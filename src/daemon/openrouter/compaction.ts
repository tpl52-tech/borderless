/**
 * Context compaction (design §16).
 *
 * At 70% of the model's window, keep the 2 HEAD messages, keep a BYTE-BUDGETED tail (35% of size, 2-8
 * messages; a message-count tail once left the bulk of the context in place), SNAP to tool-call
 * boundaries (never orphan a tool result), summarize the middle with a cheap model. Compact rarely and in
 * large chunks: one compaction costs about 100 cached turns.
 *
 * planCompaction is pure + tested; the actual summarization + atomic transcript replace is the runtime's.
 */

export const COMPACT_AT_FRACTION = 0.7;
export const HEAD_KEEP = 2;
export const TAIL_BUDGET_FRACTION = 0.35;
export const TAIL_MIN = 2;
export const TAIL_MAX = 8;

export interface CompactMessage {
  role: string; // "user" | "assistant" | "tool" | "system"
  /** true if this message is a tool RESULT (must not be orphaned from its tool_use, §16). */
  isToolResult?: boolean;
  bytes: number;
}

export interface CompactionPlan {
  /** number of head messages to keep verbatim. */
  head: number;
  /** index (into messages) where the kept tail begins. */
  tailStart: number;
  /** [start, end) range of messages to replace with a summary; empty when nothing to compact. */
  summarize: [number, number];
}

/** Decide what to keep vs summarize (design §16). Pure. */
export function planCompaction(messages: CompactMessage[]): CompactionPlan {
  const n = messages.length;
  // Nothing worth compacting if head + a minimal tail already covers everything.
  if (n <= HEAD_KEEP + TAIL_MIN) return { head: Math.min(HEAD_KEEP, n), tailStart: n, summarize: [n, n] };

  const total = messages.reduce((s, m) => s + m.bytes, 0);
  const budget = total * TAIL_BUDGET_FRACTION;

  let bytes = 0;
  let count = 0;
  let tailStart = n;
  for (let i = n - 1; i >= HEAD_KEEP; i--) {
    bytes += messages[i]!.bytes;
    count += 1;
    tailStart = i;
    if (count >= TAIL_MIN && (bytes >= budget || count >= TAIL_MAX)) break;
  }

  // Snap to a tool-call boundary: never begin the tail on a tool RESULT (it would orphan its tool_use).
  while (tailStart > HEAD_KEEP && messages[tailStart]!.isToolResult) tailStart -= 1;

  return { head: HEAD_KEEP, tailStart, summarize: [HEAD_KEEP, tailStart] };
}
