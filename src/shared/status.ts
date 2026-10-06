/**
 * Session status presentation + attention ranking (design §10.1, §19).
 *
 * Pure helpers shared by the daemon (task rollup glyph) and the client (dashboard glyphs). The
 * attention rank drives the TASK ROLLUP glyph only — the list itself never re-sorts by it (rows
 * moving under the cursor is worse than a stale glyph, design §19).
 */

import type { SessionStatus } from "./types.ts";

/** Attention rank for the task rollup glyph only (design §10.1). Higher = more urgent. */
export const ATTENTION_RANK: Record<SessionStatus, number> = {
  "needs-input": 100,
  done: 90,
  error: 80,
  stuck: 70,
  working: 20,
  starting: 15,
  exited: 10,
};

/** True for the states a human should look at (design §10.1). */
export function needsAttention(status: SessionStatus): boolean {
  return status === "needs-input" || status === "done" || status === "error";
}

export interface StatusStyle {
  glyph: string;
  label: string;
  /** Ink color name, or undefined to inherit. */
  color?: string;
  /** Render dim (used for low-salience states). */
  dim?: boolean;
}

const STYLES: Record<SessionStatus, StatusStyle> = {
  starting: { glyph: "◌", label: "starting", dim: true },
  working: { glyph: "●", label: "working", color: "cyan" },
  done: { glyph: "✓", label: "done", color: "green" },
  "needs-input": { glyph: "◆", label: "needs input", color: "yellow" },
  stuck: { glyph: "⚠", label: "stuck", color: "red" },
  error: { glyph: "✗", label: "error", color: "red" },
  exited: { glyph: "·", label: "exited", dim: true },
};

export function statusStyle(status: SessionStatus): StatusStyle {
  return STYLES[status];
}

/**
 * The rollup status for a task: the highest-attention status among its sessions (design §10.1).
 * Returns null for a task with no sessions.
 */
export function taskRollupStatus(statuses: SessionStatus[]): SessionStatus | null {
  let best: SessionStatus | null = null;
  let bestRank = -1;
  for (const s of statuses) {
    const rank = ATTENTION_RANK[s];
    if (rank > bestRank) { bestRank = rank; best = s; }
  }
  return best;
}
