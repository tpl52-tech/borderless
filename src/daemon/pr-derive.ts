/**
 * Derived PR states (design §12.4) — PURE over a fetched GitHub GraphQL PR object.
 *
 * A lookup failure is never "empty" (a wrong PR number must not read as review-clean) — that guard is
 * the caller's; this function assumes it was handed a real PR object.
 *
 * The org-specific vocabulary (CTO identities, the codex bot login + trigger phrase, the
 * code-quality-review heading, the greenlight check name, ignored checks) is parametrized via
 * {@link DeriveConfig} (design §22). Two derivations that need the audit log — the code-quality
 * "approved" state and the CTO cross-identity request disambiguation — are left to autonomy (step 7);
 * here they resolve to their pre-handover values.
 */

import { prefixEq } from "../shared/focus.ts";
import type {
  CiState, GreenlightState, CodexReviewState, ReviewBotState, CtoState, ThermoGrade,
} from "../shared/types.ts";

export interface DeriveConfig {
  ctoLogins: string[];
  codexBotLogin: string; // e.g. "codex"
  reviewBotLogin: string; // e.g. "github-actions"
  greenlightSubstring: string; // e.g. "greenlight"
  ciIgnore: string[]; // additional ignored check-name substrings
  operatorLogin?: string;
}

export interface DerivedPr {
  prState: string;
  isDraft: boolean;
  title: string;
  url: string;
  branch: string;
  mergeable: string;
  headSha: string | null;
  headCommittedAt: number | null;
  ciState: CiState;
  failedChecks: string[];
  greenlightState: GreenlightState;
  codexState: CodexReviewState;
  codexReviewedSha: string | null;
  ctoState: CtoState;
  ctoReviewedAt: number | null;
  ctoReviewedSha: string | null;
  reviewBotState: ReviewBotState;
  reviewBotAt: number | null;
  thermoGrade: ThermoGrade | null;
  thermoCycles: number;
  unresolvedComments: number;
  operatorAckedAt: number | null;
  outstandingReviewerTags: string[];
  remoteUpdatedAt: number | null;
}

type Any = Record<string, any>;
const ts = (s: string | null | undefined): number | null => (s ? Date.parse(s) : null);
const lc = (s: unknown): string => String(s ?? "").toLowerCase();
const nodes = (x: Any | undefined): Any[] => (Array.isArray(x?.nodes) ? x!.nodes : []);

// --- CI ---------------------------------------------------------------------

const FAILED_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ERROR"]);
const FAILED_STATES = new Set(["FAILURE", "ERROR"]);

export function deriveCi(pr: Any, cfg: DeriveConfig): { ciState: CiState; failedChecks: string[] } {
  const rollup = pr.statusCheckRollup;
  const ctx = nodes(rollup?.contexts);
  const ignore = [cfg.greenlightSubstring, ...cfg.ciIgnore].map((s) => s.toLowerCase()).filter(Boolean);
  const isIgnored = (name: string) => ignore.some((s) => lc(name).includes(s));

  if (ctx.length === 0) {
    const st = String(rollup?.state ?? "");
    if (st === "FAILURE" || st === "ERROR") return { ciState: "failure", failedChecks: [] };
    if (st === "PENDING" || st === "EXPECTED") return { ciState: "pending", failedChecks: [] };
    return { ciState: "success", failedChecks: [] };
  }

  const failedChecks: string[] = [];
  let anyPending = false;
  for (const c of ctx) {
    const name = c.name ?? c.context ?? "";
    if (isIgnored(name)) continue;
    if (c.__typename === "CheckRun" || c.status != null || c.conclusion != null) {
      if (c.status !== "COMPLETED") { anyPending = true; continue; }
      if (FAILED_CONCLUSIONS.has(String(c.conclusion))) failedChecks.push(name);
    } else {
      const state = String(c.state ?? "");
      if (state === "PENDING" || state === "EXPECTED") anyPending = true;
      else if (FAILED_STATES.has(state)) failedChecks.push(name);
    }
  }
  if (failedChecks.length > 0) return { ciState: "failure", failedChecks };
  return { ciState: anyPending ? "pending" : "success", failedChecks: [] };
}

// --- greenlight -------------------------------------------------------------

export function deriveGreenlight(pr: Any, cfg: DeriveConfig): GreenlightState {
  const ctx = nodes(pr.statusCheckRollup?.contexts).filter((c) =>
    lc(c.name ?? c.context).includes(cfg.greenlightSubstring.toLowerCase()));
  if (ctx.length === 0) return "absent"; // no pull_request trigger after a push => absent, never converged
  const failing = ctx.some((c) =>
    FAILED_CONCLUSIONS.has(String(c.conclusion)) || FAILED_STATES.has(String(c.state)));
  if (failing) return "failing";
  const success = ctx.some((c) => c.conclusion === "SUCCESS" || c.state === "SUCCESS");
  return success ? "converged" : "absent";
}

// --- thermo grade -----------------------------------------------------------

const THERMO_LINE = /^THERMO GRADE:\s*([A-F])\s*$/m;

export function deriveThermo(comments: Any[]): { thermoGrade: ThermoGrade | null; thermoCycles: number } {
  let grade: ThermoGrade | null = null;
  let cycles = 0;
  for (const c of comments) { // assumed chronological; newest wins
    const m = THERMO_LINE.exec(String(c.body ?? ""));
    if (m) { grade = m[1] as ThermoGrade; cycles++; }
  }
  return { thermoGrade: grade, thermoCycles: cycles };
}

// --- unresolved threads -----------------------------------------------------

export function deriveUnresolved(pr: Any): number {
  return nodes(pr.reviewThreads).filter((t) => t.isResolved === false).length;
}

// --- codex review bot -------------------------------------------------------

const CODEX_ASK = /^\s*>?\s*@[A-Za-z0-9-]*codex[A-Za-z0-9-]*\s+review\b/im;
const REVIEWED_COMMIT = /Reviewed commit:\s*([0-9a-f]{7,40})/i;

export function deriveCodex(comments: Any[], head: string | null, cfg: DeriveConfig): {
  codexState: CodexReviewState; codexReviewedSha: string | null;
} {
  const isCodex = (login: unknown) => lc(login) === cfg.codexBotLogin.toLowerCase();
  let askAt: number | null = null;
  let answerAt: number | null = null;
  let newestCodexBody = "";
  let stampedSha: string | null = null;

  for (const c of comments) {
    const at = ts(c.createdAt ?? c.submittedAt);
    if (isCodex(c.author?.login)) {
      if (at != null && (answerAt == null || at >= answerAt)) {
        answerAt = at;
        newestCodexBody = String(c.body ?? "");
        stampedSha = REVIEWED_COMMIT.exec(newestCodexBody)?.[1] ?? stampedSha;
      }
    } else if (CODEX_ASK.test(String(c.body ?? ""))) {
      if (at != null && (askAt == null || at >= askAt)) askAt = at;
    }
  }

  if (askAt == null && answerAt == null) return { codexState: "none", codexReviewedSha: null };

  const codexCoversHead = !!stampedSha && !!head && prefixEq(head, stampedSha);
  if (askAt != null && (answerAt == null || askAt > answerAt) && !codexCoversHead) {
    return { codexState: "requested", codexReviewedSha: stampedSha };
  }
  const approved = /didn't find any major issues/i.test(newestCodexBody) && codexCoversHead;
  return { codexState: approved ? "approved" : "reviewed", codexReviewedSha: stampedSha };
}

// --- CTO state --------------------------------------------------------------

export function deriveCto(pr: Any, head: string | null, cfg: DeriveConfig): {
  ctoState: CtoState; ctoReviewedAt: number | null; ctoReviewedSha: string | null;
} {
  const ctoSet = new Set(cfg.ctoLogins.map((l) => l.toLowerCase()));
  const isCto = (login: unknown) => ctoSet.has(lc(login));
  const reviews = nodes(pr.reviews)
    .filter((r) => isCto(r.author?.login) && r.state !== "PENDING")
    .sort((a, b) => (ts(a.submittedAt) ?? 0) - (ts(b.submittedAt) ?? 0));
  const pendingRequest = nodes(pr.reviewRequests)
    .some((rr) => isCto(rr.requestedReviewer?.login));

  if (reviews.length === 0) {
    return { ctoState: pendingRequest ? "requested" : "none", ctoReviewedAt: null, ctoReviewedSha: null };
  }

  const newest = reviews[reviews.length - 1]!;
  const sha = newest.commit?.oid ?? null;
  const at = ts(newest.submittedAt);
  const everApproved = reviews.some((r) => r.state === "APPROVED");

  switch (newest.state) {
    case "APPROVED": {
      const covers = (!!sha && !!head && prefixEq(head, sha)) ||
        (at != null && pr.__headCommittedAt != null && at >= pr.__headCommittedAt);
      // A fresh re-review request from the CTO after approval reads as `requested`.
      if (pendingRequest) return { ctoState: "requested", ctoReviewedAt: at, ctoReviewedSha: sha };
      return { ctoState: covers ? "approved" : "stale-approval", ctoReviewedAt: at, ctoReviewedSha: sha };
    }
    case "CHANGES_REQUESTED":
      return { ctoState: "changes-requested", ctoReviewedAt: at, ctoReviewedSha: sha };
    case "DISMISSED":
      return { ctoState: "reviewed", ctoReviewedAt: null, ctoReviewedSha: null };
    case "COMMENTED":
      return {
        ctoState: everApproved ? "commented-after-approval" : "reviewed",
        ctoReviewedAt: at, ctoReviewedSha: sha,
      };
    default:
      return { ctoState: "reviewed", ctoReviewedAt: at, ctoReviewedSha: sha };
  }
}

// --- review bot (code quality) ---------------------------------------------

export function deriveReviewBot(comments: Any[], cfg: DeriveConfig): {
  reviewBotState: ReviewBotState; reviewBotAt: number | null;
} {
  let at: number | null = null;
  for (const c of comments) {
    if (lc(c.author?.login) !== cfg.reviewBotLogin.toLowerCase()) continue;
    const firstLine = String(c.body ?? "").split("\n")[0] ?? "";
    if (!/code quality review/i.test(firstLine)) continue;
    const t = ts(c.createdAt ?? c.submittedAt);
    if (t != null && (at == null || t > at)) at = t;
  }
  // "approved" (findings handed to the agent) is derived from the audit log by autonomy (step 7).
  return { reviewBotState: at != null ? "reviewed" : "none", reviewBotAt: at };
}

// --- top-level --------------------------------------------------------------

export function deriveStates(pr: Any, cfg: DeriveConfig): DerivedPr {
  const commit = nodes(pr.commits).at(-1)?.commit;
  const headSha = commit?.oid ?? null;
  const headCommittedAt = ts(commit?.committedDate);
  (pr as Any).__headCommittedAt = headCommittedAt; // consumed by deriveCto's approval fallback

  const comments = nodes(pr.comments);
  const ci = deriveCi(pr, cfg);
  const cto = deriveCto(pr, headSha, cfg);
  const thermo = deriveThermo(comments);
  const codex = deriveCodex(comments, headSha, cfg);
  const reviewBot = deriveReviewBot(comments, cfg);

  const skip = new Set([cfg.codexBotLogin, cfg.reviewBotLogin, ...cfg.ctoLogins].map((l) => l.toLowerCase()));
  const outstanding = nodes(pr.reviewRequests)
    .map((rr) => String(rr.requestedReviewer?.login ?? ""))
    .filter((l) => l && !skip.has(l.toLowerCase()));

  let ack: number | null = null;
  if (cfg.operatorLogin) {
    for (const c of comments) {
      if (lc(c.author?.login) !== cfg.operatorLogin.toLowerCase()) continue;
      const at = ts(c.createdAt);
      if (at != null && (cto.ctoReviewedAt == null || at > cto.ctoReviewedAt) && (ack == null || at > ack)) ack = at;
    }
  }

  return {
    prState: String(pr.state ?? ""),
    isDraft: !!pr.isDraft,
    title: String(pr.title ?? ""),
    url: String(pr.url ?? ""),
    branch: String(pr.headRefName ?? ""),
    mergeable: String(pr.mergeable ?? "UNKNOWN"),
    headSha,
    headCommittedAt,
    ...ci,
    greenlightState: deriveGreenlight(pr, cfg),
    ...codex,
    ...cto,
    ...reviewBot,
    ...thermo,
    unresolvedComments: deriveUnresolved(pr),
    operatorAckedAt: ack,
    outstandingReviewerTags: outstanding,
    remoteUpdatedAt: ts(pr.updatedAt),
  };
}
