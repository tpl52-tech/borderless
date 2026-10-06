/**
 * CLI entry — `ao` (design §18).
 *
 * With no subcommand, launches the TUI (auto-starting the daemon). Several subcommands DELIBERATELY
 * bypass the daemon (setup, history, worktree, pr, autonomy, daemon, monitor, issue) so they work
 * when the daemon is wedged (design §3.1).
 *
 *   ao                                         launch the TUI
 *   ao setup [--check] [--only ...]            idempotent setup wizard
 *   ao daemon install|uninstall|status|stop|restart
 *   ao autonomy on|off|status|log|extend
 *   ao monitor deploy|restart|stop|status|logs|rollback|enable|dry-run|setup-copilot|setup-mcp
 *   ao history <session> [--full] [--no-follow]
 *   ao worktree list|prune [--days] [--dry-run] [--force]
 *   ao pr list|resolve <n> [--all|--outdated|indexes|ids] [-R repo]
 *   ao issue list|view
 *   ao awake [duration|off|status]
 */

const SUBCOMMANDS = [
  "setup", "daemon", "autonomy", "monitor", "history", "worktree", "pr", "issue", "awake",
] as const;

export async function main(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;

  // `ao attach <sessionId>` — convenience for Milestone 1 (attach is normally via the TUI).
  if (sub === "attach") {
    const sessionId = rest[0];
    if (!sessionId) throw new Error("usage: ao attach <sessionId>");
    const { attach } = await import("../client/attach.ts");
    await attach(sessionId);
    return;
  }

  if (sub && (SUBCOMMANDS as readonly string[]).includes(sub)) {
    throw new Error(`ao ${sub}: not implemented — see BUILD.md (design §18)`);
  }

  // no/unknown subcommand -> TUI
  const { main: tui } = await import("../client/index.tsx");
  await tui();
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
