/**
 * Lead-desk delegation (PRD §9) — capture a task → a Lead Ops Linear issue assigned to the chosen
 * member, then a best-effort Slack DM.
 *
 * `delegate` is pure control flow over injected I/O (createIssue + sendDm), so the orchestration is
 * unit-tested without live creds. `liveCreateIssue` is the thin live wrapper: it resolves the team +
 * Lead Ops project ids, then runs Linear's issueCreate — built on the same {@link LinearClient} the
 * sync uses (a mutation is just another GraphQL POST). No gate, no agent (PRD §9).
 */

import type { LinearClient } from "./linear.ts";
import {
  LEAD_OPS_TARGETS_QUERY, parseLeadOpsTargets,
  ISSUE_CREATE_MUTATION, parseIssueCreate, type CreatedIssue,
} from "../shared/linear.ts";
import {
  resolveDelegate, buildLeadOpsIssueInput, delegationDmText,
  type LeadOpsIssueInput, type DelegateRequest, type DelegateResult,
} from "../shared/lead-desk.ts";
import type { Member } from "../shared/roster.ts";

export type { DelegateRequest, DelegateResult }; // re-exported for daemon-layer consumers

export interface DelegateDeps {
  roster: Member[];
  leadOpsProject?: string;
  createIssue(input: LeadOpsIssueInput): Promise<CreatedIssue>;
  sendDm(emails: string[], text: string): Promise<boolean>;
}

/**
 * Orchestrate one delegation: resolve the member → create the Lead Ops issue → best-effort DM. Throws
 * only on a bad request (unknown member, empty title) or a failed issue create; the DM never throws.
 */
export async function delegate(deps: DelegateDeps, req: DelegateRequest): Promise<DelegateResult> {
  const member = resolveDelegate(deps.roster, req.who);
  const input = buildLeadOpsIssueInput({ title: req.title, notes: req.notes }, member, deps.leadOpsProject);
  const issue = await deps.createIssue(input);
  const dmSent = await deps.sendDm(member.emails, delegationDmText(member, { ...issue, title: input.title }));
  return { ticketKey: issue.ticketKey, url: issue.url, created: true, dmSent, assignee: member.name };
}

/**
 * Live: create a Lead Ops issue via Linear — resolve the team + project ids, then issueCreate. The team
 * is the first configured team key (single-team orgs); the project is matched by name across the workspace.
 */
export function liveCreateIssue(client: LinearClient, teamKey: string): (input: LeadOpsIssueInput) => Promise<CreatedIssue> {
  return async (input) => {
    const { teamId, projectId } = parseLeadOpsTargets(
      await client.query(LEAD_OPS_TARGETS_QUERY, { teamKey, project: input.projectName }),
      teamKey, input.projectName,
    );
    const createInput = { teamId, projectId, title: input.title, description: input.description, assigneeId: input.assigneeLinearId };
    return parseIssueCreate(await client.query(ISSUE_CREATE_MUTATION, { input: createInput }));
  };
}
