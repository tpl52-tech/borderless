import { test, expect, describe } from "bun:test";
import { Store } from "../src/daemon/store.ts";
import { verifyScan } from "../src/daemon/verify-scan.ts";

describe("verifyScan (PRD §13 V1 — classify Verifying tickets from their merged PRs)", () => {
  test("classifies only Verifying tickets, from their merged-PR files", async () => {
    const s = new Store(":memory:");
    s.upsertLinearIssue({ id: "i1", identifier: "COR-35", title: "Favorites: heart toggle", description: "tap a heart, shows in the grid, survives reload", stateName: "Verifying", stateType: "started" });
    s.upsertLinearIssue({ id: "i2", identifier: "COR-27", title: "profiles deny-all RLS", description: "a user cannot read another user's row", stateName: "Verifying", stateType: "started" });
    s.upsertLinearIssue({ id: "i3", identifier: "COR-99", title: "not verifying", stateName: "Todo", stateType: "unstarted" });

    const files: Record<string, string[]> = { "COR-35": ["app/favorites.tsx"], "COR-27": ["supabase/policies/profiles.sql"] };
    const rows = await verifyScan(s, { mergedPrFor: async (iss) => ({ prNumber: 1, paths: files[iss.identifier] ?? [] }) });

    expect(rows.map((r) => r.ticketKey).sort()).toEqual(["COR-27", "COR-35"]); // the Todo ticket is excluded
    const byKey = Object.fromEntries(rows.map((r) => [r.ticketKey, r]));
    expect(byKey["COR-35"]!.verifiability).toBe("ui");
    expect(byKey["COR-27"]!.verifiability).toBe("backend");
    expect(byKey["COR-27"]!.backendProperties).toContain("rls");
  });

  test("a Verifying ticket with no merged PR still classifies from its text (null prNumber)", async () => {
    const s = new Store(":memory:");
    s.upsertLinearIssue({ id: "i1", identifier: "COR-1", title: "deny-all RLS baseline", stateName: "Verifying", stateType: "started" });
    const rows = await verifyScan(s, { mergedPrFor: async () => null });
    expect(rows[0]!.prNumber).toBeNull();
    expect(rows[0]!.backendProperties).toContain("rls");
  });
});
