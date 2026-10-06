/**
 * Live boards — the pure "what's actionable and what to attack next" logic (lead-console PRD §7).
 *
 * No I/O: operates on the already-synced Linear issues (store.listLinearIssues). Two views:
 *  - §7a unblocked: every actionable ticket (not done/canceled, no open blocker);
 *  - §7b "do next": unblocked tickets ranked by how much downstream work each one unblocks (critical path),
 *    so the board answers "what to attack this session," not just "what's attackable."
 */

import type { LinearIssue } from "./types.ts";

type BoardIssue = Pick<LinearIssue, "id" | "identifier" | "title" | "stateType" | "blockedBy">;

/** A done/canceled ticket is finished — never actionable and never a live blocker. */
function isTerminal(stateType: string | null): boolean {
  return stateType === "completed" || stateType === "canceled";
}

/**
 * Actionable iff the ticket itself isn't terminal and every blocker is resolved. A *known* blocker (synced)
 * blocks until it's terminal; an unknown blocker (not in the set — e.g. external or unsynced) is treated as
 * resolved so one out-of-scope dependency can't hide the whole board.
 */
export function isUnblocked(issue: BoardIssue, byId: ReadonlyMap<string, BoardIssue>): boolean {
  if (isTerminal(issue.stateType)) return false;
  return issue.blockedBy.every((b) => {
    const blocker = byId.get(b);
    return !blocker || isTerminal(blocker.stateType);
  });
}

/** Index issues by id. */
function indexById<T extends { id: string }>(issues: readonly T[]): Map<string, T> {
  return new Map(issues.map((i) => [i.id, i]));
}

/** Every actionable ticket (PRD §7a). */
export function unblockedIssues<T extends BoardIssue>(issues: readonly T[]): T[] {
  const byId = indexById(issues);
  return issues.filter((i) => isUnblocked(i, byId));
}

/**
 * For each issue, how many *other* issues transitively depend on it (its downstream unblock impact). Built
 * over the reverse of the blockedBy edges (b unblocks everything that is blockedBy b). Cycle-safe via a
 * seen-set traversal.
 */
export function downstreamCounts(issues: readonly BoardIssue[]): Map<string, number> {
  const unblocks = new Map<string, string[]>(); // blocker id -> ids it directly unblocks
  for (const issue of issues) {
    for (const b of issue.blockedBy) {
      const list = unblocks.get(b);
      if (list) list.push(issue.id);
      else unblocks.set(b, [issue.id]);
    }
  }
  const counts = new Map<string, number>();
  for (const issue of issues) {
    const seen = new Set<string>();
    const stack = [...(unblocks.get(issue.id) ?? [])];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const dep of unblocks.get(id) ?? []) if (!seen.has(dep)) stack.push(dep);
    }
    seen.delete(issue.id); // a cycle could re-reach the start; it isn't its own downstream
    counts.set(issue.id, seen.size);
  }
  return counts;
}

export interface DoNextEntry<T extends BoardIssue = BoardIssue> {
  issue: T;
  downstream: number; // how many tickets this one transitively unblocks
}

/**
 * The "do next" board (PRD §7b): unblocked tickets ranked by downstream impact (most-unblocking first),
 * tie-broken by identifier for a stable order.
 */
export function doNext<T extends BoardIssue>(issues: readonly T[]): DoNextEntry<T>[] {
  const byId = indexById(issues);
  const counts = downstreamCounts(issues);
  return issues
    .filter((i) => isUnblocked(i, byId))
    .map((issue) => ({ issue, downstream: counts.get(issue.id) ?? 0 }))
    .sort((a, b) => b.downstream - a.downstream || a.issue.identifier.localeCompare(b.issue.identifier));
}
