/**
 * Linear live sync (lead-console PRD §4, build order #2).
 *
 * The GraphQL POST and the paginated upsert loop. The query + mapper are pure in
 * `src/shared/linear.ts`. The HTTP call is live-only (needs an API key); the orchestration is covered
 * by tests through an injected {@link LinearClient}.
 */

import type { Store } from "./store.ts";
import { ISSUES_QUERY, issuesVariables, parseIssuesResponse } from "../shared/linear.ts";

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
