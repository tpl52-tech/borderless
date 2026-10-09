import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveVerifyAgentSpawn } from "../src/daemon/verify-agent-spawn.ts";
import { sessionDir } from "../src/shared/paths.ts";
import type { SessionManager } from "../src/daemon/session-manager.ts";
import type { StatusTracker } from "../src/daemon/monitors/status.ts";

function fakes(id: string, status: "exited" | "done" | "error") {
  const killed: string[] = [], released: string[] = [];
  const manager = {
    spawn: async () => ({ id }),
    kill: (s: string) => { killed.push(s); },
    releaseWorktree: (s: string) => { released.push(s); },
  } as unknown as SessionManager;
  const tracker = { status: () => status, onChange: () => () => {} } as unknown as StatusTracker;
  return { manager, tracker, killed, released };
}

describe("liveVerifyAgentSpawn (verify sweep V4c-2 — spawn → read verdict → kill)", () => {
  test("reads the verdict.json the agent wrote, then kills + reaps the session", async () => {
    const home = mkdtempSync(join(tmpdir(), "bl-verify-"));
    const id = "sess-xyz";
    mkdirSync(sessionDir(id, home), { recursive: true });
    writeFileSync(join(sessionDir(id, home), "verdict.json"), '{"findings":[{"criterion":"c","status":"pass","evidence":"e"}]}');

    const f = fakes(id, "exited");
    const spawn = liveVerifyAgentSpawn({ manager: f.manager, tracker: f.tracker, repo: "r", taskId: "t", cwd: "/x", home });
    const raw = await spawn("the seed");
    expect(JSON.parse(raw).findings[0].status).toBe("pass");
    expect(f.killed).toEqual([id]);
    expect(f.released).toEqual([id]);
  });

  test("a missing verdict file ⇒ empty string (fails closed; the parser makes it inconclusive), still cleaned up", async () => {
    const home = mkdtempSync(join(tmpdir(), "bl-verify-"));
    const f = fakes("sess-none", "done");
    const spawn = liveVerifyAgentSpawn({ manager: f.manager, tracker: f.tracker, repo: "r", taskId: "t", cwd: "/x", home });
    expect(await spawn("seed")).toBe("");
    expect(f.killed).toEqual(["sess-none"]); // killed + released even with no verdict
    expect(f.released).toEqual(["sess-none"]);
  });
});
