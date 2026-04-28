#!/usr/bin/env node
// ═══ Camelot Backtest ═══
// Replays the regime-switching Camelot strategy on Binance 1H candles.
// Honest verdict on edge after ~30 bps round-trip costs.

const path = require('path');
const { fetchCandles, tokenToMarket } = require(path.join(__dirname, '..', 'api', '_lib', 'binance-public.js'));
const { computeIndicators, genSignal, applyCosts } = require(path.join(__dirname, '..', 'api', '_lib', 'camelot-strategy.js'));

const TOKENS    = (process.env.CAMELOT_TOKENS || 'BTC,ETH,SOL,BNB,XRP,AVAX,LINK,DOGE').split(',');
const INTERVAL  = process.env.CAMELOT_INTERVAL || '1h';
const LIMIT     = parseInt(process.env.CAMELOT_LIMIT || '1000', 10);
const STARTING_EQUITY = 10000;     // EUR/USDT
const RISK_PER_TRADE  = parseFloat(process.env.CAMELOT_RISK || '0.01');
const MAX_POSITIONS   = parseInt(process.env.CAMELOT_MAX_POS || '5', 10);
const EXCHANGE        = 'binance';

// ── Trade simulator (per token, OHLC bar replay) ──
// Once a signal fires on bar i (close), we open at NEXT bar's open (i+1).
// On each subsequent bar we check intrabar:
//   LONG:  if low <= stop → stop hit (fill at stop). If high >= target → target hit (fill at target).
//   SHORT: mirror.
// If both hit in same bar → assume worst case (stop wins).
// Force-close at last bar at close.

function simulateToken(token, candles, openPositions, allTrades) {
  const ind = computeIndicators(candles);
  // Per-token open positions tracked centrally so portfolio-level cap works.
  // We expose a closure helper bound to this token.

  for (let i = 0; i < candles.length - 1; i++) {
    const bar = candles[i];
    // 1) Close any open position for THIS token using current bar's OHLC
    const open = openPositions.get(token);
    if (open) {
      let exitPrice = null;
      let reason = null;
      if (open.type === 'BUY') {
        // Stop first (worst case)
        if (bar.low <= open.stop) {
          exitPrice = open.stop;
          reason = 'stop';
        } else if (bar.high >= open.target) {
          exitPrice = open.target;
          reason = 'target';
        }
      } else {
        if (bar.high >= open.stop) {
          exitPrice = open.stop;
          reason = 'stop';
        } else if (bar.low <= open.target) {
          exitPrice = open.target;
          reason = 'target';
        }
      }
      if (exitPrice != null) {
        const dir = open.type === 'BUY' ? 1 : -1;
        const grossPnl = dir * (exitPrice - open.entry) * open.qty;
        const sizeEur  = open.entry * open.qty;
        const netPnl   = applyCosts(grossPnl, sizeEur, EXCHANGE);
        allTrades.push({
          token, type: open.type, regime: open.regime,
          entryTime: open.entryTime, exitTime: bar.time,
          entry: open.entry, exit: exitPrice, qty: open.qty,
          stop: open.stop, target: open.target,
          grossPnl, netPnl, sizeEur, reason,
          equityAtEntry: open.equityAtEntry,
        });
        openPositions.delete(token);
      }
    }

    // 2) If no open pos for this token AND room in portfolio → check signal on this bar
    if (!openPositions.get(token) && countOpen(openPositions) < MAX_POSITIONS) {
      const sig = genSignal({ candles, i, ind });
      if (sig) {
        // Open at NEXT bar's open
        const next = candles[i + 1];
        if (!next) continue;
        const entry = next.open;
        // Sanity: stop must be on correct side of entry
        const validStop = sig.type === 'BUY' ? sig.stop < entry : sig.stop > entry;
        const validTgt  = sig.type === 'BUY' ? sig.target > entry : sig.target < entry;
        if (!validStop || !validTgt) continue;

        const stopDist = Math.abs(entry - sig.stop);
        if (stopDist <= 0) continue;

        // Equity-at-risk sizing: 1% equity / stopDist
        // We approximate equity as the marked-to-bar equity from the trade log.
        const equity = currentEquity(allTrades, openPositions);
        const riskEur = equity * RISK_PER_TRADE;
        const qty = riskEur / stopDist;
        const sizeEur = qty * entry;
        // Skip absurd sizes (e.g., size > equity * 5 = leverage)
        if (sizeEur > equity * 5 || sizeEur < 1) continue;

        openPositions.set(token, {
          type: sig.type, regime: sig.regime,
          entry, qty, stop: sig.stop, target: sig.target,
          entryTime: next.time, atr: sig.atr,
          equityAtEntry: equity,
        });
      }
    }
  }

  // Force-close any remaining position at final bar close
  const last = candles[candles.length - 1];
  const open = openPositions.get(token);
  if (open && last) {
    const dir = open.type === 'BUY' ? 1 : -1;
    const grossPnl = dir * (last.close - open.entry) * open.qty;
    const sizeEur = open.entry * open.qty;
    const netPnl = applyCosts(grossPnl, sizeEur, EXCHANGE);
    allTrades.push({
      token, type: open.type, regime: open.regime,
      entryTime: open.entryTime, exitTime: last.time,
      entry: open.entry, exit: last.close, qty: open.qty,
      stop: open.stop, target: open.target,
      grossPnl, netPnl, sizeEur, reason: 'eof',
      equityAtEntry: open.equityAtEntry,
    });
    openPositions.delete(token);
  }
}

function countOpen(map) { return map.size; }

function currentEquity(trades, openMap) {
  let eq = STARTING_EQUITY;
  for (const t of trades) eq += t.netPnl;
  // Note: open positions floated at entry equity, no MTM here (good enough for sizing).
  return eq;
}

// ── Stats ──
function stats(trades, label) {
  if (!trades.length) return { label, n: 0 };
  const wins = trades.filter(t => t.netPnl > 0);
  const losses = trades.filter(t => t.netPnl <= 0);
  const sumWin = wins.reduce((s, t) => s + t.netPnl, 0);
  const sumLoss = Math.abs(losses.reduce((s, t) => s + t.netPnl, 0));
  const totalPnl = sumWin - sumLoss;
  const avgWin = wins.length ? sumWin / wins.length : 0;
  const avgLoss = losses.length ? sumLoss / losses.length : 0;
  const wr = wins.length / trades.length;
  const pf = sumLoss > 0 ? sumWin / sumLoss : (sumWin > 0 ? Infinity : 0);
  // Sharpe on trade-by-trade returns (not annualized — quick & dirty)
  const rets = trades.map(t => t.netPnl / t.equityAtEntry);
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length;
  const sd = Math.sqrt(variance);
  const sharpe = sd > 0 ? mean / sd * Math.sqrt(rets.length) : 0;  // sqrt(N) trade-Sharpe
  return {
    label, n: trades.length, wr, avgWin, avgLoss, pf, totalPnl,
    sumWin, sumLoss, sharpe,
  };
}

function maxDrawdown(equityCurve) {
  let peak = equityCurve[0] || STARTING_EQUITY;
  let mdd = 0;
  for (const e of equityCurve) {
    if (e > peak) peak = e;
    const dd = (peak - e) / peak;
    if (dd > mdd) mdd = dd;
  }
  return mdd;
}

function fmt(n, d = 2) {
  if (!isFinite(n)) return '∞';
  return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

function printRow(s) {
  if (!s.n) {
    console.log(`  ${s.label.padEnd(10)} | trades:   0`);
    return;
  }
  console.log(
    `  ${s.label.padEnd(10)} | n:${String(s.n).padStart(4)} | WR:${(s.wr * 100).toFixed(1).padStart(5)}% ` +
    `| avgW:€${fmt(s.avgWin).padStart(8)} | avgL:€${fmt(s.avgLoss).padStart(8)} ` +
    `| PF:${fmt(s.pf).padStart(5)} | PnL:€${fmt(s.totalPnl).padStart(9)} | Sh:${fmt(s.sharpe).padStart(5)}`
  );
}

// ── Main ──
async function main() {
  console.log('═══ Camelot Backtest — Bitvavo 1H ═══');
  console.log(`Tokens: ${TOKENS.join(', ')}`);
  console.log(`Candles: ${LIMIT} per token (~${(LIMIT / 24).toFixed(0)} days)`);
  console.log(`Costs: 10 bps fee + 5 bps slip per leg = 30 bps RT (Binance)`);
  console.log(`Sizing: ${RISK_PER_TRADE * 100}% risk/trade, max ${MAX_POSITIONS} positions`);
  console.log(`Starting equity: €${STARTING_EQUITY}\n`);

  // Fetch all candles
  console.log('Fetching candles...');
  const data = {};
  for (const tok of TOKENS) {
    try {
      const c = await fetchCandles(tokenToMarket(tok), INTERVAL, LIMIT);
      data[tok] = c;
      const startDate = new Date(c[0].time).toISOString().slice(0, 10);
      const endDate = new Date(c[c.length - 1].time).toISOString().slice(0, 10);
      console.log(`  ${tok}: ${c.length} candles (${startDate} → ${endDate})`);
    } catch (e) {
      console.log(`  ${tok}: FAILED ${e.message}`);
    }
  }
  console.log();

  // Replay chronologically across tokens. Since portfolio-level position cap
  // requires time-synchronized iteration, we merge candle streams by timestamp.
  // Build a unified bar index (all 1H bars are aligned at :00).
  const allTimes = new Set();
  for (const tok of TOKENS) {
    if (!data[tok]) continue;
    for (const c of data[tok]) allTimes.add(c.time);
  }
  const sortedTimes = [...allTimes].sort((a, b) => a - b);

  // Index per token: time → candle index
  const idx = {};
  const indCache = {};
  for (const tok of TOKENS) {
    if (!data[tok]) continue;
    idx[tok] = new Map();
    data[tok].forEach((c, i) => idx[tok].set(c.time, i));
    indCache[tok] = computeIndicators(data[tok]);
  }

  const openPositions = new Map();   // token → position
  const allTrades = [];
  const equityCurve = [STARTING_EQUITY];

  for (let t = 0; t < sortedTimes.length; t++) {
    const time = sortedTimes[t];

    // 1) Close any open positions hitting stop/target on this bar
    for (const [tok, pos] of [...openPositions.entries()]) {
      const i = idx[tok].get(time);
      if (i == null) continue;
      const bar = data[tok][i];
      let exitPrice = null, reason = null;
      if (pos.type === 'BUY') {
        if (bar.low <= pos.stop) { exitPrice = pos.stop; reason = 'stop'; }
        else if (bar.high >= pos.target) { exitPrice = pos.target; reason = 'target'; }
      } else {
        if (bar.high >= pos.stop) { exitPrice = pos.stop; reason = 'stop'; }
        else if (bar.low <= pos.target) { exitPrice = pos.target; reason = 'target'; }
      }
      if (exitPrice != null) {
        const dir = pos.type === 'BUY' ? 1 : -1;
        const grossPnl = dir * (exitPrice - pos.entry) * pos.qty;
        const sizeEur = pos.entry * pos.qty;
        const netPnl = applyCosts(grossPnl, sizeEur, EXCHANGE);
        allTrades.push({
          token: tok, type: pos.type, regime: pos.regime,
          entryTime: pos.entryTime, exitTime: bar.time,
          entry: pos.entry, exit: exitPrice, qty: pos.qty,
          stop: pos.stop, target: pos.target,
          grossPnl, netPnl, sizeEur, reason,
          equityAtEntry: pos.equityAtEntry,
        });
        openPositions.delete(tok);
      }
    }

    // 2) Generate new signals on each token (using bar i, open at i+1)
    for (const tok of TOKENS) {
      if (!data[tok]) continue;
      if (openPositions.get(tok)) continue;
      if (openPositions.size >= MAX_POSITIONS) break;
      const i = idx[tok].get(time);
      if (i == null || i >= data[tok].length - 1) continue;
      const sig = genSignal({ candles: data[tok], i, ind: indCache[tok] });
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

      openPositions.set(tok, {
        type: sig.type, regime: sig.regime,
        entry, qty, stop: sig.stop, target: sig.target,
        entryTime: next.time, atr: sig.atr,
        equityAtEntry: equity,
      });
    }

    // Track equity curve at end-of-bar
    const eq = STARTING_EQUITY + allTrades.reduce((s, t) => s + t.netPnl, 0);
    equityCurve.push(eq);
  }

  // Force-close any leftover at very last bar
  for (const [tok, pos] of [...openPositions.entries()]) {
    const last = data[tok][data[tok].length - 1];
    if (!last) continue;
    const dir = pos.type === 'BUY' ? 1 : -1;
    const grossPnl = dir * (last.close - pos.entry) * pos.qty;
    const sizeEur = pos.entry * pos.qty;
    const netPnl = applyCosts(grossPnl, sizeEur, EXCHANGE);
    allTrades.push({
      token: tok, type: pos.type, regime: pos.regime,
      entryTime: pos.entryTime, exitTime: last.time,
      entry: pos.entry, exit: last.close, qty: pos.qty,
      stop: pos.stop, target: pos.target,
      grossPnl, netPnl, sizeEur, reason: 'eof',
      equityAtEntry: pos.equityAtEntry,
    });
  }

  // ── Stats ──
  console.log('─── Per Token ───');
  for (const tok of TOKENS) {
    const ts = allTrades.filter(x => x.token === tok);
    printRow(stats(ts, tok));
  }

  console.log('\n─── Per Regime ───');
  printRow(stats(allTrades.filter(t => t.regime === 'RANGE'), 'RANGE'));
  printRow(stats(allTrades.filter(t => t.regime === 'TREND'), 'TREND'));

  console.log('\n─── Per Side ───');
  printRow(stats(allTrades.filter(t => t.type === 'BUY'), 'LONG'));
  printRow(stats(allTrades.filter(t => t.type === 'SELL'), 'SHORT'));

  console.log('\n─── Portfolio ───');
  const portStats = stats(allTrades, 'TOTAL');
  printRow(portStats);
  const finalEq = STARTING_EQUITY + allTrades.reduce((s, t) => s + t.netPnl, 0);
  const ret = (finalEq / STARTING_EQUITY - 1) * 100;
  const mdd = maxDrawdown(equityCurve) * 100;
  console.log(`  Final equity: €${fmt(finalEq)} (return ${fmt(ret)}%)`);
  console.log(`  Max DD: ${fmt(mdd)}%`);

  // Exit-reason breakdown
  const byReason = {};
  for (const t of allTrades) {
    byReason[t.reason] = (byReason[t.reason] || 0) + 1;
  }
  console.log(`  Exit reasons: ${JSON.stringify(byReason)}`);

  // Bars-in-market (rough)
  const totalBars = sortedTimes.length;
  console.log(`  Total bars: ${totalBars}, trades: ${allTrades.length}, freq: 1 trade per ${(totalBars / Math.max(1, allTrades.length)).toFixed(1)} bars`);

  // Gross-vs-net to show cost drag
  const gross = allTrades.reduce((s, t) => s + t.grossPnl, 0);
  const net   = allTrades.reduce((s, t) => s + t.netPnl, 0);
  console.log(`  Gross PnL: €${fmt(gross)} | Net PnL: €${fmt(net)} | Cost drag: €${fmt(gross - net)}`);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
