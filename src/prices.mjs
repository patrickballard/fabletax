// The only file in fabletax that contains a price.
// Every dollar figure the tool prints is token counts multiplied by a row below.
// USD per million tokens, Anthropic list price. Update the date when you edit.

export const PRICES_AS_OF = '2026-11-10';
export const PRICES_SOURCE = 'https://platform.claude.com/docs/en/about-claude/pricing';

// Cache writes follow the published multipliers (5-minute = 1.25x input,
// 1-hour = 2x input). Cache reads do NOT follow one multiplier, so they are
// listed per model.
const row = (input, output, cacheRead, extra = {}) => ({
  input,
  output,
  cacheWrite5m: input * 1.25,
  cacheWrite1h: input * 2,
  cacheRead,
  ...extra,
});

// fast: multiplier applied to every category when usage.speed === 'fast'.
// noGeo: model predates the 1.1x US-only inference multiplier.
// tierOver: per-request prices when the prompt exceeds `threshold` tokens.
export const PRICES = {
  'claude-fable-5-2': row(8, 40, 0.2, { fast: 2 }),
  'claude-fable-5-1': row(10, 50, 0.25),
  'claude-fable-5': row(10, 50, 1.0),

  'claude-opus-5-5': row(4, 20, 0.2, { fast: 2 }),
  'claude-opus-5': row(5, 25, 0.5, { fast: 2 }),
  'claude-opus-4-8': row(5, 25, 0.5, { fast: 2 }),
  'claude-opus-4-7': row(5, 25, 0.5),
  'claude-opus-4-6': row(5, 25, 0.5),
  'claude-opus-4-5': row(5, 25, 0.5, { noGeo: true }),

  'claude-sonnet-5-5': row(2, 10, 0.1),
  'claude-sonnet-5': row(2, 10, 0.2),
  'claude-sonnet-4-6': row(3, 15, 0.3),
  'claude-sonnet-4-5': row(3, 15, 0.3, { noGeo: true }),

  'claude-haiku-5-5': row(0.1, 0.5, 0.01, {
    tierOver: { threshold: 100_000, ...row(0.5, 2.5, 0.05) },
  }),
  'claude-haiku-4-5': row(1, 5, 0.1, { noGeo: true }),
};

export const US_GEO_MULTIPLIER = 1.1;

// What the per-call `model:` aliases resolve to on the Anthropic API.
export const ALIASES = {
  fable: 'claude-fable-5-2',
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
};

const FAMILY_RANK = { haiku: 1, sonnet: 2, opus: 3, fable: 4, mythos: 4 };

export function familyOf(model) {
  const m = /claude-(fable|mythos|opus|sonnet|haiku)/.exec(String(model || '').toLowerCase());
  return m ? m[1] : null;
}

export function rankOf(model) {
  return FAMILY_RANK[familyOf(model)] || 0;
}

const KEYS_LONGEST_FIRST = Object.keys(PRICES).sort((a, b) => b.length - a.length);

// Resolves a transcript model id to a table key, or null. Accepts dated
// snapshots (-20251101), context suffixes ([1m]) and provider wrappers
// (us.anthropic.…-v1:0). Anything else after the key is treated as a model we
// do not know: `claude-fable-5-3` must not be priced as `claude-fable-5`.
export function resolveModel(model) {
  const id = String(model || '').toLowerCase();
  for (const key of KEYS_LONGEST_FIRST) {
    const at = id.indexOf(key);
    if (at === -1) continue;
    const rest = id.slice(at + key.length);
    if (rest === '' || /^(-20\d{6}|\[|@|-v\d)/.test(rest)) return key;
  }
  return null;
}

export function resolveTarget(aliasOrId) {
  const key = ALIASES[aliasOrId] || resolveModel(aliasOrId);
  if (!key) throw new Error(`Unknown model "${aliasOrId}". Try: ${Object.keys(ALIASES).join(', ')}`);
  return key;
}
