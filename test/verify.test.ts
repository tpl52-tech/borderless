import { test, expect, describe } from "bun:test";
import { classifyVerification, verifyRow, verifyScriptPrompt } from "../src/shared/verify.ts";

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

  // Precision frontier: the invisible-property signals must NOT fire on ordinary UI language.
  test("generic verbs / UI senses stay ui — no spurious backend flag", () => {
    expect(classifyVerification("Tapping the heart triggers the favorite animation", []).backendProperties).toEqual([]); // verb "triggers", not a DB trigger
    expect(classifyVerification("Privacy policy screen with a scroll view", []).backendProperties).toEqual([]); // "policy" ≠ RLS policy
    expect(classifyVerification("Logged-out users can't see the grid", []).backendProperties).toEqual([]); // UI visibility, not cross-user RLS
    expect(classifyVerification("Favorites persist to local storage and survive a reload", []).backendProperties).toEqual([]); // device-local, screen-observable
  });

  test("restored recall: bare 'to Storage' and 'database trigger' still flag (not just upload/noun forms)", () => {
    expect(classifyVerification("the compressed image is saved to Storage", ["lib/api/photos.ts"]).backendProperties).toContain("storage");
    expect(classifyVerification("adds a database trigger for an audit log", []).backendProperties).toContain("trigger");
  });

  test("a changed .sql path is caught regardless of its position in the list (per-path matching)", () => {
    // Regression: a whole-string join with a bare `$` only matched the LAST path.
    expect(classifyVerification("neutral text", ["db/0001_init.sql", "app/x.tsx"]).backendProperties).toContain("schema");
    expect(classifyVerification("neutral text", ["ui/Button.tsx", "lib/x.ts"]).hasUi).toBe(true); // .tsx not last
  });

  test("verifyRow composes the classification with the ticket meta + PR number", () => {
    const r = verifyRow(
      { identifier: "COR-27", title: "profiles: deny-all RLS baseline", description: "a user cannot read another user's row" },
      ["supabase/policies/profiles.sql"], 42,
    );
    expect(r.ticketKey).toBe("COR-27");
    expect(r.prNumber).toBe(42);
    expect(r.verifiability).toBe("backend");
    expect(r.backendProperties).toContain("rls");
    expect(verifyRow({ identifier: "COR-1", title: "x", description: null }, [], null).prNumber).toBeNull();
  });

  test("verifyScriptPrompt focuses the LLM on the UI half and names the auto-verified props to skip", () => {
    const p = verifyScriptPrompt(
      { identifier: "COR-35", title: "Favorites", description: "tap a heart; it persists across reload" },
      { verifiability: "mixed", backendProperties: ["rls", "schema"], hasUi: true },
    );
    expect(p).toContain("COR-35");
    expect(p).toContain("Expo Go");
    expect(p).toContain("do NOT write steps for them: rls, schema");
    expect(p).toContain("tap a heart"); // the acceptance criteria are included
    expect(verifyScriptPrompt({ identifier: "COR-1", title: "x", description: null }, { verifiability: "ui", backendProperties: [], hasUi: true }))
      .toContain("Everything here is screen-observable");
  });
});
