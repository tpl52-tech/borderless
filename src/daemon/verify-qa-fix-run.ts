/**
 * QA-fix sweep runner (PRD §13) — the thin live orchestration over the verify-qa-fix brain: read the tester
 * verdicts Cue QA saved to Supabase, and for each actionable one (a FAIL or a BLOCKED) open the follow-up ticket
 * under its feature ticket. Idempotent, and safe-by-default (a dry run plans without writing).
 *
 * All I/O is injected (the Supabase read, two store lookups, the children-descriptions read, the team/label +
 * Todo-state resolution, and the three writes), so the control flow is unit-tested with fakes; index.ts wires
 * the live ones.
 *
 * Ordering matters because a create is NOT idempotent. Per actionable verdict, in WRITE mode: move the feature
 * ticket to Todo FIRST (a `setState` is idempotent, so a later failure just re-moves it), then create the ticket
 * (whose description carries the `fixMarker` — the create is the dedupe artifact, so a create that succeeds can
 * never be re-made), then drop a best-effort breadcrumb comment on the sub-issue LAST (non-fatal: the ticket
 * already exists, and the dedupe reads the feature ticket's children, not this comment).
 */

import {
  actionableVerdicts, decideFix, shouldCloseFeature, buildFixTitle, buildFixBody, buildFixTicketInput,
  type QaFixResult, type QaFixKind,
} from "../shared/verify-qa-fix.ts";
import type { IssueCreateInput } from "../shared/linear.ts";

export interface QaFixDeps {
  /** Read the raw `qa_runs` rows from Supabase. Parsed to every recorded verdict here. */
  readVerdicts: () => Promise<unknown>;
  /** The synced manual-QA sub-issue by key → its UUID + its parent feature ticket's UUID; undefined ⇒ not in the store. */
  subIssueByKey: (key: string) => { id: string; parentId: string | null } | undefined;
  /** The feature ticket by UUID → the fields needed to file + move it; undefined ⇒ not in the store. */
  parentByUuid: (uuid: string) => { id: string; identifier: string; title: string; projectId: string | null; stateType: string | null; priority: number | null } | undefined;
  /** The feature ticket's existing children's descriptions (the idempotency source — a child carries the marker). */
  childDescriptions: (parentUuid: string) => Promise<string[]>;
  /** The team id + the `qa-fix` / `qa-blocked` label ids (resolved/created once, lazily). */
  targets: () => Promise<{ teamId: string; fixLabelId: string; blockedLabelId: string }>;
  /** The team's "Todo" workflow-state id (resolved once, lazily); null ⇒ none to move the feature ticket to. */
  todoStateId: () => Promise<string | null>;
  /** The team's "Done" workflow-state id (where a QA-passed feature ticket moves; resolved once, lazily); null ⇒ none. */
  doneStateId: () => Promise<string | null>;
  /** Create the fix/blocked ticket → its key + url. */
  createIssue: (input: IssueCreateInput) => Promise<{ ticketKey: string; url: string | null }>;
  /** Move the feature ticket to the given workflow state (Todo). */
  setState: (issueId: string, stateId: string) => Promise<void>;
  /** Best-effort breadcrumb on the sub-issue pointing at the new ticket (non-authoritative; failure is non-fatal). */
  postComment: (issueId: string, body: string) => Promise<string | null>;
  /** false ⇒ dry run: decide only, never resolve targets/state, never write. */
  write: boolean;
}

/** Run the QA-fix sweep: read the verdicts, then drive each feature ticket — FAIL/BLOCKED opens a ticket, PASS closes it. */
export async function runQaFixSweep(deps: QaFixDeps): Promise<QaFixResult[]> {
  const rows = actionableVerdicts(await deps.readVerdicts());
  const results: QaFixResult[] = [];
  for (const row of rows) {
    const kind: QaFixKind = row.verdict === "fail" ? "fix" : row.verdict === "blocked" ? "blocked" : "pass";
    const sub = deps.subIssueByKey(row.ticketKey);
    if (!sub) {
      results.push({ subKey: row.ticketKey, kind, action: "skipped-no-parent", detail: "no synced sub-issue in the store — run `ao sync`?" });
      continue;
    }
    if (!sub.parentId) {
      results.push({ subKey: row.ticketKey, kind, action: "skipped-no-parent", detail: "sub-issue has no parent feature ticket" });
      continue;
    }
    const parent = deps.parentByUuid(sub.parentId);
    if (!parent) {
      results.push({ subKey: row.ticketKey, kind, action: "skipped-no-parent", detail: "feature ticket not synced — run `ao sync`?" });
      continue;
    }
    try {
      // PASS → close the feature ticket (QA verified it). No ticket, no dedupe — a move to Done is idempotent.
      if (row.verdict === "pass") {
        if (!shouldCloseFeature(parent.stateType)) {
          results.push({ subKey: row.ticketKey, parentKey: parent.identifier, kind: "pass", action: "skipped-verified", detail: "feature ticket already closed" });
          continue;
        }
        if (!deps.write) {
          results.push({ subKey: row.ticketKey, parentKey: parent.identifier, kind: "pass", action: "would-verify" });
          continue;
        }
        const doneId = await deps.doneStateId();
        if (!doneId) {
          results.push({ subKey: row.ticketKey, parentKey: parent.identifier, kind: "pass", action: "skipped-verified", detail: "no Done workflow state found to move to" });
          continue;
        }
        await deps.setState(parent.id, doneId);
        results.push({ subKey: row.ticketKey, parentKey: parent.identifier, kind: "pass", action: "verified" });
        continue;
      }

      // FAIL / BLOCKED → open a follow-up ticket, which must be filed under a project.
      if (!parent.projectId) {
        results.push({ subKey: row.ticketKey, parentKey: parent.identifier, kind, action: "skipped-no-parent", detail: "feature ticket has no project to file the fix under" });
        continue;
      }
      const descriptions = await deps.childDescriptions(parent.id);
      const decision = decideFix(row, { childDescriptions: descriptions, parentStateType: parent.stateType });
      if (decision.alreadyExists) {
        results.push({ subKey: row.ticketKey, parentKey: parent.identifier, kind, action: "skipped-exists" });
        continue;
      }
      if (!deps.write) {
        results.push({ subKey: row.ticketKey, parentKey: parent.identifier, kind, action: "would-create", movedParent: decision.moveParent });
        continue;
      }

      // Move FIRST (idempotent), then create (the dedupe artifact), then breadcrumb (best-effort) — see header.
      let movedParent = false;
      let detail: string | undefined;
      if (decision.moveParent) {
        const stateId = await deps.todoStateId();
        if (stateId) { await deps.setState(parent.id, stateId); movedParent = true; }
        else detail = "no Todo workflow state found — ticket opened, feature ticket not moved";
      }

      const t = await deps.targets();
      const labelId = decision.kind === "fix" ? t.fixLabelId : t.blockedLabelId;
      const input = buildFixTicketInput({
        teamId: t.teamId, projectId: parent.projectId, parentId: parent.id, labelId,
        title: buildFixTitle(decision.kind, parent.title),
        description: buildFixBody(decision.kind, row, { parentKey: parent.identifier, subKey: row.ticketKey }),
        parentPriority: parent.priority,
      });
      const created = await deps.createIssue(input);

      try {
        await deps.postComment(sub.id, `Opened **${created.ticketKey}** from this QA ${decision.kind === "fix" ? "fail" : "block"} — ao.`);
      } catch { /* non-fatal: the ticket (the dedupe artifact) exists; the breadcrumb is a convenience */ }

      results.push({ subKey: row.ticketKey, parentKey: parent.identifier, kind: decision.kind, action: "created", fixKey: created.ticketKey, url: created.url, movedParent, ...(detail ? { detail } : {}) });
    } catch (err) {
      results.push({ subKey: row.ticketKey, parentKey: parent.identifier, kind, action: "error", detail: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}
