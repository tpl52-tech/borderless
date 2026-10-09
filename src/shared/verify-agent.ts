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
