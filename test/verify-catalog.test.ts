import { test, expect, describe } from "bun:test";
import { catalogProbe, type CheckOutcome } from "../src/shared/verify-catalog.ts";
import { planChecks } from "../src/shared/verify-plan.ts";
import type { VerifyCheck } from "../src/shared/verify-plan.ts";

/** The planned check for one property against one target table (uses the real planner). A `.sql` path yields
 *  the table name for the db-read/session properties; the http property (server-logic) draws its target from a
 *  functions path instead, so it gets no target here — which is fine, its probe is null regardless. */
function check(property: VerifyCheck["property"], target = "profiles"): VerifyCheck {
  return planChecks([property], [`supabase/policies/${target}.sql`])[0]!;
}
const run = (c: VerifyCheck, rows: Record<string, unknown>[]): CheckOutcome => catalogProbe(c)!.interpret(rows);

describe("catalogProbe (verify sweep V2b — structural checks over pg_catalog)", () => {
  test("only db-read checks get a probe; behavioral (session/http) ones escalate (null)", () => {
    expect(catalogProbe(check("rls"))).not.toBeNull();
    expect(catalogProbe(check("schema"))).not.toBeNull();
    expect(catalogProbe(check("trigger"))).not.toBeNull();
    expect(catalogProbe(check("data-integrity"))).not.toBeNull();
    expect(catalogProbe(check("server-logic", "pay"))).toBeNull(); // http → no catalog proxy
    expect(catalogProbe(check("storage"))).toBeNull(); // session → no catalog proxy
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
