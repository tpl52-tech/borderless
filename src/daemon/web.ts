/**
 * Web console (PRD §11) — a localhost HTTP server that serves the browser version of the lead console: the
 * exact docs/borderless-console.html design (shipped as web/console.html) wired to live daemon data via a
 * JSON feed, plus an advisory ASK endpoint. It is a READ mirror — consequential actions (sweep, rescue,
 * merge) stay terminal-driven (`ao sweep`, …). Bound to 127.0.0.1 only. The payload builder is a pure store
 * read (tested); the HTTP wiring is thin + live.
 */

import { doNext } from "../shared/boards.ts";
import { activeLoads, suggestAssignments } from "../shared/assign.ts";
import { deskOverview } from "../shared/lead-desk.ts";
import { ROSTER, memberByLinearId } from "../shared/roster.ts";
import type { Store } from "./store.ts";

/** The OWNER cell for a sweep job: the assignee's roster first name, else the raw id, else null. */
function sweepOwner(assignee: string | null): string | null {
  if (!assignee) return null;
  return memberByLinearId(assignee)?.name.split(" ")[0] ?? assignee;
}

/** The live snapshot the browser console renders — one JSON read spanning all six screens. Store reads only. */
export function consolePayload(store: Store, leadOpsProject?: string) {
  const issues = store.listLinearIssues();
  const loads = activeLoads(issues, ROSTER);
  const ranked = doNext(issues);
  return {
    sweeps: store.listSweepJobs().map((j) => ({
      ticketKey: j.ticketKey, kind: j.kind, state: j.state, owner: sweepOwner(j.assignee),
      prNumber: j.prNumber, cycles: j.cycles, reason: j.reason, sessionId: j.sessionId,
    })),
    boards: ranked.map((e) => ({ ticketKey: e.issue.identifier, title: e.issue.title, downstream: e.downstream })),
    assign: suggestAssignments(ranked, ROSTER, loads).map((s) => ({ ticketKey: s.ticketKey, netid: s.netid, name: s.name, load: s.load })),
    desk: deskOverview(issues, ROSTER, leadOpsProject),
    roster: ROSTER.map((m) => ({ name: m.name, netid: m.netid, github: m.github, lead: Boolean(m.lead) })),
    rosterLoad: ROSTER.map((m) => ({ name: m.name.split(" ")[0], netid: m.netid, lead: Boolean(m.lead), load: loads.get(m.netid) ?? 0 })),
    project: "ReUse · Fall 2026",
    now: Date.now(),
  };
}

export interface WebServerDeps {
  store: Store;
  leadOpsProject?: string;
  /** Advisory Ask Borderless over the chosen backend (the browser never gets the action tools). */
  askRun: (question: string, allowActions: boolean) => Promise<{ answer: string; configured: boolean }>;
  port: number;
}

export interface WebServer { url: string; port: number; stop(): void }

/** Start the localhost web console: the page + GET /api/console (live snapshot) + POST /api/ask (advisory). */
export function startWebServer(deps: WebServerDeps): WebServer {
  const pagePath = new URL("./web/console.html", import.meta.url);
  const server = Bun.serve({
    port: deps.port,
    hostname: "127.0.0.1", // localhost only — never exposed off the machine
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/" || pathname === "/index.html") {
        return new Response(Bun.file(pagePath), { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (pathname === "/api/console") {
        return Response.json(consolePayload(deps.store, deps.leadOpsProject));
      }
      if (pathname === "/api/ask" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { question?: unknown };
        const question = typeof body.question === "string" ? body.question.trim() : "";
        if (!question) return Response.json({ answer: "", configured: true });
        const r = await deps.askRun(question, false); // advisory only — no action tools from the browser
        return Response.json({ answer: r.answer, configured: r.configured });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${deps.port}`, port: deps.port, stop: () => server.stop(true) };
}
