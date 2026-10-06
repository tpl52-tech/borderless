# Borderless — Lead Console (PRD)

Product Requirements · Borderless · Draft v0.5 · `tpl52-tech/agent-orchestrator` · 2026-10-06

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
auto-implementing `lead-level` tickets; attendance tracking.

## §3 System context
Long-lived **daemon** (Bun, zero runtime deps) owns state + spawns agents; the **Ink dashboard
(`ao`)** attaches over a Unix-domain socket. Agents run in **Bun PTYs**; cheap calls on an
embedded **OpenRouter** runtime; store = **SQLite (bun:sqlite)**. Integrations: **Linear**
(tickets), **GitHub** (code/PRs), **Slack** (notify). Identity map: `src/shared/roster.ts`.

## §4 Feature — In-review sweep
"Sweep in review" action in the `ao` main menu, over the currently-selected tickets. For each,
spawn one agent that drives the ticket's PR through the pipeline.

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
progress** (no branch, no commits, no non-draft PR); assignee is a roster member.

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
2. **Slack — weekly digest.** Changes roll into a **per-person weekly digest** (not a per-merge
   ping), so it reads as coaching. Fallback: no resolvable email → digest omits them.
3. **QA handoff.** Move to **Verifying** and surface it. **QA assignment is Neha's** — the console
   does not auto-assign or rotate.

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
**Build:** `buildFleetContext` → OpenRouter chat loop → the tools → an Ink pane over the socket.
**UI:** a **plain code-chat** (message stream + input), NOT the terminal panels.

## §11 Human-in-the-loop
| Responsibility | Owner | Console's role |
|---|---|---|
| Assign new tickets | Tess | suggests; lead approves |
| SoftDev↔QA moves + lateness | Neha | surfaces data; Neha decides |
| Attendance | Kenan | manual |
| Merge + risk judgment | Tess | always human |

## §12 Decisions (settled 2026-10-06)
- **Concurrency → no cap.** Rebase + re-gate before merge (§4) + sequential merges handle
  correctness; the flat-rate plan runs concurrent sessions. The plan's rate limit is the only
  ambient ceiling and self-regulates.
- **Rescue → your authorization, no grace** (§5). Eligible rescues wait in the Rescues queue.
- **QA → Neha owns it** (§6). Console moves to Verifying + surfaces; no auto-assign.
- **Slack → weekly digest** (§6).
- **Coaching ledger → not in v1.**
- **Budget → nothing to cap; the 8-cycle cap is the only configured limit.** Flat-rate sub +
  concurrent sessions ⇒ every call (implement, fix, the independent review as a separate fresh
  session) runs at $0. Even triage + the digest can be subscription sessions. The plan's rate
  limit is the only ambient ceiling and self-regulates — not a knob.
