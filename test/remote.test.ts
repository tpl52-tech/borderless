import { test, expect, describe } from "bun:test";
import {
  shellQuote, sshUserFromDest, remoteHome, buildRemoteCommand, buildRemoteSpawnArgv, wrapAgentCommand,
  tmuxHasSessionCommand, tmuxCapturePaneCommand, tailEventsCommand, deployHookScriptCommand,
  classifyLiveness, detectTailscaleAuth, SSH_SPAWN_OPTS,
} from "../src/shared/remote.ts";

describe("shell quoting / ssh identity (design §9.1, §7.2)", () => {
  test("shellQuote wraps and escapes single quotes", () => {
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
  test("sshUserFromDest + remoteHome", () => {
    expect(sshUserFromDest("root@box")).toBe("root");
    expect(sshUserFromDest("ubuntu@1.2.3.4")).toBe("ubuntu");
    expect(sshUserFromDest("box")).toBe("ubuntu"); // bare host -> default
    expect(remoteHome("root")).toBe("/root");
    expect(remoteHome("ubuntu")).toBe("/home/ubuntu");
  });
});

describe("remote spawn recipe (design §9.1)", () => {
  const args = { dest: "u@h", cwd: "/repo", tmuxSession: "ao-abc12345", agentCmd: ["claude", "--model", "opus"] };

  test("wrapAgentCommand strips TMUX and pins TERM", () => {
    const w = wrapAgentCommand(["claude"]);
    expect(w).toContain("env");
    expect(w).toContain("-u");
    expect(w).toContain("TMUX");
    expect(w).toContain("TERM=xterm-256color");
    expect(w).toContain("'claude'");
  });

  test("buildRemoteCommand has env exports, cd, tmux new-session, and options", () => {
    const cmd = buildRemoteCommand(args);
    expect(cmd).toContain("export TERM=xterm-256color");
    expect(cmd).toContain("export PATH=");
    expect(cmd).toContain("cd '/repo'");
    expect(cmd).toContain("tmux -u new-session -A -D -s 'ao-abc12345'");
    expect(cmd).toContain("set-option -t 'ao-abc12345' status off");
    expect(cmd).toContain("set-option -t 'ao-abc12345' allow-passthrough on");
    expect(cmd).toContain("history-limit 100000");
  });

  test("buildRemoteSpawnArgv is ssh + opts + dest + command", () => {
    const argv = buildRemoteSpawnArgv(args);
    expect(argv[0]).toBe("ssh");
    for (const o of SSH_SPAWN_OPTS) expect(argv).toContain(o);
    expect(argv).toContain("u@h");
    expect(argv[argv.length - 1]).toBe(buildRemoteCommand(args));
  });
});

describe("tmux / hook commands (design §9.2, §8.4)", () => {
  test("has-session, capture-pane, tail, deploy", () => {
    expect(tmuxHasSessionCommand("ao-x")).toBe("tmux has-session -t 'ao-x'");
    expect(tmuxCapturePaneCommand("ao-x")).toBe("tmux capture-pane -p -e -t 'ao-x'");
    expect(tailEventsCommand("sid")).toContain("tail -n +1 -F");
    expect(tailEventsCommand("sid")).toContain("'sid'");
    const deploy = deployHookScriptCommand();
    expect(deploy).toContain("mkdir -p");
    expect(deploy).toContain("chmod +x");
  });
});

describe("liveness (design §9.2)", () => {
  test("0 alive; 255/null no-answer (never dead); other error", () => {
    expect(classifyLiveness(0)).toBe("alive");
    expect(classifyLiveness(255)).toBe("no-answer");
    expect(classifyLiveness(null)).toBe("no-answer");
    expect(classifyLiveness(1)).toBe("error");
  });
});

describe("Tailscale re-auth detection (design §9.3)", () => {
  test("needs BOTH the marker phrase and a COMPLETE url", () => {
    const line = "To authenticate, visit https://login.tailscale.com/a/abc123 to continue";
    expect(detectTailscaleAuth(line)).toBe("https://login.tailscale.com/a/abc123");
  });
  test("no marker phrase -> null", () => {
    expect(detectTailscaleAuth("https://login.tailscale.com/a/abc123 ")).toBeNull();
  });
  test("truncated token at end (no trailing non-alnum) -> null", () => {
    expect(detectTailscaleAuth("To authenticate, visit https://login.tailscale.com/a/abc123")).toBeNull();
  });
});
