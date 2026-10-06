/**
 * Autonomy window, kill switch, extension (design §13.7).
 *
 * Acting is confined to 09:00-21:00 Mon-Fri in the configured zone (monitoring runs around the clock;
 * the gate lives in the ACTUATOR, not the monitor). Timezone conversion via Intl.DateTimeFormat with
 * hourCycle "h23" (hour12:false can render midnight as 24, holding the window open overnight).
 *
 * Kill switch: an AUTONOMY_OFF file (a file, not a daemon call, so it works when the daemon is wedged).
 * Extension: an AUTONOMY_UNTIL file with an epoch-ms deadline, capped at 12h, read live; past
 * timestamps self-heal, garbage never opens.
 */

export interface WindowConfig {
  timeZone: string;
  startHour: number;
  endHour: number;
}

export const AUTONOMY_EXTENSION_CAP_MS = 12 * 60 * 60 * 1000;

interface ZonedNow { hour: number; weekday: string; }

function zoned(now: number, timeZone: string): ZonedNow {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", weekday: "short", hour: "2-digit",
  }).formatToParts(new Date(now));
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  return { hour, weekday };
}

const isWeekend = (weekday: string): boolean => weekday === "Sat" || weekday === "Sun";

/** True iff `now` falls inside the acting window in the configured zone (design §13.7). */
export function withinWindow(now: number, cfg: WindowConfig): boolean {
  const { hour, weekday } = zoned(now, cfg.timeZone);
  return !isWeekend(weekday) && hour >= cfg.startHour && hour < cfg.endHour;
}

/**
 * Parse an AUTONOMY_UNTIL deadline (design §13.7): garbage -> null; a past timestamp -> null
 * (self-heal); a deadline beyond the 12h cap -> clamped to now + 12h. Returns the effective deadline
 * (> now) or null.
 */
export function parseExtensionDeadline(raw: string, now: number): number | null {
  const n = Number(raw.trim());
  if (!Number.isFinite(n)) return null;
  if (n <= now) return null;
  return Math.min(n, now + AUTONOMY_EXTENSION_CAP_MS);
}

export type WindowLabel = string; // "9-9" | "off-hours" | "weekend" | "+2h00m"

/** Produce the header window label the TUI renders (design §13.7, §19). */
export function windowLabel(now: number, cfg: WindowConfig, extensionUntil: number | null): WindowLabel {
  if (extensionUntil != null && extensionUntil > now) {
    const mins = Math.round((extensionUntil - now) / 60000);
    return `+${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}m`;
  }
  const { weekday } = zoned(now, cfg.timeZone);
  if (isWeekend(weekday)) return "weekend";
  return withinWindow(now, cfg) ? `${cfg.startHour}-${cfg.endHour}` : "off-hours";
}

/** Is autonomy allowed to act right now (window OR a live extension), ignoring config/kill-switch. */
export function actingAllowed(now: number, cfg: WindowConfig, extensionUntil: number | null): boolean {
  return withinWindow(now, cfg) || (extensionUntil != null && extensionUntil > now);
}
