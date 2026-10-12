/**
 * Tiny coercion helpers for untrusted JSON boundaries (LLM replies, POST bodies). Each is total — it never
 * throws, it normalizes a stray shape to a safe default — so a parser built on them can't be made to throw by
 * a malformed input. Shared by the lead-desk draft parser and the create-request normalizer.
 */

/** An array, or [] for anything else. */
export function asArray(v: unknown): unknown[] { return Array.isArray(v) ? v : []; }
/** A plain object, or {} for anything else (so `.field` access is always safe). */
export function obj(v: unknown): Record<string, unknown> { return v != null && typeof v === "object" ? v as Record<string, unknown> : {}; }
/** A trimmed string, or "" for anything else. */
export function str(v: unknown): string { return typeof v === "string" ? v.trim() : ""; }
/** A trimmed non-empty string, or null. */
export function strOrNull(v: unknown): string | null { const s = str(v); return s.length ? s : null; }
/** A finite integer, or null for anything else. */
export function intOrNull(v: unknown): number | null { return typeof v === "number" && Number.isInteger(v) ? v : null; }
