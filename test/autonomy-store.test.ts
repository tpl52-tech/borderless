import { test, expect, describe } from "bun:test";
import { Store } from "../src/daemon/store.ts";

describe("autonomy_actions store (design §6, §13.5)", () => {
  test("recordAction supersedes transient rows but never a terminal one", () => {
    const s = new Store(":memory:");
    s.recordAction({ action: "nudge-agent", dedupeKey: "k", status: "suppressed", gate: "cooldown" });
    // suppressed -> superseded by performed
    s.recordAction({ action: "nudge-agent", dedupeKey: "k", status: "performed" });
    expect(s.getAction("k")!.status).toBe("performed");
    // performed is terminal -> a later suppressed does NOT overwrite it
    s.recordAction({ action: "nudge-agent", dedupeKey: "k", status: "suppressed", gate: "duplicate" });
    expect(s.getAction("k")!.status).toBe("performed");
    expect(s.hasTerminalAction("k")).toBe(true);
  });

  test("failed increments attempts; failedAttemptCount reflects it", () => {
    const s = new Store(":memory:");
    s.recordAction({ action: "request-codex", dedupeKey: "f", status: "failed" });
    s.recordAction({ action: "request-codex", dedupeKey: "f", status: "failed" });
    expect(s.getAction("f")!.attempts).toBe(2);
    expect(s.failedAttemptCount("f")).toBe(2);
  });

  test("countActed windows + filters, excluding manual", () => {
    const s = new Store(":memory:");
    const task = s.createTask({ name: "t" });
    const sess = s.createSession({ taskId: task.id, tool: "claude", location: "local", cwd: "/x" });
    const sid = sess.id;
    s.recordAction({ action: "nudge-agent", dedupeKey: "nudge:o/r#1:a", status: "performed", sessionId: sid });
    s.recordAction({ action: "request-codex", dedupeKey: "request-codex:o/r#1:h", status: "queued", sessionId: sid });
    s.recordAction({ action: "nudge-agent", dedupeKey: "manual:x:1", status: "performed", sessionId: sid }); // manual excluded
    const now = Date.now();
    expect(s.countActed(now - 3_600_000)).toBe(2); // manual excluded
    expect(s.countActed(now - 3_600_000, { sessionId: sid })).toBe(2);
    expect(s.countActed(now - 3_600_000, { externalKey: "o/r#1" })).toBe(2);
    expect(s.countActed(now - 3_600_000, { action: "nudge-agent" })).toBe(1);
    expect(s.listActions().length).toBe(3);
  });
});
