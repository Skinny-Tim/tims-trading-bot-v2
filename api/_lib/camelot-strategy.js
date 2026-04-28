// ═══ Camelot Strategy — Regime-Switching Mean-Reversion + Momentum ═══
//
// Doel: realistisch winstgevende edge op Bitvavo (spot) + Binance (spot/perp).
// Geen Elliott Wave gokken. Geen 97%-WR onzin. Pure quantitative regime detect.
//
// REGIME DETECTION (per token, per candle):
//   ADX(14) < 20  → RANGE       → mean-reversion (BB 20/2.0)
//   ADX(14) > 25  → TREND       → momentum pullback (EMA20/50)
//   anders        → NO_TRADE
//
// RANGE PLAY (mean-reversion):
//   - LONG  als close <= BB lower AND RSI(14) < 30
//   - SHORT als close >= BB upper AND RSI(14) > 70
//   - Stop:    1.0 × ATR voorbij band
//   - Target:  midline (mean) — R:R ~1.0, win rate target 60-70%
//
// TREND PLAY (momentum pullback):
//   - LONG  als EMA20 > EMA50 EN close pullback naar EMA20 (within 0.5×ATR)
//   - SHORT als EMA20 < EMA50 EN close pullback omhoog naar EMA20
//   - Stop:    1.5 × ATR
//   - Target:  3.0 × ATR (R:R 2.0)
//   - Trail:   activate bij 1.5R, tail 1.0×ATR
//
// SIZING:
//   - Risk-based: 1% van equity per trade
//   - Max 5 simultane posities (vs 10 in Elliott bot — kwaliteit > kwantiteit)
//   - Geen 2 posities op zelfde token
//
// COSTS (gebruik conservatieve schatting):
//   - Bitvavo taker: 25 bps round-trip
//   - Slippage: 5 bps per leg (uit live book als beschikbaar)
//   - Spot, geen funding
//
// Implementatie: pure functions, zelfde patroon als sim.js — testbaar.

// ── Indicators ──
function _ema(arr, period) {
  if (arr.length < period) return new Array(arr.length).fill(null);
  const k = 2 / (period + 1);
  const out = new Array(arr.length).fill(null);
  let e = arr.slice(0, period).reduce((s, v) => s + v, 0) / period;
  out[period - 1] = e;
  for (let i = period; i < arr.length; i++) {
    e = arr[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

function _sma(arr, period) {
  const out = new Array(arr.length).fill(null);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= period) sum -= arr[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function _stdev(arr, period, smaArr) {
  const out = new Array(arr.length).fill(null);
  for (let i = period - 1; i < arr.length; i++) {
    const m = smaArr[i];
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) v += (arr[j] - m) ** 2;
    out[i] = Math.sqrt(v / period);
  }
  return out;
}

function bollingerBands(closes, period = 20, k = 2.0) {
  const mid = _sma(closes, period);
  const sd = _stdev(closes, period, mid);
  const upper = mid.map((m, i) => m == null ? null : m + k * sd[i]);
  const lower = mid.map((m, i) => m == null ? null : m - k * sd[i]);
  return { mid, upper, lower, sd };
}

function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gainSum = 0, lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch > 0) gainSum += ch; else lossSum += -ch;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const g = ch > 0 ? ch : 0;
    const l = ch < 0 ? -ch : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function atr(highs, lows, closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  const trs = new Array(closes.length).fill(null);
  trs[0] = highs[0] - lows[0];
  for (let i = 1; i < closes.length; i++) {
    trs[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
  }
  let sum = 0;
  for (let i = 0; i < period; i++) sum += trs[i];
  out[period - 1] = sum / period;
  for (let i = period; i < closes.length; i++) {
    out[i] = (out[i - 1] * (period - 1) + trs[i]) / period;
  }
  return out;
}

function adx(highs, lows, closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period * 2) return out;
  const plusDM = new Array(closes.length).fill(0);
  const minusDM = new Array(closes.length).fill(0);
  const trs = new Array(closes.length).fill(0);
  for (let i = 1; i < closes.length; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDM[i] = (upMove > downMove && upMove > 0) ? upMove : 0;
    minusDM[i] = (downMove > upMove && downMove > 0) ? downMove : 0;
    trs[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
  }
  // Smoothed (Wilder) sums
  let trSum = 0, pSum = 0, mSum = 0;
  for (let i = 1; i <= period; i++) { trSum += trs[i]; pSum += plusDM[i]; mSum += minusDM[i]; }
  const dxArr = new Array(closes.length).fill(null);
  for (let i = period + 1; i < closes.length; i++) {
    trSum = trSum - trSum / period + trs[i];
    pSum  = pSum  - pSum  / period + plusDM[i];
    mSum  = mSum  - mSum  / period + minusDM[i];
    const plusDI = trSum > 0 ? 100 * pSum / trSum : 0;
    const minusDI = trSum > 0 ? 100 * mSum / trSum : 0;
    const dx = (plusDI + minusDI) > 0 ? 100 * Math.abs(plusDI - minusDI) / (plusDI + minusDI) : 0;
    dxArr[i] = dx;
  }
  // ADX = SMA of DX over `period`
  let dxSum = 0, dxCnt = 0;
  for (let i = period + 1; i < period * 2 + 1 && i < closes.length; i++) {
    if (dxArr[i] != null) { dxSum += dxArr[i]; dxCnt++; }
  }
  if (dxCnt > 0) out[period * 2] = dxSum / dxCnt;
  for (let i = period * 2 + 1; i < closes.length; i++) {
    out[i] = (out[i - 1] * (period - 1) + (dxArr[i] ?? 0)) / period;
  }
  return out;
}

// ── Regime classifier ──
function detectRegime(adxVal, opts = {}) {
  const rangeMax = opts.rangeMax ?? 20;
  const trendMin = opts.trendMin ?? 25;
  if (adxVal == null) return 'NO_TRADE';
  if (adxVal < rangeMax) return 'RANGE';
  if (adxVal > trendMin) return 'TREND';
  return 'NO_TRADE';
}

// ── Tunable signal parameters ──
// Defaults read from env vars (zo kan engine + backtest dezelfde params draaien
// zonder dat de tuner code-edits hoeft te doen). Override via opts.params bij
// elke aanroep voor grid-sweep tuning.
// Tuned params worden dagelijks geschreven naar data/camelot-params.json.
// Lookup volgorde: file → env → hard-coded default. File heeft hoogste priority
// omdat de tuner daar de beste backtest-config in commit.
//
// SAFETY NET (2026-04-22): als getunede config in backtest VERLIES geeft
// (_score < 0 OF profitFactor < 1), val terug naar env/defaults. Anders zou
// de live engine slecht-presterende params blijven gebruiken tussen tuner-runs.
// Schrijft warning naar console+module-state zodat dashboard kan tonen.
let _tunedParams = null;
let _tunedParamsMeta = { used: false, reason: null, score: null, profitFactor: null };
function _loadTunedParams() {
  if (_tunedParams !== null) return _tunedParams;  // cache hit (incl. failure → null retry)
  try {
    const path = require('path');
    const fs = require('fs');
    const p = path.join(__dirname, '..', '..', 'data', 'camelot-params.json');
    if (fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (j && j.params && typeof j.params === 'object') {
        const score = typeof j._score === 'number' ? j._score : null;
        const pf = j._stats && typeof j._stats.profitFactor === 'number' ? j._stats.profitFactor : null;
        // Reject losing tunes — better om defaults te gebruiken dan een bekende verliezer.
        if ((score !== null && score < 0) || (pf !== null && pf < 1)) {
          _tunedParamsMeta = {
            used: false,
            reason: `Tuned params rejected: score=${score?.toFixed(2)}, profitFactor=${pf?.toFixed(2)} — falling back to env/defaults`,
            score, profitFactor: pf
          };
          console.warn('[camelot-strategy] ⚠ ' + _tunedParamsMeta.reason);
          _tunedParams = {};
          return _tunedParams;
        }
        _tunedParamsMeta = { used: true, reason: 'Tuned params loaded', score, profitFactor: pf };
        _tunedParams = j.params;
        return _tunedParams;
      }
    }
  } catch (_) {}
  _tunedParams = {};  // sentinel: tried, none found
  return _tunedParams;
}
function getTunedParamsMeta() { return { ..._tunedParamsMeta }; }

function _defaultParams() {
  const tuned = _loadTunedParams();
  const get = (key, envKey, fallback) => {
    if (tuned[key] != null) return tuned[key];
    if (process.env[envKey] != null) {
      const v = process.env[envKey];
      return key === 'longOnly' ? v === '1' : parseFloat(v);
    }
    return fallback;
  };
  return {
    adxRangeMax:  get('adxRangeMax',  'CAMELOT_ADX_RANGE_MAX',  20),
    adxTrendMin:  get('adxTrendMin',  'CAMELOT_ADX_TREND_MIN',  25),
    rsiOversold:  get('rsiOversold',  'CAMELOT_RSI_OS',         35),
    rsiOverbought:get('rsiOverbought','CAMELOT_RSI_OB',         65),
    rangeStopAtr: get('rangeStopAtr', 'CAMELOT_RANGE_STOP_ATR', 1.0),
    trendStopAtr: get('trendStopAtr', 'CAMELOT_TREND_STOP_ATR', 1.5),
    trendTgtAtr:  get('trendTgtAtr',  'CAMELOT_TREND_TGT_ATR',  3.0),
    trendPullAtr: get('trendPullAtr', 'CAMELOT_TREND_PULL_ATR', 0.3),
    longOnly:     get('longOnly',     'CAMELOT_LONG_ONLY',      false),
  };
}
// Backwards-compat: expose als constant maar elke aanroep krijgt fresh values
// via genSignal die _defaultParams() opnieuw evalueert.
const DEFAULT_PARAMS = _defaultParams();

// ── Signal generator (per candle, given indicators precomputed) ──
// Returns null OR { type: 'BUY'|'SELL', regime, stop, target, atr, rationale }
function genSignal({ candles, i, ind, params }) {
  const P = { ...DEFAULT_PARAMS, ...(params || {}) };
  const close = candles[i].close;
  const high = candles[i].high;
  const low = candles[i].low;
  const a = ind.atr[i];
  const adxV = ind.adx[i];
  if (a == null || adxV == null) return null;

  const regime = detectRegime(adxV, { rangeMax: P.adxRangeMax, trendMin: P.adxTrendMin });
  if (regime === 'NO_TRADE') return null;

  if (regime === 'RANGE') {
    const upper = ind.bb.upper[i];
    const lower = ind.bb.lower[i];
    const mid = ind.bb.mid[i];
    const r = ind.rsi[i];
    if (upper == null || lower == null || r == null) return null;

    // LONG: close at or below lower band + RSI oversold
    if (close <= lower && r < P.rsiOversold) {
      return {
        type: 'BUY', regime: 'RANGE',
        stop: lower - P.rangeStopAtr * a,
        target: mid,
        atr: a,
        rationale: `BB-lower bounce (RSI ${r.toFixed(0)})`,
      };
    }
    // SHORT: close at or above upper band + RSI overbought (skip in long-only mode)
    if (!P.longOnly && close >= upper && r > P.rsiOverbought) {
      return {
        type: 'SELL', regime: 'RANGE',
        stop: upper + P.rangeStopAtr * a,
        target: mid,
        atr: a,
        rationale: `BB-upper fade (RSI ${r.toFixed(0)})`,
      };
    }
    return null;
  }

  // TREND
  const e20 = ind.ema20[i];
  const e50 = ind.ema50[i];
  if (e20 == null || e50 == null) return null;

  // BULL trend + pullback to EMA20
  if (e20 > e50 && low <= e20 + P.trendPullAtr * a && close > e20) {
    return {
      type: 'BUY', regime: 'TREND',
      stop: e20 - P.trendStopAtr * a,
      target: close + P.trendTgtAtr * a,
      atr: a,
      rationale: `EMA20 pullback bull (ADX ${adxV.toFixed(0)})`,
    };
  }
  // BEAR trend + pullback to EMA20 (skip in long-only mode)
  if (!P.longOnly && e20 < e50 && high >= e20 - P.trendPullAtr * a && close < e20) {
    return {
      type: 'SELL', regime: 'TREND',
      stop: e20 + P.trendStopAtr * a,
      target: close - P.trendTgtAtr * a,
      atr: a,
      rationale: `EMA20 pullback bear (ADX ${adxV.toFixed(0)})`,
    };
  }
  return null;
}

// ── Precompute all indicators once per token ──
function computeIndicators(candles) {
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  return {
    closes, highs, lows,
    bb: bollingerBands(closes, 20, 2.0),
    rsi: rsi(closes, 14),
    atr: atr(highs, lows, closes, 14),
    adx: adx(highs, lows, closes, 14),
    ema20: _ema(closes, 20),
    ema50: _ema(closes, 50),
  };
}

// ── Realistic cost model (mirrors what live execution would pay) ──
const COSTS = {
  bitvavoTakerBps: 25,
  binanceTakerBps: 10,    // Binance is cheaper
  slippageBps: 5,         // per leg, conservative
};

function applyCosts(grossPnl, sizeEur, exchange = 'bitvavo') {
  const feeBps = exchange === 'binance' ? COSTS.binanceTakerBps : COSTS.bitvavoTakerBps;
  const totalBps = (feeBps + COSTS.slippageBps) * 2;  // entry + exit
  const cost = sizeEur * totalBps / 10000;
  return grossPnl - cost;
}

module.exports = {
  computeIndicators,
  genSignal,
  detectRegime,
  applyCosts,
  COSTS,
  getTunedParamsMeta,
  // expose for testing
  _indicators: { _ema, _sma, bollingerBands, rsi, atr, adx },
};
