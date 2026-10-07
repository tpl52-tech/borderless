/**
 * Sweep collision guard (PRD §4 — "risky changes always get an explicit human") — the pure brain that stops
 * a sweep from silently shipping a deliverable another teammate's ticket already owns.
 *
 * The failure it prevents: a sweep drives/implements ticket X and, along the way, creates or extracts a file
 * or component (e.g. a shared `ConditionStars.tsx`) that is in fact the deliverable of a SEPARATE, assigned,
 * in-progress ticket Y. The agent can't see the board, so it duplicates a teammate's work and the sweep
 * would happily mark it ready-to-merge. This module cross-checks the PR's changed paths against the
 * "territory" other assigned tickets own; a hit becomes a gate escalation (needs_human), never an auto-ready.
 *
 * No I/O. The engine feeds the changed paths (same ones `dangerousTiers` uses) + a territory the daemon
 * builds from the synced board; this decides the collisions and the human-facing reason.
 */

import type { LinearIssue } from "./types.ts";
import { isTerminalState } from "./boards.ts";
import { isLeadOps } from "./lead-desk.ts";
import { buildRosterIndexes, type Member } from "./roster.ts";

// Ultra-generic stems carry no ownership signal (shared infra files many tickets touch) — matching on them
// would flag every sweep. A real deliverable is a component or a specifically-named file, not `index.ts`.
const GENERIC_STEMS = new Set([
  "index", "types", "type", "utils", "util", "helpers", "helper",
  "config", "constants", "main", "app", "styles", "style",
]);

const CODE_FILE = /([a-z][a-z0-9_]*)\.(?:tsx?|jsx?)\b/gi; // `Foo.tsx` / `bar.ts` → the stem (`Foo` / `bar`)
const COMPONENT = /\b([A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+)\b/g; // multi-hump PascalCase: ConditionStars, ItemCard

/**
 * Deliverable tokens named in a piece of text (a ticket's title/description, or a changed path): component
 * names + code filenames, original-cased, deduped case-insensitively, with the generic infra stems dropped.
 * Multi-hump PascalCase only (ConditionStars ✓, Home ✗) keeps precision high — a false collision only costs
 * a human glance, but matching bare words like "Home"/"Login" would flag everything and erode trust.
 *
 * Recall is deliberately narrow (precision over recall): the filename rule takes only the final stem
 * (`sweep-gate.ts` → `gate`), and acronym-prefixed components (`APIClient`) aren't matched. A deliverable a
 * ticket only describes in prose is caught by human coordination, not this guard. Pure.
 */
export function deliverableTokens(text: string): string[] {
  const byLower = new Map<string, string>(); // lowercased key → first original-cased spelling seen
  const add = (t: string): void => {
    const lower = t.toLowerCase();
    if (!GENERIC_STEMS.has(lower) && !byLower.has(lower)) byLower.set(lower, t);
  };
  // Components first, so a PascalCase spelling (ConditionStars) wins the display over a `.tsx` stem of the same token.
  for (const m of text.matchAll(COMPONENT)) add(m[1]!);
  for (const m of text.matchAll(CODE_FILE)) add(m[1]!);
  return [...byLower.values()];
}

/** The ticket that owns a deliverable — also the shape of a collision (the owner a changed path lands on). */
export interface TicketOwner { ticketKey: string; owner: string; state: string; deliverable: string }

/** Lowercased deliverable token → the OTHER assigned, non-terminal ticket that owns it. */
export type Territory = Map<string, TicketOwner>;

/**
 * The deliverables owned by OTHER tickets, from the synced board (PRD §4). A ticket "owns" a deliverable
 * only when it is a real claim: not the sweep's own ticket, assigned to someone, not terminal, and not a
 * Lead Ops task (those aren't code). First claimant of a token wins. Pure (roster passed in, as elsewhere).
 */
export function buildTerritory(issues: LinearIssue[], targetKey: string, roster: Member[], leadOpsProject?: string): Territory {
  const byLinearId = buildRosterIndexes(roster).byLinearId;
  const territory: Territory = new Map();
  for (const issue of issues) {
    if (issue.identifier === targetKey) continue; // a sweep never collides with its own ticket
    if (!issue.assignee) continue; // only a dedicated, ASSIGNED ticket owns a deliverable
    if (isTerminalState(issue.stateType)) continue; // done/canceled tickets own nothing
    if (isLeadOps(issue, leadOpsProject)) continue; // lead-desk tasks aren't code deliverables
    const owner = byLinearId.get(issue.assignee)?.name ?? "a teammate";
    const state = issue.stateName ?? "open";
    for (const token of deliverableTokens(`${issue.title} ${issue.description ?? ""}`)) {
      const key = token.toLowerCase();
      if (!territory.has(key)) territory.set(key, { ticketKey: issue.identifier, owner, state, deliverable: token });
    }
  }
  return territory;
}

/** The owning tickets a PR's changed paths land on (deduped per owning ticket + deliverable). Pure. */
export function detectCollisions(changedPaths: string[], territory: Territory): TicketOwner[] {
  const seen = new Set<string>();
  const collisions: TicketOwner[] = [];
  for (const path of changedPaths) {
    for (const token of deliverableTokens(path)) {
      const owner = territory.get(token.toLowerCase());
      if (!owner) continue;
      const key = `${owner.ticketKey}:${owner.deliverable}`;
      if (seen.has(key)) continue;
      seen.add(key);
      collisions.push(owner);
    }
  }
  return collisions;
}

const MAX_LISTED = 3; // keep the escalation reason legible when a PR straddles several tickets

/** The human-facing escalation reason for a set of collisions, or null when there are none. Pure. */
export function collisionEscalation(collisions: TicketOwner[]): string | null {
  if (collisions.length === 0) return null;
  const listed = collisions.slice(0, MAX_LISTED).map((c) => `${c.deliverable} (owned by ${c.ticketKey} ${c.owner}, ${c.state})`);
  const extra = collisions.length - listed.length;
  const tail = extra > 0 ? `, +${extra} more` : "";
  return `coordination: PR touches ${listed.join("; ")}${tail} — another assigned ticket owns this; coordinate before merging`;
}

const MAX_WARNED = 25; // keep the seed bounded even on a busy board

/**
 * The PREVENTIVE half of the guard: a worker-seed block listing the deliverables other active tickets own,
 * so the agent avoids creating/extracting them up front (saving the wasted cycle the gate would otherwise
 * catch). One line per owned deliverable, capped. Null when the territory is empty. Pure.
 */
export function territoryWarning(territory: Territory): string | null {
  if (territory.size === 0) return null;
  // No dedup needed: the territory map has one entry per lowercased token, each with a unique deliverable.
  const all = [...territory.values()].map((o) => `  - ${o.deliverable} — owned by ${o.ticketKey} (${o.owner}, ${o.state})`);
  const shown = all.slice(0, MAX_WARNED);
  const extra = all.length - shown.length;
  if (extra > 0) shown.push(`  - …and ${extra} more`);
  return [
    "Another teammate's assigned ticket owns these files/components — do NOT create, extract, or rewrite them:",
    ...shown,
    "If your change needs one of these, STOP and say so in your output rather than duplicating it; the lead will coordinate.",
  ].join("\n");
}
