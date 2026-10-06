/**
 * `ao autonomy on|off|status|log|extend` (design §13.7, §18).
 *
 * Bypasses the daemon: on/off/extend manipulate FILES (AUTONOMY_OFF, AUTONOMY_UNTIL) so they work
 * when the daemon is wedged, and MIRROR to the devbox's state dir over ssh (best effort). `status`
 * prints local AND box state (the box computes its own window; daemonAlive from systemd;
 * restartPending when the env file is newer than the loaded-at marker). Extension is capped at 12h.
 */

export async function run(_args: string[]): Promise<void> {
  throw new Error("cli.autonomy: not implemented (design §13.7)");
}
