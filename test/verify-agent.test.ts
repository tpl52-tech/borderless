import { test, expect, describe } from "bun:test";
import { parseAgentVerdict, buildVerifyAgentSeed } from "../src/shared/verify-agent.ts";

describe("buildVerifyAgentSeed (verify sweep V4 — the agent's prompt)", () => {
  const issue = { identifier: "COR-27", title: "profiles: deny-all RLS", description: "a user cannot read another user's row" };

  test("read-only by default: names the ticket, the ACs, the JSON contract, and forbids writes", () => {
    const s = buildVerifyAgentSeed(issue, { verdictPath: "/tmp/verdict.json" });
    expect(s).toContain("COR-27");
    expect(s).toContain("a user cannot read another user's row"); // the ACs are embedded
    expect(s).toContain("/tmp/verdict.json"); // where to write
    expect(s).toContain('"status": "pass" | "fail" | "inconclusive"'); // the output contract
    expect(s).toContain("READ-ONLY");
    expect(s).not.toContain("create throwaway test data");
  });

  test("allowWrites swaps in the throwaway-write rule (clean up, no real data)", () => {
    const s = buildVerifyAgentSeed(issue, { verdictPath: "/tmp/v.json", allowWrites: true });
    expect(s).toContain("DISPOSABLE TEST USER");
    expect(s).toContain("MUST delete anything you create");
    expect(s).not.toContain("You have READ-ONLY access");
  });

  test("a null description renders without crashing", () => {
    expect(buildVerifyAgentSeed({ identifier: "COR-1", title: "x", description: null }, { verdictPath: "/v" })).toContain("(none provided)");
  });
});

describe("parseAgentVerdict (verify sweep V4 — agent output → grounded findings)", () => {
  test("parses a clean { findings: [...] } object", () => {
    const out = parseAgentVerdict(JSON.stringify({ findings: [
      { criterion: "upsert is idempotent", status: "pass", evidence: "inserted twice, 1 row remained" },
      { criterion: "notification fires on approve", status: "fail", evidence: "no row in notifications" },
    ] }));
    expect(out.map((f) => f.status)).toEqual(["pass", "fail"]);
    expect(out[0]!.criterion).toBe("upsert is idempotent");
  });

  test("parses a bare array of findings", () => {
    expect(parseAgentVerdict('[{"criterion":"x","status":"pass","evidence":"ok"}]')[0]!.status).toBe("pass");
  });

  test("pulls the JSON out of markdown fences / surrounding prose", () => {
    const raw = "Here's my verdict:\n```json\n{ \"findings\": [ { \"criterion\": \"c\", \"status\": \"pass\", \"evidence\": \"e\" } ] }\n```\nDone.";
    expect(parseAgentVerdict(raw)).toEqual([{ criterion: "c", status: "pass", evidence: "e" }]);
  });

  test("pulls JSON out of surrounding prose with no fence (greedy bracket-span path)", () => {
    expect(parseAgentVerdict('Here is my verdict: {"findings":[{"criterion":"c","status":"pass","evidence":"e"}]} done.'))
      .toEqual([{ criterion: "c", status: "pass", evidence: "e" }]);
  });

  test("an unknown status becomes inconclusive (never a silent pass); an explicit inconclusive is preserved", () => {
    expect(parseAgentVerdict('[{"criterion":"c","status":"probably fine","evidence":"vibes"}]')[0]!.status).toBe("inconclusive");
    expect(parseAgentVerdict('[{"criterion":"c","status":"inconclusive","evidence":"couldn\'t tell"}]')[0]!.status).toBe("inconclusive");
  });

  test("a valid finding alongside a criterion-less one keeps the valid one (no collapse to the fallback)", () => {
    const out = parseAgentVerdict('{"findings":[{"criterion":"ok","status":"pass","evidence":"e"},{"status":"pass","evidence":"no criterion"}]}');
    expect(out).toEqual([{ criterion: "ok", status: "pass", evidence: "e" }]);
  });

  test("unparseable output ⇒ a single inconclusive finding", () => {
    const out = parseAgentVerdict("I couldn't figure it out, sorry.");
    expect(out).toHaveLength(1);
    expect(out[0]!.status).toBe("inconclusive");
    expect(out[0]!.evidence).toContain("could not be parsed");
  });

  test("an empty / shapeless findings list ⇒ inconclusive, not an empty pass", () => {
    expect(parseAgentVerdict('{"findings":[]}')[0]!.status).toBe("inconclusive");
    expect(parseAgentVerdict('{"findings":[{"status":"pass"}]}')[0]!.status).toBe("inconclusive"); // no criterion
  });
});
