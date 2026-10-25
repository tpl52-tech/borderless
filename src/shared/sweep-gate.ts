/**
 * The sweep gate — the pure "is this ready to merge, and if not what next" brain (lead-console PRD §4-§5).
 *
 * No I/O. The engine (daemon, build order #3b) gathers the signals — CI check states, the independent
 * reviewer's verdict, the changed paths — and feeds them here; the result drives whether it spawns a
 * worker, spawns a reviewer, waits on CI, marks the job ready, or escalates to the human.
 *
 * Code quality is gated too: the SAME INDEPENDENT reviewer also grades the diff to the /thermo-nuclear
 * standard, and the gate requires exactly A (below-A or ungraded blocks). This is not self-grading — the
 * grader never wrote the code — so it avoids the inflation that originally kept a self-reported grade out of
 * the gate. Absence is never a pass: a null/missing signal blocks rather than silently clearing.
 */

import type { SweepKind } from "./types.ts";

/** The fix→review loop runs at most this many worker attempts before the job stops for a human (PRD §4). */
export const MAX_CYCLES = 8;

/** The required status checks that must BOTH be green (PRD §4). */
export const REQUIRED_CHECKS = ["ci", "secrets-scan"] as const;
export type RequiredCheck = (typeof REQUIRED_CHECKS)[number];

export type CheckState = "success" | "pending" | "failure" | "missing";

/**
 * Does this sweep kind BUILD the change from nothing (rescue, qa-fix) rather than drive an author's existing
 * PR (in_review)? A build-from-scratch kind bootstraps a worker with no PR, and must prove EVERY acceptance
 * criterion satisfied (not merely "no regression") before it can be ready. One predicate so the engine, the
 * gate, and the worker/reviewer seeds all agree on what "from scratch" means.
 */
export function buildsFromScratch(kind: SweepKind): boolean {
  return kind !== "in_review";
}

/** The sweep gate's code-quality bar: the independent reviewer's /thermo-nuclear grade must be exactly A —
 *  A-, any lower grade, or no grade does not pass. One predicate so the gate and the fix-cycle worker seed
 *  share the single rule. */
export function thermoPasses(grade: string | null): boolean {
  return grade === "A";
}

/** Why a job is not yet ready-to-merge. Empty iff the gate passes. */
export type GateBlocker =
  | "regression-unproven" // in_review: the no-regression diff isn't proven
  | "acceptance-unproven" // rescue/fix (build-from-scratch): acceptance criteria not shown satisfied
  | "ci-failing" // a required check failed
  | "ci-pending" // a required check is still pending/missing
  | "reviewer-unrun" // the independent reviewer hasn't run on this head
  | "reviewer-red" // the independent reviewer left >=1 blocking (🔴) finding
  | "thermo-below-a"; // the independent reviewer graded code quality below A

export interface GateInput {
  kind: SweepKind;
  /** in_review: the no-regression proof; rescue/fix: acceptance-criteria satisfied. null = not yet established. */
  preservationProven: boolean | null;
  /** Observed state of each required check; an absent name reads as "missing". */
  checks: Partial<Record<RequiredCheck, CheckState>>;
  /** Count of blocking (🔴) findings from the independent reviewer; null = it hasn't run on this head. */
  reviewerRedFindings: number | null;
  /** The SAME independent reviewer's /thermo-nuclear code-quality grade ("A", "A-", "B+", …); null = not
   *  graded yet. The gate requires exactly "A". */
  thermoGrade: string | null;
}

export interface GateResult {
  pass: boolean;
  blockers: GateBlocker[];
}

/** Evaluate the three-part ready-to-merge gate (PRD §4). */
export function evaluateGate(input: GateInput): GateResult {
  const blockers: GateBlocker[] = [];

  // 1. Behavior preservation — no-regression (in_review) or acceptance criteria (rescue/fix, PRD §5).
  if (input.preservationProven !== true) {
    blockers.push(buildsFromScratch(input.kind) ? "acceptance-unproven" : "regression-unproven");
  }

  // 2. CI — every required check must be success. A failure is terminal-until-fixed; anything
  //    unfinished (pending/missing) only means "wait".
  let anyFailing = false;
  let anyUnfinished = false;
  for (const name of REQUIRED_CHECKS) {
    const state = input.checks[name] ?? "missing";
    if (state === "failure") anyFailing = true;
    else if (state !== "success") anyUnfinished = true;
  }
  if (anyFailing) blockers.push("ci-failing");
  else if (anyUnfinished) blockers.push("ci-pending");

  // 3. Independent reviewer — zero 🔴. null = not yet run (never a pass).
  if (input.reviewerRedFindings === null) blockers.push("reviewer-unrun");
  else if (input.reviewerRedFindings > 0) blockers.push("reviewer-red");

  // 4. Code quality — the SAME independent reviewer's /thermo-nuclear grade must be exactly A. Only checked
  //    once the reviewer has run (it is the grade's source); a below-A or missing grade blocks (fail-closed).
  if (input.reviewerRedFindings !== null && !thermoPasses(input.thermoGrade)) blockers.push("thermo-below-a");

  return { pass: blockers.length === 0, blockers };
}

export type SweepActionKind =
  | "spawn-worker" // fix (in_review) or implement (rescue) — advances a cycle
  | "spawn-reviewer" // run the independent reviewer on the current head
  | "wait-ci" // required checks still pending — poll again
  | "ready" // gate passed, nothing risky → ready-to-merge (a human merges)
  | "sign-off" // gate passed but a dangerous tier was touched → driven clean, awaiting a human glance
  | "needs-human"; // a real decision (collision/judgment) or the 8-cycle cap

export interface SweepAction {
  kind: SweepActionKind;
  reason?: string;
}

export interface SweepDecisionInput {
  /** Worker runs completed so far (fix/implement attempts). */
  cycles: number;
  gate: GateResult;
  /**
   * A reason to stop for the human NOW instead of iterating: a genuine no-clearly-better-option judgment call
   * or a cross-ticket collision: a real decision, not a rubber-stamp. Outranks everything, including a
   * passing gate. null = keep self-resolving (PRD §4).
   */
  blockingEscalation: string | null;
  /**
   * A dangerous tier was touched (auth/money/schema/ci-config): mechanically the change may be fine, but the
   * MERGE needs a human glance. This never blocks the drive: the sweep still fixes/reviews to a passing gate,
   * then hands off for sign-off instead of auto-"ready" (PRD §4, "risky tiers always get explicit human
   * review"). null = no risky tier; ignored until the gate passes. A tier that coincides with a blocking
   * escalation is folded into that reason upstream, so it won't appear here.
   */
  signoffReason: string | null;
}

/** Decide the next move for a sweep job from the gate result + cycle budget + escalations (PRD §4-§5). */
export function nextSweepAction(input: SweepDecisionInput): SweepAction {
  const { gate, cycles, blockingEscalation, signoffReason } = input;

  // A blocking escalation outranks everything, including a passing gate: a cross-ticket collision or a
  // no-clearly-better judgment call always gets an explicit human decision, never an auto-"ready"
  // rubber-stamp (PRD §4).
  if (blockingEscalation) return { kind: "needs-human", reason: blockingEscalation };

  // Gate passed. A dangerous tier doesn't block the drive, but the merge waits on a human glance, so hand
  // off for sign-off rather than auto-merging a risky change (PRD §4). No tier → genuinely ready.
  if (gate.pass) return signoffReason ? { kind: "sign-off", reason: signoffReason } : { kind: "ready" };

  const step = nextStep(gate.blockers);

  // The 8-cycle cap bounds the fix→review loop: stop before spawning a 9th worker (PRD §4). Waiting on
  // CI or running the reviewer stays within the current cycle, so the cap doesn't block those.
  if (step === "spawn-worker" && cycles >= MAX_CYCLES) {
    return { kind: "needs-human", reason: `8-cycle cap reached; unresolved: ${gate.blockers.join(", ")}` };
  }
  return { kind: step };
}

function nextStep(blockers: GateBlocker[]): "spawn-worker" | "spawn-reviewer" | "wait-ci" {
  // A red build is fixed before reviewing; CI must settle before a review is worth running.
  if (blockers.includes("ci-failing")) return "spawn-worker";
  if (blockers.includes("ci-pending")) return "wait-ci";
  // CI is green here. Review if it hasn't run on this head; otherwise the remaining blockers (red
  // findings, or a preservation diff the reviewer couldn't prove) are the worker's to address next cycle.
  if (blockers.includes("reviewer-unrun")) return "spawn-reviewer";
  return "spawn-worker";
}

/** The dangerous tiers that always get a human, however the sweep feels about the change (PRD §4). */
export type DangerTier = "auth" | "money" | "schema" | "ci-config";

// Segment keywords per tier, matched against path segments (split on / . _ -), so `src/auth/login.ts`
// flags `auth` while `author.ts` does not. Because a MISSED dangerous tier is worse than an extra human
// glance, the auth list spells out the common variants (authentication/authorize/authz/authn/...) instead
// of leaning on a bare "auth" segment. Two bare words are deliberately EXCLUDED to avoid self-collisions
// in this codebase: "token"/"tokens" (design tokens, push_tokens — not auth) and "price"/"pricing" (LLM
// usage cost in shared/pricing.ts — not money-movement); real auth/money code is caught by the folder and
// feature words below. Extend the lists as the app grows.
const DANGER_KEYWORDS: Record<Exclude<DangerTier, "ci-config">, readonly string[]> = {
  auth: [
    "auth", "authn", "authz", "authentication", "authenticate", "authenticator",
    "authorization", "authorize", "login", "logout", "session", "sessions",
    "password", "credential", "credentials", "oauth", "jwt",
  ],
  money: [
    "billing", "payment", "payments", "payout", "payouts", "charge", "charges",
    "stripe", "invoice", "checkout", "subscription",
  ],
  schema: ["migration", "migrations", "schema", "rls"],
};

/**
 * Dangerous tiers touched by the changed files (PRD §4). `.github/` and `*.sql` are matched by
 * path shape; the rest by exact path segments. Returns the distinct tiers, for the human gate.
 */
export function dangerousTiers(paths: string[]): DangerTier[] {
  const tiers = new Set<DangerTier>();
  for (const raw of paths) {
    const path = raw.toLowerCase();
    if (path === ".github" || path.startsWith(".github/") || path.includes("/.github/")) tiers.add("ci-config");
    if (path.endsWith(".sql")) tiers.add("schema");
    const segments = new Set(path.split(/[/._-]+/).filter(Boolean));
    for (const [tier, words] of Object.entries(DANGER_KEYWORDS) as [Exclude<DangerTier, "ci-config">, readonly string[]][]) {
      if (words.some((w) => segments.has(w))) tiers.add(tier);
    }
  }
  return [...tiers];
}
