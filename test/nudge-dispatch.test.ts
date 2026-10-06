import { test, expect, describe } from "bun:test";
import { dispatchDecision, onFailedCapture } from "../src/daemon/nudge/dispatch.ts";
import type { PaneAnalysis } from "../src/daemon/nudge/pane-guards.ts";

const pane = (o: Partial<PaneAnalysis>): PaneAnalysis =>
  ({ hasPendingInput: false, looksBusy: false, looksLikeMenu: false, ...o });

describe("dispatchDecision (design §10.5 dispatch order)", () => {
  test("menu -> drop (holding can't help)", () => {
    expect(dispatchDecision(pane({ looksLikeMenu: true }), false)).toBe("drop-menu");
    expect(dispatchDecision(pane({ looksLikeMenu: true, looksBusy: true }), true)).toBe("drop-menu");
  });
  test("our own text stranded and not busy -> press Enter only (never retype)", () => {
    expect(dispatchDecision(pane({}), true)).toBe("press-enter-only");
  });
  test("stranded but busy -> hold (don't press into a busy pane)", () => {
    expect(dispatchDecision(pane({ looksBusy: true }), true)).toBe("hold");
  });
  test("busy or pending input -> hold", () => {
    expect(dispatchDecision(pane({ looksBusy: true }), false)).toBe("hold");
    expect(dispatchDecision(pane({ hasPendingInput: true }), false)).toBe("hold");
  });
  test("clear pane -> type", () => {
    expect(dispatchDecision(pane({}), false)).toBe("type");
  });
});

describe("onFailedCapture (design §10.5 asymmetry)", () => {
  test("box proceeds, Mac holds", () => {
    expect(onFailedCapture("box")).toBe("type");
    expect(onFailedCapture("mac")).toBe("hold");
  });
});
