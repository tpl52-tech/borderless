/**
 * `ao worktree list|prune [--days] [--dry-run] [--force]` (design §18, §17.6).
 *
 * Bypasses the daemon. NOTE the grace inconsistency to resolve (BUILD.md known gaps): the config
 * default is 7 days but the exported constant is 0 and applies only to this CLI path.
 */

export async function run(_args: string[]): Promise<void> {
  throw new Error("cli.worktree: not implemented (design §18)");
}
