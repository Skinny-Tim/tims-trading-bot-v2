#!/usr/bin/env node
// ═══ Camelot Daily Auto-Tuner ═══
//
// Doel: dagelijks de Camelot-parameters herijken op basis van laatste 90 dagen
// Binance candles. Grid-sweep over de meest impactvolle params, score op
// (Sharpe × ProfitFactor) — beide moeten positief zijn.
//
// Schrijft beste config naar data/camelot-params.json. De live engine leest
// die file bij elke tick (zie api/_lib/camelot-strategy.js → _loadTunedParams).
//
// Run lokaal: `node scripts/camelot-tuner.js`
// Run via cron: zie .github/workflows/daily-tuner.yml

const path = require('path');
const fs = require('fs');
const { fetchCandles, tokenToMarket } = require(path.join(__dirname, '..', 'api', '_lib', 'binance-public.js'));
const { computeIndicators, genSignal, applyCosts } = require(path.join(__dirname, '..', 'api', '_lib', 'camelot-strategy.js'));

const TOKENS    = (process.env.CAMELOT_TOKENS || 'BTC,ETH,SOL,BNB,XRP,AVAX,LINK,DOGE').split(',');
const INTERVAL  = process.env.CAMELOT_INTERVAL || '1h';
const LIMIT     = parseInt(process.env.CAMELOT_LIMIT || '2160', 10);  // 90 days × 24h
const STARTING_EQUITY = 10000;
const RISK_PER_TRADE  = parseFloat(process.env.CAMELOT_RISK || '0.01');
const MAX_POSITIONS   = parseInt(process.env.CAMELOT_MAX_POS || '5', 10);
const MIN_TRADES      = parseInt(process.env.CAMELOT_TUNE_MIN_TRADES || '20', 10);  // anders unreliable

// ═══ Param grid ═══
// Klein maar gericht — focus op de hefbomen die backtest het meest beïnvloeden.
// 2 × 2 × 2 × 2 × 2 = 32 combos per token-set. 90d × 8 tokens × 32 = ~5 min op Vercel-class.
const GRID = {
  adxRangeMax:  [18, 20, 22],
  adxTrendMin:  [22, 25, 28],
  rsiOversold:  [30, 35],
  rsiOverbought:[65, 70],
  rangeStopAtr: [1.0, 1.3],
  trendStopAtr: [1.3, 1.5, 1.8],
  trendTgtAtr:  [2.5, 3.0, 3.5],
  trendPullAtr: [0.3],     // niet variëren — laag-impact
  longOnly:     [false],   // niet variëren
};

// ═══ Backtest runner (compact versie van scripts/camelot-backtest.js) ═══
function runBacktest(data, params) {
  const allTimes = new Set();
  for (const tok of Object.keys(data)) for (const c of data[tok]) allTimes.add(c.time);
  const sortedTimes = [...allTimes].sort((a, b) => a - b);
  const idx = {}, indCache = {};
  for (const tok of Object.keys(data)) {
    idx[tok] = new Map();
    data[tok].forEach((c, i) => idx[tok].set(c.time, i));
    indCache[tok] = computeIndicators(data[tok]);
  }
  const openPositions = new Map();
  const allTrades = [];

  for (let t = 0; t < sortedTimes.length; t++) {
    const time = sortedTimes[t];
    // Close
    for (const [tok, pos] of [...openPositions.entries()]) {
      const i = idx[tok].get(time);
      if (i == null) continue;
      const bar = data[tok][i];
      let exitPrice = null;
      if (pos.type === 'BUY') {
        if (bar.low <= pos.stop) exitPrice = pos.stop;
        else if (bar.high >= pos.target) exitPrice = pos.target;
      } else {
        if (bar.high >= pos.stop) exitPrice = pos.stop;
        else if (bar.low <= pos.target) exitPrice = pos.target;
      }
      if (exitPrice != null) {
        const dir = pos.type === 'BUY' ? 1 : -1;
        const grossPnl = dir * (exitPrice - pos.entry) * pos.qty;
        const sizeEur = pos.entry * pos.qty;
        const netPnl = applyCosts(grossPnl, sizeEur, 'binance');
        allTrades.push({ token: tok, netPnl, equityAtEntry: pos.equityAtEntry });
        openPositions.delete(tok);
      }
    }
    // Open
    for (const tok of Object.keys(data)) {
      if (openPositions.get(tok)) continue;
      if (openPositions.size >= MAX_POSITIONS) break;
      const i = idx[tok].get(time);
      if (i == null || i >= data[tok].length - 1) continue;
      const sig = genSignal({ candles: data[tok], i, ind: indCache[tok], params });
      if (!sig) continue;
      const next = data[tok][i + 1];
      const entry = next.open;
      const validStop = sig.type === 'BUY' ? sig.stop < entry : sig.stop > entry;
      const validTgt  = sig.type === 'BUY' ? sig.target > entry : sig.target < entry;
      if (!validStop || !validTgt) continue;
      const stopDist = Math.abs(entry - sig.stop);
      if (stopDist <= 0) continue;
      const equity = STARTING_EQUITY + allTrades.reduce((s, t) => s + t.netPnl, 0);
      const riskEur = equity * RISK_PER_TRADE;
      const qty = riskEur / stopDist;
      const sizeEur = qty * entry;
      if (sizeEur > equity * 5 || sizeEur < 1) continue;
      openPositions.set(tok, { type: sig.type, entry, qty, stop: sig.stop, target: sig.target, equityAtEntry: equity });
    }
  }

  // Stats
  const n = allTrades.length;
  if (n < MIN_TRADES) return { n, score: -Infinity, reason: 'too_few_trades' };
  const wins = allTrades.filter(t => t.netPnl > 0);
  const losses = allTrades.filter(t => t.netPnl <= 0);
  const sumWin = wins.reduce((s, t) => s + t.netPnl, 0);
  const sumLoss = Math.abs(losses.reduce((s, t) => s + t.netPnl, 0));
  const totalPnl = sumWin - sumLoss;
  const pf = sumLoss > 0 ? sumWin / sumLoss : (sumWin > 0 ? 5 : 0);
  const rets = allTrades.map(t => t.netPnl / t.equityAtEntry);
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length;
  const sd = Math.sqrt(variance);
  const sharpe = sd > 0 ? mean / sd * Math.sqrt(rets.length) : 0;
  // Composite score: sharpe × pf. Beide moeten positief zijn voor een positieve score.
  const score = sharpe > 0 && pf > 0 ? sharpe * pf : -Math.abs(sharpe * pf);
  return { n, wr: wins.length / n, totalPnl, pf, sharpe, score };
}

// Grid generator
function* combos(grid) {
  const keys = Object.keys(grid);
  const idx = keys.map(() => 0);
  while (true) {
    const obj = {};
    for (let i = 0; i < keys.length; i++) obj[keys[i]] = grid[keys[i]][idx[i]];
    yield obj;
    let pos = keys.length - 1;
    while (pos >= 0) {
      idx[pos]++;
      if (idx[pos] < grid[keys[pos]].length) break;
      idx[pos] = 0;
      pos--;
    }
    if (pos < 0) break;
  }
}

async function main() {
  console.log('═══ Camelot Daily Tuner ═══');
  console.log(`Tokens: ${TOKENS.join(', ')}`);
  console.log(`Window: ${LIMIT} ${INTERVAL} candles (~${(LIMIT / 24).toFixed(0)} days)`);

  // Fetch alle candles 1x
  const data = {};
  for (const tok of TOKENS) {
    try {
      const c = await fetchCandles(tokenToMarket(tok), INTERVAL, LIMIT);
      data[tok] = c;
      process.stdout.write(`  ${tok}: ${c.length} candles\n`);
    } catch (e) { console.log(`  ${tok}: FAILED ${e.message}`); }
  }
  if (Object.keys(data).length === 0) { console.error('No data — abort'); process.exit(1); }

  // Grid sweep
  const totalCombos = Object.values(GRID).reduce((s, a) => s * a.length, 1);
  console.log(`\nSweep: ${totalCombos} combos\n`);
  let best = null;
  let i = 0;
  for (const params of combos(GRID)) {
    i++;
    const r = runBacktest(data, params);
    if (!best || r.score > best.score) {
      best = { ...r, params: { ...params } };
    }
    if (i % 10 === 0) process.stdout.write(`  ${i}/${totalCombos} (best score ${best.score?.toFixed?.(2) ?? best.score})\n`);
  }

  if (!best || !isFinite(best.score)) {
    console.error('No viable params found — keeping previous config');
    process.exit(2);
  }

  console.log('\n═══ Best config ═══');
  console.log(`  Score:   ${best.score.toFixed(3)}`);
  console.log(`  Trades:  ${best.n}`);
  console.log(`  WinRate: ${(best.wr * 100).toFixed(1)}%`);
  console.log(`  PF:      ${best.pf.toFixed(2)}`);
  console.log(`  Sharpe:  ${best.sharpe.toFixed(2)}`);
  console.log(`  PnL:     €${best.totalPnl.toFixed(2)}`);
  console.log(`  Params:  ${JSON.stringify(best.params)}`);

  // Schrijf naar data/camelot-params.json
  const outPath = path.join(__dirname, '..', 'data', 'camelot-params.json');
  const prev = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, 'utf8')) : null;
  const out = {
    _comment: 'Auto-tuned Camelot parameters. Updated dagelijks door scripts/camelot-tuner.js. Manual edits worden bij volgende run overschreven.',
    _updated: new Date().toISOString(),
    _source: 'auto-tuner',
    _score: best.score,
    _stats: {
      trades: best.n, winRate: best.wr, profitFactor: best.pf, sharpe: best.sharpe, totalPnl: best.totalPnl,
      window: `${LIMIT} × ${INTERVAL}`,
      tokens: TOKENS,
    },
    _previousScore: prev?._score ?? null,
    params: best.params,
  };
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
  console.log(`\nWritten → ${outPath}`);

  // Exit 0 zelfs als score lager dan vorige — committer beslist
  if (prev?._score != null && best.score < prev._score) {
    console.log(`⚠ score (${best.score.toFixed(2)}) < previous (${prev._score.toFixed(2)})`);
  } else {
    console.log(`✓ score improved or equal to previous`);
  }
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
