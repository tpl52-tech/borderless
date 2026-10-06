/**
 * Dedupe keys (design §13.5) — they encode the EVENT'S IDENTITY (review timestamp, head sha, state
 * tuple), never the row id (row-keying once messaged one PR twice in 7 minutes). PR identity is the
 * externalKey, so all siblings share a key.
 */

import type { AutonomyDecision, WorkItem } from "../../shared/types.ts";

/** The state-suffixed nudge key: red->green->red is a NEW event (design §13.5). */
export function nudgeKey(item: WorkItem): string {
  const failed = [...item.failedChecks].sort().join("|");
  return `nudge:${item.externalKey}:${item.ciState}:${item.ctoState}:${item.unresolvedComments}:${item.mergeable}:${failed}`;
}

export function dedupeKey(action: AutonomyDecision, item: WorkItem): string {
  const pr = item.externalKey;
  switch (action) {
    case "nudge-agent":
      return nudgeKey(item);
    case "cto-followups":
      return `cto-followups:${pr}:${item.ctoReviewedAt ?? "?"}`; // approvedAt
    case "review-bot-followups":
      return `review-bot-followups:${pr}:${item.reviewBotAt ?? "?"}`; // NOT head sha — the agent pushes
    case "cto-review-followups":
      return `cto-review-followups:${pr}:${item.ctoReviewedAt ?? "?"}`; // reviewedAt
    case "cto-review-delay-nudge":
      return `cto-review-delay-nudge:${pr}:${item.headSha ?? "?"}`;
    default:
      return `${action}:${pr}:${item.headSha ?? "?"}`; // request-codex / request-cto / thermo-regrade
  }
}
