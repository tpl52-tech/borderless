import { test, expect, describe } from "bun:test";
import {
  normalizeProfiles, selectProfile, resolveCwd, profileIdFromRepo, DEFAULT_REVIEW_POLICY,
  type Profile,
} from "../src/shared/profile.ts";

describe("normalizeProfiles (design §4.3)", () => {
  test("derives id from repo slug and applies defaults", () => {
    const [p] = normalizeProfiles([{ repo: "Elomi-inc/dorsia-monorepo" }]);
    expect(p!.id).toBe("elomi-inc-dorsia-monorepo");
    expect(p!.defaultBranch).toBe("main");
    expect(p!.ticketProvider).toBe("linear");
    expect(p!.reviewPolicy).toEqual(DEFAULT_REVIEW_POLICY);
  });

  test("merges a partial review policy over the defaults", () => {
    const [p] = normalizeProfiles([{ repo: "o/r", reviewPolicy: { cto: false } as any }]);
    expect(p!.reviewPolicy).toEqual({ ...DEFAULT_REVIEW_POLICY, cto: false });
  });

  test("throws on duplicate ids and on reserved `legacy`", () => {
    expect(() => normalizeProfiles([{ id: "x", repo: "a/b" }, { id: "x", repo: "c/d" }])).toThrow(/duplicate/);
    expect(() => normalizeProfiles([{ id: "legacy", repo: "a/b" }])).toThrow(/reserved/);
  });

  test("profileIdFromRepo slugifies", () => {
    expect(profileIdFromRepo("Owner/Repo.Name")).toBe("owner-repo-name");
  });
});

describe("selectProfile (design §4.3)", () => {
  const profiles = normalizeProfiles([{ repo: "org/a" }, { repo: "org/b" }]);
  const idA = "org-a";
  const idB = "org-b";

  test("explicit id wins; a stale explicit id returns null (no fallback)", () => {
    expect(selectProfile(profiles, { explicitId: idB })!.id).toBe(idB);
    expect(selectProfile(profiles, { explicitId: "missing" })).toBeNull();
  });

  test("explicit repo, then defaultProfileId, then scalar repo, then first", () => {
    expect(selectProfile(profiles, { explicitRepo: "org/b" })!.id).toBe(idB);
    expect(selectProfile(profiles, { defaultProfileId: idB })!.id).toBe(idB);
    expect(selectProfile(profiles, { scalarRepo: "org/b" })!.id).toBe(idB);
    expect(selectProfile(profiles, {})!.id).toBe(idA); // first
  });

  test("a defaultProfileId that doesn't exist falls through to first", () => {
    expect(selectProfile(profiles, { defaultProfileId: "nope" })!.id).toBe(idA);
  });

  test("empty profiles -> null", () => {
    expect(selectProfile([], { explicitId: "x" })).toBeNull();
  });
});

describe("resolveCwd (design §4.3)", () => {
  const base: Profile = {
    id: "org-a", repo: "org/a", defaultBranch: "main", ticketProvider: "linear",
    reviewPolicy: DEFAULT_REVIEW_POLICY,
  };
  test("local: localCwd else <stateDir>/repos/<id>", () => {
    expect(resolveCwd(base, "local", "/state")).toBe("/state/repos/org-a");
    expect(resolveCwd({ ...base, localCwd: "/code/a" }, "local", "/state")).toBe("/code/a");
  });
  test("devbox: remoteCwd else /home/<user>/repos/<id>, /root for root", () => {
    expect(resolveCwd(base, "devbox", "/state", "ubuntu")).toBe("/home/ubuntu/repos/org-a");
    expect(resolveCwd(base, "devbox", "/state", "root")).toBe("/root/repos/org-a");
    expect(resolveCwd({ ...base, remoteCwd: "/srv/a" }, "devbox", "/state")).toBe("/srv/a");
  });
});
