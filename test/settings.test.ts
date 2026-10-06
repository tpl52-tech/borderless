import { test, expect, describe } from "bun:test";
import {
  parseSettings, diffSettings, applyTicketPlaceholder, DEFAULT_SETTINGS,
} from "../src/shared/settings.ts";

describe("parseSettings (design §4.4)", () => {
  test("empty / malformed -> defaults, never throws", () => {
    expect(parseSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("garbage")).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings(42)).toEqual(DEFAULT_SETTINGS);
  });

  test("merges known fields, ignores junk, keeps defaults for the rest", () => {
    const s = parseSettings({
      spawnDefaults: { tool: "codex", permissions: "ask", model: "gpt", nonsense: true },
      focus: { agentSilenceMs: 5000, prSilenceMs: "bad" },
      ticketPrompt: "hi {TICKET}",
    });
    expect(s.spawnDefaults.tool).toBe("codex");
    expect(s.spawnDefaults.permissions).toBe("ask");
    expect(s.spawnDefaults.model).toBe("gpt");
    expect(s.spawnDefaults.usesWorktree).toBe(DEFAULT_SETTINGS.spawnDefaults.usesWorktree);
    expect(s.focus.agentSilenceMs).toBe(5000);
    expect(s.focus.prSilenceMs).toBe(DEFAULT_SETTINGS.focus.prSilenceMs); // "bad" -> default
    expect(s.ticketPrompt).toBe("hi {TICKET}");
  });

  test("rejects an out-of-range enum, falling back to default", () => {
    const s = parseSettings({ spawnDefaults: { tool: "wat", effort: "ultra" } });
    expect(s.spawnDefaults.tool).toBe(DEFAULT_SETTINGS.spawnDefaults.tool);
    expect(s.spawnDefaults.effort).toBe(DEFAULT_SETTINGS.spawnDefaults.effort);
  });
});

describe("diffSettings (only non-defaults persist)", () => {
  test("defaults diff to {}", () => {
    expect(diffSettings(DEFAULT_SETTINGS)).toEqual({});
  });

  test("captures only what differs", () => {
    const s = structuredClone(DEFAULT_SETTINGS);
    s.spawnDefaults.tool = "codex";
    s.focus.agentSilenceMs = 1234;
    s.ticketPrompt = "x";
    expect(diffSettings(s)).toEqual({
      spawnDefaults: { tool: "codex" },
      focus: { agentSilenceMs: 1234 },
      ticketPrompt: "x",
    });
  });
});

describe("applyTicketPlaceholder", () => {
  test("replaces every {TICKET} with the uppercased id", () => {
    expect(applyTicketPlaceholder("do {TICKET} then {TICKET}", "hos-12")).toBe("do HOS-12 then HOS-12");
  });
});
