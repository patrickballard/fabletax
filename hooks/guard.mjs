#!/usr/bin/env node
// fabletax guard: PreToolUse hook for Agent/Task calls. When a subagent is
// dispatched with no `model:` from a pricier model than the target, pin it.
// Self-contained on purpose (it is copied into ~/.claude/fabletax/). It must
// never throw, never exit non-zero and never block a tool call.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TAIL = 256 * 1024;
const RANK = { haiku: 1, sonnet: 2, opus: 3, fable: 4, mythos: 4 };
const ALIAS = { fable: 'fable', opus: 'opus', sonnet: 'sonnet', haiku: 'haiku' };

const family = (m) => {
  const s = String(m || '').toLowerCase();
  return /claude-(fable|mythos|opus|sonnet|haiku)/.exec(s)?.[1] || ALIAS[s.replace(/\[.*$/, '')] || null;
};
const rank = (m) => RANK[family(m)] || 0;
const truthy = (v) => v != null && !/^(|0|false|no|off)$/i.test(String(v).trim());
const absent = (v) => v == null || v === '';

function frontmatter(text) {
  const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(text) || /^﻿?---[ \t]*\r?\n---/.exec(text);
  const data = {};
  if (!m) return null;
  for (const line of (m[1] || '').split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)[ \t]*:[ \t]*(.*?)[ \t]*$/.exec(line);
    if (!kv) continue;
    const q = /^(["'])(.*)\1/.exec(kv[2]);
    data[kv[1]] = q ? q[2] : kv[2].replace(/[ \t]+#.*$/, '');
  }
  return data;
}

// Custom agent `type` -> frontmatter data, project dir before user dir.
function findAgent(type, dirs) {
  for (const dir of dirs) {
    let names;
    try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort(); } catch { continue; }
    for (const f of names) {
      let fm;
      try { fm = frontmatter(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
      if (fm && (fm.name || f.slice(0, -3)) === type) return fm;
    }
  }
  return null;
}

// Model of the most recent request in the tail of a transcript, or null.
// The assistant line for the turn that is dispatching has not been written
// yet when PreToolUse fires, so the `api-request` line logged just before it
// counts too; on the first turn of a session it is the only one there is.
function lastModel(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const from = Math.max(0, size - TAIL);
    const buf = Buffer.alloc(size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    const lines = buf.toString('utf8').split('\n');
    if (from > 0) lines.shift(); // starts mid-line
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"model"')) continue;
      try {
        const j = JSON.parse(lines[i]);
        const model = j?.type === 'assistant' ? j.message?.model : j?.type === 'api-request' ? j.params?.model : null;
        if (typeof model === 'string' && model !== '<synthetic>') return model;
      } catch {}
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function main() {
  const env = process.env;
  if (env.FABLETAX_GUARD === 'off' || truthy(env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE)) return;
  let input;
  try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return; }
  if (!input || (input.tool_name !== 'Agent' && input.tool_name !== 'Task')) return;
  const ti = input.tool_input;
  if (!ti || typeof ti !== 'object' || Array.isArray(ti) || !absent(ti.model)) return;

  const arg = process.argv.find((a) => a.startsWith('--model='));
  const target = env.FABLETAX_MODEL || (arg && arg.slice(8)) || 'sonnet';
  if (!rank(target)) return;

  const claudeDir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const type = ti.subagent_type;
  if (!absent(type) && type !== 'general-purpose' && type !== 'claude') {
    if (typeof type !== 'string' || type === 'fork' || type.includes(':')) return;
    const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
    const fm = findAgent(type, [path.join(cwd, '.claude', 'agents'), path.join(claudeDir, 'agents')]);
    if (!fm || (fm.model && fm.model.toLowerCase() !== 'inherit')) return; // built-in/unknown, or already pinned
  }

  let file = input.transcript_path;
  if (typeof file !== 'string' || !file) return;
  if (!absent(input.agent_id)) {
    const id = String(input.agent_id);
    if (!/^[\w.-]+$/.test(id) || id.includes('..')) return;
    file = path.join(file.replace(/\.jsonl$/, ''), 'subagents', `agent-${id}.jsonl`);
  }
  let from = null;
  try { from = lastModel(file); } catch {}
  // Nothing in the transcript yet: fall back to the configured default model.
  // If that is unknown too, stay silent rather than risk pinning upwards.
  if (!from && absent(input.agent_id)) {
    const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
    for (const f of [path.join(cwd, '.claude', 'settings.local.json'), path.join(cwd, '.claude', 'settings.json'), path.join(claudeDir, 'settings.json')]) {
      try { from = JSON.parse(fs.readFileSync(f, 'utf8')).model || null; } catch {}
      if (from) break;
    }
  }
  if (!from || rank(from) <= rank(target)) return;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: `fabletax: no model given, pinned to ${target}`,
      updatedInput: { ...ti, model: target },
      additionalContext: `fabletax pinned this subagent to ${target}. Pass model explicitly to choose another.`,
    },
  }));

  try { // never the prompt
    const dir = path.join(claudeDir, 'fabletax');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'guard.log'), JSON.stringify({
      ts: Date.now(), session_id: input.session_id ?? null, subagent_type: absent(type) ? null : type, from, to: target,
    }) + '\n');
  } catch {}
}

process.stdout.on('error', () => {});
try { main(); } catch {}
process.exitCode = 0;
