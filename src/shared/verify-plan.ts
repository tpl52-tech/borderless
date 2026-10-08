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
 *   - "read-only" — pure reads; always safe to run unattended
 *   - "escalate"  — behavioral, ambiguous, or consequential (money / external side-effects): hand to a human
 * Prod (the only target until staging lands) emits only these two: every check is a residue-free catalog read,
 * and anything behavioral escalates. V3's disposable env will reintroduce a "throwaway-write" tier (writes as a
 * cleaned-up disposable user) in the PR that first consumes it. See CHECK_SPECS.
 */

import type { BackendProperty } from "./verify.ts";

/** How the live runner executes a check — one per capability the V2 access level grants. */
export type CheckMechanism = "session" | "db-read" | "http";

/** How safe a check is to run unattended against prod (conservative: ambiguous ⇒ escalate). V3's disposable
 *  env will add a "throwaway-write" tier; prod emits only these two. */
export type SafetyTier = "read-only" | "escalate";

/** One concrete check for one invisible property against one resource — what the live runner executes/asserts. */
export interface VerifyCheck {
  property: BackendProperty;
  mechanism: CheckMechanism;
  safetyTier: SafetyTier;
  /** The single resource this check verifies (table / endpoint / bucket) from the merged-PR paths, or null when
   *  none was derivable. One target per check, so the assertion names exactly what the runner probes. */
  target: string | null;
  /** Human-readable statement of what must hold (shown in the console + handed to the runner/human). */
  assertion: string;
}

// Property → how it is checked. Stable: the assertion names <target> so the planner can splice the hint in.
//
// Current stance = prod verification (verifyTarget "prod", no staging yet): READ-ONLY + STRUCTURAL. Each
// db-read check confirms the invisible guarantee EXISTS in the Postgres catalog (table/constraint/trigger/RLS
// policy present) — residue-free, derivable from the merged diff + catalog. The BEHAVIORAL proof (a live
// cross-user read, a trigger actually firing, a real dedup, an upload) creates residue that the safe prod
// access can't clean up, so it waits for a disposable env (V3 / staging) — see PRD §13. server-logic + storage
// are behavioral-only, so on prod they escalate to a human.
const CHECK_SPECS: Record<BackendProperty, { mechanism: CheckMechanism; safetyTier: SafetyTier; assertion: string }> = {
  rls: {
    mechanism: "db-read", safetyTier: "read-only",
    assertion: "RLS is enabled on <target> and at least one access policy is defined (the deny-all / owner-scoped guard exists).",
  },
  schema: {
    mechanism: "db-read", safetyTier: "read-only",
    assertion: "The table <target> the migration defines exists in the catalog.",
  },
  trigger: {
    mechanism: "db-read", safetyTier: "read-only",
    assertion: "The expected trigger is attached to <target> in the catalog.",
  },
  "data-integrity": {
    mechanism: "db-read", safetyTier: "read-only",
    assertion: "A unique or primary-key constraint on <target> structurally backs the no-duplicate / upsert guarantee.",
  },
  "server-logic": {
    mechanism: "http", safetyTier: "escalate",
    assertion: "The Worker <target> enforces its server-side contract (JWT / signature / pricing) — behavioral, verify by hand or on staging.",
  },
  storage: {
    mechanism: "session", safetyTier: "escalate",
    assertion: "A user's upload lands in <target> and the bucket's access rules hold — behavioral, verify by hand or on staging.",
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

/** Splice the resource into an assertion's `<target>` slot(s) (falls back to a generic phrase when none). */
function fillAssertion(template: string, target: string | null): string {
  return template.replaceAll("<target>", target ?? "the affected resource");
}

/**
 * The first known DB table named in the ticket text (underscore/space tolerant), or null. Lets the live runner
 * target a catalog check when the merged PR's paths yielded no table — e.g. no PR was found (the team moves
 * tickets to Verifying pre-PR). Best-effort + grounded: only a name that is actually a table in the catalog
 * can match, so it can't invent a target.
 */
export function tableFromText(text: string, knownTables: readonly string[]): string | null {
  const hay = text.toLowerCase();
  for (const t of knownTables) {
    // Escape regex metachars first (names cross a trust boundary — the catalog), THEN allow `_`↔space leniency.
    const pat = t.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/_/g, "[ _]");
    if (new RegExp(`\\b${pat}\\b`).test(hay)) return t;
  }
  return null;
}

/**
 * Plan the auto-verification checks for the invisible properties the classifier found. One check per
 * (property, target) — each check names exactly the one resource it verifies — in the classifier's stable
 * property order; targets are derived from the merged PR's changed paths. Pure — the live runner (V2b/c)
 * executes each check over the provisioned session / db-read / http capabilities. Takes `backendProperties`
 * (not the whole VerifyRow): the row carries no other field this needs, and taking the properties + paths as
 * peer inputs keeps the derivation symmetric (both came from classifying the ticket).
 *
 * `fallbackTarget` is a table name the caller resolved from the ticket text (see {@link tableFromText}) for when
 * the merged PR had no path: a db-read check with no path target falls back to it (noted as inferred), since the
 * team often reaches Verifying before opening a PR. Non-db-read checks ignore it.
 */
export function planChecks(
  backendProperties: readonly BackendProperty[],
  changedPaths: readonly string[] = [],
  fallbackTarget: string | null = null,
): VerifyCheck[] {
  return backendProperties.flatMap((property) => {
    const spec = CHECK_SPECS[property];
    const make = (target: string | null, inferred = false): VerifyCheck => ({
      property, mechanism: spec.mechanism, safetyTier: spec.safetyTier, target,
      assertion: fillAssertion(spec.assertion, target) + (inferred ? " (table inferred from the ticket text)" : ""),
    });
    // one check per path-derived target (each names exactly what it verifies).
    const targets = targetsFor(spec.mechanism, changedPaths);
    if (targets.length) return targets.map((t) => make(t));
    // no path target: a catalog check may fall back to a table named in the ticket text; else a null-target escalate.
    return spec.mechanism === "db-read" && fallbackTarget ? [make(fallbackTarget, true)] : [make(null)];
  });
}
