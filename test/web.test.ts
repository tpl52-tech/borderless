import { test, expect, describe } from "bun:test";
import { Store } from "../src/daemon/store.ts";
import { consolePayload } from "../src/daemon/web.ts";

describe("consolePayload (web console live snapshot)", () => {
  test("gathers all six screens' data from the store in one read", () => {
    const s = new Store(":memory:");
    // a sweep job + an issue it points at
    s.upsertLinearIssue({ id: "i1", identifier: "COR-1", title: "Login", stateName: "In Review", stateType: "started" });
    s.createSweepJob({ kind: "in_review", ticketId: "i1", ticketKey: "COR-1", prNumber: 7 });
    // some board/assign fodder
    s.upsertLinearIssue({ id: "i2", identifier: "COR-2", title: "Donate form", stateName: "Todo", stateType: "unstarted" });

    const p = consolePayload(s);
    expect(p.sweeps.map((j) => j.ticketKey)).toEqual(["COR-1"]);
    expect(p.sweeps[0]!.prNumber).toBe(7);
    expect(p.boards.map((b) => b.ticketKey)).toContain("COR-2"); // unblocked, unassigned
    expect(Array.isArray(p.assign)).toBe(true);
    expect(Array.isArray(p.desk)).toBe(true);
    expect(p.roster.length).toBe(12); // the real roster
    expect(p.rosterLoad.length).toBe(12);
    expect(p.rosterLoad.every((m) => typeof m.load === "number")).toBe(true);
    expect(typeof p.project).toBe("string");
  });

  test("resolves a sweep OWNER to a roster first name, else null", () => {
    const s = new Store(":memory:");
    // Tess's Linear id (from shared/roster.ts)
    s.createSweepJob({ kind: "rescue", ticketId: "x", ticketKey: "COR-9", assignee: "b21d8c6e-f3a3-4894-979f-0e8619ca9f48" });
    s.createSweepJob({ kind: "rescue", ticketId: "y", ticketKey: "COR-10", assignee: null });
    const bySweep = Object.fromEntries(consolePayload(s).sweeps.map((j) => [j.ticketKey, j.owner]));
    expect(bySweep["COR-9"]).toBe("Hyunsuh"); // first name of "Hyunsuh (Tess) Lee"
    expect(bySweep["COR-10"]).toBeNull();
  });

  test("empty store yields empty screens, not a crash", () => {
    const p = consolePayload(new Store(":memory:"));
    expect(p.sweeps).toEqual([]);
    expect(p.boards).toEqual([]);
    expect(p.assign).toEqual([]);
    expect(p.desk).toEqual([]);
    expect(p.roster.length).toBe(12);
  });
});
