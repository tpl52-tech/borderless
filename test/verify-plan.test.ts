import { test, expect, describe } from "bun:test";
import { planChecks, type VerifyCheck } from "../src/shared/verify-plan.ts";
import { verifyRow } from "../src/shared/verify.ts";

const byProp = (checks: VerifyCheck[]) => Object.fromEntries(checks.map((c) => [c.property, c]));

describe("planChecks (verify sweep V2 — properties → concrete checks)", () => {
  test("a ui ticket (no backend properties) plans no checks", () => {
    expect(planChecks([])).toEqual([]);
  });

  test("each property maps to its mechanism + conservative safety tier (prod = read-only structural)", () => {
    const c = byProp(planChecks(["rls", "schema", "trigger", "data-integrity", "server-logic", "storage"]));
    // The structural, catalog-derivable guarantees run read-only on prod.
    expect([c.rls!.mechanism, c.rls!.safetyTier]).toEqual(["db-read", "read-only"]);
    expect([c.schema!.mechanism, c.schema!.safetyTier]).toEqual(["db-read", "read-only"]);
    expect([c.trigger!.mechanism, c.trigger!.safetyTier]).toEqual(["db-read", "read-only"]);
    expect([c["data-integrity"]!.mechanism, c["data-integrity"]!.safetyTier]).toEqual(["db-read", "read-only"]);
    // Behavioral-only → escalate to a human on prod (run freely on the disposable V3 env).
    expect([c["server-logic"]!.mechanism, c["server-logic"]!.safetyTier]).toEqual(["http", "escalate"]);
    expect([c.storage!.mechanism, c.storage!.safetyTier]).toEqual(["session", "escalate"]);
  });

  test("one check per property, preserving the classifier's stable property order", () => {
    expect(planChecks(["rls", "schema", "server-logic"]).map((c) => c.property)).toEqual(["rls", "schema", "server-logic"]);
  });

  test("db target comes from the policy/migration path, with the migration ordering prefix stripped", () => {
    const rls = planChecks(["rls"], ["supabase/policies/profiles.sql"])[0]!;
    expect(rls.target).toBe("profiles");
    expect(rls.assertion).toContain("profiles");

    const schema = planChecks(["schema"], ["supabase/migrations/0007_profiles.sql"])[0]!;
    expect(schema.target).toBe("profiles"); // "0007_" prefix stripped
  });

  test("http target comes from a Worker function path — api/ folder optional, extension (ts/mjs) stripped", () => {
    expect(planChecks(["server-logic"], ["functions/api/create-payment-intent.ts"])[0]!.target).toBe("create-payment-intent");
    expect(planChecks(["server-logic"], ["functions/webhook.mjs"])[0]!.target).toBe("webhook"); // no api/, .mjs ext
  });

  test("targets are mechanism-scoped: a db check ignores a Worker path and an http check ignores a .sql path", () => {
    expect(planChecks(["rls"], ["functions/api/pay.ts"])[0]!.target).toBeNull(); // db-read ⇏ Worker path
    expect(planChecks(["server-logic"], ["supabase/policies/items.sql"])[0]!.target).toBeNull(); // http ⇏ sql path
  });

  test("no usable path → a single check with a null target and a generic assertion (no dangling <target>)", () => {
    const cs = planChecks(["schema"], ["README.md", "app/x.tsx"]);
    expect(cs).toHaveLength(1);
    expect(cs[0]!.target).toBeNull();
    expect(cs[0]!.assertion).not.toContain("<target>");
    expect(cs[0]!.assertion).toContain("the affected resource");
  });

  test("multiple derived targets fan out into one check each, every assertion naming only its own table", () => {
    const cs = planChecks(["schema"], ["app/x.tsx", "supabase/migrations/0009_notifications.sql", "supabase/migrations/0007_profiles.sql"]);
    expect(cs.map((c) => c.target)).toEqual(["notifications", "profiles"]); // one check per table, order-preserving
    expect(cs.every((c) => c.property === "schema")).toBe(true);
    expect(cs[0]!.assertion).toContain("notifications");
    expect(cs[0]!.assertion).not.toContain("profiles"); // each check names only its own target
    expect(cs[1]!.assertion).toContain("profiles");
  });

  test("composes on a real classifier row (verifyRow → planChecks over its backendProperties)", () => {
    const paths = ["supabase/policies/profiles.sql", "supabase/migrations/0007_profiles.sql"];
    const r = verifyRow(
      { identifier: "COR-27", title: "profiles: first-sign-in upsert + deny-all RLS baseline", description: "a user cannot read another user's row" },
      paths, 42,
    );
    const c = byProp(planChecks(r.backendProperties, paths));
    expect(c.rls!.target).toBe("profiles");
    expect(c.schema!.safetyTier).toBe("read-only");
    expect(c["data-integrity"]!.mechanism).toBe("db-read"); // the upsert the classifier flagged → structural constraint check
  });
});
