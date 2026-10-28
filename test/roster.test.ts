import { test, expect, describe } from "bun:test";
import {
  ROSTER, buildRosterIndexes, memberByLinearId, memberByGithub, slackLookupEmails, testerLinearId, testerMember,
} from "../src/shared/roster.ts";

const DANA_ER559 = "21964707-6acc-493e-80d5-af0a402af210";
const DANA_GMAIL = "411f7c8b-01d3-45ba-b152-ce4588f55045";

describe("roster (lead-console PRD §5)", () => {
  test("both of Dana Ryu's Linear accounts resolve to one member", () => {
    const a = memberByLinearId(DANA_ER559);
    const b = memberByLinearId(DANA_GMAIL);
    expect(a).toBeDefined();
    expect(a).toBe(b);
    expect(a!.name).toBe("Dana Ryu");
  });

  test("no linearId is claimed by two members", () => {
    const owner = new Map<string, string>();
    for (const m of ROSTER) {
      for (const id of m.linearIds) {
        expect(owner.get(id) ?? m.name).toBe(m.name);
        owner.set(id, m.name);
      }
    }
  });

  test("every member has a netid, a github, and at least one email", () => {
    for (const m of ROSTER) {
      expect(m.netid.length).toBeGreaterThan(0);
      expect(m.github.length).toBeGreaterThan(0);
      expect(m.emails.length).toBeGreaterThan(0);
    }
  });

  test("github lookup is case-insensitive (PR author -> person)", () => {
    expect(memberByGithub("ENAIKAK")?.name).toBe("Enaika Kishnani");
    expect(memberByGithub("kenan-t")?.name).toBe("Kenan Tat");
    expect(memberByGithub("ghost")).toBeUndefined();
  });

  test("Dana's Slack lookup tries her cornell email before the gmail", () => {
    expect(slackLookupEmails(DANA_ER559)).toEqual([
      "er559@cornell.edu",
      "dana.ryu2007@gmail.com",
    ]);
  });

  test("buildRosterIndexes builds the real roster without throwing", () => {
    expect(() => buildRosterIndexes(ROSTER)).not.toThrow();
  });

  test("buildRosterIndexes throws loud on a duplicate linearId or github", () => {
    const base = ROSTER[0]!;
    expect(() => buildRosterIndexes([base, { ...base, github: "other" }])).toThrow(/duplicate linearId/);
    expect(() => buildRosterIndexes([base, { ...base, linearIds: ["x"] }])).toThrow(/duplicate github/);
  });

  describe("testerLinearId (Cue QA tester → Linear user)", () => {
    test("matches a tester by first name to their primary Linear id", () => {
      expect(testerLinearId("sabrina")).toBe("8ad608d2-2181-4938-8470-b9610617f422"); // Sabrina Gerson
    });

    test("Dana resolves unambiguously to her FIRST (canonical) linearId despite two accounts", () => {
      expect(testerLinearId("dana")).toBe(DANA_ER559);
      expect(ROSTER.find((m) => m.name === "Dana Ryu")!.linearIds[0]).toBe(DANA_ER559);
    });

    test("case-insensitive, and null for an unknown or empty tester (left unassigned)", () => {
      expect(testerLinearId("Sabrina")).toBe("8ad608d2-2181-4938-8470-b9610617f422"); // case-insensitive
      expect(testerLinearId("renee")).toBeNull(); // removed from the roster
      expect(testerLinearId("ghost")).toBeNull();
      expect(testerLinearId("")).toBeNull();
      expect(testerLinearId(undefined)).toBeNull();
    });

    test("testerMember is the single source — id and display name come from one member", () => {
      const m = testerMember("dana");
      expect(m!.name).toBe("Dana Ryu");
      expect(m!.linearIds[0]).toBe(DANA_ER559); // the id testerLinearId returns
      expect(testerMember("ghost")).toBeNull();
    });
  });
});
