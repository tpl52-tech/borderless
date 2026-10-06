/**
 * Box report (box -> Mac) (design §17.4).
 *
 * A one-shot read-only script prints this; the Mac pulls it every 15s (25s timeout, stale after 90s from
 * the BOX's own clock), caches it so the 1-second snapshot never waits on ssh, and skips it while a
 * client is attached. Unreachable keeps the last payload and flips a flag (a flapping "no box" badge is
 * worse than slightly old data).
 */

export const REPORT_STALE_MS = 90_000;

export interface BoxAutonomyState {
  enabled: boolean;
  dryRun: boolean;
  actions: string[];
  killed: boolean;
  window: string;
  restartPending: boolean;
  daemonAlive: boolean;
}

export interface BoxReport {
  observedAt: number;
  autonomy: BoxAutonomyState;
  counts: Record<string, number>;
  actions: unknown[]; // up to 40 joined audit rows
}

/** Stale iff older than 90s by the BOX's own clock (design §17.4). */
export function reportStale(report: BoxReport | null, now: number): boolean {
  return !report || now - report.observedAt > REPORT_STALE_MS;
}

/** Parse a raw report tolerantly. */
export function parseReport(raw: string): BoxReport | null {
  try {
    const r = JSON.parse(raw) as BoxReport;
    return typeof r?.observedAt === "number" && r.autonomy ? r : null;
  } catch {
    return null;
  }
}

export function renderReport(): BoxReport {
  // Live-only: the box daemon renders this from its own store + autonomy state. See design §17.4 and the
  // box-side deploy/box/report.sh which the Mac pulls over ssh.
  throw new Error("box.report.renderReport: live-only (design §17.4) — use reportStale/parseReport (pure)");
}
