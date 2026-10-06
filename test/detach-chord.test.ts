import { test, expect, describe } from "bun:test";
import { createDetachChord, toInputBytes } from "../src/client/attach.ts";

const CTRL_B = 0x02;
function harness() {
  const forwarded: string[] = [];
  let detached = 0;
  const chord = createDetachChord({
    onDetach: () => { detached++; },
    onForward: (b) => forwarded.push(new TextDecoder().decode(b)),
  }, 800);
  return { chord, forwarded, detached: () => detached };
}

describe("detach chord (design §8.4)", () => {
  test("Ctrl-] (single press) -> detach", () => {
    const h = harness();
    h.chord.feed(new Uint8Array([0x1d]));
    expect(h.detached()).toBe(1);
    expect(h.forwarded).toEqual([]);
    h.chord.dispose();
  });

  test("two separate Ctrl-B reads -> detach", () => {
    const h = harness();
    h.chord.feed(new Uint8Array([CTRL_B]));
    h.chord.feed(new Uint8Array([CTRL_B]));
    expect(h.detached()).toBe(1);
    expect(h.forwarded).toEqual([]);
    h.chord.dispose();
  });

  test("two Ctrl-B coalesced into one read -> detach", () => {
    const h = harness();
    h.chord.feed(new Uint8Array([CTRL_B, CTRL_B]));
    expect(h.detached()).toBe(1);
    h.chord.dispose();
  });

  test("printable input is forwarded verbatim", () => {
    const h = harness();
    h.chord.feed(new TextEncoder().encode("hello"));
    expect(h.forwarded).toEqual(["hello"]);
    expect(h.detached()).toBe(0);
    h.chord.dispose();
  });

  test("a lone Ctrl-B is swallowed (prefix); a following key forwards the key, no detach", () => {
    const h = harness();
    h.chord.feed(new Uint8Array([CTRL_B]));       // prefix, swallowed
    h.chord.feed(new TextEncoder().encode("x"));  // not a second Ctrl-B
    expect(h.detached()).toBe(0);
    expect(h.forwarded).toEqual(["x"]);           // the dropped prefix is not forwarded
    h.chord.dispose();
  });

  test("toInputBytes: a utf8 string chunk (Ink's mode) becomes its real bytes, not NUL", () => {
    // The bug: Ink leaves stdin in utf8 mode, so 'data' yields strings; new Uint8Array("a") was [0].
    expect([...toInputBytes("a")]).toEqual([0x61]);
    expect([...toInputBytes("hello")]).toEqual([...new TextEncoder().encode("hello")]);
    expect([...toInputBytes("\r")]).toEqual([0x0d]); // Enter
    expect([...toInputBytes("\x7f")]).toEqual([0x7f]); // backspace
    expect([...toInputBytes("\x1b[A")]).toEqual([0x1b, 0x5b, 0x41]); // up arrow
    expect([...toInputBytes("\x02")]).toEqual([0x02]); // Ctrl-B still detects as the chord prefix
  });

  test("toInputBytes: a Buffer/Uint8Array chunk passes through verbatim", () => {
    expect([...toInputBytes(new Uint8Array([0x1d]))]).toEqual([0x1d]);
    expect([...toInputBytes(Buffer.from([1, 2, 3]))]).toEqual([1, 2, 3]);
  });

  test("prefix expires after the window (no detach on a later lone Ctrl-B)", async () => {
    const forwarded: string[] = [];
    let detached = 0;
    const chord = createDetachChord({ onDetach: () => { detached++; }, onForward: (b) => forwarded.push(String(b)) }, 20);
    chord.feed(new Uint8Array([CTRL_B]));
    await Bun.sleep(40); // window lapses
    chord.feed(new Uint8Array([CTRL_B])); // a fresh prefix, not a second tap
    expect(detached).toBe(0);
    chord.dispose();
  });
});
