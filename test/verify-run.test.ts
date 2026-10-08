import { test, expect, describe } from "bun:test";
import { Store } from "../src/daemon/store.ts";
import { verifyTicket, runVerify, type VerifyRunDeps } from "../src/daemon/verify-run.ts";
import type { CatalogProbe, CatalogRow } from "../src/shared/verify-catalog.ts";
import type { LinearIssue } from "../src/shared/types.ts";

// A canned catalog row whose columns satisfy EVERY probe's interpreter at once (each reads only its own
// columns), so a catalog check passes. Override fields to force a fail.
const PASS_ROW: CatalogRow = { schema: "public", name: "t", columns: 5, rls_enabled: true, policies: 2, triggers: 1, uniques: 1 };

function deps(over: Partial<VerifyRunDeps> & { paths?: string[]; rows?: CatalogRow[] } = {}): VerifyRunDeps {
  return {
    mergedPrFor: async () => ({ prNumber: 7, paths: over.paths ?? [] }),
    catalogRun: over.catalogRun ?? (async () => over.rows ?? [PASS_ROW]),
    ...(over.knownTables ? { knownTables: over.knownTables } : {}),
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

describe("runVerify", () => {
  test("runs only the Verifying tickets", async () => {
    const s = new Store(":memory:");
    s.upsertLinearIssue({ id: "i1", identifier: "COR-27", title: "deny-all RLS", description: "a user cannot read another user's row", stateName: "Verifying", stateType: "started" });
    s.upsertLinearIssue({ id: "i2", identifier: "COR-99", title: "todo", stateName: "Todo", stateType: "unstarted" });
    const rows = await runVerify(s, deps({ paths: ["supabase/policies/profiles.sql"] }));
    expect(rows.map((r) => r.ticketKey)).toEqual(["COR-27"]);
    expect(rows[0]!.verdict).toBe("verified");
  });
});
