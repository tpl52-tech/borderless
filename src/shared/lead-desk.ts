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
import { buildRosterIndexes, firstName, type Member } from "./roster.ts";

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

// --- Lead Desk v2 board (PRD §9; web console) ---------------------------------------------------------

/** The label the lead-desk stamps on work it dispatches; the DELEGATED panel reads the store by it. */
export const DELEGATED_LABEL = "lead-delegated";

/** One co-lead's plate: open (non-terminal) assigned issues + how many of those are blocked. */
export interface CoLeadLoadRow { name: string; netid: string; open: number; blocked: number; }

/**
 * Co-leads' load: the OTHER leads (roster `lead`, minus the current lead matched by github), each with their
 * open assigned count across ALL projects + how many are blocked. Pure — so a lead sees who's slammed before
 * delegating more.
 */
export function coLeadLoadRows(issues: LinearIssue[], roster: Member[], leadGithub?: string): CoLeadLoadRow[] {
  const self = (leadGithub ?? "").toLowerCase();
  return roster
    .filter((m) => m.lead && m.github.toLowerCase() !== self)
    .map((m) => {
      const ids = new Set(m.linearIds);
      const open = issues.filter((i) => i.assignee != null && ids.has(i.assignee) && !isTerminalState(i.stateType));
      return { name: firstName(m), netid: m.netid, open: open.length, blocked: open.filter((i) => i.blockedBy.length > 0).length };
    });
}

/** One row of the DELEGATED panel. */
export interface DelegatedRow { ticketKey: string; title: string; assignee: string; state: string; }

/** Work the lead has dispatched: open issues carrying the `lead-delegated` label, by assignee first name. Pure. */
export function delegatedRows(issues: LinearIssue[], roster: Member[], label: string = DELEGATED_LABEL): DelegatedRow[] {
  const byLinearId = buildRosterIndexes(roster).byLinearId;
  return issues
    .filter((i) => i.labels.includes(label) && !isTerminalState(i.stateType))
    .map((i) => {
      const m = i.assignee ? byLinearId.get(i.assignee) : undefined;
      return {
        ticketKey: i.identifier,
        title: i.title,
        assignee: m ? firstName(m) : (i.assignee ?? "unassigned"), // known member → first name; else raw id, else unassigned
        state: i.stateName ?? "—",
      };
    })
    .sort((a, b) => a.assignee.localeCompare(b.assignee) || a.ticketKey.localeCompare(b.ticketKey));
}

/** One epic (a parent issue) with its sub-issue completion. */
export interface EpicRow { ticketKey: string; title: string; done: number; total: number; }

/** Epics = parent issues in the synced set, with children progress (done = terminal children). Least-complete
 *  first, so the in-flight epics lead. Pure. */
export function epicRows(issues: LinearIssue[]): EpicRow[] {
  const byId = new Map(issues.map((i) => [i.id, i]));
  const children = new Map<string, LinearIssue[]>();
  for (const i of issues) {
    if (!i.parentId) continue;
    const arr = children.get(i.parentId);
    if (arr) arr.push(i); else children.set(i.parentId, [i]);
  }
  const rows: EpicRow[] = [];
  for (const [parentId, kids] of children) {
    const parent = byId.get(parentId);
    if (!parent) continue; // parent outside the synced team → can't render it
    rows.push({ ticketKey: parent.identifier, title: parent.title, done: kids.filter((k) => isTerminalState(k.stateType)).length, total: kids.length });
  }
  return rows.sort((a, b) => a.done / a.total - b.done / b.total || a.ticketKey.localeCompare(b.ticketKey));
}

/** The whole Lead Desk v2 board (web console): co-lead load, delegated work, epics. Pure. */
export interface DeskBoard { coLeads: CoLeadLoadRow[]; delegated: DelegatedRow[]; epics: EpicRow[]; }
export function deskBoard(issues: LinearIssue[], roster: Member[], leadGithub?: string): DeskBoard {
  return { coLeads: coLeadLoadRows(issues, roster, leadGithub), delegated: delegatedRows(issues, roster), epics: epicRows(issues) };
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
  const link = issue.url ? `\n${issue.url}` : "";
  return `Hi ${firstName(assignee)} — you've been assigned a lead-desk task: ${issue.title} (${issue.ticketKey}).${link}`;
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
