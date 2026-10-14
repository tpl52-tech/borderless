import { test, expect, describe } from "bun:test";
import { runQaFixSweep, type QaFixDeps } from "../src/daemon/verify-qa-fix-run.ts";
import { fixMarker } from "../src/shared/verify-qa-fix.ts";
import type { IssueCreateInput } from "../src/shared/linear.ts";

const AT = 1760054400000;
const rawRow = (ticket_id: string, verdict: string, over: Record<string, unknown> = {}) =>
  ({ ticket_id, run: { verdict, verdictBy: "dana", verdictAt: AT, ...over } });

type Parent = { id: string; identifier: string; title: string; projectId: string | null; stateType: string | null; priority: number | null };

function deps(over: Partial<QaFixDeps> & {
  raw?: unknown;
  subs?: Record<string, { id: string; parentId: string | null }>;
  parents?: Record<string, Parent>;
  children?: Record<string, string[]>;
  todo?: string | null;
  done?: string | null;
} = {}): { deps: QaFixDeps; created: IssueCreateInput[]; states: Array<{ issueId: string; stateId: string }>; comments: Array<{ issueId: string; body: string }>; order: string[] } {
  const created: IssueCreateInput[] = [];
  const states: Array<{ issueId: string; stateId: string }> = [];
  const comments: Array<{ issueId: string; body: string }> = [];
  const order: string[] = [];
  const subs = over.subs ?? { "COR-91": { id: "u91", parentId: "u17" }, "COR-95": { id: "u95", parentId: "u17" } };
  const parents = over.parents ?? { u17: { id: "u17", identifier: "COR-17", title: "Search", projectId: "p1", stateType: "started", priority: 0 } };
  const children = over.children ?? {};
  return {
    created, states, comments, order,
    deps: {
      readVerdicts: over.readVerdicts ?? (async () => over.raw ?? [rawRow("COR-91", "fail")]),
      subIssueByKey: over.subIssueByKey ?? ((k) => subs[k]),
      parentByUuid: over.parentByUuid ?? ((u) => parents[u]),
      childDescriptions: over.childDescriptions ?? (async (u) => children[u] ?? []),
      targets: over.targets ?? (async () => ({ teamId: "t1", fixLabelId: "lfix", blockedLabelId: "lblk" })),
      todoStateId: over.todoStateId ?? (async () => (over.todo === undefined ? "todo-state" : over.todo)),
      doneStateId: over.doneStateId ?? (async () => (over.done === undefined ? "done-state" : over.done)),
      createIssue: over.createIssue ?? (async (input) => { created.push(input); order.push("create"); return { ticketKey: `COR-${119 + created.length}`, url: `http://i/${created.length}` }; }),
      setState: over.setState ?? (async (issueId, stateId) => { states.push({ issueId, stateId }); order.push("move"); }),
      postComment: over.postComment ?? (async (issueId, body) => { comments.push({ issueId, body }); order.push("comment"); return "http://c/1"; }),
      write: over.write ?? true,
    },
  };
}

describe("runQaFixSweep", () => {
  test("a FAIL opens a qa-fix child of the feature ticket and moves it to Todo", async () => {
    const h = deps();
    const [r] = await runQaFixSweep(h.deps);
    expect(r).toMatchObject({ subKey: "COR-91", parentKey: "COR-17", kind: "fix", action: "created", movedParent: true, fixKey: "COR-120" });
    expect(h.created).toHaveLength(1);
    expect(h.created[0]).toMatchObject({ teamId: "t1", projectId: "p1", parentId: "u17", labelIds: ["lfix"], assigneeId: null });
    expect(h.created[0]!.description).toContain(fixMarker(AT));
    expect(h.states).toEqual([{ issueId: "u17", stateId: "todo-state" }]);
  });

  test("move happens BEFORE create (idempotent move first, then the non-idempotent create)", async () => {
    const h = deps();
    await runQaFixSweep(h.deps);
    expect(h.order).toEqual(["move", "create", "comment"]);
  });

  test("a BLOCKED opens a qa-blocked child and never moves the feature ticket", async () => {
    const h = deps({ raw: [rawRow("COR-95", "blocked")] });
    const [r] = await runQaFixSweep(h.deps);
    expect(r).toMatchObject({ kind: "blocked", action: "created" });
    expect(r.movedParent).toBeFalsy();
    expect(h.created[0]!.labelIds).toEqual(["lblk"]);
    expect(h.states).toHaveLength(0);
  });

  test("dry run plans would-create (+ the intended move) without writing", async () => {
    const h = deps({ write: false });
    const [r] = await runQaFixSweep(h.deps);
    expect(r).toMatchObject({ action: "would-create", movedParent: true });
    expect(h.created).toHaveLength(0);
    expect(h.states).toHaveLength(0);
  });

  test("idempotent: a feature-ticket child already carrying the marker → skipped-exists, no writes", async () => {
    const h = deps({ children: { u17: [`a prior fix\n_ref ${fixMarker(AT)}_`] } });
    const [r] = await runQaFixSweep(h.deps);
    expect(r.action).toBe("skipped-exists");
    expect(h.created).toHaveLength(0);
    expect(h.states).toHaveLength(0);
  });

  test("priority is inherited onto the fix ticket", async () => {
    const h = deps({ parents: { u17: { id: "u17", identifier: "COR-17", title: "Search", projectId: "p1", stateType: "started", priority: 2 } } });
    await runQaFixSweep(h.deps);
    expect(h.created[0]!.priority).toBe(2);
  });

  describe("skipped-no-parent", () => {
    test("the sub-issue isn't synced", async () => {
      const h = deps({ subs: {} });
      const [r] = await runQaFixSweep(h.deps);
      expect(r.action).toBe("skipped-no-parent");
      expect(r.detail).toContain("ao sync");
    });

    test("the sub-issue has no parent", async () => {
      const h = deps({ subs: { "COR-91": { id: "u91", parentId: null } } });
      const [r] = await runQaFixSweep(h.deps);
      expect(r).toMatchObject({ action: "skipped-no-parent", detail: "sub-issue has no parent feature ticket" });
    });

    test("the parent isn't synced, or has no project to file under", async () => {
      expect((await runQaFixSweep(deps({ parents: {} }).deps))[0]!.detail).toContain("not synced");
      const noProj = deps({ parents: { u17: { id: "u17", identifier: "COR-17", title: "S", projectId: null, stateType: "started", priority: 0 } } });
      expect((await runQaFixSweep(noProj.deps))[0]!.detail).toContain("no project");
    });
  });

  test("a FAIL with no resolvable Todo state still opens the fix ticket, with a detail note", async () => {
    const h = deps({ todo: null });
    const [r] = await runQaFixSweep(h.deps);
    expect(r).toMatchObject({ action: "created", movedParent: false });
    expect(r.detail).toContain("no Todo workflow state");
    expect(h.created).toHaveLength(1);
    expect(h.states).toHaveLength(0);
  });

  test("a failed create still moved the feature (move-first) but posts NO breadcrumb, and surfaces an error", async () => {
    const h = deps({ createIssue: async () => { throw new Error("Linear 500"); } });
    const [r] = await runQaFixSweep(h.deps);
    expect(r).toMatchObject({ action: "error", detail: "Linear 500" });
    expect(h.states).toHaveLength(1); // moved first (idempotent) — a re-run re-moves and retries the create
    expect(h.comments).toHaveLength(0);
  });

  test("a failing breadcrumb is non-fatal — the ticket (the dedupe artifact) still counts as created", async () => {
    const h = deps({ postComment: async () => { throw new Error("comment 500"); } });
    const [r] = await runQaFixSweep(h.deps);
    expect(r.action).toBe("created");
    expect(h.created).toHaveLength(1);
    expect(h.comments).toHaveLength(0);
  });

  test("a failing row degrades to an error without sinking the run", async () => {
    let n = 0;
    const h = deps({ raw: [rawRow("COR-91", "fail"), rawRow("COR-95", "blocked")], createIssue: async () => { n++; if (n === 1) throw new Error("boom"); return { ticketKey: "COR-200", url: null }; } });
    const results = await runQaFixSweep(h.deps);
    expect(results).toHaveLength(2);
    expect(results[0]!.action).toBe("error");
    expect(results[1]!.action).toBe("created");
  });

  test("the __probe row is dropped; real verdicts (incl. PASS) are processed", async () => {
    // distinct parents so the within-run fail-wins gate doesn't couple the two
    const h = deps({
      raw: [{ ticket_id: "__probe", run: { verdict: "fail", verdictAt: AT } }, rawRow("COR-91", "fail"), rawRow("COR-95", "pass")],
      subs: { "COR-91": { id: "u91", parentId: "u17" }, "COR-95": { id: "u95", parentId: "u18" } },
      parents: {
        u17: { id: "u17", identifier: "COR-17", title: "A", projectId: "p1", stateType: "started", priority: 0 },
        u18: { id: "u18", identifier: "COR-18", title: "B", projectId: "p1", stateType: "started", priority: 0 },
      },
    });
    const results = await runQaFixSweep(h.deps);
    expect(results.map((r) => `${r.subKey}:${r.action}`)).toEqual(["COR-91:created", "COR-95:verified"]);
  });

  describe("PASS → feature ticket to Done", () => {
    const passParent = (stateType: string | null, projectId: string | null = "p1") =>
      ({ parents: { u17: { id: "u17", identifier: "COR-17", title: "Search", projectId, stateType, priority: 0 } } });

    test("a PASS moves the feature ticket to Done (verified), creates no ticket", async () => {
      const h = deps({ raw: [rawRow("COR-91", "pass")] });
      const [r] = await runQaFixSweep(h.deps);
      expect(r).toMatchObject({ subKey: "COR-91", parentKey: "COR-17", kind: "pass", action: "verified" });
      expect(h.states).toEqual([{ issueId: "u17", stateId: "done-state" }]);
      expect(h.created).toHaveLength(0);
    });

    test("a PASS whose feature ticket is already closed → skipped-verified, no move", async () => {
      const h = deps({ raw: [rawRow("COR-91", "pass")], ...passParent("completed") });
      const [r] = await runQaFixSweep(h.deps);
      expect(r.action).toBe("skipped-verified");
      expect(h.states).toHaveLength(0);
    });

    test("dry run plans a PASS as would-verify without moving", async () => {
      const h = deps({ raw: [rawRow("COR-91", "pass")], write: false });
      const [r] = await runQaFixSweep(h.deps);
      expect(r.action).toBe("would-verify");
      expect(h.states).toHaveLength(0);
    });

    test("a PASS with no resolvable Done state → skipped-verified with a note", async () => {
      const h = deps({ raw: [rawRow("COR-91", "pass")], done: null });
      const [r] = await runQaFixSweep(h.deps);
      expect(r).toMatchObject({ action: "skipped-verified" });
      expect(r.detail).toContain("no Done workflow state");
      expect(h.states).toHaveLength(0);
    });

    test("a PASS needs only the feature ticket, not a project (unlike a fix)", async () => {
      const h = deps({ raw: [rawRow("COR-91", "pass")], ...passParent("started", null) });
      const [r] = await runQaFixSweep(h.deps);
      expect(r.action).toBe("verified");
    });

    test("a PASS does NOT close a feature with a sibling FAIL in the same run — the fail wins → Todo, not Done", async () => {
      // COR-91 (pass) and COR-95 (fail) both hang under u17.
      const h = deps({ raw: [rawRow("COR-91", "pass"), rawRow("COR-95", "fail")] });
      const results = await runQaFixSweep(h.deps);
      expect(results.find((r) => r.subKey === "COR-91")!).toMatchObject({ action: "skipped-verified" });
      expect(results.find((r) => r.subKey === "COR-91")!.detail).toContain("failing/blocked");
      expect(results.find((r) => r.subKey === "COR-95")!.action).toBe("created");
      expect(h.states).toEqual([{ issueId: "u17", stateId: "todo-state" }]); // only the fail's Todo move, never a close
    });

    test("deterministic regardless of row order: the fail still wins when it comes first", async () => {
      const h = deps({ raw: [rawRow("COR-95", "fail"), rawRow("COR-91", "pass")] });
      const results = await runQaFixSweep(h.deps);
      expect(results.find((r) => r.subKey === "COR-91")!.action).toBe("skipped-verified");
      expect(h.states).toEqual([{ issueId: "u17", stateId: "todo-state" }]);
    });
  });
});
