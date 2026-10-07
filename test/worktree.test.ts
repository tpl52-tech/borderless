import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  provisionWorktree, removeWorktree, gitToplevel, slug, branchName, prBranchCandidates,
} from "../src/daemon/worktree.ts";

describe("prBranchCandidates (PR discovery branches, shake-out fix)", () => {
  test("Linear's branch first, then canonical; deduped when equal; null → canonical only", () => {
    expect(prBranchCandidates("COR-24", "tpl52", "tpl52/cor-24-sign-up")).toEqual(["tpl52/cor-24-sign-up", "tpl52/COR-24"]);
    expect(prBranchCandidates("COR-24", "tpl52", null)).toEqual(["tpl52/COR-24"]);
    expect(prBranchCandidates("COR-24", "tpl52", "   ")).toEqual(["tpl52/COR-24"]); // blank treated as absent
    expect(prBranchCandidates("COR-24", "tpl52", "tpl52/COR-24")).toEqual(["tpl52/COR-24"]); // equal → one
  });
});

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if ((r.status ?? 1) !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

describe("branch naming (design §7.4)", () => {
  test("slug lowercases and dashes", () => {
    expect(slug("Fix the Login Bug!")).toBe("fix-the-login-bug");
    expect(slug("")).toBe("session");
  });
  test("ticket + owner -> owner/TICKET; else ao/<slug>-<id8>", () => {
    expect(branchName({ ticket: "hos-1", branchOwner: "me", id8: "abc12345" })).toBe("me/HOS-1");
    expect(branchName({ title: "Cool Thing", id8: "abc12345" })).toBe("ao/cool-thing-abc12345");
    expect(branchName({ ticket: "hos-1", id8: "abc12345" })).toBe("ao/hos-1-abc12345"); // no owner
  });
});

describe("provisionWorktree / removeWorktree (design §7.4)", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "ao-wt-"));
    git(repo, "init", "-b", "main");
    git(repo, "config", "user.email", "t@example.com");
    git(repo, "config", "user.name", "Test");
    writeFileSync(join(repo, "README.md"), "hi\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "init");
  });

  afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

  test("gitToplevel resolves the repo, null outside one", () => {
    expect(gitToplevel(repo)).toBe(realpathSync(repo)); // git resolves symlinks (/var -> /private/var)
    const outside = mkdtempSync(join(tmpdir(), "ao-nogit-"));
    expect(gitToplevel(outside)).toBeNull();
    rmSync(outside, { recursive: true, force: true });
  });

  test("creates a worktree on a fresh branch, then removes it", () => {
    const res = provisionWorktree({ repoTop: repo, branch: "ao/feat-abc12345", defaultBranch: "main", id8: "abc12345" });
    expect(res.reused).toBe(false);
    expect(res.path).toBe(join(repo, ".worktrees", "ao", "abc12345"));
    expect(existsSync(res.path)).toBe(true);
    expect(existsSync(join(res.path, "README.md"))).toBe(true);

    // Reprovisioning the SAME path reuses it.
    const again = provisionWorktree({ repoTop: repo, branch: "ao/feat-abc12345", defaultBranch: "main", id8: "abc12345" });
    expect(again.reused).toBe(true);

    removeWorktree({ repoTop: repo, path: res.path, branch: "ao/feat-abc12345" });
    expect(existsSync(res.path)).toBe(false);
  });

  test("refuses when the branch is already checked out elsewhere", () => {
    provisionWorktree({ repoTop: repo, branch: "shared", defaultBranch: "main", id8: "aaaaaaaa" });
    expect(() =>
      provisionWorktree({ repoTop: repo, branch: "shared", defaultBranch: "main", id8: "bbbbbbbb" }),
    ).toThrow(/already checked out/i);
  });
});

describe("provisionWorktree continues an existing remote branch (fix-cycle base)", () => {
  let origin: string;
  let work: string;

  beforeEach(() => {
    origin = mkdtempSync(join(tmpdir(), "ao-origin-"));
    work = mkdtempSync(join(tmpdir(), "ao-work-"));
    spawnSync("git", ["init", "--bare", "-b", "main", origin]);
    git(work, "init", "-b", "main");
    git(work, "config", "user.email", "t@example.com");
    git(work, "config", "user.name", "Test");
    git(work, "remote", "add", "origin", origin);
    writeFileSync(join(work, "README.md"), "hi\n");
    git(work, "add", "-A"); git(work, "commit", "-m", "init"); git(work, "push", "-u", "origin", "main");
    // a PR branch pushed by a prior worker, carrying a commit that isn't on main
    git(work, "checkout", "-b", "tpl52/COR-1");
    writeFileSync(join(work, "feature.txt"), "from the prior worker\n");
    git(work, "add", "-A"); git(work, "commit", "-m", "work"); git(work, "push", "-u", "origin", "tpl52/COR-1");
    git(work, "checkout", "main");
    git(work, "branch", "-D", "tpl52/COR-1"); // drop the local branch: re-provision must come from origin
  });

  afterEach(() => {
    rmSync(origin, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });

  test("re-provisioning a pushed branch bases on origin/<branch> and keeps its commits", () => {
    const res = provisionWorktree({ repoTop: work, branch: "tpl52/COR-1", defaultBranch: "main", id8: "cccccccc" });
    expect(res.reused).toBe(false);
    expect(existsSync(join(res.path, "feature.txt"))).toBe(true); // continued the PR branch, not reset to main
  });

  test("a branch NOT on the remote still starts from the default branch", () => {
    const res = provisionWorktree({ repoTop: work, branch: "tpl52/COR-2", defaultBranch: "main", id8: "dddddddd" });
    expect(existsSync(join(res.path, "feature.txt"))).toBe(false); // fresh off main
    expect(existsSync(join(res.path, "README.md"))).toBe(true);
  });
});
