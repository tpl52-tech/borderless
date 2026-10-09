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
 * Turn an anonymous read and a signed-in read of one table into a behavioral RLS outcome. Pure — it uses BOTH
 * reads: anon tells us whether unauthenticated access is blocked; the signed-in read tells us whether an
 * authenticated user is actually permitted (distinguishing "RLS gates by auth" from "locked to everyone").
 *  - anon reads ≥1 row + a public-read policy      ⇒ pass (the schema DECLARES the table public — anon reading it
 *                                                   is the policy working, not a leak; `hasPublicReadPolicy`)
 *  - anon reads ≥1 row + no public-read policy      ⇒ inconclusive (nothing explains the anon read — an RLS gap? a
 *                                                   human decides; counts alone can't prove intent)
 *  - anon blocked (denied/0) + signed-in permitted  ⇒ pass (RLS gates by auth: anon can't read, the owner can)
 *  - anon blocked + signed-in ALSO denied           ⇒ inconclusive (over-locked, or the test user lacks access?)
 *
 * `hasPublicReadPolicy` is the authoritative intent signal: a permissive `SELECT USING (true)` policy on the
 * table (from the catalog). It's the fix for crying wolf on tables the migration deliberately made public — we
 * resolve intent from the policy, never by blanket-trusting an anon read.
 */
export function rlsBehavioralOutcome(anon: TableAccess, authed: TableAccess, table: string, hasPublicReadPolicy = false): CheckOutcome {
  if (!anon.denied && anon.count > 0) {
    return hasPublicReadPolicy
      ? { status: "pass", evidence: `anon can read ${anon.count} row(s) of ${table} — expected: a permissive public SELECT policy (USING true) declares it publicly readable` }
      : { status: "inconclusive", evidence: `anon can read ${anon.count} row(s) of ${table} without signing in, and no public-read policy explains it — an RLS gap? needs a human` };
  }
  if (authed.denied) {
    return { status: "inconclusive", evidence: `anon is blocked on ${table}, but so is the signed-in user — over-locked, or does the test user legitimately lack access? needs a human` };
  }
  return { status: "pass", evidence: `RLS gates ${table} by auth: unauthenticated reads are ${anon.denied ? "denied" : "empty"}, the signed-in user is permitted (reads ${authed.count})` };
}
