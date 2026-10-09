/**
 * Verification-agent runner (PRD §13, phase V4 / COR-87) — spawn a verification agent for one ticket and turn
 * its output into grounded findings. The spawn itself (a `claude` session in a worktree that writes its verdict
 * to a file, like the sweep reviewer) is injected, so this orchestration is testable with a fake; the live
 * session-manager spawn wires in at phase C.
 */

import type { LinearIssue } from "../shared/types.ts";
import { buildVerifyAgentSeed, parseAgentVerdict } from "../shared/verify-agent.ts";
import type { AgentFinding } from "../shared/verify-verdict.ts";

export interface VerifyAgentDeps {
  /** Run the agent on the given seed and return its raw verdict output (the live spawn owns where it's written
   *  — $AO_SESSION_DIR/verdict.json — and reads it back post-spawn; see VERIFY_VERDICT_FILE). */
  spawn: (seed: string) => Promise<string>;
  /** Whether the agent may make throwaway writes (config.verifyAllowWrites); default false ⇒ read-only. */
  allowWrites?: boolean;
  /** The read-only verify-probe CLI invocation the agent should use (the daemon's own path). */
  probeCommand?: string;
}

/** Run the verification agent for one ticket → its grounded findings (a confused/empty agent ⇒ inconclusive). */
export async function runVerifyAgent(issue: LinearIssue, deps: VerifyAgentDeps): Promise<AgentFinding[]> {
  return parseAgentVerdict(await deps.spawn(buildVerifyAgentSeed(issue, { allowWrites: deps.allowWrites, probeCommand: deps.probeCommand })));
}
