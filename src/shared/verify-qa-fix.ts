/**
 * QA-fix sweep (PRD §13) — the pure brain for turning a FINISHED Cue QA verdict into follow-up work. The mirror
 * of verify-qa-sync.ts: that carries a verdict back onto the manual-QA sub-issue (comment; Done on a pass); this
 * takes the actionable verdicts — a FAIL or a BLOCKED — and shapes a new ticket for the dev team.
 *
 *   FAIL    → a `qa-fix`-labelled ticket (the failed steps + tester notes) hung under the feature ticket, and the
 *             feature ticket is moved back out of Verifying (→ Todo).
 *   BLOCKED → a separate `qa-blocked` ("needs-info / unblock") ticket under the feature ticket; the feature ticket
 *             is left in place (blocked ≠ failed — a human decides what unblocks it).
 *   PASS    → the feature ticket is moved to Done (QA verified it); no ticket is created. (verify-qa-sync
 *             separately moves the manual-QA SUB-issue to Done; this closes the parent feature ticket.)
 *
 * Both new tickets are UNASSIGNED (triage). Idempotency is non-trivial because a create is NOT idempotent (unlike
 * a state move): re-running must not make a second ticket. So the `fixMarker(verdictAt)` lives in the created
 * ticket's own description, and the dedupe (decideFix) scans the feature ticket's existing children for it — the
 * created ticket IS the marker, with no second write to strand. No I/O — the live runner does the reads + writes.
 */

import {
  parseQaRunsRows, summarizeSteps, testerLabel, type QaRun, type QaVerdictRow,
} from "./verify-qa-sync.ts";
import { buildQaSubIssueInput } from "./verify-qa.ts";
import type { IssueCreateInput } from "./linear.ts";

/** The Linear labels the two ticket kinds carry (created on first use). */
export const QA_FIX_LABEL = "qa-fix";
export const QA_BLOCKED_LABEL = "qa-blocked";

/** A failed verdict → a `fix` ticket; a blocked verdict → a `blocked` (needs-info) ticket; a passed verdict closes the feature ticket. */
export type QaFixKind = "fix" | "blocked" | "pass";

/**
 * What happened to one actionable verdict:
 * - create path (FAIL/BLOCKED): `created` / `would-create` (dry) / `skipped-exists` (ticket already made).
 * - verify path (PASS): `verified` (feature ticket moved to Done) / `would-verify` (dry) / `skipped-verified`
 *   (already closed, or no Done state).
 * - common: `skipped-no-parent` (no feature ticket to act on) / `error`.
 */
export type QaFixAction =
  | "created" | "would-create" | "skipped-exists"
  | "verified" | "would-verify" | "skipped-verified"
  | "skipped-no-parent" | "error";

/** One verdict's QA-fix outcome — the wire shape `ao verify qa-fix` renders. */
export interface QaFixResult {
  /** The manual-QA sub-issue the verdict was recorded against, e.g. "COR-91". */
  subKey: string;
  /** The feature ticket the fix hangs under, e.g. "COR-17" (absent when it couldn't be resolved). */
  parentKey?: string;
  kind: QaFixKind;
  action: QaFixAction;
  /** The created fix/blocked ticket's key (on `created`). */
  fixKey?: string;
  url?: string | null;
  /** true when the feature ticket was moved back out of Verifying (→ Todo) — only ever for a `fix`. */
  movedParent?: boolean;
  detail?: string;
}

/** The QA-fix run as the daemon surfaces it: the per-verdict results + whether it's configured + the mode. */
export interface VerifyQaFixResult {
  results: QaFixResult[];
  configured: boolean;
  /** false ⇒ a dry run (results are `would-create`); true ⇒ a write run (results say what happened). */
  wrote: boolean;
}

/** One verdict's QA-fix decision, given what Linear already holds for its feature ticket. */
export interface FixDecision {
  /** A child of the feature ticket already carries this verdict's marker — nothing to do. */
  alreadyExists: boolean;
  kind: QaFixKind;
  /** Move the feature ticket back out of Verifying — only for a `fix`, and only when it's still active. */
  moveParent: boolean;
}

/**
 * The idempotency marker embedded in every QA-fix ticket's description and matched to decide "already created".
 * Keyed by `verdictAt` (Cue QA sets it only when a verdict is recorded), so one marker ⇔ one distinct verdict
 * event: the same fail never spawns two tickets, and a genuinely new fail (new `verdictAt`) spawns a fresh one.
 */
export function fixMarker(verdictAt: number): string {
  return `ao-qa-fix:${verdictAt}`;
}

/** The feature-ticket state types from which a QA fail should NOT drag it to Todo: already settled or already out of the active lane. */
const SETTLED_STATE_TYPES = new Set(["backlog", "unstarted", "completed", "canceled"]);

/** Move the feature ticket on a fail only while it's still active (a `started`/`triage` state, e.g. Verifying) — never resurrect a Done/Canceled ticket or re-move one already in Todo. Pure. */
export function shouldMoveParent(parentStateType: string | null): boolean {
  return parentStateType != null && !SETTLED_STATE_TYPES.has(parentStateType);
}

/** State types from which a PASS should NOT move the feature ticket to Done: it's already closed. */
const CLOSED_STATE_TYPES = new Set(["completed", "canceled"]);

/** Close the feature ticket on a pass unless it's already completed/canceled (moving to Done is idempotent otherwise). Pure. */
export function shouldCloseFeature(parentStateType: string | null): boolean {
  return parentStateType == null || !CLOSED_STATE_TYPES.has(parentStateType);
}

/** The fix/blocked ticket title. Pure. */
export function buildFixTitle(kind: QaFixKind, parentTitle: string): string {
  const base = parentTitle.trim() || "untitled";
  return kind === "fix" ? `Fix: ${base} (QA failed)` : `QA blocked: ${base}`;
}

/** The fix/blocked ticket body — the failed steps + tester notes, the provenance links, and the idempotency marker. Pure. */
export function buildFixBody(kind: QaFixKind, row: QaVerdictRow, links: { parentKey: string; subKey: string }): string {
  const { run, verdictAt } = row;
  const who = testerLabel(run.verdictBy);
  const when = new Date(verdictAt).toISOString().slice(0, 10);
  const { passed, failed, failNotes } = summarizeSteps(run);

  const lines: string[] = [];
  if (kind === "fix") {
    lines.push(`A manual QA pass **failed** — recorded by ${who} · ${when}.`);
    lines.push("");
    lines.push(`Steps: ${passed} passed, ${failed} failed.`);
  } else {
    lines.push(`A tester was **blocked** during manual QA — recorded by ${who} · ${when}.`);
  }
  if (failNotes.length) {
    lines.push("");
    lines.push(kind === "fix" ? "What failed:" : "Notes:");
    for (const { step, note } of failNotes) lines.push(`- Step ${step}: ${note}`);
  }
  lines.push("");
  lines.push(`From the manual-QA run sheet ${links.subKey}, under ${links.parentKey}.`);
  lines.push("");
  lines.push("---");
  lines.push(`_Opened by ao from a Cue QA ${kind === "fix" ? "fail" : "block"} — ref ${fixMarker(verdictAt)}_`);
  return lines.join("\n");
}

/** Shape the Linear issueCreate input for a QA-fix/blocked ticket: an unassigned, labelled child in the feature ticket's project, inheriting its priority. Pure. */
export function buildFixTicketInput(args: {
  teamId: string;
  projectId: string;
  parentId: string;
  labelId: string;
  title: string;
  description: string;
  /** The feature ticket's Linear priority (0..4); inherited when set (>0), else left at the team default (None). */
  parentPriority?: number | null;
}): IssueCreateInput {
  const base = buildQaSubIssueInput({
    teamId: args.teamId, projectId: args.projectId, parentId: args.parentId,
    labelId: args.labelId, title: args.title, description: args.description,
  });
  return typeof args.parentPriority === "number" && args.parentPriority > 0
    ? { ...base, priority: args.parentPriority }
    : base;
}

/**
 * Decide what one actionable verdict needs. Idempotent on the marker: if a child of the feature ticket already
 * carries it, skip entirely. A FAIL becomes a fix ticket and moves the feature ticket out of an active lane; a
 * BLOCKED becomes a needs-info ticket and never moves the feature ticket. Pure.
 */
export function decideFix(
  row: QaVerdictRow,
  ctx: { childDescriptions: readonly string[]; parentStateType: string | null },
): FixDecision {
  const kind: QaFixKind = row.verdict === "fail" ? "fix" : "blocked";
  const marker = fixMarker(row.verdictAt);
  const alreadyExists = ctx.childDescriptions.some((d) => d.includes(marker));
  return { alreadyExists, kind, moveParent: kind === "fix" && shouldMoveParent(ctx.parentStateType) };
}

/** The verdicts the QA-fix sweep drives the feature ticket from: every recorded one — a FAIL/BLOCKED opens a ticket, a PASS closes the feature ticket. (Equivalent to the parsed rows; a named seam the runner reads through.) */
export function actionableVerdicts(raw: unknown): QaVerdictRow[] {
  return parseQaRunsRows(raw);
}

/** Re-exported so the runner builds its deps against one QaRun shape. */
export type { QaRun };
