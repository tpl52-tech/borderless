import { test, expect, describe } from "bun:test";
import { seedTicket } from "../src/daemon/session-manager.ts";

describe("seedTicket (which ticket a spawn's worktree branch keys on)", () => {
  const teamKeys = ["COR"];

  test("ignoreSeedTicket → null regardless of the seed (a reviewer gets a throwaway branch)", () => {
    expect(seedTicket({ ignoreSeedTicket: true, seed: "You are an INDEPENDENT reviewer of PR #4 for COR-9", teamKeys, provider: "linear" })).toBeNull();
    expect(seedTicket({ ignoreSeedTicket: true, seed: "COR-9", teamKeys, provider: "linear" })).toBeNull();
  });

  test("a bare-ticket seed resolves to that key, uppercased", () => {
    expect(seedTicket({ seed: "cor-9", teamKeys, provider: "linear" })).toBe("COR-9");
  });

  test("a sentence seed mentioning a ticket resolves to it (the worker lands on the ticket branch)", () => {
    expect(seedTicket({ seed: "Implement Linear ticket COR-9.\n\nAcceptance criteria:\n- …", teamKeys, provider: "linear" })).toBe("COR-9");
    expect(seedTicket({ title: "Drive COR-42", teamKeys, provider: "linear" })).toBe("COR-42");
  });

  test("no ticket present, or a key outside teamKeys, → null", () => {
    expect(seedTicket({ seed: "just do the thing", teamKeys, provider: "linear" })).toBeNull();
    expect(seedTicket({ teamKeys, provider: "linear" })).toBeNull();
    expect(seedTicket({ seed: "Implement SBX-9", teamKeys, provider: "linear" })).toBeNull(); // SBX not in teamKeys
  });
});
