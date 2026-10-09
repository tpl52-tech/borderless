/**
 * Linear issue sync — the pure pieces (lead-console PRD §4, build order #2).
 *
 * The GraphQL query + the response mapper live here (no I/O, fully testable). The live POST and the
 * paginated upsert loop are in `src/daemon/linear.ts`. The assignee is stored as the Linear USER id
 * so `roster.memberByLinearId` can resolve it to a person (see `src/shared/roster.ts`).
 */

/** One `linear_issues` upsert row, mapped from a Linear GraphQL issue node. */
export interface LinearIssueUpsert {
  id: string; // Linear issue UUID (primary key)
  identifier: string; // e.g. COR-42
  title: string;
  description: string | null; // issue body/ACs; embedded in a rescue worker's seed (PRD §5)
  url: string | null;
  stateName: string | null;
  stateType: string | null;
  assignee: string | null; // Linear user id — the roster.memberByLinearId key
  projectId: string | null;
  projectName: string | null; // project name; the "Lead Ops" project is excluded from both sweeps (PRD §9)
  teamKey: string | null;
  priority: number | null;
  dueDate: number | null; // epoch ms; feeds the rescue overdue check (PRD §5)
  labels: string[]; // label names; `lead-level` excludes a ticket from rescue
  blockedBy: string[]; // ids of issues that block this one; feeds the boards critical path (PRD §7)
  gitBranchName: string | null; // Linear's suggested branch — matches the team's PR branches (PRD §4)
  updatedAt: number | null; // epoch ms
}

/** A page of mapped issues plus the cursor to continue from. */
export interface IssuesPage {
  issues: LinearIssueUpsert[];
  hasNextPage: boolean;
  endCursor: string | null;
}

/** GraphQL to page a team's issues. Linear excludes archived issues by default. */
export const ISSUES_QUERY = `
query BorderlessIssues($filter: IssueFilter, $after: String) {
  issues(filter: $filter, first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id identifier title description url priority updatedAt dueDate branchName
      state { name type }
      assignee { id }
      project { id name }
      team { key }
      labels(first: 50) { nodes { name } }  # cap high: missing a lead-level label would mis-admit a rescue
      inverseRelations(first: 50) { nodes { type issue { id } } }  # relations pointing AT this issue; type=blocks → a blocker
    }
  }
}`;

/** Variables for {@link ISSUES_QUERY}: one team's issues, optionally continuing after a cursor. */
export function issuesVariables(teamKey: string, after: string | null = null): { filter: unknown; after: string | null } {
  return { filter: { team: { key: { eq: teamKey } } }, after };
}

// A narrow view of the GraphQL response — just the fields the mapper reads. External JSON, so the
// boundary is explicit here rather than trusting a wide type.
interface RawIssueNode {
  id: string;
  identifier: string;
  title?: string | null;
  description?: string | null;
  url?: string | null;
  priority?: number | null;
  updatedAt?: string | null;
  dueDate?: string | null;
  branchName?: string | null;
  state?: { name?: string | null; type?: string | null } | null;
  assignee?: { id?: string | null } | null;
  project?: { id?: string | null; name?: string | null } | null;
  team?: { key?: string | null } | null;
  labels?: { nodes?: Array<{ name?: string | null }> } | null;
  inverseRelations?: { nodes?: Array<{ type?: string | null; issue?: { id?: string | null } | null }> } | null;
}
interface RawIssuesResponse {
  data?: { issues?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; nodes?: RawIssueNode[] } };
}

/** Map a Linear GraphQL issues response to upsert rows + the pagination cursor. */
export function parseIssuesResponse(json: unknown): IssuesPage {
  const conn = (json as RawIssuesResponse | null)?.data?.issues;
  const nodes = conn?.nodes ?? [];
  const issues = nodes.map((n): LinearIssueUpsert => {
    const t = n.updatedAt ? Date.parse(n.updatedAt) : NaN;
    const due = n.dueDate ? Date.parse(n.dueDate) : NaN;
    return {
      id: n.id,
      identifier: n.identifier,
      title: n.title ?? "",
      description: n.description ?? null,
      url: n.url ?? null,
      stateName: n.state?.name ?? null,
      stateType: n.state?.type ?? null,
      assignee: n.assignee?.id ?? null,
      projectId: n.project?.id ?? null,
      projectName: n.project?.name ?? null,
      teamKey: n.team?.key ?? null,
      priority: typeof n.priority === "number" ? n.priority : null,
      dueDate: Number.isNaN(due) ? null : due,
      labels: (n.labels?.nodes ?? []).map((l) => l.name).filter((name): name is string => typeof name === "string"),
      // inverseRelations point AT this issue; a type="blocks" relation's `issue` is a ticket that blocks it.
      blockedBy: (n.inverseRelations?.nodes ?? [])
        .filter((r) => r.type === "blocks")
        .map((r) => r.issue?.id)
        .filter((id): id is string => typeof id === "string"),
      gitBranchName: n.branchName ?? null,
      updatedAt: Number.isNaN(t) ? null : t,
    };
  });
  return {
    issues,
    hasNextPage: Boolean(conn?.pageInfo?.hasNextPage),
    endCursor: conn?.pageInfo?.endCursor ?? null,
  };
}

// --- lead-desk delegation (PRD §9): resolve the Lead Ops target ids, then create the issue -----------

/** The team id (by key) + the Lead Ops project id (by name) — both needed to create a delegated issue. */
export const LEAD_OPS_TARGETS_QUERY = `
query BorderlessLeadOpsTargets($teamKey: String!, $project: String!) {
  teams(filter: { key: { eq: $teamKey } }, first: 1) { nodes { id } }
  projects(filter: { name: { eq: $project } }, first: 1) { nodes { id } }
}`;

export interface LeadOpsTargets { teamId: string; projectId: string; }

/** Parse {@link LEAD_OPS_TARGETS_QUERY}; throws a clear error if the team or the project is missing. */
export function parseLeadOpsTargets(json: unknown, teamKey: string, project: string): LeadOpsTargets {
  const data = (json as { data?: { teams?: { nodes?: Array<{ id?: string }> }; projects?: { nodes?: Array<{ id?: string }> } } } | null)?.data;
  const teamId = data?.teams?.nodes?.[0]?.id;
  const projectId = data?.projects?.nodes?.[0]?.id;
  if (!teamId) throw new Error(`lead-desk: no Linear team with key "${teamKey}"`);
  if (!projectId) throw new Error(`lead-desk: no Linear project named "${project}" (create it, or set leadOpsProject)`);
  return { teamId, projectId };
}

// --- Manual-QA sub-issue targets (PRD §13) -----------------------------------------------------------------

/**
 * Resolve, in one round-trip, what creating manual-QA sub-issues needs: the team id, the `manual-qa` label id,
 * and the dev tickets that ALREADY have a `manual-qa` child (so the plan stays idempotent). `$label` is the
 * label name; the issues page is the existing children with their parent identifiers.
 */
export const QA_TARGETS_QUERY = `
query BorderlessQaTargets($teamKey: String!, $label: String!) {
  teams(filter: { key: { eq: $teamKey } }, first: 1) { nodes { id } }
  issueLabels(filter: { name: { eq: $label } }, first: 1) { nodes { id } }
  issues(filter: { team: { key: { eq: $teamKey } }, labels: { name: { eq: $label } } }, first: 250) {
    nodes { parent { identifier } }
  }
}`;

export interface QaTargets { teamId: string; labelId: string; existingParentKeys: string[] }

/** Parse {@link QA_TARGETS_QUERY}; throws if the team or the `manual-qa` label is missing (fails loud). */
export function parseQaTargets(json: unknown, teamKey: string, label: string): QaTargets {
  const data = (json as {
    data?: {
      teams?: { nodes?: Array<{ id?: string }> };
      issueLabels?: { nodes?: Array<{ id?: string }> };
      issues?: { nodes?: Array<{ parent?: { identifier?: string } | null }> };
    };
  } | null)?.data;
  const teamId = data?.teams?.nodes?.[0]?.id;
  const labelId = data?.issueLabels?.nodes?.[0]?.id;
  if (!teamId) throw new Error(`verify-qa: no Linear team with key "${teamKey}"`);
  if (!labelId) throw new Error(`verify-qa: no Linear label named "${label}" — create it once in the workspace`);
  const existingParentKeys = (data?.issues?.nodes ?? [])
    .map((n) => n.parent?.identifier)
    .filter((k): k is string => typeof k === "string");
  return { teamId, labelId, existingParentKeys };
}

/** Create one Linear issue (used for lead-desk delegation, PRD §9). */
export const ISSUE_CREATE_MUTATION = `
mutation BorderlessIssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue { identifier url }
  }
}`;

/** The Linear-API-shaped input to {@link ISSUE_CREATE_MUTATION} (passed as `{ input }` in the variables). */
export interface IssueCreateInput {
  teamId: string;
  projectId: string;
  title: string;
  description: string;
  assigneeId: string | null;
  /** Optional: make this a sub-issue of the given issue UUID (manual-QA children hang under the dev ticket). */
  parentId?: string;
  /** Optional: label UUIDs to attach on create (the manual-QA child gets the `manual-qa` label). */
  labelIds?: string[];
}

export interface CreatedIssue { ticketKey: string; url: string | null; }

/** Parse {@link ISSUE_CREATE_MUTATION}; throws if the mutation didn't succeed (fails loud, never silent). */
export function parseIssueCreate(json: unknown): CreatedIssue {
  const r = (json as { data?: { issueCreate?: { success?: boolean; issue?: { identifier?: string; url?: string | null } } } } | null)?.data?.issueCreate;
  if (!r?.success || !r.issue?.identifier) throw new Error("lead-desk: Linear issueCreate did not succeed");
  return { ticketKey: r.issue.identifier, url: r.issue.url ?? null };
}

// --- Ask Borderless fleet writes (PRD §10): reassign an issue, comment on an issue --------------------

/** Reassign an issue. `id` is the issue UUID; `input.assigneeId` the new assignee's Linear user id. */
export const ISSUE_UPDATE_MUTATION = `
mutation BorderlessIssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success issue { identifier url } }
}`;

/** Parse {@link ISSUE_UPDATE_MUTATION}; fails loud on !success. */
export function parseIssueUpdate(json: unknown): { ticketKey: string; url: string | null } {
  const r = (json as { data?: { issueUpdate?: { success?: boolean; issue?: { identifier?: string; url?: string | null } } } } | null)?.data?.issueUpdate;
  if (!r?.success || !r.issue?.identifier) throw new Error("ask: Linear issueUpdate did not succeed");
  return { ticketKey: r.issue.identifier, url: r.issue.url ?? null };
}

/** Comment on an issue. `input.issueId` is the issue UUID; `input.body` the markdown comment. */
export const COMMENT_CREATE_MUTATION = `
mutation BorderlessCommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { url } }
}`;

/** Parse {@link COMMENT_CREATE_MUTATION}; fails loud on !success. */
export function parseCommentCreate(json: unknown): { url: string | null } {
  const r = (json as { data?: { commentCreate?: { success?: boolean; comment?: { url?: string | null } } } } | null)?.data?.commentCreate;
  if (!r?.success) throw new Error("ask: Linear commentCreate did not succeed");
  return { url: r.comment?.url ?? null };
}
