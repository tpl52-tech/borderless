/**
 * Resolve-drive (web SWEEPS detail panel) — the lead's decision ACTING on a sweep job stopped at needs_human.
 *
 * Phase 1 (here): APPROVE. The lead has reviewed the PR + the escalation (via the resolve-chat) and judges it
 * good, so the job moves needs_human → ready by lead fiat — overriding the dangerous-tier / judgment-call
 * escalation for this one job. `ready` is NOT merged: it just surfaces in READY_TO_MERGE for the lead to
 * `gh pr merge`. (Phase 2 — re-drive with guidance — lands later.)
 *
 * Small + injected-store so it is unit-tested; the daemon wires the real Store in.
 */

import type { Store } from "./store.ts";
import type { SweepState } from "../shared/types.ts";

/** The store surface approve needs — satisfied by Store. */
export type ResolveStore = Pick<Store, "getSweepJob" | "transitionSweepJob" | "recordSweepEvent">;

export interface ApproveResult { ok: boolean; state?: SweepState; error?: string }

/**
 * Approve a stopped job → ready (lead override). Only a needs_human job can be approved; anything else is a
 * no-op error the UI reports (never a silent state jump). Records an audit event before the transition.
 */
export function approveJob(store: ResolveStore, jobId: string, note: string): ApproveResult {
  const job = store.getSweepJob(jobId);
  if (!job) return { ok: false, error: "job not found" };
  if (job.state !== "needs_human") return { ok: false, error: `can't approve a ${job.state} job (only one waiting on you)` };
  store.recordSweepEvent(jobId, "state_change", { to: "ready", by: "lead-approve", note: note || null });
  store.transitionSweepJob(jobId, { state: "ready", reason: note ? `lead-approved: ${note}` : "lead-approved" });
  return { ok: true, state: "ready" };
}
