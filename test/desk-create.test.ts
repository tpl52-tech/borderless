import { test, expect, describe } from "bun:test";
import { issueCreateInput, runDeskCreate, parseCreateRequest, type DeskCreateDeps, type DeskCreateRequest } from "../src/shared/desk-create.ts";
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
    teamId: "T", labelId: "L", projectId: "proj-leadops", // all lead-desk work files here
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
      epics: [{ title: "Phase 2" }],
      tickets: [{ title: "Search UI", assigneeLinearId: "u1", priority: 2, epicIndex: 0, dm: true }],
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

  test("every item is filed under the one Lead Ops projectId", async () => {
    const { deps, creates } = fakeDeps();
    await runDeskCreate(req({
      epics: [{ title: "E" }],
      tickets: [{ title: "t", assigneeLinearId: null, priority: 0, epicIndex: 0, dm: false }],
    }), deps);
    expect(creates.map((c) => c.projectId)).toEqual(["proj-leadops", "proj-leadops"]);
  });

  test("a createIssue failure on one item is caught; later items still create", async () => {
    const { deps } = fakeDeps({ createIssue: async (input) => { if (input.title === "boom") throw new Error("Linear 500"); return { id: "x", ticketKey: "COR-9", url: null }; } });
    const r = await runDeskCreate(req({ tickets: [
      { title: "boom", assigneeLinearId: null, priority: 0, epicIndex: null, dm: false },
      { title: "ok", assigneeLinearId: null, priority: 0, epicIndex: null, dm: false },
    ] }), deps);
    expect(r.created).toHaveLength(1);
    expect(r.errors[0]).toContain("Linear 500");
  });

  test("dm:false, or no assignee, sends no DM", async () => {
    const { deps, dms } = fakeDeps();
    await runDeskCreate(req({ tickets: [
      { title: "a", assigneeLinearId: "u1", priority: 0, epicIndex: null, dm: false },
      { title: "b", assigneeLinearId: null, priority: 0, epicIndex: null, dm: true },
    ] }), deps);
    expect(dms).toEqual([]);
  });

  test("duplicate epic titles no longer collide — each ticket routes to its epic by index", async () => {
    const { deps, creates } = fakeDeps();
    await runDeskCreate(req({
      epics: [{ title: "Dup" }, { title: "Dup" }],
      tickets: [
        { title: "t0", assigneeLinearId: null, priority: 0, epicIndex: 0, dm: false },
        { title: "t1", assigneeLinearId: null, priority: 0, epicIndex: 1, dm: false },
      ],
    }), deps);
    expect(creates[2]!.parentId).toBe("uuid-1"); // t0 → the FIRST "Dup"
    expect(creates[3]!.parentId).toBe("uuid-2"); // t1 → the SECOND "Dup" (would've collided if keyed by title)
  });

  test("a ticket whose epic failed to create is still filed, but without a parent + a clear note", async () => {
    let n = 0;
    const creates: IssueCreateInput[] = [];
    const deps: DeskCreateDeps = {
      teamId: "T", labelId: "L", projectId: "proj", dmFor: async () => false,
      createIssue: async (input) => { if (input.title === "Doomed") throw new Error("nope"); creates.push(input); n++; return { id: `u${n}`, ticketKey: `COR-${n}`, url: null }; },
    };
    const r = await runDeskCreate(req({
      epics: [{ title: "Doomed" }],
      tickets: [{ title: "orphan", assigneeLinearId: null, priority: 0, epicIndex: 0, dm: false }],
    }), deps);
    expect(r.created.map((c) => c.ticketKey)).toEqual(["COR-1"]);   // the ticket is still filed
    expect(creates[0]!.parentId).toBeUndefined();                   // but with no parent (its epic failed)
    expect(r.errors.some((e) => e.includes('epic "Doomed"'))).toBe(true);
    expect(r.errors.some((e) => e.includes("filed without a parent"))).toBe(true);
  });
});

describe("parseCreateRequest (untrusted create body → clean request)", () => {
  test("null without a draftId; coerces every field; drops empty-title items; clamps priority", () => {
    expect(parseCreateRequest({ foo: 1 })).toBeNull();
    expect(parseCreateRequest("nope")).toBeNull();
    const r = parseCreateRequest({
      draftId: "d",
      epics: [{ title: " E " }, { title: "" }],
      tickets: [
        { title: "T", assigneeLinearId: "u1", project: "ignored", priority: 9, epicIndex: 1, dm: true },
        { title: 123 },
        { title: "noAsg", priority: "high", epicIndex: "0", dm: "yes" },
      ],
    })!;
    expect(r.draftId).toBe("d");
    expect(r.epics).toEqual([{ title: "E" }]); // trimmed; empty-title dropped; no project field
    expect(r.tickets).toEqual([
      { title: "T", assigneeLinearId: "u1", priority: 0, epicIndex: 1, dm: true }, // priority 9 out of 0..4 → 0; project ignored
      { title: "noAsg", assigneeLinearId: null, priority: 0, epicIndex: null, dm: false }, // "high"→0, "0"(string)→null, "yes"→false
    ]);
  });
});
