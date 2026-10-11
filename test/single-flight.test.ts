import { test, expect, describe } from "bun:test";
import { singleFlight } from "../src/shared/single-flight.ts";

describe("singleFlight", () => {
  test("concurrent calls with the same key share ONE invocation", async () => {
    let calls = 0;
    let resolve!: (v: number) => void;
    const fn = singleFlight((_k: string) => { calls++; return new Promise<number>((r) => { resolve = r; }); }, (k) => k);
    const a = fn("x"), b = fn("x"); // b joins a's in-flight run
    expect(calls).toBe(1);
    resolve(42);
    expect(await a).toBe(42);
    expect(await b).toBe(42);
  });

  test("different keys run independently", async () => {
    let calls = 0;
    const fn = singleFlight(async (k: string) => { calls++; return k; }, (k) => k);
    await Promise.all([fn("a"), fn("b")]);
    expect(calls).toBe(2);
  });

  test("after the in-flight call settles, the next call runs fresh", async () => {
    let calls = 0;
    const fn = singleFlight(async (_k: string) => { calls++; return calls; }, (k) => k);
    expect(await fn("x")).toBe(1);
    expect(await fn("x")).toBe(2); // re-invoked once the first settled
    expect(calls).toBe(2);
  });

  test("a rejection reaches all joiners AND clears the key so a retry runs", async () => {
    let calls = 0;
    const fn = singleFlight(async (_k: string) => { calls++; if (calls === 1) throw new Error("boom"); return "ok"; }, (k) => k);
    const a = fn("x"), b = fn("x");
    await expect(a).rejects.toThrow("boom");
    await expect(b).rejects.toThrow("boom"); // joined the same rejected run
    expect(calls).toBe(1);
    expect(await fn("x")).toBe("ok"); // key cleared → a fresh run
    expect(calls).toBe(2);
  });
});
