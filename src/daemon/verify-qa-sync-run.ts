/**
 * Manual-QA verdict writeback runner (PRD §13) — the thin live orchestration over the verify-qa-sync brain:
 * read the tester verdicts Cue QA saved to Supabase, and for each one carry the result back to its Linear
 * `manual-qa` sub-issue (post a comment; move to Done on a pass). Idempotent on a per-verdict ref marker, and
 * safe-by-default (a dry run plans without writing anything).
 *
 * All I/O is injected (the Supabase read, the store lookup, the Linear comment-bodies read, the Done-state
 * resolution, and the two writes), so the control flow is unit-tested with fakes; index.ts wires the live ones.
 */

import {
  parseQaRunsRows, buildVerdictComment, decideWriteback, type QaWritebackResult,
} from "../shared/verify-qa-sync.ts";

export interface QaWritebackDeps {
  /** Read the raw `qa_runs` rows from Supabase (the public Cue QA site's shared store). Parsed/validated here. */
  readVerdicts: () => Promise<unknown>;
  /** The synced sub-issue by key → its UUID + current workflow-state type; undefined ⇒ not in the store. */
  issueByKey: (key: string) => { id: string; stateType: string | null } | undefined;
  /** All of the sub-issue's existing comment bodies (the idempotency source). */
  commentBodies: (issueId: string) => Promise<string[]>;
  /** The team's "Done" workflow-state id (resolved once, lazily); null ⇒ no completed state to move to. */
  doneStateId: () => Promise<string | null>;
  /** Post the verdict comment on the sub-issue → the comment url (or null). */
  postComment: (issueId: string, body: string) => Promise<string | null>;
  /** Move the sub-issue to the given workflow state (Done). */
  setState: (issueId: string, stateId: string) => Promise<void>;
  /** The tester (verdictBy) resolved to their Linear user id + display name via the roster, or null when unknown (left unassigned). One lookup drives both the assignment and the credited name, so they can't drift. */
  resolveTester: (verdictBy: string | undefined) => { userId: string; name: string } | null;
  /** Assign the sub-issue to the given Linear user (marks the manual QA as performed by that tester). */
  setAssignee: (issueId: string, userId: string) => Promise<void>;
  /** false ⇒ dry run: decide only, never read comments beyond dedupe, never write. */
  write: boolean;
}

/** Run the verdict writeback: read the verdicts, then comment + (on pass) close each un-synced sub-issue. */
export async function runQaWriteback(deps: QaWritebackDeps): Promise<QaWritebackResult[]> {
  const rows = parseQaRunsRows(await deps.readVerdicts());
  const results: QaWritebackResult[] = [];
  for (const row of rows) {
    const issue = deps.issueByKey(row.ticketKey);
    if (!issue) {
      results.push({
        ticketKey: row.ticketKey, verdict: row.verdict, action: "skipped-unsynced",
        detail: "no synced sub-issue in the store — run `ao sync`?",
      });
      continue;
    }
    try {
      const bodies = await deps.commentBodies(issue.id);
      const decision = decideWriteback(row, { commentBodies: bodies, currentStateType: issue.stateType });
      if (decision.alreadySynced) {
        results.push({ ticketKey: row.ticketKey, verdict: row.verdict, action: "skipped-synced" });
        continue;
      }
      if (!deps.write) {
        // Dry run reflects INTENT (comment + the pass-move), not feasibility — it doesn't resolve the Done
        // state, so a real run may still find none and comment only.
        results.push({ ticketKey: row.ticketKey, verdict: row.verdict, action: "would-sync", movedToDone: decision.moveToDone });
        continue;
      }
      // Order matters: move to Done FIRST, post the (marker-carrying) comment LAST. The marker is what makes a
      // verdict "already synced", so it must only land once the whole writeback succeeded — a failed move then
      // leaves no marker and the next run retries both (the →Done move is idempotent). Comment-then-move would
      // strand a failed move forever (marker present ⇒ skipped next run).
      let movedToDone = false;
      let detail: string | undefined;
      if (decision.moveToDone) {
        const stateId = await deps.doneStateId();
        if (stateId) { await deps.setState(issue.id, stateId); movedToDone = true; }
        else detail = "no Done workflow state found to move to — commented only";
      }
      // Attribute the manual QA: assign the sub-issue to the tester who recorded the verdict (idempotent — the
      // same assignee re-set is a no-op). One roster lookup gives both the id to assign and the name to credit.
      // Done before the marker comment, so a failure retries without stranding. Fires for any verdict (pass or
      // fail) — the tester performed the QA either way.
      const tester = deps.resolveTester(row.run.verdictBy);
      if (tester) await deps.setAssignee(issue.id, tester.userId);
      const url = await deps.postComment(issue.id, buildVerdictComment(row));
      results.push({ ticketKey: row.ticketKey, verdict: row.verdict, action: "synced", movedToDone, url, ...(tester ? { assignedTo: tester.name } : {}), ...(detail ? { detail } : {}) });
    } catch (err) {
      results.push({ ticketKey: row.ticketKey, verdict: row.verdict, action: "error", detail: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}
