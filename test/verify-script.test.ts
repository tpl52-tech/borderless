import { test, expect, describe } from "bun:test";
import { buildVerifyScript } from "../src/daemon/verify-script.ts";
import type { Chat } from "../src/daemon/openrouter/runner.ts";

describe("buildVerifyScript (PRD §13 V1 — human-QA script over an injected LLM)", () => {
  test("classifies, sends a UI-focused prompt, returns the LLM's script", async () => {
    let seen = "";
    const chat: Chat = async (messages) => { seen = messages[0]!.content; return { text: "Before you start…\n1. Tap the heart ✅" }; };
    const out = await buildVerifyScript(
      { identifier: "COR-35", title: "Favorites", description: "tap a heart; favorites have an RLS policy" },
      ["supabase/policies/favorites.sql"], chat,
    );
    expect(out).toContain("Tap the heart");
    expect(seen).toContain("COR-35");
    expect(seen).toContain("do NOT write steps for them: rls"); // the classification fed the prompt
  });

  test("an empty LLM response yields a placeholder, never undefined", async () => {
    const chat: Chat = async () => ({ text: "" });
    expect(await buildVerifyScript({ identifier: "COR-1", title: "x", description: null }, [], chat)).toBe("(no script generated)");
  });
});
