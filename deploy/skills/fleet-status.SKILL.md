---
name: fleet-status
description: How to read agent-orchestrator fleet status from inside an agent session on the box.
---

# Reading fleet status

You are one agent in a fleet supervised by **agent-orchestrator**. Use this to see what the rest of
the fleet is doing without a running client (agents run where no `ao` binary exists).

## What the supervisor knows about you

- Your session id is the 8-char prefix of your tmux session name `ao-<id8>`.
- Your status is inferred from your CLI's notify hooks (`~/.agent-orchestrator-remote/<id>/events.log`),
  output idle timing, and transcript growth. If you go quiet for ~4s the supervisor reads you as
  `done`; a permission prompt reads as `needs-input`.
- Your PRs are auto-linked from your git branch. Keep your branch named `<branchOwner>/<TICKET>`.

## To read the fleet (read-only)

- `tmux ls` — every fleet pane is a `ao-*` session.
- `claude agents --json` — authoritative busy/idle/waiting for claude agents on this box.
- The box report script (`deploy/box/report.sh`) prints the autonomy state + recent audit rows.

## What NOT to do

- Do not `tmux kill-session` or `send-keys` into another `ao-*` pane — the supervisor owns nudging.
- Do not resolve review threads to "clear" a PR unless you actually addressed the feedback; the
  supervisor treats resolving as a claim that feedback was addressed.

> Parametrize per org (design §22): the branch prefix, the ticket team keys.
