import { resolveModel } from './prices.mjs';

export const MAX_COLS = 76;
const BOX_INNER = 70;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ANSI_RE = /\x1b\[[0-9;]*m/g;

export const stripAnsi = (s) => s.replace(ANSI_RE, '');
export const visibleLength = (s) => [...stripAnsi(s)].length;

const padEnd = (s, n) => s + ' '.repeat(Math.max(0, n - visibleLength(s)));
const padStart = (s, n) => ' '.repeat(Math.max(0, n - visibleLength(s))) + s;
const plural = (n, one, many = `${one}s`) => `${fmtInt(n)} ${n === 1 ? one : many}`;
const fmtInt = (n) => Math.round(n).toLocaleString('en-US');

export function truncate(s, n) {
  const chars = [...String(s)];
  return chars.length <= n ? chars.join('') : chars.slice(0, Math.max(0, n - 1)).join('') + '…';
}

// Cuts a possibly colored line to `max` visible columns.
export function clip(s, max = MAX_COLS) {
  if (visibleLength(s) <= max) return s;
  let out = '';
  let n = 0;
  for (const part of s.split(/(\x1b\[[0-9;]*m)/)) {
    if (part.startsWith('\x1b')) { out += part; continue; }
    const chars = [...part];
    if (n + chars.length > max - 1) { out += chars.slice(0, Math.max(0, max - 1 - n)).join('') + '…'; break; }
    out += part;
    n += chars.length;
  }
  return s.includes('\x1b') ? out + '\x1b[0m' : out;
}

export function wrap(text, width) {
  const lines = [];
  let line = '';
  for (const word of String(text).split(/[ \t\n]+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) { lines.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.map((l) => l.replaceAll('\u00a0', ' '));
}

export function money(n) {
  const v = Number.isFinite(n) && Math.abs(n) >= 0.005 ? n : 0;
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${v < 0 ? '-' : ''}$${s}`;
}

export const moneyWhole = (n) => `$${Math.round(n).toLocaleString('en-US')}`;

export function percent(frac) {
  const p = Math.round(frac * 100);
  return frac > 0 && p === 0 ? '<1%' : `${p}%`;
}

// `filled` and `empty` come back separately so the caller can color them.
export function bar(frac, width = 20) {
  const n = Math.max(0, Math.min(width, Math.round(frac * width)));
  return { filled: '█'.repeat(n), empty: '░'.repeat(width - n) };
}

// 967_000 -> "967k", 22_100_000 -> "22.1M"
export function tokens(n) {
  if (n >= 999_500) return `${+(n / 1e6).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(Math.round(n));
}

// The model the taxed subagents ran on: "Opus 5.5", or "your main model" when mixed.
function mainModel(report) {
  const models = new Set(report.topRuns.map((r) => modelName(r.model)));
  return models.size === 1 ? [...models][0] : 'your main model';
}

// "claude-sonnet-5-5" -> "Sonnet 5.5", from the id alone.
export function modelName(model) {
  const id = String(resolveModel(model) || model || '').toLowerCase();
  const m = /claude-([a-z]+)-(\d+)(?:-(\d{1,2})(?!\d))?/.exec(id);
  if (!m) return String(model || 'unknown');
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}

const shortDate = (ts) => {
  const d = new Date(ts);
  return `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, '0')}`;
};

const styler = (on) => {
  const wrapWith = (code) => (s) => (on && s !== '' ? `\x1b[${code}m${s}\x1b[0m` : s);
  return { dim: wrapWith(2), red: wrapWith(31), green: wrapWith(32), boldRed: wrapWith('1;31') };
};

function box(lines, edge) {
  const rule = '─'.repeat(BOX_INNER);
  const body = lines.map((l) => `  ${edge('│')}  ${padEnd(clip(l, BOX_INNER - 4), BOX_INNER - 4)}  ${edge('│')}`);
  return [`  ${edge(`╭${rule}╮`)}`, ...body, `  ${edge(`╰${rule}╯`)}`];
}

const tildePath = (p, home) => (home && p.startsWith(home) ? `~${p.slice(home.length)}` : p);

// opts: { color, share, verbose, days, all, claudeDir, home }
export function renderReport(report, config, opts = {}) {
  const { color = false, share = false, verbose = false, all = false } = opts;
  const days = opts.days ?? 30;
  const c = styler(color);
  const out = [];
  const push = (s = '') => out.push(s);
  const heading = (s) => { push(); push(`  ${s}`); };

  const target = modelName(report.target.model);
  const window = all ? 'all time' : `last ${days === 1 ? 'day' : `${days} days`}`;
  push(c.dim(`  fabletax · ${window} · prices as of ${report.pricesAsOf}`));

  if (report.total.calls === 0) {
    push();
    push(`  No Claude Code usage found${all ? '' : ` in the ${window}`}.`);
    if (opts.claudeDir) {
      const where = `${tildePath(opts.claudeDir, opts.home)}/projects`;
      push(c.dim(`  Looked in ${where.length > 60 ? `…${where.slice(-59)}` : where}`));
    }
    push(c.dim(`  ${all ? 'Point' : 'Try --all, or point'} --claude-dir at your Claude config folder.`));
    return finish(out);
  }

  const line = (indent, label, amount, extra) =>
    `${' '.repeat(indent)}${padEnd(label, 28 - indent)}${padStart(amount, 11)}${extra ? `   ${c.dim(extra)}` : ''}`;

  push();
  push(line(2, 'You spent', money(report.total.usd), plural(report.total.calls, 'API call')));
  push(line(4, 'main thread', money(report.main.usd)));
  push(line(4, 'subagents', money(report.subagents.usd), plural(report.subagents.runs, 'run')));
  if (report.fastPremiumUsd > 0) push(c.dim(`    includes ${money(report.fastPremiumUsd)} of fast-mode premium`));
  if (report.unpriced.calls > 0) {
    const names = Object.keys(report.unpriced.models).join(', ');
    push(c.dim(`    ${plural(report.unpriced.calls, 'call')} not priced (not in the price table): ${truncate(names, 36)}`));
  }

  const { tax, bloat, idle, taxTotal, dispatch } = report;
  const cap = tokens(bloat.capTokens);
  const compactFinding = config?.findings?.find((f) => f.id === 'compact-window');
  const compactWindow = config?.compact?.window;
  const manual = 'Fix: /compact or /clear when a task is done.';
  let bloatFix = [manual];
  if (compactFinding?.fixable) {
    bloatFix = [`Fix: npx fabletax fix (sets auto-compact to ${cap}; undo with --undo)`];
  } else if (compactFinding?.level === 'ok' && compactWindow && compactWindow <= bloat.capTokens) {
    bloatFix = [`Auto-compact is already set to ${tokens(compactWindow)}; this is from before, or from sessions that predate it.`, manual];
  } else if (compactFinding?.level === 'bad') {
    bloatFix = [compactFinding.title, `Fix: /autocompact ${cap}`];
  }
  const nb = (name) => name.replace(' ', '\u00a0');
  const has = (t) => t.usd >= 0.005;
  const taxes = [
    {
      name: 'Bloat', tax: bloat,
      gist: `${plural(bloat.calls, 'turn')} carried over ${cap} tokens`,
      body: `Every turn re-reads the whole conversation. ${plural(bloat.calls, 'turn')} carried more than ${cap}; the largest carried ${tokens(bloat.peakTokens)}. This is the cost of the part above ${cap}.`,
      fix: bloatFix,
    },
    {
      name: 'Idle', tax: idle,
      gist: `${plural(idle.resumes, 'resume')} after the cache expired`,
      body: `${fmtInt(idle.resumes)} ${idle.resumes === 1 ? 'time' : 'times'} you came back after the prompt cache had expired and paid to write ${tokens(idle.tokens)} tokens of old context back into it.`,
      fix: ['Fix: /compact or /clear before stepping away from a long session.'],
    },
    {
      name: 'Inheritance', tax,
      gist: `${plural(tax.runs, 'subagent')} ran on ${mainModel(report)}`,
      body: `${fmtInt(tax.runs)} of ${plural(dispatch.runs, 'subagent run')} ${tax.runs === 1 ? 'was' : 'were'} dispatched without a model, so ${tax.runs === 1 ? 'it' : 'they'} ran on ${nb(mainModel(report))}. Cost: ${money(tax.actualUsd)}. Same tokens on ${nb(target)}: ${money(tax.repricedUsd)}.`,
      fix: ['Fix: npx fabletax fix'],
    },
  ];
  const active = taxes.filter((t) => has(t.tax));

  push();
  if (has(taxTotal)) {
    const w = Math.max(...active.map((t) => money(t.tax.usd).length));
    const head = `TAX   ${c.boldRed(money(taxTotal.usd))}   ${c.dim(`${percent(taxTotal.shareOfTotal)} of everything you spent`)}`;
    const rows = active.map((t) => {
      const prefix = `${padEnd(`${t.name} tax`, 17)}${padStart(money(t.tax.usd), w)}   `;
      return prefix + truncate(t.gist, BOX_INNER - 4 - visibleLength(prefix));
    });
    const rate = taxTotal.perMonthUsd != null ? ['', `At this rate: ~${moneyWhole(taxTotal.perMonthUsd)}/month.`] : [];
    out.push(...box([head, '', ...rows, ...rate], c.red));
  } else {
    const text = `Nothing carried over ${cap} tokens, no cold-cache resumes, and no subagent inherited a model pricier than ${target}.`;
    out.push(...box([c.green('No tax found'), '', ...wrap(text, BOX_INNER - 4)], c.green));
  }

  for (const t of active) {
    heading(`${t.name} tax · ${money(t.tax.usd)}`);
    for (const l of wrap(t.body, 72)) push(`    ${l}`);
    for (const f of t.fix) for (const l of wrap(f, 72)) push(`    ${l}`);
  }
  if (has(taxTotal)) {
    const none = taxes.filter((t) => !has(t.tax));
    if (none.length) push();
    for (const t of none) push(`  ${c.green('✓')} ${c.dim(`No ${t.name.toLowerCase()} tax`)}`);
  }

  if (report.topSessions.length) {
    const rows = report.topSessions.slice(0, 5).map((s, i) => [
      share ? `session ${i + 1}` : truncate(s.project, 16), shortDate(s.ts),
      money(s.usd), money(s.bloatUsd), money(s.idleUsd), tokens(s.peakTokens),
    ]);
    const heads = ['spent', 'bloat', 'idle', 'peak'];
    const widths = heads.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i + 2].length)) + 4);
    push();
    push(`  ${padEnd('Worst sessions', 26)}${heads.map((h, i) => padStart(h, widths[i])).join('')}`);
    for (const r of rows) {
      push(`    ${padEnd(r[0], 16)}${padEnd(r[1], 6)}${r.slice(2).map((v, i) => padStart(v, widths[i])).join('')}`);
    }
  }

  if (verbose && tax.usd > 0) {
    const types = report.byAgentType.filter((t) => t.taxUsd > 0);
    if (types.length) {
      heading('Where it went');
      for (const t of types.slice(0, 6)) {
        push(`    ${padEnd(truncate(t.agentType, 20), 20)}${padStart(plural(t.runs, 'run'), 9)}${padStart(money(t.usd), 11)}  →${padStart(money(t.usd - t.taxUsd), 10)}`);
      }
      if (types.length > 6) push(c.dim(`    + ${types.length - 6} more`));
    }
    if (report.topRuns.length) {
      heading('Biggest runs');
      const runs = report.topRuns;
      const w = Math.max(...runs.map((r) => money(r.usd).length));
      const w2 = Math.max(...runs.map((r) => money(r.usd - r.taxUsd).length));
      // 72 columns after the indent; whatever the money columns leave goes to type and project.
      const avail = 72 - (w + w2 + 3) - 10 - 6 - (share ? 6 : 8);
      const typeW = share ? Math.min(18, avail) : Math.min(18, Math.max(8, avail - 8));
      const projW = share ? 0 : Math.max(4, Math.min(14, avail - typeW));
      for (const r of runs) {
        const cols = [
          `${padStart(money(r.usd), w)} → ${padStart(money(r.usd - r.taxUsd), w2)}`,
          padEnd(truncate(r.agentType, typeW), typeW),
          padEnd(modelName(r.model), 10),
          ...(share ? [] : [padEnd(truncate(r.project, projW), projW)]),
          shortDate(r.ts),
        ];
        push(`    ${cols.join('  ')}`);
        if (!share && r.description) push(c.dim(`      ${truncate(r.description, 66)}`));
      }
    }
  }

  heading('Spend by model');
  const models = report.byModel.slice(0, 5);
  const nameW = Math.max(...models.map((m) => m.model.length));
  for (const m of models) {
    const b = bar(report.total.usd > 0 ? m.usd / report.total.usd : 0);
    push(`    ${padEnd(m.model, nameW)}  ${b.filled}${c.dim(b.empty)}${padStart(money(m.usd), 12)}${padStart(percent(m.usd / report.total.usd), 6)}`);
  }
  if (report.byModel.length > 5) push(c.dim(`    + ${report.byModel.length - 5} more`));

  if (verbose && !share && report.byProject.length) {
    heading('Spend by project');
    for (const p of report.byProject.slice(0, 8)) {
      push(`    ${padEnd(truncate(p.project, 28), 28)}${padStart(money(p.usd), 12)}${p.taxUsd > 0 ? c.dim(`   tax ${money(p.taxUsd)}`) : ''}`);
    }
  }

  const findings = config?.findings || [];
  if (findings.length) {
    heading('Config');
    for (const f of findings) {
      const mark = f.level === 'bad' ? c.red('✗') : f.level === 'ok' ? c.green('✓') : c.dim('·');
      const [first, ...rest] = wrap(f.title, 68);
      push(`    ${mark} ${first}`);
      for (const l of rest) push(`      ${l}`);
      if (verbose && !share && f.detail) for (const l of f.detail.split('\n')) push(c.dim(`      ${truncate(l.trimEnd(), 66)}`));
    }
  }

  push();
  const fine = `An estimate, not a bill. Token counts come from your local transcripts and are priced at list price. Bloat assumes the work fit in ${cap} tokens of context, idle that the cache stayed warm, inheritance that ${nb(target)} could do the subagent's job with the same tokens. On a plan this is what your usage is worth at API rates, not what you were charged.`;
  for (const l of wrap(fine, 72)) push(c.dim(`  ${l}`));
  return finish(out);
}

const finish = (lines) => `${lines.map((l) => clip(l)).join('\n')}\n`;
