import { test, expect, describe } from "bun:test";
import {
  CONSOLE_SCREENS, NAV_LABELS, crumbLabel, cell, clampCursor, moveCursor, attachTarget, editInput,
  heroStats, readyRows, needsYouRows, stateTone, kindTone, kindLabel,
  type SweepRow,
} from "../src/client/console-model.ts";

const sweep = (over: Partial<SweepRow> = {}): SweepRow => ({
  ticketKey: "COR-1", kind: "in_review", state: "reviewing", owner: null,
  prNumber: null, cycles: 0, reason: null, sessionId: null, ...over,
});

describe("CONSOLE_SCREENS registry + nav (PRD §11)", () => {
  test("the five screens, in number-key order, each bound to a read request", () => {
    expect(CONSOLE_SCREENS.map((s) => s.key)).toEqual(["sweeps", "boards", "assign", "lead_desk", "roster"]);
    expect(CONSOLE_SCREENS.map((s) => s.request)).toEqual(["sweep.list", "boards.get", "assign.suggest", "lead.desk", "roster.get"]);
    expect(CONSOLE_SCREENS.every((s) => s.label && s.nav && s.empty)).toBe(true);
  });
  test("NAV_LABELS append ASK after the five screens; crumb follows the index", () => {
    expect(NAV_LABELS).toEqual(["SWEEPS", "BOARDS", "ASSIGN", "LEAD_DESK", "ROSTER", "ASK"]);
    expect(crumbLabel(0)).toBe("SWEEPS");
    expect(crumbLabel(5)).toBe("ASK");
    expect(crumbLabel(99)).toBe("SWEEPS"); // out of range falls back to the first
  });
});

describe("cell (fixed-width columns)", () => {
  test("pads left-aligned to width", () => {
    expect(cell("COR-1", 8)).toBe("COR-1   ");
    expect(cell("", 3)).toBe("   ");
  });
  test("pads right-aligned to width", () => {
    expect(cell("8", 3, "right")).toBe("  8");
  });
  test("truncates with a trailing ellipsis", () => {
    expect(cell("notifications table", 8)).toBe("notific…");
    expect(cell("abc", 3)).toBe("abc"); // exact fit, no ellipsis
  });
  test("degenerate widths", () => {
    expect(cell("abc", 0)).toBe("");
    expect(cell("abc", 1)).toBe("a");
  });
});

describe("heroStats + partitions (the SWEEPS numbers + side panels, all from one list)", () => {
  const rows = [
    sweep({ state: "ready" }),
    sweep({ state: "ready" }),
    sweep({ state: "needs_human" }),
    sweep({ state: "reviewing" }),
    sweep({ state: "queued" }),
    sweep({ state: "merged" }),
  ];
  test("counts scope / active / ready / needs-you", () => {
    expect(heroStats(rows)).toEqual({ inScope: 6, active: 2, ready: 2, needsYou: 1 });
    expect(heroStats([])).toEqual({ inScope: 0, active: 0, ready: 0, needsYou: 0 });
  });
  test("readyRows / needsYouRows select the right subsets", () => {
    expect(readyRows(rows).map((r) => r.state)).toEqual(["ready", "ready"]);
    expect(needsYouRows(rows).map((r) => r.state)).toEqual(["needs_human"]);
  });
});

describe("state / kind tones (match the HTML mock)", () => {
  test("state tone", () => {
    expect(stateTone("ready")).toBe("green");
    expect(stateTone("merged")).toBe("green");
    expect(stateTone("needs_human")).toBe("pink");
    expect(stateTone("failed")).toBe("red");
    expect(stateTone("queued")).toBe("dim");
    expect(stateTone("ci")).toBe("dim");
    expect(stateTone("reviewing")).toBe("ink");
    expect(stateTone("implementing")).toBe("ink");
  });
  test("kind tone + label", () => {
    expect(kindTone("rescue")).toBe("pink");
    expect(kindTone("in_review")).toBe("ink2");
    expect(kindLabel("rescue")).toBe("rescue");
    expect(kindLabel("in_review")).toBe("review");
  });
});

describe("cursor nav (no wrap — rows don't jump the cursor)", () => {
  test("clampCursor keeps the cursor in range", () => {
    expect(clampCursor(5, 0)).toBe(0);
    expect(clampCursor(-2, 3)).toBe(0);
    expect(clampCursor(9, 3)).toBe(2);
    expect(clampCursor(1, 3)).toBe(1);
  });
  test("moveCursor clamps at both ends", () => {
    expect(moveCursor(0, -1, 3)).toBe(0);
    expect(moveCursor(2, +1, 3)).toBe(2);
    expect(moveCursor(1, +1, 3)).toBe(2);
    expect(moveCursor(0, +1, 0)).toBe(0);
  });
});

describe("attachTarget — only a SWEEPS row with a live session is attachable", () => {
  const sweeps: SweepRow[] = [
    sweep({ ticketKey: "COR-9", kind: "rescue", state: "implementing", sessionId: "sess-1" }),
    sweep({ ticketKey: "COR-8", state: "needs_human", prNumber: 4, cycles: 2, reason: "no PR", sessionId: null }),
  ];
  test("returns the session for a sweep row that has one, else null", () => {
    expect(attachTarget("sweeps", sweeps, 0)).toBe("sess-1");
    expect(attachTarget("sweeps", sweeps, 1)).toBeNull(); // no session
    expect(attachTarget("sweeps", sweeps, 9)).toBeNull(); // out of range
  });
  test("never attachable on a non-SWEEPS screen", () => {
    expect(attachTarget("boards", [{ ticketKey: "COR-1" }], 0)).toBeNull();
    expect(attachTarget("roster", [{ name: "x" }], 0)).toBeNull();
  });
});

describe("editInput (ASK pane single-line editor, PRD §10)", () => {
  test("appends a lone printable char", () => {
    expect(editInput("who", "o", {})).toBe("whoo");
    expect(editInput("", "W", {})).toBe("W");
    expect(editInput("a", " ", {})).toBe("a ");
  });
  test("backspace / delete drop the last char (empty stays empty)", () => {
    expect(editInput("abc", "", { backspace: true })).toBe("ab");
    expect(editInput("abc", "", { delete: true })).toBe("ab");
    expect(editInput("", "", { backspace: true })).toBe("");
  });
  test("ignores control keys, DEL, multi-char input, and empty input", () => {
    expect(editInput("x", "", {})).toBe("x");          // empty (arrow/enter carry no printable)
    expect(editInput("x", "\t", {})).toBe("x");        // tab (control)
    expect(editInput("x", "\x1b[A", {})).toBe("x");    // an arrow escape sequence, not a paste
    expect(editInput("x", "\x7f", {})).toBe("x");      // DEL
  });
});
