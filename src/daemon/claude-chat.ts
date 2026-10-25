/**
 * Subscription chat backend for Ask Borderless (PRD §10, §12) — runs the model on the local `claude` CLI
 * (the lead's Claude subscription, $0 marginal) instead of pay-per-token OpenRouter.
 *
 * `claude -p --output-format json` is a one-shot. We run it ANSWER-ONLY and sandboxed: `--allowedTools ""`
 * (no tools — it can't call our fleet ToolDefs, nor read/exec anything) and a throwaway temp cwd (never the
 * daemon's state dir, which holds operator secrets). So the loop gets no toolCalls and ends in one turn; the
 * action tools remain the OpenRouter backend's. The response parser is pure + tested; the spawn is live.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Chat, ChatResponse, Message } from "./openrouter/runner.ts";

/** Flatten the loop's messages into one prompt for the single-shot CLI (user turns bare, other roles labeled). */
export function flattenMessages(messages: Message[]): string {
  return messages
    .map((m) => (m.role === "user" ? m.content : `${m.role}: ${m.content}`))
    .join("\n\n")
    .trim();
}

/**
 * Shared sandbox args for both backends: answer-only (`--allowedTools ""`, no tools) AND **no MCP servers
 * loaded** (`--strict-mcp-config` + an empty `--mcp-config`). The user's ~15 MCP servers add seconds of
 * connect time on every spawn, and the model can't call them here anyway — dropping them is a pure latency win.
 */
function sandboxArgs(model?: string): string[] {
  return ["--allowedTools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', ...(model ? ["--model", model] : [])];
}

/**
 * `claude -p --output-format json` body → ChatResponse. Tolerant: non-JSON output is taken verbatim as the
 * answer. Cost is intentionally NOT surfaced — a subscription call is $0 marginal; the CLI's `total_cost_usd`
 * is a notional metered-equivalent, so reporting it as spend would be misleading. (A valid-JSON bare scalar
 * has no `result` and reads as `{text: undefined}`; harmless — the CLI always emits an object envelope.)
 */
export function parseClaudeCliResult(raw: string): ChatResponse {
  const trimmed = raw.trim();
  if (!trimmed) return { text: undefined };
  try {
    const j = JSON.parse(trimmed) as { result?: unknown; is_error?: unknown };
    const result = typeof j.result === "string" ? j.result : undefined;
    if (j.is_error) return { text: result ?? "ask: the model returned an error" };
    return { text: result };
  } catch {
    return { text: trimmed };
  }
}

/**
 * A `Chat` backed by the local `claude` CLI subscription. Answer-only + sandboxed (see file header). Throws
 * if the CLI isn't runnable (the loop renders that + stops). The `tools` arg is ignored by design.
 */
export function claudeCliChat(opts: { model?: string } = {}): Chat {
  return async (messages) => {
    const scratch = mkdtempSync(join(tmpdir(), "bl-ask-")); // neutral cwd — never the secrets dir
    try {
      const args = ["-p", "--output-format", "json", ...sandboxArgs(opts.model)];
      const proc = Bun.spawn(["claude", ...args], {
        stdin: new TextEncoder().encode(flattenMessages(messages)),
        stdout: "pipe", stderr: "pipe", cwd: scratch,
      });
      // Drain stdout + stderr concurrently (a full stderr pipe would otherwise deadlock the child).
      const [out, errText] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      const code = await proc.exited;
      if (code !== 0 && !out.trim()) throw new Error(`claude CLI exited ${code}: ${errText.trim().slice(0, 200)}`);
      return parseClaudeCliResult(out);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };
}

/** Streams the answer token-by-token via onDelta; resolves when the turn completes. */
export type StreamChat = (messages: Message[], onDelta: (text: string) => void) => Promise<void>;

/**
 * One `--output-format stream-json --include-partial-messages` line → the text delta it carries, if any. The
 * token text lives at `event.delta.text` of a `content_block_delta`/`text_delta` inside a `stream_event`.
 * Tolerant: a non-JSON line, or any other event (system/init/result/usage), yields `{}`. Pure + tested.
 */
export function parseStreamJsonLine(line: string): { delta?: string } {
  const t = line.trim();
  if (!t) return {};
  let j: { type?: string; event?: { type?: string; delta?: { type?: string; text?: unknown } } };
  try { j = JSON.parse(t); } catch { return {}; }
  if (j?.type === "stream_event" && j.event?.type === "content_block_delta" && j.event.delta?.type === "text_delta") {
    const text = j.event.delta.text;
    if (typeof text === "string" && text) return { delta: text };
  }
  return {};
}

/**
 * A STREAMING `Chat` over the subscription CLI (`--output-format stream-json --include-partial-messages`):
 * same answer-only sandbox as claudeCliChat, but it forwards each text delta to `onDelta` as the model writes,
 * so the browser shows the answer appear live instead of a blank wait. Throws if the CLI isn't runnable.
 */
export function claudeCliChatStream(opts: { model?: string } = {}): StreamChat {
  return async (messages, onDelta) => {
    const scratch = mkdtempSync(join(tmpdir(), "bl-ask-")); // neutral cwd — never the secrets dir
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", ...sandboxArgs(opts.model)];
    const proc = Bun.spawn(["claude", ...args], {
      stdin: new TextEncoder().encode(flattenMessages(messages)),
      stdout: "pipe", stderr: "pipe", cwd: scratch,
    });
    const errPromise = new Response(proc.stderr).text(); // drain stderr concurrently (avoid a pipe deadlock)
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    try {
      const dec = new TextDecoder();
      let buf = "";
      const pump = (line: string) => { const d = parseStreamJsonLine(line); if (d.delta) onDelta(d.delta); };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) { pump(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
      }
      if (buf.trim()) pump(buf);
      const code = await proc.exited;
      if (code !== 0) throw new Error(`claude CLI exited ${code}: ${(await errPromise).trim().slice(0, 200)}`);
    } finally {
      // If onDelta threw (e.g. the client disconnected mid-answer), don't orphan the CLI: drop the pipe + kill it.
      try { reader.releaseLock(); } catch { /* already released */ }
      try { proc.kill(); } catch { /* already exited */ }
      rmSync(scratch, { recursive: true, force: true });
    }
  };
}
