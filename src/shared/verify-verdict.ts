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

/**
 * One grounded finding from the verification agent (V4, COR-87): did a specific acceptance criterion hold, with
 * evidence. The agent adds depth on top of the deterministic bars; it reports pass/fail/inconclusive (never
 * "escalated" — it either verified, found a problem, or couldn't determine), and it can never override a bar.
 */
export interface AgentFinding {
  criterion: string;
  status: "pass" | "fail" | "inconclusive";
  evidence: string;
}

/** A ticket's overall verdict. "ui" ⇒ no invisible properties (human QA covers it); the sweep did nothing. */
export type Verdict = "verified" | "needs_human" | "ui";

export interface TicketVerdict {
  verdict: Verdict;
  results: CheckResult[];
  /** The agent's grounded findings (V4); empty on a deterministic-only run. */
  agentFindings: AgentFinding[];
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
 * Roll the deterministic bars AND the agent's grounded findings into one ticket verdict. Pure.
 *  - nothing checked    ⇒ "ui"          (no invisible properties; human QA owns it)
 *  - EVERY check passes  ⇒ "verified"    (every deterministic bar AND every agent finding passed)
 *  - anything else      ⇒ "needs_human" (a failing/inconclusive/escalated bar, or a failing/inconclusive agent
 *                                        finding) — bars and agent are a shared floor: neither overrides the
 *                                        other, so a verified ticket cleared both.
 */
export function rollupVerdict(results: CheckResult[], agentFindings: AgentFinding[] = []): TicketVerdict {
  const summary: Record<CheckStatus, number> = { pass: 0, fail: 0, inconclusive: 0, escalated: 0 };
  for (const r of results) summary[r.status]++;
  const checked = results.length + agentFindings.length;
  const allPass = results.every((r) => r.status === "pass") && agentFindings.every((f) => f.status === "pass");
  const verdict: Verdict = checked === 0 ? "ui" : allPass ? "verified" : "needs_human";
  return { verdict, results, agentFindings, summary };
}
