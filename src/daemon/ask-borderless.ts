/**
 * Ask Borderless — the fleet-aware console chat core (PRD §10).
 *
 * `buildFleetContext` summarizes the live store (sweep jobs + the ones needing attention, Linear issues,
 * roster) and the design docs into one block, injected as the chat's context. The fleet TOOLS let the chat
 * act — enqueue a sweep, resolve a needs_human job, reassign a ticket, post a Linear comment — each wrapping
 * a Store/daemon method; all are consequential and gated behind an injected lead `confirm()` (denied → the
 * chat still answers, it just can't act). `askBorderless` composes these over the reusable `runAgentLoop`
 * (openrouter/runner.ts) with an injected `Chat`, so the orchestration is deterministic + unit-tested; the
 * live OpenRouter chat client and the Linear write mutations are the thin creds-gated half (7b).
 */

import type { Store } from "./store.ts";
import type { SweepJob } from "../shared/types.ts";
import { isTerminalState } from "../shared/boards.ts";
import { ROSTER, type Member } from "../shared/roster.ts";
import { resolveDelegate } from "../shared/lead-desk.ts";
import { authorizeRescue } from "./rescue-scan.ts";
import { runAgentLoop, type Chat, type ToolDef, type ToolCall, type LoopResult } from "./openrouter/runner.ts";
import type { ToolResult } from "./openrouter/tools.ts";

const DOC_CLIP = 6000; // keep a long design doc from blowing up the context

// --- fleet context ----------------------------------------------------------

/** Design docs injected into the context; loaded live (fs), passed in for tests. */
export interface FleetDocs { prd?: string; handoff?: string }

function countBy<T>(items: T[], key: (t: T) => string): string {
  const counts = new Map<string, number>();
  for (const it of items) counts.set(key(it), (counts.get(key(it)) ?? 0) + 1);
  return [...counts].map(([k, n]) => `${k}: ${n}`).join(", ") || "none";
}

/** A compact snapshot of live fleet state + the design docs, injected as the chat's context (PRD §10). */
export function buildFleetContext(store: Store, docs: FleetDocs = {}, roster: Member[] = ROSTER): string {
  const jobs = store.listSweepJobs();
  const needsHuman = jobs.filter((j) => j.state === "needs_human");
  // "active" and "waiting on a human" are disjoint — a needs_human job is listed only once, below.
  const active = jobs.filter((j) => j.state !== "merged" && j.state !== "failed" && j.state !== "needs_human");
  const issues = store.listLinearIssues();

  const jobLine = (j: SweepJob) =>
    `  ${j.ticketKey} [${j.kind}] ${j.state}` +
    `${j.prNumber != null ? ` PR#${j.prNumber}` : ""} cycles=${j.cycles}` +
    `${j.reason ? ` — ${j.reason}` : ""}`;

  const openIssues = issues.filter((i) => !isTerminalState(i.stateType));

  return [
    "# Fleet state",
    "",
    `Sweep jobs by state: ${countBy(jobs, (j) => j.state)}`,
    active.length ? `Active jobs:\n${active.map(jobLine).join("\n")}` : "Active jobs: none",
    needsHuman.length ? `Waiting on a human:\n${needsHuman.map(jobLine).join("\n")}` : "Waiting on a human: none",
    "",
    `Linear issues by state: ${countBy(issues, (i) => i.stateName ?? "—")}`,
    `Open issues: ${openIssues.map((i) => i.identifier).join(", ") || "none"}`,
    "",
    "Roster:",
    ...roster.map((m) => `  ${m.name} (${m.netid})${m.lead ? " — lead" : ""}`),
    docs.prd ? `\n# PRD (excerpt)\n${docs.prd.slice(0, DOC_CLIP)}` : "",
    docs.handoff ? `\n# Handoff (excerpt)\n${docs.handoff.slice(0, DOC_CLIP)}` : "",
  ].filter(Boolean).join("\n");
}

// --- fleet tools ------------------------------------------------------------

/** What the fleet tools need. The Linear writes are injected (live in 7b; faked in tests). */
export interface FleetToolDeps {
  store: Store;
  roster: Member[];
  /** Reassign a Linear ticket to a member; returns a result line, or throws (→ tool error) on failure. */
  reassign: (ticketKey: string, assigneeLinearId: string) => Promise<string>;
  /** Post a comment on a Linear ticket; returns a result line, or throws (→ tool error) on failure. */
  comment: (ticketKey: string, body: string) => Promise<string>;
}

interface FleetTool {
  def: ToolDef;
  run: (args: Record<string, any>, deps: FleetToolDeps) => Promise<ToolResult>;
}

const ok = (output: string): ToolResult => ({ output });
const err = (output: string): ToolResult => ({ output, isError: true });

/**
 * The §10 fleet action tools. Each wraps a Store/daemon method; the model picks one when asked to act.
 * ALL are consequential (they change fleet/Linear state), so `askBorderless` gates every one behind the
 * lead's confirm() — there is no read-only tool here (fleet state is supplied via buildFleetContext).
 */
export const FLEET_TOOLS: FleetTool[] = [
  {
    def: {
      name: "enqueue_sweep",
      description: "Queue a sweep. kind='in_review' queues an in-review drive for every eligible In Review ticket; kind='rescue' authorizes a rescue for one overdue ticket (ticket required).",
      parameters: { type: "object", properties: { kind: { type: "string", enum: ["in_review", "rescue"] }, ticket: { type: "string", description: "ticket key, required for rescue" } }, required: ["kind"] },
    },
    run: async (args, { store }) => {
      if (args.kind === "rescue") {
        const ticket = String(args.ticket ?? "").trim();
        if (!ticket) return err("rescue needs a `ticket`");
        const r = authorizeRescue(store, ticket);
        return ok(`rescue ${r.job.ticketKey}: ${r.created ? "authorized (queued)" : "already active"}`);
      }
      if (args.kind === "in_review") {
        const created = store.enqueueInReviewSweeps();
        return ok(`enqueued ${created.length} in-review job(s): ${created.map((j) => j.ticketKey).join(", ") || "none"}`);
      }
      return err(`unknown kind '${args.kind}' (use in_review|rescue)`);
    },
  },
  {
    def: {
      name: "resolve_needs_human",
      description: "Resolve a sweep job that is waiting on a human. action='requeue' re-runs it; action='dismiss' marks it failed.",
      parameters: { type: "object", properties: { ticket: { type: "string" }, action: { type: "string", enum: ["requeue", "dismiss"] } }, required: ["ticket", "action"] },
    },
    run: async (args, { store }) => {
      const ticket = String(args.ticket ?? "").trim();
      const job = store.listSweepJobs({ state: "needs_human" }).find((j) => j.ticketKey === ticket);
      if (!job) return err(`no needs_human job for ${ticket || "(missing ticket)"}`);
      if (args.action === "requeue") {
        store.transitionSweepJob(job.id, { state: "queued", reason: null });
        return ok(`${ticket}: re-queued`);
      }
      if (args.action === "dismiss") {
        store.transitionSweepJob(job.id, { state: "failed", reason: "dismissed by lead" });
        return ok(`${ticket}: dismissed`);
      }
      return err(`unknown action '${args.action}' (use requeue|dismiss)`);
    },
  },
  {
    def: {
      name: "reassign_ticket",
      description: "Reassign a Linear ticket to a roster member (by netid, GitHub login, email, or full name).",
      parameters: { type: "object", properties: { ticket: { type: "string" }, assignee: { type: "string" } }, required: ["ticket", "assignee"] },
    },
    run: async (args, { roster, reassign }) => {
      const member = resolveDelegate(roster, String(args.assignee ?? "")); // throws if unknown → caught upstream
      const linearId = member.linearIds[0];
      if (!linearId) return err(`${member.name} has no Linear id on the roster`);
      return ok(await reassign(String(args.ticket ?? "").trim(), linearId));
    },
  },
  {
    def: {
      name: "post_linear_comment",
      description: "Post a comment on a Linear ticket.",
      parameters: { type: "object", properties: { ticket: { type: "string" }, body: { type: "string" } }, required: ["ticket", "body"] },
    },
    run: async (args, { comment }) => {
      const body = String(args.body ?? "").trim();
      if (!body) return err("post_linear_comment needs a non-empty `body`");
      return ok(await comment(String(args.ticket ?? "").trim(), body));
    },
  },
];

// --- orchestration ----------------------------------------------------------

/** Byte-stable (cache discipline): no interpolation — the question + fleet context go in the user turn. */
export const ASK_SYSTEM_PROMPT =
  "You are Borderless, the lead console for the Cornell EWB software team. Answer the lead's question from " +
  "the FLEET STATE given in the first user message. Use a tool only when the lead actually asks you to act; " +
  "consequential actions require the lead's confirmation, which may be denied. Be concise and specific.";

export interface AskDeps {
  chat: Chat;
  store: Store;
  reassign: FleetToolDeps["reassign"];
  comment: FleetToolDeps["comment"];
  roster?: Member[];
  docs?: FleetDocs;
  /** Gate for the (all consequential) fleet tools (PRD §10 "lead-confirmed"). Default: deny (advisory). */
  confirm?: (toolName: string, args: Record<string, any>) => Promise<boolean>;
  render?: (line: string) => void;
  maxSteps?: number;
}

/**
 * Answer one question with live fleet context + the fleet tools, over an injected Chat. Consequential tool
 * calls are gated by `confirm` (default deny). Returns the final assistant answer and the raw loop result.
 */
export async function askBorderless(question: string, deps: AskDeps): Promise<{ answer: string; result: LoopResult }> {
  const roster = deps.roster ?? ROSTER;
  const toolDeps: FleetToolDeps = { store: deps.store, roster, reassign: deps.reassign, comment: deps.comment };
  const confirm = deps.confirm ?? (async () => false);
  const byName = new Map(FLEET_TOOLS.map((t) => [t.def.name, t]));

  const runTool = async (call: ToolCall): Promise<ToolResult> => {
    const tool = byName.get(call.name);
    if (!tool) return err(`unknown tool: ${call.name}`);
    // every fleet tool is consequential (it changes state) → always lead-confirmed.
    if (!(await confirm(call.name, call.args))) {
      return err(`Not performed — ${call.name} needs the lead's confirmation.`);
    }
    try { return await tool.run(call.args, toolDeps); }
    catch (e) { return err(`${call.name} failed: ${e instanceof Error ? e.message : String(e)}`); }
  };

  const seed = `${question}\n\n--- FLEET STATE ---\n${buildFleetContext(deps.store, deps.docs, roster)}`;
  const result = await runAgentLoop({
    chat: deps.chat, cwd: "borderless-fleet", tools: FLEET_TOOLS.map((t) => t.def), runTool,
    systemPrompt: ASK_SYSTEM_PROMPT, seed, render: deps.render, maxSteps: deps.maxSteps ?? 12,
  });
  const answer = [...result.messages].reverse().find((m) => m.role === "assistant" && m.content)?.content ?? "";
  return { answer, result };
}
