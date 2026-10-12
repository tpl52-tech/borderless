import { test, expect, describe } from "bun:test";
import { issueCreateInput, runDeskCreate, type DeskCreateDeps, type DeskCreateRequest } from "../src/shared/desk-create.ts";
import type { IssueCreateInput, CreatedIssue } from "../src/shared/linear.ts";

describe("issueCreateInput (lead-desk create → Linear issueCreate input)", () => {
  test("a ticket carries priority + parentId + assignee + the label, with an empty description", () => {
    expect(issueCreateInput({ teamId: "T", projectId: "P", title: "Profile", assigneeLinearId: "u1", labelId: "L", priority: 2, parentId: "E" }))
      .toEqual({ teamId: "T", projectId: "P", title: "Profile", description: "", assigneeId: "u1", labelIds: ["L"], priority: 2, parentId: "E" });
  });

  test("an epic omits priority/parentId entirely (not null-defaulted) and can be unassigned", () => {
    const i = issueCreateInput({ teamId: "T", projectId: "P", title: "Epic", assigneeLinearId: null, labelId: "L" });
    expect(i).toEqual({ teamId: "T", projectId: "P", title: "Epic", description: "", assigneeId: null, labelIds: ["L"] });
    expect("priority" in i).toBe(false);
    expect("parentId" in i).toBe(false);
  });

  test("priority None (0) is still sent — not dropped as falsy", () => {
    expect(issueCreateInput({ teamId: "T", projectId: "P", title: "X", assigneeLinearId: null, labelId: "L", priority: 0 }).priority).toBe(0);
  });
});

function fakeDeps(over: Partial<DeskCreateDeps> = {}) {
  const creates: IssueCreateInput[] = [];
  const dms: string[] = [];
  let n = 0;
  const deps: DeskCreateDeps = {
    teamId: "T", labelId: "L",
    projectIdFor: (name) => (name === "ReUse" ? "proj-reuse" : null), // only "ReUse" resolves
    createIssue: async (input): Promise<CreatedIssue> => { creates.push(input); n++; return { id: `uuid-${n}`, ticketKey: `COR-${n}`, url: `http://x/${n}` }; },
    dmFor: async (id) => { dms.push(id); return true; },
    ...over,
  };
  return { deps, creates, dms };
}
const req = (over: Partial<DeskCreateRequest> = {}): DeskCreateRequest => ({ draftId: "d1", epics: [], tickets: [], ...over });

describe("runDeskCreate (orchestration, injected I/O)", () => {
  test("creates the epic first, then hangs its ticket under it via parentId; tags + assigns + DMs", async () => {
    const { deps, creates, dms } = fakeDeps();
    const r = await runDeskCreate(req({
      epics: [{ title: "Phase 2", project: "ReUse" }],
      tickets: [{ title: "Search UI", assigneeLinearId: "u1", project: "ReUse", priority: 2, epic: "Phase 2", dm: true }],
    }), deps);
    expect(r.errors).toEqual([]);
    expect(r.created).toEqual([
      { kind: "epic", ticketKey: "COR-1", url: "http://x/1" },
      { kind: "ticket", ticketKey: "COR-2", url: "http://x/2", dmSent: true },
    ]);
    expect(creates[0]!.title).toBe("Phase 2");            // epic created first
    expect(creates[1]!.parentId).toBe("uuid-1");          // ticket hung under the epic's UUID
    expect(creates[1]!.labelIds).toEqual(["L"]);
    expect(creates[1]!.assigneeId).toBe("u1");
    expect(dms).toEqual(["u1"]);
  });

  test("an unknown project skips the item with an error; the rest still create (fail-soft)", async () => {
    const { deps, creates } = fakeDeps();
    const r = await runDeskCreate(req({ tickets: [
      { title: "bad", assigneeLinearId: "u1", project: "Nope", priority: 0, epic: null, dm: false },
      { title: "good", assigneeLinearId: "u2", project: "ReUse", priority: 0, epic: null, dm: false },
    ] }), deps);
    expect(r.created.map((c) => c.ticketKey)).toEqual(["COR-1"]); // only "good"
    expect(r.errors[0]).toContain('ticket "bad"');
    expect(creates).toHaveLength(1);
  });

  test("a createIssue failure on one item is caught; later items still create", async () => {
    const { deps } = fakeDeps({ createIssue: async (input) => { if (input.title === "boom") throw new Error("Linear 500"); return { id: "x", ticketKey: "COR-9", url: null }; } });
    const r = await runDeskCreate(req({ tickets: [
      { title: "boom", assigneeLinearId: null, project: "ReUse", priority: 0, epic: null, dm: false },
      { title: "ok", assigneeLinearId: null, project: "ReUse", priority: 0, epic: null, dm: false },
    ] }), deps);
    expect(r.created).toHaveLength(1);
    expect(r.errors[0]).toContain("Linear 500");
  });

  test("dm:false, or no assignee, sends no DM", async () => {
    const { deps, dms } = fakeDeps();
    await runDeskCreate(req({ tickets: [
      { title: "a", assigneeLinearId: "u1", project: "ReUse", priority: 0, epic: null, dm: false },
      { title: "b", assigneeLinearId: null, project: "ReUse", priority: 0, epic: null, dm: true },
    ] }), deps);
    expect(dms).toEqual([]);
  });
});
