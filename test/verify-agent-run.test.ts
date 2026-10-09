import { test, expect, describe } from "bun:test";
import { Store } from "../src/daemon/store.ts";
import { runVerifyAgent } from "../src/daemon/verify-agent-run.ts";
import type { LinearIssue } from "../src/shared/types.ts";

function issue(): LinearIssue {
  const s = new Store(":memory:");
  s.upsertLinearIssue({ id: "i1", identifier: "COR-27", title: "profiles: deny-all RLS", description: "a user cannot read another user's row", stateName: "Verifying", stateType: "started" });
  return s.listLinearIssues("Verifying")[0]!;
}

describe("runVerifyAgent (verify sweep V4 — spawn → grounded findings)", () => {
  test("parses the agent's JSON verdict into findings, and passes the seed to the spawn", async () => {
    let seenSeed = "";
    const findings = await runVerifyAgent(issue(), {
      spawn: async (seed) => {
        seenSeed = seed;
        return JSON.stringify({ findings: [{ criterion: "cross-user read is blocked", status: "pass", evidence: "queried as user B, got 0 rows" }] });
      },
    });
    expect(findings).toEqual([{ criterion: "cross-user read is blocked", status: "pass", evidence: "queried as user B, got 0 rows" }]);
    expect(seenSeed).toContain("COR-27"); // the built seed reached the spawn
    expect(seenSeed).toContain("$AO_SESSION_DIR/verdict.json");
  });

  test("a confused agent (unparseable output) degrades to an inconclusive finding, not a crash", async () => {
    const findings = await runVerifyAgent(issue(), { spawn: async () => "I gave up." });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.status).toBe("inconclusive");
  });
});
