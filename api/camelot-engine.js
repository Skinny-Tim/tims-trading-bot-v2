// ═══ Camelot Paper-Trade Engine ═══
//
// Regime-switching mean-reversion + momentum bot voor Binance spot (USDT pairs).
// Eigen Redis-namespace: camelot:*  (geen overlap met Merlin paper-engine).
// Venue: Binance — taker 10 bps, dieper boek + tighter spreads dan Bitvavo.
//
// Endpoints:
//   GET /api/camelot-engine?action=tick     — run één cycle (cron)
//   GET /api/camelot-engine?action=state    — dashboard data
//   GET /api/camelot-engine?action=reset    — wipe state (dev)
//   GET /api/camelot-engine?action=signals  — preview huidige signalen (debug)
//
// Cron: every 30 min (1H candle bot, geen 4H drift)

const redis = require('./_lib/redis');
const bn = require('./_lib/binance-public');
const camelot = require('./_lib/camelot-strategy');

const BOT = 'camelot';
const NS = 'camelot';                 // Redis namespace
const VENUE = 'binance';
const START_BALANCE = 10000;
const RISK_PER_TRADE = 0.01;          // 1%
const MAX_POSITIONS = 5;
const MAX_HOLD_HOURS = 48;            // 1H bot — kortere holds dan 4H Elliott
const TIMEFRAME = '1h';
const CANDLE_LIMIT = 300;

// Tokens — high volume USDT pairs op Binance
const TOKENS = [
  { short: 'BTC',  market: 'BTCUSDT'  },
  { short: 'ETH',  market: 'ETHUSDT'  },
  { short: 'SOL',  market: 'SOLUSDT'  },
  { short: 'BNB',  market: 'BNBUSDT'  },
  { short: 'XRP',  market: 'XRPUSDT'  },
  { short: 'AVAX', market: 'AVAXUSDT' },
  { short: 'LINK', market: 'LINKUSDT' },
  { short: 'DOGE', market: 'DOGEUSDT' },
  // ── Universe-uitbreiding (Phase 2, 2026-04-23) ──
  { short: 'SUI',  market: 'SUIUSDT'  },
  { short: 'TRX',  market: 'TRXUSDT'  },  // TRON (Binance ticker = TRX)
  // 2026-04-23 add-on: XLM (Stellar) — Spot $8.9M/24h, Top-30
  { short: 'XLM',  market: 'XLMUSDT'  },
];

// ── State helpers (Redis) ──
const KEY_STATE = `${NS}:state`;
const KEY_POS = `${NS}:positions`;
const KEY_TRADES = `${NS}:trades`;
const KEY_EQUITY = `${NS}:equity`;

async function loadState() {
  const s = await redis.get(KEY_STATE);
  if (!s) {
    const init = { balance: START_BALANCE, startBalance: START_BALANCE, peakEquity: START_BALANCE, lastTickTs: null, ticks: 0 };
    await redis.set(KEY_STATE, init);
    return init;
  }
  return s;
}
async function saveState(s) { return redis.set(KEY_STATE, s); }
async function loadPositions() {
  const p = await redis.get(KEY_POS);
  return p || {};
}
async function savePositions(p) { return redis.set(KEY_POS, p); }
async function recordTrade(t) {
  await redis.lpush(KEY_TRADES, t);
  await redis.ltrim(KEY_TRADES, 0, 499);
}
async function loadTrades(n = 200) {
  return (await redis.lrange(KEY_TRADES, 0, n - 1)) || [];
}
async function pushEquity(point) {
  await redis.lpush(KEY_EQUITY, point);
  await redis.ltrim(KEY_EQUITY, 0, 999);
}
async function loadEquity(n = 500) {
  return (await redis.lrange(KEY_EQUITY, 0, n - 1)) || [];
}

// ── Sizing ──
// risk = 1% of equity, position = risk / stop-distance, capped at 25% equity
function computeSize(equity, entryPrice, stopPrice) {
  const risk = equity * RISK_PER_TRADE;
  const stopDist = Math.abs(entryPrice - stopPrice);
  if (stopDist <= 0) return null;
  const qty = risk / stopDist;
  let sizeEur = qty * entryPrice;
  const cap = equity * 0.25;
  if (sizeEur > cap) {
    sizeEur = cap;
    return { qty: cap / entryPrice, sizeEur, riskEur: (cap / entryPrice) * stopDist };
  }
  return { qty, sizeEur, riskEur: risk };
}

// ── Open ──
async function tryOpen(state, positions, token, sig, entryPrice) {
  if (Object.keys(positions).length >= MAX_POSITIONS) return { ok: false, reason: 'max positions' };
  if (positions[token.short]) return { ok: false, reason: 'already open' };
  const equity = state.peakEquity || state.balance;
  const sz = computeSize(equity, entryPrice, sig.stop);
  if (!sz) return { ok: false, reason: 'invalid sizing' };
  if (sz.sizeEur > state.balance) return { ok: false, reason: 'insufficient cash' };

  const id = `${token.short}_${Date.now()}`;
  const side = sig.type === 'BUY' ? 'LONG' : 'SHORT';
  // Spot can't naturally short — for paper we simulate via synthetic
  // (LONG-only mode would be safer for live; we keep SHORT for sim parity)
  const entryFee = sz.sizeEur * camelot.COSTS.binanceTakerBps / 10000;
  state.balance -= sz.sizeEur + entryFee;

  const pos = {
    id, bot: BOT, token: token.short, side,
    qty: sz.qty, entryPrice, sizeUsd: sz.sizeEur,
    stop: sig.stop, initialStop: sig.stop, target: sig.target, atr: sig.atr,
    regime: sig.regime, rationale: sig.rationale,
    openTime: Date.now(),
    highWaterMark: entryPrice, lowWaterMark: entryPrice,
    breakeven: false, trailActive: false,
    entryFee,
    riskEur: sz.riskEur,
  };
  positions[token.short] = pos;
  return { ok: true, pos };
}

// ── Manage ──
// Returns true if we just activated trail this tick (skip stop check this tick)
function maybeUpdateTrail(pos, lastPrice) {
  const r = pos.riskEur || (Math.abs(pos.entryPrice - pos.initialStop) * pos.qty);
  const profitEur = pos.side === 'LONG' ? (lastPrice - pos.entryPrice) * pos.qty : (pos.entryPrice - lastPrice) * pos.qty;
  let justActivated = false;
  if (!pos.trailActive && profitEur >= 1.5 * r) {
    pos.trailActive = true;
    pos.stop = pos.side === 'LONG' ? Math.max(pos.stop, pos.entryPrice) : Math.min(pos.stop, pos.entryPrice);
    pos.breakeven = true;
    justActivated = true;     // skip stop check op deze tick — anders bar-low triggers immediately
  }
  if (pos.trailActive && pos.atr > 0) {
    if (pos.side === 'LONG') {
      const newStop = pos.highWaterMark - 1.0 * pos.atr;
      if (newStop > pos.stop) pos.stop = newStop;
    } else {
      const newStop = pos.lowWaterMark + 1.0 * pos.atr;
      if (newStop < pos.stop) pos.stop = newStop;
    }
  }
  return justActivated;
}

async function tryClose(state, positions, pos, exitPrice, reason) {
  const grossPnl = pos.side === 'LONG'
    ? (exitPrice - pos.entryPrice) * pos.qty
    : (pos.entryPrice - exitPrice) * pos.qty;
  const exitFee = (pos.qty * exitPrice) * camelot.COSTS.binanceTakerBps / 10000;
  // entryFee already deducted from balance at open
  const netPnl = grossPnl - exitFee;

  state.balance += pos.sizeUsd + netPnl;

  const trade = {
    id: pos.id, bot: BOT, token: pos.token, side: pos.side,
    qty: pos.qty, entryPrice: pos.entryPrice, exitPrice,
    sizeUsd: pos.sizeUsd, regime: pos.regime, stars: pos.regime === 'TREND' ? 4 : 3,
    pnl: netPnl, pnlPct: (netPnl / pos.sizeUsd) * 100,
    fees: pos.entryFee + exitFee,
    openTime: pos.openTime, closeTime: Date.now(),
    reason, rationale: pos.rationale,
  };
  await recordTrade(trade);
  delete positions[pos.token];
  return trade;
}

// ── Tick: main loop ──
async function tick({ verbose = false } = {}) {
  const log = (m) => verbose && console.log(`[Camelot] ${m}`);
  const state = await loadState();
  const positions = await loadPositions();
  const tradesOpened = [];
  const tradesClosed = [];
  const skipped = [];

  // Fetch all candles + tickers in parallel
  const tickers = await bn.fetchAllTickers().catch(() => ({}));
  const dataPromises = TOKENS.map(async t => {
    try {
      const candles = await bn.fetchCandles(t.market, TIMEFRAME, CANDLE_LIMIT);
      return { token: t, candles };
    } catch (e) {
      log(`fetch fail ${t.short}: ${e.message}`);
      return { token: t, candles: null };
    }
  });
  const fetched = await Promise.all(dataPromises);

  // 1) Manage open positions on latest candle
  for (const { token, candles } of fetched) {
    const pos = positions[token.short];
    if (!pos || !candles || candles.length < 2) continue;
    const last = candles[candles.length - 1];
    const livePrice = tickers[token.market] || last.close;
    const high = Math.max(last.high, livePrice);
    const low = Math.min(last.low, livePrice);

    if (pos.side === 'LONG' && high > pos.highWaterMark) pos.highWaterMark = high;
    if (pos.side === 'SHORT' && low < pos.lowWaterMark) pos.lowWaterMark = low;

    // Time exit
    const holdH = (Date.now() - pos.openTime) / 3.6e6;
    if (holdH > MAX_HOLD_HOURS) {
      const tr = await tryClose(state, positions, pos, livePrice, 'Time Exit');
      tradesClosed.push(tr);
      log(`time-exit ${pos.token} ${pos.side} pnl €${tr.pnl.toFixed(2)}`);
      continue;
    }

    maybeUpdateTrail(pos, livePrice);

    // Stop hit (intra-bar)
    const stopHit = pos.side === 'LONG' ? low <= pos.stop : high >= pos.stop;
    const tgtHit = pos.side === 'LONG' ? high >= pos.target : low <= pos.target;
    if (stopHit) {
      const tr = await tryClose(state, positions, pos, pos.stop, pos.trailActive ? 'Trailing Stop' : 'Stop-Loss');
      tradesClosed.push(tr);
      log(`stop ${pos.token} ${pos.side} pnl €${tr.pnl.toFixed(2)}`);
    } else if (tgtHit) {
      const tr = await tryClose(state, positions, pos, pos.target, 'Target');
      tradesClosed.push(tr);
      log(`target ${pos.token} ${pos.side} pnl €${tr.pnl.toFixed(2)}`);
    }
  }

  // ── Optional env-based kill-switch (geen UI toggle: Camelot zit niet in de
  // /trading bot-selector; eigen page /camelot heeft zijn eigen lifecycle).
  // Zet CAMELOT_ENABLED=0 in Vercel om Camelot stil te zetten zonder code-deploy.
  const camelotEnabled = (process.env.CAMELOT_ENABLED || '1') !== '0';
  if (!camelotEnabled) log('⏸ Camelot DISABLED via CAMELOT_ENABLED=0 env — geen nieuwe entries');

  // 2) Generate new entries
  for (const { token, candles } of fetched) {
    if (!camelotEnabled) { skipped.push(`${token.short}: DISABLED via env`); continue; }
    if (!candles || candles.length < 100) continue;
    if (positions[token.short]) continue;
    if (Object.keys(positions).length >= MAX_POSITIONS) {
      skipped.push(`${token.short}: max positions`);
      continue;
    }
    const ind = camelot.computeIndicators(candles);
    const i = candles.length - 1;
    const sig = camelot.genSignal({ candles, i, ind });
    if (!sig) continue;
    const entryPrice = tickers[token.market] || candles[i].close;

    // ── Flow filter: skip trades die tegen de stroom in gaan ──
    // CAMELOT_FLOW_FILTER=0 om uit te zetten. Threshold via CAMELOT_FLOW_THRESHOLD (default 0.5).
    if ((process.env.CAMELOT_FLOW_FILTER || '1') !== '0') {
      try {
        const flow = require('./_lib/flow-data.js');
        const flowData = await flow.getFlow(token.market).catch(() => null);
        if (flowData) {
          const threshold = parseFloat(process.env.CAMELOT_FLOW_THRESHOLD || '0.5');
          const check = flow.checkFlowFilter(sig.type, flowData.score, threshold);
          if (!check.allow) {
            skipped.push(`${token.short}: ${check.reason}`);
            log(`skip ${token.short} ${sig.type}: ${check.reason}`);
            continue;
          }
        }
      } catch (e) {
        // Flow data optioneel — bij failure gewoon doorgaan met signal
        log(`flow-check ${token.short} err: ${e.message}`);
      }
    }

    // Spot reality: only take SHORTs in TREND regime (range fades are higher confidence,
    // but spot can't short — paper sim only)
    const r = await tryOpen(state, positions, token, sig, entryPrice);
    if (r.ok) {
      tradesOpened.push(r.pos);
      log(`open ${token.short} ${sig.type} ${sig.regime} @ €${entryPrice} stop €${sig.stop.toFixed(4)} tgt €${sig.target.toFixed(4)}`);
    } else {
      skipped.push(`${token.short}: ${r.reason}`);
    }
  }

  // 3) Equity snapshot
  let pv = state.balance;
  for (const p of Object.values(positions)) {
    const live = tickers[`${p.token}USDT`] || p.entryPrice;
    if (p.side === 'LONG') pv += p.qty * live;
    else pv += p.sizeUsd + (p.entryPrice - live) * p.qty;
  }
  if (pv > (state.peakEquity || 0)) state.peakEquity = pv;
  state.lastTickTs = Date.now();
  state.ticks = (state.ticks || 0) + 1;
  await pushEquity({ time: Date.now(), value: pv, dd: state.peakEquity > 0 ? (state.peakEquity - pv) / state.peakEquity : 0 });

  await savePositions(positions);
  await saveState(state);

  return {
    ok: true,
    ts: state.lastTickTs,
    opened: tradesOpened.map(p => ({ token: p.token, side: p.side, regime: p.regime, entry: p.entryPrice, stop: p.stop, target: p.target })),
    closed: tradesClosed.map(t => ({ token: t.token, side: t.side, pnl: t.pnl, reason: t.reason })),
    skipped: skipped.slice(0, 10),
    portfolioValue: pv,
    balance: state.balance,
    openCount: Object.keys(positions).length,
  };
}

// ── Public-facing state for dashboard ──
async function getStateForDashboard() {
  const [state, positions, trades, equity] = await Promise.all([
    loadState(),
    loadPositions(),
    loadTrades(200),
    loadEquity(500),
  ]);
  const tickers = await bn.fetchAllTickers().catch(() => ({}));
  const posArr = Object.values(positions).map(p => {
    const live = tickers[`${p.token}USDT`] || p.entryPrice;
    const upPnl = p.side === 'LONG' ? (live - p.entryPrice) * p.qty : (p.entryPrice - live) * p.qty;
    return { ...p, livePrice: live, unrealizedPnl: upPnl, unrealizedPct: (upPnl / p.sizeUsd) * 100 };
  });
  let pv = state.balance;
  for (const p of posArr) {
    if (p.side === 'LONG') pv += p.qty * p.livePrice;
    else pv += p.sizeUsd + (p.entryPrice - p.livePrice) * p.qty;
  }
  // Stats
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalPnl = trades.reduce((s, t) => s + (t.pnl || 0), 0);
  const stats = {
    trades: trades.length,
    wins: wins.length, losses: losses.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    totalPnl,
    avgWin: wins.length ? wins.reduce((s,t)=>s+t.pnl,0)/wins.length : 0,
    avgLoss: losses.length ? losses.reduce((s,t)=>s+t.pnl,0)/losses.length : 0,
    profitFactor: losses.length && wins.length ? Math.abs(wins.reduce((s,t)=>s+t.pnl,0) / losses.reduce((s,t)=>s+t.pnl,0)) : 0,
    returnPct: ((pv - state.startBalance) / state.startBalance) * 100,
    maxDrawdown: state.peakEquity > 0 ? (state.peakEquity - pv) / state.peakEquity : 0,
  };
  // Tuned-params status — toont aan dashboard of getunede config nu actief is,
  // of dat we teruggevallen zijn op env/defaults door losing-strategy guard.
  const tunedMeta = camelot.getTunedParamsMeta ? camelot.getTunedParamsMeta() : null;
  return { state, positions: posArr, trades, equity: equity.slice().reverse(), portfolioValue: pv, stats, tickers, tunedMeta };
}

// ── HTTP handler ──
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (!redis.isConfigured()) return res.status(503).json({ error: 'Redis not configured' });
  const action = (req.query?.action || 'state').toLowerCase();

  try {
    if (action === 'tick') {
      const lock = await redis.setNxEx(`${NS}:lock:tick`, '1', 50);
      if (!lock) return res.status(200).json({ ok: false, skipped: 'tick lock active' });
      const out = await tick({ verbose: true });
      return res.status(200).json(out);
    }
    if (action === 'state') {
      const data = await getStateForDashboard();
      return res.status(200).json({ ok: true, ts: new Date().toISOString(), ...data });
    }
    if (action === 'signals') {
      // Preview current signals (no state change)
      const out = [];
      for (const t of TOKENS) {
        try {
          const c = await bn.fetchCandles(t.market, TIMEFRAME, CANDLE_LIMIT);
          if (!c || c.length < 100) continue;
          const ind = camelot.computeIndicators(c);
          const i = c.length - 1;
          const sig = camelot.genSignal({ candles: c, i, ind });
          out.push({
            token: t.short,
            close: c[i].close,
            adx: ind.adx[i]?.toFixed(1),
            rsi: ind.rsi[i]?.toFixed(1),
            regime: camelot.detectRegime(ind.adx[i]),
            signal: sig,
          });
        } catch (e) { out.push({ token: t.short, error: e.message }); }
      }
      return res.status(200).json({ ok: true, signals: out });
    }
    if (action === 'flow') {
      // Per-token flow snapshot (funding, top-trader L/S, taker buy/sell, OB imbalance).
      const flow = require('./_lib/flow-data.js');
      const out = {};
      await Promise.all(TOKENS.map(async t => {
        try {
          const f = await flow.getFlow(t.market);
          out[t.short] = {
            score: f.score,
            components: f.components,
            funding: f.raw.funding?.lastFundingRate ?? null,
            longShortRatio: f.raw.topTrader?.longShortRatio ?? null,
            buySellRatio: f.raw.taker?.buySellRatio ?? null,
            obImbalance: f.raw.ob?.imbalance ?? null,
            spreadBps: f.raw.ob?.spreadBps ?? null,
          };
        } catch (e) { out[t.short] = { error: e.message }; }
      }));
      return res.status(200).json({ ok: true, ts: new Date().toISOString(), flow: out });
    }
    if (action === 'reset') {
      // Auth required — env CAMELOT_RESET_TOKEN
      const tok = (req.query?.token || req.headers['x-camelot-token'] || '').toString();
      const expected = (process.env.CAMELOT_RESET_TOKEN || '').toString();
      if (!expected || tok !== expected) return res.status(401).json({ error: 'unauthorized' });
      await redis.del(KEY_STATE);
      await redis.del(KEY_POS);
      await redis.del(KEY_TRADES);
      await redis.del(KEY_EQUITY);
      return res.status(200).json({ ok: true, reset: true });
    }
    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    console.error('[camelot]', e.message, e.stack);
    return res.status(500).json({ error: e.message });
  }
};

module.exports.tick = tick;
module.exports.getStateForDashboard = getStateForDashboard;
module.exports.TOKENS = TOKENS;
