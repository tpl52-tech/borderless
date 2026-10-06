import { test, expect, describe } from "bun:test";
import { buildSpawnSpec, type SpawnRequest } from "../src/shared/spawn-spec.ts";

const base: Omit<SpawnRequest, "tool"> = {
  sessionId: "S123abcd", cwd: "/x", model: "auto", effort: null, permissions: "full-access",
  isResume: false, bunPath: "/bun", hookNotifyPath: "/hook", sessionDir: "/sd",
};

describe("claude (design §7.2)", () => {
  test("fresh: --session-id, permission mode, append-system-prompt, --settings with hooks; seed positional", () => {
    const spec = buildSpawnSpec({ ...base, tool: "claude", resumeHandle: "UUID", seed: "do it" });
    expect(spec.argv).toContain("claude");
    expect(spec.argv).toContain("--session-id");
    expect(spec.argv[spec.argv.indexOf("--session-id") + 1]).toBe("UUID");
    expect(spec.argv).not.toContain("--model"); // auto omitted
    expect(spec.argv[spec.argv.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
    expect(spec.argv).toContain("--append-system-prompt");
    expect(spec.argv[spec.argv.length - 1]).toBe("do it"); // seed positional last
    expect(spec.deferSeedPrompt).toBe(false);
    expect(spec.env.AO_SESSION_ID).toBe("S123abcd");

    const settings = JSON.parse(spec.argv[spec.argv.indexOf("--settings") + 1]!);
    const notif = settings.hooks.Notification;
    expect(notif[0].matcher).toBe("permission_prompt");
    expect(notif[0].hooks[0].command).toBe("/bun /hook needs-input");
    expect(settings.hooks.Stop[0].hooks[0].command).toBe("/bun /hook done");
  });

  test("resume: --resume <handle>, no --session-id, no seed", () => {
    const spec = buildSpawnSpec({ ...base, tool: "claude", isResume: true, resumeHandle: "UUID", seed: "x" });
    expect(spec.argv).toContain("--resume");
    expect(spec.argv).not.toContain("--session-id");
    expect(spec.argv).not.toContain("x");
  });

  test("a ticket seed on fresh claude is DEFERRED (not in argv)", () => {
    const spec = buildSpawnSpec({ ...base, tool: "claude", resumeHandle: "U", seed: "big seed", seedIsTicket: true });
    expect(spec.deferSeedPrompt).toBe(true);
    expect(spec.argv).not.toContain("big seed");
  });

  test("model + effort flags when set", () => {
    const spec = buildSpawnSpec({ ...base, tool: "claude", model: "opus", effort: "high", resumeHandle: "U" });
    expect(spec.argv[spec.argv.indexOf("--model") + 1]).toBe("opus");
    expect(spec.argv[spec.argv.indexOf("--effort") + 1]).toBe("high");
  });
});

describe("codex (design §7.2)", () => {
  test("full-access sandbox flag + notify hook + positional seed", () => {
    const spec = buildSpawnSpec({ ...base, tool: "codex", effort: "high", seed: "task" });
    expect(spec.argv[0]).toBe("codex");
    expect(spec.argv).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(spec.argv[spec.argv.indexOf("-c") + 1]).toBe("model_reasoning_effort=high");
    expect(spec.argv).toContain(`notify=["/bun","/hook","codex-event"]`);
    expect(spec.argv[spec.argv.length - 1]).toBe("task");
    expect(spec.deferSeedPrompt).toBe(false); // codex never defers
  });

  test("auto-edits maps to on-request + workspace-write", () => {
    const spec = buildSpawnSpec({ ...base, tool: "codex", permissions: "auto-edits" });
    expect(spec.argv).toContain("--ask-for-approval");
    expect(spec.argv).toContain("workspace-write");
  });

  test("resume with a discovered id, else --last", () => {
    expect(buildSpawnSpec({ ...base, tool: "codex", isResume: true, resumeHandle: "cx-1" }).argv.slice(0, 3))
      .toEqual(["codex", "resume", "cx-1"]);
    expect(buildSpawnSpec({ ...base, tool: "codex", isResume: true, resumeHandle: null }).argv.slice(0, 3))
      .toEqual(["codex", "resume", "--last"]);
  });
});

describe("copilot (design §7.2)", () => {
  test("fresh --name, --allow-all-tools beyond ask, seed via -i", () => {
    const spec = buildSpawnSpec({ ...base, tool: "copilot", resumeHandle: "ao-abc", seed: "go" });
    expect(spec.argv.slice(0, 3)).toEqual(["copilot", "--name", "ao-abc"]);
    expect(spec.argv).toContain("--allow-all-tools");
    expect(spec.argv[spec.argv.indexOf("-i") + 1]).toBe("go");
  });

  test("resume uses the = form; ask permission omits --allow-all-tools", () => {
    const spec = buildSpawnSpec({ ...base, tool: "copilot", isResume: true, resumeHandle: "ao-abc", permissions: "ask" });
    expect(spec.argv).toContain("--resume=ao-abc");
    expect(spec.argv).not.toContain("--allow-all-tools");
  });
});

describe("remote hook wiring (design §9.2)", () => {
  test("claude: hooks use the sh form and deferral is disabled on remote", () => {
    const spec = buildSpawnSpec({
      ...base, tool: "claude", resumeHandle: "U", seed: "s", seedIsTicket: true, remoteHookPath: "/rh/hook.sh",
    });
    expect(spec.deferSeedPrompt).toBe(false); // remote never defers (§10.7 delivery is the ssh hop, step 6)
    const settings = JSON.parse(spec.argv[spec.argv.indexOf("--settings") + 1]!);
    expect(settings.hooks.Stop[0].hooks[0].command).toBe("sh /rh/hook.sh S123abcd done");
    expect(settings.hooks.Notification[0].hooks[0].command).toBe("sh /rh/hook.sh S123abcd needs-input");
    expect(spec.argv[spec.argv.length - 1]).toBe("s"); // seed carried positionally (not deferred)
  });

  test("codex: notify uses the sh form with the sessionId", () => {
    const spec = buildSpawnSpec({ ...base, tool: "codex", remoteHookPath: "/rh/hook.sh" });
    expect(spec.argv).toContain(`notify=["sh","/rh/hook.sh","S123abcd","codex-event"]`);
  });
});

test("openrouter is in-process, not argv", () => {
  expect(() => buildSpawnSpec({ ...base, tool: "openrouter" })).toThrow(/in-process/);
});
