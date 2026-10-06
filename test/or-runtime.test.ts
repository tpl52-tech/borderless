import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planCompaction, HEAD_KEEP, type CompactMessage } from "../src/daemon/openrouter/compaction.ts";
import { wrapSandbox } from "../src/daemon/openrouter/sandbox.ts";
import { isReadTool, sortTools, curateTools } from "../src/daemon/openrouter/mcp-host.ts";
import { runAgentLoop, type Chat } from "../src/daemon/openrouter/runner.ts";

describe("compaction plan (design §16)", () => {
  const msgs = (n: number, bytes = 100): CompactMessage[] =>
    Array.from({ length: n }, () => ({ role: "user", bytes }));

  test("small histories are left alone", () => {
    const p = planCompaction(msgs(3));
    expect(p.summarize).toEqual([p.tailStart, p.tailStart]); // nothing to summarize
  });
  test("keeps 2 head + a byte-budgeted tail; summarizes the middle", () => {
    const p = planCompaction(msgs(10)); // total 1000, budget 350 -> ~4 in the tail
    expect(p.head).toBe(HEAD_KEEP);
    expect(p.tailStart).toBe(6);
    expect(p.summarize).toEqual([2, 6]);
  });
  test("snaps the tail off a tool-result boundary (never orphan a tool_use)", () => {
    const m = msgs(10);
    m[6]!.isToolResult = true; // the natural tailStart lands on a tool result
    const p = planCompaction(m);
    expect(p.tailStart).toBe(5); // moved back to include the tool_use
  });
});

describe("sandbox argv (design §16)", () => {
  test("full-access is unconfined (passthrough)", () => {
    const s = wrapSandbox(["echo", "hi"], "/tmp", "full-access", "darwin");
    expect(s.argv).toEqual(["echo", "hi"]);
    expect(s.confined).toBe(false);
  });
  test("darwin confines via seatbelt with a -D WORKDIR param, no network", () => {
    const s = wrapSandbox(["echo"], "/tmp", "ask", "darwin");
    expect(s.argv[0]).toBe("sandbox-exec");
    expect(s.argv).toContain("-p");
    expect(s.argv.some((a) => a.startsWith("WORKDIR="))).toBe(true);
    expect(s.network).toBe(false);
  });
  test("linux confines via bubblewrap, unshare pid + net", () => {
    const s = wrapSandbox(["echo"], "/tmp", "auto-edits", "linux");
    expect(s.argv[0]).toBe("bwrap");
    expect(s.argv).toContain("--unshare-net");
    expect(s.argv).toContain("--unshare-pid");
  });
});

describe("mcp curation (design §16)", () => {
  test("verb-gates reads; sorts; curates to a limit unless all", () => {
    expect(isReadTool("linear_get_issue")).toBe(true);
    expect(isReadTool("linear_search_documentation")).toBe(true);
    expect(isReadTool("linear_save_issue")).toBe(false);
    expect(sortTools([{ name: "b" }, { name: "a" }]).map((t) => t.name)).toEqual(["a", "b"]);
    const names = ["linear_save_issue", "linear_get_issue", "linear_list_issues"];
    expect(curateTools(names, { limit: 2 }).length).toBe(2);
    expect(curateTools(names, { all: true }).length).toBe(3);
  });
});

describe("agent loop (design §16)", () => {
  let dir: string | null = null;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });

  test("drives a tool call then finishes; the tool result lands in the transcript", async () => {
    dir = mkdtempSync(join(tmpdir(), "ao-loop-"));
    writeFileSync(join(dir, "hello.txt"), "TARGET-CONTENT");
    let turn = 0;
    const chat: Chat = async () => {
      turn++;
      if (turn === 1) return { toolCalls: [{ id: "1", name: "read_file", args: { path: "hello.txt" } }] };
      return { text: "done reading" };
    };
    const rendered: string[] = [];
    const res = await runAgentLoop({ chat, cwd: dir, tools: [{ name: "read_file" }], seed: "read hello.txt", render: (l) => rendered.push(l) });
    expect(res.status).toBe("done");
    expect(res.steps).toBe(2);
    expect(res.messages.some((m) => m.role === "tool" && m.content.includes("TARGET-CONTENT"))).toBe(true);
    expect(rendered).toContain("done reading");
  });

  test("a seedless session opens and waits (no chat call)", async () => {
    let calls = 0;
    const chat: Chat = async () => { calls++; return { text: "x" }; };
    const res = await runAgentLoop({ chat, cwd: "/tmp", tools: [] });
    expect(res.status).toBe("done");
    expect(res.steps).toBe(0);
    expect(calls).toBe(0);
  });

  test("hitting the step ceiling exits", async () => {
    const chat: Chat = async () => ({ toolCalls: [{ id: "x", name: "bash", args: { command: "true" } }] });
    const res = await runAgentLoop({ chat, cwd: "/tmp", tools: [{ name: "bash" }], seed: "loop forever", maxSteps: 3 });
    expect(res.status).toBe("exited");
    expect(res.steps).toBe(3);
  });

  test("a chat error yields error status", async () => {
    const chat: Chat = async () => { throw new Error("boom"); };
    const res = await runAgentLoop({ chat, cwd: "/tmp", tools: [], seed: "go" });
    expect(res.status).toBe("error");
  });
});
