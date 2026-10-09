/**
 * Shared ephemeral-agent spawn helpers — await a session to terminal status, and run a read-only "inspector"
 * agent (a `claude` session in a throwaway worktree that writes a verdict file, then is killed + reaped). Used
 * by BOTH the sweep reviewer (sweep-deps.ts) and the verify agent (verify-agent-spawn.ts), so the
 * spawn→await→read→cleanup dance lives in one place rather than being copied. Live-only; validated through
 * those callers' live runs (the logic — fail-closed-on-missing, always-clean-up — is unit-tested here with fakes).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sessionDir } from "../shared/paths.ts";
import type { SessionManager } from "./session-manager.ts";
import type { StatusTracker } from "./monitors/status.ts";
import type { Session, SessionStatus } from "../shared/types.ts";

const TERMINAL: ReadonlySet<SessionStatus> = new Set<SessionStatus>(["done", "exited", "error"]);

export interface ClaudeAgentSpawn {
  taskId: string;
  cwd: string;
  repo: string;
  seed: string;
  /** Give the spawn a throwaway branch instead of deriving one from a ticket in the seed (see SpawnParams). */
  ignoreSeedTicket?: boolean;
}

/**
 * Spawn a full-access `claude` session in its own worktree — the single definition of "what a sweep/verify
 * agent is". The caller owns the lifecycle after this (await, read a verdict, kill + reap): a sweep worker
 * keeps its PTY and releases the worktree only once a PR exists; an inspector always kills + reaps.
 */
export function spawnClaudeAgent(manager: SessionManager, p: ClaudeAgentSpawn): Promise<Session> {
  return manager.spawn({
    taskId: p.taskId, tool: "claude", location: "local", cwd: p.cwd,
    usesWorktree: true, permissions: "full-access", repo: p.repo, seed: p.seed,
    ignoreSeedTicket: p.ignoreSeedTicket,
  });
}

/** Resolve when `sessionId` reaches a terminal status; reject if `deadlineMs` (> 0) elapses first. */
export function awaitCompletion(tracker: StatusTracker, sessionId: string, deadlineMs = 0): Promise<SessionStatus> {
  return new Promise((resolve, reject) => {
    const current = tracker.status(sessionId);
    if (TERMINAL.has(current)) return resolve(current);
    let off = () => {};
    let timer: ReturnType<typeof setTimeout> | null = null;
    const done = () => { off(); if (timer) clearTimeout(timer); };
    off = tracker.onChange(({ sessionId: id, status }) => {
      if (id === sessionId && TERMINAL.has(status)) { done(); resolve(status); }
    });
    if (deadlineMs > 0) {
      timer = setTimeout(() => { done(); reject(new Error(`session ${sessionId} did not finish within ${deadlineMs}ms`)); }, deadlineMs);
    }
  });
}

export interface EphemeralInspectorConfig {
  manager: SessionManager;
  tracker: StatusTracker;
  repo: string;
  taskId: string;
  cwd: string;
  home: string;
  deadlineMs?: number;
}

/**
 * Spawn a read-only INSPECTOR agent (a `claude` session in a throwaway worktree — `ignoreSeedTicket`, so it
 * never shares a real ticket branch), await it, read the verdict file it wrote under $AO_SESSION_DIR, and
 * ALWAYS kill the session + reap the worktree (in a `finally`, so a deadline reject still cleans up). Returns
 * the raw file contents, or "" when missing — callers fail closed on "". Shared by the sweep reviewer + verify.
 */
export async function runEphemeralInspector(cfg: EphemeralInspectorConfig, seed: string, verdictFile: string): Promise<{ sessionId: string; raw: string }> {
  const session = await spawnClaudeAgent(cfg.manager, { taskId: cfg.taskId, cwd: cfg.cwd, repo: cfg.repo, seed, ignoreSeedTicket: true });
  try {
    await awaitCompletion(cfg.tracker, session.id, cfg.deadlineMs ?? 0);
    let raw = "";
    try { raw = readFileSync(join(sessionDir(session.id, cfg.home), verdictFile), "utf8"); } catch { /* missing → "" (fails closed) */ }
    return { sessionId: session.id, raw };
  } finally {
    cfg.manager.kill(session.id); // never leak the agent PTY
    cfg.manager.releaseWorktree(session.id); // reap its throwaway worktree
  }
}
