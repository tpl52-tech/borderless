import { test, expect, describe } from "bun:test";
import { spawnPty, trimReplayBuffer, REPLAY_BUFFER_BYTES } from "../src/daemon/pty.ts";

const dec = new TextDecoder();

describe("trimReplayBuffer", () => {
  test("returns the buffer unchanged when under the cap", () => {
    const buf = new Uint8Array(10).fill(0x61);
    expect(trimReplayBuffer(buf)).toBe(buf);
  });

  test("cuts at the byte after a newline within the scan window", () => {
    const len = REPLAY_BUFFER_BYTES + 100;
    const buf = new Uint8Array(len).fill(0x61); // 'a'
    const start = len - REPLAY_BUFFER_BYTES; // = 100
    buf[start + 50] = 0x0a; // newline inside the 4KB scan window
    const trimmed = trimReplayBuffer(buf);
    expect(trimmed.length).toBe(len - (start + 50 + 1));
    expect(trimmed[0]).toBe(0x61); // byte right after the newline
    expect(trimmed.length).toBeLessThanOrEqual(REPLAY_BUFFER_BYTES);
  });

  test("falls back to the first ESC when no newline is present", () => {
    const len = REPLAY_BUFFER_BYTES + 100;
    const buf = new Uint8Array(len).fill(0x61);
    const start = len - REPLAY_BUFFER_BYTES;
    buf[start + 30] = 0x1b; // ESC
    const trimmed = trimReplayBuffer(buf);
    expect(trimmed[0]).toBe(0x1b);
    expect(trimmed.length).toBe(len - (start + 30));
  });
});

describe("spawnPty", () => {
  test("captures output into the replay buffer", async () => {
    const pty = spawnPty({
      sessionId: "t1",
      argv: ["bash", "-c", "printf 'hello-pty'"],
      cwd: "/tmp",
    });
    const exit = await pty.exited;
    expect(exit.status).toBe("exited");
    expect(dec.decode(pty.replay())).toContain("hello-pty");
  });

  test("streams output to listeners and reports a non-zero exit as error", async () => {
    const chunks: string[] = [];
    const pty = spawnPty({
      sessionId: "t2",
      argv: ["bash", "-c", "printf 'boom'; exit 3"],
      cwd: "/tmp",
    });
    pty.addOutputListener((b) => chunks.push(dec.decode(b)));
    const exit = await pty.exited;
    expect(exit.code).toBe(3);
    expect(exit.status).toBe("error");
    expect(chunks.join("")).toContain("boom");
  });
});
