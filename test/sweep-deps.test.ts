import { test, expect, describe } from "bun:test";
import { checkStates, parseReviewVerdict } from "../src/daemon/sweep-deps.ts";

const rollup = (nodes: unknown[]): unknown => ({ contexts: { nodes } });

describe("checkStates (gh statusCheckRollup → required checks)", () => {
  test("CheckRun: only COMPLETED+SUCCESS is success; in-progress is pending; other conclusions fail", () => {
    expect(checkStates(rollup([
      { __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" },
      { __typename: "CheckRun", name: "secrets-scan", status: "COMPLETED", conclusion: "SUCCESS" },
    ]))).toEqual({ ci: "success", "secrets-scan": "success" });
    expect(checkStates(rollup([{ __typename: "CheckRun", name: "ci", status: "IN_PROGRESS" }]))).toEqual({ ci: "pending" });
    expect(checkStates(rollup([{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "FAILURE" }]))).toEqual({ ci: "failure" });
  });

  test("StatusContext: SUCCESS/PENDING/other map correctly", () => {
    expect(checkStates(rollup([{ __typename: "StatusContext", context: "ci", state: "SUCCESS" }]))).toEqual({ ci: "success" });
    expect(checkStates(rollup([{ __typename: "StatusContext", context: "secrets-scan", state: "PENDING" }]))).toEqual({ "secrets-scan": "pending" });
    expect(checkStates(rollup([{ __typename: "StatusContext", context: "ci", state: "ERROR" }]))).toEqual({ ci: "failure" });
  });

  test("non-required checks are ignored; absent/garbled rollup yields {} (gate reads missing as pending)", () => {
    expect(checkStates(rollup([{ __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SUCCESS" }]))).toEqual({});
    expect(checkStates(rollup([]))).toEqual({});
    expect(checkStates(null)).toEqual({});
    expect(checkStates({})).toEqual({});
  });
});

describe("parseReviewVerdict (reviewer output → verdict)", () => {
  test("parses all three markers; a clean review", () => {
    const v = parseReviewVerdict("summary...\nRED FINDINGS: 0\nPRESERVATION: proven\nJUDGMENT: none\n", "rev-1");
    expect(v).toEqual({ sessionId: "rev-1", redFindings: 0, preservationProven: true, judgmentCall: null });
  });

  test("red findings + unproven preservation + a judgment call", () => {
    const v = parseReviewVerdict("RED FINDINGS: 3\nPRESERVATION: unproven\nJUDGMENT: which rounding rule applies?", "rev-2");
    expect(v).toEqual({ sessionId: "rev-2", redFindings: 3, preservationProven: false, judgmentCall: "which rounding rule applies?" });
  });

  test("fails closed when markers are missing or garbled", () => {
    const v = parseReviewVerdict("the reviewer rambled with no markers at all", "rev-3");
    expect(v.redFindings).toBe(1); // unparseable red = treated as blocking
    expect(v.preservationProven).toBe(false); // unparseable = not proven
    expect(v.judgmentCall).toBeNull();
  });

  test("the last restated marker wins (reviewers revise)", () => {
    const v = parseReviewVerdict("RED FINDINGS: 5\n...after fixes...\nRED FINDINGS: 0\nPRESERVATION: proven\nJUDGMENT: none", "rev-4");
    expect(v.redFindings).toBe(0);
    expect(v.preservationProven).toBe(true);
  });
});
