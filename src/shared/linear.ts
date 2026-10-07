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
      id identifier title url priority updatedAt dueDate branchName
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
