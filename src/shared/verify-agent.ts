/**
 * Verification-agent output contract + parser (PRD §13, phase V4 / COR-87) — the pure "turn what the spawned
 * verification agent reported into grounded findings" brain. The agent (daemon, phase B) reads a ticket's
 * acceptance criteria + the PR diff + the codebase, runs read-only probes, and emits its verdict as JSON:
 *
 *   { "findings": [ { "criterion": "...", "status": "pass|fail|inconclusive", "evidence": "..." }, ... ] }
 *
 * This parses that (tolerant of prose/markdown fences around the JSON) into AgentFinding[], which rollupVerdict
 * folds alongside the deterministic bars. No I/O. Precision-biased toward inconclusive: anything we can't read
 * as a clear pass/fail becomes inconclusive (→ needs_human), never a silent pass.
 */

import type { AgentFinding } from "./verify-verdict.ts";

/** Options for the verification-agent seed. */
export interface VerifyAgentSeedOpts {
  /** Absolute path the agent must write its JSON verdict to (read back + parsed after it exits). */
  verdictPath: string;
  /** When true (verifyAllowWrites), the agent may create throwaway test data (cleaning up after); else read-only. */
  allowWrites?: boolean;
}

/**
 * Build the verification agent's seed (PRD §13, phase V4 / COR-87). Pure. The agent runs in a worktree with the
 * merged code; it confirms the ticket's acceptance criteria actually hold in the backend (the invisible half),
 * grounding every finding in real evidence, and writes a JSON verdict to `verdictPath`. Read-only by default —
 * the write allowance is gated on `allowWrites` (config.verifyAllowWrites), never on by accident.
 */
export function buildVerifyAgentSeed(
  issue: { identifier: string; title: string; description: string | null },
  opts: VerifyAgentSeedOpts,
): string {
  const accessRule = opts.allowWrites
    ? `You MAY create throwaway test data AS A DISPOSABLE TEST USER to exercise behavior, but you MUST delete anything you create, MUST NOT touch real/production data, and MUST NOT run migrations or schema changes. Anything you cannot cleanly undo → mark the finding "inconclusive".`
    : `You have READ-ONLY access: do NOT create, modify, or delete any data, run any write, or run migrations. If verifying a criterion would require a write, mark that finding "inconclusive" and say why.`;
  return [
    `You are a backend VERIFICATION agent for ticket ${issue.identifier}: "${issue.title}".`,
    `Your job: confirm the ticket's acceptance criteria actually HOLD in the merged implementation — focus on the INVISIBLE, backend behavior QA cannot see from the app screen: RLS / data isolation, DB triggers & side-effects, schema / constraints, Worker server-logic, data integrity, Storage. You are in a git worktree with the full codebase and the change is merged.`,
    accessRule,
    `Ground EVERY finding in concrete evidence — a query result, a command's output, or a file:line reference. Never guess, never assume from the code alone that runtime behavior is correct; if you cannot actually verify something, its status is "inconclusive".`,
    `Tools: read the code; use \`git log\` / \`git diff\` / \`gh pr view\` to see the change; and use the read-only verify-probe command (run it with \`--help\` for usage) to inspect the live database and app as an anonymous or test user.`,
    `Acceptance criteria to verify:\n${(issue.description ?? "(none provided)").slice(0, 4000)}`,
    `When you are done, write ONLY a JSON object to ${opts.verdictPath} — no prose, no markdown fences — of exactly this shape:`,
    `{ "findings": [ { "criterion": "<one acceptance criterion, in your own words>", "status": "pass" | "fail" | "inconclusive", "evidence": "<exactly what you observed that proves it>" } ] }`,
  ].join("\n\n");
}

const inconclusive = (criterion: string, evidence: string): AgentFinding => ({ criterion, status: "inconclusive", evidence });

/** Best-effort pull a JSON value out of the agent's raw output: the whole string, a ```json fence, or a {…}/[…] span. */
function extractJson(raw: string): unknown {
  const candidates = [raw, raw.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1], raw.match(/[[{][\s\S]*[\]}]/)?.[0]];
  for (const c of candidates) {
    if (c == null) continue;
    try { return JSON.parse(c); } catch { /* try the next candidate */ }
  }
  return null;
}

/** Validate one raw finding; null if it has no usable criterion. Unknown status ⇒ inconclusive (never a free pass). */
function toFinding(x: unknown): AgentFinding | null {
  if (x == null || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  const criterion = typeof o.criterion === "string" && o.criterion.trim() ? o.criterion.trim() : null;
  if (!criterion) return null;
  const status = o.status === "pass" || o.status === "fail" ? o.status : "inconclusive";
  const evidence = typeof o.evidence === "string" ? o.evidence.trim() : "";
  return { criterion, status, evidence };
}

/**
 * Parse the verification agent's raw output into grounded findings. Tolerant: a non-JSON / shapeless / empty
 * result degrades to a single inconclusive finding (so a confused agent surfaces as needs_human, never a pass).
 */
export function parseAgentVerdict(raw: string): AgentFinding[] {
  const json = extractJson(raw);
  if (json == null) return [inconclusive("agent verdict", "the agent's output could not be parsed as a verdict")];
  const arr: unknown = Array.isArray(json) ? json : (json as Record<string, unknown>).findings;
  if (!Array.isArray(arr)) return [inconclusive("agent verdict", "the agent's output had no findings array")];
  const findings = arr.map(toFinding).filter((f): f is AgentFinding => f != null);
  return findings.length ? findings : [inconclusive("agent verdict", "the agent reported no usable findings")];
}
