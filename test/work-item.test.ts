import { test, expect, describe } from "bun:test";
import { retirementDecision, parsePrRef, RETIRE_GRACE_MS } from "../src/daemon/monitors/work-item.ts";
import { Store } from "../src/daemon/store.ts";
import {
  splitRepo, prListArgs, prDetailArgs, mergeArgs, commentArgs, requestReviewerArgs,
} from "../src/daemon/github.ts";
import type { WorkItem } from "../src/shared/types.ts";

function wi(over: Partial<WorkItem>): WorkItem {
  return {
    id: "w", sessionId: "s", kind: "pr", externalKey: "o/r#1", repo: "o/r", number: 1, url: null,
    title: null, branch: null, lifecycle: "active", prState: "OPEN", isDraft: false, ciState: null,
    failedChecks: [], reviewState: null, mergeable: null, headSha: null, headCommittedAt: null,
    headObservedAt: null, codexState: null, codexReviewedSha: null, ctoState: null, ctoReviewedAt: null,
    ctoReviewedSha: null, reviewBotState: null, reviewBotAt: null, thermoGrade: null, thermoCycles: 0,
    greenlightState: "absent", unresolvedComments: 0, operatorAckedAt: null, outstandingReviewerTags: [],
    tickets: [], source: "auto", createdAt: 0, updatedAt: 0, remoteUpdatedAt: null, retiredAt: null,
    lastPolledAt: 0, ...over,
  };
}

describe("retirementDecision (design §12.2)", () => {
  const now = 1_000_000_000;
  test("MERGED (any source) -> retiring; CLOSED auto -> retiring; CLOSED manual -> stays", () => {
    expect(retirementDecision(wi({ prState: "MERGED" }), now)).toBe("retiring");
    expect(retirementDecision(wi({ prState: "CLOSED", source: "auto" }), now)).toBe("retiring");
    expect(retirementDecision(wi({ prState: "CLOSED", source: "manual" }), now)).toBeNull();
    expect(retirementDecision(wi({ prState: "OPEN" }), now)).toBeNull();
  });
  test("retiring -> retired only after the 10-min grace", () => {
    expect(retirementDecision(wi({ lifecycle: "retiring", retiredAt: now - RETIRE_GRACE_MS }), now)).toBe("retired");
    expect(retirementDecision(wi({ lifecycle: "retiring", retiredAt: now - 1000 }), now)).toBeNull();
  });
});

describe("parsePrRef (design §12.2)", () => {
  test("PR URL, #N, bare number, junk", () => {
    expect(parsePrRef("https://github.com/o/r/pull/42")).toBe(42);
    expect(parsePrRef("#7")).toBe(7);
    expect(parsePrRef("13")).toBe(13);
    expect(parsePrRef("not-a-pr")).toBeNull();
  });
});

describe("work_items store (design §6)", () => {
  test("upsert inserts then updates; head_observed_at moves only when head_sha changes", async () => {
    const s = new Store(":memory:");
    const task = s.createTask({ name: "t" });
    const sess = s.createSession({ taskId: task.id, tool: "claude", location: "local", cwd: "/x" });

    const a = s.upsertWorkItem({ sessionId: sess.id, kind: "pr", externalKey: "o/r#1", number: 1, headSha: "abc1234xyz", ciState: "pending" });
    expect(a.number).toBe(1);
    expect(a.ciState).toBe("pending");
    const firstObserved = a.headObservedAt;
    expect(firstObserved).not.toBeNull();

    await Bun.sleep(3);
    const b = s.upsertWorkItem({ sessionId: sess.id, kind: "pr", externalKey: "o/r#1", headSha: "abc1234xyz", ciState: "success" });
    expect(b.ciState).toBe("success");
    expect(b.headObservedAt).toBe(firstObserved!); // same head -> unchanged

    const c = s.upsertWorkItem({ sessionId: sess.id, kind: "pr", externalKey: "o/r#1", headSha: "NEWsha9999" });
    expect(c.headObservedAt).not.toBe(firstObserved!); // new head -> moved

    expect(s.listWorkItemsBySession(sess.id).length).toBe(1);
    s.setWorkItemLifecycle(c.id, "retired", Date.now());
    expect(s.listWorkItemsBySession(sess.id).length).toBe(0);
    expect(s.listWorkItemsBySession(sess.id, true).length).toBe(1);
  });

  test("siblingsOf spans every session that touched an external_key", () => {
    const s = new Store(":memory:");
    const task = s.createTask({ name: "t" });
    const a = s.createSession({ taskId: task.id, tool: "claude", location: "local", cwd: "/x" });
    const b = s.createSession({ taskId: task.id, tool: "codex", location: "local", cwd: "/y" });
    s.upsertWorkItem({ sessionId: a.id, kind: "pr", externalKey: "o/r#9" });
    s.upsertWorkItem({ sessionId: b.id, kind: "pr", externalKey: "o/r#9" });
    expect(s.siblingsOf("o/r#9").length).toBe(2);
  });
});

describe("github command builders (design §12.3, §12.5)", () => {
  test("splitRepo", () => {
    expect(splitRepo("owner/name")).toEqual({ owner: "owner", name: "name" });
    expect(() => splitRepo("bad")).toThrow(/invalid repo/);
  });
  test("prListArgs / prDetailArgs carry the identifiers", () => {
    const list = prListArgs("o/r", "me/HOS-1");
    expect(list).toContain("--head"); expect(list).toContain("me/HOS-1"); expect(list).toContain("o/r");
    const detail = prDetailArgs("o/r", 5);
    expect(detail).toContain("graphql");
    expect(detail).toContain("owner=o"); expect(detail).toContain("name=r"); expect(detail).toContain("number=5");
  });
  test("action builders", () => {
    expect(mergeArgs("o/r", 3)).toContain("--squash");
    expect(commentArgs("o/r", 3, "hi")).toContain("hi");
    expect(requestReviewerArgs("o/r", 3, "rev")).toContain("--add-reviewer");
  });
});
