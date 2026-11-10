import { PRICES, US_GEO_MULTIPLIER, resolveModel } from './prices.mjs';

const CATEGORIES = ['input', 'output', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead'];

export const emptyUsage = () => ({ input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 });

export function addUsage(into, usage) {
  for (const c of CATEGORIES) into[c] += usage[c];
  return into;
}

export const totalTokens = (u) => CATEGORIES.reduce((n, c) => n + u[c], 0);

const int = (v) => (Number.isFinite(v) && v > 0 ? v : 0);

// Turns a transcript `message.usage` object into the five billable categories.
// Older transcripts only carry cache_creation_input_tokens; those are billed
// as 5-minute writes, as is any remainder the 5m/1h breakdown does not cover.
export function normalizeUsage(raw) {
  const u = raw || {};
  const created = int(u.cache_creation_input_tokens);
  const split = u.cache_creation || {};
  const w1h = int(split.ephemeral_1h_input_tokens);
  const w5m = int(split.ephemeral_5m_input_tokens);
  return {
    input: int(u.input_tokens),
    output: int(u.output_tokens),
    cacheWrite5m: w5m + Math.max(0, created - w5m - w1h),
    cacheWrite1h: w1h,
    cacheRead: int(u.cache_read_input_tokens),
  };
}

// Tokens sent to the model on one call, however they were billed.
export const promptTokens = (u) => u.input + u.cacheWrite5m + u.cacheWrite1h + u.cacheRead;

// Per-million rates for one call of a model already resolved to a table key,
// after applying any prompt-size tier.
export function ratesFor(usage, key) {
  const rates = PRICES[key];
  const tier = rates.tierOver;
  return tier && promptTokens(usage) > tier.threshold ? { ...rates, ...tier } : rates;
}

// Cost in USD of one API call. `usage` is normalized. Returns priced:false and
// usd:0 for models missing from the price table; callers report those
// separately instead of guessing.
export function costOf(usage, model, { speed, geo } = {}) {
  const key = resolveModel(model);
  if (!key) return { usd: 0, priced: false, key: null };
  const rates = ratesFor(usage, key);
  let usd = 0;
  for (const c of CATEGORIES) usd += usage[c] * rates[c];
  usd /= 1e6;
  if (speed === 'fast' && rates.fast) usd *= rates.fast;
  if (geo === 'us' && !rates.noGeo) usd *= US_GEO_MULTIPLIER;
  return { usd, priced: true, key };
}
