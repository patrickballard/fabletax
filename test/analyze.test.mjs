import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { analyze, classifyRun, contextTaxes, DEFAULT_CONTEXT_CAP } from '../src/analyze.mjs';
import { costOf } from '../src/cost.mjs';
import { loadTranscripts } from '../src/transcripts.mjs';

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg || ''} ${a} !== ${b}`);
const FIXTURE = fileURLToPath(new URL('./fixtures/claude', import.meta.url));

const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';
const FABLE = 'claude-fable-5-2';
const HAIKU = 'claude-haiku-5-5';
const iso = (s) => Date.parse(`2026-10-${s}Z`);

// One "unit" of work: 1M input + 0.5M output tokens, no cache.
//   opus-5-5   4 + 0.5 * 20 = 14
//   sonnet-5-5 2 + 0.5 * 10 = 7
//   fable-5-2  8 + 0.5 * 40 = 28
//   haiku-5-5  over the 100k tier: 0.5 + 0.5 * 2.5 = 1.75
const UNIT = { input: 1_000_000, output: 500_000, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
const call = (o) => ({ ts: iso('01T00:00:00'), sessionId: 'x', project: 'app', model: OPUS, usage: UNIT, speed: 'standard', geo: 'not_available', agentKey: null, ...o });
const run = (key, dispatch, extra = {}) => [key, { agentKey: key, agentId: key.split(':')[1], sessionId: 'x', agentType: 'general-purpose', description: '', spawnDepth: 1, dispatch, ...extra }];
const found = (dispatcherModel, model = null) => ({ found: true, model, dispatcherModel });

test('classifyRun', () => {
  assert.equal(classifyRun(undefined, OPUS), 'unattributed');
  assert.equal(classifyRun({ dispatch: { found: false } }, OPUS), 'unattributed');
  assert.equal(classifyRun({ agentType: 'fork', dispatch: found(OPUS) }, OPUS), 'fork');
  assert.equal(classifyRun({ agentType: 'fork', dispatch: { found: false } }, OPUS), 'fork');
  assert.equal(classifyRun({ dispatch: found(OPUS, 'haiku') }, HAIKU), 'pinned');
  assert.equal(classifyRun({ dispatch: found(OPUS) }, OPUS), 'inherited');
  assert.equal(classifyRun({ dispatch: found(OPUS) }, SONNET), 'agent-default');
  // dated snapshot of the same model is still the same model
  assert.equal(classifyRun({ dispatch: found('claude-opus-5-5-20260101') }, OPUS), 'inherited');
  // ids outside the table compare verbatim
  assert.equal(classifyRun({ dispatch: found('claude-fable-5-3') }, 'claude-fable-5-3'), 'inherited');
  assert.equal(classifyRun({ dispatch: found('claude-fable-5-3') }, OPUS), 'agent-default');
});

test('only inherited runs from a pricier family are taxed', () => {
  const calls = [
    call({ ts: iso('01T00:00:00') }),                                        // main: 14
    call({ ts: iso('02T00:00:00'), agentKey: 'x:i1' }),                      // inherited opus: 14
    call({ ts: iso('02T01:00:00'), agentKey: 'x:i1' }),                      // ... second call: 14
    call({ ts: iso('03T00:00:00'), agentKey: 'x:p1' }),                      // pinned (to opus) 14
    call({ ts: iso('04T00:00:00'), agentKey: 'x:d1', model: SONNET }),       // agent-default sonnet 7
    call({ ts: iso('05T00:00:00'), agentKey: 'x:f1' }),                      // fork 14
    call({ ts: iso('06T00:00:00'), agentKey: 'x:u1' }),                      // not in agents map 14
    call({ ts: iso('06T01:00:00'), agentKey: 'x:u2' }),                      // dispatch.found false 14
    call({ ts: iso('07T00:00:00'), agentKey: 'x:i3', model: SONNET }),       // inherited, but same family as target 7
    call({ ts: iso('07T00:00:00'), model: 'claude-fable-5-3' }),             // unpriced
    call({ ts: iso('09T00:00:00'), agentKey: 'x:i2', model: FABLE, project: 'lib' }), // inherited fable 28
  ];
  const agents = new Map([
    run('x:i1', found(OPUS), { agentType: 'general-purpose' }),
    run('x:p1', found(OPUS, 'opus')),
    run('x:d1', found(OPUS), { agentType: 'reviewer' }),
    run('x:f1', found(OPUS), { agentType: 'fork' }),
    run('x:u2', { found: false, model: null, dispatcherModel: null }),
    run('x:i3', found(SONNET)),
    run('x:i2', found(FABLE), { agentType: 'reviewer', description: 'big review' }),
  ]);
  // cap is lifted so the 1.5M-token main call does not add context bloat to this inheritance scenario
  const r = analyze({ calls, agents }, { target: 'sonnet', now: 123, cap: 1e12 });

  assert.equal(r.generatedAt, 123);
  assert.deepEqual(r.target, { alias: 'sonnet', model: SONNET });
  // subagents: i1 28, p1 14, d1 7, f1 14, u1 14, u2 14, i3 7, i2 28 = 126
  near(r.main.usd, 14);
  near(r.subagents.usd, 126);
  near(r.total.usd, 140);
  assert.equal(r.total.calls, 10); // 11 calls, one with an unpriced model
  assert.equal(r.unpriced.calls, 1);
  assert.deepEqual(r.unpriced.models, { 'claude-fable-5-3': 1 });

  assert.deepEqual(r.subagents.byClass.inherited.runs, 3); // i1, i3, i2
  assert.equal(r.subagents.byClass.pinned.runs, 1);
  assert.equal(r.subagents.byClass['agent-default'].runs, 1);
  assert.equal(r.subagents.byClass.fork.runs, 1);
  assert.equal(r.subagents.byClass.unattributed.runs, 2);
  near(r.subagents.byClass.inherited.usd, 28 + 7 + 28);
  assert.deepEqual(r.dispatch, { runs: 8, unpinned: 4, inherited: 3, taxed: 2 });

  // taxed: i1 28 -> 14 (tax 14), i2 fable 28 -> sonnet 7 (tax 21). i3 is already sonnet.
  near(r.tax.usd, 35);
  assert.equal(r.tax.runs, 2);
  near(r.tax.actualUsd, 28 + 28);
  near(r.tax.repricedUsd, 14 + 7);
  near(r.tax.shareOfTotal, 35 / 140);
  // window 10-01 .. 10-09 = 8 days -> 35 / 8 * 30
  assert.equal(r.window.days, 8);
  near(r.tax.perMonthUsd, 131.25);

  assert.deepEqual(r.byAgentType.map((t) => [t.agentType, t.runs, t.taxUsd]), [['reviewer', 1, 21], ['general-purpose', 1, 14]]);
  assert.equal(r.topRuns.length, 2);
  assert.equal(r.topRuns[0].agentType, 'reviewer');
  assert.equal(r.topRuns[0].description, 'big review');
  assert.equal(r.topRuns[0].model, FABLE);
  near(r.topRuns[0].taxUsd, 21);
  near(r.topRuns[1].usd, 28);
  near(r.topRuns[1].repricedUsd, 14);

  assert.deepEqual(r.byModel.map((m) => [m.model, m.family, m.calls]), [[OPUS, 'opus', 7], [FABLE, 'fable', 1], [SONNET, 'sonnet', 2]]);
  near(r.byModel[0].usd, 14 * 7); // main + i1 x2 + p1 + f1 + u1 + u2
  assert.equal(r.byProject.length, 2);
  assert.deepEqual(r.byProject.map((p) => p.project), ['app', 'lib']);
  near(r.byProject[1].taxUsd, 21);
  near(r.byProject[0].taxUsd, 14);
  assert.equal(r.byDay.length, 8);
  assert.deepEqual(r.byDay.map((d) => d.day), ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-09']);
  near(r.byDay[1].taxUsd, 14);
  near(r.byDay[7].taxUsd, 21);
});

test('a run is classified by the model it spent the most on', () => {
  const calls = [
    call({ ts: iso('01T00:00:00'), agentKey: 'x:m1' }),                        // opus 14
    call({ ts: iso('01T00:01:00'), agentKey: 'x:m1', model: SONNET }),         // sonnet 7
  ];
  const agents = new Map([run('x:m1', found(OPUS))]);
  const r = analyze({ calls, agents });
  assert.equal(r.subagents.byClass.inherited.runs, 1);
  // run total 21; same tokens on sonnet 7 + 7 = 14; tax 7
  near(r.tax.usd, 7);
});

test('--as haiku reprices on the haiku tier; haiku-or-cheaper inherited runs are not taxed', () => {
  const calls = [
    call({ ts: iso('01T00:00:00'), agentKey: 'x:s1', model: SONNET }),
    call({ ts: iso('01T00:00:00'), agentKey: 'x:h1', model: HAIKU }),
  ];
  const agents = new Map([run('x:s1', found(SONNET)), run('x:h1', found(HAIKU))]);
  const r = analyze({ calls, agents }, { target: 'haiku' });
  assert.equal(r.target.model, HAIKU);
  // s1: sonnet 7, same tokens on haiku-5-5 (1M prompt > 100k tier) 1.75 -> tax 5.25
  near(r.tax.usd, 5.25);
  near(r.tax.repricedUsd, 1.75);
  assert.equal(r.tax.runs, 1);
  assert.equal(r.dispatch.inherited, 2);
  assert.equal(r.dispatch.taxed, 1);
});

test('fast mode is counted in cost and surfaced as a premium', () => {
  // opus-5-5 fast: 14 * 2 = 28, premium 14
  const r = analyze({ calls: [call({ speed: 'fast' }), call({ ts: iso('01T01:00:00') })], agents: new Map() });
  near(r.total.usd, 42);
  near(r.fastPremiumUsd, 14);
});

test('perMonthUsd is null under 7 days of data', () => {
  const agents = new Map([run('x:i1', found(OPUS))]);
  const withSpan = (last) => analyze({
    calls: [call({ ts: iso('01T00:00:00'), agentKey: 'x:i1' }), call({ ts: Date.parse(last) })],
    agents,
  });
  // tax = 14 - 7 = 7
  const six = withSpan('2026-10-07T00:00:00Z');
  near(six.tax.usd, 7);
  assert.equal(six.window.days, 6);
  assert.equal(six.tax.perMonthUsd, null);
  assert.equal(withSpan('2026-10-07T23:59:59Z').tax.perMonthUsd, null);
  // exactly 7 days: 7 / 7 * 30 = 30
  const seven = withSpan('2026-10-08T00:00:00Z');
  assert.equal(seven.window.days, 7);
  near(seven.tax.perMonthUsd, 30);
  // 10 days: 7 / 10 * 30 = 21
  near(withSpan('2026-10-11T00:00:00Z').tax.perMonthUsd, 21);
  // a single instant counts as one day
  const one = analyze({ calls: [call({ agentKey: 'x:i1' })], agents });
  assert.equal(one.window.days, 1);
  assert.equal(one.tax.perMonthUsd, null);
  // no tax over a long window: 0, not null
  const none = analyze({ calls: [call({ ts: iso('01T00:00:00') }), call({ ts: iso('20T00:00:00') })], agents: new Map() });
  assert.equal(none.tax.perMonthUsd, 0);
});

test('no calls', () => {
  const r = analyze({ calls: [], agents: new Map() });
  assert.deepEqual(r.window, { from: null, to: null, days: 0 });
  assert.equal(r.total.usd, 0);
  assert.equal(r.tax.usd, 0);
  assert.equal(r.tax.shareOfTotal, 0);
  assert.equal(r.tax.perMonthUsd, null);
  assert.deepEqual(r.byModel, []);
  assert.deepEqual(r.dispatch, { runs: 0, unpinned: 0, inherited: 0, taxed: 0 });
});

test('only unpriced calls: nothing counted, no crash', () => {
  const r = analyze({ calls: [call({ model: 'claude-fable-5-3', agentKey: 'x:a' })], agents: new Map() });
  assert.equal(r.total.calls, 0);
  assert.equal(r.unpriced.calls, 1);
  assert.equal(r.window.from, null);
  assert.equal(r.dispatch.runs, 0);
});

test('unknown target throws', () => {
  assert.throws(() => analyze({ calls: [], agents: new Map() }, { target: 'gpt-5' }), /Unknown model/);
});

test('end to end on the synthetic fixture', async () => {
  const loaded = await loadTranscripts({ claudeDir: FIXTURE });
  const r = analyze(loaded, { now: 1 });
  // Hand-computed per call, in micro-dollars (see test/fixtures/claude/):
  //   main  s1 opus: m1 27500 (4000+10000+7500+4000+2000), m2..m6 5 x 1400, fast 28000, haiku>100k 7775
  //              (500*0.5 + 1000*2.5 + 100500*0.05)
  //         s2 new 24000, s3 sonnet 7000 + 5000   => 106275
  //   subs  a1 32000 + 18000, a2 haiku 550, a3 sonnet 29000, a4 fork 20000, a5 30000,
  //         a6 6000, a7 6000, legacy inline 6000    => 147550
  near(r.main.usd, 0.106275);
  near(r.subagents.usd, 0.14755);
  near(r.total.usd, 0.253825);
  assert.equal(r.total.calls, 20); // 21 loaded, 1 unpriced model
  assert.deepEqual(r.unpriced, { calls: 1, models: { 'claude-fable-5-3': 1 } });
  near(r.fastPremiumUsd, 0.014);

  assert.deepEqual(r.dispatch, { runs: 8, unpinned: 4, inherited: 3, taxed: 3 });
  assert.deepEqual(
    Object.fromEntries(Object.entries(r.subagents.byClass).map(([k, v]) => [k, v.runs])),
    { inherited: 3, pinned: 1, 'agent-default': 1, fork: 1, unattributed: 2 },
  );
  // inherited a1 50000 -> sonnet 25000 (16000 + 9000), a5 30000 -> 15000, a7 6000 -> 3000
  near(r.tax.actualUsd, 0.086);
  near(r.tax.repricedUsd, 0.043);
  near(r.tax.usd, 0.043);
  near(r.tax.shareOfTotal, 0.043 / 0.253825);
  assert.equal(r.window.days, 10);
  near(r.tax.perMonthUsd, 0.129); // 0.043 / 10 * 30
  assert.deepEqual(r.topRuns.map((t) => t.description), ['Survey the widgets', 'Linked via result', 'Nested helper']);
  // main-thread turns are days apart and write almost nothing, so no context tax
  assert.equal(r.bloat.usd, 0);
  assert.equal(r.idle.usd, 0);
  near(r.taxTotal.usd, 0.043);
  assert.deepEqual(r.topSessions, []);
});

// ---- context taxes (bloat + idle) and the combined total ----------------------------------
// claude-opus-5-5 per M: input 4, 5m write 5, 1h write 8, cache read 0.2
const MIN = 60_000;
const day = (d, min = 0, sec = 0) => Date.UTC(2026, 9, d, 0, min, sec);
const use = (o) => ({ input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, ...o });
const turn = (sessionId, ts, usage, o = {}) => call({ sessionId, ts, usage: use(usage), ...o });
const noAgents = new Map();
const ctx = (calls, opts) => analyze({ calls, agents: noAgents }, opts);

test('bloat: (prompt - cap) x cache-read rate per main-thread turn, zero at exactly cap', () => {
  assert.equal(DEFAULT_CONTEXT_CAP, 200_000);
  const calls = [
    turn('b', day(1, 0), { cacheRead: 200_000 }),                 // exactly cap: 0
    turn('b', day(1, 1), { cacheRead: 300_000 }),                 // 100_000 * 0.2 / 1e6 = 0.02
    turn('b', day(1, 2), { input: 50_000, cacheRead: 200_000 }),  // 250_000 prompt: 50_000 * 0.2 / 1e6 = 0.01
    turn('b', day(1, 3), { cacheRead: 200_001 }),                 // one token over: 0.2 / 1e6
  ];
  const r = ctx(calls);
  near(r.bloat.usd, 0.02 + 0.01 + 0.0000002);
  assert.equal(r.bloat.calls, 3);
  assert.equal(r.bloat.capTokens, 200_000);
  assert.equal(r.bloat.peakTokens, 300_000);
  assert.equal(r.idle.usd, 0);
  near(r.bloat.shareOfTotal, r.bloat.usd / r.total.usd);
  // exactly at the cap alone: nothing
  const at = ctx([turn('b', day(1), { cacheRead: 200_000 })]);
  assert.equal(at.bloat.usd, 0);
  assert.equal(at.bloat.calls, 0);
  assert.deepEqual(at.topSessions, []);
});

test('bloat: the cap option moves the threshold', () => {
  const calls = [
    turn('b', day(1, 0), { cacheRead: 200_000 }),                 // cap 100k: 100_000 * 0.2 / 1e6 = 0.02
    turn('b', day(1, 1), { cacheRead: 300_000 }),                 // 200_000 * 0.2 / 1e6 = 0.04
    turn('b', day(1, 2), { input: 50_000, cacheRead: 100_000 }),  // 150_000 prompt: 50_000 * 0.2 / 1e6 = 0.01
  ];
  const r = ctx(calls, { cap: 100_000 });
  near(r.bloat.usd, 0.07);
  assert.equal(r.bloat.calls, 3);
  assert.equal(r.bloat.capTokens, 100_000);
  // cap 1M: none
  assert.equal(ctx(calls, { cap: 1_000_000 }).bloat.usd, 0);
});

test('bloat uses the haiku tier read rate once the prompt is over 100k', () => {
  // haiku-5-5 tier read rate 0.05: (300_000 - 200_000) * 0.05 / 1e6 = 0.005
  const r = ctx([turn('h', day(1), { cacheRead: 300_000 }, { model: HAIKU })]);
  near(r.bloat.usd, 0.005);
});

test('subagent calls never produce bloat or idle', () => {
  const agents = new Map([run('x:a1', found(OPUS))]);
  const calls = [
    turn('x', day(1, 0), { cacheRead: 500_000 }, { agentKey: 'x:a1' }),
    turn('x', day(1, 30), { cacheWrite1h: 500_000 }, { agentKey: 'x:a1' }), // cold resume, huge prompt
    turn('x', day(1, 60), { cacheWrite1h: 500_000 }, { agentKey: 'x:legacy' }), // not in agents map either
  ];
  const r = analyze({ calls, agents });
  assert.equal(r.bloat.usd, 0);
  assert.equal(r.bloat.calls, 0);
  assert.equal(r.idle.usd, 0);
  assert.equal(r.idle.resumes, 0);
  assert.deepEqual(r.topSessions, []);
  assert.equal(r.subagents.calls, 3);
});

test('idle: pure 1h write after a long gap = recached x (write rate - read rate)', () => {
  // prev prompt 100_000; written 80_000 (>= 20k and >= 50_000); recached = min(80_000, 100_000) = 80_000
  // 80_000 * (8 - 0.2) / 1e6 = 0.624
  const r = ctx([
    turn('i', day(1, 0), { cacheWrite1h: 100_000 }),                    // first turn: never idle
    turn('i', day(1, 10), { cacheWrite1h: 80_000, cacheRead: 20_000 }),
  ]);
  near(r.idle.usd, 0.624);
  assert.equal(r.idle.resumes, 1);
  assert.equal(r.idle.tokens, 80_000);
  assert.equal(r.bloat.usd, 0);
  near(r.idle.shareOfTotal, 0.624 / r.total.usd);
});

test('idle: mixed 5m/1h write is priced at the blended write rate', () => {
  // prev prompt 100_000; written 30_000 (5m) + 90_000 (1h) = 120_000; recached = min(120_000, 100_000) = 100_000
  // write bill = (30_000 * 5 + 90_000 * 8) / 1e6 = 0.87, so blended 0.87 / 120_000 per token
  // idle = 100_000/120_000 * 0.87 - 100_000 * 0.2 / 1e6 = 0.725 - 0.02 = 0.705
  const r = ctx([
    turn('i', day(1, 0), { cacheRead: 100_000 }),
    turn('i', day(1, 6), { cacheWrite5m: 30_000, cacheWrite1h: 90_000 }),
  ]);
  near(r.idle.usd, 0.705);
  assert.equal(r.idle.tokens, 100_000);
  assert.equal(r.bloat.usd, 0);
});

test('idle: gap must be strictly over 5 minutes', () => {
  const at = (gapMs) => ctx([
    turn('g', day(1, 0), { cacheRead: 100_000 }),
    turn('g', day(1, 0) + gapMs, { cacheWrite1h: 80_000, cacheRead: 20_000 }),
  ]);
  assert.equal(at(4 * MIN + 59_000).idle.usd, 0);
  assert.equal(at(5 * MIN).idle.usd, 0);
  assert.equal(at(5 * MIN).idle.resumes, 0);
  near(at(5 * MIN + 1).idle.usd, 0.624); // 80_000 * 7.8 / 1e6
});

test('idle: no tax for the first turn of a session, even a huge write', () => {
  const r = ctx([
    turn('s1', day(1, 0), { cacheWrite1h: 150_000 }),
    turn('s2', day(2, 0), { cacheWrite1h: 150_000 }), // a different session is not "the previous turn"
  ]);
  assert.equal(r.idle.usd, 0);
  assert.equal(r.idle.resumes, 0);
});

test('idle: small writes after a long gap are ignored, thresholds are inclusive', () => {
  const pair = (prev, written, write = 'cacheWrite5m') => ctx([
    turn('t', day(1, 0), { cacheRead: prev }),
    turn('t', day(1, 30), { [write]: written }),
  ]);
  assert.equal(pair(30_000, 19_999).idle.usd, 0);   // under the 20k floor (half of prev is only 15k)
  assert.equal(pair(100_000, 30_000).idle.usd, 0);  // over 20k but under half of the previous prompt (50_000)
  assert.equal(pair(100_000, 49_999).idle.usd, 0);
  // exactly 20_000 written on a 40_000 prompt (exactly half): 20_000 * (5 - 0.2) / 1e6 = 0.096
  near(pair(40_000, 20_000).idle.usd, 0.096);
  // exactly half of 100_000: 50_000 * 4.8 / 1e6 = 0.24
  near(pair(100_000, 50_000).idle.usd, 0.24);
});

test('idle: recached never exceeds the previous prompt', () => {
  // prev 40_000, written 100_000 (5m): recached 40_000
  // idle = 40_000/100_000 * (100_000 * 5 / 1e6) - 40_000 * 0.2 / 1e6 = 0.2 - 0.008 = 0.192
  const r = ctx([
    turn('t', day(1, 0), { cacheRead: 40_000 }),
    turn('t', day(1, 30), { cacheWrite5m: 100_000 }),
  ]);
  near(r.idle.usd, 0.192);
  assert.equal(r.idle.tokens, 40_000);
});

test('bloat + idle on one cold turn = actual prompt cost - warm prompt capped at cap', () => {
  const A = turn('c', day(1, 0), { cacheRead: 300_000 });
  const B = turn('c', day(1, 10), { cacheWrite1h: 300_000 }); // whole 300k prompt re-written after 10 minutes
  const onlyA = ctx([A]);
  const both = ctx([A, B]);
  // A: bloat (300_000 - 200_000) * 0.2 / 1e6 = 0.02, no idle
  near(onlyA.bloat.usd, 0.02);
  // B: bloat 0.02; idle 300_000 * (8 - 0.2) / 1e6 = 2.34; total 2.36
  // actual 300_000 * 8 / 1e6 = 2.4 minus warm capped prompt 200_000 * 0.2 / 1e6 = 0.04 -> 2.36
  const bTax = both.bloat.usd + both.idle.usd - (onlyA.bloat.usd + onlyA.idle.usd);
  near(bTax, 2.36);
  near(bTax, B.usage.cacheWrite1h * 8 / 1e6 - 200_000 * 0.2 / 1e6);
  near(bTax, costOf(B.usage, OPUS).usd - costOf(use({ cacheRead: 200_000 }), OPUS).usd);
  near(both.idle.usd, 2.34);
  near(both.bloat.usd, 0.04);
});

test('contextTaxes can be called directly and sorts each session by time', () => {
  const t = (ts, usage) => ({ ts, usage: use(usage), key: OPUS, usd: 0, project: 'app' });
  const sessions = new Map([['s', [t(day(1, 10), { cacheWrite1h: 100_000 }), t(day(1, 0), { cacheRead: 100_000 })]]]);
  const r = contextTaxes(sessions, 200_000);
  near(r.idle.usd, 0.78); // 100_000 * 7.8 / 1e6
  assert.equal(r.sessions[0].ts, day(1, 0));
  assert.equal(r.sessions[0].turns, 2);
});

test('taxTotal = bloat + idle + inheritance; perMonthUsd needs 7 days', () => {
  const agents = new Map([run('x:i1', found(OPUS))]);
  const build = (lastDay) => analyze({
    calls: [
      turn('c', day(1, 0), { cacheRead: 300_000 }),                    // bloat 0.02
      turn('c', day(1, 10), { cacheWrite1h: 300_000 }),                // bloat 0.02 + idle 2.34
      call({ ts: day(1, 5), agentKey: 'x:i1', sessionId: 'x' }),       // inherited: 14 -> 7, tax 7
      turn('z', day(lastDay), { input: 1000 }),
    ],
    agents,
  });
  const ten = build(11);
  near(ten.bloat.usd, 0.04);
  near(ten.idle.usd, 2.34);
  near(ten.tax.usd, 7);
  near(ten.taxTotal.usd, 9.38);
  near(ten.taxTotal.shareOfTotal, 9.38 / ten.total.usd);
  assert.equal(ten.window.days, 10);
  near(ten.taxTotal.perMonthUsd, 28.14); // 9.38 / 10 * 30
  near(ten.tax.perMonthUsd, 21);         // inheritance alone: 7 / 10 * 30
  // project and day rollups carry all three taxes: day 1 gets 7 + 2.36 + 0.02
  near(ten.byProject.find((p) => p.project === 'app').taxUsd, 9.38);
  near(ten.byDay.find((d) => d.day === '2026-10-01').taxUsd, 9.38);

  const six = build(7);
  assert.equal(six.window.days, 6);
  assert.equal(six.taxTotal.perMonthUsd, null);
  assert.equal(six.tax.perMonthUsd, null);
  near(six.taxTotal.usd, 9.38);
  assert.equal(build(8).window.days, 7);
  near(build(8).taxTotal.perMonthUsd, 40.2); // 9.38 / 7 * 30
});

test('topSessions: sorted by bloat + idle, limited to 5, zero-tax sessions left out', () => {
  const calls = [turn('zero', day(1, 0), { cacheRead: 200_000 })]; // exactly cap
  // bloat for session k: k * 10_000 * 0.2 / 1e6 = k * 0.002
  for (let k = 1; k <= 7; k++) calls.push(turn(`k${k}`, day(2, k), { cacheRead: 200_000 + k * 10_000 }, { project: `p${k}` }));
  // idle-only session: prev prompt 100_000 (read), then 100_000 re-written as 1h: 100_000 * 7.8 / 1e6 = 0.78
  calls.push(turn('m', day(3, 0), { cacheRead: 100_000 }, { project: 'pm' }));
  calls.push(turn('m', day(3, 10), { cacheWrite1h: 100_000 }, { project: 'pm' }));
  const r = ctx(calls);
  assert.deepEqual(r.topSessions.map((s) => s.project), ['pm', 'p7', 'p6', 'p5', 'p4']);
  const m = r.topSessions[0];
  assert.equal(m.turns, 2);
  assert.equal(m.resumes, 1);
  assert.equal(m.peakTokens, 100_000);
  assert.equal(m.ts, day(3, 0));
  near(m.idleUsd, 0.78);
  assert.equal(m.bloatUsd, 0);
  near(m.usd, 0.02 + 0.8); // read 100_000 * 0.2 / 1e6 + 1h write 100_000 * 8 / 1e6
  near(r.topSessions[1].bloatUsd, 0.014);
  near(r.topSessions[4].bloatUsd, 0.008);
  assert.equal(r.bloat.calls, 7);
});

test('fast-mode inherited run: tax excludes the fast premium, fastPremiumUsd reports it', () => {
  // opus-5-5 fast: UNIT 14 * 2 = 28 actual, 14 at standard speed. Same tokens on sonnet-5-5: 7.
  // Tax = 14 - 7 = 7 (not 28 - 7 = 21); the 14 premium is reported separately.
  const agents = new Map([run('x:i1', found(OPUS), { description: 'fast one' })]);
  const r = analyze({ calls: [call({ agentKey: 'x:i1', speed: 'fast' })], agents });
  near(r.total.usd, 28);
  near(r.tax.usd, 7);
  near(r.tax.actualUsd, 14);
  near(r.tax.repricedUsd, 7);
  near(r.fastPremiumUsd, 14);
  near(r.topRuns[0].usd, 14);
  near(r.topRuns[0].taxUsd, 7);
  near(r.taxTotal.usd, 7);
  near(r.byAgentType[0].usd, 14);
  // the run still shows its real cost in the class breakdown
  near(r.subagents.byClass.inherited.usd, 28);
});
