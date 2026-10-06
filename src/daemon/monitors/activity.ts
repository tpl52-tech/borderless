/**
 * Activity monitor — cosmetic (design §10.3) — and the introspection probe (design §10.4).
 *
 * Activity (cosmetic): every 2s, only for sessions in working/stuck and only on the devbox (tmux
 * capture), parse the bottom-most line shaped `<glyph> <Verb...> (<detail>)` when "esc to interrupt"
 * is present; elapsed = first `<digits>s`. Cached readings expire after 6s; null means "no detail",
 * never "idle".
 *
 * Introspection probe (feeds autonomy): one ssh round trip per fleet (30s timeout, 10s cache): a
 * read-only shell script that runs `claude agents --json` (authoritative busy/idle/waiting + cwd),
 * reads sidecars, and tails each transcript for progress + PR-link evidence. Fidelity:
 * authoritative / inferred / none — callers MUST NOT act autonomously on `none`. Unknown statuses
 * map to busy (over-reporting busy is the safe direction). See deploy/box/introspect.sh.
 */

export type Fidelity = "authoritative" | "inferred" | "none";

export function startActivityMonitor(): { stop(): void } {
  throw new Error("activity.startActivityMonitor: not implemented (design §10.3)");
}

/** Run the introspection probe once and return per-session evidence (design §10.4). */
export function introspect(): Promise<unknown> {
  throw new Error("activity.introspect: not implemented (design §10.4)");
}
