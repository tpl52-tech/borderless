import { test, expect, describe } from "bun:test";
import {
  deliverableTokens, buildTerritory, detectCollisions, collisionEscalation, territoryWarning,
  type Territory,
} from "../src/shared/collision.ts";
import type { LinearIssue } from "../src/shared/types.ts";
import type { Member } from "../src/shared/roster.ts";

const ROSTER: Member[] = [
  { name: "Renee Gowda", netid: "rsg276", emails: [], linearIds: ["renee-id"], github: "reneegowda" },
  { name: "Tess Lee", netid: "tpl52", emails: [], linearIds: ["tess-id"], github: "tpl52-tech", lead: true },
];

const issue = (over: Partial<LinearIssue>): LinearIssue => ({
  id: over.identifier ?? "x", identifier: "COR-1", title: "", description: null,
  stateName: "In Progress", stateType: "started", assignee: "renee-id",
  projectId: null, projectName: "ReUse", teamKey: "COR", url: null, priority: null,
  blockedBy: [], dueDate: null, labels: [], gitBranchName: null, updatedAt: null, ...over,
});

describe("deliverableTokens — component/file names, high precision", () => {
  test("extracts multi-hump components and code filenames", () => {
    expect(deliverableTokens("Build ConditionStars: reusable 1–5 star display")).toEqual(["ConditionStars"]);
    expect(deliverableTokens("touch components/ItemCard.tsx and HomeListing")).toEqual(["ItemCard", "HomeListing"]);
    expect(deliverableTokens("edit src/shared/boards.ts")).toEqual(["boards"]);
  });
  test("ignores single-hump words and generic infra stems (would flag everything)", () => {
    expect(deliverableTokens("Home screen Login flow and Profile")).toEqual([]); // single-hump → not deliverables
    expect(deliverableTokens("update index.ts, types.ts, utils.ts, app.tsx")).toEqual([]); // generic stems dropped
  });
  test("dedupes case-insensitively, keeping the first spelling", () => {
    expect(deliverableTokens("ConditionStars and conditionstars.tsx")).toEqual(["ConditionStars"]);
  });
});

describe("buildTerritory — only real, assigned, active, non-lead-ops claims", () => {
  const issues: LinearIssue[] = [
    issue({ identifier: "COR-54", title: "ConditionStars: reusable stars", assignee: "renee-id" }),
    issue({ identifier: "COR-19", title: "Home sections with ConditionStars", assignee: "tess-id" }), // the sweep target
    issue({ identifier: "COR-90", title: "FancyWidget", assignee: null }), // unassigned → not owned
    issue({ identifier: "COR-91", title: "OldThing", assignee: "renee-id", stateType: "completed" }), // terminal
    issue({ identifier: "COR-92", title: "LeadThing", assignee: "renee-id", projectName: "Lead Ops" }), // lead desk
  ];
  const territory = buildTerritory(issues, "COR-19", ROSTER, "Lead Ops");

  test("owns the assigned active ticket's deliverable, resolved to the owner's name", () => {
    expect(territory.get("conditionstars")).toEqual({ ticketKey: "COR-54", owner: "Renee Gowda", state: "In Progress", deliverable: "ConditionStars" });
  });
  test("excludes the target ticket, unassigned, terminal, and lead-ops tickets", () => {
    // COR-19 is the target; its own "ConditionStars" mention must NOT register (the sole owner is COR-54).
    expect(territory.get("conditionstars")!.ticketKey).toBe("COR-54");
    expect(territory.get("fancywidget")).toBeUndefined();
    expect(territory.get("oldthing")).toBeUndefined();
    expect(territory.get("leadthing")).toBeUndefined();
  });
  test("an unresolved assignee still owns, named generically", () => {
    const t = buildTerritory([issue({ identifier: "COR-7", title: "MysteryBox", assignee: "ghost-id" })], "COR-1", ROSTER);
    expect(t.get("mysterybox")!.owner).toBe("a teammate");
  });
});

describe("detectCollisions — changed paths landing on another ticket's territory", () => {
  const territory: Territory = buildTerritory(
    [issue({ identifier: "COR-54", title: "ConditionStars reusable", assignee: "renee-id" })], "COR-19", ROSTER,
  );
  test("flags a changed path whose component another ticket owns", () => {
    const hits = detectCollisions(["components/ConditionStars.tsx", "src/screens/Home.tsx"], territory);
    expect(hits).toEqual([{ deliverable: "ConditionStars", ticketKey: "COR-54", owner: "Renee Gowda", state: "In Progress" }]);
  });
  test("no collision when paths stay off the territory", () => {
    expect(detectCollisions(["src/shared/boards.ts", "src/ui/button.ts"], territory)).toEqual([]);
  });
  test("dedupes repeat hits on the same owner+deliverable", () => {
    const hits = detectCollisions(["a/ConditionStars.tsx", "b/ConditionStars.tsx"], territory);
    expect(hits.length).toBe(1);
  });
});

describe("collisionEscalation — the human-facing reason", () => {
  test("null when empty; names ticket + owner + state when present", () => {
    expect(collisionEscalation([])).toBeNull();
    const reason = collisionEscalation([{ deliverable: "ConditionStars", ticketKey: "COR-54", owner: "Renee Gowda", state: "In Progress" }]);
    expect(reason).toContain("ConditionStars");
    expect(reason).toContain("COR-54");
    expect(reason).toContain("Renee Gowda");
    expect(reason).toContain("coordinate before merging");
  });
  test("caps the list and summarizes the overflow", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ deliverable: `C${i}`, ticketKey: `COR-${i}`, owner: "x", state: "s" }));
    expect(collisionEscalation(many)).toContain("+2 more");
  });
});

describe("territoryWarning — the preventive worker-seed block", () => {
  test("null when the territory is empty", () => {
    expect(territoryWarning(new Map())).toBeNull();
  });
  test("lists each owned deliverable with its ticket/owner/state + a stop instruction", () => {
    const territory: Territory = new Map([
      ["conditionstars", { ticketKey: "COR-54", owner: "Renee Gowda", state: "In Progress", deliverable: "ConditionStars" }],
      ["itemcard", { ticketKey: "COR-30", owner: "Dana Ryu", state: "Todo", deliverable: "ItemCard" }],
    ]);
    const warning = territoryWarning(territory)!;
    expect(warning).toContain("do NOT create, extract, or rewrite them");
    expect(warning).toContain("ConditionStars — owned by COR-54 (Renee Gowda, In Progress)");
    expect(warning).toContain("ItemCard — owned by COR-30 (Dana Ryu, Todo)");
    expect(warning).toContain("STOP and say so");
  });
  test("caps the list and summarizes the overflow", () => {
    const territory: Territory = new Map(
      Array.from({ length: 30 }, (_, i) => [`c${i}`, { ticketKey: `COR-${i}`, owner: "x", state: "Todo", deliverable: `C${i}` }] as const),
    );
    expect(territoryWarning(territory)).toContain("…and 5 more");
  });
});
