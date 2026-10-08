/**
 * Web console (PRD §11) — a localhost HTTP server that serves the browser version of the lead console: the
 * exact docs/borderless-console.html design (shipped as web/console.html) wired to live daemon data via a
 * JSON feed, plus an advisory ASK endpoint. It is a READ mirror — consequential actions (sweep, rescue,
 * merge) stay terminal-driven (`ao sweep`, …). Bound to 127.0.0.1 only. The payload builder is a pure store
 * read (tested); the HTTP wiring is thin + live.
 */

import { consolePayload } from "../shared/console-rows.ts";
import type { VerifyScanResult } from "../shared/verify.ts";
import type { Store } from "./store.ts";

/** Read one trimmed string field from a JSON POST body, tolerant of a missing/malformed body (→ ""). */
async function stringField(req: Request, key: string): Promise<string> {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  return typeof body[key] === "string" ? (body[key] as string).trim() : "";
}

export interface WebServerDeps {
  store: Store;
  leadOpsProject?: string;
  /** Topbar project label (the semester/workspace), from config — not baked into the pure payload. */
  projectLabel: string;
  /** Advisory Ask Borderless over the chosen backend (the browser never gets the action tools). */
  askRun: (question: string, allowActions: boolean) => Promise<{ answer: string; configured: boolean }>;
  /** Pull the live Linear board into the store (no sweeps) — the Refresh button. */
  syncBoard: () => Promise<{ synced: number; configured: boolean }>;
  /** PRD §13 V1: classify the Verifying tickets from their merged PRs. A live gh scan — on-demand, never polled. */
  verifyScan: () => Promise<VerifyScanResult>;
  /** PRD §13 V1: the human-QA tap-through for one Verifying ticket (subscription LLM). */
  verifyScript: (ticketKey: string) => Promise<{ ticketKey: string; script: string }>;
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
        const data = consolePayload(deps.store.listLinearIssues(), deps.store.listSweepJobs(), deps.leadOpsProject);
        return Response.json({ ...data, project: deps.projectLabel });
      }
      if (pathname === "/api/sync" && req.method === "POST") {
        return Response.json(await deps.syncBoard()); // sync-only: pull Linear → store, no sweeps
      }
      if (pathname === "/api/verify" && req.method === "POST") {
        return Response.json(await deps.verifyScan()); // on-demand live gh scan — never polled (the VERIFY tab's button)
      }
      if (pathname === "/api/verify/script" && req.method === "POST") {
        const ticketKey = await stringField(req, "ticketKey");
        if (!ticketKey) return Response.json({ ticketKey: "", script: "" });
        return Response.json(await deps.verifyScript(ticketKey));
      }
      if (pathname === "/api/ask" && req.method === "POST") {
        const question = await stringField(req, "question");
        if (!question) return Response.json({ answer: "", configured: true });
        const r = await deps.askRun(question, false); // advisory only — no action tools from the browser
        return Response.json({ answer: r.answer, configured: r.configured });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${deps.port}`, port: deps.port, stop: () => server.stop(true) };
}
