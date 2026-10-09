import { test, expect, describe } from "bun:test";
import { rlsBehavioralOutcome } from "../src/shared/verify-rls.ts";

describe("rlsBehavioralOutcome (verify sweep V2b — behavioral RLS)", () => {
  test("anon denied (401/403) ⇒ pass — RLS blocks unauthenticated reads", () => {
    const o = rlsBehavioralOutcome({ denied: true, count: 0 }, { denied: false, count: 0 }, "favorites");
    expect(o.status).toBe("pass");
    expect(o.evidence).toContain("denied");
  });

  test("anon reads 0 rows ⇒ pass — RLS gates access", () => {
    expect(rlsBehavioralOutcome({ denied: false, count: 0 }, { denied: false, count: 4 }, "favorites").status).toBe("pass");
  });

  test("anon reads rows ⇒ inconclusive — public table or RLS gap, a human decides", () => {
    const o = rlsBehavioralOutcome({ denied: false, count: 5 }, { denied: false, count: 5 }, "profiles");
    expect(o.status).toBe("inconclusive");
    expect(o.evidence).toContain("5 row");
    expect(o.evidence).toContain("profiles");
  });
});
