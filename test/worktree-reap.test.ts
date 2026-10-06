import { test, expect, describe } from "bun:test";
import { classifyWorktree, planReap, type ReapableSession, type WorktreeEntry } from "../src/daemon/worktree.ts";

const DAY = 24 * 60 * 60 * 1000;
const now = 1_000_000_000;
const sessions: ReapableSession[] = [
  { id: "open1234xxxx", closed: false, closedAt: null },
  { id: "recent12xxxx", closed: true, closedAt: now - 2 * DAY },
  { id: "old98765xxxx", closed: true, closedAt: now - 30 * DAY },
];

describe("classifyWorktree (design §17.6)", () => {
  test("open / too-recent / closed / orphan against a 7-day grace", () => {
    expect(classifyWorktree("open1234", sessions, now, 7)).toBe("open");
    expect(classifyWorktree("recent12", sessions, now, 7)).toBe("too-recent");
    expect(classifyWorktree("old98765", sessions, now, 7)).toBe("closed");
    expect(classifyWorktree("nomatch0", sessions, now, 7)).toBe("orphan");
  });
});

describe("planReap (design §17.6)", () => {
  test("reaps closed-past-grace and orphans; keeps open + too-recent", () => {
    const entries: WorktreeEntry[] = [
      { id8: "open1234", path: "/r/.worktrees/ao/open1234" },
      { id8: "recent12", path: "/r/.worktrees/ao/recent12" },
      { id8: "old98765", path: "/r/.worktrees/ao/old98765" },
      { id8: "orphan00", path: "/r/.worktrees/ao/orphan00" },
    ];
    const reap = planReap(entries, sessions, now, 7).map((e) => e.id8).sort();
    expect(reap).toEqual(["old98765", "orphan00"]);
  });
});
