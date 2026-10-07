import { test, expect, describe } from "bun:test";
import { Store } from "../src/daemon/store.ts";
import { consolePayload, sweepOwner, sweepRow, rosterRow } from "../src/shared/console-rows.ts";
import { ROSTER } from "../src/shared/roster.ts";

const TESS = "b21d8c6e-f3a3-4894-979f-0e8619ca9f48"; // Tess's Linear id (shared/roster.ts)

describe("sweepOwner / sweepRow / rosterRow (the shapes both consoles share)", () => {
  test("sweepOwner → roster first name, else raw id, else null", () => {
    expect(sweepOwner(TESS)).toBe("Hyunsuh");
    expect(sweepOwner("unknown-id")).toBe("unknown-id");
    expect(sweepOwner(null)).toBeNull();
  });
  test("sweepRow projects the queue fields", () => {
    const s = new Store(":memory:");
    const j = s.createSweepJob({ kind: "in_review", ticketId: "i1", ticketKey: "COR-1", prNumber: 7, assignee: TESS });
    expect(sweepRow(j)).toEqual({ ticketKey: "COR-1", kind: "in_review", state: "queued", owner: "Hyunsuh", prNumber: 7, cycles: 0, reason: null, sessionId: null });
  });
  test("rosterRow exposes only name/netid/github/lead (no emails/linearIds)", () => {
    expect(rosterRow(ROSTER[0]!)).toEqual({ name: "Hyunsuh (Tess) Lee", netid: "tpl52", github: "tpl52-tech", lead: true });
    expect(Object.keys(rosterRow(ROSTER[0]!)).sort()).toEqual(["github", "lead", "name", "netid"]);
  });
});

describe("consolePayload (live snapshot from already-read store data)", () => {
  test("gathers all six screens; the Ink + web consoles render the same shapes", () => {
    const s = new Store(":memory:");
    s.upsertLinearIssue({ id: "i1", identifier: "COR-1", title: "Login", stateName: "In Review", stateType: "started" });
    s.createSweepJob({ kind: "in_review", ticketId: "i1", ticketKey: "COR-1", prNumber: 7 });
    s.upsertLinearIssue({ id: "i2", identifier: "COR-2", title: "Donate form", stateName: "Todo", stateType: "unstarted" });

    const p = consolePayload(s.listLinearIssues(), s.listSweepJobs());
    expect(p.sweeps.map((j) => j.ticketKey)).toEqual(["COR-1"]);
    expect(p.sweeps[0]!.prNumber).toBe(7);
    expect(p.boards.map((b) => b.ticketKey)).toContain("COR-2"); // unblocked + unassigned
    expect(Array.isArray(p.assign)).toBe(true);
    expect(Array.isArray(p.desk)).toBe(true);
    expect(p.roster.length).toBe(12);
    expect(p.rosterLoad.length).toBe(12);
    expect(p.rosterLoad.every((m) => typeof m.load === "number")).toBe(true);
    expect(typeof p.project).toBe("string");
  });
  test("empty store → empty screens, not a crash", () => {
    const p = consolePayload([], []);
    expect(p.sweeps).toEqual([]);
    expect(p.boards).toEqual([]);
    expect(p.assign).toEqual([]);
    expect(p.desk).toEqual([]);
    expect(p.roster.length).toBe(12);
  });
});
