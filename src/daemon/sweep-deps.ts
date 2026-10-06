/**
 * Sweep engine deps — the gh/PTY/reviewer I/O the engine (sweep-engine.ts) runs on (lead-console PRD §4-§5).
 *
 * Pieces of real parsing/decision live here and are PURE + unit-tested:
 *  - checkStates(): a gh statusCheckRollup → the ci/secrets-scan CheckState the gate needs;
 *  - parseReviewVerdict(): the independent reviewer's verdict text → a ReviewVerdict (fails closed);
 *  - needsHydration(): whether an in-review job still needs its existing PR discovered.
 * liveSweepDeps() + hydrateInReviewJob() compose those with manager.spawn, the status tracker, and gh into
 * the engine's deps. That composition is live-only (real PTYs, a real repo, `gh`) — validated against a
 * live repo, not here — like the base's github.ts runners; the logic it depends on is in the tested pieces.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "./store.ts";
import type { SessionManager } from "./session-manager.ts";
import type { StatusTracker } from "./monitors/status.ts";
import type { SweepJob, SessionStatus } from "../shared/types.ts";
import type { CheckState, RequiredCheck } from "../shared/sweep-gate.ts";
import { REQUIRED_CHECKS } from "../shared/sweep-gate.ts";
import type { SweepEngineDeps, ReviewVerdict, WorkerResult, WorkerFeedback, PollResult } from "./sweep-engine.ts";
import { fetchPr, listPrsForBranch } from "./github.ts";
import { branchName } from "./worktree.ts";
import { sessionDir } from "../shared/paths.ts";
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
  return {
    sessionId,
    redFindings: red != null ? Number(red) : 1, // unparseable → treat as blocking
    preservationProven: preservation?.toLowerCase() === "proven", // unparseable/unproven → false
    judgmentCall: judgment && judgment.toLowerCase() !== "none" ? judgment : null,
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

// --- live composition (live-only) ------------------------------------------

const TERMINAL: ReadonlySet<SessionStatus> = new Set<SessionStatus>(["done", "exited", "error"]);
const DEFAULT_CI_POLL_MS = 30_000;
const DEFAULT_MAX_CI_WAITS = 40; // ~20 min at 30s
const DEFAULT_SPAWN_DEADLINE_MS = 2 * 60 * 60 * 1000; // 2h: a backstop against a hung agent, not a tight bound

/** Resolve when a session reaches a terminal status; reject if it hasn't within `deadlineMs`. Live-only. */
export function awaitCompletion(tracker: StatusTracker, sessionId: string, deadlineMs = 0): Promise<SessionStatus> {
  return new Promise((resolve, reject) => {
    const current = tracker.status(sessionId);
    if (TERMINAL.has(current)) return resolve(current);
    let off = () => {};
    let timer: ReturnType<typeof setTimeout> | null = null;
    const done = () => { off(); if (timer) clearTimeout(timer); };
    off = tracker.onChange(({ sessionId: id, status }) => {
      if (id === sessionId && TERMINAL.has(status)) { done(); resolve(status); }
    });
    if (deadlineMs > 0) {
      timer = setTimeout(() => { done(); reject(new Error(`session ${sessionId} did not finish within ${deadlineMs}ms`)); }, deadlineMs);
    }
  });
}

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
}

/** Discover the existing PR for an in-review job: the ticket branch first, then a ticket-key search. */
async function discoverPr(repo: string, branchOwner: string, ticketKey: string): Promise<number | null> {
  const byBranch = (await listPrsForBranch(repo, ticketBranch(branchOwner, ticketKey)))[0]?.number;
  if (byBranch != null) return byBranch;
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
  const number = await discoverPr(cfg.repo, cfg.branchOwner, job.ticketKey);
  if (number == null) return job;
  const headSha = headOf(await fetchPr(cfg.repo, number));
  return store.transitionSweepJob(job.id, { prNumber: number, headSha });
}

/** Build the engine's deps from the live session manager + gh. Live-only; see file header. */
export function liveSweepDeps(cfg: LiveSweepDepsConfig): SweepEngineDeps {
  const deadline = cfg.spawnDeadlineMs ?? DEFAULT_SPAWN_DEADLINE_MS;

  const spawnAndWait = async (seed: string): Promise<string> => {
    const session = await cfg.manager.spawn({
      taskId: cfg.taskId, tool: "claude", location: "local", cwd: cfg.cwd,
      usesWorktree: true, permissions: "full-access", repo: cfg.repo, seed,
    });
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
    async spawnWorker(job, feedback): Promise<WorkerResult> {
      const sessionId = await spawnAndWait(workerSeed(job, feedback));
      const { headSha, prNumber } = await readHeadPr(job);
      return { sessionId, headSha, prNumber };
    },
    async pollCi(job): Promise<PollResult> {
      if (job.prNumber == null) return { checks: {}, changedPaths: [] };
      const pr = await fetchPr(cfg.repo, job.prNumber);
      return { checks: checkStates(pr.statusCheckRollup), changedPaths: await changedPaths(cfg.repo, job.prNumber) };
    },
    async review(job): Promise<ReviewVerdict> {
      const sessionId = await spawnAndWait(reviewerSeed(job));
      let out = "";
      try { out = readFileSync(join(sessionDir(sessionId, cfg.home), "verdict.txt"), "utf8"); } catch { /* missing → fails closed */ }
      cfg.manager.kill(sessionId); // don't leak the reviewer PTY
      return parseReviewVerdict(out, sessionId);
    },
    wait: (ms) => Bun.sleep(ms),
  };
}

/** Changed file paths for a PR, for the dangerous-tier gate. Live-only. */
async function changedPaths(repo: string, number: number): Promise<string[]> {
  const r = await runWithDeadline(["gh", "pr", "view", String(number), "--repo", repo, "--json", "files"]);
  if (r.code !== 0) throw new Error(`gh pr view files failed (code ${r.code}): ${r.stderr}`);
  const parsed = JSON.parse(r.stdout) as { files?: Array<{ path?: string }> };
  return (parsed.files ?? []).map((f) => f.path).filter((p): p is string => typeof p === "string");
}

/** The fixer/implementer prompt. in_review fixes the PR; rescue implements the ticket from scratch. */
function workerSeed(job: SweepJob, feedback: WorkerFeedback): string {
  const head = job.kind === "rescue"
    ? `Implement Linear ticket ${job.ticketKey} from its acceptance criteria, then open a PR.`
    : `Drive PR #${job.prNumber} for ${job.ticketKey} to a mergeable state.`;
  if (feedback.initial || !feedback.review) return head;
  const findings = feedback.review.redFindings > 0 ? `${feedback.review.redFindings} blocking review finding(s)` : "the review feedback";
  const preservation = feedback.review.preservationProven ? "" : " Also prove no behavior regression vs the original.";
  return `${head} Address ${findings} and these gate blockers: ${feedback.blockers.join(", ")}.${preservation}`;
}

/** The independent-reviewer prompt: a fresh session with no stake, writing a parseable verdict file. */
function reviewerSeed(job: SweepJob): string {
  const preservation = job.kind === "rescue"
    ? "whether each acceptance criterion is satisfied, with evidence"
    : "whether the final diff preserves the author's original behavior (no regression)";
  return [
    `You are an INDEPENDENT reviewer of PR #${job.prNumber} for ${job.ticketKey}. You did not write it.`,
    `Assess ${preservation}, and find every blocking (🔴) issue.`,
    "Then write your verdict to the file $AO_SESSION_DIR/verdict.txt as EXACTLY these three lines, nothing else:",
    "RED FINDINGS: <count>",
    "PRESERVATION: proven | unproven",
    "JUDGMENT: <a no-clearly-better-option decision only the lead can make, or 'none'>",
  ].join("\n");
}
