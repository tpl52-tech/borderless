/**
 * Verify-sweep check planner (PRD §13, phase V2) — the pure "given a ticket's invisible properties, what does
 * the machine actually check, how, and how risky is it?" brain. The companion to the V1 classifier
 * (shared/verify.ts): V1 decides WHICH invisible properties a Verifying ticket carries; this decides the
 * concrete CHECK for each one, so the live runner (V2b/c) is thin execution over injected I/O.
 *
 * No I/O, no creds: it maps each BackendProperty → a VerifyCheck (mechanism + safety tier + resource targets +
 * a human-readable assertion), best-effort deriving the targets (table / endpoint / bucket) from the merged
 * PR's changed paths the same per-path way the classifier reads them.
 *
 * The access level the operator provisions (per the V2 decision): the app's PUBLIC anon key + throwaway user
 * sessions, PLUS a read-only (SELECT-only) Postgres role — never service_role. So the three mechanisms are:
 *   - "session"  — act as a disposable test user on the anon key (sign up / sign in, read back own + others')
 *   - "db-read"  — inspect the catalog over the read-only Postgres role (schema / attached triggers)
 *   - "http"     — call a Worker endpoint and assert its contract (status / body)
 * And the three safety tiers (biased conservative — a false escalation costs a human glance; a missed write
 * guard corrupts prod):
 *   - "read-only"       — pure reads; always safe to run unattended
 *   - "throwaway-write" — writes, but only as a disposable user whose rows the runner cleans up
 *   - "escalate"        — ambiguous or consequential (money / external side-effects): hand to a human, never act
 */

import type { BackendProperty } from "./verify.ts";

/** How the live runner executes a check — one per capability the V2 access level grants. */
export type CheckMechanism = "session" | "db-read" | "http";

/** How safe a check is to run unattended against prod (conservative: ambiguous ⇒ escalate). */
export type SafetyTier = "read-only" | "throwaway-write" | "escalate";

/** One concrete check for one invisible property — what the live runner executes and asserts. */
export interface VerifyCheck {
  property: BackendProperty;
  mechanism: CheckMechanism;
  safetyTier: SafetyTier;
  /** Best-effort resource hints from the merged-PR paths (table / endpoint / bucket); empty ⇒ runner infers. */
  targets: string[];
  /** Human-readable statement of what must hold (shown in the console + handed to the runner/human). */
  assertion: string;
}

// Property → how it is checked. Stable: the assertion names <target> so the planner can splice the hint in.
// Conservative by design — see the tier doc above; server-logic defaults to escalate (Workers routinely touch
// money / auth / external services, which a planner can't prove is throwaway-safe from paths alone).
const CHECK_SPECS: Record<BackendProperty, { mechanism: CheckMechanism; safetyTier: SafetyTier; assertion: string }> = {
  rls: {
    mechanism: "session", safetyTier: "throwaway-write",
    assertion: "A disposable user cannot read another user's rows in <target> (deny-all / owner-scoped RLS holds).",
  },
  schema: {
    mechanism: "db-read", safetyTier: "read-only",
    assertion: "The migration's table, columns and constraints exist in <target> as defined.",
  },
  trigger: {
    mechanism: "db-read", safetyTier: "read-only",
    assertion: "The expected trigger is attached to <target> in the catalog (observing it fire is a later pass).",
  },
  "data-integrity": {
    mechanism: "session", safetyTier: "throwaway-write",
    assertion: "Repeating the action as a disposable user leaves one row in <target>, not duplicates (idempotent / upsert).",
  },
  "server-logic": {
    mechanism: "http", safetyTier: "escalate",
    assertion: "The Worker <target> enforces its server-side contract (JWT / signature / pricing) — verify by hand (may touch money / external services).",
  },
  storage: {
    mechanism: "session", safetyTier: "throwaway-write",
    assertion: "A disposable user's upload lands in <target> and the bucket's access rules hold.",
  },
};

// Per-path target extractors — same per-path discipline as the classifier (each path tested on its own).
const SQL_PATH = /(?:^|\/)(?:supabase\/)?(?:migrations?|policies?)\/(.+?)\.sql$/; // → the migration/policy file stem
const FN_PATH = /(?:^|\/)functions?\/(?:api\/)?(.+?)(?:\.[cm]?[jt]s)?$/; // → a Worker route name
const MIGRATION_PREFIX = /^\d+[-_]/; // strip a leading "0007_" / "20240102-" ordering prefix off a stem

/** Best-effort resource hints for a mechanism from the changed paths. Pure; deduped, order-preserving. */
function targetsFor(mechanism: CheckMechanism, paths: readonly string[]): string[] {
  const isHttp = mechanism === "http"; // http → a Worker route; session/db-read → a db object (the only split)
  const re = isHttp ? FN_PATH : SQL_PATH;
  const out: string[] = [];
  for (const p of paths) {
    const m = re.exec(p);
    if (!m) continue;
    const name = (isHttp ? m[1]! : m[1]!.replace(MIGRATION_PREFIX, "")).trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Splice the resource hints into an assertion's `<target>` slot(s) (falls back to a generic phrase when none). */
function fillAssertion(template: string, targets: string[]): string {
  return template.replaceAll("<target>", targets.length ? targets.join(", ") : "the affected resource");
}

/**
 * Plan the auto-verification checks for the invisible properties the classifier found. One check per property,
 * in the classifier's stable property order; `targets` are derived from the merged PR's changed paths. Pure —
 * the live runner (V2b/c) executes each check over the provisioned session / db-read / http capabilities.
 * Takes `backendProperties` (not the whole VerifyRow): the row carries no other field this needs, and taking
 * the properties + paths as peer inputs keeps the derivation symmetric (both came from classifying the ticket).
 */
export function planChecks(backendProperties: readonly BackendProperty[], changedPaths: readonly string[] = []): VerifyCheck[] {
  return backendProperties.map((property) => {
    const spec = CHECK_SPECS[property];
    const targets = targetsFor(spec.mechanism, changedPaths);
    return { property, mechanism: spec.mechanism, safetyTier: spec.safetyTier, targets, assertion: fillAssertion(spec.assertion, targets) };
  });
}
