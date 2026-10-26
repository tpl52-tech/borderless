/**
 * Sweep engine deps — the gh/PTY/reviewer I/O the engine (sweep-engine.ts) runs on (lead-console PRD §4-§5).
 *
 * Pieces of real parsing/decision live here and are PURE + unit-tested:
 *  - checkStates(): a gh statusCheckRollup → the ci/secrets-scan CheckState the gate needs;
 *  - parseReviewVerdict(): the independent reviewer's verdict text → a ReviewVerdict (fails closed);
 *  - needsHydration(): whether an in-review job still needs its existing PR discovered;
 *  - workerSeed(): the fixer/implementer prompt (rescue embeds the ticket's acceptance criteria).
 * liveSweepDeps() + hydrateInReviewJob() compose those with manager.spawn, the status tracker, and gh into
 * the engine's deps. That composition is live-only (real PTYs, a real repo, `gh`) — validated against a
 * live repo, not here — like the base's github.ts runners; the logic it depends on is in the tested pieces.
 */

import type { Store } from "./store.ts";
import { REOPEN_QUEUED_PATCH } from "./sweep-store.ts";
import type { SessionManager } from "./session-manager.ts";
import type { StatusTracker } from "./monitors/status.ts";
import type { SweepJob, SweepState } from "../shared/types.ts";
import type { CheckState, RequiredCheck } from "../shared/sweep-gate.ts";
import { REQUIRED_CHECKS, buildsFromScratch, thermoPasses } from "../shared/sweep-gate.ts";
import type { SweepEngineDeps, ReviewVerdict, WorkerResult, WorkerFeedback, PollResult } from "./sweep-engine.ts";
import { territoryWarning, type Territory } from "../shared/collision.ts";
import { fetchPr, listPrsForBranch, prFiles } from "./github.ts";
import { branchName, prBranchCandidates } from "./worktree.ts";
import { awaitCompletion, runEphemeralInspector, spawnClaudeAgent } from "./spawn-wait.ts";
import { runWithDeadline } from "./ssh.ts";

// --- pure mappers (unit-tested) --------------------------------------------

/** A gh CheckRun. Only COMPLETED+SUCCESS passes; SKIPPED/NEUTRAL didn't verify anything, so never a pass. */
function checkRunState(node: { status?: string; conclusion?: string }): CheckState {
  if (node.status !== "COMPLETED") return "pending";
  if (node.conclusion === "SUCCESS") return "success";
  if (node.conclusion === "SKIPPED" || node.conclusion === "NEUTRAL") return "pending";
  return "failure";
}

/** A gh StatusContext. */
function statusContextState(node: { state?: string }): CheckState {
  const state = String(node.state ?? "").toUpperCase();
  if (state === "SUCCESS") return "success";
  if (state === "PENDING" || state === "EXPECTED") return "pending";
  return "failure";
}

/**
 * Map a PR's statusCheckRollup to the required checks' states. An absent required check is simply left
 * out — the gate reads a missing check as pending, never as a pass (absence is never a pass, PRD §4).
 */
export function checkStates(rollup: unknown): Partial<Record<RequiredCheck, CheckState>> {
  const required = new Set<string>(REQUIRED_CHECKS);
  const out: Partial<Record<RequiredCheck, CheckState>> = {};
  const nodes = (rollup as { contexts?: { nodes?: unknown[] } } | null)?.contexts?.nodes;
  if (!Array.isArray(nodes)) return out;
  for (const raw of nodes) {
    const node = raw as { __typename?: string; name?: string; context?: string; status?: string; conclusion?: string; state?: string };
    const name = node.__typename === "CheckRun" ? node.name : node.__typename === "StatusContext" ? node.context : undefined;
    if (!name || !required.has(name)) continue;
    out[name as RequiredCheck] = node.__typename === "CheckRun" ? checkRunState(node) : statusContextState(node);
  }
  return out;
}

/**
 * Parse the independent reviewer's verdict (the three markers it writes to its verdict file) into a
 * ReviewVerdict. A missing/garbled marker FAILS CLOSED (blocking / unproven) so a malformed review never
 * clears the gate (PRD §4, absence is never a pass):
 *   RED FINDINGS: <n>
 *   PRESERVATION: proven | unproven
 *   JUDGMENT: <text> | none
 */
export function parseReviewVerdict(text: string, sessionId: string): ReviewVerdict {
  const red = lastMatch(text, /^RED FINDINGS:\s*(\d+)\s*$/im);
  const preservation = lastMatch(text, /^PRESERVATION:\s*(proven|unproven)\s*$/im);
  const judgment = lastMatch(text, /^JUDGMENT:\s*(.+?)\s*$/im);
  // Capture the grade WITH its modifier ([A-F][+-]?): the gate must tell A from A- (only exact A passes).
  // Deliberately separate from pr-derive.ts's letter-only THERMO_LINE, which feeds a different subsystem (the
  // PR-state ThermoGrade union) that doesn't track modifiers.
  const thermo = lastMatch(text, /^THERMO GRADE:\s*([A-F][+-]?)\s*$/im);
  // Everything after a `FINDINGS:` line — the reviewer's specific blocking + quality findings, relayed to the
  // fixer so it need not re-derive them. Trimmed + capped; "none"/blank → omitted.
  const fm = text.match(/^FINDINGS:[ \t]*\n?([\s\S]*)/im);
  const findingsRaw = fm ? fm[1]!.trim() : "";
  const findings = findingsRaw && findingsRaw.toLowerCase() !== "none" ? clampAcceptance(findingsRaw) : null;
  return {
    sessionId,
    redFindings: red != null ? Number(red) : 1, // unparseable → treat as blocking
    preservationProven: preservation?.toLowerCase() === "proven", // unparseable/unproven → false
    judgmentCall: judgment && judgment.toLowerCase() !== "none" ? judgment : null,
    thermoGrade: thermo ? thermo.toUpperCase() : null, // unparseable/absent → null → gate blocks (fail-closed)
    ...(findings ? { findings } : {}),
  };
}

/** Last capture of a multiline regex (reviewers may restate markers; the final one wins). */
function lastMatch(text: string, re: RegExp): string | null {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let m: RegExpExecArray | null;
  let last: string | null = null;
  while ((m = g.exec(text)) !== null) last = m[1] ?? null;
  return last;
}

/** An in-review job still needs its existing PR discovered before the engine can drive it. Pure. */
export function needsHydration(job: SweepJob): boolean {
  return job.kind === "in_review" && job.prNumber == null;
}

/**
 * An in-review job "resting on a human": the agent drove it as far as it can and is waiting — `ready` (gate
 * passed, a human merges), `signoff` (gate passed but a dangerous tier was touched, awaiting a human glance),
 * or `needs_human` (a blocker/judgment the agent can't clear). A later push to such a PR is the human's answer,
 * so it should trigger a fresh review of the new head (see reReviewAdvancedPrs).
 */
const RESTING_IN_REVIEW: ReadonlySet<SweepState> = new Set(["ready", "signoff", "needs_human"]);

/** A resting in-review job that has a PR + a reviewed head — i.e. a candidate for a head-advance re-review. Pure. */
export function isRestingWithPr(job: SweepJob): boolean {
  return job.kind === "in_review" && RESTING_IN_REVIEW.has(job.state) && job.prNumber != null && job.headSha != null;
}

// --- live composition (live-only) ------------------------------------------

const DEFAULT_CI_POLL_MS = 30_000;
const DEFAULT_MAX_CI_WAITS = 40; // ~20 min at 30s
const DEFAULT_SPAWN_DEADLINE_MS = 2 * 60 * 60 * 1000; // 2h: a backstop against a hung agent, not a tight bound

/** Read the oid of a fetched PR's latest commit, or null. */
function headOf(pr: Record<string, any>): string | null {
  return pr.commits?.nodes?.[0]?.commit?.oid ?? null;
}

/** The canonical ticket branch (`<owner>/<TICKET>`), reused so discovery matches what worktrees create. */
function ticketBranch(branchOwner: string, ticketKey: string): string {
  return branchName({ ticket: ticketKey, branchOwner, id8: "" });
}

export interface LiveSweepDepsConfig {
  manager: SessionManager;
  tracker: StatusTracker;
  repo: string;
  branchOwner: string;
  /** task + cwd the sweep's agent sessions run under; home for reading the reviewer's verdict file. */
  taskId: string;
  cwd: string;
  home: string;
  ciPollMs?: number;
  maxCiWaits?: number;
  spawnDeadlineMs?: number;
  /** The ticket's acceptance criteria (its synced description) — embedded in a rescue worker's seed because
   *  a spawned agent has no Linear to read them. Returns null when unknown. */
  acceptanceFor?: (ticketId: string) => string | null;
}

/** Discover the existing PR for an in-review job: its candidate branches first, then a ticket-key search. */
async function discoverPr(repo: string, branchOwner: string, ticketKey: string, gitBranchName: string | null): Promise<number | null> {
  for (const branch of prBranchCandidates(ticketKey, branchOwner, gitBranchName)) {
    const n = (await listPrsForBranch(repo, branch))[0]?.number;
    if (n != null) return n;
  }
  const r = await runWithDeadline(["gh", "pr", "list", "--repo", repo, "--search", ticketKey, "--state", "open", "--limit", "1", "--json", "number"]);
  if (r.code !== 0) return null;
  const parsed = JSON.parse(r.stdout) as Array<{ number?: number }>;
  return parsed[0]?.number ?? null;
}

/**
 * Discover and persist an in-review job's existing PR so the engine drives it (instead of seeing no head
 * and stopping). If no PR is found the job is returned unchanged — the engine's no-PR guard then stops it
 * for a human. Live-only.
 */
export async function hydrateInReviewJob(store: Store, job: SweepJob, cfg: { repo: string; branchOwner: string }): Promise<SweepJob> {
  const gitBranchName = store.getLinearIssue(job.ticketId)?.gitBranchName ?? null;
  const number = await discoverPr(cfg.repo, cfg.branchOwner, job.ticketKey, gitBranchName);
  if (number == null) return job;
  const headSha = headOf(await fetchPr(cfg.repo, number));
  return store.transitionSweepJob(job.id, { prNumber: number, headSha });
}

/** The live reader reReviewAdvancedPrs fetches a PR's current head with: `headOf(await fetchPr(repo, n))`,
 *  injected so the re-review decision (below) is unit-testable without gh — mirrors SweepEngineDeps' I/O seams. */
export function liveHeadReader(repo: string): (prNumber: number) => Promise<string | null> {
  return (prNumber) => fetchPr(repo, prNumber).then(headOf);
}

/**
 * Re-review PRs that advanced after resting. The in-review sweep drives a PR to `ready`/`signoff`/`needs_human`
 * and then waits on a human; when the human pushes a fix, that resting job's reviewed head goes stale, yet the enqueue
 * dedup (it treats any non-merged/failed job as active) would never re-review the new code. So before each
 * sweep, re-open every resting in-review job whose PR head has moved past what it reviewed: back to `queued`
 * with the new head (a fresh attempt — cycles/gate/reason/session cleared), for the supervisor to drive and
 * review afresh. Bounded by uq_sweep_review(ticket_id, head_sha) — one review per head, so an unchanged PR is
 * left resting, never looped. Returns the jobs re-opened.
 *
 * Fail-soft per job: this runs ahead of enqueue + pickup in scanInReview, so a single gh hiccup, closed PR, or
 * UNIQUE collision must never throw out and starve the rest of the sweep. Heads are fetched concurrently.
 */
export async function reReviewAdvancedPrs(
  store: Pick<Store, "listSweepJobs" | "getLinearIssue" | "transitionSweepJob" | "recordSweepEvent">,
  stateName: string,
  headFor: (prNumber: number) => Promise<string | null>,
): Promise<SweepJob[]> {
  // Only tickets STILL in the swept column: a human who moved the ticket out (e.g. back to In Progress) and
  // keeps pushing it themselves has reclaimed it — the sweep must not yank it back. (syncBoard ran first, so
  // the ticket's column is fresh.)
  const resting = store.listSweepJobs({ kind: "in_review" })
    .filter((j) => isRestingWithPr(j) && store.getLinearIssue(j.ticketId)?.stateName === stateName);
  const heads = await Promise.allSettled(resting.map((j) => headFor(j.prNumber!)));
  const reopened: SweepJob[] = [];
  resting.forEach((job, i) => {
    const res = heads[i]!;
    // A rejected fetch (transient gh/network, or a closed/deleted PR) leaves the job resting, to retry next
    // sweep; an unchanged or unknown head means the human hasn't pushed → still resting on them.
    if (res.status !== "fulfilled" || res.value == null || res.value === job.headSha) return;
    try {
      reopened.push(store.transitionSweepJob(job.id, { ...REOPEN_QUEUED_PATCH, headSha: res.value }));
      store.recordSweepEvent(job.id, "state_change", { from: job.state, to: "queued", reason: "head-advance re-review", headSha: res.value });
    } catch (err) {
      // uq_sweep_review spans ALL in_review states for a ticket (not just active ones, unlike
      // uq_sweep_rescue_active), so the head_sha UPDATE could collide with a historical sibling row if a human
      // force-pushed back to an already-recorded sha. Pathological, but kept fail-soft so it never aborts.
      console.error(`re-review ${job.ticketKey}:`, err instanceof Error ? err.message : err);
    }
  });
  return reopened;
}

/** A PR's out-of-band resolution, for reconciling the job that was waiting on it. */
export type PrOutcome = "merged" | "closed" | "open";

/** The live reader reconcileResolvedPrs uses: a PR's resolution via `fetchPr`. Injected so the reconcile logic
 *  is unit-testable without gh. A gh throw propagates and the caller fails soft (leaves the job resting). */
export function livePrOutcome(repo: string): (prNumber: number) => Promise<PrOutcome> {
  return async (prNumber) => {
    const pr = await fetchPr(repo, prNumber) as { state?: string; mergedAt?: string | null };
    const state = String(pr.state ?? "").toUpperCase();
    if (state === "MERGED" || pr.mergedAt) return "merged";
    if (state === "CLOSED") return "closed";
    return "open";
  };
}

/** The resting states that can hold a PR a human resolved out of band — the reconcile candidates. A job still
 *  being driven (ci/reviewing/fixing) is the engine's; terminal (merged/failed) is already done. */
const RECONCILABLE: ReadonlySet<SweepState> = new Set<SweepState>(["ready", "signoff", "needs_human"]);

/**
 * Reconcile resting jobs against GitHub so a job leaves the console once its PR is resolved out of band: a
 * resting job (ready/signoff/needs_human) whose PR was merged becomes `merged` (terminal, hidden from the
 * console by visibleSweepRows), and whose PR was closed without merging becomes `failed`. Runs ahead of enqueue
 * in the sweep, so a freshly-merged PR drops out of READY_TO_MERGE on the next sweep. Fail-soft per job: a gh
 * hiccup (or an open/unknown result) leaves the job resting, to retry next sweep. Outcomes fetched concurrently.
 * Returns the jobs it resolved.
 */
export async function reconcileResolvedPrs(
  store: Pick<Store, "listSweepJobs" | "transitionSweepJob" | "recordSweepEvent">,
  outcomeFor: (prNumber: number) => Promise<PrOutcome>,
): Promise<SweepJob[]> {
  const resting = store.listSweepJobs().filter((j) => RECONCILABLE.has(j.state) && j.prNumber != null);
  const outcomes = await Promise.allSettled(resting.map((j) => outcomeFor(j.prNumber!)));
  const resolved: SweepJob[] = [];
  resting.forEach((job, i) => {
    const res = outcomes[i]!;
    if (res.status !== "fulfilled" || res.value === "open") return; // unknown/open → leave it resting
    const to: SweepState = res.value === "merged" ? "merged" : "failed";
    try {
      // merged keeps its prior reason (hidden anyway); a close-without-merge records why it ended.
      resolved.push(store.transitionSweepJob(job.id, res.value === "merged" ? { state: to } : { state: to, reason: "PR closed without merging" }));
      store.recordSweepEvent(job.id, "state_change", { from: job.state, to, reason: res.value === "merged" ? "PR merged on GitHub" : "PR closed without merging" });
    } catch (err) {
      console.error(`reconcile ${job.ticketKey}:`, err instanceof Error ? err.message : err);
    }
  });
  return resolved;
}

/** Build the engine's deps from the live session manager + gh. Live-only; see file header. */
export function liveSweepDeps(cfg: LiveSweepDepsConfig): SweepEngineDeps {
  const deadline = cfg.spawnDeadlineMs ?? DEFAULT_SPAWN_DEADLINE_MS;

  const spawnAndWait = async (seed: string, opts: { ignoreSeedTicket?: boolean } = {}): Promise<string> => {
    const session = await spawnClaudeAgent(cfg.manager, { taskId: cfg.taskId, cwd: cfg.cwd, repo: cfg.repo, seed, ignoreSeedTicket: opts.ignoreSeedTicket });
    await awaitCompletion(cfg.tracker, session.id, deadline);
    return session.id;
  };

  const readHeadPr = async (job: SweepJob): Promise<{ headSha: string | null; prNumber: number | null }> => {
    // in_review already has its PR (hydrated); a rescue's PR is discovered by its branch after implement.
    const number = job.prNumber ?? (await listPrsForBranch(cfg.repo, ticketBranch(cfg.branchOwner, job.ticketKey)))[0]?.number ?? null;
    if (number == null) return { headSha: null, prNumber: null };
    return { headSha: headOf(await fetchPr(cfg.repo, number)), prNumber: number };
  };

  return {
    ciPollMs: cfg.ciPollMs ?? DEFAULT_CI_POLL_MS,
    maxCiWaits: cfg.maxCiWaits ?? DEFAULT_MAX_CI_WAITS,
    async spawnWorker(job, feedback, territory): Promise<WorkerResult> {
      const ctx: WorkerSeedContext = { acceptance: cfg.acceptanceFor?.(job.ticketId) ?? null, territory, guidance: job.leadGuidance };
      const sessionId = await spawnAndWait(workerSeed(job, feedback, ctx));
      const { headSha, prNumber } = await readHeadPr(job);
      // Free the ticket branch so a fix-cycle re-spawn can re-provision it — but only once a PR exists, i.e.
      // the work is pushed. With no PR the worktree may hold un-pushed commits; keep it for the human.
      if (prNumber != null) cfg.manager.releaseWorktree(sessionId);
      return { sessionId, headSha, prNumber };
    },
    async pollCi(job): Promise<PollResult> {
      if (job.prNumber == null) return { checks: {}, changedPaths: [] };
      const pr = await fetchPr(cfg.repo, job.prNumber);
      return { checks: checkStates(pr.statusCheckRollup), changedPaths: await prFiles(cfg.repo, job.prNumber) };
    },
    async review(job): Promise<ReviewVerdict> {
      // The reviewer is an ephemeral inspector: a throwaway worktree (it only reads the PR via gh), await,
      // read its verdict.txt, then kill + reap — all in the shared helper (fails closed on a missing file).
      const { sessionId, raw } = await runEphemeralInspector(
        { manager: cfg.manager, tracker: cfg.tracker, repo: cfg.repo, taskId: cfg.taskId, cwd: cfg.cwd, home: cfg.home, deadlineMs: deadline },
        reviewerSeed(job, cfg.acceptanceFor?.(job.ticketId) ?? null), "verdict.txt",
      );
      return parseReviewVerdict(raw, sessionId);
    },
    wait: (ms) => Bun.sleep(ms),
  };
}

/** Context for a worker's seed: the rescue ticket's acceptance criteria (embedded inline because a spawned
 *  agent has no Linear to read it), and the territory other active tickets own (the "don't duplicate" warning). */
export interface WorkerSeedContext {
  acceptance?: string | null;
  territory?: Territory;
  guidance?: string | null; // the lead's re-drive instruction (resolve panel), followed on this drive
}

const MAX_ACCEPTANCE = 4000; // keep a pathologically long description from bloating the seed

/** The fixer/implementer prompt. in_review fixes the PR; rescue implements the ticket from scratch. Both get
 *  the collision guard's preventive territory warning, so the worker avoids a teammate's deliverable up front. */
export function workerSeed(job: SweepJob, feedback: WorkerFeedback, ctx: WorkerSeedContext = {}): string {
  const head = workerSeedHead(job, ctx);
  let body = head;
  if (!feedback.initial && feedback.review) {
    const findingsPhrase = feedback.review.redFindings > 0 ? `${feedback.review.redFindings} blocking review finding(s)` : "the review feedback";
    const preservation = feedback.review.preservationProven ? "" : " Also prove no behavior regression vs the original.";
    const quality = thermoPasses(feedback.review.thermoGrade) ? "" : ` Raise code quality to /thermo-nuclear-code-quality-review grade A (the independent reviewer graded it ${feedback.review.thermoGrade ?? "below A"}); apply that standard.`;
    const detail = feedback.review.findings ? `\n\nThe independent reviewer's findings to address:\n${feedback.review.findings}` : "";
    body = `${head} Address ${findingsPhrase} and these gate blockers: ${feedback.blockers.join(", ")}.${preservation}${quality}${detail}`;
  }
  const g = clampAcceptance(ctx.guidance);
  if (g) body += `\n\nThe lead reviewed this and is re-driving it — follow this instruction exactly:\n${g}`;
  const warning = ctx.territory ? territoryWarning(ctx.territory) : null;
  return warning ? `${body}\n\n${warning}` : body;
}

/** Trim + cap an acceptance-criteria block for embedding in a seed (keeps a huge description from bloating it). */
function clampAcceptance(acceptance: string | null | undefined): string | null {
  const ac = acceptance?.trim();
  if (!ac) return null;
  return ac.length > MAX_ACCEPTANCE ? ac.slice(0, MAX_ACCEPTANCE) + "\n…(truncated)" : ac;
}

/**
 * The rescue implement instruction. A spawned worker can't read Linear, so the acceptance criteria (the
 * ticket's synced description) are embedded inline. Falls back to the prior "from its acceptance criteria"
 * phrasing when the description is unknown. (The worktree is already on the canonical ticket branch — the
 * spawn derives it from the ticket key in this seed — so the PR opens where readHeadPr looks.)
 */
function rescueSeedHead(job: SweepJob, ctx: WorkerSeedContext): string {
  const ac = clampAcceptance(ctx.acceptance);
  const criteria = ac ? `Acceptance criteria:\n${ac}` : "Implement it from its acceptance criteria.";
  return [`Implement Linear ticket ${job.ticketKey}.`, criteria, "Then open a PR."].join("\n\n");
}

/**
 * The qa-fix implement instruction. A qa-fix ticket is a tester's FAIL verdict turned into a follow-up: its
 * synced description is the failed steps + the tester's notes on what went wrong. A spawned worker can't read
 * Linear, so that body is embedded inline as the criteria to satisfy. (Like rescue, the worktree is already on
 * the canonical ticket branch — the spawn derives it from the ticket key — so the PR opens where readHeadPr looks.)
 */
function fixSeedHead(job: SweepJob, ctx: WorkerSeedContext): string {
  const ac = clampAcceptance(ctx.acceptance);
  const criteria = ac
    ? `A tester's QA found this feature failing. These are the failed steps + notes — fix the code so every one passes:\n${ac}`
    : "A tester's QA found this feature failing; implement the fix from its acceptance criteria.";
  return [`Resolve qa-fix ticket ${job.ticketKey}.`, criteria, "Then open a PR."].join("\n\n");
}

/** The fixer/implementer opening line per kind: in_review drives the author's existing PR, rescue implements the
 *  ticket from scratch, fix resolves a tester's qa-fix follow-up (both build-from-scratch kinds embed the ACs). */
function workerSeedHead(job: SweepJob, ctx: WorkerSeedContext): string {
  switch (job.kind) {
    case "in_review": return `Drive PR #${job.prNumber} for ${job.ticketKey} to a mergeable state.`;
    case "rescue": return rescueSeedHead(job, ctx);
    case "fix": return fixSeedHead(job, ctx);
    default: { const _exhaustive: never = job.kind; throw new Error(`workerSeedHead: unhandled kind ${String(_exhaustive)}`); }
  }
}

/**
 * The independent-reviewer prompt. Every kind verifies the ticket's acceptance criteria against the PR —
 * COMPLETENESS is a gate dimension, not just correctness: an unmet or only-partially-met criterion (a required
 * section/state/field/behavior that's missing) is a BLOCKING (🔴) finding, so a clean-but-incomplete PR is sent
 * back, not merged. The PRESERVATION line keeps its per-kind meaning the gate reads (sweep-gate.ts): for
 * in_review, "proven" = no regression of the author's original behavior; for rescue/fix, "proven" = every acceptance
 * criterion affirmatively satisfied. The ACs are embedded because a spawned reviewer has no Linear access;
 * `acceptance` is the ticket's synced description (null → the reviewer flags completeness couldn't be confirmed).
 * It ALSO grades the diff to the /thermo-nuclear code-quality standard (the THERMO GRADE line); the gate requires A.
 */
export function reviewerSeed(job: SweepJob, acceptance: string | null): string {
  const ac = clampAcceptance(acceptance);
  const guidance = clampAcceptance(job.leadGuidance); // set when the lead re-drove this job — authoritative here
  const preservation = buildsFromScratch(job.kind)
    ? "For PRESERVATION, report 'proven' only if EVERY acceptance criterion is affirmatively satisfied, with evidence."
    : "For PRESERVATION, report 'proven' only if the final diff preserves the author's original behavior (no regression).";
  return [
    `You are an INDEPENDENT reviewer of PR #${job.prNumber} for ${job.ticketKey}. You did not write it.`,
    "Verify the PR satisfies EVERY acceptance criterion below. An unmet or only-partially-met criterion — a",
    "required section, screen, state, field, or behavior that is missing — is itself a BLOCKING (🔴) finding;",
    "NEVER pass an incomplete implementation as done. Find every other blocking (🔴) issue too.",
    preservation,
    ac
      ? `\nAcceptance criteria for ${job.ticketKey} — check each one against the PR:\n${ac}`
      : `\n(No acceptance criteria were available — you could not confirm completeness; flag that and treat it as blocking.)`,
    guidance
      ? `\nThe lead REVIEWED this and re-drove it with this instruction — treat it as AUTHORITATIVE: do NOT re-raise a judgment the lead already settled, and verify the PR actually reflects it. Flag any part not yet implemented as a BLOCKING (🔴) unmet item:\n${guidance}`
      : "",
    "",
    "Then AUDIT CODE QUALITY to the standard in ~/.claude/skills/thermo-nuclear-code-quality-review/SKILL.md",
    "(read that file and apply it): structure, abstraction, spaghetti/branching, file size, type/boundary",
    "cleanliness, canonical-layer fit. Grade it as that standard would — A ONLY when it genuinely meets the bar,",
    "A- or below when it does not. You did not write this code, so the grade is independent.",
    "",
    "Write your verdict to $AO_SESSION_DIR/verdict.txt: FIRST these four lines, each on its own line:",
    "RED FINDINGS: <count — include every unmet acceptance criterion>",
    "PRESERVATION: proven | unproven",
    "JUDGMENT: <a no-clearly-better-option decision only the lead can make, or 'none'>",
    "THERMO GRADE: <A | A- | B+ | B | B- | C | D | F>",
    "Then a line reading exactly FINDINGS: followed by every blocking (🔴) issue AND every code-quality problem",
    "behind a below-A grade — one per line, specific and actionable (file:line + what to change) — so the",
    "implementer can fix them without re-deriving them. Put 'none' under FINDINGS when the PR is clean and A.",
  ].join("\n");
}
