// ═══ Kronos AI Proxy + Signal Generator — Vercel Serverless Function ═══
//
// Twee modes via query param:
//   GET /api/kronos?symbol=BTCUSDT          → proxy single forecast (default)
//   GET /api/kronos?action=signals          → genereer signalen voor alle tokens
//
// Signal generator:
//   - Fetch Kronos voor 12 tokens
//   - |pct| ≥ KRONOS_SIG_THRESHOLD → BUY/SELL marker
//   - Star rating op basis van magnitude
//   - Dedup via Redis (kronos:lastSig:<token>)
//   - Ntfy push naar aparte topic (opt-in/out apart van trade-signals)
//   - Geeft summary JSON terug voor monitoring
//
// Kronos offline = no signals (graceful skip, geen errors).

const redis = require('./_lib/redis');
const portfolio = require('./_lib/portfolio');
const {
  fillPrice, feeFor, computeFunding,
  FUNDING_BPS_PER_8H, FUNDING_PERIOD_MS, VENUE,
} = require('./_lib/fills');
const execution = require('./_lib/execution');     // Paper/Live router (default paper)
const killSwitch = require('./kill-switch');       // Kill-switch checker
const signalAudit = require('./_lib/signal-audit'); // Best-effort signal-outcome logger
// Voor wick-based stop detection (FIX 2026-04-22): fetch 4h candles van open-position
// tokens zodat we high/low wicks zien tussen Kronos-cron-runs (manageKronosPositions
// kreeg voorheen alleen Kronos-forecast 'current' = spot polling, en miste daardoor
// snelle wicks die het stop-niveau raakten en weer terugtrokken — zoals BTC SHORT
// stop $78,833 dat door candle-high $79,079 werd geraakt maar live $78,817 toonde).
const { fetchCandles } = require('./_lib/signals');

const KRONOS_BOT = portfolio.BOTS.PAPER_KRONOS;
// ── Isolated Kronos paper-trading namespace ──
// Gescheiden van paper_4h: eigen balance €1000, eigen positions, eigen trades.
// Redis keys: kronos_paper:state | kronos_paper:positions | kronos_paper:trades
const KRONOS_START_BALANCE = parseFloat(process.env.KRONOS_START_BALANCE || '10000');
const KRONOS_TRADE_SIZE = parseFloat(process.env.KRONOS_TRADE_SIZE || '1000');   // legacy fallback (alleen gebruikt als RISK_BASED uit staat)
// ── Risk-based sizing (zelfde model als Merlijn) ──
// Volgt: units = (balance × riskPct × starMult) / stopDistance
// starMultMap = {3★:1.0, 4★:1.5, 5★:2.0}; cap op KRONOS_MAX_SIZE_PCT × balance
const KRONOS_RISK_BASED   = (process.env.KRONOS_RISK_BASED || '1') !== '0';
const KRONOS_RISK_PCT     = parseFloat(process.env.KRONOS_RISK_PCT || '0.01');    // 1% base risk per trade
const KRONOS_MAX_SIZE_PCT = parseFloat(process.env.KRONOS_MAX_SIZE_PCT || '0.25'); // max 25% balance / trade
const KRONOS_STAR_MULT    = { 1: 0.5, 2: 0.75, 3: 1.0, 4: 1.5, 5: 2.0 };
const KRONOS_STOP_PCT = parseFloat(process.env.KRONOS_STOP_PCT || '5');         // 5% stop
const KRONOS_MIN_STARS_TRADE = parseInt(process.env.KRONOS_MIN_STARS_TRADE || '3', 10);
const KRONOS_MAX_HOLD_HOURS = parseInt(process.env.KRONOS_MAX_HOLD_HOURS || '72', 10);
const KRONOS_MAX_OPEN = parseInt(process.env.KRONOS_MAX_OPEN || '6', 10);

// ── Trail/breakeven config (zelfde regels als paper-engine) ──
const KRONOS_BREAKEVEN_ATR = parseFloat(process.env.KRONOS_BREAKEVEN_ATR || '1.0');  // breakeven trigger
const KRONOS_TRAIL_ATR_BASE = parseFloat(process.env.KRONOS_TRAIL_ATR_BASE || '1.5'); // base trail multiplier
const KRONOS_PARTIAL_PCT = parseFloat(process.env.KRONOS_PARTIAL_PCT || '0.5');       // % positie sluiten bij target1
// ── Risk guards ──
const KRONOS_DD_PAUSE_PCT = parseFloat(process.env.KRONOS_DD_PAUSE_PCT || '25');      // pauzeer nieuwe trades als drawdown > X% van peakEquity
const KRONOS_DAILY_DD_PCT = parseFloat(process.env.KRONOS_DAILY_DD_PCT || '10');      // pauzeer als 24h drop > X% (kill-switch)
function progressiveTrailMult(profitPct) {
  if (profitPct >= 10) return 0.8;
  if (profitPct >= 5)  return 1.2;
  return KRONOS_TRAIL_ATR_BASE;
}

// ── Isolated state helpers ──
// ── State I/O — UNIFIED PAPER POOL ──
// Kronos draait niet langer in een isolated kronos_paper:* sandbox; alle reads/writes
// gaan naar de gedeelde portfolio:* keys waar Merlijn ook in zit. Bot-attributie blijft
// behouden via pos.bot = 'paper_kronos' zodat byBot-breakdown blijft kloppen.
// Trades worden alleen ge-filterd op bot='paper_kronos' bij management.
async function kLoadState() {
  return portfolio.loadState();
}
async function kSaveState(s) {
  return portfolio.saveState(s);
}
async function kLoadPositions() {
  // Filter alleen Kronos-posities (Merlijn-posities horen bij paper-engine.js)
  const all = await portfolio.loadPositions();
  const out = {};
  for (const [id, p] of Object.entries(all || {})) {
    if (p && p.bot === KRONOS_BOT) out[id] = p;
  }
  return out;
}
async function kSavePositions(kronosPositions) {
  // M-P0-1 fix (2026-04-23): savePositionsForBot doet load+merge+write ATOMIC
  // onder shared positions-lock. Voorheen had deze functie zelf het merge-pattern
  // maar zonder lock → race waarbij Merlijn's net-toegevoegde positie tussen
  // onze loadPositions() en savePositions() in geschreven werd, en wij hem
  // overschreven. savePositionsForBot voorkomt dit.
  return portfolio.savePositionsForBot(kronosPositions, KRONOS_BOT);
}
async function kRecordTrade(trade) {
  return portfolio.recordTrade(trade);
}
async function kListTrades(limit = 50) {
  // Lees alle trades, filter op bot
  const all = await portfolio.listTrades(limit * 4, KRONOS_BOT);
  return all.slice(0, limit);
}

const KRONOS_URL = (process.env.KRONOS_URL || 'https://camelotlabs-kronos-ai-forecast.hf.space').replace(/\/$/, '');
const NTFY_KRONOS_TOPIC = (process.env.NTFY_KRONOS_TOPIC || 'merlijn-kronos-7e3ab21d4f').trim();
const NTFY_TOKEN = (process.env.NTFY_TOKEN || '').trim();
const NTFY_FILTER_TAG = (process.env.NTFY_KRONOS_FILTER_TAG || 'kronos-z9p4q7v2k1').trim();

// Drempels voor signal-generation
const KRONOS_SIG_THRESHOLD = parseFloat(process.env.KRONOS_SIG_THRESHOLD || '2'); // ±2% min
const NTFY_MIN_STARS = parseInt(process.env.KRONOS_NTFY_MIN_STARS || '3', 10);

const TOKENS = [
  { symbol: 'BTCUSDT',  short: 'BTC'  },
  { symbol: 'ETHUSDT',  short: 'ETH'  },
  { symbol: 'SOLUSDT',  short: 'SOL'  },
  { symbol: 'BNBUSDT',  short: 'BNB'  },
  { symbol: 'HBARUSDT', short: 'HBAR' },
  { symbol: 'XRPUSDT',  short: 'XRP'  },
  { symbol: 'AVAXUSDT', short: 'AVAX' },
  { symbol: 'LINKUSDT', short: 'LINK' },
  { symbol: 'ADAUSDT',  short: 'ADA'  },
  { symbol: 'DOTUSDT',  short: 'DOT'  },
  { symbol: 'POLUSDT',  short: 'POL'  },
  { symbol: 'DOGEUSDT', short: 'DOGE' },
  // ── Universe-uitbreiding (Phase 2, 2026-04-23) ──
  { symbol: 'SUIUSDT',  short: 'SUI'  },
  { symbol: 'TRXUSDT',  short: 'TRX'  },  // TRON (Binance ticker = TRX)
  { symbol: 'HYPEUSDT', short: 'HYPE' },  // Hyperliquid — Futures-only (Spot = Niet beschikbaar)
  // 2026-04-23 add-on: XLM (Stellar) — Futures $44.6M/24h, ruim boven liquidity-floor
  { symbol: 'XLMUSDT',  short: 'XLM'  },
  // XDC niet op Binance → overgeslagen
];

// ── Single fetch (proxy mode) ──
//
// M-P0-17 fix (2026-04-23): cache TTL alignment.
// Vroeger: cache ttl = 10 min, MAX_SIG_AGE_MS in executeKronosTrades = 60s.
// Gevolg: 90% van de cron-runs kreeg cached forecast tussen 60s-10min terug,
// die executeKronosTrades vervolgens als 'kronos_stale' rejecte. Vers ophalen
// gebeurde pas na 10 min → bot kon zelden new opens doen tussen cache-misses.
//
// Nu twee-tier:
//   SOFT_TTL_MS (60s)    — onder dit → return uit cache (vers genoeg om te traden)
//   HARD_TTL_MS (10min)  — boven SOFT, onder HARD → probeer eerst FRESH fetch,
//                          val bij failure terug op stale cache (markeer _stale)
//   > HARD_TTL_MS        — cache niet bruikbaar als fallback; gewone fetch + offline
//
// Net resultaat: bot probeert iedere tick FRESH te fetchen als de soft-TTL is
// verlopen, met cold-start protection via stale fallback (HF Space sleeps).
const KRONOS_CACHE_SOFT_TTL_MS = 60 * 1000;       // = MAX_SIG_AGE_MS in executeKronosTrades
const KRONOS_CACHE_HARD_TTL_MS = 10 * 60 * 1000;  // legacy 10min cold-start fallback

async function fetchOne(symbol, { timeoutMs = 25000, retries = 1, useCache = true } = {}) {
  // HF Spaces hibernate na inactiviteit → cold start kan 10-15s duren.
  // 25s timeout + 1 retry pakt cold-starts op zonder permanent als offline te markeren.
  const cacheKey = `kronos:fc:${symbol}`;
  let softHitFromCache = null;     // < SOFT_TTL  → return direct
  let staleFallback   = null;      // SOFT < age < HARD → fallback bij fetch-fail
  if (useCache && redis.isConfigured()) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        const c = typeof cached === 'string' ? JSON.parse(cached) : cached;
        const age = Date.now() - (c._cachedAt || 0);
        if (age < KRONOS_CACHE_SOFT_TTL_MS) {
          softHitFromCache = { ...c, _cacheAge: age };
        } else if (age < KRONOS_CACHE_HARD_TTL_MS) {
          staleFallback = { ...c, _cacheAge: age };
        }
      }
    } catch {}
  }
  // Fresh genoeg → direct return zonder backend-call
  if (softHitFromCache) return softHitFromCache;

  // Cache te oud → fresh fetchen, met staleFallback als safety net
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const r = await fetch(`${KRONOS_URL}/forecast?symbol=${encodeURIComponent(symbol)}`, { signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) throw new Error(`Kronos ${r.status}`);
      const data = await r.json();
      // Schrijf vers naar cache
      if (redis.isConfigured()) {
        try { await redis.set(cacheKey, JSON.stringify({ ...data, _cachedAt: Date.now() })); } catch {}
      }
      return data;
    } catch (e) {
      if (attempt === retries) {
        // Soft-stale fallback (60s-10min): beter een ietsje verouderd signaal dan offline
        // De _stale=true vlag laat executeKronosTrades nog steeds rejecten als beleid is om
        // alleen verse signals te traden — maar UI/audit kunnen tenminste laatste forecast tonen.
        if (staleFallback) {
          return { ...staleFallback, _stale: true, _staleReason: e.message };
        }
        // Geen recente cache (>10min of nooit gefetched) → laatste redmiddel: ANY cache
        if (redis.isConfigured()) {
          try {
            const any = await redis.get(cacheKey);
            if (any) {
              const s = typeof any === 'string' ? JSON.parse(any) : any;
              return { ...s, _stale: true, _staleReason: e.message };
            }
          } catch {}
        }
        return { symbol, direction: 'neutral', pct: 0, score: 0, forecast: null, current: null, offline: true, error: e.message };
      }
      await new Promise(r => setTimeout(r, 800));
    }
  }
}

// ── Star rating obv |pct| magnitude ──
// 2-4% = 2★, 4-6% = 3★, 6-10% = 4★, ≥10% = 5★
function starsFromPct(absPct) {
  if (absPct >= 10) return 5;
  if (absPct >= 6)  return 4;
  if (absPct >= 4)  return 3;
  if (absPct >= 2)  return 2;
  return 1;
}

// ── Ntfy push ──
async function sendNtfy(title, message, tag, priority) {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (NTFY_TOKEN) headers['Authorization'] = `Bearer ${NTFY_TOKEN}`;
    const tags = [tag, NTFY_FILTER_TAG].filter(Boolean);
    await fetch('https://ntfy.sh/', {
      method: 'POST', headers,
      body: JSON.stringify({ topic: NTFY_KRONOS_TOPIC, title, message, tags, priority }),
    });
    return true;
  } catch (e) { console.warn('[kronos-sig] ntfy fail', e.message); return false; }
}

// ── Signal generator mode ──
async function generateSignals() {
  const started = Date.now();
  const signals = [];
  const offlineTokens = [];
  const skipped = [];
  const pushed = [];

  // Fetch parallel (12 tokens, ~1-2s totaal)
  const forecasts = await Promise.all(TOKENS.map(async t => ({ token: t, data: await fetchOne(t.symbol) })));

  for (const f of forecasts) {
    const t = f.token;
    if (f.data.offline) { offlineTokens.push(t.short); continue; }
    const pct = Number(f.data.pct) || 0;
    const absPct = Math.abs(pct);
    if (absPct < KRONOS_SIG_THRESHOLD) {
      skipped.push(`${t.short} ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}% (< ${KRONOS_SIG_THRESHOLD}%)`);
      // Best-effort audit: noteer dat Kronos voor dit token geen signal genereerde door subthreshold pct
      try { signalAudit.record({ bot: 'paper_kronos', token: t.short, outcome: 'skipped', reason: `${pct.toFixed(2)}% < ${KRONOS_SIG_THRESHOLD}% threshold`, tag: 'below_threshold', meta: { pct } }); } catch {}
      continue;
    }

    const type = pct > 0 ? 'BUY' : 'SELL';
    const stars = starsFromPct(absPct);
    const sig = {
      token: t.short, symbol: t.symbol, type, stars,
      pct, direction: f.data.direction, score: f.data.score,
      current: f.data.current, forecast: f.data.forecast,
      // FIX 2026-04-22: cache-leeftijd doorgeven zodat executeKronosTrades
      // stale signals (>60s) kan rejecten in plaats van openen op een prijs
      // die intussen $3K verschoven is. _cacheAge zit in fetchOne als
      // useCache:true → < 600s anders refresh.
      _cacheAge: f.data._cacheAge || 0,
      _stale: f.data._stale === true,
      time: Date.now(),
    };
    signals.push(sig);

    // Dedup via Redis: alleen pushen als signal-richting veranderd is
    // sinds vorige push (BUY → SELL of vice versa, of nieuwe sterkere ster).
    let shouldPush = true;
    if (redis.isConfigured()) {
      try {
        const key = `kronos:lastSig:${t.short}`;
        const prev = await redis.get(key);
        const prevObj = prev ? JSON.parse(prev) : null;
        if (prevObj && prevObj.type === type && prevObj.stars === stars) {
          // Zelfde richting + sterkte als vorige push → geen herhaling
          shouldPush = false;
        }
        // Sla altijd huidige op (ook als skip)
        await redis.set(key, JSON.stringify({ type, stars, pct, time: sig.time }));
      } catch (e) { console.warn('[kronos-sig] redis err', e.message); }
    }

    if (shouldPush && stars >= NTFY_MIN_STARS) {
      const emoji = type === 'BUY' ? '⬆' : '⬇';
      const starStr = '★'.repeat(stars) + '☆'.repeat(5 - stars);
      const tag = type === 'BUY' ? 'green_circle' : 'red_circle';
      const priority = stars >= 4 ? 5 : 4;
      const ok = await sendNtfy(
        `${emoji} ${t.short} ${type} ${starStr} — Kronos AI`,
        `Kronos forecast: ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%\n` +
        `Richting: ${f.data.direction}\n` +
        `Sterkte: ${stars}/5 (drempel ${KRONOS_SIG_THRESHOLD}%)\n` +
        (f.data.current ? `Huidige: ${f.data.current}\n` : '') +
        (f.data.forecast ? `Forecast: ${f.data.forecast}\n` : '') +
        `\nMerlijn Kronos Signal`,
        tag, priority
      );
      if (ok) pushed.push(`${t.short} ${type} ${stars}★`);
    }
  }

  return {
    ok: true,
    ts: new Date().toISOString(),
    elapsedMs: Date.now() - started,
    threshold: KRONOS_SIG_THRESHOLD,
    minStars: NTFY_MIN_STARS,
    tokensChecked: TOKENS.length,
    kronosOnline: TOKENS.length - offlineTokens.length,
    offlineTokens,
    signalsGenerated: signals.length,
    signals,
    pushed,
    skipped,
  };
}

// ── Reconcile orphan balance (detect persistence-leak) ──
// Als positions=0 EN trades=0 maar balance ≠ startBalance: er is geld
// "verdwenen" buiten het trade-log om (oude bug, manual edit, redis flush, etc).
// We loggen een reconciliation-trade en herstellen de balance zodat de stats
// kloppen en de UI niet stilletjes onjuiste cijfers toont.
async function kReconcileOrphans(state, positions, trades) {
  const start = Number(state.startBalance || KRONOS_START_BALANCE);
  const openCount = Object.keys(positions).length;
  const tradeCount = (trades || []).length;
  if (openCount === 0 && tradeCount === 0 && Math.abs(state.balance - start) > 0.01) {
    const drift = state.balance - start;
    const reconTrade = {
      id: 'recon_' + Date.now(),
      bot: KRONOS_BOT, token: 'RECONCILE', side: 'NONE',
      qty: 0, entryPrice: 0, exitPrice: 0, sizeUsd: 0,
      pnl: drift, pnlPct: 0, grossPnl: drift,
      reason: `Reconciliation: balance drift €${drift.toFixed(2)} zonder trades — auto-restore`,
      openTime: Date.now(), closeTime: Date.now(),
      meta: { source: 'auto-reconcile', priorBalance: state.balance, restoredTo: start },
    };
    await kRecordTrade(reconTrade);
    state.balance = start;
    state.peakEquity = Math.max(state.peakEquity || start, start);
    state._lastReconcile = new Date().toISOString();
    await kSaveState(state);
    console.warn(`[kronos] orphan balance reconciled: €${drift.toFixed(2)} → restored to €${start}`);
    return { reconciled: true, drift };
  }
  return { reconciled: false };
}

// ── Open paper_kronos trades (isolated state) ──
async function executeKronosTrades(signals, livePrices = {}) {
  const opened = [];
  const skipped = [];
  // Best-effort audit logger — wrapped in try/catch zodat een Redis-fout NOOIT trade-flow breekt.
  // Vervangt het pure `skipped.push(...)` pattern + logged tegelijk naar signal_audit_events:paper_kronos.
  const _kSkip = (sig, reason, tag) => {
    const t = (sig && sig.token) || (typeof sig === 'string' ? sig : 'UNKNOWN');
    skipped.push(`${t}: ${reason}`);
    try { signalAudit.record({ bot: 'paper_kronos', token: t, outcome: 'rejected', reason, tag, meta: { stars: sig && sig.stars } }); } catch {}
  };
  // Bulk variant — vooraf-gefilterde signals (circuit / disabled / dd-pause)
  const _kSkipBulk = (sigs, reasonFn, tag) => sigs.map(s => {
    const r = reasonFn(s);
    try { signalAudit.record({ bot: 'paper_kronos', token: s.token, outcome: 'rejected', reason: r, tag, meta: { stars: s.stars } }); } catch {}
    return `${s.token}: ${r}`;
  });
  if (signals.length === 0) return { opened, skipped };

  // ── Hard circuit guard — auto-pause via kill-switch bij P&L floor breach ──
  try {
    const circuit = require('./_lib/circuit');
    const c = await circuit.checkCircuit('kronos');
    if (c.tripped) {
      console.warn(`[Kronos] 🛑 Hard circuit TRIPPED — ${c.kind}: ${c.reason}`);
      // Return early — kill-switch is now active, geen nieuwe opens
      return { opened, skipped: _kSkipBulk(signals, () => `HARD CIRCUIT (${c.kind})`, 'hard_circuit') };
    }
  } catch (e) {
    console.warn('[Kronos] circuit check error:', e.message);
  }

  // ── User toggle: bot disabled? skip alle nieuwe Kronos opens ──
  // (bestaande Kronos-posities blijven managed via aparte tick/cron-paths.)
  try {
    const botCfg = require('./_lib/bot-config');
    const enabled = await botCfg.isEnabled('paper_kronos');
    if (!enabled) {
      console.warn('[Kronos] ⏸ Bot DISABLED via user toggle (bot:enabled:paper_kronos=false) — geen nieuwe entries');
      return { opened, skipped: _kSkipBulk(signals, () => 'DISABLED via user toggle', 'bot_disabled') };
    }
  } catch (e) {
    console.warn('[Kronos] bot-config check error (fail-open):', e.message);
  }

  const state = await kLoadState();
  const positions = await kLoadPositions();
  const trades = await kListTrades(50);
  // FIX 2026-04-22 freshness gates:
  //   MAX_SIG_AGE_MS = max forecast leeftijd (Kronos cache 10min → te oud voor opens)
  //   MAX_PRICE_DRIFT_PCT = max spread tussen sig.current en huidige live
  // Beide guards verhinderen opens op een prijs die niet meer reflecteert wat de
  // markt op DIT moment doet (BTC $76k → $79k drift binnen 10min was de trigger).
  const MAX_SIG_AGE_MS = 60 * 1000;
  const MAX_PRICE_DRIFT_PCT = 1.0;
  // Auto-reconcile orphan balance vóór nieuwe trades
  await kReconcileOrphans(state, positions, trades);

  // ── Drawdown circuit-breaker ──
  // Bereken huidige portfolio value (best-effort uit positions, want geen prices hier)
  let pvEst = state.balance;
  for (const p of Object.values(positions)) pvEst += Number(p.sizeUsd || 0);
  const peak = Number(state.peakEquity || state.startBalance || KRONOS_START_BALANCE);
  const ddPct = peak > 0 ? Math.max(0, ((peak - pvEst) / peak) * 100) : 0;
  if (ddPct >= KRONOS_DD_PAUSE_PCT) {
    return { opened, skipped: _kSkipBulk(signals, () => `KRONOS PAUSED — drawdown ${ddPct.toFixed(1)}% ≥ ${KRONOS_DD_PAUSE_PCT}% van peak €${peak.toFixed(0)}`, 'drawdown_pause') };
  }
  // Update peakEquity bij groei
  if (pvEst > peak) state.peakEquity = pvEst;
  const openList = Object.values(positions);

  for (const sig of signals) {
    if (sig.stars < KRONOS_MIN_STARS_TRADE) { _kSkip(sig, `< ${KRONOS_MIN_STARS_TRADE}★`, 'min_stars'); continue; }
    if (openList.length + opened.length >= KRONOS_MAX_OPEN) { _kSkip(sig, `max ${KRONOS_MAX_OPEN} open bereikt`, 'max_open'); continue; }
    if (openList.find(p => p.token === sig.token) || opened.find(o => o.token === sig.token)) {
      _kSkip(sig, 'al open', 'already_open'); continue;
    }

    // FIX 2026-04-22: stale-signal gate
    // Als de forecast > 60s oud is uit Redis-cache, weiger de open. Anders openen
    // we op een prijs die intussen al verschoven kan zijn. De volgende cron-run
    // zal vers ophalen en alsnog openen als dat dan nog steeds geldig is.
    if (sig._stale === true || (sig._cacheAge && sig._cacheAge > MAX_SIG_AGE_MS)) {
      _kSkip(sig, `forecast stale (${Math.round((sig._cacheAge || 0)/1000)}s) — wacht op vers signaal`, 'kronos_stale');
      continue;
    }

    // Prefer live Binance price boven sig.current. Kronos zet sig.current bij
    // forecast-tijd; live komt uit candleMap (laatste 4h candle close = ≤ 1 min
    // oud bij Binance). Als spread > 1% → markt is duidelijk verschoven sinds
    // forecast; weiger open want sig.pct/forecast slaan niet meer op live prijs.
    const livePrice = Number(livePrices[sig.token]);
    const kronosPrice = Number(sig.current);
    if (livePrice && kronosPrice) {
      const driftPct = Math.abs((livePrice - kronosPrice) / kronosPrice) * 100;
      if (driftPct > MAX_PRICE_DRIFT_PCT) {
        _kSkip(sig, `price-drift ${driftPct.toFixed(2)}% Kronos $${kronosPrice} ≠ live $${livePrice} — markt verschoven, wacht`, 'price_drift');
        continue;
      }
    }
    const signalPrice = livePrice || kronosPrice;
    if (!signalPrice) { _kSkip(sig, 'geen current price', 'no_price'); continue; }
    const side = sig.type === 'BUY' ? 'LONG' : 'SHORT';

    // ── Kill-switch check vóór elk open ──
    const ks = await killSwitch.isBlocked('kronos');
    if (ks.blocked) { _kSkip(sig, `kill-switch active (${ks.reason})`, 'killswitch'); continue; }

    // ── Sizing: risk-based (default) of legacy flat ──
    // Risk-based: units = (balance × riskPct × starMult) / stopDistance, cap op MAX_SIZE_PCT
    const atrPct = KRONOS_STOP_PCT / 100;   // ruwe vol-proxy ≈ stop-afstand
    const _provisionalEntry = fillPrice(signalPrice, side, 'ENTRY', sig.token, { atrPct, stochastic: true });
    const _provisionalStop  = side === 'LONG'
      ? _provisionalEntry * (1 - KRONOS_STOP_PCT/100)
      : _provisionalEntry * (1 + KRONOS_STOP_PCT/100);
    const _stopDist = Math.abs(_provisionalEntry - _provisionalStop);
    let sizeUsd;
    if (KRONOS_RISK_BASED && _stopDist > 0) {
      const starMult = KRONOS_STAR_MULT[Math.min(5, Math.max(1, sig.stars))] || 1.0;
      const riskAmount = state.balance * KRONOS_RISK_PCT * starMult;
      const units = riskAmount / _stopDist;
      sizeUsd = Math.min(units * _provisionalEntry, state.balance * KRONOS_MAX_SIZE_PCT);
    } else {
      sizeUsd = KRONOS_TRADE_SIZE;
    }
    // Min trade-size guard: skip als sizing < $50 (te weinig signal — fees vreten alles op)
    if (sizeUsd < 50) { _kSkip(sig, `size €${sizeUsd.toFixed(0)} < min €50`, 'min_size'); continue; }
    if (state.balance < sizeUsd) { _kSkip(sig, `balance ${state.balance.toFixed(2)} < size ${sizeUsd.toFixed(2)}`, 'insufficient_balance'); continue; }

    // ── Portfolio risk caps (#8) — MOET vóór executeEntry want LIVE plaatst echt order ──
    // _stopDist en sizeUsd zijn al provisional uit pre-sizing hierboven.
    // riskUsd = stopDist * units = (sizeUsd / entry) * stopDist
    const _provRiskUsd = (sizeUsd / _provisionalEntry) * _stopDist;
    try {
      const portfolioMod = require('./_lib/portfolio');
      const allPos = await portfolioMod.loadPositions();
      const riskCheck = portfolioMod.canOpenPosition(state, allPos, {
        bot: KRONOS_BOT, token: sig.token, riskUsd: _provRiskUsd,
      });
      if (!riskCheck.ok) { _kSkip(sig, riskCheck.reason, 'risk_cap'); continue; }
    } catch (e) {
      console.warn(`[Kronos] risk-cap check fail for ${sig.token}: ${e.message}`);
    }

    // ── Order placement: paper-sim of live exchange (KRONOS_LIVE_NETWORK gates) ──
    // Provisional stop voor execution layer (zelfde formule als hieronder)
    const _execStop = side === 'LONG' ? _provisionalEntry * (1 - KRONOS_STOP_PCT/100) : _provisionalEntry * (1 + KRONOS_STOP_PCT/100);
    let entryPrice, entryFee, slippageCost, qty, _liveOrderInfo = null;
    try {
      const exec = await execution.executeEntry({
        bot: KRONOS_BOT,
        state, token: sig.token, side, signalPrice,
        stopPrice: _execStop, stars: sig.stars,
        riskPct: KRONOS_RISK_PCT,            // gebruik KRONOS-specifieke risk
        riskMultiplier: 1.0,
        starMultMap: KRONOS_STAR_MULT,
        maxSizePctOfBalance: KRONOS_MAX_SIZE_PCT,
        atrPct,
        leverage: parseInt(process.env.BINANCE_FUT_LEVERAGE || '3', 10),
      });
      if (!exec) { _kSkip(sig, 'execution returned null (size guard)', 'exec_null'); continue; }
      entryPrice = exec.entryPrice;
      qty = exec.qty;
      sizeUsd = exec.sizeUsd;                 // gebruik echte gerealiseerde sizeUsd
      entryFee = exec.entryFee;
      slippageCost = exec.slippageCost;
      _liveOrderInfo = exec._live || null;
    } catch (e) {
      _kSkip(sig, `live-entry FAILED: ${e.message}`, 'live_entry_failed');
      continue;
    }

    // Stop & target schalen mee met de gerealiseerde entryPrice (i.p.v. signal mid)
    const stop = side === 'LONG' ? entryPrice * (1 - KRONOS_STOP_PCT/100) : entryPrice * (1 + KRONOS_STOP_PCT/100);
    const target = Number(sig.forecast) || (side === 'LONG' ? entryPrice * (1 + Math.abs(sig.pct)/100) : entryPrice * (1 - Math.abs(sig.pct)/100));
    // Target1 = halverwege entry → target (≈ 0.5R partial take-profit, zoals paper-engine)
    const target1 = side === 'LONG'
      ? entryPrice + (target - entryPrice) * 0.5
      : entryPrice - (entryPrice - target) * 0.5;
    const id = Date.now() + '_' + Math.random().toString(36).slice(2, 8);

    const rec = {
      id, bot: KRONOS_BOT,
      token: sig.token, market: sig.token + '-USDT', side,
      qty, entryPrice, signalPrice, sizeUsd,
      initialQty: qty, initialSizeUsd: sizeUsd,
      stop, initialStop: stop, target, target1,
      atr: Math.abs(entryPrice * KRONOS_STOP_PCT/100),
      stars: sig.stars, openTime: Date.now(),
      kronosDirection: sig.direction,
      partialClosed: false, breakeven: false,
      highWaterMark: entryPrice, lowWaterMark: entryPrice,
      fills: { entryFee, slippageCost, venue: VENUE },
      fundingAccrued: 0,
      meta: { source: 'kronos', forecast: sig.forecast, pct: sig.pct, sigTime: sig.time },
      _live: _liveOrderInfo,    // null in paper, { orderId, network, ... } in live
    };
    positions[id] = rec;
    state.balance -= sizeUsd;   // volle size gereserveerd; fee is al in cost-basis verwerkt
    opened.push({
      token: sig.token, side, signalPrice, entryPrice, stop, target,
      sizeUsd, stars: sig.stars, entryFee: +entryFee.toFixed(4),
      slippageBps: +(((entryPrice/signalPrice - 1) * 1e4 * (side==='LONG'?1:-1)).toFixed(2)),
      id,
    });
    try { signalAudit.record({ bot: 'paper_kronos', token: sig.token, outcome: 'opened', reason: 'OPENED', tag: 'opened', meta: { stars: sig.stars, side, sizeUsd, entryPrice } }); } catch {}
  }

  if (opened.length > 0) {
    await kSavePositions(positions);
    await kSaveState(state);
  }
  return { opened, skipped };
}

// ── Helper: sluit (deel van) een positie met realistische fees + funding ──
async function kClosePosition(state, positions, pos, triggerPrice, reason, partialPct = 1.0) {
  const atrPct = KRONOS_STOP_PCT / 100;

  // Route via execution layer — paper sim of live exchange close (KRONOS_LIVE_NETWORK)
  let exitPrice, closeQty, closeSizeUsd, exitFee, exitSlippage, _liveExitInfo = null;
  try {
    const exec = await execution.executeExit({
      bot: pos.bot || KRONOS_BOT,
      pos, exitSignalPrice: triggerPrice, reason, partialPct, atrPct,
    });
    exitPrice = exec.exitPrice;
    closeQty = exec.closeQty;
    closeSizeUsd = exec.closeSizeUsd;
    exitFee = exec.exitFee;
    exitSlippage = exec.slippageCost;
    _liveExitInfo = exec._live || null;
  } catch (e) {
    // In LIVE mode kan exit failen (network/exchange) — log + bail. Positie blijft
    // open in onze state, reconciliation cron zal drift detecteren.
    console.warn(`[Kronos] exit FAILED ${pos.token} ${pos.side}: ${e.message}`);
    throw e;
  }

  // Funding (perpetuals): LONG betaalt, SHORT ontvangt — afgetrokken in netPnl.
  const funding = computeFunding({
    pos: { ...pos, sizeUsd: closeSizeUsd },
    periodMs: Date.now() - pos.openTime,
  });

  // FIX P0-7: gebruik portfolio.closePositionRecord helper voor UNIFORM schema
  // (zelfde als Merlijn). Voorheen: {...pos, ...} spread → mismatched keys waardoor
  // dashboard verkeerde labels rendereerde (de "EW" bug). Helper produceert ook
  // de fees+trail blokken die het frontend verwacht.
  const reasonStr = partialPct >= 0.999 ? reason : `${reason} (partial ${Math.round(partialPct*100)}%)`;
  const trade = portfolio.closePositionRecord(state, positions, pos.id, exitPrice, reasonStr, {
    partialPct,
    fees: {
      exit: exitFee,
      spread: 0,                    // Kronos heeft geen aparte spread-cost (zit in slippage)
      slippage: exitSlippage,
      funding,                      // P0-2 al verdisconteerd in pnl via fees.funding pad
    },
  });
  if (!trade) {
    throw new Error(`closePositionRecord returned null for ${pos.id}`);
  }
  // Kronos-specifieke metadata bovenop standaard schema (niet-conflicterend)
  trade.triggerPrice = triggerPrice;
  trade._liveExit = _liveExitInfo;
  trade.grossPnl = trade.pnl + exitFee + funding + (pos.fills?.entryFee || 0) * partialPct;
  trade.kronosDirection = pos.kronosDirection;
  trade.meta = pos.meta;

  // Partial-only state-bookkeeping (closePositionRecord doet de qty/sizeUsd reductie al)
  if (partialPct < 0.999) {
    const updatedPos = positions[pos.id];
    if (updatedPos) {
      updatedPos.partialClosedAt = Date.now();
      updatedPos.realizedPnl = (updatedPos.realizedPnl || 0) + trade.pnl;
    }
  }

  await kRecordTrade(trade);
  return {
    full: partialPct >= 0.999,
    reason: trade.reason, exitPrice,
    grossPnl: trade.grossPnl, netPnl: trade.pnl, pnlPct: trade.pnlPct,
    exitFee, funding,
  };
}

// ── Manage open paper_kronos posities — zelfde regels als paper-engine ──
// 1) update high/low water marks   2) time-exit
// 3) breakeven activatie           4) progressive trailing
// 5) partial close op target1      6) hard stop / full target
async function manageKronosPositions(currentPrices, candleMap = {}) {
  const state = await kLoadState();
  const positions = await kLoadPositions();
  const openList = Object.values(positions);
  const closed = [];
  const updates = [];

  // P0-FIX (audit-2026-04-23): per-position try/catch — voorheen liet één failed
  // exit (network/Binance error) de hele manage-loop crashen waardoor alle andere
  // perpetuals die tick stop-trigger missen. Op futures = 2-20x hefboom = sneller
  // catastrofaal dan spot. Nu: log failure, alert, continue met de rest.
  const manageFailedKr = [];
  for (const pos of openList) {
    const live = currentPrices[pos.token];
    if (!live) continue;
    try {
    // FIX 2026-04-22: prefer 4h candle high/low voor wick-based trigger detection.
    // Zonder dit miste Kronos snelle wicks die stop raakten maar terugkwamen voor de
    // volgende cron-poll (cron-gap kan 1h+ zijn op GitHub Actions). Fallback live als
    // candle-fetch mislukt → minstens niet slechter dan oude gedrag.
    const candle = candleMap[pos.token];
    const wickHigh = candle && Number.isFinite(candle.high) ? candle.high : live;
    const wickLow  = candle && Number.isFinite(candle.low)  ? candle.low  : live;
    const atr = pos.atr || (pos.entryPrice * KRONOS_STOP_PCT / 100);
    const holdH = (Date.now() - pos.openTime) / 3.6e6;

    // Backfill voor pre-trail posities (zodat oude trades ook de strategie krijgen)
    if (!pos.target1 && pos.target && pos.entryPrice) {
      pos.target1 = pos.side === 'LONG'
        ? pos.entryPrice + (pos.target - pos.entryPrice) * 0.5
        : pos.entryPrice - (pos.entryPrice - pos.target) * 0.5;
    }
    if (pos.initialQty == null) pos.initialQty = pos.qty;
    if (pos.initialSizeUsd == null) pos.initialSizeUsd = pos.sizeUsd;

    // 1. Water marks — gebruik wickHigh/wickLow zodat ze wicks vangen tussen runs.
    if (pos.side === 'LONG') {
      if (!pos.highWaterMark || wickHigh > pos.highWaterMark) pos.highWaterMark = wickHigh;
      if (!pos.lowWaterMark  || wickLow  < pos.lowWaterMark)  pos.lowWaterMark  = wickLow;
    } else {
      if (!pos.lowWaterMark  || wickLow  < pos.lowWaterMark)  pos.lowWaterMark  = wickLow;
      if (!pos.highWaterMark || wickHigh > pos.highWaterMark) pos.highWaterMark = wickHigh;
    }

    // 2. Time exit (alleen als nog niet veel winst)
    if (holdH > KRONOS_MAX_HOLD_HOURS) {
      const uPct = pos.side === 'LONG'
        ? (live - pos.entryPrice)/pos.entryPrice * 100
        : (pos.entryPrice - live)/pos.entryPrice * 100;
      if (uPct < 1.0) {
        const r = await kClosePosition(state, positions, pos, live, `Time Exit (${KRONOS_MAX_HOLD_HOURS}u)`, 1.0);
        closed.push({ token: pos.token, side: pos.side, reason: r.reason, pnl: +r.netPnl.toFixed(4), pnlPct: +r.pnlPct.toFixed(2) });
        continue;
      }
    }

    // 3. Breakeven — als profit ≥ 1× ATR, trek stop op naar entry + 0.1×ATR
    if (!pos.breakeven && atr > 0) {
      const profit = pos.side === 'LONG' ? live - pos.entryPrice : pos.entryPrice - live;
      if (profit >= atr * KRONOS_BREAKEVEN_ATR) {
        pos.breakeven = true;
        if (pos.side === 'LONG')  pos.stop = Math.max(pos.stop, pos.entryPrice + atr * 0.1);
        else                       pos.stop = Math.min(pos.stop, pos.entryPrice - atr * 0.1);
        updates.push({ token: pos.token, type: 'breakeven', stop: pos.stop });
      }
    }

    // 4. Progressive trailing — nadat breakeven actief is
    if (pos.breakeven && atr > 0) {
      const profitPct = pos.side === 'LONG'
        ? (live - pos.entryPrice)/pos.entryPrice * 100
        : (pos.entryPrice - live)/pos.entryPrice * 100;
      const trailMult = progressiveTrailMult(profitPct);
      if (pos.side === 'LONG') {
        const newTrail = pos.highWaterMark - atr * trailMult;
        if (newTrail > pos.stop) { pos.stop = newTrail; updates.push({ token: pos.token, type: 'trail', stop: pos.stop, mult: trailMult }); }
      } else {
        const newTrail = pos.lowWaterMark + atr * trailMult;
        if (newTrail < pos.stop) { pos.stop = newTrail; updates.push({ token: pos.token, type: 'trail', stop: pos.stop, mult: trailMult }); }
      }
    }

    // 5. Partial close op target1 (50%) — gebruik wick zodat we intra-candle vullen
    if (!pos.partialClosed && pos.target1) {
      const hit = pos.side === 'LONG' ? wickHigh >= pos.target1 : wickLow <= pos.target1;
      if (hit) {
        const r = await kClosePosition(state, positions, pos, pos.target1, 'Target 1', KRONOS_PARTIAL_PCT);
        closed.push({ token: pos.token, side: pos.side, reason: r.reason + ' partial', pnl: +r.netPnl.toFixed(4), pnlPct: +r.pnlPct.toFixed(2) });
        // Continue → check stop/target ook nog na partial (zelfde tick kan trigger missen → ok)
      }
    }

    // 6. Hard stop / full target — wickLow voor LONG-stop & SHORT-target,
    //    wickHigh voor SHORT-stop & LONG-target. Zo simuleren we de manier waarop
    //    een echte stop-order op een exchange door een wick wordt geraakt, zelfs als
    //    de candle weer terug sluit boven/onder het stop-niveau.
    let triggerPrice = null, reason = null;
    if (pos.side === 'LONG') {
      if (wickLow  <= pos.stop)   { triggerPrice = pos.stop;   reason = pos.breakeven ? 'Trailing Stop' : 'Stop-Loss'; }
      else if (wickHigh >= pos.target) { triggerPrice = pos.target; reason = 'Target (Full)'; }
    } else {
      if (wickHigh >= pos.stop)   { triggerPrice = pos.stop;   reason = pos.breakeven ? 'Trailing Stop' : 'Stop-Loss'; }
      else if (wickLow  <= pos.target) { triggerPrice = pos.target; reason = 'Target (Full)'; }
    }
    if (triggerPrice) {
      const r = await kClosePosition(state, positions, pos, triggerPrice, reason, 1.0);
      closed.push({ token: pos.token, side: pos.side, reason, pnl: +r.netPnl.toFixed(4), pnlPct: +r.pnlPct.toFixed(2) });
    }
    } catch (mErr) {
      // P0-FIX (audit-2026-04-23): vang per-positie error op zodat een failed
      // exit (network/Binance) de loop niet aborteert; andere posities krijgen
      // wél hun stop/target check deze tick. Reconcile cron flagt drift.
      manageFailedKr.push({ token: pos.token, id: pos.id, err: mErr.message });
      console.warn(`[Kronos] ❌ manage FAIL ${pos.token} (${pos.id}): ${mErr.message}`);
    }
  }
  if (manageFailedKr.length > 0) {
    try {
      const tg = require('./_lib/telegram');
      await tg.sendAlert({
        severity: 'critical',
        title: `Kronos manage-loop ${manageFailedKr.length} exit failure(s)`,
        message: `Perpetuals die niet gemanaged konden worden: ${manageFailedKr.map(f => f.token).join(', ')}. Hefboom maakt missed-stop catastrofaal — checken!`,
        dedupeKey: `manage_fail_paper_kronos`,
      });
    } catch {}
  }

  // Persist state altijd (water marks + breakeven + trail updates moeten bewaard)
  await kSavePositions(positions);
  await kSaveState(state);
  return { closed, updates, openCount: Object.keys(positions).length };
}

// ── State endpoint voor dashboard ──
async function kronosStateForDashboard() {
  const state = await kLoadState();
  const positions = Object.values(await kLoadPositions());
  const trades = await kListTrades(50);

  // Mark-to-market via meerdere bronnen (Vercel kan Binance blokkeren)
  // Volgorde: Coinbase (USD) → Binance (USDT) → Kronos forecast.current
  const currentMap = {};
  async function tryFetch(url, parser) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3500);
      const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'merlin-kronos/1.0' } });
      clearTimeout(t);
      if (!r.ok) return null;
      return parser(await r.json());
    } catch { return null; }
  }
  await Promise.all(positions.map(async p => {
    const tok = p.token;
    let price = await tryFetch(
      `https://api.coinbase.com/v2/prices/${tok}-USD/spot`,
      j => j && j.data && j.data.amount ? parseFloat(j.data.amount) : null
    );
    if (!price) {
      price = await tryFetch(
        `https://api.binance.com/api/v3/ticker/price?symbol=${tok}USDT`,
        j => j && j.price ? parseFloat(j.price) : null
      );
    }
    if (!price) {
      try {
        const f = await fetchOne(tok + 'USDT');
        if (!f.offline && f.current) price = f.current;
      } catch {}
    }
    if (price) currentMap[tok] = price;
  }));

  // ── Mark-to-market NET (na geschatte exit-fee + funding tot nu) ──
  // Realistisch = wat zou ik hebben als ik nu market-sell zou doen?
  let pv = state.balance;
  const enrichedPositions = positions.map(p => {
    const live = currentMap[p.token] || p.entryPrice;
    // Gross unrealized (live − entry × qty)
    let grossUnrealized;
    if (p.side === 'LONG') grossUnrealized = (live - p.entryPrice) * p.qty;
    else grossUnrealized = (p.entryPrice - live) * p.qty;
    // Geschatte exit-fee als we nu zouden sluiten
    const estExitFee = feeFor(Math.abs(live * p.qty), p.token);
    // Funding tot nu (LONG betaalt ≈ -, SHORT ontvangt ≈ +)
    const fundingToNow = computeFunding({ pos: p, periodMs: Date.now() - p.openTime });
    // Entry-fee zit al in cost-basis (qty werd berekend op effectiveCash), dus
    // niet nogmaals aftrekken; tonen we wel ter info.
    const netUnrealized = grossUnrealized - estExitFee - fundingToNow;
    pv += p.sizeUsd + netUnrealized;
    return {
      ...p, livePrice: live,
      unrealizedPnl: netUnrealized,
      unrealizedPct: (netUnrealized / p.sizeUsd) * 100,
      unrealizedGross: grossUnrealized,
      estCosts: { exitFee: estExitFee, funding: fundingToNow, entryFeePaid: (p.fills?.entryFee || 0) },
    };
  });

  const wins = trades.filter(t => t.pnl > 0).length;
  const losses = trades.filter(t => t.pnl <= 0).length;
  const winrate = trades.length > 0 ? wins / trades.length : 0;
  const totalRealizedPnl = trades.reduce((s, t) => s + (t.pnl || 0), 0);

  return {
    state: {
      ...state,
      portfolioValue: pv,
      pnlAll: pv - (state.startBalance || KRONOS_START_BALANCE),
      pnlPctAll: ((pv - (state.startBalance || KRONOS_START_BALANCE)) / (state.startBalance || KRONOS_START_BALANCE)) * 100,
      drawdown: state.peakEquity > 0 ? Math.max(0, ((state.peakEquity - pv) / state.peakEquity) * 100) : 0,
    },
    positions: enrichedPositions,
    trades,
    stats: { trades: trades.length, wins, losses, winrate, totalRealizedPnl },
    config: {
      startBalance: KRONOS_START_BALANCE,
      tradeSize: KRONOS_TRADE_SIZE,
      stopPct: KRONOS_STOP_PCT,
      minStars: KRONOS_MIN_STARS_TRADE,
      maxHoldHours: KRONOS_MAX_HOLD_HOURS,
      maxOpen: KRONOS_MAX_OPEN,
      venue: VENUE,
      fundingBpsPer8h: FUNDING_BPS_PER_8H,
    },
  };
}

// ── Force-close helper voor kill-switch panic ──
// Sluit een Kronos-positie op huidige markt-prijs (full close).
// In PAPER mode = sim close, in LIVE mode = market reduceOnly via execution.executeExit.
// Telegram alert wordt automatisch verstuurd.
async function closePositionByForce(posId, reason = 'FORCE_CLOSE') {
  // P1-15: acquire engine-wide lock zodat manual-close en cron-engine geen
  // concurrent state-writes kunnen doen. Zelfde reden als paper-engine.js:
  // zonder deze lock kan stale snapshot van engine een net-gesloten manual
  // close terug 'actief' schrijven.
  const lockKey = 'portfolio:lock:paper_kronos';
  const gotLock = await redis.setNxEx(lockKey, Date.now(), 90);
  if (!gotLock) {
    const err = new Error('engine lock held — close serialised, retry in a few seconds');
    err.code = 'POSITION_LOCKED';
    throw err;
  }

  let result = null;
  let alertCtx = null;
  try {
    const state = await kLoadState();
    const allPositions = await portfolio.loadPositions();
    const pos = allPositions[posId];
    if (!pos) throw new Error(`position ${posId} not found`);
    if (pos.bot !== KRONOS_BOT) throw new Error(`position ${posId} is not a Kronos position (bot=${pos.bot})`);

    // Fetch current price — primary 1m candle close
    let currentPrice = pos.entryPrice;
    try {
      const tokenObj = { short: pos.token, symbol: pos.symbol || `${pos.token}USDT`, market: pos.market };
      const candles = await fetchCandles(tokenObj, '1m', 2).catch(() => null);
      if (candles && candles.length > 0) {
        const last = candles[candles.length - 1];
        if (isFinite(last.close) && last.close > 0) currentPrice = last.close;
      }
    } catch (e) {
      console.warn(`[Kronos] closePositionByForce: price fetch fail ${pos.token}: ${e.message} — using entryPrice fallback`);
    }

    // kClosePosition needs the kronos-only positions map (since it deletes by id)
    const kronosPositions = {};
    for (const [id, p] of Object.entries(allPositions)) {
      if (p && p.bot === KRONOS_BOT) kronosPositions[id] = p;
    }

    result = await kClosePosition(state, kronosPositions, pos, currentPrice, reason, 1.0);

    // M-P0-1: cross-bot atomic save. kronosPositions is post-close (delete uitgevoerd
    // door kClosePosition). savePositionsForBot vervangt alleen Kronos-subset in Redis,
    // Merlijn-posities blijven behouden via fresh re-read inside lock.
    await portfolio.savePositionsForBot(kronosPositions, KRONOS_BOT);
    await kSaveState(state);
    alertCtx = { token: pos.token, side: pos.side, qty: pos.qty, currentPrice };
  } finally {
    try { await redis.del(lockKey); } catch {}
  }

  // Telegram alert buiten de lock (lock zo kort mogelijk vasthouden).
  if (alertCtx) {
    try {
      const tg = require('./_lib/telegram');
      await tg.sendAlert({
        severity: 'critical',
        title: `Kronos FORCE-CLOSE ${alertCtx.token}`,
        message: `${alertCtx.side} ${alertCtx.qty} @ ${alertCtx.currentPrice} | reason=${reason} | netP&L=${result?.netPnl != null ? result.netPnl.toFixed(2) : '?'}`,
        dedupeKey: `force_close_kronos_${posId}`,
      });
    } catch {}
  }

  return result;
}

// ── HTTP handler ──
module.exports = async (req, res) => {
  const action = (req.query?.action || '').toLowerCase();

  // State endpoint voor dashboard
  if (action === 'state') {
    try {
      // Merged-mode sentinel: Kronos draait nu in gedeelde portfolio:* pool.
      // Posities + balance leven in /api/portfolio-state. Dashboard moet deze
      // sandbox-panel uitschakelen om dubbeltelling te vermijden.
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, merged: true, ts: new Date().toISOString() });
    } catch (e) {
      console.error('[kronos state] error', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // Reset mode: leeg posities/trades en herinitialiseer state op KRONOS_START_BALANCE
  if (action === 'reset-kronos') {
    try {
      const fresh = {
        _version: 1, balance: KRONOS_START_BALANCE, startBalance: KRONOS_START_BALANCE,
        peakEquity: KRONOS_START_BALANCE, startDate: Date.now(), lastRun: 0,
      };
      await kSavePositions({});
      await kSaveState(fresh);
      await redis.del('kronos_paper:trades');
      return res.status(200).json({ ok: true, reset: true, startBalance: KRONOS_START_BALANCE });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // Run mode: generate signals + manage open + execute new
  if (action === 'run') {
    // FIX 2026-04-22 v2: tick-mode flag → manageOnly (skip signal-gen voor
    // sub-second close-trigger, zoals browser/worker).
    const tickMode = (req.query?.tick || '0') === '1';

    // M-P0-9 fix (2026-04-23): action=run was tot nu toe AUTH-LOOS — alleen door
    // Vercel cron via /api/cron schedule getriggerd, maar HTTP-direct kon ELKE
    // public actor de engine triggeren. Spam = DoS, kosten, premature signal-gen,
    // race-conditions met legitieme cron. Nu vereist Bearer token (CRON_SECRET of
    // KRONOS_SECRET of PAPER_ENGINE_SECRET — één moet kloppen). Als geen secret
    // configured (lokaal dev) → public, explicit opt-in via env.
    const _cronSecK = process.env.CRON_SECRET;
    const _kronosSecK = process.env.KRONOS_SECRET;
    const _paperSecK = process.env.PAPER_ENGINE_SECRET;
    const _tickSecK = process.env.TICK_SECRET;
    if (_cronSecK || _kronosSecK || _paperSecK || _tickSecK) {
      const auth = req.headers['authorization'] || req.headers['Authorization'] || '';
      const ok = (_cronSecK && auth === `Bearer ${_cronSecK}`)
              || (_kronosSecK && auth === `Bearer ${_kronosSecK}`)
              || (_paperSecK && auth === `Bearer ${_paperSecK}`)
              // Tick-mode mag ook met TICK_SECRET (browser-worker shared secret)
              || (tickMode && _tickSecK && auth === `Bearer ${_tickSecK}`);
      if (!ok) return res.status(401).json({ error: 'Unauthorized' });
    }

    // Throttle: max 1 actual run per 1.5s (atomic). Beschermt zowel cron als
    // tick-storm. Throttle is per-mode (run vs tick) zodat tick niet de full
    // cron-run blokkeert.
    if (tickMode) {
      const got = await redis.setNxEx('kronos:tick:lock', Date.now(), 1);
      if (!got) {
        return res.status(200).json({ ok: true, throttled: true, mode: 'tick' });
      }
    }

    // P1-14: overlap-lock met try/finally cleanup — voorkomt dat 2 cron-runs
    // (of cron+tick) gelijktijdig kronos posities muteren. Race kan dubbele
    // entries openen of net-gesloten trades 'terug actief' laten lijken.
    // 90s TTL = harde plafond voor stuck-lock recovery (worst-case crash → 90s
    // wachten ipv permanent geblocked).
    const lockKey = 'portfolio:lock:paper_kronos';
    const gotLock = await redis.setNxEx(lockKey, Date.now(), 90);
    if (!gotLock) {
      return res.status(200).json({ ok: true, throttled: true, reason: 'overlap-lock held by another run' });
    }

    try {
      let sigResult = { signals: [], summary: {}, ts: new Date().toISOString() };
      if (!tickMode) {
        sigResult = await generateSignals();
      }
      // Bouw current-price map uit signal data (Kronos current = recente prijs)
      const currentPrices = {};
      for (const s of sigResult.signals) currentPrices[s.token] = s.current;

      // FIX 2026-04-22: fetch 4h candles van ALLE relevante tokens — zowel open-
      // posities (voor wick-based stop detection in manageKronosPositions) als
      // signal-tokens (voor live-price gate in executeKronosTrades).
      // FIX 2026-04-22 v3: voeg óók 1m candles toe (laatste 5 candles) zodat we
      // sub-minute wicks zien — een 4h candle is "sticky" tot z'n close, dus tussen
      // cron-runs konden we wicks missen die wel binnen het laatste minuut vallen.
      // Plus: Binance ticker /ticker/price = absolute laatste prijs (sub-seconde).
      const _openPositionsForCandles = await kLoadPositions();
      const _openTokens = Object.values(_openPositionsForCandles).map(p => p.token);
      const _signalTokens = sigResult.signals.map(s => s.token);
      const _allTokens = [...new Set([..._openTokens, ..._signalTokens])];
      const candleMap = {};   // 4h candle (open/high/low/close)
      const livePrices = {};  // ticker → meest verse prijs

      async function _fetchTicker(tokenSym) {
        // Binance USDT ticker (sub-second). Fallback naar Coinbase USD bij geo-block.
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 2500);
          const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${tokenSym}USDT`, { signal: ctrl.signal });
          clearTimeout(t);
          if (r.ok) { const j = await r.json(); const p = parseFloat(j.price); if (isFinite(p) && p > 0) return p; }
        } catch {}
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 2500);
          const r = await fetch(`https://api.coinbase.com/v2/prices/${tokenSym}-USD/spot`, { signal: ctrl.signal });
          clearTimeout(t);
          if (r.ok) { const j = await r.json(); const p = parseFloat(j?.data?.amount); if (isFinite(p) && p > 0) return p; }
        } catch {}
        return null;
      }

      await Promise.all(_allTokens.map(async (sym) => {
        try {
          const tk = TOKENS.find(t => t.short === sym);
          if (!tk) return;
          // Parallelle fetch: 4h candles + 1m candles + ticker
          const [c4h, c1m, tickerPx] = await Promise.all([
            fetchCandles(tk, '4h', 5).catch(() => null),
            fetchCandles(tk, '1m', 5).catch(() => null),
            _fetchTicker(sym),
          ]);
          // Combine 4h + 1m wicks: high = max van beide, low = min van beide.
          // Dat geeft de scherpste mogelijke wick-detection: als 1m candle in de
          // laatste 5 minuten dieper of hoger ging dan de 4h candle "tot nu",
          // dan tellen we die. Plus ticker = exacte spot-prijs voor close-fill.
          let combinedHigh = -Infinity, combinedLow = Infinity, lastClose = null;
          if (c4h && c4h.length > 0) {
            const last4h = c4h[c4h.length - 1];
            if (isFinite(last4h.high)) combinedHigh = Math.max(combinedHigh, last4h.high);
            if (isFinite(last4h.low))  combinedLow  = Math.min(combinedLow,  last4h.low);
            if (isFinite(last4h.close)) lastClose = last4h.close;
          }
          if (c1m && c1m.length > 0) {
            for (const c of c1m) {
              if (isFinite(c.high)) combinedHigh = Math.max(combinedHigh, c.high);
              if (isFinite(c.low))  combinedLow  = Math.min(combinedLow,  c.low);
            }
            const last1m = c1m[c1m.length - 1];
            if (isFinite(last1m.close)) lastClose = last1m.close;
          }
          if (tickerPx && isFinite(tickerPx)) {
            combinedHigh = Math.max(combinedHigh, tickerPx);
            combinedLow  = Math.min(combinedLow,  tickerPx);
            lastClose = tickerPx;
          }
          if (isFinite(combinedHigh) && isFinite(combinedLow) && lastClose) {
            candleMap[sym] = { high: combinedHigh, low: combinedLow, close: lastClose };
            livePrices[sym] = lastClose;
            if (!currentPrices[sym]) currentPrices[sym] = lastClose;
          }
        } catch (e) {
          console.warn(`[kronos] price fetch fail ${sym}:`, e.message);
        }
      }));

      const manageResult = await manageKronosPositions(currentPrices, candleMap);
      // Tick-mode: skip executeKronosTrades (geen nieuwe trades, alleen close)
      const execResult = tickMode
        ? { opened: [], skipped: ['tick-mode: signal-gen geskipt'] }
        : await executeKronosTrades(sigResult.signals, livePrices);
      return res.status(200).json({
        ok: true,
        ts: new Date().toISOString(),
        mode: tickMode ? 'tick' : 'full',
        signals: sigResult,
        managed: manageResult,
        executed: execResult,
      });
    } catch (e) {
      console.error('[kronos run] error', e.message, e.stack);
      return res.status(500).json({ ok: false, error: e.message });
    } finally {
      // P1-14: ALTIJD lock vrijgeven, ook bij crash/throw. Anders zit volgende
      // cron-run 90s vast wachten op TTL expiry.
      try { await redis.del(lockKey); } catch {}
    }
  }

  // Signal-generator mode (info only, geen trades)
  if (action === 'signals') {
    try {
      const result = await generateSignals();
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json(result);
    } catch (e) {
      console.error('[kronos-sig] error', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // ── DefendDark Discord ingestion (called by external monitor service) ──
  // POST /api/kronos?action=defenddark_ingest
  // Body: { token, message: { id, channelId, author, content, ts, attachments?[] } }
  // Auth: header x-ingest-token must equal env DEFENDDARK_INGEST_TOKEN
  if (action === 'defenddark_ingest') {
    try {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
      const expected = process.env.DEFENDDARK_INGEST_TOKEN || '';
      const got = req.headers['x-ingest-token'] || req.query.token || '';
      if (!expected || got !== expected) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const m = body.message || {};
      if (!m.id || !m.content) return res.status(400).json({ ok: false, error: 'missing message.id/content' });
      const entry = {
        id: String(m.id),
        channelId: String(m.channelId || ''),
        channelName: String(m.channelName || ''),
        author: String(m.author || ''),
        content: String(m.content || '').slice(0, 4000),
        attachments: Array.isArray(m.attachments) ? m.attachments.slice(0, 8) : [],
        ts: m.ts || new Date().toISOString(),
        ingestedAt: new Date().toISOString(),
      };
      await redis.lpush('defenddark:messages', entry);
      await redis.ltrim('defenddark:messages', 0, 999); // keep last 1000
      return res.status(200).json({ ok: true, stored: entry.id });
    } catch (e) {
      console.error('[defenddark_ingest] error', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // GET /api/kronos?action=defenddark_recent&limit=50
  if (action === 'defenddark_recent') {
    try {
      const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
      const msgs = await redis.lrange('defenddark:messages', 0, limit - 1);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, count: msgs.length, messages: msgs });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // ── DefendDark reconciliation (server-side, triggered by GitHub Actions cron) ──
  // GET /api/kronos?action=defenddark_reconcile
  // Reads recent Discord messages from Redis, compares with our positions for
  // focus coins (HBAR/XRP/BTC/XAU/XAG), produces a Macro Positie proposal,
  // pushes ntfy summary, stores report in Redis. No Mac required.
  if (action === 'defenddark_reconcile') {
    try {
      const FOCUS = ['HBAR', 'XRP', 'BTC', 'XAU', 'XAG'];
      const PATTERNS = {
        HBAR: /\b(hbar|hedera)\b/i,
        XRP:  /\b(xrp|ripple)\b/i,
        BTC:  /\b(btc|bitcoin)\b/i,
        XAU:  /\b(xau|gold|goud)\b/i,
        XAG:  /\b(xag|silver|zilver)\b/i,
      };

      // 1) Pull recent messages
      const allMsgs = await redis.lrange('defenddark:messages', 0, 199);
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7d
      const recent = allMsgs.filter(m => {
        try { return new Date(m.ts).getTime() >= cutoff && m.author !== 'merlin-reconciler' && m.author !== 'merlin-learner'; }
        catch { return false; }
      });

      // Monitor health check
      if (recent.length < 1) {
        try {
          await fetch('https://ntfy.sh/merlijn-defenddark-7a3f9c2e1d', {
            method: 'POST',
            headers: { 'Title': '⚠️ Discord monitor lijkt offline', 'Priority': 'high', 'Tags': 'warning' },
            body: `Geen DefendDark messages in laatste 7d. Check Railway service.`,
          });
        } catch {}
        return res.status(200).json({ ok: true, alert: 'monitor_offline', recent: 0 });
      }

      // 2) Pull our state
      const dash = await kronosStateForDashboard();
      const ourByCoin = {};
      for (const p of dash.positions) {
        const base = p.symbol.replace(/USDT$|EUR$|USD$/i, '').toUpperCase();
        if (FOCUS.includes(base)) ourByCoin[base] = p;
      }

      // 3) Per coin: extract DefendDark counts/targets
      const parseTargets = (text) => {
        const out = [];
        // $X, $X.YY, $Xk, $X.YYk, €X
        const re = /[\$€]\s?([0-9]+(?:[.,][0-9]+)?)\s?([kKmM])?/g;
        let m;
        while ((m = re.exec(text)) !== null) {
          let v = parseFloat(m[1].replace(',', '.'));
          if (m[2] && /[kK]/.test(m[2])) v *= 1000;
          if (m[2] && /[mM]/.test(m[2])) v *= 1_000_000;
          if (v > 0 && v < 10_000_000) out.push(v);
        }
        return [...new Set(out)].slice(0, 8);
      };
      const parseWave = (text) => {
        const t = text;
        const counts = [];
        const re = /\b(?:wave|golf)\s*\(?([1-5ABC]|i{1,3}v?|v)\)?(?:\s*of\s*\(?([1-5ABC])\)?)?/gi;
        let m;
        while ((m = re.exec(t)) !== null) {
          counts.push(m[2] ? `${m[1]} of (${m[2]})` : m[1]);
        }
        return [...new Set(counts)].slice(0, 4);
      };
      const parseBias = (text) => {
        const t = text.toLowerCase();
        if (/\b(bullish|impuls|long|up|rally|breakout)\b/.test(t)) return 'bullish';
        if (/\b(bearish|short|down|correction|correctie|pullback|reject)\b/.test(t)) return 'bearish';
        return 'neutral';
      };

      const perCoin = {};
      for (const coin of FOCUS) {
        const matches = recent.filter(m => PATTERNS[coin].test(m.content));
        const mostRecent = matches[0]; // list is LPUSH order = newest first
        if (!matches.length) {
          perCoin[coin] = {
            count: 0,
            ddWaves: [],
            ddBias: null,
            ddTargets: [],
            ddLastSeen: null,
            ours: ourByCoin[coin] ? { side: ourByCoin[coin].side, entry: ourByCoin[coin].entry, target: ourByCoin[coin].target } : null,
            status: ourByCoin[coin] ? '◯ no DD update' : '◯ idle',
          };
          continue;
        }
        const combined = matches.slice(0, 5).map(m => m.content).join(' \n ');
        const waves = parseWave(combined);
        const bias = parseBias(combined);
        const targets = parseTargets(combined).sort((a,b)=>a-b);
        const ours = ourByCoin[coin];
        let status = '◯ no position';
        if (ours) {
          const oursBullish = ours.side === 'LONG';
          const ddBullish = bias === 'bullish';
          if (bias === 'neutral') status = '◯ DD neutral';
          else if (oursBullish === ddBullish) status = '✅ aligned';
          else status = '⚠️ DIVERGENCE';
        }
        perCoin[coin] = {
          count: matches.length,
          ddWaves: waves,
          ddBias: bias,
          ddTargets: targets,
          ddLastSeen: mostRecent.ts,
          ddSnippet: mostRecent.content.slice(0, 180),
          ours: ours ? { side: ours.side, entry: ours.entry, target: ours.target, stars: ours.stars } : null,
          status,
        };
      }

      // 4) Build markdown
      const today = new Date().toISOString().slice(0, 10);
      const lines = [`# DefendDark vs Merlin — ${today}`, ''];
      lines.push('| Coin | Onze positie | DD wave | DD bias | DD targets | Status |');
      lines.push('|------|--------------|---------|---------|------------|--------|');
      for (const coin of FOCUS) {
        const p = perCoin[coin];
        const our = p.ours ? `${p.ours.side} @${p.ours.entry}→${p.ours.target}` : '—';
        const wv = p.ddWaves.length ? p.ddWaves.join(', ') : '—';
        const bi = p.ddBias || '—';
        const tg = p.ddTargets.length ? p.ddTargets.slice(0, 4).map(v => v >= 1000 ? `$${(v/1000).toFixed(1)}k` : `$${v}`).join(', ') : '—';
        lines.push(`| ${coin} | ${our} | ${wv} | ${bi} | ${tg} | ${p.status} |`);
      }
      const divergences = FOCUS.filter(c => perCoin[c].status === '⚠️ DIVERGENCE');
      const aligned = FOCUS.filter(c => perCoin[c].status === '✅ aligned');
      lines.push('', `**Summary:** ${aligned.length} ✅ · ${divergences.length} ⚠️ · ${recent.length} DD msgs/7d`);
      if (divergences.length) lines.push(`**Divergenties:** ${divergences.join(', ')}`);
      const md = lines.join('\n');

      // 5) Macro Positie proposal
      const macroPositie = {};
      for (const coin of FOCUS) {
        const p = perCoin[coin];
        if (!p.ddBias) continue;
        macroPositie[coin] = {
          wave: p.ddWaves[0] || 'unspecified',
          bias: p.ddBias,
          targets: p.ddTargets.slice(0, 4),
          source: 'DefendDark',
          lastUpdate: p.ddLastSeen,
          ddMentions7d: p.count,
        };
      }
      await redis.set('defenddark:macro_positie_voorstel', { date: today, macroPositie, generated: new Date().toISOString() });

      // 6) Store full report in messages list (for dashboard display)
      const reportEntry = {
        id: `reconcile-${today}`,
        author: 'merlin-reconciler',
        content: md,
        ts: new Date().toISOString(),
        ingestedAt: new Date().toISOString(),
        meta: { perCoin, macroPositie, divergences, aligned: aligned.length },
      };
      await redis.lpush('defenddark:messages', reportEntry);
      await redis.ltrim('defenddark:messages', 0, 999);

      // 7) Push ntfy
      try {
        await fetch('https://ntfy.sh/merlijn-defenddark-7a3f9c2e1d', {
          method: 'POST',
          headers: {
            'Title': `DefendDark vs Merlin — ${today}`,
            'Tags': 'chart_with_upwards_trend',
            'Priority': divergences.length ? 'high' : 'default',
          },
          body: md,
        });
      } catch {}

      // 8) Extra Kronos alert on divergence
      if (divergences.length) {
        try {
          await fetch('https://ntfy.sh/merlijn-kronos-7e3ab21d4f', {
            method: 'POST',
            headers: {
              'Title': `⚠️ Macro divergence: ${divergences.join(', ')}`,
              'Tags': 'warning',
              'Priority': 'high',
            },
            body: divergences.map(c => `${c}: wij ${perCoin[c].ours?.side} — DD ${perCoin[c].ddBias}`).join('\n'),
          });
        } catch {}
      }

      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, date: today, perCoin, macroPositie, divergences, aligned: aligned.length, ddMessages7d: recent.length, markdown: md });
    } catch (e) {
      console.error('[defenddark_reconcile] error', e.message, e.stack);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // GET /api/kronos?action=defenddark_macro — read latest Macro Positie proposal
  if (action === 'defenddark_macro') {
    try {
      const data = await redis.get('defenddark:macro_positie_voorstel');
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, ...(data || { macroPositie: {}, date: null }) });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // Default: proxy single-symbol forecast (backwards-compatible)
  const { symbol = 'BTCUSDT' } = req.query;
  const data = await fetchOne(symbol);
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=300');
  return res.status(200).json(data);
};

// Export helpers voor kill-switch panic action
module.exports.closePositionByForce = closePositionByForce;
