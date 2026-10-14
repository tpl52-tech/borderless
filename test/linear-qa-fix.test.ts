import { test, expect, describe } from "bun:test";
import {
  parseIssueChildrenPage, parseTodoStates, pickTodoState, parseQaFixTargets,
} from "../src/shared/linear.ts";

describe("parseIssueChildrenPage", () => {
  test("collects child descriptions and the next cursor", () => {
    const json = { data: { issue: { children: {
      pageInfo: { hasNextPage: true, endCursor: "c2" },
      nodes: [{ description: "a" }, { description: "b" }, { description: null }],
    } } } };
    expect(parseIssueChildrenPage(json)).toEqual({ descriptions: ["a", "b"], next: "c2" });
  });

  test("next is null on the last page; a missing issue → empty page", () => {
    expect(parseIssueChildrenPage({ data: { issue: { children: { pageInfo: { hasNextPage: false, endCursor: "x" }, nodes: [{ description: "only" }] } } } }))
      .toEqual({ descriptions: ["only"], next: null });
    expect(parseIssueChildrenPage({ data: { issue: null } })).toEqual({ descriptions: [], next: null });
  });
});

describe("parseTodoStates / pickTodoState", () => {
  test("prefers a state literally named Todo", () => {
    const states = parseTodoStates({ data: { workflowStates: { nodes: [
      { id: "s1", name: "Backlog", type: "backlog" },
      { id: "s2", name: "Todo", type: "unstarted" },
    ] } } });
    expect(states).toEqual([{ id: "s1", name: "Backlog", type: "backlog" }, { id: "s2", name: "Todo", type: "unstarted" }]);
    expect(pickTodoState(states)!.id).toBe("s2");
  });

  test("falls back to the first unstarted, then the first backlog", () => {
    expect(pickTodoState(parseTodoStates({ data: { workflowStates: { nodes: [
      { id: "s1", name: "Icebox", type: "backlog" },
      { id: "s2", name: "Up Next", type: "unstarted" },
    ] } } }))!.id).toBe("s2");
    expect(pickTodoState(parseTodoStates({ data: { workflowStates: { nodes: [{ id: "s1", name: "Icebox", type: "backlog" }] } } }))!.id).toBe("s1");
  });

  test("empty / malformed → no states, null pick", () => {
    expect(parseTodoStates(null)).toEqual([]);
    expect(parseTodoStates({ data: { workflowStates: { nodes: [{ name: "no id" }] } } })).toEqual([]);
    expect(pickTodoState([])).toBeNull();
  });
});

describe("parseQaFixTargets", () => {
  test("returns the team id and both label ids, leaving a missing label null", () => {
    const json = { data: { teams: { nodes: [{ id: "t1" }] }, fix: { nodes: [{ id: "lfix" }] }, blocked: { nodes: [] } } };
    expect(parseQaFixTargets(json, "COR")).toEqual({ teamId: "t1", fixLabelId: "lfix", blockedLabelId: null });
  });

  test("throws when the team is missing (can't create anything without it)", () => {
    expect(() => parseQaFixTargets({ data: { teams: { nodes: [] } } }, "COR")).toThrow(/no Linear team/);
  });
});
