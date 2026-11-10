import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const GUARD = fileURLToPath(new URL('../hooks/guard.mjs', import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fabletax-guard-'));

// A dispatcher on `model`, with a synthetic line after it that must be ignored.
const assistant = (model, extra = {}) => JSON.stringify({ type: 'assistant', message: { id: 'm', model, usage: {} }, ...extra });

function setup({ model = 'claude-opus-5-5', agentModel = 'claude-haiku-5-5', agentId = null } = {}) {
  const claudeDir = tmp();
  const cwd = tmp();
  const transcript = path.join(claudeDir, 'projects', 'proj', 'sess.jsonl');
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, [
    assistant('claude-sonnet-4-5'),
    JSON.stringify({ type: 'user', message: { content: 'secret prompt' } }),
    assistant(model),
    assistant('<synthetic>'),
  ].join('\n') + '\n');
  if (agentId) {
    const sub = path.join(claudeDir, 'projects', 'proj', 'sess', 'subagents', `agent-${agentId}.jsonl`);
    fs.mkdirSync(path.dirname(sub), { recursive: true });
    fs.writeFileSync(sub, assistant(agentModel) + '\n');
  }
  const run = (tool_input, { env = {}, extra = {}, tool_name = 'Agent', stdin } = {}) => {
    const r = spawnSync(process.execPath, [GUARD], {
      input: stdin ?? JSON.stringify({ session_id: 's1', transcript_path: transcript, cwd, tool_name, tool_input, ...extra }),
      env: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: claudeDir, ...env },
      encoding: 'utf8',
    });
    return { status: r.status, out: r.stdout, err: r.stderr, json: r.stdout ? JSON.parse(r.stdout) : null };
  };
  const agentFile = (dir, name, fm) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.md`), `---\nname: ${name}\ndescription: d\n${fm}---\nbody\n`);
  };
  return { claudeDir, cwd, transcript, run, agentFile };
}

const silent = (r) => {
  assert.equal(r.status, 0);
  assert.equal(r.out, '');
};

test('injects model for an unpinned general-purpose call and preserves every other field', () => {
  const { run } = setup();
  const input = { subagent_type: 'general-purpose', description: 'd', prompt: 'p'.repeat(50), run_in_background: true, extra: { a: [1, 2] } };
  const r = run(input);
  assert.equal(r.status, 0);
  assert.deepEqual(r.json, {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'fabletax: no model given, pinned to sonnet',
      updatedInput: { ...input, model: 'sonnet' },
      additionalContext: 'fabletax pinned this subagent to sonnet. Pass model explicitly to choose another.',
    },
  });
});

test('works for Task, for a missing subagent_type, for "claude", and for a fable dispatcher', () => {
  const { run } = setup({ model: 'claude-fable-5-2' });
  assert.ok(run({ prompt: 'x' }, { tool_name: 'Task' }).json);
  assert.ok(run({ prompt: 'x' }).json);
  assert.ok(run({ subagent_type: 'claude', prompt: 'x' }).json);
  assert.ok(run({ subagent_type: 'general-purpose', model: '', prompt: 'x' }).json);
});

test('silent when model is already given', () => {
  const { run } = setup();
  silent(run({ subagent_type: 'general-purpose', model: 'opus', prompt: 'x' }));
});

test('silent for fork, plugin agents, built-ins, other tools', () => {
  const { run } = setup();
  silent(run({ subagent_type: 'fork', prompt: 'x' }));
  silent(run({ subagent_type: 'a:b', prompt: 'x' }));
  silent(run({ subagent_type: 'Explore', prompt: 'x' }));
  silent(run({ subagent_type: 'general-purpose', prompt: 'x' }, { tool_name: 'Bash' }));
});

test('silent when the dispatcher is sonnet or haiku', () => {
  silent(setup({ model: 'claude-sonnet-5-5' }).run({ prompt: 'x' }));
  silent(setup({ model: 'claude-haiku-5-5' }).run({ prompt: 'x' }));
});

test('silent when the transcript is missing or has no model', () => {
  const s = setup();
  silent(s.run({ prompt: 'x' }, { extra: { transcript_path: path.join(s.claudeDir, 'nope.jsonl') } }));
  const empty = path.join(s.claudeDir, 'empty.jsonl');
  fs.writeFileSync(empty, '');
  silent(s.run({ prompt: 'x' }, { extra: { transcript_path: empty } }));
});

test('silent with FABLETAX_GUARD=off or CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1', () => {
  const { run } = setup();
  silent(run({ prompt: 'x' }, { env: { FABLETAX_GUARD: 'off' } }));
  silent(run({ prompt: 'x' }, { env: { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' } }));
  assert.ok(run({ prompt: 'x' }, { env: { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '0' } }).json);
});

test('custom agents: pinned -> silent, unpinned/inherit -> injects, project beats user', () => {
  const s = setup();
  s.agentFile(path.join(s.claudeDir, 'agents'), 'pinned', 'model: haiku\n');
  s.agentFile(path.join(s.claudeDir, 'agents'), 'bare', '');
  s.agentFile(path.join(s.claudeDir, 'agents'), 'inh', 'model: inherit\n');
  s.agentFile(path.join(s.claudeDir, 'agents'), 'both', '');
  s.agentFile(path.join(s.cwd, '.claude', 'agents'), 'both', 'model: sonnet\n');
  silent(s.run({ subagent_type: 'pinned', prompt: 'x' }));
  assert.equal(s.run({ subagent_type: 'bare', prompt: 'x' }).json.hookSpecificOutput.updatedInput.subagent_type, 'bare');
  assert.ok(s.run({ subagent_type: 'inh', prompt: 'x' }).json);
  silent(s.run({ subagent_type: 'both', prompt: 'x' }));
  silent(s.run({ subagent_type: 'unknown-agent', prompt: 'x' }));
});

test('nested call with agent_id reads the subagent transcript', () => {
  const opusParent = setup({ model: 'claude-opus-5-5', agentModel: 'claude-sonnet-5-5', agentId: 'abc123' });
  silent(opusParent.run({ prompt: 'x' }, { extra: { agent_id: 'abc123' } })); // subagent is on sonnet
  const sonnetParent = setup({ model: 'claude-sonnet-5-5', agentModel: 'claude-opus-5-5', agentId: 'abc123' });
  const r = sonnetParent.run({ prompt: 'x' }, { extra: { agent_id: 'abc123' } });
  assert.equal(r.json.hookSpecificOutput.updatedInput.model, 'sonnet');
  silent(sonnetParent.run({ prompt: 'x' }, { extra: { agent_id: '../evil' } }));
  silent(sonnetParent.run({ prompt: 'x' }, { extra: { agent_id: 'missing' } }));
});

test('FABLETAX_MODEL=haiku pins to haiku', () => {
  const r = setup({ model: 'claude-sonnet-5-5' }).run({ prompt: 'x' }, { env: { FABLETAX_MODEL: 'haiku' } });
  assert.equal(r.json.hookSpecificOutput.updatedInput.model, 'haiku');
  assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /pinned to haiku$/);
  silent(setup({ model: 'claude-haiku-5-5' }).run({ prompt: 'x' }, { env: { FABLETAX_MODEL: 'haiku' } }));
  silent(setup().run({ prompt: 'x' }, { env: { FABLETAX_MODEL: 'nonsense' } }));
});

test('garbage stdin -> exit 0 and empty stdout', () => {
  const { run } = setup();
  for (const stdin of ['', 'not json', '{"tool_name":', 'null', '[]', '{"tool_name":"Agent"}', '{"tool_name":"Agent","tool_input":"x"}']) {
    silent(run({}, { stdin }));
  }
});

test('log line has no prompt text', () => {
  const { run, claudeDir } = setup();
  run({ subagent_type: 'general-purpose', description: 'SECRET-DESC', prompt: 'SECRET-PROMPT' });
  const log = fs.readFileSync(path.join(claudeDir, 'fabletax', 'guard.log'), 'utf8');
  const lines = log.trim().split('\n');
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(rec).sort(), ['from', 'session_id', 'subagent_type', 'to', 'ts']);
  assert.equal(rec.from, 'claude-opus-5-5');
  assert.equal(rec.to, 'sonnet');
  assert.equal(rec.session_id, 's1');
  assert.equal(rec.subagent_type, 'general-purpose');
  assert.ok(!log.includes('SECRET'));
});

test('does not log or write when silent', () => {
  const { run, claudeDir } = setup();
  run({ model: 'opus', prompt: 'x' });
  assert.equal(fs.existsSync(path.join(claudeDir, 'fabletax')), false);
});

test('an unwritable log dir does not break the output', () => {
  const s = setup();
  fs.writeFileSync(path.join(s.claudeDir, 'fabletax'), 'a file where the dir should be');
  const r = s.run({ prompt: 'x' });
  assert.equal(r.status, 0);
  assert.ok(r.json);
});

test('reads only the tail of a huge transcript', () => {
  const s = setup();
  const big = 'x'.repeat(1024 * 1024);
  fs.writeFileSync(s.transcript, assistant('claude-haiku-5-5') + '\n' + JSON.stringify({ type: 'user', blob: big }) + '\n' + assistant('claude-opus-5-5') + '\n');
  assert.ok(s.run({ prompt: 'x' }).json);
});

const apiReq = (model) => JSON.stringify({ type: 'api-request', params: { model, max_tokens: 1 } });
const writeTranscript = (s, lines) => fs.writeFileSync(s.transcript, lines.join('\n') + (lines.length ? '\n' : ''));
const modelOf = (r) => r.json?.hookSpecificOutput.updatedInput.model;

test('api-request line is enough when it is the only model-bearing line', () => {
  const s = setup();
  writeTranscript(s, [JSON.stringify({ type: 'user', message: { content: 'hi' } }), apiReq('claude-opus-5-5')]);
  assert.equal(modelOf(s.run({ prompt: 'x' })), 'sonnet');
  writeTranscript(s, [apiReq('claude-sonnet-5-5')]);
  silent(s.run({ prompt: 'x' }));
});

test('the latest of assistant and api-request lines wins', () => {
  const s = setup();
  writeTranscript(s, [assistant('claude-sonnet-5-5'), apiReq('claude-opus-5-5')]);
  assert.equal(modelOf(s.run({ prompt: 'x' })), 'sonnet');
  writeTranscript(s, [assistant('claude-opus-5-5'), apiReq('claude-sonnet-5-5')]);
  silent(s.run({ prompt: 'x' }));
});

test('empty transcript falls back to the settings.json model', () => {
  const s = setup();
  writeTranscript(s, []);
  const settings = path.join(s.claudeDir, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ model: 'opus' }));
  assert.equal(modelOf(s.run({ prompt: 'x' })), 'sonnet');
  fs.writeFileSync(settings, JSON.stringify({ model: 'sonnet' }));
  silent(s.run({ prompt: 'x' }));
  fs.writeFileSync(settings, JSON.stringify({ theme: 'dark' }));
  silent(s.run({ prompt: 'x' }));
  fs.rmSync(settings);
  silent(s.run({ prompt: 'x' }));
});

test('settings fallback prefers project local/shared files over user settings', () => {
  const s = setup();
  writeTranscript(s, []);
  fs.writeFileSync(path.join(s.claudeDir, 'settings.json'), JSON.stringify({ model: 'opus' }));
  fs.mkdirSync(path.join(s.cwd, '.claude'));
  fs.writeFileSync(path.join(s.cwd, '.claude', 'settings.json'), JSON.stringify({ model: 'haiku' }));
  silent(s.run({ prompt: 'x' }));
  fs.writeFileSync(path.join(s.cwd, '.claude', 'settings.local.json'), JSON.stringify({ model: 'fable' }));
  assert.equal(modelOf(s.run({ prompt: 'x' })), 'sonnet');
});

test('settings fallback is not used when agent_id is present', () => {
  const s = setup({ agentId: 'abc' });
  fs.writeFileSync(path.join(s.claudeDir, 'projects', 'proj', 'sess', 'subagents', 'agent-abc.jsonl'), '');
  fs.writeFileSync(path.join(s.claudeDir, 'settings.json'), JSON.stringify({ model: 'opus' }));
  silent(s.run({ prompt: 'x' }, { extra: { agent_id: 'abc' } }));
});
