import { test, expect, describe } from "bun:test";
import { checkGates, createActuator, type GateDeps } from "../src/daemon/autonomy/actuator.ts";
import { nudgeKey } from "../src/daemon/autonomy/keys.ts";
import type { AutonomyConfig } from "../src/daemon/autonomy/config.ts";
import { Store } from "../src/daemon/store.ts";
import type { PolicyResult } from "../src/daemon/autonomy/policy.ts";
import type { NudgeDelivery } from "../src/daemon/nudge/index.ts";
import type { WorkItem, Session, AutonomyDecision } from "../src/shared/types.ts";

const ALL: AutonomyDecision[] = [
  "nudge-agent", "request-codex", "request-cto", "cto-review-delay-nudge", "cto-followups",
  "thermo-regrade", "review-bot-followups", "cto-review-followups",
];
const config = (): AutonomyConfig =>
  ({ enabled: true, actions: new Set(ALL), dryRun: false, always: true, sessions: null, locations: null });

function item(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "w", sessionId: "s", kind: "pr", externalKey: "o/r#1", repo: "o/r", number: 1, url: null, title: null,
    branch: null, lifecycle: "active", prState: "OPEN", isDraft: false, ciState: "failure", failedChecks: ["b"],
    reviewState: null, mergeable: "MERGEABLE", headSha: "h", headCommittedAt: 0, headObservedAt: 0,
    codexState: "none", codexReviewedSha: null, ctoState: "none", ctoReviewedAt: null, ctoReviewedSha: null,
    reviewBotState: "none", reviewBotAt: null, thermoGrade: null, thermoCycles: 0, greenlightState: "absent",
    unresolvedComments: 0, operatorAckedAt: null, outstandingReviewerTags: [], tickets: [], source: "auto",
    createdAt: 0, updatedAt: 0, remoteUpdatedAt: null, retiredAt: null, lastPolledAt: 0, ...over,
  };
}
const session = (over: Partial<Session> = {}): Session => ({
  id: "s", taskId: "t", title: "", tool: "claude", location: "local", cwd: "/x", usesWorktree: false,
  worktreePath: null, model: "auto", permissions: "ask", effort: null, resumeHandle: null, tmuxSession: null,
  closed: false, createdAt: 0, closedAt: null, worktreeBranch: null, profileId: "legacy",
  codexTranscriptPath: null, codexSessionId: null, planning: false, draftMayBeStranded: false, ...over,
});

const IT = item();
const RESULT: PolicyResult = { decision: "nudge-agent", dedupeKey: nudgeKey(IT), message: "fix it", reason: "fault" };

function gd(store: Store, over: Partial<GateDeps> = {}): GateDeps {
  return { now: Date.now(), config: config(), store, killed: false, withinWindowNow: true,
    ownsSession: true, queueFull: false, stillJustified: true, ...over };
}

describe("checkGates order (design §13.5)", () => {
  test("all pass -> deliver", () => {
    expect(checkGates(RESULT, session(), IT, gd(new Store(":memory:"))).outcome).toBe("deliver");
  });
  test("gate 1 disabled (config off or killed)", () => {
    expect(checkGates(RESULT, session(), IT, gd(new Store(":memory:"), { config: { ...config(), enabled: false } }))).toEqual({ outcome: "blocked", gate: "disabled" });
    expect(checkGates(RESULT, session(), IT, gd(new Store(":memory:"), { killed: true }))).toEqual({ outcome: "blocked", gate: "disabled" });
  });
  test("gate 2 outside-window (only when not always)", () => {
    const c = { ...config(), always: false };
    expect(checkGates(RESULT, session(), IT, gd(new Store(":memory:"), { config: c, withinWindowNow: false }))).toEqual({ outcome: "blocked", gate: "outside-window" });
  });
  test("gate 3 not-my-host", () => {
    expect(checkGates(RESULT, session(), IT, gd(new Store(":memory:"), { ownsSession: false }))).toEqual({ outcome: "blocked", gate: "not-my-host" });
  });
  test("gate 4 not-allowed", () => {
    const c = { ...config(), actions: new Set<AutonomyDecision>(["request-codex"]) };
    expect(checkGates(RESULT, session(), IT, gd(new Store(":memory:"), { config: c }))).toEqual({ outcome: "blocked", gate: "not-allowed" });
  });
  test("gate 6 session-planning", () => {
    expect(checkGates(RESULT, session({ planning: true }), IT, gd(new Store(":memory:")))).toEqual({ outcome: "blocked", gate: "session-planning" });
  });
  test("gate 7 already-attempted (>=2 failures)", () => {
    const s = new Store(":memory:");
    s.recordAction({ action: "nudge-agent", dedupeKey: RESULT.dedupeKey, status: "failed" });
    s.recordAction({ action: "nudge-agent", dedupeKey: RESULT.dedupeKey, status: "failed" });
    expect(checkGates(RESULT, session(), IT, gd(s))).toEqual({ outcome: "blocked", gate: "already-attempted" });
  });
  test("gate 8 duplicate (a terminal row exists)", () => {
    const s = new Store(":memory:");
    s.recordAction({ action: "nudge-agent", dedupeKey: RESULT.dedupeKey, status: "queued" });
    expect(checkGates(RESULT, session(), IT, gd(s))).toEqual({ outcome: "blocked", gate: "duplicate" });
  });
  test("gate 9 cooldown (same PR+action, different state key)", () => {
    const s = new Store(":memory:");
    s.recordAction({ action: "nudge-agent", dedupeKey: nudgeKey(item({ ciState: "success", failedChecks: [] })), status: "performed" });
    expect(checkGates(RESULT, session(), IT, gd(s))).toEqual({ outcome: "blocked", gate: "cooldown" });
  });
  test("gate 10 global rate limit (>=12/hr)", () => {
    const s = new Store(":memory:");
    for (let i = 0; i < 12; i++) s.recordAction({ action: "request-codex", dedupeKey: `request-codex:o/z#${i}:h`, status: "performed" });
    expect(checkGates(RESULT, session(), IT, gd(s))).toEqual({ outcome: "blocked", gate: "rate-global" });
  });
  test("gate 15 dry-run", () => {
    expect(checkGates(RESULT, session(), IT, gd(new Store(":memory:"), { config: { ...config(), dryRun: true } })).outcome).toBe("dry-run");
  });
});

describe("actuator.act records the audit row (design §13.5)", () => {
  const fakeNudge = (sink: unknown[]): NudgeDelivery =>
    ({ enqueue: (r) => { sink.push(r); return "queued"; }, clearAutonomous() {}, forget() {}, stop() {} });

  // Seed real task/session/work-item rows so the audit-log foreign keys are satisfiable.
  function seed(s: Store, planning = false) {
    const task = s.createTask({ name: "t" });
    const sess = s.createSession({ taskId: task.id, tool: "claude", location: "local", cwd: "/x" });
    if (planning) s.updateSession(sess.id, { planning: true });
    const wi = s.upsertWorkItem({ sessionId: sess.id, kind: "pr", externalKey: "o/r#1", number: 1, repo: "o/r",
      ciState: "failure", failedChecks: ["b"], mergeable: "MERGEABLE", headSha: "h" });
    const result: PolicyResult = { decision: "nudge-agent", dedupeKey: nudgeKey(wi), message: "fix it", reason: "fault" };
    const ctx = { item: wi, session: s.getSession(sess.id)!, repo: "o/r", ownsSession: true, killed: false, withinWindowNow: true, queueFull: false, stillJustified: true };
    return { wi, result, ctx };
  }

  test("a nudge is queued and recorded", async () => {
    const s = new Store(":memory:");
    const { result, ctx } = seed(s);
    const enq: unknown[] = [];
    await createActuator({ config: config(), store: s, nudge: fakeNudge(enq) }).act(result, ctx);
    expect(enq.length).toBe(1);
    expect(s.getAction(result.dedupeKey)!.status).toBe("queued");
  });

  test("dry-run records dry-run and does not enqueue", async () => {
    const s = new Store(":memory:");
    const { result, ctx } = seed(s);
    const enq: unknown[] = [];
    await createActuator({ config: { ...config(), dryRun: true }, store: s, nudge: fakeNudge(enq) }).act(result, ctx);
    expect(enq.length).toBe(0);
    expect(s.getAction(result.dedupeKey)!.status).toBe("dry-run");
  });

  test("a blocked decision records suppressed with the gate", async () => {
    const s = new Store(":memory:");
    const { result, ctx } = seed(s, true); // planning
    const enq: unknown[] = [];
    await createActuator({ config: config(), store: s, nudge: fakeNudge(enq) }).act(result, ctx);
    expect(enq.length).toBe(0);
    const row = s.getAction(result.dedupeKey)!;
    expect(row.status).toBe("suppressed");
    expect(row.gate).toBe("session-planning");
  });
});
