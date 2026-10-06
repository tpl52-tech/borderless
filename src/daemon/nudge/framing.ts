/**
 * Nudge framing (design §10.5) — the rules for safely typing into an agent.
 *
 * THE cardinal rule: CR must NEVER ride in the same write as the text. A PTY delivers one write as one
 * read; the agent TUIs classify printable text + newline in one read as a PASTE and insert the newline
 * literally, leaving the message typed but unsent while looking delivered. So: write the body, wait
 * ~150ms (local/remote) or ~120ms (tmux, whose assume-paste-time is 1ms), then send Enter SEPARATELY.
 *
 * Body normalization: every CR/CRLF -> LF (a CR inside the body submits early). Codex bodies are
 * wrapped in bracketed-paste markers (otherwise literal LFs leave the composer populated).
 */

import type { Tool } from "../../shared/types.ts";

export const CR = new Uint8Array([0x0d]);
export const ESC = new Uint8Array([0x1b]);
export const BODY_SETTLE_MS_LOCAL = 150;
export const BODY_SETTLE_MS_TMUX = 120;

const BRACKET_PASTE_START = "\x1b[200~";
const BRACKET_PASTE_END = "\x1b[201~";

/** Normalize a nudge body for a tool (LF-only; codex bracketed-paste-wrapped). No CR is added here. */
export function normalizeBody(body: string, tool: Tool): string {
  const lf = body.replace(/\r\n?/g, "\n"); // every CR/CRLF -> LF
  if (tool === "codex") return `${BRACKET_PASTE_START}${lf}${BRACKET_PASTE_END}`;
  return lf;
}
