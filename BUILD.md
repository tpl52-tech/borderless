# Build plan & roadmap

This scaffold follows the design description's own suggested build order. Each step layers on
the last; the daemon + SQLite + PTY foundation must exist before anything observes or acts.
Check items off as they land. Every stub file cites the design section (`§N`) it implements.

## Build order

- [x] **1. Foundation.** Daemon + SQLite + UDS binary framing + one local PTY + attach/detach +
      terminal reset. (Tasks/sessions, 256 KB replay buffer, double-Ctrl-B detach chord.) —
      `src/daemon/{index,store,pty,uds-server,session-manager}.ts`, `src/shared/{wire,paths}.ts`,
      `src/client/{index,attach,daemon-client}.tsx`. Covered by `bun test` (framing, store, PTY,
      end-to-end daemon↔client). The client dashboard is intentionally minimal here; the rich TUI
      (status glyphs, PR rows, focus view, full keymap) is step 2, and the per-CLI spawn spec /
      worktrees are step 3 — the session manager currently uses a placeholder argv.
- [x] **2. Status.** Seven-state status machine (hooks + idle timer + 60-min stuck ceiling), a local
      notify hook (`src/daemon/hook-notify.ts`) + events.log poll-watcher, and a dashboard with stable
      human-order rows, status glyphs, task rollup, and live `session.status` updates. —
      `src/daemon/monitors/status.ts`, `src/shared/status.ts`, `src/client/index.tsx`. Covered by
      `bun test` (machine transitions, hook watcher, presentation helpers, hook script, and a
      daemon-level working→exited broadcast). Deferred: the CONFIDENT stuck via transcript-growth (8-min
      no-progress) — wired but fed only once transcript reading lands (step 11). PR rows / usage / quota
      cells and the focus view come with steps 5+.
- [x] **3. Spawning.** The full spawn sequence (§7.1): profile resolution, per-CLI spawn spec
      (claude/codex/copilot, §7.2), ticket seed expansion (§7.3), worktree provisioning (§7.4),
      tolerant settings + a lite operator-config loader, and deferred claude seed delivery (§10.7). —
      `src/shared/{spawn-spec,settings,ticket,profile,config}.ts`, `src/daemon/{worktree,session-manager}.ts`.
      Covered by `bun test` (settings parse/diff, profile select/normalize/cwd, ticket extract/expand,
      per-CLI argv, real-git worktree provisioning/removal/conflict, and a worktree-through-the-daemon
      spawn). Deferred: devbox spawning (step 4), codex rollout discovery (step 11), the four-layer
      strict `resolveConfig` with identity validation + defaults.json merge (later).
- [x] **4. Remote agents.** The ssh+tmux spawn recipe, remote status hook + events.log tail, 60s
      liveness ticks, tmux capture-pane repaint on attach, Tailscale re-auth detection, and a
      subprocess-with-deadline runner. — `src/shared/remote.ts`, `src/daemon/{ssh,remote-box,session-manager}.ts`,
      `deploy/box/hook-notify.sh`. Covered by `bun test` (all command builders, Tailscale detection,
      liveness classification, the deadline/kill runner, the remote-hook spawn form, and a
      devbox-without-config guard). **The ssh/tmux integration is exercised end-to-end only against a
      real devbox** — the daemon wiring is in place and the command strings are unit-tested, but live
      validation is pending. Deferred: remote worktree provisioning, remote deferred-seed delivery (the
      ssh nudge hop, step 6), and the capture-pane paint-sequence refinements (§8.4).
- [x] **5. Work items.** Branch linking + polling cadence, per-PR GraphQL fetch, the full derived
      states (CI/greenlight/thermo/codex/CTO/review-bot/unresolved/ack), retirement, focus
      classification, PR rows in the dashboard, and the focus view. — `src/shared/focus.ts`,
      `src/daemon/{pr-derive,github,monitors/work-item}.ts`. Covered by `bun test` (focus rules,
      PR-state derivation over fixtures, retirement + PR-ref parsing, the work_items store, and the gh
      command builders). **GitHub I/O (`gh`) is exercised only against a real repo.** Deferred: the CTO
      cross-identity/audit disambiguation and review-bot "approved" (need the audit log, step 7),
      devbox branch-over-ssh, the batched aliased multi-branch query, the manual review actions
      (codex-review/cto-review/bump-cto/merge — builders exist), and the Linear monitor (§12.6).
- [x] **6. Nudges.** The framing rules (body then Enter as SEPARATE writes; LF normalization; codex
      bracketed-paste), the Claude-shaped pane guards + stranded-text recognition, the dispatch order,
      the bounded per-session queue, local idle-gated delivery end-to-end, planning cancellation, and a
      manual nudge composer. — `src/daemon/nudge/{framing,pane-guards,dispatch,queue,index}.ts`,
      `src/client/index.tsx`. Covered by `bun test` (framing, all guards + stranded detection, dispatch
      order, queue semantics, delivery via a real PTY, and the idle gate). Deferred: the devbox tmux
      transport over the awaited ssh hop (guards + dispatch are ready; the ssh send-keys I/O is a
      follow-up), verification/settlement-row promotion + boot redelivery (§5.2), and the autonomy
      settlement checklist (§13.8, step 7).
- [x] **7. Autonomy.** The pure policy engine (rule table §13.4), the actuator gate chain (§13.5, never
      throws), the audit-log store (dedupe/rate-limit/supersede §6), the acting window + file kill switch
      + 12h extension + dry-run (§13.7), env config (§13.6), and the control loop reading window/kill
      switch live — plus the activity log view + autonomy badge. — `src/daemon/autonomy/*`,
      `src/shared/autonomy-window.ts`. Covered by `bun test` (window, config, dedupe keys, the audit
      store, the rule table, every gate in order, and an end-to-end loop). Simplifications (documented):
      agent ACTIVITY comes from the status tracker (the §10.4 introspection probe — fidelity
      authoritative, endedWithQuestion — is a later gap, so rule 5 blocked-question stays dormant); the
      GitHub delivery of request-codex/cto is live-only; alerts (alert-human decisions) are recorded but
      dispatched in step 8.
- [x] **8. Alerts / accounting.** The alert dispatcher (opt-in AO_ALERTS=1; debounce/batch/attempts/
      mark-before-narrate, §15.1) recording deterministic alert-human decisions, the Slack narrator shell
      script, the usage ledger (pricing longest-prefix + cache multipliers; message-id-deduped transcript
      sampler; lifetime totals), and quota window classification. — `src/daemon/{alerts,monitors/usage,
      monitors/quota}.ts`, `src/shared/pricing.ts`, `deploy/alerts/narrate.sh`. Covered by `bun test`
      (pricing, usage parse + accumulate, the dispatcher loop incl. debounce/forgotten/failure/dry-run,
      quota classification). Live-only: the narrator (claude -p + Slack), the CLI quota probes, and the
      transcript sampler needs a real ~/.claude transcript. Deferred: subagent rollup, usage
      series/daily tables, devbox on-box aggregation.
- [x] **9. Federation.** The Mac<->box federation logic — the manifest with its **freshness inversion**
      + ownership (§17.3), the roster **join** (exact-prefix, activity precedence, never-idle, §17.2), the
      report **staleness** (§17.4), the box **tmux-nudge dispatch** (§10.5/§17), and the worktree
      **reaper classification** (§17.6) — all pure + tested. Wired (live-only): the Mac federation loop
      (manifest push / report pull), the worktree reaper executor, `ao monitor` deploy builders, and the
      box-side report.sh. — `src/daemon/box/{manifest,roster,report,tmux-nudge,federation}.ts`,
      `src/daemon/worktree.ts`, `src/cli/monitor.ts`, `deploy/{systemd,box}/*`. Deferred / live-only: the
      headless box daemon process itself (`box/index.ts`), the reaper's dirty/docker vetoes, and the deploy
      + systemd + credential-seeding ssh execution — all need a real devbox.
- [x] **10. OpenRouter runtime (optional).** The tool-calling agent loop (step ceiling, seedless-waits,
      serial tool dispatch, cache-stable system prompt), the built-in tools (read_file with the read-on
      footer / write_file / edit_file unique-match / bash with exit code), the compaction planner (keep-2-
      head + byte-budgeted tail snapped off tool-result boundaries), the kernel sandbox argv (seatbelt /
      bubblewrap per policy), and the MCP curation + verb-gating. — `src/daemon/openrouter/*`. Covered by
      `bun test` (tools against a temp dir, compaction plan, sandbox builders per platform, MCP curation,
      and the loop driven end-to-end by a fake model). Live-only: the chat-completions POST (provider
      pinning, non-streaming), the MCP stdio client, the kernel-sandbox exec, PTY rendering, approvals, and
      credential seeding.

**The full build order (design §23) is complete.** Every subsystem is implemented; what remains is
live validation against a real repo/devbox/Slack and the box daemon process shell — see the "not
validated here" notes above and in each PR.

## Live validation (run against real tools on macOS: bun, gh, git, claude 2.1.285)

Exercised the never-run external-I/O paths and fixed what broke:

- **GitHub (M5)** — `fetchPr` + `deriveStates` against real PRs: the GraphQL query, the aliased
  `statusCheckRollup` folding, and CI derivation all work (verified `MERGED`/head sha on this repo, and
  `ciState: failure` with the real failed check name on a CI-heavy public PR).
- **claude spawn (M1-M3)** — spawning a real claude agent through the daemon: PTY + per-CLI argv + the
  status machine + the **full hook pipeline** (claude `--settings` hooks → `hook-notify.ts` → events.log →
  tracker → `done`). Confirmed working→done with the agent's reply, and the same **in a real worktree**
  provisioned off `origin/main` and torn down cleanly.
- **work-item monitor (M5)** — `workitem.add` of a real PR through the daemon derives it fully.

Fixes found this way (both covered by tests):
1. **claude workspace-trust gate** stalled every spawn before the seed — claude 2.x keys trust by the
   cwd's realpath in `~/.claude.json`. Added `ensureClaudeTrust` to pre-accept it on claude spawns.
2. **tracked work items were never refreshed by number** — `pollSession` only fetched branch-linked PRs,
   so a manually-attached PR stayed `null`. Added design §12.2 step 5 (refresh every tracked PR by number).

Still needs a real devbox / Slack / OpenRouter to validate: the ssh+tmux spawn + box daemon + federation
(M4/M9), the Slack narrator (M8), the chat-completions POST + MCP stdio (M10).

## Design principles (copy these)

1. Split **identity** (no defaults, fail loudly) from **preferences** (always defaulted,
   tolerant) from **team facts** (tracked org file).
2. One writer per database; readers are one-shot read-only processes; federation is plain
   ssh, no long-lived RPC.
3. The agent CLI is a black box on the alternate screen: status from hooks + idle timing +
   transcript growth; history from the transcript, not the pane; attach repaints from tmux.
4. Never type into a busy pane, a menu, or over pending/stranded text; body and Enter are
   separate writes; promote to `performed` only after the Enter; never retype stranded text.
5. A transport negative (ssh 255, timeout, empty probe, failed capture) is "no answer", never
   "dead", "idle" or "clean".
6. Absence is never a pass for a gate (no grade, no greenlight, no approval = not yet) —
   except where the bot is *known* to be silent on clean (the review bot).
7. Reviews are bound to commit shas, not timestamps; the audit log is the source of truth for
   handovers; dedupe keys encode the event's identity, never the row.
8. First-match-wins policy needs explicit anti-starvation: handover stamps, attempted-backoffs,
   permanent-vs-transient gate separation, act-time freshness.
9. Every automated action has a bounded budget: per-hour SQL counts, cooldowns, hold limits,
   retry caps, extension caps, keep-awake caps.
10. Deploy ships code, never authority or credentials; enabling autonomy/alerts is a separate
    per-host decision; the kill switch is a file.
11. Log suppressions and "considered and declined" — "why didn't it act" is asked more than
    "what did it do".
12. Use the counterpart system's own clock for silence (GitHub `updated_at`), never your poll
    timestamp.

## Known gaps to decide deliberately (from the source system)

The reference implementation shipped with these; a rebuild should fix them rather than
reproduce them. Tracked here so they are decided on purpose.

- [ ] **Stalled rule unreachable.** It compares against `updatedAt`, which every successful
      poll rewrites. Key the stall on a transition-stamped "bad state entered at" clock instead.
- [ ] **Roster publisher lazy start.** Start it on the first devbox spawn, not only at boot —
      otherwise the first post-boot devbox session never publishes and the box refuses everything.
- [ ] **Introspection probe not deployed.** Ship `introspect.sh` with the deploy tree and make
      its absence loud (absent → silent fidelity `none` for every claude agent).
- [ ] **Worktree grace inconsistency.** Config default (7 days) vs the exported constant (0,
      CLI-only). Pick one source of truth.
- [ ] **CTO review delay nudge always armed** at 15 min; disabled only by not naming the action.
- [ ] **Three remote-home rules.** History hardcodes `/home/ubuntu`; spawn derives from the ssh
      user; hook deploy asks the box. Unify on one derivation.
- [ ] **thermo-regrade** is a nudge-transport action but is missing from the queue-full cap and
      the restart orphan sweep; a restart can strand its `queued` row forever.
- [ ] **Nudge freshness vs badStanding mismatch.** Freshness checks raw CI failure; badStanding
      requires a non-empty failed-check list. Align them.
- [ ] **Box-side dispatch proceeds on a failed pane capture; Mac-side holds.** Decide the
      intended asymmetry.

## Org-specific vocabulary to parametrize

Reviewer identity set + @-mention bump convention; the review-bot login + trigger phrase; the
`github-actions` "code quality review" heading and the `THERMO GRADE:` comment convention; the
"greenlight" convergence-gate check name + repo-scoped ignored checks; Linear team keys +
workspace; the three SKILL.md docs; the alert persona name. All live in config / `defaults.json`,
never hardcoded.
