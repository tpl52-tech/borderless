/**
 * Box roster (design §17.2).
 *
 * Roster refresh every 10s: in parallel `tmux ls` (names + paths), `ls ~/.agent-orchestrator-remote`
 * (full uuids), `claude agents --json`, plus the last events.log line per session; each with a 20s
 * timeout. Join: only `ao-` names; the 8-char prefix must match EXACTLY ONE uuid dir (zero or several ->
 * dropped, never guessed); a live claude process match wins for activity, else the events file
 * (working/starting -> busy, needs-input -> waiting, done -> idle, anything else -> unknown); neither ->
 * unknown (NEVER idle).
 *
 * The join is pure + unit-tested; the parallel command-running refresh is live-only.
 */

export type RosterActivity = "busy" | "waiting" | "idle" | "unknown";

export interface RosterEntry {
  sessionId: string; // the full uuid
  tmuxName: string; // ao-<id8>
  activity: RosterActivity;
}

export interface RosterInputs {
  /** tmux session names from `tmux ls`. */
  tmuxNames: string[];
  /** full session-id dirs from `ls ~/.agent-orchestrator-remote`. */
  uuidDirs: string[];
  /** session ids with a live process per `claude agents --json`. */
  liveClaude: Set<string>;
  /** last events.log token per session id. */
  lastEvent: Record<string, string | undefined>;
}

const TMUX_PREFIX = "ao-";

function eventActivity(ev: string | undefined): RosterActivity {
  if (ev === "working" || ev === "starting") return "busy";
  if (ev === "needs-input") return "waiting";
  if (ev === "done") return "idle";
  return "unknown"; // present-but-other, or absent
}

/** Join the four sources into a roster (design §17.2). Pure. */
export function joinRoster(inputs: RosterInputs): RosterEntry[] {
  const out: RosterEntry[] = [];
  for (const name of inputs.tmuxNames) {
    if (!name.startsWith(TMUX_PREFIX)) continue;
    const prefix = name.slice(TMUX_PREFIX.length);
    const matches = inputs.uuidDirs.filter((u) => u.startsWith(prefix));
    if (matches.length !== 1) continue; // zero or several -> dropped, never guessed
    const sessionId = matches[0]!;
    const activity: RosterActivity = inputs.liveClaude.has(sessionId)
      ? "busy"
      : (sessionId in inputs.lastEvent ? eventActivity(inputs.lastEvent[sessionId]) : "unknown");
    out.push({ sessionId, tmuxName: name, activity });
  }
  return out;
}

export function startRoster(): { stop(): void } {
  // Live-only: runs tmux ls / ls / claude agents --json / tail on the box every 10s and upserts the
  // joined roster into the box store under the Mac's session id. See design §17.2.
  throw new Error("box.roster.startRoster: live-only (design §17.2) — use joinRoster for the pure join");
}
