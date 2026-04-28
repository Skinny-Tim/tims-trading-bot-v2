const PDFDocument = require('pdfkit');
const { Resend } = require('resend');
const { execSync } = require('child_process');

// ═══ Technical Indicator Calculations ═══
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

function calcMACD(closes) {
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const macd = ema12.map((v, i) => v - ema26[i]);
  const signal = calcEMA(macd, 9);
  const hist = macd.map((v, i) => v - signal[i]);
  return { macd, signal, hist };
}

function calcFib(highs, lows, close, lookback) {
  const h = highs.slice(-lookback);
  const l = lows.slice(-lookback);
  const high = Math.max(...h);
  const low = Math.min(...l);
  const range = high - low;
  if (range === 0) return 0.5;
  return (close - low) / range;
}

// ═══ Elliott Wave Detection (100% identiek aan app-logica index.html) ═══
function analyzeWaveDetails(candles, pivotLen = 3) {
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const closes = candles.map(c => c.close);
  const currentPrice = closes[closes.length - 1];
  const totalBars = candles.length;

  // Stap 1: Macro swing detectie
  const rawSwings = [];
  for (let i = pivotLen; i < highs.length - pivotLen; i++) {
    const hSlice = highs.slice(i - pivotLen, i + pivotLen + 1);
    const lSlice = lows.slice(i - pivotLen, i + pivotLen + 1);
    if (highs[i] === Math.max(...hSlice)) rawSwings.push({ type: 'H', val: highs[i], idx: i });
    if (lows[i] === Math.min(...lSlice)) rawSwings.push({ type: 'L', val: lows[i], idx: i });
  }
  rawSwings.sort((a, b) => a.idx - b.idx);
  const swings = [];
  for (const s of rawSwings) {
    if (swings.length === 0 || swings[swings.length - 1].type !== s.type) {
      swings.push(s);
    } else {
      const last = swings[swings.length - 1];
      if (s.type === 'H' && s.val > last.val) swings[swings.length - 1] = s;
      if (s.type === 'L' && s.val < last.val) swings[swings.length - 1] = s;
    }
  }

  // Stap 2: Cyclus-bodem (diepste punt)
  let cycleBottomIdx = 0, cycleBottomVal = Infinity;
  for (let i = 0; i < swings.length; i++) {
    if (swings[i].type === 'L' && swings[i].val < cycleBottomVal) {
      cycleBottomVal = swings[i].val;
      cycleBottomIdx = i;
    }
  }
  const cycleSwings = swings.slice(cycleBottomIdx);

  // Stap 3: Wave labeling met regelvalidatie
  const wavePoints = {};
  const waveDurations = {};

  if (cycleSwings.length > 0 && cycleSwings[0].type === 'L') {
    wavePoints['W0'] = { price: cycleSwings[0].val, barIdx: cycleSwings[0].idx };
  } else {
    const firstLow = cycleSwings.find(s => s.type === 'L');
    if (firstLow) wavePoints['W0'] = { price: firstLow.val, barIdx: firstLow.idx };
    else wavePoints['W0'] = { price: Math.min(...lows), barIdx: lows.indexOf(Math.min(...lows)) };
  }

  const w0 = wavePoints['W0'];
  let swingIdx = cycleSwings.indexOf(cycleSwings.find(s => s.type === 'L' && s.val === w0.price && s.idx === w0.barIdx));
  if (swingIdx < 0) swingIdx = 0;

  const waveSequence = [
    { name: 'W1', type: 'H' }, { name: 'W2', type: 'L' }, { name: 'W3', type: 'H' },
    { name: 'W4', type: 'L' }, { name: 'W5', type: 'H' },
    { name: 'A', type: 'L' }, { name: 'B', type: 'H' }, { name: 'C', type: 'L' }
  ];

  let seqPos = 0;
  for (let i = swingIdx + 1; i < cycleSwings.length && seqPos < waveSequence.length; i++) {
    const s = cycleSwings[i];
    const expected = waveSequence[seqPos];
    if (s.type !== expected.type) continue;

    let valid = true;
    const p = s.val;
    if (expected.name === 'W1') valid = p > w0.price;
    else if (expected.name === 'W2') valid = wavePoints['W1'] && p > w0.price && p < wavePoints['W1'].price;
    else if (expected.name === 'W3') valid = wavePoints['W1'] && p > wavePoints['W1'].price;
    else if (expected.name === 'W4') valid = wavePoints['W1'] && wavePoints['W3'] && p > wavePoints['W1'].price && p < wavePoints['W3'].price;
    else if (expected.name === 'W5') valid = wavePoints['W4'] && p > wavePoints['W4'].price;
    else if (expected.name === 'A') valid = wavePoints['W5'] && p < wavePoints['W5'].price;
    else if (expected.name === 'B') valid = wavePoints['A'] && wavePoints['W5'] && p > wavePoints['A'].price && p < wavePoints['W5'].price;
    else if (expected.name === 'C') valid = wavePoints['B'] && p < wavePoints['B'].price;

    if (valid) { wavePoints[expected.name] = { price: p, barIdx: s.idx }; seqPos++; }
  }

  // Stap 3b: STRIKTE Elliott Wave validatie
  // Regel 1: W3 mag NOOIT de kortste impulsgolf zijn
  if (wavePoints['W1'] && wavePoints['W3'] && wavePoints['W5']) {
    const w1R = wavePoints['W1'].price - wavePoints['W0'].price;
    const w3R = wavePoints['W3'].price - (wavePoints['W2'] ? wavePoints['W2'].price : wavePoints['W0'].price);
    const w5R = wavePoints['W5'].price - (wavePoints['W4'] ? wavePoints['W4'].price : wavePoints['W0'].price);
    if (w3R < w1R && w3R < w5R) {
      if (pivotLen < 7) return analyzeWaveDetails(candles, pivotLen + 1);
    }
  }

  // Regel 2: W2 retrace moet 23.6% - 99% van W1 zijn
  if (wavePoints['W1'] && wavePoints['W2']) {
    const w1R = wavePoints['W1'].price - wavePoints['W0'].price;
    const w2Retrace = (wavePoints['W1'].price - wavePoints['W2'].price) / w1R;
    if (w2Retrace < 0.236 || w2Retrace >= 1.0) {
      delete wavePoints['W2'];
      for (const k of ['W3','W4','W5','A','B','C']) delete wavePoints[k];
    }
  }

  // Regel 3: W4 non-overlap met W1 (strikt) EN retrace 14.6%-50% van W3
  if (wavePoints['W3'] && wavePoints['W4']) {
    const w3Base = wavePoints['W2'] ? wavePoints['W2'].price : wavePoints['W0'].price;
    const w3R = wavePoints['W3'].price - w3Base;
    const w4Retrace = (wavePoints['W3'].price - wavePoints['W4'].price) / w3R;
    if (wavePoints['W4'].price <= wavePoints['W1'].price) {
      delete wavePoints['W4'];
      for (const k of ['W5','A','B','C']) delete wavePoints[k];
    } else if (w4Retrace > 0.50 || w4Retrace < 0.146) {
      if (w4Retrace < 0.146) {
        delete wavePoints['W4'];
        for (const k of ['W5','A','B','C']) delete wavePoints[k];
      }
    }
  }

  // Regel 4: Alternatie-richtlijn (W2 en W4 moeten in diepte verschillen)
  if (wavePoints['W1'] && wavePoints['W2'] && wavePoints['W3'] && wavePoints['W4']) {
    const w1R = wavePoints['W1'].price - wavePoints['W0'].price;
    const w2Retrace = (wavePoints['W1'].price - wavePoints['W2'].price) / w1R;
    const w3Base = wavePoints['W2'] ? wavePoints['W2'].price : wavePoints['W0'].price;
    const w3R = wavePoints['W3'].price - w3Base;
    const w4Retrace = (wavePoints['W3'].price - wavePoints['W4'].price) / w3R;
    const alternates = (w2Retrace > 0.5 && w4Retrace < 0.382) || (w2Retrace < 0.5 && w4Retrace > 0.236);
    wavePoints._alternation = alternates;
  }

  // Regel 5: W5 range moet minstens 23.6% van W1 range zijn
  if (wavePoints['W4'] && wavePoints['W5'] && wavePoints['W1']) {
    const w1R = wavePoints['W1'].price - wavePoints['W0'].price;
    const w5R = wavePoints['W5'].price - wavePoints['W4'].price;
    if (w5R < w1R * 0.236) {
      delete wavePoints['W5'];
      for (const k of ['A','B','C']) delete wavePoints[k];
    }
  }

  // Stap 4: Bepaal huidige wave
  const detectedWaves = Object.keys(wavePoints);
  const allWaveNames = ['W0','W1','W2','W3','W4','W5','A','B','C'];
  let currentWave = 'W1';
  for (let i = 1; i < allWaveNames.length; i++) {
    if (!wavePoints[allWaveNames[i]]) { currentWave = allWaveNames[i]; break; }
    if (i === detectedWaves.length - 1 && i < allWaveNames.length - 1) { currentWave = allWaveNames[i + 1]; break; }
  }
  if (detectedWaves.length >= 9) currentWave = 'C';

  // Stap 4b: 8 Coherentie-checks
  const actualMaxHigh = Math.max(...highs);
  let coherenceFail = false;
  if (currentWave === 'W4' && wavePoints['W3'] && currentPrice > wavePoints['W3'].price) coherenceFail = true;
  if (currentWave === 'W2' && wavePoints['W1'] && currentPrice > wavePoints['W1'].price) coherenceFail = true;
  if (wavePoints['W3'] && actualMaxHigh > wavePoints['W3'].price * 2) coherenceFail = true;
  if (['A','B','C'].includes(currentWave) && wavePoints['W5'] && currentPrice > wavePoints['W5'].price) coherenceFail = true;
  if (wavePoints['W5'] && actualMaxHigh > wavePoints['W5'].price * 1.3) {
    const maxIdx = highs.indexOf(actualMaxHigh);
    if (maxIdx > wavePoints['W5'].barIdx) coherenceFail = true;
  }
  if (currentWave === 'W4' && wavePoints['W1'] && currentPrice < wavePoints['W1'].price) coherenceFail = true;
  if (currentWave === 'W4' && wavePoints['W3'] && currentPrice < wavePoints['W3'].price * 0.4) coherenceFail = true;
  if (wavePoints['W3'] && !wavePoints['W5'] && actualMaxHigh > wavePoints['W3'].price * 1.3) {
    const maxIdx = highs.indexOf(actualMaxHigh);
    if (maxIdx > wavePoints['W3'].barIdx) coherenceFail = true;
  }

  if (coherenceFail && pivotLen < 7) return analyzeWaveDetails(candles, pivotLen + 1);

  // Stap 4c: Fallback herinterpretatie bij max pivotLen
  if (coherenceFail && pivotLen >= 7) {
    const highestWave = wavePoints['W5'] || wavePoints['W3'] || wavePoints['W1'];
    if (highestWave && currentPrice < (wavePoints['W1'] ? wavePoints['W1'].price : Infinity)) {
      const highIdx = highestWave.barIdx;
      let lowestAfterPeak = { price: Infinity, barIdx: highIdx };
      for (let i = highIdx + 1; i < lows.length; i++) {
        if (lows[i] < lowestAfterPeak.price) lowestAfterPeak = { price: lows[i], barIdx: i };
      }
      const newWavePoints = {};
      newWavePoints['W0'] = wavePoints['W0'];
      newWavePoints['W1'] = { price: highestWave.price, barIdx: highestWave.barIdx };
      const barsAfterLow = totalBars - 1 - lowestAfterPeak.barIdx;
      if (barsAfterLow >= 2 && currentPrice > lowestAfterPeak.price * 1.05) {
        newWavePoints['W2'] = lowestAfterPeak;
        currentWave = 'W3';
      } else { currentWave = 'W2'; }
      for (const k of Object.keys(wavePoints)) delete wavePoints[k];
      for (const [k, v] of Object.entries(newWavePoints)) wavePoints[k] = v;
    }
  }

  // Stap 4d: MACRO cyclus herinterpretatie (KRITIEK — mag nooit verwijderd worden)
  const originalWavePoints = {};
  for (const [k, v] of Object.entries(wavePoints)) originalWavePoints[k] = { ...v };
  const originalCurrentWave = currentWave;

  if (wavePoints['W5'] && ['A','B','C'].includes(currentWave)) {
    const macroW0 = { price: wavePoints['W0'].price, barIdx: wavePoints['W0'].barIdx };
    const macroW1 = { price: wavePoints['W5'].price, barIdx: wavePoints['W5'].barIdx };
    const origW1Range = macroW1.price - macroW0.price;
    const w5Idx = macroW1.barIdx;
    let macroW2Low = { price: Infinity, barIdx: w5Idx };
    for (let i = w5Idx + 1; i < lows.length; i++) {
      if (lows[i] < macroW2Low.price) macroW2Low = { price: lows[i], barIdx: i };
    }

    const macroW2Price = macroW2Low.price < Infinity ? macroW2Low.price : macroW0.price;
    const actualHighAfterW5 = Math.max(...highs.slice(w5Idx));
    const maxMacroW3Move = actualHighAfterW5 - macroW2Price;
    const macroW3Ratio = origW1Range > 0 ? maxMacroW3Move / origW1Range : 0;
    const macroReinterpretationValid = macroW3Ratio <= 5.0;

    if (macroReinterpretationValid) {
      const macroPoints = {};
      macroPoints['W0'] = macroW0;
      macroPoints['W1'] = macroW1;
      if (macroW2Low.price < Infinity) {
        const barsAfterMacroLow = totalBars - 1 - macroW2Low.barIdx;
        if (barsAfterMacroLow >= 2 && currentPrice > macroW2Low.price * 1.05) {
          macroPoints['W2'] = macroW2Low;
          currentWave = 'W3';
        } else { currentWave = 'W2'; }
      }
      for (const k of Object.keys(wavePoints)) delete wavePoints[k];
      for (const [k, v] of Object.entries(macroPoints)) wavePoints[k] = v;
    }
  }

  // Stap 5: Wave durations
  const wKeys = Object.keys(wavePoints);
  for (let i = 1; i < wKeys.length; i++) {
    waveDurations[wKeys[i]] = wavePoints[wKeys[i]].barIdx - wavePoints[wKeys[i-1]].barIdx;
  }

  // Stap 6: Prijsreferenties (VOLLEDIG — identiek aan app)
  const w0P = wavePoints['W0'] ? wavePoints['W0'].price : null;
  const w1P = wavePoints['W1'] ? wavePoints['W1'].price : null;
  const w2P = wavePoints['W2'] ? wavePoints['W2'].price : null;
  const w3P = wavePoints['W3'] ? wavePoints['W3'].price : null;
  const w4P = wavePoints['W4'] ? wavePoints['W4'].price : null;
  const w5P = wavePoints['W5'] ? wavePoints['W5'].price : null;
  const aP  = wavePoints['A']  ? wavePoints['A'].price  : null;
  const bP  = wavePoints['B']  ? wavePoints['B'].price  : null;
  const cP  = wavePoints['C']  ? wavePoints['C'].price  : null;
  const w1Range = (w1P && w0P) ? (w1P - w0P) : null;
  const w1Duration = waveDurations['W1'] || null;
  const w3Base = w2P || w0P;
  const w3Range = w3P && w3Base ? (w3P - w3Base) : null;
  const totalImpulse = w5P && w0P ? (w5P - w0P) : (w3P && w0P ? (w3P - w0P) : null);
  const aTop = w5P || w3P;
  const aRange = aTop && aP ? (aTop - aP) : null;

  // Stap 7: Targets per wave (VOLLEDIGE Fibonacci projecties — identiek aan app)
  const waveInfo = {};

  // W1
  waveInfo['W1'] = { type: 'top', target: w1P || (w0P ? w0P * 1.5 : currentPrice * 1.3), method: w1P ? `Gedetecteerd op ${fmtP(w1P)} (werkelijke W1 top)` : 'Eerste impulsgolf na cyclus-bodem — nog niet afgerond' };

  // W2
  if (w1P && w0P && w1Range) {
    const w2_50  = w1P - (w1Range * 0.500);
    const w2_618 = w1P - (w1Range * 0.618);
    const w2_786 = w1P - (w1Range * 0.786);
    waveInfo['W2'] = { type: 'bottom', target: w2P || w2_618, targetDeep: w2P ? null : w2_786,
      method: w2P ? `Gedetecteerd op ${fmtP(w2P)} = ${((1 - (w2P - w0P) / w1Range) * 100).toFixed(1)}% retrace van W1` : `Retrace 50-78,6% van W1: ${fmtP(w2_50)} — ${fmtP(w2_786)}`,
      invalidation: w0P };
  } else {
    waveInfo['W2'] = { type: 'bottom', target: currentPrice * 0.9, method: 'Onvoldoende data voor berekening', invalidation: w0P };
  }

  // W3 — sterkste impuls (2.618x W1 vanaf W2, met escalatie)
  if (w1Range) {
    const base3 = w2P || w0P;
    const w3_1618 = base3 + w1Range * 1.618;
    const w3_2618 = base3 + w1Range * 2.618;
    const fibLevels = [1.618, 2.618, 4.236, 6.854, 11.09, 17.944];
    let w3target = w3P || w3_2618;
    let w3ext = w3P ? null : (base3 + w1Range * 6.854);
    if (!w3P) {
      for (let fi = 0; fi < fibLevels.length - 1; fi++) {
        const thisTarget = base3 + w1Range * fibLevels[fi];
        if (currentPrice > thisTarget * 1.05) {
          w3target = base3 + w1Range * fibLevels[fi + 1];
          w3ext = (fi + 2 < fibLevels.length) ? base3 + w1Range * fibLevels[fi + 2] : w3target * 1.618;
        } else { break; }
      }
    }
    waveInfo['W3'] = { type: 'top', target: w3target, targetExt: w3ext, subWave1Target: w3P || w3_1618,
      method: w3P ? `Gedetecteerd op ${fmtP(w3P)} = ${((w3P - base3) / w1Range).toFixed(3)}x W1 range vanaf W2` : `Fib ext vanaf W2 (${fmtP(base3)}): 1,618x = ${fmtP(w3_1618)} | 2,618x = ${fmtP(w3_2618)}`,
      duration: w1Duration ? Math.round(w1Duration * 1.618) : null };
  } else {
    waveInfo['W3'] = { type: 'top', target: currentPrice * 1.6, method: 'Onvoldoende data — W1 niet gedetecteerd' };
  }

  // W4 — correctie (23.6-50% retrace van W3, niet onder W1 top)
  if (w3Range && w3P) {
    const w4_236 = w3P - (w3Range * 0.236);
    const w4_382 = w3P - (w3Range * 0.382);
    const w4_500 = w3P - (w3Range * 0.500);
    const w4floor = w1P || w0P;
    waveInfo['W4'] = { type: 'bottom', target: w4P || Math.max(w4_382, w4floor), targetDeep: w4P ? null : Math.max(w4_500, w4floor),
      method: w4P ? `Gedetecteerd op ${fmtP(w4P)} = ${((w3P - w4P) / w3Range * 100).toFixed(1)}% retrace van W3` : `Retrace 23,6-50% van W3: ${fmtP(w4_236)} — ${fmtP(w4_500)} (niet onder W1 top ${fmtP(w4floor)})`,
      invalidation: w1P };
  } else {
    waveInfo['W4'] = { type: 'bottom', target: currentPrice * 0.88, method: 'Onvoldoende data — W3 niet gedetecteerd', invalidation: w1P };
  }

  // W5 — finale impuls (CONSISTENT met app: Fib ext vanuit W2 bij extended W3)
  if (w1Range) {
    const base5 = w4P || (w3P ? w3P - (w3Range || w1Range) * 0.382 : w0P);
    const w3extended = w3Range && w1Range ? (w3Range / w1Range) > 2 : false;
    let w5target, w5ext, w5method;
    if (w3extended && w3Range) {
      const fibBase = w2P || w0P || 0;
      w5target = fibBase + w3Range * 1.272;
      w5ext    = fibBase + w3Range * 1.618;
      w5method = `Fib ext 1,272-1,618x (W3 was extended) from W2 (${fmtP(fibBase)}): ${fmtP(w5target)} — ${fmtP(w5ext)}`;
    } else {
      w5target = base5 + w1Range * 0.618;
      w5ext    = base5 + w1Range * 1.000;
      w5method = `Fib ext 0,618-1,0x W1 from W4 (${fmtP(base5)}): ${fmtP(w5target)} — ${fmtP(w5ext)}`;
    }
    waveInfo['W5'] = { type: 'top', target: w5P || w5target, targetExt: w5P ? null : w5ext,
      method: w5P ? `Gedetecteerd op ${fmtP(w5P)} = ${((w5P - base5) / w1Range).toFixed(3)}x W1 range vanaf W4` : w5method,
      duration: w1Duration ? Math.round(w1Duration * 0.618) : null };
  } else {
    waveInfo['W5'] = { type: 'top', target: currentPrice * 1.3, method: 'Onvoldoende data — W1 niet gedetecteerd' };
  }

  // Wave A: Eerste correctiegolf (retrace 38.2-61.8% van W0→W5)
  if (totalImpulse && (w5P || w3P)) {
    const topRef = w5P || w3P;
    const a_382 = topRef - (totalImpulse * 0.382);
    const a_618 = topRef - (totalImpulse * 0.618);
    waveInfo['A'] = { type: 'bottom', target: aP || a_382, targetDeep: aP ? null : a_618,
      method: aP ? `Gedetecteerd op ${fmtP(aP)} = ${((topRef - aP) / totalImpulse * 100).toFixed(1)}% retrace van totale impuls` : `Retrace 38,2-61,8% van impuls (${fmtP(w0P)}→${fmtP(topRef)}): ${fmtP(a_382)} — ${fmtP(a_618)}` };
  } else {
    waveInfo['A'] = { type: 'bottom', target: currentPrice * 0.75, method: 'Onvoldoende impulsdata voor berekening' };
  }

  // Wave B: Correctieve bounce (retrace 50-78.6% van Wave A daling)
  if (aRange && aP) {
    const b_500 = aP + (aRange * 0.500);
    const b_618 = aP + (aRange * 0.618);
    const b_786 = aP + (aRange * 0.786);
    waveInfo['B'] = { type: 'top', target: bP || b_618, targetExt: bP ? null : b_786,
      method: bP ? `Gedetecteerd op ${fmtP(bP)} = ${((bP - aP) / aRange * 100).toFixed(1)}% bounce van Wave A daling` : `Bounce 50-78,6% van A-daling: ${fmtP(b_500)} — ${fmtP(b_786)} (bull trap)`,
      invalidation: w5P || aTop };
  } else {
    waveInfo['B'] = { type: 'top', target: currentPrice * 1.15, method: 'Onvoldoende data — Wave A niet gedetecteerd', invalidation: w5P };
  }

  // Wave C: Finale correctie (equal legs met A, of 1.618x A, vanaf B)
  if (aRange && (bP || aP)) {
    const cBase = bP || (aP + aRange * 0.618);
    const c_equal = cBase - aRange;
    const c_1618  = cBase - (aRange * 1.618);
    waveInfo['C'] = { type: 'bottom', target: cP || c_equal, targetDeep: cP ? null : c_1618,
      method: cP ? `Gedetecteerd op ${fmtP(cP)} = ${(Math.abs(cBase - cP) / aRange).toFixed(3)}x Wave A lengte` : `C = A vanaf B (${fmtP(cBase)}): equal legs = ${fmtP(c_equal)} | 1,618x = ${fmtP(c_1618)}` };
  } else {
    waveInfo['C'] = { type: 'bottom', target: currentPrice * 0.5, method: 'Onvoldoende data — Wave A/B niet gedetecteerd' };
  }

  // Stap 8: Timing berekening
  const durationValues = Object.values(waveDurations).filter(v => v > 0);
  const avgWaveDuration = durationValues.length > 0 ? durationValues.reduce((s, v) => s + v, 0) / durationValues.length : 6;
  const lastDetectedWave = wKeys[wKeys.length - 1];
  const currentWaveStartBar = wavePoints[lastDetectedWave] ? wavePoints[lastDetectedWave].barIdx : totalBars - 1;
  const barsInCurrentWave = totalBars - 1 - currentWaveStartBar;
  const timeMultipliers = { 'W1': 1, 'W2': 0.382, 'W3': 1.618, 'W4': 0.618, 'W5': 1.0, 'A': 0.618, 'B': 0.382, 'C': 0.618 };
  const baseDuration = w1Duration || avgWaveDuration;
  const expectedDuration = Math.max(2, Math.round(baseDuration * (timeMultipliers[currentWave] || 1)));
  const progressPct = expectedDuration > 0 ? Math.min(100, (barsInCurrentWave / expectedDuration) * 100) : 50;
  const barsRemaining = Math.max(0, expectedDuration - barsInCurrentWave);
  const now = new Date();
  const estCompletionDate = new Date(now.getTime() + barsRemaining * 30 * 24 * 60 * 60 * 1000);

  // Wave Completion Confidence
  const waveConfidence = {};
  const confNextMap = { 'W0':'W1', 'W1':'W2', 'W2':'W3', 'W3':'W4', 'W4':'W5', 'W5':'A', 'A':'B', 'B':'C' };
  const confTopWaves = new Set(['W1','W3','W5','B']);
  for (const wName of Object.keys(wavePoints).filter(k => !k.startsWith('_'))) {
    if (wName === 'W0') { waveConfidence[wName] = 'confirmed'; continue; }
    const nextW = confNextMap[wName];
    if (nextW && wavePoints[nextW]) { waveConfidence[wName] = 'confirmed'; }
    else {
      const wp = wavePoints[wName];
      if (!wp) continue;
      const isTop = confTopWaves.has(wName);
      if (isTop) {
        const retracePct = wp.price > 0 ? (wp.price - currentPrice) / wp.price : 0;
        if (retracePct > 0.20) waveConfidence[wName] = 'confirmed';
        else if (retracePct > 0.08) waveConfidence[wName] = 'likely';
        else waveConfidence[wName] = 'uncertain';
      } else {
        const risePct = wp.price > 0 ? (currentPrice - wp.price) / wp.price : 0;
        if (risePct > 0.20) waveConfidence[wName] = 'confirmed';
        else if (risePct > 0.08) waveConfidence[wName] = 'likely';
        else waveConfidence[wName] = 'uncertain';
      }
    }
  }
  waveConfidence[currentWave] = 'forming';

  // Sub-wave detectie wordt EXTERN gedaan met weekdata (niet intern met maanddata)
  // Dit zorgt voor consistentie met de app die ook weekcandles gebruikt
  let subWaves = null;

  return {
    currentWave, wavePoints, originalWavePoints, originalCurrentWave, waveDurations, waveInfo,
    waveConfidence, currentPrice, barsInCurrentWave, expectedDuration, progressPct, barsRemaining,
    estCompletionDate, w0Price: w0P, w1Price: w1P, w1Range, subWaves
  };
}

// ═══ Sub-Wave Analysis (identiek aan app) ═══
function analyzeSubWaves(candles, macroW2BarIdx, macroW3Target) {
  const subCandles = candles.slice(macroW2BarIdx);
  if (subCandles.length < 4) return null;

  const highs = subCandles.map(c => c.high);
  const lows = subCandles.map(c => c.low);
  const closes = subCandles.map(c => c.close);
  const currentPrice = closes[closes.length - 1];
  const totalBars = subCandles.length;

  const w2Bottom = Math.min(...lows.slice(0, Math.min(5, lows.length)));
  const w2BottomIdx = lows.indexOf(w2Bottom);

  // Use the LARGER of expected W3 range (Fibonacci) and actual W3 range so far
  const expectedW3Range = macroW3Target ? Math.abs(macroW3Target - w2Bottom) : null;
  const actualMaxHigh = Math.max(...highs);
  const actualW3Range = actualMaxHigh - w2Bottom;
  const effectiveRange = Math.max(expectedW3Range || 0, actualW3Range);
  const minSwingPct = 0.12;
  const minSwing = effectiveRange > 0 ? effectiveRange * minSwingPct : w2Bottom * 0.15;

  // Dynamic pivotLen based on data length
  const pivotLen = Math.max(3, Math.min(7, Math.floor(totalBars / 25)));

  function detectSwings(pLen) {
    const raw = [];
    for (let i = pLen; i < highs.length - pLen; i++) {
      const hSlice = highs.slice(i - pLen, i + pLen + 1);
      const lSlice = lows.slice(i - pLen, i + pLen + 1);
      if (highs[i] === Math.max(...hSlice)) raw.push({ type: 'H', val: highs[i], idx: i });
      if (lows[i] === Math.min(...lSlice)) raw.push({ type: 'L', val: lows[i], idx: i });
    }
    raw.sort((a, b) => a.idx - b.idx);
    const deduped = [];
    for (const s of raw) {
      if (deduped.length === 0 || deduped[deduped.length - 1].type !== s.type) deduped.push(s);
      else {
        const last = deduped[deduped.length - 1];
        if (s.type === 'H' && s.val > last.val) deduped[deduped.length - 1] = s;
        if (s.type === 'L' && s.val < last.val) deduped[deduped.length - 1] = s;
      }
    }
    return deduped;
  }

  function labelSubWaves(swingList) {
    const pts = {};
    pts['W2'] = { price: w2Bottom, barIdx: w2BottomIdx };
    const post = swingList.filter(s => s.idx > w2BottomIdx);
    const seq = [
      { name: 'i', type: 'H' }, { name: 'ii', type: 'L' }, { name: 'iii', type: 'H' },
      { name: 'iv', type: 'L' }, { name: 'v', type: 'H' }
    ];
    let pos = 0;
    for (let i = 0; i < post.length && pos < seq.length; i++) {
      const s = post[i];
      const exp = seq[pos];
      if (s.type !== exp.type) continue;
      const p = s.val;
      let prevRef = w2Bottom;
      if (pos > 0) {
        const prevName = seq[pos - 1].name;
        prevRef = pts[prevName] ? pts[prevName].price : w2Bottom;
      }
      const swingSize = Math.abs(p - prevRef);
      const isCorrective = ['ii', 'iv'].includes(exp.name);
      const swingThreshold = isCorrective ? minSwing * 0.35 : minSwing;
      if (swingSize < swingThreshold) continue;

      let valid = true;
      if (exp.name === 'i') {
        valid = p > w2Bottom && (p - w2Bottom) >= minSwing;
      } else if (exp.name === 'ii') {
        const iPrice = pts['i'] ? pts['i'].price : null;
        if (!iPrice) valid = false;
        else { const iRange = iPrice - w2Bottom; valid = p > w2Bottom && p < iPrice && (iPrice - p) >= iRange * 0.236; }
      } else if (exp.name === 'iii') {
        // Wave iii: must exceed wave i, iii range >= i range (iii is longest impulse)
        const iPrice = pts['i'] ? pts['i'].price : null;
        const iiP = pts['ii'] ? pts['ii'].price : w2Bottom;
        const iRange = iPrice ? (iPrice - w2Bottom) : 0;
        const iiiRange = p - iiP;
        valid = iPrice && p > iPrice && iiiRange >= minSwing && iiiRange >= iRange;
      } else if (exp.name === 'iv') {
        // Wave iv: non-overlap met i, retrace 23.6%-61.8% van iii
        const iPrice = pts['i'] ? pts['i'].price : null;
        const iiiPrice = pts['iii'] ? pts['iii'].price : null;
        const iiPrice = pts['ii'] ? pts['ii'].price : w2Bottom;
        if (!iPrice || !iiiPrice) valid = false;
        else { const iiiRange = iiiPrice - iiPrice; const ivRetrace = (iiiPrice - p) / iiiRange; valid = p > iPrice && p < iiiPrice && ivRetrace >= 0.146 && ivRetrace <= 0.786; }
      } else if (exp.name === 'v') {
        // Wave v: must exceed iv, v range >= 38.2% of i range (truncation limit)
        const iPrice = pts['i'] ? pts['i'].price : null;
        const iRange = iPrice ? (iPrice - w2Bottom) : 0;
        const vRange = p - pts['iv'].price;
        valid = pts['iv'] && p > pts['iv'].price && vRange >= iRange * 0.382;
      }
      if (valid) { pts[exp.name] = { price: p, barIdx: s.idx }; pos++; }
    }
    return pts;
  }

  // Try with base pivotLen, escalate if wave v > wave iii (guideline violation)
  let subWavePoints = null;
  for (let pLen = pivotLen; pLen <= Math.min(9, pivotLen + 4); pLen += 1) {
    const sw = detectSwings(pLen);
    const pts = labelSubWaves(sw);
    subWavePoints = pts;
    // STRIKTE EW VALIDATIE: iii moet langste impulsgolf zijn
    if (pts['iii'] && pts['ii'] && pts['i']) {
      const iRange = pts['i'].price - w2Bottom;
      const iiiRange = pts['iii'].price - pts['ii'].price;
      if (iiiRange < iRange * 0.9) continue;
      if (pts['v'] && pts['iv']) {
        const vRange = pts['v'].price - pts['iv'].price;
        if (vRange > iiiRange * 1.5) continue;
        if (iiiRange < iRange && iiiRange < vRange) continue;
      }
    }
    break;
  }

  // Bepaal huidige sub-wave
  const allSubNames = ['i', 'ii', 'iii', 'iv', 'v'];
  let currentSubWave = 'i';
  for (let i = 0; i < allSubNames.length; i++) {
    if (!subWavePoints[allSubNames[i]]) { currentSubWave = allSubNames[i]; break; }
    if (i === allSubNames.length - 1) currentSubWave = 'v';
  }

  const lastDetectedHigh = subWavePoints['v'] || subWavePoints['iii'] || subWavePoints['i'];
  if (lastDetectedHigh && currentPrice > lastDetectedHigh.price * 1.02) {
    const detectedKeys = Object.keys(subWavePoints).filter(k => k !== 'W2');
    if (detectedKeys.length > 0) {
      const lastKey = detectedKeys[detectedKeys.length - 1];
      const nextIdx = allSubNames.indexOf(lastKey);
      if (nextIdx >= 0 && nextIdx < allSubNames.length - 1) currentSubWave = allSubNames[nextIdx + 1];
    }
  }

  // Sub-wave targets
  const iPrice = subWavePoints['i'] ? subWavePoints['i'].price : null;
  const iiPrice = subWavePoints['ii'] ? subWavePoints['ii'].price : null;
  const iiiPrice = subWavePoints['iii'] ? subWavePoints['iii'].price : null;
  const ivPrice = subWavePoints['iv'] ? subWavePoints['iv'].price : null;
  const iRange = iPrice ? (iPrice - w2Bottom) : null;
  const subTargets = {};
  if (iRange && iiPrice) subTargets['iii'] = { target: iiPrice + iRange * 1.618, ext: iiPrice + iRange * 2.618 };
  if (iRange && iiiPrice && ivPrice) subTargets['v'] = { target: ivPrice + iRange * 1.0, ext: ivPrice + iRange * 1.618 };
  else if (iRange && iiiPrice) {
    const iiiRange = iiiPrice - (iiPrice || w2Bottom);
    const estIv = iiiPrice - iiiRange * 0.382;
    subTargets['v'] = { target: estIv + iRange * 1.0, ext: estIv + iRange * 1.618 };
  }

  // Fallback: schat op basis van prijspositie
  if (!subWavePoints['i'] && effectiveRange > 0) {
    const progress = (currentPrice - w2Bottom) / effectiveRange;
    if (progress >= 0.70) currentSubWave = 'v';
    else if (progress >= 0.60) currentSubWave = 'iv';
    else if (progress >= 0.30) currentSubWave = 'iii';
    else if (progress >= 0.20) currentSubWave = 'ii';
    else currentSubWave = 'i';
  }

  return { currentSubWave, subWavePoints, subTargets, currentPrice, w2Bottom, effectiveRange, actualW3Range, expectedW3Range, progress: effectiveRange ? (currentPrice - w2Bottom) / effectiveRange : 0 };
}

// ═══ ELLIOTT WAVE AUDIT AGENT — Runtime validatie (gesynchroniseerd met index.html) ═══
function ewAuditWaveCount(tokenName, waveDetails) {
  if (!waveDetails) return { valid: true, warnings: [], errors: [] };

  const warnings = [];
  const errors = [];
  const wp = waveDetails.wavePoints;
  const sw = waveDetails.subWaves;
  const cp = waveDetails.currentPrice;

  // ── A. HOOFDGOLVEN VALIDATIE ──

  // A1: W1 > W0
  if (wp['W0'] && wp['W1'] && wp['W1'].price <= wp['W0'].price) {
    errors.push(`[${tokenName}] W1 (${wp['W1'].price}) <= W0 (${wp['W0'].price}) — W1 moet boven W0 liggen`);
  }

  // A2: W2 retrace 23.6%-99%
  if (wp['W0'] && wp['W1'] && wp['W2']) {
    const w1R = wp['W1'].price - wp['W0'].price;
    const w2Retrace = w1R > 0 ? (wp['W1'].price - wp['W2'].price) / w1R : 0;
    if (w2Retrace < 0.236) {
      warnings.push(`[${tokenName}] W2 retrace ${(w2Retrace*100).toFixed(1)}% — te ondiep (min 23.6%)`);
    }
    if (w2Retrace >= 1.0) {
      errors.push(`[${tokenName}] W2 retrace ${(w2Retrace*100).toFixed(1)}% — W2 mag nooit 100%+ retracen`);
    }
  }

  // A3: W3 nooit de kortste
  if (wp['W0'] && wp['W1'] && wp['W2'] && wp['W3'] && wp['W4'] && wp['W5']) {
    const w1R = wp['W1'].price - wp['W0'].price;
    const w3R = wp['W3'].price - (wp['W2'] ? wp['W2'].price : wp['W0'].price);
    const w5R = wp['W5'].price - (wp['W4'] ? wp['W4'].price : wp['W0'].price);
    if (w3R < w1R && w3R < w5R) {
      errors.push(`[${tokenName}] W3 is KORTSTE impulsgolf (W1=${w1R.toFixed(2)}, W3=${w3R.toFixed(2)}, W5=${w5R.toFixed(2)}) — VERBODEN in EW`);
    }
  }

  // A4: W4 non-overlap
  if (wp['W1'] && wp['W4'] && wp['W4'].price <= wp['W1'].price) {
    errors.push(`[${tokenName}] W4 (${wp['W4'].price}) <= W1 (${wp['W1'].price}) — non-overlap regel geschonden`);
  }

  // A5: W4 retrace bereik
  if (wp['W2'] && wp['W3'] && wp['W4']) {
    const w3Base = wp['W2'] ? wp['W2'].price : (wp['W0'] ? wp['W0'].price : 0);
    const w3R = wp['W3'].price - w3Base;
    if (w3R > 0) {
      const w4Retrace = (wp['W3'].price - wp['W4'].price) / w3R;
      if (w4Retrace > 0.618) {
        warnings.push(`[${tokenName}] W4 retrace ${(w4Retrace*100).toFixed(1)}% van W3 — dieper dan 61.8% is ongewoon`);
      }
      if (w4Retrace < 0.146) {
        warnings.push(`[${tokenName}] W4 retrace ${(w4Retrace*100).toFixed(1)}% van W3 — te ondiep (min 14.6%)`);
      }
    }
  }

  // A6: Alternatie W2/W4
  if (wp['W0'] && wp['W1'] && wp['W2'] && wp['W3'] && wp['W4']) {
    const w1R = wp['W1'].price - wp['W0'].price;
    const w2Ret = w1R > 0 ? (wp['W1'].price - wp['W2'].price) / w1R : 0;
    const w3Base = wp['W2'] ? wp['W2'].price : wp['W0'].price;
    const w3R = wp['W3'].price - w3Base;
    const w4Ret = w3R > 0 ? (wp['W3'].price - wp['W4'].price) / w3R : 0;
    const bothDeep = w2Ret > 0.5 && w4Ret > 0.5;
    const bothShallow = w2Ret < 0.382 && w4Ret < 0.382;
    if (bothDeep || bothShallow) {
      warnings.push(`[${tokenName}] Alternatie geschonden: W2=${(w2Ret*100).toFixed(1)}%, W4=${(w4Ret*100).toFixed(1)}% — moeten verschillen in diepte`);
    }
  }

  // A7: Macro herinterpretatie coherentie
  if (waveDetails.originalWavePoints && waveDetails.originalWavePoints['W5'] && waveDetails.currentWave === 'W3') {
    const origW0 = waveDetails.originalWavePoints['W0'];
    const origW5 = waveDetails.originalWavePoints['W5'];
    if (origW0 && origW5 && wp['W0'] && wp['W1']) {
      const macroW1Range = wp['W1'].price - wp['W0'].price;
      const currentMoveFromW2 = wp['W2'] ? (cp - wp['W2'].price) : 0;
      if (macroW1Range > 0 && currentMoveFromW2 > macroW1Range * 6) {
        warnings.push(`[${tokenName}] Macro W3 (${currentMoveFromW2.toFixed(2)}) is ${(currentMoveFromW2/macroW1Range).toFixed(1)}x Macro W1 (${macroW1Range.toFixed(2)}) — mogelijk verkeerde macro herinterpretatie`);
      }
    }
  }

  // ── B. SUB-GOLVEN VALIDATIE ──
  if (sw && sw.subWavePoints) {
    const sp = sw.subWavePoints;
    const macroW2Price = wp['W2'] ? wp['W2'].price : null;

    // B1: Alle sub-wave punten boven macro W2
    if (macroW2Price) {
      for (const [name, point] of Object.entries(sp)) {
        if (name === 'W2') continue;
        if (point.price < macroW2Price) {
          errors.push(`[${tokenName}] Sub-wave ${name} (${point.price}) < macro W2 (${macroW2Price}) — VERBODEN`);
        }
      }
    }

    // B2: iii >= i (iii moet langste zijn)
    if (sp['i'] && sp['ii'] && sp['iii']) {
      const iR = sp['i'].price - (sw.w2Bottom || 0);
      const iiiR = sp['iii'].price - sp['ii'].price;
      if (iiiR < iR * 0.9) {
        warnings.push(`[${tokenName}] Sub-wave iii (${iiiR.toFixed(4)}) < wave i (${iR.toFixed(4)}) — iii moet langste impulsgolf zijn`);
      }
    }

    // B3: iv non-overlap met i
    if (sp['i'] && sp['iv'] && sp['iv'].price <= sp['i'].price) {
      errors.push(`[${tokenName}] Sub-wave iv (${sp['iv'].price}) <= wave i (${sp['i'].price}) — non-overlap geschonden`);
    }

    // B4: iv retrace bereik
    if (sp['ii'] && sp['iii'] && sp['iv']) {
      const iiiR = sp['iii'].price - sp['ii'].price;
      if (iiiR > 0) {
        const ivRet = (sp['iii'].price - sp['iv'].price) / iiiR;
        if (ivRet > 0.618) {
          warnings.push(`[${tokenName}] Sub-wave iv retrace ${(ivRet*100).toFixed(1)}% van iii — te diep (max 61.8%)`);
        }
      }
    }

    // B5: v vs iii proportie
    if (sp['ii'] && sp['iii'] && sp['iv'] && sp['v']) {
      const iiiR = sp['iii'].price - sp['ii'].price;
      const vR = sp['v'].price - sp['iv'].price;
      if (vR > iiiR * 1.5) {
        warnings.push(`[${tokenName}] Sub-wave v (${vR.toFixed(4)}) > 1.5x wave iii (${iiiR.toFixed(4)}) — v disproportioneel lang`);
      }
    }
  }

  // ── C. PRIJS-CONSISTENTIE ──
  if (waveDetails.currentWave === 'W3' && wp['W1'] && cp < wp['W1'].price * 0.5) {
    warnings.push(`[${tokenName}] In W3 maar prijs (${cp}) < 50% van W1 (${wp['W1'].price}) — ongewoon voor W3 impuls`);
  }
  if (waveDetails.currentWave === 'W4' && wp['W3'] && cp > wp['W3'].price) {
    errors.push(`[${tokenName}] In W4 maar prijs (${cp}) > W3 (${wp['W3'].price}) — W3 is nog niet compleet`);
  }

  const valid = errors.length === 0;
  return { valid, warnings, errors, token: tokenName, wave: waveDetails.currentWave };
}

// ═══ Fetch Binance Klines ═══
async function fetchBinanceKlines(symbol, interval, limit = 100) {
  // Probeer eerst binance.com, dan binance.us als fallback
  const urls = [
    `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
    `https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
  ];

  for (const url of urls) {
    try {
      const resp = await fetch(url);
      const text = await resp.text();
      let data;
      try { data = JSON.parse(text); } catch(e) { continue; }
      if (!Array.isArray(data)) continue; // Try next URL
      return data.map(k => ({
        time: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5])
      }));
    } catch(e) { continue; }
  }

  // Fallback: Yahoo Finance met crypto suffix
  const yahooSymbol = symbol.replace('USDT', '-USD');
  try {
    return await fetchYahooKlines(yahooSymbol, interval, limit);
  } catch(e) {
    throw new Error(`Geen data beschikbaar voor ${symbol}. Binance en Yahoo Finance zijn niet bereikbaar.`);
  }
}

// ═══ Fetch Yahoo Finance Klines (for stocks) ═══
const YF_INTERVAL_MAP = { '1M': '1mo', '1w': '1wk', '4h': '1d' };
const YF_RANGE_MAP = { '1mo': '20y', '1wk': '10y', '1d': '2y' };

async function fetchYahooKlines(symbol, interval, limit = 100) {
  const yInterval = YF_INTERVAL_MAP[interval] || interval;
  const range = YF_RANGE_MAP[yInterval] || '10y';
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${yInterval}&range=${range}`;

  const raw = execSync(`curl -s "${url}" -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"`, {
    timeout: 15000,
    encoding: 'utf8'
  });

  if (raw.startsWith('Too Many')) throw new Error('Rate limited by Yahoo Finance');

  const json = JSON.parse(raw);
  if (!json.chart || !json.chart.result || json.chart.result.length === 0) {
    throw new Error(`Yahoo Finance: geen data voor "${symbol}"`);
  }

  const result = json.chart.result[0];
  const timestamps = result.timestamp || [];
  const quote = result.indicators.quote[0];
  const klines = [];
  for (let i = 0; i < timestamps.length; i++) {
    const o = quote.open[i], h = quote.high[i], l = quote.low[i], c = quote.close[i];
    if (o != null && h != null && l != null && c != null) {
      klines.push({ time: timestamps[i] * 1000, open: o, high: h, low: l, close: c, volume: quote.volume[i] || 0 });
    }
  }
  return klines.slice(-limit);
}

// Known crypto suffixes — tickers ending with these go to Binance
const CRYPTO_SUFFIXES = ['USDT', 'USD', 'BTC', 'ETH', 'BNB', 'BUSD'];
const KNOWN_CRYPTO = ['BTC', 'ETH', 'XRP', 'HBAR', 'SOL', 'DOGE', 'ADA', 'DOT', 'LINK', 'AVAX', 'MATIC', 'UNI', 'SHIB', 'LTC', 'VET', 'XLM', 'ATOM', 'FIL', 'NEAR', 'APT', 'ARB', 'OP', 'SUI', 'SEI', 'INJ', 'TIA', 'PEPE', 'WIF', 'BONK', 'FLOKI', 'RENDER', 'FET', 'ONDO', 'JASMY', 'PAXG', 'ALGO', 'ICP', 'SAND', 'MANA', 'GRT', 'CRV', 'AAVE', 'MKR', 'SNX', 'COMP', 'ENS', 'LDO', 'RPL', 'SSV', 'EIGEN'];

function isCryptoTicker(ticker) {
  const upper = ticker.toUpperCase().trim();
  if (CRYPTO_SUFFIXES.some(s => upper.endsWith(s))) return true;
  if (KNOWN_CRYPTO.includes(upper)) return true;
  return false;
}

// ═══ Swing Signal Detection ═══
function generateSignals(candles) {
  if (candles.length < 30) return [];
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);
  const ema9 = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const rsi = calcRSI(closes, 14);
  const macdData = calcMACD(closes);
  const signals = [];

  for (let i = 2; i < candles.length; i++) {
    let bullScore = 0, bearScore = 0, bullInd = 0, bearInd = 0;
    // EMA crossover
    if (ema9[i] > ema21[i] && ema9[i - 1] <= ema21[i - 1]) { bullScore += 3; bullInd++; }
    if (ema9[i] < ema21[i] && ema9[i - 1] >= ema21[i - 1]) { bearScore += 3; bearInd++; }
    // MACD crossover
    if (macdData.macd[i] > macdData.signal[i] && macdData.macd[i - 1] <= macdData.signal[i - 1]) { bullScore += 2; bullInd++; }
    if (macdData.macd[i] < macdData.signal[i] && macdData.macd[i - 1] >= macdData.signal[i - 1]) { bearScore += 2; bearInd++; }
    // RSI
    if (rsi[i] <= 25) { bullScore += 4; bullInd++; } else if (rsi[i] <= 32) { bullScore += 3; bullInd++; } else if (rsi[i] <= 38) { bullScore += 2; bullInd++; }
    if (rsi[i] >= 85) { bearScore += 4; bearInd++; } else if (rsi[i] >= 78) { bearScore += 3; bearInd++; } else if (rsi[i] >= 70) { bearScore += 2; bearInd++; }

    const net = bullScore - bearScore;
    if (bullInd >= 2 && net >= 2) {
      const stars = Math.min(5, Math.ceil(net / 2));
      signals.push({ idx: i, type: 'BUY', stars, price: closes[i], time: candles[i].time });
    } else if (bearInd >= 2 && -net >= 2) {
      const stars = Math.min(5, Math.ceil(-net / 2));
      signals.push({ idx: i, type: 'SELL', stars, price: closes[i], time: candles[i].time });
    }
  }

  // Cooldown: 3 bars between same-direction signals
  const filtered = [];
  let lastBuy = -10, lastSell = -10;
  for (const s of signals) {
    if (s.type === 'BUY' && s.idx - lastBuy >= 3) { filtered.push(s); lastBuy = s.idx; }
    if (s.type === 'SELL' && s.idx - lastSell >= 3) { filtered.push(s); lastSell = s.idx; }
  }
  return filtered;
}

// ═══ Format price (kommanotatie) ═══
function fmtP(v) {
  if (!v || isNaN(v)) return '—';
  let str;
  if (v >= 1000) str = v.toLocaleString('nl-NL', { maximumFractionDigits: 0 });
  else if (v >= 1) str = v.toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  else if (v >= 0.01) str = v.toLocaleString('nl-NL', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  else str = v.toLocaleString('nl-NL', { minimumFractionDigits: 6, maximumFractionDigits: 6 });
  return '$' + str;
}
function pctFmt(v) { return (v >= 0 ? '+' : '') + v.toFixed(1).replace('.', ',') + '%'; }

// ═══ PDF Report Generator — Professional Camelot Finance Template ═══
const C = {
  headerDark: '#0d2240', headerMid: '#1a3a5c', headerLight: '#1e4d80',
  accent: '#f0b429', accentLight: '#fef9e7', accentDark: '#d68910',
  priceBar: '#1a3a5c', footer: '#0d2240',
  text: '#1a1a2e', textMid: '#4a5568', textLight: '#718096', white: '#ffffff',
  green: '#27ae60', greenLight: '#d5f5e3', greenDark: '#1e8449',
  red: '#e74c3c', redLight: '#fde8e8', redDark: '#c0392b',
  blue: '#1a6db5', bg: '#F7F7F7', gridLine: '#e2e8f0', cardBg: '#f1f5f9',
  separator: '#cbd5e1', subtleGold: '#f0b42920'
};

function sectionHeader(doc, num, title, y) {
  // Refined section header with accent bar and clean typography
  doc.save().lineWidth(0).rect(40, y, 515, 26).fill('#f8fafc').restore();
  doc.rect(40, y, 4, 26).fill(C.accent);
  doc.roundedRect(50, y + 3, 22, 20, 10).fill(C.headerDark);
  doc.fontSize(8).fillColor(C.accent).text(num, 52, y + 8, { width: 18, align: 'center' });
  doc.fontSize(11).fillColor(C.headerDark).text(title.toUpperCase(), 80, y + 7, {});
  doc.save().lineWidth(0.5).strokeColor(C.separator)
     .moveTo(40, y + 28).lineTo(555, y + 28).stroke().restore();
  return y + 34;
}

// ── Chart Drawing Helpers ──
function drawLineChart(doc, data, x, y, w, h, color, lineWidth = 1.2) {
  if (!data || data.length < 2) return;
  const min = Math.min(...data), max = Math.max(...data);
  const range = max - min || 1;
  const stepX = w / (data.length - 1);

  doc.save().lineWidth(lineWidth).strokeColor(color);
  doc.moveTo(x, y + h - ((data[0] - min) / range) * h);
  for (let i = 1; i < data.length; i++) {
    doc.lineTo(x + i * stepX, y + h - ((data[i] - min) / range) * h);
  }
  doc.stroke().restore();
}

function drawAreaChart(doc, data, x, y, w, h, color, opacity = 0.1) {
  if (!data || data.length < 2) return;
  const min = Math.min(...data), max = Math.max(...data);
  const range = max - min || 1;
  const stepX = w / (data.length - 1);

  doc.save().opacity(opacity).fillColor(color);
  doc.moveTo(x, y + h);
  for (let i = 0; i < data.length; i++) {
    doc.lineTo(x + i * stepX, y + h - ((data[i] - min) / range) * h);
  }
  doc.lineTo(x + w, y + h).closePath().fill().restore();
}

function drawCandlesticks(doc, candles, x, y, w, h) {
  if (!candles || candles.length < 2) return;
  const allH = candles.map(c => c.high), allL = candles.map(c => c.low);
  const min = Math.min(...allL), max = Math.max(...allH);
  const range = max - min || 1;
  const barW = Math.max(1.2, (w / candles.length) * 0.55);
  const gap = w / candles.length;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const bull = c.close >= c.open;
    const color = bull ? C.green : C.red;
    const bx = x + i * gap + (gap - barW) / 2;
    const openY = y + h - ((c.open - min) / range) * h;
    const closeY = y + h - ((c.close - min) / range) * h;
    const highY = y + h - ((c.high - min) / range) * h;
    const lowY = y + h - ((c.low - min) / range) * h;
    const bodyTop = Math.min(openY, closeY);
    const bodyH = Math.max(Math.abs(closeY - openY), 0.5);

    // Wick — slightly thicker for visibility
    doc.save().lineWidth(0.4).strokeColor(color);
    doc.moveTo(bx + barW / 2, highY).lineTo(bx + barW / 2, lowY).stroke();
    // Body with subtle shadow effect
    if (bull) {
      doc.rect(bx, bodyTop, barW, bodyH).fill(color);
    } else {
      doc.rect(bx, bodyTop, barW, bodyH).fill(color);
    }
    doc.restore();
  }
}

function drawBarChart(doc, data, x, y, w, h, posColor, negColor) {
  if (!data || data.length < 2) return;
  const max = Math.max(...data.map(Math.abs)) || 1;
  const barW = Math.max(0.8, (w / data.length) * 0.7);
  const gap = w / data.length;
  const midY = y + h / 2;

  for (let i = 0; i < data.length; i++) {
    const val = data[i];
    const barH = (Math.abs(val) / max) * (h / 2);
    const color = val >= 0 ? posColor : negColor;
    const bx = x + i * gap;
    const by = val >= 0 ? midY - barH : midY;
    doc.rect(bx, by, barW, barH).fill(color);
  }
}

function drawGridLines(doc, x, y, w, h, rows = 4) {
  doc.save().lineWidth(0.3).strokeColor(C.gridLine);
  for (let i = 0; i <= rows; i++) {
    const gy = y + (h / rows) * i;
    doc.moveTo(x, gy).lineTo(x + w, gy).stroke();
  }
  doc.restore();
}

function drawYLabels(doc, min, max, x, y, h, rows = 4) {
  for (let i = 0; i <= rows; i++) {
    const val = max - ((max - min) / rows) * i;
    const gy = y + (h / rows) * i;
    doc.fontSize(5).fillColor(C.textLight).text(fmtP(val), x, gy - 3, { width: 45, align: 'right' });
  }
}

function generatePDF(ticker, analysis, livePrice, options = {}) {
  const { includeAnalyse = true, includeFundamentals = false } = options;
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const PW = 595, PH = 842; // A4
    const M = 40;
    const CW = PW - M * 2; // content width
    const { monthly, fourH, weekly, ewData, signals, fundamentals } = analysis;
    const closes = monthly.map(c => c.close);
    const currentPrice = livePrice || closes[closes.length - 1];
    const cw = ewData.currentWave;
    const wi = ewData.waveInfo[cw];
    const sw = ewData.subWaves;
    const dateStr = new Date().toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' });
    const timeStr = new Date().toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });

    // ── Technische berekeningen ──
    const ema9 = calcEMA(closes, 9), ema21 = calcEMA(closes, 21), ema50 = calcEMA(closes, 50);
    const rsi = calcRSI(closes, 14);
    const macdData = calcMACD(closes);
    const fib = calcFib(monthly.map(c => c.high), monthly.map(c => c.low), currentPrice, 24);
    const lastRSI = rsi[rsi.length - 1];
    const lastMACD = macdData.hist[macdData.hist.length - 1];
    const emaTrend = ema9[ema9.length - 1] > ema21[ema21.length - 1] ? 'BULLISH' : 'BEARISH';

    // 4H indicators
    let trend4H = '—', rsi4H_val = 50, macd4H_val = 0;
    let closes4H = [], rsi4H = [], macd4H = { hist: [] }, ema9_4H = [], ema21_4H = [];
    if (fourH && fourH.length > 30) {
      closes4H = fourH.map(c => c.close);
      ema9_4H = calcEMA(closes4H, 9); ema21_4H = calcEMA(closes4H, 21);
      trend4H = ema9_4H[ema9_4H.length - 1] > ema21_4H[ema21_4H.length - 1] ? 'BULLISH' : 'BEARISH';
      rsi4H = calcRSI(closes4H, 14); rsi4H_val = rsi4H[rsi4H.length - 1];
      macd4H = calcMACD(closes4H); macd4H_val = macd4H.hist[macd4H.hist.length - 1];
    }

    // Fibonacci levels
    const highs = monthly.map(c => c.high), lows = monthly.map(c => c.low);
    const cycleLow = Math.min(...lows.slice(-24));
    const cycleHigh = Math.max(...highs.slice(-24));
    const range = cycleHigh - cycleLow;

    // Merlin score
    let totalScore = 0;
    const ewScores = { 'W1': 16, 'W2': 20, 'W3': 14, 'W4': 0, 'W5': -8, 'A': -16, 'B': -6, 'C': -12 };
    totalScore += ewScores[cw] || 0;
    totalScore += emaTrend === 'BULLISH' ? 18 : -18;
    if (lastRSI <= 30) totalScore += 12; else if (lastRSI <= 40) totalScore += 3; else if (lastRSI >= 75) totalScore -= 12; else if (lastRSI >= 65) totalScore -= 6;
    totalScore += lastMACD > 0 ? 12 : -12;
    const direction = totalScore > 15 ? 'BULLISH' : totalScore < -15 ? 'BEARISH' : 'NEUTRAAL';
    const dirColor = direction === 'BULLISH' ? C.green : direction === 'BEARISH' ? C.red : C.textLight;

    // Page tracking
    let pageNum = 0;

    // ── Helper: Professional Footer ──
    function drawFooter() {
      pageNum++;
      doc.rect(0, PH - 36, PW, 36).fill(C.footer);
      doc.rect(0, PH - 36, PW, 1.5).fill(C.accent);
      doc.fontSize(7).fillColor(C.accent).text('MERLIJN SIGNAAL LABO', M, PH - 26, {});
      doc.fontSize(5.5).fillColor('#5a7a90').text(`Gegenereerd: ${dateStr} ${timeStr}`, M, PH - 16);
      doc.fontSize(5).fillColor('#3a5a70').text('VERTROUWELIJK', PW / 2 - 30, PH - 26);
      doc.fontSize(7).fillColor(C.accent).text(ticker.toUpperCase() + '/USD', PW - M - 80, PH - 26, { width: 80, align: 'right' });
      doc.fontSize(6).fillColor('#5a7a90').text(`Pagina ${pageNum}`, PW - M - 80, PH - 16, { width: 80, align: 'right' });
      doc.save().lineWidth(0.3).strokeColor('#1a3a5c')
         .moveTo(M, PH - 34).lineTo(PW - M, PH - 34).stroke().restore();
    }

    // ── Helper: Draw watermark ──
    function drawWatermark() {
      doc.save().opacity(0.025).fontSize(60).fillColor(C.headerDark)
         .text('MERLIJN', PW / 2 - 100, PH / 2 - 30, { width: 200, align: 'center' })
         .restore();
    }

    // ── Helper: Page header (pages 2+) ──
    function drawPageHeader() {
      doc.rect(0, 0, PW, 28).fill(C.headerDark);
      doc.rect(0, 28, PW, 1.5).fill(C.accent);
      doc.fontSize(8).fillColor(C.accent).text('MERLIJN SIGNAAL LABO', M, 9, {});
      doc.fontSize(8).fillColor('#8ab4d4').text(`${ticker.toUpperCase()}/USD  |  ${dateStr}`, PW - M - 200, 9, { width: 200, align: 'right' });
    }

    // ════════════════════════════════════════════════════════
    // ██  PAGINA 1 — HEADER + PRICE BAR + INLEIDING + EW
    // ════════════════════════════════════════════════════════

    // ── PREMIUM HEADER (90px) ──
    doc.rect(0, 0, PW, 90).fill(C.headerDark);
    doc.save().opacity(0.06);
    doc.moveTo(PW * 0.3, 0).lineTo(PW, 0).lineTo(PW, 90).lineTo(PW * 0.5, 90).closePath().fill(C.headerLight);
    doc.restore();
    doc.save().opacity(0.08);
    doc.moveTo(PW * 0.65, 0).lineTo(PW * 0.68, 0).lineTo(PW * 0.58, 90).lineTo(PW * 0.55, 90).closePath().fill(C.accent);
    doc.restore();

    // Left: brand
    doc.fontSize(22).fillColor(C.white).text('MERLIJN', M, 14, { continued: true });
    doc.fontSize(22).fillColor(C.accent).text(' SIGNAAL LABO');
    doc.fontSize(9).fillColor('#7a9ab8').text('WEKELIJKS ANALYSE RAPPORT', M, 42, {});
    // Gold separator
    doc.rect(M, 56, 60, 2).fill(C.accent);
    doc.fontSize(8).fillColor('#8ab4d4').text(dateStr.toUpperCase(), M, 64, {});

    // Right: price + ticker + direction badge
    doc.fontSize(28).fillColor(C.white).text(fmtP(currentPrice), PW - M - 200, 10, { width: 200, align: 'right' });
    doc.fontSize(10).fillColor(C.accent).text(ticker.toUpperCase() + ' / USD', PW - M - 200, 42, { width: 200, align: 'right' });
    const badgeW = 90, badgeH = 22;
    const badgeX = PW - M - badgeW, badgeY = 58;
    doc.roundedRect(badgeX, badgeY, badgeW, badgeH, 4).fill(dirColor);
    doc.fontSize(9).fillColor(C.white).text(direction, badgeX, badgeY + 6, { width: badgeW, align: 'center' });

    // Gold bottom line
    doc.rect(0, 90, PW, 3).fill(C.accent);

    // ── PRICE BAR (6 columns, 40px) ──
    const pbY = 93;
    doc.rect(0, pbY, PW, 40).fill(C.priceBar);
    doc.save().opacity(0.1).rect(0, pbY, PW, 1).fill('#000').restore();
    doc.save().opacity(0.25).rect(0, pbY + 39, PW, 1).fill(C.accent).restore();

    const pbItems = [
      ['PRIJS', fmtP(currentPrice), C.white],
      ['WAVE', cw + (sw ? '.' + sw.currentSubWave : ''), C.accent],
      ['RSI (1M)', lastRSI.toFixed(1).replace('.', ','), lastRSI > 70 ? C.red : lastRSI < 30 ? C.green : C.white],
      ['EMA TREND', emaTrend, emaTrend === 'BULLISH' ? C.green : C.red],
      ['MACD', lastMACD > 0 ? 'POSITIEF' : 'NEGATIEF', lastMACD > 0 ? C.green : C.red],
      ['SCORE', (totalScore > 0 ? '+' : '') + totalScore, dirColor]
    ];
    const pbColW = (PW - M * 2) / pbItems.length;
    pbItems.forEach(([label, val, clr], i) => {
      const px = M + i * pbColW + 4;
      doc.fontSize(5).fillColor('#6a8aa4').text(label, px, pbY + 8, {});
      doc.fontSize(11).fillColor(clr).text(val, px, pbY + 20);
      if (i > 0) {
        doc.save().lineWidth(0.5).strokeColor('#1a3a5c')
           .moveTo(px - 8, pbY + 6).lineTo(px - 8, pbY + 34).stroke().restore();
        doc.save().opacity(0.12).lineWidth(0.5).strokeColor('#fff')
           .moveTo(px - 7, pbY + 6).lineTo(px - 7, pbY + 34).stroke().restore();
      }
    });

    let y = 142;
    let secNum = 0;
    function nextSec() { secNum++; return secNum.toString().padStart(2, '0'); }

    // Chart dimensions (used across pages)
    const chartX = M + 50, chartW = CW - 55;
    const miniH = 48, miniW = (CW - 14) / 2;

    if (includeAnalyse) {

    // ════════════════════════════════════════════════════════
    // ██  SECTIE 01 — INLEIDING
    // ════════════════════════════════════════════════════════
    y = sectionHeader(doc, nextSec(), 'Inleiding', y);

    // Auto-generated Dutch paragraphs
    const ema9Val = ema9[ema9.length - 1];
    const ema21Val = ema21[ema21.length - 1];
    const aboveEma9 = currentPrice > ema9Val;
    const aboveEma21 = currentPrice > ema21Val;
    const rsiStatus = lastRSI > 70 ? 'overbought' : lastRSI < 30 ? 'oversold' : lastRSI < 45 ? 'neutraal-laag' : lastRSI < 55 ? 'neutraal' : 'neutraal-hoog';

    const waveDescriptions = {
      'W1': 'de eerste impulsgolf, het begin van een nieuwe cyclus',
      'W2': 'een correctieve golf na de eerste impuls, een potentiele koopkans',
      'W3': 'de sterkste en langste impulsgolf met maximale groei',
      'W4': 'een consolidatiefase na de sterke W3 impuls',
      'W5': 'de finale impulsgolf, de top nadert',
      'A': 'correctieve fase A na de top', 'B': 'een bounce binnen de correctie', 'C': 'de finale correctiegolf'
    };

    const para1 = `${ticker.toUpperCase()} noteert momenteel op ${fmtP(currentPrice)}, wat ${aboveEma9 && aboveEma21 ? 'boven' : !aboveEma9 && !aboveEma21 ? 'onder' : 'tussen'} de EMA9 (${fmtP(ema9Val)}) en EMA21 (${fmtP(ema21Val)}) ligt. De RSI staat op ${lastRSI.toFixed(1).replace('.', ',')} (${rsiStatus}) en de MACD is ${lastMACD > 0 ? 'positief' : 'negatief'}.`;

    const waveDesc = waveDescriptions[cw] || 'een onbepaalde fase';
    const targetInfo = wi && wi.target ? `Het koersdoel voor deze wave is ${fmtP(wi.target)}${wi.targetExt ? ' met een extended target van ' + fmtP(wi.targetExt) : ''}` : 'Er zijn momenteel geen specifieke koersdoelen berekend';
    const invalidationInfo = wi && wi.invalidation ? `Het invalidatieniveau ligt op ${fmtP(wi.invalidation)}` : 'Er is geen duidelijk invalidatieniveau';
    const para2 = `Op de maandgrafiek bevindt ${ticker.toUpperCase()} zich in Elliott Wave ${cw} (${waveDesc}). ${targetInfo}. ${invalidationInfo}.`;

    // Inleiding card with left accent bar
    const inleidingText = para1 + '\n\n' + para2;
    const inlH = 72;
    doc.roundedRect(M, y, CW, inlH, 5).fill('#fafbfd');
    doc.save().lineWidth(0.5).strokeColor(C.gridLine).roundedRect(M, y, CW, inlH, 5).stroke().restore();
    doc.rect(M, y, 4, inlH).fill(C.accent);
    doc.fontSize(7).fillColor(C.text).text(inleidingText, M + 14, y + 8, { width: CW - 28, lineGap: 3 });
    y += inlH + 10;

    // ════════════════════════════════════════════════════════
    // ██  SECTIE 02 — ELLIOTT WAVE-ANALYSE
    // ════════════════════════════════════════════════════════
    y = sectionHeader(doc, nextSec(), 'Elliott Wave-Analyse', y);

    // ── A) Elliott Wave Journey — Visueel pad door de golven ──
    const allPhases = ['W0', 'W1', 'W2', 'W3', 'W4', 'W5', 'A', 'B', 'C'];
    const ewJourneyH = 110;
    doc.roundedRect(M, y, CW, ewJourneyH, 5).fill('#fafbfd');
    doc.save().lineWidth(0.5).strokeColor(C.gridLine).roundedRect(M, y, CW, ewJourneyH, 5).stroke().restore();

    // Header bar
    doc.rect(M, y, CW, 14).fill(C.headerDark);
    doc.fontSize(7).fillColor(C.accent).text('ELLIOTT WAVE JOURNEY — HUIDIGE POSITIE: ' + cw, M + 10, y + 3.5, {});
    doc.fontSize(6).fillColor('#8ab4d4').text(ewData.waveConfidence && ewData.waveConfidence[cw] ? ewData.waveConfidence[cw].toUpperCase() : '', M + CW - 80, y + 4, { width: 70, align: 'right' });

    const jY = y + 18; // journey area start
    const jH = ewJourneyH - 22; // journey area height
    const jPadX = 30; // horizontal padding
    const stepX = (CW - jPadX * 2) / (allPhases.length - 1);

    // Ideale EW vorm tekenen (W0 laag, W1 hoog, W2 laag, W3 hoger, W4 midden, W5 hoogst, A laag, B midden, C laagst)
    const idealY = { W0: 0.85, W1: 0.45, W2: 0.65, W3: 0.15, W4: 0.45, W5: 0.05, A: 0.55, B: 0.35, C: 0.75 };

    // Gebruik werkelijke prijzen waar gedetecteerd, anders ideaal pad
    const detectedPrices = {};
    allPhases.forEach(w => { if (ewData.wavePoints[w]) detectedPrices[w] = ewData.wavePoints[w].price; });
    const allPrices = Object.values(detectedPrices);
    const pMin = allPrices.length >= 2 ? Math.min(...allPrices) * 0.9 : 0;
    const pMax = allPrices.length >= 2 ? Math.max(...allPrices) * 1.1 : 1;
    const pRange = pMax - pMin || 1;

    // Bereken Y-posities
    const waveYPos = {};
    allPhases.forEach((w, i) => {
      if (detectedPrices[w] !== undefined) {
        waveYPos[w] = jY + jH - ((detectedPrices[w] - pMin) / pRange) * (jH - 10) - 5;
      } else {
        waveYPos[w] = jY + idealY[w] * (jH - 10) + 5;
      }
    });

    // Achtergrond area fill voor gedetecteerde golven
    const detectedPhases = allPhases.filter(w => detectedPrices[w] !== undefined);
    if (detectedPhases.length >= 2) {
      doc.save().opacity(0.06).fillColor(C.headerDark);
      const firstIdx = allPhases.indexOf(detectedPhases[0]);
      doc.moveTo(M + jPadX + firstIdx * stepX, jY + jH);
      detectedPhases.forEach(w => {
        const idx = allPhases.indexOf(w);
        doc.lineTo(M + jPadX + idx * stepX, waveYPos[w]);
      });
      const lastIdx = allPhases.indexOf(detectedPhases[detectedPhases.length - 1]);
      doc.lineTo(M + jPadX + lastIdx * stepX, jY + jH).closePath().fill().restore();
    }

    // Verbindingslijnen
    allPhases.forEach((w, i) => {
      if (i === 0) return;
      const prevW = allPhases[i - 1];
      const x1 = M + jPadX + (i - 1) * stepX;
      const y1 = waveYPos[prevW];
      const x2 = M + jPadX + i * stepX;
      const y2 = waveYPos[w];
      const bothDetected = detectedPrices[prevW] !== undefined && detectedPrices[w] !== undefined;
      const oneDetected = detectedPrices[prevW] !== undefined || detectedPrices[w] !== undefined;
      doc.save();
      if (bothDetected) {
        doc.lineWidth(2.5).strokeColor(C.headerDark);
      } else if (oneDetected) {
        doc.lineWidth(1.5).strokeColor(C.headerDark).dash(4, { space: 3 });
      } else {
        doc.lineWidth(0.8).strokeColor('#ccc').dash(3, { space: 4 });
      }
      doc.moveTo(x1, y1).lineTo(x2, y2).stroke().undash().restore();
    });

    // Wave nodes
    allPhases.forEach((w, i) => {
      const nx = M + jPadX + i * stepX;
      const ny = waveYPos[w];
      const detected = detectedPrices[w] !== undefined;
      const isCur = w === cw;
      const isImpulse = i <= 5; // W0-W5 = impuls, A-B-C = correctie

      if (isCur) {
        // Huidige wave: grote gouden node met glow
        doc.save().opacity(0.2).circle(nx, ny, 14).fill(C.accent).restore();
        doc.circle(nx, ny, 10).fill(C.accent);
        doc.fontSize(7).fillColor(C.headerDark).text(w, nx - 12, ny - 4, { width: 24, align: 'center' });
      } else if (detected) {
        // Gedetecteerde wave: volle donkere node
        doc.circle(nx, ny, 7).fill(C.headerDark);
        doc.fontSize(6).fillColor(C.white).text(w, nx - 8, ny - 3.5, { width: 16, align: 'center' });
      } else {
        // Toekomstige wave: lege cirkel
        doc.save().lineWidth(1).strokeColor('#ccc').circle(nx, ny, 6).stroke().restore();
        doc.fontSize(5.5).fillColor('#bbb').text(w, nx - 8, ny - 3, { width: 16, align: 'center' });
      }

      // Prijslabel
      if (detected) {
        const isBottom = ['W0','W2','W4','A','C'].includes(w);
        const labelY = isBottom ? ny + (isCur ? 12 : 9) : ny - (isCur ? 16 : 13);
        doc.fontSize(5.5).fillColor(isCur ? C.accent : C.textMid).text(fmtP(detectedPrices[w]), nx - 22, labelY, { width: 44, align: 'center' });
      }
    });

    // Target indicator (gestippelde lijn naar target)
    if (wi && wi.target) {
      const lastDetIdx = allPhases.indexOf(cw);
      if (lastDetIdx >= 0 && lastDetIdx < allPhases.length - 1) {
        const tgtX = M + jPadX + (lastDetIdx + 1) * stepX;
        const lastX = M + jPadX + lastDetIdx * stepX;
        const lastY = waveYPos[cw];
        const tgtYcalc = allPrices.length >= 2 ? jY + jH - ((Math.min(Math.max(wi.target, pMin), pMax) - pMin) / pRange) * (jH - 10) - 5 : jY + 10;
        doc.save().lineWidth(1.2).strokeColor(C.green).dash(4, { space: 3 })
           .moveTo(lastX, lastY).lineTo(tgtX, tgtYcalc).stroke().undash().restore();
        doc.circle(tgtX, tgtYcalc, 4).fill(C.green);
        doc.fontSize(5).fillColor(C.green).text('TGT ' + fmtP(wi.target), tgtX - 22, tgtYcalc - 12, { width: 44, align: 'center' });
      }
    }
    y += ewJourneyH + 8;

    // ── B) Wave Cards — 3 side-by-side ──
    const cardW3 = (CW - 16) / 3;
    const cardH3 = 80;
    const waveCardHeaderH = 16;

    // Card 1: Maandgrafiek
    const c1x = M;
    doc.roundedRect(c1x, y, cardW3, cardH3, 4).fill(C.white);
    doc.save().lineWidth(0.5).strokeColor(C.gridLine).roundedRect(c1x, y, cardW3, cardH3, 4).stroke().restore();
    doc.rect(c1x, y, 3, cardH3).fill(C.accent);
    doc.roundedRect(c1x, y, cardW3, waveCardHeaderH, 4).fill(C.headerDark);
    doc.rect(c1x, y + waveCardHeaderH - 4, cardW3, 4).fill(C.headerDark); // square off bottom corners
    doc.fontSize(7).fillColor(C.accent).text('MAANDGRAFIEK', c1x + 10, y + 4, {});
    let cy1 = y + waveCardHeaderH + 6;
    doc.fontSize(6.5).fillColor(C.textMid).text('Huidige Wave', c1x + 10, cy1);
    doc.fontSize(9).fillColor(C.headerDark).text(cw + (sw ? '.' + sw.currentSubWave : ''), c1x + 10, cy1 + 10);
    cy1 += 24;
    if (wi && wi.target) {
      doc.fontSize(6.5).fillColor(C.textMid).text('Target', c1x + 10, cy1);
      doc.fontSize(8).fillColor(C.green).text(fmtP(wi.target), c1x + 10, cy1 + 10);
      cy1 += 22;
    }
    if (wi && wi.invalidation) {
      doc.fontSize(6.5).fillColor(C.textMid).text('Invalidatie', c1x + 10, cy1);
      doc.fontSize(8).fillColor(C.red).text(fmtP(wi.invalidation), c1x + 10, cy1 + 10);
    }

    // Card 2: 4-Uur
    const c2x = M + cardW3 + 8;
    doc.roundedRect(c2x, y, cardW3, cardH3, 4).fill(C.white);
    doc.save().lineWidth(0.5).strokeColor(C.gridLine).roundedRect(c2x, y, cardW3, cardH3, 4).stroke().restore();
    doc.rect(c2x, y, 3, cardH3).fill(C.accent);
    doc.roundedRect(c2x, y, cardW3, waveCardHeaderH, 4).fill(C.headerDark);
    doc.rect(c2x, y + waveCardHeaderH - 4, cardW3, 4).fill(C.headerDark);
    doc.fontSize(7).fillColor(C.accent).text('4-UUR', c2x + 10, y + 4, {});
    let cy2 = y + waveCardHeaderH + 6;
    doc.fontSize(6.5).fillColor(C.textMid).text('4H Trend', c2x + 10, cy2);
    doc.fontSize(9).fillColor(trend4H === 'BULLISH' ? C.green : C.red).text(trend4H, c2x + 10, cy2 + 10);
    cy2 += 24;
    doc.fontSize(6.5).fillColor(C.textMid).text('RSI 4H', c2x + 10, cy2);
    doc.fontSize(8).fillColor(rsi4H_val > 70 ? C.red : rsi4H_val < 30 ? C.green : C.headerDark).text(rsi4H_val.toFixed(1).replace('.', ','), c2x + 10, cy2 + 10);
    cy2 += 22;
    doc.fontSize(6.5).fillColor(C.textMid).text('MACD 4H', c2x + 10, cy2);
    doc.fontSize(8).fillColor(macd4H_val > 0 ? C.green : C.red).text(macd4H_val > 0 ? 'Positief' : 'Negatief', c2x + 10, cy2 + 10);

    // Card 3: Sub-Wave
    const c3x = M + (cardW3 + 8) * 2;
    doc.roundedRect(c3x, y, cardW3, cardH3, 4).fill(C.white);
    doc.save().lineWidth(0.5).strokeColor(C.gridLine).roundedRect(c3x, y, cardW3, cardH3, 4).stroke().restore();
    doc.rect(c3x, y, 3, cardH3).fill(C.accent);
    doc.roundedRect(c3x, y, cardW3, waveCardHeaderH, 4).fill(C.headerDark);
    doc.rect(c3x, y + waveCardHeaderH - 4, cardW3, 4).fill(C.headerDark);
    doc.fontSize(7).fillColor(C.accent).text('SUB-WAVE', c3x + 10, y + 4, {});
    let cy3 = y + waveCardHeaderH + 6;
    doc.fontSize(6.5).fillColor(C.textMid).text('Huidige Sub-wave', c3x + 10, cy3);
    doc.fontSize(9).fillColor(C.headerDark).text(sw ? cw + '.' + sw.currentSubWave : 'n.v.t.', c3x + 10, cy3 + 10);
    cy3 += 24;
    doc.fontSize(6.5).fillColor(C.textMid).text('Voortgang', c3x + 10, cy3);
    const swProgress = sw && sw.progress ? (sw.progress * 100).toFixed(0) + '%' : '—';
    doc.fontSize(8).fillColor(C.accent).text(swProgress, c3x + 10, cy3 + 10);
    cy3 += 22;
    if (sw && sw.subTargets) {
      const subTgt = sw.subTargets[sw.currentSubWave];
      doc.fontSize(6.5).fillColor(C.textMid).text('Sub-wave Target', c3x + 10, cy3);
      doc.fontSize(8).fillColor(C.green).text(subTgt && subTgt.target ? fmtP(subTgt.target) : '—', c3x + 10, cy3 + 10);
    } else {
      doc.fontSize(6.5).fillColor(C.textMid).text('Sub-wave Target', c3x + 10, cy3);
      doc.fontSize(8).fillColor(C.textLight).text('—', c3x + 10, cy3 + 10);
    }
    y += cardH3 + 10;

    // ── C) Candlestick Chart — Maandgrafiek met EW annotaties ──
    const chartH = 140, chartY = y;
    doc.roundedRect(M, chartY - 4, CW, chartH + 24, 5).fill('#fafbfd');
    doc.save().lineWidth(0.5).strokeColor(C.gridLine)
       .roundedRect(M, chartY - 4, CW, chartH + 24, 5).stroke().restore();

    // Chart title
    doc.fontSize(7).fillColor(C.headerDark).text('ELLIOTT WAVE — MAANDGRAFIEK', chartX, chartY - 2, { width: chartW, align: 'center' });
    const chartYInner = chartY + 12;
    const chartHInner = chartH - 12;

    drawGridLines(doc, chartX, chartYInner, chartW, chartHInner, 5);
    const allH = monthly.map(c => c.high), allL = monthly.map(c => c.low);
    const chartMin = Math.min(...allL), chartMax = Math.max(...allH);
    drawYLabels(doc, chartMin, chartMax, M - 2, chartYInner, chartHInner, 5);

    const chartCandles = monthly.slice(-36);
    drawCandlesticks(doc, chartCandles, chartX, chartYInner, chartW, chartHInner);

    // EMA lines
    const e9slice = ema9.slice(-36), e21slice = ema21.slice(-36), e50slice = ema50.slice(-36);
    drawLineChart(doc, e9slice, chartX, chartYInner, chartW, chartHInner, '#3b82f6', 0.9);
    drawLineChart(doc, e21slice, chartX, chartYInner, chartW, chartHInner, '#f59e0b', 0.9);
    drawLineChart(doc, e50slice, chartX, chartYInner, chartW, chartHInner, '#8b5cf6', 0.7);

    // ── Elliott Wave labels op de grafiek ──
    // Teken wave-punten (W0-W5, A, B, C) op de candlestick chart
    const chartRange = chartMax - chartMin || 1;
    const totalMonthly = monthly.length;
    const sliceStart = totalMonthly - 36;
    const ewWaveNames = ['W0','W1','W2','W3','W4','W5','A','B','C'];
    const gap = chartW / Math.max(chartCandles.length, 1);
    ewWaveNames.forEach(wName => {
      const wp = ewData.wavePoints[wName];
      if (!wp) return;
      // Bereken positie op de grafiek (barIdx relatief aan slice)
      const relIdx = wp.barIdx - sliceStart;
      if (relIdx < 0 || relIdx >= chartCandles.length) return;
      const wpX = chartX + relIdx * gap + gap / 2;
      const isTop = ['W1','W3','W5','B'].includes(wName);
      const priceY = chartYInner + chartHInner - ((wp.price - chartMin) / chartRange) * chartHInner;

      // Lijn van wave punt naar label
      const labelOffset = isTop ? -14 : 10;
      doc.save().lineWidth(0.5).strokeColor(C.accent).dash(2, { space: 2 })
         .moveTo(wpX, priceY).lineTo(wpX, priceY + labelOffset).stroke().undash().restore();

      // Wave label badge
      const badgeY = priceY + labelOffset + (isTop ? -9 : 0);
      const isCurrent = wName === cw;
      doc.save();
      if (isCurrent) {
        doc.roundedRect(wpX - 10, badgeY, 20, 9, 3).fill(C.accent);
        doc.fontSize(5.5).fillColor(C.headerDark).text(wName, wpX - 10, badgeY + 1.5, { width: 20, align: 'center' });
      } else {
        doc.roundedRect(wpX - 8, badgeY, 16, 8, 2).fill(C.headerDark);
        doc.fontSize(5).fillColor(C.accent).text(wName, wpX - 8, badgeY + 1.5, { width: 16, align: 'center' });
      }
      doc.restore();

      // Dot op de candle
      doc.circle(wpX, priceY, isCurrent ? 3 : 2).fill(isCurrent ? C.accent : C.headerDark);
    });

    // Verbindingslijnen tussen wave punten (EW pad op de chart)
    const visibleWaves = ewWaveNames.filter(wn => {
      const wp = ewData.wavePoints[wn];
      return wp && (wp.barIdx - sliceStart) >= 0 && (wp.barIdx - sliceStart) < chartCandles.length;
    });
    if (visibleWaves.length >= 2) {
      doc.save().lineWidth(1.2).strokeColor(C.accent).opacity(0.5);
      for (let vi = 1; vi < visibleWaves.length; vi++) {
        const wp1 = ewData.wavePoints[visibleWaves[vi - 1]];
        const wp2 = ewData.wavePoints[visibleWaves[vi]];
        const x1 = chartX + (wp1.barIdx - sliceStart) * gap + gap / 2;
        const y1 = chartYInner + chartHInner - ((wp1.price - chartMin) / chartRange) * chartHInner;
        const x2 = chartX + (wp2.barIdx - sliceStart) * gap + gap / 2;
        const y2 = chartYInner + chartHInner - ((wp2.price - chartMin) / chartRange) * chartHInner;
        doc.moveTo(x1, y1).lineTo(x2, y2).stroke();
      }
      doc.restore();
    }

    // Target lijn (gestippeld)
    if (wi && wi.target && wi.target >= chartMin && wi.target <= chartMax * 1.2) {
      const tgtClamp = Math.max(chartMin, Math.min(chartMax, wi.target));
      const tgtY = chartYInner + chartHInner - ((tgtClamp - chartMin) / chartRange) * chartHInner;
      doc.save().lineWidth(0.6).strokeColor(C.green).dash(4, { space: 3 })
         .moveTo(chartX, tgtY).lineTo(chartX + chartW, tgtY).stroke().undash().restore();
      doc.roundedRect(chartX + chartW + 1, tgtY - 5, 44, 10, 2).fill(C.green);
      doc.fontSize(5).fillColor(C.white).text('TGT ' + fmtP(wi.target), chartX + chartW + 3, tgtY - 3, { width: 40, align: 'center' });
    }

    // Current price line
    const cpY = chartYInner + chartHInner - ((currentPrice - chartMin) / chartRange) * chartHInner;
    doc.save().lineWidth(0.6).strokeColor(C.accent).dash(4, { space: 3 })
       .moveTo(chartX, cpY).lineTo(chartX + chartW, cpY).stroke().undash().restore();
    doc.roundedRect(chartX + chartW + 1, cpY - 5, 44, 10, 2).fill(C.accent);
    doc.fontSize(5).fillColor(C.white).text(fmtP(currentPrice), chartX + chartW + 3, cpY - 3, { width: 40, align: 'center' });

    // Legend
    const legY = chartY + chartH + 14;
    const legItems = [['EMA 9', '#3b82f6'], ['EMA 21', '#f59e0b'], ['EMA 50', '#8b5cf6'], ['Prijs', C.accent], ['EW Pad', C.accent]];
    legItems.forEach(([l, c], i) => {
      const lx = chartX + i * 72;
      if (l === 'EW Pad') {
        doc.circle(lx + 3, legY + 2, 2.5).fill(C.headerDark);
        doc.save().lineWidth(1).strokeColor(C.accent).dash(2, { space: 2 }).moveTo(lx + 7, legY + 2).lineTo(lx + 14, legY + 2).stroke().undash().restore();
      } else {
        doc.save().lineWidth(2).strokeColor(c).moveTo(lx, legY + 2).lineTo(lx + 12, legY + 2).stroke().restore();
      }
      doc.fontSize(5.5).fillColor(C.textMid).text(l, lx + 15, legY - 1);
    });
    y = legY + 14;

    drawWatermark();
    drawFooter();
    } else {
      drawWatermark();
      drawFooter();
    }

    if (includeAnalyse) {
    // ════════════════════════════════════════════════════════
    // ██  PAGINA 2 — FIBONACCI + KOOP/VERKOOP + SCENARIO
    // ════════════════════════════════════════════════════════
    doc.addPage();
    drawPageHeader();
    y = 38;

    // ════════════════════════════════════════════════════════
    // ██  SECTIE 03 — FIBONACCI-DOELEN
    // ════════════════════════════════════════════════════════
    y = sectionHeader(doc, nextSec(), 'Fibonacci-Doelen', y);

    // Table header
    doc.roundedRect(M, y, CW, 14, 3).fill(C.headerDark);
    doc.fontSize(6).fillColor(C.accent);
    doc.text('TYPE', M + 8, y + 4, {});
    doc.text('NIVEAU', M + 75, y + 4, {});
    doc.text('PRIJS', M + 195, y + 4, {});
    doc.text('SIGNIFICANTIE', M + 310, y + 4, {});
    doc.text('TIJDFRAME', M + 440, y + 4, {});
    y += 14;

    const fibLevels = [
      { type: 'Support', niveau: 'Retracement 78,6%', price: cycleLow + range * 0.214, sig: 'Sterk', tf: 'Middellang' },
      { type: 'Support', niveau: 'Retracement 61,8%', price: cycleLow + range * 0.382, sig: 'Zeer sterk', tf: 'Middellang' },
      { type: 'Support', niveau: 'Retracement 50,0%', price: cycleLow + range * 0.5, sig: 'Gemiddeld', tf: 'Middellang' },
      { type: 'Support', niveau: 'Retracement 38,2%', price: cycleLow + range * 0.618, sig: 'Gemiddeld', tf: 'Middellang' },
      { type: 'Huidig', niveau: 'Huidige Prijs', price: currentPrice, sig: '—', tf: '—' },
      { type: 'Target', niveau: 'Extension 127,2%', price: cycleLow + range * 1.272, sig: 'Target 1', tf: 'Middellang' },
      { type: 'Target', niveau: 'Extension 161,8%', price: cycleLow + range * 1.618, sig: 'Target 2', tf: 'Lang' },
      { type: 'Target', niveau: 'Extension 261,8%', price: cycleLow + range * 2.618, sig: 'Moon Target', tf: 'Lang' }
    ];

    fibLevels.forEach((row, i) => {
      const isCurrent = row.type === 'Huidig';
      const rowBg = isCurrent ? C.accentLight : (i % 2 === 0 ? '#f8fafc' : C.white);
      doc.rect(M, y, CW, 14).fill(rowBg);
      if (isCurrent) doc.rect(M, y, 3, 14).fill(C.accent);

      // Type column
      const typeColor = row.type === 'Support' ? C.red : row.type === 'Target' ? C.green : C.accent;
      doc.roundedRect(M + 6, y + 2, 50, 10, 2).fill(typeColor);
      doc.fontSize(5.5).fillColor(C.white).text(row.type, M + 8, y + 3.5, { width: 46, align: 'center' });

      doc.fontSize(7).fillColor(isCurrent ? C.headerDark : C.text).text(row.niveau, M + 75, y + 3);
      doc.fontSize(7).fillColor(isCurrent ? C.accent : C.text).text(fmtP(row.price), M + 195, y + 3);

      // Significantie badge
      if (row.sig !== '—') {
        const sigBg = row.sig.includes('Zeer') ? '#dcfce7' : row.sig.includes('Sterk') ? '#dbeafe' : row.sig.includes('Moon') ? '#fef3c7' : row.sig.includes('Target') ? '#d1fae5' : '#f1f5f9';
        const sigClr = row.sig.includes('Zeer') ? C.greenDark : row.sig.includes('Sterk') ? C.blue : row.sig.includes('Moon') ? C.accentDark : row.sig.includes('Target') ? C.green : C.textMid;
        doc.roundedRect(M + 308, y + 2, 70, 10, 2).fill(sigBg);
        doc.fontSize(5.5).fillColor(sigClr).text(row.sig, M + 310, y + 3.5, { width: 66, align: 'center' });
      }

      // Tijdframe
      doc.fontSize(6.5).fillColor(C.textMid).text(row.tf, M + 440, y + 3);
      y += 14;
    });
    doc.save().lineWidth(0.5).strokeColor(C.gridLine).moveTo(M, y).lineTo(M + CW, y).stroke().restore();
    y += 16;

    // ════════════════════════════════════════════════════════
    // ██  SECTIE 04 — KOOP- & VERKOOPSIGNALEN ECA
    // ════════════════════════════════════════════════════════
    y = sectionHeader(doc, nextSec(), 'Koop- & Verkoopsignalen ECA', y);

    // ── A) Signal Cards — KOOP / VERKOOP side by side ──
    const ecaHalfW = (CW - 12) / 2;

    // KOOP card
    doc.roundedRect(M, y, ecaHalfW, 16, 3).fill(C.greenDark);
    doc.fontSize(7).fillColor(C.white).text('KOOPZONES', M + 8, y + 4, {});
    // VERKOOP card
    doc.roundedRect(M + ecaHalfW + 12, y, ecaHalfW, 16, 3).fill(C.redDark);
    doc.fontSize(7).fillColor(C.white).text('VERKOOPZONES', M + ecaHalfW + 20, y + 4, {});
    y += 16;

    const buyZ = [['38,2%', cycleLow + range * 0.618], ['50,0%', cycleLow + range * 0.5], ['61,8%', cycleLow + range * 0.382], ['78,6%', cycleLow + range * 0.214]];
    const sellZ = [['100%', cycleHigh], ['127,2%', cycleLow + range * 1.272], ['161,8%', cycleLow + range * 1.618], ['261,8%', cycleLow + range * 2.618]];

    for (let i = 0; i < 4; i++) {
      doc.rect(M, y, ecaHalfW, 13).fill(i % 2 === 0 ? C.greenLight : C.white);
      doc.rect(M, y, 2, 13).fill(C.green);
      doc.circle(M + 10, y + 6.5, 2).fill(C.green);
      doc.fontSize(7).fillColor(C.text).text(buyZ[i][0], M + 16, y + 3);
      doc.fontSize(7).fillColor(C.greenDark).text(fmtP(buyZ[i][1]), M + ecaHalfW - 75, y + 3, { width: 70, align: 'right' });
      doc.rect(M + ecaHalfW + 12, y, ecaHalfW, 13).fill(i % 2 === 0 ? C.redLight : C.white);
      doc.rect(M + ecaHalfW + 12, y, 2, 13).fill(C.red);
      doc.circle(M + ecaHalfW + 22, y + 6.5, 2).fill(C.red);
      doc.fontSize(7).fillColor(C.text).text(sellZ[i][0], M + ecaHalfW + 28, y + 3);
      doc.fontSize(7).fillColor(C.redDark).text(fmtP(sellZ[i][1]), M + CW - 75, y + 3, { width: 70, align: 'right' });
      y += 13;
    }
    y += 8;

    // ── B) Scenario Tabel ──
    doc.roundedRect(M, y, CW, 14, 3).fill(C.headerDark);
    doc.fontSize(6).fillColor(C.accent);
    doc.text('SCENARIO', M + 8, y + 4, {});
    doc.text('TRIGGER', M + 120, y + 4, {});
    doc.text('ACTIE', M + 310, y + 4, {});
    doc.text('DOELPRIJS', M + 430, y + 4, {});
    y += 14;

    // Auto-generated scenarios
    const w0Price = ewData.wavePoints['W0'] ? ewData.wavePoints['W0'].price : cycleLow;
    const bullTarget = wi && wi.target ? wi.target : cycleLow + range * 1.618;
    const baseTarget = wi && wi.target ? (currentPrice + wi.target) / 2 : cycleLow + range * 1.272;
    const bearLevel = ewData.wavePoints['W2'] ? ewData.wavePoints['W2'].price : (ewData.wavePoints['W1'] ? ewData.wavePoints['W1'].price : cycleLow + range * 0.382);

    const scenarios = [
      { scenario: 'Bull', trigger: `Doorbraak boven ${fmtP(wi && wi.target ? wi.target * 0.9 : cycleHigh)}`, actie: 'Accumuleren', doel: fmtP(bullTarget), color: C.green, bg: '#f0fdf4' },
      { scenario: 'Base', trigger: `Consolidatie rond ${fmtP(currentPrice)}`, actie: 'Houden / ECA', doel: fmtP(baseTarget), color: C.accent, bg: '#fefce8' },
      { scenario: 'Bear', trigger: `Daling onder ${fmtP(bearLevel)}`, actie: 'Afbouwen', doel: fmtP(w0Price), color: C.red, bg: '#fef2f2' }
    ];

    scenarios.forEach((s, i) => {
      doc.rect(M, y, CW, 15).fill(s.bg);
      doc.rect(M, y, 3, 15).fill(s.color);
      // Scenario badge
      doc.roundedRect(M + 6, y + 2, 55, 11, 2).fill(s.color);
      doc.fontSize(6).fillColor(C.white).text(s.scenario, M + 8, y + 4, { width: 51, align: 'center' });
      doc.fontSize(6.5).fillColor(C.text).text(s.trigger, M + 120, y + 4, { width: 185 });
      doc.fontSize(6.5).fillColor(C.headerDark).text(s.actie, M + 310, y + 4);
      doc.fontSize(7).fillColor(s.color).text(s.doel, M + 430, y + 4);
      y += 15;
    });
    doc.save().lineWidth(0.5).strokeColor(C.gridLine).moveTo(M, y).lineTo(M + CW, y).stroke().restore();
    y += 6;

    // ── C) Stop-loss badge ──
    doc.roundedRect(M, y, 200, 14, 3).fill('#fef2f2');
    doc.rect(M, y, 3, 14).fill(C.red);
    doc.fontSize(7).fillColor(C.red).text(`Stop-loss: onder ${fmtP(w0Price)}`, M + 10, y + 3);
    y += 22;

    // ════════════════════════════════════════════════════════
    // ██  SECTIE 05 — SAMENVATTING KEY SIGNALS
    // ════════════════════════════════════════════════════════
    y = sectionHeader(doc, nextSec(), 'Samenvatting Key Signals', y);

    // ── A) Key Signals Tabel ──
    doc.roundedRect(M, y, CW, 14, 3).fill(C.headerDark);
    doc.fontSize(6).fillColor(C.accent);
    doc.text('INDICATOR', M + 8, y + 4, {});
    doc.text('WAARDE', M + 180, y + 4, {});
    doc.text('SIGNAAL', M + 320, y + 4, {});
    doc.text('GEWICHT', M + 450, y + 4, {});
    y += 14;

    // EMA trend (4H) signal
    const ema4HSig = trend4H === 'BULLISH' ? 'Bullish' : trend4H === 'BEARISH' ? 'Bearish' : 'Neutraal';
    const rsi4HSig = rsi4H_val > 70 ? 'Bearish' : rsi4H_val < 30 ? 'Bullish' : 'Neutraal';

    const keySignals = [
      { ind: 'Elliott Wave', waarde: cw + (sw ? '.' + sw.currentSubWave : ''), signaal: ['W1','W2','W3'].includes(cw) ? 'Bullish' : ['W4','W5'].includes(cw) ? 'Neutraal' : 'Bearish', gewicht: '25%' },
      { ind: 'EMA Trend (M)', waarde: emaTrend, signaal: emaTrend === 'BULLISH' ? 'Bullish' : 'Bearish', gewicht: '20%' },
      { ind: 'RSI (M)', waarde: lastRSI.toFixed(1).replace('.', ','), signaal: lastRSI > 70 ? 'Bearish' : lastRSI < 30 ? 'Bullish' : 'Neutraal', gewicht: '15%' },
      { ind: 'MACD (M)', waarde: lastMACD > 0 ? 'Positief' : 'Negatief', signaal: lastMACD > 0 ? 'Bullish' : 'Bearish', gewicht: '15%' },
      { ind: 'EMA Trend (4H)', waarde: trend4H, signaal: ema4HSig, gewicht: '10%' },
      { ind: 'RSI (4H)', waarde: rsi4H_val.toFixed(1).replace('.', ','), signaal: rsi4HSig, gewicht: '5%' },
      { ind: 'Fibonacci', waarde: (fib * 100).toFixed(1).replace('.', ',') + '%', signaal: fib > 0.7 ? 'Bullish' : fib < 0.3 ? 'Bearish' : 'Neutraal', gewicht: '10%' }
    ];

    keySignals.forEach((row, i) => {
      const rowBg = i % 2 === 0 ? '#f8fafc' : C.white;
      doc.rect(M, y, CW, 14).fill(rowBg);
      const sigColor = row.signaal === 'Bullish' ? C.green : row.signaal === 'Bearish' ? C.red : C.textLight;
      doc.circle(M + 4, y + 7, 2).fill(sigColor);
      doc.fontSize(7).fillColor(C.text).text(row.ind, M + 12, y + 3);
      doc.fontSize(7).fillColor(C.headerDark).text(row.waarde, M + 180, y + 3);
      // Signal badge
      doc.roundedRect(M + 318, y + 2, 60, 10, 2).fill(sigColor);
      doc.fontSize(5.5).fillColor(C.white).text(row.signaal, M + 320, y + 3.5, { width: 56, align: 'center' });
      doc.fontSize(6.5).fillColor(C.textMid).text(row.gewicht, M + 450, y + 3);
      y += 14;
    });
    doc.save().lineWidth(0.5).strokeColor(C.gridLine).moveTo(M, y).lineTo(M + CW, y).stroke().restore();
    y += 12;

    // ── B) Merlijn Score Card ──
    const cardH = 85;
    doc.roundedRect(M, y, CW, cardH, 6).fill('#f8fafc');
    doc.save().lineWidth(0.8).strokeColor(C.gridLine).roundedRect(M, y, CW, cardH, 6).stroke().restore();
    doc.roundedRect(M, y, CW, 3, 3).fill(C.accent);

    // Score circle
    const circX = M + 55, circY = y + 46, circR = 30;
    doc.save().lineWidth(3).strokeColor(C.headerDark).circle(circX, circY, circR).stroke().restore();
    doc.save().lineWidth(3).strokeColor(dirColor).circle(circX, circY, circR - 4).stroke().restore();
    doc.circle(circX, circY, circR - 8).fill(C.headerDark);
    doc.fontSize(18).fillColor(C.white).text(`${totalScore > 0 ? '+' : ''}${totalScore}`, circX - 22, circY - 10, { width: 44, align: 'center' });
    doc.fontSize(5.5).fillColor(dirColor).text(direction, circX - 22, circY + 10, { width: 44, align: 'center' });

    // Direction + advice
    doc.fontSize(18).fillColor(dirColor).text(direction, M + 100, y + 14, {});
    const advice = totalScore >= 50 ? 'Sterk koopsignaal — accumuleren' : totalScore >= 30 ? 'Koopsignaal — positie opbouwen' : totalScore >= 15 ? 'Licht bullish — ECA overwegen' :
                   totalScore <= -50 ? 'Sterk verkoopsignaal — risico beperken' : totalScore <= -30 ? 'Verkoopsignaal — winst nemen' : totalScore <= -15 ? 'Voorzichtig — afbouwen overwegen' : 'Neutraal — afwachten';
    doc.fontSize(8).fillColor(C.textMid).text(advice, M + 100, y + 36);

    if (wi) {
      doc.fontSize(8).fillColor(C.headerDark).text(`Target: ${fmtP(wi.target)}`, M + 100, y + 52);
      if (wi.targetExt) doc.fontSize(7).fillColor(C.accent).text(`Extended: ${fmtP(wi.targetExt)}`, M + 260, y + 52);
    }
    doc.fontSize(6.5).fillColor(C.textLight).text(`Wave: ${cw}${sw ? '.' + sw.currentSubWave : ''} | RSI: ${lastRSI.toFixed(1).replace('.', ',')} | EMA: ${emaTrend}`, M + 100, y + 66);

    // Score breakdown bars
    const barX = M + 330, barY = y + 10;
    doc.fontSize(6).fillColor(C.textLight).text('SCORE BREAKDOWN', barX, barY - 2, {});
    const factors = [
      ['Elliott Wave', ewScores[cw] || 0, 20],
      ['EMA Trend', emaTrend === 'BULLISH' ? 18 : -18, 18],
      ['RSI', lastRSI <= 30 ? 12 : lastRSI <= 40 ? 3 : lastRSI >= 75 ? -12 : lastRSI >= 65 ? -6 : 0, 15],
      ['MACD', lastMACD > 0 ? 12 : -12, 12]
    ];
    factors.forEach(([label, score, maxS], i) => {
      const fy = barY + 12 + i * 16;
      doc.fontSize(6).fillColor(C.textMid).text(label, barX, fy);
      doc.roundedRect(barX + 55, fy + 1, 70, 8, 2).fill('#e2e8f0');
      const bW = Math.abs(score) / maxS * 70;
      doc.roundedRect(barX + 55, fy + 1, bW, 8, 2).fill(score > 0 ? C.green : C.red);
      doc.fontSize(5.5).fillColor(C.text).text((score > 0 ? '+' : '') + score, barX + 130, fy + 1);
    });

    y += cardH + 12;

    // ── DISCLAIMER ──
    doc.roundedRect(M, y, CW, 58, 5).fill('#fffbeb');
    doc.save().lineWidth(0.8).strokeColor(C.accent).roundedRect(M, y, CW, 58, 5).stroke().restore();
    doc.rect(M, y, 4, 58).fill(C.accent);
    doc.roundedRect(M + 12, y + 5, 18, 18, 3).fill(C.accent);
    doc.fontSize(12).fillColor(C.white).text('!', M + 14, y + 7, { width: 14, align: 'center' });
    doc.fontSize(7).fillColor(C.accentDark).text('DISCLAIMER', M + 38, y + 6, {});
    doc.fontSize(6).fillColor(C.textMid).text(
      'Dit rapport is gegenereerd door Merlijn Signaal Labo en vormt geen financieel advies. De informatie is uitsluitend bedoeld voor educatieve doeleinden. ' +
      'Het gebruik of opvolgen van rapporten en signalen in live trading is volledig op eigen risico en niet de intentie van Camelot Beleggersclub. ' +
      'Om de eigen kennis te toetsen kan je dit oefenen in paper trading. Doe altijd eigen onderzoek (DYOR).',
      M + 38, y + 17, { width: CW - 54, lineGap: 2.5 }
    );

    y += 64;
    doc.fontSize(5).fillColor(C.textLight).text('© 2026 Camelot Beleggersclub — Alle rechten voorbehouden. Dit rapport mag niet openbaar gedeeld of verspreid worden.', M, y, { width: CW, align: 'center' });

    drawWatermark();
    drawFooter();
    } // einde includeAnalyse blok (pagina 1+2)

    // ════════════════════════════════════════════════════════
    // ██  FUNDAMENTALS PAGINA
    // ════════════════════════════════════════════════════════
    if (includeFundamentals) {
      doc.addPage();
      drawPageHeader();
      y = 38;

      y = sectionHeader(doc, nextSec(), `Fundamentele Analyse — ${ticker.toUpperCase()}`, y);

      if (fundamentals) {
        // ── Helper functions for fundamentals ──
        const fmtBig = (v) => {
          if (v == null) return '—';
          if (v >= 1e12) return '$' + (v / 1e12).toFixed(2) + 'T';
          if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
          if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
          return '$' + v.toLocaleString('en-US');
        };
        const fmtSupply = (v) => {
          if (v == null) return '—';
          if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
          if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
          return v.toLocaleString('en-US');
        };
        const fmtPct = (v) => v != null ? (v * 100).toFixed(2) + '%' : '—';

        // Helper: draw a risk badge
        const drawRiskBadge = (label, level, bx, by, bw) => {
          const riskColor = level === 'Hoog' ? C.red : level === 'Gemiddeld' ? '#f59e0b' : C.green;
          doc.roundedRect(bx, by, bw, 18, 3).fill('#f8fafc');
          doc.save().lineWidth(0.3).strokeColor(C.gridLine).roundedRect(bx, by, bw, 18, 3).stroke().restore();
          doc.rect(bx, by, 3, 18).fill(riskColor);
          doc.fontSize(6.5).fillColor(C.text).text(label, bx + 8, by + 4);
          doc.roundedRect(bx + bw - 58, by + 3, 50, 12, 3).fill(riskColor);
          doc.fontSize(6).fillColor(C.white).text(level, bx + bw - 56, by + 5, { width: 46, align: 'center' });
        };

        // Helper: draw a score bar
        const drawScoreBar = (label, score, bx, by, bw) => {
          doc.fontSize(6.5).fillColor(C.text).text(label, bx, by + 2);
          doc.roundedRect(bx + 110, by + 1, bw, 10, 3).fill('#e2e8f0');
          const fillW = Math.max(0, Math.min(bw, bw * score / 10));
          const scoreColor = score >= 7 ? C.green : score >= 4 ? '#f59e0b' : C.red;
          doc.roundedRect(bx + 110, by + 1, fillW, 10, 3).fill(scoreColor);
          doc.fontSize(6).fillColor(C.headerDark).text(`${score.toFixed(1)}/10`, bx + 115 + bw, by + 2);
        };

        if (fundamentals.type === 'crypto') {
          // ════════════════════════════════════════
          // ██  CRYPTO FUNDAMENTALS
          // ════════════════════════════════════════

          // ── SECTIE: Project Overzicht ──
          y = sectionHeader(doc, nextSec(), 'Project Overzicht', y);

          doc.roundedRect(M, y, CW, 54, 5).fill('#f8fafc');
          doc.save().lineWidth(0.5).strokeColor(C.gridLine).roundedRect(M, y, CW, 54, 5).stroke().restore();
          doc.rect(M, y, 4, 54).fill(C.accent);

          doc.fontSize(14).fillColor(C.headerDark).text(fundamentals.name || ticker.toUpperCase(), M + 14, y + 6);
          doc.fontSize(8).fillColor(C.accent).text(fundamentals.symbol || ticker.toUpperCase(), M + 14, y + 24, {});
          if (fundamentals.categories && fundamentals.categories.length > 0) {
            doc.fontSize(6).fillColor(C.textMid).text(fundamentals.categories.slice(0, 4).join(' | '), M + 14, y + 36);
          }
          if (fundamentals.homepage) {
            doc.fontSize(5.5).fillColor(C.blue).text(fundamentals.homepage, M + 14, y + 45);
          }

          // Price stats on right
          doc.fontSize(20).fillColor(C.headerDark).text(fmtP(currentPrice), PW - M - 160, y + 6, { width: 150, align: 'right' });
          if (fundamentals.priceChange24h != null) {
            const ch = fundamentals.priceChange24h;
            doc.fontSize(8).fillColor(ch >= 0 ? C.green : C.red).text(`24h: ${pctFmt(ch)}`, PW - M - 160, y + 30, { width: 150, align: 'right' });
          }
          y += 60;

          // Description (up to 400 chars)
          if (fundamentals.description && fundamentals.description.length > 10) {
            const descH = 44;
            doc.roundedRect(M, y, CW, descH, 4).fill('#fafbfd');
            doc.save().lineWidth(0.3).strokeColor(C.gridLine).roundedRect(M, y, CW, descH, 4).stroke().restore();
            const desc = fundamentals.description.length > 400 ? fundamentals.description.substring(0, 397) + '...' : fundamentals.description;
            doc.fontSize(6.5).fillColor(C.textMid).text(desc, M + 8, y + 6, { width: CW - 16, lineGap: 2 });
            y += descH + 6;
          }

          // ── Team & Project Links ──
          if (y > 700) { doc.addPage(); drawPageHeader(); y = 38; }
          y = sectionHeader(doc, nextSec(), 'Team & Project', y);

          // Links card
          const linksCardH = 50;
          doc.roundedRect(M, y, CW, linksCardH, 4).fill('#f8fafc');
          doc.save().lineWidth(0.5).strokeColor(C.gridLine).roundedRect(M, y, CW, linksCardH, 4).stroke().restore();
          doc.rect(M, y, 3, linksCardH).fill(C.accent);

          let linkY = y + 6;
          if (fundamentals.homepage) {
            doc.fontSize(6).fillColor(C.textMid).text('Website:', M + 10, linkY);
            doc.fontSize(6).fillColor(C.blue).text(fundamentals.homepage, M + 55, linkY);
            linkY += 10;
          }
          if (fundamentals.twitter) {
            doc.fontSize(6).fillColor(C.textMid).text('Twitter/X:', M + 10, linkY);
            doc.fontSize(6).fillColor(C.blue).text('@' + fundamentals.twitter, M + 55, linkY);
            linkY += 10;
          }
          if (fundamentals.telegram) {
            doc.fontSize(6).fillColor(C.textMid).text('Telegram:', M + 10, linkY);
            doc.fontSize(6).fillColor(C.blue).text(fundamentals.telegram, M + 55, linkY);
            linkY += 10;
          }
          if (fundamentals.subreddit) {
            doc.fontSize(6).fillColor(C.textMid).text('Reddit:', M + 10, linkY);
            doc.fontSize(6).fillColor(C.blue).text(fundamentals.subreddit.replace('https://www.reddit.com', ''), M + 55, linkY);
            linkY += 10;
          }

          // Right side: GitHub repos
          const repoX = M + CW / 2;
          let repoY = y + 6;
          if (fundamentals.repos && fundamentals.repos.length > 0) {
            doc.fontSize(6).fillColor(C.textMid).text('GitHub:', repoX, repoY);
            repoY += 10;
            fundamentals.repos.slice(0, 3).forEach(repo => {
              const shortRepo = repo.replace('https://github.com/', '');
              doc.fontSize(5.5).fillColor(C.blue).text(shortRepo, repoX + 10, repoY);
              repoY += 9;
            });
          }

          // Blockchain explorers
          if (fundamentals.blockchain_site && fundamentals.blockchain_site.length > 0) {
            const bsY = Math.max(linkY, repoY) > y + linksCardH - 4 ? y + linksCardH - 12 : y + linksCardH - 12;
            doc.fontSize(5).fillColor(C.textLight).text('Explorers: ' + fundamentals.blockchain_site.map(s => {
              try { return new URL(s).hostname; } catch(e) { return s; }
            }).join(' | '), M + 10, bsY, { width: CW - 20 });
          }

          y += linksCardH + 8;

          // ── SECTIE: Tokenomics ──
          if (y > 700) { doc.addPage(); drawPageHeader(); y = 38; }
          y = sectionHeader(doc, nextSec(), 'Tokenomics', y);

          // 3-column supply layout
          const colW3 = (CW - 16) / 3;
          const supplyItems = [
            { label: 'Totaal Aanbod', value: fmtSupply(fundamentals.totalSupply) },
            { label: 'Max Aanbod', value: fundamentals.maxSupply ? fmtSupply(fundamentals.maxSupply) : 'Onbeperkt' },
            { label: 'Circulerend Aanbod', value: fmtSupply(fundamentals.circulatingSupply) }
          ];
          supplyItems.forEach((item, i) => {
            const cx = M + i * (colW3 + 8);
            doc.roundedRect(cx, y, colW3, 32, 4).fill('#f8fafc');
            doc.save().lineWidth(0.3).strokeColor(C.gridLine).roundedRect(cx, y, colW3, 32, 4).stroke().restore();
            doc.rect(cx, y, 3, 32).fill(C.accent);
            doc.fontSize(6).fillColor(C.textMid).text(item.label, cx + 8, y + 5);
            doc.fontSize(10).fillColor(C.headerDark).text(item.value, cx + 8, y + 16);
          });
          y += 38;

          // FDV vs Market Cap side by side
          const halfW = (CW - 8) / 2;
          doc.roundedRect(M, y, halfW, 32, 4).fill('#f8fafc');
          doc.save().lineWidth(0.3).strokeColor(C.gridLine).roundedRect(M, y, halfW, 32, 4).stroke().restore();
          doc.rect(M, y, 3, 32).fill(C.headerDark);
          doc.fontSize(6).fillColor(C.textMid).text('Marktkapitalisatie', M + 8, y + 5);
          doc.fontSize(10).fillColor(C.headerDark).text(fmtBig(fundamentals.marketCap), M + 8, y + 16);

          doc.roundedRect(M + halfW + 8, y, halfW, 32, 4).fill('#f8fafc');
          doc.save().lineWidth(0.3).strokeColor(C.gridLine).roundedRect(M + halfW + 8, y, halfW, 32, 4).stroke().restore();
          doc.rect(M + halfW + 8, y, 3, 32).fill(C.accent);
          doc.fontSize(6).fillColor(C.textMid).text('Fully Diluted Valuation', M + halfW + 16, y + 5);
          doc.fontSize(10).fillColor(C.headerDark).text(fmtBig(fundamentals.fullyDilutedValuation), M + halfW + 16, y + 16);
          y += 38;

          // Supply distribution progress bar
          if (fundamentals.circulatingSupply && fundamentals.totalSupply) {
            const circPct = (fundamentals.circulatingSupply / fundamentals.totalSupply * 100);
            const barW = CW - 20;

            doc.roundedRect(M, y, CW, 30, 4).fill('#f8fafc');
            doc.save().lineWidth(0.3).strokeColor(C.gridLine).roundedRect(M, y, CW, 30, 4).stroke().restore();

            doc.roundedRect(M + 10, y + 6, barW, 14, 4).fill('#e2e8f0');
            doc.roundedRect(M + 10, y + 6, barW * circPct / 100, 14, 4).fill(C.accent);
            doc.fontSize(6).fillColor(C.white).text(`${circPct.toFixed(1)}% in circulatie`, M + 14, y + 9);

            // Inflation badge
            const isInflationary = !fundamentals.maxSupply;
            const inflBadgeColor = isInflationary ? C.red : C.green;
            const inflLabel = isInflationary ? 'Inflatoir' : 'Deflatoir/Gelimiteerd';
            doc.roundedRect(M + 10, y + 23, 80, 11, 3).fill(inflBadgeColor);
            doc.fontSize(5.5).fillColor(C.white).text(inflLabel, M + 12, y + 25, { width: 76, align: 'center' });

            // Circulating % badge
            doc.roundedRect(M + 96, y + 23, 65, 11, 3).fill(C.headerDark);
            doc.fontSize(5.5).fillColor(C.accent).text(`Circulerend: ${circPct.toFixed(1)}%`, M + 98, y + 25, { width: 61, align: 'center' });

            y += 38;
          }

          // ── SECTIE: Markt & Liquiditeit ──
          if (y > 700) { doc.addPage(); drawPageHeader(); y = 38; }
          y = sectionHeader(doc, nextSec(), 'Markt & Liquiditeit', y);

          // 3-column top bar: Market Cap, Rank, Volume
          const topBarItems = [
            { label: 'Marktkapitalisatie', value: fmtBig(fundamentals.marketCap) },
            { label: 'Rank', value: fundamentals.marketCapRank ? '#' + fundamentals.marketCapRank : '—' },
            { label: '24h Volume', value: fmtBig(fundamentals.volume24h) }
          ];
          topBarItems.forEach((item, i) => {
            const cx = M + i * (colW3 + 8);
            doc.roundedRect(cx, y, colW3, 28, 4).fill('#f8fafc');
            doc.save().lineWidth(0.3).strokeColor(C.gridLine).roundedRect(cx, y, colW3, 28, 4).stroke().restore();
            doc.rect(cx, y, 3, 28).fill(C.accent);
            doc.fontSize(5.5).fillColor(C.textMid).text(item.label, cx + 8, y + 4);
            doc.fontSize(9).fillColor(C.headerDark).text(item.value, cx + 8, y + 14);
          });
          y += 34;

          // Volume/MCap ratio
          const volMcapRatio = (fundamentals.volume24h && fundamentals.marketCap) ? (fundamentals.volume24h / fundamentals.marketCap * 100) : null;
          if (volMcapRatio != null) {
            doc.roundedRect(M, y, CW, 18, 3).fill('#f8fafc');
            doc.save().lineWidth(0.3).strokeColor(C.gridLine).roundedRect(M, y, CW, 18, 3).stroke().restore();
            doc.rect(M, y, 3, 18).fill(C.accent);
            doc.fontSize(6.5).fillColor(C.text).text('Volume/Marktkapitalisatie Ratio:', M + 8, y + 5);
            doc.fontSize(7).fillColor(C.headerDark).text(volMcapRatio.toFixed(2) + '%', M + 160, y + 5);
            const ratioNote = volMcapRatio > 10 ? 'Hoge liquiditeit' : volMcapRatio > 3 ? 'Gemiddelde liquiditeit' : 'Lage liquiditeit';
            const ratioClr = volMcapRatio > 10 ? C.green : volMcapRatio > 3 ? '#f59e0b' : C.red;
            doc.roundedRect(M + 220, y + 3, 80, 12, 3).fill(ratioClr);
            doc.fontSize(5.5).fillColor(C.white).text(ratioNote, M + 222, y + 5, { width: 76, align: 'center' });
            y += 22;
          }

          // ATH / ATL cards side by side
          const athAfstand = (fundamentals.ath && currentPrice) ? ((currentPrice - fundamentals.ath) / fundamentals.ath * 100) : null;
          const atlAfstand = (fundamentals.atl && currentPrice) ? ((currentPrice - fundamentals.atl) / fundamentals.atl * 100) : null;

          doc.roundedRect(M, y, halfW, 38, 4).fill('#f8fafc');
          doc.save().lineWidth(0.3).strokeColor(C.gridLine).roundedRect(M, y, halfW, 38, 4).stroke().restore();
          doc.rect(M, y, 3, 38).fill(C.green);
          doc.fontSize(6).fillColor(C.textMid).text('All-Time High', M + 8, y + 4);
          doc.fontSize(10).fillColor(C.headerDark).text(fundamentals.ath ? fmtP(fundamentals.ath) : '—', M + 8, y + 14);
          if (athAfstand != null) doc.fontSize(6).fillColor(C.red).text(`Afstand: ${pctFmt(athAfstand)}`, M + 8, y + 28);
          if (fundamentals.athDate) doc.fontSize(5).fillColor(C.textLight).text(new Date(fundamentals.athDate).toLocaleDateString('nl-NL'), M + halfW - 60, y + 28);

          doc.roundedRect(M + halfW + 8, y, halfW, 38, 4).fill('#f8fafc');
          doc.save().lineWidth(0.3).strokeColor(C.gridLine).roundedRect(M + halfW + 8, y, halfW, 38, 4).stroke().restore();
          doc.rect(M + halfW + 8, y, 3, 38).fill(C.red);
          doc.fontSize(6).fillColor(C.textMid).text('All-Time Low', M + halfW + 16, y + 4);
          doc.fontSize(10).fillColor(C.headerDark).text(fundamentals.atl ? fmtP(fundamentals.atl) : '—', M + halfW + 16, y + 14);
          if (atlAfstand != null) doc.fontSize(6).fillColor(C.green).text(`Afstand: ${pctFmt(atlAfstand)}`, M + halfW + 16, y + 28);
          if (fundamentals.atlDate) doc.fontSize(5).fillColor(C.textLight).text(new Date(fundamentals.atlDate).toLocaleDateString('nl-NL'), M + CW - 60, y + 28);
          y += 44;

          // Watchlist users
          if (fundamentals.watchlistUsers) {
            doc.roundedRect(M, y, CW, 18, 3).fill('#f8fafc');
            doc.save().lineWidth(0.3).strokeColor(C.gridLine).roundedRect(M, y, CW, 18, 3).stroke().restore();
            doc.rect(M, y, 3, 18).fill(C.accent);
            doc.fontSize(6.5).fillColor(C.text).text('Watchlist Gebruikers:', M + 8, y + 5);
            doc.fontSize(7).fillColor(C.headerDark).text(fmtSupply(fundamentals.watchlistUsers), M + 120, y + 5);
            const wlNote = fundamentals.watchlistUsers > 100000 ? 'Veel interesse' : fundamentals.watchlistUsers > 10000 ? 'Gemiddeld' : 'Weinig interesse';
            doc.fontSize(6).fillColor(C.textLight).text(wlNote, M + 200, y + 5);
            y += 22;
          }

          // ── SECTIE: Prijsprestaties ──
          if (y > 700) { doc.addPage(); drawPageHeader(); y = 38; }
          y = sectionHeader(doc, nextSec(), 'Prijsprestaties', y);

          const priceChanges = [
            ['24 Uur', fundamentals.priceChange24h],
            ['7 Dagen', fundamentals.priceChange7d],
            ['30 Dagen', fundamentals.priceChange30d],
            ['1 Jaar', fundamentals.priceChange1y]
          ];

          doc.roundedRect(M, y, CW, 14, 3).fill(C.headerDark);
          doc.fontSize(6).fillColor(C.accent).text('PERIODE', M + 8, y + 4, {});
          doc.text('VERANDERING', M + 160, y + 4, {});
          doc.text('RICHTING', M + 360, y + 4, {});
          y += 14;

          priceChanges.forEach(([period, change], i) => {
            const rowBg = i % 2 === 0 ? '#f8fafc' : C.white;
            doc.rect(M, y, CW, 15).fill(rowBg);
            doc.fontSize(7).fillColor(C.text).text(period, M + 8, y + 4);
            if (change != null) {
              const clr = change >= 0 ? C.green : C.red;
              doc.fontSize(7).fillColor(clr).text(pctFmt(change), M + 160, y + 4);
              const barMaxW = 120;
              const barW = Math.min(Math.abs(change) / 50 * barMaxW, barMaxW);
              doc.roundedRect(M + 360, y + 3, barW, 9, 2).fill(clr);
              doc.fontSize(5.5).fillColor(C.white).text(change >= 0 ? 'UP' : 'DOWN', M + 362, y + 4);
            } else {
              doc.fontSize(7).fillColor(C.textLight).text('—', M + 160, y + 4);
            }
            y += 15;
          });
          doc.save().lineWidth(0.5).strokeColor(C.gridLine).moveTo(M, y).lineTo(M + CW, y).stroke().restore();
          y += 12;

          // ── SECTIE: Community & Sociaal ──
          if (fundamentals.twitterFollowers || fundamentals.redditSubscribers || fundamentals.telegramUsers) {
            if (y > 700) { doc.addPage(); drawPageHeader(); y = 38; }
            y = sectionHeader(doc, nextSec(), 'Community & Sociaal', y);

            doc.roundedRect(M, y, CW, 14, 3).fill(C.headerDark);
            doc.fontSize(6).fillColor(C.accent).text('PLATFORM', M + 8, y + 4, {});
            doc.fontSize(6).fillColor(C.accent).text('VOLGERS/LEDEN', M + 200, y + 4, {});
            doc.fontSize(6).fillColor(C.accent).text('STATUS', M + 380, y + 4, {});
            y += 14;

            const socialRows = [
              ['Twitter / X', fundamentals.twitterFollowers, fundamentals.twitterFollowers ? (fundamentals.twitterFollowers > 1000000 ? 'Groot bereik' : fundamentals.twitterFollowers > 100000 ? 'Actief' : 'Groeiend') : null],
              ['Reddit Subscribers', fundamentals.redditSubscribers, fundamentals.redditSubscribers ? (fundamentals.redditSubscribers > 500000 ? 'Grote community' : fundamentals.redditSubscribers > 50000 ? 'Actief' : 'Klein') : null],
              ['Reddit Actief (48h)', fundamentals.redditActiveAccounts, fundamentals.redditActiveAccounts ? (fundamentals.redditActiveAccounts > 5000 ? 'Zeer actief' : fundamentals.redditActiveAccounts > 500 ? 'Actief' : 'Rustig') : null],
              ['Telegram', fundamentals.telegramUsers, fundamentals.telegramUsers ? (fundamentals.telegramUsers > 100000 ? 'Groot' : fundamentals.telegramUsers > 10000 ? 'Gemiddeld' : 'Klein') : null]
            ].filter(r => r[1] != null);

            socialRows.forEach(([platform, value, status], i) => {
              const rowBg = i % 2 === 0 ? '#f8fafc' : C.white;
              doc.rect(M, y, CW, 15).fill(rowBg);
              doc.fontSize(7).fillColor(C.text).text(platform, M + 8, y + 4);
              doc.fontSize(7).fillColor(C.headerDark).text(fmtSupply(value), M + 200, y + 4);
              if (status) {
                const statusClr = status.includes('Groot') || status.includes('Zeer') ? C.green : status.includes('Actief') || status.includes('Gemiddeld') ? C.accent : C.textLight;
                doc.fontSize(6).fillColor(statusClr).text(status, M + 380, y + 4);
              }
              y += 15;
            });

            // Sentiment bar
            if (fundamentals.sentimentVotesUp != null && fundamentals.sentimentVotesDown != null) {
              y += 4;
              doc.rect(M, y, CW, 20).fill('#f8fafc');
              doc.fontSize(6.5).fillColor(C.textMid).text('Sentiment', M + 8, y + 3);
              const sentBarX = M + 80;
              const sentBarW = CW - 100;
              const upW = sentBarW * (fundamentals.sentimentVotesUp / 100);
              doc.roundedRect(sentBarX, y + 2, sentBarW, 12, 3).fill('#e2e8f0');
              doc.roundedRect(sentBarX, y + 2, upW, 12, 3).fill(C.green);
              doc.fontSize(5.5).fillColor(C.white).text(`${fundamentals.sentimentVotesUp.toFixed(0)}% positief`, sentBarX + 4, y + 5);
              doc.fontSize(5.5).fillColor(C.red).text(`${fundamentals.sentimentVotesDown.toFixed(0)}% negatief`, sentBarX + upW + 4, y + 5);
              y += 20;
            }

            // Watchlist in community section too
            if (fundamentals.watchlistUsers) {
              doc.rect(M, y, CW, 15).fill('#f8fafc');
              doc.fontSize(7).fillColor(C.text).text('Watchlist Gebruikers', M + 8, y + 4);
              doc.fontSize(7).fillColor(C.headerDark).text(fmtSupply(fundamentals.watchlistUsers), M + 200, y + 4);
              y += 15;
            }

            doc.save().lineWidth(0.5).strokeColor(C.gridLine).moveTo(M, y).lineTo(M + CW, y).stroke().restore();
            y += 12;
          }

          // ── SECTIE: Developer Activiteit & Code ──
          if (fundamentals.githubStars || fundamentals.githubCommit4Weeks || fundamentals.githubForks) {
            if (y > 700) { doc.addPage(); drawPageHeader(); y = 38; }
            y = sectionHeader(doc, nextSec(), 'Developer Activiteit & Code', y);

            doc.roundedRect(M, y, CW, 14, 3).fill(C.headerDark);
            doc.fontSize(6).fillColor(C.accent).text('METRIC', M + 8, y + 4, {});
            doc.fontSize(6).fillColor(C.accent).text('WAARDE', M + 260, y + 4, {});
            y += 14;

            const devRows = [
              ['GitHub Stars', fundamentals.githubStars],
              ['GitHub Forks', fundamentals.githubForks],
              ['Commits (4 weken)', fundamentals.githubCommit4Weeks],
              ['Pull Requests Gemerged', fundamentals.githubPullRequestsMerged],
              ['Code Toevoegingen (4w)', fundamentals.codeAdditions4Weeks],
              ['Code Verwijderingen (4w)', fundamentals.codeDeletions4Weeks],
              ['Open Issues', (fundamentals.githubTotalIssues != null && fundamentals.githubClosedIssues != null) ? (fundamentals.githubTotalIssues - fundamentals.githubClosedIssues) : null],
              ['Gesloten Issues', fundamentals.githubClosedIssues],
              ['Open/Gesloten Ratio', (fundamentals.githubTotalIssues != null && fundamentals.githubClosedIssues != null && fundamentals.githubClosedIssues > 0) ? ((fundamentals.githubTotalIssues - fundamentals.githubClosedIssues) / fundamentals.githubClosedIssues).toFixed(2) : null]
            ].filter(r => r[1] != null);

            devRows.forEach(([label, value], i) => {
              const rowBg = i % 2 === 0 ? '#f8fafc' : C.white;
              doc.rect(M, y, CW, 14).fill(rowBg);
              doc.fontSize(7).fillColor(C.text).text(label, M + 8, y + 3);
              doc.fontSize(7).fillColor(C.headerDark).text(typeof value === 'string' ? value : fmtSupply(value), M + 260, y + 3);
              y += 14;
            });
            doc.save().lineWidth(0.5).strokeColor(C.gridLine).moveTo(M, y).lineTo(M + CW, y).stroke().restore();
            y += 6;

            // Development Score badge
            const commits = fundamentals.githubCommit4Weeks || 0;
            let devLabel, devColor;
            if (commits > 50) { devLabel = 'Zeer Actief'; devColor = C.green; }
            else if (commits > 20) { devLabel = 'Actief'; devColor = '#3b82f6'; }
            else if (commits > 5) { devLabel = 'Matig'; devColor = '#f59e0b'; }
            else { devLabel = 'Inactief'; devColor = C.red; }

            doc.roundedRect(M, y, 140, 20, 4).fill('#f8fafc');
            doc.save().lineWidth(0.3).strokeColor(C.gridLine).roundedRect(M, y, 140, 20, 4).stroke().restore();
            doc.fontSize(6).fillColor(C.textMid).text('Development Score:', M + 6, y + 6);
            doc.roundedRect(M + 90, y + 3, 44, 14, 3).fill(devColor);
            doc.fontSize(6).fillColor(C.white).text(devLabel, M + 92, y + 7, { width: 40, align: 'center' });
            y += 28;
          }

          // ── SECTIE: Risicoprofiel ──
          if (y > 700) { doc.addPage(); drawPageHeader(); y = 38; }
          y = sectionHeader(doc, nextSec(), 'Risicoprofiel', y);

          const riskVolMcap = (fundamentals.volume24h && fundamentals.marketCap) ? (fundamentals.volume24h / fundamentals.marketCap * 100) : 0;
          const riskCircRatio = (fundamentals.circulatingSupply && fundamentals.totalSupply) ? (fundamentals.circulatingSupply / fundamentals.totalSupply * 100) : 50;
          const riskCommits = fundamentals.githubCommit4Weeks || 0;

          const liqRisk = riskVolMcap < 1 ? 'Hoog' : riskVolMcap <= 5 ? 'Gemiddeld' : 'Laag';
          const concRisk = riskCircRatio < 50 ? 'Hoog' : riskCircRatio <= 80 ? 'Gemiddeld' : 'Laag';
          const devRisk = riskCommits < 5 ? 'Hoog' : riskCommits <= 20 ? 'Gemiddeld' : 'Laag';

          const riskCardW = CW;
          drawRiskBadge('Liquiditeitsrisico (Volume/MCap)', liqRisk, M, y, riskCardW);
          y += 22;
          drawRiskBadge('Concentratierisico (Circulerend/Totaal)', concRisk, M, y, riskCardW);
          y += 22;
          drawRiskBadge('Ontwikkelingsrisico (GitHub Commits)', devRisk, M, y, riskCardW);
          y += 26;

          // Overall risk score (1-10)
          const riskToNum = (r) => r === 'Hoog' ? 8 : r === 'Gemiddeld' ? 5 : 2;
          const overallRisk = ((riskToNum(liqRisk) + riskToNum(concRisk) + riskToNum(devRisk)) / 3);
          const overallRiskLabel = overallRisk >= 7 ? 'Hoog Risico' : overallRisk >= 4 ? 'Gemiddeld Risico' : 'Laag Risico';
          const overallRiskColor = overallRisk >= 7 ? C.red : overallRisk >= 4 ? '#f59e0b' : C.green;

          doc.roundedRect(M, y, CW, 24, 4).fill('#f8fafc');
          doc.save().lineWidth(0.5).strokeColor(C.gridLine).roundedRect(M, y, CW, 24, 4).stroke().restore();
          doc.rect(M, y, 4, 24).fill(overallRiskColor);
          doc.fontSize(7).fillColor(C.text).text('Overall Risicoscore:', M + 12, y + 7);
          doc.fontSize(12).fillColor(overallRiskColor).text(overallRisk.toFixed(1) + '/10', M + 120, y + 4);
          doc.roundedRect(M + 200, y + 5, 90, 14, 3).fill(overallRiskColor);
          doc.fontSize(7).fillColor(C.white).text(overallRiskLabel, M + 202, y + 8, { width: 86, align: 'center' });
          y += 32;

          // ── SECTIE: Conclusie & Score ──
          if (y > 700) { doc.addPage(); drawPageHeader(); y = 38; }
          y = sectionHeader(doc, nextSec(), 'Conclusie & Score', y);

          // Calculate scores
          const techScore = Math.min(10, Math.max(1, riskCommits > 50 ? 9 : riskCommits > 20 ? 7 : riskCommits > 5 ? 5 : 2));
          const tokenomicsScore = Math.min(10, Math.max(1,
            (riskCircRatio > 80 ? 8 : riskCircRatio > 50 ? 6 : 3) +
            (fundamentals.maxSupply ? 2 : -1)
          ));
          const adoptionScore = Math.min(10, Math.max(1,
            (fundamentals.marketCapRank ? (fundamentals.marketCapRank <= 10 ? 9 : fundamentals.marketCapRank <= 50 ? 7 : fundamentals.marketCapRank <= 100 ? 5 : 3) : 3) +
            ((fundamentals.twitterFollowers || 0) > 500000 ? 1 : 0) +
            ((fundamentals.redditSubscribers || 0) > 100000 ? 1 : 0)
          ));
          const riskReturnScore = Math.min(10, Math.max(1, 10 - overallRisk));
          const overallScore = (techScore + tokenomicsScore + adoptionScore + riskReturnScore) / 4;

          // Score card
          doc.roundedRect(M, y, CW, 90, 5).fill('#f8fafc');
          doc.save().lineWidth(0.5).strokeColor(C.gridLine).roundedRect(M, y, CW, 90, 5).stroke().restore();
          doc.roundedRect(M, y, CW, 3, 3).fill(C.accent);

          const barAreaX = M + 10;
          const barAreaW = 140;
          drawScoreBar('Technologie', techScore, barAreaX, y + 10, barAreaW);
          drawScoreBar('Tokenomics', tokenomicsScore, barAreaX, y + 26, barAreaW);
          drawScoreBar('Adoptie', adoptionScore, barAreaX, y + 42, barAreaW);
          drawScoreBar('Risico/Rendement', riskReturnScore, barAreaX, y + 58, barAreaW);

          // Overall score circle
          const oscX = M + CW - 70, oscY = y + 30, oscR = 24;
          doc.save().lineWidth(3).strokeColor(C.headerDark).circle(oscX, oscY, oscR).stroke().restore();
          const oscColor = overallScore >= 7 ? C.green : overallScore >= 4 ? '#f59e0b' : C.red;
          doc.save().lineWidth(3).strokeColor(oscColor).circle(oscX, oscY, oscR - 4).stroke().restore();
          doc.circle(oscX, oscY, oscR - 8).fill(C.headerDark);
          doc.fontSize(14).fillColor(C.white).text(overallScore.toFixed(1), oscX - 16, oscY - 8, { width: 32, align: 'center' });
          doc.fontSize(5).fillColor(C.accent).text('OVERALL', oscX - 16, oscY + 8, { width: 32, align: 'center' });

          // Auto-generated conclusion in Dutch
          const conclusionRating = overallScore >= 7.5 ? 'sterk' : overallScore >= 5 ? 'gemiddeld' : 'zwak';
          const conclusionTrend = techScore >= 6 ? 'actieve ontwikkeling' : 'beperkte ontwikkelactiviteit';
          const conclusionAdoption = adoptionScore >= 7 ? 'brede marktacceptatie' : adoptionScore >= 4 ? 'groeiende adoptie' : 'beperkte adoptie';
          const conclusionText = `${fundamentals.name || ticker.toUpperCase()} scoort overall ${conclusionRating} met een score van ${overallScore.toFixed(1)}/10. ` +
            `Het project toont ${conclusionTrend} en ${conclusionAdoption}. ` +
            `Het risicoprofiel is ${overallRiskLabel.toLowerCase()} met een score van ${overallRisk.toFixed(1)}/10.`;

          doc.fontSize(6.5).fillColor(C.textMid).text(conclusionText, M + 10, y + 76, { width: CW - 100, lineGap: 2 });
          y += 98;

        } else {
          // ════════════════════════════════════════
          // ██  STOCK FUNDAMENTALS
          // ════════════════════════════════════════

          // ── SECTIE: Bedrijfsprofiel ──
          y = sectionHeader(doc, nextSec(), 'Bedrijfsprofiel', y);

          doc.roundedRect(M, y, CW, 50, 5).fill('#f8fafc');
          doc.save().lineWidth(0.5).strokeColor(C.gridLine).roundedRect(M, y, CW, 50, 5).stroke().restore();
          doc.rect(M, y, 4, 50).fill(C.accent);

          doc.fontSize(14).fillColor(C.headerDark).text(fundamentals.name || ticker.toUpperCase(), M + 14, y + 6);
          doc.fontSize(8).fillColor(C.accent).text(fundamentals.symbol || ticker.toUpperCase(), M + 14, y + 24, {});
          if (fundamentals.exchange) doc.fontSize(7).fillColor(C.textLight).text(`Exchange: ${fundamentals.exchange} | Valuta: ${fundamentals.currency || 'USD'}`, M + 14, y + 36);

          doc.fontSize(20).fillColor(C.headerDark).text(fmtP(currentPrice), PW - M - 160, y + 6, { width: 150, align: 'right' });
          y += 56;

          // Previous close, 52w high/low
          const stockInfoItems = [
            { label: 'Vorige Slotkoers', value: fundamentals.previousClose ? fmtP(fundamentals.previousClose) : '—' },
            { label: '52-Week Hoog', value: fundamentals.fiftyTwoWeekHigh ? fmtP(fundamentals.fiftyTwoWeekHigh) : '—' },
            { label: '52-Week Laag', value: fundamentals.fiftyTwoWeekLow ? fmtP(fundamentals.fiftyTwoWeekLow) : '—' }
          ];
          const siColW = (CW - 16) / 3;
          stockInfoItems.forEach((item, i) => {
            const cx = M + i * (siColW + 8);
            doc.roundedRect(cx, y, siColW, 28, 4).fill('#f8fafc');
            doc.save().lineWidth(0.3).strokeColor(C.gridLine).roundedRect(cx, y, siColW, 28, 4).stroke().restore();
            doc.rect(cx, y, 3, 28).fill(C.accent);
            doc.fontSize(5.5).fillColor(C.textMid).text(item.label, cx + 8, y + 4);
            doc.fontSize(9).fillColor(C.headerDark).text(item.value, cx + 8, y + 14);
          });
          y += 34;

          // ── SECTIE: Waardering & Multiples ──
          if (fundamentals.peRatio || fundamentals.forwardPE || fundamentals.priceToBook || fundamentals.beta) {
            if (y > 700) { doc.addPage(); drawPageHeader(); y = 38; }
            y = sectionHeader(doc, nextSec(), 'Waardering & Multiples', y);

            const peInterp = (v) => { if (v == null) return ['—', C.textLight]; return v < 15 ? ['Ondergewaardeerd', C.green] : v <= 25 ? ['Redelijk', '#f59e0b'] : ['Overgewaardeerd', C.red]; };
            const betaInterp = (v) => { if (v == null) return ['—', C.textLight]; return v < 0.8 ? ['Defensief', C.green] : v <= 1.5 ? ['Marktconform', '#f59e0b'] : ['Volatiel', C.red]; };

            // 2-column card layout
            const valCardW = (CW - 8) / 2;
            const valCardH = 28;

            const leftMetrics = [
              { label: 'P/E (trailing)', value: fundamentals.peRatio != null ? fundamentals.peRatio.toFixed(2) : '—', badge: peInterp(fundamentals.peRatio) },
              { label: 'Forward P/E', value: fundamentals.forwardPE != null ? fundamentals.forwardPE.toFixed(2) : '—', badge: peInterp(fundamentals.forwardPE) },
              { label: 'PEG (impliciet)', value: (fundamentals.peRatio && fundamentals.earningsGrowth && fundamentals.earningsGrowth !== 0) ? (fundamentals.peRatio / (fundamentals.earningsGrowth * 100)).toFixed(2) : '—', badge: ['—', C.textLight] },
              { label: 'Koers/Boekwaarde', value: fundamentals.priceToBook != null ? fundamentals.priceToBook.toFixed(2) : '—', badge: ['—', C.textLight] }
            ];

            const rightMetrics = [
              { label: 'Marktkapitalisatie', value: fmtBig(fundamentals.marketCap), badge: ['—', C.textLight] },
              { label: 'Enterprise Value', value: (fundamentals.marketCap && fundamentals.debtToEquity && fundamentals.bookValue) ? fmtBig(fundamentals.marketCap * (1 + (fundamentals.debtToEquity / 100))) : '—', badge: ['—', C.textLight] },
              { label: 'Dividendrendement', value: fundamentals.dividendYield != null ? (fundamentals.dividendYield * 100).toFixed(2) + '%' : '—', badge: ['—', C.textLight] },
              { label: 'Beta', value: fundamentals.beta != null ? fundamentals.beta.toFixed(2) : '—', badge: betaInterp(fundamentals.beta) }
            ];

            leftMetrics.forEach((m, i) => {
              const cy = y + i * (valCardH + 4);
              doc.roundedRect(M, cy, valCardW, valCardH, 4).fill('#f8fafc');
              doc.save().lineWidth(0.3).strokeColor(C.gridLine).roundedRect(M, cy, valCardW, valCardH, 4).stroke().restore();
              doc.rect(M, cy, 3, valCardH).fill(C.headerDark);
              doc.fontSize(6).fillColor(C.textMid).text(m.label, M + 8, cy + 4);
              doc.fontSize(10).fillColor(C.headerDark).text(m.value, M + 8, cy + 14);
              if (m.badge[0] !== '—') {
                doc.roundedRect(M + valCardW - 78, cy + 6, 70, 14, 3).fill(m.badge[1]);
                doc.fontSize(5.5).fillColor(C.white).text(m.badge[0], M + valCardW - 76, cy + 9, { width: 66, align: 'center' });
              }
            });

            rightMetrics.forEach((m, i) => {
              const cy = y + i * (valCardH + 4);
              const rx = M + valCardW + 8;
              doc.roundedRect(rx, cy, valCardW, valCardH, 4).fill('#f8fafc');
              doc.save().lineWidth(0.3).strokeColor(C.gridLine).roundedRect(rx, cy, valCardW, valCardH, 4).stroke().restore();
              doc.rect(rx, cy, 3, valCardH).fill(C.accent);
              doc.fontSize(6).fillColor(C.textMid).text(m.label, rx + 8, cy + 4);
              doc.fontSize(10).fillColor(C.headerDark).text(m.value, rx + 8, cy + 14);
              if (m.badge[0] !== '—') {
                doc.roundedRect(rx + valCardW - 78, cy + 6, 70, 14, 3).fill(m.badge[1]);
                doc.fontSize(5.5).fillColor(C.white).text(m.badge[0], rx + valCardW - 76, cy + 9, { width: 66, align: 'center' });
              }
            });
            y += leftMetrics.length * (valCardH + 4) + 8;
          }

          // ── SECTIE: Winstgevendheid & Groei ──
          if (fundamentals.eps || fundamentals.profitMargin || fundamentals.revenueGrowth) {
            if (y > 700) { doc.addPage(); drawPageHeader(); y = 38; }
            y = sectionHeader(doc, nextSec(), 'Winstgevendheid & Groei', y);

            doc.roundedRect(M, y, CW, 14, 3).fill(C.headerDark);
            doc.fontSize(6).fillColor(C.accent).text('KENGETAL', M + 8, y + 4, {});
            doc.fontSize(6).fillColor(C.accent).text('WAARDE', M + 220, y + 4, {});
            doc.fontSize(6).fillColor(C.accent).text('BEOORDELING', M + 400, y + 4, {});
            y += 14;

            const profitRows = [
              ['Winst per Aandeel (EPS)', fundamentals.eps != null ? '$' + fundamentals.eps.toFixed(2) : null, fundamentals.eps != null ? (fundamentals.eps > 0 ? C.green : C.red) : null],
              ['Winstmarge', fundamentals.profitMargin != null ? fmtPct(fundamentals.profitMargin) : null, fundamentals.profitMargin != null ? (fundamentals.profitMargin > 0 ? C.green : C.red) : null],
              ['Operationele Marge', fundamentals.operatingMargin != null ? fmtPct(fundamentals.operatingMargin) : null, fundamentals.operatingMargin != null ? (fundamentals.operatingMargin > 0 ? C.green : C.red) : null],
              ['Return on Equity (ROE)', fundamentals.returnOnEquity != null ? fmtPct(fundamentals.returnOnEquity) : null, fundamentals.returnOnEquity != null ? (fundamentals.returnOnEquity > 0.15 ? C.green : fundamentals.returnOnEquity > 0 ? '#f59e0b' : C.red) : null],
              ['Return on Assets (ROA)', fundamentals.returnOnAssets != null ? fmtPct(fundamentals.returnOnAssets) : null, fundamentals.returnOnAssets != null ? (fundamentals.returnOnAssets > 0.05 ? C.green : fundamentals.returnOnAssets > 0 ? '#f59e0b' : C.red) : null],
              ['Omzetgroei', fundamentals.revenueGrowth != null ? fmtPct(fundamentals.revenueGrowth) : null, fundamentals.revenueGrowth != null ? (fundamentals.revenueGrowth > 0 ? C.green : C.red) : null],
              ['Winstgroei', fundamentals.earningsGrowth != null ? fmtPct(fundamentals.earningsGrowth) : null, fundamentals.earningsGrowth != null ? (fundamentals.earningsGrowth > 0 ? C.green : C.red) : null]
            ].filter(r => r[1] != null);

            profitRows.forEach(([label, value, clr], i) => {
              const rowBg = i % 2 === 0 ? '#f8fafc' : C.white;
              doc.rect(M, y, CW, 14).fill(rowBg);
              doc.circle(M + 6, y + 7, 3).fill(clr || C.textLight);
              doc.fontSize(7).fillColor(C.text).text(label, M + 14, y + 3);
              doc.fontSize(7).fillColor(C.headerDark).text(value, M + 220, y + 3);
              if (clr) {
                const assessment = clr === C.green ? 'Positief' : clr === C.red ? 'Negatief' : 'Neutraal';
                doc.fontSize(6).fillColor(clr).text(assessment, M + 400, y + 3);
              }
              y += 14;
            });
            doc.save().lineWidth(0.5).strokeColor(C.gridLine).moveTo(M, y).lineTo(M + CW, y).stroke().restore();
            y += 12;
          }

          // ── SECTIE: Financiele Gezondheid ──
          if (fundamentals.debtToEquity != null) {
            if (y > 700) { doc.addPage(); drawPageHeader(); y = 38; }
            y = sectionHeader(doc, nextSec(), 'Financiele Gezondheid', y);

            const deInterp = fundamentals.debtToEquity < 50 ? ['Conservatief', C.green] : fundamentals.debtToEquity <= 200 ? ['Gemiddeld', '#f59e0b'] : ['Hoge Schuld', C.red];

            doc.roundedRect(M, y, CW, 36, 4).fill('#f8fafc');
            doc.save().lineWidth(0.3).strokeColor(C.gridLine).roundedRect(M, y, CW, 36, 4).stroke().restore();
            doc.rect(M, y, 4, 36).fill(deInterp[1]);

            doc.fontSize(7).fillColor(C.text).text('Schuld/Eigen Vermogen Ratio', M + 12, y + 6);
            doc.fontSize(14).fillColor(C.headerDark).text(fundamentals.debtToEquity.toFixed(2), M + 12, y + 18);
            doc.roundedRect(M + 120, y + 8, 80, 14, 3).fill(deInterp[1]);
            doc.fontSize(6).fillColor(C.white).text(deInterp[0], M + 122, y + 11, { width: 76, align: 'center' });

            // Interpretation text
            const deNote = fundamentals.debtToEquity < 50 ? 'Het bedrijf heeft een lage schuldenlast ten opzichte van eigen vermogen.'
              : fundamentals.debtToEquity <= 200 ? 'De schuldenlast is gemiddeld. Let op de rentelasten.'
              : 'Hoge schuldenlast — verhoogd financieel risico.';
            doc.fontSize(6).fillColor(C.textMid).text(deNote, M + 220, y + 10, { width: CW - 240, lineGap: 2 });
            y += 42;
          }

          // ── SECTIE: Analistenoverzicht ──
          if (fundamentals.recommendation) {
            if (y > 700) { doc.addPage(); drawPageHeader(); y = 38; }
            y = sectionHeader(doc, nextSec(), 'Analistenoverzicht', y);

            const recKey = (fundamentals.recommendation || '').toLowerCase();
            let recLabel, recColor;
            if (recKey.includes('buy') || recKey.includes('strong')) { recLabel = 'BUY'; recColor = C.green; }
            else if (recKey.includes('hold') || recKey.includes('neutral')) { recLabel = 'HOLD'; recColor = '#f59e0b'; }
            else if (recKey.includes('sell') || recKey.includes('under')) { recLabel = 'SELL'; recColor = C.red; }
            else { recLabel = fundamentals.recommendation.toUpperCase(); recColor = C.textMid; }

            doc.roundedRect(M, y, CW, 60, 5).fill('#f8fafc');
            doc.save().lineWidth(0.5).strokeColor(C.gridLine).roundedRect(M, y, CW, 60, 5).stroke().restore();
            doc.rect(M, y, 4, 60).fill(recColor);

            // Large badge
            doc.roundedRect(M + 14, y + 6, 70, 30, 5).fill(recColor);
            doc.fontSize(14).fillColor(C.white).text(recLabel, M + 16, y + 14, { width: 66, align: 'center' });

            // Number of analysts
            if (fundamentals.numberOfAnalysts) {
              doc.fontSize(6).fillColor(C.textMid).text('Aantal Analisten', M + 14, y + 42);
              doc.fontSize(10).fillColor(C.headerDark).text(fundamentals.numberOfAnalysts.toString(), M + 14, y + 50);
            }

            // Target price vs current
            if (fundamentals.targetMeanPrice) {
              doc.fontSize(6).fillColor(C.textMid).text('Gemiddeld Koersdoel', M + 100, y + 6);
              doc.fontSize(16).fillColor(C.headerDark).text('$' + fundamentals.targetMeanPrice.toFixed(2), M + 100, y + 16);

              const upside = ((fundamentals.targetMeanPrice - currentPrice) / currentPrice * 100);
              const upsideClr = upside >= 0 ? C.green : C.red;
              const upsideLabel = upside >= 0 ? `+${upside.toFixed(1)}% Upside` : `${upside.toFixed(1)}% Downside`;
              doc.roundedRect(M + 100, y + 36, 110, 16, 3).fill(upsideClr);
              doc.fontSize(7).fillColor(C.white).text(upsideLabel, M + 102, y + 40, { width: 106, align: 'center' });

              // Visual bar: target vs current
              const barStartX = M + 280;
              const barTotalW = CW - 294;
              const maxVal = Math.max(currentPrice, fundamentals.targetMeanPrice) * 1.1;
              const curBarW = (currentPrice / maxVal) * barTotalW;
              const tgtBarW = (fundamentals.targetMeanPrice / maxVal) * barTotalW;

              doc.fontSize(5.5).fillColor(C.textMid).text('Huidige Koers', barStartX, y + 8);
              doc.roundedRect(barStartX, y + 16, curBarW, 8, 2).fill(C.headerDark);
              doc.fontSize(5.5).fillColor(C.textMid).text('Koersdoel', barStartX, y + 28);
              doc.roundedRect(barStartX, y + 36, tgtBarW, 8, 2).fill(upsideClr);
            }

            y += 66;
          }

          // ── SECTIE: Risicoprofiel ──
          if (y > 700) { doc.addPage(); drawPageHeader(); y = 38; }
          y = sectionHeader(doc, nextSec(), 'Risicoprofiel', y);

          const peVal = fundamentals.peRatio || 20;
          const betaVal = fundamentals.beta || 1;
          const deVal = fundamentals.debtToEquity || 100;

          const valRisk = peVal > 30 ? 'Hoog' : peVal >= 15 ? 'Gemiddeld' : 'Laag';
          const volRisk = betaVal > 1.5 ? 'Hoog' : betaVal >= 0.8 ? 'Gemiddeld' : 'Laag';
          const debtRisk = deVal > 200 ? 'Hoog' : deVal >= 50 ? 'Gemiddeld' : 'Laag';

          drawRiskBadge('Waarderingsrisico (P/E Ratio)', valRisk, M, y, CW);
          y += 22;
          drawRiskBadge('Volatiliteitsrisico (Beta)', volRisk, M, y, CW);
          y += 22;
          drawRiskBadge('Schuldrisico (Schuld/EV)', debtRisk, M, y, CW);
          y += 28;

        } // end stock vs crypto

      } else {
        // Geen fundamentele data beschikbaar
        doc.roundedRect(M, y, CW, 40, 4).fill('#fef2f2');
        doc.save().lineWidth(0.5).strokeColor(C.red).roundedRect(M, y, CW, 40, 4).stroke().restore();
        doc.fontSize(9).fillColor(C.red).text('Fundamentele data niet beschikbaar', M + 14, y + 8);
        doc.fontSize(7).fillColor(C.textMid).text('Er kon geen fundamentele informatie opgehaald worden voor deze ticker. Dit kan te wijten zijn aan API-limieten of een ongeldige ticker.', M + 14, y + 22, { width: CW - 28 });
        y += 50;
      }

      // ── SECTIE: Recent Nieuws ──
      if (fundamentals && fundamentals.news && fundamentals.news.length > 0) {
        if (y > 700) { doc.addPage(); drawPageHeader(); y = 38; }
        y = sectionHeader(doc, nextSec(), 'Recent Nieuws', y);

        fundamentals.news.forEach((article, i) => {
          const rowH = 22;
          if (y + rowH > 750) { doc.addPage(); drawPageHeader(); y = 38; }
          const rowBg = i % 2 === 0 ? '#f8fafc' : '#ffffff';
          doc.roundedRect(M, y, CW, rowH, 3).fill(rowBg);
          doc.rect(M, y, 3, rowH).fill(C.accent);

          // Title (truncated to fit)
          const titleText = article.title.length > 80 ? article.title.substring(0, 77) + '...' : article.title;
          doc.fontSize(7).fillColor(C.headerDark).text(titleText, M + 10, y + 3, { width: CW - 120 });

          // Source + date on right
          doc.fontSize(5.5).fillColor(C.textMid).text(article.source, M + CW - 105, y + 3, { width: 100, align: 'right' });
          doc.fontSize(5).fillColor(C.textLight).text(article.date, M + CW - 105, y + 12, { width: 100, align: 'right' });

          y += rowH + 2;
        });
        y += 6;
      }

      // Disclaimer op fundamentals pagina
      if (y > 700) { doc.addPage(); drawPageHeader(); y = 38; }
      y += 8;
      doc.roundedRect(M, y, CW, 58, 5).fill('#fffbeb');
      doc.save().lineWidth(0.8).strokeColor(C.accent).roundedRect(M, y, CW, 58, 5).stroke().restore();
      doc.rect(M, y, 4, 58).fill(C.accent);
      doc.roundedRect(M + 12, y + 5, 18, 18, 3).fill(C.accent);
      doc.fontSize(12).fillColor(C.white).text('!', M + 14, y + 7, { width: 14, align: 'center' });
      doc.fontSize(7).fillColor(C.accentDark).text('DISCLAIMER', M + 38, y + 6, {});
      doc.fontSize(6).fillColor(C.textMid).text(
        'Dit rapport is gegenereerd door Merlijn Signaal Labo en vormt geen financieel advies. De informatie is uitsluitend bedoeld voor educatieve doeleinden. ' +
        'Het gebruik of opvolgen van rapporten en signalen in live trading is volledig op eigen risico en niet de intentie van Camelot Beleggersclub. ' +
        'Om de eigen kennis te toetsen kan je dit oefenen in paper trading. Doe altijd eigen onderzoek (DYOR).',
        M + 38, y + 17, { width: CW - 54, lineGap: 2.5 }
      );
      y += 64;
      doc.fontSize(5).fillColor(C.textLight).text('© 2026 Camelot Beleggersclub — Alle rechten voorbehouden. Dit rapport mag niet openbaar gedeeld of verspreid worden.', M, y, { width: CW, align: 'center' });

      drawWatermark();
      drawFooter();
    }

    doc.end();
  });
}

// ═══ Main API Handler ═══
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { ticker, includeAnalyse = true, includeFundamentals = false } = req.body || {};
    if (!ticker) return res.status(400).json({ error: 'ticker is verplicht' });

    // Determine source: crypto (Binance) or stock (Yahoo Finance)
    const rawTicker = ticker.toUpperCase().trim();
    const useCrypto = isCryptoTicker(rawTicker);
    let symbol, displayName, monthly, fourH, weekly;

    if (useCrypto) {
      // Crypto via Binance
      symbol = rawTicker;
      if (!symbol.endsWith('USDT') && !symbol.endsWith('USD')) {
        symbol = symbol + 'USDT';
      }
      displayName = symbol.replace('USDT', '').replace('USD', '');

      [monthly, fourH, weekly] = await Promise.all([
        fetchBinanceKlines(symbol, '1M', 60),
        fetchBinanceKlines(symbol, '4h', 500),
        fetchBinanceKlines(symbol, '1w', 500)
      ]);
    } else {
      // Stock via Yahoo Finance
      symbol = rawTicker;
      displayName = rawTicker;

      // Try fetching from Yahoo — use daily instead of 4h (not available for stocks)
      try {
        [monthly, weekly, fourH] = await Promise.all([
          fetchYahooKlines(symbol, '1M', 60),
          fetchYahooKlines(symbol, '1w', 500),
          fetchYahooKlines(symbol, '4h', 500)  // maps to 1d for stocks
        ]);
      } catch (yahooErr) {
        return res.status(400).json({ error: `Geen data gevonden voor "${ticker}". Controleer of het een geldige ticker is (bijv. AAPL, MSFT, TSLA voor aandelen of BTC, ETH voor crypto).` });
      }
    }

    if (!monthly || monthly.length < 10) {
      return res.status(400).json({ error: `Onvoldoende data voor ticker "${ticker}". Controleer of het een geldige ticker is.` });
    }

    // Haal live prijs op voor maximale accuraatheid
    let livePrice = null;
    if (useCrypto) {
      // Probeer binance.com, dan binance.us
      for (const base of ['https://api.binance.com', 'https://api.binance.us']) {
        try {
          const tickerResp = await fetch(`${base}/api/v3/ticker/price?symbol=${symbol}`);
          const tickerData = await tickerResp.json();
          if (tickerData && tickerData.price) { livePrice = parseFloat(tickerData.price); break; }
        } catch(e) { continue; }
      }
      // Fallback: als Binance geen prijs geeft, probeer CoinGecko of gebruik laatste 4h candle
      if (!livePrice && fourH && fourH.length > 0) {
        livePrice = fourH[fourH.length - 1].close;
      }
    } else {
      // Stocks: haal live prijs op via Yahoo Finance quote
      try {
        const yahooQuoteUrl = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
        const raw = execSync(`curl -s "${yahooQuoteUrl}" -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"`, {
          timeout: 10000, encoding: 'utf8'
        });
        const json = JSON.parse(raw);
        if (json.chart && json.chart.result && json.chart.result.length > 0) {
          const meta = json.chart.result[0].meta;
          if (meta && meta.regularMarketPrice) {
            livePrice = meta.regularMarketPrice;
          }
        }
      } catch(e) { /* gebruik laatste candle als fallback */ }
      // Fallback: laatste candle close
      if (!livePrice && fourH && fourH.length > 0) {
        livePrice = fourH[fourH.length - 1].close;
      }
    }

    // Run analysis
    const ewData = analyzeWaveDetails(monthly, 3);
    const signals = generateSignals(monthly);

    // ── Sub-wave analyse met WEEKDATA (identiek aan app) ──
    // analyzeWaveDetails doet nu GEEN sub-wave analyse meer intern
    // Sub-waves worden apart berekend op 500 weekcandles voor hogere resolutie
    if (ewData && ewData.currentWave === 'W3' && weekly && weekly.length >= 10) {
      const hasOriginal = ewData.originalWavePoints && ewData.originalWavePoints['W5'];
      const w1Price = ewData.wavePoints['W1'] ? ewData.wavePoints['W1'].price : 0;
      const w0Ref = ewData.wavePoints['W0'];
      const w2Ref = ewData.wavePoints['W2'];
      const bigMoveAlreadyHappened = w1Price > 0 && ewData.currentPrice > 0 && w1Price > ewData.currentPrice * 2;

      let startRef = null;
      if (hasOriginal) {
        startRef = w2Ref; // macro W2
      } else if (bigMoveAlreadyHappened && w0Ref) {
        startRef = w0Ref;
      } else {
        startRef = w2Ref;
      }

      if (startRef) {
        // Map monthly barIdx naar weekly barIdx (identiek aan app)
        let startWeekIdx = 0;
        let minDiff = Infinity;

        if (hasOriginal && startRef.barIdx !== undefined) {
          const monthlyLen = monthly.length;
          const weeklyLen = weekly.length;
          const barsFromEnd = monthlyLen - 1 - startRef.barIdx;
          const weeksFromEnd = Math.round(barsFromEnd * 4.3);
          const estimatedWeekIdx = Math.max(0, weeklyLen - 1 - weeksFromEnd);
          const searchRadius = 15;
          const searchStart = Math.max(0, estimatedWeekIdx - searchRadius);
          const searchEnd = Math.min(weeklyLen - 1, estimatedWeekIdx + searchRadius);
          let bestLow = Infinity;
          for (let i = searchStart; i <= searchEnd; i++) {
            if (weekly[i].low < bestLow) { bestLow = weekly[i].low; startWeekIdx = i; }
          }
        } else {
          for (let i = 0; i < weekly.length; i++) {
            const diff = Math.abs(weekly[i].low - startRef.price);
            if (diff < minDiff) { minDiff = diff; startWeekIdx = i; }
          }
        }

        const w3Target = ewData.waveInfo && ewData.waveInfo['W3'] ? ewData.waveInfo['W3'].target : null;
        ewData.subWaves = analyzeSubWaves(weekly, startWeekIdx, w3Target);

        // Fallback: retry from W0 if no sub-waves found
        if (!hasOriginal && ewData.subWaves && Object.keys(ewData.subWaves.subWavePoints).filter(k=>k!=='W2').length === 0
            && bigMoveAlreadyHappened && w0Ref && startRef !== w0Ref) {
          let w0WeekIdx = 0; minDiff = Infinity;
          for (let i = 0; i < weekly.length; i++) {
            const diff = Math.abs(weekly[i].low - w0Ref.price);
            if (diff < minDiff) { minDiff = diff; w0WeekIdx = i; }
          }
          ewData.subWaves = analyzeSubWaves(weekly, w0WeekIdx, w3Target);
        }

        // EW VALIDATIE: sub-wave punten moeten BOVEN W2 liggen
        const macroW2Price = ewData.wavePoints['W2'] ? ewData.wavePoints['W2'].price : null;
        if (macroW2Price && ewData.subWaves && ewData.subWaves.subWavePoints) {
          const hasInvalidPoint = Object.entries(ewData.subWaves.subWavePoints)
            .filter(([k]) => k !== 'W2')
            .some(([, v]) => v.price < macroW2Price);
          if (hasInvalidPoint) ewData.subWaves = null;
        }

        // W3 COMPLEET DETECTIE
        if (ewData.subWaves && ewData.subWaves.subWavePoints) {
          const sp = ewData.subWaves.subWavePoints;
          if (sp['i'] && sp['ii'] && sp['iii'] && sp['iv'] && sp['v']) {
            const w3Peak = Math.max(sp['iii'].price, sp['v'].price);
            const w2Price = macroW2Price || (ewData.wavePoints['W2'] ? ewData.wavePoints['W2'].price : 0);
            const w3RangeLocal = w3Peak - w2Price;
            const retrace = w3RangeLocal > 0 ? (w3Peak - ewData.currentPrice) / w3RangeLocal : 0;
            if (ewData.currentPrice < sp['v'].price * 0.95 && retrace >= 0.10) {
              // W3 compleet → transitie naar W4
              let w3MonthlyIdx = 0, md = Infinity;
              for (let mi = 0; mi < monthly.length; mi++) {
                const diff = Math.abs(monthly[mi].high - w3Peak);
                if (diff < md) { md = diff; w3MonthlyIdx = mi; }
              }
              ewData.wavePoints['W3'] = { price: w3Peak, barIdx: w3MonthlyIdx };
              let w4Low = { price: Infinity, barIdx: w3MonthlyIdx };
              for (let mi = w3MonthlyIdx + 1; mi < monthly.length; mi++) {
                if (monthly[mi].low < w4Low.price) w4Low = { price: monthly[mi].low, barIdx: mi };
              }
              const w1Top = ewData.wavePoints['W1'].price;
              if (w4Low.price > w1Top && w4Low.price < w3Peak) {
                const w4Ret = (w3Peak - w4Low.price) / w3RangeLocal;
                if (w4Ret >= 0.146) {
                  const barsAfter = monthly.length - 1 - w4Low.barIdx;
                  if (barsAfter >= 1 && ewData.currentPrice > w4Low.price * 1.02) {
                    ewData.wavePoints['W4'] = w4Low;
                    ewData.currentWave = 'W5';
                  } else { ewData.currentWave = 'W4'; }
                } else { ewData.currentWave = 'W4'; }
              }
            }
          }
        }
      }
    }

    // ── EW AUDIT AGENT — valideer wave telling voor rapport ──
    const audit = ewAuditWaveCount(displayName, ewData);
    if (audit.errors.length > 0) {
      console.error(`🔍 EW AUDIT [${displayName}]: ${audit.errors.length} SCHENDINGEN:`);
      audit.errors.forEach(e => console.error(`  ${e}`));
    }
    if (audit.warnings.length > 0) {
      console.warn(`🔍 EW AUDIT [${displayName}]: ${audit.warnings.length} waarschuwingen:`);
      audit.warnings.forEach(w => console.warn(`  ${w}`));
    }

    // Log live prijs bron voor debugging
    const priceSource = livePrice
      ? (useCrypto ? 'Binance API' : 'Yahoo Finance')
      : 'Laatste candle close (geen live prijs beschikbaar)';
    console.log(`📊 Rapport ${displayName}: Live prijs = ${livePrice || 'N/A'} (Bron: ${priceSource})`);

    // Haal fundamentele data op als dat nodig is
    let fundamentals = null;
    if (includeFundamentals) {
      try {
        if (useCrypto) {
          // CoinGecko API voor crypto fundamentals
          const cgId = { BTC: 'bitcoin', ETH: 'ethereum', XRP: 'ripple', HBAR: 'hedera-hashgraph', VET: 'vechain', SOL: 'solana', ADA: 'cardano', DOT: 'polkadot', LINK: 'chainlink', AVAX: 'avalanche-2', MATIC: 'matic-network', DOGE: 'dogecoin', SHIB: 'shiba-inu', BNB: 'binancecoin', LTC: 'litecoin', UNI: 'uniswap', ATOM: 'cosmos', ALGO: 'algorand', XLM: 'stellar', FTM: 'fantom', NEAR: 'near', PAXG: 'pax-gold' }[displayName] || displayName.toLowerCase();
          const cgUrl = `https://api.coingecko.com/api/v3/coins/${cgId}?localization=false&tickers=false&community_data=true&developer_data=true`;
          const cgRaw = execSync(`curl -s "${cgUrl}" -H "User-Agent: Mozilla/5.0"`, { timeout: 10000, encoding: 'utf8' });
          const cgData = JSON.parse(cgRaw);
          if (cgData && cgData.market_data) {
            const md = cgData.market_data;
            fundamentals = {
              type: 'crypto',
              name: cgData.name || displayName,
              symbol: (cgData.symbol || displayName).toUpperCase(),
              description: cgData.description?.en?.split('.').slice(0, 2).join('.') + '.' || '',
              marketCap: md.market_cap?.usd || null,
              marketCapRank: cgData.market_cap_rank || null,
              volume24h: md.total_volume?.usd || null,
              circulatingSupply: md.circulating_supply || null,
              totalSupply: md.total_supply || null,
              maxSupply: md.max_supply || null,
              ath: md.ath?.usd || null,
              athDate: md.ath_date?.usd || null,
              athChange: md.ath_change_percentage?.usd || null,
              atl: md.atl?.usd || null,
              atlDate: md.atl_date?.usd || null,
              priceChange24h: md.price_change_percentage_24h || null,
              priceChange7d: md.price_change_percentage_7d || null,
              priceChange30d: md.price_change_percentage_30d || null,
              priceChange1y: md.price_change_percentage_1y || null,
              fullyDilutedValuation: md.fully_diluted_valuation?.usd || null,
              categories: cgData.categories || [],
              genesisDate: cgData.genesis_date || null,
              hashingAlgorithm: cgData.hashing_algorithm || null,
              homepage: cgData.links?.homepage?.[0] || null,
              // Community
              twitterFollowers: cgData.community_data?.twitter_followers || null,
              redditSubscribers: cgData.community_data?.reddit_subscribers || null,
              redditActiveAccounts: cgData.community_data?.reddit_accounts_active_48h || null,
              telegramUsers: cgData.community_data?.telegram_channel_user_count || null,
              // Developer
              githubForks: cgData.developer_data?.forks || null,
              githubStars: cgData.developer_data?.stars || null,
              githubSubscribers: cgData.developer_data?.subscribers || null,
              githubTotalIssues: cgData.developer_data?.total_issues || null,
              githubClosedIssues: cgData.developer_data?.closed_issues || null,
              githubPullRequestsMerged: cgData.developer_data?.pull_requests_merged || null,
              githubCommit4Weeks: cgData.developer_data?.commit_count_4_weeks || null,
              codeAdditions4Weeks: cgData.developer_data?.code_additions_deletions_4_weeks?.additions || null,
              codeDeletions4Weeks: cgData.developer_data?.code_additions_deletions_4_weeks?.deletions || null,
              // Extra market
              sentimentVotesUp: cgData.sentiment_votes_up_percentage || null,
              sentimentVotesDown: cgData.sentiment_votes_down_percentage || null,
              watchlistUsers: cgData.watchlist_portfolio_users || null,
              // Team & Links
              repos: cgData.links?.repos_url?.github || [],
              blockchain_site: cgData.links?.blockchain_site?.filter(s => s && s.length > 0).slice(0, 3) || [],
              official_forum: cgData.links?.official_forum_url?.filter(s => s && s.length > 0).slice(0, 2) || [],
              subreddit: cgData.links?.subreddit_url || null,
              twitter: cgData.links?.twitter_screen_name || null,
              telegram: cgData.links?.telegram_channel_identifier || null
            };

            // Fetch crypto news from CryptoCompare
            try {
              const newsUrl = `https://min-api.cryptocompare.com/data/v2/news/?categories=${encodeURIComponent(displayName)}&limit=5`;
              const newsRaw = execSync(`curl -s "${newsUrl}" -H "User-Agent: Mozilla/5.0"`, { timeout: 10000, encoding: 'utf8' });
              const newsData = JSON.parse(newsRaw);
              fundamentals.news = (newsData.Data || []).slice(0, 5).map(n => ({
                title: n.title,
                source: n.source,
                date: new Date(n.published_on * 1000).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' }),
                url: n.url,
                sentiment: n.sentiment
              }));
            } catch(e) { /* no crypto news */ }
          }
        } else {
          // Yahoo Finance voor stock fundamentals
          try {
            const yUrl = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
            const yRaw = execSync(`curl -s "${yUrl}" -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"`, { timeout: 10000, encoding: 'utf8' });
            const yData = JSON.parse(yRaw);
            if (yData.chart && yData.chart.result && yData.chart.result.length > 0) {
              const meta = yData.chart.result[0].meta;
              fundamentals = {
                type: 'stock',
                name: meta.longName || meta.shortName || displayName,
                symbol: symbol,
                exchange: meta.exchangeName || meta.fullExchangeName || '—',
                currency: meta.currency || 'USD',
                marketCap: meta.marketCap || null,
                regularMarketPrice: meta.regularMarketPrice || null,
                previousClose: meta.chartPreviousClose || meta.previousClose || null,
                fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh || null,
                fiftyTwoWeekLow: meta.fiftyTwoWeekLow || null,
                regularMarketVolume: meta.regularMarketVolume || null
              };
            }
          } catch(e) { /* no fundamentals */ }

          // Try to get additional quote data for stocks (vereist crumb + cookie auth)
          if (fundamentals) {
            try {
              // Stap 1: Haal Yahoo Finance cookie + crumb op
              execSync('curl -s -c /tmp/yf_cookies.txt "https://fc.yahoo.com" -H "User-Agent: Mozilla/5.0"', { timeout: 5000 });
              const crumb = execSync('curl -s -b /tmp/yf_cookies.txt "https://query2.finance.yahoo.com/v1/test/getcrumb" -H "User-Agent: Mozilla/5.0"', { timeout: 5000, encoding: 'utf8' }).trim();
              // Stap 2: Gebruik crumb + cookie voor quoteSummary
              const quoteUrl = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=summaryDetail,defaultKeyStatistics,financialData&crumb=${encodeURIComponent(crumb)}`;
              const quoteRaw = execSync(`curl -s -b /tmp/yf_cookies.txt "${quoteUrl}" -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"`, { timeout: 10000, encoding: 'utf8' });
              const quoteData = JSON.parse(quoteRaw);
              const sd = quoteData?.quoteSummary?.result?.[0]?.summaryDetail || {};
              const ks = quoteData?.quoteSummary?.result?.[0]?.defaultKeyStatistics || {};
              const fd = quoteData?.quoteSummary?.result?.[0]?.financialData || {};

              fundamentals.peRatio = sd.trailingPE?.raw || null;
              fundamentals.forwardPE = sd.forwardPE?.raw || null;
              fundamentals.eps = ks.trailingEps?.raw || null;
              fundamentals.dividendYield = sd.dividendYield?.raw || null;
              fundamentals.dividendRate = sd.dividendRate?.raw || null;
              fundamentals.beta = sd.beta?.raw || ks.beta?.raw || null;
              fundamentals.bookValue = ks.bookValue?.raw || null;
              fundamentals.priceToBook = ks.priceToBook?.raw || null;
              fundamentals.profitMargin = ks.profitMargins?.raw || fd.profitMargins?.raw || null;
              fundamentals.revenueGrowth = fd.revenueGrowth?.raw || null;
              fundamentals.earningsGrowth = fd.earningsGrowth?.raw || null;
              fundamentals.debtToEquity = fd.debtToEquity?.raw || null;
              fundamentals.returnOnEquity = fd.returnOnEquity?.raw || null;
              fundamentals.returnOnAssets = fd.returnOnAssets?.raw || null;
              fundamentals.operatingMargin = fd.operatingMargins?.raw || null;
              fundamentals.targetMeanPrice = fd.targetMeanPrice?.raw || null;
              fundamentals.recommendation = fd.recommendationKey || null;
              fundamentals.numberOfAnalysts = fd.numberOfAnalystOpinions?.raw || null;
            } catch(e) { /* no additional data */ }
          }

          // Fetch stock news from Google News RSS
          try {
            const gnUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(symbol + ' stock')}&hl=nl&gl=NL&ceid=NL:nl`;
            const gnRaw = execSync(`curl -s "${gnUrl}" -H "User-Agent: Mozilla/5.0"`, { timeout: 10000, encoding: 'utf8' });
            const items = gnRaw.match(/<item>[\s\S]*?<\/item>/g) || [];
            fundamentals.news = items.slice(0, 5).map(item => {
              const title = (item.match(/<title>(.*?)<\/title>/) || [])[1] || '';
              const source = (item.match(/<source.*?>(.*?)<\/source>/) || [])[1] || '';
              const pubDate = (item.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1] || '';
              const date = pubDate ? new Date(pubDate).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
              return { title: title.replace(/<!\[CDATA\[|\]\]>/g, ''), source, date };
            });
          } catch(e) { /* no stock news */ }
        }
      } catch(e) {
        console.warn(`Fundamentals ophalen mislukt voor ${displayName}:`, e.message);
      }
    }

    // Generate PDF met live prijs en rapport opties
    const pdfBuffer = await generatePDF(displayName, {
      monthly, fourH, weekly, ewData, signals, fundamentals
    }, livePrice, { includeAnalyse, includeFundamentals });

    // Return PDF as download
    const filename = `Merlijn_Rapport_${displayName}_${new Date().toISOString().slice(0, 10)}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Report-Wave', ewData.currentWave);
    res.setHeader('X-Report-SubWave', ewData.subWaves ? ewData.subWaves.currentSubWave : '');
    res.setHeader('X-Report-Price', fmtP(ewData.currentPrice));
    return res.status(200).send(pdfBuffer);

  } catch (err) {
    console.error('Report error:', err);
    return res.status(500).json({ error: err.message || 'Er ging iets mis bij het genereren van het rapport' });
  }
};
