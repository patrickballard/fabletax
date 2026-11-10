import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/analyze.mjs';
import { renderReport, money, bar, modelName, tokens, stripAnsi, visibleLength } from '../src/report.mjs';

const NOW = Date.UTC(2026, 10, 10, 12);
const DAY = 86_400_000;
const M = 1_000_000;
const usage = (input = 0, output = 0, cacheRead = 0) => ({ input, output, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead });

// Builds { calls, agents } from a short description of main calls and subagent runs.
// Main calls may set `session` and `at` (absolute ms) to build multi-turn sessions.
function data({ main = [], runs = [] }) {
  const calls = [];
  const agents = new Map();
  for (const m of main) {
    calls.push({ ts: m.at ?? NOW - (m.days ?? 1) * DAY, sessionId: m.session ?? 's1', project: m.project ?? 'my-app', model: m.model, usage: m.usage, agentKey: null });
  }
  runs.forEach((r, i) => {
    const agentKey = `s1:a${i}`;
    calls.push({ ts: NOW - (r.days ?? 1) * DAY, sessionId: 's1', project: r.project ?? 'my-app', model: r.model, usage: r.usage, agentKey });
    agents.set(agentKey, {
      agentKey, agentId: `a${i}`, sessionId: 's1',
      agentType: r.agentType ?? 'general-purpose', description: r.description ?? '', spawnDepth: 1,
      dispatch: { found: true, model: r.pinned ?? null, dispatcherModel: r.dispatcher ?? r.model },
    });
  });
  return { calls, agents };
}

const render = (d, config = null, opts = {}, analyzeOpts = {}) =>
  renderReport(analyze(d, { target: 'sonnet', now: NOW, ...analyzeOpts }), config, { color: false, days: 30, ...opts });

// One main call ($0.40 on opus-5-5: 100k input, under the cap) and one
// inherited subagent run (1M in + 1M out = $24 on opus-5-5, $12 on
// sonnet-5-5), so the only tax is the $12 inheritance tax.
const taxed = () => data({
  main: [{ model: 'claude-opus-5-5', usage: usage(100_000) }],
  runs: [{ model: 'claude-opus-5-5', usage: usage(M, M), description: 'refactor the billing module', project: 'secret-project' }],
});

// All three taxes on fable-5 (cache write $12.50/M, cache read $1.00/M):
//  bloat:       3 turns of 1M cached tokens: (1M - 200k) * $1 = $0.80 each -> $2.40
//  idle:        2 turns in one session, 10 minutes apart; the second rewrites
//               100k tokens: $1.25 write - $0.10 read = $1.15
//  inheritance: the $12 run above
// Spend: 3 * $1.00 + 2 * $1.25 + $24 = $29.50; tax $15.55.
const all3 = () => {
  const d = data({
    main: [
      ...[0, 1, 2].map((i) => ({ model: 'claude-fable-5', usage: usage(0, 0, M), days: 10, at: NOW - 10 * DAY + i * 60_000, session: 'big', project: 'secret-project' })),
      { model: 'claude-fable-5', usage: { input: 0, output: 0, cacheWrite5m: 100_000, cacheWrite1h: 0, cacheRead: 0 }, at: NOW - 3 * DAY, session: 'cold', project: 'other-project' },
      { model: 'claude-fable-5', usage: { input: 0, output: 0, cacheWrite5m: 100_000, cacheWrite1h: 0, cacheRead: 0 }, at: NOW - 3 * DAY + 10 * 60_000, session: 'cold', project: 'other-project' },
    ],
    runs: [{ model: 'claude-opus-5-5', usage: usage(M, M), description: 'refactor the billing module', project: 'secret-project' }],
  });
  return d;
};

const cfg = {
  findings: [
    { id: 'unpinned-agents', level: 'bad', title: '3 custom agents have no model: reviewer, planner, docs', detail: 'x', fixable: true },
    { id: 'guard', level: 'bad', title: 'Guard hook not installed', detail: 'y', fixable: true },
    { id: 'subagent-env', level: 'ok', title: 'CLAUDE_CODE_SUBAGENT_MODEL not set', detail: 'z', fixable: false },
  ],
};

const flat = (s) => s.replace(/\s+/g, ' ');
const visibleLines = (s) => stripAnsi(s).split('\n');
const longest = (s) => Math.max(...visibleLines(s).map((l) => [...l].length));

test('the box lists all three taxes with their figures', () => {
  const out = render(all3(), cfg);
  assert.match(out, /You spent\s+\$29\.50\s+6 API calls/);
  assert.match(out, /main thread\s+\$5\.50/);
  assert.match(out, /subagents\s+\$24\.00\s+1 run\b/);
  assert.match(out, /TAX\s+\$15\.55\s+53% of everything you spent/);
  assert.match(out, /Bloat tax\s+\$2\.40\s+3 turns carried over 200k tokens/);
  assert.match(out, /Idle tax\s+\$1\.15\s+1 resume after the cache expired/);
  assert.match(out, /Inheritance tax\s+\$12\.00\s+1 subagent ran on Opus 5\.5/);
  assert.match(out, /At this rate: ~\$\d+\/month\./);
  // The sections underneath.
  assert.match(out, /Bloat tax · \$2\.40/);
  assert.ok(flat(out).includes('3 turns carried more than 200k; the largest carried 1M. This is the cost of the part above 200k.'));
  assert.match(out, /Fix: \/compact or \/clear when a task is done\./);
  assert.match(out, /Idle tax · \$1\.15/);
  assert.ok(flat(out).includes('1 time you came back after the prompt cache had expired and paid to write 100k tokens of old context back into it.'));
  assert.match(out, /Inheritance tax · \$12\.00/);
  assert.ok(flat(out).includes('1 of 1 subagent run was dispatched without a model, so it ran on Opus 5.5. Cost: $24.00. Same tokens on Sonnet 5.5: $12.00.'));
  assert.match(out, /Fix: npx fabletax fix/);
  assert.doesNotMatch(out, /✓ No/);
  assert.doesNotMatch(out, /Fix it:/);
  assert.ok(flat(out).includes('Bloat assumes the work fit in 200k tokens of context, idle that the cache stayed warm, inheritance that Sonnet 5.5 could do'));
});

test('the box rows line up', () => {
  const rows = visibleLines(render(all3())).filter((l) => /(Bloat|Idle|Inheritance) tax\s+\$/.test(l) && l.includes('│'));
  assert.equal(rows.length, 3);
  const cols = rows.map((l) => l.indexOf('$'));
  const ends = rows.map((l) => /\$[\d,.]+/.exec(l).index + /\$[\d,.]+/.exec(l)[0].length);
  assert.equal(new Set(ends).size, 1);
  assert.ok(cols.every((c) => c > 0));
});

test('worst sessions table', () => {
  const out = render(all3());
  assert.match(out, /Worst sessions\s+spent\s+bloat\s+idle\s+peak/);
  assert.match(out, /secret-project\s+Oct 31\s+\$3\.00\s+\$2\.40\s+\$0\.00\s+1M/);
  assert.match(out, /other-project\s+Nov 07\s+\$2\.50\s+\$0\.00\s+\$1\.15\s+100k/);
  assert.ok(out.indexOf('secret-project  ') < out.indexOf('other-project'));
});

test('--share replaces session projects with "session N" and drops names', () => {
  const out = render(all3(), cfg, { share: true, verbose: true });
  assert.match(out, /session 1\s+Oct 31/);
  assert.match(out, /session 2\s+Nov 07/);
  assert.doesNotMatch(out, /secret-project|other-project|billing/);
});

test('inheritance paragraph names the model, or "your main model" when mixed', () => {
  const mixed = data({ runs: [
    { model: 'claude-opus-5-5', usage: usage(M, M), agentType: 'a' },
    { model: 'claude-fable-5-2', usage: usage(M, M), agentType: 'b' },
  ] });
  const out = render(mixed);
  assert.ok(flat(out).includes('2 of 2 subagent runs were dispatched without a model, so they ran on your main model.'));
  assert.match(out, /2 subagents ran on your main model/);
});

test('"N of M" uses the taxed runs', () => {
  const d = data({ runs: [
    { model: 'claude-opus-5-5', usage: usage(M, M) },
    { model: 'claude-sonnet-5-5', usage: usage(M, M), agentType: 'cheap' },
    { model: 'claude-opus-5-5', usage: usage(M, M), pinned: 'sonnet', agentType: 'pinned' },
  ] });
  assert.match(render(d), /1 of 3 subagent runs was dispatched without a model/);
});

test('a tax with no cost collapses to a dim green-check line', () => {
  const out = render(taxed(), cfg);
  assert.match(out, /TAX\s+\$12\.00\s+49% of everything you spent/);
  assert.match(out, /Inheritance tax\s+\$12\.00/);
  assert.doesNotMatch(out, /Bloat tax|Idle tax/);
  assert.match(out, /✓ No bloat tax\n\s+✓ No idle tax/);
  assert.doesNotMatch(out, /✓ No inheritance tax/);
  assert.doesNotMatch(out, /Worst sessions/);

  const onlyBloat = render(data({ main: [{ model: 'claude-fable-5', usage: usage(0, 0, M) }] }));
  assert.match(onlyBloat, /Bloat tax · \$0\.80/);
  assert.match(onlyBloat, /✓ No idle tax/);
  assert.match(onlyBloat, /✓ No inheritance tax/);
  assert.doesNotMatch(onlyBloat, /Idle tax ·|Inheritance tax ·/);
  assert.match(onlyBloat, /Worst sessions/);

  const colored = render(taxed(), null, { color: true });
  assert.match(colored, /\x1b\[32m✓\x1b\[0m \x1b\[2mNo bloat tax\x1b\[0m/);
});

test('the Bloat fix line follows the compact-window finding', () => {
  const finding = (f) => ({ findings: [{ id: 'compact-window', detail: 'd', ...f }], compact: f.window ? { window: f.window } : { window: null } });
  const bloatSection = (out) => flat(out).split('Bloat tax · ')[1].split('Idle tax · ')[0];

  const fixable = render(all3(), finding({ level: 'bad', title: 'Auto-compact window not set: 1M-context models carry up to ~967k tokens per turn', fixable: true }));
  assert.ok(flat(fixable).includes('Fix: npx fabletax fix (sets auto-compact to 200k; undo with --undo)'));
  assert.ok(!flat(bloatSection(fixable)).includes('Fix: /compact'));

  const already = render(all3(), finding({ level: 'ok', title: 'Auto-compact window 150k', window: 150000 }));
  const sec = bloatSection(already);
  assert.ok(sec.includes('Auto-compact is already set to 150k; this is from before, or from sessions that predate it. Fix: /compact or /clear when a task is done.'), sec);
  assert.ok(!sec.includes('npx fabletax fix'));

  const manual = render(all3(), finding({ level: 'bad', title: 'Auto-compact window is 500k, above 200k', fixable: false, window: 500000 }));
  const msec = bloatSection(manual);
  assert.ok(msec.includes('Auto-compact window is 500k, above 200k Fix: /autocompact 200k'), msec);

  // A window above the cap is not "already set".
  assert.ok(!flat(manual).includes('already set'));

  // Without a compact finding, and with the 1M-context switch off, the plain advice stays.
  for (const cfgIn of [null, cfg, finding({ level: 'ok', title: 'CLAUDE_CODE_DISABLE_1M_CONTEXT is set' })]) {
    const out = render(all3(), cfgIn);
    assert.ok(bloatSection(out).includes('Fix: /compact or /clear when a task is done.'));
    assert.ok(!bloatSection(out).includes('already set'));
  }

  // The wording uses the cap the report was built with.
  const capped = render(all3(), finding({ level: 'bad', title: 't', fixable: true }), {}, { cap: 500_000 });
  assert.ok(flat(capped).includes('sets auto-compact to 500k;'));
  const capManual = render(all3(), finding({ level: 'bad', title: 't', fixable: false }), {}, { cap: 500_000 });
  assert.ok(flat(capManual).includes('Fix: /autocompact 500k'));
});

test('compact-window findings appear in the Config list (title only, detail with --verbose)', () => {
  const config = { findings: [{ id: 'compact-window', level: 'bad', title: 'Auto-compact window not set', detail: 'Every turn re-reads everything.', fixable: true }], compact: { window: null } };
  const out = render(taxed(), config);
  assert.match(out, /✗ Auto-compact window not set/);
  assert.doesNotMatch(out, /Every turn re-reads everything/);
  assert.match(render(taxed(), config, { verbose: true }), /Every turn re-reads everything\./);
});

test('--cap changes the copy', () => {
  const out = render(all3(), null, {}, { cap: 500_000 });
  assert.match(out, /3 turns carried over 500k tokens/);
  assert.match(out, /Bloat tax\s+\$1\.50/);
  assert.ok(flat(out).includes('fit in 500k tokens of context'));
});

test('--as haiku names the repricing model in the sentence', () => {
  const out = render(taxed(), null, {}, { target: 'haiku' });
  assert.match(flat(out), /Same tokens on Haiku 5\.5: \$\d/);
  assert.match(flat(out), /inheritance that Haiku 5\.5 could do/);
});

test('run-rate appears only once there is a week of data', () => {
  assert.doesNotMatch(render(taxed()), /At this rate/);
  const week = data({
    main: [{ model: 'claude-opus-5-5', usage: usage(100_000), days: 10 }],
    runs: [{ model: 'claude-opus-5-5', usage: usage(M, M), days: 1 }],
  });
  assert.match(render(week), /At this rate: ~\$\d+\/month\./);
});

test('thousands separators in large figures', () => {
  const big = data({ runs: [{ model: 'claude-opus-5-5', usage: usage(400 * M, 100 * M) }] });
  const out = render(big);
  assert.match(out, /\$3,600\.00/);
  assert.doesNotMatch(out, /…/);
  assert.equal(money(1284.1), '$1,284.10');
  assert.equal(money(0), '$0.00');
  assert.equal(money(-0.001), '$0.00');
});

test('all-zero variant: a green "No tax found" box', () => {
  const d = data({
    main: [{ model: 'claude-opus-5-5', usage: usage(100_000) }],
    runs: [{ model: 'claude-opus-5-5', usage: usage(M, M), pinned: 'sonnet' }],
  });
  const out = render(d, { findings: [{ id: 'guard', level: 'ok', title: 'Guard hook installed', detail: '', fixable: false }] });
  assert.match(out, /│  No tax found\s+│/);
  assert.ok(flat(out.replace(/│/g, '')).includes('Nothing carried over 200k tokens, no cold-cache resumes, and no subagent inherited a model pricier than Sonnet 5.5.'));
  assert.doesNotMatch(out, /TAX\s+\$|Bloat tax|Idle tax|Inheritance tax|✓ No/);
  assert.doesNotMatch(out, /Worst sessions|Where it went|Biggest runs|Fix it/);
  assert.match(out, /Spend by model/);
  assert.match(render(d, null, { color: true }), /\x1b\[32m│\x1b\[0m/);
});

test('the detail tables sit behind --verbose', () => {
  const quiet = render(all3());
  assert.doesNotMatch(quiet, /Where it went|Biggest runs|Spend by project/);
  const loud = render(all3(), null, { verbose: true });
  assert.match(loud, /Where it went/);
  assert.match(loud, /Biggest runs/);
  assert.match(loud, /general-purpose\s+1 run\s+\$24\.00\s+→\s+\$12\.00/);
});

test('no-data variant says where it looked', () => {
  const out = render({ calls: [], agents: new Map() }, cfg, { claudeDir: '/home/me/.claude', home: '/home/me' });
  assert.match(out, /No Claude Code usage found in the last 30 days\./);
  assert.match(out, /Looked in ~\/\.claude\/projects/);
  assert.doesNotMatch(out, /You spent|TAX/);
  assert.match(render({ calls: [], agents: new Map() }, null, { all: true }), /No Claude Code usage found\./);
});

test('window label', () => {
  assert.match(render(taxed(), null, { days: 7 }), /last 7 days · prices as of 2026-11-10/);
  assert.match(render(taxed(), null, { all: true }), /fabletax · all time/);
});

test('--share leaves out project names and descriptions, even with --verbose', () => {
  const d = data({
    main: [{ model: 'claude-opus-5-5', usage: usage(100_000), project: 'secret-project' }],
    runs: [{ model: 'claude-opus-5-5', usage: usage(M, M), description: 'refactor the billing module', project: 'secret-project' }],
  });
  const plain = render(d, cfg, { share: true });
  const verbose = render(d, cfg, { share: true, verbose: true });
  for (const out of [plain, verbose]) {
    assert.doesNotMatch(out, /secret-project/);
    assert.doesNotMatch(out, /billing/);
    assert.match(out, /TAX\s+\$12\.00/);
  }
  const normal = render(d, cfg, { verbose: true });
  assert.match(normal, /secret-project/);
  assert.match(normal, /billing/);
});

test('--verbose adds descriptions and projects', () => {
  const out = render(taxed(), cfg, { verbose: true });
  assert.match(out, /refactor the billing module/);
  assert.match(out, /Spend by project/);
});

test('no line exceeds 76 visible columns', () => {
  const many = data({
    main: [
      { model: 'claude-opus-5-5', usage: usage(900 * M, 90 * M) },
      { model: 'claude-fable-5-2', usage: usage(50 * M, 5 * M) },
      { model: 'claude-sonnet-4-5', usage: usage(M) },
      { model: 'claude-haiku-4-5', usage: usage(M) },
      { model: 'claude-opus-4-8', usage: usage(M) },
      { model: 'claude-opus-4-7', usage: usage(M) },
      { model: 'made-up-model-9', usage: usage(M), project: 'x' },
    ],
    runs: Array.from({ length: 9 }, (_, i) => ({
      model: i % 2 ? 'claude-fable-5-2' : 'claude-opus-5-5',
      usage: usage((i + 1) * 20 * M, (i + 1) * 4 * M),
      agentType: `an-extremely-long-custom-agent-name-number-${i}`,
      description: 'a very long description '.repeat(10),
      project: 'a-project-with-a-really-long-name-that-goes-on-and-on',
      days: i + 1,
    })),
  });
  const longConfig = { findings: [{ id: 'x', level: 'bad', title: 'word '.repeat(60), detail: 'd'.repeat(200), fixable: true }] };
  for (const color of [false, true]) {
    for (const opts of [{}, { verbose: true }, { share: true }, { all: true }]) {
      const out = render(many, longConfig, { color, ...opts });
      for (const line of out.split('\n')) assert.ok(visibleLength(line) <= 76, `too wide (${visibleLength(line)}): ${stripAnsi(line)}`);
    }
  }
  for (const line of render({ calls: [], agents: new Map() }, null, { claudeDir: `/x/${'y'.repeat(100)}` }).split('\n')) {
    assert.ok(visibleLength(line) <= 76);
  }
});

test('three-tax layout stays within 76 columns, including huge figures and long names', () => {
  const project = 'a-project-with-a-really-long-name-that-goes-on-and-on';
  const d = data({
    main: [
      ...Array.from({ length: 6 }, (_, i) => ({ model: 'claude-fable-5', usage: usage(0, 0, 900 * M), at: NOW - 20 * DAY + i * 1000, session: `big${i}`, project: `${project}-${i}` })),
      { model: 'claude-fable-5', usage: { input: 0, output: 0, cacheWrite5m: 900_000_000, cacheWrite1h: 0, cacheRead: 0 }, at: NOW - 9 * DAY, session: 'cold', project },
      { model: 'claude-fable-5', usage: { input: 0, output: 0, cacheWrite5m: 900_000_000, cacheWrite1h: 0, cacheRead: 0 }, at: NOW - 8 * DAY, session: 'cold', project },
    ],
    runs: [{ model: 'claude-opus-5-5', usage: usage(900 * M, 90 * M), agentType: 'x'.repeat(60) }],
  });
  const wide = analyze(d, { now: NOW });
  assert.ok(wide.topSessions.length > 0 && wide.bloat.usd > 1000);
  for (const color of [false, true]) {
    for (const opts of [{}, { verbose: true }, { share: true }]) {
      for (const line of renderReport(wide, cfg, { color, days: 30, ...opts }).split('\n')) {
        assert.ok(visibleLength(line) <= 76, `too wide (${visibleLength(line)}): ${stripAnsi(line)}`);
      }
    }
  }
});

test('the tax box stays aligned', () => {
  for (const color of [false, true]) {
    const lines = visibleLines(render(all3(), cfg, { color }));
    const box = lines.filter((l) => /^\s*[╭│╰]/.test(l));
    assert.ok(box.length >= 8);
    assert.equal(new Set(box.map((l) => [...l].length)).size, 1);
  }
});

test('no ANSI codes when color is false, codes when true', () => {
  assert.doesNotMatch(render(taxed(), cfg), /\x1b/);
  assert.doesNotMatch(render({ calls: [], agents: new Map() }, cfg), /\x1b/);
  const colored = render(taxed(), cfg, { color: true });
  assert.match(colored, /\x1b\[1;31m\$12\.00\x1b\[0m/);
  assert.equal(stripAnsi(colored), render(taxed(), cfg));
});

test('unpriced calls and fast-mode premium are mentioned only when non-zero', () => {
  const clean = render(taxed());
  assert.doesNotMatch(clean, /not priced|fast-mode/);
  const d = data({
    main: [
      { model: 'claude-mystery-9', usage: usage(M) },
      { model: 'claude-opus-5-5', usage: usage(M) },
    ],
    runs: [{ model: 'claude-opus-5-5', usage: usage(M, M) }],
  });
  d.calls[1].speed = 'fast';
  const out = render(d);
  assert.match(out, /1 call not priced .*claude-mystery-9/);
  assert.match(out, /includes \$4\.00 of fast-mode premium/);
});

test('helpers', () => {
  assert.equal(modelName('claude-sonnet-5-5'), 'Sonnet 5.5');
  assert.equal(modelName('claude-fable-5'), 'Fable 5');
  assert.equal(modelName('claude-opus-4-5-20251101'), 'Opus 4.5');
  assert.equal(modelName('claude-haiku-5-5[1m]'), 'Haiku 5.5');
  assert.equal(tokens(967_000), '967k');
  assert.equal(tokens(22_100_000), '22.1M');
  assert.equal(tokens(200_000), '200k');
  assert.equal(tokens(999_900), '1M');
  assert.equal(tokens(512), '512');
  assert.equal(modelName('gpt-whatever'), 'gpt-whatever');
  const b = bar(0.5, 20);
  assert.equal(b.filled.length, 10);
  assert.equal(b.empty.length, 10);
  assert.equal(bar(2, 4).filled.length, 4);
  assert.equal(bar(-1, 4).filled.length, 0);
});
