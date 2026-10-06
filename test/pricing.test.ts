import { test, expect, describe } from "bun:test";
import { priceForModel, valuate } from "../src/shared/pricing.ts";

describe("priceForModel (longest-prefix, design §15.2)", () => {
  test("matches model families", () => {
    expect(priceForModel("claude-opus-4-8-20260101")?.outputPerMTok).toBe(75);
    expect(priceForModel("claude-sonnet-5")?.inputPerMTok).toBe(3);
    expect(priceForModel("gpt-4o")?.inputPerMTok).toBe(2.5);
  });
  test("unknown model -> null (never zero)", () => {
    expect(priceForModel("some-random-model")).toBeNull();
  });
});

describe("valuate (cache multipliers, design §15.2)", () => {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
  test("input + output in micros", () => {
    expect(valuate("claude-sonnet-5", { ...zero, input: 1_000_000, output: 1_000_000 })).toBe(18_000_000); // $3 + $15
  });
  test("cache read is 0.1x input; 5m write 1.25x; 1h write 2x", () => {
    expect(valuate("claude-sonnet-5", { ...zero, cacheRead: 1_000_000 })).toBe(300_000);   // $3 * 0.1
    expect(valuate("claude-sonnet-5", { ...zero, cacheWrite5m: 1_000_000 })).toBe(3_750_000); // $3 * 1.25
    expect(valuate("claude-sonnet-5", { ...zero, cacheWrite1h: 1_000_000 })).toBe(6_000_000);  // $3 * 2
  });
  test("unknown model valuates to null", () => {
    expect(valuate("nope", { ...zero, input: 1_000_000 })).toBeNull();
  });
});
