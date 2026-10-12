/**
 * Lead Desk v2 — confirm → create (PRD §9; web console). The lead's reviewed/edited draft comes back as a
 * DeskCreateRequest; the live orchestrator (daemon) creates the epics then the tickets in Linear — assigning,
 * tagging `lead-delegated`, hanging each ticket under its epic, and DMing assignees. This is the PURE half:
 * the request/result shapes + the single issueCreate-input builder the orchestrator fills with resolved ids.
 */

import type { IssueCreateInput, CreatedIssue } from "./linear.ts";

/** An epic to create (a parent issue). */
export interface CreateEpic { title: string; project: string | null; }
/** A ticket to create, assigned to one person; `epic` names its parent epic (by title), `dm` DMs the assignee. */
export interface CreateTicket {
  title: string; assigneeLinearId: string | null; project: string | null; priority: number; epic: string | null; dm: boolean;
}
/** The lead's reviewed draft, posted to create. `draftId` dedupes a double-clicked Create (singleFlight). */
export interface DeskCreateRequest { draftId: string; epics: CreateEpic[]; tickets: CreateTicket[]; }

/** One created item, echoed back to the console. */
export interface CreatedItem { kind: "epic" | "ticket"; ticketKey: string; url: string | null; dmSent?: boolean; }
/** The create outcome: what landed in Linear + any per-item failures (fail-soft — Linear has no transaction). */
export interface DeskCreateResult { created: CreatedItem[]; errors: string[]; configured: boolean; }

/** Build the Linear issueCreate input for one delegated item; the orchestrator supplies the resolved ids. Pure. */
export function issueCreateInput(p: {
  teamId: string; projectId: string; title: string; assigneeLinearId: string | null; labelId: string;
  priority?: number; parentId?: string;
}): IssueCreateInput {
  return {
    teamId: p.teamId, projectId: p.projectId, title: p.title, description: "", assigneeId: p.assigneeLinearId,
    labelIds: [p.labelId],
    ...(p.priority !== undefined ? { priority: p.priority } : {}),
    ...(p.parentId ? { parentId: p.parentId } : {}),
  };
}

/** The injected I/O runDeskCreate orchestrates over — resolved ids + the live Linear create + Slack DM. */
export interface DeskCreateDeps {
  teamId: string;
  labelId: string;
  /** Project name → Linear project id (null when unknown — the item is skipped with an error). */
  projectIdFor: (name: string | null) => string | null;
  createIssue: (input: IssueCreateInput) => Promise<CreatedIssue>;
  /** DM the assignee about a created ticket; returns whether the DM was sent. */
  dmFor: (assigneeLinearId: string, ctx: { ticketKey: string; title: string; url: string | null }) => Promise<boolean>;
}

/**
 * Orchestrate a reviewed draft → Linear issues: epics FIRST (so a ticket can hang under its epic via parentId),
 * each tagged + assigned + prioritized, then a best-effort DM. Fail-soft PER ITEM — Linear has no transaction,
 * so a failed create (or an unknown project) is recorded and the rest proceed. Pure control flow over injected
 * I/O, so it's unit-tested without live creds (mirrors `delegate`).
 */
export async function runDeskCreate(req: DeskCreateRequest, deps: DeskCreateDeps): Promise<DeskCreateResult> {
  const created: CreatedItem[] = [];
  const errors: string[] = [];
  const epicUuid = new Map<string, string>();
  for (const epic of req.epics) {
    const projectId = deps.projectIdFor(epic.project);
    if (!projectId) { errors.push(`epic "${epic.title}": pick a known project`); continue; }
    try {
      const issue = await deps.createIssue(issueCreateInput({ teamId: deps.teamId, projectId, title: epic.title, assigneeLinearId: null, labelId: deps.labelId }));
      epicUuid.set(epic.title, issue.id);
      created.push({ kind: "epic", ticketKey: issue.ticketKey, url: issue.url });
    } catch (err) { errors.push(`epic "${epic.title}": ${errMsg(err)}`); }
  }
  for (const t of req.tickets) {
    const projectId = deps.projectIdFor(t.project);
    if (!projectId) { errors.push(`ticket "${t.title}": pick a known project`); continue; }
    try {
      const parentId = t.epic ? epicUuid.get(t.epic) : undefined;
      const issue = await deps.createIssue(issueCreateInput({ teamId: deps.teamId, projectId, title: t.title, assigneeLinearId: t.assigneeLinearId, labelId: deps.labelId, priority: t.priority, parentId }));
      const dmSent = t.dm && t.assigneeLinearId ? await deps.dmFor(t.assigneeLinearId, { ticketKey: issue.ticketKey, title: t.title, url: issue.url }) : false;
      created.push({ kind: "ticket", ticketKey: issue.ticketKey, url: issue.url, dmSent });
    } catch (err) { errors.push(`ticket "${t.title}": ${errMsg(err)}`); }
  }
  return { created, errors, configured: true };
}

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }
