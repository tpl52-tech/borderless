import { test, expect, describe } from "bun:test";
import { classifyVerification } from "../src/shared/verify.ts";

describe("classifyVerification (verify sweep, PRD §13)", () => {
  test("COR-35 Favorites — fully screen-observable (persistence included), no backend check", () => {
    const text = "Tapping a heart favorites an item, it shows up in the Favorites tab, un-tapping removes it, and favorites survive an app reload (saved to the database). Two-column grid, heart icon in the bottom bar.";
    const c = classifyVerification(text, ["app/(tabs)/favorites.tsx", "components/ItemCard.tsx"]);
    expect(c.verifiability).toBe("ui");
    expect(c.backendProperties).toEqual([]);
    expect(c.hasUi).toBe(true);
  });

  test("COR-27 profiles deny-all RLS + first-sign-in upsert — backend only", () => {
    const c = classifyVerification(
      "profiles table: first-sign-in upsert + deny-all RLS baseline (a user cannot read another user's row)",
      ["supabase/migrations/0007_profiles.sql", "supabase/policies/profiles.sql"],
    );
    expect(c.verifiability).toBe("backend");
    expect(c.backendProperties).toContain("rls");
    expect(c.backendProperties).toContain("data-integrity"); // upsert
    expect(c.backendProperties).toContain("schema"); // migrations path
    expect(c.hasUi).toBe(false);
  });

  test("COR-36 notifications: table + triggers — backend only", () => {
    const c = classifyVerification("Notifications: table + triggers (a row is inserted on approved / sold)", ["supabase/migrations/0009_notifications.sql"]);
    expect(c.verifiability).toBe("backend");
    expect(c.backendProperties).toEqual(["trigger", "schema"]);
  });

  test("COR-39 create-payment-intent Worker — server-logic, backend", () => {
    const c = classifyVerification("create-payment-intent Worker route: JWT verify + server-side pricing", ["functions/api/create-payment-intent.ts"]);
    expect(c.verifiability).toBe("backend");
    expect(c.backendProperties).toEqual(["server-logic"]);
  });

  test("a mixed ticket — visible form + an invisible RLS property", () => {
    const c = classifyVerification(
      "Donate form: tap submit inserts an item and shows a success screen; RLS so only staff see pending items",
      ["app/donate.tsx", "supabase/policies/items.sql"],
    );
    expect(c.verifiability).toBe("mixed");
    expect(c.backendProperties).toContain("rls");
    expect(c.hasUi).toBe(true);
  });

  test("photo upload → Storage — flags storage", () => {
    const c = classifyVerification("Photo upload: device compression → upload the photo to Storage → item_photos", ["lib/api/photos.ts"]);
    expect(c.backendProperties).toContain("storage");
    expect(c.verifiability).toBe("backend");
  });

  test("defaults to ui when nothing signals backend, even with no explicit UI words", () => {
    expect(classifyVerification("Rename the Donate label to Give", []).verifiability).toBe("ui");
  });
});
