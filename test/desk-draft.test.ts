import { test, expect, describe } from "bun:test";
import { priorityNumber, draftPrompt, parseDraft } from "../src/shared/desk-draft.ts";
import type { Member } from "../src/shared/roster.ts";

const ROSTER: Member[] = [
  { name: "Dana Ryu", netid: "er559", emails: ["er559@cornell.edu"], linearIds: ["dana-1", "dana-2"], github: "danar" },
  { name: "Neha Bommireddy", netid: "nb644", emails: [], linearIds: ["neha"], github: "nehab", lead: true },
];

const ctx = { coLeads: ["Neha Bommireddy"], members: ["Dana Ryu"], epics: ["Onboarding"] };

describe("priorityNumber", () => {
  test("maps the words to Linear's numeric priority; unknown/absent → None(0)", () => {
    expect([priorityNumber("Urgent"), priorityNumber("high"), priorityNumber("Medium"), priorityNumber(" low ")]).toEqual([1, 2, 3, 4]);
    expect([priorityNumber("none"), priorityNumber("whatever"), priorityNumber(undefined), priorityNumber(3)]).toEqual([0, 0, 0, 0]);
  });
});

describe("draftPrompt", () => {
  test("grounds the model with people, projects, epics, the JSON contract, and the lead's words", () => {
    const p = draftPrompt("Dana builds the profile screen", ctx);
    expect(p).toContain("co-leads: Neha Bommireddy");
    expect(p).toContain("others: Dana Ryu");
    expect(p).toContain("Existing epics: Onboarding");
    expect(p).toContain('"priority":"None|Low|Medium|High|Urgent"');
    expect(p).toContain("Lead's request: Dana builds the profile screen");
  });
});

describe("parseDraft", () => {
  test("parses a clean reply; resolves full name + unique first name; maps priority + epic", () => {
    const reply = JSON.stringify({
      epics: [{ title: "Phase 2 Search", project: "ReUse App — Fall 2026" }],
      tickets: [
        { title: "Profile edit screen", assignee: "Dana Ryu", project: "ReUse App — Fall 2026", priority: "High", epic: null },
        { title: "Favorites RLS", assignee: "Neha", project: null, priority: "Urgent", epic: "Phase 2 Search" },
      ],
      questions: ["Which milestone?"],
    });
    const d = parseDraft(reply, ROSTER);
    expect(d.warnings).toEqual([]);
    expect(d.epics).toEqual([{ title: "Phase 2 Search" }]);
    expect(d.tickets[0]).toEqual({ title: "Profile edit screen", assignee: "Dana", assigneeLinearId: "dana-1", resolved: true, priority: 2, epic: null });
    expect(d.tickets[1]).toEqual({ title: "Favorites RLS", assignee: "Neha", assigneeLinearId: "neha", resolved: true, priority: 1, epic: "Phase 2 Search" });
    expect(d.questions).toEqual(["Which milestone?"]);
  });

  test("tolerates a ```json fenced reply with surrounding prose", () => {
    const reply = "Sure! Here you go:\n```json\n{\"tickets\":[{\"title\":\"X\",\"assignee\":\"Neha\",\"priority\":\"Low\"}]}\n```\nHope that helps.";
    const d = parseDraft(reply, ROSTER);
    expect(d.tickets).toHaveLength(1);
    expect(d.tickets[0]!.assignee).toBe("Neha");
    expect(d.tickets[0]!.priority).toBe(4);
  });

  test("an unresolvable assignee is kept with resolved=false + a warning (never dropped or thrown)", () => {
    const d = parseDraft(JSON.stringify({ tickets: [{ title: "T", assignee: "Bob", priority: "Medium" }] }), ROSTER);
    expect(d.tickets[0]!.resolved).toBe(false);
    expect(d.tickets[0]!.assignee).toBe("Bob");            // raw string preserved for the lead to fix
    expect(d.tickets[0]!.assigneeLinearId).toBeNull();
    expect(d.warnings.some((w) => w.includes("Bob"))).toBe(true);
  });

  test("drops empty-title entries and flags a draft with no tickets", () => {
    expect(parseDraft(JSON.stringify({ epics: [], tickets: [{ title: "" }], questions: [] }), ROSTER).warnings)
      .toContain("the draft had no tickets — try being more specific");
  });

  test("fails soft on non-JSON and on invalid JSON", () => {
    expect(parseDraft("the model rambled with no json", ROSTER).warnings[0]).toContain("couldn't read a draft");
    expect(parseDraft("{not valid json,,,}", ROSTER).warnings[0]).toContain("wasn't valid JSON");
  });
});
