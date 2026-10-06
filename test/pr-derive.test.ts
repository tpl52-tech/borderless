import { test, expect, describe } from "bun:test";
import { deriveStates, deriveCi, type DeriveConfig } from "../src/daemon/pr-derive.ts";

const HEAD = "deadbeef1234";
const CFG: DeriveConfig = {
  ctoLogins: ["reviewer"], codexBotLogin: "codex", reviewBotLogin: "github-actions",
  greenlightSubstring: "greenlight", ciIgnore: [], operatorLogin: "me",
};

function basePr(over: Record<string, any> = {}): Record<string, any> {
  return {
    number: 1, title: "Fix", url: "u", state: "OPEN", isDraft: false,
    updatedAt: "2026-01-01T00:00:00Z", headRefName: "me/HOS-1", mergeable: "MERGEABLE",
    commits: { nodes: [{ commit: { oid: HEAD, committedDate: "2026-01-01T00:00:00Z" } }] },
    reviewRequests: { totalCount: 0, nodes: [] },
    reviews: { nodes: [] },
    comments: { totalCount: 0, nodes: [] },
    reviewThreads: { totalCount: 0, nodes: [] },
    statusCheckRollup: { state: "SUCCESS", contexts: { nodes: [
      { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
    ] } },
    ...over,
  };
}

describe("deriveCi (design §12.4)", () => {
  const ci = (nodes: any[]) => deriveCi({ statusCheckRollup: { state: "X", contexts: { nodes } } }, CFG);
  test("a failed non-ignored check -> failure with the name", () => {
    expect(ci([{ __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "FAILURE" }]))
      .toEqual({ ciState: "failure", failedChecks: ["build"] });
  });
  test("a failed check that is ALL ignored downgrades (greenlight)", () => {
    expect(ci([{ __typename: "CheckRun", name: "greenlight", status: "COMPLETED", conclusion: "FAILURE" }]))
      .toEqual({ ciState: "success", failedChecks: [] });
  });
  test("an in-progress check -> pending", () => {
    expect(ci([{ __typename: "CheckRun", name: "build", status: "IN_PROGRESS" }]))
      .toEqual({ ciState: "pending", failedChecks: [] });
  });
  test("StatusContext state is handled", () => {
    expect(ci([{ __typename: "StatusContext", context: "ci/ext", state: "FAILURE" }]))
      .toEqual({ ciState: "failure", failedChecks: ["ci/ext"] });
  });
});

describe("deriveStates end to end (design §12.4)", () => {
  test("a clean approved PR derives approved/approved/A/converged", () => {
    const pr = basePr({
      reviews: { nodes: [{ author: { login: "reviewer" }, state: "APPROVED", submittedAt: "2026-01-02T00:00:00Z", commit: { oid: HEAD } }] },
      comments: { totalCount: 3, nodes: [
        { author: { login: "someone" }, body: "@codex review please", createdAt: "2026-01-01T01:00:00Z" },
        { author: { login: "codex" }, body: `I didn't find any major issues.\nReviewed commit: ${HEAD}`, createdAt: "2026-01-01T02:00:00Z" },
        { author: { login: "me" }, body: "THERMO GRADE: A", createdAt: "2026-01-01T03:00:00Z" },
      ] },
      reviewThreads: { totalCount: 2, nodes: [{ isResolved: true }, { isResolved: false }] },
      statusCheckRollup: { state: "SUCCESS", contexts: { nodes: [
        { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
        { __typename: "CheckRun", name: "greenlight", status: "COMPLETED", conclusion: "SUCCESS" },
      ] } },
    });
    const d = deriveStates(pr, CFG);
    expect(d.headSha).toBe(HEAD);
    expect(d.ciState).toBe("success");
    expect(d.greenlightState).toBe("converged");
    expect(d.ctoState).toBe("approved");
    expect(d.ctoReviewedSha).toBe(HEAD);
    expect(d.codexState).toBe("approved");
    expect(d.codexReviewedSha).toBe(HEAD);
    expect(d.thermoGrade).toBe("A");
    expect(d.thermoCycles).toBe(1);
    expect(d.unresolvedComments).toBe(1);
    expect(d.mergeable).toBe("MERGEABLE");
  });

  test("a CTO APPROVED on an OLD sha is stale-approval", () => {
    const pr = basePr({
      commits: { nodes: [{ commit: { oid: HEAD, committedDate: "2026-01-05T00:00:00Z" } }] },
      reviews: { nodes: [{ author: { login: "reviewer" }, state: "APPROVED", submittedAt: "2026-01-02T00:00:00Z", commit: { oid: "0000old0000" } }] },
    });
    expect(deriveStates(pr, CFG).ctoState).toBe("stale-approval");
  });

  test("CTO CHANGES_REQUESTED maps through", () => {
    const pr = basePr({
      reviews: { nodes: [{ author: { login: "reviewer" }, state: "CHANGES_REQUESTED", submittedAt: "2026-01-02T00:00:00Z", commit: { oid: HEAD } }] },
    });
    expect(deriveStates(pr, CFG).ctoState).toBe("changes-requested");
  });

  test("codex `requested` when a fresh ask post-dates the codex answer and it doesn't cover head", () => {
    const pr = basePr({
      comments: { totalCount: 2, nodes: [
        { author: { login: "codex" }, body: "looked. Reviewed commit: 0000old0000", createdAt: "2026-01-01T02:00:00Z" },
        { author: { login: "me" }, body: "@codex review", createdAt: "2026-01-01T03:00:00Z" },
      ] },
    });
    expect(deriveStates(pr, CFG).codexState).toBe("requested");
  });
});
