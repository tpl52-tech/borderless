/**
 * Linear monitor (design §12.6).
 *
 * Reuses the MCP client against the `linear` server entry in ~/.claude.json; PERMANENTLY disables
 * itself if absent. Tick 30s, full resync every 5 min, wedge breaker after 4 min of NO PROGRESS
 * (not elapsed time), a generation fence so a superseded pass never writes or prunes.
 *
 * Fetches projects the operator is a member of; issues per visible project (identifier parsed from
 * gitBranchName/url because requesting it errors); an assigned-to-me sweep; blockers via get_issue
 * with relations (direction matters: only INCOMING "blocks" is a blocker). A failed blocker lookup
 * returns null (keep last known; a new issue with a failed lookup is skipped — absent beats falsely
 * ready). Prune ONLY after a fully successful pass. Derived status: done / blocked / in-progress /
 * ready — unknowns resolve toward caution because "ready" invites starting an agent.
 */

export function startLinearMonitor(): { stop(): void } {
  throw new Error("linear.startLinearMonitor: not implemented (design §12.6)");
}
