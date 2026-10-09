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
import { catalogProbe, type CatalogProbe, type CatalogRow, type CheckOutcome } from "../shared/verify-catalog.ts";
import { rollupVerdict, type AgentFinding, type CheckResult, type VerifyRunRow } from "../shared/verify-verdict.ts";

export interface VerifyRunDeps {
  /** The merged PR + its changed paths for a Verifying ticket (live gh); null when none is found. */
  mergedPrFor: (issue: LinearIssue) => Promise<{ prNumber: number; paths: string[] } | null>;
  /** Run a catalog probe's SQL over the read-only role (live Postgres). */
  catalogRun: (probe: CatalogProbe) => Promise<CatalogRow[]>;
  /** The real public-schema tables — used to target a catalog check from the ticket text when no PR path did. */
  knownTables?: readonly string[];
  /** Behavioral RLS probe (app session). When set, each RLS table also gets a "does RLS actually gate reads?"
   *  check on top of the structural "a policy exists" one. Absent → only the structural check runs. */
  rlsProbe?: (table: string) => Promise<CheckOutcome>;
  /** Run the verification agent for a ticket → its grounded findings (PRD §13 V4). Absent → deterministic-only.
   *  Invoked only for tickets with ≥1 backend property (a pure-UI ticket has nothing invisible to verify). */
  runAgent?: (issue: LinearIssue) => Promise<AgentFinding[]>;
  /** Linear state treated as "Verifying" (default "Verifying"). */
  stateName?: string;
}

/** Run one probe into a CheckResult; a thrown probe degrades to inconclusive (resilient), never crashes the run. */
async function runCheck(base: Omit<CheckResult, "status" | "evidence">, run: () => Promise<CheckOutcome>, failNote: string): Promise<CheckResult> {
  try {
    const o = await run();
    return { ...base, status: o.status, evidence: o.evidence };
  } catch (err) {
    return { ...base, status: "inconclusive", evidence: `${failNote}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Run the structural + behavioral RLS bars for one ticket's backend properties → the deterministic CheckResults. */
async function runBars(backendProperties: VerifyRunRow["backendProperties"], paths: string[], fallbackTarget: string | null, deps: VerifyRunDeps): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of planChecks(backendProperties, paths, fallbackTarget)) {
    const base = { property: check.property, target: check.target, mechanism: check.mechanism, assertion: check.assertion };
    const probe = catalogProbe(check);
    if (!probe) { // behavioral (session/http) or no target → a human / the staging env, not this run
      results.push({ ...base, status: "escalated", evidence: "behavioral check — needs a human or the staging env" });
      continue;
    }
    results.push(await runCheck(base, async () => probe.interpret(await deps.catalogRun(probe)), "catalog query failed"));
  }

  // Behavioral RLS augmentation — deliberately a post-loop pass, NOT a planned check: it needs a live app
  // session the pure planner can't know about, and routing it through planChecks would force every RLS ticket
  // to needs_human whenever no app session is configured (penalising structural-only verification). Absent
  // rlsProbe ⇒ simply skipped. For each RLS table the structural checks targeted, confirm RLS actually GATES
  // reads (the catalog check only proves a policy exists). Read-only, residue-free.
  const rlsProbe = deps.rlsProbe;
  if (rlsProbe) {
    const rlsTables = [...new Set(results.filter((r) => r.property === "rls" && r.target).map((r) => r.target!))];
    for (const table of rlsTables) {
      const base = { property: "rls" as const, target: table, mechanism: "session" as const,
        assertion: `Unauthenticated reads of ${table} are denied; an authenticated user is permitted only what RLS allows.` };
      results.push(await runCheck(base, () => rlsProbe(table), "behavioral RLS check failed"));
    }
  }
  return results;
}

/** Verify one Verifying ticket: run the deterministic bars AND the verification agent, then roll both up. */
export async function verifyTicket(issue: LinearIssue, deps: VerifyRunDeps): Promise<VerifyRunRow> {
  const pr = await deps.mergedPrFor(issue);
  const paths = pr?.paths ?? [];
  const row = verifyRow(issue, paths, pr?.prNumber ?? null);
  // When the merged PR had no path, let a catalog check target a table named in the ticket text (∩ real tables).
  const fallbackTarget = deps.knownTables?.length ? tableFromText(issueText(issue), deps.knownTables) : null;

  // The bars (catalog DB) and the agent (a spawned worktree) probe independent resources, so run them
  // concurrently. The agent runs only when there's an invisible property to verify: a pure-UI ticket stays
  // "ui" (human QA owns it), and we don't spend a verification agent on nothing. The agent never overrides a
  // bar — rollupVerdict treats both as a shared floor (every bar AND every finding must pass for "verified").
  const agentRun: Promise<AgentFinding[]> =
    deps.runAgent && row.backendProperties.length ? deps.runAgent(issue) : Promise.resolve([]);
  const [results, agentFindings] = await Promise.all([runBars(row.backendProperties, paths, fallbackTarget, deps), agentRun]);
  return { ...row, ...rollupVerdict(results, agentFindings) };
}

/** A ticket whose verify run threw (e.g. its agent hit the spawn deadline) → a visible needs_human row that
 *  carries the error as evidence. Keeps the concurrent fan-out fail-soft: one ticket's failure never sinks the
 *  rest of the run, matching runCheck/parseAgentVerdict and the per-job-isolating sweep supervisor. */
function failedVerifyRow(issue: LinearIssue, err: unknown): VerifyRunRow {
  const evidence = `the verify run failed for this ticket: ${err instanceof Error ? err.message : String(err)}`;
  return { ...verifyRow(issue, [], null), ...rollupVerdict([], [{ criterion: "verify run", status: "inconclusive", evidence }]) };
}

/** Verify every Verifying ticket, concurrently — each verdict is independent and its agent runs in parallel
 *  (like the code-driving sweeps; the Verifying column is small, so no concurrency cap — mirrors PRD §12). A
 *  ticket that throws degrades to a needs_human row (via failedVerifyRow), so it never fails the whole run. */
export async function runVerify(store: Pick<Store, "listLinearIssues">, deps: VerifyRunDeps): Promise<VerifyRunRow[]> {
  return Promise.all(
    store.listLinearIssues(deps.stateName ?? "Verifying").map((issue) =>
      verifyTicket(issue, deps).catch((err) => failedVerifyRow(issue, err))),
  );
}
