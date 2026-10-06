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

  test("upsert updates an existing issue (state change), not a duplicate row", () => {
    const s = new Store(":memory:");
    s.upsertLinearIssue({ id: "x", identifier: "COR-9", stateName: "In Progress" });
    s.upsertLinearIssue({ id: "x", identifier: "COR-9", stateName: "In Review" });
    expect(s.listLinearIssues().length).toBe(1);
    expect(s.enqueueInReviewSweeps().map((j) => j.ticketKey)).toEqual(["COR-9"]);
  });
});
