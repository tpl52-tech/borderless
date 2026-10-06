/**
 * Daemon client — the socket connection the TUI and CLI use (design §8, §19 Daemon client).
 *
 * Connects to ~/.agent-orchestrator/daemon.sock, sends control requests, receives events, and carries
 * raw PTY bytes during attach. MILESTONE 1: request/response correlation, event + PTY-output
 * delivery, and backpressure-aware writes. The forever-reconnect-with-backoff behavior (design §19)
 * layers on top in the TUI; this module exposes a single live connection plus a `closed` promise.
 */

import {
  FrameKind, FrameDecoder, createFrameWriter, controlFrame, parseControl,
  ptyInputFrame, ptyResizeFrame, type FrameWriter, type ControlEvent, type RequestType,
} from "../shared/wire.ts";

export interface DaemonClient {
  request<T = unknown>(type: RequestType, params?: unknown): Promise<T>;
  on(fn: (event: ControlEvent) => void): () => void;
  onPtyOutput(fn: (sessionId: string, bytes: Uint8Array) => void): () => void;
  sendInput(sessionId: string, bytes: Uint8Array): void;
  sendResize(sessionId: string, cols: number, rows: number): void;
  /** Resolves when the connection closes. */
  readonly closed: Promise<void>;
  close(): void;
}

interface Pending {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
}

export async function connectDaemon(socketPath: string): Promise<DaemonClient> {
  const decoder = new FrameDecoder();
  const pending = new Map<string, Pending>();
  const eventListeners = new Set<(event: ControlEvent) => void>();
  const ptyListeners = new Set<(sessionId: string, bytes: Uint8Array) => void>();
  let writer: FrameWriter;
  let closeResolve!: () => void;
  const closed = new Promise<void>((res) => { closeResolve = res; });

  const failAll = (err: Error) => {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };

  const socket = await Bun.connect({
    unix: socketPath,
    socket: {
      data(_s, chunk) {
        for (const frame of decoder.push(chunk)) {
          if (frame.kind === FrameKind.PtyOutput) {
            for (const fn of ptyListeners) fn(frame.sessionId, frame.payload);
            continue;
          }
          if (frame.kind !== FrameKind.Control) continue;
          const msg = parseControl(frame.payload);
          if (msg.msg === "response") {
            const p = pending.get(msg.id);
            if (!p) continue;
            pending.delete(msg.id);
            if (msg.ok) p.resolve(msg.data);
            else p.reject(new Error(msg.error ?? "request failed"));
          } else if (msg.msg === "event") {
            for (const fn of eventListeners) fn({ type: msg.type, data: msg.data });
          }
        }
      },
      drain(_s) {
        writer.flush();
      },
      close() {
        failAll(new Error("daemon connection closed"));
        closeResolve();
      },
      error(_s, err) {
        failAll(err instanceof Error ? err : new Error(String(err)));
      },
    },
  });

  writer = createFrameWriter(socket);

  return {
    request<T = unknown>(type: RequestType, params?: unknown): Promise<T> {
      const id = crypto.randomUUID();
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (d: unknown) => void, reject });
        writer.write(controlFrame({ msg: "request", id, type, params }));
      });
    },
    on(fn) {
      eventListeners.add(fn);
      return () => eventListeners.delete(fn);
    },
    onPtyOutput(fn) {
      ptyListeners.add(fn);
      return () => ptyListeners.delete(fn);
    },
    sendInput(sessionId, bytes) {
      writer.write(ptyInputFrame(sessionId, bytes));
    },
    sendResize(sessionId, cols, rows) {
      writer.write(ptyResizeFrame(sessionId, { cols, rows }));
    },
    closed,
    close() {
      socket.end();
    },
  };
}
