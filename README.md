# Borderless

**The lead console for the `ao` fleet supervisor** — the supervisory layer that drives tickets
to a mergeable state so a lead can run a project without babysitting it.

> **Spec:** [`docs/borderless-prd.md`](./docs/borderless-prd.md) (PRD §1–§12) ·
> visual target [`docs/borderless-console.html`](./docs/borderless-console.html) ·
> build handoff [`docs/borderless-handoff.md`](./docs/borderless-handoff.md).

Borderless adds, on top of the orchestrator base below: two autonomous **sweeps** (drive an
in-review PR to mergeable; rescue overdue/unstarted tickets), live **boards**, **assignment**
suggestions, a **lead desk**, and a context-loaded **chat** ("Ask Borderless"). Its one
principle: **automate the lead's throughput, never the lead's judgment** — the human stays the
quality gate, the merge authority, and the decision-maker on anything risky.

This repo was **seeded from the `tpl52-tech/agent-orchestrator` reference** (the fleet
supervisor it builds on, kept as the reference implementation) and carries that base plus the
already-built lead-console foundation (team roster identity map, the `sweep_job`/`sweep_event`
store, and the in-review enqueue slice).

---

## The orchestrator base (what Borderless is built on)

**A fleet supervisor and autonomous PR-driver for coding agents, with a tmux-like TUI.**

Think "Kubernetes-style control loop, but the pods are LLM agents and the desired state is
`PR merged`." It is *not* a code factory — it writes no application code itself (with one
exception, the embedded OpenRouter runtime). It is the shift supervisor and the conveyor
belt; the machines are the agent CLIs (`claude`, `codex`, `copilot`, and a built-in
`openrouter` runtime).

> **Base status: all 10 orchestrator milestones implemented** — daemon + SQLite + UDS framing +
> PTY + attach; the status machine + live dashboard; the spawn sequence; remote/devbox agents; the
> work-item monitor + focus view; nudge delivery; autonomy; alerts + accounting; box federation; and
> the in-process OpenRouter agent runtime. External I/O is exercised through pure, tested command
> builders / decision logic; see [`BUILD.md`](./BUILD.md) for what's live-only per milestone.

---

## What it does

- **Process supervisor / terminal multiplexer for agents** — like tmux, but the panes are
  agent CLI sessions and the supervisor knows what each one is doing.
- **Queue / kanban of workstreams** (tasks) with agents attached to them.
- **PR babysitter** — watches every PR the agents open (CI, reviews, merge conflicts,
  unresolved threads) and knows what each PR needs next.
- **Autopilot ("autonomy")** — within strict guardrails, types instructions into agents
  whose PRs need attention, requests bot/human reviews, and sweeps approvals for follow-up.
- **Chief of staff** — batches whatever autonomy could not handle into a terse Slack DM
  written by an LLM.
- **Accountant** — attributes token spend and rate-limit quota per agent across machines.

## Stack

Bun + TypeScript. TUI is Ink (React for terminals). Persistence is SQLite (`bun:sqlite`).
IPC is a Unix-domain socket with custom binary framing. Remote execution is plain `ssh` +
`tmux`. GitHub via the `gh` CLI. Linear via MCP (`mcp-remote`). Slack via bot-token HTTP.
Service management via `launchd` (Mac) and `systemd --user` units (Linux devbox).

**Zero runtime npm dependencies on the daemon side** — deliberate: the daemon ships as
source to the remote box and runs under Bun without `node_modules`. Ink/React are used only
by the client (`src/client`).

## Mental model (two levels)

- **Task** — a workstream (ticket, bug, refactor). Human-assigned order in a queue. Open or closed.
- **Session (agent)** — one agent CLI process working on a task. A task may have several.
  Each session has: tool, location (`local` | `devbox`), cwd, worktree flag, model, effort,
  permission level (`ask` | `auto-edits` | `full-access`), a resume handle, a title, status.

Everything else hangs off those two: **work items** (PRs/tickets a session carries),
**status** (seven-state session status), **nudges** (text typed into an agent unattended),
**autonomy** (policy + actuator), **alerts** (deterministic "a human should see this"),
**focus** (pure PR/session classification), **devbox** (a Linux box over ssh), and
**profiles** (per-repository config).

## Architecture (processes)

1. **Daemon (Mac)** — one long-lived process. Sole writer of the SQLite DB; owner of every
   local agent PTY and every ssh-mirror PTY; UDS socket server; runs all monitors, the
   autonomy actuator, the alert dispatcher, the worktree reaper, box federation. Agents
   outlive any client.
2. **TUI client (`ao`)** — a thin Ink app, no durable state. Renders a 1-second snapshot;
   attaches to a live agent by raw byte passthrough (dashboard OR attached, toggled like tmux).
   Auto-starts the daemon if none is listening.
3. **Box monitor daemon (devbox, optional)** — a cut-down daemon under `systemd --user`: no
   PTYs, no socket, no clients. Discovers agents from `tmux ls`, polls GitHub, runs the same
   policy engine, delivers nudges via `tmux send-keys`, raises alerts into its own DB.
4. **CLI subcommands** that deliberately bypass the daemon (`setup`, `history`, `worktree`,
   `pr`, `autonomy`, `daemon`, `monitor`, `issue`) so they work when the daemon is wedged.

## Layout

```
src/daemon    everything except UI (store, PTY, UDS server, monitors, autonomy, nudge, box)
src/client    Ink components, attach, history view, settings writer
src/shared    domain types, wire protocol, per-CLI spawn spec, config, settings,
              focus classification, ticket/transcript parsing, pricing, autonomy window,
              remote command builders
src/cli       entry, setup wizard, launchd, monitor (devbox deploy), history, worktree, pr, issue
src/daemon/box the box daemon (index, roster, policy, report, tmux-nudge)
deploy/       systemd units, box-side shell scripts, three SKILL.md docs (fleet status,
              review queue, deploy)
defaults.json         tracked org defaults (team facts; nothing personal)
config.example.json   template operator config
```

## State directory

Root `~/.borderless`, overridable by `AO_HOME` (the isolation seam: two daemons with different
homes share nothing — distinct from the reference repo's `~/.agent-orchestrator`, so Borderless
and the reference run side by side; the box daemon uses `~/.agent-orchestrator-monitor`).
Contents: `daemon.sock`, `store.sqlite` (WAL), `daemon.pid`, `daemon.log`, `client.log`,
`config.json` (0600), `sessions/<id>/`, `worktrees/`, `repos/<profileId>/`, and the
file-based escape hatches `AUTONOMY_OFF`, `AUTONOMY_UNTIL`, `AUTONOMY_CONFIG_LOADED_AT`.

## Configuration model

Four resolution layers, highest first:

1. **Environment** (`AO_*`) — how the devbox daemon is configured; the escape hatch for tests.
2. **Operator config** `~/.agent-orchestrator/config.json` — only facts about *you*.
   Written by `ao setup`, mode 0600. Malformed → throws (it's your typo to see).
3. **Tracked org defaults** `defaults.json` — facts about the team. Malformed/missing →
   silently `{}` (not your file to fix).
4. **Built-in defaults** (autonomy window + a few numeric knobs).

Split identity (no defaults, fail loudly) from preferences (always defaulted, tolerant) from
team facts (tracked org file). Absent identity config is a startup error naming the key.
Runtime authority toggles (`AO_AUTONOMY`, `AO_ALERTS`, ...) are **environment-only on purpose**
so "install the daemon" and "let it act" stay separate decisions. See
[`config.example.json`](./config.example.json) and `src/shared/config.ts` for the full key set.

## Core invariants

- Exactly one writer per SQLite file; readers are one-shot read-only processes.
- Nothing personal has a default at any config layer.
- Every escape hatch works without the daemon (file-based kill switch, direct-DB history,
  ssh mirror of the kill switch to the devbox).
- Failure of any observer degrades to "know nothing, do nothing" — never to "idle" or "clean".
- Reviews are bound to commit shas, not timestamps; the audit log is the source of truth for
  what autonomy has done; dedupe keys encode the event's identity, never the row.

## Design principles

See [`BUILD.md`](./BUILD.md#design-principles) for the distilled list — copy them; they are
the real design. The short version: never type into a busy pane/menu/over stranded text; a
transport negative is "no answer", never "dead/idle/clean"; absence is never a pass for a
gate; every automated action has a bounded budget; deploy ships code, never authority.

## Naming / parametrization

This project is the generic supervisor. The org-specific vocabulary (reviewer identity set,
the review-bot login + trigger phrase, the code-quality-review heading and grade convention,
the convergence-gate check name, Linear team keys/workspace, the alert persona name) is
**parametrized** — see `BUILD.md` and `src/shared/config.ts`. Everything else — the
supervisor, PTY/tmux plumbing, status machine, nudge safety, work-item derivation,
policy/actuator, accounting, OpenRouter runtime, federation — is generic.

## Getting started

```sh
bun install
bun test                 # framing, store, PTY, and end-to-end daemon↔client tests
bun run typecheck        # tsc --noEmit

bun run src/cli/index.ts # launch the minimal TUI (auto-starts the daemon)
# in the TUI: n = new task, a = add agent, enter = attach, Ctrl-] = detach, q = quit
```

`ao setup` and most subcommands are not implemented yet (they print a pointer to `BUILD.md`).
The daemon runs directly via `bun run src/daemon/index.ts`; state lives in `~/.borderless`
(override with `AO_HOME`).
