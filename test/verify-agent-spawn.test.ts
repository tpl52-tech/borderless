import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveVerifyAgentSpawn } from "../src/daemon/verify-agent-spawn.ts";
import { sessionDir } from "../src/shared/paths.ts";
import type { SessionManager } from "../src/daemon/session-manager.ts";
import type { StatusTracker } from "../src/daemon/monitors/status.ts";

// liveVerifyAgentSpawn is a thin wrapper over runEphemeralInspector (unit-tested thoroughly in
// spawn-wait.test.ts); here we just confirm it threads the verify verdict file through and hands
// back the raw contents as the `spawn` runVerifyAgent (V4b) expects.
describe("liveVerifyAgentSpawn (verify sweep V4c-2)", () => {
  test("returns the raw verdict.json the agent wrote under $AO_SESSION_DIR", async () => {
    const home = mkdtempSync(join(tmpdir(), "bl-verify-"));
    const id = "sess-xyz";
    mkdirSync(sessionDir(id, home), { recursive: true });
    writeFileSync(join(sessionDir(id, home), "verdict.json"), '{"findings":[{"criterion":"c","status":"pass","evidence":"e"}]}');

    const manager = {
      spawn: async () => ({ id }),
      kill: () => {},
      releaseWorktree: () => {},
    } as unknown as SessionManager;
    const tracker = { status: () => "exited", onChange: () => () => {} } as unknown as StatusTracker;

    const spawn = liveVerifyAgentSpawn({ manager, tracker, repo: "r", taskId: "t", cwd: "/x", home });
    expect(JSON.parse(await spawn("the seed")).findings[0].status).toBe("pass");
  });
});
