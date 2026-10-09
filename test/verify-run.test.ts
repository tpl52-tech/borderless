import { test, expect, describe } from "bun:test";
import { Store } from "../src/daemon/store.ts";
import { verifyTicket, runVerify, type VerifyRunDeps } from "../src/daemon/verify-run.ts";
import type { CatalogProbe, CatalogRow } from "../src/shared/verify-catalog.ts";
import type { AgentFinding } from "../src/shared/verify-verdict.ts";
import type { LinearIssue } from "../src/shared/types.ts";

// A canned catalog row whose columns satisfy EVERY probe's interpreter at once (each reads only its own
// columns), so a catalog check passes. Override fields to force a fail.
const PASS_ROW: CatalogRow = { schema: "public", name: "t", columns: 5, rls_enabled: true, policies: 2, triggers: 1, uniques: 1 };

function deps(over: Partial<VerifyRunDeps> & { paths?: string[]; rows?: CatalogRow[] } = {}): VerifyRunDeps {
  return {
    mergedPrFor: async () => ({ prNumber: 7, paths: over.paths ?? [] }),
    catalogRun: over.catalogRun ?? (async () => over.rows ?? [PASS_ROW]),
    ...(over.knownTables ? { knownTables: over.knownTables } : {}),
    ...(over.rlsProbe ? { rlsProbe: over.rlsProbe } : {}),
    ...(over.runAgent ? { runAgent: over.runAgent } : {}),
    ...(over.stateName ? { stateName: over.stateName } : {}),
  };
}
const issue = (identifier: string, title: string, description: string | null, stateName = "Verifying"): LinearIssue => {
  const s = new Store(":memory:");
  s.upsertLinearIssue({ id: identifier, identifier, title, description: description ?? undefined, stateName, stateType: "started" });
  return s.listLinearIssues(stateName)[0]!;
};

describe("verifyTicket (verify sweep V2b — execute structural checks → verdict)", () => {
  test("a backend ticket whose catalog checks all pass ⇒ verified", async () => {
    const i = issue("COR-27", "profiles: deny-all RLS baseline", "a user cannot read another user's row");
    const r = await verifyTicket(i, deps({ paths: ["supabase/policies/profiles.sql"] }));
    expect(r.verdict).toBe("verified");
    expect(r.results.every((c) => c.status === "pass")).toBe(true);
    expect(r.results.some((c) => c.property === "rls" && c.target === "profiles")).toBe(true);
  });

  test("a failing catalog check ⇒ needs_human with the fail surfaced", async () => {
    const i = issue("COR-27", "profiles: deny-all RLS", "a user cannot read another user's row");
    const r = await verifyTicket(i, deps({ paths: ["supabase/policies/profiles.sql"], rows: [{ ...PASS_ROW, rls_enabled: false }] }));
    expect(r.verdict).toBe("needs_human");
    expect(r.results.find((c) => c.property === "rls")!.status).toBe("fail");
  });

  test("a behavioral (server-logic) check escalates ⇒ needs_human, never touches the DB", async () => {
    const i = issue("COR-39", "create-payment-intent Worker", "JWT verify + server-side pricing");
    let dbHit = false;
    const r = await verifyTicket(i, deps({ paths: ["functions/api/create-payment-intent.ts"], catalogRun: async () => { dbHit = true; return []; } }));
    expect(r.results.find((c) => c.property === "server-logic")!.status).toBe("escalated");
    expect(r.verdict).toBe("needs_human");
    expect(dbHit).toBe(false); // escalated checks don't query
  });

  test("a ui-only ticket (no invisible properties) ⇒ ui, no checks run", async () => {
    const i = issue("COR-35", "Favorites", "tap a heart; it shows in the Favorites tab");
    const r = await verifyTicket(i, deps({ paths: ["app/favorites.tsx"] }));
    expect(r.verdict).toBe("ui");
    expect(r.results).toEqual([]);
  });

  test("no PR path, but the ticket text names a real table ⇒ the catalog check targets it and runs", async () => {
    const i = issue("COR-27", "profiles table: deny-all RLS baseline", "a user cannot read another user's row");
    // No paths (no merged PR), but knownTables lets the runner bind the target from the text.
    const r = await verifyTicket(i, deps({ paths: [], knownTables: ["profiles", "items"] }));
    const rls = r.results.find((c) => c.property === "rls")!;
    expect(rls.target).toBe("profiles"); // bound from the text, not escalated
    expect(rls.status).toBe("pass"); // the canned PASS_ROW satisfies the rls probe
    expect(rls.assertion).toContain("inferred from the ticket text");
  });

  test("a catalog query that throws ⇒ inconclusive (resilient), not a crash", async () => {
    const i = issue("COR-27", "profiles: deny-all RLS", "a user cannot read another user's row");
    const r = await verifyTicket(i, deps({ paths: ["supabase/policies/profiles.sql"], catalogRun: async () => { throw new Error("connection reset"); } }));
    expect(r.verdict).toBe("needs_human");
    expect(r.results.find((c) => c.property === "rls")!.status).toBe("inconclusive");
    expect(r.results.find((c) => c.property === "rls")!.evidence).toContain("connection reset");
  });
});

describe("verifyTicket — behavioral RLS pass", () => {
  test("when an rlsProbe is injected, each RLS table gets a second (session) check on top of the catalog one", async () => {
    const i = issue("COR-27", "profiles table: deny-all RLS baseline", "a user cannot read another user's row");
    const r = await verifyTicket(i, deps({
      paths: [], knownTables: ["profiles"],
      rlsProbe: async (table) => ({ status: "inconclusive", evidence: `anon can read 5 rows of ${table}` }),
    }));
    const rls = r.results.filter((c) => c.property === "rls");
    expect(rls.map((c) => c.mechanism).sort()).toEqual(["db-read", "session"]); // structural + behavioral
    const behavioral = rls.find((c) => c.mechanism === "session")!;
    expect(behavioral.target).toBe("profiles");
    expect(behavioral.status).toBe("inconclusive");
    expect(r.verdict).toBe("needs_human"); // the behavioral inconclusive pulls it off "verified"
  });

  test("a throwing rlsProbe degrades that check to inconclusive, never crashes the ticket", async () => {
    const i = issue("COR-27", "profiles table: deny-all RLS", "a user cannot read another user's row");
    const r = await verifyTicket(i, deps({ paths: [], knownTables: ["profiles"], rlsProbe: async () => { throw new Error("sign-in expired"); } }));
    const behavioral = r.results.find((c) => c.property === "rls" && c.mechanism === "session")!;
    expect(behavioral.status).toBe("inconclusive");
    expect(behavioral.evidence).toContain("sign-in expired");
  });

  test("no rlsProbe ⇒ only the structural RLS check (behavioral pass skipped)", async () => {
    const i = issue("COR-27", "profiles table: deny-all RLS", "a user cannot read another user's row");
    const r = await verifyTicket(i, deps({ paths: [], knownTables: ["profiles"] }));
    expect(r.results.filter((c) => c.property === "rls").map((c) => c.mechanism)).toEqual(["db-read"]);
  });
});

describe("verifyTicket — verification agent (V4)", () => {
  const passFinding: AgentFinding = { criterion: "RLS denies cross-user reads", status: "pass", evidence: "anon got 0 rows" };

  test("a backend ticket runs the agent; its findings fold into the verdict and surface on the row", async () => {
    const i = issue("COR-27", "profiles: deny-all RLS", "a user cannot read another user's row");
    const seen: string[] = [];
    const r = await verifyTicket(i, deps({ paths: ["supabase/policies/profiles.sql"], runAgent: async (iss) => { seen.push(iss.identifier); return [passFinding]; } }));
    expect(seen).toEqual(["COR-27"]); // the agent ran for a backend ticket
    expect(r.agentFindings).toEqual([passFinding]);
    expect(r.verdict).toBe("verified"); // every bar passed AND the agent passed
  });

  test("an agent fail pulls a bars-clean ticket to needs_human (shared floor, not an override)", async () => {
    const i = issue("COR-27", "profiles: deny-all RLS", "a user cannot read another user's row");
    const fail: AgentFinding = { criterion: "server recomputes price", status: "fail", evidence: "it trusted the client amount" };
    const r = await verifyTicket(i, deps({ paths: ["supabase/policies/profiles.sql"], runAgent: async () => [fail] }));
    expect(r.results.every((c) => c.status === "pass")).toBe(true); // every deterministic bar passed
    expect(r.verdict).toBe("needs_human"); // but the agent finding did not
    expect(r.agentFindings).toEqual([fail]);
  });

  test("a pure-UI ticket does NOT spend an agent (nothing invisible to verify) ⇒ stays ui", async () => {
    const i = issue("COR-35", "Favorites", "tap a heart; it shows in the Favorites tab");
    let ran = false;
    const r = await verifyTicket(i, deps({ paths: ["app/favorites.tsx"], runAgent: async () => { ran = true; return [passFinding]; } }));
    expect(ran).toBe(false);
    expect(r.verdict).toBe("ui");
    expect(r.agentFindings).toEqual([]);
  });

  test("no runAgent ⇒ deterministic-only, agentFindings empty, verdict unchanged", async () => {
    const i = issue("COR-27", "profiles: deny-all RLS", "a user cannot read another user's row");
    const r = await verifyTicket(i, deps({ paths: ["supabase/policies/profiles.sql"] }));
    expect(r.agentFindings).toEqual([]);
    expect(r.verdict).toBe("verified");
  });
});

describe("runVerify", () => {
  test("runs only the Verifying tickets", async () => {
    const s = new Store(":memory:");
    s.upsertLinearIssue({ id: "i1", identifier: "COR-27", title: "deny-all RLS", description: "a user cannot read another user's row", stateName: "Verifying", stateType: "started" });
    s.upsertLinearIssue({ id: "i2", identifier: "COR-99", title: "todo", stateName: "Todo", stateType: "unstarted" });
    const rows = await runVerify(s, deps({ paths: ["supabase/policies/profiles.sql"] }));
    expect(rows.map((r) => r.ticketKey)).toEqual(["COR-27"]);
    expect(rows[0]!.verdict).toBe("verified");
  });

  test("fans the agents out concurrently across tickets, not one-at-a-time", async () => {
    const s = new Store(":memory:");
    s.upsertLinearIssue({ id: "i1", identifier: "COR-27", title: "profiles RLS", description: "a user cannot read another user's row", stateName: "Verifying", stateType: "started" });
    s.upsertLinearIssue({ id: "i2", identifier: "COR-28", title: "items RLS", description: "a user cannot edit another user's row", stateName: "Verifying", stateType: "started" });
    let inFlight = 0, maxInFlight = 0;
    const runAgent = async (): Promise<AgentFinding[]> => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((res) => setTimeout(res, 10));
      inFlight--;
      return [{ criterion: "c", status: "pass", evidence: "e" }];
    };
    const rows = await runVerify(s, deps({ paths: ["supabase/policies/x.sql"], runAgent }));
    expect(rows.map((r) => r.ticketKey).sort()).toEqual(["COR-27", "COR-28"]);
    expect(maxInFlight).toBe(2); // both agents were in flight at once — the fan-out is concurrent
  });
});
