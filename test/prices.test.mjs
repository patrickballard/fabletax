import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALIASES, PRICES, PRICES_AS_OF, familyOf, rankOf, resolveModel, resolveTarget,
} from '../src/prices.mjs';

test('table: every ALIASES target exists and cache multipliers are derived from input', () => {
  for (const key of Object.values(ALIASES)) assert.ok(PRICES[key], key);
  assert.match(PRICES_AS_OF, /^\d{4}-\d{2}-\d{2}$/);
  // opus-5-5: input 4 -> 5m write 4 * 1.25 = 5, 1h write 4 * 2 = 8
  assert.equal(PRICES['claude-opus-5-5'].cacheWrite5m, 5);
  assert.equal(PRICES['claude-opus-5-5'].cacheWrite1h, 8);
  // sonnet-5-5: input 2 -> 2.5 / 4
  assert.equal(PRICES['claude-sonnet-5-5'].cacheWrite5m, 2.5);
  assert.equal(PRICES['claude-sonnet-5-5'].cacheWrite1h, 4);
  // the haiku long-prompt tier carries its own derived write prices: 0.5 * 1.25, 0.5 * 2
  assert.equal(PRICES['claude-haiku-5-5'].tierOver.threshold, 100_000);
  assert.equal(PRICES['claude-haiku-5-5'].tierOver.cacheWrite5m, 0.625);
  assert.equal(PRICES['claude-haiku-5-5'].tierOver.cacheWrite1h, 1);
});

test('resolveModel: exact keys, longest key wins', () => {
  assert.equal(resolveModel('claude-opus-5-5'), 'claude-opus-5-5');
  assert.equal(resolveModel('claude-opus-5'), 'claude-opus-5');
  assert.equal(resolveModel('claude-fable-5'), 'claude-fable-5');
  assert.equal(resolveModel('claude-fable-5-1'), 'claude-fable-5-1');
  assert.equal(resolveModel('claude-fable-5-2'), 'claude-fable-5-2');
  assert.equal(resolveModel('CLAUDE-SONNET-5-5'), 'claude-sonnet-5-5');
});

test('resolveModel: dated snapshots, context suffixes, provider wrappers', () => {
  assert.equal(resolveModel('claude-opus-4-5-20251101'), 'claude-opus-4-5');
  assert.equal(resolveModel('claude-opus-5-5[1m]'), 'claude-opus-5-5');
  assert.equal(resolveModel('us.anthropic.claude-sonnet-4-5-20250929-v1:0'), 'claude-sonnet-4-5');
  assert.equal(resolveModel('anthropic.claude-haiku-4-5-v1:0'), 'claude-haiku-4-5');
  assert.equal(resolveModel('claude-sonnet-5-5@20260101'), 'claude-sonnet-5-5');
});

test('resolveModel: unknown ids are null, never priced as a shorter key', () => {
  assert.equal(resolveModel('claude-fable-5-3'), null); // must not fall back to claude-fable-5
  assert.equal(resolveModel('claude-opus-5-6'), null);  // must not fall back to claude-opus-5
  assert.equal(resolveModel('claude-sonnet-5-5-latest'), null);
  assert.equal(resolveModel('gpt-5'), null);
  assert.equal(resolveModel('<synthetic>'), null);
  assert.equal(resolveModel(''), null);
  assert.equal(resolveModel(undefined), null);
  assert.equal(resolveModel(null), null);
});

test('familyOf / rankOf order haiku < sonnet < opus < fable', () => {
  assert.equal(familyOf('us.anthropic.claude-sonnet-4-5-20250929-v1:0'), 'sonnet');
  assert.equal(familyOf('claude-fable-5-3'), 'fable'); // family is known even when the price is not
  assert.equal(familyOf('gpt-5'), null);
  assert.equal(rankOf('claude-mythos-1'), rankOf('claude-fable-5'));
  assert.ok(rankOf('claude-haiku-5-5') < rankOf('claude-sonnet-5-5'));
  assert.ok(rankOf('claude-sonnet-5-5') < rankOf('claude-opus-5-5'));
  assert.ok(rankOf('claude-opus-5-5') < rankOf('claude-fable-5-2'));
  assert.equal(rankOf('nonsense'), 0);
});

test('resolveTarget: aliases, ids, and a helpful error', () => {
  assert.equal(resolveTarget('sonnet'), 'claude-sonnet-5-5');
  assert.equal(resolveTarget('haiku'), 'claude-haiku-5-5');
  assert.equal(resolveTarget('claude-opus-4-8-20260101'), 'claude-opus-4-8');
  assert.throws(() => resolveTarget('gpt-5'), /Unknown model "gpt-5".*sonnet/);
});
