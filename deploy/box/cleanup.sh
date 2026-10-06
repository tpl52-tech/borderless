#!/bin/sh
# Daily disk hygiene on the box (design §17.6). Invoked by the cleanup timer.
#
# SCAFFOLD SAFETY: this is intentionally a NO-OP that only PRINTS what it would do. It performs no
# destructive action until implemented, because it is wired into a timer. Implement each step behind
# real guards before enabling.
#
# Intended steps (design §17.6):
#   - docker container/volume/image/builder prune via `sudo -n` (user manager can't grant docker group)
#   - remove orphaned compose stacks whose worktree directory is gone
#   - remove stacks whose git registration is gone and no tmux session exists
#   - remove ad-hoc containers older than 5 days (AGE only, never ticket numbers in names)
#   - remove non-ao worktrees whose remote branch vanished and which are clean
#   - journalctl --user --vacuum-time=7d ; rotate logs older than 14 d
set -eu

echo "cleanup.sh: scaffold no-op — see design §17.6 for the intended steps (nothing removed)."
exit 0
