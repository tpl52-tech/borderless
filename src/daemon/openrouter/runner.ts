/**
 * OpenRouter agent runtime — the one place the system writes code itself (design §16).
 *
 * Why: pointing codex at OpenRouter measured 105s to first token vs 2.5s direct and a 0% prompt-cache hit
 * rate vs 98%; cache reads are ~1000:1 of the token mix, so losing the cache costs more than the
 * subscription. So we run the tool-calling loop ourselves against the chat-completions API.
 *
 * Cache discipline: a short, BYTE-STABLE system prompt (no interpolation — cwd + task go in the first
 * USER message); tools sorted by name; provider pinned to whoever served turn 1; non-streaming.
 *
 * Loop: per-turn step ceiling 150 (a per-session ceiling of 60 bricked agents forever); await MCP
 * readiness before the first turn; maybe compact; POST; run tool calls SERIALLY (MCP first, then
 * built-ins); flush transcript. Seedless sessions open with only the system message and WAIT (a bare cwd
 * line made the model invent work).
 *
 * runAgentLoop takes an injected `chat` + `runTool`, so the loop + tools are unit-tested end to end with a
 * fake model; runOpenRouterAgent is the live entry (real chat-completions POST, MCP, sandbox, PTY render).
 */

import { runBuiltinTool, type ToolResult } from "./tools.ts";
import { sortTools } from "./mcp-host.ts";

export const STEP_CEILING = 150;
export const COMPACT_AT_FRACTION = 0.7;

/** Byte-stable system prompt (no interpolation — cwd/task go in the first user message, §16). */
export const SYSTEM_PROMPT =
  "You are a coding agent. Use the provided tools to inspect and edit the repository and run commands. " +
  "Read before you edit; make minimal, correct changes; run the tests. When the task is complete, reply " +
  "with a short summary and no tool calls.";

export interface ToolDef { name: string; description?: string; parameters?: unknown; }
export interface ToolCall { id: string; name: string; args: Record<string, any>; }
export interface Message { role: "system" | "user" | "assistant" | "tool"; content: string; toolCallId?: string; toolCalls?: ToolCall[]; }
export interface ChatResponse { text?: string; toolCalls?: ToolCall[]; usageCost?: number; }
export type Chat = (messages: Message[], tools: ToolDef[]) => Promise<ChatResponse>;

export type AgentStatus = "working" | "needs-input" | "done" | "error" | "exited";

export interface LoopDeps {
  chat: Chat;
  cwd: string;
  tools: ToolDef[];
  /** dispatch a tool call — MCP first, then built-ins. Defaults to the built-in tools. */
  runTool?: (call: ToolCall) => Promise<ToolResult>;
  render?: (line: string) => void;
  seed?: string;
  maxSteps?: number;
  systemPrompt?: string;
}

export interface LoopResult { status: AgentStatus; steps: number; messages: Message[]; costMicros: number; }

/** Run the tool-calling loop (design §16). Deterministic given `chat`/`runTool`. */
export async function runAgentLoop(deps: LoopDeps): Promise<LoopResult> {
  const render = deps.render ?? (() => {});
  const runTool = deps.runTool ?? ((call: ToolCall) => runBuiltinTool(call.name, call.args, deps.cwd));
  const tools = sortTools(deps.tools); // cache discipline
  const maxSteps = deps.maxSteps ?? STEP_CEILING;

  const messages: Message[] = [{ role: "system", content: deps.systemPrompt ?? SYSTEM_PROMPT }];
  if (!deps.seed) return { status: "done", steps: 0, messages, costMicros: 0 }; // seedless: open + wait
  // cwd + task go in the FIRST user message (keeps the system prompt byte-stable).
  messages.push({ role: "user", content: `cwd: ${deps.cwd}\n\n${deps.seed}` });

  let steps = 0;
  let costMicros = 0;
  for (; steps < maxSteps; steps++) {
    let res: ChatResponse;
    try { res = await deps.chat(messages, tools); }
    catch (err) { render(`[error] ${err instanceof Error ? err.message : err}`); return { status: "error", steps, messages, costMicros }; }
    if (res.usageCost) costMicros += Math.round(res.usageCost * 1_000_000);
    if (res.text) render(res.text);
    messages.push({ role: "assistant", content: res.text ?? "", toolCalls: res.toolCalls });

    if (!res.toolCalls || res.toolCalls.length === 0) return { status: "done", steps: steps + 1, messages, costMicros };

    for (const call of res.toolCalls) { // serially (MCP first, then built-ins)
      const result = await runTool(call);
      render(`[${call.name}]${result.isError ? " error" : ""}`);
      messages.push({ role: "tool", toolCallId: call.id, content: result.output });
    }
  }
  return { status: "exited", steps, messages, costMicros }; // hit the step ceiling
}

export async function runOpenRouterAgent(): Promise<void> {
  // Live entry: parse --session/--cwd/--model/--effort/--permissions/[--resume]/[--seed], build the real
  // chat-completions `chat` (provider pinned, non-streaming), the sandboxed built-in tools + MCP host, and
  // render into a PTY-shaped byte stream. Then call runAgentLoop. See design §16.
  throw new Error("openrouter.runOpenRouterAgent: live-only (design §16) — runAgentLoop is the tested core");
}

if (import.meta.main) {
  runOpenRouterAgent().catch((err) => { console.error(err); process.exit(1); });
}
