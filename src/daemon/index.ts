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
import { fileURLToPath } from "node:url";
import { paths, stateHome } from "../shared/paths.ts";
import { loadOperatorConfig, BUILTIN_DEFAULTS, DEFAULT_OPENROUTER_MODEL, DEFAULT_WEB_PORT } from "../shared/config.ts";
import { ISSUE_UPDATE_MUTATION, parseIssueUpdate, COMMENT_CREATE_MUTATION, parseCommentCreate } from "../shared/linear.ts";
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
import { verifyScan, liveMergedPrFor } from "./verify-scan.ts";
import { runVerify, verifyTicket, type VerifyRunDeps } from "./verify-run.ts";
import { runVerifyAgent } from "./verify-agent-run.ts";
import { liveVerifyAgentSpawn } from "./verify-agent-spawn.ts";
import { openCatalogDb } from "./verify-db.ts";
import { publicReadPolicyProbe, hasPublicReadPolicy } from "../shared/verify-catalog.ts";
import { openAppSession } from "./verify-session.ts";
import { startBoxFederation, type BoxFederation } from "./box/federation.ts";
import { RemoteAgents } from "./remote-box.ts";
import { startUdsServer, type UdsServer, type UdsServerDeps } from "./uds-server.ts";
import { startWebServer, type WebServer } from "./web.ts";
import { httpLinearClient, syncLinearIssues } from "./linear.ts";
import { runSweepJob, type SweepEngineDeps } from "./sweep-engine.ts";
import { buildTerritory } from "../shared/collision.ts";
import { liveSweepDeps, needsHydration, hydrateInReviewJob } from "./sweep-deps.ts";
import { createSweepSupervisor, type SweepSupervisor } from "./sweep-supervisor.ts";
import { scanRescues, authorizeRescue, liveProgressCheck } from "./rescue-scan.ts";
import { delegate, liveCreateIssue, type DelegateResult } from "./lead-delegate.ts";
import { liveSlackDm } from "./slack.ts";
import { askBorderless, type FleetDocs } from "./ask-borderless.ts";
import { httpOpenRouterChat } from "./openrouter/chat.ts";
import { claudeCliChat } from "./claude-chat.ts";
import type { Chat } from "./openrouter/runner.ts";
import { memberByLinearId, ROSTER } from "../shared/roster.ts";

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

/** Load the design docs for Ask Borderless's fleet context (PRD §10); tolerant — a missing doc is omitted. */
function askDocs(): FleetDocs {
  const read = (name: string): string | undefined => {
    try { return readFileSync(fileURLToPath(new URL(`../../docs/${name}`, import.meta.url)), "utf8"); } catch { return undefined; }
  };
  return { prd: read("borderless-prd.md"), handoff: read("borderless-handoff.md") };
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
  // Rescue deps fall back to no-ops when no repo is configured: scan finds nothing, authorize still records
  // a rescue job (a configured daemon would run it) but can't start one without a supervisor.
  let rescueScan: UdsServerDeps["rescueScan"] = async () => [];
  let rescueAuthorize: UdsServerDeps["rescueAuthorize"] = (ticket) => {
    const r = authorizeRescue(store, ticket);
    return { ticketKey: r.job.ticketKey, created: r.created, started: false };
  };
  // Verify scan (PRD §13 V1) — read-only, so it needs only a repo + branchOwner (no localCwd / supervisor):
  // classify the Verifying tickets from their merged PRs. No repo → an empty scan.
  let runVerifyScan: UdsServerDeps["verifyScan"] = async () => ({ rows: [], configured: false });
  // V2b runner: runs the structural checks over the read-only DB role. Needs a repo (for the merged-PR lookup)
  // AND config.verifyDbUrl (the catalog role); absent either → a no-op. A DB connection is opened per run.
  let runVerifyRun: UdsServerDeps["verifyRun"] = async () => ({ rows: [], configured: false });
  // The local working copy configured for a repo — the checkout a sweep/verify agent spawns its worktree from.
  const localCwdFor = (r: string | undefined) => (r ? config.profiles.find((pr) => pr.repo === r && pr.localCwd)?.localCwd : undefined);
  if (config.repo && config.branchOwner) {
    const repo = config.repo;
    const mergedPrFor = liveMergedPrFor(repo, config.branchOwner);
    runVerifyScan = async () => ({ rows: await verifyScan(store, { mergedPrFor }), configured: true });
    const verifyDbUrl = config.verifyDbUrl;
    if (verifyDbUrl) {
      // Verification agent (PRD §13 V4): compose once when a local checkout of the app repo exists to spawn a
      // throwaway worktree from. Absent → deterministic-only (the bars still run). The agent calls back into
      // borderless's own `verify probe` CLI (read-only creds from config) to inspect the live DB/app.
      const verifyCwd = localCwdFor(repo);
      let runAgent: VerifyRunDeps["runAgent"];
      if (verifyCwd) {
        const verifyTask = store.listTasks(true).find((t) => t.name === "Verify") ?? store.createTask({ name: "Verify" });
        const spawn = liveVerifyAgentSpawn({ manager, tracker, repo, taskId: verifyTask.id, cwd: verifyCwd, home });
        const probeCommand = `${process.execPath} run ${new URL("../cli/index.ts", import.meta.url).pathname} verify probe`;
        runAgent = (issue) => runVerifyAgent(issue, { spawn, allowWrites: config.verifyAllowWrites, probeCommand });
      }
      runVerifyRun = async (ticketKey) => {
        const db = openCatalogDb(verifyDbUrl);
        // Behavioral RLS: sign in once per run (best-effort — a sign-in failure degrades to structural-only,
        // but is logged so a stale test password / bad key doesn't silently disable a configured check).
        const app = config.verifyApp
          ? await openAppSession(config.verifyApp).catch((err) => {
              console.error(`behavioral RLS check disabled: ${err instanceof Error ? err.message : err}`);
              return null;
            })
          : null;
        try {
          const knownTables = await db.tables().catch(() => [] as string[]); // best-effort text-targeting
          const publicReadPolicy = async (t: string) => hasPublicReadPolicy(await db.run(publicReadPolicyProbe(t)));
          const deps: VerifyRunDeps = { mergedPrFor, catalogRun: db.run, knownTables, publicReadPolicy, ...(app ? { rlsProbe: app.rlsProbe } : {}), ...(runAgent ? { runAgent } : {}) };
          if (ticketKey) {
            const issue = store.getLinearIssueByIdentifier(ticketKey);
            return { rows: issue ? [await verifyTicket(issue, deps)] : [], configured: true };
          }
          return { rows: await runVerify(store, deps), configured: true };
        } finally {
          await db.close();
        }
      };
    }
  }
  const sweepCwd = localCwdFor(config.repo);
  if (config.repo && config.branchOwner && sweepCwd) {
    const repo = config.repo;
    const branchOwner = config.branchOwner;
    const sweepsTask = store.listTasks(true).find((t) => t.name === "Sweeps") ?? store.createTask({ name: "Sweeps" });
    const sweepDeps: SweepEngineDeps = {
      ...liveSweepDeps({
        manager, tracker, repo, branchOwner, taskId: sweepsTask.id, cwd: sweepCwd, home,
        acceptanceFor: (ticketId) => store.getLinearIssue(ticketId)?.description ?? null,
      }),
      // Collision guard (PRD §4): the deliverables other assigned, non-terminal tickets own, from the board.
      territoryFor: (job) => buildTerritory(store.listLinearIssues(), job.ticketKey, ROSTER, config.leadOpsProject),
    };
    const supervisor = createSweepSupervisor({
      store,
      run: async (job) => {
        // in-review jobs are enqueued with no PR; discover + persist it before the engine drives them.
        const ready = needsHydration(job) ? await hydrateInReviewJob(store, job, { repo, branchOwner }) : job;
        return runSweepJob(ready, store, sweepDeps);
      },
      onError: (job, err) => console.error(`sweep ${job.ticketKey}:`, err instanceof Error ? err.message : err),
    });
    sweepSupervisor = supervisor;

    const progress = liveProgressCheck(repo, branchOwner);
    rescueScan = async () => {
      const candidates = await scanRescues(store, {
        now: Date.now(), checkProgress: progress,
        isRosterMember: (id) => id != null && memberByLinearId(id) != null,
        leadOpsProject: config.leadOpsProject,
      });
      return candidates.map((c) => ({ ticketId: c.issue.id, ticketKey: c.issue.identifier, title: c.issue.title, daysOverdue: c.daysOverdue }));
    };
    rescueAuthorize = (ticket) => {
      const r = authorizeRescue(store, ticket);
      const started = r.created && supervisor.pickup().includes(r.job.id);
      return { ticketKey: r.job.ticketKey, created: r.created, started };
    };
  }

  // Lead-desk delegation (PRD §9): materialize a Lead Ops issue + DM the assignee. Needs a Linear key
  // (and a team) to write; without one it's a guarded no-op. The Slack DM is best-effort (no token → no DM).
  const sendDm = liveSlackDm(config.slackBotToken);
  const leadTeamKey = (config.linearTeamKeys ?? [])[0]; // single-team org: the Lead Ops issue is created here
  let leadDelegate: UdsServerDeps["leadDelegate"] = async (): Promise<DelegateResult> =>
    ({ ticketKey: null, url: null, created: false, dmSent: false,
       reason: config.linearApiKey ? "no Linear team configured" : "Linear API key not configured" });
  if (config.linearApiKey && leadTeamKey) {
    const createIssue = liveCreateIssue(httpLinearClient(config.linearApiKey), leadTeamKey);
    leadDelegate = (req) => delegate({ roster: ROSTER, leadOpsProject: config.leadOpsProject, createIssue, sendDm }, req);
  }

  // Ask Borderless (PRD §10/§12): fleet-aware chat. Default backend is the subscription `claude` CLI (no key,
  // answer-only); "openrouter" is opt-in (needs a key, supports the action tools). The Linear-write tools
  // (used only on the openrouter backend) also need a Linear key.
  const askRun: UdsServerDeps["askRun"] = async (question, allowActions) => {
    const backend = config.askBackend ?? "subscription"; // PRD §12: the subscription CLI is the default ($0)
    let chat: Chat;
    if (backend === "openrouter") {
      if (!config.openRouterApiKey) return { answer: "", steps: 0, costMicros: 0, configured: false };
      chat = httpOpenRouterChat(config.openRouterApiKey, config.openRouterModel ?? DEFAULT_OPENROUTER_MODEL);
    } else {
      chat = claudeCliChat({ model: config.askModel }); // subscription: no key, answer-only (sandboxed)
    }
    const linear = config.linearApiKey ? httpLinearClient(config.linearApiKey) : null;
    const issueUuid = (ticketKey: string) => store.getLinearIssueByIdentifier(ticketKey)?.id ?? null;
    // These throw on a guard miss so the fleet tool reports it as an error (not a false success); the
    // ask-borderless runTool catches it. The happy path returns the human-readable result line.
    const reassign = async (ticketKey: string, assigneeLinearId: string): Promise<string> => {
      if (!linear) throw new Error("Linear API key not configured");
      const id = issueUuid(ticketKey);
      if (!id) throw new Error(`unknown ticket ${ticketKey} (not synced)`);
      const r = parseIssueUpdate(await linear.query(ISSUE_UPDATE_MUTATION, { id, input: { assigneeId: assigneeLinearId } }));
      return `reassigned ${r.ticketKey}`;
    };
    const comment = async (ticketKey: string, body: string): Promise<string> => {
      if (!linear) throw new Error("Linear API key not configured");
      const id = issueUuid(ticketKey);
      if (!id) throw new Error(`unknown ticket ${ticketKey} (not synced)`);
      const r = parseCommentCreate(await linear.query(COMMENT_CREATE_MUTATION, { input: { issueId: id, body } }));
      return `commented on ${ticketKey}${r.url ? ` (${r.url})` : ""}`;
    };
    const confirm = async () => allowActions; // CLI: deny by default (advisory); --yes auto-confirms
    const { answer, result } = await askBorderless(question, { chat, store, reassign, comment, docs: askDocs(), confirm });
    // The subscription backend is answer-only — it can't run the action tools, so --yes can't act there.
    const note = backend !== "openrouter" && allowActions
      ? "\n\n[Ask on the subscription backend is advisory — it can't run actions. Set askBackend:\"openrouter\" with an openRouterApiKey to let --yes act.]"
      : "";
    return { answer: answer + note, steps: result.steps, costMicros: result.costMicros, configured: true };
  };

  // Sync-only: pull the live Linear board into the store (no sweeps). Shared by the refresh button / `ao sync`
  // and by scanInReview, so there is one sync path. configured=false when no key/teams are set.
  const syncBoard = async (): Promise<{ synced: number; configured: boolean }> => {
    const teamKeys = config.linearTeamKeys ?? [];
    if (!config.linearApiKey || teamKeys.length === 0) return { synced: 0, configured: false };
    const { synced } = await syncLinearIssues(store, httpLinearClient(config.linearApiKey), teamKeys);
    return { synced, configured: true };
  };

  const scanInReview = async (stateName = "In Review"): Promise<{ synced: number; created: number; started: number }> => {
    const { synced } = await syncBoard();
    const created = store.enqueueInReviewSweeps(stateName, config.leadOpsProject).length;
    const started = sweepSupervisor?.pickup().length ?? 0; // kick the engine on the newly-queued jobs
    return { synced, created, started };
  };

  server = startUdsServer(p.socket, { store, manager, monitor, nudge, autonomyState, extendAutonomy, scanInReview, rescueScan, rescueAuthorize, leadOpsProject: config.leadOpsProject, leadDelegate, askRun, syncBoard, verifyScan: runVerifyScan, verifyRun: runVerifyRun });

  // Web console (PRD §11 browser mirror): the exact console design wired to live data, localhost only. It is
  // a non-essential read mirror — a bind failure (port taken, another instance) must NEVER abort the daemon.
  let web: WebServer | undefined;
  try {
    web = startWebServer({ store, leadOpsProject: config.leadOpsProject, projectLabel: config.projectLabel ?? "Borderless", askRun, syncBoard, verifyScan: runVerifyScan, verifyRun: runVerifyRun, port: config.webPort ?? DEFAULT_WEB_PORT });
    console.log(`borderless web console on ${web.url}`);
  } catch (err) {
    console.error(`web console disabled: ${err instanceof Error ? err.message : err}`);
  }

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
      web?.stop();
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
