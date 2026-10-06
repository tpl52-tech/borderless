import { test, expect, describe } from "bun:test";
import { parseAutonomyConfig, SAFE_ACTIONS } from "../src/daemon/autonomy/config.ts";

describe("parseAutonomyConfig (design §13.6)", () => {
  test("unset / 0 -> disabled", () => {
    expect(parseAutonomyConfig({}).enabled).toBe(false);
    expect(parseAutonomyConfig({ AO_AUTONOMY: "0" }).enabled).toBe(false);
  });
  test("=1 enables EXACTLY the safe set (named-only actions stay off)", () => {
    const c = parseAutonomyConfig({ AO_AUTONOMY: "1" });
    expect(c.enabled).toBe(true);
    expect([...c.actions].sort()).toEqual([...SAFE_ACTIONS].sort());
    expect(c.actions.has("request-cto")).toBe(false);
    expect(c.actions.has("thermo-regrade")).toBe(false);
  });
  test("a comma list enables exactly those actions", () => {
    const c = parseAutonomyConfig({ AO_AUTONOMY: "nudge-agent,request-cto,thermo-regrade" });
    expect(c.enabled).toBe(true);
    expect(c.actions.has("request-cto")).toBe(true);
    expect(c.actions.has("thermo-regrade")).toBe(true);
    expect(c.actions.has("request-codex")).toBe(false);
  });
  test("dry-run, sessions and locations", () => {
    const c = parseAutonomyConfig({
      AO_AUTONOMY: "1", AO_AUTONOMY_DRY_RUN: "1",
      AO_AUTONOMY_SESSIONS: "s1, s2", AO_AUTONOMY_LOCATIONS: "devbox",
    });
    expect(c.dryRun).toBe(true);
    expect(c.sessions).toEqual(new Set(["s1", "s2"]));
    expect(c.locations).toEqual(new Set(["devbox"]) as any);
    expect(parseAutonomyConfig({ AO_AUTONOMY: "1" }).sessions).toBeNull(); // unset = all
  });
});
