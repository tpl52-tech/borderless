/**
 * Usage ledger (design §15.2, §12.8).
 *
 * Claude transcripts are sampled incrementally: per-file byte marks + CONSECUTIVE-DUPLICATE message-id
 * dedupe (usage rows repeat verbatim across streaming; naive summing overstated output by 96%). Cost is
 * an API-equivalent valuation via the pricing table (unknown model -> null, never zero). Codex/copilot
 * keep no transcript -> "unaccounted", not free.
 *
 * MILESTONE 8: the pure parser + aggregation (unit-tested) and a light incremental sampler for LOCAL
 * claude sessions. Subagent rollup, devbox on-box aggregation, and the samples/series/daily tables are
 * later refinements.
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import type { Store } from "../store.ts";
import { valuate } from "../../shared/pricing.ts";
import { claudeTranscriptPath } from "../../shared/transcript.ts";

export interface UsageDelta {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Parse usage rows from claude transcript lines, deduping consecutive-duplicate message ids (§15.2). */
export function parseClaudeUsage(lines: string[]): UsageDelta[] {
  const out: UsageDelta[] = [];
  let lastId: string | null = null;
  for (const line of lines) {
    let rec: any;
    try { rec = JSON.parse(line); } catch { continue; }
    const msg = rec?.message;
    const u = msg?.usage;
    if (!u) continue;
    const id: string | null = msg.id ?? null;
    if (id && id === lastId) continue; // usage rows repeat verbatim; count once
    lastId = id;
    out.push({
      model: msg.model ?? "unknown",
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
    });
  }
  return out;
}

/** Sum deltas by model. */
export function sumByModel(deltas: UsageDelta[]): Map<string, UsageDelta> {
  const m = new Map<string, UsageDelta>();
  for (const d of deltas) {
    const cur = m.get(d.model) ?? { model: d.model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    cur.input += d.input; cur.output += d.output; cur.cacheRead += d.cacheRead; cur.cacheWrite += d.cacheWrite;
    m.set(d.model, cur);
  }
  return m;
}

export interface UsageLedger { stop(): void; sampleNow(): void; }

export interface UsageLedgerDeps {
  store: Store;
  home?: string; // the USER home (for ~/.claude); defaults to os.homedir()
  intervalMs?: number;
}

export function startUsageLedger(deps: UsageLedgerDeps): UsageLedger {
  const home = deps.home ?? homedir();

  const sampleSession = (sessionId: string, cwd: string, resumeHandle: string): void => {
    const path = claudeTranscriptPath(home, cwd, resumeHandle);
    let size: number;
    try { size = statSync(path).size; } catch { return; }
    const offset = deps.store.usageProgress(sessionId, path);
    if (size <= offset) return;
    let buf: Buffer;
    try { buf = readFileSync(path); } catch { return; }
    const text = buf.subarray(offset).toString("utf8");
    const lastNL = text.lastIndexOf("\n");
    if (lastNL < 0) return;
    const complete = text.slice(0, lastNL + 1);
    for (const [model, d] of sumByModel(parseClaudeUsage(complete.split("\n")))) {
      deps.store.accumulateUsage(sessionId, model, {
        input: d.input, output: d.output, cacheRead: d.cacheRead, cacheWrite: d.cacheWrite,
        costMicros: valuate(model, { input: d.input, output: d.output, cacheRead: d.cacheRead, cacheWrite5m: d.cacheWrite, cacheWrite1h: 0 }),
      });
    }
    deps.store.setUsageProgress(sessionId, path, offset + Buffer.byteLength(complete, "utf8"));
  };

  const sampleNow = (): void => {
    for (const s of deps.store.listSessions({ includeClosed: true })) {
      if (s.tool === "claude" && s.location === "local" && s.resumeHandle) {
        try { sampleSession(s.id, s.cwd, s.resumeHandle); } catch { /* degrade to know-nothing */ }
      }
    }
  };

  const timer = setInterval(sampleNow, deps.intervalMs ?? 60_000);
  return { stop() { clearInterval(timer); }, sampleNow };
}
