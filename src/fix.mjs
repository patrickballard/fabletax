import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFrontmatter, readJsonFile } from './config.mjs';

const GUARD_SRC = fileURLToPath(new URL('../hooks/guard.mjs', import.meta.url));
const MATCHER = 'Agent|Task';

const dirs = (claudeDir) => {
  const root = path.join(claudeDir, 'fabletax');
  return { root, guard: path.join(root, 'guard.mjs'), backups: path.join(root, 'backups'), settings: path.join(claudeDir, 'settings.json') };
};

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const readBuf = (p) => { try { return fs.readFileSync(p); } catch { return null; } };
const modeOf = (p) => { try { return fs.statSync(p).mode & 0o777; } catch { return null; } };
// Write through symlinks (dotfile managers) and keep the existing mode.
const realOf = (p) => { try { return fs.realpathSync(p); } catch { return p; } };

function writeFile(p, data, defaultMode = 0o644) {
  const real = realOf(p);
  const mode = modeOf(real) ?? defaultMode;
  fs.mkdirSync(path.dirname(real), { recursive: true });
  const tmp = `${real}.fabletax-${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, real);
}

const quoteIfSpaced = (p) => (p.includes(' ') && !p.startsWith('"') ? `"${p}"` : p);

const guardCommand = (claudeDir, target) => {
  const guard = quoteIfSpaced(dirs(claudeDir).guard);
  return {
    type: 'command',
    command: 'node',
    args: target && target !== 'sonnet' ? [guard, `--model=${target}`] : [guard],
    timeout: 10,
  };
};

const isOurs = (h) => /fabletax/i.test(JSON.stringify(h ?? '')) && /guard\.mjs/.test(JSON.stringify(h));

const clamp = (n) => Math.min(1_000_000, Math.max(100_000, Math.round(n)));

export function planFix(audit, { claudeDir, cwd = process.cwd(), target = 'sonnet', hook = true, agents = true, compact = true, cap = 200000 } = {}) {
  if (!/^[\w.\-[\]]+$/.test(target)) throw new Error(`Bad model "${target}"`);
  const steps = [];
  if (agents) {
    for (const a of audit.agents || []) {
      if (a.pinned) continue;
      steps.push({ id: `agent-model:${a.path}`, kind: 'agent-model', path: a.path, target,
        summary: `Add "model: ${target}" to agent ${a.name}${a.model ? ` (was ${a.model})` : ''}` });
    }
  }
  if (hook && !audit.guardInstalled) {
    const d = dirs(claudeDir);
    steps.push({ id: 'install-guard', kind: 'install-guard', path: d.guard,
      summary: `Copy the guard hook to ${d.guard}` });
    steps.push({ id: 'settings-hook', kind: 'settings-hook', path: d.settings, target,
      summary: `Register it as a PreToolUse hook (${MATCHER}) in ${d.settings}` });
  }
  if (compact && audit.findings?.find((f) => f.id === 'compact-window')?.fixable) {
    const window = clamp(cap);
    steps.push({ id: 'compact-window', kind: 'compact-window', path: dirs(claudeDir).settings, window,
      summary: `Set autoCompactWindow to ${window} in ${dirs(claudeDir).settings}` });
  }
  return steps;
}

// Text of an agent file with `model: <target>` set; null when it needs no change.
function pinAgentText(text, target) {
  const fm = readFrontmatter(text);
  if (!fm) return null;
  const cur = fm.data.model;
  if (cur && cur.toLowerCase() !== 'inherit') return null;
  const block = text.slice(fm.start, fm.end);
  const re = /^model[ \t]*:.*?(\r?)$/m;
  const next = re.test(block)
    ? block.replace(re, `model: ${target}$1`)
    : block + `model: ${target}${fm.eol}`;
  return text.slice(0, fm.start) + next + text.slice(fm.end);
}

const indentOf = (text) => /^([ \t]+)"/m.exec(text)?.[1] ?? 2;
const dump = (obj, like) => JSON.stringify(obj, null, indentOf(like)) + (like.endsWith('\n') || !like ? '\n' : '');

// Parses settings text into a mutable object, or { error }.
function parseSettings(text) {
  if (!text.trim()) return { json: {} };
  let json;
  try { json = JSON.parse(text); } catch { return { error: 'settings.json is not valid JSON' }; }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { error: 'settings.json is not a JSON object' };
  return { json };
}

// Mutates json. Returns an error string, or true when it added the hook.
function addHook(json, claudeDir, target) {
  if (json.hooks != null && (typeof json.hooks !== 'object' || Array.isArray(json.hooks))) return 'settings.json "hooks" is not an object';
  const hooks = (json.hooks ||= {});
  if (hooks.PreToolUse != null && !Array.isArray(hooks.PreToolUse)) return 'settings.json "hooks.PreToolUse" is not an array';
  const groups = (hooks.PreToolUse ||= []);
  if (groups.some((g) => isOurs(g))) return false;
  groups.push({ matcher: MATCHER, hooks: [guardCommand(claudeDir, target)] });
  return true;
}

function removeHook(json) {
  const groups = json?.hooks?.PreToolUse;
  if (!Array.isArray(groups)) return;
  const kept = [];
  for (const g of groups) {
    if (!Array.isArray(g?.hooks)) { if (!isOurs(g)) kept.push(g); continue; }
    const hs = g.hooks.filter((h) => !isOurs(h));
    if (hs.length) kept.push({ ...g, hooks: hs });
  }
  if (kept.length) json.hooks.PreToolUse = kept;
  else {
    delete json.hooks.PreToolUse;
    if (!Object.keys(json.hooks).length) delete json.hooks;
  }
}

function newBackupDir(root) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (let i = 0; ; i++) {
    const dir = path.join(root, i ? `${stamp}-${i}` : stamp);
    try { fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(path.join(dir, 'files')); return dir; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
}

// -> { changed: [{kind,path,summary}], skipped: [{kind,path,reason}], backupDir }
export function applyFix(steps, { claudeDir } = {}) {
  const d = dirs(claudeDir);
  const changed = [];
  const skipped = [];
  const work = []; // { path, before:Buffer|null, after:string|Buffer, steps:[], meta }
  const skip = (step, reason) => skipped.push({ kind: step.kind, path: step.path, reason });

  // settings.json: the hook and the compact window share one read-modify-write.
  const hookStep = steps.find((s) => s.kind === 'settings-hook');
  const compactStep = steps.find((s) => s.kind === 'compact-window');
  let hookBlock = hookStep && !fs.existsSync(GUARD_SRC) ? `guard source not found at ${GUARD_SRC}` : null;
  let settingsMsg = null; // why settings.json cannot be edited
  if (hookStep || compactStep) {
    const before = readBuf(d.settings);
    const parsed = parseSettings(before ? before.toString('utf8') : '');
    if (parsed.error) settingsMsg = parsed.error;
    else {
      const json = parsed.json;
      const meta = {};
      const done = [];
      if (hookStep && !hookBlock) {
        const r = addHook(json, claudeDir, hookStep.target);
        if (typeof r === 'string') hookBlock = r;
        else if (r) { meta.hook = true; done.push(hookStep); }
        else skip(hookStep, 'hook already registered');
      }
      if (compactStep) {
        const cur = json.autoCompactWindow;
        if (typeof cur === 'number' && cur <= compactStep.window) skip(compactStep, `autoCompactWindow is already ${cur}`);
        else {
          meta.compact = { had: 'autoCompactWindow' in json, prev: json.autoCompactWindow, set: compactStep.window };
          json.autoCompactWindow = compactStep.window;
          done.push(compactStep);
        }
      }
      if (done.length) work.push({ path: d.settings, before, after: dump(json, before ? before.toString('utf8') : ''), steps: done, meta, kind: 'settings' });
    }
  }
  if (settingsMsg) {
    for (const s of [hookStep, compactStep]) if (s) skip(s, `${settingsMsg}; left untouched`);
    hookBlock = hookBlock || settingsMsg;
  }
  if (hookStep && hookBlock && !settingsMsg) skip(hookStep, hookBlock);

  for (const step of steps) {
    if (step.kind === 'agent-model') {
      const before = readBuf(step.path);
      const after = before && pinAgentText(before.toString('utf8'), step.target);
      if (after == null) skip(step, before ? 'already pins a model' : 'file not found');
      else work.push({ path: step.path, before, after, steps: [step], kind: step.kind });
    } else if (step.kind === 'install-guard') {
      if (hookBlock) skip(step, hookBlock);
      else work.push({ path: step.path, before: readBuf(step.path), after: fs.readFileSync(GUARD_SRC), steps: [step], kind: step.kind });
    }
  }
  if (!work.length) return { changed, skipped, backupDir: null };

  // Back up everything first, with the manifest on disk before any write.
  const backupDir = newBackupDir(d.backups);
  const manifest = { version: 1, createdAt: new Date().toISOString(), claudeDir, entries: [] };
  work.forEach((w, i) => {
    const entry = { kind: w.kind, path: w.path, backup: null, mode: modeOf(realOf(w.path)), afterSha: sha(Buffer.from(w.after)), ...w.meta };
    if (w.before) {
      entry.backup = `files/${i}-${path.basename(w.path)}`;
      fs.writeFileSync(path.join(backupDir, entry.backup), w.before, { mode: entry.mode ?? 0o644 });
      fs.chmodSync(path.join(backupDir, entry.backup), entry.mode ?? 0o644);
    }
    manifest.entries.push(entry);
  });
  fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  for (const w of work) {
    writeFile(w.path, w.after);
    for (const s of w.steps) changed.push({ kind: s.kind, path: s.path, summary: s.summary });
  }
  return { changed, skipped, backupDir };
}

// Restores the newest backup that has not been undone. Files that changed
// after the fix are not clobbered: settings.json only loses the keys fabletax
// set (our hook entry; autoCompactWindow back to what it was), anything else
// is left alone and reported.
export function undoFix({ claudeDir } = {}) {
  const d = dirs(claudeDir);
  const out = { restored: [], removed: [], skipped: [], backupDir: null };
  let names;
  try { names = fs.readdirSync(d.backups).sort().reverse(); } catch { return out; }
  for (const name of names) {
    const dir = path.join(d.backups, name);
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch { continue; }
    if (manifest.undone) continue;
    out.backupDir = dir;
    for (const e of [...manifest.entries].reverse()) {
      const cur = readBuf(e.path);
      const backup = e.backup ? readBuf(path.join(dir, e.backup)) : null;
      const untouched = cur && sha(cur) === e.afterSha;
      try {
        if (e.kind === 'settings' && cur && !untouched) {
          const parsed = parseSettings(cur.toString('utf8'));
          if (parsed.error) { out.skipped.push({ path: e.path, reason: 'settings.json is no longer valid JSON; revert fabletax\'s changes by hand' }); continue; }
          const json = parsed.json;
          if (e.hook) removeHook(json);
          if (e.compact && json.autoCompactWindow === e.compact.set) {
            if (e.compact.had) json.autoCompactWindow = e.compact.prev;
            else delete json.autoCompactWindow;
          }
          writeFile(e.path, dump(json, cur.toString('utf8')));
          out.restored.push(e.path);
        } else if (e.kind === 'agent-model' && cur && !untouched) {
          out.skipped.push({ path: e.path, reason: 'changed since the fix; left alone' });
        } else if (!cur) {
          if (backup) { writeFile(e.path, backup); fs.chmodSync(realOf(e.path), e.mode ?? 0o644); out.restored.push(e.path); }
        } else if (backup) {
          writeFile(e.path, backup);
          if (e.mode != null) fs.chmodSync(realOf(e.path), e.mode);
          out.restored.push(e.path);
        } else {
          fs.rmSync(realOf(e.path), { force: true });
          out.removed.push(e.path);
        }
      } catch (err) {
        out.skipped.push({ path: e.path, reason: err.message });
      }
    }
    manifest.undone = new Date().toISOString();
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    return out;
  }
  return out;
}
