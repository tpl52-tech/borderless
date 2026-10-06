/**
 * Status detection — the per-PTY state machine (design §10.1) + the local hook watcher (§10.2).
 *
 * Evidence layers, strongest first: CLI notify hooks (authoritative for needs-input/done) ->
 * output-idle timer (fallback) -> process exit (exited/error) -> transcript-growth progress (claude
 * only; gates a CONFIDENT stuck — wired but fed only once transcript reading lands, build step 11).
 *
 * Rules (design §10.1):
 *   - output -> `working` unless a hook holds needs-input or status is already working/stuck
 *     (stuck is NOT cleared by bytes — it is diagnosed precisely because output keeps flowing);
 *   - hook event sets the state directly;
 *   - a hook-asserted needs-input >= 90s ago with output within the idle window overturns to working;
 *   - quiet >= 4s -> done;
 *   - working >= 60 min -> stuck (not confident, never un-sticks).
 *
 * Hook watcher (§10.2): poll each live session's events.log every 500ms by byte offset so each line
 * processes once (fs.watch is edge-triggered and misses rapid writes — the poll is the robust path).
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { sessionDir } from "../../shared/paths.ts";
import type { SessionStatus } from "../../shared/types.ts";

export { ATTENTION_RANK, needsAttention } from "../../shared/status.ts";

export const DONE_QUIET_MS = 4_000;
export const NEEDS_INPUT_OVERTURN_MS = 90_000;
export const IDLE_WINDOW_MS = 4_000;
export const STUCK_CEILING_MS = 60 * 60 * 1_000;
export const HOOK_POLL_MS = 500;
export const TICK_MS = 1_000;

export type HookEvent = "needs-input" | "done";
export type ExitStatus = "exited" | "error";

/**
 * The per-session status state machine. Deterministic and clock-injected: every method takes `now`
 * (epoch ms), so it unit-tests without real timers.
 */
export class StatusMachine {
  private status: SessionStatus;
  private since: number;
  private lastActivityAt: number;
  private hookNeedsInputAt: number | null = null;
  private terminal = false;
  stuckConfident = false;

  constructor(now: number) {
    this.status = "starting";
    this.since = now;
    this.lastActivityAt = now;
  }

  getStatus(): SessionStatus { return this.status; }
  isTerminal(): boolean { return this.terminal; }

  private set(status: SessionStatus, now: number): void {
    if (this.status === status) return;
    this.status = status;
    this.since = now;
  }

  /** PTY bytes arrived. */
  onOutput(now: number): void {
    this.lastActivityAt = now;
    if (this.terminal) return;
    if (this.status === "stuck") return; // stuck is not cleared by bytes
    if (this.hookNeedsInputAt !== null) return; // a hook is holding needs-input
    this.set("working", now);
  }

  /** A CLI notify hook fired (authoritative). */
  onHook(now: number, event: HookEvent): void {
    if (this.terminal) return;
    if (event === "needs-input") {
      this.hookNeedsInputAt = now;
      this.set("needs-input", now);
    } else {
      this.hookNeedsInputAt = null;
      this.set("done", now);
    }
  }

  /** Process/PTY exit — terminal. */
  onExit(now: number, status: ExitStatus): void {
    this.terminal = true;
    this.hookNeedsInputAt = null;
    this.status = status;
    this.since = now;
  }

  /** The every-second rules. Returns true if the visible status changed. */
  tick(now: number): boolean {
    if (this.terminal) return false;
    const before = this.status;

    // (1) needs-input overturn: hook asserted >= 90s ago AND output within the idle window.
    if (
      this.hookNeedsInputAt !== null &&
      now - this.hookNeedsInputAt >= NEEDS_INPUT_OVERTURN_MS &&
      now - this.lastActivityAt <= IDLE_WINDOW_MS
    ) {
      this.hookNeedsInputAt = null;
      this.set("working", now);
    }

    // (2)/(3) transitions out of working.
    if (this.status === "working") {
      if (now - this.lastActivityAt >= DONE_QUIET_MS) {
        this.set("done", now);
      } else if (now - this.since >= STUCK_CEILING_MS) {
        this.stuckConfident = false;
        this.set("stuck", now);
      }
    }

    return this.status !== before;
  }
}

// ---------------------------------------------------------------------------
// Tracker: per-session machines + hook watcher + 1s tick, emitting changes.
// ---------------------------------------------------------------------------

interface Entry {
  machine: StatusMachine;
  offset: number; // events.log bytes consumed
  lastEmitted: SessionStatus;
}

export interface StatusTracker {
  register(sessionId: string): void;
  onOutput(sessionId: string): void;
  onExit(sessionId: string, status: ExitStatus): void;
  /** Feed a hook event from an external source (remote agents tail events.log over ssh, §9.2). */
  feedHook(sessionId: string, event: HookEvent): void;
  unregister(sessionId: string): void;
  status(sessionId: string): SessionStatus;
  onChange(cb: (e: { sessionId: string; status: SessionStatus }) => void): () => void;
  start(): void;
  stop(): void;
}

export interface StatusTrackerOptions {
  home: string;
  now?: () => number;
}

export function createStatusTracker(opts: StatusTrackerOptions): StatusTracker {
  const now = opts.now ?? Date.now;
  const entries = new Map<string, Entry>();
  const cbs = new Set<(e: { sessionId: string; status: SessionStatus }) => void>();
  let hookTimer: ReturnType<typeof setInterval> | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;

  const reconcile = (sessionId: string, entry: Entry): void => {
    const status = entry.machine.getStatus();
    if (status === entry.lastEmitted) return;
    entry.lastEmitted = status;
    for (const cb of cbs) cb({ sessionId, status });
  };

  const readHooks = (sessionId: string, entry: Entry): void => {
    if (entry.machine.isTerminal()) return;
    const path = join(sessionDir(sessionId, opts.home), "events.log");
    let size: number;
    try { size = statSync(path).size; } catch { return; } // no events.log yet
    if (size === entry.offset) return;
    if (size < entry.offset) entry.offset = 0; // shrink -> reset
    let buf: Buffer;
    try { buf = readFileSync(path); } catch { return; }
    const fresh = buf.subarray(entry.offset);
    const text = fresh.toString("utf8");
    const lastNL = text.lastIndexOf("\n");
    if (lastNL < 0) return; // no complete line yet
    const complete = text.slice(0, lastNL + 1);
    entry.offset += Buffer.byteLength(complete, "utf8");
    for (const line of complete.split("\n")) {
      const token = line.trim().split(/\s+/)[1]; // "<epoch> <event>"
      if (token === "needs-input" || token === "done") entry.machine.onHook(now(), token);
    }
    reconcile(sessionId, entry);
  };

  return {
    register(sessionId) {
      const machine = new StatusMachine(now());
      entries.set(sessionId, { machine, offset: 0, lastEmitted: machine.getStatus() });
    },
    onOutput(sessionId) {
      const entry = entries.get(sessionId);
      if (!entry) return;
      entry.machine.onOutput(now());
      reconcile(sessionId, entry);
    },
    onExit(sessionId, status) {
      const entry = entries.get(sessionId);
      if (!entry) return;
      entry.machine.onExit(now(), status);
      reconcile(sessionId, entry);
    },
    feedHook(sessionId, event) {
      const entry = entries.get(sessionId);
      if (!entry) return;
      entry.machine.onHook(now(), event);
      reconcile(sessionId, entry);
    },
    unregister(sessionId) {
      entries.delete(sessionId);
    },
    status(sessionId) {
      return entries.get(sessionId)?.machine.getStatus() ?? "exited";
    },
    onChange(cb) {
      cbs.add(cb);
      return () => cbs.delete(cb);
    },
    start() {
      if (hookTimer || tickTimer) return;
      hookTimer = setInterval(() => {
        for (const [id, entry] of entries) readHooks(id, entry);
      }, HOOK_POLL_MS);
      tickTimer = setInterval(() => {
        const t = now();
        for (const [id, entry] of entries) {
          if (entry.machine.tick(t)) reconcile(id, entry);
        }
      }, TICK_MS);
    },
    stop() {
      if (hookTimer) clearInterval(hookTimer);
      if (tickTimer) clearInterval(tickTimer);
      hookTimer = tickTimer = null;
    },
  };
}

/** Legacy entry point kept for the monitors barrel. Prefer createStatusTracker. */
export function startStatusMonitor(): { stop(): void } {
  throw new Error("status.startStatusMonitor: superseded by createStatusTracker (design §10.1)");
}
