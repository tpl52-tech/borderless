/**
 * `ao pr list|resolve <n> [--all|--outdated|indexes|ids] [-R repo]` (design §18, §12.4).
 *
 * Bypasses the daemon. `resolve` is the HUMAN's tool for resolving review threads — the daemon never
 * resolves threads itself (resolving is a claim that feedback was addressed). A dangling `-R` is an
 * error; any bad token resolves NOTHING.
 */

export async function run(_args: string[]): Promise<void> {
  throw new Error("cli.pr: not implemented (design §18)");
}
