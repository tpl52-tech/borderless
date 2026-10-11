/**
 * Verify auto-advance (PRD §13) — when `config.verifyAutoAdvance` is on, a verify run moves each PURE-BACKEND
 * ticket it marked `verified` to Done (mixed/ui tickets wait for the Cue QA tester sign-off that `qa-sync`
 * carries back). Thin orchestration over injected I/O (the store lookup + the move), so it's testable with
 * fakes; index.ts wires the live Linear move (resolve Done state → issueUpdate → audit comment).
 */

import { advanceableTickets, type VerifyRunRow } from "../shared/verify-verdict.ts";
import type { LinearIssue } from "../shared/types.ts";

export interface AdvanceDeps {
  /** The synced dev ticket by key (for its UUID); null ⇒ not in the store, skip it. */
  issueByKey: (key: string) => LinearIssue | null;
  /** Move the ticket (by UUID) to Done + post the audit comment. Throws on failure. */
  moveToDone: (issueId: string, ticketKey: string) => Promise<void>;
  /** Reflect a successful move in the local store (so it leaves "Verifying" and a later run neither re-verifies
   *  nor re-comments it — the move's idempotency in-process, with no extra Linear read). */
  onAdvanced: (issue: LinearIssue) => void;
}

/**
 * Auto-advance the pure-backend `verified` tickets to Done → the keys actually moved. Best-effort PER ticket:
 * a missing store row or a failed move is skipped (logged), never failing the whole run or blocking the others.
 */
export async function runAutoAdvance(rows: readonly VerifyRunRow[], deps: AdvanceDeps): Promise<string[]> {
  const advanced: string[] = [];
  for (const row of advanceableTickets(rows)) {
    const issue = deps.issueByKey(row.ticketKey);
    // Skip a missing ticket, or one already advanced (stateType completed — the signal onAdvanced wrote). This
    // guards BOTH run paths at the one choke point: the full run already drops it from the Verifying filter, and
    // a repeated single-ticket run (`ao verify run <key>`, which selects by identifier, ignoring state) is caught here.
    if (!issue || issue.stateType === "completed") continue;
    try {
      await deps.moveToDone(issue.id, row.ticketKey);
      deps.onAdvanced(issue); // reflect locally so a re-run doesn't re-advance / re-comment it
      advanced.push(row.ticketKey);
    } catch (err) {
      console.error(`verify auto-advance: ${row.ticketKey} → Done failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  return advanced;
}
