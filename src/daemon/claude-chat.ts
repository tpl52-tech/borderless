/**
 * Subscription chat backend for Ask Borderless (PRD §10, §12) — runs the model on the local `claude` CLI
 * (the lead's Claude subscription, $0 per call) instead of pay-per-token OpenRouter.
 *
 * `claude -p --output-format json` is a one-shot: it answers but does not expose our fleet ToolDefs, so
 * this backend is ANSWER-ONLY (advisory). The action tools (reassign/enqueue/…) remain the OpenRouter
 * backend's. The response parser is pure + tested; the spawn is the thin live part.
 */

import type { Chat, ChatResponse, Message } from "./openrouter/runner.ts";

/** Flatten the loop's messages into one prompt for the single-shot CLI (system first, then the turns). */
export function flattenMessages(messages: Message[]): string {
  return messages
    .map((m) => (m.role === "user" ? m.content : `${m.role}: ${m.content}`))
    .join("\n\n")
    .trim();
}

/** `claude -p --output-format json` body → ChatResponse. Tolerant: non-JSON output is taken as the answer. */
export function parseClaudeCliResult(raw: string): ChatResponse {
  const trimmed = raw.trim();
  if (!trimmed) return { text: undefined };
  try {
    const j = JSON.parse(trimmed) as { result?: unknown; is_error?: unknown; total_cost_usd?: unknown };
    const result = typeof j.result === "string" ? j.result : undefined;
    const usageCost = typeof j.total_cost_usd === "number" ? j.total_cost_usd : undefined;
    if (j.is_error) return { text: result ?? "ask: the model returned an error", usageCost };
    return { text: result, usageCost };
  } catch {
    return { text: trimmed }; // plain-text output (not the json envelope) → the whole thing is the answer
  }
}

/**
 * A `Chat` backed by the local `claude` CLI subscription. The `tools` arg is ignored — the CLI can't call
 * our ToolDefs — so it always returns text and the agent loop ends in one turn (advisory). Throws if the
 * CLI isn't runnable (the loop renders that + stops).
 */
export function claudeCliChat(opts: { model?: string; cwd?: string } = {}): Chat {
  return async (messages) => {
    const args = ["-p", "--output-format", "json", ...(opts.model ? ["--model", opts.model] : [])];
    const proc = Bun.spawn(["claude", ...args], {
      stdin: new TextEncoder().encode(flattenMessages(messages)),
      stdout: "pipe", stderr: "pipe", cwd: opts.cwd,
    });
    const raw = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0 && !raw.trim()) {
      throw new Error(`claude CLI exited ${code}: ${(await new Response(proc.stderr).text()).trim().slice(0, 200)}`);
    }
    return parseClaudeCliResult(raw);
  };
}
