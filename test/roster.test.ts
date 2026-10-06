import { test, expect, describe } from "bun:test";
import {
  ROSTER, buildRosterIndexes, memberByLinearId, memberByGithub, slackLookupEmails,
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
});
