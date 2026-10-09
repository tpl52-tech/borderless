import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEphemeralInspector } from "../src/daemon/spawn-wait.ts";
import { sessionDir } from "../src/shared/paths.ts";
import type { SessionManager } from "../src/daemon/session-manager.ts";
import type { StatusTracker } from "../src/daemon/monitors/status.ts";

function fakes(id: string, status: "exited" | "done" | "error" | "running") {
  const killed: string[] = [], released: string[] = [];
  const manager = {
    spawn: async () => ({ id }),
    kill: (s: string) => { killed.push(s); },
    releaseWorktree: (s: string) => { released.push(s); },
  } as unknown as SessionManager;
  const tracker = { status: () => status, onChange: () => () => {} } as unknown as StatusTracker;
  return { manager, tracker, killed, released };
}
const cfg = (f: ReturnType<typeof fakes>, home: string, deadlineMs?: number) =>
  ({ manager: f.manager, tracker: f.tracker, repo: "r", taskId: "t", cwd: "/x", home, deadlineMs });

describe("runEphemeralInspector (shared spawn → await → read → cleanup)", () => {
  test("reads the verdict file → {sessionId, raw}, then kills + reaps", async () => {
    const home = mkdtempSync(join(tmpdir(), "bl-insp-"));
    mkdirSync(sessionDir("s1", home), { recursive: true });
    writeFileSync(join(sessionDir("s1", home), "verdict.json"), "HELLO");
    const f = fakes("s1", "exited");
    expect(await runEphemeralInspector(cfg(f, home), "seed", "verdict.json")).toEqual({ sessionId: "s1", raw: "HELLO" });
    expect(f.killed).toEqual(["s1"]);
    expect(f.released).toEqual(["s1"]);
  });

  test("a missing verdict file ⇒ raw '' (fails closed), still cleaned up", async () => {
    const home = mkdtempSync(join(tmpdir(), "bl-insp-"));
    const f = fakes("s2", "done");
    const r = await runEphemeralInspector(cfg(f, home), "seed", "verdict.json");
    expect(r.raw).toBe("");
    expect(f.killed).toEqual(["s2"]);
    expect(f.released).toEqual(["s2"]);
  });

  test("a deadline reject STILL kills + reaps (the finally), then propagates", async () => {
    const home = mkdtempSync(join(tmpdir(), "bl-insp-"));
    const f = fakes("s3", "running"); // never terminal + onChange never fires → the deadline fires
    await expect(runEphemeralInspector(cfg(f, home, 20), "seed", "verdict.json")).rejects.toThrow(/did not finish/);
    expect(f.killed).toEqual(["s3"]); // cleaned up despite the reject
    expect(f.released).toEqual(["s3"]);
  });
});
