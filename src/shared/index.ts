/**
 * Shared domain layer (design §3.2). Re-exports the vocabulary used by daemon, client, and CLI:
 * domain types, wire protocol, per-CLI spawn spec, config, settings, profiles, focus
 * classification, ticket/transcript parsing, usage pricing, autonomy window, remote builders, team roster,
 * the sweep gate.
 */

export * from "./types.ts";
export * from "./wire.ts";
export * from "./paths.ts";
export * from "./status.ts";
export * from "./config.ts";
export * from "./settings.ts";
export * from "./profile.ts";
export * from "./spawn-spec.ts";
export * from "./focus.ts";
export * from "./ticket.ts";
export * from "./transcript.ts";
export * from "./pricing.ts";
export * from "./autonomy-window.ts";
export * from "./remote.ts";
export * from "./roster.ts";
export * from "./sweep-gate.ts";
export * from "./rescue.ts";
export * from "./boards.ts";
