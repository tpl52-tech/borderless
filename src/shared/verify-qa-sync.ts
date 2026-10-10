/**
 * Manual-QA verdict writeback (PRD §13) — the pure brain for carrying a tester's Cue QA verdict back to the
 * Linear `manual-qa` sub-issue. The mirror of verify-qa.ts: that AUTHORS the sub-issue from the acceptance
 * criteria; this reads back the human result the tester recorded against it.
 *
 * The tester-facing app (Cue QA, repo `greenlight`) persists one row per sub-issue into the Supabase `qa_runs`
 * table — `{ ticket_id, run }` where `run` is `{ pre, steps, notes, verdict, verdictBy, verdictAt }`. This module
 * turns those rows into Linear actions: post a comment recording the verdict (always), and move the sub-issue to
 * Done (only on a PASS). No I/O — the live runner (daemon/verify-qa-sync-run.ts) does the Supabase read + the
 * Linear writes; here we parse/validate the rows, build the comment, and decide what each row needs.
 */

/** The recorded run for one sub-issue, as Cue QA writes it into `qa_runs.run`. All fields optional (external JSON). */
export interface QaRun {
  pre?: Record<string, boolean>;
  steps?: Record<string, string>; // step key -> "pass" | "fail"
  notes?: Record<string, string>; // step key -> free-text failure note
  verdict?: string; // "pass" | "fail" | "blocked"
  verdictBy?: string; // tester id, e.g. "renee"
  verdictAt?: number; // epoch ms — set together with verdict; also the idempotency key
}

/** One validated verdict row: a real issue key + a run with a recorded verdict. */
export interface QaVerdictRow {
  ticketKey: string; // the manual-qa sub-issue key, e.g. "COR-96"
  verdict: "pass" | "fail" | "blocked";
  verdictAt: number;
  run: QaRun;
}

/** What happened to one verdict row's writeback. */
export type QaWritebackAction = "synced" | "would-sync" | "skipped-synced" | "skipped-unsynced" | "error";

/** One verdict row's writeback outcome — the wire shape `ao verify qa-sync` renders. */
export interface QaWritebackResult {
  ticketKey: string;
  verdict: string;
  action: QaWritebackAction;
  /** true when the sub-issue was (or would be) moved to Done — only ever on a pass. */
  movedToDone?: boolean;
  url?: string | null; // the created comment's url
  detail?: string;
}

/** The writeback run as the daemon surfaces it: the per-row results + whether it's configured + the mode. */
export interface VerifyQaSyncResult {
  results: QaWritebackResult[];
  configured: boolean;
  /** false ⇒ a dry run (results are `would-sync`); true ⇒ a write run (results say what happened). */
  wrote: boolean;
}

/** A real Linear issue key like "COR-96" — excludes Cue QA's internal rows (e.g. the `__probe` health row). */
const ISSUE_KEY_RE = /^[A-Z][A-Z0-9]*-\d+$/;

const VERDICTS = new Set(["pass", "fail", "blocked"]);

/**
 * The idempotency ref embedded in every writeback comment and matched to decide "already synced". Keyed by
 * `verdictAt`, so re-recording a verdict (a new `verdictAt`) posts a fresh comment rather than being swallowed.
 */
export function verdictMarker(verdictAt: number): string {
  return `ao-qa-verdict:${verdictAt}`;
}

/** A tester id ("renee") → a display name ("Renee"). Falls back to the raw id, then to "a tester". */
export function testerLabel(verdictBy: string | undefined): string {
  const id = (verdictBy ?? "").trim();
  if (!id) return "a tester";
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/**
 * Validate the raw `qa_runs` JSON into verdict rows worth syncing: a real issue key (drops `__probe` and any
 * non-issue id) with a recorded verdict in {pass,fail,blocked} and a numeric `verdictAt` (needed for the ref
 * marker). Rows with no verdict yet, or malformed rows, are dropped. Pure; tolerant of unknown input.
 */
export function parseQaRunsRows(raw: unknown): QaVerdictRow[] {
  if (!Array.isArray(raw)) return [];
  const out: QaVerdictRow[] = [];
  for (const r of raw) {
    if (r == null || typeof r !== "object") continue;
    const ticketKey = (r as { ticket_id?: unknown }).ticket_id;
    const run = (r as { run?: unknown }).run;
    if (typeof ticketKey !== "string" || !ISSUE_KEY_RE.test(ticketKey)) continue;
    if (run == null || typeof run !== "object") continue;
    const verdict = (run as QaRun).verdict;
    const verdictAt = (run as QaRun).verdictAt;
    if (typeof verdict !== "string" || !VERDICTS.has(verdict)) continue;
    if (typeof verdictAt !== "number" || !Number.isFinite(verdictAt)) continue;
    out.push({ ticketKey, verdict: verdict as QaVerdictRow["verdict"], verdictAt, run: run as QaRun });
  }
  return out;
}

/** Build the Linear comment body recording a verdict — a human-readable summary plus the idempotency ref. Pure. */
export function buildVerdictComment(row: QaVerdictRow): string {
  const { run, verdict, verdictAt } = row;
  const head = verdict === "pass" ? "✅ PASS" : verdict === "fail" ? "❌ FAIL" : "⛔ BLOCKED";
  const who = testerLabel(run.verdictBy);
  const when = new Date(verdictAt).toISOString().slice(0, 10);
  const steps = run.steps ?? {};
  const passed = Object.values(steps).filter((s) => s === "pass").length;
  const failed = Object.values(steps).filter((s) => s === "fail").length;

  const lines: string[] = [];
  lines.push(`**Manual QA verdict: ${head}** — recorded by ${who} · ${when}`);
  lines.push("");
  lines.push(`Steps recorded: ${passed} passed, ${failed} failed.`);

  const notes = run.notes ?? {};
  const noted = Object.keys(steps)
    .filter((k) => steps[k] === "fail")
    .filter((k) => (notes[k] ?? "").trim());
  if (noted.length) {
    lines.push("");
    lines.push("Notes on failed steps:");
    for (const k of noted) lines.push(`- Step ${k}: ${notes[k]!.trim()}`);
  }

  lines.push("");
  lines.push(`_Synced from Cue QA by ao — ref ${verdictMarker(verdictAt)}_`);
  return lines.join("\n");
}

/** One verdict row's decision, given what Linear already holds for its sub-issue. */
export interface WritebackDecision {
  /** A comment already carries this verdict's ref — nothing to do. */
  alreadySynced: boolean;
  /** Post the verdict comment. */
  comment: boolean;
  /** Move the sub-issue to Done — only on a pass, and only if it isn't completed already. */
  moveToDone: boolean;
}

/**
 * Decide what a verdict row needs. Idempotent on the ref marker: if a comment already carries it, skip entirely
 * (never re-comment, never re-transition — a human may have since reopened it). Otherwise always comment, and
 * move to Done only for a PASS whose sub-issue isn't already completed. A FAIL/BLOCKED never changes state (it
 * stays open for someone to act on) — reopening a Done sub-issue is deliberately left to a human. Pure.
 */
export function decideWriteback(
  row: QaVerdictRow,
  ctx: { commentBodies: readonly string[]; currentStateType: string | null },
): WritebackDecision {
  const marker = verdictMarker(row.verdictAt);
  if (ctx.commentBodies.some((b) => b.includes(marker))) {
    return { alreadySynced: true, comment: false, moveToDone: false };
  }
  return { alreadySynced: false, comment: true, moveToDone: row.verdict === "pass" && ctx.currentStateType !== "completed" };
}
