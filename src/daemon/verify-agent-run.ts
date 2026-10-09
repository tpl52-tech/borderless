/**
 * Verification-agent runner (PRD §13, phase V4 / COR-87) — spawn a verification agent for one ticket and turn
 * its output into grounded findings. The spawn itself (a `claude` session in a worktree that writes its verdict
 * to a file, like the sweep reviewer) is injected, so this orchestration is testable with a fake; the live
 * session-manager spawn wires in at phase C.
 */

import type { LinearIssue } from "../shared/types.ts";
import { buildVerifyAgentSeed, parseAgentVerdict, type VerifyAgentSeedOpts } from "../shared/verify-agent.ts";
import type { AgentFinding } from "../shared/verify-verdict.ts";

export interface VerifyAgentDeps {
  /** Run the agent with the given seed and return its raw verdict output (the contents it wrote). */
  spawn: (seed: string) => Promise<string>;
  /** Whether the agent may make throwaway writes (config.verifyAllowWrites); default false ⇒ read-only. */
  allowWrites?: boolean;
  /** Where the agent writes its verdict (named in the seed so the live spawn knows where to read from). */
  verdictPath: string;
}

/** Run the verification agent for one ticket → its grounded findings (a confused/empty agent ⇒ inconclusive). */
export async function runVerifyAgent(issue: LinearIssue, deps: VerifyAgentDeps): Promise<AgentFinding[]> {
  const opts: VerifyAgentSeedOpts = { verdictPath: deps.verdictPath, allowWrites: deps.allowWrites };
  const raw = await deps.spawn(buildVerifyAgentSeed(issue, opts));
  return parseAgentVerdict(raw);
}
