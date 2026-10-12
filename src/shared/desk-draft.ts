/**
 * Lead Desk v2 — chat → draft (PRD §9; web console). The lead describes work in natural language; the LLM
 * proposes a structured plan of epics + tickets (assignee, priority) which the lead reviews before
 * ANYTHING is written to Linear. This is the PURE half: the single-shot prompt the model gets, and the parser
 * that turns its JSON reply into a validated, assignee-resolved draft. It fails SOFT — a garbled reply, a bad
 * shape, or an unresolvable assignee degrades to warnings (the ticket is kept, flagged), never a throw. The
 * live Chat call + the create step (P3) live elsewhere; drafting writes nothing.
 */

import type { Member } from "./roster.ts";
import { firstName } from "./roster.ts";
import { findMember } from "./lead-desk.ts";
import { asArray, obj, str, strOrNull } from "./coerce.ts";

export interface DraftEpic { title: string; }
export interface DraftTicket {
  title: string;
  assignee: string;                 // display name (resolved first name, or the raw string the model returned)
  assigneeLinearId: string | null;  // resolved Linear user id, or null when unresolved
  resolved: boolean;                // false → the lead must fix the assignee before create
  priority: number;                 // Linear priority 0..4 (0 None, 1 Urgent, 2 High, 3 Medium, 4 Low)
  epic: string | null;              // the epic title this ticket belongs under, or null
}
export interface DeskDraft { epics: DraftEpic[]; tickets: DraftTicket[]; questions: string[]; warnings: string[]; }

/** A person the lead can assign work to, for the review dropdowns (localhost console only, so a Linear id is ok). */
export interface DraftPerson { name: string; linearId: string; }
/** The draft endpoint's full response: the parsed draft + the assignable people the review dropdowns need +
 *  whether the chat backend is configured. */
export interface DeskDraftResponse extends DeskDraft { configured: boolean; assignable: DraftPerson[]; }

/** Grounding for the draft prompt: who can be assigned + the existing epics, so the model stays real. */
export interface DraftContext { coLeads: string[]; members: string[]; epics: string[]; }

const PRIORITY: Record<string, number> = { none: 0, urgent: 1, high: 2, medium: 3, low: 4 };

/** Map a model priority word to Linear's numeric priority; unknown/absent → None (0). */
export function priorityNumber(word: unknown): number {
  return typeof word === "string" ? (PRIORITY[word.trim().toLowerCase()] ?? 0) : 0;
}

/** The single-shot prompt: the lead's words + grounding context + the exact JSON contract to emit. Pure. */
export function draftPrompt(text: string, ctx: DraftContext): string {
  return [
    "You are a staff engineering lead's delegation assistant. Turn the lead's request into a plan of Linear",
    "work: epics (big parent items) and tickets (each assigned to ONE person). Output ONLY a JSON object — no",
    "prose, no code fence — matching exactly this shape:",
    '{"epics":[{"title":str}],"tickets":[{"title":str,"assignee":str,"priority":"None|Low|Medium|High|Urgent","epic":str|null}],"questions":[str]}',
    "",
    "Rules:",
    "- assignee MUST be one of the people listed below, written EXACTLY as shown (full name). If the lead",
    "  didn't say who, make your best pick and add a question about it.",
    "- epic: the title of the epic this ticket belongs under (from your epics array or an existing epic), else null.",
    "- Only create an epic when the lead asks for one or the work clearly needs a parent. Never invent work the lead didn't ask for.",
    "- questions: anything you guessed or that's genuinely ambiguous; [] if none.",
    "",
    `People you can assign — co-leads: ${ctx.coLeads.join(", ") || "(none)"}${ctx.members.length ? ` · others: ${ctx.members.join(", ")}` : ""}`,
    `Existing epics: ${ctx.epics.join(", ") || "(none)"}`,
    "",
    `Lead's request: ${text}`,
  ].join("\n");
}

/** Pull the JSON object out of a model reply: a ```json fence first, else the first {...} span. Null if none. */
function extractJson(reply: string): string | null {
  const fence = reply.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence?.[1] ?? reply;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  return start >= 0 && end > start ? body.slice(start, end + 1) : null;
}

/** Resolve an assignee name to a member: an exact match (full name / netid / github / email) first, then a
 *  UNIQUE first-name match (the model usually writes first names); ambiguous or unknown → null. */
function resolveAssignee(roster: Member[], who: string): Member | null {
  const exact = findMember(roster, who);
  if (exact) return exact;
  const q = who.trim().toLowerCase();
  const byFirst = roster.filter((m) => firstName(m).toLowerCase() === q);
  return byFirst.length === 1 ? byFirst[0]! : null; // unique only — never guess between two people
}

/**
 * Parse a model reply into a validated DeskDraft. Fails SOFT: an unparseable reply, a bad shape, or an
 * unresolvable assignee degrades to warnings (the ticket kept with resolved=false), never a throw — the lead
 * fixes it in review before anything is created.
 */
export function parseDraft(reply: string, roster: Member[]): DeskDraft {
  const json = extractJson(reply);
  if (!json) return empty(["couldn't read a draft from the model — try rephrasing"]);
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(json) as Record<string, unknown>; } catch { return empty(["the model's draft wasn't valid JSON — try again"]); }

  const warnings: string[] = [];
  const epics: DraftEpic[] = asArray(raw.epics)
    .map((e) => ({ title: str(obj(e).title) }))
    .filter((e) => e.title.length > 0);

  const tickets: DraftTicket[] = asArray(raw.tickets)
    .map((entry) => {
      const t = obj(entry);
      const title = str(t.title);
      const who = str(t.assignee);
      let assignee = who, assigneeLinearId: string | null = null, resolved = false;
      if (who) {
        const m = resolveAssignee(roster, who);
        if (m) { assignee = firstName(m); assigneeLinearId = m.linearIds[0] ?? null; resolved = true; }
        else warnings.push(`couldn't match "${who}" to a teammate — pick someone before creating`);
      }
      return { title, assignee, assigneeLinearId, resolved, priority: priorityNumber(t.priority), epic: strOrNull(t.epic) };
    })
    .filter((t) => t.title.length > 0);

  const questions = asArray(raw.questions).map(str).filter((q) => q.length > 0);
  if (epics.length === 0 && tickets.length === 0) warnings.push("the draft had no tickets — try being more specific");
  return { epics, tickets, questions, warnings };
}

function empty(warnings: string[]): DeskDraft { return { epics: [], tickets: [], questions: [], warnings }; }
