import { test, expect, describe } from "bun:test";
import { joinRoster } from "../src/daemon/box/roster.ts";

describe("joinRoster (design §17.2)", () => {
  test("only ao- names, prefix must match exactly one uuid dir; ambiguous/zero dropped", () => {
    const r = joinRoster({
      tmuxNames: ["ao-abc12345", "ao-def67890", "ao-zzz00000", "unrelated"],
      uuidDirs: ["abc12345aaaa", "def67890bbbb"],
      liveClaude: new Set(),
      lastEvent: {},
    });
    const ids = r.map((e) => e.sessionId).sort();
    expect(ids).toEqual(["abc12345aaaa", "def67890bbbb"]); // zzz00000 (no dir) + "unrelated" dropped
  });

  test("ambiguous prefix (two matching dirs) is dropped, never guessed", () => {
    const r = joinRoster({
      tmuxNames: ["ao-abc12345"],
      uuidDirs: ["abc12345one", "abc12345two"],
      liveClaude: new Set(), lastEvent: {},
    });
    expect(r.length).toBe(0);
  });

  test("activity: live claude wins; else events; neither -> unknown (never idle)", () => {
    const r = joinRoster({
      tmuxNames: ["ao-aaaa1111", "ao-bbbb2222", "ao-cccc3333"],
      uuidDirs: ["aaaa1111x", "bbbb2222x", "cccc3333x"],
      liveClaude: new Set(["aaaa1111x"]),
      lastEvent: { "bbbb2222x": "done" }, // cccc3333x has no event
    });
    const by = Object.fromEntries(r.map((e) => [e.sessionId, e.activity]));
    expect(by["aaaa1111x"]).toBe("busy");    // live claude
    expect(by["bbbb2222x"]).toBe("idle");    // events "done"
    expect(by["cccc3333x"]).toBe("unknown"); // neither -> unknown, NOT idle
  });

  test("event mapping", () => {
    const mk = (ev: string) => joinRoster({ tmuxNames: ["ao-aaaa1111"], uuidDirs: ["aaaa1111x"], liveClaude: new Set(), lastEvent: { "aaaa1111x": ev } })[0]!.activity;
    expect(mk("working")).toBe("busy");
    expect(mk("starting")).toBe("busy");
    expect(mk("needs-input")).toBe("waiting");
    expect(mk("done")).toBe("idle");
    expect(mk("weird")).toBe("unknown");
  });
});
