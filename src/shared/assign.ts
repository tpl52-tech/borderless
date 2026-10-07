/**
 * Assignment suggestions — the pure "who should take this?" scorer (lead-console PRD §8).
 *
 * No I/O: operates on the synced Linear issues + the roster. Suggests one assignee per unblocked ticket,
 * load-balanced, placing the highest critical-path-impact tickets first so the most-available person gets
 * the most-unblocking work. The lead approves with a keystroke — this NEVER auto-assigns (PRD §8). Past-fit
 * (who has done similar work) is a future input; there's no assignment-history signal to use yet.
 */

import type { LinearIssue } from "./types.ts";
import type { Member } from "./roster.ts";
import type { DoNextEntry } from "./boards.ts";

function isTerminal(stateType: string | null): boolean {
  return stateType === "completed" || stateType === "canceled";
}

/** Active (non-terminal) issue count per member netid, resolved via each member's Linear ids. */
export function activeLoads(
  issues: readonly Pick<LinearIssue, "assignee" | "stateType">[],
  members: readonly Member[],
): Map<string, number> {
  const netidByLinearId = new Map<string, string>();
  for (const m of members) for (const lid of m.linearIds) netidByLinearId.set(lid, m.netid);

  const loads = new Map<string, number>(members.map((m) => [m.netid, 0]));
  for (const issue of issues) {
    if (issue.assignee == null || isTerminal(issue.stateType)) continue;
    const netid = netidByLinearId.get(issue.assignee);
    if (netid != null) loads.set(netid, (loads.get(netid) ?? 0) + 1);
  }
  return loads;
}

export interface AssignmentSuggestion {
  ticketId: string;
  ticketKey: string;
  netid: string;
  name: string;
  load: number; // the suggested member's load at the moment of suggestion
}

/**
 * Suggest an assignee per unblocked ticket (PRD §8). Highest downstream-impact tickets are placed first,
 * each going to the currently-least-loaded member (ties broken by name); the pick's load is then reserved
 * so subsequent tickets spread across the team instead of piling onto one person. Pure — the lead decides.
 */
export function suggestAssignments(
  doNext: readonly DoNextEntry[],
  members: readonly Member[],
  baseLoads: ReadonlyMap<string, number>,
): AssignmentSuggestion[] {
  if (members.length === 0) return [];
  const load = new Map<string, number>(members.map((m) => [m.netid, baseLoads.get(m.netid) ?? 0]));

  const ordered = [...doNext].sort(
    (a, b) => b.downstream - a.downstream || a.issue.identifier.localeCompare(b.issue.identifier),
  );

  const suggestions: AssignmentSuggestion[] = [];
  for (const entry of ordered) {
    // least-loaded member, ties broken by name (n is small; a per-ticket sort is plenty)
    const pick = [...members].sort((a, b) => (load.get(a.netid)! - load.get(b.netid)!) || a.name.localeCompare(b.name))[0]!;
    suggestions.push({ ticketId: entry.issue.id, ticketKey: entry.issue.identifier, netid: pick.netid, name: pick.name, load: load.get(pick.netid)! });
    load.set(pick.netid, load.get(pick.netid)! + 1); // reserve capacity so suggestions spread
  }
  return suggestions;
}
