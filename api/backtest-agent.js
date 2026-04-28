/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  Backtest Agent v3 — Continue Monitoring + Auto-Adjust          ║
 * ║  Merlijn Signaal Labo — Camelot Finance                         ║
 * ║                                                                  ║
 * ║  Draait dagelijks via Vercel cron voor monitoring                 ║
 * ║  Pusht wekelijks rapport via email naar account@camelotlabs.be  ║
 * ║                                                                  ║
 * ║  1. Backtestt volledige signaal-engine op 4H + maanddata         ║
 * ║  2. Optimaliseert drempels voor 97%+ accuraatheid                ║
 * ║  3. Past signaal parameters automatisch aan                      ║
 * ║  4. Genereert wekelijks rapport                                  ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

// ── Technische Indicatoren ──
function calcEMA(data, period) {
  const k = 2 / (period + 1);
  const ema = [data[0]];
  for (let i = 1; i < data.length; i++) {
    ema.push(data[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return Array(closes.length).fill(50);
  const rsi = Array(period).fill(50);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss += Math.abs(d);
  }
  avgGain /= period; avgLoss /= period;
  rsi.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? Math.abs(d) : 0)) / period;
    rsi.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return rsi;
}

function calcADX(candles, period = 14) {
  // Average Directional Index — meet trend sterkte
  if (candles.length < period * 2 + 1) return Array(candles.length).fill(20);
  const adx = Array(period).fill(20);
  const trArr = [], pDM = [], nDM = [];

  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low;
    const ph = candles[i - 1].high, pl = candles[i - 1].low, pc = candles[i - 1].close;
    trArr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const upMove = h - ph, downMove = pl - l;
    pDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    nDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  // Smoothed TR, +DM, -DM
  let sTR = trArr.slice(0, period).reduce((a, b) => a + b, 0);
  let sPDM = pDM.slice(0, period).reduce((a, b) => a + b, 0);
  let sNDM = nDM.slice(0, period).reduce((a, b) => a + b, 0);
  const dx = [];

  for (let i = period; i < trArr.length; i++) {
    if (i > period) {
      sTR = sTR - sTR / period + trArr[i];
      sPDM = sPDM - sPDM / period + pDM[i];
      sNDM = sNDM - sNDM / period + nDM[i];
    }
    const pDI = sTR > 0 ? (sPDM / sTR) * 100 : 0;
    const nDI = sTR > 0 ? (sNDM / sTR) * 100 : 0;
    const diSum = pDI + nDI;
    dx.push(diSum > 0 ? Math.abs(pDI - nDI) / diSum * 100 : 0);
  }

  // ADX = smoothed DX
  if (dx.length < period) return Array(candles.length).fill(20);
  let adxVal = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const result = Array(period * 2).fill(20);
  result.push(adxVal);
  for (let i = period; i < dx.length; i++) {
    adxVal = (adxVal * (period - 1) + dx[i]) / period;
    result.push(adxVal);
  }
  while (result.length < candles.length) result.push(adxVal);
  return result;
}

// ── Binance data ophalen (met US fallback) ──
async function fetchBinanceKlines(symbol, interval = '4h', limit = 1000) {
  const urls = [
    `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
    `https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
  ];
  for (const url of urls) {
    try {
      const resp = await fetch(url);
      const data = await resp.json();
      if (Array.isArray(data) && data.length > 0) {
        return data.map(k => ({
          time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
          low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5])
        }));
      }
    } catch (e) {
      console.log(`[Binance] ${url.split('/')[2]} failed: ${e.message}`);
    }
  }
  throw new Error(`Binance unavailable for ${symbol}`);
}

// ── Maandcandles aggregeren uit dagdata ──
function aggregateToMonthly(dailyCandles) {
  const months = {};
  for (const c of dailyCandles) {
    const d = new Date(c.time);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!months[key]) {
      months[key] = { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
    } else {
      months[key].high = Math.max(months[key].high, c.high);
      months[key].low = Math.min(months[key].low, c.low);
      months[key].close = c.close;
      months[key].volume += c.volume;
    }
  }
  return Object.values(months).sort((a, b) => a.time - b.time);
}

// ── Kronos forecast ophalen ──
async function fetchKronos(symbol) {
  const KRONOS_URL = (process.env.KRONOS_URL || 'https://camelotlabs-kronos-ai-forecast.hf.space').replace(/\/$/, '');
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const resp = await fetch(`${KRONOS_URL}/forecast?symbol=${encodeURIComponent(symbol)}`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } catch (e) {
    return { symbol, direction: 'neutral', pct: 0, score: 0, offline: true };
  }
}

// ══════════════════════════════════════════════════════════════
// ║  SIGNAAL ENGINE v3 — met geavanceerde filters
// ║
// ║  NIEUWE FILTERS voor 97%+ accuratie:
// ║  - Trend Alignment (EMA cascade 9>21>50)
// ║  - Volume Confirmatie (>1.5x avg als vereiste)
// ║  - ADX Trend Sterkte (alleen handelen in sterke trends)
// ║  - Anti-Trend Blokkade (niet kopen < EMA50)
// ║  - Multi-Candle Confirmatie (2+ candles in zelfde richting)
// ║  - Minimum Star Filter (alleen hoge sterren)
// ══════════════════════════════════════════════════════════════
function generateSignalsV3(candles, timeframe, params) {
  const is4H = timeframe === '4h';
  const closes = candles.map(c => c.close);
  const ema9 = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const ema50 = calcEMA(closes, 50);
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const macdLine = ema12.map((v, j) => v - ema26[j]);
  const macdSignal = calcEMA(macdLine, 9);
  const rsiAll = calcRSI(closes);
  const adxAll = calcADX(candles);
  const signals = [];
  let lastBuyIdx = -100, lastSellIdx = -100;
  const cooldown = is4H ? params.cooldown4H : params.cooldownMonthly;

  for (let i = 2; i < candles.length; i++) {
    const c = candles[i];
    let bullIndicators = 0, bearIndicators = 0;
    let bullScore = 0, bearScore = 0;

    // ═══ 1. EMA 9/21 crossover ═══
    const emaCrossUp = ema9[i] > ema21[i] && ema9[i - 1] <= ema21[i - 1];
    const emaCrossDown = ema9[i] < ema21[i] && ema9[i - 1] >= ema21[i - 1];
    if (emaCrossUp) { bullIndicators += params.emaIndWeight; bullScore += params.emaScoreWeight; }
    if (emaCrossDown) { bearIndicators += params.emaIndWeight; bearScore += params.emaScoreWeight; }

    // ═══ 2. MACD crossover ═══
    if (i >= 27) {
      const mUp = macdLine[i] > macdSignal[i] && macdLine[i - 1] <= macdSignal[i - 1];
      const mDn = macdLine[i] < macdSignal[i] && macdLine[i - 1] >= macdSignal[i - 1];
      if (mUp) { bullIndicators += params.macdIndWeight; bullScore += params.macdScoreWeight; }
      if (mDn) { bearIndicators += params.macdIndWeight; bearScore += params.macdScoreWeight; }
    }

    // ═══ 3. RSI ═══
    if (i >= 15) {
      const lastRSI = rsiAll[i];
      const ob1 = is4H ? params.rsi4H_ob1 : params.rsiM_ob1;
      const ob2 = is4H ? params.rsi4H_ob2 : params.rsiM_ob2;
      const ob3 = is4H ? params.rsi4H_ob3 : params.rsiM_ob3;
      const os1 = is4H ? params.rsi4H_os1 : params.rsiM_os1;
      const os2 = is4H ? params.rsi4H_os2 : params.rsiM_os2;
      const os3 = is4H ? params.rsi4H_os3 : params.rsiM_os3;

      if (lastRSI >= ob1) { bearIndicators += 2; bearScore += 4; }
      else if (lastRSI >= ob2) { bearIndicators += 2; bearScore += 3; }
      else if (lastRSI >= ob3) { bearIndicators++; bearScore += 2; }
      if (lastRSI <= os1) { bullIndicators += 2; bullScore += 4; }
      else if (lastRSI <= os2) { bullIndicators += 2; bullScore += 3; }
      else if (lastRSI <= os3) { bullIndicators++; bullScore += 2; }
    }

    // ═══ 4. Prijs momentum ═══
    if (i >= 3) {
      const pctChange = (c.close - candles[i - 1].close) / candles[i - 1].close;
      const dropThresh = is4H ? params.mom4H_drop : params.momM_drop;
      const riseThresh = is4H ? params.mom4H_rise : params.momM_rise;
      const highDropThresh = is4H ? params.mom4H_highDrop : params.momM_highDrop;
      const lowRiseThresh = is4H ? params.mom4H_lowRise : params.momM_lowRise;

      if (pctChange <= -dropThresh) { bearIndicators++; bearScore += 1; }
      if (pctChange >= riseThresh) { bullIndicators++; bullScore += 1; }
      const lookback = is4H ? 6 : 6;
      const rHigh = Math.max(...candles.slice(Math.max(0, i - lookback), i + 1).map(x => x.high));
      const rLow = Math.min(...candles.slice(Math.max(0, i - lookback), i + 1).map(x => x.low));
      if ((rHigh - c.close) / rHigh > highDropThresh) { bullIndicators++; bullScore += 1; }
      if ((c.close - rLow) / rLow > lowRiseThresh) { bearIndicators++; bearScore += 1; }
    }

    // ═══ 5. Candle patterns ═══
    if (i >= 1) {
      const prev = candles[i - 1], curr = candles[i];
      if (prev.close > prev.open && curr.close < curr.open && curr.close < prev.open && curr.open > prev.close) {
        bearIndicators++; bearScore += params.candleWeight;
      }
      if (prev.close < prev.open && curr.close > curr.open && curr.close > prev.open && curr.open < prev.close) {
        bullIndicators++; bullScore += params.candleWeight;
      }
      const body = Math.abs(c.close - c.open);
      const upperWick = c.high - Math.max(c.open, c.close);
      const lowerWick = Math.min(c.open, c.close) - c.low;
      if (body > 0) {
        if (upperWick > body * 2 && lowerWick < body * 0.5 && c.close < c.open) { bearIndicators++; bearScore += params.candleWeight; }
        if (lowerWick > body * 2 && upperWick < body * 0.5 && c.close > c.open) { bullIndicators++; bullScore += params.candleWeight; }
      }
    }

    // ═══ 6. Volume spike — versterker ═══
    if (i >= 20) {
      const avgVol = candles.slice(i - 20, i).reduce((s, x) => s + x.volume, 0) / 20;
      const hasVolumeSpike = candles[i].volume > avgVol * params.volMultiplier;
      if (hasVolumeSpike) {
        if (bullScore > bearScore) bullScore += params.volWeight;
        if (bearScore > bullScore) bearScore += params.volWeight;
      }
    }

    // ═══ 7. Trend context (EMA50) ═══
    if (i >= 50) {
      if (closes[i] > ema50[i] && bullScore > bearScore) bullScore += params.trendWeight;
      if (closes[i] < ema50[i] && bearScore > bullScore) bearScore += params.trendWeight;
    }

    // ═══ NIEUWE FILTERS ═══

    // 8. TREND ALIGNMENT — EMA cascade (9>21>50 voor bull, 9<21<50 voor bear)
    let trendAligned = true;
    if (params.requireTrendAlignment && i >= 50) {
      const bullAlignment = ema9[i] > ema21[i] && ema21[i] > ema50[i];
      const bearAlignment = ema9[i] < ema21[i] && ema21[i] < ema50[i];
      if (bullScore > bearScore && !bullAlignment) trendAligned = false;
      if (bearScore > bullScore && !bearAlignment) trendAligned = false;
    }

    // 9. ADX TREND STERKTE — alleen handelen in sterke trends
    let adxOk = true;
    if (params.requireADX && i < adxAll.length) {
      adxOk = adxAll[i] >= params.minADX;
    }

    // 10. VOLUME CONFIRMATIE — als hard vereiste (niet alleen versterker)
    let volConfirmed = true;
    if (params.requireVolume && i >= 20) {
      const avgVol = candles.slice(i - 20, i).reduce((s, x) => s + x.volume, 0) / 20;
      volConfirmed = candles[i].volume > avgVol * params.reqVolMultiplier;
    }

    // 11. ANTI-TREND BLOKKADE — niet kopen onder EMA50, niet verkopen boven EMA50
    let antiTrendBlocked = false;
    if (params.antiTrendBlock && i >= 50) {
      if (bullScore > bearScore && closes[i] < ema50[i]) antiTrendBlocked = true;
      if (bearScore > bullScore && closes[i] > ema50[i]) antiTrendBlocked = true;
    }

    // 12. MULTI-CANDLE CONFIRMATIE — 2+ opeenvolgende candles in zelfde richting
    let multiCandleOk = true;
    if (params.requireMultiCandle && i >= 2) {
      if (bullScore > bearScore) {
        // BUY: laatste 2 candles moeten groen zijn
        multiCandleOk = candles[i].close > candles[i].open && candles[i - 1].close > candles[i - 1].open;
      } else if (bearScore > bullScore) {
        // SELL: laatste 2 candles moeten rood zijn
        multiCandleOk = candles[i].close < candles[i].open && candles[i - 1].close < candles[i - 1].open;
      }
    }

    // ═══ SIGNAAL GENERATIE ═══
    const netScore = bullScore - bearScore;
    const absScore = Math.abs(netScore);
    const minInd = is4H ? params.minIndicators4H : params.minIndicatorsMonthly;
    const minScore = is4H ? params.minScore4H : params.minScoreMonthly;
    const minStars = is4H ? params.minStars4H : params.minStarsMonthly;

    const stars = Math.min(5, absScore);
    const passFilters = trendAligned && adxOk && volConfirmed && !antiTrendBlocked && multiCandleOk;

    const isBull = passFilters && netScore > 0 && bullIndicators >= minInd && absScore >= minScore && stars >= minStars;
    const isBear = passFilters && netScore < 0 && bearIndicators >= minInd && absScore >= minScore && stars >= minStars;

    if (isBull && (i - lastBuyIdx) >= cooldown) {
      signals.push({ type: 'BUY', price: c.close, stars, index: i, time: c.time, bullIndicators, bullScore, bearScore });
      lastBuyIdx = i;
    } else if (isBear && (i - lastSellIdx) >= cooldown) {
      signals.push({ type: 'SELL', price: c.close, stars, index: i, time: c.time, bearIndicators, bearScore, bullScore });
      lastSellIdx = i;
    }
  }
  return signals;
}

// ── Default parameters ──
const DEFAULT_PARAMS = {
  emaIndWeight: 2, emaScoreWeight: 3,
  macdIndWeight: 1, macdScoreWeight: 2,
  rsi4H_ob1: 75, rsi4H_ob2: 70, rsi4H_ob3: 65,
  rsi4H_os1: 30, rsi4H_os2: 35, rsi4H_os3: 40,
  rsiM_ob1: 85, rsiM_ob2: 78, rsiM_ob3: 70,
  rsiM_os1: 25, rsiM_os2: 32, rsiM_os3: 38,
  mom4H_drop: 0.03, mom4H_rise: 0.05, mom4H_highDrop: 0.08, mom4H_lowRise: 0.12,
  momM_drop: 0.15, momM_rise: 0.25, momM_highDrop: 0.30, momM_lowRise: 0.80,
  candleWeight: 1, volMultiplier: 1.5, volWeight: 1, trendWeight: 1,
  minIndicators4H: 2, minScore4H: 2, minStars4H: 1,
  minIndicatorsMonthly: 2, minScoreMonthly: 2, minStarsMonthly: 1,
  cooldown4H: 12, cooldownMonthly: 3,
  // Nieuwe filters (standaard uit)
  requireTrendAlignment: false,
  requireADX: false, minADX: 25,
  requireVolume: false, reqVolMultiplier: 1.3,
  antiTrendBlock: false,
  requireMultiCandle: false,
};

// ── Parameter profielen ──
function generateParamSets() {
  const variations = [
    // Huidige engine
    { label: 'HUIDIG' },

    // Progressief strengere drempels
    { label: 'LEVEL-1', minIndicators4H: 3, minScore4H: 3, minIndicatorsMonthly: 2, minScoreMonthly: 3 },
    { label: 'LEVEL-2', minIndicators4H: 3, minScore4H: 4, minIndicatorsMonthly: 3, minScoreMonthly: 4, cooldown4H: 18 },
    { label: 'LEVEL-3', minIndicators4H: 4, minScore4H: 5, minIndicatorsMonthly: 3, minScoreMonthly: 5, cooldown4H: 24 },

    // Star filters
    // NB: voor STARS-2+ moeten we ook minIndicators/minScore verlagen, anders
    // wordt een 2★ signaal al weggefilterd door de indicators-bar (default 3).
    // Met deze variant zien we of de bot écht beter performs als we 2★ toelaten.
    { label: 'STARS-2+', minStars4H: 2, minStarsMonthly: 2, minIndicators4H: 2, minScore4H: 2, minIndicatorsMonthly: 2, minScoreMonthly: 2 },
    { label: 'STARS-2+TREND', minStars4H: 2, minStarsMonthly: 2, minIndicators4H: 2, minScore4H: 2, minIndicatorsMonthly: 2, minScoreMonthly: 2, requireTrendAlignment: true, antiTrendBlock: true },
    { label: 'STARS-3+', minStars4H: 3, minStarsMonthly: 3 },
    { label: 'STARS-4+', minStars4H: 4, minStarsMonthly: 4 },
    { label: 'STARS-5', minStars4H: 5, minStarsMonthly: 5 },

    // Trend alignment
    { label: 'TREND-ALIGN', requireTrendAlignment: true, minIndicators4H: 3, minScore4H: 3 },
    { label: 'TREND+STARS3', requireTrendAlignment: true, minStars4H: 3, minStarsMonthly: 3 },
    { label: 'TREND+STARS4', requireTrendAlignment: true, minStars4H: 4, minStarsMonthly: 3 },

    // ADX filter
    { label: 'ADX-25', requireADX: true, minADX: 25, minIndicators4H: 3, minScore4H: 3 },
    { label: 'ADX-30', requireADX: true, minADX: 30, minIndicators4H: 3, minScore4H: 3 },

    // Anti-trend
    { label: 'ANTI-TREND', antiTrendBlock: true, minIndicators4H: 3, minScore4H: 3 },

    // Volume confirmatie
    { label: 'VOL-CONFIRM', requireVolume: true, reqVolMultiplier: 1.3, minIndicators4H: 3, minScore4H: 3 },

    // Multi-candle
    { label: 'MULTI-CANDLE', requireMultiCandle: true, minIndicators4H: 3, minScore4H: 3 },

    // Combinaties (97% target)
    { label: 'COMBO-A', requireTrendAlignment: true, antiTrendBlock: true, minStars4H: 3, minStarsMonthly: 3, minIndicators4H: 3, minScore4H: 4 },
    { label: 'COMBO-B', requireTrendAlignment: true, requireADX: true, minADX: 25, minStars4H: 3, minStarsMonthly: 3, minIndicators4H: 3, minScore4H: 4 },
    { label: 'COMBO-C', requireTrendAlignment: true, antiTrendBlock: true, requireMultiCandle: true, minStars4H: 3, minStarsMonthly: 3, minIndicators4H: 3, minScore4H: 3 },
    { label: 'COMBO-D', requireTrendAlignment: true, antiTrendBlock: true, requireADX: true, minADX: 25, minStars4H: 4, minStarsMonthly: 3, minIndicators4H: 3, minScore4H: 4, cooldown4H: 24 },
    { label: 'COMBO-MAX', requireTrendAlignment: true, antiTrendBlock: true, requireADX: true, minADX: 25, requireVolume: true, reqVolMultiplier: 1.3, requireMultiCandle: true, minStars4H: 3, minStarsMonthly: 3, minIndicators4H: 3, minScore4H: 4, cooldown4H: 24 },

    // RSI-strict combinaties
    { label: 'RSI-STR+TREND', requireTrendAlignment: true, antiTrendBlock: true, minStars4H: 3,
      rsi4H_ob1: 80, rsi4H_ob2: 75, rsi4H_ob3: 70, rsi4H_os1: 25, rsi4H_os2: 30, rsi4H_os3: 35,
      rsiM_ob1: 88, rsiM_ob2: 82, rsiM_ob3: 75, rsiM_os1: 20, rsiM_os2: 28, rsiM_os3: 35,
      minIndicators4H: 3, minScore4H: 4 },
  ];

  return variations.map(v => ({
    label: v.label,
    params: { ...DEFAULT_PARAMS, ...v }
  }));
}

// ── Signaal accuratie evaluatie ──
function evaluateSignalAccuracy(signals, candles, forwardCandles, thresholdPct = 0.5) {
  let correct = 0, incorrect = 0, neutral = 0;
  const details = [];

  for (const sig of signals) {
    const futureIdx = sig.index + forwardCandles;
    if (futureIdx >= candles.length) continue;

    const entryPrice = sig.price;
    const futurePrice = candles[futureIdx].close;
    const pctMove = (futurePrice - entryPrice) / entryPrice * 100;

    // Check ook de MAX gunstige beweging in het forward window
    let maxFavorable = 0;
    for (let j = sig.index + 1; j <= Math.min(futureIdx, candles.length - 1); j++) {
      const move = sig.type === 'BUY'
        ? (candles[j].high - entryPrice) / entryPrice * 100
        : (entryPrice - candles[j].low) / entryPrice * 100;
      maxFavorable = Math.max(maxFavorable, move);
    }

    const isCorrect = sig.type === 'BUY' ? pctMove > thresholdPct : pctMove < -thresholdPct;
    const isNeutral = Math.abs(pctMove) <= thresholdPct;
    // "Hit" = de prijs bereikte minstens 1% in de goede richting op enig moment
    const hitTarget = maxFavorable >= 1.0;

    if (isNeutral) neutral++;
    else if (isCorrect) correct++;
    else incorrect++;

    details.push({
      type: sig.type, stars: sig.stars,
      entryPrice: entryPrice.toFixed(4), futurePrice: futurePrice.toFixed(4),
      pctMove: pctMove.toFixed(2), maxFavorable: maxFavorable.toFixed(2),
      correct: isCorrect, neutral: isNeutral, hitTarget,
      date: new Date(candles[sig.index].time).toISOString().slice(0, 10)
    });
  }

  const evaluated = correct + incorrect;
  const accuracy = evaluated > 0 ? (correct / evaluated * 100) : 0;
  const hitRate = details.length > 0 ? (details.filter(d => d.hitTarget).length / details.length * 100) : 0;

  return { correct, incorrect, neutral, accuracy, hitRate, totalSignals: signals.length, evaluable: evaluated, details };
}

function analyzeByStars(details) {
  const byStars = {};
  for (const d of details) {
    if (d.neutral) continue;
    if (!byStars[d.stars]) byStars[d.stars] = { correct: 0, total: 0 };
    byStars[d.stars].total++;
    if (d.correct) byStars[d.stars].correct++;
  }
  return byStars;
}

// ══════════════════════════════════════════════════════════════
// ║  RAPPORT GENERATIE
// ══════════════════════════════════════════════════════════════
function generateReport(results4H, resultsMonthly, kronosResults, bestParams, isWeekly) {
  const now = new Date();
  const weekNr = Math.ceil((now - new Date(now.getFullYear(), 0, 1)) / (7 * 24 * 60 * 60 * 1000));

  let r = `MERLIJN BACKTEST v3 — Week ${weekNr}, ${now.getFullYear()}\n`;
  r += `Datum: ${now.toISOString().slice(0, 10)}\n`;
  r += `Type: ${isWeekly ? 'WEKELIJKS RAPPORT' : 'DAGELIJKSE MONITORING'}\n`;
  r += `Doel: 97% signaal accuratie\n`;
  r += `${'═'.repeat(55)}\n\n`;

  // Top 5 profielen per token + timeframe
  for (const tf of ['4H', 'MAAND']) {
    const results = tf === '4H' ? results4H : resultsMonthly;
    r += `══ ${tf} TIMEFRAME — TOP 5 PROFIELEN ══\n`;

    for (const [symbol, paramResults] of Object.entries(results)) {
      // Sorteer op accuracy, filter op minimaal 3 (4H) of 2 (maand) signalen
      const minSig = tf === '4H' ? 3 : 2;
      const sorted = paramResults
        .filter(p => p.evaluable >= minSig)
        .sort((a, b) => b.accuracy - a.accuracy)
        .slice(0, 5);

      r += `\n${symbol} (${tf}):\n`;
      r += `${'Profiel'.padEnd(18)} ${'Acc%'.padStart(6)} ${'Hit%'.padStart(6)} ${'Sig'.padStart(5)} ${'OK'.padStart(4)} ${'Fout'.padStart(5)}\n`;
      r += `${'─'.repeat(48)}\n`;

      for (const p of sorted) {
        const marker = p.accuracy >= 97 ? ' ✅' : p.accuracy >= 85 ? ' ⬆' : p.accuracy >= 70 ? ' ●' : '';
        r += `${p.label.padEnd(18)} ${p.accuracy.toFixed(1).padStart(5)}% ${p.hitRate.toFixed(0).padStart(5)}% ${String(p.evaluable).padStart(5)} ${String(p.correct).padStart(4)} ${String(p.incorrect).padStart(5)}${marker}\n`;
      }

      // Huidige engine
      const current = paramResults.find(p => p.label === 'HUIDIG');
      if (current && !sorted.find(s => s.label === 'HUIDIG')) {
        r += `${'HUIDIG'.padEnd(18)} ${current.accuracy.toFixed(1).padStart(5)}% ${current.hitRate.toFixed(0).padStart(5)}% ${String(current.evaluable).padStart(5)} ${String(current.correct).padStart(4)} ${String(current.incorrect).padStart(5)} (ref)\n`;
      }
    }
    r += '\n';
  }

  // Star analyse (huidige engine)
  r += `══ ACCURATIE PER STAR-LEVEL (huidige engine) ══\n`;
  for (const [symbol, paramResults] of Object.entries(results4H)) {
    const current = paramResults.find(p => p.label === 'HUIDIG');
    if (current?.starAnalysis) {
      r += `${symbol} 4H: `;
      for (const [stars, data] of Object.entries(current.starAnalysis).sort()) {
        const acc = data.total > 0 ? (data.correct / data.total * 100).toFixed(0) : '-';
        r += `${stars}★=${acc}%(${data.total}) `;
      }
      r += '\n';
    }
  }

  // Kronos
  r += `\n══ KRONOS AI ══\n`;
  for (const [symbol, kronos] of Object.entries(kronosResults)) {
    r += kronos.offline ? `${symbol}: OFFLINE\n` : `${symbol}: ${kronos.direction} (${kronos.pct > 0 ? '+' : ''}${kronos.pct}%, score ${kronos.score})\n`;
  }

  // Beste parameters
  r += `\n══ AANBEVOLEN PARAMETERS ══\n`;
  if (bestParams.best4H) {
    const b = bestParams.best4H;
    r += `\n4H BEST: ${b.label} (${b.accuracy.toFixed(1)}% acc, ${b.totalSignals} signalen)\n`;
    const p = b.params;
    r += `  minIndicators: ${p.minIndicators4H}, minScore: ${p.minScore4H}, minStars: ${p.minStars4H}\n`;
    r += `  trendAlign: ${p.requireTrendAlignment}, ADX: ${p.requireADX}(${p.minADX}), antiTrend: ${p.antiTrendBlock}\n`;
    r += `  volConfirm: ${p.requireVolume}, multiCandle: ${p.requireMultiCandle}\n`;
  }
  if (bestParams.bestMonthly) {
    const b = bestParams.bestMonthly;
    r += `\nMAAND BEST: ${b.label} (${b.accuracy.toFixed(1)}% acc, ${b.totalSignals} signalen)\n`;
    const p = b.params;
    r += `  minIndicators: ${p.minIndicatorsMonthly}, minScore: ${p.minScoreMonthly}, minStars: ${p.minStarsMonthly}\n`;
  }

  // Actie
  r += `\n══ ACTIE ══\n`;
  const acc4H = bestParams.best4H?.accuracy || 0;
  const accM = bestParams.bestMonthly?.accuracy || 0;

  if (acc4H >= 97 && accM >= 97) {
    r += `✅ DOEL BEREIKT: Beide timeframes ≥97%!\n`;
    r += `→ Parameters worden automatisch toegepast.\n`;
  } else if (acc4H >= 85 || accM >= 85) {
    r += `⬆ GOED: 4H=${acc4H.toFixed(0)}%, Maand=${accM.toFixed(0)}%\n`;
    r += `→ Nog ${Math.max(97 - acc4H, 97 - accM).toFixed(0)}% verbetering nodig\n`;
  } else {
    r += `● VOORTGANG: 4H=${acc4H.toFixed(0)}%, Maand=${accM.toFixed(0)}%\n`;
    r += `→ Agent blijft optimaliseren. Nieuwe filters worden getest.\n`;
  }

  return r;
}

// ── ntfy push ──
// Backtest is informatief, niet actiegericht — daarom default naar de
// 'labo' topic i.p.v. de hoofd-signals feed. Zo blijft je phone-feed
// puur trade-events (open/close) van paper-engine + signals-cron alerts.
async function sendNtfyReport(report) {
  const NTFY_TOPIC = (process.env.NTFY_TOPIC || 'merlijn-labo-a9c8431fe0').trim();
  try {
    const msg = report.length > 3900 ? report.slice(0, 3900) + '\n...(truncated)' : report;
    const resp = await fetch('https://ntfy.sh/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: NTFY_TOPIC,
        title: 'Merlijn Backtest v3',
        message: msg,
        tags: ['chart_with_upwards_trend', 'robot'],
        priority: 3
      })
    });
    return resp.ok;
  } catch (e) {
    console.error('ntfy error:', e.message);
    return false;
  }
}

// ── Email rapport (wekelijks) ──
async function sendEmailReport(report) {
  // Resend.com API — gratis 100 mails/dag
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const EMAIL_TO = process.env.EMAIL_TO || 'account@camelotlabs.be';
  if (!RESEND_API_KEY) {
    console.warn('[Email] Geen RESEND_API_KEY — email overgeslagen');
    return false;
  }
  try {
    // Converteer plain text rapport naar simpele HTML
    const htmlReport = report
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/✅/g, '&#9989;').replace(/⚠/g, '&#9888;').replace(/●/g, '&#9679;')
      .replace(/★/g, '&#9733;').replace(/⬆/g, '&#11014;')
      .replace(/═/g, '=').replace(/─/g, '-')
      .replace(/\n/g, '<br>');

    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Merlijn AI <merlijn@camelotlabs.be>',
        to: [EMAIL_TO],
        subject: '📊 Merlijn Backtest Rapport — ' + new Date().toISOString().slice(0, 10),
        html: `<div style="font-family:monospace;font-size:13px;background:#1a1a2e;color:#e0e0e0;padding:24px;border-radius:8px;max-width:700px;">${htmlReport}</div>`
      })
    });
    const data = await resp.json();
    console.log('[Email] Resend →', resp.status, JSON.stringify(data));
    return resp.ok;
  } catch (e) {
    console.error('[Email] Error:', e.message);
    return false;
  }
}

// ── Beste parameters vinden ──
function findBestParams(results4H, resultsMonthly, paramSets) {
  const avg4H = {}, avgM = {};

  for (const ps of paramSets) {
    let sum4H = 0, count4H = 0, totalSig4H = 0;
    let sumM = 0, countM = 0, totalSigM = 0;

    for (const token of Object.keys(results4H)) {
      const r4H = results4H[token].find(r => r.label === ps.label);
      const rM = resultsMonthly[token]?.find(r => r.label === ps.label);
      if (r4H && r4H.evaluable >= 3) { sum4H += r4H.accuracy; count4H++; totalSig4H += r4H.evaluable; }
      if (rM && rM.evaluable >= 2) { sumM += rM.accuracy; countM++; totalSigM += rM.evaluable; }
    }

    if (count4H > 0) avg4H[ps.label] = { accuracy: sum4H / count4H, count: count4H, totalSignals: totalSig4H, params: ps.params, label: ps.label };
    if (countM > 0) avgM[ps.label] = { accuracy: sumM / countM, count: countM, totalSignals: totalSigM, params: ps.params, label: ps.label };
  }

  const sort = (obj) => Object.values(obj)
    .filter(a => a.totalSignals >= 3)
    .sort((a, b) => {
      const a97 = a.accuracy >= 97 ? 1 : 0, b97 = b.accuracy >= 97 ? 1 : 0;
      if (a97 !== b97) return b97 - a97;
      if (a97 && b97) return b.totalSignals - a.totalSignals;
      return b.accuracy - a.accuracy;
    });

  const sorted4H = sort(avg4H);
  const sortedM = sort(avgM);

  return {
    best4H: sorted4H[0] || null,
    bestMonthly: sortedM[0] || null,
    all4H: sorted4H.slice(0, 5),
    allMonthly: sortedM.slice(0, 5),
  };
}

// ═══ Main Handler ═══
module.exports = async (req, res) => {
  const authHeader = req.headers['authorization'];
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Bepaal of het wekelijks rapport is (zondag) of dagelijkse monitoring
  const now = new Date();
  const isWeekly = now.getDay() === 0; // Zondag
  const runType = isWeekly ? 'WEEKLY' : 'DAILY';

  console.log(`[Backtest v3] ${runType} run starting...`);
  const startTime = Date.now();

  const tokens = [
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
    { symbol: 'SUIUSDT',  short: 'SUI'  },
    { symbol: 'TRXUSDT',  short: 'TRX'  },
    { symbol: 'XLMUSDT',  short: 'XLM'  }
  ];

  const paramSets = generateParamSets();
  const results4H = {}, resultsMonthly = {}, results1H = {};
  const kronosResults = {};

  try {
    for (const token of tokens) {
      console.log(`\n[Backtest] ${token.short} — data ophalen...`);

      // 4H candles
      const candles4H = await fetchBinanceKlines(token.symbol, '4h', 1000);
      console.log(`  4H: ${candles4H.length} candles`);

      // 1H candles (Phase 2 — meer trade opportuniteiten testen vóór live)
      // 1000 candles ≈ 42 dagen geschiedenis. Forward window = 24 candles (1 dag),
      // threshold 0.6% (lager dan 4H's 1.0% — 1H bewegingen zijn kleiner).
      const candles1H = await fetchBinanceKlines(token.symbol, '1h', 1000);
      console.log(`  1H: ${candles1H.length} candles`);

      // Dagcandles → maandcandles
      const dailyCandles = await fetchBinanceKlines(token.symbol, '1d', 1000);
      const monthlyCandles = aggregateToMonthly(dailyCandles);
      console.log(`  Maand: ${monthlyCandles.length} candles`);

      // Parameter sweep
      results4H[token.short] = [];
      results1H[token.short] = [];
      resultsMonthly[token.short] = [];

      for (const ps of paramSets) {
        // 4H: forward = 24 candles (4 dagen)
        const sig4H = generateSignalsV3(candles4H, '4h', ps.params);
        const eval4H = evaluateSignalAccuracy(sig4H, candles4H, 24, 1.0);
        results4H[token.short].push({
          label: ps.label, params: ps.params,
          ...eval4H, starAnalysis: analyzeByStars(eval4H.details)
        });

        // 1H: forward = 24 candles (1 dag), threshold 0.6% (kleinere bewegingen)
        // Behandelen 1H signalen als 4H qua param-set (zelfde indicator-config)
        // — als deze backtest goed presteert kunnen we 1H live zetten met eigen tuning.
        const sig1H = generateSignalsV3(candles1H, '4h', ps.params);
        const eval1H = evaluateSignalAccuracy(sig1H, candles1H, 24, 0.6);
        results1H[token.short].push({
          label: ps.label, params: ps.params,
          ...eval1H, starAnalysis: analyzeByStars(eval1H.details)
        });

        // Maand: forward = 1 candle (1 maand)
        const sigM = generateSignalsV3(monthlyCandles, 'monthly', ps.params);
        const evalM = evaluateSignalAccuracy(sigM, monthlyCandles, 1, 2.0);
        resultsMonthly[token.short].push({
          label: ps.label, params: ps.params,
          ...evalM, starAnalysis: analyzeByStars(evalM.details)
        });
      }

      // Kronos
      const kronos = await fetchKronos(token.symbol);
      kronosResults[token.short] = kronos;
      await new Promise(r => setTimeout(r, 300));
    }

    // Beste parameters
    const bestParams = findBestParams(results4H, resultsMonthly, paramSets);

    // ═══ AUTO-ADJUST: update signal-params.json via GitHub API ═══
    let autoAdjusted = false;
    if (bestParams.best4H || bestParams.bestMonthly) {
      autoAdjusted = await autoAdjustParams(bestParams);
    }

    // Rapport
    let report = generateReport(results4H, resultsMonthly, kronosResults, bestParams, isWeekly);

    // Phase 2 — append 1H summary aan rapport (1H is alleen backtest, niet live)
    report += '\n\n══════ 1H TIMEFRAME (alleen backtest, nog niet live) ══════\n';
    report += 'Per-token beste 1H variant — vergelijk met 4H om te beslissen of 1H live mag.\n\n';
    for (const [tk, arr] of Object.entries(results1H)) {
      const sorted = arr.slice().sort((a, b) => (b.accuracy || 0) - (a.accuracy || 0));
      const top3 = sorted.slice(0, 3);
      report += `${tk.padEnd(5)} | `;
      report += top3.map(r => `${r.label}: ${(r.accuracy || 0).toFixed(1)}% (${r.totalSignals || 0} sig)`).join(' · ');
      report += '\n';
    }
    report += '\nVergelijk: kijk of best 1H accuracy ≥ best 4H accuracy. Zo ja → 1H live overwegen.\n';

    console.log('\n' + report);

    // Email rapport (elke run)
    const emailed = await sendEmailReport(report);
    console.log(`[Backtest] Email rapport: ${emailed ? 'OK' : 'FAILED'}`);

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[Backtest] ${runType} klaar in ${duration}s`);

    return res.status(200).json({
      ok: true,
      runType,
      duration: `${duration}s`,
      report,
      bestParams,
      autoAdjusted,
      results4H, results1H, resultsMonthly,
      kronos: kronosResults,
      emailSent: emailed,
      // Phase 2 summary: per-token 1H best variant — handig om snel te zien
      // of 1H meer/minder accuraat is dan 4H per token, zonder json-walking.
      summary1H: Object.fromEntries(Object.entries(results1H).map(([tk, arr]) => {
        const best = arr.slice().sort((a, b) => (b.accuracy || 0) - (a.accuracy || 0))[0];
        return [tk, best ? { label: best.label, accuracy: best.accuracy, signals: best.totalSignals || 0 } : null];
      }))
    });

  } catch (err) {
    console.error('[Backtest] Error:', err.message, err.stack);
    return res.status(500).json({ error: err.message });
  }
};

// ══════════════════════════════════════════════════════════════
// ║  AUTO-ADJUST — Update signal-params.json via GitHub API
// ║  Triggert automatisch een nieuwe Vercel deploy
// ══════════════════════════════════════════════════════════════
async function autoAdjustParams(bestParams) {
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  if (!GITHUB_TOKEN) {
    console.log('[AutoAdjust] Geen GITHUB_TOKEN — skip auto-adjust');
    return false;
  }

  const REPO = 'soflabs/merlin-signal-dashboard';
  const FILE_PATH = 'signal-params.json';

  try {
    // 1. Huidige config ophalen van GitHub
    const getResp = await fetch(`https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`, {
      headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' }
    });
    if (!getResp.ok) {
      console.error('[AutoAdjust] GitHub GET failed:', getResp.status);
      return false;
    }
    const fileData = await getResp.json();
    const currentConfig = JSON.parse(Buffer.from(fileData.content, 'base64').toString('utf-8'));
    const currentVersion = currentConfig._version || 0;

    // 2. Nieuwe config samenstellen uit beste parameters
    const best4H = bestParams.best4H;
    const bestM = bestParams.bestMonthly;

    // Alleen updaten als accuracy significant beter is (≥5% verbetering)
    const current4HAcc = currentConfig._accuracy4H || 0;
    const currentMAcc = currentConfig._accuracyMonthly || 0;
    const new4HAcc = best4H?.accuracy || 0;
    const newMAcc = bestM?.accuracy || 0;

    const improved4H = new4HAcc > current4HAcc + 3; // Min 3% verbetering
    const improvedM = newMAcc > currentMAcc + 3;

    if (!improved4H && !improvedM) {
      console.log(`[AutoAdjust] Geen significante verbetering (4H: ${current4HAcc.toFixed(1)}→${new4HAcc.toFixed(1)}%, M: ${currentMAcc.toFixed(1)}→${newMAcc.toFixed(1)}%)`);
      return false;
    }

    // 3. Nieuwe config bouwen
    const newConfig = { ...currentConfig };
    newConfig._version = currentVersion + 1;
    newConfig._updated = new Date().toISOString().slice(0, 10);
    newConfig._updatedBy = 'backtest-agent-v3';
    newConfig._accuracy4H = new4HAcc;
    newConfig._accuracyMonthly = newMAcc;

    if (improved4H && best4H) {
      newConfig._label = best4H.label;
      const p = best4H.params;
      newConfig['4h'] = {
        minIndicators: p.minIndicators4H, minScore: p.minScore4H, minStars: p.minStars4H || 3,
        cooldown: p.cooldown4H,
        emaIndWeight: p.emaIndWeight || 2, emaScoreWeight: p.emaScoreWeight || 3,
        macdIndWeight: p.macdIndWeight || 1, macdScoreWeight: p.macdScoreWeight || 2,
        rsi_ob1: p.rsi4H_ob1, rsi_ob2: p.rsi4H_ob2, rsi_ob3: p.rsi4H_ob3,
        rsi_os1: p.rsi4H_os1, rsi_os2: p.rsi4H_os2, rsi_os3: p.rsi4H_os3,
        mom_drop: p.mom4H_drop, mom_rise: p.mom4H_rise, mom_highDrop: p.mom4H_highDrop, mom_lowRise: p.mom4H_lowRise,
        candleWeight: p.candleWeight || 1, volMultiplier: p.volMultiplier || 1.5, volWeight: p.volWeight || 1, trendWeight: p.trendWeight || 1,
        requireTrendAlignment: p.requireTrendAlignment ?? true,
        antiTrendBlock: p.antiTrendBlock ?? true,
        requireMultiCandle: p.requireMultiCandle ?? true,
        requireADX: p.requireADX ?? false, minADX: p.minADX || 25,
        requireVolume: p.requireVolume ?? false, reqVolMultiplier: p.reqVolMultiplier || 1.3,
      };
      console.log(`[AutoAdjust] 4H updated: ${best4H.label} (${new4HAcc.toFixed(1)}%)`);
    }

    if (improvedM && bestM) {
      const p = bestM.params;
      newConfig['monthly'] = {
        minIndicators: p.minIndicatorsMonthly, minScore: p.minScoreMonthly, minStars: p.minStarsMonthly || 3,
        cooldown: p.cooldownMonthly,
        emaIndWeight: p.emaIndWeight || 2, emaScoreWeight: p.emaScoreWeight || 3,
        macdIndWeight: p.macdIndWeight || 1, macdScoreWeight: p.macdScoreWeight || 2,
        rsi_ob1: p.rsiM_ob1, rsi_ob2: p.rsiM_ob2, rsi_ob3: p.rsiM_ob3,
        rsi_os1: p.rsiM_os1, rsi_os2: p.rsiM_os2, rsi_os3: p.rsiM_os3,
        mom_drop: p.momM_drop, mom_rise: p.momM_rise, mom_highDrop: p.momM_highDrop, mom_lowRise: p.momM_lowRise,
        candleWeight: p.candleWeight || 1, volMultiplier: p.volMultiplier || 1.5, volWeight: p.volWeight || 1, trendWeight: p.trendWeight || 1,
        requireTrendAlignment: p.requireTrendAlignment ?? true,
        antiTrendBlock: p.antiTrendBlock ?? true,
        requireMultiCandle: p.requireMultiCandle ?? true,
        requireADX: p.requireADX ?? false, minADX: p.minADX || 25,
        requireVolume: p.requireVolume ?? false, reqVolMultiplier: p.reqVolMultiplier || 1.3,
      };
      console.log(`[AutoAdjust] Monthly updated: ${bestM.label} (${newMAcc.toFixed(1)}%)`);
    }

    // 4. Commit naar GitHub (triggert auto-deploy)
    const newContent = Buffer.from(JSON.stringify(newConfig, null, 2) + '\n').toString('base64');
    const commitMsg = `Auto-adjust signal params v${newConfig._version}: ${newConfig._label || 'optimized'}\n\n` +
      `4H: ${new4HAcc.toFixed(1)}% acc (was ${current4HAcc.toFixed(1)}%)\n` +
      `Monthly: ${newMAcc.toFixed(1)}% acc (was ${currentMAcc.toFixed(1)}%)\n` +
      `Updated by backtest-agent-v3`;

    const putResp = await fetch(`https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`, {
      method: 'PUT',
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: commitMsg,
        content: newContent,
        sha: fileData.sha,
        committer: { name: 'Merlijn Backtest Agent', email: 'bot@camelotlabs.be' }
      })
    });

    if (putResp.ok) {
      console.log(`[AutoAdjust] ✅ signal-params.json v${newConfig._version} gepusht — auto-deploy triggered`);
      return true;
    } else {
      const err = await putResp.text();
      console.error('[AutoAdjust] GitHub PUT failed:', putResp.status, err.slice(0, 200));
      return false;
    }

  } catch (e) {
    console.error('[AutoAdjust] Error:', e.message);
    return false;
  }
}
