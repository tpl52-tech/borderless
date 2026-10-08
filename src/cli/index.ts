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
 *   ao assign                                  suggested assignee per unblocked ticket (load-balanced)
 *   ao desk [delegate <who> "<title>" [notes]] list Lead Ops tasks / delegate one (PRD §9 lead desk)
 *   ao ask "<question>" [--yes]                Ask Borderless over live fleet state (PRD §10; --yes acts)
 *   ao console                                 the lead console TUI (SWEEPS/BOARDS/ASSIGN/LEAD DESK/ROSTER)
 *   ao web                                     open the browser lead console (the mockup design, live data)
 *   ao sync                                    pull the live Linear board into the store (no sweeps)
 *   ao verify                                  classify the Verifying tickets (ui / backend / mixed)
 *   ao verify script <TICKET>                  generate the human-QA tap-through for one Verifying ticket
 */

import type { DaemonClient } from "../client/daemon-client.ts";
import type { DelegateResult } from "../shared/lead-desk.ts";
import type { VerifyRow } from "../shared/verify.ts";

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

  // `ao assign` — one suggested assignee per unblocked ticket, load-balanced. Suggest only; the lead
  // decides (never auto-assigns, build order #6/PRD §8).
  if (sub === "assign") {
    await withDaemon("assign", async (client) => {
      const rows = await client.request<Array<{ ticketKey: string; netid: string; name: string; load: number }>>("assign.suggest");
      if (rows.length === 0) console.log("assign: nothing to suggest");
      else for (const r of rows) console.log(`  ${r.ticketKey}  →  ${r.name} (${r.netid}, load ${r.load})`);
    });
    return;
  }

  // `ao desk` — the lead desk (PRD §9): list open Lead Ops tasks, or `ao desk delegate <who> "<title>"
  // ["notes"]` to capture a task → a Lead Ops issue assigned to the member + a best-effort Slack DM.
  if (sub === "desk") {
    const [action, who, title, notes] = rest;
    await withDaemon("desk", async (client) => {
      if (action === "delegate") {
        if (!who || !title) throw new Error('usage: ao desk delegate <who> "<title>" ["notes"]');
        const r = await client.request<DelegateResult>("lead.delegate", { who, title, notes });
        if (!r.created) console.log(`desk: not delegated — ${r.reason ?? "unknown reason"}`);
        else console.log(`desk: ${r.ticketKey} → ${r.assignee}${r.dmSent ? " (Slack DM sent)" : " (no Slack DM)"}${r.url ? `  ${r.url}` : ""}`);
        return;
      }
      const rows = await client.request<Array<{ ticketKey: string; title: string; assignee: string; state: string }>>("lead.desk");
      if (rows.length === 0) console.log("desk: no open Lead Ops tasks");
      else for (const r of rows) console.log(`  ${r.ticketKey}  [${r.state}]  →  ${r.assignee}  ${r.title}`);
    });
    return;
  }

  // `ao ask "<question>" [--yes]` — Ask Borderless (PRD §10): a one-shot fleet-aware question. Advisory by
  // default; --yes auto-confirms the consequential tools (reassign/enqueue/resolve/comment).
  if (sub === "ask") {
    const allowActions = rest.includes("--yes");
    const question = rest.filter((a) => a !== "--yes").join(" ").trim();
    if (!question) throw new Error('usage: ao ask "<question>" [--yes]');
    await withDaemon("ask", async (client) => {
      const r = await client.request<{ answer: string; steps: number; costMicros: number; configured: boolean }>("ask.run", { question, allowActions });
      if (!r.configured) { console.log("ask: set `openRouterApiKey` in ~/.borderless/config.json to enable Ask Borderless"); return; }
      console.log(r.answer || "(no answer)");
      const cost = r.costMicros ? ` · $${(r.costMicros / 1e6).toFixed(4)}` : "";
      console.error(`(${r.steps} step${r.steps === 1 ? "" : "s"}${cost})`); // stderr: keeps the answer clean on stdout
    });
    return;
  }

  // `ao sync` — pull the live Linear board into the store (no sweeps). The terminal twin of the Refresh button.
  if (sub === "sync") {
    await withDaemon("sync", async (client) => {
      const r = await client.request<{ synced: number; configured: boolean }>("sync.run");
      console.log(r.configured ? `sync: ${r.synced} issue(s) pulled from Linear` : "sync: set `linearApiKey` + `linearTeamKeys` in ~/.borderless/config.json");
    });
    return;
  }

  // `ao verify` — classify the Verifying tickets (PRD §13 V1): what human QA can tap-through vs the invisible
  // backend properties (RLS/trigger/schema/server-logic/data-integrity/storage) that need verification.
  if (sub === "verify") {
    // `ao verify script <COR-123>` — generate the human-QA tap-through for one Verifying ticket.
    if (rest[0] === "script") {
      const ticketKey = rest[1];
      if (!ticketKey) throw new Error("usage: ao verify script <TICKET>");
      await withDaemon("verify", async (client) => {
        const r = await client.request<{ ticketKey: string; script: string }>("verify.script", { ticketKey });
        console.log(r.script);
      });
      return;
    }
    await withDaemon("verify", async (client) => {
      const rows = await client.request<VerifyRow[]>("verify.scan");
      if (rows.length === 0) { console.log("verify: no tickets in Verifying (or no repo configured)"); return; }
      for (const r of rows) {
        const props = r.backendProperties.length ? `  needs: ${r.backendProperties.join(", ")}` : "";
        console.log(`  ${r.ticketKey}  [${r.verifiability}]${props}  ${r.title}`);
      }
    });
    return;
  }

  // `ao web` — open the browser lead console (PRD §11): the mockup design wired to live data, localhost only.
  if (sub === "web") {
    const { ensureDaemon, openUrl } = await import("../client/runtime.ts");
    const { loadOperatorConfig, DEFAULT_WEB_PORT } = await import("../shared/config.ts");
    (await ensureDaemon()).close(); // starts the daemon (and its web server) if it isn't already up
    const url = `http://127.0.0.1:${loadOperatorConfig().webPort ?? DEFAULT_WEB_PORT}`;
    console.log(`Borderless web console: ${url}`);
    openUrl(url);
    return;
  }

  // `ao console` — the Borderless lead console (PRD §11): SWEEPS/BOARDS/ASSIGN/LEAD DESK/ROSTER screens.
  if (sub === "console") {
    const { runConsole } = await import("../client/console.tsx");
    await runConsole();
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
