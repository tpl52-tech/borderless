/**
 * State directory layout (design §3.3).
 *
 * Root `~/.borderless`, overridable by AO_HOME (the isolation seam: two daemons with
 * different homes share nothing — the box daemon uses `~/.agent-orchestrator-monitor`).
 * The default root is distinct from the agent-orchestrator reference repo's `~/.agent-orchestrator`,
 * so Borderless and the reference can run side by side without sharing a socket/db.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** Resolve the state-directory root, honoring AO_HOME (blank/whitespace reads as unset). */
export function stateHome(): string {
  const raw = process.env.AO_HOME;
  const override = raw?.trim();
  if (override) return override;
  return join(homedir(), ".borderless");
}

export interface Paths {
  home: string;
  socket: string;
  db: string;
  pid: string;
  daemonLog: string;
  clientLog: string;
  config: string;
  sessions: string;
  worktrees: string;
  repos: string;
  autonomyOff: string;
  autonomyUntil: string;
  autonomyConfigLoadedAt: string;
}

export function paths(home = stateHome()): Paths {
  return {
    home,
    socket: join(home, "daemon.sock"),
    db: join(home, "store.sqlite"),
    pid: join(home, "daemon.pid"),
    daemonLog: join(home, "daemon.log"),
    clientLog: join(home, "client.log"),
    config: join(home, "config.json"),
    sessions: join(home, "sessions"),
    worktrees: join(home, "worktrees"),
    repos: join(home, "repos"),
    autonomyOff: join(home, "AUTONOMY_OFF"),
    autonomyUntil: join(home, "AUTONOMY_UNTIL"),
    autonomyConfigLoadedAt: join(home, "AUTONOMY_CONFIG_LOADED_AT"),
  };
}

/** Per-session scratch dir + the events.log hook sentinel (design §3.3, §10.2). */
export function sessionDir(sessionId: string, home = stateHome()): string {
  return join(home, "sessions", sessionId);
}
