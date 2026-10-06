import { test, expect, describe } from "bun:test";
import { dedupeKey, nudgeKey } from "../src/daemon/autonomy/keys.ts";
import type { WorkItem } from "../src/shared/types.ts";

function item(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "w", sessionId: "s", kind: "pr", externalKey: "o/r#5", repo: "o/r", number: 5, url: null,
    title: null, branch: null, lifecycle: "active", prState: "OPEN", isDraft: false, ciState: "failure",
    failedChecks: ["build"], reviewState: null, mergeable: "MERGEABLE", headSha: "abc1234", headCommittedAt: 0,
    headObservedAt: 0, codexState: "none", codexReviewedSha: null, ctoState: "none", ctoReviewedAt: 900,
    ctoReviewedSha: null, reviewBotState: "reviewed", reviewBotAt: 800, thermoGrade: null, thermoCycles: 0,
    greenlightState: "absent", unresolvedComments: 0, operatorAckedAt: null, outstandingReviewerTags: [],
    tickets: [], source: "auto", createdAt: 0, updatedAt: 0, remoteUpdatedAt: null, retiredAt: null,
    lastPolledAt: 0, ...over,
  };
}

describe("dedupe keys (design §13.5)", () => {
  test("nudge key is state-suffixed (red->green->red is a NEW event) and PR-scoped", () => {
    const red = nudgeKey(item({ ciState: "failure" }));
    const green = nudgeKey(item({ ciState: "success", failedChecks: [] }));
    expect(red).not.toBe(green);
    expect(red).toContain("o/r#5");
  });
  test("sweep keys use the review timestamp; the agent pushing is fine (review-bot uses reviewBotAt)", () => {
    expect(dedupeKey("cto-followups", item())).toBe("cto-followups:o/r#5:900");
    expect(dedupeKey("review-bot-followups", item())).toBe("review-bot-followups:o/r#5:800");
    expect(dedupeKey("cto-review-followups", item())).toBe("cto-review-followups:o/r#5:900");
  });
  test("request-* default to <action>:<PR>:<headSha>", () => {
    expect(dedupeKey("request-codex", item())).toBe("request-codex:o/r#5:abc1234");
    expect(dedupeKey("cto-review-delay-nudge", item())).toBe("cto-review-delay-nudge:o/r#5:abc1234");
  });
});
