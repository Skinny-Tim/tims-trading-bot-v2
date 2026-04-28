#!/usr/bin/env node
/**
 * ═══ Weekly Masterfile Generator ═══
 *
 * Dumpt het hele project (source + config + live state) in één markdown file.
 * Doel: single-file snapshot die je aan een fresh AI-sessie kan geven voor
 * instant context, of als forensisch baseline/audit-log voor de repo.
 *
 * Output: docs/masterfiles/YYYY-MM-DD.md
 *
 * Draait via .github/workflows/weekly-masterfile.yml (Sunday 22:00 UTC).
 * Lokaal testen: `node scripts/generate-masterfile.js`
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'docs', 'masterfiles');
const NOW = new Date();
const DATE_STR = NOW.toISOString().slice(0, 10);
const OUT_FILE = path.join(OUT_DIR, `${DATE_STR}.md`);

// Per-file truncation cap — zelfs grote libs blijven leesbaar in markdown.
const MAX_FILE_BYTES = 120 * 1024;
const LIVE_BASE = process.env.LIVE_BASE_URL || 'https://merlijn.camelotlabs.be';

// ── Bestanden die in de masterfile komen, in deze volgorde ──
const CORE_FILES = [
  'vercel.json',
  'package.json',
  'ew-params.json',
  'signal-params.json',
  'INSTRUCTIONS.md',
  'PROJECT_KNOWLEDGE.md',
  'EW_RESEARCH_LOG.md',
  '.github/workflows/paper-engine-cron.yml',
  '.github/workflows/weekly-masterfile.yml',
];

const LIB_FILES = [
  'api/_lib/signals.js',
  'api/_lib/sim.js',
  'api/_lib/fills.js',
  'api/_lib/portfolio.js',
  'api/_lib/redis.js',
  'api/_lib/bitvavo-public.js',
];

const API_FILES = [
  'api/paper-engine.js',
  'api/signals-cron.js',
  'api/backtest-agent.js',
  'api/backtest-parity.js',
  'api/ew-tuner.js',
  'api/ew-audit.js',
  'api/portfolio-state.js',
  'api/signal-config.js',
  'api/bitvavo.js',
  'api/kronos.js',
  'api/metals.js',
  'api/report.js',
];

function sh(cmd) {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: 'utf-8' }).trim();
  } catch (e) {
    return `<err: ${e.message}>`;
  }
}

function readFileSafe(rel) {
  try {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) return null;
    const buf = fs.readFileSync(p);
    if (buf.length > MAX_FILE_BYTES) {
      return buf.slice(0, MAX_FILE_BYTES).toString('utf-8')
        + `\n\n/* ─── TRUNCATED at ${MAX_FILE_BYTES} bytes (file size ${buf.length}) ─── */`;
    }
    return buf.toString('utf-8');
  } catch {
    return null;
  }
}

function lineCount(s) {
  return s ? s.split('\n').length : 0;
}

function extFor(rel) {
  const e = path.extname(rel).slice(1);
  if (e === 'js' || e === 'json' || e === 'yml' || e === 'yaml' || e === 'md') return e;
  return 'txt';
}

async function fetchJsonSafe(url, timeout = 8000) {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeout);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(to);
    if (!r.ok) return { _err: `HTTP ${r.status}`, _url: url };
    return await r.json();
  } catch (e) {
    return { _err: e.message, _url: url };
  }
}

function md(content) {
  return Array.isArray(content) ? content.join('\n') : content;
}

function section(title, body) {
  return `\n\n## ${title}\n\n${body}`;
}

function codeBlock(code, lang = '') {
  return '```' + lang + '\n' + (code ?? '') + '\n```';
}

async function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  // ── Live state fetch (parallel, failures worden gelogd niet gegooid) ──
  const [paperState, ewAudit, backtestResult] = await Promise.all([
    fetchJsonSafe(`${LIVE_BASE}/api/paper-state`),
    fetchJsonSafe(`${LIVE_BASE}/api/ew-audit`),
    fetchJsonSafe(`${LIVE_BASE}/api/backtest-parity`),
  ]);

  const parts = [];

  // ── Header ──
  parts.push(`# Merlijn Signal Dashboard — Master Snapshot`);
  parts.push('');
  parts.push(`**Date:** ${DATE_STR}`);
  parts.push(`**Generated:** ${NOW.toISOString()}`);
  parts.push(`**Git HEAD:** \`${sh('git rev-parse HEAD')}\``);
  parts.push(`**Branch:** \`${sh('git rev-parse --abbrev-ref HEAD')}\``);
  parts.push(`**Live base:** ${LIVE_BASE}`);
  parts.push('');
  parts.push('> Auto-generated weekly snapshot. Feed this to a fresh AI session for instant context.');

  // ── Git activity ──
  parts.push(section('1. Recent commits (last 30 days)',
    codeBlock(sh('git log --since="30 days ago" --oneline --decorate'))));

  parts.push(section('1b. Changed files (last 30 days)',
    codeBlock(sh('git log --since="30 days ago" --name-only --format=  ').split('\n').filter(Boolean).sort().filter((x, i, a) => x !== a[i - 1]).join('\n'))));

  // ── Live state ──
  parts.push(section('2. Live paper trading state',
    codeBlock(JSON.stringify(paperState, null, 2).slice(0, 8000), 'json')));

  parts.push(section('3. Elliott Wave audit (per-token)',
    codeBlock(JSON.stringify(ewAudit, null, 2).slice(0, 8000), 'json')));

  parts.push(section('4. Backtest parity summary',
    codeBlock(JSON.stringify(backtestResult, null, 2).slice(0, 8000), 'json')));

  // ── Architecture ──
  parts.push(section('5. Architecture overview', [
    `### Serverless functions (${API_FILES.length} total — Vercel Hobby limit = 12)`,
    '',
    API_FILES.map(f => `- \`${f}\``).join('\n'),
    '',
    `### Shared libs (${LIB_FILES.length})`,
    '',
    LIB_FILES.map(f => `- \`${f}\``).join('\n'),
    '',
    '### Cron schedule (from vercel.json + GitHub Actions)',
    '```',
    '  */5  * * * *   paper-engine       (GitHub Actions dual-cron)',
    '  0    6 * * *   backtest-agent     (Vercel daily)',
    '  0    7 * * *   signals-cron       (Vercel daily)',
    '  0    3 * * 1   ew-tuner           (Vercel weekly Monday)',
    '  0   22 * * 0   weekly-masterfile  (GitHub Actions weekly Sunday)',
    '```',
  ].join('\n')));

  // ── Core config + docs ──
  parts.push(section('6. Configuration & docs', ''));
  for (const f of CORE_FILES) {
    const content = readFileSafe(f);
    if (content === null) continue;
    parts.push(`\n### ${f} (${lineCount(content)} lines)\n`);
    parts.push(codeBlock(content, extFor(f)));
  }

  // ── Shared libs ──
  parts.push(section('7. Shared libs (api/_lib/)', ''));
  for (const f of LIB_FILES) {
    const content = readFileSafe(f);
    if (content === null) continue;
    parts.push(`\n### ${f} (${lineCount(content)} lines)\n`);
    parts.push(codeBlock(content, 'js'));
  }

  // ── API endpoints ──
  parts.push(section('8. API endpoints (api/*.js)', ''));
  for (const f of API_FILES) {
    const content = readFileSafe(f);
    if (content === null) continue;
    parts.push(`\n### ${f} (${lineCount(content)} lines)\n`);
    parts.push(codeBlock(content, 'js'));
  }

  // ── Footer ──
  parts.push(section('9. Notes for next session',
    [
      '- Paper-engine runs every 5 min via GitHub Actions dual-cron — Vercel crons (backtest/signals/tuner) zijn aanvullend.',
      '- ntfy topics zijn geroteerd naar onraadbare namen — zie `NTFY_TOPIC` default in paper-engine.js.',
      '- `NTFY_FILTER_TAG` als defense-in-depth layer blijft actief.',
      '- Vercel Hobby zit op de 12-function limit — nieuwe endpoints moeten in bestaande files samengevoegd worden.',
      '- Backtest-parity verwacht dezelfde sim-engine als paper-engine (shared `_lib/sim.js`).',
    ].join('\n')));

  const finalMd = parts.join('\n');
  fs.writeFileSync(OUT_FILE, finalMd);

  const sizeKB = (fs.statSync(OUT_FILE).size / 1024).toFixed(1);
  console.log(`✔ Masterfile written: ${path.relative(ROOT, OUT_FILE)}`);
  console.log(`  Size: ${sizeKB} KB — ${lineCount(finalMd)} lines`);

  // ── Keep only last 26 weekly snapshots (≈6 months) ──
  const files = fs.readdirSync(OUT_DIR).filter(n => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)).sort();
  const toDelete = files.slice(0, Math.max(0, files.length - 26));
  for (const n of toDelete) {
    fs.unlinkSync(path.join(OUT_DIR, n));
    console.log(`  removed old: ${n}`);
  }
}

main().catch(err => {
  console.error('generate-masterfile failed:', err);
  process.exit(1);
});
