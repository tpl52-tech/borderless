/**
 * `ao awake [duration|off|status]` (design §18).
 *
 * A bounded `caffeinate -i` via the daemon so it outlives the command. Default 90 min, max 8h.
 * Durations: a number with optional m/h; a bare number = minutes.
 */

export async function run(_args: string[]): Promise<void> {
  throw new Error("cli.awake: not implemented (design §18)");
}
