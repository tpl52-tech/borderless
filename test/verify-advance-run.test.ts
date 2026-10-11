import { test, expect, describe } from "bun:test";
import { runAutoAdvance } from "../src/daemon/verify-advance-run.ts";
import type { VerifyRunRow } from "../src/shared/verify-verdict.ts";
import type { LinearIssue } from "../src/shared/types.ts";

const vrow = (ticketKey: string, verdict: VerifyRunRow["verdict"], verifiability: VerifyRunRow["verifiability"]): VerifyRunRow =>
  ({ ticketKey, title: ticketKey, prNumber: null, verifiability, backendProperties: [], hasUi: verifiability !== "backend",
     verdict, results: [], agentFindings: [], summary: { pass: 0, fail: 0, inconclusive: 0, escalated: 0 } });

const issue = (id: string, identifier: string): LinearIssue =>
  ({ id, identifier, title: identifier, description: null, url: null, stateName: "Verifying", stateType: "started",
     assignee: null, projectId: null, projectName: null, teamKey: "COR", priority: null, dueDate: null, labels: [], blockedBy: [] } as unknown as LinearIssue);

function harness(over: { store?: Record<string, LinearIssue>; moveToDone?: (id: string, k: string) => Promise<void> } = {}) {
  const moved: Array<{ id: string; key: string }> = [];
  const reflected: string[] = [];
  const store = over.store ?? { "COR-27": issue("u27", "COR-27"), "COR-28": issue("u28", "COR-28") };
  return {
    moved, reflected,
    deps: {
      issueByKey: (k: string) => store[k] ?? null,
      moveToDone: over.moveToDone ?? (async (id: string, key: string) => { moved.push({ id, key }); }),
      onAdvanced: (i: LinearIssue) => { reflected.push(i.identifier); },
    },
  };
}

describe("runAutoAdvance", () => {
  test("moves only pure-backend verified tickets (by UUID), reflects locally, returns the keys moved", async () => {
    const h = harness();
    const rows = [vrow("COR-27", "verified", "backend"), vrow("COR-35", "verified", "mixed"), vrow("COR-40", "needs_human", "backend")];
    expect(await runAutoAdvance(rows, h.deps)).toEqual(["COR-27"]);
    expect(h.moved).toEqual([{ id: "u27", key: "COR-27" }]); // COR-35 (mixed) + COR-40 (needs_human) untouched
    expect(h.reflected).toEqual(["COR-27"]); // reflected in the store so a re-run won't re-advance it
  });

  test("a ticket missing from the store is skipped (not moved, not reflected, not returned)", async () => {
    const h = harness({ store: {} });
    expect(await runAutoAdvance([vrow("COR-27", "verified", "backend")], h.deps)).toEqual([]);
    expect(h.moved).toHaveLength(0);
    expect(h.reflected).toHaveLength(0);
  });

  test("a failed move is best-effort: skipped, NOT reflected, run continues for the others", async () => {
    const h = harness({ moveToDone: async (_id, key) => { if (key === "COR-27") throw new Error("Linear 500"); } });
    const rows = [vrow("COR-27", "verified", "backend"), vrow("COR-28", "verified", "backend")];
    expect((await runAutoAdvance(rows, h.deps)).sort()).toEqual(["COR-28"]); // COR-27 failed → not advanced
    expect(h.reflected).toEqual(["COR-28"]); // the failed one is NOT reflected (so a retry can re-attempt it)
  });
});
