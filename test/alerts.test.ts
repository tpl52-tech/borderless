import { test, expect, describe } from "bun:test";
import { createAlertDispatcher, type AlertVerdict } from "../src/daemon/alerts.ts";
import { Store } from "../src/daemon/store.ts";
import type { Alert } from "../src/shared/types.ts";

describe("alert store (design §6, §15.1)", () => {
  test("recordAlert dedupes by key", () => {
    const s = new Store(":memory:");
    const a = s.recordAlert({ kind: "ci-failed", dedupeKey: "k1", summary: "red" });
    const b = s.recordAlert({ kind: "ci-failed", dedupeKey: "k1", summary: "red again" });
    expect(b.id).toBe(a.id);
    expect(s.listAlerts().length).toBe(1);
  });
});

describe("alert dispatcher (design §15.1)", () => {
  function setup(narrate: (a: Alert[]) => Promise<AlertVerdict>, dryRun = false) {
    const s = new Store(":memory:");
    const alert = s.recordAlert({ kind: "ready-to-merge", dedupeKey: "k", summary: "ready" });
    let nowVal = alert.createdAt;
    const d = createAlertDispatcher({ store: s, narrate, dryRun, now: () => nowVal });
    return { s, alert, d, setNow: (v: number) => { nowVal = v; } };
  }

  test("debounces: within 30s nothing is notified; after 30s it narrates + delivers", async () => {
    let calls = 0;
    const { s, alert, d, setNow } = setup(async () => { calls++; return { delivered: [alert!.id], suppressed: [] }; });
    setNow(alert.createdAt + 10_000);
    await d.tick();
    expect(calls).toBe(0);
    expect(s.getAlert(alert.id)!.notifiedAt).toBeNull();

    setNow(alert.createdAt + 40_000);
    await d.tick();
    expect(calls).toBe(1);
    const after = s.getAlert(alert.id)!;
    expect(after.attempts).toBe(1); // marked notified BEFORE narrating
    expect(after.deliveredAt).not.toBeNull();
  });

  test("forgotten ids are suppressed", async () => {
    const { s, alert, d, setNow } = setup(async () => ({ delivered: [], suppressed: [] }));
    setNow(alert.createdAt + 40_000);
    await d.tick();
    expect(s.getAlert(alert.id)!.suppressedAt).not.toBeNull();
  });

  test("narrator failure releases for retry (attempts incremented, not delivered)", async () => {
    const { s, alert, d, setNow } = setup(async () => { throw new Error("boom"); });
    setNow(alert.createdAt + 40_000);
    await d.tick();
    const after = s.getAlert(alert.id)!;
    expect(after.attempts).toBe(1);
    expect(after.deliveredAt).toBeNull();
    expect(after.suppressedAt).toBeNull();
    expect(s.pendingAlerts().length).toBe(1); // still eligible
  });

  test("dry-run never narrates", async () => {
    let calls = 0;
    const { alert, d, setNow } = setup(async () => { calls++; return { delivered: [], suppressed: [] }; }, true);
    setNow(alert.createdAt + 40_000);
    await d.tick();
    expect(calls).toBe(0);
  });
});
