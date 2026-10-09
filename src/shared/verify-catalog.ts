/**
 * Verify-sweep catalog probes (PRD §13, phase V2b) — the pure "which Postgres catalog query confirms this
 * structural guarantee, and did it hold?" brain. For each `db-read` VerifyCheck the planner produced, it
 * builds a parameterized `pg_catalog` query + the verdict interpreter over the returned rows. The live runner
 * (daemon, V2b-2) executes the SQL over the SELECT-only role and feeds the rows back to `interpret()`.
 *
 * No I/O here. **Catalog-only**: every query reads `pg_catalog`, never a user-data row — so the role it runs
 * under needs no table privileges at all (it literally cannot read a user's data). Scoped to the `public`
 * schema, where the app's migrations/policies live; other schemas (storage, auth) are a later pass.
 *
 * Outcomes are three-valued on purpose (precision over bravado): `pass` / `fail` are definitive; `inconclusive`
 * is "I couldn't confirm" — e.g. the target table name (a best-effort hint from the migration file) matched no
 * table — and must surface to a human, never masquerade as a fail.
 */

import type { BackendProperty } from "./verify.ts";
import type { VerifyCheck } from "./verify-plan.ts";

/** One row returned by a catalog query (shape depends on the probe). */
export type CatalogRow = Record<string, unknown>;

export interface CheckOutcome {
  status: "pass" | "fail" | "inconclusive";
  evidence: string;
}

/** A parameterized catalog query + the pure interpreter of its rows. */
export interface CatalogProbe {
  sql: string;
  params: unknown[];
  interpret: (rows: CatalogRow[]) => CheckOutcome;
}

// pg returns counts as bigint strings and bools as "t"/true depending on the driver — coerce both defensively.
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));
const bool = (v: unknown): boolean => v === true || v === "t" || v === "true";

// The catalog row that locates a public table by name (shared `from`/`where` across probes).
const TABLE = `pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where c.relname = $1 and c.relkind in ('r','p') and n.nspname = 'public'`;
const notFound = (property: string, t: string): CheckOutcome =>
  ({ status: "inconclusive", evidence: `no public table named "${t}" to run the ${property} check on (the migration file name may not be the table name) — needs a human glance` });

// property → (target table) → its catalog probe. Only the structural (db-read) properties appear; the others
// have no catalog proxy and fall through to null in catalogProbe() so the runner escalates them.
const PROBES: Partial<Record<BackendProperty, (target: string) => CatalogProbe>> = {
  schema: (t) => ({
    sql: `select n.nspname as schema, c.relname as name,
            (select count(*) from pg_catalog.pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped) as columns
          from ${TABLE}`,
    params: [t],
    interpret: (rows) =>
      rows.length
        ? { status: "pass", evidence: `${rows[0]!.schema}.${rows[0]!.name} exists (${num(rows[0]!.columns)} columns)` }
        : notFound("schema", t),
  }),
  rls: (t) => ({
    sql: `select c.relrowsecurity as rls_enabled,
            (select count(*) from pg_catalog.pg_policy p where p.polrelid = c.oid) as policies
          from ${TABLE}`,
    params: [t],
    interpret: (rows) => {
      if (!rows.length) return notFound("RLS", t);
      const enabled = bool(rows[0]!.rls_enabled), policies = num(rows[0]!.policies);
      return enabled && policies > 0
        ? { status: "pass", evidence: `RLS enabled on ${t} with ${policies} polic${policies === 1 ? "y" : "ies"}` }
        : { status: "fail", evidence: `${t}: RLS enabled=${enabled}, policies=${policies} — no full deny-all / owner-scoped guard in place` };
    },
  }),
  trigger: (t) => ({
    sql: `select (select count(*) from pg_catalog.pg_trigger g where g.tgrelid = c.oid and not g.tgisinternal) as triggers
          from ${TABLE}`,
    params: [t],
    interpret: (rows) => {
      if (!rows.length) return notFound("trigger", t);
      const triggers = num(rows[0]!.triggers);
      return triggers > 0
        ? { status: "pass", evidence: `${triggers} trigger(s) attached to ${t}` }
        : { status: "fail", evidence: `no non-internal trigger is attached to ${t}` };
    },
  }),
  "data-integrity": (t) => ({
    sql: `select (select count(*) from pg_catalog.pg_constraint con where con.conrelid = c.oid and con.contype in ('p','u')) as uniques
          from ${TABLE}`,
    params: [t],
    interpret: (rows) => {
      if (!rows.length) return notFound("data-integrity", t);
      const uniques = num(rows[0]!.uniques);
      return uniques > 0
        ? { status: "pass", evidence: `${uniques} unique/primary-key constraint(s) on ${t} back the no-duplicate guarantee` }
        : { status: "fail", evidence: `no unique or primary-key constraint on ${t} — nothing structurally prevents duplicates` };
    },
  }),
};

/**
 * Catalog probe: does `table` declare itself readable BY ANONYMOUS CLIENTS — a permissive SELECT (or ALL)
 * policy, applying to PUBLIC or the `anon` role, whose USING qualifier is literally `true`? That policy is the
 * schema's own statement that anon reads are intended, so the behavioral RLS check can treat an anon read as
 * expected (pass) rather than a possible leak (inconclusive). Catalog-only.
 *
 * The role scope is load-bearing for safety: a `TO authenticated USING (true)` policy lets *logged-in* users
 * read all rows but says nothing about anon — counting it would let a real anon leak masquerade as intended.
 * So we require PUBLIC (`polroles` contains oid 0 — the default when a policy has no TO clause) or a role named
 * `anon`. The qual must render as exactly `true` (a null qual — e.g. an ALL policy with only WITH CHECK — does
 * NOT match and so is never blessed as public). At runtime the authoritative reader is `hasPublicReadPolicy`;
 * `interpret` only serves the CatalogProbe shape + a direct `verify probe`, and follows the module's
 * precision-bias (absence ⇒ inconclusive, never a hard fail).
 */
export function publicReadPolicyProbe(table: string): CatalogProbe {
  return {
    sql: `select count(*) as public_read_policies
            from pg_catalog.pg_policy p
            join pg_catalog.pg_class c on c.oid = p.polrelid
            join pg_catalog.pg_namespace n on n.oid = c.relnamespace
          where c.relname = $1 and n.nspname = 'public'
            and p.polcmd in ('r', '*')       -- SELECT or ALL
            and p.polpermissive              -- permissive, not restrictive
            and pg_catalog.pg_get_expr(p.polqual, p.polrelid) = 'true'  -- unconditional (null qual → no match)
            and ( 0 = any(p.polroles)        -- PUBLIC (no TO clause) — reaches anon
               or exists (select 1 from pg_catalog.pg_roles r
                            where r.oid = any(p.polroles) and r.rolname = 'anon') )`,
    params: [table],
    interpret: (rows) =>
      hasPublicReadPolicy(rows)
        ? { status: "pass", evidence: `${table} has a permissive anon/PUBLIC SELECT policy (USING true)` }
        : { status: "inconclusive", evidence: `no unconditional anon/PUBLIC SELECT policy on ${table} (or the table is absent)` },
  };
}

/** Parse publicReadPolicyProbe's rows → whether an anon-reachable unconditional SELECT policy exists. Pure. */
export function hasPublicReadPolicy(rows: CatalogRow[]): boolean {
  return num(rows[0]?.public_read_policies) > 0;
}

/** The public-schema table names (catalog-only) — the live runner uses these to target a check from the ticket
 *  text when a merged PR yielded no path. The query lives here (not in the thin daemon client) so all the
 *  catalog SQL stays in one place. */
export const PUBLIC_TABLES_QUERY = `select c.relname as name
  from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r','p') and n.nspname = 'public' order by 1`;

/** Parse the PUBLIC_TABLES_QUERY rows into table names. Pure. */
export function publicTableNames(rows: CatalogRow[]): string[] {
  return rows.map((r) => String(r.name));
}

/** The structural (db-read) checks for one named table — one per catalog-probeable property (derived from
 *  PROBES), each targeted at it. For the verify-probe tool (V4c-1): run every catalog check on a table. Pure. */
export function catalogChecksForTable(table: string): VerifyCheck[] {
  // Derived from PROBES (the single local source of truth for catalog-probeable properties), so a new probe is
  // picked up here for free — nothing to re-list and drift.
  return (Object.keys(PROBES) as BackendProperty[]).map((property) => ({
    property, target: table, mechanism: "db-read", safetyTier: "read-only",
    assertion: `structural ${property} check on ${table}`,
  }));
}

/**
 * The catalog probe for a `db-read` check, or null when it isn't catalog-derivable — a non-db-read mechanism
 * (session/http → behavioral) or no target table the migration file yielded. The runner escalates a null.
 */
export function catalogProbe(check: VerifyCheck): CatalogProbe | null {
  if (check.mechanism !== "db-read") return null; // session/http checks have no catalog proxy — escalate
  const build = PROBES[check.property];
  return build && check.target ? build(check.target) : null;
}
