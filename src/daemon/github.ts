/**
 * GitHub access via the `gh` CLI (design §12.3, §12.5). The command/query BUILDERS are pure and
 * unit-tested; the runners shell out to `gh` and are exercised only against a real repo.
 *
 * A lookup FAILURE is never "empty" (a wrong PR number must never read as review-clean, §12.3): the
 * runners throw on a non-zero `gh` exit, and callers keep the last-known state rather than treating an
 * error as a clean PR.
 */

import { runWithDeadline } from "./ssh.ts";

/** The per-PR field set fetched via GraphQL (design §12.3). */
export const PR_DETAIL_QUERY = `
query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      number title url state isDraft mergedAt closedAt updatedAt headRefName body reviewDecision mergeable
      reviewRequests(first:10){ totalCount nodes{ requestedReviewer{ __typename ... on User{login} ... on Bot{login} } } }
      reviews(last:30){ nodes{ author{login} state submittedAt commit{ oid } } }
      comments(last:30){ totalCount nodes{ author{login} body createdAt } }
      reviewThreads(first:50){ totalCount nodes{ isResolved } }
      commits(last:1){ nodes{ commit{ oid committedDate } } }
      statusCheckRollup: commits(last:1){ nodes{ commit{ statusCheckRollup{ state
        contexts(first:100){ nodes{ __typename
          ... on CheckRun{ name status conclusion }
          ... on StatusContext{ context state } } } } } } }
    }
  }
}`.trim();

/** Split an `owner/repo` slug. */
export function splitRepo(repo: string): { owner: string; name: string } {
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new Error(`github: invalid repo slug '${repo}'`);
  return { owner, name };
}

/** `gh pr list` args to find the newest PRs for a head branch (design §12.2: newest 3 per head). */
export function prListArgs(repo: string, branch: string, limit = 3): string[] {
  return [
    "pr", "list", "--repo", repo, "--head", branch, "--state", "all",
    "--limit", String(limit), "--json", "number,state,isDraft,updatedAt,headRefName",
  ];
}

/** `gh api graphql` args to fetch one PR's detail (design §12.3). */
export function prDetailArgs(repo: string, number: number): string[] {
  const { owner, name } = splitRepo(repo);
  return [
    "api", "graphql",
    "-f", `query=${PR_DETAIL_QUERY}`,
    "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${number}`,
  ];
}

/** `gh` args to request a reviewer (design §12.5 cto-review). */
export function requestReviewerArgs(repo: string, number: number, reviewer: string): string[] {
  return ["pr", "edit", String(number), "--repo", repo, "--add-reviewer", reviewer];
}

/** `gh` args to post a PR comment (codex-review trigger / bump-cto @-mention, design §12.5). */
export function commentArgs(repo: string, number: number, body: string): string[] {
  return ["pr", "comment", String(number), "--repo", repo, "--body", body];
}

/** `gh` args to merge a PR (squash by default, design §12.5). */
export function mergeArgs(repo: string, number: number, method: "squash" | "merge" | "rebase" = "squash"): string[] {
  return ["pr", "merge", String(number), "--repo", repo, `--${method}`];
}

// --- runners (live-only) ----------------------------------------------------

export interface BranchPr { number: number; state: string; isDraft: boolean; updatedAt: string; headRefName: string; }

async function ghJson<T>(args: string[]): Promise<T> {
  const r = await runWithDeadline(["gh", ...args]);
  if (r.code !== 0) throw new Error(`gh ${args[0]} ${args[1]} failed (code ${r.code}): ${r.stderr}`);
  return JSON.parse(r.stdout) as T;
}

/** Find the newest PRs for a head branch. Throws on failure (never reads as "no PRs", §12.3). */
export function listPrsForBranch(repo: string, branch: string): Promise<BranchPr[]> {
  return ghJson<BranchPr[]>(prListArgs(repo, branch));
}

/** Fetch one PR's full detail for derivation. Throws on failure. */
export async function fetchPr(repo: string, number: number): Promise<Record<string, any>> {
  const data = await ghJson<{ data: { repository: { pullRequest: Record<string, any> } } }>(prDetailArgs(repo, number));
  const pr = data.data?.repository?.pullRequest;
  if (!pr) throw new Error(`github: PR ${repo}#${number} not found`);
  // Fold the aliased statusCheckRollup sub-query back onto the PR object for deriveStates.
  const rollup = pr.statusCheckRollup?.nodes?.[0]?.commit?.statusCheckRollup;
  return { ...pr, statusCheckRollup: rollup ?? null };
}
