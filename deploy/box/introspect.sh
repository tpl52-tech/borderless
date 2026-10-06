#!/bin/sh
# Introspection probe (design §10.4). Read-only. One ssh round trip per fleet feeds autonomy.
#
# IMPORTANT (design §21 known gap): in the reference system nothing deployed this script, so every
# claude agent silently read fidelity `none`. Here it SHIPS with the deploy tree and the daemon must
# make its ABSENCE loud. Expected at ~/agent-orchestrator-alerts/introspect.sh on the box.
#
# It must, read-only:
#   1. run `claude agents --json` (authoritative busy/idle/waiting + cwd);
#   2. read ~/.claude/sessions/*.json sidecars (statusUpdatedAt is UNRELIABLE — liveness proof is
#      presence in `claude agents`);
#   3. per session id (hex/dash only) tail the last 2 MB of the transcript to extract: whole-file
#      byte count, newest pr-link record per PR number, last 6 Monitor-tool descriptions, a
#      babysit-prs marker count, the last prompt (300 chars), the last assistant text (400 chars).
#   4. base64 all raw captures; emit one JSON envelope.
set -eu

echo '{ "error": "introspect.sh: not implemented (scaffold) — see design §10.4, §21" }'
exit 0
