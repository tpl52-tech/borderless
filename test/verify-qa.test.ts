import { test, expect, describe } from "bun:test";
import { planQaSubIssues, qaRunsheetPrompt, buildQaSubIssueInput, QA_LABEL } from "../src/shared/verify-qa.ts";
import { parseQaTargets } from "../src/shared/linear.ts";
import type { VerifyRow } from "../src/shared/verify.ts";

const row = (ticketKey: string, hasUi: boolean, verifiability: VerifyRow["verifiability"], title = `${ticketKey} title`): VerifyRow =>
  ({ ticketKey, title, prNumber: null, verifiability, backendProperties: [], hasUi });

describe("planQaSubIssues", () => {
  const rows: VerifyRow[] = [
    row("COR-1", true, "ui"),
    row("COR-2", true, "mixed"),
    row("COR-3", false, "backend"), // no visible half → no manual-QA sub-issue
  ];

  test("plans a sub-issue only for the screen-observable (ui / mixed) tickets", () => {
    const plans = planQaSubIssues(rows, new Set());
    expect(plans.map((p) => p.parentKey)).toEqual(["COR-1", "COR-2"]); // COR-3 (backend-only) excluded
    expect(plans[0]!.title).toBe("QA verify: COR-1 title");
  });

  test("is idempotent — a ticket that already has a manual-qa child is skipped", () => {
    expect(planQaSubIssues(rows, new Set(["COR-1"])).map((p) => p.parentKey)).toEqual(["COR-2"]);
    expect(planQaSubIssues(rows, new Set(["COR-1", "COR-2"]))).toEqual([]);
  });
});

describe("qaRunsheetPrompt", () => {
  test("embeds the ticket + ACs and constrains the output to a tester run sheet", () => {
    const p = qaRunsheetPrompt({ identifier: "COR-17", title: "Search screen", description: "list filters live from the DB" });
    expect(p).toContain("COR-17");
    expect(p).toContain("Search screen");
    expect(p).toContain("list filters live from the DB");
    expect(p).toContain("Cue QA");
    expect(p).toContain("Expo Go");
    expect(p).toContain("Generated from the ticket's acceptance criteria for the manual-qa pass.");
    // it must steer AWAY from backend language (that half is verified separately)
    expect(p).toContain("Do NOT mention databases, RLS, SQL, servers, or code");
  });

  test("a null/empty description falls back to inferring from the title, and long ACs are truncated+marked", () => {
    expect(qaRunsheetPrompt({ identifier: "COR-9", title: "T", description: null })).toContain("infer the user-visible behaviour from the title");
    const long = qaRunsheetPrompt({ identifier: "COR-9", title: "T", description: "x".repeat(5000) });
    expect(long).toContain("[acceptance criteria truncated]");
  });
});

describe("buildQaSubIssueInput", () => {
  test("makes a labelled, unassigned sub-issue in the parent's project", () => {
    const input = buildQaSubIssueInput({ teamId: "team-1", projectId: "proj-1", parentId: "parent-uuid", labelId: "label-1", title: "QA verify: X", description: "run sheet" });
    expect(input).toEqual({
      teamId: "team-1", projectId: "proj-1", parentId: "parent-uuid",
      labelIds: ["label-1"], title: "QA verify: X", description: "run sheet", assigneeId: null,
    });
  });

  test("QA_LABEL is the agreed marker", () => {
    expect(QA_LABEL).toBe("manual-qa");
  });
});

describe("parseQaTargets", () => {
  const ok = {
    data: {
      teams: { nodes: [{ id: "team-1" }] },
      issueLabels: { nodes: [{ id: "label-1" }] },
      issues: { nodes: [{ parent: { identifier: "COR-17" } }, { parent: { identifier: "COR-19" } }, { parent: null }] },
    },
  };

  test("returns team id, label id, and the existing children's parent keys (nulls dropped)", () => {
    expect(parseQaTargets(ok, "COR", "manual-qa")).toEqual({ teamId: "team-1", labelId: "label-1", existingParentKeys: ["COR-17", "COR-19"] });
  });

  test("throws a clear error when the team or the manual-qa label is missing", () => {
    expect(() => parseQaTargets({ data: { teams: { nodes: [] }, issueLabels: { nodes: [{ id: "l" }] } } }, "COR", "manual-qa")).toThrow(/no Linear team/i);
    expect(() => parseQaTargets({ data: { teams: { nodes: [{ id: "t" }] }, issueLabels: { nodes: [] } } }, "COR", "manual-qa")).toThrow(/no Linear label/i);
  });
});
