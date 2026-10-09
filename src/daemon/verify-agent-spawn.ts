/**
 * Live verification-agent spawn (PRD §13, phase V4c-2 / COR-89) — the `spawn` injected into runVerifyAgent:
 * run a `claude` session in a throwaway worktree on the repo with the verify seed, wait for it to finish, read
 * its `$AO_SESSION_DIR/verdict.json`, then kill the session + reap the worktree. Mirrors the sweep reviewer's
 * review() (spawn → await → read verdict file → kill). Live-only; the agent only runs when the engine (V4c-3)
 * invokes this — validated there.
 *
 * The agent INSPECTS only: `ignoreSeedTicket` gives it a throwaway branch (not a ticket branch, which the
 * worker owns), and its path to the DB/app is the read-only verify-probe CLI (named in the seed). The probe's
 * creds are read-only by construction (the SELECT-only catalog role + the anon/test-user session;
 * `service_role` is never in config), so the spawn hands the agent no write capability by default.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sessionDir } from "../shared/paths.ts";
import { VERIFY_VERDICT_FILE } from "../shared/verify-agent.ts";
import { awaitCompletion } from "./sweep-deps.ts";
import type { SessionManager } from "./session-manager.ts";
import type { StatusTracker } from "./monitors/status.ts";

const DEFAULT_VERIFY_DEADLINE_MS = 30 * 60 * 1000; // 30m backstop against a hung verify agent

export interface VerifySpawnConfig {
  manager: SessionManager;
  tracker: StatusTracker;
  repo: string;
  /** Task + cwd the verify sessions run under; home for reading the verdict file. */
  taskId: string;
  cwd: string;
  home: string;
  spawnDeadlineMs?: number;
}

/** Build the live `spawn(seed) → raw verdict` for runVerifyAgent — one throwaway session per call, cleaned up. */
export function liveVerifyAgentSpawn(cfg: VerifySpawnConfig): (seed: string) => Promise<string> {
  return async (seed) => {
    const session = await cfg.manager.spawn({
      taskId: cfg.taskId, tool: "claude", location: "local", cwd: cfg.cwd,
      usesWorktree: true, permissions: "full-access", repo: cfg.repo, seed,
      ignoreSeedTicket: true, // verify only inspects → a throwaway branch, not a ticket branch
    });
    try {
      await awaitCompletion(cfg.tracker, session.id, cfg.spawnDeadlineMs ?? DEFAULT_VERIFY_DEADLINE_MS);
      try { return readFileSync(join(sessionDir(session.id, cfg.home), VERIFY_VERDICT_FILE), "utf8"); }
      catch { return ""; } // no verdict file → parseAgentVerdict degrades to inconclusive (fails closed)
    } finally {
      cfg.manager.kill(session.id); // never leak the agent PTY
      cfg.manager.releaseWorktree(session.id); // reap its throwaway worktree
    }
  };
}
