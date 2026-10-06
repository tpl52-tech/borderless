import { test, expect, describe } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
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

  test("session link: default null, set/clear, and ON DELETE SET NULL (migration step 2)", () => {
    const s = new Store(":memory:");
    const task = s.createTask({ name: "sweep task" });
    const sess = s.createSession({ taskId: task.id, tool: "claude", location: "local", cwd: "/tmp/x" });
    const job = s.createSweepJob({ kind: "in_review", ticketId: "lin-9", ticketKey: "COR-9", headSha: "h1" });
    expect(job.sessionId).toBeNull();

    // link the job to its agent session
    const linked = s.transitionSweepJob(job.id, { sessionId: sess.id });
    expect(linked.sessionId).toBe(sess.id);
    expect(s.getSweepJob(job.id)!.sessionId).toBe(sess.id);

    // explicit unlink
    expect(s.transitionSweepJob(job.id, { sessionId: null }).sessionId).toBeNull();

    // relink, then remove the session: the FK drops the link but keeps the durable job row
    s.transitionSweepJob(job.id, { sessionId: sess.id });
    s.removeSession(sess.id);
    const after = s.getSweepJob(job.id);
    expect(after).not.toBeNull();
    expect(after!.sessionId).toBeNull();
  });

  test("session link: a nonexistent session is rejected by the foreign key", () => {
    const s = new Store(":memory:");
    const job = s.createSweepJob({ kind: "rescue", ticketId: "lin-1", ticketKey: "COR-1" });
    expect(() => s.transitionSweepJob(job.id, { sessionId: "no-such-session" })).toThrow();
  });

  test("migration step 2 is not re-applied on reopen (no duplicate-column error)", () => {
    const path = join(tmpdir(), `borderless-sweep-${crypto.randomUUID()}.sqlite`);
    try {
      const a = new Store(path);
      const job = a.createSweepJob({ kind: "in_review", ticketId: "t", ticketKey: "COR-7" });
      a.close();
      // reopen: migrate() must see user_version=2 and skip step 2 — a re-run ALTER would throw.
      const b = new Store(path);
      expect(b.getSweepJob(job.id)!.sessionId).toBeNull();
      b.close();
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) { try { rmSync(path + suffix); } catch { /* ignore */ } }
    }
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
