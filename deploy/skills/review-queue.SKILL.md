---
name: review-queue
description: How to drive a PR through the review pipeline the supervisor watches.
---

# The review queue

agent-orchestrator drives every PR toward `merged`. It watches these surfaces; make each one green.

## The pipeline (in order)

1. **CI** — green. Ignored checks: the convergence-gate check (`<GREENLIGHT_CHECK_NAME>`), repo-scoped
   noise, and anything in `AO_CI_IGNORE`. A failure whose checks are ALL ignored is not a real failure.
2. **Self-review grade** — post a line of its own `THERMO GRADE: <A-F>` in a PR comment. This is the
   ONLY surface the supervisor reads a grade from. Run a graded self-review cycle until grade A, at
   most 3 cycles. Absence of a grade is a BLOCKER.
3. **Code-review bot** (`<CODEX_BOT_LOGIN>`) — request with a comment `@<codex> review`; approval =
   the bot says it "didn't find any major issues" AND its `Reviewed commit:` stamp matches the head.
4. **Code-quality review** (posts as `github-actions` with "code quality review" in the first line) —
   presence means findings; read them, fix, reply where a finding is wrong, resolve threads you fixed.
5. **Reviewer** (`<CTO_LOGIN>` / identities in `<CTO_LOGINS>`) — a review is requested; drive to
   APPROVED against the current head. If they leave follow-ups after approving, address them.
6. **Merge conflict** — MERGE the base branch, do NOT rebase (rebasing rewrites pushed commits and
   invalidates every review anchor).
7. **Unresolved threads** — address AND mark each fixed thread resolved.

## Do not

- Do not implement from a ticket id alone — read the ticket, check for blockers first.
- Do not merge; the operator merges (or the supervisor, on explicit confirm).

> Parametrize per org (design §22): `<GREENLIGHT_CHECK_NAME>`, `<CODEX_BOT_LOGIN>`, `<CTO_LOGIN>`,
> `<CTO_LOGINS>`, the code-quality-review heading, the `THERMO GRADE:` convention.
