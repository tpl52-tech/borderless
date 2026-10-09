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

  // V4: agent findings fold into the verdict alongside the deterministic bars — neither can override the other.
  test("agent findings + bars both pass ⇒ verified", () => {
    const v = rollupVerdict([r("pass")], [{ criterion: "upsert is idempotent", status: "pass", evidence: "ran twice, 1 row" }]);
    expect(v.verdict).toBe("verified");
    expect(v.agentFindings).toHaveLength(1);
  });

  test("a failing agent finding ⇒ needs_human even when every bar passed", () => {
    expect(rollupVerdict([r("pass"), r("pass")], [{ criterion: "notification fires on approve", status: "fail", evidence: "no row appeared" }]).verdict).toBe("needs_human");
  });

  test("a failing bar ⇒ needs_human even when the agent passed everything (bar can't be overridden)", () => {
    expect(rollupVerdict([r("fail")], [{ criterion: "x", status: "pass", evidence: "looked fine" }]).verdict).toBe("needs_human");
  });

  test("an inconclusive agent finding ⇒ needs_human", () => {
    expect(rollupVerdict([], [{ criterion: "x", status: "inconclusive", evidence: "couldn't determine" }]).verdict).toBe("needs_human");
  });

  test("agent-only findings (no bars) still drive the verdict", () => {
    expect(rollupVerdict([], [{ criterion: "x", status: "pass", evidence: "ok" }]).verdict).toBe("verified");
  });

  test("no bars and no agent findings ⇒ ui", () => {
    expect(rollupVerdict([], []).verdict).toBe("ui");
  });
});
