import { test, expect, describe } from "bun:test";
import { resolveChatSeed, parseResolveTurns, type ResolveChatContext } from "../src/shared/resolve-chat.ts";

const ctx = (over: Partial<ResolveChatContext> = {}): ResolveChatContext => ({
  ticketKey: "COR-102", title: "Home screen", description: "- [ ] Recommended/Deals section", state: "needs_human",
  reason: "judgment call: how to derive Recommended/Deals", prNumber: 34, ...over,
});

describe("resolveChatSeed", () => {
  test("embeds ticket, state, the escalation reason, PR, and the ACs; framed advisory", () => {
    const s = resolveChatSeed(ctx());
    expect(s).toContain("COR-102: Home screen");
    expect(s).toContain("needs_human");
    expect(s).toContain("PR #34");
    expect(s).toContain("judgment call: how to derive Recommended/Deals");
    expect(s).toContain("Recommended/Deals section");
    expect(s).toContain("advice for the lead"); // advisory — the chat can't act
  });

  test("tolerates missing fields", () => {
    const s = resolveChatSeed(ctx({ title: null, description: null, reason: null, prNumber: null, state: null }));
    expect(s).toContain("(title unknown)");
    expect(s).toContain("(no reason recorded)");
    expect(s).toContain("No ticket body was synced");
    expect(s).not.toContain("PR #");
  });

  test("truncates a pathologically long body", () => {
    const s = resolveChatSeed(ctx({ description: "x".repeat(5000) }));
    expect(s).toContain("…(truncated)");
    expect(s).not.toContain("x".repeat(4001));
  });
});

describe("parseResolveTurns", () => {
  test("keeps valid turns, drops empties, defaults unknown/absent roles to user", () => {
    const turns = parseResolveTurns([
      { role: "user", text: "why auth?" },
      { role: "assistant", text: "it touches login" },
      { role: "weird", text: "kept as user" },
      { role: "user", text: "   " }, // empty after trim → dropped
      { text: "no role" },           // → user
      "garbage",                      // → {} → empty → dropped
    ]);
    expect(turns).toEqual([
      { role: "user", text: "why auth?" },
      { role: "assistant", text: "it touches login" },
      { role: "user", text: "kept as user" },
      { role: "user", text: "no role" },
    ]);
  });

  test("non-array → []", () => {
    expect(parseResolveTurns(null)).toEqual([]);
    expect(parseResolveTurns("x")).toEqual([]);
  });
});
