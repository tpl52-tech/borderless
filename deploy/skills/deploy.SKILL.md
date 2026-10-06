---
name: deploy
description: How to deploy the agent-orchestrator box monitor daemon to the devbox.
---

# Deploying the box monitor

The box monitor daemon runs autonomy on the devbox so the fleet keeps working when the laptop sleeps.
Deploy from the Mac; it ships CODE, never authority or credentials (design §17.5).

## Deploy

```sh
ao monitor deploy      # git archive HEAD of src/daemon src/shared package.json deploy -> box, atomic swap
ao monitor restart     # systemctl restart (never a raw signal)
ao monitor status      # unit + autonomy state
ao monitor logs        # journalctl --user -u agent-orchestrator-monitor
ao monitor rollback    # swap back to the kept .old
```

- Deploy does NOT start the service; it swaps code and keeps one rollback level (`.old`,
  `DEPLOYED_SHA`).
- The env file is regenerated from the Mac's config for IDENTITY keys only; the box's existing
  `AO_AUTONOMY` / `AO_ALERTS` are CARRIED FORWARD unchanged (two dispatchers would DM twice).
- Enabling autonomy/alerts on the box is a SEPARATE decision: `ao monitor enable <actions>` /
  `ao monitor dry-run`, each rewrites the env line and needs a restart.

## First-time provisioning

```sh
ao setup --only devbox         # ssh reachability, bun, PATH, tmux
ao monitor setup-mcp           # seed mcp-remote + codex credentials (no browser on the box, §17.7)
ao monitor setup-copilot       # if using copilot agents on the box
```

## Escape hatches (work when the daemon is wedged)

- Kill switch is a FILE: `~/.agent-orchestrator-monitor/AUTONOMY_OFF` (mirrored from the Mac by
  `ao autonomy off`).
- `ao autonomy status` prints local AND box state, including `restartPending` (env file newer than the
  loaded-at marker) and `daemonAlive` (from systemd).

> One operator per devbox: tmux names, deploy path, and unit name are not namespaced (design §17.5).
