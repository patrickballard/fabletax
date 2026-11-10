import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { auditConfig } from '../src/config.mjs';
import { planFix, applyFix, undoFix } from '../src/fix.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fabletax-fix-'));
const put = (file, content, mode) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (mode) fs.chmodSync(file, mode);
};
const get = (file) => fs.readFileSync(file, 'utf8');
const modeOf = (file) => fs.statSync(file).mode & 0o777;

function setup() {
  const claudeDir = tmp();
  const cwd = tmp();
  const audit = () => auditConfig({ claudeDir, cwd, env: {} });
  const plan = (o = {}) => planFix(audit(), { claudeDir, cwd, ...o });
  return { claudeDir, cwd, audit, plan, settings: path.join(claudeDir, 'settings.json') };
}

const REVIEWER = '---\nname: reviewer\ndescription: Reviews code\ntools: Read, Grep\n---\nYou review.\n';
const PLANNER = '---\r\nname: planner\r\ndescription: Plans\r\nmodel: inherit\r\n---\r\nPlan.\r\n';
const SETTINGS = JSON.stringify({
  model: 'opus',
  env: { FOO: '1' },
  permissions: { allow: ['Bash(ls:*)'] },
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }],
  },
}, null, 4) + '\n';

test('plan: one step per unpinned agent plus guard and hook; respects flags', () => {
  const { claudeDir, plan } = setup();
  put(path.join(claudeDir, 'agents', 'reviewer.md'), REVIEWER);
  put(path.join(claudeDir, 'agents', 'ok.md'), '---\nname: ok\nmodel: haiku\n---\n');
  const steps = plan();
  assert.deepEqual(steps.map((s) => s.kind), ['agent-model', 'install-guard', 'settings-hook', 'compact-window']);
  assert.deepEqual(plan({ compact: false }).map((s) => s.kind), ['agent-model', 'install-guard', 'settings-hook']);
  assert.ok(steps.every((s) => s.id && s.path && s.summary));
  assert.deepEqual(plan({ hook: false, compact: false }).map((s) => s.kind), ['agent-model']);
  assert.deepEqual(plan({ agents: false }).map((s) => s.kind), ['install-guard', 'settings-hook', 'compact-window']);
  assert.throws(() => plan({ target: 'so nnet; rm' }));
});

test('apply then undo restores byte-identical files; second run plans nothing', () => {
  const { claudeDir, cwd, audit, plan, settings } = setup();
  const reviewer = path.join(claudeDir, 'agents', 'reviewer.md');
  const planner = path.join(cwd, '.claude', 'agents', 'planner.md');
  put(reviewer, REVIEWER, 0o600);
  put(planner, PLANNER, 0o640);
  put(settings, SETTINGS, 0o600);
  const before = [reviewer, planner, settings].map(get);

  const res = applyFix(plan(), { claudeDir });
  assert.equal(res.changed.length, 5);
  assert.equal(JSON.parse(get(settings)).autoCompactWindow, 200000);
  assert.deepEqual(res.skipped, []);
  assert.match(get(reviewer), /^---\nname: reviewer\ndescription: Reviews code\ntools: Read, Grep\nmodel: sonnet\n---\nYou review\.\n$/);
  assert.equal(get(planner), PLANNER.replace('model: inherit', 'model: sonnet'));
  assert.equal(modeOf(reviewer), 0o600);
  assert.equal(modeOf(planner), 0o640);
  assert.equal(modeOf(settings), 0o600);
  assert.ok(fs.existsSync(path.join(claudeDir, 'fabletax', 'guard.mjs')));
  assert.equal(get(path.join(claudeDir, 'fabletax', 'guard.mjs')), get(new URL('../hooks/guard.mjs', import.meta.url)));

  const a = audit();
  assert.equal(a.guardInstalled, true);
  assert.deepEqual(planFix(a, { claudeDir, cwd }), []);

  const manifest = JSON.parse(get(path.join(res.backupDir, 'manifest.json')));
  assert.equal(manifest.entries.length, 4);

  const un = undoFix({ claudeDir });
  assert.deepEqual(un.skipped, []);
  assert.deepEqual([reviewer, planner, settings].map(get), before);
  assert.equal(modeOf(reviewer), 0o600);
  assert.equal(modeOf(planner), 0o640);
  assert.equal(modeOf(settings), 0o600);
  assert.equal(fs.existsSync(path.join(claudeDir, 'fabletax', 'guard.mjs')), false);
  assert.equal(audit().guardInstalled, false);
  assert.deepEqual(undoFix({ claudeDir }).restored, []); // nothing left to undo
});

test('undo removes a settings.json that did not exist before', () => {
  const { claudeDir, plan, settings } = setup();
  applyFix(plan(), { claudeDir });
  assert.ok(fs.existsSync(settings));
  undoFix({ claudeDir });
  assert.equal(fs.existsSync(settings), false);
});

test('merges into existing hooks and keys, keeps indent, is idempotent', () => {
  const { claudeDir, plan, settings } = setup();
  put(settings, SETTINGS);
  applyFix(plan(), { claudeDir });
  const text = get(settings);
  const json = JSON.parse(text);
  assert.equal(json.model, 'opus');
  assert.deepEqual(json.env, { FOO: '1' });
  assert.deepEqual(json.permissions, { allow: ['Bash(ls:*)'] });
  assert.equal(json.hooks.Stop.length, 1);
  assert.equal(json.hooks.PreToolUse.length, 2);
  assert.equal(json.hooks.PreToolUse[0].matcher, 'Bash');
  assert.deepEqual(json.hooks.PreToolUse[1], {
    matcher: 'Agent|Task',
    hooks: [{ type: 'command', command: 'node', args: [path.join(claudeDir, 'fabletax', 'guard.mjs')], timeout: 10 }],
  });
  assert.match(text, /^ {4}"model"/m);
  assert.ok(text.endsWith('\n'));

  // Re-applying a stale plan changes nothing more.
  const again = applyFix([{ kind: 'settings-hook', path: settings, id: 'settings-hook', summary: 's' }], { claudeDir });
  assert.equal(again.changed.length, 0);
  assert.equal(get(settings), text);
});

test('undo after the user edited settings.json only removes our hook', () => {
  const { claudeDir, plan, settings } = setup();
  put(settings, SETTINGS);
  applyFix(plan(), { claudeDir });
  const json = JSON.parse(get(settings));
  json.theme = 'dark';
  fs.writeFileSync(settings, JSON.stringify(json, null, 4));
  undoFix({ claudeDir });
  const after = JSON.parse(get(settings));
  assert.equal(after.theme, 'dark');
  assert.equal(after.hooks.PreToolUse.length, 1);
  assert.equal(after.hooks.PreToolUse[0].matcher, 'Bash');
});

test('invalid settings.json is refused, left untouched, and no guard is installed', () => {
  const { claudeDir, plan, settings } = setup();
  const bad = '{ "hooks": { oops ';
  put(settings, bad);
  put(path.join(claudeDir, 'agents', 'reviewer.md'), REVIEWER);
  const res = applyFix(plan(), { claudeDir });
  assert.equal(get(settings), bad);
  assert.equal(fs.existsSync(path.join(claudeDir, 'fabletax', 'guard.mjs')), false);
  assert.deepEqual(res.skipped.map((s) => s.kind).sort(), ['compact-window', 'install-guard', 'settings-hook']);
  assert.match(res.skipped[0].reason, /not valid JSON/);
  assert.equal(res.changed.length, 1); // the agent pin still applies
  assert.match(get(path.join(claudeDir, 'agents', 'reviewer.md')), /model: sonnet/);
});

test('settings.json with a non-array PreToolUse is refused', () => {
  const { claudeDir, plan, settings } = setup();
  const odd = JSON.stringify({ hooks: { PreToolUse: {} } });
  put(settings, odd);
  const res = applyFix(plan({ compact: false }), { claudeDir });
  assert.equal(get(settings), odd);
  assert.equal(res.changed.length, 0);
  assert.equal(res.backupDir, null);
  // the compact window can still be written; the odd hooks value is preserved
  applyFix(plan(), { claudeDir });
  assert.deepEqual(JSON.parse(get(settings)), { hooks: { PreToolUse: {} }, autoCompactWindow: 200000 });
});

test('--model haiku pins agents to haiku and the hook carries it', () => {
  const { claudeDir, plan, settings } = setup();
  put(path.join(claudeDir, 'agents', 'reviewer.md'), REVIEWER);
  applyFix(plan({ target: 'haiku' }), { claudeDir });
  assert.match(get(path.join(claudeDir, 'agents', 'reviewer.md')), /model: haiku/);
  const hook = JSON.parse(get(settings)).hooks.PreToolUse[0].hooks[0];
  assert.deepEqual(hook.args.slice(1), ['--model=haiku']);
});

test('plugin enabled -> no guard steps', () => {
  const { claudeDir, plan, settings } = setup();
  put(settings, JSON.stringify({ enabledPlugins: { 'fabletax@fabletax': true } }));
  assert.deepEqual(plan().map((s) => s.kind), ['compact-window']);
  assert.deepEqual(plan({ compact: false }), []);
});

test('symlinked agent file is edited through the link', () => {
  const { claudeDir, plan } = setup();
  const real = path.join(tmp(), 'real.md');
  put(real, REVIEWER);
  fs.mkdirSync(path.join(claudeDir, 'agents'), { recursive: true });
  const link = path.join(claudeDir, 'agents', 'reviewer.md');
  fs.symlinkSync(real, link);
  applyFix(plan({ hook: false }), { claudeDir });
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.match(get(real), /model: sonnet/);
});

test('compact-window: sets autoCompactWindow, honours cap and clamps it', () => {
  const { claudeDir, plan, settings } = setup();
  put(settings, JSON.stringify({ theme: 'dark' }, null, 2) + '\n');
  const [step] = plan({ hook: false, agents: false, cap: 150000 });
  assert.equal(step.kind, 'compact-window');
  assert.equal(step.path, settings);
  assert.equal(step.window, 150000);
  assert.ok(step.summary);
  assert.equal(plan({ hook: false, agents: false, cap: 5 })[0].window, 100000);
  assert.equal(plan({ hook: false, agents: false, cap: 9e9 })[0].window, 1000000);
  applyFix([step], { claudeDir });
  assert.deepEqual(JSON.parse(get(settings)), { theme: 'dark', autoCompactWindow: 150000 });
});

test('compact-window: creates settings.json, is idempotent, undo removes the file', () => {
  const { claudeDir, cwd, audit, plan, settings } = setup();
  const res = applyFix(plan({ hook: false }), { claudeDir });
  assert.equal(res.changed.length, 1);
  assert.deepEqual(JSON.parse(get(settings)), { autoCompactWindow: 200000 });
  assert.deepEqual(planFix(audit(), { claudeDir, cwd }).map((s) => s.kind), ['install-guard', 'settings-hook']);
  assert.deepEqual(planFix(audit(), { claudeDir, cwd, hook: false }), []);
  undoFix({ claudeDir });
  assert.equal(fs.existsSync(settings), false);
});

test('compact-window: lowers an over-cap user value and undo restores it byte-identically', () => {
  const { claudeDir, plan, settings } = setup();
  const orig = JSON.stringify({ autoCompactWindow: 900000, model: 'opus' }, null, 2) + '\n';
  put(settings, orig, 0o600);
  const steps = plan({ hook: false });
  assert.equal(steps.length, 1);
  applyFix(steps, { claudeDir });
  assert.equal(JSON.parse(get(settings)).autoCompactWindow, 200000);
  assert.equal(modeOf(settings), 0o600);
  undoFix({ claudeDir });
  assert.equal(get(settings), orig);
});

test('compact-window: not planned when the window is fine or comes from elsewhere', () => {
  const { claudeDir, cwd, plan, settings } = setup();
  put(settings, JSON.stringify({ autoCompactWindow: 150000 }));
  assert.deepEqual(plan({ hook: false }), []);
  put(settings, JSON.stringify({}));
  put(path.join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ autoCompactWindow: 900000 }));
  assert.deepEqual(plan({ hook: false }), []); // project/local value: report-only
});

test('compact-window: never raises a lower value the user set since planning', () => {
  const { claudeDir, settings } = setup();
  put(settings, JSON.stringify({ autoCompactWindow: 120000 }));
  const res = applyFix([{ id: 'compact-window', kind: 'compact-window', path: settings, window: 200000, summary: 's' }], { claudeDir });
  assert.equal(res.changed.length, 0);
  assert.equal(JSON.parse(get(settings)).autoCompactWindow, 120000);
});

test('hook + compact-window share one backup entry for settings.json', () => {
  const { claudeDir, plan, settings } = setup();
  put(settings, SETTINGS);
  const res = applyFix(plan(), { claudeDir });
  const manifest = JSON.parse(get(path.join(res.backupDir, 'manifest.json')));
  assert.equal(manifest.entries.filter((e) => e.path === settings).length, 1);
  const json = JSON.parse(get(settings));
  assert.equal(json.autoCompactWindow, 200000);
  assert.equal(json.hooks.PreToolUse.length, 2);
});

test('undo after later edits removes only the keys fabletax set', () => {
  const { claudeDir, plan, settings } = setup();
  put(settings, JSON.stringify({ autoCompactWindow: 900000, model: 'opus' }, null, 2));
  applyFix(plan(), { claudeDir });
  const json = JSON.parse(get(settings));
  json.theme = 'dark';
  fs.writeFileSync(settings, JSON.stringify(json, null, 2));
  undoFix({ claudeDir });
  const after = JSON.parse(get(settings));
  assert.deepEqual(after, { autoCompactWindow: 900000, model: 'opus', theme: 'dark' });
});

test('undo: a window the user changed after the fix is left alone; an absent one is removed', () => {
  const { claudeDir, plan, settings } = setup();
  put(settings, JSON.stringify({ model: 'opus' }));
  applyFix(plan(), { claudeDir });
  const json = JSON.parse(get(settings));
  json.autoCompactWindow = 300000;
  fs.writeFileSync(settings, JSON.stringify(json));
  undoFix({ claudeDir });
  const after = JSON.parse(get(settings));
  assert.equal(after.autoCompactWindow, 300000);
  assert.equal(after.hooks, undefined);

  const t = setup();
  put(t.settings, JSON.stringify({ model: 'opus' }));
  applyFix(t.plan(), { claudeDir: t.claudeDir });
  const j = JSON.parse(get(t.settings));
  j.theme = 'dark';
  fs.writeFileSync(t.settings, JSON.stringify(j));
  undoFix({ claudeDir: t.claudeDir });
  assert.deepEqual(JSON.parse(get(t.settings)), { model: 'opus', theme: 'dark' });
});

test('compact-window on invalid settings.json is refused', () => {
  const { claudeDir, plan, settings } = setup();
  put(settings, '{ nope');
  const res = applyFix(plan({ hook: false }), { claudeDir });
  assert.equal(get(settings), '{ nope');
  assert.deepEqual(res.skipped.map((s) => s.kind), ['compact-window']);
  assert.equal(res.backupDir, null);
});

// The hook entry is exec form (command + args, no shell), so a path with
// spaces must be written as-is: quoting it would make the quotes part of the
// file name.
test('the installed hook entry runs when the guard path contains spaces', () => {
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabletax fix '));
  const settings = path.join(claudeDir, 'settings.json');
  put(settings, '{}');
  const steps = planFix(auditConfig({ claudeDir, cwd: tmp(), env: {} }), { claudeDir, agents: false, compact: false });
  applyFix(steps, { claudeDir });
  const hook = JSON.parse(get(settings)).hooks.PreToolUse[0].hooks[0];
  assert.deepEqual(hook.args, [path.join(claudeDir, 'fabletax', 'guard.mjs')]);
  const run = spawnSync(hook.command, hook.args, { input: '{}', encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, '');
});
