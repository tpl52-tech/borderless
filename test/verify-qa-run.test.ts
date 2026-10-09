import { test, expect, describe } from "bun:test";
import { runQaSubIssues, type QaSubIssueDeps } from "../src/daemon/verify-qa-run.ts";
import type { VerifyRow } from "../src/shared/verify.ts";
import type { LinearIssue } from "../src/shared/types.ts";
import type { IssueCreateInput, CreatedIssue, QaTargets } from "../src/shared/linear.ts";

const row = (ticketKey: string, hasUi = true): VerifyRow =>
  ({ ticketKey, title: `${ticketKey} title`, prNumber: null, verifiability: hasUi ? "mixed" : "backend", backendProperties: [], hasUi });

const issue = (id: string, identifier: string, projectId: string | null): LinearIssue =>
  ({ id, identifier, title: `${identifier} title`, description: "ACs", url: null, stateName: "Verifying", stateType: "started",
     assignee: null, projectId, projectName: null, teamKey: "COR", priority: null, dueDate: null, labels: [], blockedBy: [] } as unknown as LinearIssue);

function deps(over: Partial<QaSubIssueDeps> & { targets?: Partial<QaTargets>; store?: Record<string, LinearIssue> } = {}): {
  deps: QaSubIssueDeps; created: IssueCreateInput[]; generated: string[];
} {
  const created: IssueCreateInput[] = [];
  const generated: string[] = [];
  const store = over.store ?? { "COR-1": issue("u1", "COR-1", "proj-1"), "COR-2": issue("u2", "COR-2", "proj-1") };
  return {
    created, generated,
    deps: {
      rows: over.rows ?? [row("COR-1"), row("COR-2")],
      qaTargets: over.qaTargets ?? (async () => ({ teamId: "team-1", labelId: "label-1", existingParentKeys: [], ...over.targets })),
      issueByKey: over.issueByKey ?? ((k) => store[k]),
      generateRunsheet: over.generateRunsheet ?? (async (i) => { generated.push(i.identifier); return `run sheet for ${i.identifier}`; }),
      createIssue: over.createIssue ?? (async (input): Promise<CreatedIssue> => { created.push(input); return { ticketKey: `QA-${created.length}`, url: `http://x/${created.length}` }; }),
      write: over.write ?? true,
    },
  };
}

describe("runQaSubIssues", () => {
  test("write=true creates a labelled sub-issue per eligible ticket, in the parent's project", async () => {
    const h = deps();
    const results = await runQaSubIssues(h.deps);
    expect(results.map((r) => r.action)).toEqual(["created", "created"]);
    expect(h.created).toHaveLength(2);
    expect(h.created[0]).toMatchObject({ teamId: "team-1", projectId: "proj-1", parentId: "u1", labelIds: ["label-1"], assigneeId: null });
    expect(h.created[0]!.description).toBe("run sheet for COR-1");
    expect(results[0]!.ticketKey).toBe("QA-1");
  });

  test("dry run (write=false) plans but never generates or creates", async () => {
    const h = deps({ write: false });
    const results = await runQaSubIssues(h.deps);
    expect(results.map((r) => r.action)).toEqual(["would-create", "would-create"]);
    expect(h.created).toHaveLength(0);
    expect(h.generated).toHaveLength(0);
  });

  test("idempotent — a ticket that already has a manual-qa child is not acted on", async () => {
    const h = deps({ targets: { existingParentKeys: ["COR-1"] } });
    const results = await runQaSubIssues(h.deps);
    expect(results.map((r) => r.parentKey)).toEqual(["COR-2"]); // COR-1 planned out
  });

  test("a ticket not in the store, or with no project, is skipped (not created)", async () => {
    const h = deps({ store: { "COR-2": issue("u2", "COR-2", null) } }); // COR-1 missing, COR-2 has null project
    const results = await runQaSubIssues(h.deps);
    const byKey = Object.fromEntries(results.map((r) => [r.parentKey, r]));
    expect(byKey["COR-1"]!.action).toBe("skipped-no-parent");
    expect(byKey["COR-1"]!.detail).toContain("no synced ticket");
    expect(byKey["COR-2"]!.action).toBe("skipped-no-parent");
    expect(byKey["COR-2"]!.detail).toContain("no Linear project");
    expect(h.created).toHaveLength(0);
  });

  test("a failing create, or an empty run sheet, degrades to an error result (never throws the run)", async () => {
    const boom = deps({ rows: [row("COR-1")], createIssue: async () => { throw new Error("Linear 500"); } });
    expect((await runQaSubIssues(boom.deps))[0]).toMatchObject({ action: "error", detail: "Linear 500" });

    const empty = deps({ rows: [row("COR-1")], generateRunsheet: async () => "   " });
    const r = (await runQaSubIssues(empty.deps))[0]!;
    expect(r.action).toBe("error");
    expect(r.detail).toContain("returned nothing");
    expect(empty.created).toHaveLength(0); // never created with an empty description
  });
});
