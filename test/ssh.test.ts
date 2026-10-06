import { test, expect, describe } from "bun:test";
import { runWithDeadline } from "../src/daemon/ssh.ts";

describe("runWithDeadline (design §9.4)", () => {
  test("captures stdout/stderr and the real exit code", async () => {
    const r = await runWithDeadline(["bash", "-c", "printf out; printf err >&2; exit 2"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("out");
    expect(r.stderr).toBe("err");
    expect(r.timedOut).toBe(false);
  });

  test("feeds stdin input", async () => {
    const r = await runWithDeadline(["cat"], { input: "piped-in" });
    expect(r.stdout).toBe("piped-in");
    expect(r.code).toBe(0);
  });

  test("kills on the deadline and reports code null / timedOut", async () => {
    const r = await runWithDeadline(["sleep", "5"], { timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(r.code).toBeNull();
  });
});
