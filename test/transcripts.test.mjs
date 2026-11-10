import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultClaudeDir, loadTranscripts } from '../src/transcripts.mjs';

// Only ever reads the synthetic fixture or temp dirs, never the real ~/.claude.
const FIXTURE = fileURLToPath(new URL('./fixtures/claude', import.meta.url));
const tmps = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'fabletax-test-')); tmps.push(d); return d; };
after(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

const T = (s) => Date.parse(`2026-10-${s}Z`);
const load = (opts = {}) => loadTranscripts({ claudeDir: FIXTURE, ...opts });

function jsonlFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) jsonlFiles(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

const asst = (o = {}) => JSON.stringify({
  type: 'assistant', timestamp: '2026-10-01T00:00:00.000Z', cwd: '/w/proj', requestId: 'r1',
  message: { id: 'm1', model: 'claude-opus-5-5', content: [], usage: { input_tokens: 1, output_tokens: 1 } },
  ...o,
});
const msg = (o = {}) => ({ id: 'm1', model: 'claude-opus-5-5', content: [], usage: { input_tokens: 1, output_tokens: 1 }, ...o });
function writeTree(files) {
  const root = tmp();
  for (const [rel, text] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  return root;
}

test('defaultClaudeDir honours CLAUDE_CONFIG_DIR', () => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.CLAUDE_CONFIG_DIR = '/somewhere/else';
    assert.equal(defaultClaudeDir(), '/somewhere/else');
    delete process.env.CLAUDE_CONFIG_DIR;
    assert.match(defaultClaudeDir(), /\.claude$/);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved;
  }
});

test('fixture stats', async () => {
  const { calls, stats } = await load();
  const onDisk = jsonlFiles(FIXTURE);
  const lines = onDisk.reduce((n, f) => n + readFileSync(f, 'utf8').split('\n').filter(Boolean).length, 0);
  assert.equal(stats.files, 10);
  assert.equal(stats.files, onDisk.length);
  assert.equal(stats.lines, lines);
  // exactly one malformed line that mentions "usage"; the keyword-free junk line is never parsed
  assert.equal(stats.parseErrors, 1);
  // m1 streamed x3 (2 repeats), m2 x2 (1), a1's first reply x2 (1), plus s2's copies of m1 and m2 (2)
  assert.equal(stats.duplicates, 6);
  assert.deepEqual(stats.versions, { '2.1.300': 18, '2.1.308': 1, '2.1.299': 2 });
  assert.equal(stats.latestVersion, '2.1.308');
  assert.equal(calls.length, 21);
});

test('de-dupes streamed lines and resumed copies, keeping the field-wise max', async () => {
  const { calls } = await load();
  const m1 = calls.filter((c) => c.usage.cacheWrite1h === 500);
  assert.equal(m1.length, 1);
  assert.deepEqual(m1[0].usage, { input: 1000, output: 500, cacheWrite5m: 1500, cacheWrite1h: 500, cacheRead: 10_000 });
  assert.equal(m1[0].sessionId, 's1'); // first file wins, not the resumed copy in s2
  assert.equal(m1[0].ts, T('01T00:00:00.000'));
  assert.equal(m1[0].agentKey, null);
  assert.equal(m1[0].model, 'claude-opus-5-5');
  assert.equal(calls.filter((c) => c.sessionId === 's2').length, 1);
});

test('skips <synthetic>, keeps unknown model ids verbatim', async () => {
  const { calls } = await load();
  assert.equal(calls.some((c) => c.model === '<synthetic>'), false);
  assert.equal(calls.filter((c) => c.model === 'claude-fable-5-3').length, 1);
});

test('fast mode, geo, haiku long prompt and legacy cache_creation survive normalisation', async () => {
  const { calls } = await load();
  const fast = calls.filter((c) => c.speed === 'fast');
  assert.equal(fast.length, 1);
  assert.equal(fast[0].geo, 'not_available');
  assert.deepEqual(fast[0].usage, { input: 1000, output: 500, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 });
  const big = calls.find((c) => c.model === 'claude-haiku-5-5' && c.usage.cacheRead === 100_500);
  assert.equal(big.usage.input + big.usage.cacheRead, 101_000);
  const legacy = calls.find((c) => c.agentKey === 's1:a1' && c.usage.output === 300);
  assert.deepEqual(legacy.usage, { input: 500, output: 300, cacheWrite5m: 1000, cacheWrite1h: 0, cacheRead: 25_000 });
});

test('project is basename(cwd), falling back to the projects/ slug', async () => {
  const { calls } = await load();
  const projects = [...new Set(calls.map((c) => c.project))].sort();
  assert.deepEqual(projects, ['-Users-test-beta', 'alpha', 'beta']);
  assert.equal(calls.filter((c) => c.project === '-Users-test-beta').length, 1);
  assert.equal(calls.find((c) => c.agentKey === 's1:a2').project, 'alpha');
});

test('agent keys: subagent files, legacy inline sidechains, main thread', async () => {
  const { calls, agents } = await load();
  assert.equal(calls.filter((c) => c.agentKey === null).length, 12);
  assert.deepEqual([...agents.keys()].sort(), ['s1:a1', 's1:a2', 's1:a3', 's1:a4', 's1:a5', 's1:a6', 's1:a7', 's1:inline']);
  assert.equal(calls.filter((c) => c.agentKey === 's1:inline').length, 1);
  assert.equal(calls.filter((c) => c.agentKey === 's1:a1').length, 2); // streamed duplicate collapsed
});

test('agent runs: dispatch linkage', async () => {
  const { agents } = await load();
  const get = (id) => agents.get(`s1:${id}`);
  const OPUS = 'claude-opus-5-5';

  // inherited: meta.toolUseId -> Agent call with no model; tool_use sat on a streamed repeat line
  assert.deepEqual(get('a1'), {
    agentKey: 's1:a1', agentId: 'a1', sessionId: 's1', agentType: 'general-purpose', description: 'Survey the widgets',
    spawnDepth: 1, dispatch: { found: true, model: null, dispatcherModel: OPUS },
  });
  // pinned
  assert.deepEqual(get('a2').dispatch, { found: true, model: 'haiku', dispatcherModel: OPUS });
  assert.equal(get('a2').agentType, 'Explore');
  // agent-default: dispatched with the legacy "Task" tool name, no model
  assert.deepEqual(get('a3').dispatch, { found: true, model: null, dispatcherModel: OPUS });
  assert.equal(get('a3').agentType, 'reviewer');
  // fork
  assert.equal(get('a4').agentType, 'fork');
  assert.equal(get('a4').dispatch.found, true);
  // no meta.json: linked through the user line's toolUseResult.agentId + tool_use_id; type and
  // description fall back to the dispatch input, spawnDepth to null
  assert.deepEqual(get('a5'), {
    agentKey: 's1:a5', agentId: 'a5', sessionId: 's1', agentType: 'general-purpose', description: 'Linked via result',
    spawnDepth: null, dispatch: { found: true, model: null, dispatcherModel: OPUS },
  });
  // meta points at a tool_use id that does not exist anywhere
  assert.deepEqual(get('a6').dispatch, { found: false, model: null, dispatcherModel: null });
  assert.equal(get('a6').description, 'Orphan run');
  // dispatched from inside another subagent's transcript
  assert.deepEqual(get('a7').dispatch, { found: true, model: null, dispatcherModel: OPUS });
  assert.equal(get('a7').spawnDepth, 2);
  // legacy inline line: nothing to link
  assert.deepEqual(get('inline'), {
    agentKey: 's1:inline', agentId: 'inline', sessionId: 's1', agentType: null, description: '', spawnDepth: null,
    dispatch: { found: false, model: null, dispatcherModel: null },
  });
});

test('project filter is a case-insensitive substring of Call.project', async () => {
  const beta = await load({ project: 'BET' });
  assert.equal(beta.calls.length, 2); // cwd basename 'beta' + the slug-fallback '-Users-test-beta'
  assert.equal(beta.agents.size, 0);
  const alpha = await load({ project: 'alph' });
  assert.equal(alpha.calls.length, 19);
  assert.equal(alpha.agents.size, 8);
  assert.equal((await load({ project: 'nope' })).calls.length, 0);
});

test('sinceMs drops older calls and agents without remaining calls', async () => {
  const r = await load({ sinceMs: T('09T00:00:00.000') });
  // fast (10-09), haiku>100k (10-10), s2 new (10-10), s3 x2 (10-10, 10-11)
  assert.equal(r.calls.length, 5);
  assert.equal(r.agents.size, 0);
  assert.ok(r.calls.every((c) => c.ts >= T('09T00:00:00.000')));
});

test('sinceMs skips files whose mtime is older', async () => {
  const root = tmp();
  cpSync(FIXTURE, root, { recursive: true });
  const old = new Date('2020-01-01T00:00:00Z');
  utimesSync(join(root, 'projects/-Users-test-beta/s3.jsonl'), old, old);
  const r = await loadTranscripts({ claudeDir: root, sinceMs: T('01T00:00:00.000') - 86_400_000 });
  assert.equal(r.stats.files, 9);
  assert.equal(r.calls.length, 19);
  assert.equal(r.calls.some((c) => c.sessionId === 's3'), false);
});

test('missing timestamp falls back to the file mtime', async () => {
  const root = writeTree({ 'projects/p/s.jsonl': asst({ timestamp: undefined }) + '\n' });
  const f = join(root, 'projects/p/s.jsonl');
  const when = new Date('2026-09-15T12:00:00Z');
  utimesSync(f, when, when);
  const { calls } = await loadTranscripts({ claudeDir: root });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].ts, statSync(f).mtimeMs);
  assert.equal(calls[0].project, 'proj');
});

test('duplicate usage is merged field-wise; different requestId or no message.id is not a duplicate', async () => {
  const root = writeTree({
    'projects/p/s.jsonl': [
      asst({ message: msg({ usage: { input_tokens: 10, output_tokens: 500 } }) }),
      asst({ message: msg({ usage: { input_tokens: 20, output_tokens: 100, cache_read_input_tokens: 7 } }) }),
      asst({ requestId: 'r2', message: msg({ usage: { input_tokens: 1, output_tokens: 1 } }) }),
      asst({ message: msg({ id: undefined }) }),
      asst({ message: msg({ id: undefined }) }),
    ].join('\n'),
  });
  const { calls, stats } = await loadTranscripts({ claudeDir: root });
  assert.equal(stats.duplicates, 1);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[0].usage, { input: 20, output: 500, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 7 });
});

test('layout: only <slug>/<session>.jsonl and **/subagents/agent-*.jsonl are read; blank lines and CRLF are fine', async () => {
  const root = writeTree({
    'projects/p/main.jsonl': asst() + '\r\n\r\n',
    'projects/p/main/subagents/agent-zz.jsonl': asst({ message: msg({ id: 'm2' }), isSidechain: true }) + '\n',
    'projects/p/main/other/stray.jsonl': asst({ message: msg({ id: 'm3' }) }) + '\n',
    'projects/p/notes.txt': asst({ message: msg({ id: 'm4' }) }) + '\n',
    'projects/p/main/subagents/agent-zz.meta.json': '{ not json',
  });
  const { calls, agents, stats } = await loadTranscripts({ claudeDir: root });
  assert.equal(stats.files, 2);
  assert.equal(calls.length, 2);
  assert.equal(agents.get('main:zz').agentType, null); // unreadable meta is just no meta
  assert.equal(agents.get('main:zz').sessionId, 'main');
});

test('missing claude dir yields an empty result', async () => {
  const r = await loadTranscripts({ claudeDir: join(tmp(), 'does-not-exist') });
  assert.deepEqual(r.calls, []);
  assert.equal(r.agents.size, 0);
  assert.deepEqual(r.stats, { files: 0, lines: 0, parseErrors: 0, duplicates: 0, versions: {}, latestVersion: null });
});

test('latestVersion compares numerically', async () => {
  const root = writeTree({
    'projects/p/s.jsonl': [
      asst({ version: '2.1.99', message: msg({ id: 'a' }) }),
      asst({ version: '2.1.308', message: msg({ id: 'b' }) }),
      asst({ version: '2.1.1000', message: msg({ id: 'c' }) }),
      asst({ version: '2.0.5000', message: msg({ id: 'd' }) }),
    ].join('\n'),
  });
  assert.equal((await loadTranscripts({ claudeDir: root })).stats.latestVersion, '2.1.1000');
});
