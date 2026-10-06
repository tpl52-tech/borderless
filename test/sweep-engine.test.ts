import { test, expect, describe } from "bun:test";
import { Store } from "../src/daemon/store.ts";
import { MAX_CYCLES } from "../src/shared/sweep-gate.ts";
import {
  runSweepJob,
  type SweepEngineDeps, type PollResult, type ReviewVerdict, type WorkerResult, type WorkerFeedback,
} from "../src/daemon/sweep-engine.ts";

const CLEAN_POLL: PollResult = { checks: { ci: "success", "secrets-scan": "success" }, changedPaths: ["src/ui/button.ts"] };
const cleanReview = (): Omit<ReviewVerdict, "sessionId"> => ({ redFindings: 0, preservationProven: true, judgmentCall: null });
const redReview = (): Omit<ReviewVerdict, "sessionId"> => ({ redFindings: 2, preservationProven: false, judgmentCall: null });

// The overrides give everything EXCEPT the sessionId — the fake mints a real session row (so the
// sweep_job.session_id FK from Phase 1 is satisfiable) and injects its id, mirroring production where the
// spawn creates the session before the job links to it.
interface Over {
  poll?: (call: number) => PollResult;
  review?: (call: number) => Omit<ReviewVerdict, "sessionId">;
  worker?: (feedback: WorkerFeedback, call: number) => Omit<WorkerResult, "sessionId">;
}
interface Rec { spawns: WorkerFeedback[]; polls: number; reviews: number; waits: number; sessions: string[] }

function makeDeps(store: Store, over: Over = {}): { deps: SweepEngineDeps; rec: Rec } {
  const taskId = store.createTask({ name: "sweep task" }).id;
  const rec: Rec = { spawns: [], polls: 0, reviews: 0, waits: 0, sessions: [] };
  const mkSession = (): string => {
    const id = store.createSession({ taskId, tool: "claude", location: "local", cwd: "/tmp/x" }).id;
    rec.sessions.push(id);
    return id;
  };
  const deps: SweepEngineDeps = {
    ciPollMs: 0,
    async spawnWorker(_job, feedback) {
      rec.spawns.push(feedback);
      const n = rec.spawns.length;
      const partial = over.worker ? over.worker(feedback, n) : { headSha: `h${n}`, prNumber: 5 };
      return { ...partial, sessionId: mkSession() };
    },
    async pollCi() {
      rec.polls++;
      return over.poll ? over.poll(rec.polls) : CLEAN_POLL;
    },
    async review() {
      rec.reviews++;
      const partial = over.review ? over.review(rec.reviews) : cleanReview();
      return { ...partial, sessionId: mkSession() };
    },
    async wait() { rec.waits++; },
  };
  return { deps, rec };
}

describe("runSweepJob (sweep engine, PRD §4-§5)", () => {
  test("in_review: an author PR that already passes reviews once and goes ready (no fixer)", async () => {
    const s = new Store(":memory:");
    const job = s.createSweepJob({ kind: "in_review", ticketId: "t1", ticketKey: "COR-1", prNumber: 5, headSha: "h0" });
    const { deps, rec } = makeDeps(s);

    expect(await runSweepJob(job, s, deps)).toBe("ready");
    const final = s.getSweepJob(job.id)!;
    expect(final.state).toBe("ready");
    expect(final.cycles).toBe(0);
    expect(rec.spawns.length).toBe(0);
    expect(rec.reviews).toBe(1);
    const events = s.listSweepEvents(job.id).map((e) => e.event);
    expect(events).toContain("gate_eval");
    expect(events).toContain("spawn"); // the reviewer
    expect(events.at(-1)).toBe("state_change");
  });

  test("in_review: reviewer red → one fix cycle → clean → ready; session_id follows the live agent", async () => {
    const s = new Store(":memory:");
    const job = s.createSweepJob({ kind: "in_review", ticketId: "t2", ticketKey: "COR-2", prNumber: 6, headSha: "h0" });
    const { deps, rec } = makeDeps(s, { review: (n) => (n === 1 ? redReview() : cleanReview()) });

    expect(await runSweepJob(job, s, deps)).toBe("ready");
    const final = s.getSweepJob(job.id)!;
    expect(final.cycles).toBe(1);
    expect(rec.spawns.length).toBe(1);
    expect(rec.reviews).toBe(2);
    expect(rec.spawns[0]!.blockers).toContain("reviewer-red");
    expect(rec.spawns[0]!.review?.redFindings).toBe(2); // the fixer gets the findings to address
    expect(final.sessionId).toBe(rec.sessions.at(-1)); // last agent to touch it (the 2nd reviewer)
  });

  test("CI failing is fixed before any review runs", async () => {
    const s = new Store(":memory:");
    const job = s.createSweepJob({ kind: "in_review", ticketId: "t3", ticketKey: "COR-3", prNumber: 7, headSha: "h0" });
    const { deps, rec } = makeDeps(s, {
      poll: (n) => (n === 1 ? { checks: { ci: "failure", "secrets-scan": "success" }, changedPaths: ["src/ui/x.ts"] } : CLEAN_POLL),
    });

    expect(await runSweepJob(job, s, deps)).toBe("ready");
    expect(rec.spawns.length).toBe(1);
    expect(rec.spawns[0]!.blockers).toContain("ci-failing");
    expect(s.getSweepJob(job.id)!.cycles).toBe(1);
  });

  test("the 8-cycle cap ends a never-passing job as needs_human", async () => {
    const s = new Store(":memory:");
    const job = s.createSweepJob({ kind: "in_review", ticketId: "t4", ticketKey: "COR-4", prNumber: 8, headSha: "h0" });
    const { deps, rec } = makeDeps(s, { review: () => redReview() }); // never clean

    expect(await runSweepJob(job, s, deps)).toBe("needs_human");
    const final = s.getSweepJob(job.id)!;
    expect(final.cycles).toBe(MAX_CYCLES);
    expect(rec.spawns.length).toBe(MAX_CYCLES);
    expect(final.reason).toContain("8-cycle cap");
  });

  test("a dangerous tier escalates to the human immediately — before spending a fix or review", async () => {
    const s = new Store(":memory:");
    const job = s.createSweepJob({ kind: "in_review", ticketId: "t5", ticketKey: "COR-5", prNumber: 9, headSha: "h0" });
    const { deps, rec } = makeDeps(s, {
      poll: () => ({ checks: { ci: "success", "secrets-scan": "success" }, changedPaths: ["src/auth/login.ts"] }),
    });

    expect(await runSweepJob(job, s, deps)).toBe("needs_human");
    expect(s.getSweepJob(job.id)!.reason).toContain("dangerous tier: auth");
    expect(rec.spawns.length).toBe(0);
    expect(rec.reviews).toBe(0);
  });

  test("rescue: bootstraps by building a PR, then runs the same gate to ready", async () => {
    const s = new Store(":memory:");
    const job = s.createSweepJob({ kind: "rescue", ticketId: "t6", ticketKey: "COR-6" }); // no PR yet
    const { deps, rec } = makeDeps(s);

    expect(await runSweepJob(job, s, deps)).toBe("ready");
    const final = s.getSweepJob(job.id)!;
    expect(final.cycles).toBe(1);
    expect(final.prNumber).toBe(5);
    expect(rec.spawns.length).toBe(1);
    expect(rec.spawns[0]!.initial).toBe(true); // the implement bootstrap
    expect(s.listSweepEvents(job.id).map((e) => e.event)).toContain("pr_open");
  });

  test("a failing dep ends the job as failed with an error event", async () => {
    const s = new Store(":memory:");
    const job = s.createSweepJob({ kind: "rescue", ticketId: "t7", ticketKey: "COR-7" });
    const { deps } = makeDeps(s, { worker: () => { throw new Error("spawn boom"); } });

    expect(await runSweepJob(job, s, deps)).toBe("failed");
    const final = s.getSweepJob(job.id)!;
    expect(final.state).toBe("failed");
    expect(final.reason).toContain("spawn boom");
    expect(s.listSweepEvents(job.id).map((e) => e.event)).toContain("error");
  });

  test("a judgment-call verdict from the reviewer escalates with its reason", async () => {
    const s = new Store(":memory:");
    const job = s.createSweepJob({ kind: "in_review", ticketId: "t8", ticketKey: "COR-8", prNumber: 10, headSha: "h0" });
    const { deps, rec } = makeDeps(s, {
      review: () => ({ redFindings: 0, preservationProven: true, judgmentCall: "which rounding rule?" }),
    });

    expect(await runSweepJob(job, s, deps)).toBe("needs_human");
    expect(s.getSweepJob(job.id)!.reason).toContain("judgment call: which rounding rule?");
    expect(rec.spawns.length).toBe(0); // escalated after the review, no fix attempted
    expect(rec.reviews).toBe(1);
  });
});
