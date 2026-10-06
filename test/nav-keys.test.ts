import { test, expect, describe } from "bun:test";
import { navDirection } from "../src/client/index.tsx";

describe("navDirection (dashboard list navigation)", () => {
  test("Ink's parsed arrow flags", () => {
    expect(navDirection("", { upArrow: true })).toBe("up");
    expect(navDirection("", { downArrow: true })).toBe("down");
  });

  test("vim j/k", () => {
    expect(navDirection("k", {})).toBe("up");
    expect(navDirection("j", {})).toBe("down");
  });

  test("raw CSI escape sequences (whole)", () => {
    expect(navDirection("[A", {})).toBe("up");
    expect(navDirection("[B", {})).toBe("down");
  });

  test("ESC-stripped sequences (arrive as a separate chunk under Bun)", () => {
    expect(navDirection("[A", {})).toBe("up");
    expect(navDirection("[B", {})).toBe("down");
  });

  test("application-cursor mode (ESC O A / O B)", () => {
    expect(navDirection("OA", {})).toBe("up");
    expect(navDirection("OB", {})).toBe("down");
    expect(navDirection("OA", {})).toBe("up");
    expect(navDirection("OB", {})).toBe("down");
  });

  test("unrelated keys do not navigate", () => {
    for (const k of ["q", "n", "a", "A", "x", "r", "f", "E", "m", "i", "", "[C", "[D"]) {
      expect(navDirection(k, {})).toBeNull();
    }
  });

  test("the activity toggle 'A' is not mistaken for an arrow", () => {
    expect(navDirection("A", {})).toBeNull();
  });
});
