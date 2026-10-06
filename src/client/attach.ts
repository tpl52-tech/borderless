/**
 * Attach / detach — raw byte passthrough (design §8.4, §8.5).
 *
 * MILESTONE 1 core: raw stdin passthrough to the daemon, PTY output to stdout, SIGWINCH -> resize, a
 * double-Ctrl-B detach chord within 800ms, and the unconditional terminal-mode reset on exit. The
 * fuller loop (braille spinner, Kitty-protocol chord decoding, focus-in Ctrl-L, 250ms resync) layers
 * on in later polish; the framing and safety contract is here.
 *
 * Terminal reset (§8.5): unconditionally disable mouse modes 1000/1002/1003/1005/1006/1015, focus
 * 1004, bracketed paste 2004, show cursor, wrap on, SGR reset FIRST, leave alt screen (1049) LAST.
 */

import type { DaemonClient } from "./daemon-client.ts";
import { connectDaemon } from "./daemon-client.ts";
import { paths } from "../shared/paths.ts";

export const DETACH_CHORD_MS = 800;
const CTRL_B = 0x02;
const CTRL_RBRACKET = 0x1d; // Ctrl-] — single-key detach (classic telnet/ssh escape; tmux leaves it alone)
const ESC = "\x1b";

export interface ChordHandlers {
  onDetach(): void;
  onForward(bytes: Uint8Array): void;
}

const INPUT_ENCODER = new TextEncoder();

/**
 * Normalize a stdin 'data' chunk to raw bytes. Ink leaves process.stdin in 'utf8' mode (it calls
 * setEncoding('utf8') on mount and never resets it), so once we switch stdin to flowing the 'data'
 * event delivers STRINGS, not Buffers — and `new Uint8Array(someString)` yields all-zero bytes, so
 * every keystroke would reach the agent as NUL ("can't type"). Encode strings as UTF-8; still accept
 * Buffers/Uint8Arrays in case the encoding was ever reset. (design §8.4)
 */
export function toInputBytes(chunk: string | Uint8Array): Uint8Array {
  return typeof chunk === "string" ? INPUT_ENCODER.encode(chunk) : new Uint8Array(chunk);
}

/**
 * Detach triggers (design §8.4):
 *   - Ctrl-] (single press) — the simple, always-available escape; survives running inside tmux/screen,
 *     which capture Ctrl-B as their own prefix.
 *   - double Ctrl-B within the window — whether delivered as two reads or coalesced into one chunk.
 * A lone Ctrl-B is swallowed as the prefix; a prefix followed by another key forwards that key.
 * Pure + testable.
 */
export function createDetachChord(h: ChordHandlers, windowMs = DETACH_CHORD_MS) {
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = () => { if (timer) { clearTimeout(timer); timer = null; } pending = false; };
  const isAllCtrlB = (b: Uint8Array) => b.length > 0 && b.every((x) => x === CTRL_B);
  return {
    feed(chunk: Uint8Array): void {
      // Ctrl-] alone -> detach (simple, tmux-proof).
      if (chunk.length === 1 && chunk[0] === CTRL_RBRACKET) { clear(); h.onDetach(); return; }
      // Two (or more) Ctrl-B coalesced into one read -> detach.
      if (chunk.length >= 2 && isAllCtrlB(chunk)) { clear(); h.onDetach(); return; }
      if (chunk.length === 1 && chunk[0] === CTRL_B) {
        if (pending) { clear(); h.onDetach(); return; } // second within the window
        pending = true;
        timer = setTimeout(clear, windowMs);
        return; // swallow a lone prefix
      }
      if (pending) clear(); // prefix + other key -> drop the swallowed prefix, forward the rest
      h.onForward(chunk);
    },
    dispose(): void { if (timer) clearTimeout(timer); },
  };
}

/** Emit the unconditional terminal-mode reset sequence to a TTY (design §8.5). No-op on non-TTY. */
export function terminalReset(out: NodeJS.WriteStream = process.stdout): void {
  if (!out.isTTY) return;
  const seq =
    `${ESC}[0m` + // SGR reset first
    `${ESC}[?1000l${ESC}[?1002l${ESC}[?1003l${ESC}[?1005l${ESC}[?1006l${ESC}[?1015l` + // mouse
    `${ESC}[?1004l` + // focus reporting
    `${ESC}[?2004l` + // bracketed paste
    `${ESC}[?25h` + // show cursor
    `${ESC}[?7h` + // wrap on
    `${ESC}[?1049l`; // leave alt screen LAST
  out.write(seq);
}

/** Clear screen + scrollback (separate from reset — only correct when something will repaint). */
export function clearScreen(out: NodeJS.WriteStream = process.stdout): void {
  if (!out.isTTY) return;
  out.write(`${ESC}[H${ESC}[2J${ESC}[3J`);
}

export interface AttachIO {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
}

/**
 * Attach the real terminal to a session over an existing daemon connection. Resolves on detach
 * (double Ctrl-B) or when the daemon connection closes.
 */
export async function attachSession(
  client: DaemonClient,
  sessionId: string,
  io: AttachIO = { stdin: process.stdin, stdout: process.stdout },
): Promise<void> {
  const { stdin, stdout } = io;
  const cols = stdout.columns ?? 80;
  const rows = stdout.rows ?? 24;

  let done!: () => void;
  const finished = new Promise<void>((res) => { done = res; });

  const unsubOutput = client.onPtyOutput((sid, bytes) => {
    if (sid === sessionId) stdout.write(bytes);
  });

  const chord = createDetachChord({
    onDetach: () => void detach(),
    onForward: (bytes) => client.sendInput(sessionId, bytes),
  });
  const onStdin = (chunk: Buffer | string) => chord.feed(toInputBytes(chunk));

  const onResize = () => {
    client.sendResize(sessionId, stdout.columns ?? 80, stdout.rows ?? 24);
  };

  let rawReassert: ReturnType<typeof setTimeout> | null = null;
  const enableRaw = () => { if (stdin.isTTY) { try { stdin.setRawMode(true); } catch { /* not a tty */ } } };

  // The agent process ending while we're attached — a resume that finds no conversation, a crash, or just
  // the agent exiting — must hand control back to the dashboard. Without this the terminal is stranded in
  // raw mode, attached to a corpse, with keystrokes forwarded into the void (design §8.4).
  const offExit = client.on((ev) => {
    if (ev.type === "session.exit" && (ev.data as { sessionId?: string } | undefined)?.sessionId === sessionId) {
      cleanup();
      done();
    }
  });

  let ended = false;
  const cleanup = () => {
    if (ended) return; // idempotent: session-exit, detach, and connection-close can all race here
    ended = true;
    offExit();
    unsubOutput();
    stdin.removeListener("data", onStdin);
    process.removeListener("SIGWINCH", onResize);
    if (rawReassert) clearTimeout(rawReassert);
    chord.dispose();
    if (stdin.isTTY) { try { stdin.setRawMode(false); } catch { /* ignore */ } }
    stdin.pause();
    terminalReset(stdout);
    clearScreen(stdout);
  };

  const detach = async () => {
    try { await client.request("session.detach"); } catch { /* connection may be gone */ }
    cleanup();
    done();
  };

  // If the connection drops mid-attach, restore the terminal and resolve.
  void client.closed.then(() => { cleanup(); done(); });

  await client.request("session.attach", { sessionId, cols, rows });

  // The session may have exited during the attach round-trip (e.g. a resume that instantly fails). If so,
  // cleanup already ran — don't re-grab the terminal, just resolve back to the dashboard.
  if (ended) return finished;

  // Raw mode + flowing, ref'd so stdin wakes the loop (design §8.4). Re-assert once after a tick in case
  // the caller (Ink) restored cooked mode during its own teardown AFTER we enabled it — the handoff race.
  enableRaw();
  (stdin as unknown as { ref?: () => void }).ref?.();
  stdin.resume();
  stdin.on("data", onStdin);
  process.on("SIGWINCH", onResize);
  rawReassert = setTimeout(enableRaw, 50);

  // Snap the session's PTY to this terminal's size. A live session keeps its 80x24 spawn geometry, so
  // without this the agent renders in a small box until the next window change. Sending the resize from
  // the client means it works against an already-running daemon too (no daemon restart needed). (§8.4)
  onResize();

  return finished;
}

/** Standalone: connect, attach, detach, close. */
export async function attach(sessionId: string): Promise<void> {
  const client = await connectDaemon(paths().socket);
  try {
    await attachSession(client, sessionId);
  } finally {
    client.close();
  }
}
