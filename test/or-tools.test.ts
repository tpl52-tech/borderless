import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileTool, writeFileTool, editFileTool, bashTool, rejectUnknownArgs } from "../src/daemon/openrouter/tools.ts";

let dir: string | null = null;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });
function tmp(): string { dir = mkdtempSync(join(tmpdir(), "ao-tools-")); return dir; }

describe("read_file (design §16)", () => {
  test("offset/limit with the read-on footer", () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "f.txt"), "a\nb\nc\nd\ne");
    const r = readFileTool(cwd, { path: "f.txt", offset: 2, limit: 2 });
    expect(r.output).toContain("b\nc");
    expect(r.output).toContain("showing lines 2-3 of 5, read on with offset=4");
  });
  test("no footer when the whole file fits", () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "f.txt"), "one\ntwo");
    expect(readFileTool(cwd, { path: "f.txt" }).output).toBe("one\ntwo");
  });
  test("missing file is an error", () => {
    expect(readFileTool(tmp(), { path: "nope" }).isError).toBe(true);
  });
});

describe("write_file / edit_file (design §16)", () => {
  test("write_file writes the whole file", () => {
    const cwd = tmp();
    writeFileTool(cwd, { path: "w.txt", content: "hello" });
    expect(readFileSync(join(cwd, "w.txt"), "utf8")).toBe("hello");
  });
  test("edit_file replaces a UNIQUE match; ambiguous/absent change nothing", () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "e.txt"), "foo bar foo");
    expect(editFileTool(cwd, { path: "e.txt", old_string: "bar", new_string: "baz" }).isError).toBeUndefined();
    expect(readFileSync(join(cwd, "e.txt"), "utf8")).toBe("foo baz foo");
    expect(editFileTool(cwd, { path: "e.txt", old_string: "foo", new_string: "x" }).isError).toBe(true); // 2 matches
    expect(readFileSync(join(cwd, "e.txt"), "utf8")).toBe("foo baz foo"); // unchanged
    expect(editFileTool(cwd, { path: "e.txt", old_string: "zzz", new_string: "x" }).isError).toBe(true); // absent
  });
});

describe("bash + unknown args (design §16)", () => {
  test("bash prints the exit code", async () => {
    const cwd = tmp();
    expect((await bashTool(cwd, { command: "echo hi" })).output).toContain("hi");
    expect((await bashTool(cwd, { command: "echo hi" })).output).toContain("[exit code: 0]");
    expect((await bashTool(cwd, { command: "exit 3" })).output).toContain("[exit code: 3]");
  });
  test("unknown arguments are rejected with the supported listing", () => {
    expect(rejectUnknownArgs("read_file", { path: "x", bogus: 1 })).toContain("supported: path, offset, limit");
    expect(readFileTool(tmp(), { path: "x", bogus: 1 }).isError).toBe(true);
  });
});
