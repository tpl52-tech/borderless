/**
 * QA-fix sweep runner (PRD §13) — the thin live orchestration over the verify-qa-fix brain: read the tester
 * verdicts Cue QA saved to Supabase, and drive each feature ticket. A FAIL/BLOCKED opens a follow-up ticket (in
 * the team's Todo state) under the feature ticket, which itself stays put; a PASS closes the feature ticket (→
 * Done). Idempotent, and safe-by-default (a dry run plans without writing).
 *
 * All I/O is injected (the Supabase read, two store lookups, the children-descriptions read, the team/label +
 * Todo/Done-state resolution, and the three writes), so the control flow is unit-tested with fakes; index.ts
 * wires the live ones.
 *
 * Idempotency, since a create is NOT idempotent: the `fixMarker` lives in the created ticket's description, and
 * the dedupe scans the feature ticket's children for it — the create is the dedupe artifact, so a create that
 * succeeds can never be re-made and a create that fails strands nothing. The breadcrumb comment on the sub-issue
 * is a best-effort LAST step (non-fatal: the dedupe reads the children, not this comment). The PASS close is a
 * plain idempotent `setState` (no artifact), gated so a feature with a failing sibling this run is not closed.
 */

import {
  actionableVerdicts, decideFix, shouldCloseFeature, buildFixTitle, buildFixBody, buildFixTicketInput,
  type QaFixResult, type QaFixKind, type Difficulty,
} from "../shared/verify-qa-fix.ts";
import type { QaVerdictRow } from "../shared/verify-qa-sync.ts";
import type { IssueCreateInput } from "../shared/linear.ts";

export interface QaFixDeps {
  /** Read the raw `qa_runs` rows from Supabase. Parsed to every recorded verdict here. */
  readVerdicts: () => Promise<unknown>;
  /** The synced manual-QA sub-issue by key → its UUID + its parent feature ticket's UUID; undefined ⇒ not in the store. */
  subIssueByKey: (key: string) => { id: string; parentId: string | null } | undefined;
  /** The feature ticket by UUID → the fields needed to file the fix + close it (description = the acceptance criteria for the difficulty assessment); undefined ⇒ not in the store. */
  parentByUuid: (uuid: string) => { id: string; identifier: string; title: string; description: string | null; projectId: string | null; stateType: string | null; priority: number | null } | undefined;
  /** The feature ticket's existing children's descriptions (the idempotency source — a child carries the marker). */
  childDescriptions: (parentUuid: string) => Promise<string[]>;
  /** The team id + the `qa-fix` / `qa-blocked` + the three `difficulty:` label ids (resolved/created once, lazily). */
  targets: () => Promise<{ teamId: string; fixLabelId: string; blockedLabelId: string; difficultyLabelIds: { easy: string; medium: string; hard: string } }>;
  /** Rate how hard a FAIL's fix is (LLM, else a step-count heuristic) from the failure notes + the feature's acceptance criteria. */
  assessDifficulty: (row: QaVerdictRow, acceptance: string | null) => Promise<Difficulty>;
  /** The team's "Todo" workflow-state id — the state a new fix/blocked ticket OPENS in (resolved once, lazily); null ⇒ the team default state. */
  todoStateId: () => Promise<string | null>;
  /** The team's "Done" workflow-state id (where a QA-passed feature ticket moves; resolved once, lazily); null ⇒ none. */
  doneStateId: () => Promise<string | null>;
  /** Create the fix/blocked ticket → its key + url. */
  createIssue: (input: IssueCreateInput) => Promise<{ ticketKey: string; url: string | null }>;
  /** Move the feature ticket to the given workflow state (Done, on a PASS). */
  setState: (issueId: string, stateId: string) => Promise<void>;
  /** Best-effort breadcrumb on the sub-issue pointing at the new ticket (non-authoritative; failure is non-fatal). */
  postComment: (issueId: string, body: string) => Promise<string | null>;
  /** false ⇒ dry run: decide only, never resolve targets/state, never write. */
  write: boolean;
}

/** Run the QA-fix sweep: read the verdicts, then drive each feature ticket — FAIL/BLOCKED opens a ticket, PASS closes it. */
export async function runQaFixSweep(deps: QaFixDeps): Promise<QaFixResult[]> {
  const rows = actionableVerdicts(await deps.readVerdicts());
  // Parents that have a FAIL/BLOCKED in THIS run — a sibling PASS must not close them (the fail/blocked outcome,
  // Todo + a qa-fix ticket, wins). Precomputed so the PASS path is deterministic regardless of row order: without
  // this, a parent with both a pass and a fail would end Done or Todo depending on which Supabase row came first.
  const parentsWithOpenWork = new Set<string>();
  for (const row of rows) {
    if (row.verdict === "pass") continue;
    const sub = deps.subIssueByKey(row.ticketKey);
    if (sub?.parentId) parentsWithOpenWork.add(sub.parentId);
  }
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
        if (parentsWithOpenWork.has(sub.parentId)) {
          results.push({ subKey: row.ticketKey, parentKey: parent.identifier, kind: "pass", action: "skipped-verified", detail: "a failing/blocked QA item under this feature is being handled this run" });
          continue;
        }
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
      const decision = decideFix(row, { childDescriptions: descriptions });
      if (decision.alreadyExists) {
        results.push({ subKey: row.ticketKey, parentKey: parent.identifier, kind, action: "skipped-exists" });
        continue;
      }
      if (!deps.write) {
        results.push({ subKey: row.ticketKey, parentKey: parent.identifier, kind, action: "would-create" });
        continue;
      }

      // The fix/blocked ticket is the actionable item, so it opens in the team's Todo state; the feature ticket
      // itself is NOT moved (it stays in Verifying as the umbrella). Create is the dedupe artifact (its body holds
      // the marker), so a failed create strands nothing; the breadcrumb on the sub-issue is a best-effort last step.
      const todoId = await deps.todoStateId();
      const t = await deps.targets();
      const isFix = decision.kind === "fix";
      const labelId = isFix ? t.fixLabelId : t.blockedLabelId;
      // Rate how hard the fix is (fix tickets only) from the failure + the feature's acceptance criteria, and
      // attach the matching `difficulty:` label. Assessed here, once, on create — a re-run is skipped-exists.
      const difficulty = isFix ? await deps.assessDifficulty(row, parent.description) : undefined;
      const input = buildFixTicketInput({
        teamId: t.teamId, projectId: parent.projectId, parentId: parent.id, labelId,
        title: buildFixTitle(decision.kind, parent.title),
        description: buildFixBody(decision.kind, row, { parentKey: parent.identifier, subKey: row.ticketKey }),
        parentPriority: parent.priority,
        stateId: todoId ?? undefined,
        difficultyLabelId: difficulty ? t.difficultyLabelIds[difficulty] : undefined,
      });
      const created = await deps.createIssue(input);

      try {
        await deps.postComment(sub.id, `Opened **${created.ticketKey}** from this QA ${isFix ? "fail" : "block"} — ao.`);
      } catch { /* non-fatal: the ticket (the dedupe artifact) exists; the breadcrumb is a convenience */ }

      results.push({ subKey: row.ticketKey, parentKey: parent.identifier, kind: decision.kind, action: "created", fixKey: created.ticketKey, url: created.url, ...(difficulty ? { difficulty } : {}), ...(todoId ? {} : { detail: "no Todo workflow state found — opened in the team default state" }) });
    } catch (err) {
      results.push({ subKey: row.ticketKey, parentKey: parent.identifier, kind, action: "error", detail: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}
