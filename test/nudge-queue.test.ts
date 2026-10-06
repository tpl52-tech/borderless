import { test, expect, describe } from "bun:test";
import { NudgeQueue } from "../src/daemon/nudge/queue.ts";

const nudge = (over: Partial<{ key: string; body: string; manual: boolean }> = {}) =>
  ({ key: "k", body: "b", settleKeys: [], manual: false, ...over });

describe("NudgeQueue (design §10.5)", () => {
  test("caps at 2 pending per session", () => {
    const q = new NudgeQueue();
    expect(q.enqueue("s", nudge({ key: "a" }))).toBe("queued");
    expect(q.enqueue("s", nudge({ key: "b" }))).toBe("queued");
    expect(q.enqueue("s", nudge({ key: "c" }))).toBe("rejected-full");
    expect(q.size("s")).toBe(2);
  });

  test("dedupes autonomous by key; a manual message is never deduped", () => {
    const q = new NudgeQueue();
    expect(q.enqueue("s", nudge({ key: "same" }))).toBe("queued");
    expect(q.enqueue("s", nudge({ key: "same" }))).toBe("deduped");
    // manual with a colliding key is still accepted (its key is really a unique UUID)
    expect(q.enqueue("s", nudge({ key: "same", manual: true }))).toBe("queued");
  });

  test("holdFront re-inserts at the front and increments holds", () => {
    const q = new NudgeQueue();
    q.enqueue("s", nudge({ key: "a" }));
    const held = { key: "held", body: "h", settleKeys: [], manual: false, holds: 0 };
    q.holdFront("s", held);
    const front = q.peek("s")!;
    expect(front.key).toBe("held");
    expect(front.holds).toBe(1);
  });

  test("clearAutonomous drops autonomous entries but keeps manual (planning, §10.6)", () => {
    const q = new NudgeQueue();
    q.enqueue("s", nudge({ key: "auto", manual: false }));
    q.enqueue("s", nudge({ key: "manual", manual: true }));
    q.clearAutonomous("s");
    expect(q.size("s")).toBe(1);
    expect(q.peek("s")!.manual).toBe(true);
  });
});
