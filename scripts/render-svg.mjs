#!/usr/bin/env node
// Render ANSI-coloured terminal text (stdin) as an SVG terminal window.
// Usage: <command> | node scripts/render-svg.mjs out.svg [--lines N] [--title TEXT]
// Zero dependencies. Handles SGR: 0/22 reset, 1 bold, 2 dim, 30-37/90-97 colours, 39.
import { readFileSync, writeFileSync } from 'node:fs';

const COLS = 76;
const FONT_SIZE = 14;
const ADV = 8.4;          // fixed advance per character cell (0.6em at 14px)
const LINE_H = 21;
const PAD_X = 22;
const PAD_Y = 18;
const BAR_H = 40;
const WIN_W = Math.round(COLS * ADV + PAD_X * 2);
const FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

const FG = '#e6edf3';
const DIM = '#7d8590';
const COLORS = {
  30: '#484f58', 31: '#ff7b72', 32: '#3fb950', 33: '#d29922',
  34: '#58a6ff', 35: '#bc8cff', 36: '#56d4dd', 37: '#e6edf3',
  90: '#7d8590', 91: '#ffa198', 92: '#56d364', 93: '#e3b341',
  94: '#79c0ff', 95: '#d2a8ff', 96: '#76e3ea', 97: '#ffffff',
};

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (n) => String(Math.round(n * 100) / 100);

function parseArgs(argv) {
  const o = { out: null, lines: Infinity, title: 'npx fabletax' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--lines') o.lines = Number(argv[++i]);
    else if (a.startsWith('--lines=')) o.lines = Number(a.slice(8));
    else if (a === '--title') o.title = argv[++i];
    else if (a.startsWith('--title=')) o.title = a.slice(8);
    else if (!o.out) o.out = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (!o.out) throw new Error('usage: render-svg.mjs <out.svg> [--lines N] [--title TEXT]');
  if (!(o.lines >= 1)) throw new Error('--lines needs a positive number');
  return o;
}

// Split one line into runs of identical style: [{ text, bold, dim, color }]
function parseLine(line, state) {
  const runs = [];
  let text = '';
  const flush = () => {
    if (text) runs.push({ text, bold: state.bold, dim: state.dim, color: state.color });
    text = '';
  };
  for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
    const m = /^\x1b\[([0-9;]*)m$/.exec(part);
    if (!m) { text += part.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''); continue; }
    flush();
    const codes = m[1] === '' ? [0] : m[1].split(';').map(Number);
    for (const c of codes) {
      if (c === 0) { state.bold = false; state.dim = false; state.color = null; }
      else if (c === 1) state.bold = true;
      else if (c === 2) state.dim = true;
      else if (c === 22) { state.bold = false; state.dim = false; }
      else if (c === 39) state.color = null;
      else if (COLORS[c]) state.color = COLORS[c];
    }
  }
  flush();
  return runs;
}

function runAttrs(r) {
  const a = [];
  let fill = r.color || FG;
  if (r.dim && !r.color) fill = DIM;
  a.push(`fill="${fill}"`);
  if (r.dim && r.color) a.push('fill-opacity="0.6"');
  if (r.bold) a.push('font-weight="700"');
  return a.join(' ');
}

const opts = parseArgs(process.argv.slice(2));
let input = readFileSync(0, 'utf8').replace(/\r/g, '').replace(/[\x00-\x08\x0b-\x1a]/g, '');
let lines = input.split('\n');
while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
lines = lines.slice(0, opts.lines);

const state = { bold: false, dim: false, color: null };
const body = [];
lines.forEach((line, i) => {
  const y = BAR_H + PAD_Y + i * LINE_H + FONT_SIZE;
  const spans = [];
  let col = 0;
  for (const r of parseLine(line, state)) {
    const chars = [...r.text];
    if (r.text.trim() !== '') {
      // Trim edge spaces off the run so textLength only governs visible glyphs.
      const lead = chars.findIndex((c) => c !== ' ');
      let end = chars.length;
      while (chars[end - 1] === ' ') end--;
      const vis = chars.slice(lead, end).join('');
      const x = PAD_X + (col + lead) * ADV;
      const len = (end - lead) * ADV;
      spans.push(`<tspan x="${num(x)}" textLength="${num(len)}" lengthAdjust="spacing" ${runAttrs(r)}>${esc(vis)}</tspan>`);
    }
    col += chars.length;
  }
  if (spans.length) body.push(`<text y="${y}" xml:space="preserve">${spans.join('')}</text>`);
});

const height = BAR_H + PAD_Y * 2 + Math.max(lines.length, 1) * LINE_H;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIN_W}" height="${height}" viewBox="0 0 ${WIN_W} ${height}" role="img" aria-label="${esc(opts.title)} terminal output">
<title>${esc(opts.title)}</title>
<defs><clipPath id="win"><rect width="${WIN_W}" height="${height}" rx="10"/></clipPath></defs>
<g clip-path="url(#win)">
<rect width="${WIN_W}" height="${height}" fill="#0d1117"/>
<rect width="${WIN_W}" height="${BAR_H}" fill="#161b22"/>
<rect y="${BAR_H - 1}" width="${WIN_W}" height="1" fill="#30363d"/>
<circle cx="22" cy="${BAR_H / 2}" r="6" fill="#ff5f56"/>
<circle cx="42" cy="${BAR_H / 2}" r="6" fill="#ffbd2e"/>
<circle cx="62" cy="${BAR_H / 2}" r="6" fill="#27c93f"/>
<text x="${WIN_W / 2}" y="${BAR_H / 2 + 4.5}" text-anchor="middle" font-family="${FONT}" font-size="13" fill="${DIM}">${esc(opts.title)}</text>
<g font-family="${FONT}" font-size="${FONT_SIZE}" fill="${FG}">
${body.join('\n')}
</g>
</g>
<rect x="0.5" y="0.5" width="${WIN_W - 1}" height="${height - 1}" rx="10" fill="none" stroke="#30363d"/>
</svg>
`;
writeFileSync(opts.out, svg);
