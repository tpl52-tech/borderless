import { test, expect, describe } from "bun:test";
import { extractTickets, isBareTicket, ticketUrl, expandTicketSeed } from "../src/shared/ticket.ts";
import { DEFAULT_REVIEW_POLICY } from "../src/shared/profile.ts";

const KEYS = ["HOS", "ENG"];

describe("extractTickets (design §12.2)", () => {
  test("only allow-listed keys, word-bounded, deduped, max 4", () => {
    expect(extractTickets("fix HOS-12 and ENG-3", KEYS, "linear")).toEqual(["HOS-12", "ENG-3"]);
    expect(extractTickets("nope ABC-9 xHOS-1", KEYS, "linear")).toEqual([]); // ABC not allowed; xHOS not word-bounded
    expect(extractTickets("HOS-1 HOS-1 HOS-2", KEYS, "linear")).toEqual(["HOS-1", "HOS-2"]); // dedupe
    const many = extractTickets("HOS-1 HOS-2 HOS-3 HOS-4 HOS-5", KEYS, "linear");
    expect(many.length).toBe(4);
  });

  test("case-insensitive key match, normalized to uppercase", () => {
    expect(extractTickets("branch hos-42", KEYS, "linear")).toEqual(["HOS-42"]);
  });
});

describe("isBareTicket (design §7.1)", () => {
  test("exact single ticket only", () => {
    expect(isBareTicket("HOS-12", KEYS)).toBe(true);
    expect(isBareTicket("  eng-3 ", KEYS)).toBe(true);
    expect(isBareTicket("do HOS-12", KEYS)).toBe(false);
    expect(isBareTicket("ABC-1", KEYS)).toBe(false); // key not allowed
  });
});

describe("ticketUrl", () => {
  test("built from the workspace slug, never defaulted", () => {
    expect(ticketUrl("hos-1", "acme")).toBe("https://linear.app/acme/issue/HOS-1");
  });
});

describe("expandTicketSeed (design §7.3)", () => {
  test("claude/linear seed carries all four elements + reviewer tail", () => {
    const seed = expandTicketSeed("hos-12", "claude", {
      provider: "linear", reviewPolicy: DEFAULT_REVIEW_POLICY, ctoLogin: "reviewer",
    });
    expect(seed).toContain("HOS-12");
    expect(seed).toContain("Linear MCP");
    expect(seed).toContain("BLOCKED by");
    expect(seed).toContain("THERMO GRADE: <A-F>");
    expect(seed).toContain("approved by reviewer");
  });

  test("github provider reads via gh issue view", () => {
    const seed = expandTicketSeed("GH-9", "codex", {
      provider: "github", reviewPolicy: DEFAULT_REVIEW_POLICY, ctoLogin: "reviewer",
    });
    expect(seed).toContain("gh issue view GH-9");
  });

  test("reviewer tail follows the review policy", () => {
    const codexOnly = expandTicketSeed("HOS-1", "claude", {
      provider: "linear", reviewPolicy: { ...DEFAULT_REVIEW_POLICY, cto: false },
    });
    expect(codexOnly).toContain("approved by the code review bot");

    const none = expandTicketSeed("HOS-1", "claude", {
      provider: "linear", reviewPolicy: { codex: false, cto: false, reviewBot: false, ctoFollowups: false },
    });
    expect(none).toContain("all required reviews satisfied");
  });
});
