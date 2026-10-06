/**
 * The sweep engine — drives a queued sweep_job to ready | needs_human | failed (lead-console PRD §4-§5).
 *
 * This is the ORCHESTRATION. It loops using the pure brain in `shared/sweep-gate.ts` (evaluateGate,
 * nextSweepAction, dangerousTiers) and executes each decision through injected deps — spawn a fixer/
 * implementer, poll CI, spawn a FRESH independent reviewer, wait. The deps are the only I/O, so the whole
 * loop is unit-testable with fakes; the live deps (PTY spawn via the session manager, CI via `gh`, the
 * reviewer session) are wired in build order #3c.
 *
 * Invariants it keeps:
 *  - the brain owns the 8-cycle cap + the escalation rules; the engine only executes the decision;
 *  - a new head resets the reviewer verdict, so a stale green review can never clear a fresh head
 *    (the head-freshness contract the pure gate deliberately delegates to the caller);
 *  - the job's session_id always points at the agent currently driving it, so the TUI can attach;
 *  - a failing dep ends the job as `failed`; a safety-iteration bound backstops the loop.
 */

import type { Store } from "./store.ts";
import type { SweepJob, SweepKind, SweepState } from "../shared/types.ts";
import {
  evaluateGate, nextSweepAction, dangerousTiers,
  MAX_CYCLES, type CheckState, type RequiredCheck, type GateBlocker, type DangerTier,
} from "../shared/sweep-gate.ts";

/** CI signal for the job's current head: required-check states + the PR's changed paths. */
export interface PollResult {
  checks: Partial<Record<RequiredCheck, CheckState>>;
  changedPaths: string[];
}

/** The independent reviewer's verdict on the current head. */
export interface ReviewVerdict {
  sessionId: string;
  redFindings: number; // 🔴 blocking findings
  preservationProven: boolean; // no-regression (in_review) / acceptance criteria (rescue)
  judgmentCall: string | null; // a no-clearly-better-option decision only the lead can make
}

/** What a worker run produced (after it finished and pushed). */
export interface WorkerResult {
  sessionId: string;
  headSha: string | null;
  prNumber: number | null;
}

/** Context handed to a worker spawn. */
export interface WorkerFeedback {
  initial: boolean; // the first build (e.g. a rescue with no PR yet) vs a fix cycle
  blockers: GateBlocker[]; // what the gate is unhappy about
  review: ReviewVerdict | null; // the last reviewer verdict, so the fixer can address the findings
}

/** The engine's only I/O — real in the daemon (3c), faked in tests. */
export interface SweepEngineDeps {
  /** Spawn the fixer (in_review) / implementer (rescue); await it finishing + pushing; return new head/PR. */
  spawnWorker(job: SweepJob, feedback: WorkerFeedback): Promise<WorkerResult>;
  /** Poll CI for the job's current head: required-check states + the PR's changed paths. */
  pollCi(job: SweepJob): Promise<PollResult>;
  /** Spawn a FRESH independent reviewer on the current head; await its verdict. */
  review(job: SweepJob): Promise<ReviewVerdict>;
  /** Sleep between CI polls (injected so tests don't actually wait). */
  wait(ms: number): Promise<void>;
  /** CI poll interval, ms. */
  ciPollMs: number;
}

export type SweepOutcome = "ready" | "needs_human" | "failed";

// The brain's 8-cycle cap is the real limit; this only bounds total loop iterations so a logic/dep bug
// can't spin forever. A cycle is at most worker + a few CI polls + a review.
const SAFETY_ITERATIONS = MAX_CYCLES * 4 + 8;

const WORKER_STATE: Record<SweepKind, SweepState> = { in_review: "fixing", rescue: "implementing" };

/** Compose the escalation reason the gate uses to stop for a human (null = keep self-resolving). */
function deriveEscalation(tiers: DangerTier[], judgmentCall: string | null): string | null {
  const parts: string[] = [];
  if (tiers.length > 0) parts.push(`dangerous tier: ${tiers.join(", ")}`);
  if (judgmentCall) parts.push(`judgment call: ${judgmentCall}`);
  return parts.length > 0 ? parts.join("; ") : null;
}

/** Drive one sweep job to a terminal state. Returns the outcome. */
export async function runSweepJob(seed: SweepJob, store: Store, deps: SweepEngineDeps): Promise<SweepOutcome> {
  let current = seed;
  let cycles = seed.cycles;
  let review: ReviewVerdict | null = null;
  let hasHead = seed.prNumber != null || seed.headSha != null;

  const transition = (patch: Parameters<Store["transitionSweepJob"]>[1]): void => {
    current = store.transitionSweepJob(seed.id, patch);
  };
  const finish = (state: SweepOutcome, reason?: string): SweepOutcome => {
    transition({ state, reason: reason ?? null });
    store.recordSweepEvent(seed.id, "state_change", { to: state, reason: reason ?? null });
    return state;
  };
  // Spawn a worker, persist the new head/PR/session, record events. The caller owns the cycle counter.
  const runWorker = async (feedback: WorkerFeedback): Promise<WorkerResult> => {
    transition({ state: WORKER_STATE[seed.kind] });
    const result = await deps.spawnWorker(current, feedback);
    const hadPr = current.prNumber != null;
    transition({ sessionId: result.sessionId, headSha: result.headSha, prNumber: result.prNumber });
    store.recordSweepEvent(seed.id, "spawn", { role: "worker", sessionId: result.sessionId, head: result.headSha });
    if (!hadPr && result.prNumber != null) store.recordSweepEvent(seed.id, "pr_open", { prNumber: result.prNumber });
    return result;
  };

  try {
    for (let iter = 0; iter < SAFETY_ITERATIONS; iter++) {
      // No PR/head yet (a fresh rescue): the only move is to build it. Honor the cap here too.
      if (!hasHead) {
        if (cycles >= MAX_CYCLES) return finish("needs_human", "8-cycle cap reached before a PR existed");
        const built = await runWorker({ initial: true, blockers: [], review: null });
        cycles++;
        transition({ cycles });
        hasHead = built.prNumber != null || built.headSha != null;
        review = null;
        continue;
      }

      const poll = await deps.pollCi(current);
      const escalation = deriveEscalation(dangerousTiers(poll.changedPaths), review?.judgmentCall ?? null);
      const gate = evaluateGate({
        kind: current.kind,
        preservationProven: review?.preservationProven ?? null,
        checks: poll.checks,
        reviewerRedFindings: review?.redFindings ?? null,
      });
      const action = nextSweepAction({ cycles, gate, escalation });
      store.recordSweepEvent(seed.id, "gate_eval", { blockers: gate.blockers, action: action.kind, cycles });

      switch (action.kind) {
        case "ready":
          return finish("ready");
        case "needs-human":
          return finish("needs_human", action.reason);
        case "wait-ci":
          transition({ state: "ci" });
          await deps.wait(deps.ciPollMs);
          break;
        case "spawn-reviewer":
          transition({ state: "reviewing" });
          review = await deps.review(current);
          transition({ sessionId: review.sessionId });
          store.recordSweepEvent(seed.id, "spawn", { role: "reviewer", sessionId: review.sessionId, red: review.redFindings });
          break;
        case "spawn-worker":
          await runWorker({ initial: false, blockers: gate.blockers, review });
          cycles++;
          transition({ cycles });
          review = null; // new head — the reviewer must re-run and CI re-polls fresh
          break;
      }
    }
    return finish("needs_human", "engine safety-iteration bound exceeded");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    store.recordSweepEvent(seed.id, "error", { message });
    return finish("failed", message);
  }
}
