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

// --- delegation (PRD §9): capture a task → a Lead Ops issue assigned to a member, + a Slack DM ---------

/**
 * Resolve a delegate from the roster by netid, GitHub login, email, or full name (case-insensitive).
 * Throws when `who` matches nobody — delegation must never silently drop a task on no one.
 */
export function resolveDelegate(roster: Member[], who: string): Member {
  const q = who.trim().toLowerCase();
  const m = roster.find((r) =>
    r.netid.toLowerCase() === q ||
    r.github.toLowerCase() === q ||
    r.name.toLowerCase() === q ||
    r.emails.some((e) => e.toLowerCase() === q));
  if (!m) throw new Error(`lead-desk: no roster member matches "${who}" (try a netid, GitHub login, email, or full name)`);
  return m;
}

/** The domain payload for a delegated task — mapped to Linear's IssueCreateInput by the live wrapper. */
export interface LeadOpsIssueInput {
  title: string;
  description: string;
  assigneeLinearId: string | null;
  projectName: string;
}

/** Build the Lead Ops issue payload for a delegated task (PRD §9). Throws on an empty title. */
export function buildLeadOpsIssueInput(
  task: { title: string; notes?: string },
  assignee: Member,
  leadOpsProject: string = DEFAULT_LEAD_OPS_PROJECT,
): LeadOpsIssueInput {
  const title = task.title.trim();
  if (!title) throw new Error("lead-desk: a delegated task needs a title");
  const notes = task.notes?.trim();
  const description = [
    notes,
    `_Captured via the Borderless lead desk, assigned to ${assignee.name} (${assignee.netid})._`,
  ].filter((p): p is string => Boolean(p)).join("\n\n");
  return { title, description, assigneeLinearId: assignee.linearIds[0] ?? null, projectName: leadOpsProject };
}

/** The Slack DM announcing a delegated task to its assignee (PRD §9). */
export function delegationDmText(assignee: Member, issue: { ticketKey: string; title: string; url: string | null }): string {
  const firstName = assignee.name.split(" ")[0];
  const link = issue.url ? `\n${issue.url}` : "";
  return `Hi ${firstName} — you've been assigned a lead-desk task: ${issue.title} (${issue.ticketKey}).${link}`;
}

/** A lead-desk delegation request: who to assign, the task title, and optional notes (PRD §9). */
export interface DelegateRequest { who: string; title: string; notes?: string }

/** The outcome of a delegation (PRD §9): the created Lead Ops issue + whether the courtesy DM went out. */
export interface DelegateResult {
  ticketKey: string | null;
  url: string | null;
  created: boolean;
  dmSent: boolean;
  assignee?: string; // resolved member name, for the console's confirmation line
  reason?: string;   // why nothing was created (e.g. no Linear key), when created is false
}
