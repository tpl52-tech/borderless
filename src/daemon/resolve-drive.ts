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
import { REOPEN_QUEUED_PATCH } from "./sweep-store.ts";

/** The store surface approve needs — satisfied by Store. */
export type ResolveStore = Pick<Store, "getSweepJob" | "transitionSweepJob" | "recordSweepEvent">;

export interface ApproveResult { ok: boolean; state?: SweepState; error?: string }

/**
 * Approve a stopped job → ready (lead override). Approvable only when the job is needs_human AND has a PR:
 * `ready` means "there is a PR to `gh pr merge`", the invariant the engine keeps (it only reaches ready with a
 * head; a PR-less job escalates instead). Any other state/shape is a no-op error the UI reports, never a silent
 * jump. Transition FIRST, then record the audit event (the engine's order — sweep-engine `finish`, the
 * reReviewAdvancedPrs reopener), so a throw between the two writes can't leave a log line claiming a state the
 * job isn't in.
 *
 * Not sticky against a head advance: an in_review job later gets re-opened to queued by reReviewAdvancedPrs if
 * the author pushes a new commit — a new head deserves fresh review. Intended.
 */
export function approveJob(store: ResolveStore, jobId: string): ApproveResult {
  const job = store.getSweepJob(jobId);
  if (!job) return { ok: false, error: "job not found" };
  if (job.state !== "needs_human") return { ok: false, error: `can't approve a ${job.state} job (only one waiting on you)` };
  if (job.prNumber == null) return { ok: false, error: "no PR to merge — this job never opened one" };
  store.transitionSweepJob(jobId, { state: "ready", reason: "lead-approved" });
  store.recordSweepEvent(jobId, "state_change", { from: "needs_human", to: "ready", by: "lead-approve" });
  return { ok: true, state: "ready" };
}

export interface RedriveResult { ok: boolean; state?: SweepState; error?: string }

/**
 * Re-drive a stopped job with the lead's guidance. Same shape-guards as approve (needs_human + has a PR) plus a
 * non-empty instruction. Re-opens the job to queued from its existing PR/head with a FRESH cycle budget and the
 * guidance stashed on the job (the next worker's seed carries it); clears the stale review/reason. The caller
 * kicks the supervisor so the engine picks it up.
 */
export function redriveJob(store: ResolveStore, jobId: string, guidance: string): RedriveResult {
  const job = store.getSweepJob(jobId);
  if (!job) return { ok: false, error: "job not found" };
  if (job.state !== "needs_human") return { ok: false, error: `can't re-drive a ${job.state} job (only one waiting on you)` };
  if (job.prNumber == null) return { ok: false, error: "no PR to re-drive — this job never opened one" };
  if (!guidance) return { ok: false, error: "add an instruction telling the agent what to change" };
  store.transitionSweepJob(jobId, { ...REOPEN_QUEUED_PATCH, leadGuidance: guidance });
  store.recordSweepEvent(jobId, "state_change", { from: "needs_human", to: "queued", by: "lead-redrive", guidance });
  return { ok: true, state: "queued" };
}
