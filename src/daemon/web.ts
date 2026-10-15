/**
 * Web console (PRD §11) — a localhost HTTP server that serves the browser version of the lead console: the
 * exact docs/borderless-console.html design (shipped as web/console.html) wired to live daemon data via a
 * JSON feed, plus an advisory ASK endpoint. It is mostly a READ mirror; the code-driving buttons that DO act —
 * VERIFY "Run checks" and SWEEP "In Review" — run server-side in the daemon (deduped via singleFlight so a
 * double-click can't fan out a second agent fleet), while rescue + merge stay terminal-driven (`ao rescue`,
 * `gh pr merge`). Bound to 127.0.0.1 only. The payload builder is a pure store read (tested); the HTTP wiring
 * is thin + live.
 */

import { consolePayload, sweepRow } from "../shared/console-rows.ts";
import { parseResolveTurns, type ResolveTurn } from "../shared/resolve-chat.ts";
import type { ApproveResult, RedriveResult } from "./resolve-drive.ts";
import type { InReviewSweepResult, FixSweepResult } from "../shared/types.ts";
import { parseDraftAnswers, type DeskDraftResponse, type DraftAnswer } from "../shared/desk-draft.ts";
import { parseCreateRequest, type DeskCreateRequest, type DeskCreateResult } from "../shared/desk-create.ts";
import type { VerifyScanResult } from "../shared/verify.ts";
import type { VerifyRunResult } from "../shared/verify-verdict.ts";
import type { VerifyQaSyncResult } from "../shared/verify-qa-sync.ts";
import type { VerifyQaFixResult } from "../shared/verify-qa-fix.ts";
import type { Store } from "./store.ts";

export interface WebServerDeps {
  store: Store;
  leadOpsProject?: string;
  /** The current lead's identifier (config.branchOwner — a netid or github login) — the desk's co-lead load
   *  excludes this person (matched against each member's github OR netid). */
  leadIdent?: string;
  /** Topbar project label (the semester/workspace), from config — not baked into the pure payload. */
  projectLabel: string;
  /** Advisory Ask Borderless over the chosen backend (the browser never gets the action tools). */
  askRun: (question: string, allowActions: boolean) => Promise<{ answer: string; configured: boolean }>;
  /** The GitHub repo slug (owner/repo), for building PR links in the sweep detail panel. */
  repo?: string;
  /** Per-job resolve chat (the SWEEPS detail panel): advisory, scoped to the clicked job; the client replays
   *  prior turns via `history` because the chat backend is stateless. */
  resolveChatRun: (jobId: string, question: string, history: ResolveTurn[]) => Promise<{ answer: string; configured: boolean }>;
  /** Lead decision on a stopped job (SWEEPS detail panel): APPROVE → move the needs_human job to ready (lead
   *  override). Synchronous store update; `ready` is surfaced for the lead to merge, not merged here. */
  approveJob: (jobId: string) => ApproveResult;
  /** Lead decision on a stopped job: RE-DRIVE with guidance → re-open the needs_human job to queued with the
   *  lead's instruction + kick the engine (the next worker's seed carries it). */
  redrive: (jobId: string, guidance: string) => RedriveResult;
  /** Pull the live Linear board into the store (no sweeps) — the Refresh button. */
  syncBoard: () => Promise<{ synced: number; configured: boolean }>;
  /** PRD §13: classify the Verifying tickets from their merged PRs. A live gh scan — on-demand, never polled. */
  verifyScan: () => Promise<VerifyScanResult>;
  /** PRD §13 V2b: run the structural checks over the read-only DB role → a verdict per Verifying ticket. */
  verifyRun: () => Promise<VerifyRunResult>;
  /** PRD §13: the screen-testable counterpart — carry Cue QA tester verdicts (Supabase) back to their Linear
   *  manual-qa sub-issues: a comment per verdict + move to Done on a pass. The browser button always writes
   *  (there is no dry mode from the UI). Idempotent on the per-verdict ref marker (a re-click after the run is a
   *  no-op), and concurrent triggers — a second tab, or the Sync button racing `ao verify qa-sync --write` — are
   *  deduped onto one run upstream (singleFlight), so neither path double-posts. */
  runQaSync: () => Promise<VerifyQaSyncResult>;
  /** PRD §13: the QA-fix sweep — turn FINISHED Cue QA verdicts (FAIL/BLOCKED) into follow-up tickets under the
   *  feature ticket. The browser button always writes; idempotent (the marker lives in each created ticket's body)
   *  and deduped onto one run upstream (singleFlight). */
  runQaFix: () => Promise<VerifyQaFixResult>;
  /** PRD §4/§11: run the In-Review sweep from the browser SWEEP button — sync + re-review + enqueue + kick the
   *  engine; the fixer/reviewer agents run server-side in the daemon. Deduped (singleFlight) upstream. */
  runInReviewSweep: () => Promise<InReviewSweepResult>;
  /** PRD §13: run the qa-fix sweep from the browser FIX SWEEP button — sync + enqueue + kick build-from-scratch
   *  jobs for qa-fix Todo tickets; agents run server-side. Deduped (singleFlight) upstream. */
  runFixSweep: () => Promise<FixSweepResult>;
  /** PRD §9 (Lead Desk v2): the lead's words (+ any MCQ answers from a re-draft) → the LLM's structured draft
   *  of epics + tickets + clarifying questions. Writes nothing. */
  deskDraft: (text: string, answers: DraftAnswer[]) => Promise<DeskDraftResponse>;
  /** PRD §9 (Lead Desk v2): the lead's reviewed draft → real Linear issues (assign, label, DM). Deduped upstream. */
  deskCreate: (req: DeskCreateRequest) => Promise<DeskCreateResult>;
  port: number;
}

export interface WebServer { url: string; port: number; stop(): void }

/** Start the localhost web console: the page + GET /api/console (live snapshot) + POST /api/ask (advisory). */
export function startWebServer(deps: WebServerDeps): WebServer {
  const pagePath = new URL("./web/console.html", import.meta.url);
  const server = Bun.serve({
    port: deps.port,
    hostname: "127.0.0.1", // localhost only — never exposed off the machine
    // A verify run spawns an agent and blocks the request for minutes; Bun's default 10s idle timeout would kill
    // it mid-run (the browser hangs on "running…" though the run finishes server-side). 255 is Bun's max — it
    // covers the realistic single/few-agent run; a worst-case slow agent still exceeds it, so `ao verify run`
    // (no HTTP timeout) stays the path for very long runs.
    idleTimeout: 255,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/" || pathname === "/index.html") {
        return new Response(Bun.file(pagePath), { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (pathname === "/api/console") {
        const data = consolePayload(deps.store.listLinearIssues(), deps.store.listSweepJobs(), deps.leadOpsProject, deps.leadIdent);
        return Response.json({ ...data, project: deps.projectLabel });
      }
      if (pathname === "/api/sync" && req.method === "POST") {
        return Response.json(await deps.syncBoard()); // sync-only: pull Linear → store, no sweeps
      }
      if (pathname === "/api/verify" && req.method === "POST") {
        return Response.json(await deps.verifyScan()); // on-demand live gh scan — never polled (the VERIFY tab's button)
      }
      if (pathname === "/api/verify/run" && req.method === "POST") {
        return Response.json(await deps.verifyRun()); // executes the catalog checks over the read-only role
      }
      if (pathname === "/api/verify/qa-sync" && req.method === "POST") {
        return Response.json(await deps.runQaSync()); // push Cue QA verdicts → Linear (comment + Done on a pass); idempotent
      }
      if (pathname === "/api/verify/qa-fix" && req.method === "POST") {
        return Response.json(await deps.runQaFix()); // open fix/blocked tickets from failed/blocked QA verdicts; idempotent
      }
      if (pathname === "/api/sweep" && req.method === "POST") {
        return Response.json(await deps.runInReviewSweep()); // enqueue + drive the In-Review sweep (agents run server-side)
      }
      if (pathname === "/api/sweep/fix" && req.method === "POST") {
        return Response.json(await deps.runFixSweep()); // enqueue + drive qa-fix build-from-scratch jobs (agents run server-side)
      }
      if (pathname === "/api/desk/draft" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { text?: unknown; answers?: unknown };
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (!text) return Response.json({ epics: [], tickets: [], questions: [], warnings: [], configured: true, assignable: [] });
        return Response.json(await deps.deskDraft(text, parseDraftAnswers(body.answers))); // LLM drafts epics + tickets (+ MCQ answers on a re-draft); writes nothing
      }
      if (pathname === "/api/desk/create" && req.method === "POST") {
        const parsed = parseCreateRequest(await req.json().catch(() => null)); // coerce every field (untrusted body)
        if (!parsed) return Response.json({ created: [], errors: ["bad request"], configured: true });
        return Response.json(await deps.deskCreate(parsed));
      }
      if (pathname === "/api/ask" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { question?: unknown };
        const question = typeof body.question === "string" ? body.question.trim() : "";
        if (!question) return Response.json({ answer: "", configured: true });
        const r = await deps.askRun(question, false); // advisory only — no action tools from the browser
        return Response.json({ answer: r.answer, configured: r.configured });
      }
      if (pathname === "/api/sweep/job") {
        const id = new URL(req.url).searchParams.get("id") ?? ""; // the detail panel for one clicked job
        const job = id ? deps.store.getSweepJob(id) : null;
        if (!job) return Response.json({ job: null, events: [], prUrl: null });
        const prUrl = deps.repo && job.prNumber != null ? `https://github.com/${deps.repo}/pull/${job.prNumber}` : null;
        return Response.json({ job: sweepRow(job), events: deps.store.listSweepEvents(job.id), prUrl });
      }
      if (pathname === "/api/resolve-chat" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { id?: unknown; question?: unknown; history?: unknown };
        const id = typeof body.id === "string" ? body.id.trim() : ""; // the exact clicked job
        const question = typeof body.question === "string" ? body.question.trim() : "";
        if (!id || !question) return Response.json({ answer: "", configured: true });
        return Response.json(await deps.resolveChatRun(id, question, parseResolveTurns(body.history)));
      }
      if (pathname === "/api/sweep/approve" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { id?: unknown };
        const id = typeof body.id === "string" ? body.id.trim() : "";
        if (!id) return Response.json({ ok: false, error: "no job id" });
        return Response.json(deps.approveJob(id)); // needs_human → ready (lead override)
      }
      if (pathname === "/api/sweep/redrive" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { id?: unknown; guidance?: unknown };
        const id = typeof body.id === "string" ? body.id.trim() : "";
        const guidance = typeof body.guidance === "string" ? body.guidance.trim() : "";
        if (!id) return Response.json({ ok: false, error: "no job id" });
        return Response.json(deps.redrive(id, guidance)); // needs_human → queued, re-driven with the lead's guidance
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${deps.port}`, port: deps.port, stop: () => server.stop(true) };
}
