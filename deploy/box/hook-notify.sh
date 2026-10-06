#!/bin/sh
# Remote status hook (design §9.2). Deployed once per daemon run to
# ~/.agent-orchestrator-remote/hook-notify.sh (piped over ssh stdin, chmod +x). Absolute paths
# because the hook command is nested in the CLI's settings JSON inside tmux inside ssh quoting.
#
# Appends "<epoch> <event>" to ~/.agent-orchestrator-remote/<sessionId>/events.log. The daemon
# runs a persistent `ssh ... tail -n +1 -F` on that file and forwards needs-input / done.
#
# Usage:
#   sh hook-notify.sh <sessionId> <event>              (claude: event is the mapped state)
#   sh hook-notify.sh <sessionId> codex-event <json>   (codex: classify from the JSON `type` field)
set -eu

base="$HOME/.agent-orchestrator-remote"
sid="$1"
event="$2"
dir="$base/$sid"
mkdir -p "$dir"

if [ "$event" = "codex-event" ]; then
  json="${3:-}"
  # Codex classification reads ONLY the `type` field: "approval"/"request" -> needs-input, else done
  # (matching the WHOLE payload once produced a false needs-input). TODO: parse the type field precisely.
  type_val=$(printf '%s' "$json" | sed -n 's/.*"type"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
  case "$type_val" in
    *approval*|*request*) event="needs-input" ;;
    *) event="done" ;;
  esac
fi

printf '%s %s\n' "$(date +%s)" "$event" >> "$dir/events.log"
