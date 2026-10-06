/**
 * launchd management (design §5.4) — backing `ao daemon install|uninstall|status|stop|restart`.
 *
 * Label `com.agent-orchestrator.daemon`, plist in ~/Library/LaunchAgents, KeepAlive + RunAtLoad,
 * stdout/err to daemon.log, PATH copied from the installing shell, AO_HOME and the runtime toggles
 * forwarded IF SET. `restart` uses `launchctl kickstart -k` (a raw signal would just make KeepAlive
 * respawn the OLD code).
 */

export async function run(_args: string[]): Promise<void> {
  throw new Error("cli.launchd: not implemented (design §5.4)");
}
