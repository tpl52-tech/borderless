/**
 * Autonomy env config (design §13.6). Runtime authority is environment-only ON PURPOSE — "install the
 * daemon" and "let it act" are separate decisions.
 *
 * AO_AUTONOMY=1 enables EXACTLY nudge-agent, request-codex, review-bot-followups, cto-review-followups
 * (worst case stays inside the PR/agent pair). Anything else is a comma list; request-cto, cto-followups,
 * cto-review-delay-nudge, thermo-regrade must be NAMED (they spend a human's time, open tickets, or jump
 * queues). Config is read once per process; the kill switch and extension file are read LIVE.
 */

import type { AutonomyDecision, Location } from "../../shared/types.ts";

/** The set AO_AUTONOMY=1 turns on (design §13.6). */
export const SAFE_ACTIONS: AutonomyDecision[] = [
  "nudge-agent", "request-codex", "review-bot-followups", "cto-review-followups",
];

/** Actions that must be explicitly named — never enabled by `=1` (design §13.6). */
export const NAMED_ONLY_ACTIONS: AutonomyDecision[] = [
  "request-cto", "cto-followups", "cto-review-delay-nudge", "thermo-regrade",
];

export interface AutonomyConfig {
  enabled: boolean;
  actions: Set<AutonomyDecision>;
  dryRun: boolean;
  /** always act (bypass the scheduled window)? AO_AUTONOMY_ALWAYS=1. */
  always: boolean;
  /** allow-listed session ids, or null for all. */
  sessions: Set<string> | null;
  /** owned locations, or null for all. */
  locations: Set<Location> | null;
}

function parseSet(raw: string | undefined): Set<string> | null {
  const t = raw?.trim();
  if (!t) return null;
  return new Set(t.split(",").map((s) => s.trim()).filter(Boolean));
}

export function parseAutonomyConfig(env: Record<string, string | undefined> = process.env): AutonomyConfig {
  const raw = (env.AO_AUTONOMY ?? "").trim();
  const actions = new Set<AutonomyDecision>();
  let enabled = false;
  if (raw === "1") {
    enabled = true;
    for (const a of SAFE_ACTIONS) actions.add(a);
  } else if (raw && raw !== "0") {
    enabled = true;
    for (const a of raw.split(",").map((s) => s.trim()).filter(Boolean)) actions.add(a as AutonomyDecision);
  }
  const locs = parseSet(env.AO_AUTONOMY_LOCATIONS);
  return {
    enabled,
    actions,
    dryRun: (env.AO_AUTONOMY_DRY_RUN ?? "").trim() === "1",
    always: (env.AO_AUTONOMY_ALWAYS ?? "").trim() === "1",
    sessions: parseSet(env.AO_AUTONOMY_SESSIONS),
    locations: locs as Set<Location> | null,
  };
}
