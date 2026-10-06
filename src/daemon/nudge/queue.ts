/**
 * Nudge queue semantics (design §10.5).
 *
 *   - max 2 pending per session ("a deep queue is a delayed firehose");
 *   - dedupe by key;
 *   - holds re-insert at the FRONT (bounded by the caller's hold cap);
 *   - a manual/unkeyed message is never terminally demoted (its key is a random UUID nothing
 *     regenerates), so it is exempt from the dedupe drop;
 *   - flagging a session `planning` drops queued AUTONOMOUS entries (manual survive, design §10.6).
 */

export interface QueuedNudge {
  key: string;
  body: string;
  /** settlement/dedupe keys this delivery should record on success (autonomy, step 7). */
  settleKeys: string[];
  manual: boolean;
  holds: number;
}

export const MAX_PENDING_PER_SESSION = 2;

export type EnqueueResult = "queued" | "deduped" | "rejected-full";

export class NudgeQueue {
  private readonly q = new Map<string, QueuedNudge[]>();

  private list(sessionId: string): QueuedNudge[] {
    let l = this.q.get(sessionId);
    if (!l) { l = []; this.q.set(sessionId, l); }
    return l;
  }

  enqueue(sessionId: string, nudge: Omit<QueuedNudge, "holds">): EnqueueResult {
    const l = this.list(sessionId);
    // Dedupe by key (a manual message's key is a unique UUID, so it never collides).
    if (!nudge.manual && l.some((n) => n.key === nudge.key)) return "deduped";
    if (l.length >= MAX_PENDING_PER_SESSION) return "rejected-full";
    l.push({ ...nudge, holds: 0 });
    return "queued";
  }

  /** The next nudge to try (front of the queue), without removing it. */
  peek(sessionId: string): QueuedNudge | undefined {
    return this.q.get(sessionId)?.[0];
  }

  /** Remove and return the front nudge (on successful delivery). */
  shift(sessionId: string): QueuedNudge | undefined {
    return this.q.get(sessionId)?.shift();
  }

  /** Re-insert a held nudge at the FRONT with holds+1. */
  holdFront(sessionId: string, nudge: QueuedNudge): void {
    this.list(sessionId).unshift({ ...nudge, holds: nudge.holds + 1 });
  }

  /** Drop queued autonomous entries; manual survive (design §10.6 planning cancellation). */
  clearAutonomous(sessionId: string): void {
    const l = this.q.get(sessionId);
    if (l) this.q.set(sessionId, l.filter((n) => n.manual));
  }

  size(sessionId: string): number {
    return this.q.get(sessionId)?.length ?? 0;
  }

  forget(sessionId: string): void {
    this.q.delete(sessionId);
  }
}
