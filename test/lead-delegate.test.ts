import { test, expect, describe } from "bun:test";
import { delegate, type DelegateDeps } from "../src/daemon/lead-delegate.ts";
import { parseLeadOpsTargets, parseIssueCreate } from "../src/shared/linear.ts";
import type { Member } from "../src/shared/roster.ts";
import type { LeadOpsIssueInput } from "../src/shared/lead-desk.ts";

const ROSTER: Member[] = [
  { name: "Tess Lee", netid: "tpl52", emails: ["tpl52@cornell.edu"], linearIds: ["u-tess"], github: "tpl52-tech", lead: true },
];

// Capture what the injected I/O was asked to do.
function deps(over: Partial<DelegateDeps> = {}): DelegateDeps & { created: LeadOpsIssueInput[]; dms: Array<{ emails: string[]; text: string }> } {
  const created: LeadOpsIssueInput[] = [];
  const dms: Array<{ emails: string[]; text: string }> = [];
  return {
    roster: ROSTER,
    created, dms,
    async createIssue(input) { created.push(input); return { ticketKey: "COR-100", url: "https://linear.app/x/COR-100" }; },
    async sendDm(emails, text) { dms.push({ emails, text }); return true; },
    ...over,
  };
}

describe("delegate orchestration (PRD §9)", () => {
  test("resolves → creates the Lead Ops issue → DMs the assignee", async () => {
    const d = deps();
    const r = await delegate(d, { who: "tpl52", title: "Book the van", notes: "Saturday" });
    expect(r).toMatchObject({ ticketKey: "COR-100", created: true, dmSent: true, assignee: "Tess Lee" });
    expect(d.created[0]!.projectName).toBe("Lead Ops");
    expect(d.created[0]!.assigneeLinearId).toBe("u-tess");
    expect(d.dms[0]!.emails).toEqual(["tpl52@cornell.edu"]);
    expect(d.dms[0]!.text).toContain("COR-100"); // the DM carries the created key
  });

  test("a failed DM doesn't fail the delegation (issue still created)", async () => {
    const r = await delegate(deps({ sendDm: async () => false }), { who: "tpl52", title: "T" });
    expect(r).toMatchObject({ created: true, dmSent: false });
  });

  test("an unknown delegate throws before any issue is created", async () => {
    const d = deps();
    await expect(delegate(d, { who: "ghost", title: "T" })).rejects.toThrow(/no roster member/i);
    expect(d.created).toHaveLength(0);
  });
});

describe("Linear delegation parsers (PRD §9)", () => {
  test("parseLeadOpsTargets returns the team + project ids", () => {
    const json = { data: { teams: { nodes: [{ id: "team-1" }] }, projects: { nodes: [{ id: "proj-1" }] } } };
    expect(parseLeadOpsTargets(json, "COR", "Lead Ops")).toEqual({ teamId: "team-1", projectId: "proj-1" });
  });

  test("parseLeadOpsTargets throws a clear error when the team or project is missing", () => {
    expect(() => parseLeadOpsTargets({ data: { teams: { nodes: [] }, projects: { nodes: [{ id: "p" }] } } }, "COR", "Lead Ops")).toThrow(/no Linear team/i);
    expect(() => parseLeadOpsTargets({ data: { teams: { nodes: [{ id: "t" }] }, projects: { nodes: [] } } }, "COR", "Lead Ops")).toThrow(/no Linear project/i);
  });

  test("parseIssueCreate returns the created key + url, throws on failure", () => {
    expect(parseIssueCreate({ data: { issueCreate: { success: true, issue: { identifier: "COR-7", url: "u" } } } })).toEqual({ ticketKey: "COR-7", url: "u" });
    expect(() => parseIssueCreate({ data: { issueCreate: { success: false } } })).toThrow(/did not succeed/i);
    expect(() => parseIssueCreate({})).toThrow(/did not succeed/i);
  });
});
