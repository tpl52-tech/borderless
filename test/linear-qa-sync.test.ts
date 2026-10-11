import { test, expect, describe } from "bun:test";
import {
  parseWorkflowStates, pickDoneState, parseIssueCommentsPage,
} from "../src/shared/linear.ts";

describe("parseWorkflowStates / pickDoneState", () => {
  test("maps the completed states, then prefers the one named Done", () => {
    const json = { data: { workflowStates: { nodes: [
      { id: "s1", name: "Released", type: "completed" },
      { id: "s2", name: "Done", type: "completed" },
    ] } } };
    const states = parseWorkflowStates(json);
    expect(states).toEqual([{ id: "s1", name: "Released" }, { id: "s2", name: "Done" }]);
    expect(pickDoneState(states)!.id).toBe("s2");
  });

  test("falls back to the first completed state when none is literally Done", () => {
    const states = parseWorkflowStates({ data: { workflowStates: { nodes: [{ id: "s1", name: "Shipped", type: "completed" }] } } });
    expect(pickDoneState(states)!.id).toBe("s1");
  });

  test("empty / malformed → no states, null pick", () => {
    expect(parseWorkflowStates(null)).toEqual([]);
    expect(parseWorkflowStates({ data: { workflowStates: { nodes: [{ name: "no id" }] } } })).toEqual([]);
    expect(pickDoneState([])).toBeNull();
  });
});

describe("parseIssueCommentsPage", () => {
  test("collects comment bodies and the next cursor", () => {
    const json = { data: { issue: { comments: {
      pageInfo: { hasNextPage: true, endCursor: "cur2" },
      nodes: [{ body: "first" }, { body: "second" }, { body: null }],
    } } } };
    expect(parseIssueCommentsPage(json)).toEqual({ bodies: ["first", "second"], next: "cur2" });
  });

  test("next is null on the last page", () => {
    const json = { data: { issue: { comments: { pageInfo: { hasNextPage: false, endCursor: "x" }, nodes: [{ body: "only" }] } } } };
    expect(parseIssueCommentsPage(json)).toEqual({ bodies: ["only"], next: null });
  });

  test("a missing issue (null) → empty page", () => {
    expect(parseIssueCommentsPage({ data: { issue: null } })).toEqual({ bodies: [], next: null });
  });
});
