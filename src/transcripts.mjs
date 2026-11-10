import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { normalizeUsage } from './cost.mjs';

export const defaultClaudeDir = () =>
  process.env.CLAUDE_CONFIG_DIR ||
  (process.platform === 'win32' && process.env.USERPROFILE
    ? join(process.env.USERPROFILE, '.claude')
    : join(homedir(), '.claude'));

const SYNTHETIC = '<synthetic>';
const str = (v) => (typeof v === 'string' && v ? v : null);

async function walk(dir, out = []) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

// <slug>/<session>.jsonl is a main thread; <slug>/<session>/**/subagents/agent-<id>.jsonl
// is a subagent. Anything else under projects/ is not ours.
function classify(projectsDir, path) {
  const parts = relative(projectsDir, path).split(/[/\\]/);
  const name = parts[parts.length - 1].replace(/\.jsonl$/, '');
  if (parts.length === 2) return { slug: parts[0], sessionId: name, agentId: null };
  if (parts.length >= 4 && parts[parts.length - 2] === 'subagents') {
    return { slug: parts[0], sessionId: parts[1], agentId: name.replace(/^agent-/, ''), metaPath: path.replace(/\.jsonl$/, '.meta.json') };
  }
  return null;
}

// One streaming pass over a file. Big lines of other types are never parsed.
async function scan(file, fallbackTs) {
  const out = { lines: 0, parseErrors: 0, calls: [], dispatches: [], links: [] };
  const { sessionId, slug } = file;
  try {
    const rl = createInterface({ input: createReadStream(file.path, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const text of rl) {
      if (!text) continue;
      out.lines += 1;
      if (!text.includes('"usage"') && !text.includes('"toolUseResult"')) continue;
      let line;
      try { line = JSON.parse(text); } catch { out.parseErrors += 1; continue; }
      if (!line || typeof line !== 'object') continue;

      if (line.type === 'user') {
        const agentId = str(line.toolUseResult?.agentId);
        if (!agentId || !Array.isArray(line.message?.content)) continue;
        for (const b of line.message.content) {
          if (str(b?.tool_use_id)) out.links.push({ agentKey: `${sessionId}:${agentId}`, toolUseId: b.tool_use_id });
        }
        continue;
      }
      const msg = line.message;
      if (line.type !== 'assistant' || !msg || typeof msg !== 'object') continue;

      const dispatcherModel = str(msg.model) === SYNTHETIC ? null : str(msg.model);
      if (Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (b?.type !== 'tool_use' || (b.name !== 'Agent' && b.name !== 'Task') || !str(b.id)) continue;
          const input = b.input || {};
          out.dispatches.push({
            id: b.id, model: str(input.model), subagentType: str(input.subagent_type),
            description: str(input.description), dispatcherModel,
          });
        }
      }

      if (!msg.usage || typeof msg.usage !== 'object' || msg.model === SYNTHETIC) continue;
      const side = line.isSidechain === true;
      const agentId = file.agentId || (side ? str(line.agentId) || 'inline' : null);
      const parsed = Date.parse(line.timestamp);
      out.calls.push({
        dedupe: str(msg.id) ? `${msg.id}:${line.requestId ?? ''}` : null,
        version: str(line.version),
        agentId,
        call: {
          ts: Number.isFinite(parsed) ? parsed : fallbackTs,
          sessionId,
          project: (str(line.cwd) && basename(line.cwd)) || slug,
          model: str(msg.model) || 'unknown',
          usage: normalizeUsage(msg.usage),
          speed: msg.usage.speed,
          geo: msg.usage.inference_geo,
          agentKey: agentId ? `${sessionId}:${agentId}` : null,
        },
      });
    }
  } catch { /* unreadable file: keep what we have */ }
  return out;
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

const versionParts = (v) => v.split('.').map((n) => parseInt(n, 10) || 0);
function newerVersion(a, b) {
  const x = versionParts(a), y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
}

const MAX_CATEGORIES = ['input', 'output', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead'];

async function readMeta(path) {
  try {
    const meta = JSON.parse(await readFile(path, 'utf8'));
    return meta && typeof meta === 'object' ? meta : null;
  } catch { return null; }
}

export async function loadTranscripts({ claudeDir = defaultClaudeDir(), sinceMs = 0, project = null } = {}) {
  const projectsDir = join(claudeDir, 'projects');
  const stats = { files: 0, lines: 0, parseErrors: 0, duplicates: 0, versions: {}, latestVersion: null };

  const files = (await walk(projectsDir))
    .sort()
    .map((path) => ({ path, ...classify(projectsDir, path) }))
    .filter((f) => f.sessionId);

  const results = await pool(files, 8, async (file) => {
    let mtimeMs;
    try { mtimeMs = (await stat(file.path)).mtimeMs; } catch { return null; }
    if (mtimeMs < sinceMs) return null;
    return scan(file, mtimeMs);
  });

  const seen = new Map();
  const all = [];
  const agentInfo = new Map();
  const dispatchIndex = new Map();
  const links = new Map();

  results.forEach((r, i) => {
    if (!r) return;
    const file = files[i];
    stats.files += 1;
    stats.lines += r.lines;
    stats.parseErrors += r.parseErrors;
    for (const d of r.dispatches) if (!dispatchIndex.has(d.id)) dispatchIndex.set(d.id, d);
    for (const l of r.links) if (!links.has(l.agentKey)) links.set(l.agentKey, l.toolUseId);
    for (const c of r.calls) {
      const prev = c.dedupe && seen.get(c.dedupe);
      if (prev) {
        stats.duplicates += 1;
        for (const k of MAX_CATEGORIES) prev.usage[k] = Math.max(prev.usage[k], c.call.usage[k]);
        prev.ts = Math.min(prev.ts, c.call.ts);
        prev.speed ??= c.call.speed;
        prev.geo ??= c.call.geo;
        continue;
      }
      if (c.dedupe) seen.set(c.dedupe, c.call);
      all.push(c.call);
      if (c.version) {
        stats.versions[c.version] = (stats.versions[c.version] || 0) + 1;
        if (!stats.latestVersion || newerVersion(c.version, stats.latestVersion)) stats.latestVersion = c.version;
      }
      if (c.call.agentKey && !agentInfo.has(c.call.agentKey)) {
        agentInfo.set(c.call.agentKey, { agentId: c.agentId, sessionId: c.call.sessionId, metaPath: file.agentId ? file.metaPath : null });
      }
    }
  });

  const needle = project ? String(project).toLowerCase() : null;
  const calls = all.filter((c) => c.ts >= sinceMs && (!needle || c.project.toLowerCase().includes(needle)));

  const agents = new Map();
  for (const key of new Set(calls.map((c) => c.agentKey).filter(Boolean))) {
    const info = agentInfo.get(key);
    const meta = info.metaPath ? await readMeta(info.metaPath) : null;
    const d = dispatchIndex.get(meta?.toolUseId) || dispatchIndex.get(links.get(key));
    agents.set(key, {
      agentKey: key,
      agentId: info.agentId,
      sessionId: info.sessionId,
      agentType: str(meta?.agentType) || d?.subagentType || null,
      description: str(meta?.description) || d?.description || '',
      spawnDepth: Number.isFinite(meta?.spawnDepth) ? meta.spawnDepth : null,
      dispatch: { found: !!d, model: d?.model ?? null, dispatcherModel: d?.dispatcherModel ?? null },
    });
  }

  return { calls, agents, stats };
}
