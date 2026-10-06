import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  StatusMachine, createStatusTracker, DONE_QUIET_MS, STUCK_CEILING_MS, NEEDS_INPUT_OVERTURN_MS,
  type StatusTracker,
} from "../src/daemon/monitors/status.ts";
import { statusStyle, taskRollupStatus, needsAttention, ATTENTION_RANK } from "../src/shared/status.ts";

describe("StatusMachine (design §10.1)", () => {
  test("starts in `starting`, goes `working` on output", () => {
    const m = new StatusMachine(0);
    expect(m.getStatus()).toBe("starting");
    m.onOutput(100);
    expect(m.getStatus()).toBe("working");
  });

  test("working -> done after >=4s quiet; done -> working on new output", () => {
    const m = new StatusMachine(0);
    m.onOutput(100);
    expect(m.tick(100 + DONE_QUIET_MS - 1)).toBe(false);
    expect(m.getStatus()).toBe("working");
    expect(m.tick(100 + DONE_QUIET_MS)).toBe(true);
    expect(m.getStatus()).toBe("done");
    m.onOutput(10_000);
    expect(m.getStatus()).toBe("working");
  });

  test("a hook sets state directly and holds needs-input against output", () => {
    const m = new StatusMachine(0);
    m.onHook(1000, "needs-input");
    expect(m.getStatus()).toBe("needs-input");
    m.onOutput(2000); // hook holds — output does not clear it
    expect(m.getStatus()).toBe("needs-input");
    m.onHook(3000, "done");
    expect(m.getStatus()).toBe("done");
  });

  test("needs-input overturns to working after 90s WITH recent output; silence keeps it", () => {
    const held = new StatusMachine(0);
    held.onHook(0, "needs-input");
    held.tick(NEEDS_INPUT_OVERTURN_MS + 5000); // silent -> stays needs-input
    expect(held.getStatus()).toBe("needs-input");

    const busy = new StatusMachine(0);
    busy.onHook(0, "needs-input");
    busy.onOutput(NEEDS_INPUT_OVERTURN_MS); // recent output within the idle window
    expect(busy.tick(NEEDS_INPUT_OVERTURN_MS)).toBe(true);
    expect(busy.getStatus()).toBe("working");
  });

  test("working >=60min -> stuck; stuck is not cleared by bytes", () => {
    const m = new StatusMachine(0);
    m.onOutput(0);
    m.onOutput(STUCK_CEILING_MS - 1); // keep lastActivity fresh so it isn't `done`
    expect(m.tick(STUCK_CEILING_MS)).toBe(true);
    expect(m.getStatus()).toBe("stuck");
    m.onOutput(STUCK_CEILING_MS + 1);
    expect(m.getStatus()).toBe("stuck"); // bytes don't un-stick
  });

  test("exit is terminal", () => {
    const m = new StatusMachine(0);
    m.onOutput(100);
    m.onExit(200, "error");
    expect(m.getStatus()).toBe("error");
    expect(m.tick(999_999)).toBe(false);
    m.onOutput(1_000_000);
    expect(m.getStatus()).toBe("error");
  });
});

describe("status presentation (§10.1, §19)", () => {
  test("every status has a glyph + label", () => {
    for (const s of ["starting", "working", "done", "needs-input", "stuck", "error", "exited"] as const) {
      expect(statusStyle(s).glyph.length).toBeGreaterThan(0);
      expect(statusStyle(s).label.length).toBeGreaterThan(0);
    }
  });

  test("task rollup picks the highest-attention status", () => {
    expect(taskRollupStatus(["working", "needs-input", "done"])).toBe("needs-input");
    expect(taskRollupStatus(["working", "done"])).toBe("done");
    expect(taskRollupStatus([])).toBeNull();
    expect(ATTENTION_RANK["needs-input"]).toBeGreaterThan(ATTENTION_RANK.done);
  });

  test("needsAttention flags the three states", () => {
    expect(needsAttention("needs-input")).toBe(true);
    expect(needsAttention("done")).toBe(true);
    expect(needsAttention("error")).toBe(true);
    expect(needsAttention("working")).toBe(false);
  });
});

describe("StatusTracker hook watcher (§10.2)", () => {
  let tracker: StatusTracker | null = null;
  let home: string | null = null;

  afterEach(() => {
    tracker?.stop();
    if (home) rmSync(home, { recursive: true, force: true });
    tracker = null; home = null;
  });

  test("reads events.log lines and reports needs-input; emits onChange", async () => {
    home = mkdtempSync(join(tmpdir(), "ao-status-"));
    const id = "sess-1";
    mkdirSync(join(home, "sessions", id), { recursive: true });
    writeFileSync(join(home, "sessions", id, "events.log"), `${Date.now()} needs-input\n`);

    tracker = createStatusTracker({ home });
    const changes: string[] = [];
    tracker.onChange((e) => { if (e.sessionId === id) changes.push(e.status); });
    tracker.register(id);
    tracker.start();

    await waitFor(() => tracker!.status(id) === "needs-input");
    expect(changes).toContain("needs-input");

    // A subsequent `done` line advances the byte offset and is applied once.
    appendFileSync(join(home, "sessions", id, "events.log"), `${Date.now()} done\n`);
    await waitFor(() => tracker!.status(id) === "done");
  });
});

async function waitFor(fn: () => boolean, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (fn()) return;
    await Bun.sleep(25);
  }
  throw new Error("timed out waiting for condition");
}
