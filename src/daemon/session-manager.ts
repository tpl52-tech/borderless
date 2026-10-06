/**
 * Session manager — owns the lifecycle of every agent (design §7, §9).
 *
 * Spawn sequence (design §7.1): resolve profile -> parse seed ticket -> mint the resume handle ->
 * create the DB row FIRST -> provision the worktree (local) -> build argv via the per-CLI spawn spec ->
 * start the PTY -> for a local claude ticket seed, deliver it deferred (§10.7).
 *
 * MILESTONE 3-4: LOCAL agents (own PTY) and DEVBOX agents (a local ssh mirror PTY running tmux, §9).
 * A devbox agent's status comes from the remote events.log tail + liveness ticks; its mirror PTY
 * dying is NOT the agent dying (the tmux session survives, §5.3). Deferred: remote worktree
 * provisioning, codex rollout discovery (step 11), the remote nudge/seed hop (step 6).
 */

import { mkdirSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnPty, type PtySession, type PtyExit } from "./pty.ts";
import { Store } from "./store.ts";
import type { StatusTracker } from "./monitors/status.ts";
import type { RemoteAgents } from "./remote-box.ts";
import { provisionWorktree, gitToplevel, branchName } from "./worktree.ts";
import { sessionDir, stateHome } from "../shared/paths.ts";
import { buildSpawnSpec, DEFERRED_TOOL_GUIDANCE, type SpawnSpec } from "../shared/spawn-spec.ts";
import { isBareTicket, extractTickets, expandTicketSeed } from "../shared/ticket.ts";
import {
  selectProfile, profileIdFromRepo, resolveCwd, DEFAULT_REVIEW_POLICY, type Profile,
} from "../shared/profile.ts";
import { sshUserFromDest } from "../shared/remote.ts";
import { applyTicketPlaceholder } from "../shared/settings.ts";
import { defaultOperatorConfig, type OperatorConfigLite } from "../shared/config.ts";
import type { Session, SessionStatus, Tool, Location, Permissions, Effort } from "../shared/types.ts";

const HOOK_PATH = new URL("./hook-notify.ts", import.meta.url).pathname;

export interface SpawnParams {
  taskId: string;
  title?: string;
  tool?: Tool;
  location?: Location;
  cwd: string;
  usesWorktree?: boolean;
  model?: string;
  permissions?: Permissions;
  effort?: Effort | null;
  profileId?: string;
  repo?: string;
  seed?: string;
  cols?: number;
  rows?: number;
  /** Override argv (tests / bring-up); otherwise derived from the per-CLI spawn spec. */
  command?: string[];
}

export interface SessionManager {
  spawn(params: SpawnParams): Promise<Session>;
  resume(sessionId: string, size?: { cols: number; rows: number }): PtySession;
  live(sessionId: string): PtySession | undefined;
  status(sessionId: string): SessionStatus;
  /** Bytes to paint a freshly-attached client: local replay buffer, or a devbox tmux capture (§8.4). */
  repaintBytes(sessionId: string): Promise<Uint8Array>;
  write(sessionId: string, bytes: Uint8Array): void;
  resize(sessionId: string, cols: number, rows: number): void;
  kill(sessionId: string): void;
  forget(sessionId: string): void;
  onExit(cb: (e: { sessionId: string; exit: PtyExit }) => void): () => void;
  shutdown(): void;
}

interface Common {
  tool: Tool;
  location: Location;
  model: string;
  permissions: Permissions;
  effort: Effort | null;
  usesWorktree: boolean;
  profile: Profile;
  seed?: string;
  seedIsTicket: boolean;
  ticket: string | null;
  title: string;
  resumeHandle: string | null;
}

export function createSessionManager(
  store: Store,
  tracker: StatusTracker,
  config: OperatorConfigLite = defaultOperatorConfig(),
  home = stateHome(),
  remote?: RemoteAgents,
): SessionManager {
  const live = new Map<string, PtySession>();
  const exitCbs = new Set<(e: { sessionId: string; exit: PtyExit }) => void>();

  const startPty = (
    session: Session,
    argv: string[],
    env: Record<string, string>,
    size: { cols: number; rows: number } | undefined,
    agentExit: boolean,
  ): PtySession => {
    mkdirSync(sessionDir(session.id, home), { recursive: true });
    tracker.register(session.id);
    const pty = spawnPty({
      sessionId: session.id, argv, cwd: agentExit ? session.cwd : home, cols: size?.cols, rows: size?.rows, env,
      onExit: (exit) => {
        live.delete(session.id);
        if (agentExit) {
          // Local agent: the process dying IS the agent dying.
          tracker.onExit(session.id, exit.status);
          for (const cb of exitCbs) cb({ sessionId: session.id, exit });
        }
        // Devbox: the ssh mirror dying is not the agent dying (tmux survives, §5.3). Liveness decides.
      },
    });
    pty.addOutputListener(() => tracker.onOutput(session.id));
    live.set(session.id, pty);
    return pty;
  };

  const resolveProfile = (params: SpawnParams): Profile => {
    const chosen = selectProfile(config.profiles, {
      explicitId: params.profileId, explicitRepo: params.repo,
      defaultProfileId: config.defaultProfileId, scalarRepo: config.repo,
    });
    if (chosen) return chosen;
    const repo = params.repo ?? config.repo ?? "";
    return {
      id: params.profileId ?? (repo ? profileIdFromRepo(repo) : "legacy"),
      repo, defaultBranch: "main", ticketProvider: "linear",
      linearTeamKeys: config.linearTeamKeys, linearWorkspace: config.linearWorkspace,
      ctoLogin: config.ctoLogin, ctoBotLogin: config.ctoBotLogin,
      reviewPolicy: { ...DEFAULT_REVIEW_POLICY },
    };
  };

  const prepare = (params: SpawnParams): Common => {
    const D = config.settings.spawnDefaults;
    const tool = params.tool ?? D.tool;
    const location = params.location ?? D.location;
    const profile = resolveProfile(params);
    const teamKeys = profile.linearTeamKeys ?? config.linearTeamKeys ?? [];

    let seed = params.seed?.trim() || undefined;
    let ticket: string | null = null;
    let seedIsTicket = false;
    if (seed && isBareTicket(seed, teamKeys)) {
      ticket = seed.toUpperCase();
      seedIsTicket = true;
      const custom = ticketPromptFor(tool, config);
      seed = custom ? applyTicketPlaceholder(custom, ticket) : expandTicketSeed(ticket, tool, {
        provider: profile.ticketProvider, reviewPolicy: profile.reviewPolicy,
        ctoLogin: profile.ctoLogin, codexBotLogin: profile.ctoBotLogin,
      });
    } else {
      ticket = extractTickets(`${params.title ?? ""} ${seed ?? ""}`, teamKeys, profile.ticketProvider)[0] ?? null;
    }

    return {
      tool, location, model: params.model ?? D.model, permissions: params.permissions ?? D.permissions,
      effort: params.effort ?? D.effort, usesWorktree: params.usesWorktree ?? D.usesWorktree,
      profile, seed, seedIsTicket, ticket, title: params.title?.trim() || ticket || "",
      resumeHandle: mintResumeHandle(tool),
    };
  };

  const spawnLocal = (params: SpawnParams, c: Common): Session => {
    let session = store.createSession({
      taskId: params.taskId, title: c.title, tool: c.tool, location: "local", cwd: params.cwd,
      usesWorktree: c.usesWorktree, model: c.model, permissions: c.permissions, effort: c.effort,
      resumeHandle: c.resumeHandle, profileId: c.profile.id,
    });

    if (c.usesWorktree) {
      try {
        const repoTop = gitToplevel(c.profile.localCwd || params.cwd);
        if (!repoTop) throw new Error(`usesWorktree but '${params.cwd}' is not inside a git repo`);
        const id8 = session.id.slice(0, 8);
        const branch = branchName({ ticket: c.ticket, branchOwner: config.branchOwner, title: c.title, id8 });
        const wt = provisionWorktree({ repoTop, branch, defaultBranch: c.profile.defaultBranch, id8 });
        store.updateSession(session.id, { cwd: wt.path, worktreePath: wt.path, worktreeBranch: wt.branch });
        session = store.getSession(session.id)!;
      } catch (err) {
        store.removeSession(session.id);
        throw err;
      }
    }

    let argv: string[];
    let env: Record<string, string>;
    let spec: SpawnSpec | null = null;
    if (params.command) {
      argv = params.command;
      env = { AO_SESSION_ID: session.id, AO_SESSION_DIR: sessionDir(session.id, home) };
    } else {
      // Pre-accept claude's per-folder trust dialog, else the agent stalls at it before processing the
      // seed (found in live validation; claude 2.x keys trust by the cwd's realpath in ~/.claude.json).
      if (c.tool === "claude") ensureClaudeTrust(session.cwd);
      spec = buildSpawnSpec({
        tool: c.tool, sessionId: session.id, cwd: session.cwd, model: c.model, effort: c.effort,
        permissions: c.permissions, isResume: false, resumeHandle: c.resumeHandle, seed: c.seed,
        seedIsTicket: c.seedIsTicket, bunPath: process.execPath, hookNotifyPath: HOOK_PATH,
        sessionDir: sessionDir(session.id, home), appendSystemPrompt: DEFERRED_TOOL_GUIDANCE, claudeMdExcludes: [],
      });
      argv = spec.argv;
      env = spec.env;
    }

    const pty = startPty(session, argv, env, sizeOf(params), true);
    if (spec?.deferSeedPrompt && c.seed) void deliverDeferredSeed(pty, c.seed).catch(() => {});
    return session;
  };

  const spawnDevbox = async (params: SpawnParams, c: Common): Promise<Session> => {
    if (!remote) {
      throw new Error("session-manager: devbox spawning requires `devbox` in config (design §4.2)");
    }
    await remote.ensureHookDeployed();

    const sshUser = sshUserFromDest(config.devbox ?? "");
    const remoteCwd = c.profile.remoteCwd || resolveCwd(c.profile, "devbox", "", sshUser);

    let session = store.createSession({
      taskId: params.taskId, title: c.title, tool: c.tool, location: "devbox", cwd: remoteCwd,
      usesWorktree: false, model: c.model, permissions: c.permissions, effort: c.effort,
      resumeHandle: c.resumeHandle, profileId: c.profile.id,
    });
    const tmuxSession = `ao-${session.id.slice(0, 8)}`;
    store.updateSession(session.id, { tmuxSession });
    session = store.getSession(session.id)!;

    const agentArgv = buildSpawnSpec({
      tool: c.tool, sessionId: session.id, cwd: remoteCwd, model: c.model, effort: c.effort,
      permissions: c.permissions, isResume: false, resumeHandle: c.resumeHandle, seed: c.seed,
      seedIsTicket: c.seedIsTicket, bunPath: process.execPath, hookNotifyPath: HOOK_PATH,
      sessionDir: "", remoteHookPath: remote.remoteHookPath(), appendSystemPrompt: DEFERRED_TOOL_GUIDANCE,
    }).argv;

    const sshArgv = remote.buildSpawnArgv({ cwd: remoteCwd, tmuxSession, agentCmd: agentArgv });
    const pty = startPty(session, sshArgv, {}, sizeOf(params), false);
    remote.scanTailscale(session.id, pty);
    remote.startSession(session.id, tmuxSession);
    return session;
  };

  return {
    async spawn(params) {
      const c = prepare(params);
      // `return await` (not a bare return) so a devbox rejection is handled within this async frame
      // rather than adopted across a microtask gap, which Bun flags as an unhandled rejection.
      if (c.location === "devbox") return await spawnDevbox(params, c);
      return spawnLocal(params, c);
    },

    resume(sessionId, size) {
      const existing = live.get(sessionId);
      if (existing) return existing;
      const session = store.getSession(sessionId);
      if (!session) throw new Error(`session-manager.resume: unknown session ${sessionId}`);
      if (session.closed) throw new Error(`session-manager.resume: session ${sessionId} is closed`);

      if (session.location === "devbox") {
        if (!remote) throw new Error("session-manager.resume: devbox not configured");
        const agentArgv = buildSpawnSpec({
          tool: session.tool, sessionId: session.id, cwd: session.cwd, model: session.model,
          effort: session.effort, permissions: session.permissions, isResume: true,
          resumeHandle: session.resumeHandle, bunPath: process.execPath, hookNotifyPath: HOOK_PATH,
          sessionDir: "", remoteHookPath: remote.remoteHookPath(), appendSystemPrompt: DEFERRED_TOOL_GUIDANCE,
        }).argv;
        const tmuxSession = session.tmuxSession ?? `ao-${session.id.slice(0, 8)}`;
        const sshArgv = remote.buildSpawnArgv({ cwd: session.cwd, tmuxSession, agentCmd: agentArgv });
        const pty = startPty(session, sshArgv, {}, size, false);
        remote.scanTailscale(session.id, pty);
        remote.startSession(session.id, tmuxSession);
        return pty;
      }

      const spec = buildSpawnSpec({
        tool: session.tool, sessionId: session.id, cwd: session.cwd, model: session.model,
        effort: session.effort, permissions: session.permissions, isResume: true,
        resumeHandle: session.resumeHandle, bunPath: process.execPath, hookNotifyPath: HOOK_PATH,
        sessionDir: sessionDir(session.id, home), appendSystemPrompt: DEFERRED_TOOL_GUIDANCE,
      });
      return startPty(session, spec.argv, spec.env, size, true);
    },

    live: (sessionId) => live.get(sessionId),
    status: (sessionId) => tracker.status(sessionId),

    async repaintBytes(sessionId) {
      const session = store.getSession(sessionId);
      if (session?.location === "devbox" && remote && session.tmuxSession) {
        try { return await remote.captureRepaint(session.tmuxSession); } catch { return new Uint8Array(0); }
      }
      return live.get(sessionId)?.replay() ?? new Uint8Array(0);
    },

    write(sessionId, bytes) { live.get(sessionId)?.write(bytes); },
    resize(sessionId, cols, rows) { live.get(sessionId)?.resize(cols, rows); },
    kill(sessionId) {
      live.get(sessionId)?.kill();
      remote?.stopSession(sessionId);
    },
    forget(sessionId) {
      tracker.unregister(sessionId);
      remote?.stopSession(sessionId);
    },
    onExit(cb) { exitCbs.add(cb); return () => exitCbs.delete(cb); },
    shutdown() {
      for (const pty of live.values()) pty.kill();
      live.clear();
      remote?.shutdown();
    },
  };
}

function sizeOf(p: SpawnParams): { cols: number; rows: number } | undefined {
  return p.cols && p.rows ? { cols: p.cols, rows: p.rows } : undefined;
}

/**
 * Pre-accept claude's workspace-trust dialog for a cwd (design §7, live-validation fix). claude 2.x keys
 * trust by the folder's REALPATH in ~/.claude.json under projects[path].hasTrustDialogAccepted; without
 * it a spawned agent stalls on the trust menu before reading its seed. Read-modify-write preserves the
 * rest of the file; best-effort (a trust prompt is recoverable, a corrupted ~/.claude.json is not).
 */
export function ensureClaudeTrust(cwd: string, homeDir: string = homedir()): void {
  const file = join(homeDir, ".claude.json");
  let json: Record<string, any> = {};
  try { json = JSON.parse(readFileSync(file, "utf8")); } catch { /* missing/!readable -> start fresh */ }
  let key = cwd;
  try { key = realpathSync(cwd); } catch { /* dir may not be realpath-able; use as-is */ }
  json.projects = json.projects ?? {};
  json.projects[key] = { ...(json.projects[key] ?? {}), hasTrustDialogAccepted: true };
  try { writeFileSync(file, JSON.stringify(json, null, 2)); } catch { /* best-effort */ }
}

function mintResumeHandle(tool: Tool): string | null {
  if (tool === "claude") return crypto.randomUUID();
  if (tool === "copilot") return `ao-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
  return null;
}

function ticketPromptFor(tool: Tool, config: OperatorConfigLite): string {
  const s = config.settings;
  if (tool === "codex") return s.ticketPromptCodex;
  if (tool === "copilot") return s.ticketPromptCopilot;
  if (tool === "openrouter") return s.ticketPromptOpenRouter;
  return s.ticketPrompt;
}

/**
 * Deferred seed delivery for a LOCAL claude ticket seed (design §10.7): measure output quiescence
 * (poll 250ms, require 1.5s quiet, give up at 30s), then a fixed 6s MCP grace, then write the body and
 * — 150ms later, as a SEPARATE write — the CR (§10.5: CR must never ride with the text).
 */
async function deliverDeferredSeed(pty: PtySession, seed: string): Promise<void> {
  let last = Date.now();
  const off = pty.addOutputListener(() => { last = Date.now(); });
  const start = Date.now();
  try {
    while (Date.now() - start < 30_000) {
      await Bun.sleep(250);
      if (Date.now() - last >= 1_500) break;
    }
    await Bun.sleep(6_000);
    pty.write(new TextEncoder().encode(seed.replace(/\r\n?/g, "\n")));
    await Bun.sleep(150);
    pty.write(new Uint8Array([0x0d]));
  } finally {
    off();
  }
}
