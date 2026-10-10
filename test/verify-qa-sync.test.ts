import { test, expect, describe } from "bun:test";
import {
  parseQaRunsRows, buildVerdictComment, decideWriteback, verdictMarker, testerLabel, type QaVerdictRow,
} from "../src/shared/verify-qa-sync.ts";

const AT = 1760054400000; // a fixed epoch for deterministic markers

describe("parseQaRunsRows", () => {
  test("keeps real issue keys with a recorded verdict + numeric verdictAt", () => {
    const rows = parseQaRunsRows([
      { ticket_id: "COR-96", run: { verdict: "pass", verdictBy: "renee", verdictAt: AT } },
      { ticket_id: "COR-94", run: { verdict: "fail", verdictBy: "dana", verdictAt: AT + 1 } },
    ]);
    expect(rows.map((r) => r.ticketKey)).toEqual(["COR-96", "COR-94"]);
    expect(rows[0]).toMatchObject({ ticketKey: "COR-96", verdict: "pass", verdictAt: AT });
  });

  test("drops the __probe health row (not an issue key)", () => {
    expect(parseQaRunsRows([{ ticket_id: "__probe", run: { verdict: "fail" } }])).toEqual([]);
  });

  test("drops rows with no/invalid verdict, or no numeric verdictAt", () => {
    const rows = parseQaRunsRows([
      { ticket_id: "COR-1", run: { verdictAt: AT } }, // no verdict
      { ticket_id: "COR-2", run: { verdict: "maybe", verdictAt: AT } }, // not a real verdict
      { ticket_id: "COR-3", run: { verdict: "pass" } }, // no verdictAt → no stable marker
      { ticket_id: "COR-4", run: { verdict: "pass", verdictAt: "soon" } }, // non-numeric
    ]);
    expect(rows).toEqual([]);
  });

  test("tolerates non-array / malformed input without throwing", () => {
    expect(parseQaRunsRows(null)).toEqual([]);
    expect(parseQaRunsRows("nope")).toEqual([]);
    expect(parseQaRunsRows([null, 7, { ticket_id: "COR-5" }, { run: {} }])).toEqual([]);
  });
});

describe("buildVerdictComment", () => {
  const row = (verdict: QaVerdictRow["verdict"], run: Partial<QaVerdictRow["run"]> = {}): QaVerdictRow =>
    ({ ticketKey: "COR-96", verdict, verdictAt: AT, run: { verdict, verdictBy: "renee", verdictAt: AT, ...run } });

  test("records the verdict, tester, a date, and the idempotency ref", () => {
    const body = buildVerdictComment(row("pass", { steps: { "1": "pass", "2": "pass" } }));
    expect(body).toContain("✅ PASS");
    expect(body).toContain("recorded by Renee");
    expect(body).toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(body).toContain("Steps recorded: 2 passed, 0 failed.");
    expect(body).toContain(verdictMarker(AT));
  });

  test("lists notes for failed steps only", () => {
    const body = buildVerdictComment(row("fail", {
      verdictBy: "dana",
      steps: { "1": "pass", "2": "fail", "3": "fail" },
      notes: { "2": "button did nothing", "3": "   ", "1": "ignored (passed)" },
    }));
    expect(body).toContain("❌ FAIL");
    expect(body).toContain("recorded by Dana");
    expect(body).toContain("Steps recorded: 1 passed, 2 failed.");
    expect(body).toContain("- Step 2: button did nothing");
    expect(body).not.toContain("Step 3:"); // blank note skipped
    expect(body).not.toContain("ignored (passed)"); // passing step's note not shown
  });

  test("blocked renders its own head", () => {
    expect(buildVerdictComment(row("blocked"))).toContain("⛔ BLOCKED");
  });
});

describe("testerLabel", () => {
  test("capitalizes an id, falls back when absent", () => {
    expect(testerLabel("sabrina")).toBe("Sabrina");
    expect(testerLabel("")).toBe("a tester");
    expect(testerLabel(undefined)).toBe("a tester");
  });
});

describe("decideWriteback", () => {
  const row = (verdict: QaVerdictRow["verdict"]): QaVerdictRow =>
    ({ ticketKey: "COR-96", verdict, verdictAt: AT, run: { verdict, verdictAt: AT } });

  test("a pass with no prior comment → comment + move to Done", () => {
    expect(decideWriteback(row("pass"), { commentBodies: [], currentStateType: "started" }))
      .toEqual({ alreadySynced: false, comment: true, moveToDone: true });
  });

  test("a fail → comment only, never move state", () => {
    expect(decideWriteback(row("fail"), { commentBodies: [], currentStateType: "started" }))
      .toEqual({ alreadySynced: false, comment: true, moveToDone: false });
  });

  test("a pass already in a completed state → comment, but no redundant move", () => {
    expect(decideWriteback(row("pass"), { commentBodies: [], currentStateType: "completed" }))
      .toMatchObject({ comment: true, moveToDone: false });
  });

  test("idempotent: a comment carrying this verdict's ref → skip entirely", () => {
    const bodies = [`earlier\n_Synced from Cue QA by ao — ref ${verdictMarker(AT)}_`];
    expect(decideWriteback(row("pass"), { commentBodies: bodies, currentStateType: "started" }))
      .toEqual({ alreadySynced: true, comment: false, moveToDone: false });
  });

  test("a different verdict instance (new verdictAt) is NOT considered synced", () => {
    const bodies = [`ref ${verdictMarker(AT - 999)}`]; // an older verdict's marker
    expect(decideWriteback(row("pass"), { commentBodies: bodies, currentStateType: "started" }).alreadySynced).toBe(false);
  });
});
