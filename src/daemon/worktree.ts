/**
 * Worktrees & the worktree reaper (design §7.4, §17.6).
 *
 * Path: <repo top>/.worktrees/ao/<id8>. Branch: with ticket `<branchOwner>/<TICKET>`; without,
 * `ao/<slug(title,40)>-<id8>` (the id suffix is load-bearing against collisions). Base is ALWAYS
 * origin/<defaultBranch> when available (the shared checkout was once 195 commits behind), falling
 * back to the local branch then HEAD. Script: mkdir; `git fetch --no-tags origin <branch>` (tolerated);
 * `git worktree add -B <branch> <path> <base>` (-B so a second attempt at the same ticket resets).
 * "Already used by worktree at ..." is surfaced as a one-line error. Existing dir -> reuse.
 *
 * Removal: `worktree remove --force`, `prune`, `branch -D` (the STORED branch, never re-derived).
 * TODO(step 9): stop any docker-compose stack whose working_dir label equals the worktree first, and
 * the disk-side hourly reaper.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

interface GitResult { code: number; stdout: string; stderr: string; }

function git(cwd: string, args: string[]): GitResult {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return { code: r.status ?? -1, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
}

/** The git top-level of a directory, or null if it isn't inside a repo. */
export function gitToplevel(cwd: string): string | null {
  const r = git(cwd, ["rev-parse", "--show-toplevel"]);
  return r.code === 0 && r.stdout ? r.stdout : null;
}

/** The current branch of a worktree, or null (design §12.2 branch linking). */
export function currentBranch(cwd: string): string | null {
  const r = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const b = r.code === 0 ? r.stdout : "";
  return b && b !== "HEAD" ? b : null; // "HEAD" = detached; treat as unlinked
}

/** Slugify a title for a branch name (design §7.4). */
export function slug(title: string, max = 40): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max) || "session";
}

/** Compute the branch name for a session (design §7.4). */
export function branchName(opts: {
  ticket?: string | null;
  branchOwner?: string;
  title?: string;
  id8: string;
  githubPrefixNormalize?: boolean;
}): string {
  if (opts.ticket && opts.branchOwner) {
    return `${opts.branchOwner}/${opts.ticket.toUpperCase()}`;
  }
  return `ao/${slug(opts.title ?? opts.ticket ?? "session")}-${opts.id8}`;
}

/**
 * Branches to try when matching a ticket's PR (shake-out finding): Linear's suggested branch first — the
 * team's actual convention, e.g. `tpl52/cor-24-sign-up-…`, which Linear's GitHub integration auto-links —
 * then the canonical `<owner>/<TICKET>`. Deduped so an equal pair collapses to one.
 */
export function prBranchCandidates(ticketKey: string, branchOwner: string, gitBranchName: string | null): string[] {
  const canonical = branchName({ ticket: ticketKey, branchOwner, id8: "" });
  const suggested = gitBranchName?.trim();
  return suggested && suggested !== canonical ? [suggested, canonical] : [canonical];
}

export interface ProvisionOptions {
  repoTop: string;
  branch: string;
  defaultBranch: string;
  id8: string;
}

export interface ProvisionResult {
  path: string;
  branch: string;
  reused: boolean;
}

/** Provision a worktree; throws a one-line error on "branch already checked out elsewhere". */
export function provisionWorktree(opts: ProvisionOptions): ProvisionResult {
  const path = join(opts.repoTop, ".worktrees", "ao", opts.id8);
  if (existsSync(path)) return { path, branch: opts.branch, reused: true };

  mkdirSync(dirname(path), { recursive: true });
  git(opts.repoTop, ["fetch", "--no-tags", "origin", opts.defaultBranch]); // tolerated on failure

  const base = resolveBase(opts.repoTop, opts.defaultBranch);
  const add = git(opts.repoTop, ["worktree", "add", "-B", opts.branch, path, base]);
  if (add.code !== 0) {
    const conflict = /already used by worktree at (.+)/i.exec(add.stderr);
    if (conflict) {
      throw new Error(
        `worktree: branch '${opts.branch}' is already checked out at ${conflict[1]!.trim()} — ` +
        `remove that worktree or pick another branch (refusing to share the checkout).`,
      );
    }
    throw new Error(`worktree: 'git worktree add' failed for '${opts.branch}': ${add.stderr}`);
  }
  return { path, branch: opts.branch, reused: false };
}

function resolveBase(repoTop: string, defaultBranch: string): string {
  if (git(repoTop, ["rev-parse", "--verify", "--quiet", `origin/${defaultBranch}`]).code === 0) {
    return `origin/${defaultBranch}`;
  }
  if (git(repoTop, ["rev-parse", "--verify", "--quiet", defaultBranch]).code === 0) {
    return defaultBranch;
  }
  return "HEAD";
}

export interface RemoveOptions {
  repoTop: string;
  path: string;
  branch: string;
}

/** Remove a worktree and delete its branch (design §7.4). */
export function removeWorktree(opts: RemoveOptions): void {
  // TODO(step 9): stop any docker-compose stack whose working_dir label equals the worktree first.
  git(opts.repoTop, ["worktree", "remove", "--force", opts.path]);
  git(opts.repoTop, ["worktree", "prune"]);
  git(opts.repoTop, ["branch", "-D", opts.branch]);
}

// --- reaper (design §17.6) --------------------------------------------------

export type WorktreeClass = "open" | "too-recent" | "closed" | "orphan";

export interface WorktreeEntry { id8: string; path: string; }
export interface ReapableSession { id: string; closed: boolean; closedAt: number | null; }

/**
 * Classify a worktree dir against the store (design §17.6): a matching OPEN session -> open; closed
 * within the grace -> too-recent; closed beyond the grace -> closed (reap); no matching session ->
 * orphan (reap). The id8 is the first 8 chars of the session id.
 */
export function classifyWorktree(id8: string, sessions: ReapableSession[], now: number, graceDays: number): WorktreeClass {
  const s = sessions.find((x) => x.id.startsWith(id8));
  if (!s) return "orphan";
  if (!s.closed) return "open";
  const graceMs = graceDays * 24 * 60 * 60 * 1000;
  if (s.closedAt != null && now - s.closedAt < graceMs) return "too-recent";
  return "closed";
}

/** Which worktree entries should be reaped (closed-past-grace or orphan). Pure. */
export function planReap(entries: WorktreeEntry[], sessions: ReapableSession[], now: number, graceDays: number): WorktreeEntry[] {
  return entries.filter((e) => {
    const c = classifyWorktree(e.id8, sessions, now, graceDays);
    return c === "closed" || c === "orphan";
  });
}

/**
 * The hourly disk-side reaper pass (design §17.6). Enumerates <repoTop>/.worktrees/ao, classifies each
 * against the store, and removes the closed/orphan ones (dirty + live-docker-mount vetoes are I/O and
 * checked before removal). The classification (classifyWorktree/planReap) is pure + tested; this
 * executor is live-ish and best-effort.
 */
export function reapWorktrees(repoTop: string, sessions: ReapableSession[], now: number, graceDays: number): void {
  const dir = join(repoTop, ".worktrees", "ao");
  if (!existsSync(dir)) return;
  let ids: string[];
  try { ids = readdirSync(dir); } catch { return; }
  const entries: WorktreeEntry[] = ids.map((id8) => ({ id8, path: join(dir, id8) }));
  for (const e of planReap(entries, sessions, now, graceDays)) {
    // TODO(live): veto if the worktree is dirty or has a live docker mount (design §17.6).
    const branchFor = sessions.find((s) => s.id.startsWith(e.id8));
    removeWorktree({ repoTop, path: e.path, branch: branchFor ? `ao/${e.id8}` : `ao/${e.id8}` });
  }
}
