import { test, expect, describe } from "bun:test";
import {
  evaluateGate, nextSweepAction, dangerousTiers, MAX_CYCLES,
  type GateInput, type GateBlocker, type GateResult, type SweepDecisionInput,
} from "../src/shared/sweep-gate.ts";

// A fully-passing gate input; override one axis at a time.
const PASSING: GateInput = {
  kind: "in_review", preservationProven: true,
  checks: { ci: "success", "secrets-scan": "success" }, reviewerRedFindings: 0,
};
const gate = (over: Partial<GateInput> = {}): GateInput => ({ ...PASSING, ...over });

describe("evaluateGate (PRD §4)", () => {
  test("all three conditions met → pass, no blockers", () => {
    expect(evaluateGate(PASSING)).toEqual({ pass: true, blockers: [] });
  });

  test("preservation: unproven blocks, keyed by kind", () => {
    expect(evaluateGate(gate({ preservationProven: null })).blockers).toContain("regression-unproven");
    expect(evaluateGate(gate({ preservationProven: false })).blockers).toContain("regression-unproven");
    expect(evaluateGate(gate({ kind: "rescue", preservationProven: null })).blockers).toContain("acceptance-unproven");
  });

  test("CI: a failure blocks as ci-failing; pending/missing only as ci-pending", () => {
    expect(evaluateGate(gate({ checks: { ci: "failure", "secrets-scan": "success" } })).blockers).toContain("ci-failing");
    expect(evaluateGate(gate({ checks: { ci: "pending", "secrets-scan": "success" } })).blockers).toContain("ci-pending");
    expect(evaluateGate(gate({ checks: {} })).blockers).toContain("ci-pending"); // missing reads as pending
  });

  test("CI: a failing check outranks a pending one (don't report both)", () => {
    const b = evaluateGate(gate({ checks: { ci: "failure", "secrets-scan": "pending" } })).blockers;
    expect(b).toContain("ci-failing");
    expect(b).not.toContain("ci-pending");
  });

  test("reviewer: unrun (null) and red (>0) each block; zero is clean", () => {
    expect(evaluateGate(gate({ reviewerRedFindings: null })).blockers).toContain("reviewer-unrun");
    expect(evaluateGate(gate({ reviewerRedFindings: 2 })).blockers).toContain("reviewer-red");
    expect(evaluateGate(gate({ reviewerRedFindings: 0 })).blockers).not.toContain("reviewer-red");
  });

  test("absence is never a pass: nothing established → all three block", () => {
    const r = evaluateGate({ kind: "in_review", preservationProven: null, checks: {}, reviewerRedFindings: null });
    expect(r.pass).toBe(false);
    expect(r.blockers.sort()).toEqual(["ci-pending", "regression-unproven", "reviewer-unrun"].sort() as GateBlocker[]);
  });
});

const result = (blockers: GateBlocker[]): GateResult => ({ pass: blockers.length === 0, blockers });
const decide = (over: Partial<SweepDecisionInput>): ReturnType<typeof nextSweepAction> =>
  nextSweepAction({ cycles: 0, gate: result([]), escalation: null, ...over });

describe("nextSweepAction (PRD §4-§5)", () => {
  test("a passing gate is ready-to-merge", () => {
    expect(decide({ gate: result([]) }).kind).toBe("ready");
  });

  test("escalation stops for the human now, carrying the reason", () => {
    const a = decide({ gate: result(["ci-failing"]), escalation: "dangerous tier: auth" });
    expect(a).toEqual({ kind: "needs-human", reason: "dangerous tier: auth" });
  });

  test("blocker routing: fail CI → worker; pending CI → wait; unrun reviewer → reviewer; red → worker", () => {
    expect(decide({ gate: result(["ci-failing"]) }).kind).toBe("spawn-worker");
    expect(decide({ gate: result(["ci-pending"]) }).kind).toBe("wait-ci");
    expect(decide({ gate: result(["reviewer-unrun", "regression-unproven"]) }).kind).toBe("spawn-reviewer");
    expect(decide({ gate: result(["reviewer-red"]) }).kind).toBe("spawn-worker");
    expect(decide({ gate: result(["regression-unproven"]) }).kind).toBe("spawn-worker"); // reviewer ran, 0 red, preservation false
  });

  test("CI is settled before a review runs (pending outranks unrun reviewer)", () => {
    expect(decide({ gate: result(["ci-pending", "reviewer-unrun"]) }).kind).toBe("wait-ci");
  });

  test("8-cycle cap: the Nth worker is refused, earlier ones aren't", () => {
    expect(decide({ gate: result(["reviewer-red"]), cycles: MAX_CYCLES - 1 }).kind).toBe("spawn-worker");
    const capped = decide({ gate: result(["reviewer-red"]), cycles: MAX_CYCLES });
    expect(capped.kind).toBe("needs-human");
    expect(capped.reason).toContain("8-cycle cap");
    expect(capped.reason).toContain("reviewer-red");
  });

  test("the cap only bounds new worker cycles — waiting/reviewing still proceed at the cap", () => {
    expect(decide({ gate: result(["ci-pending"]), cycles: MAX_CYCLES }).kind).toBe("wait-ci");
    expect(decide({ gate: result(["reviewer-unrun"]), cycles: MAX_CYCLES }).kind).toBe("spawn-reviewer");
  });

  test("escalation outranks the cycle cap (the reason is the escalation, not the cap)", () => {
    const a = decide({ gate: result(["reviewer-red"]), escalation: "dangerous tier: money", cycles: MAX_CYCLES });
    expect(a).toEqual({ kind: "needs-human", reason: "dangerous tier: money" });
  });

  test("end to end: evaluateGate → nextSweepAction on a fresh in-review job wants CI to settle", () => {
    const g = evaluateGate({ kind: "in_review", preservationProven: null, checks: { ci: "pending", "secrets-scan": "pending" }, reviewerRedFindings: null });
    expect(nextSweepAction({ cycles: 1, gate: g, escalation: null }).kind).toBe("wait-ci");
  });
});

describe("dangerousTiers (PRD §4)", () => {
  test("flags the risky areas by path shape and segment", () => {
    expect(dangerousTiers([".github/workflows/ci.yml"])).toEqual(["ci-config"]);
    expect(dangerousTiers(["src/auth/login.ts"])).toEqual(["auth"]);
    expect(dangerousTiers(["app/features/payments/stripe.ts"])).toEqual(["money"]);
    expect(dangerousTiers(["db/migrations/003_add.sql"])).toEqual(["schema"]); // migrations + .sql, deduped
    expect(dangerousTiers(["supabase/policies/rls.sql"])).toEqual(["schema"]);
  });

  test("does not false-positive on lookalike segments or ordinary files", () => {
    expect(dangerousTiers(["src/author.ts"])).toEqual([]); // "author" != "auth" (segment match, not substring)
    expect(dangerousTiers(["src/shared/linear.ts", "README.md"])).toEqual([]);
  });

  test("auth: catches the common variants, not just a bare 'auth' segment", () => {
    expect(dangerousTiers(["src/authentication/index.ts"])).toEqual(["auth"]);
    expect(dangerousTiers(["lib/authenticate.ts"])).toEqual(["auth"]);
    expect(dangerousTiers(["api/authorization.ts"])).toEqual(["auth"]);
    expect(dangerousTiers(["src/authz.ts"])).toEqual(["auth"]);
    expect(dangerousTiers(["src/authn/guard.ts"])).toEqual(["auth"]);
  });

  test("deliberate exclusions: design tokens and LLM-cost pricing are not dangerous tiers", () => {
    expect(dangerousTiers(["src/styles/tokens.css"])).toEqual([]);
    expect(dangerousTiers(["src/design-tokens.ts"])).toEqual([]);
    expect(dangerousTiers(["src/shared/pricing.ts"])).toEqual([]); // LLM usage cost, not money-movement
    expect(dangerousTiers(["src/features/price-tag.tsx"])).toEqual([]);
  });

  test("collects the distinct tiers across a changeset", () => {
    const tiers = dangerousTiers(["src/auth/session.ts", ".github/deploy.yml", "db/schema.ts", "src/ui/button.ts"]);
    expect(tiers.sort()).toEqual(["auth", "ci-config", "schema"]);
  });
});
