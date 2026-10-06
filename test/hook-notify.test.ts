import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = new URL("../src/daemon/hook-notify.ts", import.meta.url).pathname;

describe("local hook-notify script (§7.2, §10.2)", () => {
  let dir: string | null = null;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });

  test("appends `<epochMs> <event>` to AO_SESSION_DIR/events.log", async () => {
    dir = mkdtempSync(join(tmpdir(), "ao-hook-"));
    for (const event of ["needs-input", "done"]) {
      const proc = Bun.spawn([process.execPath, "run", HOOK, event], {
        env: { ...process.env, AO_SESSION_DIR: dir },
        stdio: ["ignore", "ignore", "ignore"],
      });
      await proc.exited;
    }
    const lines = readFileSync(join(dir, "events.log"), "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    expect(lines[0]).toMatch(/^\d+ needs-input$/);
    expect(lines[1]).toMatch(/^\d+ done$/);
  });

  test("does nothing without AO_SESSION_DIR", async () => {
    const proc = Bun.spawn([process.execPath, "run", HOOK, "done"], {
      env: { ...process.env, AO_SESSION_DIR: "" },
      stdio: ["ignore", "ignore", "ignore"],
    });
    expect(await proc.exited).toBe(0); // no throw, clean exit
  });
});
