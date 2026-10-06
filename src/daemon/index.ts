/**
 * The daemon (Mac) — one long-lived process (design §3.1, §5).
 *
 * Sole writer of the SQLite DB; owner of every local agent PTY; server of the UDS socket. Agents
 * outlive any client.
 *
 * MILESTONE 1 boot: mkdir state dir; open the store (migrate); create the session manager; start the
 * UDS server and wire manager status/exit events to broadcast; write the pidfile; install signal
 * handlers. Config validation, the monitors, autonomy, alerts, and box federation land in later build
 * steps (see BUILD.md); their ordered boot sequence is documented in daemon/index.ts history / §5.1.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { paths, stateHome } from "../shared/paths.ts";
import { loadOperatorConfig, BUILTIN_DEFAULTS } from "../shared/config.ts";
import { windowLabel, parseExtensionDeadline, AUTONOMY_EXTENSION_CAP_MS, type WindowConfig } from "../shared/autonomy-window.ts";
import { Store } from "./store.ts";
import { createSessionManager, type SessionManager } from "./session-manager.ts";
import { createStatusTracker, type StatusTracker } from "./monitors/status.ts";
import { startWorkItemMonitor, type WorkItemMonitor } from "./monitors/work-item.ts";
import { createNudgeDelivery, type NudgeDelivery } from "./nudge/index.ts";
import { startAutonomy, parseAutonomyConfig, type AutonomyEngine } from "./autonomy/index.ts";
import { createAlertDispatcher, shellNarrator, type AlertDispatcher } from "./alerts.ts";
import { startUsageLedger, type UsageLedger } from "./monitors/usage.ts";
import { reapWorktrees } from "./worktree.ts";
import { startBoxFederation, type BoxFederation } from "./box/federation.ts";
import { RemoteAgents } from "./remote-box.ts";
import { startUdsServer, type UdsServer } from "./uds-server.ts";
import { httpLinearClient, syncLinearIssues } from "./linear.ts";
import { runSweepJob } from "./sweep-engine.ts";
import { liveSweepDeps, needsHydration, hydrateInReviewJob } from "./sweep-deps.ts";
import { createSweepSupervisor, type SweepSupervisor } from "./sweep-supervisor.ts";

export interface Daemon {
  store: Store;
  manager: SessionManager;
  tracker: StatusTracker;
  monitor: WorkItemMonitor;
  nudge: NudgeDelivery;
  autonomy: AutonomyEngine;
  usage: UsageLedger;
  alerts: AlertDispatcher | null;
  server: UdsServer;
  socketPath: string;
  stop(): void;
}

/** Start the daemon in-process (also used by integration tests). */
export function startDaemon(home = stateHome()): Daemon {
  const p = paths(home);
  for (const dir of [p.home, p.sessions, p.worktrees, p.repos]) {
    mkdirSync(dir, { recursive: true });
  }

  const store = new Store(p.db);
  const config = loadOperatorConfig(home);
  const tracker = createStatusTracker({ home });

  // The remote-agent helper (devbox) needs to emit openUrl through the server, created just below.
  let server: UdsServer;
  const remote = config.devbox
    ? new RemoteAgents({
        dest: config.devbox,
        tracker,
        onOpenUrl: (sessionId, url) => server.broadcast({ type: "session.openUrl", data: { sessionId, url } }),
      })
    : undefined;

  const manager = createSessionManager(store, tracker, config, home, remote);
  const nudge = createNudgeDelivery({
    store, manager,
    subscribeStatus: (cb) => tracker.onChange(({ sessionId }) => cb(sessionId)),
  });
  const monitor = startWorkItemMonitor({
    store, manager, config,
    emit: () => server.broadcast({ type: "workitems.changed", data: {} }),
    isBusy: () => server.isBusy(),
  });

  const autonomyConfig = parseAutonomyConfig();
  const autonomy = startAutonomy({
    store, tracker, nudge, config: autonomyConfig, operatorConfig: config, home,
    emit: () => server.broadcast({ type: "autonomy.acted", data: {} }),
  });

  const windowCfg: WindowConfig = {
    timeZone: BUILTIN_DEFAULTS.autonomyTimeZone,
    startHour: BUILTIN_DEFAULTS.autonomyStartHour,
    endHour: BUILTIN_DEFAULTS.autonomyEndHour,
  };
  const extensionUntil = (): number | null => {
    try { return existsSync(p.autonomyUntil) ? parseExtensionDeadline(readFileSync(p.autonomyUntil, "utf8"), Date.now()) : null; }
    catch { return null; }
  };
  const autonomyState = () => ({
    enabled: autonomyConfig.enabled,
    dryRun: autonomyConfig.dryRun,
    killed: !autonomyConfig.enabled || existsSync(p.autonomyOff),
    window: windowLabel(Date.now(), windowCfg, extensionUntil()),
  });
  const extendAutonomy = (hours: number) => {
    const until = Date.now() + Math.min(Math.max(hours, 0) * 3_600_000, AUTONOMY_EXTENSION_CAP_MS);
    writeFileSync(p.autonomyUntil, String(until));
    return { until };
  };

  // Usage accounting runs always (even with no repo). Alerts are opt-in (AO_ALERTS=1), not deploy-inherited.
  const usage = startUsageLedger({ store });
  const alertsOn = (process.env.AO_ALERTS ?? "").trim() === "1";
  const narratePath = new URL("../../deploy/alerts/narrate.sh", import.meta.url).pathname;
  const alerts = alertsOn
    ? createAlertDispatcher({
        store,
        narrate: shellNarrator(narratePath, config.alertSlackId ?? ""),
        dryRun: (process.env.AO_ALERTS_DRY_RUN ?? "").trim() === "1",
      })
    : null;

  // Worktree reaper (immediately, then hourly, design §5.1/§17.6) over each repo that hosts a worktree.
  const reapSessions = () => store.listSessions({ includeClosed: true })
    .map((s) => ({ id: s.id, closed: s.closed, closedAt: s.closedAt }));
  const repoTops = () => {
    const tops = new Set<string>();
    for (const s of store.listSessions({ includeClosed: true })) {
      const i = s.worktreePath?.indexOf("/.worktrees/ao/") ?? -1;
      if (s.worktreePath && i > 0) tops.add(s.worktreePath.slice(0, i));
    }
    return [...tops];
  };
  const reap = () => { for (const top of repoTops()) { try { reapWorktrees(top, reapSessions(), Date.now(), BUILTIN_DEFAULTS.worktreeReapDays); } catch { /* best-effort */ } } };
  reap();
  const reapTimer = setInterval(reap, 60 * 60 * 1000);

  // Box federation over ssh, unless AO_BOX_MONITOR=0 (design §5.1 step 10).
  const boxMonitorOff = (process.env.AO_BOX_MONITOR ?? "").trim() === "0";
  const federation: BoxFederation | null = config.devbox && !boxMonitorOff
    ? startBoxFederation({ store, dest: config.devbox }) : null;

  // In-review sweep trigger (build order #2): optionally refresh linear_issues from Linear (when an API
  // key + team keys are configured), then enqueue an in-review job per eligible issue. Idempotent.
  // Sweep supervisor (build order #3c): run queued sweep jobs through the engine. Live path — wired only
  // when a repo + its local checkout are configured; otherwise scanInReview just enqueues (as in Phase 2).
  let sweepSupervisor: SweepSupervisor | null = null;
  const sweepProfile = config.profiles.find((pr) => pr.repo === config.repo && pr.localCwd);
  if (config.repo && config.branchOwner && sweepProfile?.localCwd) {
    const repo = config.repo;
    const branchOwner = config.branchOwner;
    const sweepsTask = store.listTasks(true).find((t) => t.name === "Sweeps") ?? store.createTask({ name: "Sweeps" });
    const sweepDeps = liveSweepDeps({
      manager, tracker, repo, branchOwner, taskId: sweepsTask.id, cwd: sweepProfile.localCwd, home,
    });
    sweepSupervisor = createSweepSupervisor({
      store,
      run: async (job) => {
        // in-review jobs are enqueued with no PR; discover + persist it before the engine drives them.
        const ready = needsHydration(job) ? await hydrateInReviewJob(store, job, { repo, branchOwner }) : job;
        return runSweepJob(ready, store, sweepDeps);
      },
      onError: (job, err) => console.error(`sweep ${job.ticketKey}:`, err instanceof Error ? err.message : err),
    });
  }

  const scanInReview = async (stateName = "In Review"): Promise<{ synced: number; created: number; started: number }> => {
    let synced = 0;
    const teamKeys = config.linearTeamKeys ?? [];
    if (config.linearApiKey && teamKeys.length > 0) {
      ({ synced } = await syncLinearIssues(store, httpLinearClient(config.linearApiKey), teamKeys));
    }
    const created = store.enqueueInReviewSweeps(stateName).length;
    const started = sweepSupervisor?.pickup().length ?? 0; // kick the engine on the newly-queued jobs
    return { synced, created, started };
  };

  server = startUdsServer(p.socket, { store, manager, monitor, nudge, autonomyState, extendAutonomy, scanInReview });

  // Broadcast runtime status transitions to all clients (design §8.2 manager fan-out).
  tracker.onChange(({ sessionId, status }) =>
    server.broadcast({ type: "session.status", data: { sessionId, status } }));
  manager.onExit(({ sessionId, exit }) =>
    server.broadcast({ type: "session.exit", data: { sessionId, ...exit } }));

  tracker.start();

  return {
    store,
    manager,
    tracker,
    monitor,
    nudge,
    autonomy,
    usage,
    alerts,
    server,
    socketPath: p.socket,
    stop() {
      server.stop();
      autonomy.stop();
      alerts?.stop();
      usage.stop();
      monitor.stop();
      nudge.stop();
      federation?.stop();
      clearInterval(reapTimer);
      tracker.stop();
      manager.shutdown();
      store.close();
    },
  };
}

export async function main(): Promise<void> {
  const p = paths();
  const daemon = startDaemon();
  writeFileSync(p.pid, String(process.pid));
  console.log(`borderless daemon listening on ${daemon.socketPath} (pid ${process.pid})`);

  const shutdown = (): never => {
    daemon.stop();
    if (existsSync(p.pid)) { try { unlinkSync(p.pid); } catch { /* ignore */ } }
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
