/**
 * Nudge delivery — typing into an agent SAFELY (design §10.5, §10.6, §10.8).
 *
 * MILESTONE 6: the framing + queue + idle gating for LOCAL delivery, end-to-end (the PTY write path).
 * The body and Enter are always SEPARATE writes (framing.ts). Idle gating: deliver only when the
 * session is done/needs-input and no send is in flight, else the message waits in the queue and a drain
 * fires from each status change and a 1s tick. Planning cancellation (§10.6): if the session is flagged
 * planning during the settle gap, send ESC (clear) instead of Enter.
 *
 * The devbox transport (Mac->tmux over an awaited ssh hop with pane guards / stranded-text recognition,
 * §10.5) reuses the pure guards here but its ssh I/O is a follow-up; M6 delivers to a devbox agent's
 * mirror PTY with the same framing. The pure guards (pane-guards.ts) + dispatch (dispatch.ts) are ready
 * for that path and are unit-tested.
 */

import { normalizeBody, CR, ESC, BODY_SETTLE_MS_LOCAL } from "./framing.ts";
import { NudgeQueue, type EnqueueResult } from "./queue.ts";
import type { PtySession } from "../pty.ts";
import type { Store } from "../store.ts";
import type { SessionManager } from "../session-manager.ts";
import type { Tool } from "../../shared/types.ts";

export * from "./framing.ts";
export * from "./pane-guards.ts";
export * from "./dispatch.ts";
export * from "./queue.ts";

const enc = new TextEncoder();

export type DeliverResult = "delivered" | "cancelled";

/**
 * The framing primitive (design §10.5): write the normalized body, wait for it to settle, then — as a
 * SEPARATE write — send Enter (or ESC to clear, if cancelled mid-send). Exported for testing.
 */
export async function deliverToPty(
  pty: PtySession,
  body: string,
  tool: Tool,
  opts: { settleMs?: number; cancelled?: () => boolean } = {},
): Promise<DeliverResult> {
  pty.write(enc.encode(normalizeBody(body, tool)));
  await Bun.sleep(opts.settleMs ?? BODY_SETTLE_MS_LOCAL);
  if (opts.cancelled?.()) {
    pty.write(ESC); // clear the typed body instead of submitting (§10.6)
    return "cancelled";
  }
  pty.write(CR);
  return "delivered";
}

export interface NudgeRequest {
  sessionId: string;
  body: string;
  /** dedupe key; omit for a manual nudge (a unique key is minted, never deduped). */
  key?: string;
  /** settlement keys to record on success (autonomy, step 7). */
  settleKeys?: string[];
  manual: boolean;
}

export interface NudgeDelivery {
  enqueue(req: NudgeRequest): EnqueueResult;
  clearAutonomous(sessionId: string): void;
  forget(sessionId: string): void;
  stop(): void;
}

export interface NudgeDeps {
  store: Store;
  manager: SessionManager;
  /** subscribe to status changes; returns an unsubscribe. */
  subscribeStatus: (cb: (sessionId: string) => void) => () => void;
}

export function createNudgeDelivery(deps: NudgeDeps): NudgeDelivery {
  const { store, manager } = deps;
  const queue = new NudgeQueue();
  const inFlight = new Set<string>();

  // Local idle gating: deliver only when the agent is idle (design §10.5).
  const gateOpen = (sessionId: string): boolean => {
    const s = manager.status(sessionId);
    return s === "done" || s === "needs-input";
  };

  const drain = async (sessionId: string): Promise<void> => {
    if (inFlight.has(sessionId)) return;
    const next = queue.peek(sessionId);
    if (!next) return;
    if (!gateOpen(sessionId)) return; // not idle -> wait for a status change / tick
    const pty = manager.live(sessionId);
    if (!pty) return; // not live -> leave queued (boot redelivery is §5.2)

    inFlight.add(sessionId);
    try {
      queue.shift(sessionId);
      const tool = store.getSession(sessionId)?.tool ?? ("claude" as Tool);
      await deliverToPty(pty, next.body, tool, {
        cancelled: () => !!store.getSession(sessionId)?.planning, // §10.6 cancellation latch
      });
      // TODO(step 7): record settlement/audit rows from next.settleKeys.
    } finally {
      inFlight.delete(sessionId);
    }
    // Deliver at most one per idle transition; the next drain fires on the next status change / tick.
  };

  const offStatus = deps.subscribeStatus((sessionId) => void drain(sessionId));
  const tick = setInterval(() => {
    for (const s of store.listSessions({ includeClosed: false })) void drain(s.id);
  }, 1000);

  return {
    enqueue(req) {
      const result = queue.enqueue(req.sessionId, {
        key: req.key ?? crypto.randomUUID(),
        body: req.body,
        settleKeys: req.settleKeys ?? [],
        manual: req.manual,
      });
      if (result === "queued") void drain(req.sessionId);
      return result;
    },
    clearAutonomous(sessionId) { queue.clearAutonomous(sessionId); },
    forget(sessionId) { queue.forget(sessionId); },
    stop() { offStatus(); clearInterval(tick); },
  };
}
