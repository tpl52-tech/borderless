import { test, expect, describe } from "bun:test";
import {
  CONSOLE_SCREENS, formatRow, clampCursor, moveCursor, attachTarget,
  type SweepRow,
} from "../src/client/console-model.ts";

describe("CONSOLE_SCREENS registry (PRD §11)", () => {
  test("the five screens, in number-key order, each bound to a read request", () => {
    expect(CONSOLE_SCREENS.map((s) => s.key)).toEqual(["sweeps", "boards", "assign", "lead_desk", "roster"]);
    expect(CONSOLE_SCREENS.map((s) => s.request)).toEqual(["sweep.list", "boards.get", "assign.suggest", "lead.desk", "roster.get"]);
    expect(CONSOLE_SCREENS.every((s) => s.label && s.empty)).toBe(true);
  });
});

describe("formatRow", () => {
  test("a SWEEPS row shows PR, cycles, the attach hint (only with a session), and a reason", () => {
    const base: SweepRow = { ticketKey: "COR-9", kind: "in_review", state: "reviewing", prNumber: 4, cycles: 1, reason: null, sessionId: "s1" };
    const line = formatRow("sweeps", base);
    expect(line).toContain("COR-9");
    expect(line).toContain("PR#4");
    expect(line).toContain("cyc=1");
    expect(line).toContain("⏎attach");
    expect(formatRow("sweeps", { ...base, sessionId: null })).not.toContain("⏎attach");
    expect(formatRow("sweeps", { ...base, prNumber: null, reason: "no PR found" })).toContain("— no PR found");
    expect(formatRow("sweeps", { ...base, prNumber: null })).toContain("—");
  });

  test("the other screens render their shapes", () => {
    expect(formatRow("boards", { ticketKey: "COR-1", title: "Login", downstream: 3 })).toContain("unblocks");
    expect(formatRow("assign", { ticketKey: "COR-1", netid: "ktt38", name: "Kenan Tat", load: 2 })).toContain("→ Kenan Tat");
    expect(formatRow("lead_desk", { ticketKey: "COR-7", title: "Book van", assignee: "Tess Lee", state: "Todo" })).toContain("Book van");
    expect(formatRow("roster", { name: "Tess Lee", netid: "tpl52", github: "tpl52-tech", lead: true })).toContain("— lead");
    expect(formatRow("roster", { name: "Willow Chen", netid: "wc697", github: "willowchen2", lead: false })).not.toContain("lead");
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
    { ticketKey: "COR-9", kind: "rescue", state: "implementing", prNumber: null, cycles: 0, reason: null, sessionId: "sess-1" },
    { ticketKey: "COR-8", kind: "in_review", state: "needs_human", prNumber: 4, cycles: 2, reason: "no PR", sessionId: null },
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
