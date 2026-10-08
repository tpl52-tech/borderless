import { test, expect, describe } from "bun:test";
import { rollupVerdict, type CheckResult } from "../src/shared/verify-verdict.ts";

const r = (status: CheckResult["status"]): CheckResult =>
  ({ property: "schema", target: "t", mechanism: "db-read", status, assertion: "a", evidence: "e" });

describe("rollupVerdict (verify sweep V2b)", () => {
  test("no checks ⇒ ui (nothing invisible; human QA owns it)", () => {
    expect(rollupVerdict([]).verdict).toBe("ui");
  });

  test("every check pass ⇒ verified", () => {
    expect(rollupVerdict([r("pass"), r("pass")]).verdict).toBe("verified");
  });

  test("any fail ⇒ needs_human", () => {
    expect(rollupVerdict([r("pass"), r("fail")]).verdict).toBe("needs_human");
  });

  test("an inconclusive or an escalated (no hard fail) still ⇒ needs_human", () => {
    expect(rollupVerdict([r("pass"), r("inconclusive")]).verdict).toBe("needs_human");
    expect(rollupVerdict([r("pass"), r("escalated")]).verdict).toBe("needs_human");
  });

  test("summary counts each status", () => {
    expect(rollupVerdict([r("pass"), r("pass"), r("fail"), r("escalated")]).summary)
      .toEqual({ pass: 2, fail: 1, inconclusive: 0, escalated: 1 });
  });
});
