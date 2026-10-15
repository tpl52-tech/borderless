import { test, expect, describe } from "bun:test";
import { Store } from "../src/daemon/store.ts";

describe("enqueueInReviewSweeps (first live slice: linear_issues -> sweep_job)", () => {
  test("one job per In-Review issue, skips other states, idempotent, re-eligible when terminal", () => {
    const s = new Store(":memory:");
    s.upsertLinearIssue({ id: "i1", identifier: "COR-24", stateName: "In Review", assignee: "neha" });
    s.upsertLinearIssue({ id: "i2", identifier: "COR-23", stateName: "In Progress" }); // not swept
    s.upsertLinearIssue({ id: "i3", identifier: "COR-35", stateName: "In Review", assignee: "willow" });

    const first = s.enqueueInReviewSweeps();
    expect(first.map((j) => j.ticketKey).sort()).toEqual(["COR-24", "COR-35"]);
    expect(first.every((j) => j.kind === "in_review" && j.state === "queued")).toBe(true);
    expect(first[0]!.assignee === "neha" || first[0]!.assignee === "willow").toBe(true);

    // idempotent: active jobs already exist -> nothing new
    expect(s.enqueueInReviewSweeps().length).toBe(0);

    // once a job is terminal, its ticket is eligible again
    s.transitionSweepJob(first[0]!.id, { state: "merged" });
    expect(s.enqueueInReviewSweeps().map((j) => j.ticketKey)).toEqual([first[0]!.ticketKey]);
  });

  test("sweeps lead-level In-Review issues too (lead-level gates only the rescue sweep, not in-review)", () => {
    const s = new Store(":memory:");
    s.upsertLinearIssue({ id: "lead", identifier: "COR-24", stateName: "In Review", labels: ["lead-level"] });
    s.upsertLinearIssue({ id: "normal", identifier: "COR-35", stateName: "In Review", labels: ["intermediate"] });
    expect(s.enqueueInReviewSweeps().map((j) => j.ticketKey).sort()).toEqual(["COR-24", "COR-35"]); // both driven
  });

  test("still skips Lead Ops project issues (human to-dos, excluded from both sweeps)", () => {
    const s = new Store(":memory:");
    s.upsertLinearIssue({ id: "ops", identifier: "COR-7", stateName: "In Review", projectName: "Lead Ops" });
    s.upsertLinearIssue({ id: "app", identifier: "COR-8", stateName: "In Review", projectName: "ReUse App" });
    expect(s.enqueueInReviewSweeps("In Review", "Lead Ops").map((j) => j.ticketKey)).toEqual(["COR-8"]);
  });

  test("upsert updates an existing issue (state change), not a duplicate row", () => {
    const s = new Store(":memory:");
    s.upsertLinearIssue({ id: "x", identifier: "COR-9", stateName: "In Progress" });
    s.upsertLinearIssue({ id: "x", identifier: "COR-9", stateName: "In Review" });
    expect(s.listLinearIssues().length).toBe(1);
    expect(s.enqueueInReviewSweeps().map((j) => j.ticketKey)).toEqual(["COR-9"]);
  });
});

describe("enqueueFixSweeps (qa-fix Todo tickets → build-from-scratch jobs)", () => {
  test("one job per unstarted qa-fix ticket; skips non-qa-fix, started, done; idempotent; re-eligible when terminal", () => {
    const s = new Store(":memory:");
    s.upsertLinearIssue({ id: "f1", identifier: "COR-100", stateName: "Todo", stateType: "unstarted", labels: ["qa-fix"], assignee: "dana" });
    s.upsertLinearIssue({ id: "f2", identifier: "COR-101", stateName: "Todo", stateType: "unstarted", labels: ["qa-fix"] });
    s.upsertLinearIssue({ id: "nf", identifier: "COR-7", stateName: "Todo", stateType: "unstarted", labels: ["feature"] });       // not qa-fix
    s.upsertLinearIssue({ id: "started", identifier: "COR-8", stateName: "In Progress", stateType: "started", labels: ["qa-fix"] }); // a human owns it
    s.upsertLinearIssue({ id: "done", identifier: "COR-9", stateName: "Done", stateType: "completed", labels: ["qa-fix"] });         // terminal

    const first = s.enqueueFixSweeps();
    expect(first.map((j) => j.ticketKey).sort()).toEqual(["COR-100", "COR-101"]);
    expect(first.every((j) => j.kind === "fix" && j.state === "queued")).toBe(true);

    expect(s.enqueueFixSweeps().length).toBe(0); // idempotent — active fix jobs already exist

    s.transitionSweepJob(first[0]!.id, { state: "merged" });
    expect(s.enqueueFixSweeps().map((j) => j.ticketKey)).toEqual([first[0]!.ticketKey]); // terminal → eligible again
  });

  test("skips lead-level (stays off the auto-builder, as with rescue) and Lead Ops", () => {
    const s = new Store(":memory:");
    s.upsertLinearIssue({ id: "lead", identifier: "COR-100", stateName: "Todo", stateType: "unstarted", labels: ["qa-fix", "lead-level"] });
    s.upsertLinearIssue({ id: "ops", identifier: "COR-101", stateName: "Todo", stateType: "unstarted", labels: ["qa-fix"], projectName: "Lead Ops" });
    s.upsertLinearIssue({ id: "ok", identifier: "COR-102", stateName: "Todo", stateType: "unstarted", labels: ["qa-fix"] });
    expect(s.enqueueFixSweeps("Lead Ops").map((j) => j.ticketKey)).toEqual(["COR-102"]);
  });

  test("the fix dedup is scoped to kind=fix: an in-review job on the same ticket doesn't block the fix job", () => {
    const s = new Store(":memory:");
    s.upsertLinearIssue({ id: "t", identifier: "COR-100", stateName: "Todo", stateType: "unstarted", labels: ["qa-fix"] });
    s.createSweepJob({ kind: "in_review", ticketId: "t", ticketKey: "COR-100" });
    expect(s.enqueueFixSweeps().map((j) => j.ticketKey)).toEqual(["COR-100"]);
  });
});
