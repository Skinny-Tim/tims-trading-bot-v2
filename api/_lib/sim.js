// ═══ Paper-trade simulator — pure function, gedeeld tussen backtest en live ═══
//
// Dit is de CORE trade-simulatie die identiek is aan paper-engine.js. Door
// deze logic te extraheren naar een pure functie zonder Redis/fetch kunnen
// backtest en live exact dezelfde fills, risk caps, stop/trail/target logic
// gebruiken. Resultaat: backtest = live.
//
// Gebruikt door:
//   paper-engine.js  (live: delegeert open/manage naar eigen code, maar kan
//                     via simulateRun backtest-parity runnen)
//   backtest-agent.js (backtest-parity endpoint)
//
// Input: array van candles per token + signalen van generateSignals()
// Output: { trades, equityCurve, finalBalance, positions, stats }
//
// Geen side-effects; iedere call is deterministisch.

const fills = require('./fills');
const { generateSignals, calc4hLevels, detectElliottWave } = require('./signals');

const DEFAULT_CFG = {
  startBalance: 10000,
  riskPerTrade: 0.01,                  // ↓ 2%→1% (per research: lower risk-per-trade improves Sharpe)
  breakevenAtr: 1.0,
  trailAtrBase: 1.5,
  partialPct: 0.5,
  maxHoldHours: 120,
  minRR: 1.5,                          // ↑ 0.5→1.5 (asymmetric R:R is the #1 lever)
  maxPositions: 10,
  maxCryptoLongs: 4,
  volatilityMaxAtrPct: 0.08,
  kronosVetoPct: 10,
  // portfolio risk caps
  maxPortfolioRisk: 0.06,
  maxPerTokenRisk: 0.03,
  maxCorrelatedRisk: 0.05,
  clusters: { CRYPTO_L1: ['BTC','ETH','SOL','BNB'], XRP_LIKE: ['XRP','XLM','HBAR'] },
  // ── Hardening (mirror live paper-engine.js) ──
  cashBufferPct: 0.25,                 // 25% van startBalance reserveren
  portfolioKillDdPct: 0.05,            // 24h equity-drop >5% → pauze entries
  ema200Regime: true,                  // 4H EMA200 macro filter
  mtfAlignment: true,                  // EMA600(4H) ≈ 1D EMA200 macro-bias check
  blacklist: ['HBAR','XRP','LINK','ADA','DOT','SOL'],  // chronic losers per per-token PnL
  minStars: 4,
};

// Lightweight EMA helper (sim is dependency-light)
function _ema(arr, period) {
  if (!arr || arr.length < period) return null;
  const k = 2 / (period + 1);
  let e = arr.slice(0, period).reduce((s,v)=>s+v,0) / period;
  for (let i = period; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
  return e;
}

function progressiveTrail(profitPct, base) {
  if (profitPct >= 10) return 0.8;
  if (profitPct >= 5) return 1.2;
  return base;
}

function findCluster(token, clusters) {
  for (const [name, members] of Object.entries(clusters || {})) {
    if (members.includes(token)) return name;
  }
  return null;
}

function exposureUsd(positions, { token, cluster, clusters } = {}) {
  let total = 0;
  for (const p of positions) {
    if (token && p.token !== token) continue;
    if (cluster) {
      const members = clusters[cluster] || [];
      if (!members.includes(p.token)) continue;
    }
    total += Math.abs(p.entryPrice - p.initialStop) * p.qty;
  }
  return total;
}

function canOpen(positions, equity, token, riskUsd, cfg) {
  const total = exposureUsd(positions);
  if ((total + riskUsd) > equity * cfg.maxPortfolioRisk) return { ok: false, reason: `portfolio cap ${((total+riskUsd)/equity*100).toFixed(1)}%` };
  const tkn = exposureUsd(positions, { token });
  if ((tkn + riskUsd) > equity * cfg.maxPerTokenRisk) return { ok: false, reason: `token cap ${token}` };
  const cl = findCluster(token, cfg.clusters);
  if (cl) {
    const cle = exposureUsd(positions, { cluster: cl, clusters: cfg.clusters });
    if ((cle + riskUsd) > equity * cfg.maxCorrelatedRisk) return { ok: false, reason: `cluster cap ${cl}` };
  }
  return { ok: true };
}

// ── Main simulator ──
//
// perToken: { [tokenShort]: { candles:[], kronos: {offline,pct,direction,score} } }
// signalsForToken: { [tokenShort]: [ {type:'BUY'|'SELL', index, time, price, stars} ] }
// timestep t = aantal candles (we lopen per-candle synchroon; elk token moet
// gelijke lengte hebben voor fair sim — pad met null als nodig).
//
// Dit is een vereenvoudigde walking-forward simulator: per candle-index i
// bekijken we alle tokens, manage open posities op candles[i].close, en
// openen nieuwe posities als er signaal op exact die candle was.
function simulateRun({ perToken, cfg = {}, ewPerToken = {} }) {
  const C = { ...DEFAULT_CFG, ...cfg };
  const tokens = Object.keys(perToken);
  if (tokens.length === 0) return { trades: [], equityCurve: [], finalBalance: C.startBalance };

  const N = Math.min(...tokens.map(t => perToken[t].candles.length));
  if (N < 60) return { trades: [], equityCurve: [], finalBalance: C.startBalance, error: 'too few candles' };

  const state = { balance: C.startBalance, peakEquity: C.startBalance };
  const positions = [];
  const trades = [];
  const equityCurve = [];
  let peakEquity = C.startBalance;

  // Pre-compute signals per token (via shared engine)
  const sigs = {};
  for (const t of tokens) {
    const k = perToken[t].kronos || { offline: true, score: 0 };
    const kScore = k.offline ? 0 : (k.score || 0);
    const ew = ewPerToken[t] || null;
    sigs[t] = generateSignals(perToken[t].candles, '4h', kScore, ew).markers;
  }

  for (let i = 60; i < N; i++) {
    // 0) Funding accrual per candle-step (4h ≈ 0.5 funding period)
    //    LONG betaalt, SHORT ontvangt
    for (const p of positions) {
      const t0 = perToken[p.token].candles[i-1]?.time || 0;
      const t1 = perToken[p.token].candles[i]?.time || 0;
      const periodMs = Math.max(0, t1 - t0);
      if (periodMs > 0) {
        const amt = fills.computeFunding({ pos: p, periodMs });
        state.balance -= amt;
        p.accruedFunding = (p.accruedFunding || 0) + amt;
      }
    }

    // 1) Manage open posities op candle close
    for (let pi = positions.length - 1; pi >= 0; pi--) {
      const pos = positions[pi];
      const cs = perToken[pos.token].candles;
      if (i >= cs.length) continue;
      const hi = cs[i].high, lo = cs[i].low, close = cs[i].close;
      const atrPctHere = pos.atr && pos.entryPrice ? pos.atr / pos.entryPrice : null;

      // Update water marks
      if (pos.side === 'LONG' && hi > pos.highWaterMark) pos.highWaterMark = hi;
      if (pos.side === 'SHORT' && lo < pos.lowWaterMark) pos.lowWaterMark = lo;

      // Time exit
      const holdH = (cs[i].time - pos.openTime) / 3.6e6;
      if (holdH > C.maxHoldHours) {
        const uPct = pos.side === 'LONG' ? (close - pos.entryPrice)/pos.entryPrice*100 : (pos.entryPrice - close)/pos.entryPrice*100;
        if (uPct < 1.0) {
          const ex = fills.computeExit({ pos, exitSignalPrice: close, reason: 'Time Exit', partialPct: 1.0, atrPct: atrPctHere, stochastic: true });
          const efee = pos.entryFee || 0;
          const netPnl = ex.pnl - efee;
          state.balance += pos.sizeUsd + netPnl;
          trades.push({ ...pos, exitPrice: ex.exitPrice, pnl: netPnl, pnlPct: netPnl/pos.sizeUsd*100, closeTime: cs[i].time, reason: 'Time Exit' });
          positions.splice(pi, 1);
          continue;
        }
      }

      // Break-even
      if (!pos.breakeven && pos.atr > 0) {
        const profit = pos.side === 'LONG' ? close - pos.entryPrice : pos.entryPrice - close;
        if (profit >= pos.atr * C.breakevenAtr) {
          pos.breakeven = true;
          pos.stop = pos.side === 'LONG' ? Math.max(pos.stop, pos.entryPrice + pos.atr*0.1) : Math.min(pos.stop, pos.entryPrice - pos.atr*0.1);
        }
      }

      // Trailing stop
      if (pos.breakeven && pos.atr > 0) {
        const profitPct = pos.side === 'LONG' ? (close - pos.entryPrice)/pos.entryPrice*100 : (pos.entryPrice - close)/pos.entryPrice*100;
        const mult = progressiveTrail(profitPct, C.trailAtrBase);
        if (pos.side === 'LONG') {
          const nt = pos.highWaterMark - pos.atr * mult;
          if (nt > pos.stop) pos.stop = nt;
        } else {
          const nt = pos.lowWaterMark + pos.atr * mult;
          if (nt < pos.stop) pos.stop = nt;
        }
      }

      // Partial target 1
      if (!pos.partialClosed && pos.target1) {
        const hit = pos.side === 'LONG' ? hi >= pos.target1 : lo <= pos.target1;
        if (hit) {
          const ex = fills.computeExit({ pos, exitSignalPrice: pos.target1, reason: 'Target1', partialPct: C.partialPct, atrPct: atrPctHere, stochastic: true });
          const efeeShare = (pos.entryFee || 0) * C.partialPct;
          const netPnl = ex.pnl - efeeShare;
          state.balance += ex.closeSizeUsd + netPnl;
          trades.push({ ...pos, exitPrice: ex.exitPrice, pnl: netPnl, pnlPct: netPnl/ex.closeSizeUsd*100, closeTime: cs[i].time, reason: 'Target1 (50%)' });
          pos.qty -= ex.closeQty; pos.sizeUsd -= ex.closeSizeUsd; pos.partialClosed = true;
          pos.entryFee = (pos.entryFee || 0) - efeeShare;   // rest bewaren voor final close
        }
      }

      // Hard stop / full target — check op intra-candle hi/lo
      const stopHit = pos.side === 'LONG' ? lo <= pos.stop : hi >= pos.stop;
      const tgtHit  = pos.side === 'LONG' ? hi >= pos.target : lo <= pos.target;
      if (stopHit) {
        const ex = fills.computeExit({ pos, exitSignalPrice: pos.stop, reason: pos.breakeven ? 'Trailing' : 'Stop', partialPct: 1.0, atrPct: atrPctHere, stochastic: true });
        const efee = pos.entryFee || 0;
        const netPnl = ex.pnl - efee;
        state.balance += pos.sizeUsd + netPnl;
        trades.push({ ...pos, exitPrice: ex.exitPrice, pnl: netPnl, pnlPct: netPnl/pos.sizeUsd*100, closeTime: cs[i].time, reason: pos.breakeven ? 'Trailing Stop' : 'Stop-Loss' });
        positions.splice(pi, 1);
      } else if (tgtHit) {
        const ex = fills.computeExit({ pos, exitSignalPrice: pos.target, reason: 'Target', partialPct: 1.0, atrPct: atrPctHere, stochastic: true });
        const efee = pos.entryFee || 0;
        const netPnl = ex.pnl - efee;
        state.balance += pos.sizeUsd + netPnl;
        trades.push({ ...pos, exitPrice: ex.exitPrice, pnl: netPnl, pnlPct: netPnl/pos.sizeUsd*100, closeTime: cs[i].time, reason: 'Target Full' });
        positions.splice(pi, 1);
      }
    }

    // 2) Nieuwe signalen openen
    for (const t of tokens) {
      const cs = perToken[t].candles;
      const sigList = sigs[t] || [];
      const sig = sigList.find(s => s.index === i);
      if (!sig) continue;

      const kronos = perToken[t].kronos || { offline: true, pct: 0 };
      const side = sig.type === 'BUY' ? 'LONG' : 'SHORT';
      const signalPrice = cs[i].close;
      const levels = calc4hLevels(cs.slice(0, i+1), sig.type, kronos);

      // ── Universe blacklist (chronic losers) ──
      if (Array.isArray(C.blacklist) && C.blacklist.includes(t)) continue;

      // Filters (zelfde als live)
      const atrPct = levels.atr / signalPrice;
      if (atrPct > C.volatilityMaxAtrPct) continue;
      if (!kronos.offline) {
        if (sig.type === 'BUY' && kronos.pct <= -C.kronosVetoPct) continue;
        if (sig.type === 'SELL' && kronos.pct >= C.kronosVetoPct) continue;
      }

      // ── EMA200(4H) regime filter (mirror live) ──
      if (C.ema200Regime && i >= 200) {
        const closes = cs.slice(0, i+1).map(c => c.close);
        const ema200 = _ema(closes, 200);
        const last = closes[closes.length-1];
        if (ema200 && last) {
          const bull = last > ema200 * 1.005;
          const bear = last < ema200 * 0.995;
          if (sig.type === 'SELL' && bull) continue;
          if (sig.type === 'BUY'  && bear) continue;
        }
      }

      // ── MTF: EMA600(4H) ≈ 1D EMA200 macro-bias ──
      if (C.mtfAlignment && i >= 600) {
        const closes = cs.slice(0, i+1).map(c => c.close);
        const ema600 = _ema(closes, 600);
        const last = closes[closes.length-1];
        if (ema600 && last) {
          const macroBull = last > ema600;
          // Trend-following only: BUY in macro bull, SELL in macro bear
          if (sig.type === 'BUY'  && !macroBull) continue;
          if (sig.type === 'SELL' && macroBull)  continue;
        }
      }

      // ── Portfolio kill-switch: 24h equity-drop >5% → pauze ──
      if (C.portfolioKillDdPct && equityCurve.length > 0) {
        const cutoff = cs[i].time - 24 * 3.6e6;
        const hist = equityCurve.filter(p => p.time >= cutoff);
        if (hist.length > 0) {
          const ref = hist[0].value;
          const cur = equityCurve[equityCurve.length-1].value;
          if (ref > 0 && (ref - cur) / ref >= C.portfolioKillDdPct) continue;
        }
      }

      // ── Cash buffer guard ──
      if (C.cashBufferPct) {
        const floor = C.startBalance * C.cashBufferPct;
        if (state.balance < floor) continue;
      }

      if (side === 'LONG' && positions.filter(p => p.side === 'LONG').length >= C.maxCryptoLongs) continue;

      const rr = Math.abs(levels.uitstap - signalPrice) / Math.max(1e-9, Math.abs(signalPrice - levels.stop));
      // Honor optional cfg.minStars override (default 4)
      const _minStars = (typeof C.minStars === 'number' && C.minStars > 0) ? C.minStars : 4;
      if (sig.stars < _minStars) continue;
      if (rr < C.minRR) continue;
      if (positions.length >= C.maxPositions) continue;
      if (positions.find(p => p.token === t)) continue;

      const entry = fills.computeEntry({
        state, token: t, side, signalPrice, stopPrice: levels.stop, stars: sig.stars,
        riskPct: C.riskPerTrade,
        atrPct: levels.atr / signalPrice,
        stochastic: true,
      });
      if (!entry) continue;

      const equity = state.peakEquity || state.balance;
      const rc = canOpen(positions, equity, t, entry.riskUsd, C);
      if (!rc.ok) continue;

      const target1 = side === 'LONG'
        ? entry.entryPrice + (levels.uitstap - entry.entryPrice) * 0.6
        : entry.entryPrice - (entry.entryPrice - levels.uitstap) * 0.6;

      state.balance -= entry.sizeUsd;
      positions.push({
        id: `${t}_${i}`, token: t, side,
        qty: entry.qty, entryPrice: entry.entryPrice, sizeUsd: entry.sizeUsd,
        stop: levels.stop, initialStop: levels.stop,
        target: levels.uitstap, target1, atr: levels.atr,
        stars: sig.stars, openTime: cs[i].time,
        highWaterMark: entry.entryPrice, lowWaterMark: entry.entryPrice,
        partialClosed: false, breakeven: false,
        entryFee: entry.entryFee,    // voor correcte kostenverrekening bij close
      });
    }

    // 3) Equity snapshot (on most recent close per token)
    let pv = state.balance;
    for (const p of positions) {
      const cs = perToken[p.token].candles;
      const close = cs[i] ? cs[i].close : p.entryPrice;
      if (p.side === 'LONG') pv += p.qty * close;
      else pv += p.sizeUsd + (p.entryPrice - close) * p.qty;
    }
    if (pv > peakEquity) peakEquity = pv;
    state.peakEquity = peakEquity;
    equityCurve.push({ time: perToken[tokens[0]].candles[i].time, value: pv, dd: (peakEquity - pv)/peakEquity });
  }

  // Liquideer open posities op laatste close voor eindrapport
  const lastBalance = (() => {
    let b = state.balance;
    for (const p of positions) {
      const cs = perToken[p.token].candles;
      const close = cs[cs.length - 1].close;
      const atrPctEod = p.atr && p.entryPrice ? p.atr / p.entryPrice : null;
      const ex = fills.computeExit({ pos: p, exitSignalPrice: close, reason: 'EOD', partialPct: 1.0, atrPct: atrPctEod, stochastic: true });
      const efee = p.entryFee || 0;
      b += p.sizeUsd + ex.pnl - efee;
    }
    return b;
  })();

  // Stats
  const wins = trades.filter(t => t.pnl > 0).length;
  const losses = trades.filter(t => t.pnl <= 0).length;
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const winRate = trades.length > 0 ? wins / trades.length : 0;
  const maxDD = equityCurve.reduce((m, e) => Math.max(m, e.dd || 0), 0);

  // ── Hardened risk-adjusted stats ──
  // Profit factor = gross profit / gross loss (1.0 = breakeven; >1.5 = healthy)
  const grossProfit = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(trades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);
  const avgWin = wins > 0 ? grossProfit / wins : 0;
  const avgLoss = losses > 0 ? grossLoss / losses : 0;
  // Expectancy per trade (in $) = winRate*avgWin - (1-winRate)*avgLoss
  const expectancy = trades.length > 0 ? (winRate * avgWin - (1 - winRate) * avgLoss) : 0;

  // Sharpe-achtig metric op TRADE-NIVEAU (returns per trade als % van startBalance).
  // Geannualiseerd door te schalen met sqrt(252 * trades_per_year_estimate).
  // Echte Sharpe vraagt tijdgewogen periode-returns; dit is een proxy die toch
  // volatiliteit penaliseert ten opzichte van pure totalReturn.
  let sharpe = 0;
  if (trades.length >= 2) {
    const tradeReturns = trades.map(t => t.pnl / C.startBalance);
    const mean = tradeReturns.reduce((s, x) => s + x, 0) / tradeReturns.length;
    const variance = tradeReturns.reduce((s, x) => s + (x - mean) ** 2, 0) / (tradeReturns.length - 1);
    const std = Math.sqrt(variance);
    if (std > 0) {
      // Annualisatie: schat aantal trades/jaar op basis van eerste→laatste trade
      const firstT = trades[0].closeTime || trades[0].openTime;
      const lastT = trades[trades.length - 1].closeTime || trades[trades.length - 1].openTime;
      const spanDays = Math.max(1, (lastT - firstT) / 86400000);
      const tradesPerYear = (trades.length / spanDays) * 365;
      sharpe = (mean / std) * Math.sqrt(tradesPerYear);
    }
  }

  // Recovery factor = totaal rendement / max drawdown — "hoeveel ben je
  // gecompenseerd voor je grootste pijn?" (>2.0 = robuust)
  const totalReturnPct = (lastBalance - C.startBalance) / C.startBalance * 100;
  const recoveryFactor = maxDD > 0 ? (totalReturnPct / 100) / maxDD : (totalReturnPct > 0 ? Infinity : 0);

  // Langste drawdown-periode in BARS (via equityCurve dd-veld → consecutive non-zero)
  let longestDdBars = 0;
  let curDdBars = 0;
  for (const e of equityCurve) {
    if ((e.dd || 0) > 0.001) { curDdBars++; if (curDdBars > longestDdBars) longestDdBars = curDdBars; }
    else curDdBars = 0;
  }
  // 4H bars → days approx
  const longestDdDays = +(longestDdBars / 6).toFixed(1);

  // Max consecutive losing trades
  let maxConsecLosses = 0;
  let curConsecLosses = 0;
  for (const t of trades) {
    if (t.pnl <= 0) { curConsecLosses++; if (curConsecLosses > maxConsecLosses) maxConsecLosses = curConsecLosses; }
    else curConsecLosses = 0;
  }

  const stats = {
    trades: trades.length, wins, losses, winRate, totalPnl,
    returnPct: totalReturnPct,
    maxDrawdown: maxDD,
    profitFactor: isFinite(profitFactor) ? +profitFactor.toFixed(3) : 999,
    sharpe: +sharpe.toFixed(3),
    avgWin: +avgWin.toFixed(2),
    avgLoss: +avgLoss.toFixed(2),
    expectancy: +expectancy.toFixed(2),
    recoveryFactor: isFinite(recoveryFactor) ? +recoveryFactor.toFixed(3) : 999,
    longestDdBars,
    longestDdDays,
    maxConsecLosses,
  };
  stats.verdict = computeVerdict(stats);

  return {
    trades, equityCurve,
    openAtEnd: positions,
    finalBalance: lastBalance,
    stats,
  };
}

// ── Verdict gate — beslist of een backtest goed genoeg is voor live promotion ──
// Thresholds zijn bewust streng omdat ze de poort vormen naar real money.
// Alle defaults zijn override-baar via env (geen build nodig om te tunen).
//
// PASS  = alle MUST-criteria gehaald
// WARN  = MUST gehaald, maar ≥1 NICE-TO-HAVE niet → review eerst
// FAIL  = ≥1 MUST faalt → blokkeer live
function computeVerdict(s) {
  const env = (k, def) => {
    const v = parseFloat(process.env[k] || '');
    return isFinite(v) ? v : def;
  };
  const T = {
    minTrades:          env('VERDICT_MIN_TRADES',          30),    // statistische sig
    maxDdPct:           env('VERDICT_MAX_DD_PCT',          0.25),  // 25% absolute cap
    minProfitFactor:    env('VERDICT_MIN_PROFIT_FACTOR',   1.30),
    minSharpe:          env('VERDICT_MIN_SHARPE',          0.80),
    minWinRate:         env('VERDICT_MIN_WIN_RATE',        0.35),  // bij R:R≥1.5 OK
    minRecoveryFactor:  env('VERDICT_MIN_RECOVERY_FACTOR', 1.50),
    minExpectancy:      env('VERDICT_MIN_EXPECTANCY',      0),     // moet positief zijn
  };
  const fails = [];
  const warns = [];

  if (s.trades < T.minTrades) fails.push(`trades ${s.trades} < ${T.minTrades} (statistisch onbetrouwbaar)`);
  if (s.maxDrawdown > T.maxDdPct) fails.push(`maxDD ${(s.maxDrawdown*100).toFixed(1)}% > ${(T.maxDdPct*100).toFixed(0)}%`);
  if (s.expectancy <= T.minExpectancy) fails.push(`expectancy €${s.expectancy.toFixed(2)} ≤ €${T.minExpectancy.toFixed(2)} (geen edge)`);
  if (s.profitFactor < T.minProfitFactor) fails.push(`profitFactor ${s.profitFactor.toFixed(2)} < ${T.minProfitFactor}`);

  if (s.sharpe < T.minSharpe) warns.push(`sharpe ${s.sharpe.toFixed(2)} < ${T.minSharpe} (volatiel)`);
  if (s.winRate < T.minWinRate) warns.push(`winRate ${(s.winRate*100).toFixed(1)}% < ${(T.minWinRate*100).toFixed(0)}% (veel verliesstreaks)`);
  if (s.recoveryFactor < T.minRecoveryFactor) warns.push(`recoveryFactor ${s.recoveryFactor.toFixed(2)} < ${T.minRecoveryFactor}`);

  let level;
  if (fails.length > 0) level = 'FAIL';
  else if (warns.length > 0) level = 'WARN';
  else level = 'PASS';

  return {
    level,
    pass: level === 'PASS',
    promotable: level !== 'FAIL',     // WARN nog promotable mits review
    fails,
    warns,
    thresholds: T,
  };
}

module.exports = { simulateRun, DEFAULT_CFG, canOpen, exposureUsd, computeVerdict };
