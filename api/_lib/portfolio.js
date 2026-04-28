// ═══ Unified Portfolio State — single source of truth over alle bots ═══
//
// Ontwerp:
//   Voorheen: elke bot (paper-engine, camelot_paper, forward_test) had
//   eigen state file → geen portfolio view, geen cross-bot risk.
//   Nu: één Redis-gebacked model waar alle bots via deze helper in schrijven.
//
// Redis schema:
//   portfolio:state            — { equity:{bot→n,total}, peakEquity, circuit, meta }
//   portfolio:positions        — JSON object { [id]: PositionRecord }
//   portfolio:trades           — LIST van ClosedTrade (newest first)
//   portfolio:equity           — LIST van { time, value, byBot:{…} } (newest first)
//
// PositionRecord:
//   { id, bot, token, market, side:'LONG'|'SHORT',
//     qty, entryPrice, sizeUsd,
//     stop, target, target1, initialStop, atr,
//     stars, openTime, kronosDirection,
//     partialClosed, breakeven, highWaterMark, lowWaterMark,
//     riskMultiplier, meta:{…} }
//
// ClosedTrade:
//   { id, bot, token, side, entryPrice, exitPrice, amount, sizeUsd,
//     pnl, pnlPct, stars, openTime, closeTime, reason, fees:{entry,exit,spread} }
//
// Legacy compat:
//   Writes mirroren naar paper:state / paper:trades / paper:equity zodat de
//   bestaande dashboard-endpoints (paper-state.js) blijven werken tijdens de
//   migratie. Lezers kunnen stapsgewijs overstappen naar portfolio:*.

const redis = require('./redis');
const fills = require('./fills');

const LEGACY_MIRROR = true;   // schakelt dual-write naar paper:* keys

// ── Bot identiteit ──
const BOTS = {
  PAPER_4H:       'paper_4h',        // api/paper-engine.js
  PAPER_KRONOS:   'paper_kronos',    // api/kronos.js (action=run)
  CAMELOT_PAPER:  'camelot_paper',   // local python paper runner
  FORWARD_TEST:   'forward_test',    // local python forward test
  BACKTEST:       'backtest',        // backtest-agent.js
};

// ── Default state ──
const START_BALANCE = 10000;

function defaultState() {
  return {
    _version: 1,
    _updated: new Date().toISOString(),
    balance: START_BALANCE,
    startBalance: START_BALANCE,
    startDate: Date.now(),
    peakEquity: START_BALANCE,
    lastRun: Date.now(),
    lastSignals: {},          // { [token]: { time, type } } — dedup voor trade-opening
    lastNtfyPush: {},         // { [token]: { [tf]: lastSig.time } }
    circuit: { active: false, until: 0, reason: '' },
    byBot: {},                // { [bot]: { balance, trades, winRate, lastRun } }
    risk: {
      maxPortfolioRisk:  0.06,   // max % equity at risk totaal
      maxPerTokenRisk:   0.03,   // max % equity at risk op één token
      maxCorrelatedRisk: 0.05,   // max % equity at risk op gecorreleerde cluster
      clusters: {
        CRYPTO_L1: ['BTC','ETH','SOL','BNB'],
        XRP_LIKE:  ['XRP','XLM','HBAR']
      }
    }
  };
}

// ── State I/O ──
async function loadState() {
  const s = await redis.get('portfolio:state');
  if (s) return s;
  // Migration path: probeer legacy paper:state te lezen
  const legacy = await redis.get('paper:state');
  if (legacy) {
    const migrated = { ...defaultState(), ...legacy };
    migrated._migratedFrom = 'paper:state';
    migrated._version = 1;
    return migrated;
  }
  return defaultState();
}

async function saveState(state) {
  state._updated = new Date().toISOString();
  await redis.set('portfolio:state', state);
  if (LEGACY_MIRROR) {
    // Schrijf legacy-key met dezelfde inhoud zodat paper-state.js blijft werken
    await redis.set('paper:state', state);
  }
}

// ── Signal-dedup state (M-P0-10 fix, 2026-04-23) ──
//
// Voorheen leefde dedup-state (lastSignals + lastNtfyPush) IN portfolio:state.
// Beide bots (Merlijn én Kronos) delen die state-key → race waarbij Kronos's
// saveState een Merlijn-dedup-update kon overschrijven met een stale snapshot.
// Resultaat: Merlijn behandelt zelfde 4H-signaal nogmaals als nieuw → dubbele
// trade-open, dubbele Telegram push.
//
// Fix: aparte per-bot keys `portfolio:dedup:<bot>` met { lastSignals, lastNtfy }.
// Per-bot lock (paper_4h / paper_kronos) garandeert dat reads/writes binnen
// één bot serieel zijn. Cross-bot heeft geen dedup-collision meer want elke
// bot heeft eigen key.
async function loadDedup(bot) {
  if (!bot) throw new Error('loadDedup: bot required');
  const v = await redis.get(`portfolio:dedup:${bot}`);
  if (v && typeof v === 'object') return v;
  return { lastSignals: {}, lastNtfyPush: {}, recentlyClosed: {} };
}
async function saveDedup(bot, dedup) {
  if (!bot) throw new Error('saveDedup: bot required');
  if (!dedup || typeof dedup !== 'object') return;
  await redis.set(`portfolio:dedup:${bot}`, dedup);
}

// ── Positions (hash binnen state) ──
async function loadPositions() {
  const raw = await redis.get('portfolio:positions');
  if (raw && typeof raw === 'object') return raw;
  return {};
}

async function savePositions(positions) {
  await redis.set('portfolio:positions', positions);
}

// ── Cross-bot lost-update prevention (M-P0-1, 2026-04-23) ──
//
// Both Merlijn (paper_4h) en Kronos (paper_kronos) schreven naar dezelfde
// `portfolio:positions` hash maar gebruikten verschillende per-bot locks.
// Race scenario die positions kon corrupteren:
//   T0  Merlijn loadPositions() → snapshot { mer_pos1, kron_pos1 }
//   T1  Kronos opent kron_pos2 → savePositions({ mer_pos1, kron_pos1, kron_pos2 })
//   T2  Merlijn sluit mer_pos1 → savePositions(merlijnSnapshot ZONDER kron_pos2)
//   ⇒  kron_pos2 verdwijnt uit Redis = phantom open positie op Binance Futures
//      maar weg uit onze state. Geen manage, geen close, geen alert.
//
// Fix: alle savePositions van engines → savePositionsForBot.
//   1. Acquire shared lock `portfolio:lock:positions` (kort, max ~5s)
//   2. Re-load FRESH positions from Redis (post-andere-bot updates)
//   3. Merge: drop fresh positions van DEZE bot, voeg engine's set toe
//   4. Write merged hash, release lock
//
// Per-bot lock (paper_4h / paper_kronos) blijft bestaan voor sequencing van
// runs binnen één bot. Deze positions-lock is veel KORTER (alleen tijdens write).
const POS_LOCK_KEY = 'portfolio:lock:positions';
const POS_LOCK_TTL = 15;          // 15s — ruim genoeg voor read+merge+write
const POS_LOCK_RETRIES = 8;       // 8 × 250ms = 2s totaal wachten
const POS_LOCK_RETRY_MS = 250;

async function _acquirePositionsLock() {
  for (let i = 0; i < POS_LOCK_RETRIES; i++) {
    if (await redis.setNxEx(POS_LOCK_KEY, Date.now(), POS_LOCK_TTL)) return true;
    await new Promise(r => setTimeout(r, POS_LOCK_RETRY_MS));
  }
  return false;
}
async function _releasePositionsLock() {
  try { await redis.del(POS_LOCK_KEY); } catch {}
}

// engineSnapshot = positions hash zoals engine die in-memory heeft gemuteerd
//   (kan posities van ANDERE bots bevatten — die worden genegeerd, niet als waarheid
//   beschouwd, want stale).
// bot = identifier waarvan deze save de authoritative source is.
async function savePositionsForBot(engineSnapshot, bot) {
  if (!bot) throw new Error('savePositionsForBot: bot is required');
  const got = await _acquirePositionsLock();
  if (!got) {
    const e = new Error('positions-lock niet beschikbaar binnen 2s — retry next tick');
    e.code = 'POSITIONS_LOCK_TIMEOUT';
    throw e;
  }
  try {
    const fresh = await loadPositions();
    // Drop fresh positions van DEZE bot — engine is authoritative voor zijn eigen
    for (const id of Object.keys(fresh)) {
      const p = fresh[id];
      if (p && p.bot === bot) delete fresh[id];
    }
    // Voeg engine-side positions van DEZE bot toe (negeer engine's stale view van anderen)
    for (const [id, p] of Object.entries(engineSnapshot || {})) {
      if (p && p.bot === bot) fresh[id] = p;
    }
    await redis.set('portfolio:positions', fresh);
    return fresh;
  } finally {
    await _releasePositionsLock();
  }
}

function listOpenPositions(positions, filter = {}) {
  const arr = Object.values(positions || {});
  return arr.filter(p => {
    if (filter.bot && p.bot !== filter.bot) return false;
    if (filter.token && p.token !== filter.token) return false;
    if (filter.side && p.side !== filter.side) return false;
    return true;
  });
}

// ── Trades (lijst) ──
// M-P0-19 fix (2026-04-23): atomic lpush+ltrim om TOCTOU-gap te dichten
// (zie redis.js lpushTrim — voorkomt unbounded list growth bij failed ltrim).
async function recordTrade(trade) {
  await redis.lpushTrim('portfolio:trades', trade, 0, 999);
  if (LEGACY_MIRROR) {
    await redis.lpushTrim('paper:trades', trade, 0, 499);
  }
}

async function listTrades(limit = 200, botFilter = null) {
  const trades = await redis.lrange('portfolio:trades', 0, limit - 1) || [];
  if (botFilter) return trades.filter(t => t.bot === botFilter);
  return trades;
}

// ── Equity snapshot ──
// M-P0-19 fix (2026-04-23): atomic lpush+ltrim (zie redis.js lpushTrim).
async function recordEquity(snapshot) {
  // snapshot: { time, value, byBot:{…} }
  await redis.lpushTrim('portfolio:equity', snapshot, 0, 1999);
  if (LEGACY_MIRROR) {
    await redis.lpushTrim('paper:equity', { time: snapshot.time, value: snapshot.value }, 0, 1999);
  }
}

// ── Portfolio value ──
// Voor LONG: qty * price (qty is al post-fee, dus entryFee zit impliciet in).
// Voor SHORT: sizeUsd is NOMINAAL (pre-fee); trek entryFee eraf zodat de PV
// consistent is met wat balance wordt na close.
function portfolioValue(state, positions, livePrices) {
  let v = state.balance;
  for (const p of Object.values(positions || {})) {
    const price = livePrices[p.token] || p.entryPrice;
    const entryFee = p.fills?.entryFee || 0;
    if (p.side === 'LONG') v += p.qty * price;                           // qty is post-fee
    else v += (p.sizeUsd - entryFee) + (p.entryPrice - price) * p.qty;   // expliciet fee-corr.
  }
  return v;
}

// ── Risk exposure berekenen ──
// Returns $ at risk = som over open posities van |entry - stop| * qty
function computeExposure(positions, { token = null, cluster = null, bot = null, clusters = {} } = {}) {
  let total = 0;
  for (const p of Object.values(positions || {})) {
    if (token && p.token !== token) continue;
    if (bot && p.bot !== bot) continue;
    if (cluster) {
      const members = clusters[cluster] || [];
      if (!members.includes(p.token)) continue;
    }
    const riskPerUnit = Math.abs(p.entryPrice - (p.initialStop || p.stop));
    total += riskPerUnit * p.qty;
  }
  return total;
}

function findCluster(token, clusters) {
  for (const [name, members] of Object.entries(clusters || {})) {
    if (members.includes(token)) return name;
  }
  return null;
}

// ── Centrale risk-check voor nieuwe positie ──
// opts: { bot, token, riskUsd }  — riskUsd = |entry - stop| * qty (geplande trade)
// Returns { ok:true } of { ok:false, reason }
function canOpenPosition(state, positions, opts) {
  // P1-FIX (audit-2026-04-23): defensief — een upstream sizing-bug die NaN of
  // negative riskUsd produceert zou anders silently door de cap-check heen
  // glippen omdat `NaN > X` altijd false is → trade opent uncapped. Reject hard.
  if (!opts || !Number.isFinite(opts.riskUsd) || opts.riskUsd <= 0) {
    return { ok: false, reason: `invalid riskUsd=${opts?.riskUsd}` };
  }
  const equity = state.peakEquity || state.balance || 1;
  const risk = state.risk || defaultState().risk;

  // 1. Portfolio-totaal
  const totalAtRisk = computeExposure(positions, {});
  if ((totalAtRisk + opts.riskUsd) > equity * risk.maxPortfolioRisk) {
    return { ok: false, reason: `portfolio risk cap: ${(totalAtRisk/equity*100).toFixed(1)}% +${(opts.riskUsd/equity*100).toFixed(1)}% > ${(risk.maxPortfolioRisk*100).toFixed(0)}%` };
  }

  // 2. Per token
  const tokenAtRisk = computeExposure(positions, { token: opts.token });
  if ((tokenAtRisk + opts.riskUsd) > equity * risk.maxPerTokenRisk) {
    return { ok: false, reason: `per-token cap ${opts.token}: ${(tokenAtRisk/equity*100).toFixed(1)}% +${(opts.riskUsd/equity*100).toFixed(1)}% > ${(risk.maxPerTokenRisk*100).toFixed(0)}%` };
  }

  // 3. Correlated cluster
  const cluster = findCluster(opts.token, risk.clusters);
  if (cluster) {
    const clusterAtRisk = computeExposure(positions, { cluster, clusters: risk.clusters });
    if ((clusterAtRisk + opts.riskUsd) > equity * risk.maxCorrelatedRisk) {
      return { ok: false, reason: `cluster ${cluster} cap: ${(clusterAtRisk/equity*100).toFixed(1)}% +${(opts.riskUsd/equity*100).toFixed(1)}% > ${(risk.maxCorrelatedRisk*100).toFixed(0)}%` };
    }
  }

  return { ok: true };
}

// ── Open position (schrijft zowel state.balance als positions hash) ──
function openPositionRecord(state, positions, data) {
  const id = data.id || (Date.now() + '_' + Math.random().toString(36).slice(2, 8));
  const rec = {
    id,
    bot: data.bot,
    token: data.token,
    market: data.market,
    symbol: data.symbol,    // Binance USDT-pair (BTCUSDT) — gebruikt voor venue-aware book-fetch op close
    side: data.side,
    qty: data.qty,
    entryPrice: data.entryPrice,
    sizeUsd: data.sizeUsd,
    stop: data.stop,
    initialStop: data.stop,
    target: data.target,
    target1: data.target1,
    atr: data.atr,
    stars: data.stars,
    openTime: data.openTime || Date.now(),
    kronosDirection: data.kronosDirection || '',
    partialClosed: false,
    breakeven: false,
    highWaterMark: data.entryPrice,
    lowWaterMark: data.entryPrice,
    riskMultiplier: data.riskMultiplier || 1.0,
    fills: data.fills || null,        // slippage/fee/latency details (zie fills.js)
    meta: data.meta || {},
  };
  positions[id] = rec;
  state.balance -= data.sizeUsd;
  return rec;
}

// ── Close position (partial of full), produceert ClosedTrade ──
// Alle kosten worden verrekend in balance:
//   - grossPnl       = (exit - entry) * qty           (price move)
//   - exitFee        = taker fee bij sluiten          (uit fills.computeExit)
//   - exitSlippage   = slippage-component exit        (zit al in exitPrice,
//                      dus NIET nogmaals aftrekken — grossPnl bevat 'm)
//   - entryFee       = taker fee bij openen           (was tot nu toe alleen
//                      verwerkt via qty-reductie, maar sizeUsd-terugbetaling
//                      aan close gebeurde op nominaal bedrag → lek. Nu hier
//                      proportioneel afgetrokken zodat balance klopt.)
//   - entrySlippage  = zat in entryPrice → al in grossPnl verwerkt
function closePositionRecord(state, positions, posId, exitPrice, reason, { partialPct = 1.0, fees = null } = {}) {
  const pos = positions[posId];
  if (!pos) return null;
  const closeQty = pos.qty * partialPct;
  const closeSizeUsd = pos.sizeUsd * partialPct;

  let grossPnl;
  if (pos.side === 'LONG') grossPnl = (exitPrice - pos.entryPrice) * closeQty;
  else grossPnl = (pos.entryPrice - exitPrice) * closeQty;

  const exitFee = fees?.exit ?? 0;
  const spreadCost = fees?.spread ?? 0;
  // Funding (Kronos perpetuals): LONG betaalt, SHORT ontvangt — al ge-signeerd door caller.
  const funding = fees?.funding ?? 0;
  // Proportionele entry-fee: bij partial close reken je enkel het stukje af.
  const entryFeeFull = pos.fills?.entryFee || 0;
  const entryFeeShare = entryFeeFull * partialPct;

  const pnl = grossPnl - exitFee - spreadCost - entryFeeShare - funding;
  const pnlPct = (pnl / closeSizeUsd) * 100;

  state.balance += closeSizeUsd + pnl;

  // Peak favorable excursion — zelfde side-logic als MFE:
  //   LONG  → beste prijs = highWaterMark (hoger dan entry = winst)
  //   SHORT → beste prijs = lowWaterMark  (lager dan entry = winst)
  const peakPrice = pos.side === 'LONG'
    ? (pos.highWaterMark || pos.entryPrice)
    : (pos.lowWaterMark  || pos.entryPrice);
  const peakPct = pos.side === 'LONG'
    ? ((peakPrice - pos.entryPrice) / pos.entryPrice) * 100
    : ((pos.entryPrice - peakPrice) / pos.entryPrice) * 100;

  const trade = {
    id: pos.id + (partialPct < 1 ? '_p' : ''),
    bot: pos.bot,
    token: pos.token, side: pos.side,
    entryPrice: pos.entryPrice, exitPrice,
    amount: closeQty, sizeUsd: closeSizeUsd,
    pnl, pnlPct, stars: pos.stars,
    openTime: pos.openTime, closeTime: Date.now(),
    reason,
    fees: { ...(fees || {}), entryFee: entryFeeShare },
    // Trail/MFE detail — gebruikt door dashboard om "hoe goed liep 't"
    // en "welk stop-niveau triggerde" zichtbaar te maken.
    trail: {
      initialStop: pos.initialStop ?? null,
      finalStop:   pos.stop ?? null,
      target:      pos.target ?? null,
      target1:     pos.target1 ?? null,
      breakeven:   !!pos.breakeven,
      peakPrice,
      peakPct,
      atr:         pos.atr ?? null,
    }
  };

  if (partialPct >= 1.0) {
    delete positions[posId];
  } else {
    pos.qty -= closeQty;
    pos.sizeUsd -= closeSizeUsd;
    pos.partialClosed = true;
  }
  return trade;
}

// ── Funding accrual ──
// Past funding toe op alle open posities o.b.v. tijd sinds vorige run.
// - LONG betaalt   (balance -= cost)
// - SHORT ontvangt (balance += credit)
// Bewaart accumulatie op pos.accruedFunding (positief = wat al afgedragen/ontvangen).
// Returns { total, perPosition } voor logging.
function accrueFunding(state, positions, periodMs) {
  if (!periodMs || periodMs <= 0) return { total: 0, perPosition: {} };
  let total = 0;
  const perPosition = {};
  for (const p of Object.values(positions || {})) {
    const amt = fills.computeFunding({ pos: p, periodMs });
    // amt: LONG = +, SHORT = -
    // LONG pays → balance DECREASES by amt; SHORT receives → balance INCREASES by |amt|
    if (p.side === 'LONG') {
      state.balance -= amt;
      p.accruedFunding = (p.accruedFunding || 0) + amt;
    } else {
      state.balance -= amt;   // amt is negatief → balance stijgt
      p.accruedFunding = (p.accruedFunding || 0) + amt;
    }
    total += amt;
    perPosition[p.id] = amt;
  }
  return { total, perPosition };
}

// ── Per-bot stats accumulator (optioneel, voor portfolio-state endpoint) ──
function updateByBot(state, bot, patch) {
  state.byBot = state.byBot || {};
  state.byBot[bot] = { ...(state.byBot[bot] || {}), ...patch, lastRun: Date.now() };
}

// ── P1-15: per-position mutation lock ──────────────────────────────────────
// Voorkomt dat engine-cron en manual-close (HTTP) gelijktijdig dezelfde positie
// muteren. Race-scenario zonder deze lock:
//   t=0   cron-engine start, snapshot positions[]
//   t=10  user klikt "Close" → manual close laadt FRESH, sluit pos, save
//   t=20  cron-engine schrijft snapshot terug → OVERWRITE, pos lijkt 'terug actief'
// Met deze lock: wie 'm eerst krijgt mag muteren. De ander throwt POSITION_LOCKED
// → engine slaat die positie over deze tick (volgende tick re-load is fresh).
//
// Lock-key: 'paper:close:${posId}' — overlap met de HTTP-handler 5s anti-double-click
// is bewust: bij re-entry vanaf zelfde request faalt de tweede acquisition met
// een nette error i.p.v. silent race.
async function withPositionMutationLock(posId, fn, { ttlSec = 15 } = {}) {
  if (!posId) throw new Error('withPositionMutationLock: posId required');
  const lockKey = `paper:close:${posId}`;
  const got = await redis.setNxEx(lockKey, Date.now(), ttlSec);
  if (!got) {
    const err = new Error(`position ${posId} mutation lock held — concurrent close in progress`);
    err.code = 'POSITION_LOCKED';
    throw err;
  }
  try {
    return await fn();
  } finally {
    try { await redis.del(lockKey); } catch {}
  }
}

module.exports = {
  BOTS,
  START_BALANCE,
  defaultState,
  loadState, saveState,
  loadDedup, saveDedup,
  loadPositions, savePositions, savePositionsForBot,
  listOpenPositions,
  recordTrade, listTrades,
  recordEquity,
  portfolioValue,
  computeExposure, findCluster, canOpenPosition,
  openPositionRecord, closePositionRecord,
  accrueFunding,
  updateByBot,
  withPositionMutationLock,
};
