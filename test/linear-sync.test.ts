import { test, expect, describe } from "bun:test";
import { Store } from "../src/daemon/store.ts";
import { parseIssuesResponse, issuesVariables } from "../src/shared/linear.ts";
import { syncLinearIssues, type LinearClient } from "../src/daemon/linear.ts";

// A Linear GraphQL issue node, with overridable fields.
function node(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "uuid-1", identifier: "COR-1", title: "Fix the thing",
    url: "https://linear.app/cornell-ewb-softdev/issue/COR-1",
    priority: 2, updatedAt: "2026-10-06T18:00:00.000Z",
    state: { name: "In Review", type: "started" },
    assignee: { id: "user-1" }, project: { id: "proj-1" }, team: { key: "COR" },
    ...over,
  };
}
// A GraphQL `issues` connection response.
function page(nodes: unknown[], hasNextPage = false, endCursor: string | null = null): unknown {
  return { data: { issues: { pageInfo: { hasNextPage, endCursor }, nodes } } };
}

// A fake client that returns prepared pages in call order and records the variables it was asked with.
function recordingClient(pages: unknown[]): LinearClient & { calls: Array<{ after: unknown }> } {
  const calls: Array<{ after: unknown }> = [];
  let i = 0;
  return {
    calls,
    async query(_q, v) { calls.push(v as { after: unknown }); return pages[i++] ?? page([]); },
  };
}

describe("parseIssuesResponse (pure mapper, PRD §4)", () => {
  test("maps a node to an upsert row; assignee is the Linear user id", () => {
    const { issues, hasNextPage, endCursor } = parseIssuesResponse(page([node()], true, "cur-1"));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toEqual({
      id: "uuid-1", identifier: "COR-1", title: "Fix the thing",
      url: "https://linear.app/cornell-ewb-softdev/issue/COR-1",
      stateName: "In Review", stateType: "started", assignee: "user-1",
      projectId: "proj-1", teamKey: "COR", priority: 2,
      dueDate: null, labels: [], blockedBy: [],
      updatedAt: Date.parse("2026-10-06T18:00:00.000Z"),
    });
    expect(hasNextPage).toBe(true);
    expect(endCursor).toBe("cur-1");
  });

  test("tolerates missing optionals (no assignee/project/state/url) and bad dates", () => {
    const { issues } = parseIssuesResponse(page([
      node({ assignee: null, project: null, state: null, url: null, priority: null, updatedAt: "not-a-date" }),
    ]));
    expect(issues[0]).toMatchObject({
      assignee: null, projectId: null, stateName: null, stateType: null,
      url: null, priority: null, updatedAt: null,
    });
  });

  test("an empty / shapeless response yields no issues and no next page", () => {
    expect(parseIssuesResponse({})).toEqual({ issues: [], hasNextPage: false, endCursor: null });
    expect(parseIssuesResponse(null)).toEqual({ issues: [], hasNextPage: false, endCursor: null });
    expect(parseIssuesResponse(page([]))).toEqual({ issues: [], hasNextPage: false, endCursor: null });
  });

  test("maps dueDate (date → epoch) and label names (PRD §5 rescue data)", () => {
    const { issues } = parseIssuesResponse(page([node({
      dueDate: "2026-10-01", labels: { nodes: [{ name: "lead-level" }, { name: "intermediate" }] },
    })]));
    expect(issues[0]!.dueDate).toBe(Date.parse("2026-10-01"));
    expect(issues[0]!.labels).toEqual(["lead-level", "intermediate"]);
  });

  test("maps blockedBy from type=blocks inverse relations only", () => {
    const { issues } = parseIssuesResponse(page([node({
      inverseRelations: { nodes: [
        { type: "blocks", issue: { id: "blocker-1" } },
        { type: "related", issue: { id: "not-a-blocker" } },
        { type: "blocks", issue: { id: "blocker-2" } },
      ] },
    })]));
    expect(issues[0]!.blockedBy).toEqual(["blocker-1", "blocker-2"]);
  });

  test("tolerates a garbled dueDate and null label names", () => {
    const { issues } = parseIssuesResponse(page([node({
      dueDate: "not-a-date", labels: { nodes: [{ name: "ok" }, { name: null }] },
    })]));
    expect(issues[0]!.dueDate).toBeNull();
    expect(issues[0]!.labels).toEqual(["ok"]); // null name filtered out
  });

  test("issuesVariables filters by team key and carries the cursor", () => {
    expect(issuesVariables("COR")).toEqual({ filter: { team: { key: { eq: "COR" } } }, after: null });
    expect(issuesVariables("COR", "cur-9").after).toBe("cur-9");
  });
});

describe("syncLinearIssues (orchestration via injected client, PRD §4)", () => {
  test("persists dueDate and labels through the store", async () => {
    const s = new Store(":memory:");
    const client = recordingClient([page([node({ id: "u1", identifier: "COR-1", dueDate: "2026-10-01", labels: { nodes: [{ name: "lead-level" }] } })])]);
    await syncLinearIssues(s, client, ["COR"]);
    const row = s.listLinearIssues()[0]!;
    expect(row.dueDate).toBe(Date.parse("2026-10-01"));
    expect(row.labels).toEqual(["lead-level"]);
  });

  test("upserts a single page into linear_issues", async () => {
    const s = new Store(":memory:");
    const client = recordingClient([page([node({ id: "u1", identifier: "COR-1" }), node({ id: "u2", identifier: "COR-2" })])]);
    const { synced } = await syncLinearIssues(s, client, ["COR"]);
    expect(synced).toBe(2);
    expect(s.listLinearIssues().map((i) => i.identifier).sort()).toEqual(["COR-1", "COR-2"]);
    expect(s.listLinearIssues()[0]!.assignee).toBe("user-1");
  });

  test("follows pagination: threads the cursor and stops when hasNextPage is false", async () => {
    const s = new Store(":memory:");
    const client = recordingClient([
      page([node({ id: "u1", identifier: "COR-1" })], true, "cur-1"),
      page([node({ id: "u2", identifier: "COR-2" })], false, null),
    ]);
    const { synced } = await syncLinearIssues(s, client, ["COR"]);
    expect(synced).toBe(2);
    expect(client.calls.map((c) => c.after)).toEqual([null, "cur-1"]); // first page, then continue after cur-1
    expect(s.listLinearIssues()).toHaveLength(2);
  });

  test("re-sync is idempotent (upsert by id, not insert)", async () => {
    const s = new Store(":memory:");
    const mk = () => recordingClient([page([node({ id: "u1", identifier: "COR-1", title: "v1" })])]);
    await syncLinearIssues(s, mk(), ["COR"]);
    await syncLinearIssues(s, recordingClient([page([node({ id: "u1", identifier: "COR-1", title: "v2" })])]), ["COR"]);
    const rows = s.listLinearIssues();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe("v2"); // updated in place
  });
});

describe("sync -> enqueue in-review (build order #2 end to end)", () => {
  test("only In Review issues become in-review sweep jobs, idempotently", async () => {
    const s = new Store(":memory:");
    const client = recordingClient([page([
      node({ id: "u1", identifier: "COR-1", state: { name: "In Review", type: "started" } }),
      node({ id: "u2", identifier: "COR-2", state: { name: "In Progress", type: "started" } }),
      node({ id: "u3", identifier: "COR-3", state: { name: "In Review", type: "started" } }),
    ])]);
    await syncLinearIssues(s, client, ["COR"]);

    const created = s.enqueueInReviewSweeps("In Review");
    expect(created.map((j) => j.ticketKey).sort()).toEqual(["COR-1", "COR-3"]);
    expect(created.every((j) => j.kind === "in_review")).toBe(true);

    // running again creates nothing new (an active in-review job already exists per ticket)
    expect(s.enqueueInReviewSweeps("In Review")).toHaveLength(0);
  });
});
