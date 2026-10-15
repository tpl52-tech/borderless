import { test, expect, describe } from "bun:test";
import { Store } from "../src/daemon/store.ts";
import { approveJob } from "../src/daemon/resolve-drive.ts";

describe("approveJob (lead approves a stopped job → ready)", () => {
  test("a needs_human job → ready, with an audit event; the note lands in the reason", () => {
    const s = new Store(":memory:");
    const job = s.createSweepJob({ kind: "fix", ticketId: "t1", ticketKey: "COR-101" });
    s.transitionSweepJob(job.id, { state: "needs_human", reason: "dangerous tier: auth" });

    expect(approveJob(s, job.id, "reviewed PR #33, the SSO change is correct")).toEqual({ ok: true, state: "ready" });

    const after = s.getSweepJob(job.id)!;
    expect(after.state).toBe("ready");
    expect(after.reason).toBe("lead-approved: reviewed PR #33, the SSO change is correct");
    const ev = s.listSweepEvents(job.id).at(-1)!;
    expect(ev.event).toBe("state_change");
    expect(ev.detail).toMatchObject({ to: "ready", by: "lead-approve" });
  });

  test("no note → a bare lead-approved reason", () => {
    const s = new Store(":memory:");
    const job = s.createSweepJob({ kind: "in_review", ticketId: "t2", ticketKey: "COR-20" });
    s.transitionSweepJob(job.id, { state: "needs_human", reason: "judgment call: …" });
    expect(approveJob(s, job.id, "").ok).toBe(true);
    expect(s.getSweepJob(job.id)!.reason).toBe("lead-approved");
  });

  test("unknown job → error, no write", () => {
    const s = new Store(":memory:");
    expect(approveJob(s, "nope", "")).toEqual({ ok: false, error: "job not found" });
  });

  test("only a needs_human job is approvable (a resting/active job is refused, unchanged)", () => {
    const s = new Store(":memory:");
    for (const state of ["ready", "queued", "reviewing", "merged", "failed"] as const) {
      const job = s.createSweepJob({ kind: "fix", ticketId: "t-" + state, ticketKey: "COR-9" });
      s.transitionSweepJob(job.id, { state });
      const r = approveJob(s, job.id, "");
      expect(r.ok).toBe(false);
      expect(r.error).toContain(state);
      expect(s.getSweepJob(job.id)!.state).toBe(state); // unchanged
    }
  });
});
