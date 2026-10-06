import { test, expect, describe } from "bun:test";
import { Store } from "../src/daemon/store.ts";
import { scanRescues, authorizeRescue, type RescueScanDeps } from "../src/daemon/rescue-scan.ts";
import type { LinearIssue } from "../src/shared/types.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-06T00:00:00.000Z");

// Seed a synced linear issue. Overdue + roster assignee + unstarted by default (an eligible shape).
function seed(s: Store, over: Partial<Parameters<Store["upsertLinearIssue"]>[0]> = {}): void {
  s.upsertLinearIssue({
    id: `lin-${over.identifier ?? "x"}`, identifier: "COR-X",
    dueDate: NOW - 3 * DAY, labels: [], assignee: "member-1", stateType: "unstarted", ...over,
  });
}

const deps = (over: Partial<RescueScanDeps> = {}): RescueScanDeps => ({
  now: NOW,
  checkProgress: async () => false,
  isRosterMember: (id) => id === "member-1",
  ...over,
});

describe("scanRescues (PRD §5 Rescues queue)", () => {
  test("returns only eligible tickets, most-overdue first", async () => {
    const s = new Store(":memory:");
    seed(s, { identifier: "COR-1", dueDate: NOW - 2 * DAY });            // eligible
    seed(s, { identifier: "COR-2", dueDate: NOW - 9 * DAY });            // eligible, more overdue
    seed(s, { identifier: "COR-3", labels: ["lead-level"] });           // excluded: lead-level
    seed(s, { identifier: "COR-4", dueDate: NOW + DAY });               // excluded: not overdue
    seed(s, { identifier: "COR-5", assignee: "stranger" });            // excluded: not a roster member

    const candidates = await scanRescues(s, deps());
    expect(candidates.map((c) => c.issue.identifier)).toEqual(["COR-2", "COR-1"]); // sorted by daysOverdue desc
    expect(candidates[0]!.daysOverdue).toBe(9);
  });

  test("excludes tickets with live progress, and only pays for the progress check when otherwise eligible", async () => {
    const s = new Store(":memory:");
    seed(s, { identifier: "COR-1" });                        // eligible, no progress
    seed(s, { identifier: "COR-5" });                        // eligible shape, but has progress
    seed(s, { identifier: "COR-lead", labels: ["lead-level"] }); // ineligible without a progress check

    const probed: string[] = [];
    const candidates = await scanRescues(s, deps({
      checkProgress: async (issue) => { probed.push(issue.identifier); return issue.identifier === "COR-5"; },
    }));

    expect(candidates.map((c) => c.issue.identifier)).toEqual(["COR-1"]);
    expect(probed.sort()).toEqual(["COR-1", "COR-5"]); // the lead-level ticket never hit the live check
  });
});

describe("authorizeRescue (PRD §5 per-ticket authorization)", () => {
  test("creates a rescue job for the ticket (by id or identifier), keeping the late assignee for context", () => {
    const s = new Store(":memory:");
    s.upsertLinearIssue({ id: "lin-1", identifier: "COR-1", assignee: "late-dev" });

    const first = authorizeRescue(s, "lin-1");
    expect(first.created).toBe(true);
    expect(first.job.kind).toBe("rescue");
    expect(first.job.ticketKey).toBe("COR-1");
    expect(first.job.assignee).toBe("late-dev"); // kept for context (attribution to the lead is at PR/comment time)

    // idempotent: authorizing again (by identifier this time) returns the same active job, no duplicate
    const again = authorizeRescue(s, "COR-1");
    expect(again.created).toBe(false);
    expect(again.job.id).toBe(first.job.id);
    expect(s.listSweepJobs({ kind: "rescue" })).toHaveLength(1);
  });

  test("a terminal rescue lets a fresh one be authorized", () => {
    const s = new Store(":memory:");
    s.upsertLinearIssue({ id: "lin-2", identifier: "COR-2" });
    const a = authorizeRescue(s, "lin-2");
    s.transitionSweepJob(a.job.id, { state: "merged" });
    expect(authorizeRescue(s, "lin-2").created).toBe(true); // prior one is terminal → new rescue allowed
  });

  test("throws on an unknown ticket", () => {
    const s = new Store(":memory:");
    expect(() => authorizeRescue(s, "nope")).toThrow();
  });
});
