/**
 * Autonomy policy — a PURE, deterministic decision function (design §13.1, §13.4).
 *
 * Over (work item, field changes since last tick, agent activity, session, now, injected store-backed
 * lookups) -> EXACTLY ONE decision per item per tick, FIRST MATCHING RULE WINS. No model votes on
 * typing into an agent; models only word human alerts.
 *
 * Bias toward inaction: suppressing a nudge costs one tick; a duplicate instruction typed mid-fix
 * corrupts work that cannot be undone. Cost of first-match-wins = STARVATION, so a large fraction of the
 * design is anti-starvation machinery (handover stamps, attempt backoffs, act-time freshness).
 *
 * The store-backed lookups (handover stamps, attempted backoffs) are INJECTED so the function stays
 * pure and unit-testable. Rule order below IS the design.
 */

import { badStanding, isReadyToMerge, prefixEq } from "../../shared/focus.ts";
import type { ReviewPolicy } from "../../shared/profile.ts";
import type { AutonomyDecision, WorkItem, Session } from "../../shared/types.ts";
import { dedupeKey } from "./keys.ts";

export const THRESHOLDS = {
  monitorTaskEvidenceMs: 20 * 60 * 1000,
  prLinkEvidenceMs: 10 * 60 * 1000,
  idleEvidenceMs: 5 * 60 * 1000,
  waitingSustainedMs: 3 * 60 * 1000,
  stallMs: 45 * 60 * 1000,
  followupRetryBackoffMs: 20 * 60 * 1000, // == the actuator cooldown
  thermoCycleCap: 3,
} as const;

export type ActivityFidelity = "authoritative" | "inferred" | "none";

export interface AgentActivity {
  fidelity: ActivityFidelity;
  state: "busy" | "idle" | "waiting" | "unknown";
  endedWithQuestion: boolean;
  statusSince: number;
  /** §13.3 predicate result: is the owning agent actively handling THIS PR? */
  handlingThisPr: boolean;
}

export interface FieldChanges {
  ciToFailure: boolean;
  ctoToChanges: boolean;
  ctoToCommentedAfterApproval: boolean;
  newCtoReviewTimestamp: boolean;
  unresolvedRising: boolean;
  mergeableToConflicting: boolean;
}

export interface Handover {
  reviewBotHandedOver: boolean;
  ctoReviewHandedOver: boolean;
  ctoFollowupSwept: boolean;
  /** within the 20-min attempted backoff for this action? */
  attemptedRecently: (action: AutonomyDecision) => boolean;
}

export interface PolicyInputs {
  now: number;
  item: WorkItem;
  session: Session;
  reviewPolicy: ReviewPolicy;
  activity: AgentActivity;
  changes: FieldChanges;
  handover: Handover;
  ctoLogin?: string;
  ctoReviewDelayNudgeMinutes: number;
  /** transition-stamped "bad state entered at" clock for stalled (fixes the §21 updatedAt gap). */
  badStateSince: number | null;
  /** the newest focus evidence is at/after the change clock (evidence-postdates-change gate, §13.4). */
  evidencePostdatesChange?: boolean;
}

export interface PolicyResult {
  decision: AutonomyDecision;
  dedupeKey: string;
  message?: string;
  reason: string;
}

const none = (reason: string): PolicyResult => ({ decision: "none", dedupeKey: "", reason });

/** §13.3: is the owning agent handling this PR? (injected via activity.handlingThisPr). */
export function isAgentHandling(inputs: PolicyInputs): boolean {
  if (inputs.activity.fidelity === "none") return false; // blind
  return inputs.activity.handlingThisPr;
}

function anyBadTransition(c: FieldChanges): boolean {
  return c.ciToFailure || c.ctoToChanges || c.ctoToCommentedAfterApproval ||
    c.newCtoReviewTimestamp || c.unresolvedRising || c.mergeableToConflicting;
}

function faultMessage(item: WorkItem, c: FieldChanges): string {
  if (c.mergeableToConflicting || item.mergeable === "CONFLICTING") {
    return "This PR has a merge conflict. MERGE the base branch — do NOT rebase (rebasing rewrites pushed commits and invalidates every review anchor).";
  }
  if (c.ciToFailure || (item.ciState === "failure" && item.failedChecks.length)) {
    return `CI is failing: ${item.failedChecks.join(", ") || "see checks"}. Fix it and push.`;
  }
  if (c.ctoToChanges) return "The reviewer requested changes. Address them and push.";
  if (c.ctoToCommentedAfterApproval) return "The reviewer left follow-up comments after approving. Address them.";
  if (c.unresolvedRising || item.unresolvedComments > 0) {
    return "There are unresolved review threads. Address each AND mark it resolved (use the paginated GraphQL resolve).";
  }
  return "This PR needs attention.";
}

const codexCoversHead = (item: WorkItem): boolean =>
  !!item.codexReviewedSha && !!item.headSha && prefixEq(item.headSha, item.codexReviewedSha);

/**
 * Decide the single action for one work item this tick (design §13.4). Rule order is the design.
 */
export function decide(inputs: PolicyInputs): PolicyResult {
  const { item, activity, changes, handover, now, reviewPolicy } = inputs;
  const key = (a: AutonomyDecision) => dedupeKey(a, item);
  const bad = anyBadTransition(changes);

  // Rule 0 — cannot see the agent.
  if (activity.state === "unknown") {
    return bad
      ? { decision: "alert-human", dedupeKey: `agent-dead:${item.externalKey}:${item.headSha}`, reason: "agent not running on a bad transition" }
      : none("agent activity unknown, no bad transition");
  }
  // fidelity `none` (codex/copilot): fall through so their one-shot handovers still fire (§13.4 r0).

  // Rule 1 — draft.
  if (item.isDraft) return none("draft: red CI is expected");

  // Rule 1.5 — code-quality review handover (before fault rules: an agent can't discover it itself).
  if (item.prState === "OPEN" && item.reviewBotState === "reviewed" && item.reviewBotAt != null &&
      !handover.reviewBotHandedOver && !handover.attemptedRecently("review-bot-followups")) {
    return { decision: "review-bot-followups", dedupeKey: key("review-bot-followups"),
      reason: "code-quality review posted, not yet handed over",
      message: "A code-quality review was posted. Read it, fix what you haven't addressed, reply where a finding is wrong; then do a complete review-readiness pass (resolve threads you fixed, reply where you disagree)." };
  }

  // Rule 1.6 — non-approving CTO review handover.
  if (item.ctoState === "reviewed" && item.ctoReviewedAt != null &&
      !handover.ctoReviewHandedOver && !handover.attemptedRecently("cto-review-followups")) {
    return { decision: "cto-review-followups", dedupeKey: key("cto-review-followups"),
      reason: "non-approving CTO review, not yet handed over",
      message: "The reviewer left a non-approving review. Read it and address the feedback." };
  }

  // Rule 1.7 — CTO approval sweep.
  if (item.ctoState === "approved" && item.ctoReviewedAt != null && item.prState !== "MERGED" &&
      reviewPolicy.ctoFollowups && !handover.ctoFollowupSwept && !handover.attemptedRecently("cto-followups")) {
    return { decision: "cto-followups", dedupeKey: key("cto-followups"),
      reason: "CTO approved, sweep not yet run",
      message: "Read the newest approval body. If it explicitly defers something, size it (small: do it now in the PR, reply, no ticket; large: open one ticket quoting the reviewer and post one PR comment). If nothing is deferred, file nothing. Then complete the whole-PR review pass." };
  }

  // Rules 2/3/4 — fault nudge.
  if (bad || badStanding(item)) {
    if (isAgentHandling(inputs)) {
      if (inputs.badStateSince != null && now - inputs.badStateSince >= THRESHOLDS.stallMs) {
        return { decision: "alert-human", dedupeKey: `stalled:${item.externalKey}:${item.headSha}`, reason: "stalled while the agent is handling it" };
      }
      return none("agent is handling this PR");
    }
    if (inputs.evidencePostdatesChange) return none("focus evidence postdates the change");
    // (activity.state === "unknown" is already handled by rule 0's early return.)
    return { decision: "nudge-agent", dedupeKey: key("nudge-agent"), reason: "fault, agent idle", message: faultMessage(item, changes) };
  }

  // Rule 5 — agent blocked on a question.
  if (activity.fidelity === "authoritative" && now - activity.statusSince >= THRESHOLDS.waitingSustainedMs &&
      (activity.state === "waiting" || activity.endedWithQuestion)) {
    return { decision: "alert-human", dedupeKey: `needs-input:${item.externalKey}:${activity.statusSince}`, reason: "agent blocked on a question" };
  }

  // Rule 5.5 — thermo regrade (before review requests: codex/CTO queues are shared and expensive).
  if (item.ciState === "success" && item.thermoGrade !== "A" && item.thermoCycles < THRESHOLDS.thermoCycleCap &&
      !isReadyToMerge(item, reviewPolicy)) {
    const last = item.thermoCycles >= THRESHOLDS.thermoCycleCap - 1 ? " This is the LAST pass." : "";
    return { decision: "thermo-regrade", dedupeKey: key("thermo-regrade"), reason: "CI green but grade != A",
      message: `Run the graded self-review, fix, and post the new THERMO GRADE line.${last}` };
  }

  // Rule 6 — request codex.
  if (item.ciState === "success" && item.prState === "OPEN" && reviewPolicy.codex && item.codexState !== "requested") {
    const neverAsked = item.codexState === "none" && item.ctoState === "none";
    const codexStale = item.codexState === "reviewed" && !codexCoversHead(item);
    const ctoStaleNeedsCodex = (item.ctoState === "stale-approval" || item.ctoState === "reviewed") && !codexCoversHead(item);
    if (neverAsked || codexStale || ctoStaleNeedsCodex) {
      return { decision: "request-codex", dedupeKey: key("request-codex"), reason: "codex review needed" };
    }
  }

  // Rule 6.1a — CTO review delay nudge (checked before 6.1 so a suppressed request can't starve it).
  if (inputs.ctoReviewDelayNudgeMinutes > 0 && inputs.ctoLogin && item.ciState === "success" &&
      codexCoversHead(item) && item.unresolvedComments === 0 &&
      (item.ctoState === "none" || item.ctoState === "requested") &&
      item.headObservedAt != null && now - item.headObservedAt >= inputs.ctoReviewDelayNudgeMinutes * 60000 &&
      !handover.attemptedRecently("cto-review-delay-nudge")) {
    return { decision: "cto-review-delay-nudge", dedupeKey: key("cto-review-delay-nudge"), reason: "CTO review overdue" };
  }

  // Rule 6.1 — request CTO.
  if (reviewPolicy.cto && item.ciState === "success" && item.prState === "OPEN" && codexCoversHead(item) &&
      item.unresolvedComments === 0 && item.ctoState !== "requested" &&
      (item.ctoState === "none" || item.ctoState === "stale-approval" ||
       (item.ctoState === "changes-requested") || item.ctoState === "reviewed")) {
    return { decision: "request-cto", dedupeKey: key("request-cto"), reason: "ready for CTO review" };
  }

  // Rule 7 — ready to merge (alert).
  if (isReadyToMerge(item, reviewPolicy)) {
    return { decision: "alert-human", dedupeKey: `ready-to-merge:${item.externalKey}:${item.remoteUpdatedAt}:${item.unresolvedComments}:${item.reviewBotState}`, reason: "ready to merge" };
  }

  // Rule 9 — stalled (transition-stamped clock, fixing the §21 gap).
  if ((item.ciState === "failure" || item.ctoState === "changes-requested" || item.ctoState === "commented-after-approval") &&
      inputs.badStateSince != null && now - inputs.badStateSince >= THRESHOLDS.stallMs) {
    return { decision: "alert-human", dedupeKey: `stalled:${item.externalKey}:${item.headSha}`, reason: "stalled" };
  }

  return none("nothing to do");
}
