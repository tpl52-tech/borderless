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

function deps(over: { store?: Record<string, LinearIssue>; moveToDone?: (id: string, k: string) => Promise<void> } = {}) {
  const moved: Array<{ id: string; key: string }> = [];
  const store = over.store ?? { "COR-27": issue("u27", "COR-27"), "COR-35": issue("u35", "COR-35") };
  return {
    moved,
    deps: {
      issueByKey: (k: string) => store[k],
      moveToDone: over.moveToDone ?? (async (id: string, key: string) => { moved.push({ id, key }); }),
    },
  };
}

describe("runAutoAdvance", () => {
  test("moves only the pure-backend verified tickets to Done, by UUID, and returns the keys moved", async () => {
    const h = deps();
    const rows = [vrow("COR-27", "verified", "backend"), vrow("COR-35", "verified", "mixed"), vrow("COR-40", "needs_human", "backend")];
    expect(await runAutoAdvance(rows, h.deps)).toEqual(["COR-27"]);
    expect(h.moved).toEqual([{ id: "u27", key: "COR-27" }]); // COR-35 (mixed) + COR-40 (needs_human) untouched
  });

  test("a ticket missing from the store is skipped (not moved, not returned)", async () => {
    const h = deps({ store: {} }); // COR-27 not synced
    expect(await runAutoAdvance([vrow("COR-27", "verified", "backend")], h.deps)).toEqual([]);
    expect(h.moved).toHaveLength(0);
  });

  test("a failed move is best-effort: skipped, run continues, the key is NOT reported as advanced", async () => {
    const store = { "COR-27": issue("u27", "COR-27"), "COR-28": issue("u28", "COR-28") };
    const d = {
      issueByKey: (k: string) => store[k as keyof typeof store],
      moveToDone: async (_id: string, key: string) => { if (key === "COR-27") throw new Error("Linear 500"); },
    };
    const rows = [vrow("COR-27", "verified", "backend"), vrow("COR-28", "verified", "backend")];
    expect((await runAutoAdvance(rows, d)).sort()).toEqual(["COR-28"]); // COR-27 failed → not advanced; COR-28 still moved
  });
});
