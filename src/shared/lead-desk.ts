/**
 * Lead desk — the "Lead Ops" project predicate + overview (PRD §9).
 *
 * Lead-desk tasks are human to-dos, not agent work: they materialize as Linear issues in a dedicated
 * "Lead Ops" project and must never be driven by either sweep (the in-review drive or the rescue
 * implement). This module owns the single predicate both sweeps consult, so "what counts as Lead Ops"
 * lives in one place; `deskOverview` is the pure read behind the console's desk panel. No gates, no agents.
 */

import type { LinearIssue } from "./types.ts";
import { isTerminalState } from "./boards.ts";
import { buildRosterIndexes, type Member } from "./roster.ts";

/** Default name of the lead-desk project; overridable via operator config (PRD §9). */
export const DEFAULT_LEAD_OPS_PROJECT = "Lead Ops";

/** True iff the issue is in the lead-desk ("Lead Ops") project — excluded from BOTH sweeps (PRD §9). */
export function isLeadOps(
  issue: Pick<LinearIssue, "projectName">,
  leadOpsProject: string = DEFAULT_LEAD_OPS_PROJECT,
): boolean {
  return issue.projectName === leadOpsProject; // a null projectName never matches
}

/** A row of the lead-desk overview. */
export interface DeskRow {
  ticketKey: string;
  title: string;
  assignee: string; // roster name, else the raw Linear id, else "unassigned"
  state: string;
}

/**
 * Open lead-desk tasks for the overview (PRD §9): the Lead Ops project's non-terminal issues, with the
 * assignee resolved to a roster name. Pure — the console's desk panel is a plain task list, no gate.
 */
export function deskOverview(
  issues: LinearIssue[],
  roster: Member[],
  leadOpsProject: string = DEFAULT_LEAD_OPS_PROJECT,
): DeskRow[] {
  const byLinearId = buildRosterIndexes(roster).byLinearId;
  return issues
    .filter((i) => isLeadOps(i, leadOpsProject) && !isTerminalState(i.stateType))
    .map((i) => ({
      ticketKey: i.identifier,
      title: i.title,
      assignee: i.assignee ? (byLinearId.get(i.assignee)?.name ?? i.assignee) : "unassigned",
      state: i.stateName ?? "—",
    }));
}
