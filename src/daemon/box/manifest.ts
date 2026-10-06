/**
 * The Mac -> box manifest (design §17.3) — pushed over ssh (atomic temp+mv) every 60s when changed,
 * forced immediately on setPlanning.
 *
 * FRESHNESS INVERSION: missing/invalid/older than 24h -> the box refuses to act on ANYTHING. Elsewhere
 * an empty allowlist means unrestricted; HERE staleness must make the box MORE conservative (nudging a
 * retired agent is wrong). Ownership on the box = manifest allows AND the session is in the live roster;
 * no election protocol, just disjoint partitioning.
 */

import type { Session } from "../../shared/types.ts";

export const MANIFEST_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface Manifest {
  writtenAt: number;
  closed: string[];
  allowed: string[];
  tool: Record<string, string>;
  title: Record<string, string>;
  profile: Record<string, string>;
  planning: string[];
}

/** Build the manifest from the Mac's sessions (only devbox sessions are the box's concern). */
export function buildManifest(sessions: Session[], now: number): Manifest {
  const devbox = sessions.filter((s) => s.location === "devbox");
  const m: Manifest = {
    writtenAt: now, closed: [], allowed: [], tool: {}, title: {}, profile: {}, planning: [],
  };
  for (const s of devbox) {
    if (s.closed) { m.closed.push(s.id); continue; }
    m.allowed.push(s.id);
    m.tool[s.id] = s.tool;
    m.title[s.id] = s.title;
    m.profile[s.id] = s.profileId;
    if (s.planning) m.planning.push(s.id);
  }
  return m;
}

/** Fresh iff present and written within the last 24h (design §17.3 freshness inversion). */
export function manifestFresh(manifest: Manifest | null, now: number): boolean {
  return !!manifest && Number.isFinite(manifest.writtenAt) && now - manifest.writtenAt <= MANIFEST_MAX_AGE_MS;
}

/** Parse a raw manifest tolerantly; returns null on anything invalid (-> box refuses to act). */
export function parseManifest(raw: string): Manifest | null {
  try {
    const m = JSON.parse(raw) as Manifest;
    if (typeof m?.writtenAt !== "number" || !Array.isArray(m.allowed)) return null;
    return m;
  } catch {
    return null;
  }
}

/**
 * Does the box own this session? (design §17.3) Manifest fresh AND allows AND in the live roster AND not
 * flagged planning. A stale/missing manifest owns NOTHING.
 */
export function boxOwns(manifest: Manifest | null, sessionId: string, inRoster: boolean, now: number): boolean {
  if (!manifestFresh(manifest, now)) return false;
  return manifest!.allowed.includes(sessionId) && inRoster && !manifest!.planning.includes(sessionId);
}
