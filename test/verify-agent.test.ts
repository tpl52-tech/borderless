import { test, expect, describe } from "bun:test";
import { parseAgentVerdict } from "../src/shared/verify-agent.ts";

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
