import { test, expect, describe } from "bun:test";
import { checkStates, parseReviewVerdict, needsHydration, isRestingWithPr, reReviewAdvancedPrs, workerSeed, reviewerSeed } from "../src/daemon/sweep-deps.ts";
import type { Store } from "../src/daemon/store.ts";
import type { SweepJob } from "../src/shared/types.ts";
import type { WorkerFeedback } from "../src/daemon/sweep-engine.ts";
import type { Territory } from "../src/shared/collision.ts";

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

describe("isRestingWithPr (head-advance re-review candidate)", () => {
  const job = (over: Partial<SweepJob>): SweepJob => ({
    id: "j", kind: "in_review", ticketId: "t", ticketKey: "COR-20", assignee: null,
    prNumber: 31, headSha: "sha-a", sessionId: null, state: "needs_human", cycles: 0,
    gate: null, reason: null, createdAt: 0, updatedAt: 0, ...over,
  });

  test("true for a resting in-review job with a PR + reviewed head", () => {
    expect(isRestingWithPr(job({ state: "needs_human" }))).toBe(true);
    expect(isRestingWithPr(job({ state: "ready" }))).toBe(true);
  });

  test("false while the job is still being driven (not resting)", () => {
    for (const state of ["queued", "fixing", "ci", "reviewing"] as const) {
      expect(isRestingWithPr(job({ state }))).toBe(false);
    }
  });

  test("false once terminal — a merged/failed job is done, not awaiting a new push", () => {
    expect(isRestingWithPr(job({ state: "merged" }))).toBe(false);
    expect(isRestingWithPr(job({ state: "failed" }))).toBe(false);
  });

  test("false without a PR or a reviewed head (nothing to compare a new head against)", () => {
    expect(isRestingWithPr(job({ prNumber: null }))).toBe(false);
    expect(isRestingWithPr(job({ headSha: null }))).toBe(false);
  });

  test("false for a rescue job (re-review is in-review-only)", () => {
    expect(isRestingWithPr(job({ kind: "rescue", state: "needs_human" }))).toBe(false);
  });
});

describe("reReviewAdvancedPrs (re-open resting jobs whose PR head advanced)", () => {
  const mk = (over: Partial<SweepJob>): SweepJob => ({
    id: over.id ?? "j", kind: "in_review", ticketId: over.ticketId ?? "t", ticketKey: over.ticketKey ?? "COR-20",
    assignee: null, prNumber: 31, headSha: "sha-old", sessionId: "old-sess", state: "needs_human", cycles: 5,
    gate: { grade: "A-" }, reason: "a blocker", createdAt: 0, updatedAt: 0, ...over,
  });

  /** A fake store that records transitions + events, scoped to the four methods reReviewAdvancedPrs reads.
   *  `throwTransitionFor` makes transitionSweepJob throw for that job id — e.g. a uq_sweep_review collision. */
  const fakeStore = (jobs: SweepJob[], columns: Record<string, string | undefined>, throwTransitionFor?: string) => {
    const byId = new Map(jobs.map((j) => [j.id, { ...j }]));
    const events: Array<{ jobId: string; detail: Record<string, unknown> }> = [];
    const store = {
      listSweepJobs: ({ kind }: { kind?: string } = {}) => [...byId.values()].filter((j) => !kind || j.kind === kind),
      getLinearIssue: (id: string) => (columns[id] ? { stateName: columns[id] } : null),
      transitionSweepJob: (id: string, patch: Partial<SweepJob>) => {
        if (id === throwTransitionFor) throw new Error("SQLITE_CONSTRAINT: uq_sweep_review");
        const next = { ...byId.get(id)!, ...patch, updatedAt: byId.get(id)!.updatedAt + 1 };
        byId.set(id, next);
        return next;
      },
      recordSweepEvent: (jobId: string, _event: string, detail: Record<string, unknown>) => { events.push({ jobId, detail }); return {} as never; },
    };
    return { store: store as unknown as Store, events, byId };
  };
  const headAdvanced = async () => "sha-new";

  test("re-opens an advanced resting job in place: queued + new head, prior attempt cleared, event recorded", async () => {
    const { store, events, byId } = fakeStore([mk({ id: "j1", ticketId: "t1" })], { t1: "In Review" });
    const reopened = await reReviewAdvancedPrs(store, "In Review", headAdvanced);

    expect(reopened.map((j) => j.id)).toEqual(["j1"]);
    const j = byId.get("j1")!;
    expect(j.state).toBe("queued");
    expect(j.headSha).toBe("sha-new");
    expect({ cycles: j.cycles, gate: j.gate, reason: j.reason, sessionId: j.sessionId }).toEqual({ cycles: 0, gate: null, reason: null, sessionId: null });
    expect(events).toEqual([{ jobId: "j1", detail: { from: "needs_human", to: "queued", reason: "head-advance re-review", headSha: "sha-new" } }]);
  });

  test("leaves a job whose head is unchanged, or whose head is unknown (human hasn't pushed)", async () => {
    const { store, byId } = fakeStore([mk({ id: "j1", ticketId: "t1" })], { t1: "In Review" });
    expect(await reReviewAdvancedPrs(store, "In Review", async () => "sha-old")).toEqual([]);
    expect(await reReviewAdvancedPrs(store, "In Review", async () => null)).toEqual([]);
    expect(byId.get("j1")!.state).toBe("needs_human");
  });

  test("ignores a ticket that left the swept column — a human reclaimed it (back to In Progress)", async () => {
    const { store, byId } = fakeStore([mk({ id: "j1", ticketId: "t1" })], { t1: "In Progress" });
    expect(await reReviewAdvancedPrs(store, "In Review", headAdvanced)).toEqual([]);
    expect(byId.get("j1")!.state).toBe("needs_human");
  });

  test("ignores jobs still being driven, terminal, or rescue (only resting-with-PR is a candidate)", async () => {
    const jobs = [
      mk({ id: "driving", ticketId: "t1", state: "reviewing" }),
      mk({ id: "merged", ticketId: "t2", state: "merged" }),
      mk({ id: "rescue", ticketId: "t3", kind: "rescue" }),
    ];
    const { store } = fakeStore(jobs, { t1: "In Review", t2: "In Review", t3: "In Review" });
    expect(await reReviewAdvancedPrs(store, "In Review", headAdvanced)).toEqual([]);
  });

  test("fail-soft: one PR's fetch failure doesn't block re-review of the others", async () => {
    const { store, byId } = fakeStore(
      [mk({ id: "boom", ticketId: "t1", prNumber: 31 }), mk({ id: "ok", ticketId: "t2", prNumber: 32 })],
      { t1: "In Review", t2: "In Review" },
    );
    const headFor = async (pr: number) => { if (pr === 31) throw new Error("gh exit 1"); return "sha-new"; };
    const reopened = await reReviewAdvancedPrs(store, "In Review", headFor);
    expect(reopened.map((j) => j.id)).toEqual(["ok"]); // the healthy one still re-opened
    expect(byId.get("boom")!.state).toBe("needs_human"); // the failed one left resting, retried next sweep
  });

  test("fail-soft on the reopen UPDATE itself: a uq_sweep_review collision on one job doesn't block the others", async () => {
    const { store, byId } = fakeStore(
      [mk({ id: "collide", ticketId: "t1", prNumber: 31 }), mk({ id: "ok", ticketId: "t2", prNumber: 32 })],
      { t1: "In Review", t2: "In Review" },
      "collide", // transitionSweepJob throws for this one (a force-push back to an already-recorded sha)
    );
    const reopened = await reReviewAdvancedPrs(store, "In Review", headAdvanced);
    expect(reopened.map((j) => j.id)).toEqual(["ok"]); // the collision was swallowed; the other still re-opened
    expect(byId.get("collide")!.state).toBe("needs_human"); // left resting (the throwing UPDATE never applied)
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

describe("workerSeed (PRD §5/§4 — rescue embeds the ACs; in-review drives the PR)", () => {
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

  test("a territory in context appends the preventive collision warning (both initial + fix cycles)", () => {
    const territory: Territory = new Map([
      ["conditionstars", { ticketKey: "COR-54", owner: "Renee Gowda", state: "In Progress", deliverable: "ConditionStars" }],
    ]);
    const rescue = workerSeed(job(), initial, { acceptance: "build it", territory });
    expect(rescue).toContain("Implement Linear ticket COR-9."); // the normal seed body is kept
    expect(rescue).toContain("do NOT create, extract, or rewrite them"); // ...plus the warning
    expect(rescue).toContain("ConditionStars — owned by COR-54");

    const fb: WorkerFeedback = { initial: false, blockers: ["ci-failing"], review: { redFindings: 1, preservationProven: true, judgmentCall: null, sessionId: "r1" } };
    const fix = workerSeed(job({ kind: "in_review", prNumber: 7 }), fb, { territory });
    expect(fix).toContain("Drive PR #7");
    expect(fix).toContain("ConditionStars — owned by COR-54");
  });
});

describe("reviewerSeed (acceptance-criteria completeness is a gate dimension)", () => {
  const job = (over: Partial<SweepJob> = {}): SweepJob => ({
    id: "j", kind: "in_review", ticketId: "t", ticketKey: "COR-19", assignee: null,
    prNumber: 22, headSha: "h", sessionId: null, state: "reviewing", cycles: 0,
    gate: null, reason: null, createdAt: 0, updatedAt: 0, ...over,
  });

  test("embeds the ACs and makes an unmet criterion blocking; in-review also checks regression", () => {
    const s = reviewerSeed(job(), "- [ ] Recommended/Deals section\n- [ ] New Additions section");
    expect(s).toContain("PR #22 for COR-19");
    expect(s).toContain("NEVER pass an incomplete implementation");
    expect(s).toContain("Recommended/Deals section"); // the ACs are embedded for the reviewer to check
    expect(s).toContain("no regression");              // in-review guards the author's original behavior
    expect(s).toContain("RED FINDINGS:");
  });

  test("rescue checks completeness but NOT regression (no original behavior to preserve)", () => {
    const s = reviewerSeed(job({ kind: "rescue" }), "- [ ] build it");
    expect(s).toContain("EVERY acceptance criterion");
    expect(s).not.toContain("no regression");
  });

  test("no/blank ACs → flags that completeness couldn't be confirmed and treats it as blocking", () => {
    expect(reviewerSeed(job(), null)).toContain("could not confirm completeness");
    expect(reviewerSeed(job(), "   ")).toContain("could not confirm completeness");
  });

  test("truncates a pathologically long AC block", () => {
    const s = reviewerSeed(job(), "x".repeat(5000));
    expect(s).toContain("…(truncated)");
    expect(s).not.toContain("x".repeat(4001)); // the AC block is capped at MAX_ACCEPTANCE (4000)
    expect(s.length).toBeLessThan(5200);        // 4000 capped AC + the prompt boilerplate
  });
});
