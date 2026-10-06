import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAutonomy } from "../src/daemon/autonomy/index.ts";
import { nudgeKey } from "../src/daemon/autonomy/keys.ts";
import { Store } from "../src/daemon/store.ts";
import { defaultOperatorConfig } from "../src/shared/config.ts";
import type { StatusTracker } from "../src/daemon/monitors/status.ts";
import type { NudgeDelivery } from "../src/daemon/nudge/index.ts";

let home: string | null = null;
afterEach(() => { if (home) rmSync(home, { recursive: true, force: true }); home = null; });

describe("autonomy loop end to end (design §13)", () => {
  test("a failing PR with an idle agent gets a nudge queued + an audit row", async () => {
    home = mkdtempSync(join(tmpdir(), "ao-auto-"));
    const store = new Store(join(home, "store.sqlite"));
    const task = store.createTask({ name: "t" });
    const session = store.createSession({ taskId: task.id, tool: "claude", location: "local", cwd: "/x" });
    const wi = store.upsertWorkItem({
      sessionId: session.id, kind: "pr", externalKey: "o/r#1", number: 1, repo: "o/r",
      prState: "OPEN", ciState: "failure", failedChecks: ["build"], mergeable: "MERGEABLE",
      headSha: "h", codexState: "none", ctoState: "none",
    });

    const tracker = { status: () => "done" } as unknown as StatusTracker; // idle agent
    const enq: Array<{ body: string }> = [];
    const nudge = { enqueue: (r: { body: string }) => { enq.push(r); return "queued" as const; }, clearAutonomous() {}, forget() {}, stop() {} } as unknown as NudgeDelivery;

    const engine = startAutonomy({
      store, tracker, nudge,
      config: { enabled: true, actions: new Set(["nudge-agent"]), dryRun: false, always: true, sessions: null, locations: null },
      operatorConfig: defaultOperatorConfig(), home,
      emit: () => {},
    });
    await engine.tickNow();
    engine.stop();

    expect(enq.length).toBe(1);
    expect(enq[0]!.body).toContain("CI is failing");
    expect(store.getAction(nudgeKey(wi))!.status).toBe("queued");
  });

  test("dry-run records dry-run and never enqueues", async () => {
    home = mkdtempSync(join(tmpdir(), "ao-auto-"));
    const store = new Store(join(home, "store.sqlite"));
    const task = store.createTask({ name: "t" });
    const session = store.createSession({ taskId: task.id, tool: "claude", location: "local", cwd: "/x" });
    const wi = store.upsertWorkItem({
      sessionId: session.id, kind: "pr", externalKey: "o/r#1", number: 1, repo: "o/r",
      prState: "OPEN", ciState: "failure", failedChecks: ["build"], mergeable: "MERGEABLE", headSha: "h",
      codexState: "none", ctoState: "none",
    });
    const tracker = { status: () => "done" } as unknown as StatusTracker;
    const enq: unknown[] = [];
    const nudge = { enqueue: (r: unknown) => { enq.push(r); return "queued" as const; }, clearAutonomous() {}, forget() {}, stop() {} } as unknown as NudgeDelivery;

    const engine = startAutonomy({
      store, tracker, nudge,
      config: { enabled: true, actions: new Set(["nudge-agent"]), dryRun: true, always: true, sessions: null, locations: null },
      operatorConfig: defaultOperatorConfig(), home, emit: () => {},
    });
    await engine.tickNow();
    engine.stop();

    expect(enq.length).toBe(0);
    expect(store.getAction(nudgeKey(wi))!.status).toBe("dry-run");
  });
});
