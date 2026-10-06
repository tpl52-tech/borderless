import { test, expect, describe } from "bun:test";
import { classifyWindow, pruneExpired, type QuotaWindow } from "../src/daemon/monitors/quota.ts";

describe("quota window classification (design §15.3)", () => {
  test("windows >= 1440 min are weekly", () => {
    expect(classifyWindow(60)).toBe("short");
    expect(classifyWindow(300)).toBe("short");
    expect(classifyWindow(1440)).toBe("weekly");
    expect(classifyWindow(10080)).toBe("weekly");
  });
  test("pruneExpired drops windows whose reset has passed", () => {
    const now = 1_000_000;
    const windows: QuotaWindow[] = [
      { kind: "short", utilization: 0.5, resetsAt: now - 1 },
      { kind: "weekly", utilization: 0.2, resetsAt: now + 1000 },
      { kind: "short", utilization: 0.1, resetsAt: null },
    ];
    expect(pruneExpired(windows, now).length).toBe(2);
  });
});
