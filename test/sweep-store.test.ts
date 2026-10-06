import { test, expect, describe } from "bun:test";
import { Store } from "../src/daemon/store.ts";

describe("sweep_job store (lead-console PRD §4-§5)", () => {
  test("create -> transition -> event lifecycle", () => {
    const s = new Store(":memory:");
    const job = s.createSweepJob({ kind: "rescue", ticketId: "lin-1", ticketKey: "COR-29", assignee: "dana" });
    expect(job.state).toBe("queued");
    expect(job.cycles).toBe(0);
    expect(job.gate).toBeNull();

    const up = s.transitionSweepJob(job.id, { state: "implementing", cycles: 1, gate: { ac: false } });
    expect(up.state).toBe("implementing");
    expect(up.cycles).toBe(1);
    expect(up.gate).toEqual({ ac: false });
    expect(up.updatedAt).toBeGreaterThanOrEqual(job.updatedAt);

    s.recordSweepEvent(job.id, "spawn", { tool: "claude" });
    s.recordSweepEvent(job.id, "gate_eval", { grade: "A" });
    const events = s.listSweepEvents(job.id);
    expect(events.map((e) => e.event)).toEqual(["spawn", "gate_eval"]);
    expect(events[1]!.detail).toEqual({ grade: "A" });
  });

  test("filters by kind and state", () => {
    const s = new Store(":memory:");
    s.createSweepJob({ kind: "in_review", ticketId: "a", ticketKey: "COR-1" });
    const r = s.createSweepJob({ kind: "rescue", ticketId: "b", ticketKey: "COR-2" });
    s.transitionSweepJob(r.id, { state: "ready" });
    expect(s.listSweepJobs({ kind: "rescue" }).length).toBe(1);
    expect(s.listSweepJobs({ state: "ready" }).map((j) => j.ticketKey)).toEqual(["COR-2"]);
    expect(s.listSweepJobs().length).toBe(2);
  });

  test("one active rescue per ticket (partial unique index)", () => {
    const s = new Store(":memory:");
    const a = s.createSweepJob({ kind: "rescue", ticketId: "t1", ticketKey: "COR-9" });
    // a second ACTIVE rescue for the same ticket is rejected
    expect(() => s.createSweepJob({ kind: "rescue", ticketId: "t1", ticketKey: "COR-9" })).toThrow();
    // once the first is terminal, a fresh rescue is allowed
    s.transitionSweepJob(a.id, { state: "merged" });
    expect(() => s.createSweepJob({ kind: "rescue", ticketId: "t1", ticketKey: "COR-9" })).not.toThrow();
  });

  test("in-review idempotency: one job per (ticket, head)", () => {
    const s = new Store(":memory:");
    s.createSweepJob({ kind: "in_review", ticketId: "t", ticketKey: "COR-7", headSha: "abc123" });
    // same ticket + same head is rejected by the partial unique index
    expect(() => s.createSweepJob({ kind: "in_review", ticketId: "t", ticketKey: "COR-7", headSha: "abc123" })).toThrow();
    // a new commit (new head) is a new job
    expect(() => s.createSweepJob({ kind: "in_review", ticketId: "t", ticketKey: "COR-7", headSha: "def456" })).not.toThrow();
  });
});
