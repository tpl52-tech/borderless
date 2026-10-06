import { test, expect, describe } from "bun:test";
import { parseClaudeUsage, sumByModel } from "../src/daemon/monitors/usage.ts";
import { Store } from "../src/daemon/store.ts";

const lines = [
  JSON.stringify({ message: { id: "m1", model: "claude-sonnet-5", usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 } } }),
  JSON.stringify({ message: { id: "m1", model: "claude-sonnet-5", usage: { input_tokens: 100, output_tokens: 50 } } }), // consecutive dup id -> skipped
  JSON.stringify({ message: { id: "m2", model: "claude-sonnet-5", usage: { input_tokens: 200, output_tokens: 80 } } }),
  JSON.stringify({ type: "user" }), // no usage -> skipped
  "not json",                        // -> skipped
];

describe("parseClaudeUsage (design §15.2)", () => {
  test("dedupes consecutive-duplicate message ids and skips non-usage lines", () => {
    const deltas = parseClaudeUsage(lines);
    expect(deltas.length).toBe(2);
    const sum = sumByModel(deltas).get("claude-sonnet-5")!;
    expect(sum).toEqual({ model: "claude-sonnet-5", input: 300, output: 130, cacheRead: 10, cacheWrite: 5 });
  });
});

describe("usage store accumulation (design §6)", () => {
  test("accumulateUsage sums; usageProgress round-trips", () => {
    const s = new Store(":memory:");
    s.accumulateUsage("sess", "claude-sonnet-5", { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, costMicros: 1000 });
    s.accumulateUsage("sess", "claude-sonnet-5", { input: 200, output: 80, cacheRead: 0, cacheWrite: 0, costMicros: 2000 });
    const totals = s.usageTotals();
    expect(totals.length).toBe(1);
    expect(totals[0]!.input).toBe(300);
    expect(totals[0]!.output).toBe(130);
    expect(totals[0]!.costMicros).toBe(3000);

    expect(s.usageProgress("sess", "/t.jsonl")).toBe(0);
    s.setUsageProgress("sess", "/t.jsonl", 4096);
    expect(s.usageProgress("sess", "/t.jsonl")).toBe(4096);
  });
});
