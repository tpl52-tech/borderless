/**
 * Verify scan (PRD §13, phase V1) — find the Verifying-state tickets and classify each one from its merged
 * PR's changed paths. On-demand (like the rescue scan), not a poll: discovering each ticket's merged PR is a
 * live `gh` call, injected here so the composition stays testable with a fake. No credentials, no backend
 * access — V1 only reads the board + the diff and classifies.
 */

import type { Store } from "./store.ts";
import type { LinearIssue } from "../shared/types.ts";
import { verifyRow, type VerifyRow } from "../shared/verify.ts";
import { listPrsForBranch, prFiles } from "./github.ts";
import { prBranchCandidates } from "./worktree.ts";

export interface VerifyScanDeps {
  /** The merged PR + its changed paths for a Verifying ticket (live gh); null when none is found. */
  mergedPrFor: (issue: LinearIssue) => Promise<{ prNumber: number; paths: string[] } | null>;
  /** Linear state name treated as "Verifying" (default "Verifying"). */
  stateName?: string;
}

/** Classify every Verifying ticket. A ticket whose merged PR can't be found still classifies from its text. */
export async function verifyScan(store: Pick<Store, "listLinearIssues">, deps: VerifyScanDeps): Promise<VerifyRow[]> {
  const rows: VerifyRow[] = [];
  for (const issue of store.listLinearIssues(deps.stateName ?? "Verifying")) {
    const pr = await deps.mergedPrFor(issue);
    rows.push(verifyRow(issue, pr?.paths ?? [], pr?.prNumber ?? null));
  }
  return rows;
}

/**
 * Live `mergedPrFor` (gh) — the named factory the daemon injects, mirroring rescue-scan's `liveProgressCheck`.
 * Discovers the ticket's MERGED PR via its branch candidates and reads its changed files. Returns null when no
 * merged PR exists, and is resilient per-ticket: a gh hiccup on one ticket degrades it to text-only (null),
 * never aborting the whole read-only scan.
 */
export function liveMergedPrFor(repo: string, branchOwner: string): VerifyScanDeps["mergedPrFor"] {
  return async (issue) => {
    for (const branch of prBranchCandidates(issue.identifier, branchOwner, issue.gitBranchName)) {
      let merged;
      try { merged = (await listPrsForBranch(repo, branch)).find((p) => p.state === "MERGED"); }
      catch { continue; }
      if (merged) {
        try { return { prNumber: merged.number, paths: await prFiles(repo, merged.number) }; }
        catch { return { prNumber: merged.number, paths: [] }; } // have the PR, files unavailable
      }
    }
    return null;
  };
}
