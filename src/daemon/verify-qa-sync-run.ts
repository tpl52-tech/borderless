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
        results.push({ ticketKey: row.ticketKey, verdict: row.verdict, action: "would-sync", movedToDone: decision.moveToDone });
        continue;
      }
      const url = await deps.postComment(issue.id, buildVerdictComment(row));
      let movedToDone = false;
      let detail: string | undefined;
      if (decision.moveToDone) {
        const stateId = await deps.doneStateId();
        if (stateId) { await deps.setState(issue.id, stateId); movedToDone = true; }
        else detail = "commented; no Done workflow state found to move to";
      }
      results.push({ ticketKey: row.ticketKey, verdict: row.verdict, action: "synced", movedToDone, url, ...(detail ? { detail } : {}) });
    } catch (err) {
      results.push({ ticketKey: row.ticketKey, verdict: row.verdict, action: "error", detail: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}
