#!/bin/sh
# Box report (box -> Mac) (design §17.4). One-shot, READ-ONLY. The Mac pulls it every 15s.
# Emits JSON: { observedAt, autonomy{enabled,dryRun,actions,killed,window,restartPending,daemonAlive},
#               counts, actions[ up to 40 joined audit rows ] }
#
# Reads the box store via a one-shot read-only sqlite process (invariant: exactly one writer per file).
# daemonAlive comes from systemd (file/DB state looks healthy even when the process is stopped);
# restartPending when the env file is newer than the loaded-at marker. Requires sqlite3 + jq.
set -eu

HOME_DIR="$HOME/.agent-orchestrator-monitor"
DB="$HOME_DIR/store.sqlite"
ENV_FILE="$HOME_DIR/env"
LOADED_AT="$HOME_DIR/AUTONOMY_CONFIG_LOADED_AT"

killed=false; [ -f "$HOME_DIR/AUTONOMY_OFF" ] && killed=true
daemon_alive=false; systemctl --user is-active --quiet agent-orchestrator-monitor.service 2>/dev/null && daemon_alive=true
restart_pending=false
[ -f "$ENV_FILE" ] && [ -f "$LOADED_AT" ] && [ "$ENV_FILE" -nt "$LOADED_AT" ] && restart_pending=true

enabled=false; case "${AO_AUTONOMY:-}" in ""|0) ;; *) enabled=true ;; esac
dry_run=false; [ "${AO_AUTONOMY_DRY_RUN:-}" = "1" ] && dry_run=true

actions='[]'
if [ -f "$DB" ] && command -v sqlite3 >/dev/null 2>&1; then
  actions=$(sqlite3 -readonly -json "$DB" \
    "SELECT action, status, gate, reason, created_at FROM autonomy_actions ORDER BY created_at DESC LIMIT 40;" 2>/dev/null || echo '[]')
  [ -n "$actions" ] || actions='[]'
fi

jq -n \
  --argjson observedAt "$(( $(date +%s) * 1000 ))" \
  --argjson enabled "$enabled" --argjson dryRun "$dry_run" --argjson killed "$killed" \
  --argjson restartPending "$restart_pending" --argjson daemonAlive "$daemon_alive" \
  --argjson actions "$actions" \
  '{observedAt: $observedAt,
    autonomy: {enabled: $enabled, dryRun: $dryRun, actions: [], killed: $killed,
               window: "", restartPending: $restartPending, daemonAlive: $daemonAlive},
    counts: {actions: ($actions | length)},
    actions: $actions}'
