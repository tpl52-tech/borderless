/**
 * `ao daemon install|uninstall|status|stop|restart` (design §5.4, §18).
 *
 * Thin wrapper over launchd management (src/cli/launchd.ts). Bypasses the running daemon so it can
 * recover a wedged one.
 */

export async function run(_args: string[]): Promise<void> {
  throw new Error("cli.daemon: not implemented (design §5.4)");
}
