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
      const args = ["-p", "--output-format", "json", "--allowedTools", "", ...(opts.model ? ["--model", opts.model] : [])];
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
