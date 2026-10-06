/**
 * Ticket parsing & seed expansion (design §7.3, §12.2).
 *
 * Ticket extraction: 2-6 letters, hyphen, 1-6 digits, word-bounded, team key in the allowlist;
 * max 4 per call; branch checked first (callers pass branch text first). GitHub-issue provider matches
 * `<PREFIX>-<digits>` (pass the prefix in the allowlist). Bare-ticket detection gates seed expansion.
 * Ticket URLs are built from the configured workspace slug, NEVER defaulted.
 */

import type { Tool, TicketProvider } from "./types.ts";
import type { ReviewPolicy } from "./profile.ts";

const TOKEN = /\b([A-Za-z]{2,6})-(\d{1,6})\b/g;
const BARE = /^([A-Za-z]{2,6})-(\d{1,6})$/;

function keySet(teamKeys: string[]): Set<string> {
  return new Set(teamKeys.map((k) => k.toUpperCase()));
}

/** Extract up to 4 allow-listed ticket ids from text, in order, de-duplicated (design §12.2). */
export function extractTickets(text: string, teamKeys: string[], _provider: TicketProvider): string[] {
  const allow = keySet(teamKeys);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(TOKEN)) {
    const key = m[1]!.toUpperCase();
    if (!allow.has(key)) continue;
    const id = `${key}-${m[2]}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= 4) break;
  }
  return out;
}

/** True iff the trimmed text is EXACTLY one bare ticket id with a known team key (design §7.1). */
export function isBareTicket(text: string, teamKeys: string[]): boolean {
  const m = BARE.exec(text.trim());
  return !!m && keySet(teamKeys).has(m[1]!.toUpperCase());
}

/** Build a Linear ticket URL from the configured workspace slug (never defaulted). */
export function ticketUrl(ticket: string, workspaceSlug: string): string {
  return `https://linear.app/${workspaceSlug}/issue/${ticket.toUpperCase()}`;
}

export interface SeedExpansionContext {
  provider: TicketProvider;
  reviewPolicy: ReviewPolicy;
  ctoLogin?: string;
  codexBotLogin?: string;
}

/** How each tool reads a ticket (design §7.3 element 1). */
function readInstruction(tool: Tool, provider: TicketProvider, ticket: string): string {
  if (provider === "github") {
    return `Read the issue with \`gh issue view ${ticket}\` (and its comments). Do NOT implement from the id alone.`;
  }
  switch (tool) {
    case "claude":
      return `Load the Linear MCP tools (use the exact deferred-tool search — an empty result means success; never the regex search tool) and read ${ticket} and its comments. Do NOT implement from the id alone.`;
    case "codex":
    case "copilot":
      return `Call the configured \`linear\` MCP server and read ${ticket} and its comments. Do NOT implement from the id alone.`;
    case "openrouter":
      return `Use the preloaded \`linear_get_issue\` / \`linear_list_comments\` tools to read ${ticket}. Do NOT implement from the id alone.`;
  }
}

/** The reviewer tail, rewritten to match the profile's review policy (design §7.3). */
function approvalTail(ctx: SeedExpansionContext): string {
  if (ctx.reviewPolicy.cto && ctx.ctoLogin) return `approved by ${ctx.ctoLogin}`;
  if (ctx.reviewPolicy.codex) return `approved by the code review bot`;
  return `all required reviews satisfied`;
}

/**
 * Expand a bare ticket into the per-tool workflow prompt (design §7.3). Semantic elements:
 * (1) read the ticket; (2) blocked check; (3) implement + graded self-review to grade A (<=3 cycles),
 * open the PR, post a line `THERMO GRADE: <A-F>`; (4) drive to green CI and to approval by the
 * configured reviewers.
 */
export function expandTicketSeed(ticket: string, tool: Tool, ctx: SeedExpansionContext): string {
  const T = ticket.toUpperCase();
  const verify = ctx.provider === "github"
    ? "`gh pr view --json state,mergedAt`"
    : "`gh pr view --json state,mergedAt` for any prerequisite PR";
  return [
    `Work on ${T}.`,
    ``,
    `1. ${readInstruction(tool, ctx.provider, T)}`,
    `2. Blocked check: if ${T} has a "blocked by" relation whose blocker is not Done, or names a`,
    `   prerequisite PR in its description that is not merged (verify with ${verify}), do NOT`,
    `   implement — stop and report exactly: "BLOCKED by <what>".`,
    `3. Implement it. Then run a graded self-review cycle until grade A, at most three cycles. Open the`,
    `   PR and post a comment containing, on its own line, \`THERMO GRADE: <A-F>\` (this is the only`,
    `   surface the supervisor can read a grade from).`,
    `4. Drive the PR to green CI and to ${approvalTail(ctx)}.`,
  ].join("\n");
}
