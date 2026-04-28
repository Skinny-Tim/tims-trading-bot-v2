// ═══ Realistic Fill Model — slippage + fee + latency ═══
//
// Voorheen: fills op candle-close prijs, geen spread, geen latency → backtest
// liet onrealistisch winstgevende trades zien.
//
// Nu: expliciet model voor alle kosten die een echte order raakt:
//   1. Latency    — tijd tussen signaal en execution; fill op next-candle open
//   2. Spread     — bid/ask gap, asymmetrisch per side
//   3. Slippage   — market impact, in basispunten
//   4. Fees       — taker fee per side
//
// Gebruikt door: paper-engine (live paper), backtest-runner (parity), en
// camelot-runner indien je die ooit reactiveert via het unified model.
//
// Alle functies zijn PURE — geen Redis, geen side effects. Makkelijk te testen.

// ── Defaults per asset (basispunten) ──
// Schat tussen "gemiddelde spot fill op Binance" en "conservatief voor kleine caps".
// Tune deze waarden met echte broker-data of backtest-sweep.
// avgDailyVolumeUsd = ruwe schatting in $ → gebruikt voor size-impact slippage.
const FILL_DEFAULTS = {
  // per symbol — als niet aanwezig val je terug op 'default'
  BTC:     { slippageBps: 3,  spreadBps: 2,  takerFeeBps: 10, avgDailyVolumeUsd: 25e9 }, // Binance spot taker ~0.1%
  ETH:     { slippageBps: 4,  spreadBps: 3,  takerFeeBps: 10, avgDailyVolumeUsd: 12e9 },
  SOL:     { slippageBps: 6,  spreadBps: 5,  takerFeeBps: 10, avgDailyVolumeUsd: 3e9  },
  BNB:     { slippageBps: 5,  spreadBps: 4,  takerFeeBps: 10, avgDailyVolumeUsd: 2e9  },
  XRP:     { slippageBps: 8,  spreadBps: 6,  takerFeeBps: 10, avgDailyVolumeUsd: 2.5e9 },
  HBAR:    { slippageBps: 15, spreadBps: 12, takerFeeBps: 10, avgDailyVolumeUsd: 0.2e9 }, // kleinere cap, breder
  default: { slippageBps: 10, spreadBps: 8,  takerFeeBps: 10, avgDailyVolumeUsd: 0.1e9 },
};

// ── Funding rate per 8h (voor SHORT op perpetuals) ──
// Binance perps: mean funding ≈ +0.01%/8h voor majors = LONG betaalt SHORT
// 1.1% APR. Tijdens rallies kan pieken naar 0.1%/8h. We pakken conservatief
// gemiddelde — LONG betaalt, SHORT ontvangt.
const FUNDING_BPS_PER_8H = 1;            // 0.01% per 8u = 1.1% APR
const FUNDING_PERIOD_MS  = 8 * 3600 * 1000;

// ── Venue premium (Bitvavo vs Binance reference) ──
// Set via ENV VENUE_PREMIUM_BPS (default 0 = trade op Binance direct).
// Als je echt op Bitvavo handelt, tune dit naar ~15-25 bps (premium observed).
const VENUE_PREMIUM_BPS = parseFloat(process.env.VENUE_PREMIUM_BPS || '0');

// ── Venue switch ──
// VENUE=binance (default) → Binance fees (10 bps taker)
// VENUE=bitvavo → Bitvavo fees (25 bps taker) en book-based slippage
const VENUE = (process.env.VENUE || 'binance').toLowerCase();
const BITVAVO_TAKER_BPS = parseFloat(process.env.BITVAVO_TAKER_BPS || '25');
const BINANCE_TAKER_BPS = parseFloat(process.env.BINANCE_TAKER_BPS || '10');

// ── Stochastische adverse fill ──
// Elke N-de fill raakt een "slechte tick" — 2x slippage. Simuleert momenten
// waar het boek even dun is (microflits). 5% default.
const ADVERSE_FILL_PROB = parseFloat(process.env.ADVERSE_FILL_PROB || '0.05');
const ADVERSE_FILL_MULT = 2.0;

const BPS = 10000;
const MAX_SIGNAL_LATENCY_SEC = 15 * 60;  // drop fills ouder dan 15 min

function getFillParams(token) {
  const base = FILL_DEFAULTS[token] || FILL_DEFAULTS.default;
  if (VENUE === 'bitvavo') return { ...base, takerFeeBps: BITVAVO_TAKER_BPS };
  if (VENUE === 'binance') return { ...base, takerFeeBps: BINANCE_TAKER_BPS };
  return base;
}

// ── Latency check ──
// signalTimeMs  = candle close time
// nowMs         = when we're processing
// returns { ok, lagSec }
function checkLatency(signalTimeMs, nowMs = Date.now(), maxLagSec = MAX_SIGNAL_LATENCY_SEC) {
  const lagSec = Math.max(0, Math.floor((nowMs - signalTimeMs) / 1000));
  return { ok: lagSec <= maxLagSec, lagSec, maxLagSec };
}

// ── Dynamic slippage multiplier ──
// 1. Volatiliteit: hogere ATR% → breder boek, meer slip
//    atrPct 0-2% = 1x, 2-5% = lineair tot 2x, >5% = 3x
// 2. Size impact: orderSize als % van dagelijks volume
//    size/vol < 0.01% = 1x, 0.1% = 1.5x, 1% = 3x, >1% = 5x
function volSlipMult(atrPct) {
  if (!atrPct || atrPct <= 0.02) return 1.0;
  if (atrPct >= 0.05) return 3.0;
  return 1.0 + (atrPct - 0.02) / 0.03 * 1.0;   // lineair 1→2
}
function sizeSlipMult(sizeUsd, avgDailyVolumeUsd) {
  if (!sizeUsd || !avgDailyVolumeUsd) return 1.0;
  const frac = sizeUsd / avgDailyVolumeUsd;
  if (frac < 1e-4) return 1.0;                // <0.01% van volume → negligible
  if (frac < 1e-3) return 1.0 + frac / 1e-3 * 0.5;   // tot 1.5x bij 0.1%
  if (frac < 1e-2) return 1.5 + (frac - 1e-3) / 9e-3 * 1.5;  // tot 3x bij 1%
  return 3.0 + Math.min(2.0, (frac - 1e-2) * 100);  // cap 5x
}
function slipMultiplier({ atrPct, sizeUsd, avgDailyVolumeUsd, stochastic = true }) {
  const vm = volSlipMult(atrPct);
  const sm = sizeSlipMult(sizeUsd, avgDailyVolumeUsd);
  const sx = (stochastic && Math.random() < ADVERSE_FILL_PROB) ? ADVERSE_FILL_MULT : 1.0;
  return { mult: vm * sm * sx, vol: vm, size: sm, adverse: sx };
}

// ── Walk orderbook voor een bepaald size-bedrag ──
// Geeft VWAP-executieprijs terug op basis van echt Bitvavo boek.
function walkBookForSize(book, sizeEur, side, kind) {
  const isBuy = (side === 'LONG' && kind === 'ENTRY') || (side === 'SHORT' && kind === 'EXIT');
  const levels = isBuy ? book.asks : book.bids;
  if (!levels || levels.length === 0) return { error: 'empty_book' };

  const refPrice = levels[0][0];
  let qtyTotal = 0, eurTotal = 0, eurLeft = sizeEur, hit = 0;
  for (const [price, qty] of levels) {
    if (eurLeft <= 0) break;
    const levelEur = price * qty;
    if (levelEur >= eurLeft) {
      const partialQty = eurLeft / price;
      qtyTotal += partialQty; eurTotal += partialQty * price;
      eurLeft = 0; hit++;
      break;
    } else {
      qtyTotal += qty; eurTotal += levelEur; eurLeft -= levelEur; hit++;
    }
  }
  if (qtyTotal <= 0) return { error: 'no_fill' };
  const fillPrice = eurTotal / qtyTotal;
  const slipBps = Math.abs(fillPrice - refPrice) / refPrice * 10000;
  return { fillPrice, refPrice, slipBps, levelsHit: hit, leftover: eurLeft };
}

// ── Realistic fill price ──
// Voor LONG entry kopen we op ask (hoger dan mid); voor SHORT entry verkopen
// we op bid (lager dan mid). Plus slippage in de ongunstige richting.
//
// side    = 'LONG' | 'SHORT'
// kind    = 'ENTRY' | 'EXIT'
// mid     = referentieprijs (candle close of next-candle open — zie fillAtNextOpen)
// opts    = { atrPct, sizeUsd, stochastic, book } — voor dynamische slippage
//
// Als opts.book een orderbook snapshot is (bv. van Bitvavo public API), dan
// walken we door het echte boek voor de WAARE executieprijs. Dat is veel
// accurater dan onze bps-schatting voor grotere orders.
function fillPrice(mid, side, kind, token, opts = {}) {
  // Als er een échte orderbook is meegeven: gebruik die
  if (opts.book && opts.sizeUsd) {
    const w = walkBookForSize(opts.book, opts.sizeUsd, side, kind);
    if (w.fillPrice && !w.error) {
      // Venue premium bovenop (als Bitvavo ten opzichte van Binance signaal)
      const venuePrem = w.fillPrice * (VENUE_PREMIUM_BPS / BPS);
      const isBuy = (side === 'LONG' && kind === 'ENTRY') || (side === 'SHORT' && kind === 'EXIT');
      // Adverse stochastic
      const adverseMult = (opts.stochastic !== false && Math.random() < ADVERSE_FILL_PROB) ? ADVERSE_FILL_MULT : 1.0;
      const extraSlip = w.fillPrice * (w.slipBps / BPS) * (adverseMult - 1);
      return isBuy ? (w.fillPrice + venuePrem + extraSlip) : (w.fillPrice - venuePrem - extraSlip);
    }
    // Book leeg/onvolledig → val terug op bps-schatting hieronder
  }

  const p = getFillParams(token);
  const sm = slipMultiplier({
    atrPct: opts.atrPct,
    sizeUsd: opts.sizeUsd,
    avgDailyVolumeUsd: p.avgDailyVolumeUsd,
    stochastic: opts.stochastic !== false,
  });
  const halfSpread = mid * (p.spreadBps / BPS) / 2;
  const slip       = mid * (p.slippageBps / BPS) * sm.mult;
  const venuePrem  = mid * (VENUE_PREMIUM_BPS / BPS);

  // Ongunstige richting:
  //   LONG ENTRY  → betaal ask + slippage  (hoger)
  //   LONG EXIT   → ontvang bid − slippage (lager)
  //   SHORT ENTRY → ontvang bid − slippage (lager)
  //   SHORT EXIT  → betaal ask + slippage  (hoger)
  const isBuy = (side === 'LONG' && kind === 'ENTRY') || (side === 'SHORT' && kind === 'EXIT');
  // Venue premium werkt áltijd tegen je: koopt duurder, verkoopt goedkoper
  return isBuy ? (mid + halfSpread + slip + venuePrem) : (mid - halfSpread - slip - venuePrem);
}

// ── Funding ──
// Per 8u periode: LONG betaalt rate * sizeUsd, SHORT ontvangt hetzelfde.
// We prorateren per fractie van 8u (bv. 4u = 0.5).
// Returns $ bedrag dat uit balance moet (positief = kost, negatief = credit).
function computeFunding({ pos, periodMs, ratePer8hBps = FUNDING_BPS_PER_8H }) {
  const periods = periodMs / FUNDING_PERIOD_MS;
  const ratePeriod = ratePer8hBps / BPS * periods;
  // LONG betaalt, SHORT ontvangt (positieve funding = majority case)
  const sign = pos.side === 'LONG' ? +1 : -1;
  return sign * Math.abs(pos.sizeUsd || 0) * ratePeriod;
}

// ── Fees ──
function feeFor(sizeUsd, token) {
  const p = getFillParams(token);
  return Math.abs(sizeUsd) * (p.takerFeeBps / BPS);
}

// ── Fill at next-candle open (tick-accurate benadering) ──
// Voor backtest: gebruik NOOIT de candle waarin het signaal ontstond — gebruik
// de next candle's open. Dat simuleert "order placed na close, filled at open".
//
// candles        = volledige array {time,open,high,low,close}
// signalIndex    = index van candle waarin signaal werd gegenereerd
// side, kind     = zoals hierboven
// token          = voor slippage/spread params
//
// Returns { price, candleIndex, skipped:false } of { skipped:true, reason } als
// er geen next-candle is (live mode → gebruik live mid met skip=false).
function fillAtNextOpen(candles, signalIndex, side, kind, token, opts = {}) {
  const nextIdx = signalIndex + 1;
  if (nextIdx >= candles.length) {
    return { skipped: true, reason: 'no_next_candle' };
  }
  const mid = candles[nextIdx].open;
  return {
    skipped: false,
    candleIndex: nextIdx,
    mid,
    price: fillPrice(mid, side, kind, token, opts)
  };
}

// ── Complete entry berekening (size + fee + realistic entry price) ──
//
// state.balance    = beschikbaar kapitaal
// signalPrice      = candle close prijs van signaal
// stopPrice        = stop-loss (voor sizing op basis van risk per unit)
// stars            = 1..5
// riskPct          = base risk per trade (default 0.02 = 2%)
// starMultMap      = optionele override
//
// Returns null als size invalid, anders:
//   { entryPrice, qty, sizeUsd, entryFee, slippageCost, riskUsd }
function computeEntry({
  state, token, side, signalPrice, stopPrice, stars,
  riskPct = 0.02, riskMultiplier = 1.0,
  starMultMap = { 1:0.5, 2:0.75, 3:1.0, 4:1.5, 5:2.0 },
  maxSizePctOfBalance = 0.25,
  atrPct = null, stochastic = true, book = null,
}) {
  const starMult = starMultMap[Math.min(5, Math.max(1, stars))] || 1.0;
  const effectiveRiskPct = riskPct * starMult * riskMultiplier;

  const portfolioEstimate = state.balance;  // caller voegt open-size toe als gewenst
  const riskAmount = portfolioEstimate * effectiveRiskPct;

  // Eerste schatting entryPrice zonder size-impact (sizeUsd kennen we nog niet).
  // Na sizing hieronder rekenen we evt. opnieuw met size-aware slippage of echte book.
  let entryPrice = fillPrice(signalPrice, side, 'ENTRY', token, { atrPct, stochastic });
  const riskPerUnit = Math.abs(entryPrice - stopPrice);
  if (riskPerUnit <= 0) return null;

  let units = riskAmount / riskPerUnit;
  let sizeUsd = units * entryPrice;

  const maxSize = state.balance * maxSizePctOfBalance;
  if (sizeUsd > maxSize) { sizeUsd = maxSize; units = sizeUsd / entryPrice; }

  // Re-price met size-impact nu sizeUsd bekend is. Als we een echt orderbook
  // hebben (Bitvavo) gebruik die — anders bps-schatting.
  entryPrice = fillPrice(signalPrice, side, 'ENTRY', token, { atrPct, sizeUsd, stochastic: false, book });
  units   = sizeUsd / entryPrice;

  const entryFee = feeFor(sizeUsd, token);
  const effectiveSize = sizeUsd - entryFee;
  const qty = effectiveSize / entryPrice;

  if (sizeUsd < 1 || sizeUsd > state.balance) return null;

  const slippageCost = Math.abs(entryPrice - signalPrice) * qty;
  const riskUsd = Math.abs(entryPrice - stopPrice) * qty;

  return { entryPrice, qty, sizeUsd, entryFee, slippageCost, riskUsd, effectiveRiskPct };
}

// ── Complete exit berekening (realistic exit + fees) ──
function computeExit({ pos, exitSignalPrice, reason, partialPct = 1.0, atrPct = null, stochastic = true, book = null }) {
  const exitPrice = fillPrice(exitSignalPrice, pos.side, 'EXIT', pos.token, {
    atrPct, sizeUsd: pos.sizeUsd * partialPct, stochastic, book
  });
  const closeQty = pos.qty * partialPct;
  const closeSizeUsd = pos.sizeUsd * partialPct;

  let grossPnl;
  if (pos.side === 'LONG') grossPnl = (exitPrice - pos.entryPrice) * closeQty;
  else grossPnl = (pos.entryPrice - exitPrice) * closeQty;

  const exitFee = feeFor(Math.abs(exitPrice * closeQty), pos.token);
  const slippageCost = Math.abs(exitPrice - exitSignalPrice) * closeQty;

  return {
    exitPrice, closeQty, closeSizeUsd,
    pnl: grossPnl - exitFee,        // slippage zit al in exitPrice
    exitFee, slippageCost,
    reason,
  };
}

module.exports = {
  FILL_DEFAULTS, MAX_SIGNAL_LATENCY_SEC,
  FUNDING_BPS_PER_8H, FUNDING_PERIOD_MS,
  VENUE, VENUE_PREMIUM_BPS, ADVERSE_FILL_PROB,
  BITVAVO_TAKER_BPS,
  getFillParams,
  checkLatency,
  fillPrice, feeFor,
  slipMultiplier, volSlipMult, sizeSlipMult,
  walkBookForSize,
  fillAtNextOpen,
  computeEntry, computeExit,
  computeFunding,
};
