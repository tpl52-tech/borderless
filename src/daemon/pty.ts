/**
 * PTY sessions (design §8.1).
 *
 * Spawned with Bun's inline terminal option (the ONLY form that makes the PTY the child's
 * controlling terminal so SIGWINCH and signals work). A 256 KB replay ring buffer; trimming cuts at
 * a SAFE BOUNDARY (byte after a newline within a 4 KB scan window, else the first ESC, else skip
 * UTF-8 continuation bytes) — a blind slice mid-escape makes the terminal swallow following
 * printable bytes as parameters and the screen drifts on scroll.
 *
 * Output listeners are multiplexed per attached client. Resize is a NO-OP when geometry is unchanged
 * (SIGWINCH makes agent TUIs repaint). Exit code 0/null -> `exited`, else `error`.
 */

export const REPLAY_BUFFER_BYTES = 256 * 1024;
const TRIM_SCAN_WINDOW = 4 * 1024;

export type ExitStatus = "exited" | "error";

export interface PtyExit {
  code: number | null;
  status: ExitStatus;
}

/** A live local PTY (or the ssh-mirror PTY for a remote agent). */
export interface PtySession {
  readonly sessionId: string;
  readonly pid: number;
  write(bytes: Uint8Array): void;
  resize(cols: number, rows: number): void;
  /** the trimmed replay ring buffer to send a freshly-attached local client. */
  replay(): Uint8Array;
  addOutputListener(fn: (bytes: Uint8Array) => void): () => void;
  kill(signal?: number | NodeJS.Signals): void;
  readonly exited: Promise<PtyExit>;
}

export interface SpawnPtyOptions {
  sessionId: string;
  argv: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  cols?: number;
  rows?: number;
  name?: string;
  onExit?: (exit: PtyExit) => void;
}

/** Spawn a local PTY-backed subprocess (design §8.1). */
export function spawnPty(opts: SpawnPtyOptions): PtySession {
  let replayBuf: Uint8Array = new Uint8Array(0);
  const listeners = new Set<(bytes: Uint8Array) => void>();
  let cols = opts.cols ?? 80;
  let rows = opts.rows ?? 24;

  const proc = Bun.spawn(opts.argv, {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) } as Record<string, string | undefined>,
    terminal: {
      cols,
      rows,
      name: opts.name ?? "xterm-256color",
      data(_term, data) {
        // Copy the chunk (Bun may reuse the backing buffer) before it lands anywhere durable.
        const chunk = data.slice();
        replayBuf = trimReplayBuffer(concat(replayBuf, chunk));
        for (const fn of listeners) fn(chunk);
      },
    },
  });

  const term = proc.terminal;
  if (!term) throw new Error("pty.spawnPty: PTY not attached (terminal option unsupported here)");

  const exited: Promise<PtyExit> = proc.exited.then((code) => {
    const exit: PtyExit = { code, status: code === 0 || code === null ? "exited" : "error" };
    opts.onExit?.(exit);
    return exit;
  });

  return {
    sessionId: opts.sessionId,
    pid: proc.pid,
    write(bytes) {
      term.write(bytes);
    },
    resize(nextCols, nextRows) {
      if (nextCols === cols && nextRows === rows) return; // no-op on unchanged geometry
      cols = nextCols;
      rows = nextRows;
      term.resize(nextCols, nextRows);
    },
    replay() {
      return replayBuf;
    },
    addOutputListener(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    kill(signal = "SIGTERM") {
      proc.kill(signal as number);
    },
    exited,
  };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Trim a replay buffer to <= REPLAY_BUFFER_BYTES, cutting at a SAFE BOUNDARY (design §8.1):
 * prefer the byte after a newline within a 4 KB scan window, else the first ESC, else skip UTF-8
 * continuation bytes so we never slice mid-escape or mid-codepoint.
 */
export function trimReplayBuffer(buf: Uint8Array): Uint8Array {
  if (buf.length <= REPLAY_BUFFER_BYTES) return buf;
  const start = buf.length - REPLAY_BUFFER_BYTES;
  const scanEnd = Math.min(buf.length, start + TRIM_SCAN_WINDOW);

  for (let k = start; k < scanEnd; k++) {
    if (buf[k] === 0x0a) return buf.slice(k + 1); // byte after a newline
  }
  for (let k = start; k < scanEnd; k++) {
    if (buf[k] === 0x1b) return buf.slice(k); // first ESC
  }
  let s = start;
  while (s < buf.length && (buf[s]! & 0xc0) === 0x80) s++; // skip UTF-8 continuation bytes
  return buf.slice(s);
}
