// ═══ Merlijn Paper Trading Engine — unified portfolio model ═══
//
// Single source of truth voor 4H paper trades én ntfy pushes.
// Gebruikt gedeelde modules:
//   api/_lib/signals.js    → signalen (zelfde als signals-cron/backtest)
//   api/_lib/portfolio.js  → state, posities, trades, portfolio-wide risk caps
//   api/_lib/fills.js      → realistische fills (slippage + fee + latency)
//
// Draait elke 5-10 min via GitHub Actions dual-cron.
//
// 7 trade-filters blijven actief:
//   1. Drawdown circuit breaker    2. Consecutive loss guard
//   3. Progressive trailing stop   4. Volatility filter
//   5. Correlation guard           6. Adaptive min stars
//   7. Kronos AI veto
// + NEW 8. Portfolio-wide risk caps (per-token / cluster / totaal) via portfolio.canOpenPosition

const redis = require('./_lib/redis');
const portfolio = require('./_lib/portfolio');
const fills = require('./_lib/fills');
const bitvavo = require('./_lib/bitvavo-public');
const bn = require('./_lib/binance-public');
const execution = require('./_lib/execution');     // Paper/Live router (default paper)
const killSwitch = require('./kill-switch');       // Kill-switch checker
const telegram = require('./_lib/telegram');
const signalAudit = require('./_lib/signal-audit'); // Best-effort signal-outcome logger

// VENUE default: 'binance' (10 bps fees, dieper boek, gratis flow data via fapi).
// Override naar 'bitvavo' via env als je terug wilt.
const VENUE = (process.env.VENUE || 'binance').toLowerCase();
const USE_LIVE_BOOK = VENUE === 'bitvavo' || VENUE === 'binance';  // beide hebben book-fetch
// Bitvavo is spot-only (shorts "binnenkort beschikbaar"). Tot shorts live gaan
// weigeren we SHORT-signals in paper om 1:1 te blijven met wat executable is.
// Op Binance spot kunnen we technisch ook geen shorts, maar voor paper-sim wel toegestaan.
const SHORTS_ENABLED = (process.env.SHORTS_ENABLED || '0') === '1' || VENUE !== 'bitvavo';
// Funding alleen relevant voor perp/margin — op spot uit.
//
// P0-FIX (audit-2026-04-23): Merlijn = Binance Spot. Spot heeft GEEN funding.
// Bovendien itereerde accrueFunding over portfolio.loadPositions() = ALLE bots,
// dus ook Kronos perpetuals — Merlijn's state.balance werd vervolgens gedebiteerd
// voor andermans funding (Kronos heeft eigen state). Resultaat: bleed op Merlijn,
// phantom funding op spot posities. Kronos handelt zijn eigen funding bij close
// in kClosePosition (single charge, correct). Daarom hard uit voor Merlijn.
const FUNDING_ENABLED = false;

// Helper: kies venue-specifieke market identifier voor book-fetch.
function _venueMarket(token) {
  return VENUE === 'binance' ? (token.symbol || token.market) : (token.market || token.symbol);
}
async function _venueFetchBook(token, depth = 50) {
  const market = _venueMarket(token);
  if (!market) return null;
  if (VENUE === 'binance') return bn.fetchBook(market, depth);
  return bitvavo.fetchBook(market, depth);
}
const {
  calcATR, calcEMA, detectElliottWave,
  fetchCandles, fetchKronos,
  generateSignals, calc4hLevels,
  loadEwParams,
  computeExitScore
} = require('./_lib/signals');

const BOT = portfolio.BOTS.PAPER_4H;

// ── Runtime config: laad Redis overrides (gezet via /config pagina) ──
// Overschrijft de hardcoded constanten hieronder als de gebruiker ze via de
// config pagina heeft aangepast. Fallback naar hardcoded waarden als Redis leeg is.
async function loadRuntimeConfig() {
  try {
    const overrides = await redis.get('bot:config:overrides') || {};
    return overrides;
  } catch {
    return {};
  }
}
// Pas constanten aan op basis van Redis config (wordt aangeroepen bij elke cron run)
async function applyRuntimeConfig(cfg) {
  if (!cfg || !Object.keys(cfg).length) return;
  if (cfg.ADAPTIVE_MIN_STARS    != null) global._CFG_ADAPTIVE_MIN_STARS    = cfg.ADAPTIVE_MIN_STARS;
  if (cfg.MIN_RR                != null) global._CFG_MIN_RR                = cfg.MIN_RR;
  if (cfg.TRAIL_ATR_BASE        != null) global._CFG_TRAIL_ATR_BASE        = cfg.TRAIL_ATR_BASE;
  if (cfg.BREAKEVEN_ATR         != null) global._CFG_BREAKEVEN_ATR         = cfg.BREAKEVEN_ATR;
  if (cfg.MAX_POSITIONS         != null) global._CFG_MAX_POSITIONS         = cfg.MAX_POSITIONS;
  if (cfg.MAX_CRYPTO_LONGS      != null) global._CFG_MAX_CRYPTO_LONGS      = cfg.MAX_CRYPTO_LONGS;
  if (cfg.CASH_BUFFER_PCT       != null) global._CFG_CASH_BUFFER_PCT       = cfg.CASH_BUFFER_PCT;
  if (cfg.PARTIAL_PCT           != null) global._CFG_PARTIAL_PCT           = cfg.PARTIAL_PCT;
  if (cfg.MAX_HOLD_HOURS        != null) global._CFG_MAX_HOLD_HOURS        = cfg.MAX_HOLD_HOURS;
  if (cfg.PORTFOLIO_KILL_DD_PCT != null) global._CFG_PORTFOLIO_KILL_DD_PCT = cfg.PORTFOLIO_KILL_DD_PCT;
  if (cfg.DD_HALVE_THRESHOLD    != null) global._CFG_DD_HALVE_THRESHOLD    = cfg.DD_HALVE_THRESHOLD;
  if (cfg.DD_PAUSE_THRESHOLD    != null) global._CFG_DD_PAUSE_THRESHOLD    = cfg.DD_PAUSE_THRESHOLD;
  if (cfg.CIRCUIT_PAUSE_HOURS   != null) global._CFG_CIRCUIT_PAUSE_HOURS   = cfg.CIRCUIT_PAUSE_HOURS;
  if (cfg.REOPEN_GUARD_HOURS    != null) global._CFG_REOPEN_GUARD_HOURS    = cfg.REOPEN_GUARD_HOURS;
  if (cfg.KRONOS_VETO_PCT       != null) global._CFG_KRONOS_VETO_PCT       = cfg.KRONOS_VETO_PCT;
  if (cfg.CONSECUTIVE_LOSS_THRESHOLD != null) global._CFG_CONSECUTIVE_LOSS_THRESHOLD = cfg.CONSECUTIVE_LOSS_THRESHOLD;
  if (cfg.ADAPTIVE_LOOKBACK_TRADES   != null) global._CFG_ADAPTIVE_LOOKBACK_TRADES   = cfg.ADAPTIVE_LOOKBACK_TRADES;
  if (cfg.ADAPTIVE_WIN_RATE          != null) global._CFG_ADAPTIVE_WIN_RATE          = cfg.ADAPTIVE_WIN_RATE;
}

// ── Constants (defaults — worden overschreven door Redis config via /config pagina) ──
const _DEF_ADAPTIVE_MIN_STARS    = 4;
const _DEF_RISK_PER_TRADE        = 0.01;
const _DEF_BREAKEVEN_ATR         = 1.0;
const _DEF_TRAIL_ATR_BASE        = 1.5;
const _DEF_PARTIAL_PCT           = 0.5;
const _DEF_MAX_HOLD_HOURS        = 120;
const _DEF_MIN_RR                = 0.5;
const _DEF_MAX_POSITIONS         = parseInt(process.env.MERLIJN_MAX_OPEN || '4', 10);
const _DEF_MAX_CRYPTO_LONGS      = 4;
const _DEF_CASH_BUFFER_PCT       = 0.25;
const _DEF_PORTFOLIO_KILL_DD_PCT = 0.05;

// Getters: gebruiken Redis override indien beschikbaar, anders default
const getC = (key, def) => global[`_CFG_${key}`] != null ? global[`_CFG_${key}`] : def;
const ADAPTIVE_MIN_STARS    = () => getC('ADAPTIVE_MIN_STARS',    _DEF_ADAPTIVE_MIN_STARS);
const RISK_PER_TRADE        = () => getC('RISK_PER_TRADE',        _DEF_RISK_PER_TRADE);
const BREAKEVEN_ATR         = () => getC('BREAKEVEN_ATR',         _DEF_BREAKEVEN_ATR);
const TRAIL_ATR_BASE        = () => getC('TRAIL_ATR_BASE',        _DEF_TRAIL_ATR_BASE);
const PARTIAL_PCT           = () => getC('PARTIAL_PCT',           _DEF_PARTIAL_PCT);
const MAX_HOLD_HOURS        = () => getC('MAX_HOLD_HOURS',        _DEF_MAX_HOLD_HOURS);
const MIN_RR                = () => getC('MIN_RR',                _DEF_MIN_RR);
const MAX_POSITIONS         = () => getC('MAX_POSITIONS',         _DEF_MAX_POSITIONS);
const MAX_CRYPTO_LONGS      = () => getC('MAX_CRYPTO_LONGS',      _DEF_MAX_CRYPTO_LONGS);
const CASH_BUFFER_PCT       = () => getC('CASH_BUFFER_PCT',       _DEF_CASH_BUFFER_PCT);
const PORTFOLIO_KILL_DD_PCT = () => getC('PORTFOLIO_KILL_DD_PCT', _DEF_PORTFOLIO_KILL_DD_PCT);
// Multi-timeframe alignment: 4H signaal moet met 1D EMA200 bias agreement hebben
const MTF_ALIGNMENT_REQUIRED = (process.env.MTF_ALIGNMENT_REQUIRED || 'true').toLowerCase() !== 'false';
// Universe filter: optionele blacklist voor chronisch slecht presterende tokens.
// 2026-04: default leeg gezet — gebruiker wil ALLE 12 tokens (BTC + 9 alts) actief
// kunnen handelen op /trading. Wie alsnog wil filteren, zet env var:
//   TRADE_TOKEN_BLACKLIST=HBAR,SOL,XRP,LINK,ADA,DOT
// (oude default — gebaseerd op pre-Path-C backtest die mogelijk verouderd is).
const TRADE_TOKEN_BLACKLIST = (process.env.TRADE_TOKEN_BLACKLIST || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const VOLATILITY_MAX_ATR_PCT = 0.08;     // Optimalisatie #4
const DD_HALVE_THRESHOLD = 0.15;         // Optimalisatie #1
const DD_PAUSE_THRESHOLD = 0.25;         // Optimalisatie #1
const CIRCUIT_PAUSE_HOURS = 24;          // Optimalisatie #1
const CONSECUTIVE_LOSS_THRESHOLD = 3;    // Optimalisatie #2
const ADAPTIVE_LOOKBACK_TRADES = 7;      // Optimalisatie #6
const ADAPTIVE_WIN_RATE = 0.40;          // Optimalisatie #6
const KRONOS_VETO_PCT = 10;              // Optimalisatie #7
// Kronos-mode: 'blend' (60% swing + 40% Kronos in score & target), 'veto' (alleen veto, geen score-input), 'off'
const KRONOS_MODE = (process.env.KRONOS_MODE || 'blend').toLowerCase();
// EXIT-signal awareness — als Signal Lab een sterk EXIT-confluence afgeeft op
// een open positie, willen we de trail strakker zetten + (optioneel) partial
// forcen. Drempel komt overeen met dashboard ★★★★★ EXIT badge (|score|≥5).
const REOPEN_GUARD_HOURS = 4;           // Geen nieuwe trade op dezelfde coin binnen 4u na sluiting
const EXIT_SIGNAL_THRESHOLD = 5;
const EXIT_TRAIL_MULT_TIGHT = 0.5;       // ATR-mult voor trail bij EXIT-trigger

const TOKENS = [
  { symbol: 'BTCUSDT',  short: 'BTC',  market: 'BTC-EUR' },
  { symbol: 'ETHUSDT',  short: 'ETH',  market: 'ETH-EUR' },
  { symbol: 'SOLUSDT',  short: 'SOL',  market: 'SOL-EUR' },
  { symbol: 'RENDERUSDT',  short: 'RENDER',  market: 'RENDER-EUR' },
  { symbol: 'BNBUSDT',  short: 'BNB',  market: 'BNB-EUR' },
  { symbol: 'HBARUSDT', short: 'HBAR', market: 'HBAR-EUR' },
  { symbol: 'XRPUSDT',  short: 'XRP',  market: 'XRP-EUR' },
  // ── Universe-uitbreiding (Phase 1) — meer signaal-opportuniteiten ──
  { symbol: 'AVAXUSDT', short: 'AVAX', market: 'AVAX-EUR' },
  { symbol: 'LINKUSDT', short: 'LINK', market: 'LINK-EUR' },
  { symbol: 'ADAUSDT',  short: 'ADA',  market: 'ADA-EUR'  },
  { symbol: 'DOTUSDT',  short: 'DOT',  market: 'DOT-EUR'  },
  { symbol: 'POLUSDT',  short: 'POL',  market: 'POL-EUR'  },  // Polygon (was MATIC)
  { symbol: 'DOGEUSDT', short: 'DOGE', market: 'DOGE-EUR' },
  // ── Universe-uitbreiding (Phase 2, 2026-04-23) ──
  { symbol: 'SUIUSDT',  short: 'SUI',  market: 'SUI-EUR'  },
  { symbol: 'TRXUSDT',  short: 'TRX',  market: 'TRX-EUR'  },  // TRON (Binance ticker = TRX)
  // 2026-04-23 add-on: XLM (Stellar) — Spot $8.9M/24h, Top-30 marketcap
  { symbol: 'XLMUSDT',  short: 'XLM',  market: 'XLM-EUR'  },
  // NB: XDC is NIET op Binance gelist → niet toegevoegd (zou alleen errors geven)
  // ── AI/Cloud coins (Phase 3, v2) ──
  { symbol: 'TAOUSDT',  short: 'TAO',  market: 'TAO-EUR'  },  // Bittensor AI
  { symbol: 'FETUSDT',  short: 'FET',  market: 'FET-EUR'  },  // ASI Alliance AI
];

// ═══ Ntfy ═══
// Anti-rogue-bot defense via server-side tag filter. Elke push krijgt een
// geheime NTFY_FILTER_TAG. User's phone abonneert zich met ?tag=<filter>
// query param → ntfy.sh filtert rogue messages (zonder de geheime tag) weg
// voor ze het phone bereiken. Zie README/setup-instructions.
//
// Optioneel: NTFY_TOKEN voor ntfy.sh Supporter tier (extra auth-laag).
const NTFY_TOPIC = (process.env.NTFY_TOPIC || 'merlijn-signals-dc80da6186').trim();
const NTFY_TOKEN = (process.env.NTFY_TOKEN || '').trim();
const NTFY_FILTER_TAG = (process.env.NTFY_FILTER_TAG || 'merlin-mwur29i4qf').trim();
// Minimum stars om een ntfy push te triggeren (user policy: ≥3★).
// Geldt voor geopende 4H trades én maandelijkse swing signalen (signals-cron).
const NTFY_MIN_STARS = parseInt(process.env.NTFY_MIN_STARS || '3', 10);

function fmtPrice(v) {
  if (v == null || isNaN(v)) return '—';
  if (v < 0.01) return v.toFixed(6);
  if (v < 1) return v.toFixed(4);
  if (v < 100) return v.toFixed(2);
  return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

async function sendNtfy(title, message, tags, priority) {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (NTFY_TOKEN) headers['Authorization'] = `Bearer ${NTFY_TOKEN}`;
    // Tag-array opbouwen: originele display-tag (green_circle etc.) + geheime
    // filter-tag (onzichtbaar in notificatie, wél matchbaar in subscription).
    const tagArr = [];
    if (tags) tagArr.push(tags);
    if (NTFY_FILTER_TAG) tagArr.push(NTFY_FILTER_TAG);
    const resp = await fetch('https://ntfy.sh/', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        topic: NTFY_TOPIC, title, message, tags: tagArr.length ? tagArr : undefined, priority,
      }),
    });
    if (!resp.ok) {
      console.warn(`[ntfy] non-OK response ${resp.status} — topic=${NTFY_TOPIC} token=${NTFY_TOKEN ? 'set' : 'MISSING'}`);
      return false;
    }
    return true;
  } catch (e) { console.warn('[ntfy] fail', e.message); return false; }
}

// outcome = { opened: true, entryPrice, sizeUsd, tier, ageCandles }
// Per nieuwe policy wordt deze functie ALLEEN aangeroepen als trade geopend is
// — dus de template maakt dat klip-en-klaar: "TRADE INGENOMEN" in titel + body.
async function pushSignalNtfy(token, signal, ewWave, levels, kronos, outcome) {
  const isBuy = signal.type === 'BUY';
  const type = isBuy ? 'KOOP' : 'VERKOOP';
  const emoji = isBuy ? '⬆' : '⬇';
  const stars = '★'.repeat(signal.stars) + '☆'.repeat(5 - signal.stars);
  const sigDate = new Date(signal.time);
  const sigWhen = sigDate.toLocaleString('nl-BE', { timeZone: 'Europe/Brussels', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const rr = Math.abs(levels.uitstap - levels.instap) / Math.abs(levels.instap - levels.stop);
  const ewStr = ewWave && ewWave.currentWave !== 'unclear'
    ? `${ewWave.currentWave} (${Math.round((ewWave.primary?.confidence||0)*100)}%)`
    : 'unclear';
  const kronosStr = kronos && !kronos.offline
    ? `${kronos.direction} (${kronos.pct > 0 ? '+' : ''}${kronos.pct}%)`
    : 'offline';

  // Trade is ingenomen — duidelijke header + size + entry
  const tierTag = outcome?.tier === 'stale' ? ` · stale-tier ${outcome.ageCandles}c · 50% risk` : '';
  const entryPrice = outcome?.entryPrice;
  const sizeUsd = outcome?.sizeUsd;
  const priority = signal.stars >= 4 ? 5 : signal.stars >= 3 ? 4 : 3;
  const tag = isBuy ? 'green_circle' : 'red_circle';

  return sendNtfy(
    `${emoji} ${token.short} ${type} — TRADE INGENOMEN [4H AI Trading]`,
    `✅ TRADE INGENOMEN — ${token.short} ${type} ${stars}\n` +
    `Positie: ${isBuy ? 'LONG' : 'SHORT'} @ ${fmtPrice(entryPrice)}\n` +
    `Size: $${Math.round(sizeUsd || 0)}${tierTag}\n` +
    `Stop-loss: ${fmtPrice(levels.stop)}\n` +
    `Target: ${fmtPrice(levels.uitstap)}\n` +
    `R/R: 1:${rr.toFixed(1)}\n` +
    `Sterkte: ${signal.stars}/5\n` +
    `Signaal gegenereerd: ${sigWhen} (Brussel)\n` +
    `Signaal prijs: ${fmtPrice(signal.price)}\n` +
    `Elliott Wave: ${ewStr}\n` +
    `Kronos AI: ${kronosStr}\n` +
    `\nMerlijn 4H AI Trading`,
    tag, priority
  );
}

// ── Close-push template ──
// Gebruiker krijgt niet alleen OPEN notifs maar ook bij CLOSE (stop-loss,
// target, trailing, time-exit, partial target1). Reason + P&L in de body zodat
// je op je telefoon in één blik weet wat er gebeurd is zonder dashboard open.
async function pushClosedTradeNtfy(pos, trade, reason) {
  const isWin = trade.pnl >= 0;
  const sideEmoji = pos.side === 'LONG' ? '⬆' : '⬇';
  const outcomeEmoji = isWin ? '✅' : '⛔';
  const pnlSign = trade.pnl >= 0 ? '+' : '';
  const tag = isWin ? 'green_circle' : 'red_circle';
  // Verlies = hoge prioriteit (5), winst = normaal (4), partial = lager (3)
  const isPartial = reason && reason.toLowerCase().includes('target 1');
  const priority = isPartial ? 3 : (isWin ? 4 : 5);

  const openedAt = pos.openTime
    ? new Date(pos.openTime).toLocaleString('nl-BE', { timeZone: 'Europe/Brussels', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '—';
  const closedAt = new Date().toLocaleString('nl-BE', { timeZone: 'Europe/Brussels', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const holdH = pos.openTime ? ((Date.now() - pos.openTime) / 3.6e6).toFixed(1) : '—';
  const stars = pos.stars ? '★'.repeat(pos.stars) + '☆'.repeat(5 - pos.stars) : '';

  return sendNtfy(
    `${outcomeEmoji} ${pos.token} ${pos.side} GESLOTEN — ${reason}`,
    `${sideEmoji} ${pos.token} ${pos.side} ${stars}\n` +
    `Reden: ${reason}\n` +
    `Entry: ${fmtPrice(pos.entryPrice)}\n` +
    `Exit:  ${fmtPrice(trade.exitPrice)}\n` +
    `P&L: ${pnlSign}$${trade.pnl.toFixed(2)} (${pnlSign}${trade.pnlPct.toFixed(2)}%)\n` +
    `Hold: ${holdH}u\n` +
    `Geopend: ${openedAt}\n` +
    `Gesloten: ${closedAt} (Brussel)\n` +
    `\nMerlijn 4H AI Trading`,
    tag, priority
  );
}

// ── Stats voor adaptive filters ──
async function getStats() {
  const trades = (await portfolio.listTrades(50, BOT)) || [];
  let consecLosses = 0;
  for (const t of trades) {
    if (t.pnl < 0) consecLosses++;
    else break;
  }
  const recent = trades.slice(0, ADAPTIVE_LOOKBACK_TRADES);
  const wins = recent.filter(t => t.pnl >= 0).length;
  const winRate = recent.length > 0 ? wins / recent.length : 0.5;
  return { consecLosses, winRate, recentCount: recent.length, totalTrades: trades.length };
}

// ── Progressive trail ──
function getProgressiveTrailMult(profitPct) {
  if (profitPct >= 10) return 0.8;
  if (profitPct >= 5) return 1.2;
  return TRAIL_ATR_BASE;
}

// ── Manage open positie (stop/target/trail/partial) ──
// Gebruikt candle.high/low voor stop/target triggers — zo vangen we wicks
// die tussen 5-min cron ticks gebeurd zijn (anders missen we trades die een
// echte stop-order WEL zouden triggeren). Close wordt gebruikt voor
// breakeven-activatie + trailing adjustments (die horen bij realized move).
async function managePosition(state, positions, posId, candle, L, exitInfo) {
  const pos = positions[posId];
  if (!pos) return false;
  const atr = pos.atr || 0;
  const closePrice = candle.close;
  const highPrice  = candle.high ?? closePrice;
  const lowPrice   = candle.low  ?? closePrice;

  // ── EXIT-signal awareness ──
  // Als Signal Lab een sterk EXIT-confluence afgeeft tegen onze richting:
  //   • LONG + score ≤ -EXIT_SIGNAL_THRESHOLD  → exit-druk
  //   • SHORT + score ≥ +EXIT_SIGNAL_THRESHOLD → exit-druk
  // Reactie:
  //   1. Forceer partial close (50%) als nog niet T1 gehaald
  //   2. Trek trail strak (EXIT_TRAIL_MULT_TIGHT × ATR) — vangt komende swing
  //   3. Push ntfy zodat user weet dat bot reageert
  // Eénmalig per positie (pos.exitTriggered flag) — anders elke 5min spammen.
  const exitScore = exitInfo?.score;
  const exitTriggered = !pos.exitTriggered && atr > 0 && exitInfo && !exitInfo.insufficient && (
    (pos.side === 'LONG'  && exitScore <= -EXIT_SIGNAL_THRESHOLD) ||
    (pos.side === 'SHORT' && exitScore >=  EXIT_SIGNAL_THRESHOLD)
  );
  if (exitTriggered) {
    pos.exitTriggered = true;
    pos.exitTriggeredAt = Date.now();
    pos.exitTriggerScore = exitScore;
    L && L(`[Paper] ⚠ EXIT-signal ${pos.token} ${pos.side} score=${exitScore} → tighten trail + force partial`);

    // 1. Forceer partial close (50%) als T1 nog niet gehit
    if (!pos.partialClosed) {
      await closeAndRecord(state, positions, posId, closePrice, `EXIT-signal partial (score ${exitScore})`, PARTIAL_PCT, L);
      // pos kan nu nog open zijn (50% remainder) — verder trailen hieronder
    }

    // 2. Trek trail strak op huidige water-mark
    const tightTrail = pos.side === 'LONG'
      ? (pos.highWaterMark || closePrice) - atr * EXIT_TRAIL_MULT_TIGHT
      : (pos.lowWaterMark  || closePrice) + atr * EXIT_TRAIL_MULT_TIGHT;
    if (pos.side === 'LONG'  && tightTrail > pos.stop) pos.stop = tightTrail;
    if (pos.side === 'SHORT' && tightTrail < pos.stop) pos.stop = tightTrail;
    // Activeer breakeven-vlag zodat reguliere trail-logic hieronder verder werkt
    pos.breakeven = true;

    // 3. Ntfy push
    try {
      await sendNtfy(
        `⚠ ${pos.token} EXIT-signaal — trail strakker`,
        `${pos.side} positie krijgt EXIT-druk (score ${exitScore}).\n` +
        `Stop opgetrokken naar ${fmtPrice(pos.stop)} (${EXIT_TRAIL_MULT_TIGHT}× ATR).\n` +
        (pos.partialClosed ? `Partial al genomen — alleen trail strakker.\n` : `Partial 50% geforceerd.\n`) +
        `Entry ${fmtPrice(pos.entryPrice)} · huidige ${fmtPrice(closePrice)}\n` +
        `\nMerlijn 4H AI Trading`,
        'warning', 4
      );
    } catch {}
  }

  // Water marks volgen wicks (realistisch voor trailing stops)
  if (pos.side === 'LONG') { if (highPrice > pos.highWaterMark) pos.highWaterMark = highPrice; }
  else { if (lowPrice < pos.lowWaterMark) pos.lowWaterMark = lowPrice; }

  // Time exit — baseren op close (realized) niet wicks
  const holdH = (Date.now() - pos.openTime) / 3.6e6;
  if (holdH > MAX_HOLD_HOURS) {
    const uPct = pos.side === 'LONG'
      ? (closePrice - pos.entryPrice)/pos.entryPrice * 100
      : (pos.entryPrice - closePrice)/pos.entryPrice * 100;
    if (uPct < 1.0) {
      await closeAndRecord(state, positions, posId, closePrice, 'Time Exit (5d)', 1.0, L);
      return true;
    }
  }

  // Break-even — activeer op basis van CLOSE (realized move), niet wick
  if (!pos.breakeven && atr > 0) {
    const profit = pos.side === 'LONG' ? closePrice - pos.entryPrice : pos.entryPrice - closePrice;
    if (profit >= atr * BREAKEVEN_ATR) {
      pos.breakeven = true;
      if (pos.side === 'LONG') pos.stop = Math.max(pos.stop, pos.entryPrice + atr * 0.1);
      else pos.stop = Math.min(pos.stop, pos.entryPrice - atr * 0.1);
    }
  }

  // Progressive trailing — close voor profitPct, water marks voor trail
  if (pos.breakeven && atr > 0) {
    const profitPct = pos.side === 'LONG'
      ? (closePrice - pos.entryPrice)/pos.entryPrice * 100
      : (pos.entryPrice - closePrice)/pos.entryPrice * 100;
    const trailMult = getProgressiveTrailMult(profitPct);
    if (pos.side === 'LONG') {
      const newTrail = pos.highWaterMark - atr * trailMult;
      if (newTrail > pos.stop) pos.stop = newTrail;
    } else {
      const newTrail = pos.lowWaterMark + atr * trailMult;
      if (newTrail < pos.stop) pos.stop = newTrail;
    }
  }

  // Partial target — gebruik wicks (high voor LONG target, low voor SHORT target).
  // Exit PRIJS = pos.target1 (waar de take-profit order zou vullen), niet
  // closePrice — anders raporteer je een fills op een prijs die je nooit
  // daadwerkelijk zou krijgen bij een stop-order.
  if (!pos.partialClosed && pos.target1) {
    if (pos.side === 'LONG' && highPrice >= pos.target1) {
      await closeAndRecord(state, positions, posId, pos.target1, 'Target 1 (50%)', PARTIAL_PCT, L);
      return false;
    }
    if (pos.side === 'SHORT' && lowPrice <= pos.target1) {
      await closeAndRecord(state, positions, posId, pos.target1, 'Target 1 (50%)', PARTIAL_PCT, L);
      return false;
    }
  }

  // Hard stop / full target — triggers op wicks, exit op trigger-prijs zelf
  if (pos.side === 'LONG') {
    if (lowPrice <= pos.stop) {
      await closeAndRecord(state, positions, posId, pos.stop, pos.breakeven ? 'Trailing Stop' : 'Stop-Loss', 1.0, L);
      return true;
    }
    if (highPrice >= pos.target) {
      await closeAndRecord(state, positions, posId, pos.target, 'Target (Full)', 1.0, L);
      return true;
    }
  } else {
    if (highPrice >= pos.stop) {
      await closeAndRecord(state, positions, posId, pos.stop, pos.breakeven ? 'Trailing Stop' : 'Stop-Loss', 1.0, L);
      return true;
    }
    if (lowPrice <= pos.target) {
      await closeAndRecord(state, positions, posId, pos.target, 'Target (Full)', 1.0, L);
      return true;
    }
  }
  return false;
}

// ── Close positie via fills model + portfolio helpers ──
async function closeAndRecord(state, positions, posId, exitSignalPrice, reason, partialPct, L) {
  const pos = positions[posId];
  if (!pos) return null;
  // ATR% uit opgeslagen pos.atr (gezet bij open). Als ontbrekend → 0 (fallback).
  const atrPct = pos.atr && pos.entryPrice ? pos.atr / pos.entryPrice : null;

  // Live book voor echte VWAP-fill (venue-aware: bitvavo of binance)
  let book = null;
  if (USE_LIVE_BOOK) {
    try { book = await _venueFetchBook({ symbol: pos.symbol, market: pos.market }, 50); }
    catch (e) { L && L(`[Paper] book-fetch fail ${pos.token} (${VENUE}): ${e.message} — fallback bps`); }
  }

  // Route via execution layer — paper-sim of live exchange order (per MERLIJN_LIVE_NETWORK)
  const exit = await execution.executeExit({
    bot: pos.bot || 'paper_4h',
    pos, exitSignalPrice, reason, partialPct, atrPct, book,
  });
  const trade = portfolio.closePositionRecord(state, positions, posId, exit.exitPrice, reason, {
    partialPct,
    fees: { exit: exit.exitFee, spread: 0, slippage: exit.slippageCost }
  });
  // Bewaar live order ID in trade record voor reconciliation/audit
  if (exit._live) {
    trade._live = exit._live;
  }
  await portfolio.recordTrade(trade);
  // Reopen guard: sla sluitingstijd op per coin zodat tryOpen 4u wacht
  dedup.recentlyClosed = dedup.recentlyClosed || {};
  dedup.recentlyClosed[pos.token] = Date.now();
  L && L(`[Paper] CLOSE ${pos.side} ${pos.token} @ ${exit.exitPrice.toFixed(6)} | P&L ${trade.pnl >= 0 ? '+' : ''}$${trade.pnl.toFixed(2)} (${trade.pnlPct.toFixed(1)}%) | ${reason}`);

  // Ntfy push op CLOSE (stop-loss, target, trailing, time-exit, partial).
  // Best-effort: fout in push mag never de trade-record blokkeren.
  try {
    const ok = await pushClosedTradeNtfy(pos, trade, reason);
    if (ok) L && L(`[Paper] 🔔 ntfy push ${pos.token} ${pos.side} CLOSED (${reason})`);
  } catch (e) {
    L && L(`[Paper] ntfy close-push fail ${pos.token}: ${e.message}`);
  }

  return trade;
}

// ── Open positie met ALLE filters inclusief portfolio risk caps ──
// Returns { opened, rec?, reason?, levels? } — reason is gevuld bij weigering.
// opts: { skipLatency: bool } — gebruikt voor stale-tier trades (oudere
// signalen waar we bewust op huidige prijs willen entreren).
async function tryOpen(state, positions, token, signal, candles, kronos, riskMultiplier, minStarsOverride, L, opts = {}) {
  const side = signal.type === 'BUY' ? 'LONG' : 'SHORT';
  const signalPrice = candles[candles.length-1].close;
  // KRONOS_MODE 'veto'/'off' → geen Kronos forecast in target-blend
  const levelsKronos = (KRONOS_MODE === 'blend') ? kronos : { offline: true, pct: 0, score: 0, direction: '', forecast: null };
  const levels = calc4hLevels(candles, signal.type, levelsKronos);
  const atr = levels.atr;

  const reject = (reason) => {
    L(`[Paper] SKIP ${token.short}: ${reason}`);
    // Best-effort audit log — wrapped in try/catch zodat een Redis-fout NOOIT trade-flow breekt
    try { signalAudit.record({ bot: 'paper_4h', token: token.short, outcome: 'rejected', reason, meta: { stars: signal.stars, type: signal.type } }); } catch {}
    return { opened: false, reason, levels };
  };

  if (minStarsOverride && signal.stars < minStarsOverride) return reject(`${signal.stars}★ < ${minStarsOverride}★ adaptive min`);

  // ── Universe blacklist (chronic losers per per-token PnL backtest) ──
  if (TRADE_TOKEN_BLACKLIST.includes(token.short)) {
    return reject(`token blacklisted (${token.short} chronic loser)`);
  }

  // ── MTF: EMA600(4H) ≈ 1D EMA200 macro-bias filter ──
  if (MTF_ALIGNMENT_REQUIRED && candles.length >= 600) {
    const closesM = candles.map(c => c.close);
    const ema600Arr = calcEMA(closesM, 600);
    const ema600 = ema600Arr[ema600Arr.length - 1];
    const lastM = closesM[closesM.length - 1];
    if (ema600 && lastM) {
      const macroBull = lastM > ema600;
      if (signal.type === 'BUY'  && !macroBull) return reject(`MTF macro bear (close ${lastM.toFixed(4)} ≤ EMA600 ${ema600.toFixed(4)})`);
      if (signal.type === 'SELL' && macroBull)  return reject(`MTF macro bull (close ${lastM.toFixed(4)} > EMA600 ${ema600.toFixed(4)})`);
    }
  }

  // Volatility filter (#4)
  const atrPct = atr / signalPrice;
  if (atrPct > VOLATILITY_MAX_ATR_PCT) return reject(`ATR ${(atrPct*100).toFixed(1)}% > ${VOLATILITY_MAX_ATR_PCT*100}% (te volatiel)`);

  // Kronos veto (#7) + EMA200 regime fallback
  // Doel: countertrend trades blokkeren. Live data toonde beide SHORT-losers
  // vuurden tegen de macro-trend in. Twee lagen:
  //   1. Kronos forecast (primair) — strenge asymmetrie: SELL al bij ≥+1%,
  //      BUY bij ≤-10% (bull-bias correctie).
  //   2. EMA200(4H) regime (fallback, ALTIJD actief) — ook als Kronos online
  //      is. Macro-context check: bull regime → geen SHORTs, bear → geen LONGs.
  //      Cruciaal want Kronos kan offline gaan (zoals nu).
  const SELL_KRONOS_MAX_PCT = 1;
  if (!kronos.offline && KRONOS_MODE !== 'off') {
    if (signal.type === 'BUY' && kronos.pct <= -KRONOS_VETO_PCT) return reject(`Kronos veto BUY (${kronos.pct}%)`);
    if (signal.type === 'SELL' && kronos.pct >= SELL_KRONOS_MAX_PCT) return reject(`Kronos veto SELL bullish (+${kronos.pct}%)`);
  }
  // EMA200 regime — gratis (gebruikt candles die we al hebben).
  // 4H EMA200 ≈ 33 dagen lookback — vangt macro-trend goed.
  if (candles.length >= 200) {
    const closes = candles.map(c => c.close);
    const ema200Arr = calcEMA(closes, 200);
    const ema200 = ema200Arr[ema200Arr.length - 1];
    const lastClose = closes[closes.length - 1];
    if (ema200 && lastClose) {
      // Buffer 0.5% rond EMA om rand-flips te dempen
      const bullRegime = lastClose > ema200 * 1.005;
      const bearRegime = lastClose < ema200 * 0.995;
      if (signal.type === 'SELL' && bullRegime) return reject(`regime bull (close ${lastClose.toFixed(4)} > EMA200 ${ema200.toFixed(4)})`);
      if (signal.type === 'BUY'  && bearRegime) return reject(`regime bear (close ${lastClose.toFixed(4)} < EMA200 ${ema200.toFixed(4)})`);
    }
  }

  // Correlation guard (#5)
  if (side === 'LONG') {
    const cryptoLongs = portfolio.listOpenPositions(positions, { side: 'LONG' }).length;
    if (cryptoLongs >= MAX_CRYPTO_LONGS) return reject(`correlation guard (${cryptoLongs} LONGs open)`);
  }

  // R/R minimum
  const riskDist = Math.abs(signalPrice - levels.stop);
  const rewardDist = Math.abs(levels.uitstap - signalPrice);
  const rr = riskDist > 0 ? rewardDist/riskDist : 0;
  if (signal.stars < 4 && rr < MIN_RR) return reject(`R/R ${rr.toFixed(1)} < ${MIN_RR} min`);

  // Max posities per bot
  const openForBot = portfolio.listOpenPositions(positions, { bot: BOT }).length;
  if (openForBot >= MAX_POSITIONS) return reject(`max positions (${openForBot}/${MAX_POSITIONS})`);
  if (portfolio.listOpenPositions(positions, { token: token.short, bot: BOT }).length > 0) return reject(`al open positie in ${token.short}`);

  // Reopen guard: wacht REOPEN_GUARD_HOURS na sluiting op dezelfde coin
  const _lastClose = (dedup.recentlyClosed || {})[token.short];
  if (_lastClose) {
    const _elapsedMs = Date.now() - _lastClose;
    const _guardMs   = REOPEN_GUARD_HOURS * 60 * 60 * 1000;
    if (_elapsedMs < _guardMs) {
      const _remainMin = Math.round((_guardMs - _elapsedMs) / 60000);
      return reject(`reopen guard: ${token.short} gesloten ${Math.round(_elapsedMs/60000)}min geleden (wacht nog ${_remainMin}min)`);
    }
  }

  // ── Provisional sizing (gedeeld door cash-buffer + risk-cap checks) ──
  // Star-multiplier-tabel matcht fills.computeEntry / execution.executeEntry default.
  // riskAmount = upper-bound op riskUsd (cap-pad heeft kleinere riskUsd).
  // sizeUsd = ~25% van balance (matcht maxSizePctOfBalance default).
  const _SM = { 1:0.5, 2:0.75, 3:1.0, 4:1.5, 5:2.0 };
  const _starMult = _SM[Math.min(5, Math.max(1, signal.stars))] || 1.0;
  const _provisionalRiskUsd = state.balance * RISK_PER_TRADE * _starMult * riskMultiplier;
  const _provisionalSizeUsd = Math.min(state.balance * 0.25, _provisionalRiskUsd * 10);

  // Cash buffer guard: houd 25% startBalance vrij (dry powder voor dip-buying).
  const startBal = Number(state.startBalance || 10000);
  const cashFloor = startBal * CASH_BUFFER_PCT;
  if (Number(state.balance || 0) - _provisionalSizeUsd < cashFloor) {
    return reject(`cash buffer guard (balance €${state.balance?.toFixed(0)} − provisional €${_provisionalSizeUsd.toFixed(0)} < floor €${cashFloor.toFixed(0)})`);
  }

  // Portfolio kill-switch: 24h equity-drop > 10% → pauze
  try {
    const eqArr = state.equityCurve || [];
    if (eqArr.length > 0) {
      const cutoff = Date.now() - 24 * 3.6e6;
      const hist = eqArr.filter(p => p.time >= cutoff);
      const ref = (hist[0] || eqArr[eqArr.length - 1]).value;
      const cur = eqArr[eqArr.length - 1].value;
      if (ref > 0 && (ref - cur) / ref >= PORTFOLIO_KILL_DD_PCT) {
        return reject(`portfolio kill-switch: 24h drop ${(((ref-cur)/ref)*100).toFixed(1)}% ≥ ${(PORTFOLIO_KILL_DD_PCT*100).toFixed(0)}%`);
      }
    }
  } catch (_) {}

  // Latency (#fills) — skip voor stale-tier (we entreren bewust op current close)
  const lat = fills.checkLatency(signal.time);
  if (!lat.ok && !opts.skipLatency) return reject(`signaal te oud: ${lat.lagSec}s > ${lat.maxLagSec}s`);

  // Sizing — hergebruikt atrPct van volatility filter hierboven (geen re-declare)

  // Live book voor echte VWAP fill (venue-aware)
  let book = null;
  if (USE_LIVE_BOOK) {
    try { book = await _venueFetchBook(token, 50); }
    catch (e) { L && L(`[Paper] book-fetch fail ${token.short} (${VENUE}): ${e.message} — fallback bps`); }
  }

  // Kill-switch check vóór elk open (zowel paper als live)
  const ks = await killSwitch.isBlocked('merlijn');
  if (ks.blocked) return reject(`kill-switch active: ${ks.reason}`);

  // Portfolio risk caps (#8) — MOET vóór executeEntry want LIVE plaatst echt order.
  // Provisional riskUsd is upper-bound (zie boven); post-fill recheck pakt de
  // edge-case waar slippage de echte riskUsd hoger maakt.
  const riskCheck = portfolio.canOpenPosition(state, positions, {
    bot: BOT, token: token.short, riskUsd: _provisionalRiskUsd
  });
  if (!riskCheck.ok) return reject(riskCheck.reason);

  // Route via execution layer — paper-sim of live exchange order
  let entry;
  try {
    entry = await execution.executeEntry({
      bot: BOT,
      state, token: token.short, side, signalPrice,
      stopPrice: levels.stop, stars: signal.stars,
      riskPct: RISK_PER_TRADE, riskMultiplier,
      atrPct, book,
    });
  } catch (e) {
    L(`[Paper] LIVE entry FAILED ${token.short}: ${e.message}`);
    return reject(`live order failed: ${e.message}`);
  }
  if (!entry) return reject('invalid entry sizing');

  // Post-fill recheck met ECHTE riskUsd — kan strenger zijn als entry slipte
  const riskCheckPost = portfolio.canOpenPosition(state, positions, {
    bot: BOT, token: token.short, riskUsd: entry.riskUsd
  });
  if (!riskCheckPost.ok) {
    // Position is al in exchange! Direct sluiten via execution.executeExit
    L(`[Paper] ⚠️ Post-fill risk-cap fail ${token.short}: ${riskCheckPost.reason} — closing immediately`);
    if (entry._live) {
      try {
        await execution.executeExit({
          bot: BOT,
          pos: { token: token.short, side, qty: entry.qty, entryPrice: entry.entryPrice, sizeUsd: entry.sizeUsd },
          exitSignalPrice: entry.entryPrice, reason: `risk-cap-violation: ${riskCheckPost.reason}`,
          partialPct: 1.0, atrPct,
        });
      } catch (closeErr) {
        L(`[Paper] CRITICAL: failed to close orphan order ${token.short}: ${closeErr.message}`);
      }
    }
    return reject(`risk-cap (post-fill): ${riskCheckPost.reason}`);
  }

  // Target 1
  const target1 = side === 'LONG'
    ? entry.entryPrice + (levels.uitstap - entry.entryPrice) * 0.6
    : entry.entryPrice - (entry.entryPrice - levels.uitstap) * 0.6;

  const rec = portfolio.openPositionRecord(state, positions, {
    bot: BOT,
    token: token.short, market: token.market, symbol: token.symbol, side,
    qty: entry.qty, entryPrice: entry.entryPrice, sizeUsd: entry.sizeUsd,
    stop: levels.stop, target: levels.uitstap, target1,
    atr, stars: signal.stars,
    openTime: Date.now(),
    kronosDirection: kronos.direction || '',
    riskMultiplier,
    fills: {
      entryFee: entry.entryFee,
      slippageCost: entry.slippageCost,
      signalPrice, lagSec: lat.lagSec,
      riskUsd: entry.riskUsd,
    },
    meta: { signalTime: signal.time },
    // Live order metadata (alleen aanwezig wanneer LIVE mode actief was)
    _live: entry._live || null,
  });

  L(`[Paper] OPEN ${side} ${token.short} @ ${entry.entryPrice.toFixed(6)} | size $${entry.sizeUsd.toFixed(0)} | ${signal.stars}★ | stop ${levels.stop.toFixed(6)} | target ${levels.uitstap.toFixed(6)} | R/R 1:${rr.toFixed(1)} | risk$ ${entry.riskUsd.toFixed(2)} | fee $${entry.entryFee.toFixed(2)} | lag ${lat.lagSec}s`);
  try { signalAudit.record({ bot: 'paper_4h', token: token.short, outcome: 'opened', reason: 'OPENED', tag: 'opened', meta: { stars: signal.stars, side, sizeUsd: entry.sizeUsd, lagSec: lat.lagSec, rr: +rr.toFixed(2) } }); } catch {}
  return { opened: true, rec, levels, rr, entry, lagSec: lat.lagSec };
}

// ═══ Main engine ═══
async function runEngine(opts = {}) {
  const manageOnly = !!opts.manageOnly;
  const log = [];
  const L = (...a) => { log.push(a.join(' ')); console.log(...a); };

  if (!redis.isConfigured()) {
    L('[Paper] Redis niet geconfigureerd');
    return { ok: false, error: 'Redis not configured' };
  }

  // Overlap-lock: voorkom dat 2 cron-runs tegelijk positions muteren
  // (race waardoor net-gesloten trade 'terug actief' lijkt).
  const lockKey = 'portfolio:lock:paper_4h';
  const gotLock = await redis.setNxEx(lockKey, Date.now(), 90);
  if (!gotLock) {
    L('[Paper] Andere run houdt lock — skip deze tick');
    return { ok: true, skipped: 'locked' };
  }

  try {

  // ── Hard circuit guard — auto-trigger kill-switch bij daily/weekly loss exceed ──
  // Draait VOOR alles anders zodat we nooit nieuwe trades openen op een rode dag
  // boven de configured threshold. (Sluit bestaande posities ook niet — alleen blocks new entries.)
  //
  // P0-FIX (audit-2026-04-23): voorheen logged dit alleen, fall-through naar opens.
  // Kronos doet `return` bij c.tripped (kronos.js:333). Merlijn moet ZELF ook
  // pauseAutoTrade zetten — anders is een Redis-hiccup tussen autoPause-write en
  // kill-switch read = trades alsnog geplaatst voorbij de loss-floor.
  let circuitTripped = false;
  try {
    const circuit = require('./_lib/circuit');
    const c = await circuit.checkCircuit('merlijn');
    if (c.tripped) {
      L(`[Paper] 🛑 Hard circuit TRIPPED — ${c.kind}: ${c.reason} — geen nieuwe entries deze tick`);
      circuitTripped = true;
    }
  } catch (e) {
    L(`[Paper] circuit check error: ${e.message}`);
  }

  // Laad Redis config overrides (gezet via /config pagina) en pas toe
  const runtimeCfg = await loadRuntimeConfig();
  applyRuntimeConfig(runtimeCfg);

  // Load unified state + positions
  const state = await portfolio.loadState();
  const positions = await portfolio.loadPositions();
  // M-P0-10 fix (2026-04-23): dedup state in eigen Redis-key (per bot) zodat
  // Kronos's saveState onze lastSignals niet kan stompen. Backwards compat:
  // als state.lastSignals bestaat (legacy migration), gebruik dat als initial.
  const dedup = await portfolio.loadDedup(BOT);
  if (state.lastSignals && Object.keys(dedup.lastSignals || {}).length === 0) {
    dedup.lastSignals = state.lastSignals;
    delete state.lastSignals;
  }
  if (state.lastNtfyPush && Object.keys(dedup.lastNtfyPush || {}).length === 0) {
    dedup.lastNtfyPush = state.lastNtfyPush;
    delete state.lastNtfyPush;
  }

  // Funding accrual — alleen als venue dit ondersteunt (niet op spot).
  const nowTs = Date.now();
  const lastRunTs = state.lastRun || nowTs;
  const elapsedMs = Math.max(0, Math.min(nowTs - lastRunTs, 24 * 3600 * 1000));
  if (FUNDING_ENABLED && elapsedMs > 0 && Object.keys(positions).length > 0) {
    const fund = portfolio.accrueFunding(state, positions, elapsedMs);
    if (Math.abs(fund.total) > 0.001) {
      L(`[Paper] Funding toegepast over ${(elapsedMs/3600000).toFixed(2)}u: netto $${fund.total.toFixed(3)} (LONG betaalt, SHORT ontvangt)`);
    }
  } else if (!FUNDING_ENABLED && Object.keys(positions).length > 0) {
    L(`[Paper] Funding skipped — venue=${VENUE} (spot, geen funding)`);
  }

  // Fetch data
  const data = await Promise.all(TOKENS.map(async t => {
    const [candles, kronos] = await Promise.all([fetchCandles(t, '4h', 500), fetchKronos(t.symbol)]);
    return { token: t, candles, kronos };
  }));
  const livePrices = {};
  const liveCandles = {};
  const exitScores = {};
  for (const d of data) {
    if (d.candles && d.candles.length > 0) {
      const last = d.candles[d.candles.length-1];
      // P1-FIX (audit-2026-04-23): valideer numeric — als Binance error-payload
      // als array binnenkomt of parseFloat NaN produceert, zou pos.stop > NaN
      // false zijn → stops vuren niet die tick. Skip token als data corrupt.
      if (!Number.isFinite(last.close) || !Number.isFinite(last.high) ||
          !Number.isFinite(last.low) || last.close <= 0) {
        L(`[Paper] ⚠ skip ${d.token.short} — corrupt candle data (close=${last.close})`);
        continue;
      }
      livePrices[d.token.short] = last.close;
      liveCandles[d.token.short] = last;
      // Exit-confluence score (-10..+10) — voor open-position management.
      // Best-effort: errors mogen run niet breken.
      try { exitScores[d.token.short] = computeExitScore(d.candles); }
      catch (e) { exitScores[d.token.short] = null; }
    }
  }

  // Peak equity
  const pv = portfolio.portfolioValue(state, positions, livePrices);
  if (pv > state.peakEquity) state.peakEquity = pv;
  const drawdown = (state.peakEquity - pv) / state.peakEquity;

  // Manage alleen positions van DEZE bot — candle meegeven zodat
  // stop/target triggers op wicks (high/low) werken, niet alleen close.
  //
  // P0-FIX (audit-2026-04-23): per-position try/catch — voorheen liet één failed
  // exit (network/Binance error/-2010 insufficient balance) de hele manage-loop
  // crashen waardoor alle andere posities die tick stop-trigger missen. Tegen
  // een gappende markt = onbegrensd verlies tot manual intervention. Nu: log+
  // alert per failure, continue met de rest. Reconcile cron checkt drift.
  const ourPositions = portfolio.listOpenPositions(positions, { bot: BOT });
  const manageFailed = [];
  for (const pos of ourPositions) {
    const candle = liveCandles[pos.token];
    if (!candle) continue;
    try {
      await managePosition(state, positions, pos.id, candle, L, exitScores[pos.token]);
    } catch (mErr) {
      manageFailed.push({ token: pos.token, id: pos.id, err: mErr.message });
      L(`[Paper] ❌ managePosition FAIL ${pos.token} (${pos.id}): ${mErr.message}`);
    }
  }
  if (manageFailed.length > 0) {
    try {
      await telegram.sendAlert({
        severity: 'critical',
        title: `Merlijn manage-loop ${manageFailed.length} exit failure(s)`,
        message: `Posities die niet gemanaged konden worden: ${manageFailed.map(f => f.token).join(', ')}. Stops/targets gemist. Reconcile cron checkt drift; intervene als nodig.`,
        dedupeKey: `manage_fail_paper_4h`,
      });
    } catch {}
  }

  // Circuit breaker
  let riskMultiplier = 1.0;
  let pauseAutoTrade = circuitTripped;   // P0-FIX: circuit-tripped uit hard guard hierboven
  if (state.circuit && state.circuit.active && Date.now() < state.circuit.until) {
    pauseAutoTrade = true;
    L(`[Paper] Circuit breaker actief tot ${new Date(state.circuit.until).toISOString()} (${state.circuit.reason})`);
  } else if (state.circuit && state.circuit.active) {
    L('[Paper] Circuit breaker afgelopen');
    state.circuit = { active: false, until: 0, reason: '' };
  }
  if (!pauseAutoTrade) {
    if (drawdown >= DD_PAUSE_THRESHOLD) {
      state.circuit = { active: true, until: Date.now() + CIRCUIT_PAUSE_HOURS*3600*1000, reason: `DD ${(drawdown*100).toFixed(1)}% > ${DD_PAUSE_THRESHOLD*100}%` };
      pauseAutoTrade = true;
      L(`[Paper] 🚨 Drawdown ${(drawdown*100).toFixed(1)}% — pauze 24u`);
    } else if (drawdown >= DD_HALVE_THRESHOLD) {
      riskMultiplier *= 0.5;
      L(`[Paper] ⚠ Drawdown ${(drawdown*100).toFixed(1)}% — risk halveren`);
    }
  }

  // Consecutive loss guard
  const stats = await getStats();
  if (stats.consecLosses >= CONSECUTIVE_LOSS_THRESHOLD) {
    riskMultiplier *= 0.5;
    L(`[Paper] ⚠ ${stats.consecLosses} losses op rij — risk halveren`);
  }

  // Adaptive min stars
  let minStarsOverride = null;
  if (stats.recentCount >= ADAPTIVE_LOOKBACK_TRADES && stats.winRate < ADAPTIVE_WIN_RATE) {
    minStarsOverride = ADAPTIVE_MIN_STARS;
    L(`[Paper] ⚠ Winrate ${(stats.winRate*100).toFixed(0)}% — min stars → ${minStarsOverride}★`);
  }

  // ── User toggle: bot disabled? skip nieuwe entries (managed-only blijft draaien) ──
  // Lazy-load om require-cycle met ops.js te vermijden.
  try {
    const botCfg = require('./_lib/bot-config');
    const enabled = await botCfg.isEnabled('paper_4h');
    if (!enabled) {
      pauseAutoTrade = true;
      L('[Paper] ⏸ Bot DISABLED via user toggle (bot:enabled:paper_4h=false) — geen nieuwe entries; bestaande posities blijven managed.');
    }
  } catch (e) {
    L(`[Paper] bot-config check error (fail-open): ${e.message}`);
  }

  // Signals + open — geskipt in manageOnly modus (tick-trigger vanuit browser/worker)
  // om cold-start latency te beperken: we willen alleen stop/target/trailing close
  // doorvoeren, geen zware signal-generation meer doen. Signal gen blijft via cron.
  if (!pauseAutoTrade && !manageOnly) {
    const ewP = loadEwParams();
    // Tiered freshness (option 3):
    //   age ≤ 6c  (~24u) → volle risk
    //   age 7-24c (~96u) → halve risk (stale-tier — wel trade, minder exposure)
    //   age > 24c        → reject (echt te oud)
    const FRESH_MAX = 6;
    const STALE_MAX = 24;
    const diag = [];
    for (const d of data) {
      if (!d.candles || d.candles.length < 60) { diag.push(`${d.token.short}: no candles`); continue; }
      // KRONOS_MODE: 'blend' = score-input; 'veto' = geen score-input (alleen veto verderop); 'off' = uit
      const kronosScore = (KRONOS_MODE === 'blend' && !d.kronos.offline) ? (d.kronos.score || 0) : 0;
      const ewWave = detectElliottWave(d.candles.map(c=>c.high), d.candles.map(c=>c.low), ewP.pivotLen, { token: d.token.short, timeframe: '4h', silent: true, provisionalLen: ewP.provisionalLen });
      const signals = generateSignals(d.candles, '4h', kronosScore, ewWave);
      if (signals.markers.length === 0) { diag.push(`${d.token.short}: no markers (EW ${ewWave.currentWave})`); continue; }
      const lastSig = signals.markers[signals.markers.length-1];
      const candleAge = d.candles.length - 1 - lastSig.index;
      if (candleAge > STALE_MAX) { diag.push(`${d.token.short}: too old ${lastSig.type} ${lastSig.stars}★ age=${candleAge}c > ${STALE_MAX}`); continue; }

      // Spot-venue filter: SHORT kan (nog) niet op Bitvavo — skip SELL signals.
      if (!SHORTS_ENABLED && lastSig.type === 'SELL') {
        diag.push(`${d.token.short}: SELL geskipt — venue=${VENUE} spot-only (SHORTS_ENABLED=0)`);
        continue;
      }

      // Tier-based risk multiplier: vers = volle risk, stale = halve risk
      const freshnessTier = candleAge <= FRESH_MAX ? 'fresh' : 'stale';
      const tierRiskMult = freshnessTier === 'fresh' ? 1.0 : 0.5;
      const effectiveRiskMult = riskMultiplier * tierRiskMult;

      // Dedup trade-opening — zelfde signaal nooit 2x verwerken
      // M-P0-10 fix: dedup leeft nu in eigen `portfolio:dedup:paper_4h` key
      dedup.lastSignals = dedup.lastSignals || {};
      const lk = dedup.lastSignals[d.token.short];
      if (lk && lk.time === lastSig.time && lk.type === lastSig.type) { diag.push(`${d.token.short}: dup ${lastSig.type}`); continue; }

      L(`[Paper] 🎯 Signaal ${d.token.short} ${lastSig.type} ${lastSig.stars}★ age=${candleAge}c [${freshnessTier}, riskMult ${effectiveRiskMult.toFixed(2)}x] @ ${lastSig.price} (EW ${ewWave.currentWave} ${Math.round((ewWave.primary?.confidence||0)*100)}%)`);
      const outcome = await tryOpen(state, positions, d.token, lastSig, d.candles, d.kronos, effectiveRiskMult, minStarsOverride, L, { skipLatency: freshnessTier === 'stale' });

      // Markeer signaal als verwerkt — ongeacht opened of rejected (zo krijg je niet elke cron-run een push voor hetzelfde signaal)
      dedup.lastSignals[d.token.short] = { time: lastSig.time, type: lastSig.type, opened: !!outcome.opened };

      // Ntfy push ALLEEN als:
      //   (1) positie daadwerkelijk geopend is (user policy: enkel ingenomen trades)
      //   (2) signaal ≥ NTFY_MIN_STARS (user policy: "enkel 3 sterren of meer")
      dedup.lastNtfyPush = dedup.lastNtfyPush || {};
      const lastNtfy = (dedup.lastNtfyPush[d.token.short] || {})['4h'];
      if (outcome.opened && lastSig.stars >= NTFY_MIN_STARS && lastNtfy !== lastSig.time) {
        const levels = outcome.levels || calc4hLevels(d.candles, lastSig.type, d.kronos);
        const ntfyOutcome = {
          opened: true,
          entryPrice: outcome.rec?.entryPrice,
          sizeUsd: outcome.rec?.sizeUsd,
          tier: freshnessTier,
          ageCandles: candleAge,
        };
        const ok = await pushSignalNtfy(d.token, lastSig, ewWave, levels, d.kronos, ntfyOutcome);
        if (ok) {
          dedup.lastNtfyPush[d.token.short] = { ...(dedup.lastNtfyPush[d.token.short]||{}), '4h': lastSig.time };
          L(`[Paper] 🔔 ntfy push ${d.token.short} ${lastSig.type} ${lastSig.stars}★ (OPENED)`);
        }
      } else if (outcome.opened && lastSig.stars < NTFY_MIN_STARS) {
        L(`[Paper] 🔕 ntfy geskipt ${d.token.short} ${lastSig.type} ${lastSig.stars}★ — onder min ${NTFY_MIN_STARS}★ (wel geopend)`);
      } else if (!outcome.opened) {
        L(`[Paper] 🔕 ntfy geskipt ${d.token.short} ${lastSig.type} ${lastSig.stars}★ — niet geopend (${outcome.reason})`);
      }

      if (outcome.opened) diag.push(`${d.token.short}: OPENED ${lastSig.type} ${lastSig.stars}★`);
      else diag.push(`${d.token.short}: ${lastSig.type} ${lastSig.stars}★ — ${outcome.reason}`);
    }
    L(`[Paper] Diag: ${diag.join(' | ')}`);
  }

  const finalPV = portfolio.portfolioValue(state, positions, livePrices);
  // P0-FIX (audit-2026-04-23): peakEquity moet ook NA closes refreshen — anders
  // blijft drawdown computation tegen een stale peak en kunnen DD-circuits
  // false-positief firen op recoveries (of late-firen omdat peak underestimated).
  if (finalPV > state.peakEquity) state.peakEquity = finalPV;
  state.lastRun = Date.now();
  portfolio.updateByBot(state, BOT, { lastRun: Date.now() });

  // M-P0-1 fix (2026-04-23): savePositionsForBot acquires shared positions-lock,
  // re-reads fresh state, en vervangt alleen DEZE bot's positions. Voorkomt dat
  // Merlijn de net-geopende Kronos positie overschrijft met een stale snapshot.
  await portfolio.savePositionsForBot(positions, BOT);
  await portfolio.saveState(state);
  // M-P0-10 fix: dedup state in eigen key (cross-bot collision-free)
  await portfolio.saveDedup(BOT, dedup);
  await portfolio.recordEquity({ time: Date.now(), value: finalPV, byBot: { [BOT]: finalPV } });

  const pnlPct = ((finalPV - state.startBalance) / state.startBalance) * 100;
  const openForBot = portfolio.listOpenPositions(positions, { bot: BOT }).length;
  L(`[Paper] Run complete — balance $${state.balance.toFixed(2)} | PV $${finalPV.toFixed(2)} | P&L ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% | ${openForBot} open (bot) | DD ${(drawdown*100).toFixed(1)}%`);

  return {
    ok: true,
    ts: new Date().toISOString(),
    bot: BOT,
    balance: state.balance,
    portfolioValue: finalPV,
    pnlPct,
    openPositions: openForBot,
    drawdown,
    circuit: state.circuit,
    riskMultiplier,
    minStars: minStarsOverride || 'config',
    log
  };

  } finally {
    try { await redis.del(lockKey); } catch {}
  }
}

// ── Force-close helper voor kill-switch panic ──
// Sluit een positie op de huidige markt-prijs (full close).
// In PAPER mode = sim close via fills.computeExit, in LIVE mode = market order
// via execution.executeExit. Telegram alert wordt automatisch verstuurd.
async function closePositionByForce(posId, reason = 'FORCE_CLOSE') {
  // P1-15: acquire engine-wide lock zodat manual-close en cron-engine geen
  // concurrent state-writes kunnen doen. Zonder deze lock zou een net-gesloten
  // manual trade door een stale engine-snapshot terug 'actief' worden geschreven
  // (engine snapshot positions[] vóór manual close, schrijft later terug).
  // 90s TTL = harde recovery cap voor stuck-lock; in praktijk <1s per tick.
  const lockKey = 'portfolio:lock:paper_4h';
  const gotLock = await redis.setNxEx(lockKey, Date.now(), 90);
  if (!gotLock) {
    const err = new Error('engine lock held — close serialised, retry in a few seconds');
    err.code = 'POSITION_LOCKED';
    throw err;
  }

  let trade = null;
  let alertCtx = null;
  try {
    const state = await portfolio.loadState();
    const positions = await portfolio.loadPositions();
    const pos = positions[posId];
    if (!pos) throw new Error(`position ${posId} not found`);

    // Fetch current price — use last close from latest 1m candle (binance USDT primary, bitvavo fallback)
    let currentPrice = pos.entryPrice; // safe fallback
    try {
      const tokenObj = { short: pos.token, symbol: pos.symbol, market: pos.market };
      const candles = await fetchCandles(tokenObj, '1m', 2).catch(() => null);
      if (candles && candles.length > 0) {
        const last = candles[candles.length - 1];
        if (isFinite(last.close) && last.close > 0) currentPrice = last.close;
      }
    } catch (e) {
      console.warn(`[Paper] closePositionByForce: price fetch fail ${pos.token}: ${e.message} — using entryPrice fallback`);
    }

    const log = (msg) => console.log(msg);
    trade = await closeAndRecord(state, positions, posId, currentPrice, reason, 1.0, log);
    await portfolio.saveState(state);
    // M-P0-1: cross-bot atomic save (zie portfolio.js)
    await portfolio.savePositionsForBot(positions, BOT);
    alertCtx = { token: pos.token, side: pos.side, qty: pos.qty, currentPrice };
  } finally {
    try { await redis.del(lockKey); } catch {}
  }

  // Telegram alert buiten de lock zodat we de lock niet langer vasthouden dan nodig.
  if (alertCtx) {
    try {
      await telegram.sendAlert({
        severity: 'critical',
        title: `Merlijn FORCE-CLOSE ${alertCtx.token}`,
        message: `${alertCtx.side} ${alertCtx.qty} @ ${alertCtx.currentPrice} | reason=${reason} | P&L=${trade?.pnl != null ? trade.pnl.toFixed(2) : '?'}`,
        dedupeKey: `force_close_${posId}`,
      });
    } catch {}
  }

  return trade;
}

// ── HTTP handler ──
module.exports = async (req, res) => {
  const action = (req.query?.action || '').toLowerCase();

  // ── Action: reset (token-protected) ──
  // Wist alle portfolio:* keys → Merlijn herstart vanaf clean state
  // (€10k startBalance, geen open posities, geen trade history).
  // Bedoeld om Bitvavo-EUR legacy posities op te ruimen na Binance-migratie.
  // GET /api/paper-engine?action=reset&token=<MERLIJN_RESET_TOKEN>
  if (action === 'reset') {
    const tok = (req.query?.token || req.headers['x-merlijn-token'] || '').toString();
    const expected = (process.env.MERLIJN_RESET_TOKEN || '').toString();
    if (!expected || tok !== expected) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    try {
      const redis = require('./_lib/redis');
      await redis.del('portfolio:state');
      await redis.del('portfolio:positions');
      await redis.del('portfolio:trades');
      await redis.del('portfolio:equity');
      // Legacy paper:* keys ook wissen voor de zekerheid
      await redis.del('paper:state');
      await redis.del('paper:positions');
      await redis.del('paper:trades');
      await redis.del('paper:equity');
      // Kronos sandbox (apart €1000 paper-bot, hoort bij Merlijn-view op /trading)
      const includeKronos = (req.query?.kronos || '1') !== '0';
      if (includeKronos) {
        await redis.del('kronos_paper:state');
        await redis.del('kronos_paper:positions');
        await redis.del('kronos_paper:trades');
        await redis.del('kronos_paper:equity');
      }
      return res.status(200).json({
        ok: true,
        reset: true,
        cleared: [
          'portfolio:state','portfolio:positions','portfolio:trades','portfolio:equity',
          'paper:state','paper:positions','paper:trades','paper:equity',
          ...(includeKronos ? ['kronos_paper:state','kronos_paper:positions','kronos_paper:trades','kronos_paper:equity'] : []),
        ],
        ts: new Date().toISOString(),
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // ── Action: close-position (PUBLIC, single position close) ──
  // User klikt "Close" in dashboard → POST /api/paper-engine?action=close-position&id=<posId>&reason=Manual
  //
  // ARCHITECTUUR: server is single source of truth voor open posities + trade
  // records. Eerder deed de UI client-side close in localStorage, wat twee bugs
  // veroorzaakte:
  //   (1) na 30s syncServerState() kwam de positie terug (server wist niks)
  //   (2) trade record had geen `bot` field → kreeg standaard EW badge,
  //       ook voor Kronos posities die per ongeluk EW gelabeld werden
  //
  // Deze endpoint:
  //   - leest position uit portfolio:positions
  //   - bepaalt bot via position.bot (paper_4h | paper_kronos)
  //   - delegeert naar de bot-eigen closePositionByForce (met juiste prijsfetch,
  //     fee-berekening, fills, en juiste `bot` field op trade record)
  //   - retourneert closed trade record
  //
  // Auth: PUBLIC, met posId-based rate-limit (max 1 close per posId per 5s)
  // tegen double-click races. Same pattern als `tick` action: kan alleen
  // bestaande posities sluiten, geen nieuwe trades openen → laag risico.
  // P1-13: MANUAL_CLOSE_TOKEN is REQUIRED zodra LIVE_MAINNET_CONFIRM=YES_I_UNDERSTAND
  // (zonder token → 503 blocked). In paper/testnet blijft hij optioneel.
  if (action === 'close-position') {
    try {
      const posId = (req.query?.id || req.query?.posId || '').toString().trim();
      const reason = (req.query?.reason || 'Manual').toString().slice(0, 80);
      if (!posId) {
        return res.status(400).json({ ok: false, error: 'missing id query param' });
      }

      // P1-13: in LIVE mainnet mode is MANUAL_CLOSE_TOKEN VERPLICHT.
      // Een onbeschermde close-endpoint op mainnet = aanvalsvector: iedereen die
      // de URL kent kan posities sluiten (denial-of-trading, of erger: geforceerde
      // exit op slecht moment). In paper/testnet blijft hij optioneel zodat dev
      // workflow niet breekt.
      const hardToken = process.env.MANUAL_CLOSE_TOKEN || '';
      const isLive = process.env.LIVE_MAINNET_CONFIRM === 'YES_I_UNDERSTAND';
      if (isLive && !hardToken) {
        console.error('[Paper close-position] BLOCKED: live mode without MANUAL_CLOSE_TOKEN');
        return res.status(503).json({
          ok: false,
          error: 'MANUAL_CLOSE_TOKEN env required in live mainnet mode (security policy P1-13)',
        });
      }
      if (hardToken) {
        const provided = (req.headers['x-close-token'] || req.query?.token || '').toString();
        if (provided !== hardToken) {
          return res.status(401).json({ ok: false, error: 'unauthorized (MANUAL_CLOSE_TOKEN mismatch)' });
        }
      }

      // P1-15: handler doet GEEN aparte lock acquisition — closePositionByForce
      // (paper én kronos) acquireert zelf de engine-wide portfolio:lock:* zodat
      // manual-close + cron-engine echt serialiseren. POSITION_LOCKED → 429.

      // Lookup position, dispatch op bot
      const portfolio = require('./_lib/portfolio');
      const positions = await portfolio.loadPositions();
      const pos = positions[posId];
      if (!pos) {
        return res.status(404).json({ ok: false, error: `position ${posId} not found` });
      }

      let trade;
      try {
        if (pos.bot === 'paper_kronos') {
          const kronos = require('./kronos');
          if (typeof kronos.closePositionByForce !== 'function') {
            return res.status(500).json({ ok: false, error: 'kronos.closePositionByForce not exported' });
          }
          trade = await kronos.closePositionByForce(posId, reason);
        } else {
          // paper_4h, of legacy posities zonder bot field → behandel als Merlijn
          trade = await closePositionByForce(posId, reason);
        }
      } catch (closeErr) {
        if (closeErr.code === 'POSITION_LOCKED') {
          return res.status(429).json({
            ok: false, throttled: true,
            error: 'close already in progress for this position, retry in a few seconds',
          });
        }
        throw closeErr;
      }

      return res.status(200).json({
        ok: true,
        action: 'close-position',
        posId,
        bot: pos.bot || 'paper_4h',
        token: pos.token,
        reason,
        trade: trade || null,
        ts: new Date().toISOString(),
      });
    } catch (e) {
      console.error('[Paper close-position] error:', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // ── Action: tick (manageOnly) ──
  // Browser tick-trigger of externe Binance-WS worker pingt deze endpoint zodra
  // een live tick een stop/target/target1 raakt → server doet ALLEEN position
  // management (geen signal-gen, geen nieuwe trades). Voorkomt cold-start cost
  // van full runEngine. Throttle via Redis: max 1 actual run per 2 seconden.
  //
  // M-P0-9 fix (2026-04-23): tick was PUBLIC = vrij te spammen door rogue
  // actors → DoS, geforceerde slechte closes via timing, Telegram-alert spam,
  // Binance rate-limit verbruik. Nu vereist auth via TICK_SECRET / CRON_SECRET
  // / PAPER_ENGINE_SECRET (één moet kloppen). Browser tick-worker moet TICK_SECRET
  // mee in Authorization: Bearer <secret>. Als geen van de 3 secrets configured
  // is (lokaal dev), valt back op public — explicit opt-in via env.
  if (action === 'tick') {
    try {
      const tickSecret = process.env.TICK_SECRET;
      const cronSecretT = process.env.CRON_SECRET;
      const paperSecretT = process.env.PAPER_ENGINE_SECRET;
      // Als TENMINSTE één van de tick-acceptable secrets configured is → auth verplicht
      if (tickSecret || cronSecretT || paperSecretT) {
        const auth = req.headers['authorization'] || req.headers['Authorization'] || '';
        const ok = (tickSecret && auth === `Bearer ${tickSecret}`)
                || (cronSecretT && auth === `Bearer ${cronSecretT}`)
                || (paperSecretT && auth === `Bearer ${paperSecretT}`);
        if (!ok) return res.status(401).json({ error: 'Unauthorized' });
      }
      // Atomic throttle via setNxEx: max 1 actual run per 2 sec; race-safe ook
      // bij meerdere browsers/workers die tegelijk pingen.
      const TICK_THROTTLE_SEC = 2;
      const got = await redis.setNxEx('portfolio:tick:paper_4h', Date.now(), TICK_THROTTLE_SEC);
      if (!got) {
        return res.status(200).json({ ok: true, throttled: true, ttlSec: TICK_THROTTLE_SEC });
      }
      const result = await runEngine({ manageOnly: true });
      return res.status(result.ok ? 200 : 500).json({ ...result, mode: 'tick' });
    } catch (e) {
      console.error('[Paper tick] error:', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // Auth: accepteer Vercel CRON_SECRET (auto-set door Vercel cron) OF expliciet PAPER_ENGINE_SECRET.
  // FIX 2026-04-22: voorheen alleen PAPER_ENGINE_SECRET → Vercel cron werd geweigerd → engine
  // draaide alleen handmatig via syncServerState (browser-tab open). Stops misten tussen visits.
  const paperSecret = process.env.PAPER_ENGINE_SECRET;
  const cronSecret = process.env.CRON_SECRET;
  if (paperSecret || cronSecret) {
    const auth = req.headers['authorization'] || req.headers['Authorization'] || '';
    const okPaper = paperSecret && auth === `Bearer ${paperSecret}`;
    const okCron = cronSecret && auth === `Bearer ${cronSecret}`;
    if (!okPaper && !okCron) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }
  try {
    const result = await runEngine();
    return res.status(result.ok ? 200 : 500).json(result);
  } catch (e) {
    console.error('[Paper] Engine error:', e.message);
    return res.status(500).json({ error: e.message, stack: e.stack });
  }
};

// Export helpers voor kill-switch panic action
module.exports.closePositionByForce = closePositionByForce;
module.exports.runEngine = runEngine;
