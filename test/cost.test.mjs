import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addUsage, costOf, emptyUsage, normalizeUsage, promptTokens, ratesFor, totalTokens } from '../src/cost.mjs';
import { PRICES } from '../src/prices.mjs';

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-12, `${msg || ''} ${a} !== ${b}`);
const M = 1_000_000;
const u = (o) => ({ ...emptyUsage(), ...o });

test('normalizeUsage: empty and garbage input', () => {
  assert.deepEqual(normalizeUsage(undefined), emptyUsage());
  assert.deepEqual(normalizeUsage(null), emptyUsage());
  assert.deepEqual(normalizeUsage({}), emptyUsage());
  assert.deepEqual(
    normalizeUsage({ input_tokens: -5, output_tokens: NaN, cache_read_input_tokens: '7', cache_creation_input_tokens: Infinity }),
    emptyUsage(),
  );
});

test('normalizeUsage: legacy transcripts bill all cache creation as 5m writes', () => {
  assert.deepEqual(
    normalizeUsage({ input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 1000, cache_read_input_tokens: 5 }),
    { input: 10, output: 20, cacheWrite5m: 1000, cacheWrite1h: 0, cacheRead: 5 },
  );
});

test('normalizeUsage: 5m/1h breakdown that covers the total is used as-is', () => {
  const r = normalizeUsage({
    cache_creation_input_tokens: 2000,
    cache_creation: { ephemeral_5m_input_tokens: 1500, ephemeral_1h_input_tokens: 500 },
  });
  assert.equal(r.cacheWrite5m, 1500);
  assert.equal(r.cacheWrite1h, 500);
});

test('normalizeUsage: remainder the breakdown does not cover is billed as 5m', () => {
  // created 3000, breakdown 1000 + 500 -> 1500 uncovered -> 5m = 1000 + 1500
  const r = normalizeUsage({
    cache_creation_input_tokens: 3000,
    cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 500 },
  });
  assert.equal(r.cacheWrite5m, 2500);
  assert.equal(r.cacheWrite1h, 500);
  // only a 1h breakdown, rest is 5m
  const r2 = normalizeUsage({ cache_creation_input_tokens: 400, cache_creation: { ephemeral_1h_input_tokens: 100 } });
  assert.equal(r2.cacheWrite5m, 300);
  assert.equal(r2.cacheWrite1h, 100);
  // breakdown larger than the total: no negative remainder, breakdown wins
  const r3 = normalizeUsage({ cache_creation_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 80, ephemeral_1h_input_tokens: 80 } });
  assert.equal(r3.cacheWrite5m, 80);
  assert.equal(r3.cacheWrite1h, 80);
  // breakdown with no top-level total
  const r4 = normalizeUsage({ cache_creation: { ephemeral_5m_input_tokens: 7, ephemeral_1h_input_tokens: 9 } });
  assert.equal(r4.cacheWrite5m, 7);
  assert.equal(r4.cacheWrite1h, 9);
});

test('addUsage / totalTokens', () => {
  const into = emptyUsage();
  addUsage(into, u({ input: 1, output: 2, cacheWrite5m: 3, cacheWrite1h: 4, cacheRead: 5 }));
  addUsage(into, u({ input: 10 }));
  assert.deepEqual(into, { input: 11, output: 2, cacheWrite5m: 3, cacheWrite1h: 4, cacheRead: 5 });
  assert.equal(totalTokens(into), 25);
});

test('costOf: one million of every category', () => {
  const all = u({ input: M, output: M, cacheWrite5m: M, cacheWrite1h: M, cacheRead: M });
  // opus-5-5: 4 + 20 + 5 + 8 + 0.2 = 37.2
  near(costOf(all, 'claude-opus-5-5').usd, 37.2);
  // sonnet-5-5: 2 + 10 + 2.5 + 4 + 0.1 = 18.6
  near(costOf(all, 'claude-sonnet-5-5').usd, 18.6);
  // fable-5-2: 8 + 40 + 10 + 16 + 0.2 = 74.2
  near(costOf(all, 'claude-fable-5-2').usd, 74.2);
  // haiku-5-5 is over its 100k tier: 0.5 + 2.5 + 0.625 + 1 + 0.05 = 4.675
  near(costOf(all, 'claude-haiku-5-5').usd, 4.675);
  assert.deepEqual(
    { priced: costOf(all, 'claude-opus-5-5').priced, key: costOf(all, 'claude-opus-5-5').key },
    { priced: true, key: 'claude-opus-5-5' },
  );
});

test('costOf: cache reads are priced per model, not by a shared multiplier', () => {
  const read = u({ cacheRead: M });
  near(costOf(read, 'claude-fable-5').usd, 1.0);
  near(costOf(read, 'claude-fable-5-1').usd, 0.25);
  near(costOf(read, 'claude-opus-5').usd, 0.5);
  near(costOf(read, 'claude-opus-5-5').usd, 0.2);
});

test('costOf: dated / wrapped ids resolve to the table row', () => {
  // sonnet-4-5: 3 in + 15 out = 18
  const r = costOf(u({ input: M, output: M }), 'us.anthropic.claude-sonnet-4-5-20250929-v1:0');
  near(r.usd, 18);
  assert.equal(r.key, 'claude-sonnet-4-5');
});

test('costOf: unknown models are unpriced, not guessed', () => {
  const r = costOf(u({ input: M }), 'claude-fable-5-3');
  assert.deepEqual(r, { usd: 0, priced: false, key: null });
  assert.equal(costOf(u({ input: M }), undefined).priced, false);
});

test('costOf: fast mode multiplies only models that list a fast multiplier', () => {
  const use = u({ input: M, output: M }); // opus-5-5 4 + 20 = 24
  near(costOf(use, 'claude-opus-5-5', { speed: 'fast' }).usd, 48); // x2
  near(costOf(use, 'claude-opus-5-5', { speed: 'standard' }).usd, 24);
  near(costOf(use, 'claude-sonnet-5-5', { speed: 'fast' }).usd, 12); // 2 + 10, no fast row
  near(costOf(use, 'claude-opus-4-7', { speed: 'fast' }).usd, 30); // 5 + 25, no fast row
});

test('costOf: 1.1x US geo multiplier skips models that predate it', () => {
  const use = u({ input: M, output: M });
  near(costOf(use, 'claude-sonnet-5-5', { geo: 'us' }).usd, 13.2); // (2 + 10) * 1.1
  near(costOf(use, 'claude-sonnet-5-5', { geo: 'not_available' }).usd, 12);
  near(costOf(use, 'claude-sonnet-4-5', { geo: 'us' }).usd, 18); // noGeo: 3 + 15
  near(costOf(use, 'claude-haiku-4-5', { geo: 'us' }).usd, 6); // noGeo: 1 + 5
  // fast and US stack: opus-5-5 1M input = 4, x2 x1.1 = 8.8
  near(costOf(u({ input: M }), 'claude-opus-5-5', { speed: 'fast', geo: 'us' }).usd, 8.8);
});

test('costOf: haiku-5-5 tier boundary is strictly over 100000 prompt tokens', () => {
  // exactly 100000: base rate 0.1/M -> 100000 * 0.1 / 1e6 = 0.01
  near(costOf(u({ input: 100_000 }), 'claude-haiku-5-5').usd, 0.01);
  // 100001: whole request at the tier rate 0.5/M -> 100001 * 0.5 / 1e6 = 0.0500005
  near(costOf(u({ input: 100_001 }), 'claude-haiku-5-5').usd, 0.0500005);
  // cache reads count toward the prompt: 100000 * 0.01 / 1e6 = 0.001 vs 100001 * 0.05 / 1e6 = 0.00500005
  near(costOf(u({ cacheRead: 100_000 }), 'claude-haiku-5-5').usd, 0.001);
  near(costOf(u({ cacheRead: 100_001 }), 'claude-haiku-5-5').usd, 0.00500005);
  // so do cache writes (5m tier write 0.625/M): 100001 * 0.625 / 1e6 = 0.062500625
  near(costOf(u({ cacheWrite5m: 100_001 }), 'claude-haiku-5-5').usd, 0.062500625);
  // categories add up across the boundary: 50000 + 50001 = 100001 -> tier
  // 50000 * 0.5 + 50001 * 0.05 = 25000 + 2500.05 = 27500.05 -> 0.02750005
  near(costOf(u({ input: 50_000, cacheRead: 50_001 }), 'claude-haiku-5-5').usd, 0.02750005);
  // output does not count toward the threshold: input 100000 stays base (0.01),
  // output 1M at the base 0.5/M = 0.5
  near(costOf(u({ input: 100_000, output: M }), 'claude-haiku-5-5').usd, 0.51);
  // output past the boundary uses the tier price 2.5/M: 100001 * 0.5 + 1M * 2.5 = 50000.5 + 2500000 -> 2.5500005
  near(costOf(u({ input: 100_001, output: M }), 'claude-haiku-5-5').usd, 2.5500005);
  // haiku-4-5 has no tier
  near(costOf(u({ input: 200_000 }), 'claude-haiku-4-5').usd, 0.2);
});

test('promptTokens: input + both cache writes + cache reads, never output', () => {
  assert.equal(promptTokens(u({ input: 1, output: 100, cacheWrite5m: 2, cacheWrite1h: 3, cacheRead: 4 })), 10);
  assert.equal(promptTokens(emptyUsage()), 0);
});

test('ratesFor: plain rows pass through, haiku-5-5 switches to the tier strictly over 100000', () => {
  assert.equal(ratesFor(u({ input: 5_000_000 }), 'claude-opus-5-5'), PRICES['claude-opus-5-5']);
  assert.equal(ratesFor(u({ input: 5_000_000 }), 'claude-haiku-4-5'), PRICES['claude-haiku-4-5']);
  const base = ratesFor(u({ input: 100_000 }), 'claude-haiku-5-5');
  assert.equal(base.input, 0.1);
  assert.equal(base.cacheRead, 0.01);
  assert.equal(base.output, 0.5);
  const tier = ratesFor(u({ input: 100_001 }), 'claude-haiku-5-5');
  assert.deepEqual(
    { input: tier.input, output: tier.output, w5m: tier.cacheWrite5m, w1h: tier.cacheWrite1h, read: tier.cacheRead },
    { input: 0.5, output: 2.5, w5m: 0.625, w1h: 1, read: 0.05 },
  );
  // prompt = cache reads + writes + input; output does not count
  assert.equal(ratesFor(u({ cacheRead: 60_000, cacheWrite1h: 40_001 }), 'claude-haiku-5-5').input, 0.5);
  assert.equal(ratesFor(u({ cacheRead: 100_000, output: 5_000_000 }), 'claude-haiku-5-5').input, 0.1);
});
