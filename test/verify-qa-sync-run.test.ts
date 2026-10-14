import { test, expect, describe } from "bun:test";
import { runQaWriteback, type QaWritebackDeps } from "../src/daemon/verify-qa-sync-run.ts";
import { verdictMarker } from "../src/shared/verify-qa-sync.ts";

const AT = 1760054400000;
const rawRow = (ticket_id: string, verdict: string, over: Record<string, unknown> = {}) =>
  ({ ticket_id, run: { verdict, verdictBy: "renee", verdictAt: AT, ...over } });

function deps(over: Partial<QaWritebackDeps> & {
  raw?: unknown; store?: Record<string, { id: string; stateType: string | null }>; comments?: Record<string, string[]>; done?: string | null; assignee?: string | null;
} = {}): { deps: QaWritebackDeps; comments: Array<{ id: string; body: string }>; states: Array<{ id: string; stateId: string }>; assigned: Array<{ id: string; userId: string }> } {
  const commented: Array<{ id: string; body: string }> = [];
  const states: Array<{ id: string; stateId: string }> = [];
  const assigned: Array<{ id: string; userId: string }> = [];
  const store = over.store ?? { "COR-96": { id: "u96", stateType: "started" } };
  const comments = over.comments ?? {};
  return {
    comments: commented, states, assigned,
    deps: {
      readVerdicts: over.readVerdicts ?? (async () => over.raw ?? [rawRow("COR-96", "pass")]),
      issueByKey: over.issueByKey ?? ((k) => store[k]),
      commentBodies: over.commentBodies ?? (async (id) => comments[id] ?? []),
      doneStateId: over.doneStateId ?? (async () => (over.done === undefined ? "done-state" : over.done)),
      postComment: over.postComment ?? (async (id, body) => { commented.push({ id, body }); return `http://c/${commented.length}`; }),
      setState: over.setState ?? (async (id, stateId) => { states.push({ id, stateId }); }),
      assigneeForTester: over.assigneeForTester ?? (() => over.assignee ?? null),
      setAssignee: over.setAssignee ?? (async (id, userId) => { assigned.push({ id, userId }); }),
      write: over.write ?? true,
    },
  };
}

describe("runQaWriteback", () => {
  test("a pass comments the sub-issue and moves it to Done", async () => {
    const h = deps();
    const [r] = await runQaWriteback(h.deps);
    expect(r).toMatchObject({ ticketKey: "COR-96", verdict: "pass", action: "synced", movedToDone: true, url: "http://c/1" });
    expect(h.comments).toHaveLength(1);
    expect(h.comments[0]!.body).toContain(verdictMarker(AT));
    expect(h.states).toEqual([{ id: "u96", stateId: "done-state" }]);
  });

  test("a fail comments but never changes state", async () => {
    const h = deps({ raw: [rawRow("COR-96", "fail")] });
    const [r] = await runQaWriteback(h.deps);
    expect(r).toMatchObject({ action: "synced", movedToDone: false });
    expect(h.comments).toHaveLength(1);
    expect(h.states).toHaveLength(0);
  });

  test("dry run plans without posting or transitioning", async () => {
    const h = deps({ write: false });
    const [r] = await runQaWriteback(h.deps);
    expect(r).toMatchObject({ action: "would-sync", movedToDone: true });
    expect(h.comments).toHaveLength(0);
    expect(h.states).toHaveLength(0);
  });

  test("idempotent: a verdict already carrying its ref is skipped (no writes)", async () => {
    const h = deps({ comments: { u96: [`ref ${verdictMarker(AT)}`] } });
    const [r] = await runQaWriteback(h.deps);
    expect(r.action).toBe("skipped-synced");
    expect(h.comments).toHaveLength(0);
    expect(h.states).toHaveLength(0);
  });

  test("a verdict for an un-synced sub-issue is skipped with guidance", async () => {
    const h = deps({ raw: [rawRow("COR-77", "pass")] }); // not in the store
    const [r] = await runQaWriteback(h.deps);
    expect(r.action).toBe("skipped-unsynced");
    expect(r.detail).toContain("ao sync");
    expect(h.comments).toHaveLength(0);
  });

  test("a pass with no resolvable Done state still comments, with a detail note", async () => {
    const h = deps({ done: null });
    const [r] = await runQaWriteback(h.deps);
    expect(r).toMatchObject({ action: "synced", movedToDone: false });
    expect(r.detail).toContain("no Done workflow state");
    expect(h.comments).toHaveLength(1);
    expect(h.states).toHaveLength(0);
  });

  test("a failed Done-move posts NO marker comment, so a re-run retries both (atomicity)", async () => {
    const h = deps({ setState: async () => { throw new Error("state 500"); } });
    const [r] = await runQaWriteback(h.deps);
    expect(r).toMatchObject({ action: "error", detail: "state 500" });
    expect(h.comments).toHaveLength(0); // marker not written → next run is not short-circuited as already-synced
  });

  test("a failing write degrades to an error result (never throws the run)", async () => {
    const h = deps({ raw: [rawRow("COR-96", "pass"), rawRow("COR-96", "fail", { verdictAt: AT + 1 })], postComment: async () => { throw new Error("Linear 500"); } });
    const results = await runQaWriteback(h.deps);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ action: "error", detail: "Linear 500" });
    expect(results[1]).toMatchObject({ action: "error", detail: "Linear 500" });
  });

  test("the __probe row and un-verdicted rows are parsed out before any Linear call", async () => {
    const h = deps({ raw: [{ ticket_id: "__probe", run: { verdict: "fail" } }, { ticket_id: "COR-96", run: { verdict: "pass", verdictAt: AT } }] });
    const results = await runQaWriteback(h.deps);
    expect(results.map((r) => r.ticketKey)).toEqual(["COR-96"]);
  });

  describe("tester attribution", () => {
    test("assigns the sub-issue to the resolved tester and notes it by display name", async () => {
      const h = deps({ raw: [rawRow("COR-96", "pass", { verdictBy: "renee" })], assignee: "u-renee" });
      const [r] = await runQaWriteback(h.deps);
      expect(h.assigned).toEqual([{ id: "u96", userId: "u-renee" }]);
      expect(r.assignedTo).toBe("Renee");
    });

    test("leaves it unassigned (no setAssignee, no assignedTo) when the tester doesn't resolve", async () => {
      const h = deps({ raw: [rawRow("COR-96", "pass", { verdictBy: "ghost" })], assignee: null });
      const [r] = await runQaWriteback(h.deps);
      expect(h.assigned).toHaveLength(0);
      expect(r.assignedTo).toBeUndefined();
    });

    test("a dry run assigns nothing", async () => {
      const h = deps({ raw: [rawRow("COR-96", "pass")], assignee: "u-renee", write: false });
      await runQaWriteback(h.deps);
      expect(h.assigned).toHaveLength(0);
    });

    test("an already-synced verdict is not re-assigned", async () => {
      const h = deps({ comments: { u96: [`ref ${verdictMarker(AT)}`] }, assignee: "u-renee" });
      await runQaWriteback(h.deps);
      expect(h.assigned).toHaveLength(0);
    });
  });
});
