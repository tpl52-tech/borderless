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
  parentId: string | null; // parent/epic issue UUID when this is a sub-issue (lead-desk epics)
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
      parent { id }  # the epic/parent issue, when this is a sub-issue (lead-desk epics)
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
  parent?: { id?: string | null } | null;
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
      parentId: n.parent?.id ?? null,
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

/** The team id + `manual-qa` label id needed to create a sub-issue — resolved in one round-trip. */
export const QA_TARGETS_QUERY = `
query BorderlessQaTargets($teamKey: String!, $label: String!) {
  teams(filter: { key: { eq: $teamKey } }, first: 1) { nodes { id } }
  issueLabels(filter: { name: { eq: $label } }, first: 1) { nodes { id } }
}`;

/** The runner's input: the create targets + the dev keys that already have a `manual-qa` child (idempotency). */
export interface QaTargets { teamId: string; labelId: string; existingParentKeys: string[] }

/** Parse {@link QA_TARGETS_QUERY} → the team + label ids; throws if either is missing (fails loud). */
export function parseQaTargets(json: unknown, teamKey: string, label: string): { teamId: string; labelId: string } {
  const data = (json as { data?: { teams?: { nodes?: Array<{ id?: string }> }; issueLabels?: { nodes?: Array<{ id?: string }> } } } | null)?.data;
  const teamId = data?.teams?.nodes?.[0]?.id;
  const labelId = data?.issueLabels?.nodes?.[0]?.id;
  if (!teamId) throw new Error(`verify-qa: no Linear team with key "${teamKey}"`);
  if (!labelId) throw new Error(`verify-qa: no Linear label named "${label}" — create it once in the workspace`);
  return { teamId, labelId };
}

// --- Lead Desk v2 create targets: team + Lead Ops project + the lead-delegated label, in ONE round-trip ---

/** The team id + Lead Ops project id + the lead-delegated label id, resolved together (lead-desk create). */
export const DESK_TARGETS_QUERY = `
query BorderlessDeskTargets($teamKey: String!, $project: String!, $label: String!) {
  teams(filter: { key: { eq: $teamKey } }, first: 1) { nodes { id } }
  projects(filter: { name: { eq: $project } }, first: 1) { nodes { id } }
  issueLabels(filter: { name: { eq: $label } }, first: 1) { nodes { id } }
}`;

/** Parse {@link DESK_TARGETS_QUERY} → team id + Lead Ops project id + an OPTIONAL label id (null when the
 *  label doesn't exist yet, so the caller can create it). Team + project must exist (fails loud). */
export function parseDeskTargets(json: unknown, teamKey: string, project: string): { teamId: string; projectId: string; labelId: string | null } {
  const data = (json as { data?: { teams?: { nodes?: Array<{ id?: string }> }; projects?: { nodes?: Array<{ id?: string }> }; issueLabels?: { nodes?: Array<{ id?: string }> } } } | null)?.data;
  const teamId = data?.teams?.nodes?.[0]?.id;
  const projectId = data?.projects?.nodes?.[0]?.id;
  if (!teamId) throw new Error(`lead-desk: no Linear team with key "${teamKey}"`);
  if (!projectId) throw new Error(`lead-desk: no Linear project named "${project}" (create it, or set leadOpsProject)`);
  return { teamId, projectId, labelId: data?.issueLabels?.nodes?.[0]?.id ?? null };
}

/** Create a workspace label (the lead-desk's `lead-delegated` tag, made once on first use). */
export const ISSUE_LABEL_CREATE_MUTATION = `
mutation BorderlessLabelCreate($input: IssueLabelCreateInput!) {
  issueLabelCreate(input: $input) { success issueLabel { id } }
}`;

/** Parse {@link ISSUE_LABEL_CREATE_MUTATION} → the new label id; throws on failure. */
export function parseLabelCreate(json: unknown): string {
  const r = (json as { data?: { issueLabelCreate?: { success?: boolean; issueLabel?: { id?: string } } } } | null)?.data?.issueLabelCreate;
  if (!r?.success || !r.issueLabel?.id) throw new Error("lead-desk: Linear issueLabelCreate did not succeed");
  return r.issueLabel.id;
}

/**
 * The dev tickets that already have a `manual-qa` child — the idempotency set. PAGINATED (`$after`): this set
 * is the sole basis of "don't re-create", so it must never silently truncate (unlike a capped `first:`); the
 * live caller loops until `next` is null, exactly like {@link ISSUES_QUERY}.
 */
export const QA_CHILDREN_QUERY = `
query BorderlessQaChildren($teamKey: String!, $label: String!, $after: String) {
  issues(filter: { team: { key: { eq: $teamKey } }, labels: { name: { eq: $label } } }, first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { parent { identifier } }
  }
}`;

/** Parse one page of {@link QA_CHILDREN_QUERY}: the parent keys on this page + the next cursor (null at the end). */
export function parseQaChildrenPage(json: unknown): { parentKeys: string[]; next: string | null } {
  const conn = (json as { data?: { issues?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; nodes?: Array<{ parent?: { identifier?: string } | null }> } } } | null)?.data?.issues;
  const parentKeys = (conn?.nodes ?? [])
    .map((n) => n.parent?.identifier)
    .filter((k): k is string => typeof k === "string");
  const next = conn?.pageInfo?.hasNextPage ? (conn.pageInfo.endCursor ?? null) : null;
  return { parentKeys, next };
}

/** Create one Linear issue (used for lead-desk delegation, PRD §9). */
export const ISSUE_CREATE_MUTATION = `
mutation BorderlessIssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue { id identifier url }
  }
}`;

/** The Linear-API-shaped input to {@link ISSUE_CREATE_MUTATION} (passed as `{ input }` in the variables). */
export interface IssueCreateInput {
  teamId: string;
  projectId: string;
  title: string;
  description: string;
  assigneeId: string | null;
  /** Optional: Linear priority 0..4 (0 None, 1 Urgent, 2 High, 3 Medium, 4 Low) — lead-desk tickets carry it. */
  priority?: number;
  /** Optional: make this a sub-issue of the given issue UUID (manual-QA children hang under the dev ticket). */
  parentId?: string;
  /** Optional: label UUIDs to attach on create (the manual-QA child gets the `manual-qa` label). */
  labelIds?: string[];
  /** Optional: the workflow-state id to open the issue in (a qa-fix ticket opens in Todo); omitted ⇒ the team default. */
  stateId?: string;
}

export interface CreatedIssue { id: string; ticketKey: string; url: string | null; }

/** Parse {@link ISSUE_CREATE_MUTATION}; throws if the mutation didn't succeed (fails loud, never silent). The
 *  issue UUID (`id`) is returned so a created epic can be a parent for its children (lead-desk epics). */
export function parseIssueCreate(json: unknown): CreatedIssue {
  const r = (json as { data?: { issueCreate?: { success?: boolean; issue?: { id?: string; identifier?: string; url?: string | null } } } } | null)?.data?.issueCreate;
  if (!r?.success || !r.issue?.identifier || !r.issue.id) throw new Error("lead-desk: Linear issueCreate did not succeed");
  return { id: r.issue.id, ticketKey: r.issue.identifier, url: r.issue.url ?? null };
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

// --- Manual-QA verdict writeback (PRD §13): carry a tester's Cue QA verdict back to the sub-issue -----------

/**
 * A team's "Done" (completed) workflow states — resolved so a passing QA sub-issue can be moved to Done. Linear
 * can have several `completed`-type states; the caller prefers the one literally named "Done" (see
 * {@link pickDoneState}), else the first completed state. Filtering by type keeps non-completed states out.
 */
export const WORKFLOW_STATES_QUERY = `
query BorderlessWorkflowStates($teamKey: String!) {
  workflowStates(filter: { team: { key: { eq: $teamKey } }, type: { eq: "completed" } }, first: 20) {
    nodes { id name type }
  }
}`;

/** One workflow state (id + display name) from {@link WORKFLOW_STATES_QUERY}. */
export interface WorkflowState { id: string; name: string }

/** Parse {@link WORKFLOW_STATES_QUERY} → the team's completed states (may be empty if none/misconfigured). */
export function parseWorkflowStates(json: unknown): WorkflowState[] {
  const nodes = (json as { data?: { workflowStates?: { nodes?: Array<{ id?: string; name?: string }> } } } | null)?.data?.workflowStates?.nodes ?? [];
  return nodes
    .filter((n): n is { id: string; name?: string } => typeof n.id === "string")
    .map((n) => ({ id: n.id, name: typeof n.name === "string" ? n.name : "" }));
}

/** Pick the state to mark a passing sub-issue Done: the one named "Done" (case-insensitive), else the first. Pure. */
export function pickDoneState(states: readonly WorkflowState[]): WorkflowState | null {
  return states.find((s) => s.name.trim().toLowerCase() === "done") ?? states[0] ?? null;
}

/**
 * One issue's comment bodies — the idempotency source for the verdict writeback (a verdict is "already synced"
 * iff a comment already carries its ref marker). PAGINATED (`$after`) so the dedupe set never silently truncates,
 * exactly like {@link QA_CHILDREN_QUERY}; the live caller loops until `next` is null.
 */
export const ISSUE_COMMENTS_QUERY = `
query BorderlessIssueComments($id: String!, $after: String) {
  issue(id: $id) {
    comments(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { body }
    }
  }
}`;

/** Parse one page of {@link ISSUE_COMMENTS_QUERY}: the comment bodies on this page + the next cursor (null at end). */
export function parseIssueCommentsPage(json: unknown): { bodies: string[]; next: string | null } {
  const conn = (json as { data?: { issue?: { comments?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; nodes?: Array<{ body?: string | null }> } } } } | null)?.data?.issue?.comments;
  const bodies = (conn?.nodes ?? []).map((n) => n.body).filter((b): b is string => typeof b === "string");
  const next = conn?.pageInfo?.hasNextPage ? (conn.pageInfo.endCursor ?? null) : null;
  return { bodies, next };
}

// --- QA-fix sweep (PRD §13): a failed Cue QA verdict → a fix ticket under the feature ticket -----------------

/**
 * One feature ticket's children's descriptions — the idempotency source for the QA-fix sweep. A fix/blocked
 * ticket is created non-idempotently (unlike a state move), so "already created" can't rest on a separate marker
 * comment that a partial failure might strand: the marker (`fixMarker(verdictAt)`) lives in the fix ticket's own
 * description, and the dedupe scans the parent's existing children for it. PAGINATED (`$after`) so the set never
 * silently truncates; the live caller loops until `next` is null.
 */
export const ISSUE_CHILDREN_QUERY = `
query BorderlessIssueChildren($id: String!, $after: String) {
  issue(id: $id) {
    children(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { description }
    }
  }
}`;

/** Parse one page of {@link ISSUE_CHILDREN_QUERY}: the child descriptions on this page + the next cursor. */
export function parseIssueChildrenPage(json: unknown): { descriptions: string[]; next: string | null } {
  const conn = (json as { data?: { issue?: { children?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; nodes?: Array<{ description?: string | null }> } } } } | null)?.data?.issue?.children;
  const descriptions = (conn?.nodes ?? []).map((n) => n.description).filter((d): d is string => typeof d === "string");
  const next = conn?.pageInfo?.hasNextPage ? (conn.pageInfo.endCursor ?? null) : null;
  return { descriptions, next };
}

/**
 * A team's UNSTARTED + BACKLOG workflow states — so a feature ticket whose QA failed can be moved back out of
 * Verifying. The caller prefers the one named "Todo", else the first `unstarted`, else the first `backlog`
 * (see {@link pickTodoState}), so the `type` is kept here (unlike {@link WORKFLOW_STATES_QUERY}, which filters
 * to one type up front).
 */
export const TODO_STATES_QUERY = `
query BorderlessTodoStates($teamKey: String!) {
  workflowStates(filter: { team: { key: { eq: $teamKey } }, type: { in: ["unstarted", "backlog"] } }, first: 20) {
    nodes { id name type }
  }
}`;

/** One workflow state with its type, from {@link TODO_STATES_QUERY}. */
export interface TypedWorkflowState { id: string; name: string; type: string }

/** Parse {@link TODO_STATES_QUERY} → the team's unstarted/backlog states (may be empty if none/misconfigured). */
export function parseTodoStates(json: unknown): TypedWorkflowState[] {
  const nodes = (json as { data?: { workflowStates?: { nodes?: Array<{ id?: string; name?: string; type?: string }> } } } | null)?.data?.workflowStates?.nodes ?? [];
  return nodes
    .filter((n): n is { id: string; name?: string; type?: string } => typeof n.id === "string")
    .map((n) => ({ id: n.id, name: typeof n.name === "string" ? n.name : "", type: typeof n.type === "string" ? n.type : "" }));
}

/** Pick the state to move a QA-failed feature ticket to: the one named "Todo", else the first unstarted, else the first backlog. Pure. */
export function pickTodoState(states: readonly TypedWorkflowState[]): TypedWorkflowState | null {
  return states.find((s) => s.name.trim().toLowerCase() === "todo")
    ?? states.find((s) => s.type === "unstarted")
    ?? states.find((s) => s.type === "backlog")
    ?? states[0] ?? null;
}

/** The team id + the `qa-fix` / `qa-blocked` label ids (null ⇒ not created yet; the caller makes it on first use). */
export const QA_FIX_TARGETS_QUERY = `
query BorderlessQaFixTargets($teamKey: String!, $fix: String!, $blocked: String!) {
  teams(filter: { key: { eq: $teamKey } }, first: 1) { nodes { id } }
  fix: issueLabels(filter: { name: { eq: $fix } }, first: 1) { nodes { id } }
  blocked: issueLabels(filter: { name: { eq: $blocked } }, first: 1) { nodes { id } }
}`;

export interface QaFixTargets { teamId: string; fixLabelId: string | null; blockedLabelId: string | null }

/** Parse {@link QA_FIX_TARGETS_QUERY}; throws if the team is missing, leaves missing labels null (created on first use). */
export function parseQaFixTargets(json: unknown, teamKey: string): QaFixTargets {
  const data = (json as { data?: { teams?: { nodes?: Array<{ id?: string }> }; fix?: { nodes?: Array<{ id?: string }> }; blocked?: { nodes?: Array<{ id?: string }> } } } | null)?.data;
  const teamId = data?.teams?.nodes?.[0]?.id;
  if (!teamId) throw new Error(`qa-fix: no Linear team with key "${teamKey}"`);
  return { teamId, fixLabelId: data?.fix?.nodes?.[0]?.id ?? null, blockedLabelId: data?.blocked?.nodes?.[0]?.id ?? null };
}
