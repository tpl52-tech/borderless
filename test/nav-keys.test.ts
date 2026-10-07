import { test, expect, describe } from "bun:test";
import { navDirection } from "../src/client/runtime.ts";

// ESC written as an explicit \x1b so the four real arrow forms are visible in source (a literal ESC byte
// renders invisibly and reads as a duplicate of its stripped form).
describe("navDirection (list navigation)", () => {
  test("Ink's parsed arrow flags", () => {
    expect(navDirection("", { upArrow: true })).toBe("up");
    expect(navDirection("", { downArrow: true })).toBe("down");
  });

  test("vim j/k", () => {
    expect(navDirection("k", {})).toBe("up");
    expect(navDirection("j", {})).toBe("down");
  });

  test("raw CSI escape sequences (whole, with ESC)", () => {
    expect(navDirection("\x1b[A", {})).toBe("up");
    expect(navDirection("\x1b[B", {})).toBe("down");
  });

  test("ESC-stripped CSI (arrives as a separate chunk under Bun)", () => {
    expect(navDirection("[A", {})).toBe("up");
    expect(navDirection("[B", {})).toBe("down");
  });

  test("application-cursor mode (SS3), with ESC and stripped", () => {
    expect(navDirection("\x1bOA", {})).toBe("up");
    expect(navDirection("\x1bOB", {})).toBe("down");
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
