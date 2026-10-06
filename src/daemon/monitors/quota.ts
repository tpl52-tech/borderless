/**
 * Quota probes (design §15.3, §12.8).
 *
 * NOT accumulation: read each CLI's OWN rate-limit snapshot. Windows classified by window_minutes
 * (>= 1440 = weekly). Probed locally AND on the devbox; expired windows pruned per window on every read;
 * a failed round trip keeps the prior reading, a successful probe reporting absence clears it. NOTHING
 * acts on quota; it is displayed with staleness.
 *
 * MILESTONE 8: the window classification is pure + tested; the CLI probes (claude -p "/usage", the codex
 * app-server JSON-RPC) are live-only and left as a thin wired shell.
 */

export const WEEKLY_MINUTES = 1440;

export type QuotaWindowKind = "short" | "weekly";

/** Classify a rate-limit window by its length in minutes (design §15.3). */
export function classifyWindow(windowMinutes: number): QuotaWindowKind {
  return windowMinutes >= WEEKLY_MINUTES ? "weekly" : "short";
}

export interface QuotaWindow {
  kind: QuotaWindowKind;
  utilization: number; // 0..1
  resetsAt: number | null; // epoch ms
}

export interface QuotaSnapshot {
  tool: string;
  windows: QuotaWindow[];
  observedAt: number;
  stale: boolean;
}

/** Prune windows whose reset time has passed (design §15.3). */
export function pruneExpired(windows: QuotaWindow[], now: number): QuotaWindow[] {
  return windows.filter((w) => w.resetsAt == null || w.resetsAt > now);
}

export interface QuotaProbe { stop(): void; }

/** TODO(live): probe `claude -p "/usage"` + the codex app-server every 5 min, fire-and-forget (§15.3). */
export function startQuotaProbe(): QuotaProbe {
  // No-op shell for M8: the CLI probes are live-only. Structure kept so the daemon can start it.
  return { stop() {} };
}
