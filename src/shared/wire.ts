/**
 * Wire protocol over the Unix-domain socket (design §8.2).
 *
 * One socket carries JSON control messages AND raw PTY bytes, interleaved.
 * Frame layout (no JSON/base64 on the hot path):
 *
 *   [1 byte kind][1 byte sessionId length][4 bytes payload length, big-endian][sessionId][payload]
 *
 * An incremental parser keeps partial tails. Backpressure: Bun's socket write returns the number
 * of bytes accepted and silently drops the rest — every frame write MUST go through a writer
 * wrapper that queues the tail and flushes on drain, or streams desync.
 */

export enum FrameKind {
  Control = 0, // JSON request/response/event
  PtyOutput = 1, // raw bytes daemon -> client
  PtyInput = 2, // raw bytes client -> daemon
  PtyResize = 3, // JSON { cols, rows }
}

export interface Frame {
  kind: FrameKind;
  sessionId: string; // "" for daemon-scoped control frames
  payload: Uint8Array;
}

export const HEADER_SIZE = 6; // 1 (kind) + 1 (sid len) + 4 (payload len)
export const MAX_SESSION_ID_BYTES = 255;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/** Encode a single frame to bytes (design §8.2). */
export function encodeFrame(frame: Frame): Uint8Array {
  const sid = encoder.encode(frame.sessionId);
  if (sid.length > MAX_SESSION_ID_BYTES) {
    throw new Error(`wire.encodeFrame: sessionId too long (${sid.length} > ${MAX_SESSION_ID_BYTES})`);
  }
  const out = new Uint8Array(HEADER_SIZE + sid.length + frame.payload.length);
  const view = new DataView(out.buffer);
  out[0] = frame.kind;
  out[1] = sid.length;
  view.setUint32(2, frame.payload.length, false); // big-endian
  out.set(sid, HEADER_SIZE);
  out.set(frame.payload, HEADER_SIZE + sid.length);
  return out;
}

// ---------------------------------------------------------------------------
// Incremental decoding
// ---------------------------------------------------------------------------

/**
 * Incremental frame decoder. Feed it socket chunks; it yields complete frames and retains a
 * partial tail across calls.
 */
export class FrameDecoder {
  private buf: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): Frame[] {
    this.buf = concat(this.buf, chunk);
    const frames: Frame[] = [];
    let offset = 0;

    while (this.buf.length - offset >= HEADER_SIZE) {
      const view = new DataView(this.buf.buffer, this.buf.byteOffset + offset, HEADER_SIZE);
      const kind = view.getUint8(0) as FrameKind;
      const sidLen = view.getUint8(1);
      const payloadLen = view.getUint32(2, false);
      const total = HEADER_SIZE + sidLen + payloadLen;
      if (this.buf.length - offset < total) break; // wait for more bytes

      const sidStart = offset + HEADER_SIZE;
      const payloadStart = sidStart + sidLen;
      const sessionId = sidLen === 0 ? "" : decoder.decode(this.buf.subarray(sidStart, payloadStart));
      // Copy the payload out so it survives the next compaction of `buf`.
      const payload = this.buf.slice(payloadStart, payloadStart + payloadLen);
      frames.push({ kind, sessionId, payload });
      offset = payloadStart + payloadLen;
    }

    // Retain the unparsed tail.
    this.buf = offset === 0 ? this.buf : this.buf.slice(offset);
    return frames;
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// ---------------------------------------------------------------------------
// Control & PTY frame helpers
// ---------------------------------------------------------------------------

export interface ControlRequest {
  id: string;
  type: string; // see RequestType below
  params?: unknown;
}

export interface ControlResponse {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface ControlEvent {
  type: EventType;
  data: unknown;
}

export type ControlMessage =
  | ({ msg: "request" } & ControlRequest)
  | ({ msg: "response" } & ControlResponse)
  | ({ msg: "event" } & ControlEvent);

/** Server-pushed event types (design §8.2). */
export type EventType =
  | "snapshot"
  | "session.status"
  | "session.exit"
  | "session.openUrl"
  | "workitems.changed"
  | "workitem.transition"
  | "autonomy.acted"
  | "linear.changed";

/** The request surface (design §8.3). No auth: filesystem permissions on the socket protect it. */
export type RequestType =
  | "task.list" | "task.create" | "task.update" | "task.close" | "task.reopen"
  | "session.list" | "session.spawn" | "session.rename" | "session.setPlanning"
  | "session.attach" | "session.detach" | "session.resume" | "session.prune"
  | "session.kill" | "session.close" | "session.remove" | "session.files"
  | "session.nudge" | "session.updateBranch" | "session.queue" | "session.queue.set"
  | "session.interrupt"
  | "snapshot.get" | "tool.capabilities" | "keepawake.set"
  | "autonomy.log" | "autonomy.extend"
  | "game.scores"
  | "workitem.list" | "workitem.refresh" | "workitem.add" | "workitem.remove"
  | "workitem.action"
  | "project.setHidden" | "linear.refresh" | "linear.list"
  | "sweep.scanInReview" | "rescue.scan" | "rescue.authorize"
  | "boards.get" | "assign.suggest" | "lead.desk" | "lead.delegate" | "ask.run"
  | "sweep.list" | "roster.get"
  | "usage.get" | "quota.get";

export function controlFrame(msg: ControlMessage): Frame {
  return { kind: FrameKind.Control, sessionId: "", payload: encoder.encode(JSON.stringify(msg)) };
}

export function parseControl(payload: Uint8Array): ControlMessage {
  return JSON.parse(decoder.decode(payload)) as ControlMessage;
}

export function ptyOutputFrame(sessionId: string, bytes: Uint8Array): Frame {
  return { kind: FrameKind.PtyOutput, sessionId, payload: bytes };
}

export function ptyInputFrame(sessionId: string, bytes: Uint8Array): Frame {
  return { kind: FrameKind.PtyInput, sessionId, payload: bytes };
}

export interface Resize {
  cols: number;
  rows: number;
}

export function ptyResizeFrame(sessionId: string, size: Resize): Frame {
  return { kind: FrameKind.PtyResize, sessionId, payload: encoder.encode(JSON.stringify(size)) };
}

export function parseResize(payload: Uint8Array): Resize {
  return JSON.parse(decoder.decode(payload)) as Resize;
}

// ---------------------------------------------------------------------------
// Backpressure-aware writer
// ---------------------------------------------------------------------------

/** The minimal shape of a Bun socket we write through. */
export interface WritableSocket {
  write(data: Uint8Array): number;
}

/**
 * A backpressure-aware frame writer. Every frame write goes through here: it queues the bytes that
 * the socket did not accept and flushes them on drain. Call {@link FrameWriter.flush} from the
 * socket's `drain` handler.
 */
export interface FrameWriter {
  write(frame: Frame): void;
  /** Flush any queued tail; call from the socket `drain` event. */
  flush(): void;
  /** Bytes still queued (0 when fully flushed). */
  readonly pending: number;
}

export function createFrameWriter(socket: WritableSocket): FrameWriter {
  let queue: Uint8Array = new Uint8Array(0);

  const flush = (): void => {
    if (queue.length === 0) return;
    const written = socket.write(queue);
    if (written >= queue.length) {
      queue = new Uint8Array(0);
    } else if (written > 0) {
      queue = queue.slice(written);
    }
  };

  return {
    write(frame: Frame): void {
      queue = concat(queue, encodeFrame(frame));
      flush();
    },
    flush,
    get pending(): number {
      return queue.length;
    },
  };
}
