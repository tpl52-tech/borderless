/**
 * `ao issue list|view` (design §18).
 *
 * Bypasses the daemon. Reads tickets from the configured provider (Linear via MCP, or GitHub issues
 * via `gh issue view` for GH-issue profiles).
 */

export async function run(_args: string[]): Promise<void> {
  throw new Error("cli.issue: not implemented (design §18)");
}
