/**
 * Manual-QA sub-issue runner (PRD §13) — the thin live orchestration over the verify-qa brain: resolve the QA
 * targets (team + `manual-qa` label + the dev tickets that already have a child), plan which Verifying tickets
 * still need one, and — only on `write` — generate each run sheet and create the labelled sub-issue. Idempotent
 * (existing children are planned out) and safe-by-default (dry run plans without generating or writing).
 *
 * All I/O is injected (Linear query/create + the run-sheet generator + the store lookup), so the control flow
 * is unit-tested with fakes; index.ts wires the live Linear client, the subscription model, and the store.
 */

import type { VerifyRow } from "../shared/verify.ts";
import type { LinearIssue } from "../shared/types.ts";
import type { IssueCreateInput, CreatedIssue, QaTargets } from "../shared/linear.ts";
import { planQaSubIssues, buildQaSubIssueInput, type QaSubIssueResult } from "../shared/verify-qa.ts";

export interface QaSubIssueDeps {
  /** The classified Verifying rows to consider (the scan output, optionally narrowed to one ticket). */
  rows: readonly VerifyRow[];
  /** Resolve the team id, the `manual-qa` label id, and the dev keys that already have a child (idempotency). */
  qaTargets: () => Promise<QaTargets>;
  /** The synced dev ticket by key (for its UUID + project); undefined ⇒ not in the store. */
  issueByKey: (key: string) => LinearIssue | undefined;
  /** Generate the tester run-sheet markdown for a ticket (the subscription model, live). */
  generateRunsheet: (issue: LinearIssue) => Promise<string>;
  /** Create one Linear issue from the shaped input. */
  createIssue: (input: IssueCreateInput) => Promise<CreatedIssue>;
  /** false ⇒ dry run: plan only, never generate or create. */
  write: boolean;
}

/** Run the manual-QA sub-issue pass: plan from the classification, then create the missing ones (unless dry run). */
export async function runQaSubIssues(deps: QaSubIssueDeps): Promise<QaSubIssueResult[]> {
  const { teamId, labelId, existingParentKeys } = await deps.qaTargets();
  const plans = planQaSubIssues(deps.rows, new Set(existingParentKeys));
  const results: QaSubIssueResult[] = [];
  for (const plan of plans) {
    const issue = deps.issueByKey(plan.parentKey);
    if (!issue || !issue.projectId) {
      results.push({
        parentKey: plan.parentKey, title: plan.title, action: "skipped-no-parent",
        detail: !issue ? "no synced ticket in the store — run `ao sync`?" : "the ticket has no Linear project",
      });
      continue;
    }
    if (!deps.write) {
      results.push({ parentKey: plan.parentKey, title: plan.title, action: "would-create" });
      continue;
    }
    try {
      const description = (await deps.generateRunsheet(issue)).trim();
      if (!description) throw new Error("the run-sheet generator returned nothing");
      const created = await deps.createIssue(
        buildQaSubIssueInput({ teamId, projectId: issue.projectId, parentId: issue.id, labelId, title: plan.title, description }),
      );
      results.push({ parentKey: plan.parentKey, title: plan.title, action: "created", ticketKey: created.ticketKey, url: created.url });
    } catch (err) {
      results.push({ parentKey: plan.parentKey, title: plan.title, action: "error", detail: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}
