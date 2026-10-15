import { test, expect, describe } from "bun:test";
import { Store } from "../src/daemon/store.ts";
import { approveJob } from "../src/daemon/resolve-drive.ts";

describe("approveJob (lead approves a stopped job → ready)", () => {
  // The only approvable shape: a needs_human job that actually has a PR to merge.
  const stopped = (s: Store, key: string, prNumber: number | null = 33) => {
    const job = s.createSweepJob({ kind: "fix", ticketId: "t-" + key, ticketKey: key, prNumber });
    s.transitionSweepJob(job.id, { state: "needs_human", reason: "dangerous tier: auth" });
    return job;
  };

  test("a needs_human job with a PR → ready; transition lands before the audit event", () => {
    const s = new Store(":memory:");
    const job = stopped(s, "COR-101");
    expect(approveJob(s, job.id)).toEqual({ ok: true, state: "ready" });

    const after = s.getSweepJob(job.id)!;
    expect(after.state).toBe("ready");
    expect(after.reason).toBe("lead-approved");
    const ev = s.listSweepEvents(job.id).at(-1)!;
    expect(ev.event).toBe("state_change");
    expect(ev.detail).toMatchObject({ from: "needs_human", to: "ready", by: "lead-approve" });
  });

  test("unknown job → error, no write", () => {
    const s = new Store(":memory:");
    expect(approveJob(s, "nope")).toEqual({ ok: false, error: "job not found" });
  });

  test("a needs_human job with NO PR is refused (ready must have something to merge)", () => {
    const s = new Store(":memory:");
    const job = stopped(s, "COR-20", null);
    const r = approveJob(s, job.id);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("no PR");
    expect(s.getSweepJob(job.id)!.state).toBe("needs_human"); // unchanged
  });

  test("only a needs_human job is approvable (every other state refused + left unchanged)", () => {
    const s = new Store(":memory:");
    for (const state of ["ready", "queued", "implementing", "fixing", "reviewing", "ci", "merged", "failed"] as const) {
      const job = s.createSweepJob({ kind: "fix", ticketId: "t-" + state, ticketKey: "COR-9", prNumber: 5 });
      s.transitionSweepJob(job.id, { state });
      const r = approveJob(s, job.id);
      expect(r.ok).toBe(false);
      expect(r.error).toContain(state);
      expect(s.getSweepJob(job.id)!.state).toBe(state); // unchanged
    }
  });
});
