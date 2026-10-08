/**
 * Verify run (PRD §13, phase V2b) — execute the structural checks for the Verifying tickets and roll each up to
 * a verdict. On-demand (like the scan): classify a ticket from its merged PR, plan its checks, run the catalog
 * ones over the SELECT-only role + escalate the behavioral ones, then rollupVerdict. Live I/O (the merged-PR
 * lookup and the catalog queries) is injected, so the orchestration is testable with fakes.
 */

import type { Store } from "./store.ts";
import type { LinearIssue } from "../shared/types.ts";
import { verifyRow, issueText } from "../shared/verify.ts";
import { planChecks, tableFromText } from "../shared/verify-plan.ts";
import { catalogProbe, type CatalogProbe, type CatalogRow } from "../shared/verify-catalog.ts";
import { rollupVerdict, type CheckResult, type VerifyRunRow } from "../shared/verify-verdict.ts";

export interface VerifyRunDeps {
  /** The merged PR + its changed paths for a Verifying ticket (live gh); null when none is found. */
  mergedPrFor: (issue: LinearIssue) => Promise<{ prNumber: number; paths: string[] } | null>;
  /** Run a catalog probe's SQL over the read-only role (live Postgres). */
  catalogRun: (probe: CatalogProbe) => Promise<CatalogRow[]>;
  /** The real public-schema tables — used to target a catalog check from the ticket text when no PR path did. */
  knownTables?: readonly string[];
  /** Linear state treated as "Verifying" (default "Verifying"). */
  stateName?: string;
}

/** Run every structural check for one Verifying ticket and roll up its verdict. */
export async function verifyTicket(issue: LinearIssue, deps: VerifyRunDeps): Promise<VerifyRunRow> {
  const pr = await deps.mergedPrFor(issue);
  const paths = pr?.paths ?? [];
  const row = verifyRow(issue, paths, pr?.prNumber ?? null);
  // When the merged PR had no path, let a catalog check target a table named in the ticket text (∩ real tables).
  const fallbackTarget = deps.knownTables?.length ? tableFromText(issueText(issue), deps.knownTables) : null;

  const results: CheckResult[] = [];
  for (const check of planChecks(row.backendProperties, paths, fallbackTarget)) {
    const base = { property: check.property, target: check.target, mechanism: check.mechanism, assertion: check.assertion };
    const probe = catalogProbe(check);
    if (!probe) { // behavioral (session/http) or no target → a human / the staging env, not this run
      results.push({ ...base, status: "escalated", evidence: "behavioral check — needs a human or the staging env" });
      continue;
    }
    try {
      const outcome = probe.interpret(await deps.catalogRun(probe));
      results.push({ ...base, status: outcome.status, evidence: outcome.evidence });
    } catch (err) {
      results.push({ ...base, status: "inconclusive", evidence: `catalog query failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  return { ...row, ...rollupVerdict(results) };
}

/** Run the verify checks across every Verifying ticket (a ticket whose merged PR can't be found still classifies). */
export async function runVerify(store: Pick<Store, "listLinearIssues">, deps: VerifyRunDeps): Promise<VerifyRunRow[]> {
  const rows: VerifyRunRow[] = [];
  for (const issue of store.listLinearIssues(deps.stateName ?? "Verifying")) rows.push(await verifyTicket(issue, deps));
  return rows;
}
