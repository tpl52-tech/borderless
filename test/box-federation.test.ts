import { test, expect, describe } from "bun:test";
import { buildManifest, manifestFresh, parseManifest, boxOwns, MANIFEST_MAX_AGE_MS } from "../src/daemon/box/manifest.ts";
import { reportStale, parseReport, REPORT_STALE_MS } from "../src/daemon/box/report.ts";
import type { Session } from "../src/shared/types.ts";

function session(over: Partial<Session>): Session {
  return {
    id: "s", taskId: "t", title: "", tool: "claude", location: "devbox", cwd: "/x", usesWorktree: false,
    worktreePath: null, model: "auto", permissions: "ask", effort: null, resumeHandle: null, tmuxSession: null,
    closed: false, createdAt: 0, closedAt: null, worktreeBranch: null, profileId: "legacy",
    codexTranscriptPath: null, codexSessionId: null, planning: false, draftMayBeStranded: false, ...over,
  };
}

describe("manifest (design §17.3)", () => {
  const now = 1_000_000_000;
  const sessions = [
    session({ id: "open1", title: "A", tool: "claude", profileId: "p1" }),
    session({ id: "plan1", planning: true }),
    session({ id: "closed1", closed: true }),
    session({ id: "local1", location: "local" }), // ignored (not devbox)
  ];

  test("buildManifest partitions devbox sessions", () => {
    const m = buildManifest(sessions, now);
    expect(m.allowed.sort()).toEqual(["open1", "plan1"]);
    expect(m.closed).toEqual(["closed1"]);
    expect(m.planning).toEqual(["plan1"]);
    expect(m.tool.open1).toBe("claude");
    expect(m.title.open1).toBe("A");
  });

  test("freshness inversion: stale/missing owns nothing", () => {
    const m = buildManifest(sessions, now);
    expect(manifestFresh(m, now)).toBe(true);
    expect(manifestFresh(m, now + MANIFEST_MAX_AGE_MS + 1)).toBe(false);
    expect(manifestFresh(null, now)).toBe(false);
  });

  test("boxOwns = fresh AND allowed AND in-roster AND not planning", () => {
    const m = buildManifest(sessions, now);
    expect(boxOwns(m, "open1", true, now)).toBe(true);
    expect(boxOwns(m, "open1", false, now)).toBe(false);         // not in roster
    expect(boxOwns(m, "plan1", true, now)).toBe(false);          // planning
    expect(boxOwns(m, "open1", true, now + MANIFEST_MAX_AGE_MS + 1)).toBe(false); // stale -> nothing
    expect(boxOwns(null, "open1", true, now)).toBe(false);
  });

  test("parseManifest tolerates garbage", () => {
    expect(parseManifest(JSON.stringify(buildManifest(sessions, now)))?.allowed.length).toBe(2);
    expect(parseManifest("not json")).toBeNull();
    expect(parseManifest("{}")).toBeNull();
  });
});

describe("report staleness (design §17.4)", () => {
  const rep = (observedAt: number) => ({ observedAt, autonomy: { enabled: true } } as any);
  test("stale after 90s by the box clock; null is stale", () => {
    const now = 1_000_000;
    expect(reportStale(rep(now - 1000), now)).toBe(false);
    expect(reportStale(rep(now - REPORT_STALE_MS - 1), now)).toBe(true);
    expect(reportStale(null, now)).toBe(true);
  });
  test("parseReport tolerates garbage", () => {
    expect(parseReport(JSON.stringify(rep(5)))?.observedAt).toBe(5);
    expect(parseReport("nope")).toBeNull();
  });
});
