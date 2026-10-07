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
 *   ao rescue [authorize <ticketKey>]          list eligible overdue tickets / authorize a rescue
 *   ao boards                                  unblocked tickets, ranked by critical-path impact
 */

import type { DaemonClient } from "../client/daemon-client.ts";

const SUBCOMMANDS = [
  "setup", "daemon", "autonomy", "monitor", "history", "worktree", "pr", "issue", "awake",
] as const;

/** Connect to the daemon, run `fn`, and always close — the shared shape of the daemon-backed subcommands. */
async function withDaemon<T>(cmd: string, fn: (client: DaemonClient) => Promise<T>): Promise<T> {
  const { connectDaemon } = await import("../client/daemon-client.ts");
  const { paths } = await import("../shared/paths.ts");
  const client = await connectDaemon(paths().socket).catch(() => {
    throw new Error(`ao ${cmd}: daemon not running — start it with \`ao\` (the TUI) or \`bun run src/daemon/index.ts\``);
  });
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

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

  // `ao sweep ["In Review"]` — refresh linear_issues (if a Linear key is configured) + enqueue + run
  // in-review sweep jobs (build order #2/#3c).
  if (sub === "sweep") {
    await withDaemon("sweep", async (client) => {
      const stateName = rest[0];
      const r = await client.request<{ synced: number; created: number; started: number }>(
        "sweep.scanInReview", stateName ? { stateName } : {},
      );
      console.log(`sweep: synced ${r.synced} issue(s), enqueued ${r.created} job(s), started ${r.started} run(s)`);
    });
    return;
  }

  // `ao rescue [authorize <ticket>]` — the Rescues queue + per-ticket authorization. Nothing auto-starts;
  // authorize is the lead's explicit go-ahead (build order #4b).
  if (sub === "rescue") {
    await withDaemon("rescue", async (client) => {
      if (rest[0] === "authorize") {
        const ticket = rest[1];
        if (!ticket) throw new Error("usage: ao rescue authorize <ticketKey>");
        const r = await client.request<{ ticketKey: string; created: boolean; started: boolean }>("rescue.authorize", { ticket });
        console.log(`rescue ${r.ticketKey}: ${r.created ? "authorized" : "already queued"}${r.started ? ", started" : ""}`);
      } else {
        const queue = await client.request<Array<{ ticketKey: string; title: string; daysOverdue: number }>>("rescue.scan");
        if (queue.length === 0) console.log("rescue: no eligible overdue tickets");
        else for (const c of queue) console.log(`  ${c.ticketKey}  ${c.daysOverdue}d overdue  ${c.title}`);
      }
    });
    return;
  }

  // `ao boards` — the "do next" board: unblocked tickets ranked by how much each unblocks (build order #6).
  if (sub === "boards") {
    await withDaemon("boards", async (client) => {
      const rows = await client.request<Array<{ ticketKey: string; title: string; downstream: number }>>("boards.get");
      if (rows.length === 0) console.log("boards: nothing actionable right now");
      else for (const r of rows) console.log(`  ${r.ticketKey}  unblocks ${r.downstream}  ${r.title}`);
    });
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
