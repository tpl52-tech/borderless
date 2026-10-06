/**
 * Transcript parsing (design §11).
 *
 * Claude transcript path: <home>/.claude/projects/<cwd with every "/" and "." replaced by "-">/
 *   <resumeHandle>.jsonl (exact, because we minted the session id).
 * Codex rollouts: <CODEX_HOME or ~/.codex>/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl, discovered
 *   after spawn by matching session_meta.payload.cwd on the first line.
 *
 * Incremental reader: byte offset via `tail -c +<offset+1>` (1-indexed) over ssh or local read;
 * a follower returns only COMPLETE lines and carries partial tails; shrink -> reset. Format
 * sniffing scans every line of a chunk, not the first.
 */

export type TranscriptFormat = "claude" | "codex";

export interface TranscriptChunk {
  /** complete lines parsed this read. */
  lines: string[];
  /** new byte offset to resume from. */
  offset: number;
  /** true if the file shrank (transcript restarted) — caller resets. */
  reset: boolean;
}

/**
 * Compute the exact claude transcript path for a session (design §11):
 * <home>/.claude/projects/<cwd with every "/" and "." replaced by "-">/<resumeHandle>.jsonl.
 * Exact, because we minted the session id.
 */
export function claudeTranscriptPath(home: string, cwd: string, resumeHandle: string): string {
  const slug = cwd.replace(/[/.]/g, "-");
  return `${home}/.claude/projects/${slug}/${resumeHandle}.jsonl`;
}

/**
 * Read the next chunk of a transcript from a byte offset, returning only complete lines.
 * TODO(step 2/5): implement the incremental follower + shrink detection.
 */
export function readChunk(_path: string, _offset: number): Promise<TranscriptChunk> {
  throw new Error("transcript.readChunk: not implemented (design §11)");
}

/** Sniff the format of a chunk by scanning every line (design §11). */
export function sniffFormat(_lines: string[]): TranscriptFormat | null {
  throw new Error("transcript.sniffFormat: not implemented (design §11)");
}
