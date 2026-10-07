/**
 * Slack DM — the thin live sender behind lead-desk delegation (PRD §9).
 *
 * Live-only (needs a bot token): resolve a Slack user by email, then post a DM. Best-effort by design —
 * it returns false (never throws) when there's no token, the email isn't a Slack user, or the API says
 * no, so a failed DM never fails the delegation (the Linear issue is the source of truth; the DM is a
 * courtesy ping). The orchestration that calls it is tested through an injected sender.
 */

const SLACK_API = "https://slack.com/api";

interface SlackResponse { ok?: boolean; user?: { id?: string } }

async function slackGet(token: string, method: string, params: Record<string, string>): Promise<SlackResponse> {
  const url = `${SLACK_API}/${method}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  return res.ok ? ((await res.json()) as SlackResponse) : { ok: false };
}

async function slackPost(token: string, method: string, body: unknown): Promise<SlackResponse> {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  return res.ok ? ((await res.json()) as SlackResponse) : { ok: false };
}

/**
 * A best-effort DM sender bound to a bot token. Tries each email until one resolves to a Slack user and
 * the message posts; returns true on the first success, false otherwise. With no token it's a no-op that
 * always returns false — so an un-configured Slack simply means "no DM", not an error.
 */
export function liveSlackDm(botToken: string | undefined): (emails: string[], text: string) => Promise<boolean> {
  if (!botToken) return async () => false;
  return async (emails, text) => {
    for (const email of emails) {
      const found = await slackGet(botToken, "users.lookupByEmail", { email });
      const userId = found.ok ? found.user?.id : undefined;
      if (!userId) continue;
      const posted = await slackPost(botToken, "chat.postMessage", { channel: userId, text });
      if (posted.ok) return true;
    }
    return false;
  };
}
