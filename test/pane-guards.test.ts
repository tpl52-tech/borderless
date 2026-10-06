import { test, expect, describe } from "bun:test";
import {
  plain, looksBusy, hasPendingInput, looksLikeMenu, analyzePane, fingerprint, isStranded,
} from "../src/daemon/nudge/pane-guards.ts";

describe("plain / dim stripping (design §10.5)", () => {
  test("dim runs (greyed placeholders) are removed with their content", () => {
    const captured = "real \x1b[2mgreyed placeholder\x1b[22m text";
    expect(plain(captured)).toBe("real  text");
  });
  test("remaining ANSI is stripped", () => {
    expect(plain("\x1b[31mred\x1b[0m")).toBe("red");
  });
});

describe("looksBusy (design §10.5)", () => {
  test("'esc to interrupt' means busy", () => {
    expect(looksBusy("Working… (esc to interrupt)")).toBe(true);
  });
  test("a spinner line with an ellipsis + h/m/s duration means busy", () => {
    expect(looksBusy("✻ Thinking… (12s)")).toBe(true);
    expect(looksBusy("✻ Compacting… (1h2m)")).toBe(true); // unit class must include h
  });
  test("plain idle text is not busy", () => {
    expect(looksBusy("Done. Anything else?")).toBe(false);
  });
});

describe("hasPendingInput (design §10.5)", () => {
  test("the last prompt row with text is pending", () => {
    expect(hasPendingInput("some output\n> half-typed thing")).toBe(true);
    expect(hasPendingInput("some output\n> ")).toBe(false);
    expect(hasPendingInput("❯ hello")).toBe(true);
  });
});

describe("looksLikeMenu (design §10.5)", () => {
  test("footer + a numbered option is a menu", () => {
    const menu = "Choose:\n  1. Yes\n  2. No\n(enter to confirm, esc to cancel)";
    expect(looksLikeMenu(menu)).toBe(true);
  });
  test("no footer or no number is not a menu", () => {
    expect(looksLikeMenu("just some prose with a 1. in it")).toBe(false);
  });
  test("cleared-dialog exception (empty prompt row + blank line) is not a menu", () => {
    const cleared = "1. old option\n(enter to confirm)\n> \n\ntail";
    expect(looksLikeMenu(cleared)).toBe(false);
  });
});

describe("analyzePane", () => {
  test("combines the guards over a capture", () => {
    const a = analyzePane("Working… (esc to interrupt)\n> ");
    expect(a.looksBusy).toBe(true);
    expect(a.hasPendingInput).toBe(false);
  });
});

describe("stranded-text recognition (the 58-copies rule, §10.5)", () => {
  test("fingerprint needs >= 12 chars", () => {
    expect(fingerprint("short")).toBeNull();
    expect(fingerprint("this is a long enough first line")).toBe("this is a long enough first line");
  });
  test("isStranded detects our own body sitting in the pane", () => {
    const body = "please fix the failing build and push";
    const pane = "> please fix the failing build and push";
    expect(isStranded(pane, body)).toBe(true);
    expect(isStranded("> something totally different here", body)).toBe(false);
  });
});
