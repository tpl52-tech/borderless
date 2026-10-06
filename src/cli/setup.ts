/**
 * `ao setup` — the idempotent setup wizard (design §18).
 *
 * `ao setup [--check] [--only local|config|repos|devbox|remote-repos|deploy]`. Report before act.
 * Local preflight of git/gh/bun and optional ssh/sqlite3/python3/jq WITH REASONS (sqlite3 missing
 * makes the fleet report idle). Config prompts SKIP inherited org keys. Repos cloned into
 * <stateDir>/repos/<id> with origin validation across https/ssh/git forms. Writes config.json 0600.
 */

export async function run(_args: string[]): Promise<void> {
  throw new Error("cli.setup: not implemented (design §18)");
}
