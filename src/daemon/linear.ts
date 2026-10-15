/**
 * Linear live sync (lead-console PRD §4, build order #2).
 *
 * The GraphQL POST and the paginated upsert loop. The query + mapper are pure in
 * `src/shared/linear.ts`. The HTTP call is live-only (needs an API key); the orchestration is covered
 * by tests through an injected {@link LinearClient}.
 */

import type { Store } from "./store.ts";
import {
  ISSUES_QUERY, issuesVariables, parseIssuesResponse, QA_CHILDREN_QUERY, parseQaChildrenPage,
  ISSUE_COMMENTS_QUERY, parseIssueCommentsPage, WORKFLOW_STATES_QUERY, parseWorkflowStates, pickDoneState,
  ISSUE_CHILDREN_QUERY, parseIssueChildrenPage, TODO_STATES_QUERY, parseTodoStates, pickTodoState,
  QA_FIX_TARGETS_QUERY, parseQaFixTargets, ISSUE_LABEL_CREATE_MUTATION, parseLabelCreate, type QaFixTargets,
} from "../shared/linear.ts";

/** Minimal GraphQL client — the real one POSTs to Linear; tests inject a fake. */
export interface LinearClient {
  query(query: string, variables: unknown): Promise<unknown>;
}

const LINEAR_GRAPHQL = "https://api.linear.app/graphql";

/**
 * Live client: POST to Linear with a personal API key. A personal key goes in `Authorization` raw
 * (no `Bearer` prefix — that form is for OAuth access tokens).
 */
export function httpLinearClient(apiKey: string, endpoint = LINEAR_GRAPHQL): LinearClient {
  return {
    async query(query, variables) {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: apiKey },
        body: JSON.stringify({ query, variables }),
      });
      if (!res.ok) throw new Error(`linear: HTTP ${res.status} ${res.statusText}`);
      const json = (await res.json()) as { errors?: unknown };
      if (json.errors) throw new Error(`linear: ${JSON.stringify(json.errors)}`);
      return json;
    },
  };
}

/** Sync each team's issues into `linear_issues` (paginated). Returns how many rows were upserted. */
export async function syncLinearIssues(
  store: Store,
  client: LinearClient,
  teamKeys: string[],
): Promise<{ synced: number }> {
  let synced = 0;
  for (const teamKey of teamKeys) {
    let after: string | null = null;
    do {
      const page = parseIssuesResponse(await client.query(ISSUES_QUERY, issuesVariables(teamKey, after)));
      for (const issue of page.issues) {
        store.upsertLinearIssue(issue);
        synced++;
      }
      after = page.hasNextPage ? page.endCursor : null;
    } while (after);
  }
  return { synced };
}

/**
 * The dev tickets that already have a `manual-qa` child — the verify-qa idempotency set. Fully paginated: this
 * is the sole basis of "don't re-create", so it must never truncate. Loops the cursor like syncLinearIssues.
 */
export async function fetchQaChildParentKeys(client: LinearClient, teamKey: string, label: string): Promise<string[]> {
  const keys: string[] = [];
  let after: string | null = null;
  do {
    const page = parseQaChildrenPage(await client.query(QA_CHILDREN_QUERY, { teamKey, label, after }));
    keys.push(...page.parentKeys);
    after = page.next;
  } while (after);
  return keys;
}

/**
 * All of one issue's comment bodies — the verdict-writeback idempotency source. Fully paginated: a verdict is
 * "already synced" iff a comment already carries its ref marker, so a missed page would double-post; loops the
 * cursor like {@link fetchQaChildParentKeys}.
 */
export async function fetchIssueCommentBodies(client: LinearClient, issueId: string): Promise<string[]> {
  const bodies: string[] = [];
  let after: string | null = null;
  do {
    const page = parseIssueCommentsPage(await client.query(ISSUE_COMMENTS_QUERY, { id: issueId, after }));
    bodies.push(...page.bodies);
    after = page.next;
  } while (after);
  return bodies;
}

/** Resolve the team's "Done" workflow-state id (the target for a passing QA sub-issue), or null if none exists. */
export async function resolveDoneStateId(client: LinearClient, teamKey: string): Promise<string | null> {
  const states = parseWorkflowStates(await client.query(WORKFLOW_STATES_QUERY, { teamKey }));
  return pickDoneState(states)?.id ?? null;
}

/**
 * All of one feature ticket's children's descriptions — the QA-fix idempotency source. Fully paginated (a missed
 * page could re-create a fix ticket already made): loops the cursor like {@link fetchIssueCommentBodies}.
 */
export async function fetchIssueChildDescriptions(client: LinearClient, parentUuid: string): Promise<string[]> {
  const descriptions: string[] = [];
  let after: string | null = null;
  do {
    const page = parseIssueChildrenPage(await client.query(ISSUE_CHILDREN_QUERY, { id: parentUuid, after }));
    descriptions.push(...page.descriptions);
    after = page.next;
  } while (after);
  return descriptions;
}

/** Resolve the team's "Todo" workflow-state id (where a QA-failed feature ticket moves), or null if none exists. */
export async function resolveTodoStateId(client: LinearClient, teamKey: string): Promise<string | null> {
  const states = parseTodoStates(await client.query(TODO_STATES_QUERY, { teamKey }));
  return pickTodoState(states)?.id ?? null;
}

/** QA-fix label colors (Linear hex): red for `qa-fix`, amber for `qa-blocked`. */
const QA_FIX_LABEL_COLOR = "#e5484d";
const QA_BLOCKED_LABEL_COLOR = "#f5a623";

/** Difficulty label colors (Linear hex): green / amber / red for easy / medium / hard. */
const DIFFICULTY_LABEL_COLORS = { easy: "#4cb782", medium: "#f5a623", hard: "#e5484d" } as const;

/**
 * Resolve the team id + the `qa-fix` / `qa-blocked` + the three `difficulty:` label ids, creating any that don't
 * exist yet. Returns the ids ready to attach on create — unlike the read-only {@link resolveDoneStateId}, this
 * may write (the labels).
 */
export async function resolveQaFixTargets(
  client: LinearClient,
  teamKey: string,
  fixLabel: string,
  blockedLabel: string,
  difficultyLabels: { easy: string; medium: string; hard: string },
): Promise<{ teamId: string; fixLabelId: string; blockedLabelId: string; difficultyLabelIds: { easy: string; medium: string; hard: string } }> {
  const t: QaFixTargets = parseQaFixTargets(await client.query(QA_FIX_TARGETS_QUERY, { teamKey, fix: fixLabel, blocked: blockedLabel, ...difficultyLabels }), teamKey);
  const ensure = async (existing: string | null, name: string, color: string): Promise<string> =>
    existing ?? parseLabelCreate(await client.query(ISSUE_LABEL_CREATE_MUTATION, { input: { name, teamId: t.teamId, color } }));
  return {
    teamId: t.teamId,
    fixLabelId: await ensure(t.fixLabelId, fixLabel, QA_FIX_LABEL_COLOR),
    blockedLabelId: await ensure(t.blockedLabelId, blockedLabel, QA_BLOCKED_LABEL_COLOR),
    difficultyLabelIds: {
      easy: await ensure(t.difficultyLabelIds.easy, difficultyLabels.easy, DIFFICULTY_LABEL_COLORS.easy),
      medium: await ensure(t.difficultyLabelIds.medium, difficultyLabels.medium, DIFFICULTY_LABEL_COLORS.medium),
      hard: await ensure(t.difficultyLabelIds.hard, difficultyLabels.hard, DIFFICULTY_LABEL_COLORS.hard),
    },
  };
}
