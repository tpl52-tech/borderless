/**
 * Borderless console view-model (PRD §11) — PURE + tested, so the Ink console (console.tsx) is thin render.
 *
 * Owns: the screen registry (which daemon request feeds each screen + the empty-state line), the nav/crumb
 * labels, cursor clamping/movement (no wrap — rows never move under the cursor, §19), which selected row is
 * attachable (only a SWEEPS row with a live session), the ASK single-line editor, and the structured
 * derivations the rich screens render from — hero stats, sweep partitions, state/kind tones, and the
 * fixed-width table cell. No Ink, no I/O; console.tsx maps these to boxes + colors.
 */

import type { RequestType } from "../shared/wire.ts";
import type { SweepState, SweepKind } from "../shared/types.ts";
import type { Tone } from "./theme.ts";
import type { DeskRow } from "../shared/lead-desk.ts"; // the lead.desk handler returns this canonical shape

export type ConsoleScreen = "sweeps" | "boards" | "assign" | "lead_desk" | "roster";

// The wire shapes the daemon handlers return, one per screen (DeskRow is reused from shared/lead-desk).
export interface SweepRow { ticketKey: string; kind: SweepKind; state: SweepState; owner: string | null; prNumber: number | null; cycles: number; reason: string | null; sessionId: string | null }
export interface BoardRow { ticketKey: string; title: string; downstream: number }
export interface AssignRow { ticketKey: string; netid: string; name: string; load: number }
export interface RosterRow { name: string; netid: string; github: string; lead: boolean }

export interface ScreenDef { key: ConsoleScreen; label: string; nav: string; request: RequestType; empty: string }

/** Screen order = the number-key order (1 SWEEPS … 5 ROSTER) and the first five of the Tab cycle. */
export const CONSOLE_SCREENS: ScreenDef[] = [
  { key: "sweeps", label: "SWEEP CONSOLE", nav: "SWEEPS", request: "sweep.list", empty: "no sweep jobs yet — nothing in review, nothing rescued" },
  { key: "boards", label: "BOARDS", nav: "BOARDS", request: "boards.get", empty: "nothing actionable right now" },
  { key: "assign", label: "ASSIGN", nav: "ASSIGN", request: "assign.suggest", empty: "nothing to suggest" },
  { key: "lead_desk", label: "LEAD DESK", nav: "LEAD_DESK", request: "lead.desk", empty: "no open Lead Ops tasks" },
  { key: "roster", label: "ROSTER", nav: "ROSTER", request: "roster.get", empty: "empty roster" },
];

/** The sidebar / tab labels, with ASK appended after the five list screens. */
export const NAV_LABELS: string[] = [...CONSOLE_SCREENS.map((s) => s.nav), "ASK"];

/** The breadcrumb for a screen index (ASK is the last tab). */
export function crumbLabel(screenIdx: number): string {
  return NAV_LABELS[screenIdx] ?? NAV_LABELS[0]!;
}

/**
 * Pad or truncate a value to exactly `width` columns (truncation keeps a trailing ellipsis). Pure.
 * Null-safe: a client/daemon version skew can hand a row a missing field, so a nullish value renders
 * as blank rather than crashing the whole TUI on `.length` (the failure mode the old `pad` had).
 */
export function cell(value: string, width: number, align: "left" | "right" = "left"): string {
  const s = value ?? "";
  if (width <= 0) return "";
  if (s.length > width) return width <= 1 ? s.slice(0, width) : s.slice(0, width - 1) + "…";
  const padding = " ".repeat(width - s.length);
  return align === "right" ? padding + s : s + padding;
}

// --- SWEEPS derivations (the hero numbers + the three panels all come from the one sweep list) -----------

/** The hero summary line's counts (PRD §11): scope + how the queue breaks down. Pure. */
export interface HeroStats { inScope: number; active: number; ready: number; needsYou: number }

const ACTIVE_STATES = new Set<SweepState>(["implementing", "fixing", "reviewing", "ci", "queued"]);

export function heroStats(sweeps: SweepRow[]): HeroStats {
  let active = 0, ready = 0, needsYou = 0;
  for (const s of sweeps) {
    if (s.state === "ready") ready++;
    else if (s.state === "needs_human") needsYou++;
    else if (ACTIVE_STATES.has(s.state)) active++;
  }
  return { inScope: sweeps.length, active, ready, needsYou };
}

/** The rows that drop into the READY_TO_MERGE / NEEDS_YOU side panels (subsets of the queue). Pure. */
export function readyRows(sweeps: SweepRow[]): SweepRow[] { return sweeps.filter((s) => s.state === "ready"); }
export function needsYouRows(sweeps: SweepRow[]): SweepRow[] { return sweeps.filter((s) => s.state === "needs_human"); }

/** Foreground tone for a sweep state (matches the HTML mock's s-green/s-ink/s-dim/s-pink classes). */
export function stateTone(state: SweepState): Tone {
  switch (state) {
    case "ready": case "merged": return "green";
    case "needs_human": return "pink";
    case "failed": return "red";
    case "queued": case "ci": return "dim";
    default: return "ink"; // implementing / fixing / reviewing
  }
}

/** Foreground tone for a sweep kind (rescue reads pink, in-review reads muted — the mock's k-rescue/k-review). */
export function kindTone(kind: SweepKind): Tone {
  return kind === "rescue" ? "pink" : "ink2";
}

/** How a kind is spelled in the queue table. */
export function kindLabel(kind: SweepKind): string {
  return kind === "rescue" ? "rescue" : "review";
}

// --- nav / cursor / attach / ask-editor ------------------------------------------------------------------

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

// `DeskRow` is re-exported so console.tsx renders the lead-desk shape without reaching into shared/.
export type { DeskRow };
