/**
 * Console row projections + the live snapshot — the ONE place the wire shapes for the lead console live, so
 * the Ink TUI (via the UDS server) and the browser console (via the web server) render byte-identical data.
 *
 * Pure: store reads are passed in (issues + sweep jobs); no I/O, no daemon imports. Both servers call these.
 */

import type { LinearIssue, SweepJob } from "./types.ts";
import { doNext } from "./boards.ts";
import { activeLoads, suggestAssignments } from "./assign.ts";
import { deskOverview } from "./lead-desk.ts";
import { ROSTER, memberByLinearId, type Member } from "./roster.ts";

/** The OWNER cell for a sweep job: the assignee's roster first name, else the raw Linear id, else null. */
export function sweepOwner(assignee: string | null): string | null {
  if (!assignee) return null;
  return memberByLinearId(assignee)?.name.split(" ")[0] ?? assignee;
}

/** The sweep-queue row shape both consoles render. */
export function sweepRow(j: SweepJob) {
  return {
    ticketKey: j.ticketKey, kind: j.kind, state: j.state, owner: sweepOwner(j.assignee),
    prNumber: j.prNumber, cycles: j.cycles, reason: j.reason, sessionId: j.sessionId,
  };
}

/** The roster row shape both consoles render (identity-safe: no emails/linearIds). */
export function rosterRow(m: Member) {
  return { name: m.name, netid: m.netid, github: m.github, lead: Boolean(m.lead) };
}

/** The full live snapshot spanning all six screens, from already-read store data. Pure. */
export function consolePayload(issues: LinearIssue[], sweepJobs: SweepJob[], leadOpsProject?: string) {
  const loads = activeLoads(issues, ROSTER);
  const ranked = doNext(issues);
  return {
    sweeps: sweepJobs.map(sweepRow),
    boards: ranked.map((e) => ({ ticketKey: e.issue.identifier, title: e.issue.title, downstream: e.downstream })),
    assign: suggestAssignments(ranked, ROSTER, loads).map((s) => ({ ticketKey: s.ticketKey, netid: s.netid, name: s.name, load: s.load })),
    desk: deskOverview(issues, ROSTER, leadOpsProject),
    roster: ROSTER.map(rosterRow),
    rosterLoad: ROSTER.map((m) => ({ name: m.name.split(" ")[0], netid: m.netid, lead: Boolean(m.lead), load: loads.get(m.netid) ?? 0 })),
    project: "ReUse · Fall 2026",
    now: Date.now(),
  };
}
