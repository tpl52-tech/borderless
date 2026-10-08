# Borderless — Lead Console (PRD)

Product Requirements · Borderless · Draft v0.7 · `tpl52-tech/borderless` · 2026-10-08

Two autonomous sweeps, live project boards, assisted assignment, a lead desk, and a
context-loaded chat — the supervisory layer of the `ao` orchestrator.

> Visual target: `docs/borderless-console.html` (the TUI mockup — terminal style, pink+green).

## §1 Summary
`ao` is a fleet supervisor for AI coding-agent CLIs. This is its **lead-facing supervision
layer**: two sweeps that drive tickets to a mergeable state (one for in-review PRs, one that
rescues overdue work), always-on boards, assignment suggestions, a lead desk, and a chat.

Principle: **automate the lead's throughput, never the lead's judgment.** The lead stays the
quality gate, the merge authority, and the decision-maker on anything risky.

## §2 Goals & non-goals
**Goals:** drive in-review PRs to mergeable without babysitting; rescue overdue/unstarted
tickets so one late person doesn't block the project; keep the human as the merge + risk gate;
show what to attack next and who to assign; let the lead ask about anything (live context +
actions) in one place; let the lead delegate ad-hoc lead/ops work.
**Non-goals (v1):** auto-merge (a human always merges); replacing lead judgment on risky work;
auto-**implementing** `lead-level` tickets (the **rescue** sweep skips them — but the in-review
sweep still **drives** a lead's existing PR like any other, §4/§5); attendance tracking.

## §3 System context
Long-lived **daemon** (Bun, zero runtime deps) owns state + spawns agents; the **Ink dashboard
(`ao`)** attaches over a Unix-domain socket. Agents run in **Bun PTYs**; cheap calls on an
embedded **OpenRouter** runtime; store = **SQLite (bun:sqlite)**. Integrations: **Linear**
(tickets), **GitHub** (code/PRs), **Slack** (notify). Identity map: `src/shared/roster.ts`.

## §4 Feature — In-review sweep
"Sweep in review" action in the `ao` main menu, over the currently-selected tickets. For each,
spawn one agent that drives the ticket's PR through the pipeline. **Every in-review ticket is
driven regardless of label or owner — a `lead-level` PR included** (that label gates only the
rescue sweep, §5). Only **Lead Ops** project tickets (§9) are excluded — those are human to-dos.

**Pipeline:** `queued → fix → review → ci → {ready-to-merge | needs-human}`. `fix` and `review`
run as **separate agents** (see gate).

**The gate — what "passed" means.** A PR reaches `ready-to-merge` only when ALL hold:
1. **No regression** — a behavior-preservation diff proves the final code does what the author's
   original did. The proof, not a promise. (This is what actually protects `main`.)
2. **CI green** — `ci` and `secrets-scan` both pass.
3. **Zero 🔴 blocking findings** from an **independent review agent** — a fresh session with no
   stake in the fix. The fixer never grades its own work.
The thermo grade is a **summary, not the gate** (self-grading inflates).

**Giving up — the 8-cycle cap.** The `fix → review` loop runs at most **8 cycles**. If the gate
isn't clear after the eighth, the agent stops → `needs-human` with the reason.

**Escalation — only when it has to.** A job escalates to `needs-human` sparingly. The agent
**resolves the call itself whenever one option is clearly better** (no rubber-stamp asks). It
stops for you only when:
- **Necessary** — a genuine judgment call with no clearly-better option, or missing context only
  the lead has (after the 8-cycle cap, that's the usual reason).
- **Dangerous** — a risky tier (auth, money, schema/RLS, `.github`) or anything irreversible.
- **Collision** — the PR touches a file or component another open, **assigned** ticket already
  owns (its deliverable), so shipping would duplicate a teammate's in-flight work. Derived from
  the synced board; the sweep stops for you to coordinate rather than auto-readying over their
  ticket, and the worker is warned off those off-limits deliverables up front in its seed.
When it stops, it asks as **multiple choice**: 2–3 concrete courses of action with its own
recommendation flagged, **inside its own session** — opening a `needs-human` job drops the lead
into the chat with the agent that did the work, and they decide (or talk it through) there.

**Merge is the human's.** The sweep never merges. **Before each merge the branch is rebased onto
current `main` and the gate re-run on that rebased state**, so a stale/conflicting PR can't slip
through — which is also why running many sweep agents at once is fine (correctness is settled at
merge, not at spawn; agent count needs no cap). Risky tiers always get explicit human review.

## §5 Feature — Late-ticket rescue sweep
Where §4 drives an existing PR, this **implements overdue tickets nobody started**, then runs
them through the same machinery. Triggered by a "Scan overdue" action (or a schedule).

**Eligible when ALL hold:** due date passed; **not** labeled `lead-level`; **no meaningful
progress** (no branch, no commits, no non-draft PR); assignee is a roster member. The `lead-level`
label gates the rescue sweep **only** — §4's in-review sweep drives a lead's existing PR like any
other; this is the sole place the label excludes a ticket from automation.

**Pipeline:** `queued → implement → review → ci → {ready-to-merge | needs-human}` — same shape as
§4, but the first step is `implement` (build from acceptance criteria), not `fix`.

**States:** `queued, implementing, reviewing, ci, ready, needs_human, merged, failed`.

**The gate (greenfield).** No prior behavior to preserve, so the no-regression diff is replaced
by **acceptance-criteria satisfied** (each AC item mapped to evidence) + **new tests + CI green**
+ **zero 🔴 from the independent reviewer**. Same 8-cycle cap; human still merges.

**Authorization — gated on your go-ahead.** A rescue **never starts on its own**: an eligible
ticket lands in a **Rescues** queue on the main screen and waits for your **per-ticket
authorization**. No grace window beyond eligibility; no fully-autonomous mode.

**Attribution.** The implementer is listed as the **lead (you)** — you run the sweep and own the
result — **not a faceless bot, and not the late assignee** (who is kept for context). A ticket
comment records "auto-implemented via the rescue sweep, N days overdue." Slack notice via the
roster; QA handoff moves it to Verifying — never back to the assignee.

**The SQLite shape** (one `sweep_job` table serves both sweeps; already built as migration step 1):
```sql
CREATE TABLE sweep_job (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL,          -- 'in_review' | 'rescue'
  ticket_id TEXT NOT NULL, ticket_key TEXT NOT NULL,
  assignee TEXT, pr_number INTEGER, head_sha TEXT,
  state TEXT NOT NULL DEFAULT 'queued', cycles INTEGER NOT NULL DEFAULT 0,
  gate TEXT, reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX uq_sweep_review ON sweep_job(ticket_id, head_sha) WHERE kind='in_review';
CREATE UNIQUE INDEX uq_sweep_rescue_active ON sweep_job(ticket_id)
  WHERE kind='rescue' AND state NOT IN ('merged','failed');
CREATE TABLE sweep_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES sweep_job(id) ON DELETE CASCADE,
  at INTEGER NOT NULL, event TEXT NOT NULL, detail TEXT
);
```

## §6 Post-merge automation (either sweep, in order)
1. **Change-summary comment** — if the sweep changed the PR (vs the author's original, or built
   from scratch), post a Linear comment summarizing what/why, categorized (`bug`/`missing-test`/
   `style`/`architecture`), so the author learns.
2. **QA handoff.** Move to **Verifying** and surface it. **QA assignment is Neha's** — the console
   does not auto-assign or rotate.

*(The per-person weekly **Slack digest** — an earlier §6 item — was **cut** (2026-10-07, §12). The
only Slack integration that ships is the lead-desk delegation DM, §9.)*

## §7 Feature — Live boards
- **7a Unblocked + phase** — every currently-unblocked ticket with its project phase.
- **7b Do next (critical path)** — unblocked tickets ranked by **how much downstream work each
  unblocks**, so the board answers "what to attack this session," not just "what's attackable."

## §8 Feature — Assignment suggestions
Suggests an assignee per unblocked ticket (load + past fit + critical path). The lead approves
with a keystroke. **Never auto-assigns.**

## §9 Feature — Lead desk (ad-hoc delegation)
Capture in the console, but it **materializes as a Linear issue in a dedicated "Lead Ops"
project** assigned to the chosen lead **and Slack-DMs them** (via `shared/roster.ts`). **The
sweeps exclude Lead Ops.** No gates, no agents — a human task tracker with capture + overview.

## §10 Feature — Console chat (Ask Borderless)
Not a wrapper — it runs on the orchestrator's runtime with live fleet state + tools:
1. **Live fleet state as context** — `buildFleetContext(store)` reads the store (`sweep_job`,
   `sweep_event`, `linear_issues`, roster) + loads the PRD + ARCHITECTURE.md, injected every message.
2. **Acts on the fleet** — tools: `reassignTicket`, `enqueueSweep`, `resolveNeedsHuman`,
   `postLinearComment` — each wrapping a daemon/Store method; consequential actions lead-confirmed.
3. **Backends** — default to the lead's **Claude subscription** via the local `claude` CLI (`$0`,
   answer-only → **advisory**). The **OpenRouter** backend is opt-in (API key) and is the only
   backend that can run the action tools in (2). Consequential actions are lead-confirmed regardless.
**Build:** `buildFleetContext` → a chat loop over the chosen backend → the tools → an Ink pane over the socket.
**UI:** a **plain code-chat** (message stream + input), NOT the terminal panels.

## §11 Human-in-the-loop
| Responsibility | Owner | Console's role |
|---|---|---|
| Assign new tickets | Tess | suggests; lead approves |
| SoftDev↔QA moves + lateness | Neha | surfaces data; Neha decides |
| Attendance | Kenan | manual |
| Merge + risk judgment | Tess | always human |

## §12 Decisions (settled 2026-10-06; updated 2026-10-07)
- **Concurrency → no cap.** Rebase + re-gate before merge (§4) + sequential merges handle
  correctness; the flat-rate plan runs concurrent sessions. The plan's rate limit is the only
  ambient ceiling and self-regulates.
- **Rescue → your authorization, no grace** (§5). Eligible rescues wait in the Rescues queue.
- **QA → Neha owns it** (§6). Console moves to Verifying + surfaces; no auto-assign.
- **Slack → weekly digest CUT** (2026-10-07): not built; the lead-desk delegation DM (§9) is the
  only Slack integration.
- **`lead-level` gates rescue only** (2026-10-07): the in-review sweep drives a lead's PR like any
  other; `lead-level` keeps a ticket out of the **rescue** sweep only — reversing an earlier
  over-broad in-review exclusion (§2/§4/§5).
- **Collision guard** (2026-10-07): a sweep never auto-ships a deliverable another assigned,
  in-progress ticket owns — it escalates to `needs-human`, and the worker is warned off those
  deliverables up front (§4).
- **Ask Borderless → subscription by default** (2026-10-07): the Claude-subscription backend
  (answer-only, `$0`) is the default; OpenRouter is opt-in and the only backend that runs the
  fleet action tools (§10).
- **Coaching ledger → not in v1.**
- **Budget → nothing to cap; the 8-cycle cap is the only configured limit.** Flat-rate sub +
  concurrent sessions ⇒ every call (implement, fix, the independent review as a separate fresh
  session) runs at $0. Even triage and Ask Borderless (§10) run as subscription sessions. The plan's rate
  limit is the only ambient ceiling and self-regulates — not a knob.

## §13 Feature — Verify sweep (post-merge QA automation) · added v0.7 2026-10-08 · revised 2026-10-08 (backend-only: no human-QA scripts)
The third sweep (alongside §4 in-review and §5 rescue). Where §6 moves a merged ticket to **Verifying**
and hands it to human QA, this sweep covers **what human QA cannot verify from the app UI** — the blind
spot where a feature's screen looks right but the logic underneath is quietly broken.

**The line — "can you confirm it by looking at the screen?"** If yes, it stays with human QA: e.g. the
Favorites ticket (tap a heart → it turns red → appears in the Favorites tab → survives an app reload) is
fully screen-observable, reload included. The verify sweep targets the acceptance criteria that are
**invisible on screen**:
- **RLS isolation** — can user A read user B's rows? (sign-in-as-two-users / role probes)
- **Triggers / side-effects** — a notification row inserted on approve/sold; the screen may show nothing.
- **Migrations / schema** — columns, constraints, indexes. Not on screen at all.
- **Worker server-logic** — JWT verify, *server-side* pricing, webhook signature verification.
- **Data integrity** — first-sign-in upsert doesn't duplicate; idempotency; photo actually lands in Storage.

**Per Verifying ticket, it auto-verifies the invisible half (complements QA, never replaces it).** The
invisible acceptance criteria are checked against the backend **with evidence** → the §4 gate shape
(acceptance-criteria-satisfied + evidence, confirmed by a fresh independent reviewer) → `verified | needs_human`.
The screen-observable half stays **entirely** with human QA (Neha): the sweep writes **nothing** for human
testers — no tap-through scripts, no checklists — it only reports which invisible properties it checked and the
result. (The classifier still labels the visible/invisible split so the lead sees what the sweep does and
doesn't cover; it just never generates tester-facing prose.)

**Classifier** (pure): from a ticket's ACs + its merged PR's changed paths, label each aspect `ui` vs
`backend` and the ticket `ui | backend | mixed`. Signals: paths (`supabase/migrations`, policies,
`functions/` Workers, `lib/api`) + AC keywords (RLS/policy/trigger/deny/server-side/webhook/signature/JWT/
idempotent/duplicate/migration/schema/Storage → invisible; tap/screen/tab/shows/grid/renders → visible).

**Verification target is config (`verifyTarget`) — prod now, staging later.** There is no staging env yet
(it's under development), so the invisible checks run against **prod** under a strict safety protocol:
read-only first (RLS reads, schema inspection, idempotent GETs); any write uses a throwaway test user with
cleanup/rollback; anything destructive or ambiguous **escalates to Neha**, never guesses. The day staging is
ready, `verifyTarget` flips to the staging endpoints and the write checks run freely — **no code change**.

**Phases (each a gated grade-A PR, pure/tested brain first):**
- **V1 (done)** — the pure classifier + `ao verify` + a Verifying console tab (the classified queue). **No
  credentials, no backend access.** The lead sees which merged tickets carry properties no one can check by hand.
- **V2** — the auto-verifier. The pure **check planner** (each invisible property → a concrete check: mechanism
  + safety tier + resource targets; done) then the live runners over the provisioned access: the app's **public
  anon key + throwaway user sessions** (RLS isolation, data-integrity, Storage, Worker-JWT) **plus a read-only
  (SELECT-only) Postgres role** (schema / attached triggers). Each check emits a pass/fail + evidence;
  `server-logic` and anything ambiguous escalate to a human. **Never `service_role`.**
- **V3** — full write/trigger thoroughness (observe a trigger actually fire; exercise Worker logic) once
  `verifyTarget` points at **staging**. Riskiest; heaviest gate (the reviewer confirms the evidence AND that
  nothing touched prod). Blocked on staging.
