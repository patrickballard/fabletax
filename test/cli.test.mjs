import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.mjs';
import { PRICES_AS_OF } from '../src/prices.mjs';

const root = mkdtempSync(join(tmpdir(), 'fabletax-cli-'));
process.on('exit', () => rmSync(root, { recursive: true, force: true }));

const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();

// A Claude dir with one session: the main thread dispatches one Agent call
// with no model, and the subagent runs on opus (1M in + 1M out = $24 there,
// $12 on sonnet, so the inheritance tax is $12). The main turn is 100k tokens
// ($0.40), under the default context cap.
function makeClaudeDir(name, { pinned = false } = {}) {
  const claudeDir = join(root, name, 'claude');
  const cwd = join(root, name, 'work');
  mkdirSync(cwd, { recursive: true });
  const dir = join(claudeDir, 'projects', '-work-secret-project');
  const sub = join(dir, 'sess1', 'subagents');
  mkdirSync(sub, { recursive: true });
  const base = { sessionId: 'sess1', cwd: '/work/secret-project', version: '2.1.308' };
  writeFileSync(join(dir, 'sess1.jsonl'), jsonl([
    {
      ...base, type: 'assistant', timestamp: iso(2), requestId: 'r1',
      message: {
        id: 'm1', model: 'claude-opus-5-5', role: 'assistant',
        content: [{ type: 'tool_use', name: 'Agent', id: 'toolu_1', input: { subagent_type: 'general-purpose', description: 'refactor the billing module', ...(pinned ? { model: 'sonnet' } : {}) } }],
        usage: { input_tokens: 100_000, output_tokens: 0 },
      },
    },
  ]));
  writeFileSync(join(sub, 'agent-a1.jsonl'), jsonl([
    {
      ...base, type: 'assistant', timestamp: iso(2), requestId: 'r2', isSidechain: true, agentId: 'a1',
      message: { id: 'm2', model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'SECRET RESPONSE TEXT' }], usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } },
    },
  ]));
  writeFileSync(join(sub, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'refactor the billing module', toolUseId: 'toolu_1', spawnDepth: 1 }));
  return { claudeDir, cwd };
}

async function run(argv, { cwd = root, env = {}, stdin } = {}) {
  let out = '';
  let err = '';
  const stdout = { write: (s) => { out += s; return true; }, isTTY: false };
  const stderr = { write: (s) => { err += s; return true; } };
  const code = await main(argv, { stdout, stderr, stdin: stdin || { isTTY: false }, env, cwd });
  return { code, out, err };
}

test('--help and --version', async () => {
  const help = await run(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.out, /Usage/);
  assert.match(help.out, /--claude-dir/);
  const v = await run(['-v']);
  assert.equal(v.code, 0);
  assert.equal(v.out.trim(), JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
});

test('unknown flags, commands and bad values are usage errors (exit 2)', async () => {
  for (const argv of [['--bogus'], ['audit', '--nope'], ['bogus'], ['--days', 'abc'], ['--days', '0'], ['--days'], ['--as', 'gpt-4'], ['fix', '--model', 'opus'], ['prices', '--days', '3'], ['fix', '--json'], ['audit', 'extra']]) {
    const r = await run(argv);
    assert.equal(r.code, 2, argv.join(' '));
    assert.equal(r.out, '');
    assert.match(r.err, /^fabletax: /);
  }
});

test('prices prints the dated table', async () => {
  const r = await run(['prices']);
  assert.equal(r.code, 0);
  assert.ok(r.out.includes(PRICES_AS_OF));
  assert.match(r.out, /claude-sonnet-5-5\s+2\s+10/);
  assert.match(r.out, /platform\.claude\.com/);
  assert.ok(r.out.split('\n').every((l) => [...l].length <= 76));
});

test('audit prints the inheritance tax from a temp Claude dir', async () => {
  const { claudeDir, cwd } = makeClaudeDir('audit');
  const r = await run(['--claude-dir', claudeDir], { cwd });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /TAX\s+\$12\.00\s+49% of everything you spent/);
  assert.match(r.out, /Inheritance tax\s+\$12\.00\s+1 subagent ran on Opus 5\.5/);
  assert.match(r.out, /Cost: \$24\.00\. Same tokens on Sonnet 5\.5: \$12\.00\./);
  assert.match(r.out, /✓ No bloat tax/);
  assert.match(r.out, /✓ No idle tax/);
  assert.match(r.out, /You spent\s+\$24\.40/);
  assert.match(r.out, /Config/);
  assert.doesNotMatch(r.out, /\x1b/);
  assert.doesNotMatch(r.out, /SECRET RESPONSE TEXT|billing/);
  assert.ok(r.out.split('\n').every((l) => [...l].length <= 76));
  const explicit = await run(['audit', '--days=30', '--as', 'sonnet', `--claude-dir=${claudeDir}`], { cwd });
  assert.equal(explicit.out, r.out);
});

test('audit: a pinned dispatch is not taxed', async () => {
  const { claudeDir, cwd } = makeClaudeDir('pinned', { pinned: true });
  const r = await run(['--claude-dir', claudeDir], { cwd });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /No tax found/);
});

test('--share has no project name or description; --verbose shows the description', async () => {
  const { claudeDir, cwd } = makeClaudeDir('share');
  const shared = await run(['--share', '--verbose', '--claude-dir', claudeDir], { cwd });
  assert.equal(shared.code, 0, shared.err);
  assert.match(shared.out, /TAX\s+\$12\.00/);
  assert.doesNotMatch(shared.out, /secret-project|billing/);
  const verbose = await run(['--verbose', '--claude-dir', claudeDir], { cwd });
  assert.match(verbose.out, /secret-project/);
  assert.match(verbose.out, /refactor the billing module/);
});

test('--json prints { report, config } and nothing else', async () => {
  const { claudeDir, cwd } = makeClaudeDir('json');
  const r = await run(['--json', '--claude-dir', claudeDir], { cwd });
  assert.equal(r.code, 0, r.err);
  const parsed = JSON.parse(r.out);
  assert.deepEqual(Object.keys(parsed).sort(), ['config', 'report']);
  assert.ok(Math.abs(parsed.report.tax.usd - 12) < 1e-9);
  assert.equal(parsed.report.dispatch.inherited, 1);
  assert.equal(parsed.report.bloat.capTokens, 200000);
  assert.ok(Math.abs(parsed.report.taxTotal.usd - 12) < 1e-9);
  assert.ok(Array.isArray(parsed.config.findings));
  assert.doesNotMatch(r.out, /SECRET RESPONSE TEXT/);

  const shared = await run(['--json', '--share', '--claude-dir', claudeDir], { cwd });
  assert.doesNotMatch(shared.out, /secret-project|billing/);
  assert.ok(JSON.parse(shared.out).report.tax);
});

test('--cap sets the bloat threshold (200000, 200k and 0.05m all mean the same)', async () => {
  const { claudeDir, cwd } = makeClaudeDir('cap');
  // The 100k-token main turn is 50k over a 50k cap: 50,000 * $0.20/M = $0.01.
  for (const cap of ['50000', '50k', '0.05m']) {
    const r = await run(['--json', '--cap', cap, '--claude-dir', claudeDir], { cwd });
    assert.equal(r.code, 0, r.err);
    const { report } = JSON.parse(r.out);
    assert.equal(report.bloat.capTokens, 50000);
    assert.equal(report.bloat.calls, 1);
    assert.ok(Math.abs(report.bloat.usd - 0.01) < 1e-9);
  }
  const text = await run(['--cap=50k', '--claude-dir', claudeDir], { cwd });
  assert.match(text.out, /Bloat tax\s+\$0\.01\s+1 turn carried over 50k tokens/);
  assert.match(text.out, /Worst sessions/);
  assert.match(text.out, /secret-project/);
  assert.match(text.out, /Bloat assumes the work fit in 50k tokens/);
  const shared = await run(['--cap', '50k', '--share', '--claude-dir', claudeDir], { cwd });
  assert.doesNotMatch(shared.out, /secret-project/);
  assert.match(shared.out, /session 1/);
  const sharedJson = await run(['--cap', '50k', '--share', '--json', '--claude-dir', claudeDir], { cwd });
  assert.doesNotMatch(sharedJson.out, /secret-project/);
  assert.equal(JSON.parse(sharedJson.out).report.topSessions[0].project, 'session 1');
  const help = await run(['--help']);
  assert.match(help.out, /--cap <tokens>/);
});

test('--cap rejects nonsense (exit 2)', async () => {
  for (const cap of ['abc', '0', '12', '-5', '']) {
    const r = await run(['--cap', cap]);
    assert.equal(r.code, 2, cap);
    assert.match(r.err, /--cap/);
  }
  assert.equal((await run(['fix', '--cap', 'abc'])).code, 2);
  assert.equal((await run(['fix', '--days', '3'])).code, 2);
});

test('--project filters, and an empty window says where it looked', async () => {
  const { claudeDir, cwd } = makeClaudeDir('filter');
  const none = await run(['--project', 'does-not-exist', '--claude-dir', claudeDir], { cwd });
  assert.equal(none.code, 0, none.err);
  assert.match(none.out, /No Claude Code usage found/);
  const hit = await run(['--project', 'SECRET', '--claude-dir', claudeDir], { cwd });
  assert.match(hit.out, /Inheritance tax/);
  const empty = await run(['--claude-dir', join(root, 'nothing-here')], { cwd });
  assert.equal(empty.code, 0, empty.err);
  assert.match(empty.out, /No Claude Code usage found/);
  assert.match(empty.out, /Looked in .*nothing-here/);
});

test('color only on a TTY, and NO_COLOR / --no-color turn it off', async () => {
  const { claudeDir, cwd } = makeClaudeDir('color');
  const go = async (argv, env = {}) => {
    let out = '';
    const stdout = { write: (s) => { out += s; return true; }, isTTY: true };
    await main([...argv, '--claude-dir', claudeDir], { stdout, stderr: { write() {} }, stdin: { isTTY: false }, env, cwd });
    return out;
  };
  assert.match(await go([]), /\x1b\[/);
  assert.doesNotMatch(await go(['--no-color']), /\x1b/);
  assert.doesNotMatch(await go([], { NO_COLOR: '1' }), /\x1b/);
});

test('fix without --yes on a non-TTY changes nothing; --yes pins agents; --undo restores', async () => {
  const { claudeDir, cwd } = makeClaudeDir('fix');
  const agentFile = join(claudeDir, 'agents', 'reviewer.md');
  mkdirSync(join(claudeDir, 'agents'), { recursive: true });
  const original = '---\nname: reviewer\ndescription: reviews\n---\nReview things.\n';
  writeFileSync(agentFile, original);

  const dry = await run(['fix', '--no-hook', '--claude-dir', claudeDir], { cwd });
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /reviewer/);
  assert.match(dry.out, /--yes/);
  assert.equal(readFileSync(agentFile, 'utf8'), original);

  const applied = await run(['fix', '--yes', '--no-hook', '--claude-dir', claudeDir], { cwd });
  assert.equal(applied.code, 0, applied.err);
  assert.match(readFileSync(agentFile, 'utf8'), /^model: sonnet$/m);
  assert.ok(existsSync(join(claudeDir, 'fabletax', 'backups')));
  assert.equal(existsSync(join(claudeDir, 'fabletax', 'guard.mjs')), false);

  const undone = await run(['fix', '--undo', '--claude-dir', claudeDir], { cwd });
  assert.equal(undone.code, 0, undone.err);
  assert.equal(readFileSync(agentFile, 'utf8'), original);
});

const settingsOf = (claudeDir) => {
  try { return JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8')); } catch { return null; }
};

test('fix plans and applies the compact window, honoring --cap and --no-compact', async () => {
  const { claudeDir, cwd } = makeClaudeDir('compact');
  const settingsPath = join(claudeDir, 'settings.json');
  const base = ['fix', '--no-hook', '--no-agents', '--claude-dir', claudeDir];

  const def = await run(base, { cwd });
  assert.equal(def.code, 0, def.err);
  assert.ok(def.out.includes(`Set autoCompactWindow to 200k in ${settingsPath} (Claude Code will compact the conversation at 200k tokens instead of ~967k)`), def.out);
  assert.equal(settingsOf(claudeDir), null, 'a dry run writes nothing');

  const none = await run([...base, '--no-compact'], { cwd });
  assert.equal(none.code, 0, none.err);
  assert.match(none.out, /Nothing to fix/);
  assert.doesNotMatch(none.out, /autoCompactWindow/);

  const custom = await run([...base, '--cap', '300k'], { cwd });
  assert.ok(custom.out.includes('Set autoCompactWindow to 300k'), custom.out);
  assert.ok(custom.out.includes('at 300k tokens instead of ~967k'));

  const applied = await run([...base, '--cap=300000', '--yes'], { cwd });
  assert.equal(applied.code, 0, applied.err);
  assert.equal(settingsOf(claudeDir).autoCompactWindow, 300000);
  assert.match(applied.out, /Backup:/);

  // Already at the window: nothing left to plan. At the default 200k cap it is above, so it plans a lower one.
  const again = await run([...base, '--cap', '300k'], { cwd });
  assert.match(again.out, /Nothing to fix/);
  assert.match((await run(base, { cwd })).out, /Set autoCompactWindow to 200k/);

  const undone = await run(['fix', '--undo', '--claude-dir', claudeDir], { cwd });
  assert.equal(undone.code, 0, undone.err);
  assert.equal(settingsOf(claudeDir)?.autoCompactWindow, undefined);
});

test('fix with the hook but --no-compact plans no compact-window step', async () => {
  const { claudeDir, cwd } = makeClaudeDir('compact-hook');
  const r = await run(['fix', '--no-agents', '--no-compact', '--claude-dir', claudeDir], { cwd });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /PreToolUse hook/);
  assert.doesNotMatch(r.out, /autoCompactWindow/);
  const withBoth = await run(['fix', '--no-agents', '--claude-dir', claudeDir], { cwd });
  assert.match(withBoth.out, /PreToolUse hook/);
  assert.match(withBoth.out, /autoCompactWindow/);
});

test('audit passes --cap to the config audit', async () => {
  const { claudeDir, cwd } = makeClaudeDir('audit-cap');
  const r = await run(['--json', '--cap', '300k', '--claude-dir', claudeDir], { cwd });
  const finding = JSON.parse(r.out).config.findings.find((f) => f.id === 'compact-window');
  assert.equal(finding.level, 'bad');
  assert.equal(finding.fixable, true);
  assert.match(finding.detail, /300k/);
  const text = await run(['--claude-dir', claudeDir], { cwd });
  assert.match(text.out, /✗ Auto-compact window not set/);
});

test('fix --undo with nothing to undo is fine', async () => {
  const { claudeDir, cwd } = makeClaudeDir('undo-empty');
  const r = await run(['fix', '--undo', '--claude-dir', claudeDir], { cwd });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /No fabletax backup/);
});
