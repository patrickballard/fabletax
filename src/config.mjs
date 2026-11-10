import fs from 'node:fs';
import path from 'node:path';
import { ALIASES, familyOf, rankOf } from './prices.mjs';

// Env flags: "set" means non-empty and not an explicit off-word.
export const isTruthyEnv = (v) => v != null && !/^(|0|false|no|off)$/i.test(String(v).trim());

// Minimal frontmatter reader: the first `---` block, top-level `key: value`
// lines only (indented lines belong to block scalars/lists and are ignored).
// Returns null when the text has no frontmatter block, else
// { data, start, end, eol } where start/end are offsets of the lines between
// the fences (end = offset of the closing fence line).
export function readFrontmatter(text) {
  const s = String(text).replace(/^﻿/, '');
  const bom = text.length - s.length;
  const open = /^---[ \t]*(\r?\n)/.exec(s);
  if (!open) return null;
  const eol = open[1];
  const close = /^---[ \t]*\r?$/m;
  const rest = s.slice(open[0].length);
  const m = close.exec(rest);
  if (!m) return null;
  const start = bom + open[0].length;
  const end = start + m.index;
  const data = {};
  for (const line of rest.slice(0, m.index).split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)[ \t]*:[ \t]*(.*?)[ \t]*$/.exec(line);
    if (!kv) continue;
    let v = kv[2];
    const q = /^(["'])(.*)\1/.exec(v);
    v = q ? q[2] : v.replace(/[ \t]+#.*$/, '');
    data[kv[1]] = v;
  }
  return { data, start, end, eol };
}

const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

// -> { ok, json } ; ok=false only when the file exists but is not a JSON object.
export function readJsonFile(p) {
  const t = readText(p);
  if (t == null) return { ok: true, json: null, exists: false };
  try {
    const json = JSON.parse(t);
    if (json && typeof json === 'object' && !Array.isArray(json)) return { ok: true, json, exists: true };
  } catch {}
  return { ok: false, json: null, exists: true };
}

export function isUnpinned(model) {
  return !model || model.toLowerCase() === 'inherit';
}

function listAgents(dir, scope) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const f of names.sort()) {
    if (!f.endsWith('.md')) continue;
    const file = path.join(dir, f);
    const text = readText(file);
    const fm = text == null ? null : readFrontmatter(text);
    if (!fm) continue; // not a valid agent definition
    const model = fm.data.model || null;
    out.push({
      name: fm.data.name || f.slice(0, -3),
      path: file,
      scope,
      model,
      pinned: !isUnpinned(model),
    });
  }
  return out;
}

const guardMentioned = (x) => /fabletax/i.test(JSON.stringify(x ?? ''));

function hasGuardHook(settings) {
  const groups = settings?.hooks?.PreToolUse;
  return Array.isArray(groups) && groups.some((g) => guardMentioned(g?.hooks ?? g));
}

function hasGuardPlugin(settings) {
  const ep = settings?.enabledPlugins;
  if (!ep || typeof ep !== 'object') return false;
  return Object.entries(ep).some(([k, v]) => /^fabletax@/i.test(k) && v !== false);
}

// Accepts an alias (opus), a full id, or a [1m]-suffixed id.
const familyOfName = (v) => familyOf(ALIASES[String(v).trim().toLowerCase()] || v);

// "2.1.250" < "2.1.251"
function versionLt(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0);
  return false;
}

const list = (names, max = 5) =>
  names.length > max ? `${names.slice(0, max).join(', ')} +${names.length - max} more` : names.join(', ');

// 200000, "200k", "1m" -> tokens, else null.
export function parseWindow(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  const m = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(String(v ?? '').trim());
  if (!m) return null;
  return Math.round(Number(m[1]) * ({ k: 1e3, m: 1e6 }[(m[2] || '').toLowerCase()] || 1));
}

const fmtTokens = (n) => (n >= 1e6 && n % 1e5 === 0 ? `${n / 1e6}M` : n >= 1e3 && n % 1e3 === 0 ? `${n / 1e3}k` : String(n));

export function auditConfig({ claudeDir, cwd = process.cwd(), env = process.env, latestVersion = null, cap = 200000 } = {}) {
  const files = [
    ['user', path.join(claudeDir, 'settings.json')],
    ['project', path.join(cwd, '.claude', 'settings.json')],
    ['local', path.join(cwd, '.claude', 'settings.local.json')],
  ].map(([scope, p]) => ({ scope, path: p, ...readJsonFile(p) }));
  const [user] = files;
  const prec = [...files].reverse(); // local > project > user
  const findings = [];
  const add = (id, level, title, detail, fixable = false) => findings.push({ id, level, title, detail, fixable });

  for (const f of files.filter((x) => !x.ok)) {
    add('settings-invalid', 'bad', `${f.path} is not valid JSON`,
      'fabletax will not edit it. Fix the file by hand, then re-run.');
  }

  // Custom agents without a model.
  const agents = [
    ...listAgents(path.join(cwd, '.claude', 'agents'), 'project'),
    ...listAgents(path.join(claudeDir, 'agents'), 'user'),
  ];
  const unpinned = agents.filter((a) => !a.pinned);
  if (unpinned.length) {
    add('unpinned-agents', 'bad',
      `${unpinned.length} custom agent${unpinned.length === 1 ? ' has' : 's have'} no model: ${list(unpinned.map((a) => a.name))}`,
      `They run on whatever model dispatched them. Files:\n${unpinned.map((a) => `  ${a.path}`).join('\n')}`, true);
  } else {
    add('unpinned-agents', 'ok',
      agents.length ? `All ${agents.length} custom agents pin a model` : 'No custom agents found',
      'Nothing to pin.');
  }

  // Guard hook / plugin.
  const hook = hasGuardHook(user.json);
  const plugin = files.some((f) => hasGuardPlugin(f.json));
  const guardInstalled = hook || plugin;
  if (guardInstalled) {
    add('guard', 'ok', `Guard ${plugin ? 'plugin enabled' : 'hook installed'}`,
      'Unpinned general-purpose subagent calls are pinned before they run.');
  } else {
    add('guard', 'bad', 'Guard hook not installed',
      'Nothing stops a subagent call with no model from inheriting an expensive one.', true);
  }

  // CLAUDE_CODE_SUBAGENT_MODEL, wherever it is set (process env wins).
  const envVal = (name) => {
    if (env[name] != null && env[name] !== '') return { value: String(env[name]), where: 'process env' };
    for (const f of prec) {
      const v = f.json?.env?.[name];
      if (v != null && v !== '') return { value: String(v), where: f.path };
    }
    return null;
  };
  const sub = envVal('CLAUDE_CODE_SUBAGENT_MODEL');
  if (!sub) {
    add('subagent-env', 'ok', 'CLAUDE_CODE_SUBAGENT_MODEL not set', 'Subagents follow per-call and per-agent models.');
  } else if (rankOf(`claude-${familyOfName(sub.value)}`) >= 3) {
    add('subagent-env', 'bad', `CLAUDE_CODE_SUBAGENT_MODEL=${sub.value} sends every subagent to a pricey model`,
      `Set in ${sub.where}. Remove it or set it to sonnet/haiku. fabletax never edits env.`);
  } else if (familyOfName(sub.value)) {
    add('subagent-env', 'ok', `CLAUDE_CODE_SUBAGENT_MODEL=${sub.value}`, `Set in ${sub.where}.`);
  } else {
    add('subagent-env', 'info', `CLAUDE_CODE_SUBAGENT_MODEL=${sub.value} (unrecognized model)`, `Set in ${sub.where}.`);
  }

  const force = envVal('CLAUDE_CODE_SUBAGENT_MODEL_FORCE');
  if (force && isTruthyEnv(force.value)) {
    add('subagent-force', 'bad', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE is set',
      `Set in ${force.where}. Agent frontmatter pins and the guard hook are ignored while it is on.`);
  }

  if (sub && latestVersion && versionLt(latestVersion, '2.1.251')) {
    add('old-version', 'bad', `Claude Code ${latestVersion}: CLAUDE_CODE_SUBAGENT_MODEL overrides pinned agents`,
      'On versions before 2.1.251 the env var beats both agent frontmatter and per-call models. Update Claude Code.');
  }

  const main = prec.map((f) => f.json?.model).find((m) => typeof m === 'string' && m);
  if (main && rankOf(`claude-${familyOfName(main)}`) >= 3) {
    add('main-model', 'info', `Main model is ${main}`, 'Fine for the main thread; just make sure subagents do not inherit it.');
  }

  // Context bloat: how many tokens a turn may carry before auto-compact.
  const winEnv = envVal('CLAUDE_CODE_AUTO_COMPACT_WINDOW');
  const envWin = winEnv && parseWindow(winEnv.value);
  const top = envWin ? null : prec.map((f) => ({ f, w: parseWindow(f.json?.autoCompactWindow) })).find((x) => x.w);
  const perModel = [];
  for (const f of prec) {
    const ms = f.json?.modelSettings;
    if (!ms || typeof ms !== 'object') continue;
    for (const [k, v] of Object.entries(ms)) {
      const w = parseWindow(v?.autoCompactWindow);
      if (w) perModel.push({ w, source: `${f.path} (modelSettings.${k})` });
    }
  }
  let window = null;
  let source = null;
  let fixable = false;
  if (envWin) {
    window = envWin;
    source = winEnv.where;
  } else if (top) {
    window = top.w;
    source = top.f.path;
    fixable = top.f.scope === 'user';
  } else if (perModel.length) {
    const m = perModel.reduce((a, b) => (b.w > a.w ? b : a));
    window = m.w;
    source = m.source;
  }
  const compact = { window, source };
  const overModel = !envWin && perModel.find((m) => m.w > cap);
  const is1mOff = isTruthyEnv(envVal('CLAUDE_CODE_DISABLE_1M_CONTEXT')?.value);
  const hint = 'Run `/autocompact 200k` in Claude Code, or edit that setting.';
  if (is1mOff) {
    add('compact-window', 'ok', 'CLAUDE_CODE_DISABLE_1M_CONTEXT is set', 'Turns cannot grow past the standard window.');
  } else if (window == null) {
    add('compact-window', 'bad', 'Auto-compact window not set: 1M-context models carry up to ~967k tokens per turn',
      `Every turn re-reads the whole context, so a long session gets expensive. fabletax can set autoCompactWindow to ${fmtTokens(cap)}.`, true);
  } else if (window > cap) {
    add('compact-window', 'bad', `Auto-compact window is ${fmtTokens(window)}, above ${fmtTokens(cap)}`,
      `From ${source}. ${fixable ? `fabletax can lower it to ${fmtTokens(cap)}.` : hint}`, fixable);
  } else if (overModel) {
    add('compact-window', 'bad', `Auto-compact window is ${fmtTokens(overModel.w)} for one model, above ${fmtTokens(cap)}`,
      `From ${overModel.source}. ${hint}`);
  } else {
    add('compact-window', 'ok', `Auto-compact window ${fmtTokens(window)}`, `From ${source}.`);
  }

  const settingVal = (key) => prec.map((f) => f.json?.[key]).find((v) => v !== undefined);
  const dac = envVal('DISABLE_AUTO_COMPACT');
  if (settingVal('autoCompactEnabled') === false || (dac && isTruthyEnv(dac.value))) {
    add('auto-compact-off', 'bad', 'Auto-compact is turned off',
      `Sessions grow until they hit the context limit.${dac && isTruthyEnv(dac.value) ? ` DISABLE_AUTO_COMPACT is set in ${dac.where}.` : ' autoCompactEnabled is false.'} fabletax never edits this.`);
  }
  if (settingVal('idleCompaction') === false) {
    add('idle-compaction-off', 'bad', 'Idle compaction is turned off',
      'An idle session is no longer compacted before the 1h prompt cache expires, so the next turn rewrites the whole context. fabletax never edits this.');
  }

  return { findings, agents, guardInstalled, guard: { hook, plugin }, compact };
}
