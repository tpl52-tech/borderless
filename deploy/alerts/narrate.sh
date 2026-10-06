#!/bin/sh
# Slack narrator (design §15.1). Deployed to ~/agent-orchestrator-alerts/ (on the box when a devbox is
# configured, else locally). Invoked by the alert dispatcher with the batch as JSON on stdin:
#   { "recipient": "U0XXXX", "alerts": [ { "id", "kind", "summary", "payloadJson", ... }, ... ] }
#
# It pipes a rendered persona prompt + the alert JSON into `claude -p ... --max-turns 1`, extracts the
# first JSON object from the model's output, posts the DM to Slack, and prints the verdict JSON:
#   { "dm": "...", "delivered": [ids...], "suppressed": [ids...] }
#
# The persona: GROUP/PHRASE/catch duplicates — do NOT judge whether alerts are real; terse, lead with
# ticket/PR, say what changed, no emoji. NO default recipient (a default once DM'd someone else).
# Requires: claude, jq, curl, and SLACK_BOT_TOKEN in ~/.agent-orchestrator-alerts.env.
set -eu

ENV_FILE="$HOME/.agent-orchestrator-alerts.env"
[ -f "$ENV_FILE" ] && . "$ENV_FILE"
: "${SLACK_BOT_TOKEN:?SLACK_BOT_TOKEN is required (set it in $ENV_FILE)}"

input=$(cat)
recipient=$(printf '%s' "$input" | jq -r '.recipient // empty')
[ -n "$recipient" ] || { echo '{"delivered":[],"suppressed":[]}'; exit 0; } # no default recipient

prompt='You are the chief of staff for a fleet of coding agents. Group these alerts into one terse Slack DM.
Lead with the ticket/PR, say what changed, no emoji. Suppress only duplicates within the batch or the
plainly obsolete. Reply with ONE JSON object: {"dm": "<message>", "delivered": [alert ids you included],
"suppressed": [alert ids you dropped]}. Alerts:'

verdict=$(printf '%s\n%s\n' "$prompt" "$input" | claude -p --max-turns 1 2>/dev/null | sed -n '/{/,/}/p' | tr -d '\n')
[ -n "$verdict" ] || { echo "narrate: no verdict from claude" >&2; exit 1; }

dm=$(printf '%s' "$verdict" | jq -r '.dm // empty')
if [ -n "$dm" ]; then
  channel=$(curl -sS -X POST https://slack.com/api/conversations.open \
    -H "Authorization: Bearer $SLACK_BOT_TOKEN" -H 'Content-type: application/json' \
    -d "$(jq -n --arg u "$recipient" '{users:$u}')" | jq -r '.channel.id // empty')
  [ -n "$channel" ] && curl -sS -X POST https://slack.com/api/chat.postMessage \
    -H "Authorization: Bearer $SLACK_BOT_TOKEN" -H 'Content-type: application/json' \
    -d "$(jq -n --arg c "$channel" --arg t "$dm" '{channel:$c, text:$t}')" >/dev/null
fi

printf '%s\n' "$verdict"
