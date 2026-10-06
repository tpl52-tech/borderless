import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureClaudeTrust } from "../src/daemon/session-manager.ts";

let home: string | null = null;
let work: string | null = null;
afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  if (work) rmSync(work, { recursive: true, force: true });
  home = work = null;
});

describe("ensureClaudeTrust (live-validation fix: §7 claude trust gate)", () => {
  test("sets hasTrustDialogAccepted keyed by the cwd realpath, creating ~/.claude.json", () => {
    home = mkdtempSync(join(tmpdir(), "ao-home-"));
    work = mkdtempSync(join(tmpdir(), "ao-work-"));
    ensureClaudeTrust(work, home);
    const json = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
    const key = realpathSync(work);
    expect(json.projects[key].hasTrustDialogAccepted).toBe(true);
  });

  test("preserves existing top-level keys and other projects", () => {
    home = mkdtempSync(join(tmpdir(), "ao-home-"));
    work = mkdtempSync(join(tmpdir(), "ao-work-"));
    writeFileSync(join(home, ".claude.json"), JSON.stringify({
      hasCompletedOnboarding: true,
      projects: { "/some/other": { hasTrustDialogAccepted: true, foo: 1 } },
    }));
    ensureClaudeTrust(work, home);
    const json = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
    expect(json.hasCompletedOnboarding).toBe(true);              // top-level preserved
    expect(json.projects["/some/other"].foo).toBe(1);           // other projects preserved
    expect(json.projects[realpathSync(work)].hasTrustDialogAccepted).toBe(true);
  });

  test("merges into an existing entry for the same cwd without clobbering its other keys", () => {
    home = mkdtempSync(join(tmpdir(), "ao-home-"));
    work = mkdtempSync(join(tmpdir(), "ao-work-"));
    const key = realpathSync(work);
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ projects: { [key]: { allowedTools: ["x"] } } }));
    ensureClaudeTrust(work, home);
    const json = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
    expect(json.projects[key].allowedTools).toEqual(["x"]);
    expect(json.projects[key].hasTrustDialogAccepted).toBe(true);
  });

  test("tolerates a malformed ~/.claude.json (starts fresh, best-effort)", () => {
    home = mkdtempSync(join(tmpdir(), "ao-home-"));
    work = mkdtempSync(join(tmpdir(), "ao-work-"));
    writeFileSync(join(home, ".claude.json"), "not json {{{");
    ensureClaudeTrust(work, home);
    const json = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
    expect(json.projects[realpathSync(work)].hasTrustDialogAccepted).toBe(true);
  });
});
