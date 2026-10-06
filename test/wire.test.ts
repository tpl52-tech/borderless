import { test, expect, describe } from "bun:test";
import {
  FrameKind, FrameDecoder, encodeFrame, createFrameWriter, controlFrame, parseControl,
  ptyOutputFrame, type Frame,
} from "../src/shared/wire.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("frame codec", () => {
  test("encode/decode round-trip", () => {
    const frame: Frame = { kind: FrameKind.PtyOutput, sessionId: "sess-1", payload: enc.encode("hello") };
    const [out] = new FrameDecoder().push(encodeFrame(frame));
    expect(out).toBeDefined();
    expect(out!.kind).toBe(FrameKind.PtyOutput);
    expect(out!.sessionId).toBe("sess-1");
    expect(dec.decode(out!.payload)).toBe("hello");
  });

  test("empty sessionId and empty payload", () => {
    const [out] = new FrameDecoder().push(
      encodeFrame({ kind: FrameKind.Control, sessionId: "", payload: new Uint8Array(0) }),
    );
    expect(out!.sessionId).toBe("");
    expect(out!.payload.length).toBe(0);
  });

  test("decodes a frame split across many chunks", () => {
    const bytes = encodeFrame({ kind: FrameKind.PtyInput, sessionId: "abc", payload: enc.encode("payload-data") });
    const decoder = new FrameDecoder();
    const frames: Frame[] = [];
    for (const byte of bytes) frames.push(...decoder.push(new Uint8Array([byte])));
    expect(frames.length).toBe(1);
    expect(dec.decode(frames[0]!.payload)).toBe("payload-data");
  });

  test("decodes multiple frames from one chunk, retaining a partial tail", () => {
    const a = encodeFrame({ kind: FrameKind.PtyOutput, sessionId: "s", payload: enc.encode("one") });
    const b = encodeFrame({ kind: FrameKind.PtyOutput, sessionId: "s", payload: enc.encode("two") });
    const decoder = new FrameDecoder();
    // Feed a + b + first 3 bytes of a third frame.
    const partial = a.slice(0, 3);
    const combined = new Uint8Array(a.length + b.length + partial.length);
    combined.set(a, 0); combined.set(b, a.length); combined.set(partial, a.length + b.length);
    const frames = decoder.push(combined);
    expect(frames.length).toBe(2);
    expect(dec.decode(frames[0]!.payload)).toBe("one");
    expect(dec.decode(frames[1]!.payload)).toBe("two");
    // The partial tail completes when the rest arrives.
    const rest = a.slice(3);
    const more = decoder.push(rest);
    expect(more.length).toBe(1);
    expect(dec.decode(more[0]!.payload)).toBe("one");
  });

  test("control frame helpers", () => {
    const frame = controlFrame({ msg: "request", id: "1", type: "task.list", params: { x: 1 } });
    const msg = parseControl(frame.payload);
    expect(msg.msg).toBe("request");
    if (msg.msg === "request") {
      expect(msg.type).toBe("task.list");
      expect(msg.params).toEqual({ x: 1 });
    }
  });
});

describe("backpressure writer", () => {
  test("queues bytes the socket rejects, flushes on drain", () => {
    let accepted = 0; // socket accepts nothing until we "drain"
    const received: number[] = [];
    const socket = {
      write(data: Uint8Array): number {
        const n = Math.min(accepted, data.length);
        for (let i = 0; i < n; i++) received.push(data[i]!);
        return n;
      },
    };
    const writer = createFrameWriter(socket);
    writer.write(ptyOutputFrame("s", enc.encode("XYZ")));
    expect(writer.pending).toBeGreaterThan(0); // nothing accepted yet
    accepted = 1e9; // socket now accepts everything
    writer.flush();
    expect(writer.pending).toBe(0);
    // The flushed bytes decode back to the original frame.
    const [out] = new FrameDecoder().push(new Uint8Array(received));
    expect(dec.decode(out!.payload)).toBe("XYZ");
  });
});
