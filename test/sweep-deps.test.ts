import { test, expect, describe } from "bun:test";
import { checkStates, parseReviewVerdict, needsHydration, workerSeed } from "../src/daemon/sweep-deps.ts";
import type { SweepJob } from "../src/shared/types.ts";
import type { WorkerFeedback } from "../src/daemon/sweep-engine.ts";

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

  test("SKIPPED/NEUTRAL conclusions are pending — not a pass, not a fixable failure", () => {
    expect(checkStates(rollup([{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SKIPPED" }]))).toEqual({ ci: "pending" });
    expect(checkStates(rollup([{ __typename: "CheckRun", name: "secrets-scan", status: "COMPLETED", conclusion: "NEUTRAL" }]))).toEqual({ "secrets-scan": "pending" });
  });

  test("non-required checks are ignored; absent/garbled rollup yields {} (gate reads missing as pending)", () => {
    expect(checkStates(rollup([{ __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SUCCESS" }]))).toEqual({});
    expect(checkStates(rollup([]))).toEqual({});
    expect(checkStates(null)).toEqual({});
    expect(checkStates({})).toEqual({});
  });
});

describe("needsHydration", () => {
  test("true only for an in_review job that has no PR yet", () => {
    expect(needsHydration({ kind: "in_review", prNumber: null } as SweepJob)).toBe(true);
    expect(needsHydration({ kind: "in_review", prNumber: 5 } as SweepJob)).toBe(false);
    expect(needsHydration({ kind: "rescue", prNumber: null } as SweepJob)).toBe(false);
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

describe("workerSeed (PRD §5/§4 — rescue embeds ACs + branch; in-review drives the PR)", () => {
  const job = (over: Partial<SweepJob> = {}): SweepJob => ({
    id: "j1", kind: "rescue", ticketId: "t1", ticketKey: "COR-9", assignee: null,
    prNumber: null, headSha: null, sessionId: null, state: "queued", cycles: 0,
    gate: null, reason: null, createdAt: 0, updatedAt: 0, ...over,
  });
  const initial: WorkerFeedback = { initial: true, blockers: [], review: null };

  test("rescue embeds the acceptance criteria inline and asks for a PR", () => {
    const seed = workerSeed(job(), initial, { acceptance: "- [ ] greet returns Hello, X!" });
    expect(seed).toContain("Implement Linear ticket COR-9.");
    expect(seed).toContain("Acceptance criteria:\n- [ ] greet returns Hello, X!");
    expect(seed).toContain("Then open a PR.");
  });

  test("rescue truncates an over-long description", () => {
    const seed = workerSeed(job(), initial, { acceptance: "x".repeat(5000) });
    expect(seed).toContain("…(truncated)");
    expect(seed.length).toBeLessThan(4300);
  });

  test("rescue falls back to the prior phrasing when no description is known", () => {
    const seed = workerSeed(job(), initial, { acceptance: null });
    expect(seed).toContain("Implement it from its acceptance criteria.");
    expect(seed).toContain("Then open a PR.");
  });

  test("in-review drives the existing PR and ignores the rescue ACs", () => {
    const seed = workerSeed(job({ kind: "in_review", prNumber: 7 }), initial, { acceptance: "ignored" });
    expect(seed).toBe("Drive PR #7 for COR-9 to a mergeable state.");
  });

  test("a fix cycle appends the findings + gate blockers to the head", () => {
    const fb: WorkerFeedback = { initial: false, blockers: ["ci-failing"], review: { redFindings: 2, preservationProven: false, judgmentCall: null, sessionId: "r1" } };
    const seed = workerSeed(job({ kind: "in_review", prNumber: 7 }), fb);
    expect(seed).toContain("Drive PR #7");
    expect(seed).toContain("2 blocking review finding(s)");
    expect(seed).toContain("ci-failing");
    expect(seed).toContain("prove no behavior regression");
  });
});
