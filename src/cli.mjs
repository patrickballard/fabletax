import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { loadTranscripts, defaultClaudeDir } from './transcripts.mjs';
import { analyze, DEFAULT_CONTEXT_CAP } from './analyze.mjs';
import { auditConfig } from './config.mjs';
import { planFix, applyFix, undoFix } from './fix.mjs';
import { renderReport, tokens } from './report.mjs';
import { ALIASES, PRICES, PRICES_AS_OF, PRICES_SOURCE, resolveTarget } from './prices.mjs';

const DAY_MS = 86_400_000;

const USAGE = `fabletax: find the avoidable part of your Claude Code bill, then fix it

Usage
  fabletax [audit] [options]   read local transcripts, print the three taxes
  fabletax fix [options]       cap auto-compact, install the guard hook, pin agents
  fabletax prices              print the dated price table

Audit options
  --days <n>           look back n days (default 30)
  --all                look at everything
  --project <text>     only projects whose name contains text
  --as <model>         reprice on sonnet (default), haiku, or a model id
  --cap <tokens>       context size the bloat tax is measured above (200k)
  --json               print { report, config } as JSON and nothing else
  --share              leave project names and descriptions out
  --verbose            also show descriptions, projects and finding details
  --no-color           plain output (also NO_COLOR, or when not a terminal)
  --claude-dir <path>  Claude config folder (default $CLAUDE_CONFIG_DIR or ~/.claude)

Fix options
  --yes                apply without asking
  --undo               restore the newest backup and remove the guard entry
  --model <name>       sonnet (default) or haiku
  --no-hook            do not install the guard hook
  --no-agents          do not edit agent files
  --no-compact         do not set the auto-compact window
  --cap <tokens>       auto-compact window to set (default 200k)

  -h, --help           this text
  -v, --version        print the version
`;

const FLAGS = {
  '--days': { key: 'days', value: true },
  '--all': { key: 'all' },
  '--project': { key: 'project', value: true },
  '--as': { key: 'as', value: true },
  '--cap': { key: 'cap', value: true },
  '--json': { key: 'json' },
  '--share': { key: 'share' },
  '--verbose': { key: 'verbose' },
  '--no-color': { key: 'noColor' },
  '--claude-dir': { key: 'claudeDir', value: true },
  '--yes': { key: 'yes' },
  '--undo': { key: 'undo' },
  '--model': { key: 'model', value: true },
  '--no-hook': { key: 'noHook' },
  '--no-agents': { key: 'noAgents' },
  '--no-compact': { key: 'noCompact' },
  '-h': { key: 'help' },
  '--help': { key: 'help' },
  '-v': { key: 'version' },
  '--version': { key: 'version' },
  '-y': { key: 'yes' },
};

const ALLOWED = {
  audit: ['days', 'all', 'project', 'as', 'cap', 'json', 'share', 'verbose', 'noColor', 'claudeDir', 'help', 'version'],
  fix: ['yes', 'undo', 'model', 'cap', 'noHook', 'noAgents', 'noCompact', 'noColor', 'claudeDir', 'help', 'version'],
  prices: ['noColor', 'help', 'version'],
};

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    if (arg === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (!arg.startsWith('-') || arg === '-') { positional.push(arg); continue; }
    let inline;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq > -1) { inline = arg.slice(eq + 1); arg = arg.slice(0, eq); }
    const flag = FLAGS[arg];
    if (!flag) throw new UsageError(`unknown option ${arg}`);
    if (!flag.value) {
      if (inline !== undefined) throw new UsageError(`${arg} does not take a value`);
      opts[flag.key] = true;
      continue;
    }
    const value = inline !== undefined ? inline : argv[++i];
    if (value === undefined || (inline === undefined && value.startsWith('--'))) throw new UsageError(`${arg} needs a value`);
    opts[flag.key] = value;
  }
  return { opts, positional };
}

const readVersion = () => JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

// io: { stdout, stderr, stdin, env, cwd } so tests can drive it. Returns the exit code.
export async function main(argv, io = {}) {
  const env = io.env || process.env;
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const ctx = { stdout, stderr, stdin: io.stdin || process.stdin, env, cwd: io.cwd || process.cwd() };
  try {
    const { opts, positional } = parseArgs(argv);
    if (opts.help) { stdout.write(USAGE); return 0; }
    if (opts.version) { stdout.write(`${readVersion()}\n`); return 0; }

    const command = positional[0] || 'audit';
    if (!ALLOWED[command]) throw new UsageError(`unknown command ${command}`);
    if (positional.length > 1) throw new UsageError(`unexpected argument ${positional[1]}`);
    for (const key of Object.keys(opts)) {
      if (!ALLOWED[command].includes(key)) {
        const flag = Object.keys(FLAGS).find((f) => FLAGS[f].key === key);
        throw new UsageError(`${flag} does not apply to ${command}`);
      }
    }
    ctx.color = !opts.noColor && !env.NO_COLOR && Boolean(stdout.isTTY);
    ctx.claudeDir = opts.claudeDir || env.CLAUDE_CONFIG_DIR || defaultClaudeDir();

    if (command === 'prices') return printPrices(ctx);
    if (command === 'fix') return await runFix(opts, ctx);
    return await runAudit(opts, ctx);
  } catch (err) {
    if (err instanceof UsageError) {
      stderr.write(`fabletax: ${err.message}\nRun fabletax --help for usage.\n`);
      return 2;
    }
    stderr.write(`fabletax: ${err?.message || err}\n`);
    return 1;
  }
}

function positiveInt(text, flag) {
  if (!/^\d+$/.test(String(text)) || Number(text) < 1) throw new UsageError(`${flag} needs a whole number of 1 or more`);
  return Number(text);
}

// 200000, 200k or 0.5m -> tokens
function parseCap(text) {
  const m = /^(\d+(?:\.\d+)?)([km])?$/i.exec(String(text).trim());
  const n = m ? Math.round(Number(m[1]) * ({ k: 1e3, m: 1e6 }[(m[2] || '').toLowerCase()] || 1)) : 0;
  if (n < 1000) throw new UsageError('--cap needs a token count of at least 1000, like 200000 or 200k');
  return n;
}

function targetOrUsage(name, flag) {
  try {
    resolveTarget(name);
    return name;
  } catch (err) {
    throw new UsageError(`${flag}: ${err.message}`);
  }
}

// --share also applies to --json: nothing that names a project or a task.
function redact(report) {
  const names = new Map();
  const alias = (p) => names.get(p) || names.set(p, `project-${names.size + 1}`).get(p);
  return {
    ...report,
    byProject: report.byProject.map((p) => ({ ...p, project: alias(p.project) })),
    topSessions: report.topSessions.map(({ project, ...s }, i) => ({ ...s, project: `session ${i + 1}` })),
    topRuns: report.topRuns.map(({ description, project, ...r }) => ({ ...r, project: alias(project) })),
  };
}

async function runAudit(opts, ctx) {
  const days = opts.days === undefined ? 30 : positiveInt(opts.days, '--days');
  const target = targetOrUsage(opts.as || 'sonnet', '--as');
  const cap = opts.cap === undefined ? DEFAULT_CONTEXT_CAP : parseCap(opts.cap);
  const now = Date.now();
  const loaded = await loadTranscripts({
    claudeDir: ctx.claudeDir,
    sinceMs: opts.all ? 0 : now - days * DAY_MS,
    project: opts.project || null,
  });
  const report = analyze(loaded, { target, cap, now });
  const config = await auditConfig({ claudeDir: ctx.claudeDir, cwd: ctx.cwd, env: ctx.env, latestVersion: loaded.stats?.latestVersion, cap });

  if (opts.json) {
    ctx.stdout.write(`${JSON.stringify({ report: opts.share ? redact(report) : report, config }, null, 2)}\n`);
    return 0;
  }
  ctx.stdout.write(renderReport(report, config, {
    color: ctx.color,
    share: Boolean(opts.share),
    verbose: Boolean(opts.verbose),
    days,
    all: Boolean(opts.all),
    claudeDir: ctx.claudeDir,
    home: homedir(),
  }));
  return 0;
}

async function confirm(ctx, question) {
  if (!ctx.stdin.isTTY) return false;
  const rl = createInterface({ input: ctx.stdin, output: ctx.stdout });
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

// Plain-words version of a plan step (the step's own summary for most kinds).
function describeStep(step) {
  if (step.kind !== 'compact-window') return step.summary;
  const w = tokens(step.window);
  return `Set autoCompactWindow to ${w} in ${step.path} (Claude Code will compact the conversation at ${w} tokens instead of ~967k)`;
}

async function runFix(opts, ctx) {
  const { stdout } = ctx;
  const target = opts.model || 'sonnet';
  if (!['sonnet', 'haiku'].includes(target)) throw new UsageError('--model must be sonnet or haiku');
  const cap = opts.cap === undefined ? DEFAULT_CONTEXT_CAP : parseCap(opts.cap);
  const { claudeDir, cwd, env } = ctx;

  if (opts.undo) {
    const res = await undoFix({ claudeDir });
    if (!res.backupDir) {
      stdout.write('  No fabletax backup to restore.\n');
      return 0;
    }
    for (const p of res.restored) stdout.write(`  ✓ restored ${p}\n`);
    for (const p of res.removed) stdout.write(`  ✓ removed ${p}\n`);
    for (const s of res.skipped) stdout.write(`  ✗ ${s.path}: ${s.reason}\n`);
    return res.skipped.length ? 1 : 0;
  }

  const audit = await auditConfig({ claudeDir, cwd, env, cap });
  const steps = await planFix(audit, { claudeDir, cwd, target, hook: !opts.noHook, agents: !opts.noAgents, compact: !opts.noCompact, cap });
  if (!steps.length) {
    stdout.write('  Nothing to fix.\n');
    return 0;
  }
  stdout.write('\n  fabletax fix will:\n\n');
  for (const step of steps) stdout.write(`    • ${describeStep(step)}\n`);
  stdout.write('\n  Files are backed up first. Undo with: npx fabletax fix --undo\n\n');

  if (!opts.yes && !(await confirm(ctx, '  Apply these changes? [y/N] '))) {
    stdout.write(ctx.stdin.isTTY ? '  Nothing changed.\n' : '  Nothing changed. Re-run with --yes to apply.\n');
    return 0;
  }
  const res = await applyFix(steps, { claudeDir });
  for (const c of res.changed) stdout.write(`  ✓ ${c.summary}\n`);
  for (const s of res.skipped) stdout.write(`  ✗ ${s.path}: ${s.reason}\n`);
  if (res.backupDir) stdout.write(`\n  Backup: ${res.backupDir}\n`);
  return res.skipped.some((s) => !/^(already|hook already)/.test(s.reason)) ? 1 : 0;
}

const trim = (n) => String(+n.toFixed(4));

function printPrices({ stdout }) {
  const rows = [];
  for (const [id, p] of Object.entries(PRICES)) {
    const notes = [p.fast && `fast x${p.fast}`, p.noGeo && 'no-geo', p.tierOver && 'tiered'].filter(Boolean).join(' ');
    rows.push([id, p, notes]);
    if (p.tierOver) rows.push([`${id} >${p.tierOver.threshold / 1000}k`, p.tierOver, '']);
  }
  const num = (n) => trim(n).padStart(8);
  const lines = [
    `  USD per million tokens, Anthropic list price, as of ${PRICES_AS_OF}`,
    `  ${PRICES_SOURCE}`,
    '',
    `  ${'model'.padEnd(22)}${['input', 'output', 'write5m', 'write1h', 'read'].map((h) => h.padStart(8)).join('')}  notes`,
    ...rows.map(([id, p, notes]) => `  ${id.padEnd(22)}${[p.input, p.output, p.cacheWrite5m, p.cacheWrite1h, p.cacheRead].map(num).join('')}  ${notes}`.trimEnd()),
    '',
    '  Aliases (what --as and per-call model: resolve to)',
    ...Object.entries(ALIASES).map(([a, id]) => `    ${a.padEnd(8)}${id}`),
    '',
    '  fast: fast mode multiplies every category. no-geo: model predates the 1.1x',
    '  US-inference multiplier. tiered: other prices above 100k prompt tokens.',
  ];
  stdout.write(`${lines.join('\n')}\n`);
  return 0;
}
