/**
 * Claude API price map for cost estimation (Item 9).
 *
 * Rates are USD per 1,000,000 tokens, by model id. Cache reads are
 * charged at ~0.1x the input rate and cache writes (5-min ephemeral) at
 * ~1.25x input — the standard Anthropic multipliers. Keep this table in
 * sync with https://www.anthropic.com/pricing when prices change; it's a
 * plain data map on purpose so updating it is a one-line edit.
 *
 * IMPORTANT: these are estimates for an at-a-glance cost dashboard, not
 * billing-grade figures. Unknown model ids fall back to the Sonnet rate
 * and are flagged via `estimated:false`-style callers if they care.
 */

export interface ModelRate {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
}

// Per-1M-token USD rates. Prefix match on model id (so a dated id like
// claude-haiku-4-5-20251001 still resolves via startsWith).
const RATES: Array<{ prefix: string; rate: ModelRate }> = [
  { prefix: "claude-opus", rate: { input: 15, output: 75 } },
  { prefix: "claude-sonnet", rate: { input: 3, output: 15 } },
  { prefix: "claude-haiku", rate: { input: 0.8, output: 4 } },
  { prefix: "gemini", rate: { input: 0, output: 0 } }, // gemini billed elsewhere
];

const FALLBACK: ModelRate = { input: 3, output: 15 }; // Sonnet-equivalent

const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

export function rateForModel(model: string): ModelRate {
  const m = (model ?? "").toLowerCase();
  for (const { prefix, rate } of RATES) {
    if (m.startsWith(prefix)) return rate;
  }
  return FALLBACK;
}

export interface UsageCounts {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
}

/**
 * Estimate the USD cost of one model turn from its token counts. Cache
 * reads are discounted and cache writes carry the ephemeral surcharge,
 * both relative to the model's input rate. Returns 0 for zero usage (the
 * common case on the subscription CLI path, which doesn't always report
 * token counts).
 */
export function estimateCostUsd(model: string, usage: UsageCounts): number {
  const rate = rateForModel(model);
  const input = Math.max(0, usage.inputTokens || 0);
  const output = Math.max(0, usage.outputTokens || 0);
  const cacheWrite = Math.max(0, usage.cacheCreationTokens || 0);
  const cacheRead = Math.max(0, usage.cacheReadTokens || 0);
  const usd =
    (input / 1_000_000) * rate.input +
    (output / 1_000_000) * rate.output +
    (cacheWrite / 1_000_000) * rate.input * CACHE_WRITE_MULTIPLIER +
    (cacheRead / 1_000_000) * rate.input * CACHE_READ_MULTIPLIER;
  // Round to 6 decimals (micro-dollars) — enough for per-turn granularity.
  return Math.round(usd * 1e6) / 1e6;
}
