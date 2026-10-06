import { test, expect, describe } from "bun:test";
import { deliverTmux } from "../src/daemon/box/tmux-nudge.ts";

/** A fake tmux runner: returns `capture` for capture-pane; records every argv; codes for capture. */
function runner(captureStdout: string, captureCode = 0) {
  const calls: string[][] = [];
  const run = async (argv: string[]) => {
    calls.push(argv);
    if (argv[1] === "capture-pane") return { code: captureCode, stdout: captureStdout };
    return { code: 0, stdout: "" };
  };
  return { run, calls };
}
const sent = (calls: string[][], sub: string) => calls.some((c) => c[1] === "send-keys" && c.includes(sub));
const sentLiteral = (calls: string[][]) => calls.some((c) => c[1] === "send-keys" && c.includes("-l"));

describe("deliverTmux dispatch (design §10.5, §17)", () => {
  test("idle pane -> type (literal body then Enter)", async () => {
    const { run, calls } = runner("some output\n> ");
    expect(await deliverTmux({ tmuxSession: "ao-x", body: "fix the build please", tool: "claude", run, settleMs: 1 })).toBe("typed");
    expect(sentLiteral(calls)).toBe(true);
    expect(sent(calls, "Enter")).toBe(true);
  });

  test("busy pane -> hold (no send)", async () => {
    const { run, calls } = runner("Working… (esc to interrupt)");
    expect(await deliverTmux({ tmuxSession: "ao-x", body: "hi there friend", tool: "claude", run })).toBe("held");
    expect(sentLiteral(calls)).toBe(false);
    expect(sent(calls, "Enter")).toBe(false);
  });

  test("menu -> dropped", async () => {
    const { run } = runner("1. Yes\n2. No\n(enter to confirm, esc to cancel)");
    expect(await deliverTmux({ tmuxSession: "ao-x", body: "do the thing now", tool: "claude", run })).toBe("dropped");
  });

  test("our stranded text (not busy) -> press Enter only, never retype", async () => {
    const body = "please address the failing tests";
    const { run, calls } = runner(`> ${body}`);
    expect(await deliverTmux({ tmuxSession: "ao-x", body, tool: "claude", run })).toBe("entered");
    expect(sentLiteral(calls)).toBe(false);      // never retype
    expect(sent(calls, "Enter")).toBe(true);
  });

  test("failed capture -> box proceeds (types)", async () => {
    const { run, calls } = runner("", 1);
    expect(await deliverTmux({ tmuxSession: "ao-x", body: "long enough body here", tool: "claude", run, settleMs: 1 })).toBe("typed");
    expect(sentLiteral(calls)).toBe(true);
  });

  test("cancellation during settle -> Escape (clear), reported as held", async () => {
    const { run, calls } = runner("idle\n> ");
    expect(await deliverTmux({ tmuxSession: "ao-x", body: "body to be cancelled", tool: "claude", run, settleMs: 1, cancelled: () => true })).toBe("held");
    expect(calls.some((c) => c.includes("Escape"))).toBe(true);
    expect(sent(calls, "Enter")).toBe(false);
  });
});
