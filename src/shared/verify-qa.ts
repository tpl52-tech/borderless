/**
 * Manual-QA sub-issue authoring (PRD §13) — the pure brain for turning a Verifying ticket's screen-observable
 * half into a tester-facing Linear sub-issue that Cue QA reads. The verify sweep proves the INVISIBLE backend;
 * this is its mirror image: for the VISIBLE half (a `ui`/`mixed` classification), a `manual-qa`-labelled child
 * of the dev ticket carrying a step-by-step run sheet generated from the acceptance criteria.
 *
 * No I/O here: `planQaSubIssues` decides which tickets need one (idempotent against the parents that already
 * have a child), `qaRunsheetPrompt` builds the generation prompt, and `buildQaSubIssueInput` shapes the Linear
 * create input. The live runner (daemon/verify-qa-run.ts) runs the generation + the create.
 */

import type { VerifyRow } from "./verify.ts";
import type { IssueCreateInput } from "./linear.ts";

/** The label Cue QA sources manual-QA run sheets by — the one marker the whole pipeline agrees on. */
export const QA_LABEL = "manual-qa";

/** How much acceptance-criteria text the run-sheet prompt embeds (long bodies are rare; a cut is marked). */
const MAX_AC_CHARS = 4000;

/** A planned manual-QA sub-issue: the dev ticket it hangs under + the child's title. */
export interface QaSubIssuePlan {
  parentKey: string;
  title: string;
}

/** What happened to one planned sub-issue: created, would-create (dry run), skipped (no usable parent), or errored. */
export type QaAction = "created" | "would-create" | "skipped-no-parent" | "error";

/** One planned manual-QA sub-issue's outcome — the wire shape `ao verify qa` renders. */
export interface QaSubIssueResult {
  parentKey: string;
  title: string;
  action: QaAction;
  ticketKey?: string;
  url?: string | null;
  detail?: string;
}

/** The verify-qa run as the daemon surfaces it: the per-ticket results + whether it's configured + the mode. */
export interface VerifyQaResult {
  results: QaSubIssueResult[];
  configured: boolean;
  /** false ⇒ a dry run (results are `would-create`); true ⇒ a write run (per-ticket results say what happened). */
  wrote: boolean;
}

/**
 * Which Verifying tickets need a manual-QA sub-issue: those with a screen-observable half (`ui` or `mixed`,
 * i.e. `hasUi`) that don't already have one (`existingParentKeys` = dev keys that already have a `manual-qa`
 * child). Idempotent — re-running never double-creates. Pure.
 */
export function planQaSubIssues(rows: readonly VerifyRow[], existingParentKeys: ReadonlySet<string>): QaSubIssuePlan[] {
  return rows
    .filter((r) => r.hasUi && !existingParentKeys.has(r.ticketKey))
    .map((r) => ({ parentKey: r.ticketKey, title: `QA verify: ${r.title}` }));
}

/**
 * Build the prompt that generates one ticket's tester run sheet (the COR-91 shape). The tester is non-technical
 * and works on their phone in Expo Go, so the output is plain, tap-by-tap, with an explicit pass/fail per step.
 * Pure — the live runner feeds this to the subscription model and uses the reply as the sub-issue description.
 */
export function qaRunsheetPrompt(issue: { identifier: string; title: string; description: string | null }): string {
  const acs = issue.description?.trim() ? issue.description : "(no acceptance criteria on the ticket — infer the user-visible behaviour from the title)";
  const acsShown = acs.length > MAX_AC_CHARS ? `${acs.slice(0, MAX_AC_CHARS)}\n…[acceptance criteria truncated]` : acs;
  return [
    `Write a MANUAL QA run sheet for a non-technical tester to verify the user-visible behaviour of this ticket on their phone in Expo Go. Output ONLY the run sheet as Markdown — no preamble, no code fences.`,
    `Ticket ${issue.identifier}: "${issue.title}".`,
    `Acceptance criteria:\n${acsShown}`,
    `Shape the Markdown exactly like this:`,
    [
      `Start with one sentence: "Manual QA run sheet for the parent ticket (${issue.title}). Work it on your phone in Expo Go; record pass/fail per step and an overall verdict in **Cue QA**."`,
      `Then a "## What \"working\" means" section: 1-2 sentences describing the expected visible behaviour.`,
      `Then a "## Before you start" section: a short bullet list of preconditions (signed in, app running, seeded data, etc.).`,
      `Then a "## Steps" section: numbered steps, each a bold short action heading, then bullets — a "✅ Expect —" line, and where useful a "❌ Fail if —" line. Keep each step a single concrete tap/look.`,
      `End with a horizontal rule and the italic line: "*Generated from the ticket's acceptance criteria for the manual-qa pass.*"`,
    ].map((s) => `- ${s}`).join("\n"),
    `Only describe things a tester can see or tap on screen. Do NOT mention databases, RLS, SQL, servers, or code — the invisible backend is verified separately.`,
  ].join("\n\n");
}

/** Shape the Linear issueCreate input for a manual-QA sub-issue: a labelled child in the parent's own project. Pure. */
export function buildQaSubIssueInput(args: {
  teamId: string;
  projectId: string;
  parentId: string;
  labelId: string;
  title: string;
  description: string;
}): IssueCreateInput {
  return {
    teamId: args.teamId,
    projectId: args.projectId,
    parentId: args.parentId,
    labelIds: [args.labelId],
    title: args.title,
    description: args.description,
    assigneeId: null, // unassigned — a tester picks it up from the Cue QA run sheet
  };
}
