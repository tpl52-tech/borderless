/**
 * Focus classification — shared, pure, over WorkItem fields alone (design §14).
 *
 * Used by BOTH the daemon's autonomy rule 7 and the client's focus view, so it lives in shared and
 * stays a pure function of its inputs. The one thing focus cannot know from WorkItem fields alone is
 * whether the CTO follow-up sweep is still pending (that is derived from the audit log, §6) — callers
 * inject it; the client passes false, and autonomy (step 7) passes the real value.
 */

import type { WorkItem, Session } from "./types.ts";
import type { ReviewPolicy } from "./profile.ts";

export type WorkItemFocus =
  | "final-ready"
  | "ready-to-merge"
  | "needs-attention"
  | "waiting-review"
  | "in-progress";

export type SessionFocus = "planning" | "needs-attention" | "working";

export interface FocusOptions {
  /** whether the CTO follow-up sweep is still pending for this PR (from the audit log; §14). */
  ctoFollowupSweepPending?: boolean;
  /** grace after GitHub silence before a bad-standing PR is "needs attention" (default 20 min). */
  githubSilenceGraceMs?: number;
}

const GITHUB_SILENCE_GRACE_MS = 20 * 60 * 1000;

/** True iff a CTO changes-requested review has been addressed by a newer head (design §14). */
function ctoChangesAddressed(item: WorkItem): boolean {
  const movedPast =
    !!item.headSha && !!item.ctoReviewedSha && !prefixEq(item.headSha, item.ctoReviewedSha);
  const byTime =
    item.ctoReviewedAt != null && item.headCommittedAt != null && item.ctoReviewedAt < item.headCommittedAt;
  return (movedPast || byTime) && item.ciState === "success" && item.unresolvedComments === 0;
}

/**
 * badStanding (ordered, design §14): CI failed with a NON-EMPTY failed-check list (a failure whose
 * checks were all filtered is a phantom); CTO changes-requested unless addressed; CTO follow-up
 * comments; merge conflict (UNKNOWN stays silent); unresolved threads > 0 unless the PR is otherwise
 * finished (an unclicked resolve button is not work).
 */
export function badStanding(item: WorkItem): boolean {
  if (item.ciState === "failure" && item.failedChecks.length > 0) return true;
  if (item.ctoState === "changes-requested" && !ctoChangesAddressed(item)) return true;
  if (item.ctoState === "commented-after-approval") return true;
  if (item.mergeable === "CONFLICTING") return true; // UNKNOWN stays silent
  if (item.unresolvedComments > 0 && !otherwiseFinished(item)) return true;
  return false;
}

function otherwiseFinished(item: WorkItem): boolean {
  return item.ciState === "success" && item.mergeable === "MERGEABLE" &&
    (item.ctoState === "approved" || item.codexState === "approved");
}

/** reviewApproved: CTO required -> approved; else codex required -> approved; else true (design §14). */
export function reviewApproved(item: WorkItem, policy: ReviewPolicy): boolean {
  if (policy.cto) return item.ctoState === "approved";
  if (policy.codex) return item.codexState === "approved";
  return true;
}

/**
 * isReadyToMerge (design §14): PR, OPEN, not draft, mergeable exactly MERGEABLE, CI success, review
 * approved, CTO follow-up sweep not pending, codex not `requested`. Open threads and an unaddressed
 * code-quality review are CAVEATS, not disqualifiers.
 */
export function isReadyToMerge(item: WorkItem, policy: ReviewPolicy, opts: FocusOptions = {}): boolean {
  return item.kind === "pr" &&
    item.prState === "OPEN" &&
    !item.isDraft &&
    item.mergeable === "MERGEABLE" &&
    item.ciState === "success" &&
    reviewApproved(item, policy) &&
    !opts.ctoFollowupSweepPending &&
    item.codexState !== "requested";
}

/** classifyWorkItem (design §14). */
export function classifyWorkItem(
  item: WorkItem,
  now: number,
  policy: ReviewPolicy,
  opts: FocusOptions = {},
): WorkItemFocus {
  if (item.kind !== "pr" || item.lifecycle !== "active" || item.prState !== "OPEN" || item.isDraft) {
    return "in-progress";
  }
  if (badStanding(item)) {
    const silence = opts.githubSilenceGraceMs ?? GITHUB_SILENCE_GRACE_MS;
    const quietSince = item.remoteUpdatedAt ?? item.updatedAt;
    return now - quietSince >= silence ? "needs-attention" : "in-progress";
  }
  if (isReadyToMerge(item, policy, opts)) {
    const finalReady =
      item.operatorAckedAt != null &&
      item.outstandingReviewerTags.length === 0 &&
      item.unresolvedComments === 0 &&
      item.reviewBotState !== "reviewed";
    return finalReady ? "final-ready" : "ready-to-merge";
  }
  if (item.codexState === "requested" || item.ctoState === "requested") return "waiting-review";
  return "in-progress";
}

/**
 * classifySession (design §14): planning wins; needs-input/done/error/stuck -> needs-attention; a live
 * (working/starting) agent silent >= agentSilenceMs -> needs-attention; else working.
 */
export function classifySession(session: Session, now: number, agentSilenceMs: number): SessionFocus {
  if (session.planning) return "planning";
  const status = session.status ?? "exited";
  if (status === "needs-input" || status === "done" || status === "error" || status === "stuck") {
    return "needs-attention";
  }
  if ((status === "working" || status === "starting") &&
      session.lastActivityAt != null && now - session.lastActivityAt >= agentSilenceMs) {
    return "needs-attention";
  }
  return "working";
}

/** Prefix-compare two commit shas (GitHub abbreviates; a prefix match counts, design §12.4). */
export function prefixEq(a: string, b: string): boolean {
  const n = Math.min(a.length, b.length);
  return n >= 7 && a.slice(0, n) === b.slice(0, n);
}
