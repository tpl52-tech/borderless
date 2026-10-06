import { test, expect, describe } from "bun:test";
import {
  badStanding, reviewApproved, isReadyToMerge, classifyWorkItem, classifySession, prefixEq,
} from "../src/shared/focus.ts";
import { DEFAULT_REVIEW_POLICY } from "../src/shared/profile.ts";
import type { WorkItem, Session } from "../src/shared/types.ts";

const HEAD = "abc1234def";

function item(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "w1", sessionId: "s1", kind: "pr", externalKey: "o/r#1", repo: "o/r", number: 1,
    url: "u", title: "t", branch: "b", lifecycle: "active", prState: "OPEN", isDraft: false,
    ciState: "success", failedChecks: [], reviewState: null, mergeable: "MERGEABLE",
    headSha: HEAD, headCommittedAt: 800, headObservedAt: 800, codexState: "approved",
    codexReviewedSha: HEAD, ctoState: "approved", ctoReviewedAt: 900, ctoReviewedSha: HEAD,
    reviewBotState: "none", reviewBotAt: null, thermoGrade: "A", thermoCycles: 1,
    greenlightState: "converged", unresolvedComments: 0, operatorAckedAt: null,
    outstandingReviewerTags: [], tickets: [], source: "auto", createdAt: 0, updatedAt: 0,
    remoteUpdatedAt: 0, retiredAt: null, lastPolledAt: 0, ...over,
  };
}

describe("badStanding (design §14)", () => {
  test("CI failure needs a non-empty failed-check list (else it's a phantom)", () => {
    expect(badStanding(item({ ciState: "failure", failedChecks: ["build"] }))).toBe(true);
    expect(badStanding(item({ ciState: "failure", failedChecks: [] }))).toBe(false);
  });
  test("CTO changes-requested unless addressed by a newer head", () => {
    expect(badStanding(item({ ctoState: "changes-requested", ctoReviewedSha: HEAD }))).toBe(true);
    expect(badStanding(item({ ctoState: "changes-requested", ctoReviewedSha: "old9999", ciState: "success", unresolvedComments: 0 }))).toBe(false);
  });
  test("merge conflict flags; UNKNOWN stays silent", () => {
    expect(badStanding(item({ mergeable: "CONFLICTING" }))).toBe(true);
    expect(badStanding(item({ mergeable: "UNKNOWN" }))).toBe(false);
  });
  test("unresolved threads unless the PR is otherwise finished", () => {
    expect(badStanding(item({ unresolvedComments: 3, ctoState: "reviewed", codexState: "reviewed", mergeable: "MERGEABLE", ciState: "success" }))).toBe(true);
    expect(badStanding(item({ unresolvedComments: 3 }))).toBe(false); // otherwise finished (approved+mergeable+green)
  });
});

describe("reviewApproved / isReadyToMerge (design §14)", () => {
  test("reviewApproved follows the policy", () => {
    expect(reviewApproved(item({ ctoState: "approved" }), DEFAULT_REVIEW_POLICY)).toBe(true);
    expect(reviewApproved(item({ ctoState: "reviewed" }), DEFAULT_REVIEW_POLICY)).toBe(false);
    expect(reviewApproved(item({ ctoState: "reviewed", codexState: "approved" }), { codex: true, cto: false, reviewBot: true, ctoFollowups: true })).toBe(true);
  });
  test("isReadyToMerge: a clean PR is ready; caveats are not disqualifiers", () => {
    expect(isReadyToMerge(item(), DEFAULT_REVIEW_POLICY)).toBe(true);
    expect(isReadyToMerge(item({ unresolvedComments: 5 }), DEFAULT_REVIEW_POLICY)).toBe(true); // caveat
    expect(isReadyToMerge(item({ reviewBotState: "reviewed" }), DEFAULT_REVIEW_POLICY)).toBe(true); // caveat
  });
  test("isReadyToMerge disqualifiers", () => {
    expect(isReadyToMerge(item({ isDraft: true }), DEFAULT_REVIEW_POLICY)).toBe(false);
    expect(isReadyToMerge(item({ ciState: "pending" }), DEFAULT_REVIEW_POLICY)).toBe(false);
    expect(isReadyToMerge(item({ mergeable: "CONFLICTING" }), DEFAULT_REVIEW_POLICY)).toBe(false);
    expect(isReadyToMerge(item({ codexState: "requested" }), DEFAULT_REVIEW_POLICY)).toBe(false);
    expect(isReadyToMerge(item(), DEFAULT_REVIEW_POLICY, { ctoFollowupSweepPending: true })).toBe(false);
  });
});

describe("classifyWorkItem (design §14)", () => {
  const now = 10_000_000;
  test("final-ready needs acked + no tags + 0 unresolved + review bot not reviewed", () => {
    expect(classifyWorkItem(item({ operatorAckedAt: 5, reviewBotState: "none" }), now, DEFAULT_REVIEW_POLICY)).toBe("final-ready");
    expect(classifyWorkItem(item({ operatorAckedAt: null }), now, DEFAULT_REVIEW_POLICY)).toBe("ready-to-merge");
    expect(classifyWorkItem(item({ operatorAckedAt: 5, reviewBotState: "reviewed" }), now, DEFAULT_REVIEW_POLICY)).toBe("ready-to-merge");
  });
  test("bad standing -> needs-attention only after the GitHub-silence grace", () => {
    const bad = { ciState: "failure" as const, failedChecks: ["x"], remoteUpdatedAt: now - 30 * 60_000 };
    expect(classifyWorkItem(item(bad), now, DEFAULT_REVIEW_POLICY)).toBe("needs-attention");
    expect(classifyWorkItem(item({ ...bad, remoteUpdatedAt: now - 60_000 }), now, DEFAULT_REVIEW_POLICY)).toBe("in-progress");
  });
  test("waiting-review when codex/cto requested", () => {
    expect(classifyWorkItem(item({ ctoState: "requested", codexState: "reviewed" }), now, DEFAULT_REVIEW_POLICY)).toBe("waiting-review");
  });
});

describe("classifySession (design §14)", () => {
  const s = (over: Partial<Session>): Session => ({
    id: "s", taskId: "t", title: "", tool: "claude", location: "local", cwd: "/x", usesWorktree: false,
    worktreePath: null, model: "auto", permissions: "ask", effort: null, resumeHandle: null,
    tmuxSession: null, closed: false, createdAt: 0, closedAt: null, worktreeBranch: null,
    profileId: "legacy", codexTranscriptPath: null, codexSessionId: null, planning: false,
    draftMayBeStranded: false, ...over,
  });
  test("planning wins; attention states; silence threshold", () => {
    expect(classifySession(s({ planning: true, status: "working" }), 0, 600000)).toBe("planning");
    expect(classifySession(s({ status: "done" }), 0, 600000)).toBe("needs-attention");
    expect(classifySession(s({ status: "working", lastActivityAt: 1000 }), 1000, 600000)).toBe("working");
    expect(classifySession(s({ status: "working", lastActivityAt: 0 }), 700000, 600000)).toBe("needs-attention");
  });
});

describe("prefixEq", () => {
  test("needs >= 7 chars and a common prefix", () => {
    expect(prefixEq("abcdef1234", "abcdef1")).toBe(true);
    expect(prefixEq("abc", "abc")).toBe(false); // too short
    expect(prefixEq("abcdefg", "abcdefx")).toBe(false);
  });
});
