import { test, expect, describe } from "bun:test";
import { planChecks, type VerifyCheck } from "../src/shared/verify-plan.ts";
import { verifyRow } from "../src/shared/verify.ts";

const byProp = (checks: VerifyCheck[]) => Object.fromEntries(checks.map((c) => [c.property, c]));

describe("planChecks (verify sweep V2 — properties → concrete checks)", () => {
  test("a ui ticket (no backend properties) plans no checks", () => {
    expect(planChecks([])).toEqual([]);
  });

  test("each property maps to its mechanism + conservative safety tier", () => {
    const c = byProp(planChecks(["rls", "schema", "trigger", "data-integrity", "server-logic", "storage"]));
    expect([c.rls!.mechanism, c.rls!.safetyTier]).toEqual(["session", "throwaway-write"]);
    expect([c.schema!.mechanism, c.schema!.safetyTier]).toEqual(["db-read", "read-only"]);
    expect([c.trigger!.mechanism, c.trigger!.safetyTier]).toEqual(["db-read", "read-only"]);
    expect([c["data-integrity"]!.mechanism, c["data-integrity"]!.safetyTier]).toEqual(["session", "throwaway-write"]);
    // Worker logic is ambiguous/consequential from paths alone → escalate to a human, never auto-act.
    expect([c["server-logic"]!.mechanism, c["server-logic"]!.safetyTier]).toEqual(["http", "escalate"]);
    expect([c.storage!.mechanism, c.storage!.safetyTier]).toEqual(["session", "throwaway-write"]);
  });

  test("one check per property, preserving the classifier's stable property order", () => {
    expect(planChecks(["rls", "schema", "server-logic"]).map((c) => c.property)).toEqual(["rls", "schema", "server-logic"]);
  });

  test("db targets come from policy/migration paths, with the migration ordering prefix stripped", () => {
    const rls = planChecks(["rls"], ["supabase/policies/profiles.sql"])[0]!;
    expect(rls.targets).toEqual(["profiles"]);
    expect(rls.assertion).toContain("profiles");

    const schema = planChecks(["schema"], ["supabase/migrations/0007_profiles.sql"])[0]!;
    expect(schema.targets).toEqual(["profiles"]); // "0007_" prefix stripped
  });

  test("http targets come from Worker function paths — api/ folder optional, extension (ts/mjs) stripped", () => {
    expect(planChecks(["server-logic"], ["functions/api/create-payment-intent.ts"])[0]!.targets).toEqual(["create-payment-intent"]);
    expect(planChecks(["server-logic"], ["functions/webhook.mjs"])[0]!.targets).toEqual(["webhook"]); // no api/, .mjs ext
  });

  test("targets are mechanism-scoped: a db check ignores a Worker path and an http check ignores a .sql path", () => {
    expect(planChecks(["rls"], ["functions/api/pay.ts"])[0]!.targets).toEqual([]); // session ⇏ Worker path
    expect(planChecks(["server-logic"], ["supabase/policies/items.sql"])[0]!.targets).toEqual([]); // http ⇏ sql path
  });

  test("no usable path → empty targets and a generic assertion (no dangling <target>)", () => {
    const c = planChecks(["schema"], ["README.md", "app/x.tsx"])[0]!;
    expect(c.targets).toEqual([]);
    expect(c.assertion).not.toContain("<target>");
    expect(c.assertion).toContain("the affected resource");
  });

  test("a usable path is found regardless of its position, and multiple targets dedupe in order", () => {
    const c = planChecks(["schema"], ["app/x.tsx", "supabase/migrations/0009_notifications.sql", "supabase/migrations/0007_profiles.sql"])[0]!;
    expect(c.targets).toEqual(["notifications", "profiles"]); // both, order-preserving
  });

  test("composes on a real classifier row (verifyRow → planChecks over its backendProperties)", () => {
    const paths = ["supabase/policies/profiles.sql", "supabase/migrations/0007_profiles.sql"];
    const r = verifyRow(
      { identifier: "COR-27", title: "profiles: first-sign-in upsert + deny-all RLS baseline", description: "a user cannot read another user's row" },
      paths, 42,
    );
    const c = byProp(planChecks(r.backendProperties, paths));
    expect(c.rls!.targets).toEqual(["profiles"]);
    expect(c.schema!.safetyTier).toBe("read-only");
    expect(c["data-integrity"]!.mechanism).toBe("session"); // the upsert the classifier flagged
  });
});
