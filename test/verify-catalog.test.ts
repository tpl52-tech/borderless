import { test, expect, describe } from "bun:test";
import { catalogProbe, catalogChecksForTable, publicReadPolicyProbe, hasPublicReadPolicy, type CheckOutcome } from "../src/shared/verify-catalog.ts";
import { planChecks } from "../src/shared/verify-plan.ts";
import type { VerifyCheck } from "../src/shared/verify-plan.ts";

/** The planned check for one property against one target table (uses the real planner). A `.sql` path yields
 *  the table name for the db-read/session properties; the http property (server-logic) draws its target from a
 *  functions path instead, so it gets no target here — which is fine, its probe is null regardless. */
function check(property: VerifyCheck["property"], target = "profiles"): VerifyCheck {
  return planChecks([property], [`supabase/policies/${target}.sql`])[0]!;
}
const run = (c: VerifyCheck, rows: Record<string, unknown>[]): CheckOutcome => catalogProbe(c)!.interpret(rows);

describe("publicReadPolicyProbe / hasPublicReadPolicy (declared-public intent signal)", () => {
  test("the SQL targets a permissive, true-qual SELECT/ALL policy on the public table", () => {
    const p = publicReadPolicyProbe("profiles");
    expect(p.params).toEqual(["profiles"]);
    expect(p.sql).toContain("pg_catalog.pg_policy");
    expect(p.sql).toContain("polcmd in ('r', '*')"); // SELECT or ALL
    expect(p.sql).toContain("polpermissive");
    expect(p.sql).toContain("pg_get_expr"); // renders the USING qual to compare against 'true'
  });

  test("hasPublicReadPolicy is true only when the count is > 0", () => {
    expect(hasPublicReadPolicy([{ public_read_policies: 1 }])).toBe(true);
    expect(hasPublicReadPolicy([{ public_read_policies: "2" }])).toBe(true); // bigint-as-string
    expect(hasPublicReadPolicy([{ public_read_policies: 0 }])).toBe(false);
    expect(hasPublicReadPolicy([])).toBe(false);
  });

  test("the probe's own interpret mirrors the parser (pass when a public policy exists, else inconclusive)", () => {
    expect(publicReadPolicyProbe("profiles").interpret([{ public_read_policies: 1 }]).status).toBe("pass");
    // absence ⇒ inconclusive (can't tell "no public policy" from "table absent"), matching the module's bias
    expect(publicReadPolicyProbe("items").interpret([{ public_read_policies: 0 }]).status).toBe("inconclusive");
  });
});

describe("catalogProbe (verify sweep V2b — structural checks over pg_catalog)", () => {
  test("only db-read checks get a probe; behavioral (session/http) ones escalate (null)", () => {
    expect(catalogProbe(check("rls"))).not.toBeNull();
    expect(catalogProbe(check("schema"))).not.toBeNull();
    expect(catalogProbe(check("trigger"))).not.toBeNull();
    expect(catalogProbe(check("data-integrity"))).not.toBeNull();
    expect(catalogProbe(check("server-logic", "pay"))).toBeNull(); // http → no catalog proxy
    expect(catalogProbe(check("storage"))).toBeNull(); // session → no catalog proxy
  });

  test("catalogChecksForTable builds the four structural checks, each db-read + targeted at the table (probeable)", () => {
    const checks = catalogChecksForTable("profiles");
    expect(checks.map((c) => c.property).sort()).toEqual(["data-integrity", "rls", "schema", "trigger"]);
    expect(checks.every((c) => c.mechanism === "db-read" && c.target === "profiles")).toBe(true);
    expect(checks.every((c) => catalogProbe(c) != null)).toBe(true); // every one yields a runnable probe
  });

  test("a db-read check with no derivable target table has no probe (→ escalate)", () => {
    const noTarget = planChecks(["rls"], ["README.md"])[0]!; // nothing yields a table name
    expect(noTarget.target).toBeNull();
    expect(catalogProbe(noTarget)).toBeNull();
  });

  test("the probe is catalog-only and parameterized (no user-data table, no string-interpolated target)", () => {
    const p = catalogProbe(check("rls"))!;
    expect(p.sql).toContain("pg_catalog.pg_class");
    expect(p.sql).toContain("pg_catalog.pg_policy");
    expect(p.params).toEqual(["profiles"]);
    expect(p.sql).toContain("$1"); // bound param, not spliced
    expect(p.sql).not.toContain("profiles"); // the table name never lands in the SQL text
  });

  test("schema: table present → pass; absent → inconclusive (not a false fail)", () => {
    expect(run(check("schema"), [{ schema: "public", name: "profiles", columns: 7 }])).toEqual({ status: "pass", evidence: "public.profiles exists (7 columns)" });
    expect(run(check("schema"), []).status).toBe("inconclusive");
  });

  test("rls: enabled + a policy → pass; enabled but zero policies → fail; missing table → inconclusive", () => {
    expect(run(check("rls"), [{ rls_enabled: true, policies: 2 }]).status).toBe("pass");
    const fail = run(check("rls"), [{ rls_enabled: true, policies: 0 }]);
    expect(fail.status).toBe("fail");
    expect(fail.evidence).toContain("policies=0");
    expect(run(check("rls"), [{ rls_enabled: false, policies: 3 }]).status).toBe("fail"); // policy exists but RLS off
    expect(run(check("rls"), []).status).toBe("inconclusive");
  });

  test("rls coerces pg's string/char encodings (bigint count, 't' boolean)", () => {
    expect(run(check("rls"), [{ rls_enabled: "t", policies: "1" }]).status).toBe("pass");
  });

  test("trigger: attached → pass; none → fail; missing table → inconclusive", () => {
    expect(run(check("trigger"), [{ triggers: 1 }]).status).toBe("pass");
    expect(run(check("trigger"), [{ triggers: 0 }]).status).toBe("fail");
    expect(run(check("trigger"), []).status).toBe("inconclusive");
  });

  test("data-integrity: a unique/pk constraint → pass; none → fail; missing table → inconclusive", () => {
    expect(run(check("data-integrity"), [{ uniques: 1 }]).status).toBe("pass");
    expect(run(check("data-integrity"), [{ uniques: 0 }]).status).toBe("fail");
    expect(run(check("data-integrity"), []).status).toBe("inconclusive");
  });
});
