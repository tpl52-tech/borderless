import { test, expect, describe } from "bun:test";
import { rescueEligibility, daysOverdue, type RescueContext } from "../src/shared/rescue.ts";
import type { LinearIssue } from "../src/shared/types.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-06T00:00:00.000Z");

type Issue = Pick<LinearIssue, "dueDate" | "labels" | "assignee" | "stateType" | "projectName">;
const issue = (over: Partial<Issue> = {}): Issue => ({
  dueDate: NOW - 3 * DAY, labels: [], assignee: "user-1", stateType: "unstarted", projectName: null, ...over,
});
const ctx = (over: Partial<RescueContext> = {}): RescueContext => ({
  now: NOW, hasProgress: false, isRosterMember: true, ...over,
});

describe("rescueEligibility (PRD §5)", () => {
  test("all conditions met → eligible, no reasons", () => {
    expect(rescueEligibility(issue(), ctx())).toEqual({ eligible: true, reasons: [] });
  });

  test("overdue only once the due day has fully elapsed (PRD §5 'passed')", () => {
    // due today (00:00 UTC): still not overdue partway through the day...
    expect(rescueEligibility(issue({ dueDate: NOW }), ctx({ now: NOW + 14 * 3_600_000 })).reasons).toContain("not overdue");
    // ...overdue only after a full day has elapsed
    expect(rescueEligibility(issue({ dueDate: NOW }), ctx({ now: NOW + DAY })).reasons).not.toContain("not overdue");
    // a future due date is not overdue
    expect(rescueEligibility(issue({ dueDate: NOW + DAY }), ctx()).reasons).toContain("not overdue");
  });

  test("a ticket with no due date is reported distinctly (not 'not overdue')", () => {
    const r = rescueEligibility(issue({ dueDate: null }), ctx());
    expect(r.reasons).toContain("no due date");
    expect(r.reasons).not.toContain("not overdue");
  });

  test("lead-level tickets are never rescued", () => {
    expect(rescueEligibility(issue({ labels: ["intermediate", "lead-level"] }), ctx()).reasons).toContain("lead-level");
  });

  test("lead-desk (Lead Ops) tickets are never rescued (PRD §9)", () => {
    expect(rescueEligibility(issue({ projectName: "Lead Ops" }), ctx()).reasons).toContain("lead-ops");
    expect(rescueEligibility(issue({ projectName: "ReUse App" }), ctx()).reasons).not.toContain("lead-ops");
    // honors a configured override name
    expect(rescueEligibility(issue({ projectName: "Desk" }), ctx({ leadOpsProject: "Desk" })).reasons).toContain("lead-ops");
  });

  test("meaningful progress blocks (somebody started it)", () => {
    expect(rescueEligibility(issue(), ctx({ hasProgress: true })).reasons).toContain("has progress");
  });

  test("assignee must be a roster member (and present)", () => {
    expect(rescueEligibility(issue(), ctx({ isRosterMember: false })).reasons).toContain("assignee not a roster member");
    expect(rescueEligibility(issue({ assignee: null }), ctx()).reasons).toContain("assignee not a roster member");
  });

  test("already done/canceled tickets are not rescue candidates", () => {
    expect(rescueEligibility(issue({ stateType: "completed" }), ctx()).reasons).toContain("already done/canceled");
    expect(rescueEligibility(issue({ stateType: "canceled" }), ctx()).reasons).toContain("already done/canceled");
  });

  test("collects every failing reason at once", () => {
    const r = rescueEligibility(
      issue({ dueDate: NOW + DAY, labels: ["lead-level"], assignee: null, stateType: "completed" }),
      ctx({ hasProgress: true, isRosterMember: false }),
    );
    expect(r.eligible).toBe(false);
    expect(r.reasons.sort()).toEqual(
      ["already done/canceled", "assignee not a roster member", "has progress", "lead-level", "not overdue"].sort(),
    );
  });
});

describe("daysOverdue", () => {
  test("whole days since the due date, floored, never negative", () => {
    expect(daysOverdue(NOW - 3 * DAY, NOW)).toBe(3);
    expect(daysOverdue(NOW - Math.floor(2.9 * DAY), NOW)).toBe(2);
    expect(daysOverdue(NOW + DAY, NOW)).toBe(0); // not overdue → 0, not negative
  });
});
