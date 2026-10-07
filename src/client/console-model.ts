/**
 * Borderless console view-model (PRD §11) — PURE + tested, so the Ink console (console.tsx) is thin render.
 *
 * Owns: the screen registry (which daemon request feeds each screen + the empty-state line), the per-screen
 * row formatting, cursor clamping/movement (no wrap — rows never move under the cursor, §19), and which
 * selected row is attachable (only a SWEEPS row with a live session id). No Ink, no I/O.
 */

import type { RequestType } from "../shared/wire.ts";
import type { DeskRow } from "../shared/lead-desk.ts"; // the lead.desk handler returns this canonical shape

export type ConsoleScreen = "sweeps" | "boards" | "assign" | "lead_desk" | "roster";

// The wire shapes the daemon handlers return, one per screen (DeskRow is reused from shared/lead-desk).
export interface SweepRow { ticketKey: string; kind: string; state: string; prNumber: number | null; cycles: number; reason: string | null; sessionId: string | null }
export interface BoardRow { ticketKey: string; title: string; downstream: number }
export interface AssignRow { ticketKey: string; netid: string; name: string; load: number }
export interface RosterRow { name: string; netid: string; github: string; lead: boolean }

export interface ScreenDef { key: ConsoleScreen; label: string; request: RequestType; empty: string }

/** Screen order = the number-key order (1 SWEEPS … 5 ROSTER) and the Tab cycle. */
export const CONSOLE_SCREENS: ScreenDef[] = [
  { key: "sweeps", label: "SWEEPS", request: "sweep.list", empty: "no sweep jobs" },
  { key: "boards", label: "BOARDS", request: "boards.get", empty: "nothing actionable right now" },
  { key: "assign", label: "ASSIGN", request: "assign.suggest", empty: "nothing to suggest" },
  { key: "lead_desk", label: "LEAD DESK", request: "lead.desk", empty: "no open Lead Ops tasks" },
  { key: "roster", label: "ROSTER", request: "roster.get", empty: "empty roster" },
];

function pad(s: string, n: number): string { return s.length >= n ? s : s + " ".repeat(n - s.length); }

const FORMATTERS: Record<ConsoleScreen, (row: unknown) => string> = {
  sweeps: (row) => {
    const r = row as SweepRow;
    return `${pad(r.ticketKey, 8)} ${pad(r.kind, 10)} ${pad(r.state, 12)} ${r.prNumber != null ? `PR#${r.prNumber}` : "—"}  cyc=${r.cycles}` +
      `${r.sessionId ? "  ⏎attach" : ""}${r.reason ? `  — ${r.reason}` : ""}`;
  },
  boards: (row) => { const r = row as BoardRow; return `${pad(r.ticketKey, 8)} unblocks ${pad(String(r.downstream), 3)} ${r.title}`; },
  assign: (row) => { const r = row as AssignRow; return `${pad(r.ticketKey, 8)} → ${pad(r.name, 20)} (${r.netid}, load ${r.load})`; },
  lead_desk: (row) => { const r = row as DeskRow; return `${pad(r.ticketKey, 8)} [${pad(r.state, 12)}] → ${pad(r.assignee, 20)} ${r.title}`; },
  roster: (row) => { const r = row as RosterRow; return `${pad(r.name, 22)} ${pad(r.netid, 8)} @${r.github}${r.lead ? "  — lead" : ""}`; },
};

/** The one-line rendering of a row on a screen. */
export function formatRow(screen: ConsoleScreen, row: unknown): string {
  return FORMATTERS[screen](row);
}

/** Clamp a cursor into [0, len) (len 0 → 0). */
export function clampCursor(cursor: number, len: number): number {
  if (len <= 0) return 0;
  return Math.max(0, Math.min(cursor, len - 1));
}

/** Move the cursor by delta within len, clamped — no wrap (rows must not jump the cursor across ends). */
export function moveCursor(cursor: number, delta: number, len: number): number {
  return clampCursor(cursor + delta, len);
}

/** The session to attach to for the selected row, or null — only a SWEEPS row that has a live session. */
export function attachTarget(screen: ConsoleScreen, rows: unknown[], index: number): string | null {
  if (screen !== "sweeps") return null;
  const r = rows[index] as SweepRow | undefined;
  return r?.sessionId ?? null;
}

/**
 * Apply one keystroke to the single-line ASK input (PRD §10 chat pane): backspace/delete drops the last
 * char, a lone printable char appends, everything else (control keys, multi-char pastes, DEL) is ignored.
 * Pure — the Ink pane holds the string, this decides the next one.
 */
export function editInput(current: string, ch: string, key: { backspace?: boolean; delete?: boolean }): string {
  if (key.backspace || key.delete) return current.slice(0, -1);
  if (ch.length === 1 && ch >= " " && ch !== "\x7f") return current + ch;
  return current;
}
