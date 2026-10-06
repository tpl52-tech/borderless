/**
 * `ao monitor` — devbox box-daemon deploy & management (design §17.5, §17.7, §18).
 *
 * deploy: `git archive HEAD` of src/daemon src/shared package.json deploy piped over ssh into
 * ~/agent-orchestrator-monitor.new, atomic swap keeping .old (one rollback level), DEPLOYED_SHA written.
 * Env file regenerated from the Mac's config for IDENTITY keys only, CARRYING FORWARD the box's existing
 * AO_AUTONOMY/AO_ALERTS ("a deploy ships code, not authority"). Installs five user units. Deploy does NOT
 * start the service; restart uses systemctl (never a signal).
 *
 * The command builders are pure; the ssh execution is live-only.
 */

/** `git archive` args for the deploy tree (design §17.5). */
export function deployArchiveArgs(): string[] {
  return ["archive", "HEAD", "src/daemon", "src/shared", "package.json", "deploy"];
}

/** The five systemd --user units installed on the box (design §17.5). */
export const BOX_UNITS = [
  "agent-orchestrator-monitor.service",
  "agent-orchestrator-monitor-watchdog.service",
  "agent-orchestrator-monitor-watchdog.timer",
  "agent-orchestrator-monitor-cleanup.service",
  "agent-orchestrator-monitor-cleanup.timer",
] as const;

export const MONITOR_SUBCOMMANDS = [
  "deploy", "restart", "stop", "status", "logs", "rollback", "enable", "dry-run", "setup-copilot", "setup-mcp",
] as const;

export async function run(_args: string[]): Promise<void> {
  // Live-only: shells out to git archive | ssh + systemctl on the devbox. See design §17.5.
  throw new Error("cli.monitor: live-only (design §17.5) — deployArchiveArgs/BOX_UNITS are the pure pieces");
}
