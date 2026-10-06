/**
 * Rescue-sweep eligibility — the pure "should this overdue ticket be offered for rescue?" decision (PRD §5).
 *
 * No I/O. The live scan (build order #4b) gathers the signals — the synced Linear issue, whether any
 * meaningful progress exists (branch/commits/non-draft PR, via gh), and whether the assignee is a roster
 * member — and feeds them here. Eligibility only puts a ticket in the Rescues queue; nothing auto-starts:
 * a rescue needs explicit per-ticket lead authorization (PRD §5, §12).
 */

import type { LinearIssue } from "./types.ts";

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

const LEAD_LEVEL = "lead-level";

/**
 * Eligible iff ALL hold (PRD §5): the due date has passed · NOT labeled `lead-level` · no meaningful
 * progress · the assignee is a roster member · the ticket isn't already done/canceled. Returns the
 * failing reasons so the console can explain why a ticket is or isn't a rescue candidate.
 */
export function rescueEligibility(
  issue: Pick<LinearIssue, "dueDate" | "labels" | "assignee" | "stateType">,
  ctx: RescueContext,
): RescueEligibility {
  const reasons: string[] = [];
  if (issue.dueDate == null || issue.dueDate >= ctx.now) reasons.push("not overdue");
  if (issue.labels.includes(LEAD_LEVEL)) reasons.push("lead-level");
  if (ctx.hasProgress) reasons.push("has progress");
  if (!issue.assignee || !ctx.isRosterMember) reasons.push("assignee not a roster member");
  if (issue.stateType === "completed" || issue.stateType === "canceled") reasons.push("already done/canceled");
  return { eligible: reasons.length === 0, reasons };
}

/** Whole days a ticket is overdue (for the "auto-implemented … N days overdue" comment, PRD §5). */
export function daysOverdue(dueDate: number, now: number): number {
  return Math.max(0, Math.floor((now - dueDate) / 86_400_000));
}
