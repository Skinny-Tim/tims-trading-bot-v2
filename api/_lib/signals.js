// ═══ Shared Signal Engine ═══
// Single source of truth voor signals-cron (ntfy push) én paper-engine (trades)
// Gebaseerd op signals-cron.js — beide eindpunten gebruiken identieke logica
// Parameters uit ../signal-params.json (dynamisch via backtest-agent)

const fs = require('fs');
const path = require('path');

let _signalParams = null;
try {
  _signalParams = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'signal-params.json'), 'utf-8'));
  console.log('[SignalConfig] Geladen:', _signalParams._label);
} catch (e) { console.warn('[SignalConfig] Fallback naar defaults:', e.message); }

function getParams() { return _signalParams; }

// ── Technische Indicatoren ──
function calcEMA(data, period) {
  const k = 2 / (period + 1);
  const ema = [data[0]];
  for (let i = 1; i < data.length; i++) ema.push(data[i] * k + ema[i - 1] * (1 - k));
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

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    if (i < 1) continue;
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    sum += tr;
  }
  return sum / period;
}

// ═══════════════════════════════════════════════════════════
// ── CENTRAAL ELLIOTT WAVE AUDIT-SYSTEEM ──
// Eén bron van waarheid voor alle tokens (BTC/ETH/SOL/BNB/HBAR/XRP)
// Returns: { currentWave, primary, alternate, status, pivots, violations, inputs, audit }
//
// Filosofie:
//   1. EW is inherent niet-deterministisch → we retourneren PRIMARY + ALTERNATE + CONFIDENCE
//   2. Hard-rules (W2<W1-start, W3 niet kortst, W4 geen W1-overlap) valideren ELKE kandidaat
//   3. Provisional pivots (onbevestigd door gebrek aan future bars) worden gemarkeerd, niet genegeerd
//   4. Als geen enkele kandidaat geldig is → status='unclear', currentWave='unclear'
//   5. .toString() geeft currentWave terug voor backward-compat string interpolatie
// ═══════════════════════════════════════════════════════════

function _findPivots(highs, lows, pLenConfirmed, pLenProvisional) {
  // Returns pivots met 'confirmed' flag — provisional = alleen linker-context volledig
  const pivots = [];
  const n = highs.length;
  for (let i = pLenConfirmed; i < n; i++) {
    const leftH = highs.slice(i - pLenConfirmed, i);
    const leftL = lows.slice(i - pLenConfirmed, i);
    const rightSize = Math.min(pLenConfirmed, n - 1 - i);
    const rightH = highs.slice(i + 1, i + 1 + rightSize);
    const rightL = lows.slice(i + 1, i + 1 + rightSize);
    const confirmed = rightSize >= pLenConfirmed;
    const provisional = !confirmed && rightSize >= pLenProvisional;
    if (!confirmed && !provisional) continue;

    const isHighPivot = (leftH.length === 0 || highs[i] > Math.max(...leftH))
                    && (rightH.length === 0 || highs[i] >= Math.max(...rightH));
    const isLowPivot  = (leftL.length === 0 || lows[i]  < Math.min(...leftL))
                    && (rightL.length === 0 || lows[i]  <= Math.min(...rightL));

    if (isHighPivot) pivots.push({ type: 'H', val: highs[i], idx: i, confirmed });
    if (isLowPivot)  pivots.push({ type: 'L', val: lows[i],  idx: i, confirmed });
  }
  return pivots;
}

function _filterAlternating(pivots) {
  const out = [];
  for (const p of pivots) {
    if (out.length === 0 || out[out.length - 1].type !== p.type) {
      out.push({ ...p });
    } else {
      const last = out[out.length - 1];
      if (p.type === 'H' && p.val > last.val) out[out.length - 1] = { ...p };
      if (p.type === 'L' && p.val < last.val) out[out.length - 1] = { ...p };
    }
  }
  return out;
}

function _retracePct(fromVal, toVal, endVal) {
  // Hoeveel van de move (from→to) is geretraced tot endVal?
  const range = Math.abs(toVal - fromVal);
  if (range === 0) return 0;
  return Math.abs(toVal - endVal) / range;
}

// ── Hard-rule validatie voor één kandidaat count ──
function _validateHardRules(count, currentPrice) {
  const violations = [];
  const { wave, points } = count;

  if (points.W0 != null && points.W1 != null && points.W2 != null) {
    // W2 mag niet onder W0 komen (retracement > 100% van W1)
    if (points.W2 <= points.W0) violations.push('W2 breaks below W0 (> 100% retrace of W1) — invalidates impulse');
  }
  if (points.W1 != null && points.W2 != null && points.W3 != null) {
    // W3 moet HOGER zijn dan W1 (bullish impulse)
    if (points.W3 <= points.W1) violations.push('W3 does not exceed W1 — not a valid impulse');
  }
  if (points.W1 != null && points.W4 != null) {
    // W4 mag niet in W1-territorium komen
    if (points.W4 <= points.W1) violations.push('W4 overlaps W1 territory — forbidden in standard impulse');
  }
  if (points.W1 != null && points.W2 != null && points.W3 != null && points.W5 != null) {
    const w1len = points.W1 - points.W0;
    const w3len = points.W3 - points.W2;
    const w5len = points.W5 - points.W4;
    if (w3len < w1len && w3len < w5len) violations.push('W3 is shortest impulse wave — forbidden');
  }
  // ABC-count: geen hard-rule violations voor structuur, maar proportie-check
  if (wave === 'C' && points.A != null && points.B != null && currentPrice != null) {
    // B mag geen 100% van A retracen (anders geen geldige ABC)
    if (points.B >= points.peak) violations.push('Wave B retraces >100% of A — invalid correction');
  }

  return violations;
}

// ── Fib-proximity scoring (confidence booster) ──
function _fibScore(actualRatio, idealRatio, tolerance = 0.15) {
  const diff = Math.abs(actualRatio - idealRatio);
  if (diff <= tolerance) return 1 - (diff / tolerance) * 0.3; // 0.7..1.0
  if (diff <= tolerance * 2) return 0.4 - (diff - tolerance) / tolerance * 0.3; // 0.1..0.4
  return 0.1;
}

// ── Helper: impulse count vanaf een specifiek low-pivot ──
function _tryImpulseFromLow(candidates, filtered, startPivot, currentPrice, degreeLabel) {
  const afterLow = filtered.filter(p => p.idx >= startPivot.idx);
  if (afterLow.length === 0 || afterLow[0].type !== 'L') return;

  const P = {};
  P.W0 = afterLow[0].val;
  P.W1 = afterLow[1]?.type === 'H' ? afterLow[1].val : null;
  P.W2 = afterLow[2]?.type === 'L' ? afterLow[2].val : null;
  P.W3 = afterLow[3]?.type === 'H' ? afterLow[3].val : null;
  P.W4 = afterLow[4]?.type === 'L' ? afterLow[4].val : null;
  P.W5 = afterLow[5]?.type === 'H' ? afterLow[5].val : null;

  let currentWave, confidence, rationale;
  const sincePivots = afterLow.length;

  if (sincePivots === 1) {
    currentWave = 'W1'; confidence = 0.50;
    rationale = `Eerste rally vanaf ${degreeLabel} low ${P.W0.toFixed(5)} — W1 forming`;
  } else if (sincePivots === 2) {
    const retraceNow = _retracePct(P.W0, P.W1, currentPrice);
    if (currentPrice > P.W1) {
      currentWave = 'W3'; confidence = 0.40;
      rationale = `Prijs boven W1-top ${P.W1.toFixed(5)} → W3 mogelijk gestart (${degreeLabel})`;
    } else if (retraceNow > 1.0) {
      currentWave = 'invalidated'; confidence = 0.05;
      rationale = `W2 breekt W0 → impulse invalidated (${degreeLabel})`;
    } else if (retraceNow > 0.786) {
      currentWave = 'W2'; confidence = 0.50;
      rationale = `Diepe W2 retrace ${(retraceNow*100).toFixed(0)}% van W1 (${degreeLabel}) — binnen regels, maar extreem`;
    } else if (retraceNow >= 0.382) {
      currentWave = 'W2'; confidence = 0.75;
      rationale = `Gezonde W2 retrace ${(retraceNow*100).toFixed(0)}% (fib 38-78%, ${degreeLabel})`;
    } else {
      currentWave = 'W2'; confidence = 0.55;
      rationale = `Ondiepe W2 ${(retraceNow*100).toFixed(0)}% (${degreeLabel})`;
    }
  } else if (sincePivots === 3) {
    if (currentPrice > P.W1) {
      currentWave = 'W3'; confidence = 0.75;
      rationale = `W3 impulse boven W1-top (${degreeLabel})`;
    } else {
      currentWave = 'W3'; confidence = 0.45;
      rationale = `W3 begonnen, onder W1-top (${degreeLabel}) — of W-B alt`;
    }
  } else if (sincePivots === 4) {
    const w3len = P.W3 - P.W2;
    const retrace = (P.W3 - currentPrice) / w3len;
    if (P.W4 != null && P.W4 <= P.W1) {
      currentWave = 'invalidated'; confidence = 0.05;
      rationale = `W4 overlap met W1 → invalid impulse (${degreeLabel})`;
    } else if (retrace >= 0.236 && retrace <= 0.5) {
      currentWave = 'W4'; confidence = 0.70;
      rationale = `W4 binnen fib 23-50% (${degreeLabel})`;
    } else {
      currentWave = 'W4'; confidence = 0.50;
      rationale = `W4 buiten typische fib (${degreeLabel})`;
    }
  } else if (sincePivots === 5) {
    // Check W3 not shortest, W4 no overlap
    const w1len = P.W1 - P.W0;
    const w3len = P.W3 - P.W2;
    if (P.W4 <= P.W1) {
      currentWave = 'invalidated'; confidence = 0.05;
      rationale = `W4 overlap met W1 → ongeldige impulse (${degreeLabel})`;
    } else if (w3len < w1len && w3len < (currentPrice - P.W4)) {
      currentWave = 'invalidated'; confidence = 0.05;
      rationale = `W3 is kortste impulse-golf → regel-schending (${degreeLabel})`;
    } else if (currentPrice > P.W3) {
      currentWave = 'W5'; confidence = 0.70;
      rationale = `W5 impulse boven W3-top (${degreeLabel}) — cyclus vaak ten einde`;
    } else {
      currentWave = 'W5'; confidence = 0.45;
      rationale = `W5 in progress, onder W3-top (truncated 5th mogelijk, ${degreeLabel})`;
    }
  } else if (sincePivots === 6) {
    // Post-impulse: waarschijnlijk wave A van correctie
    currentWave = 'A'; confidence = 0.55;
    rationale = `5-wave impulse voltooid, wave A van ABC-correctie in progress (${degreeLabel})`;
  } else if (sincePivots === 7) {
    currentWave = 'B'; confidence = 0.55;
    rationale = `Post-impulse ABC: in wave B bounce (${degreeLabel})`;
  } else {
    currentWave = 'C'; confidence = 0.50;
    rationale = `Post-impulse ABC: in wave C (${degreeLabel})`;
  }

  const viol = _validateHardRules({ wave: currentWave, points: P }, currentPrice);
  const penalizedConf = viol.length > 0 ? 0 : confidence; // hard-rule violations = reject completely
  candidates.push({
    wave: currentWave,
    confidence: penalizedConf,
    rationale: viol.length > 0 ? `${rationale} [VIOLATIONS: ${viol.join('; ')}]` : rationale,
    points: P,
    violations: viol,
    type: `impulse_${degreeLabel}`,
    startIdx: startPivot.idx
  });
}

// ── Helper: ABC-correctie vanaf een specifiek high-pivot ──
function _tryABCFromHigh(candidates, filtered, startPivot, currentPrice, degreeLabel) {
  const afterHigh = filtered.filter(p => p.idx >= startPivot.idx);
  if (afterHigh.length < 2) return;

  const P = { peak: startPivot.val };
  P.A = afterHigh[1]?.type === 'L' ? afterHigh[1].val : null;
  P.B = afterHigh[2]?.type === 'H' ? afterHigh[2].val : null;
  P.C = afterHigh[3]?.type === 'L' ? afterHigh[3].val : null;

  let currentWave, confidence, rationale;
  const sincePivots = afterHigh.length;

  if (sincePivots === 2) {
    currentWave = 'A'; confidence = 0.50;
    rationale = `Wave A decline vanaf ${degreeLabel} peak ${P.peak.toFixed(5)}`;
  } else if (sincePivots === 3) {
    const bounce = (currentPrice - P.A) / (P.peak - P.A);
    if (bounce >= 0.382 && bounce <= 0.786) {
      currentWave = 'B'; confidence = 0.70;
      rationale = `Wave B bounce ${(bounce*100).toFixed(0)}% van A (fib zone, ${degreeLabel})`;
    } else if (bounce > 1.0) {
      currentWave = 'invalidated'; confidence = 0.05;
      rationale = `B bounce >100% van A → niet ABC (${degreeLabel})`;
    } else {
      currentWave = 'B'; confidence = 0.40;
      rationale = `Wave B bounce ${(bounce*100).toFixed(0)}% — buiten fib (${degreeLabel})`;
    }
  } else if (sincePivots >= 4) {
    // C wave — target typisch 100% van A-length afgetrokken van B
    const aLen = P.peak - P.A;
    const bTop = P.B || P.peak;
    const cTarget = bTop - aLen;
    const cSoFar = bTop - currentPrice;
    const cProgress = aLen > 0 ? cSoFar / aLen : 0;
    if (cProgress >= 0.85 && cProgress <= 1.20) {
      currentWave = 'C'; confidence = 0.80;
      rationale = `Wave C nadert 100% van A — target ≈ ${cTarget.toFixed(5)} (${degreeLabel})`;
    } else if (cProgress > 0 && cProgress < 0.85) {
      currentWave = 'C'; confidence = 0.60;
      rationale = `Wave C in progress ${(cProgress*100).toFixed(0)}% — target = ${cTarget.toFixed(5)} (${degreeLabel})`;
    } else if (cProgress > 1.20) {
      currentWave = 'C'; confidence = 0.45;
      rationale = `Wave C uitgebreid (>120% A) — bodem mogelijk nabij (${degreeLabel})`;
    } else {
      currentWave = 'C'; confidence = 0.35;
      rationale = `Wave C — onzekere progressie (${degreeLabel})`;
    }
  }

  if (!currentWave) return;
  const viol = _validateHardRules({ wave: currentWave, points: P }, currentPrice);
  const penalizedConf = viol.length > 0 ? 0 : confidence;
  candidates.push({
    wave: currentWave,
    confidence: penalizedConf,
    rationale: viol.length > 0 ? `${rationale} [VIOLATIONS: ${viol.join('; ')}]` : rationale,
    points: P,
    violations: viol,
    type: `abc_${degreeLabel}`,
    startIdx: startPivot.idx
  });
}

// ── Kandidaat-enumerator: probeer counts vanaf meerdere start-punten ──
function _enumerateCandidates(filtered, currentPrice, currentIdx) {
  const candidates = [];
  if (filtered.length < 2) {
    candidates.push({ wave: 'W1', confidence: 0.3, rationale: 'Insufficient pivots — assume initial impulse forming', points: {}, violations: [], type: 'insufficient' });
    return candidates;
  }

  const lowPivots = filtered.filter(p => p.type === 'L');
  const highPivots = filtered.filter(p => p.type === 'H');

  // Sort by significance (lowest low / highest high = most significant)
  const sortedLows = [...lowPivots].sort((a, b) => a.val - b.val);
  const sortedHighs = [...highPivots].sort((a, b) => b.val - a.val);

  // Probeer impulse counts vanaf top-3 meest significante lows (grand + 2 sub-degrees)
  const lowStarts = sortedLows.slice(0, 3);
  for (let i = 0; i < lowStarts.length; i++) {
    const lbl = i === 0 ? 'grand-low' : `sub-low-${i}`;
    _tryImpulseFromLow(candidates, filtered, lowStarts[i], currentPrice, lbl);
  }

  // Probeer ABC counts vanaf top-2 meest significante highs
  const highStarts = sortedHighs.slice(0, 2);
  for (let i = 0; i < highStarts.length; i++) {
    const lbl = i === 0 ? 'grand-high' : `sub-high-${i}`;
    _tryABCFromHigh(candidates, filtered, highStarts[i], currentPrice, lbl);
  }

  // Altijd ook: probeer impulse vanaf MEEST RECENTE low (nested sub-degree)
  if (lowPivots.length > 0) {
    const recentLow = lowPivots[lowPivots.length - 1];
    if (!lowStarts.find(p => p.idx === recentLow.idx)) {
      _tryImpulseFromLow(candidates, filtered, recentLow, currentPrice, 'recent-low');
    }
  }

  return candidates;
}

// ── Hoofd-entry: publieke API ──
function detectElliottWave(highs, lows, pivotLen = 5, opts = {}) {
  const {
    provisionalLen = 2,
    token = null,
    timeframe = null,
    silent = true,
  } = opts;

  const inputs = { pivotLen, provisionalLen, candles: highs.length, token, timeframe };

  if (!highs || highs.length < 20) {
    return _makeResult('unclear', null, null, [], [], 'insufficient_data', inputs);
  }

  const rawPivots = _findPivots(highs, lows, pivotLen, provisionalLen);
  const filtered = _filterAlternating(rawPivots);
  const currentPrice = highs[highs.length - 1]; // gebruik laatste high als benadering current; signals.js geeft close apart mee

  const candidates = _enumerateCandidates(filtered, currentPrice, highs.length - 1);

  const valid = candidates.filter(c => c.wave !== 'invalidated' && c.wave !== 'unclear' && c.violations.length === 0);
  const invalidated = candidates.filter(c => c.wave === 'invalidated' || c.violations.length > 0);

  valid.sort((a, b) => b.confidence - a.confidence);

  const primary = valid[0] || null;
  const alternate = valid[1] || null;

  let status;
  if (!primary) status = 'unclear';
  else if (filtered.some(p => !p.confirmed)) status = 'provisional';
  else status = 'clear';

  const currentWave = primary ? primary.wave : 'unclear';

  if (!silent) {
    console.log(`[EW Audit] ${token || '?'} ${timeframe || '?'}: primary=${currentWave} (${primary?.confidence.toFixed(2)}) alt=${alternate?.wave || '—'} status=${status}`);
    if (invalidated.length > 0) {
      console.log(`  Rejected counts: ${invalidated.map(c => `${c.type}→${c.wave}`).join(', ')}`);
    }
  }

  return _makeResult(currentWave, primary, alternate, filtered, invalidated, status, inputs);
}

function _makeResult(currentWave, primary, alternate, pivots, rejected, status, inputs) {
  const obj = {
    currentWave,
    primary: primary || { wave: currentWave, confidence: 0, rationale: 'no valid count' },
    alternate,
    pivots,
    rejected,
    status,
    inputs,
    // Backward compat: string interpolatie ${ewWave} geeft currentWave terug
    toString() { return currentWave; }
  };
  // Ook: .includes(obj) gebruikt strict equality → werkt niet. Helper _ewStr hieronder.
  return obj;
}

// Helper: extract wave string uit context (string | object | null)
function _ewStr(ctx) {
  if (ctx == null) return null;
  if (typeof ctx === 'string') return ctx;
  if (typeof ctx === 'object') return ctx.currentWave || ctx.primary?.wave || null;
  return null;
}

// ── Data Fetchers ──
async function fetchBitvavoCandles(market, interval, limit = 500) {
  try {
    // M-P0-16 fix (2026-04-23): Bitvavo heeft GEEN native '1M' interval.
    // Ondersteund: 1m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 8h, 12h, 1d, 1w.
    // Vroeger: gewoon `null` returnen → monthly chart stuk als Binance down is.
    // Nu: fetch 1d candles en aggregeer naar maand (calendar-month buckets).
    if (interval === '1M') {
      const dailyLimit = Math.min(1000, Math.max(365, limit * 31));   // ~31 dagen per maand
      const dailyCandles = await fetchBitvavoCandles(market, '1d', dailyLimit);
      if (!dailyCandles || dailyCandles.length < 31) return null;
      return _aggregateDailyToMonthly(dailyCandles).slice(-limit);
    }
    const end = Date.now();
    const intervalMs = interval === '4h' ? 4 * 60 * 60 * 1000
                     : interval === '1d' ? 24 * 60 * 60 * 1000
                     : interval === '1w' ? 7 * 24 * 60 * 60 * 1000
                     : 30 * 24 * 60 * 60 * 1000;
    const start = end - limit * intervalMs;
    const url = `https://api.bitvavo.com/v2/${market}/candles?interval=${interval}&start=${start}&end=${end}&limit=${limit}`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!Array.isArray(data) || data.length < 50) return null;
    return data.reverse().map(k => ({
      time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
      low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5])
    }));
  } catch (e) {
    console.warn(`Bitvavo ${market} ${interval} failed:`, e.message);
    return null;
  }
}

// M-P0-16 fix (2026-04-23): aggregeer daily candles → monthly buckets.
// Calendar-month grouping (UTC) — compat met Binance 1M die ook UTC calendar-month is.
function _aggregateDailyToMonthly(dailyCandles) {
  if (!Array.isArray(dailyCandles) || dailyCandles.length === 0) return [];
  const buckets = new Map();   // key = "YYYY-MM" (UTC) → { time, open, high, low, close, volume }
  for (const c of dailyCandles) {
    const d = new Date(c.time);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    let b = buckets.get(key);
    if (!b) {
      // Bucket start = 1e van de maand UTC, zodat .time aligned met Binance 1M
      const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0);
      b = { time: monthStart, open: c.open, high: c.high, low: c.low, close: c.close, volume: 0 };
      buckets.set(key, b);
    }
    // Open: van eerste dag (al gezet). High/low: agg. Close: laatste dag.
    if (c.high > b.high) b.high = c.high;
    if (c.low  < b.low)  b.low  = c.low;
    b.close = c.close;
    b.volume += c.volume;
  }
  // Sorteer op time (oldest first), zelfde als native 1M candles
  return Array.from(buckets.values()).sort((a, b) => a.time - b.time);
}

async function fetchBinanceKlines(symbol, interval, limit = 500) {
  const urls = [
    `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
    `https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
  ];
  for (const url of urls) {
    try {
      const resp = await fetch(url);
      const data = await resp.json();
      if (!Array.isArray(data)) continue;
      return data.map(k => ({
        time: Math.floor(k[0] / 1000) * 1000,
        open: parseFloat(k[1]), high: parseFloat(k[2]),
        low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5])
      }));
    } catch (e) { continue; }
  }
  return null;
}

async function fetchCandles(token, interval, limit = 500) {
  // VENUE switch: 'binance' (default) → Binance USDT eerst, Bitvavo als fallback.
  // 'bitvavo' → Bitvavo EUR voor 4H eerst, Binance fallback.
  const venue = (process.env.VENUE || 'binance').toLowerCase();
  // M-P0-16 fix (2026-04-23): Bitvavo fallback is nu ook beschikbaar voor 1M
  // en 1d (via aggregateDailyToMonthly bij 1M). Vroeger werkte fallback alleen
  // op 4h → bij Binance-outage was monthly chart ineens leeg.
  const bitvavoSupported = ['4h', '1d', '1w', '1M'].includes(interval);
  if (venue === 'binance') {
    const binance = await fetchBinanceKlines(token.symbol, interval, limit);
    if (binance) {
      console.log(`[Data] ${token.short} ${interval}: Binance USDT (${binance.length} candles)`);
      return binance;
    }
    if (bitvavoSupported && token.market) {
      const bv = await fetchBitvavoCandles(token.market, interval, limit);
      if (bv) { console.log(`[Data] ${token.short} ${interval}: Bitvavo EUR fallback (${bv.length} candles)`); return bv; }
    }
    return null;
  }
  // legacy bitvavo-first path
  if (bitvavoSupported && token.market) {
    const bv = await fetchBitvavoCandles(token.market, interval, limit);
    if (bv) { console.log(`[Data] ${token.short} ${interval}: Bitvavo EUR (${bv.length} candles)`); return bv; }
  }
  const binance = await fetchBinanceKlines(token.symbol, interval, limit);
  if (binance) console.log(`[Data] ${token.short} ${interval}: Binance USDT fallback (${binance.length} candles)`);
  return binance;
}

async function fetchKronos(symbol) {
  const KRONOS_URL = (process.env.KRONOS_URL || 'https://camelotlabs-kronos-ai-forecast.hf.space').replace(/\/$/, '');
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const resp = await fetch(`${KRONOS_URL}/forecast?symbol=${encodeURIComponent(symbol)}`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    console.log(`[Kronos] ${symbol}: ${data.direction} ${data.pct > 0 ? '+' : ''}${data.pct}% score ${data.score}`);
    return data;
  } catch (e) {
    console.warn(`[Kronos] ${symbol} offline: ${e.message}`);
    return { symbol, direction: 'neutral', pct: 0, score: 0, offline: true };
  }
}

// ── Signal Engine ──
// SINGLE SOURCE OF TRUTH (Path C refactor 2026-04):
//   - Engine (paper-engine.js)   → 4H, waveContext = simple EW audit object
//   - Cron  (signals-cron.js)    → 4H + Monthly, waveContext = EW audit object
//   - Dashboard via /api/signals → 4H + Monthly, waveContext kan rich object zijn
//                                  met progressPct/waveConfidence/waveInfo
// Alle paden draaien dit éne stuk code → geen drift mogelijk.
function generateSignals(candles, timeframe = 'monthly', kronosScore = 0, waveContext = null) {
  const is4H = timeframe === '4h';
  const cfg = _signalParams ? (is4H ? _signalParams['4h'] : _signalParams['monthly']) : null;
  const P = {
    emaIndWeight: cfg?.emaIndWeight ?? 2, emaScoreWeight: cfg?.emaScoreWeight ?? 3,
    macdIndWeight: cfg?.macdIndWeight ?? 1, macdScoreWeight: cfg?.macdScoreWeight ?? 2,
    rsi_ob1: cfg?.rsi_ob1 ?? (is4H ? 75 : 85), rsi_ob2: cfg?.rsi_ob2 ?? (is4H ? 70 : 78), rsi_ob3: cfg?.rsi_ob3 ?? (is4H ? 65 : 70),
    rsi_os1: cfg?.rsi_os1 ?? (is4H ? 30 : 25), rsi_os2: cfg?.rsi_os2 ?? (is4H ? 35 : 32), rsi_os3: cfg?.rsi_os3 ?? (is4H ? 40 : 38),
    mom_drop: cfg?.mom_drop ?? (is4H ? 0.03 : 0.15), mom_rise: cfg?.mom_rise ?? (is4H ? 0.05 : 0.25),
    mom_highDrop: cfg?.mom_highDrop ?? (is4H ? 0.08 : 0.30), mom_lowRise: cfg?.mom_lowRise ?? (is4H ? 0.12 : 0.80),
    candleWeight: cfg?.candleWeight ?? 1, volMultiplier: cfg?.volMultiplier ?? 1.5, volWeight: cfg?.volWeight ?? 1, trendWeight: cfg?.trendWeight ?? 1,
    minIndicators: cfg?.minIndicators ?? (is4H ? 3 : 2), minScore: cfg?.minScore ?? 3, minStars: cfg?.minStars ?? 3,
    cooldown: cfg?.cooldown ?? (is4H ? 12 : 3),
    requireTrendAlignment: cfg?.requireTrendAlignment ?? true, antiTrendBlock: cfg?.antiTrendBlock ?? true, requireMultiCandle: cfg?.requireMultiCandle ?? true,
  };
  const closes = candles.map(c => c.close);
  const ema9 = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const ema50 = calcEMA(closes, 50);
  const ema200 = calcEMA(closes, 200);
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const macdLine = ema12.map((v, j) => v - ema26[j]);
  const macdSignal = calcEMA(macdLine, 9);
  const markers = [];
  let buyCount = 0, sellCount = 0;
  let lastBuyIdx = -10, lastSellIdx = -10;
  const cooldown = P.cooldown;

  for (let i = 2; i < candles.length; i++) {
    const c = candles[i];
    let bullIndicators = 0, bearIndicators = 0;
    let bullScore = 0, bearScore = 0;

    // ═══ 1. EMA 9/21 crossover ═══
    const emaCrossUp = ema9[i] > ema21[i] && ema9[i - 1] <= ema21[i - 1];
    const emaCrossDown = ema9[i] < ema21[i] && ema9[i - 1] >= ema21[i - 1];
    if (emaCrossUp) { bullIndicators += P.emaIndWeight; bullScore += P.emaScoreWeight; }
    if (emaCrossDown) { bearIndicators += P.emaIndWeight; bearScore += P.emaScoreWeight; }

    // ═══ 2. MACD crossover ═══
    if (i >= 27) {
      const macdCrossUp = macdLine[i] > macdSignal[i] && macdLine[i - 1] <= macdSignal[i - 1];
      const macdCrossDown = macdLine[i] < macdSignal[i] && macdLine[i - 1] >= macdSignal[i - 1];
      if (macdCrossUp) { bullIndicators += P.macdIndWeight; bullScore += P.macdScoreWeight; }
      if (macdCrossDown) { bearIndicators += P.macdIndWeight; bearScore += P.macdScoreWeight; }
    }

    // ═══ 3. RSI ═══
    if (i >= 15) {
      const rsiArr = calcRSI(closes.slice(0, i + 1));
      const lastRSI = rsiArr[rsiArr.length - 1];
      if (lastRSI >= P.rsi_ob1) { bearIndicators += 2; bearScore += 4; }
      else if (lastRSI >= P.rsi_ob2) { bearIndicators += 2; bearScore += 3; }
      else if (lastRSI >= P.rsi_ob3) { bearIndicators++; bearScore += 2; }
      if (lastRSI <= P.rsi_os1) { bullIndicators += 2; bullScore += 4; }
      else if (lastRSI <= P.rsi_os2) { bullIndicators += 2; bullScore += 3; }
      else if (lastRSI <= P.rsi_os3) { bullIndicators++; bullScore += 2; }
    }

    // ═══ 4. Prijs momentum ═══
    if (i >= 3) {
      const pctChange = (c.close - candles[i - 1].close) / candles[i - 1].close;
      if (pctChange <= -P.mom_drop) { bearIndicators++; bearScore += 1; }
      if (pctChange >= P.mom_rise) { bullIndicators++; bullScore += 1; }
      const rHigh = Math.max(...candles.slice(Math.max(0, i - 6), i + 1).map(x => x.high));
      const rLow = Math.min(...candles.slice(Math.max(0, i - 6), i + 1).map(x => x.low));
      if ((rHigh - c.close) / rHigh > P.mom_highDrop) { bullIndicators++; bullScore += 1; }
      if ((c.close - rLow) / rLow > P.mom_lowRise) { bearIndicators++; bearScore += 1; }
    }

    // ═══ 5. Candle patterns ═══
    if (i >= 1) {
      const prev = candles[i - 1], curr = candles[i];
      if (prev.close > prev.open && curr.close < curr.open && curr.close < prev.open && curr.open > prev.close) {
        bearIndicators++; bearScore += P.candleWeight;
      }
      if (prev.close < prev.open && curr.close > curr.open && curr.close > prev.open && curr.open < prev.close) {
        bullIndicators++; bullScore += P.candleWeight;
      }
      const body = Math.abs(c.close - c.open);
      const upperWick = c.high - Math.max(c.open, c.close);
      const lowerWick = Math.min(c.open, c.close) - c.low;
      if (body > 0) {
        if (upperWick > body * 2 && lowerWick < body * 0.5 && c.close < c.open) { bearIndicators++; bearScore += P.candleWeight; }
        if (lowerWick > body * 2 && upperWick < body * 0.5 && c.close > c.open) { bullIndicators++; bullScore += P.candleWeight; }
      }
    }

    // ═══ 6. Volume spike ═══
    if (i >= 20) {
      const avgVol = candles.slice(i - 20, i).reduce((s, x) => s + x.volume, 0) / 20;
      if (candles[i].volume > avgVol * P.volMultiplier) {
        if (bullScore > bearScore) bullScore += P.volWeight;
        if (bearScore > bullScore) bearScore += P.volWeight;
      }
    }

    // ═══ 7. Trend context ═══
    if (i >= 50) {
      if (closes[i] > ema50[i] && bullScore > bearScore) bullScore += P.trendWeight;
      if (closes[i] < ema50[i] && bearScore > bullScore) bearScore += P.trendWeight;
    }

    // ═══ 8. Kronos AI context (alleen 4H laatste candle) ═══
    if (is4H && i === candles.length - 1 && kronosScore !== 0) {
      if (kronosScore >= 10) { bullIndicators += 2; bullScore += 3; }
      else if (kronosScore >= 5) { bullIndicators++; bullScore += 2; }
      else if (kronosScore >= 2) { bullScore += 1; }
      if (kronosScore <= -10) { bearIndicators += 2; bearScore += 3; }
      else if (kronosScore <= -5) { bearIndicators++; bearScore += 2; }
      else if (kronosScore <= -2) { bearScore += 1; }
    }

    // ═══ 9. Elliott Wave context — ACTIEVE SCORING + BLOKKADE ═══
    // Voor maandgrafiek: waveContext kan een object zijn met currentWave,
    //   progressPct, waveConfidence, waveInfo (rich path).
    // Voor 4H of als geen rich object: gebruikt simpele wave-naam (string of EW audit obj).
    let ewBlockBull = false, ewBlockBear = false;
    if (waveContext && i === candles.length - 1) {
      const isWaveObj = typeof waveContext === 'object' && waveContext.currentWave;
      const waveName = isWaveObj ? waveContext.currentWave : _ewStr(waveContext);
      const impulseWaves   = ['W1', 'W3', 'W5'];
      const correctionWaves = ['W2', 'W4', 'A', 'B', 'C'];

      // ── Blokkade (origineel) ──
      if (waveName && impulseWaves.includes(waveName))   ewBlockBear = true;
      if (waveName && correctionWaves.includes(waveName)) ewBlockBull = true;

      // ── ACTIEVE EW SCORING (alleen maandgrafiek met rich waveContext object) ──
      if (isWaveObj && !is4H && waveContext.progressPct !== undefined) {
        const progress = waveContext.progressPct || 0;
        const confidence = waveContext.waveConfidence || 'uncertain';
        const wInfo = waveContext.waveInfo || {};
        const curInfo = wInfo[waveName] || {};

        // ── BODEM DETECTIE (BUY bij wave completie) ──
        if (waveName === 'W2' && progress >= 70) {
          bullIndicators += 2; bullScore += 4;
          ewBlockBull = false;
          if (confidence === 'confirmed' || confidence === 'likely') {
            bullIndicators += 1; bullScore += 2;
          }
        }
        if (waveName === 'W4' && progress >= 70) {
          bullIndicators += 2; bullScore += 3;
          ewBlockBull = false;
          if (confidence === 'confirmed' || confidence === 'likely') {
            bullIndicators += 1; bullScore += 1;
          }
        }
        if (waveName === 'C' && progress >= 65) {
          bullIndicators += 3; bullScore += 5;
          ewBlockBull = false;
          if (confidence === 'confirmed') {
            bullScore += 2;
          }
        }
        if (waveName === 'A' && progress >= 80) {
          bullIndicators += 1; bullScore += 2;
          ewBlockBull = false;
        }

        // ── TOP DETECTIE (SELL bij wave completie) ──
        if (waveName === 'W3' && progress >= 85) {
          bearIndicators += 2; bearScore += 3;
          ewBlockBear = false;
          if (confidence === 'confirmed' || confidence === 'likely') {
            bearIndicators += 1; bearScore += 2;
          }
        }
        if (waveName === 'W5' && progress >= 70) {
          bearIndicators += 3; bearScore += 5;
          ewBlockBear = false;
          if (confidence === 'confirmed') {
            bearScore += 2;
          }
        }
        if (waveName === 'B' && progress >= 60) {
          bearIndicators += 2; bearScore += 4;
          ewBlockBear = false;
        }

        // ── IMPULSE WAVE VERSTERKING ──
        if (waveName === 'W1' && progress < 50) bullScore += 1;
        if (waveName === 'W3' && progress < 50) bullScore += 4;
        if (waveName === 'W5' && progress < 30) bullScore += 1;
      }
    }

    // ═══ 10. Trend Alignment — EMA cascade ═══
    let trendAligned = true;
    if (P.requireTrendAlignment && i >= 50) {
      const bullAlignment = ema9[i] > ema21[i] && ema21[i] > ema50[i];
      const bearAlignment = ema9[i] < ema21[i] && ema21[i] < ema50[i];
      const ewOverride = !is4H && (bullScore >= 6 || bearScore >= 6);
      if (!ewOverride) {
        if (bullScore > bearScore && !bullAlignment) trendAligned = false;
        if (bearScore > bullScore && !bearAlignment) trendAligned = false;
      }
    }

    // ═══ 11. Anti-Trend Block ═══
    let antiTrendBlocked = false;
    if (P.antiTrendBlock && i >= 50) {
      const isWaveObj = typeof waveContext === 'object' && waveContext?.currentWave;
      const progressPct = isWaveObj ? (waveContext.progressPct || 0) : 100; // string-context = treat als full progress
      const waveName = isWaveObj ? waveContext.currentWave : _ewStr(waveContext);
      const isEWBottom = !is4H && waveName && ['W2', 'W4', 'C', 'A'].includes(waveName) && progressPct >= 65;
      const isEWTop    = !is4H && waveName && ['W3', 'W5', 'B'].includes(waveName) && progressPct >= 70;
      if (!isEWBottom && !isEWTop) {
        if (bullScore > bearScore && closes[i] < ema50[i]) antiTrendBlocked = true;
        if (bearScore > bullScore && closes[i] > ema50[i]) antiTrendBlocked = true;
      }
    }

    // ═══ 12. Multi-Candle Confirmatie ═══
    let multiCandleOk = true;
    if (P.requireMultiCandle && i >= 2) {
      const isWaveObj = typeof waveContext === 'object' && waveContext?.currentWave;
      const hasEWSignal = !is4H && isWaveObj && (bullScore + bearScore >= 6);
      if (!hasEWSignal) {
        if (bullScore > bearScore) {
          multiCandleOk = candles[i].close > candles[i].open && candles[i - 1].close > candles[i - 1].open;
        } else if (bearScore > bullScore) {
          multiCandleOk = candles[i].close < candles[i].open && candles[i - 1].close < candles[i - 1].open;
        }
      }
    }

    // ═══ 13. Extreme Drawdown Filter ═══
    let extremeDrawdown = false;
    if (i >= 6) {
      const lookback = Math.min(i, is4H ? 120 : 12);
      const recentHigh = Math.max(...candles.slice(Math.max(0, i - lookback), i + 1).map(x => x.high));
      const drawdownPct = (recentHigh - c.close) / recentHigh;
      if (drawdownPct > 0.60 && bearScore > bullScore) extremeDrawdown = true;
    }

    // ═══ Signaal generatie ═══
    const netScore = bullScore - bearScore;
    const absScore = Math.abs(netScore);
    const stars = Math.min(5, absScore);
    const passFilters = trendAligned && !antiTrendBlocked && multiCandleOk && !extremeDrawdown;
    const isBull = !ewBlockBull && passFilters && netScore > 0 && bullIndicators >= P.minIndicators && absScore >= P.minScore && stars >= P.minStars;
    const isBear = !ewBlockBear && passFilters && netScore < 0 && bearIndicators >= P.minIndicators && absScore >= P.minScore && stars >= P.minStars;
    const starStr = '★'.repeat(stars);
    const priceStr = c.close < 1 ? c.close.toFixed(4) : c.close < 100 ? c.close.toFixed(2) : c.close.toLocaleString('en-US', { maximumFractionDigits: 0 });

    if (isBull && (i - lastBuyIdx) >= cooldown) {
      // Marker bevat ZOWEL backend velden (type/stars/index/price/time) ALS
      // dashboard UI velden (position/color/shape/text/size). Backwards-compat
      // met paper-engine + signals-cron, plus directe render in dashboard chart.
      markers.push({
        time: c.time,
        position: 'belowBar',
        color: '#00c853',
        shape: 'arrowUp',
        text: '▲ BUY ' + starStr + '  $' + priceStr,
        size: 2,
        type: 'BUY', stars, index: i, price: c.close
      });
      buyCount++; lastBuyIdx = i;
    } else if (isBear && (i - lastSellIdx) >= cooldown) {
      markers.push({
        time: c.time,
        position: 'aboveBar',
        color: '#d50000',
        shape: 'arrowDown',
        text: '▼ SELL ' + starStr + '  $' + priceStr,
        size: 2,
        type: 'SELL', stars, index: i, price: c.close
      });
      sellCount++; lastSellIdx = i;
    }
  }
  return { markers, buyCount, sellCount, ema9, ema21, ema50, ema200 };
}

// ── 4H Levels (ATR + Kronos-aware) ──
function calc4hLevels(candles, signalType, kronos = {}) {
  const len = candles.length;
  const close = candles[len - 1].close;
  let atrSum = 0;
  for (let i = len - 14; i < len; i++) {
    if (i < 1) continue;
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    atrSum += tr;
  }
  const atr = atrSum / 14;
  const lookback = candles.slice(-24);
  const recentHigh = Math.max(...lookback.map(c => c.high));
  const recentLow = Math.min(...lookback.map(c => c.low));
  const kronosForecast = kronos.forecast || null;
  const kronosPct = kronos.pct || 0;
  const kronosOnline = !kronos.offline && kronosForecast;
  const minStop = atr;

  if (signalType === 'BUY') {
    const instap = close;
    const atrTarget = close + atr * 2.5;
    let uitstap;
    if (kronosOnline && kronosPct > 0) {
      const swingTarget = Math.max(atrTarget, recentHigh * 1.005);
      uitstap = swingTarget * 0.6 + kronosForecast * 0.4;
      uitstap = Math.max(uitstap, atrTarget);
    } else {
      uitstap = Math.max(atrTarget, recentHigh * 1.005);
    }
    const stop = Math.min(close - atr * 1.2, recentLow * 0.995);
    const safeStop = Math.min(stop, close - minStop);
    return { instap, uitstap, stop: safeStop, atr, kronosUsed: kronosOnline && kronosPct > 0 };
  } else {
    const instap = close;
    const atrTarget = close - atr * 2.5;
    let uitstap;
    if (kronosOnline && kronosPct < 0) {
      const swingTarget = Math.min(atrTarget, recentLow * 0.995);
      uitstap = swingTarget * 0.6 + kronosForecast * 0.4;
      uitstap = Math.min(uitstap, atrTarget);
    } else {
      uitstap = Math.min(atrTarget, recentLow * 0.995);
    }
    const stop = Math.max(close + atr * 1.2, recentHigh * 1.005);
    const safeStop = Math.max(stop, close + minStop);
    return { instap, uitstap, stop: safeStop, atr, kronosUsed: kronosOnline && kronosPct < 0 };
  }
}

// ── EW params loader (leest tuner-output ew-params.json) ──
let _ewParamsCache = null, _ewParamsLoadedAt = 0;
function loadEwParams() {
  const now = Date.now();
  if (_ewParamsCache && (now - _ewParamsLoadedAt < 60_000)) return _ewParamsCache;
  try {
    const fs = require('fs'), path = require('path');
    const p = path.join(__dirname, '..', '..', 'ew-params.json');
    _ewParamsCache = JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch { _ewParamsCache = { pivotLen: 5, provisionalLen: 2 }; }
  _ewParamsLoadedAt = now;
  return _ewParamsCache;
}

module.exports = {
  calcEMA, calcRSI, calcATR,
  detectElliottWave,
  ewString: _ewStr,
  fetchBitvavoCandles, fetchBinanceKlines, fetchCandles, fetchKronos,
  generateSignals, calc4hLevels,
  getParams,
  loadEwParams,
  computeExitScore,
};

// ── Exit Score (-10..+10) — server-side port van Signal Lab homepage ──
// Negatieve score = exit-druk (overbought, top-of-fib, MACD bearish, etc.).
// Positieve score = entry-druk. Gebruikt door paper-engine om open posities
// strakker te trailen of te sluiten als markt-druk omslaat tegen positie.
//
// Score-componenten (overgenomen van index.html signalBadge logic):
//   RSI      <30 +1, >70 -1
//   MACD     hist >0 +1, <0 -1
//   Trend    bull (ema_fast>slow + price>ema50) +1, bear -1
//   Volume   >1.5× & green +1, >1.5× & red -1
//   Fib      ≥0.618+bull +1, ≤0.382+bear -1
//   Structuur price>ema50+bull +1, price<ema50+bear -1
//   Wave     W1/W2/W3 +1, A/C -1
//   MACD x   bullish cross +2, bearish cross -2
function computeExitScore(candles) {
  if (!candles || candles.length < 50) return { score: 0, components: {}, insufficient: true };
  const closes = candles.map(c => c.close);
  const opens  = candles.map(c => c.open);
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);
  const vols   = candles.map(c => c.volume || 0);

  const last = closes.length - 1;
  const price = closes[last];
  const lastOpen = opens[last];

  // RSI
  const rsiArr = calcRSI(closes, 14);
  const rsi = rsiArr[last] ?? 50;

  // MACD
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const macdArr = ema12.map((v, i) => v - ema26[i]);
  const macdSig = calcEMA(macdArr, 9);
  const macdHist = (macdArr[last] - macdSig[last]) || 0;

  // Trend EMAs
  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, 50);
  const ef = ema20[last], es = ema50[last], e50 = ema50[last];
  const bull = ef > es && price > e50;
  const bear = ef < es && price < e50;

  // Volume ratio (laatste vs gemiddelde laatste 20)
  const volAvg = vols.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const volR = volAvg > 0 ? vols[last] / volAvg : 1;

  // Fib position binnen lookback range
  const lookback = Math.min(50, candles.length);
  const recent = candles.slice(-lookback);
  const hi = Math.max(...recent.map(c => c.high));
  const lo = Math.min(...recent.map(c => c.low));
  const fib = hi > lo ? (price - lo) / (hi - lo) : 0.5;

  // Score
  let score = 0;
  const comp = {};
  comp.rsi      = rsi < 30 ? 1 : rsi > 70 ? -1 : 0;
  comp.macdHist = macdHist > 0 ? 1 : macdHist < 0 ? -1 : 0;
  comp.trend    = bull ? 1 : bear ? -1 : 0;
  comp.volume   = volR > 1.5 && price > lastOpen ? 1 : volR > 1.5 && price < lastOpen ? -1 : 0;
  comp.fib      = fib >= 0.618 && bull ? 1 : fib <= 0.382 && bear ? -1 : 0;
  comp.struct   = price > e50 && bull ? 1 : price < e50 && bear ? -1 : 0;

  // Elliott wave bonus
  try {
    const wave = detectElliottWave(highs, lows);
    const waveStr = _ewStr(wave);
    if (['W1', 'W2', 'W3'].includes(waveStr)) comp.wave = 1;
    else if (['A', 'C'].includes(waveStr)) comp.wave = -1;
    else comp.wave = 0;
  } catch (e) { comp.wave = 0; }

  // MACD crossover (worth 2)
  if (macdArr.length >= 2) {
    const crossUp   = macdArr[last] > macdSig[last] && macdArr[last-1] <= macdSig[last-1];
    const crossDown = macdArr[last] < macdSig[last] && macdArr[last-1] >= macdSig[last-1];
    if (crossUp) comp.macdCross = 2;
    else if (crossDown) comp.macdCross = -2;
    else comp.macdCross = 0;
  }

  for (const v of Object.values(comp)) score += v;
  return { score, components: comp, rsi, macdHist, fib, volR, bull, bear };
}
