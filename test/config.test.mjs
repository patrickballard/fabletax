import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { auditConfig, readFrontmatter } from '../src/config.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fabletax-config-'));
const put = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
};
const agent = (model, name = 'x') => `---\nname: ${name}\ndescription: d\n${model === undefined ? '' : `model: ${model}\n`}---\nbody\n`;
const find = (audit, id) => audit.findings.find((f) => f.id === id);

function setup() {
  const claudeDir = tmp();
  const cwd = tmp();
  return { claudeDir, cwd, run: (o = {}) => auditConfig({ claudeDir, cwd, env: {}, ...o }) };
}

test('readFrontmatter reads top-level keys, quotes, CRLF and ignores block scalars', () => {
  const fm = readFrontmatter('---\r\nname: "rev"\r\ndescription: |\r\n  model: opus\r\nmodel: haiku # cheap\r\n---\r\nbody');
  assert.deepEqual(fm.data, { name: 'rev', description: '|', model: 'haiku' });
  assert.equal(readFrontmatter('no frontmatter'), null);
  assert.equal(readFrontmatter('---\nname: x\n'), null);
});

test('missing dirs and files are normal', () => {
  const claudeDir = path.join(tmp(), 'nope');
  const a = auditConfig({ claudeDir, cwd: path.join(tmp(), 'nope2'), env: {}, latestVersion: null });
  assert.deepEqual(a.agents, []);
  assert.equal(a.guardInstalled, false);
  assert.equal(find(a, 'guard').level, 'bad');
  assert.equal(find(a, 'guard').fixable, true);
  assert.equal(find(a, 'subagent-env').level, 'ok');
  assert.ok(a.findings.every((f) => f.title && typeof f.detail === 'string'));
});

test('unpinned agents: none / inherit / pinned, user and project scopes', () => {
  const { claudeDir, cwd, run } = setup();
  put(path.join(claudeDir, 'agents', 'reviewer.md'), agent(undefined, 'reviewer'));
  put(path.join(claudeDir, 'agents', 'planner.md'), agent('inherit', 'planner'));
  put(path.join(cwd, '.claude', 'agents', 'docs.md'), agent('haiku'));
  put(path.join(cwd, '.claude', 'agents', 'notes.txt'), 'ignored');
  put(path.join(cwd, '.claude', 'agents', 'nofm.md'), 'just text');
  const a = run();
  assert.equal(a.agents.length, 3);
  const f = find(a, 'unpinned-agents');
  assert.equal(f.level, 'bad');
  assert.equal(f.fixable, true);
  assert.match(f.title, /^2 custom agents have no model: /);
  assert.match(f.title, /reviewer/);
  assert.match(f.title, /planner/);
  assert.deepEqual(a.agents.filter((x) => x.pinned).map((x) => x.model), ['haiku']);
});

test('all agents pinned -> ok', () => {
  const { claudeDir, run } = setup();
  put(path.join(claudeDir, 'agents', 'a.md'), agent('sonnet'));
  assert.equal(find(run(), 'unpinned-agents').level, 'ok');
});

test('guard: hook in settings.json, plugin in enabledPlugins, absent', () => {
  const { claudeDir, run } = setup();
  assert.equal(run().guardInstalled, false);
  put(path.join(claudeDir, 'settings.json'), { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo' }] }] } });
  assert.equal(run().guardInstalled, false);
  put(path.join(claudeDir, 'settings.json'), {
    hooks: { PreToolUse: [{ matcher: 'Agent|Task', hooks: [{ type: 'command', command: 'node', args: ['/x/fabletax/guard.mjs'] }] }] },
  });
  const a = run();
  assert.equal(a.guardInstalled, true);
  assert.equal(find(a, 'guard').level, 'ok');
  put(path.join(claudeDir, 'settings.json'), { enabledPlugins: { 'fabletax@fabletax': true } });
  assert.equal(run().guardInstalled, true);
  put(path.join(claudeDir, 'settings.json'), { enabledPlugins: { 'fabletax@fabletax': false } });
  assert.equal(run().guardInstalled, false);
});

test('subagent-env: bad for opus/fable, ok for sonnet/haiku, read from every source', () => {
  const { claudeDir, cwd, run } = setup();
  put(path.join(claudeDir, 'settings.json'), { env: { CLAUDE_CODE_SUBAGENT_MODEL: 'claude-opus-5-5' } });
  assert.equal(find(run(), 'subagent-env').level, 'bad');
  put(path.join(claudeDir, 'settings.json'), {});
  put(path.join(cwd, '.claude', 'settings.local.json'), { env: { CLAUDE_CODE_SUBAGENT_MODEL: 'fable' } });
  assert.equal(find(run(), 'subagent-env').level, 'bad');
  put(path.join(cwd, '.claude', 'settings.local.json'), {});
  assert.equal(find(run({ env: { CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet' } }), 'subagent-env').level, 'ok');
  assert.equal(find(run({ env: { CLAUDE_CODE_SUBAGENT_MODEL: 'claude-haiku-5-5' } }), 'subagent-env').level, 'ok');
  assert.equal(find(run({ env: { CLAUDE_CODE_SUBAGENT_MODEL: 'opus' } }), 'subagent-env').level, 'bad');
});

test('subagent-force only appears when set', () => {
  const { run } = setup();
  assert.equal(find(run(), 'subagent-force'), undefined);
  assert.equal(find(run({ env: { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' } }), 'subagent-force').level, 'bad');
  assert.equal(find(run({ env: { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '0' } }), 'subagent-force'), undefined);
});

test('old-version needs both an old version and the env var', () => {
  const { run } = setup();
  const env = { CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet' };
  assert.equal(find(run({ env, latestVersion: '2.1.250' }), 'old-version').level, 'bad');
  assert.equal(find(run({ env, latestVersion: '2.1.251' }), 'old-version'), undefined);
  assert.equal(find(run({ env, latestVersion: '2.0.999' }), 'old-version').level, 'bad');
  assert.equal(find(run({ env: {}, latestVersion: '2.1.250' }), 'old-version'), undefined);
  assert.equal(find(run({ env, latestVersion: null }), 'old-version'), undefined);
});

test('main-model is info for opus/fable only', () => {
  const { claudeDir, run } = setup();
  put(path.join(claudeDir, 'settings.json'), { model: 'opus' });
  assert.equal(find(run(), 'main-model').level, 'info');
  put(path.join(claudeDir, 'settings.json'), { model: 'sonnet' });
  assert.equal(find(run(), 'main-model'), undefined);
});

test('invalid settings.json never throws and is reported', () => {
  const { claudeDir, run } = setup();
  put(path.join(claudeDir, 'settings.json'), '{ nope');
  const a = run();
  assert.equal(find(a, 'settings-invalid').level, 'bad');
  assert.equal(a.guardInstalled, false);
});

const win = (a) => find(a, 'compact-window');

test('compact-window: unset is bad and fixable; compact is {window:null}', () => {
  const { run } = setup();
  const a = run();
  assert.equal(win(a).level, 'bad');
  assert.equal(win(a).fixable, true);
  assert.match(win(a).title, /^Auto-compact window not set: 1M-context models carry up to ~967k tokens per turn$/);
  assert.deepEqual(a.compact, { window: null, source: null });
});

test('compact-window: user setting at or under the cap is ok, over is fixable', () => {
  const { claudeDir, run } = setup();
  const file = path.join(claudeDir, 'settings.json');
  put(file, { autoCompactWindow: 200000 });
  let a = run();
  assert.equal(win(a).level, 'ok');
  assert.deepEqual(a.compact, { window: 200000, source: file });
  put(file, { autoCompactWindow: 500000 });
  a = run();
  assert.equal(win(a).level, 'bad');
  assert.equal(win(a).fixable, true);
  assert.equal(run({ cap: 500000 }).findings.find((f) => f.id === 'compact-window').level, 'ok');
});

test('compact-window: precedence local > project > user', () => {
  const { claudeDir, cwd, run } = setup();
  put(path.join(claudeDir, 'settings.json'), { autoCompactWindow: 900000 });
  put(path.join(cwd, '.claude', 'settings.json'), { autoCompactWindow: 400000 });
  let a = run();
  assert.equal(a.compact.window, 400000);
  assert.equal(win(a).fixable, false);
  put(path.join(cwd, '.claude', 'settings.local.json'), { autoCompactWindow: 150000 });
  a = run();
  assert.equal(a.compact.window, 150000);
  assert.equal(win(a).level, 'ok');
});

test('compact-window: env var beats settings, accepts 200k, over-cap env is bad and not fixable', () => {
  const { claudeDir, cwd, run } = setup();
  put(path.join(claudeDir, 'settings.json'), { autoCompactWindow: 900000 });
  let a = run({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200k' } });
  assert.equal(win(a).level, 'ok');
  assert.deepEqual(a.compact, { window: 200000, source: 'process env' });
  a = run({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '800000' } });
  assert.equal(win(a).level, 'bad');
  assert.equal(win(a).fixable, false);
  assert.match(win(a).detail, /process env/);
  assert.match(win(a).detail, /\/autocompact 200k/);
  put(path.join(cwd, '.claude', 'settings.json'), { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1m' } });
  a = run();
  assert.equal(a.compact.window, 1000000);
  assert.equal(win(a).fixable, false);
});

test('compact-window: modelSettings values are read defensively', () => {
  const { claudeDir, run } = setup();
  const file = path.join(claudeDir, 'settings.json');
  put(file, { modelSettings: { 'claude-opus-5-5': { autoCompactWindow: 600000 }, junk: 5, other: { x: 1 } } });
  let a = run();
  assert.equal(win(a).level, 'bad');
  assert.equal(win(a).fixable, false);
  assert.equal(a.compact.window, 600000);
  assert.match(a.compact.source, /modelSettings\.claude-opus-5-5/);
  put(file, { modelSettings: { opus: { autoCompactWindow: 150000 } } });
  assert.equal(win(run()).level, 'ok');
  put(file, { autoCompactWindow: 200000, modelSettings: { opus: { autoCompactWindow: 700000 } } });
  a = run();
  assert.equal(win(a).level, 'bad');
  assert.equal(win(a).fixable, false);
});

test('compact-window: CLAUDE_CODE_DISABLE_1M_CONTEXT makes unset ok', () => {
  const { run } = setup();
  assert.equal(win(run({ env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' } })).level, 'ok');
  assert.equal(win(run({ env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: '0' } })).level, 'bad');
});

test('auto-compact-off and idle-compaction-off are bad, report-only, and absent by default', () => {
  const { claudeDir, run } = setup();
  assert.equal(find(run(), 'auto-compact-off'), undefined);
  assert.equal(find(run(), 'idle-compaction-off'), undefined);
  put(path.join(claudeDir, 'settings.json'), { autoCompactEnabled: false, idleCompaction: false });
  const a = run();
  for (const id of ['auto-compact-off', 'idle-compaction-off']) {
    assert.equal(find(a, id).level, 'bad');
    assert.equal(find(a, id).fixable, false);
  }
  put(path.join(claudeDir, 'settings.json'), { autoCompactEnabled: true, idleCompaction: true });
  assert.equal(find(run(), 'auto-compact-off'), undefined);
  assert.equal(find(run({ env: { DISABLE_AUTO_COMPACT: '1' } }), 'auto-compact-off').level, 'bad');
});
