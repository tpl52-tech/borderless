/**
 * Live verification-agent spawn (PRD §13, phase V4c-2 / COR-89) — the `spawn` injected into runVerifyAgent
 * (V4b): run a `claude` session in a throwaway worktree on the repo with the verify seed, wait for it, read its
 * `$AO_SESSION_DIR/verdict.json`, then kill + reap the worktree. The spawn→await→read→cleanup dance is the
 * shared runEphemeralInspector (same path as the sweep reviewer). Live-only; the agent runs only when the engine
 * (V4c-3) invokes this.
 *
 * Safety: the agent inspects the DB/app through the read-only verify-probe CLI (named in the seed); its creds
 * carry no catalog-write power (the SELECT-only catalog role; `service_role` is never in config). The read-only
 * posture is otherwise enforced by the seed + RLS, not a hard sandbox: a full-access agent can reach the public
 * anon key that ships in the app repo, so under `verifyAllowWrites` it may make RLS-bounded throwaway writes as
 * the test user (and only then — it still can never touch another user's or the catalog's data). The real
 * guarantee while this runs against prod is that the DB holds no real data yet (COR-86). Like every full-access
 * spawn it can also read local files and reach the network; the boundary here is RLS + no-real-data, not isolation.
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
