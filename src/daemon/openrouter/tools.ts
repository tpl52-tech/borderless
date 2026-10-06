/**
 * OpenRouter runtime built-in tools (design §16).
 *
 * read_file (1-based offset, limit 2000 lines, an explicit footer "showing lines A-B of T, read on with
 * offset=B+1" — a bare truncation once caused ~290 retries and zero edits), write_file (whole file; patch
 * grammars are where weak models fail), edit_file (exact UNIQUE-match replace; ambiguous match changes
 * nothing), bash (exit code printed so passing vs failing tests are distinguishable; 20,000-char clip; no
 * timeout). Unknown arguments reject the call with a listing of supported ones (derived from the schemas
 * so they can't drift).
 *
 * The file tools are pure over a cwd and unit-tested; bash shells out.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export const READ_LIMIT_DEFAULT = 2000;
export const BASH_CLIP = 20_000;

export interface ToolResult { output: string; isError?: boolean; }

const SCHEMAS: Record<string, string[]> = {
  read_file: ["path", "offset", "limit"],
  write_file: ["path", "content"],
  edit_file: ["path", "old_string", "new_string"],
  bash: ["command"],
};

export const BUILTIN_TOOL_NAMES = Object.keys(SCHEMAS);

function resolve(cwd: string, p: string): string {
  return isAbsolute(p) ? p : join(cwd, p);
}

/** Reject unknown argument keys with the supported listing (design §16). Returns an error string or null. */
export function rejectUnknownArgs(tool: string, args: Record<string, unknown>): string | null {
  const allowed = SCHEMAS[tool];
  if (!allowed) return `unknown tool '${tool}'`;
  const unknown = Object.keys(args).filter((k) => !allowed.includes(k));
  if (unknown.length) return `unknown argument(s) ${unknown.join(", ")} for ${tool}; supported: ${allowed.join(", ")}`;
  return null;
}

export function readFileTool(cwd: string, args: Record<string, any>): ToolResult {
  const bad = rejectUnknownArgs("read_file", args);
  if (bad) return { output: bad, isError: true };
  const path = resolve(cwd, String(args.path));
  if (!existsSync(path)) return { output: `no such file: ${args.path}`, isError: true };
  const lines = readFileSync(path, "utf8").split("\n");
  const total = lines.length;
  const offset = Math.max(1, Number(args.offset ?? 1));
  const limit = Math.max(1, Number(args.limit ?? READ_LIMIT_DEFAULT));
  const a = offset;
  const b = Math.min(offset + limit - 1, total);
  const body = lines.slice(a - 1, b).join("\n");
  const footer = b < total ? `\n\n[showing lines ${a}-${b} of ${total}, read on with offset=${b + 1}]` : "";
  return { output: body + footer };
}

export function writeFileTool(cwd: string, args: Record<string, any>): ToolResult {
  const bad = rejectUnknownArgs("write_file", args);
  if (bad) return { output: bad, isError: true };
  const content = String(args.content ?? "");
  writeFileSync(resolve(cwd, String(args.path)), content);
  return { output: `wrote ${Buffer.byteLength(content, "utf8")} bytes to ${args.path}` };
}

export function editFileTool(cwd: string, args: Record<string, any>): ToolResult {
  const bad = rejectUnknownArgs("edit_file", args);
  if (bad) return { output: bad, isError: true };
  const path = resolve(cwd, String(args.path));
  if (!existsSync(path)) return { output: `no such file: ${args.path}`, isError: true };
  const before = readFileSync(path, "utf8");
  const oldStr = String(args.old_string ?? "");
  const occurrences = oldStr === "" ? 0 : before.split(oldStr).length - 1;
  if (occurrences === 0) return { output: `edit_file: old_string not found (no change)`, isError: true };
  if (occurrences > 1) return { output: `edit_file: old_string is not unique (${occurrences} matches, no change)`, isError: true };
  writeFileSync(path, before.replace(oldStr, String(args.new_string ?? "")));
  return { output: `edited ${args.path}` };
}

export async function bashTool(cwd: string, args: Record<string, any>): Promise<ToolResult> {
  const bad = rejectUnknownArgs("bash", args);
  if (bad) return { output: bad, isError: true };
  const proc = Bun.spawn(["sh", "-c", String(args.command ?? "")], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  let combined = (out + (err ? (out ? "\n" : "") + err : "")).slice(0, BASH_CLIP);
  return { output: `${combined}\n[exit code: ${code}]` }; // exit code printed so pass vs fail is distinguishable
}

/** Dispatch a built-in tool call. */
export async function runBuiltinTool(name: string, args: Record<string, any>, cwd: string): Promise<ToolResult> {
  switch (name) {
    case "read_file": return readFileTool(cwd, args);
    case "write_file": return writeFileTool(cwd, args);
    case "edit_file": return editFileTool(cwd, args);
    case "bash": return await bashTool(cwd, args);
    default: return { output: `unknown tool '${name}'; supported: ${BUILTIN_TOOL_NAMES.join(", ")}`, isError: true };
  }
}
