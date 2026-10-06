/**
 * Sweep engine deps — the gh/PTY/reviewer I/O the engine (sweep-engine.ts) runs on (lead-console PRD §4-§5).
 *
 * Two pieces of real parsing live here and are PURE + unit-tested:
 *  - checkStates(): a gh statusCheckRollup → the ci/secrets-scan CheckState the gate needs;
 *  - parseReviewVerdict(): the independent reviewer session's output → a ReviewVerdict.
 * liveSweepDeps() composes those with manager.spawn + the status tracker + gh into the engine's deps.
 * The composition is live-only (real PTYs, a real repo, `gh`) — validated against a live repo, not here —
 * exactly like the base's github.ts runners; all the logic it depends on is in the tested pure pieces.
 */

import type { Store } from "./store.ts";
import type { SessionManager } from "./session-manager.ts";
import type { StatusTracker } from "./monitors/status.ts";
import type { SweepJob, SessionStatus } from "../shared/types.ts";
import type { CheckState, RequiredCheck } from "../shared/sweep-gate.ts";
import { REQUIRED_CHECKS } from "../shared/sweep-gate.ts";
import type { SweepEngineDeps, ReviewVerdict, WorkerResult, WorkerFeedback, PollResult } from "./sweep-engine.ts";
import { fetchPr, listPrsForBranch } from "./github.ts";
import { runWithDeadline } from "./ssh.ts";

// --- pure mappers (unit-tested) --------------------------------------------

/** A gh CheckRun (`{__typename:"CheckRun", name, status, conclusion}`): COMPLETED+SUCCESS is the only pass. */
function checkRunState(node: { status?: string; conclusion?: string }): CheckState {
  if (node.status !== "COMPLETED") return "pending";
  return node.conclusion === "SUCCESS" ? "success" : "failure";
}

/** A gh StatusContext (`{__typename:"StatusContext", context, state}`). */
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
 * Parse the independent reviewer session's output into a verdict. The reviewer is prompted to end with
 * three markers; a missing/garbled marker FAILS CLOSED (counts as blocking / unproven) so a malformed
 * review never clears the gate (PRD §4, absence is never a pass):
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

/** Last capture of a global/multiline regex (reviewers may restate markers; the final one wins). */
function lastMatch(text: string, re: RegExp): string | null {
  let m: RegExpExecArray | null;
  let last: string | null = null;
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  while ((m = g.exec(text)) !== null) last = m[1] ?? null;
  return last;
}

// --- live composition (live-only) ------------------------------------------

const TERMINAL: ReadonlySet<SessionStatus> = new Set<SessionStatus>(["done", "exited", "error"]);

/** Resolve when a session reaches a terminal status (done/exited/error). Live-only. */
export function awaitCompletion(tracker: StatusTracker, sessionId: string): Promise<SessionStatus> {
  return new Promise((resolve) => {
    if (TERMINAL.has(tracker.status(sessionId))) return resolve(tracker.status(sessionId));
    const off = tracker.onChange(({ sessionId: id, status }) => {
      if (id === sessionId && TERMINAL.has(status)) { off(); resolve(status); }
    });
  });
}

export interface LiveSweepDepsConfig {
  manager: SessionManager;
  tracker: StatusTracker;
  repo: string;
  /** branch prefix for a rescue's new branch: `<branchOwner>/<TICKET>`. */
  branchOwner: string;
  /** task + cwd the sweep's agent sessions run under. */
  taskId: string;
  cwd: string;
  ciPollMs?: number;
  maxCiWaits?: number;
}

const DEFAULT_CI_POLL_MS = 30_000;
const DEFAULT_MAX_CI_WAITS = 40; // ~20 min at 30s

/** Build the engine's deps from the live session manager + gh. Live-only; see file header. */
export function liveSweepDeps(cfg: LiveSweepDepsConfig): SweepEngineDeps {
  const branchFor = (job: SweepJob) => `${cfg.branchOwner}/${job.ticketKey}`;

  const readHeadPr = async (job: SweepJob): Promise<{ headSha: string | null; prNumber: number | null }> => {
    // in_review already has its PR; a rescue's PR is discovered by its branch after the implement run.
    const number = job.prNumber ?? (await listPrsForBranch(cfg.repo, branchFor(job)))[0]?.number ?? null;
    if (number == null) return { headSha: null, prNumber: null };
    const pr = await fetchPr(cfg.repo, number);
    const headSha = pr.statusCheckRollup == null ? null : (pr.commits?.nodes?.[0]?.commit?.oid ?? null);
    return { headSha, prNumber: number };
  };

  const spawnAndWait = async (seed: string): Promise<string> => {
    const session = await cfg.manager.spawn({
      taskId: cfg.taskId, tool: "claude", location: "local", cwd: cfg.cwd,
      usesWorktree: true, permissions: "full-access", repo: cfg.repo, seed,
    });
    await awaitCompletion(cfg.tracker, session.id);
    return session.id;
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
      const out = new TextDecoder().decode(await cfg.manager.repaintBytes(sessionId));
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

/** The independent-reviewer prompt: a fresh session with no stake, ending in the parseable markers. */
function reviewerSeed(job: SweepJob): string {
  const preservation = job.kind === "rescue"
    ? "whether each acceptance-criterion is satisfied with evidence"
    : "whether the final diff preserves the author's original behavior (no regression)";
  return [
    `You are an INDEPENDENT reviewer of PR #${job.prNumber} for ${job.ticketKey}. You did not write it.`,
    `Assess ${preservation}, and list every blocking (🔴) issue.`,
    "End your output with exactly these three lines:",
    "RED FINDINGS: <count>",
    "PRESERVATION: proven | unproven",
    "JUDGMENT: <a no-clearly-better-option decision only the lead can make, or 'none'>",
  ].join("\n");
}
