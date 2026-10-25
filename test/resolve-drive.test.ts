import { test, expect, describe } from "bun:test";
import { Store } from "../src/daemon/store.ts";
import { approveJob, redriveJob } from "../src/daemon/resolve-drive.ts";

describe("approveJob (lead approves a stopped job → ready)", () => {
  // An approvable shape: a job waiting on a human (needs_human or signoff) that actually has a PR to merge.
  const stopped = (s: Store, key: string, prNumber: number | null = 33) => {
    const job = s.createSweepJob({ kind: "fix", ticketId: "t-" + key, ticketKey: key, prNumber });
    s.transitionSweepJob(job.id, { state: "needs_human", reason: "dangerous tier: auth" });
    return job;
  };
  const parkedForSignoff = (s: Store, key: string, prNumber: number | null = 33) => {
    const job = s.createSweepJob({ kind: "fix", ticketId: "t-" + key, ticketKey: key, prNumber });
    s.transitionSweepJob(job.id, { state: "signoff", reason: "dangerous tier: schema" });
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

  test("a signoff job with a PR → ready; the audit records it was a sign-off", () => {
    const s = new Store(":memory:");
    const job = parkedForSignoff(s, "COR-150");
    expect(approveJob(s, job.id)).toEqual({ ok: true, state: "ready" });

    const after = s.getSweepJob(job.id)!;
    expect(after.state).toBe("ready");
    expect(after.reason).toBe("lead-approved");
    const ev = s.listSweepEvents(job.id).at(-1)!;
    expect(ev.event).toBe("state_change");
    expect(ev.detail).toMatchObject({ from: "signoff", to: "ready", by: "lead-signoff" });
  });

  test("a signoff job with NO PR is refused (ready must have something to merge)", () => {
    const s = new Store(":memory:");
    const job = parkedForSignoff(s, "COR-151", null);
    const r = approveJob(s, job.id);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("no PR");
    expect(s.getSweepJob(job.id)!.state).toBe("signoff"); // unchanged
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

  test("a non-waiting state is refused (every other state left unchanged)", () => {
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

describe("redriveJob (lead re-drives a stopped job with guidance)", () => {
  const stopped = (s: Store, key: string, prNumber: number | null = 34) => {
    const job = s.createSweepJob({ kind: "fix", ticketId: "t-" + key, ticketKey: key, prNumber });
    s.transitionSweepJob(job.id, { state: "needs_human", reason: "judgment call: ..." });
    return job;
  };
  const GUIDANCE = "put the price above the stars, per Figma";

  test("needs_human + PR + guidance → queued: guidance stashed, fresh cycle budget, reason cleared, audit event", () => {
    const s = new Store(":memory:");
    const job = stopped(s, "COR-102");
    s.transitionSweepJob(job.id, { cycles: 3 }); // some prior cycles to prove the reset
    expect(redriveJob(s, job.id, GUIDANCE)).toEqual({ ok: true, state: "queued" });

    const after = s.getSweepJob(job.id)!;
    expect(after.state).toBe("queued");
    expect(after.leadGuidance).toBe(GUIDANCE);
    expect(after.cycles).toBe(0);
    expect(after.reason).toBeNull();
    const ev = s.listSweepEvents(job.id).at(-1)!;
    expect(ev.event).toBe("state_change");
    expect(ev.detail).toMatchObject({ from: "needs_human", to: "queued", by: "lead-redrive", guidance: GUIDANCE });
  });

  test("empty guidance → error, no write", () => {
    const s = new Store(":memory:");
    const job = stopped(s, "COR-102");
    const r = redriveJob(s, job.id, "");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("instruction");
    expect(s.getSweepJob(job.id)!.state).toBe("needs_human");
  });

  test("PR-less / non-needs_human / unknown → refused", () => {
    const s = new Store(":memory:");
    expect(redriveJob(s, stopped(s, "COR-20", null).id, "do x").ok).toBe(false); // no PR
    const ready = s.createSweepJob({ kind: "fix", ticketId: "t-r", ticketKey: "COR-9", prNumber: 5 });
    s.transitionSweepJob(ready.id, { state: "ready" });
    expect(redriveJob(s, ready.id, "do x").ok).toBe(false); // not needs_human
    expect(redriveJob(s, "nope", "do x")).toEqual({ ok: false, error: "job not found" });
  });
});
