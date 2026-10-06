/**
 * Usage pricing (design §15.2).
 *
 * Agents run on subscriptions, so cost is an API-equivalent VALUATION; the headline is share of observed
 * fleet spend. Per-model input/output $/MTok with LONGEST-PREFIX model matching (dated snapshot ids);
 * cache read 0.1x, 5m write 1.25x, 1h write 2x. Unknown model -> null cost, NEVER zero. Provider-reported
 * cost (OpenRouter) overrides the table and is flagged as a receipt.
 */

export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_5M_MULTIPLIER = 1.25;
export const CACHE_WRITE_1H_MULTIPLIER = 2.0;

/**
 * The price table, keyed by model-id PREFIX (longest wins). Illustrative $/MTok — swap for a maintained
 * source. More specific prefixes (e.g. a dated snapshot) can be added and will win over the family.
 */
export const PRICE_TABLE: Record<string, ModelPrice> = {
  "claude-opus": { inputPerMTok: 15, outputPerMTok: 75 },
  "claude-sonnet": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-haiku": { inputPerMTok: 0.8, outputPerMTok: 4 },
  "claude-fable": { inputPerMTok: 3, outputPerMTok: 15 },
  "gpt-": { inputPerMTok: 2.5, outputPerMTok: 10 },
  "o1": { inputPerMTok: 15, outputPerMTok: 60 },
};

/** Longest-prefix match a model id against the price table (design §15.2). */
export function priceForModel(modelId: string): ModelPrice | null {
  let best: ModelPrice | null = null;
  let bestLen = -1;
  for (const [prefix, price] of Object.entries(PRICE_TABLE)) {
    if (modelId.startsWith(prefix) && prefix.length > bestLen) { best = price; bestLen = prefix.length; }
  }
  return best;
}

/**
 * Value token counts in integer MICROS. Returns null when the model is unknown (never zero, §15.2).
 * Cache reads/writes are valued against the INPUT rate with their multipliers.
 */
export function valuate(modelId: string, tokens: TokenCounts): number | null {
  const price = priceForModel(modelId);
  if (!price) return null;
  const perTok = price.inputPerMTok / 1_000_000;
  const outPerTok = price.outputPerMTok / 1_000_000;
  const dollars =
    tokens.input * perTok +
    tokens.output * outPerTok +
    tokens.cacheRead * perTok * CACHE_READ_MULTIPLIER +
    tokens.cacheWrite5m * perTok * CACHE_WRITE_5M_MULTIPLIER +
    tokens.cacheWrite1h * perTok * CACHE_WRITE_1H_MULTIPLIER;
  return Math.round(dollars * 1_000_000);
}
