/**
 * Verify scan (PRD §13, phase V1) — find the Verifying-state tickets and classify each one from its merged
 * PR's changed paths. On-demand (like the rescue scan), not a poll: discovering each ticket's merged PR is a
 * live `gh` call, injected here so the composition stays testable with a fake. No credentials, no backend
 * access — V1 only reads the board + the diff and classifies.
 */

import type { Store } from "./store.ts";
import type { LinearIssue } from "../shared/types.ts";
import { verifyRow, type VerifyRow } from "../shared/verify.ts";

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
