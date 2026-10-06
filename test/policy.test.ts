import { test, expect, describe } from "bun:test";
import { decide, type PolicyInputs, type AgentActivity } from "../src/daemon/autonomy/policy.ts";
import { DEFAULT_REVIEW_POLICY } from "../src/shared/profile.ts";
import type { WorkItem, Session } from "../src/shared/types.ts";

const HEAD = "abc1234def";

function item(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "w", sessionId: "s", kind: "pr", externalKey: "o/r#1", repo: "o/r", number: 1, url: "u", title: "t",
    branch: "b", lifecycle: "active", prState: "OPEN", isDraft: false, ciState: "success", failedChecks: [],
    reviewState: null, mergeable: "MERGEABLE", headSha: HEAD, headCommittedAt: 800, headObservedAt: 800,
    codexState: "approved", codexReviewedSha: HEAD, ctoState: "approved", ctoReviewedAt: 900, ctoReviewedSha: HEAD,
    reviewBotState: "none", reviewBotAt: null, thermoGrade: "A", thermoCycles: 0, greenlightState: "converged",
    unresolvedComments: 0, operatorAckedAt: null, outstandingReviewerTags: [], tickets: [], source: "auto",
    createdAt: 0, updatedAt: 0, remoteUpdatedAt: 0, retiredAt: null, lastPolledAt: 0, ...over,
  };
}

const session: Session = {
  id: "s", taskId: "t", title: "", tool: "claude", location: "local", cwd: "/x", usesWorktree: false,
  worktreePath: null, model: "auto", permissions: "full-access", effort: null, resumeHandle: null,
  tmuxSession: null, closed: false, createdAt: 0, closedAt: null, worktreeBranch: null, profileId: "legacy",
  codexTranscriptPath: null, codexSessionId: null, planning: false, draftMayBeStranded: false,
};

const activity = (o: Partial<AgentActivity> = {}): AgentActivity =>
  ({ fidelity: "inferred", state: "idle", endedWithQuestion: false, statusSince: 0, handlingThisPr: false, ...o });

function inputs(over: Partial<PolicyInputs> = {}): PolicyInputs {
  return {
    now: 10_000_000, item: item(), session, reviewPolicy: DEFAULT_REVIEW_POLICY, activity: activity(),
    changes: { ciToFailure: false, ctoToChanges: false, ctoToCommentedAfterApproval: false,
      newCtoReviewTimestamp: false, unresolvedRising: false, mergeableToConflicting: false },
    handover: { reviewBotHandedOver: false, ctoReviewHandedOver: false, ctoFollowupSwept: false, attemptedRecently: () => false },
    ctoLogin: "reviewer", ctoReviewDelayNudgeMinutes: 15, badStateSince: null, ...over,
  };
}

describe("policy rule table (design §13.4)", () => {
  test("rule 1: draft -> none", () => {
    expect(decide(inputs({ item: item({ isDraft: true }) })).decision).toBe("none");
  });

  test("rule 0: agent unknown + a bad transition -> alert; unknown + nothing -> none", () => {
    const bad = { ciToFailure: true, ctoToChanges: false, ctoToCommentedAfterApproval: false, newCtoReviewTimestamp: false, unresolvedRising: false, mergeableToConflicting: false };
    expect(decide(inputs({ activity: activity({ state: "unknown" }), changes: bad })).decision).toBe("alert-human");
    expect(decide(inputs({ activity: activity({ state: "unknown" }) })).decision).toBe("none");
  });

  test("rule 1.5: a posted code-quality review hands over before fault rules", () => {
    const r = decide(inputs({ item: item({ reviewBotState: "reviewed", reviewBotAt: 800, ctoState: "none", codexState: "none" }) }));
    expect(r.decision).toBe("review-bot-followups");
  });

  test("rule 1.7: a fresh CTO approval sweeps (before ready-to-merge)", () => {
    expect(decide(inputs()).decision).toBe("cto-followups");
  });

  test("rule 2/3/4: CI failure with an idle agent -> nudge; a handling agent suppresses it", () => {
    const failing = item({ ciState: "failure", failedChecks: ["build"], ctoState: "none", codexState: "none" });
    const changes = { ciToFailure: true, ctoToChanges: false, ctoToCommentedAfterApproval: false, newCtoReviewTimestamp: false, unresolvedRising: false, mergeableToConflicting: false };
    const nudged = decide(inputs({ item: failing, changes }));
    expect(nudged.decision).toBe("nudge-agent");
    expect(nudged.message).toContain("CI is failing");
    const handled = decide(inputs({ item: failing, changes, activity: activity({ state: "busy", handlingThisPr: true }) }));
    expect(handled.decision).toBe("none");
  });

  test("rule 5.5: CI green but grade != A -> thermo-regrade", () => {
    const r = decide(inputs({ item: item({ thermoGrade: "C", ctoState: "none", codexState: "none" }) }));
    expect(r.decision).toBe("thermo-regrade");
  });

  test("rule 6: never-asked codex on a green PR -> request-codex", () => {
    const r = decide(inputs({ item: item({ codexState: "none", codexReviewedSha: null, ctoState: "none", thermoGrade: "A" }) }));
    expect(r.decision).toBe("request-codex");
  });

  test("rule 7: a fully-approved, already-swept PR is ready to merge", () => {
    const r = decide(inputs({ handover: { reviewBotHandedOver: false, ctoReviewHandedOver: false, ctoFollowupSwept: true, attemptedRecently: () => false } }));
    expect(r.decision).toBe("alert-human");
    expect(r.reason).toBe("ready to merge");
  });
});
