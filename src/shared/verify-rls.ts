/**
 * Behavioral RLS interpreter (PRD §13, phase V2b) — the pure "given what an anonymous reader and a signed-in
 * user can actually read from a table, is RLS gating access?" brain. The companion to the structural catalog
 * check (verify-catalog.ts): the catalog check confirms an RLS policy EXISTS; this confirms it actually BLOCKS
 * unauthenticated reads — catching "RLS theater" (enabled + a permissive policy) the catalog check can't.
 *
 * No I/O: the live session (daemon/verify-session.ts) signs in as a test user and reads the row counts; this
 * turns the two counts into a verdict. Single-account + read-only, so it's a necessary-not-sufficient signal:
 * it proves anon is (or isn't) denied, not full "user A can't read user B's specific row" (that needs a second
 * user → the disposable V3 env).
 */

import type { CheckOutcome } from "./verify-catalog.ts";

/** What a reader could get from a table: whether the request was denied (401/403), and the exact row count. */
export interface TableAccess {
  denied: boolean;
  count: number;
}

/**
 * Turn an anonymous read and a signed-in read of one table into a behavioral RLS outcome. Pure.
 *  - anon denied, or anon reads 0 rows      ⇒ pass (RLS gates unauthenticated access)
 *  - anon reads ≥1 row                      ⇒ inconclusive — an intended public table, or an RLS gap? a human
 *                                             decides (we can't tell a public table from a leak from counts)
 */
export function rlsBehavioralOutcome(anon: TableAccess, authed: TableAccess, table: string): CheckOutcome {
  if (anon.denied) {
    return { status: "pass", evidence: `unauthenticated reads of ${table} are denied (RLS blocks anon); the signed-in user reads ${authed.count}` };
  }
  if (anon.count === 0) {
    return { status: "pass", evidence: `anon reads 0 rows of ${table}; RLS gates access (the signed-in user reads ${authed.count})` };
  }
  return { status: "inconclusive", evidence: `anon can read ${anon.count} row(s) of ${table} without signing in — an intended public table, or an RLS gap? needs a human` };
}
