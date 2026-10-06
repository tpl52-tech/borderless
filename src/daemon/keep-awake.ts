/**
 * Keep-awake controller (design §5.1, §18 `ao awake`).
 *
 * A bounded `caffeinate -i` so the Mac does not sleep while agents work — run via the daemon so it
 * outlives the command. Default 90 min, max 8 h. Disposed on shutdown (never leave the Mac pinned
 * awake, design §5.3).
 */

export const KEEP_AWAKE_DEFAULT_MS = 90 * 60 * 1000;
export const KEEP_AWAKE_MAX_MS = 8 * 60 * 60 * 1000;

export interface KeepAwake {
  set(durationMs: number | "off"): void;
  remainingMs(): number;
  dispose(): void;
}

/** TODO(step 1): implement via `caffeinate -i` with a bounded timer. */
export function createKeepAwake(): KeepAwake {
  throw new Error("keep-awake.createKeepAwake: not implemented (design §5.1)");
}
