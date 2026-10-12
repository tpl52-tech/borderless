import { test, expect, describe } from "bun:test";
import { coLeadLoadRows, delegatedRows, epicRows, deskBoard, DELEGATED_LABEL } from "../src/shared/lead-desk.ts";
import type { LinearIssue } from "../src/shared/types.ts";
import type { Member } from "../src/shared/roster.ts";

const iss = (over: Partial<LinearIssue>): LinearIssue => ({
  id: "i", identifier: "COR-1", title: "T", description: null,
  stateName: "In Progress", stateType: "started", assignee: null,
  projectId: null, projectName: null, teamKey: "COR", url: null, priority: null,
  blockedBy: [], dueDate: null, labels: [], parentId: null, gitBranchName: null, updatedAt: null,
  ...over,
});

const ROSTER: Member[] = [
  { name: "Tess Lee", netid: "tpl52", emails: [], linearIds: ["tess"], github: "tpl52-tech", lead: true },
  { name: "Kenan Tat", netid: "ktt38", emails: [], linearIds: ["kenan"], github: "Kenan-t", lead: true },
  { name: "Neha B", netid: "nb644", emails: [], linearIds: ["neha-a", "neha-b"], github: "nehab", lead: true },
  { name: "Dana Ryu", netid: "er559", emails: [], linearIds: ["dana"], github: "danar" }, // not a lead
];

describe("coLeadLoadRows", () => {
  test("co-leads = leads minus the current lead (by github); open + blocked span all their linearIds", () => {
    const issues = [
      iss({ id: "1", assignee: "kenan" }),                          // Kenan open
      iss({ id: "2", assignee: "kenan", blockedBy: ["x"] }),        // Kenan open + blocked
      iss({ id: "3", assignee: "kenan", stateType: "completed" }),  // terminal → not counted
      iss({ id: "4", assignee: "neha-b" }),                         // Neha (2nd linear id) open
      iss({ id: "5", assignee: "tess" }),                           // the current lead → excluded
      iss({ id: "6", assignee: "dana" }),                           // not a lead → not a co-lead
    ];
    expect(coLeadLoadRows(issues, ROSTER, "tpl52-tech")).toEqual([
      { name: "Kenan", netid: "ktt38", open: 2, blocked: 1 },
      { name: "Neha", netid: "nb644", open: 1, blocked: 0 },
    ]);
  });

  test("the current lead matches by github OR netid (branchOwner can be either), case-insensitive", () => {
    expect(coLeadLoadRows([], ROSTER, "tpl52-tech").map((r) => r.netid)).toEqual(["ktt38", "nb644"]); // github
    expect(coLeadLoadRows([], ROSTER, "TPL52").map((r) => r.netid)).toEqual(["ktt38", "nb644"]);       // netid (the real branchOwner), case-insensitive
    expect(coLeadLoadRows([], ROSTER).map((r) => r.netid)).toEqual(["tpl52", "ktt38", "nb644"]);        // no ident → every lead shows
  });
});

describe("delegatedRows", () => {
  test("open issues with the lead-delegated label; assignee → first name; sorted by assignee then key", () => {
    const issues = [
      iss({ identifier: "COR-9", assignee: "kenan", labels: [DELEGATED_LABEL] }),
      iss({ identifier: "COR-3", assignee: "dana", labels: [DELEGATED_LABEL, "beginner"] }),
      iss({ identifier: "COR-4", assignee: "dana", labels: ["beginner"] }),                      // not delegated
      iss({ identifier: "COR-5", assignee: "dana", labels: [DELEGATED_LABEL], stateType: "completed" }), // terminal
    ];
    expect(delegatedRows(issues, ROSTER).map((r) => `${r.assignee}:${r.ticketKey}`)).toEqual(["Dana:COR-3", "Kenan:COR-9"]);
  });

  test("an unknown assignee id falls back to the raw id; no assignee → 'unassigned'", () => {
    const rows = delegatedRows([
      iss({ identifier: "COR-7", assignee: "ghost-id", labels: [DELEGATED_LABEL] }),
      iss({ identifier: "COR-8", assignee: null, labels: [DELEGATED_LABEL] }),
    ], ROSTER);
    expect(rows.map((r) => r.assignee).sort()).toEqual(["ghost-id", "unassigned"]);
  });
});

describe("epicRows", () => {
  test("parent issues with child completion, least-complete first; orphan children skipped", () => {
    const issues = [
      iss({ id: "epicA", identifier: "COR-100", title: "Search" }),
      iss({ id: "c1", parentId: "epicA", stateType: "completed" }),
      iss({ id: "c2", parentId: "epicA", stateType: "started" }),
      iss({ id: "epicB", identifier: "COR-200", title: "Onboarding" }),
      iss({ id: "c3", parentId: "epicB", stateType: "completed" }),
      iss({ id: "c4", parentId: "epicB", stateType: "completed" }),
      iss({ id: "c5", parentId: "ghost", stateType: "started" }), // parent not synced → skipped
    ];
    expect(epicRows(issues)).toEqual([
      { ticketKey: "COR-100", title: "Search", done: 1, total: 2 },     // 50% — in flight, leads
      { ticketKey: "COR-200", title: "Onboarding", done: 2, total: 2 }, // 100%
    ]);
  });

  test("no parent relationships → no epics", () => {
    expect(epicRows([iss({ id: "a" }), iss({ id: "b" })])).toEqual([]);
  });
});

describe("deskBoard", () => {
  test("bundles the three panels from one issue set", () => {
    const b = deskBoard([iss({ assignee: "kenan" })], ROSTER, "tpl52-tech");
    expect(Object.keys(b).sort()).toEqual(["coLeads", "delegated", "epics"]);
    expect(b.coLeads.find((c) => c.netid === "ktt38")?.open).toBe(1);
  });
});
