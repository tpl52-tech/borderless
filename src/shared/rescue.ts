/**
 * Rescue-sweep eligibility — the pure "should this overdue ticket be offered for rescue?" decision (PRD §5).
 *
 * No I/O. The live scan (build order #4b) gathers the signals — the synced Linear issue, whether any
 * meaningful progress exists (branch/commits/non-draft PR, via gh), and whether the assignee is a roster
 * member — and feeds them here. Eligibility only puts a ticket in the Rescues queue; nothing auto-starts:
 * a rescue needs explicit per-ticket lead authorization (PRD §5, §12).
 */

import { LEAD_LEVEL, type LinearIssue } from "./types.ts";
import { isTerminalState } from "./boards.ts";

export interface RescueContext {
  now: number;
  /** Meaningful progress exists: a branch, commits, or a non-draft PR (checked live in 4b). */
  hasProgress: boolean;
  /** The assignee resolves to a roster member (roster.memberByLinearId). */
  isRosterMember: boolean;
}

export interface RescueEligibility {
  eligible: boolean;
  /** Why NOT eligible (empty iff eligible) — surfaced in the Rescues queue and for debugging. */
  reasons: string[];
}

const DAY_MS = 86_400_000;

/**
 * Eligible iff ALL of PRD §5's four conditions hold — the due date has passed · NOT labeled `lead-level` ·
 * no meaningful progress · the assignee is a roster member — plus one added safety guard: the ticket isn't
 * already done/canceled. Returns the failing reasons so the console can explain a ticket's status.
 *
 * Overdue uses "the due day has fully elapsed": Linear's dueDate is a timeless UTC date, so a ticket due D
 * is overdue only once `now >= D + 1 day` — never while the due day is still in progress (PRD §5 "passed").
 */
export function rescueEligibility(
  issue: Pick<LinearIssue, "dueDate" | "labels" | "assignee" | "stateType">,
  ctx: RescueContext,
): RescueEligibility {
  const reasons: string[] = [];
  if (issue.dueDate == null) reasons.push("no due date");
  else if (ctx.now < issue.dueDate + DAY_MS) reasons.push("not overdue");
  if (issue.labels.includes(LEAD_LEVEL)) reasons.push("lead-level");
  if (ctx.hasProgress) reasons.push("has progress");
  if (!issue.assignee || !ctx.isRosterMember) reasons.push("assignee not a roster member");
  // Beyond §5's four: a manually done/canceled ticket isn't work to rescue (and hasProgress alone can
  // miss a ticket closed with no branch/commits/PR).
  if (isTerminalState(issue.stateType)) reasons.push("already done/canceled");
  return { eligible: reasons.length === 0, reasons };
}

/**
 * Whole days a ticket is overdue, from its due date (for the "auto-implemented … N days overdue" comment,
 * PRD §5). Since {@link rescueEligibility} only fires once the due day has elapsed, this is ≥ 1 for any
 * actually-overdue ticket.
 */
export function daysOverdue(dueDate: number, now: number): number {
  return Math.max(0, Math.floor((now - dueDate) / DAY_MS));
}
