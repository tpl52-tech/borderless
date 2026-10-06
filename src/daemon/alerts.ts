/**
 * Alert dispatcher + Slack narrator (design §15.1).
 *
 * Detection is deterministic (the autonomy policy's alert-human decisions, recorded as alert rows);
 * the dedupe key encodes the transition; alerts are kept forever. Dispatcher (opt-in AO_ALERTS=1;
 * dry-run flag; NOT inherited by deploys): tick 60s, debounce 30s from the newest pending alert
 * (changes arrive in clusters), batch 20, mark notified + increment attempts BEFORE invoking the
 * narrator (a crash must not replay into a duplicate burst), release on failure until attempts reach 5.
 *
 * The narrator is a shell script (deploy/alerts/narrate.sh) that pipes a rendered prompt + the alert
 * JSON into `claude -p ... --max-turns 1`, extracts the first JSON object, and posts to Slack. Here it
 * is INJECTED so the dispatcher loop (debounce/batch/attempts/mark) is unit-tested with a fake.
 */

import type { Store } from "./store.ts";
import type { Alert } from "../shared/types.ts";
import { runWithDeadline } from "./ssh.ts";

export const ALERT_MAX_ATTEMPTS = 5;
export const ALERT_TICK_MS = 60_000;
export const ALERT_DEBOUNCE_MS = 30_000;
export const ALERT_BATCH = 20;

/** The narrator's verdict: which alert ids it DM'd, and which it suppressed. Forgotten ids => suppressed. */
export interface AlertVerdict {
  delivered: string[];
  suppressed: string[];
}

export type Narrator = (alerts: Alert[]) => Promise<AlertVerdict>;

export interface AlertDispatcher {
  tick(): Promise<void>;
  stop(): void;
}

export interface AlertDispatcherDeps {
  store: Store;
  narrate: Narrator;
  dryRun?: boolean;
  now?: () => number;
}

export function createAlertDispatcher(deps: AlertDispatcherDeps): AlertDispatcher {
  const now = deps.now ?? Date.now;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const pending = deps.store.pendingAlerts(ALERT_MAX_ATTEMPTS);
    if (pending.length === 0) return;

    // Debounce: wait until the newest pending alert has settled (changes arrive in clusters).
    const newest = Math.max(...pending.map((a) => a.createdAt));
    if (now() - newest < ALERT_DEBOUNCE_MS) return;

    const batch = pending.slice(0, ALERT_BATCH);
    if (deps.dryRun) return; // detection still records rows; dispatch is a no-op in dry-run

    // Mark notified + attempts++ BEFORE narrating (a crash must not replay into a duplicate burst).
    for (const a of batch) deps.store.markAlertNotified(a.id);

    let verdict: AlertVerdict;
    try {
      verdict = await deps.narrate(batch);
    } catch {
      return; // release for retry; attempts already incremented, capped at ALERT_MAX_ATTEMPTS
    }
    const delivered = new Set(verdict.delivered);
    for (const a of batch) {
      if (delivered.has(a.id)) deps.store.markAlertDelivered(a.id);
      else deps.store.markAlertSuppressed(a.id); // forgotten ids are suppressed (§15.1)
    }
  };

  const timer = setInterval(() => void tick().catch(() => {}), ALERT_TICK_MS);
  return { tick, stop() { stopped = true; clearInterval(timer); } };
}

/**
 * The real narrator: shell out to the deployed narrate.sh with the batch as JSON (design §15.1).
 * Live-only — needs `claude -p`, a Slack bot token, and the configured member id. The verdict is parsed
 * from the script's stdout JSON `{ dm, delivered[], suppressed[] }`.
 */
export function shellNarrator(scriptPath: string, alertSlackId: string): Narrator {
  return async (alerts: Alert[]): Promise<AlertVerdict> => {
    const payload = JSON.stringify({ recipient: alertSlackId, alerts });
    const r = await runWithDeadline(["sh", scriptPath], { input: payload, timeoutMs: 120_000 });
    if (r.code !== 0) throw new Error(`narrate.sh failed (code ${r.code}): ${r.stderr}`);
    const m = /\{[\s\S]*\}/.exec(r.stdout);
    if (!m) throw new Error("narrate.sh produced no JSON verdict");
    const v = JSON.parse(m[0]) as { delivered?: string[]; suppressed?: string[] };
    return { delivered: v.delivered ?? [], suppressed: v.suppressed ?? [] };
  };
}
