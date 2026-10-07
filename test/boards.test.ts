import { test, expect, describe } from "bun:test";
import { unblockedIssues, doNext, downstreamCounts, isUnblocked } from "../src/shared/boards.ts";
import type { LinearIssue } from "../src/shared/types.ts";

type Issue = Pick<LinearIssue, "id" | "identifier" | "title" | "stateType" | "blockedBy">;
const iss = (id: string, over: Partial<Issue> = {}): Issue => ({
  id, identifier: id.toUpperCase(), title: `t-${id}`, stateType: "unstarted", blockedBy: [], ...over,
});
const byId = (issues: Issue[]) => new Map(issues.map((i) => [i.id, i]));

describe("isUnblocked / unblockedIssues (PRD §7a)", () => {
  test("terminal tickets are never actionable", () => {
    expect(isUnblocked(iss("a", { stateType: "completed" }), byId([]))).toBe(false);
    expect(isUnblocked(iss("a", { stateType: "canceled" }), byId([]))).toBe(false);
  });

  test("a known open blocker blocks; a terminal one does not", () => {
    const open = iss("b", { stateType: "started" });
    const done = iss("b", { stateType: "completed" });
    expect(isUnblocked(iss("a", { blockedBy: ["b"] }), byId([iss("a"), open]))).toBe(false);
    expect(isUnblocked(iss("a", { blockedBy: ["b"] }), byId([iss("a"), done]))).toBe(true);
  });

  test("an unknown/external blocker (not synced) does not hide the ticket", () => {
    expect(isUnblocked(iss("a", { blockedBy: ["external"] }), byId([iss("a")]))).toBe(true);
  });

  test("unblockedIssues returns exactly the actionable set", () => {
    const issues = [
      iss("a"), // unblocked
      iss("b", { blockedBy: ["a"] }), // blocked by open a
      iss("c", { stateType: "completed" }), // terminal
      iss("d", { blockedBy: ["c"] }), // blocked by terminal c → unblocked
    ];
    expect(unblockedIssues(issues).map((i) => i.id).sort()).toEqual(["a", "d"]);
  });
});

describe("downstreamCounts (critical path)", () => {
  test("counts transitive dependents, not just direct", () => {
    // a <- b <- c  (c blockedBy b, b blockedBy a): a unblocks {b,c}, b unblocks {c}, c unblocks {}
    const issues = [iss("a"), iss("b", { blockedBy: ["a"] }), iss("c", { blockedBy: ["b"] })];
    const counts = downstreamCounts(issues);
    expect(counts.get("a")).toBe(2);
    expect(counts.get("b")).toBe(1);
    expect(counts.get("c")).toBe(0);
  });

  test("diamond dependency is counted once", () => {
    // b,c blockedBy a; d blockedBy b and c → a unblocks {b,c,d} = 3 (d not double-counted)
    const issues = [iss("a"), iss("b", { blockedBy: ["a"] }), iss("c", { blockedBy: ["a"] }), iss("d", { blockedBy: ["b", "c"] })];
    expect(downstreamCounts(issues).get("a")).toBe(3);
  });

  test("a terminal node in the chain contributes no phantom impact", () => {
    // a(open) <- b(completed, blockedBy a) <- c(open, blockedBy b): b is done, so c is already unblocked
    // through b, and finishing a newly unblocks nothing. a's true downstream impact is 0.
    const issues = [
      iss("a"),
      iss("b", { stateType: "completed", blockedBy: ["a"] }),
      iss("c", { blockedBy: ["b"] }),
    ];
    const counts = downstreamCounts(issues);
    expect(counts.get("a")).toBe(0); // done b is neither downstream work nor a live edge to c
    expect(counts.get("b")).toBe(0); // a done ticket has no downstream
  });

  test("a dependency cycle doesn't hang or self-count", () => {
    const issues = [iss("a", { blockedBy: ["b"] }), iss("b", { blockedBy: ["a"] })];
    const counts = downstreamCounts(issues);
    expect(counts.get("a")).toBe(1); // a unblocks b (and the cycle back to a is excluded from a's own downstream)
    expect(counts.get("b")).toBe(1);
  });
});

describe("doNext (PRD §7b)", () => {
  test("ranks unblocked tickets by downstream impact, most-unblocking first", () => {
    // a unblocks b,c,d (chain); x is a standalone unblocked ticket; b is blocked by open a
    const issues = [
      iss("a"),
      iss("b", { blockedBy: ["a"] }),
      iss("c", { blockedBy: ["b"] }),
      iss("d", { blockedBy: ["c"] }),
      iss("x"),
    ];
    const ranked = doNext(issues);
    // only a and x are unblocked; a has 3 downstream, x has 0
    expect(ranked.map((e) => e.issue.id)).toEqual(["a", "x"]);
    expect(ranked[0]).toMatchObject({ downstream: 3 });
    expect(ranked[1]).toMatchObject({ downstream: 0 });
  });

  test("equal impact breaks ties by identifier (stable order)", () => {
    const ranked = doNext([iss("z"), iss("a"), iss("m")]);
    expect(ranked.map((e) => e.issue.identifier)).toEqual(["A", "M", "Z"]);
  });
});
