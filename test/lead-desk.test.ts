import { test, expect, describe } from "bun:test";
import { isLeadOps, deskOverview, DEFAULT_LEAD_OPS_PROJECT, type DeskRow } from "../src/shared/lead-desk.ts";
import type { LinearIssue } from "../src/shared/types.ts";
import type { Member } from "../src/shared/roster.ts";

const ROSTER: Member[] = [
  { name: "Tess Lee", netid: "tpl52", emails: ["tpl52@cornell.edu"], linearIds: ["u-tess"], github: "tpl52-tech", lead: true },
  { name: "Kenan Tat", netid: "ktt38", emails: ["ktt38@cornell.edu"], linearIds: ["u-kenan"], github: "Kenan-t", lead: true },
];

function issue(over: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: "id-1", identifier: "COR-1", title: "A task", stateName: "Todo", stateType: "unstarted",
    assignee: null, projectId: null, projectName: null, teamKey: "COR", url: null, priority: null,
    blockedBy: [], dueDate: null, labels: [], gitBranchName: null, updatedAt: null, ...over,
  };
}

describe("isLeadOps (PRD §9)", () => {
  test("matches the default 'Lead Ops' project; a null/other project never matches", () => {
    expect(isLeadOps(issue({ projectName: "Lead Ops" }))).toBe(true);
    expect(isLeadOps(issue({ projectName: "ReUse App" }))).toBe(false);
    expect(isLeadOps(issue({ projectName: null }))).toBe(false);
    expect(DEFAULT_LEAD_OPS_PROJECT).toBe("Lead Ops");
  });

  test("honors a configured project name (exact match)", () => {
    expect(isLeadOps(issue({ projectName: "Desk" }), "Desk")).toBe(true);
    expect(isLeadOps(issue({ projectName: "Lead Ops" }), "Desk")).toBe(false); // default no longer matches
  });
});

describe("deskOverview (PRD §9)", () => {
  test("lists only open Lead Ops issues, resolving the assignee to a roster name", () => {
    const rows = deskOverview([
      issue({ identifier: "COR-10", title: "Book the room", projectName: "Lead Ops", assignee: "u-kenan", stateName: "In Progress" }),
      issue({ identifier: "COR-11", title: "Not lead ops", projectName: "ReUse App", assignee: "u-tess" }),
      issue({ identifier: "COR-12", title: "Done desk task", projectName: "Lead Ops", stateType: "completed", stateName: "Done" }),
      issue({ identifier: "COR-13", title: "Unassigned desk task", projectName: "Lead Ops", assignee: null, stateName: "Todo" }),
    ], ROSTER);
    expect(rows.map((r) => r.ticketKey)).toEqual(["COR-10", "COR-13"]); // non-Lead-Ops + terminal excluded
    expect(rows[0]).toEqual({ ticketKey: "COR-10", title: "Book the room", assignee: "Kenan Tat", state: "In Progress" } satisfies DeskRow);
    expect(rows[1]!.assignee).toBe("unassigned");
  });

  test("falls back to the raw Linear id when the assignee isn't on the roster", () => {
    const rows = deskOverview([issue({ projectName: "Lead Ops", assignee: "u-stranger" })], ROSTER);
    expect(rows[0]!.assignee).toBe("u-stranger");
  });
});
