/**
 * Verify-sweep verdict rollup (PRD §13, phase V2b) — the pure "given each check's outcome, is this ticket
 * verified or does it need a human?" brain. The live runner executes the checks (catalog probes + escalations)
 * and hands the per-check results here. No I/O.
 */

import type { VerifyCheck } from "./verify-plan.ts";
import type { VerifyRow } from "./verify.ts";

/** A check's outcome: pass/fail/inconclusive from a catalog probe, or escalated (no catalog proxy — behavioral). */
export type CheckStatus = "pass" | "fail" | "inconclusive" | "escalated";

/** One executed check — the plan's fields plus how it came out, with human-readable evidence. */
export interface CheckResult {
  property: VerifyCheck["property"];
  target: string | null;
  mechanism: VerifyCheck["mechanism"];
  status: CheckStatus;
  assertion: string;
  evidence: string;
}

/** A ticket's overall verdict. "ui" ⇒ no invisible properties (human QA covers it); the sweep did nothing. */
export type Verdict = "verified" | "needs_human" | "ui";

export interface TicketVerdict {
  verdict: Verdict;
  results: CheckResult[];
  summary: Record<CheckStatus, number>;
}

/** A classified Verifying ticket plus its executed verdict — the wire shape `ao verify run` / the console render. */
export interface VerifyRunRow extends VerifyRow, TicketVerdict {}

/** The verify-run result as the daemon surfaces it (mirrors VerifyScanResult): the rows + whether it's configured. */
export interface VerifyRunResult {
  rows: VerifyRunRow[];
  configured: boolean;
}

/**
 * Roll per-check results into a ticket verdict. Pure.
 *  - no checks        ⇒ "ui"          (nothing invisible to verify; human QA owns it)
 *  - every check pass ⇒ "verified"
 *  - anything else    ⇒ "needs_human" (a fail, an inconclusive, or an escalated behavioral check)
 */
export function rollupVerdict(results: CheckResult[]): TicketVerdict {
  const summary: Record<CheckStatus, number> = { pass: 0, fail: 0, inconclusive: 0, escalated: 0 };
  for (const r of results) summary[r.status]++;
  const verdict: Verdict =
    results.length === 0 ? "ui" : summary.pass === results.length ? "verified" : "needs_human";
  return { verdict, results, summary };
}
