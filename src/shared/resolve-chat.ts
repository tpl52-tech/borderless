/**
 * Resolve-chat (web console, PRD §11) — the PURE half of the per-ticket chat that helps a lead resolve a sweep
 * job stopped at needs_human. The live chat call + HTTP endpoint live in the daemon/web; here is the context
 * seed the model gets and the coercer for the untrusted client-sent history. No I/O.
 */

import { asArray, obj, str } from "./coerce.ts";

export interface ResolveChatContext {
  ticketKey: string;
  title: string | null;
  description: string | null; // the ticket body / acceptance criteria
  state: string | null;       // the sweep job's state (e.g. needs_human)
  reason: string | null;      // why it stopped for a human (the escalation)
  prNumber: number | null;
}

/** One prior turn of the conversation, replayed to the stateless chat backend so it threads. */
export interface ResolveTurn { role: "user" | "assistant"; text: string; }

const MAX_DESCRIPTION = 4000; // keep a long ticket body from bloating the seed

/** The standing context message: the model's role + the ticket + why it stopped. The lead's question follows. Pure. */
export function resolveChatSeed(ctx: ResolveChatContext): string {
  const desc = ctx.description?.trim();
  const clamped = desc ? (desc.length > MAX_DESCRIPTION ? desc.slice(0, MAX_DESCRIPTION) + "\n…(truncated)" : desc) : null;
  return [
    "You are helping the engineering lead resolve a Borderless sweep job that stopped for human review.",
    "An autonomous agent built and drove a PR for this ticket, and the gate escalated it to a human instead of",
    "marking it ready. Discuss the ticket and the blocker, answer the lead's questions directly, and recommend",
    "how to resolve it: approve the PR as-is, change the approach, or give the implementer specific guidance.",
    "Be concise and concrete. You cannot take actions here — this is advice for the lead to act on.",
    "",
    `Ticket ${ctx.ticketKey}: ${ctx.title ?? "(title unknown)"}`,
    `Job state: ${ctx.state ?? "unknown"}${ctx.prNumber != null ? ` · PR #${ctx.prNumber}` : ""}`,
    `Why it stopped for a human: ${ctx.reason ?? "(no reason recorded)"}`,
    clamped ? `\nAcceptance criteria / ticket body:\n${clamped}` : "\n(No ticket body was synced.)",
  ].join("\n");
}

/** Coerce the untrusted `history` from a resolve-chat POST → clean ResolveTurn[] (drops empty turns). Pure. */
export function parseResolveTurns(raw: unknown): ResolveTurn[] {
  return asArray(raw)
    .map((t) => {
      const o = obj(t);
      const role: ResolveTurn["role"] = str(o.role) === "assistant" ? "assistant" : "user";
      return { role, text: str(o.text) };
    })
    .filter((t) => t.text.length > 0);
}
