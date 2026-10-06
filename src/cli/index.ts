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
 *   ao sweep ["In Review"]                     sync Linear issues + enqueue in-review sweep jobs
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

  // `ao sweep ["In Review"]` — refresh linear_issues (if a Linear key is configured) + enqueue
  // in-review sweep jobs. A thin client over the daemon's sweep.scanInReview (build order #2).
  if (sub === "sweep") {
    const { connectDaemon } = await import("../client/daemon-client.ts");
    const { paths } = await import("../shared/paths.ts");
    const client = await connectDaemon(paths().socket).catch(() => {
      throw new Error("ao sweep: daemon not running — start it with `ao` (the TUI) or `bun run src/daemon/index.ts`");
    });
    try {
      const stateName = rest[0];
      const r = await client.request<{ synced: number; created: number; started: number }>(
        "sweep.scanInReview", stateName ? { stateName } : {},
      );
      console.log(`sweep: synced ${r.synced} issue(s), enqueued ${r.created} job(s), started ${r.started} run(s)`);
    } finally {
      client.close();
    }
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
