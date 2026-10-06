/**
 * `ao history <session> [--full] [--no-follow]` (design §18, §11).
 *
 * Bypasses the daemon (direct transcript read) so it works when the daemon is wedged. Id-prefix beats
 * title-substring; open sessions win ties. Delegates rendering to the client history view (§11).
 */

export async function run(_args: string[]): Promise<void> {
  throw new Error("cli.history: not implemented (design §18)");
}
