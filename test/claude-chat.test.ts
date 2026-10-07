import { test, expect, describe } from "bun:test";
import { flattenMessages, parseClaudeCliResult } from "../src/daemon/claude-chat.ts";
import type { Message } from "../src/daemon/openrouter/runner.ts";

describe("flattenMessages (loop transcript → one CLI prompt)", () => {
  test("user turns are bare; other roles are labeled; joined by blank lines", () => {
    const msgs: Message[] = [
      { role: "system", content: "You are Borderless." },
      { role: "user", content: "status?" },
    ];
    expect(flattenMessages(msgs)).toBe("system: You are Borderless.\n\nstatus?");
  });
});

describe("parseClaudeCliResult (claude -p --output-format json → ChatResponse)", () => {
  test("maps result → text; does NOT surface total_cost_usd ($0 marginal on a subscription)", () => {
    expect(parseClaudeCliResult(JSON.stringify({ type: "result", result: "all quiet", is_error: false, total_cost_usd: 0.21 })))
      .toEqual({ text: "all quiet" });
  });

  test("is_error surfaces the result text (or a fallback)", () => {
    expect(parseClaudeCliResult(JSON.stringify({ result: "rate limited", is_error: true, total_cost_usd: 0 })))
      .toEqual({ text: "rate limited" });
    expect(parseClaudeCliResult(JSON.stringify({ is_error: true })).text).toMatch(/error/i);
  });

  test("missing result → undefined text; empty output → undefined", () => {
    expect(parseClaudeCliResult(JSON.stringify({ is_error: false })).text).toBeUndefined();
    expect(parseClaudeCliResult("   ")).toEqual({ text: undefined });
  });

  test("non-JSON output is taken verbatim as the answer", () => {
    expect(parseClaudeCliResult("just a plain answer")).toEqual({ text: "just a plain answer" });
  });
});
