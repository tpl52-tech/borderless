/**
 * Dashboard (design §19).
 *
 * Rows are tasks, sessions (with PR items), and items — a FLAT list so one integer cursor walks
 * everything; every row is one TRUNCATED line (scroll math depends on it). Task order is the store's
 * human order — NEVER re-sorted by urgency or recency (rows moved under the cursor once).
 *
 * Session row: glyph, ticket, title, tool:model, location, "wt", status label, "planning" badge,
 * activity/elapsed, usage cell (share + cost, red >= 40%). PR row: number, title, draft, conflicts,
 * CI cell, "N unresolved", codex/cto glyphs (only for gates the profile enables), "rev" while a
 * code-quality review is unhandled. Header: keep-awake remaining, autonomy badge + window label,
 * closed counts, last-action banner, quota block. Snapshot polled every second + on every event.
 *
 * Keys (design §19): arrows/enter, c/C closed, n new task, a add agent, e edit, x close, X hard-remove,
 * i planning, h history, H handoff, L link, m/M nudge form, r codex review, R CTO review, B bump CTO,
 * m-on-PR merge (confirm y only), p re-poll, U update branches, Ctrl-R reconnect all, Ctrl-P prune,
 * f focus, A activity, $ usage, comma settings, l Linear, E extend autonomy, W keep awake, q quit.
 */

export function Dashboard(): unknown {
  throw new Error("client.Dashboard: not implemented (design §19)");
}
