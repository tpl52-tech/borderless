/**
 * Live verification-agent spawn (PRD §13, phase V4c-2 / COR-89) — the `spawn` injected into runVerifyAgent
 * (V4b): run a `claude` session in a throwaway worktree on the repo with the verify seed, wait for it, read its
 * `$AO_SESSION_DIR/verdict.json`, then kill + reap the worktree. The spawn→await→read→cleanup dance is the
 * shared runEphemeralInspector (same path as the sweep reviewer). Live-only; the agent runs only when the engine
 * (V4c-3) invokes this.
 *
 * Safety: the agent's only path to the DB/app is the read-only verify-probe CLI (named in the seed), whose creds
 * are read-only by construction (the SELECT-only catalog role + the anon/test-user session; `service_role` is
 * never in config) — so the agent has **no DB write capability**. (Like every full-access spawn in the system,
 * it can still read local files and reach the network; the guarantee here is specifically the database-write
 * boundary, not blanket isolation.)
 */

import { runEphemeralInspector } from "./spawn-wait.ts";
import { VERIFY_VERDICT_FILE } from "../shared/verify-agent.ts";
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
  const deadlineMs = cfg.spawnDeadlineMs ?? DEFAULT_VERIFY_DEADLINE_MS;
  return async (seed) => {
    const { raw } = await runEphemeralInspector(
      { manager: cfg.manager, tracker: cfg.tracker, repo: cfg.repo, taskId: cfg.taskId, cwd: cfg.cwd, home: cfg.home, deadlineMs },
      seed, VERIFY_VERDICT_FILE,
    );
    return raw;
  };
}
