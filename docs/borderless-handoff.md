# Borderless — Lead Console: build handoff

Kickoff context for an agent building the lead-console layer. Read this, then
`docs/borderless-prd.md` (full spec) and `docs/borderless-console.html` (visual target).

## What this is
Borderless (`~/agent-orchestrator`, GitHub `tpl52-tech/agent-orchestrator`, CLI `ao`) is a
fleet supervisor for AI coding-agent CLIs. Daemon (Bun, zero runtime deps) + Ink dashboard
(`ao`) that attaches to agent sessions over a Unix-domain socket; agents run in Bun PTYs;
SQLite (bun:sqlite) is the single store; an embedded OpenRouter runtime does cheap calls.
You are building the **lead-console** layer on top of this existing base.

## Already built — on `main`, do NOT redo
- `src/shared/roster.ts` — Linear↔GitHub↔Slack identity map; `memberByLinearId`,
  `memberByGithub`, `slackLookupEmails`, `buildRosterIndexes` (throws on dup). In the `index.ts` barrel.
- `src/daemon/store.ts` — migration **step 1** = `sweep_job` + `sweep_event` (partial unique
  indexes for idempotency) + `Store` methods `createSweepJob/getSweepJob/listSweepJobs/
  transitionSweepJob/recordSweepEvent/listSweepEvents`. Types in `src/shared/types.ts`.
- `enqueueInReviewSweeps("In Review")` + `upsertLinearIssue` + `listLinearIssues` — first slice:
  `linear_issues` → `sweep_job`, idempotent.
- Tests: `test/{roster,sweep-store,enqueue-sweeps}.test.ts`.

## Repo conventions — follow exactly
- Store = single source of truth, one writer per file. Evolve schema by APPENDING to the
  `MIGRATIONS` array in `store.ts` — NEVER edit a shipped step. New state = `Store` methods +
  module-level `rowToX` mappers; snake_case cols / camelCase fields; JSON cols via JSON.stringify/parse;
  ids via `crypto.randomUUID()`; epoch-ms times.
- Domain types in `src/shared/types.ts`, re-exported via the barrel. Identity is never defaulted
  (read from `src/shared/config.ts`).
- `bun:test` in `test/*.test.ts`; keep `bun run typecheck` clean and `bun test` green every PR.
- Workflow: branch → PR → merge (merge commit).

## Settled decisions (constraints — see the PRD §12)
- GATE for ready-to-merge: no-regression diff (vs author's original) + CI green (`ci`+`secrets-scan`)
  + ZERO 🔴 from an INDEPENDENT reviewer = a separate fresh agent session, not the fixer. Grade is a summary, not the gate.
- 8-cycle cap is the ONLY configured limit. Flat-rate sub + concurrent sessions → no budget/concurrency caps.
  Fixer AND reviewer both run on the subscription.
- Two sweeps: in-review (drive a PR) + rescue (build overdue+no-progress ticket from scratch).
  Rescue needs PER-TICKET lead authorization (Rescues queue; never auto-starts; no grace).
  Rescue is attributed to the LEAD (not a bot / the late assignee).
- Merge is always the human's. Before each merge: rebase onto `main` + re-run the gate (makes concurrency safe).
- needs_human: escalate ONLY if necessary (no clearly-better option) or dangerous (auth/money/schema/
  `.github`/irreversible); otherwise self-resolve. When it escalates it poses 2–3 options + a recommendation
  INSIDE ITS OWN SESSION — opening a needs-human job drops the lead into that agent's chat.
- Post-merge: change-summary Linear comment → WEEKLY Slack digest (not per-merge) → move to Verifying.
  QA assignment is Neha's (don't auto-assign). Lead-desk delegation writes to a separate "Lead Ops" Linear project.

## Build order (ship + get reviewed each slice)
1. `session_id` on `sweep_job` (migration step 2) — link job → agent session so the TUI can attach.
2. Trigger `enqueueInReviewSweeps()` from an `ao` command; add a Linear→SQLite sync to fill `linear_issues`.
3. Sweep engine: spawn fixer (PTY) → gate (CI poll + no-regression diff + fresh reviewer session) → ≤8 cycles → ready|needs_human. Reuse existing session/spawn machinery.
4. Rescue sweep: scan overdue+no-progress → Rescues queue → on AUTHORIZE, spawn implementer → same gate.
5. Post-merge: comment + Verifying move + accumulate the weekly Slack digest.
6. Boards + Assign + Lead-desk panels (reuse linear_issues + roster + critical-path ranking).
7. Ask Borderless: `buildFleetContext(store)` → OpenRouter chat loop → fleet tools
   (reassignTicket, enqueueSweep, resolveNeedsHuman, postLinearComment; lead-confirmed).
8. Ink TUI: SWEEPS/BOARDS/ASSIGN/LEAD_DESK/ROSTER/ASK screens; row-click attaches to the job's session.

The hardest, highest-value parts are #3 (the agentic loop + the independent-reviewer gate) and the live
session attach — build and test those most carefully; they're what protect `main`.
