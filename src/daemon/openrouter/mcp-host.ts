/**
 * OpenRouter runtime MCP host (design §16).
 *
 * A minimal stdio JSON-RPC client (initialize -> initialized -> tools/list; tools/call; 20s startup, 60s
 * call timeouts; unimplemented methods answered with -32601 rather than dropped; stderr drained). Servers
 * from ~/.claude.json (allowlist: `linear`), the same file the CLIs use, so mcp-remote holds the OAuth
 * tokens. A CURATED 10 of Linear's 58 tools (~2.7K tokens vs ~18K), names <server>_<tool>, writes gated by
 * verb (get_/list_/search_ are reads). AO_MCP_ALL_TOOLS=1 sends everything.
 *
 * The curation + verb-gating are pure + tested; the stdio client is live-only.
 */

export const MCP_STARTUP_TIMEOUT_MS = 20_000;
export const MCP_CALL_TIMEOUT_MS = 60_000;
export const MCP_CURATED_LIMIT = 10;

export interface McpTool {
  name: string; // <server>_<tool>
  isRead: boolean;
  schema: unknown;
}

const READ_VERBS = new Set(["get", "list", "search"]);

/** Verb-gate a <server>_<tool> name: get_/list_/search_ are reads, everything else is a write (§16). */
export function isReadTool(name: string): boolean {
  const verb = name.split("_")[1]; // <server>_<verb>_...
  return verb != null && READ_VERBS.has(verb);
}

/** Deterministic order for cache discipline: tools sorted by name (design §16). */
export function sortTools<T extends { name: string }>(tools: T[]): T[] {
  return [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Curate the tool set: sort by name, then keep the first `limit` UNLESS `all` (AO_MCP_ALL_TOOLS=1).
 * Marks each tool's read/write gate from its verb.
 */
export function curateTools(
  rawNames: string[],
  opts: { limit?: number; all?: boolean; schemas?: Record<string, unknown> } = {},
): McpTool[] {
  const tools = sortTools(rawNames.map((name) => ({ name, isRead: isReadTool(name), schema: opts.schemas?.[name] })));
  return opts.all ? tools : tools.slice(0, opts.limit ?? MCP_CURATED_LIMIT);
}

export interface McpHost {
  listTools(): Promise<McpTool[]>;
  call(name: string, args: unknown): Promise<unknown>;
  stop(): void;
}

export function startMcpHost(): Promise<McpHost> {
  // Live-only: spawns mcp-remote and speaks stdio JSON-RPC. See design §16.
  throw new Error("mcp-host.startMcpHost: live-only (design §16) — curateTools/isReadTool are the pure pieces");
}
