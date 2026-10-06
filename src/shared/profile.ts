/**
 * Repository profiles — multi-repo support (design §4.3).
 *
 * Id derived from the repo slug if absent (`Elomi-inc/dorsia-monorepo` -> `elomi-inc-dorsia-monorepo`).
 * `legacy` is reserved; duplicate ids throw. A scalar `repo` matching no profile appends an implicit
 * profile. A stale explicit selection returns null rather than silently falling back.
 */

import { join } from "node:path";
import type { TicketProvider } from "./types.ts";

export interface ReviewPolicy {
  codex: boolean;
  cto: boolean;
  reviewBot: boolean;
  ctoFollowups: boolean;
}

export const DEFAULT_REVIEW_POLICY: ReviewPolicy = {
  codex: true,
  cto: true,
  reviewBot: true,
  ctoFollowups: true,
};

export interface Profile {
  id: string;
  repo: string;
  defaultBranch: string; // "main"
  localCwd?: string;
  remoteCwd?: string;
  ticketProvider: TicketProvider;
  githubIssuePrefix?: string; // GH profiles
  linearWorkspace?: string;
  linearTeamKeys?: string[];
  ctoLogin?: string;
  ctoBotLogin?: string;
  ctoLogins?: string[];
  ctoRepo?: string;
  ctoHostMatch?: string;
  reviewPolicy: ReviewPolicy;
}

/** Derive a profile id from a repo slug (design §4.3). */
export function profileIdFromRepo(repo: string): string {
  return repo.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Normalize raw profiles: fill ids from the repo slug, apply review-policy + defaultBranch +
 * ticketProvider defaults, reserve `legacy`, and throw on duplicate ids (design §4.3).
 */
export function normalizeProfiles(raw: Partial<Profile>[] | undefined): Profile[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: Profile[] = [];
  for (const p of raw) {
    const repo = (p.repo ?? "").trim();
    const id = (p.id ?? (repo ? profileIdFromRepo(repo) : "")).trim();
    if (!id) throw new Error("profile: cannot derive an id (no id and no repo)");
    if (id === "legacy") throw new Error("profile id 'legacy' is reserved");
    if (seen.has(id)) throw new Error(`profile: duplicate id '${id}'`);
    seen.add(id);
    out.push({
      id,
      repo,
      defaultBranch: p.defaultBranch?.trim() || "main",
      localCwd: p.localCwd,
      remoteCwd: p.remoteCwd,
      ticketProvider: p.ticketProvider ?? "linear",
      githubIssuePrefix: p.githubIssuePrefix,
      linearWorkspace: p.linearWorkspace,
      linearTeamKeys: p.linearTeamKeys,
      ctoLogin: p.ctoLogin,
      ctoBotLogin: p.ctoBotLogin,
      ctoLogins: p.ctoLogins,
      ctoRepo: p.ctoRepo,
      ctoHostMatch: p.ctoHostMatch,
      reviewPolicy: { ...DEFAULT_REVIEW_POLICY, ...(p.reviewPolicy ?? {}) },
    });
  }
  return out;
}

export interface ProfileSelection {
  explicitId?: string;
  explicitRepo?: string;
  defaultProfileId?: string;
  scalarRepo?: string;
}

/**
 * Select the active profile (design §4.3):
 * explicit id/repo -> defaultProfileId -> scalar repo match -> first.
 * A stale EXPLICIT selection returns null (never silently falls back to first).
 */
export function selectProfile(profiles: Profile[], sel: ProfileSelection): Profile | null {
  const byId = (id: string) => profiles.find((p) => p.id === id) ?? null;
  const byRepo = (repo: string) => profiles.find((p) => p.repo === repo) ?? null;

  if (sel.explicitId != null) return byId(sel.explicitId); // stale -> null
  if (sel.explicitRepo != null) return byRepo(sel.explicitRepo); // stale -> null
  if (sel.defaultProfileId != null) {
    const p = byId(sel.defaultProfileId);
    if (p) return p;
  }
  if (sel.scalarRepo != null) {
    const p = byRepo(sel.scalarRepo);
    if (p) return p;
  }
  return profiles[0] ?? null;
}

/**
 * Default cwd per location (design §4.3): devbox -> remoteCwd else /home/<sshuser>/repos/<id>
 * (root -> /root/repos/<id>); local -> localCwd else <stateDir>/repos/<id>.
 */
export function resolveCwd(
  profile: Profile,
  location: "local" | "devbox",
  stateDir: string,
  sshUser = "ubuntu",
): string {
  if (location === "devbox") {
    if (profile.remoteCwd) return profile.remoteCwd;
    const home = sshUser === "root" ? "/root" : `/home/${sshUser}`;
    return `${home}/repos/${profile.id}`;
  }
  return profile.localCwd || join(stateDir, "repos", profile.id);
}
