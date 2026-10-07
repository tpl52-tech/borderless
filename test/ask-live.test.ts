import { test, expect, describe } from "bun:test";
import { toOpenAITools, toOpenAIMessages, parseChatCompletion } from "../src/daemon/openrouter/chat.ts";
import type { Message, ToolDef } from "../src/daemon/openrouter/runner.ts";
import {
  ISSUE_UPDATE_MUTATION, parseIssueUpdate, COMMENT_CREATE_MUTATION, parseCommentCreate,
} from "../src/shared/linear.ts";

describe("OpenRouter mappers (PRD §10 live chat)", () => {
  test("toOpenAITools shapes function tools and defaults missing parameters", () => {
    const tools: ToolDef[] = [{ name: "t1", description: "d", parameters: { type: "object", properties: { x: { type: "string" } } } }, { name: "t2" }];
    const out = toOpenAITools(tools) as any[];
    expect(out[0]).toEqual({ type: "function", function: { name: "t1", description: "d", parameters: { type: "object", properties: { x: { type: "string" } } } } });
    expect(out[1].function).toEqual({ name: "t2", description: "", parameters: { type: "object", properties: {} } });
  });

  test("toOpenAIMessages encodes assistant tool calls, tool results, and plain turns", () => {
    const msgs: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "enqueue_sweep", args: { kind: "in_review" } }] },
      { role: "tool", toolCallId: "c1", content: "enqueued 1" },
    ];
    const out = toOpenAIMessages(msgs) as any[];
    expect(out[1]).toEqual({ role: "user", content: "hi" });
    expect(out[2].tool_calls[0]).toEqual({ id: "c1", type: "function", function: { name: "enqueue_sweep", arguments: JSON.stringify({ kind: "in_review" }) } });
    expect(out[2].content).toBeNull();
    expect(out[3]).toEqual({ role: "tool", tool_call_id: "c1", content: "enqueued 1" });
  });

  test("parseChatCompletion extracts text, tool calls (args JSON-parsed), and cost", () => {
    const r = parseChatCompletion({
      choices: [{ message: { content: "done", tool_calls: [{ id: "c1", function: { name: "reassign_ticket", arguments: '{"ticket":"COR-1","assignee":"ktt38"}' } }] } }],
      usage: { cost: 0.0021 },
    });
    expect(r.text).toBe("done");
    expect(r.toolCalls).toEqual([{ id: "c1", name: "reassign_ticket", args: { ticket: "COR-1", assignee: "ktt38" } }]);
    expect(r.usageCost).toBe(0.0021);
  });

  test("parseChatCompletion tolerates garbled args and a shapeless body", () => {
    const r = parseChatCompletion({ choices: [{ message: { content: null, tool_calls: [{ id: "c1", function: { name: "enqueue_sweep", arguments: "not json" } }] } }] });
    expect(r.text).toBeUndefined();
    expect(r.toolCalls).toEqual([{ id: "c1", name: "enqueue_sweep", args: {} }]);
    expect(parseChatCompletion({})).toEqual({ text: undefined, toolCalls: undefined, usageCost: undefined });
    expect(parseChatCompletion(null)).toEqual({ text: undefined, toolCalls: undefined, usageCost: undefined });
  });
});

describe("Linear write parsers (PRD §10 fleet writes)", () => {
  test("mutation strings name the operations", () => {
    expect(ISSUE_UPDATE_MUTATION).toContain("issueUpdate(id: $id, input: $input)");
    expect(COMMENT_CREATE_MUTATION).toContain("commentCreate(input: $input)");
  });

  test("parseIssueUpdate returns the ticket + url, throws on failure", () => {
    expect(parseIssueUpdate({ data: { issueUpdate: { success: true, issue: { identifier: "COR-1", url: "u" } } } })).toEqual({ ticketKey: "COR-1", url: "u" });
    expect(() => parseIssueUpdate({ data: { issueUpdate: { success: false } } })).toThrow(/did not succeed/i);
    expect(() => parseIssueUpdate({})).toThrow(/did not succeed/i);
  });

  test("parseCommentCreate returns the url, throws on failure", () => {
    expect(parseCommentCreate({ data: { commentCreate: { success: true, comment: { url: "c" } } } })).toEqual({ url: "c" });
    expect(parseCommentCreate({ data: { commentCreate: { success: true } } })).toEqual({ url: null });
    expect(() => parseCommentCreate({ data: { commentCreate: { success: false } } })).toThrow(/did not succeed/i);
  });
});
