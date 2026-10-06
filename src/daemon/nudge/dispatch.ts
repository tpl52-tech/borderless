/**
 * Nudge dispatch order (design §10.5) — pure decision from a pane analysis + whether our own text is
 * already stranded there.
 *
 *   capture -> menu                      => DROP and report (holding can't help; a hold bound would
 *                                           eventually type into it)
 *          -> our text stranded, not busy => press ENTER only, never retype
 *          -> busy / pending input        => HOLD (re-enqueue at the front, bounded)
 *          -> otherwise                    => TYPE, settle, check cancellation, Enter, acknowledge
 *
 * Failed-capture asymmetry (design §10.5, §21): the box PROCEEDS on a failed capture, the Mac HOLDS.
 */

import type { PaneAnalysis } from "./pane-guards.ts";

export type NudgeDecision = "type" | "hold" | "press-enter-only" | "drop-menu";

export function dispatchDecision(pane: PaneAnalysis, ourTextStranded: boolean): NudgeDecision {
  if (pane.looksLikeMenu) return "drop-menu";
  if (ourTextStranded && !pane.looksBusy) return "press-enter-only";
  if (pane.looksBusy || pane.hasPendingInput) return "hold";
  return "type";
}

/** On a failed pane capture: the box proceeds (types), the Mac holds (design §10.5). */
export function onFailedCapture(host: "box" | "mac"): NudgeDecision {
  return host === "box" ? "type" : "hold";
}
