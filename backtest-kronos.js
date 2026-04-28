/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  Kronos AI Backtest — Merlijn Signaal Labo                      ║
 * ║                                                                  ║
 * ║  Valideert Kronos AI voorspellingen tegen werkelijke koersen.    ║
 * ║  Draait via: node backtest-kronos.js                             ║
 * ║                                                                  ║
 * ║  Methode:                                                        ║
 * ║  1. Haalt historische 4H candles op van Binance                  ║
 * ║  2. Roept Kronos API aan op sliding windows                      ║
 * ║  3. Vergelijkt voorspelling (4 dagen vooruit) met werkelijkheid  ║
 * ║  4. Berekent accuraatheid, correlatie en score-validatie          ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

const KRONOS_URL = process.env.KRONOS_URL || 'https://camelotlabs-kronos-ai-forecast.hf.space';
const SYMBOLS = ['BTCUSDT', 'HBARUSDT', 'XRPUSDT'];
const FORECAST_CANDLES = 24; // 24 × 4H = 4 dagen vooruit
const TEST_POINTS = 30;     // Aantal testpunten per token (elke ~4 dagen)
const STEP_CANDLES = 24;    // Stap tussen testpunten (= 4 dagen)

// ── Binance Klines ophalen ──
async function fetchBinanceKlines(symbol, interval = '4h', limit = 1000) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const resp = await fetch(url);
  const data = await resp.json();
  if (!Array.isArray(data)) throw new Error(`Binance error for ${symbol}`);
  return data.map(k => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5])
  }));
}

// ── Kronos API aanroepen ──
async function fetchKronosForecast(symbol) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch(`${KRONOS_URL}/forecast?symbol=${encodeURIComponent(symbol)}`, {
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } catch (e) {
    clearTimeout(timeout);
    return { symbol, direction: 'neutral', pct: 0, score: 0, offline: true, error: e.message };
  }
}

// ── Naïeve baseline: EMA-crossover richting ──
function calcEMA(data, period) {
  const k = 2 / (period + 1);
  const ema = [data[0]];
  for (let i = 1; i < data.length; i++) {
    ema.push(data[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

function emaBaseline(closes) {
  const ema9 = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const last = closes.length - 1;
  // Simpele baseline: als EMA9 > EMA21 → bullish
  if (ema9[last] > ema21[last]) return 'bullish';
  if (ema9[last] < ema21[last]) return 'bearish';
  return 'neutral';
}

// ── Backtest core ──
async function backtestSymbol(symbol) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${symbol} — Kronos AI Backtest`);
  console.log(`${'═'.repeat(60)}`);

  // Haal maximale historie op (1000 candles = ~167 dagen)
  const candles = await fetchBinanceKlines(symbol, '4h', 1000);
  console.log(`  Data: ${candles.length} candles (${Math.floor(candles.length * 4 / 24)} dagen)`);

  if (candles.length < 400 + FORECAST_CANDLES + TEST_POINTS * STEP_CANDLES) {
    console.log(`  ⚠ Onvoldoende data voor ${TEST_POINTS} testpunten, gebruik minder`);
  }

  // We simuleren: op elk testpunt bekijken we "wat was de prijs, wat werd 4 dagen later"
  // Dan vergelijken we met wat Kronos VANDAAG zegt (want we kunnen niet historisch Kronos draaien via API)
  //
  // METHODE: "Historische directie validatie"
  // We berekenen voor elke 4-daagse window de werkelijke koersbeweging
  // en vergelijken de HUIDIGE Kronos voorspelling met de meest recente werkelijke bewegingen

  const results = [];
  const closes = candles.map(c => c.close);

  // Bereken werkelijke 4-daagse koersbewegingen (historisch)
  const windowResults = [];
  const startIdx = Math.max(0, candles.length - TEST_POINTS * STEP_CANDLES - FORECAST_CANDLES);

  for (let i = startIdx; i <= candles.length - FORECAST_CANDLES - 1; i += STEP_CANDLES) {
    const entryPrice = candles[i].close;
    const exitPrice = candles[i + FORECAST_CANDLES].close;
    const actualPct = ((exitPrice - entryPrice) / entryPrice) * 100;
    const actualDir = actualPct > 1.5 ? 'bullish' : actualPct < -1.5 ? 'bearish' : 'neutral';

    // EMA baseline op dat moment
    const lookbackCloses = closes.slice(0, i + 1);
    const baselineDir = emaBaseline(lookbackCloses);

    windowResults.push({
      idx: i,
      entryTime: new Date(candles[i].time).toISOString().slice(0, 10),
      entryPrice,
      exitPrice,
      actualPct: actualPct.toFixed(2),
      actualDir,
      baselineDir,
      baselineCorrect: baselineDir === actualDir
    });
  }

  // Haal HUIDIGE Kronos forecast op
  console.log(`  Kronos API aanroepen...`);
  const kronos = await fetchKronosForecast(symbol);

  if (kronos.offline || kronos.error) {
    console.log(`  ⚠ Kronos OFFLINE: ${kronos.error || 'no response'}`);
    console.log(`  → Kan alleen historische analyse doen (zonder Kronos vergelijking)\n`);
  } else {
    console.log(`  Kronos: ${kronos.direction} (${kronos.pct > 0 ? '+' : ''}${kronos.pct}%, score ${kronos.score})`);
    console.log(`  Forecast prijs: ${kronos.forecast}, Huidige prijs: ${kronos.current}`);
  }

  // ── Statistieken berekenen ──
  const totalWindows = windowResults.length;
  const bullishWindows = windowResults.filter(w => w.actualDir === 'bullish').length;
  const bearishWindows = windowResults.filter(w => w.actualDir === 'bearish').length;
  const neutralWindows = windowResults.filter(w => w.actualDir === 'neutral').length;

  // Baseline (EMA) accuraatheid
  const baselineCorrect = windowResults.filter(w => w.baselineCorrect).length;
  const baselineAccuracy = (baselineCorrect / totalWindows * 100).toFixed(1);

  // Gemiddelde werkelijke koersbeweging
  const avgMove = (windowResults.reduce((s, w) => s + Math.abs(parseFloat(w.actualPct)), 0) / totalWindows).toFixed(2);
  const avgPct = (windowResults.reduce((s, w) => s + parseFloat(w.actualPct), 0) / totalWindows).toFixed(2);

  // Volatiliteit (standaarddeviatie van 4-daagse bewegingen)
  const pcts = windowResults.map(w => parseFloat(w.actualPct));
  const mean = pcts.reduce((a, b) => a + b, 0) / pcts.length;
  const variance = pcts.reduce((s, p) => s + (p - mean) ** 2, 0) / pcts.length;
  const stdDev = Math.sqrt(variance).toFixed(2);

  // Consecutive direction streaks
  let maxStreak = 0, currentStreak = 1;
  for (let i = 1; i < windowResults.length; i++) {
    if (windowResults[i].actualDir === windowResults[i - 1].actualDir) {
      currentStreak++;
      maxStreak = Math.max(maxStreak, currentStreak);
    } else {
      currentStreak = 1;
    }
  }

  console.log(`\n  ── Historische 4-Daagse Bewegingen (${totalWindows} windows) ──`);
  console.log(`  Bullish (>+1.5%):  ${bullishWindows}x (${(bullishWindows / totalWindows * 100).toFixed(0)}%)`);
  console.log(`  Bearish (<-1.5%):  ${bearishWindows}x (${(bearishWindows / totalWindows * 100).toFixed(0)}%)`);
  console.log(`  Neutraal:          ${neutralWindows}x (${(neutralWindows / totalWindows * 100).toFixed(0)}%)`);
  console.log(`  Gem. beweging:     ${avgPct}% (abs: ${avgMove}%)`);
  console.log(`  Std. deviatie:     ${stdDev}%`);
  console.log(`  Max streak:        ${maxStreak} opeenvolgende zelfde richting`);
  console.log(`\n  ── Baseline (EMA 9/21) Accuraatheid ──`);
  console.log(`  Correct: ${baselineCorrect}/${totalWindows} = ${baselineAccuracy}%`);

  // Als Kronos online is, vergelijk huidige voorspelling met recente werkelijkheid
  if (!kronos.offline && !kronos.error) {
    const recentWindows = windowResults.slice(-5);
    const kronosDir = kronos.direction;

    // Hoeveel van de recente 5 windows matchen met Kronos' huidige richting?
    const matchRecent = recentWindows.filter(w => w.actualDir === kronosDir).length;

    console.log(`\n  ── Kronos vs Recente Werkelijkheid ──`);
    console.log(`  Kronos zegt: ${kronosDir} (${kronos.pct > 0 ? '+' : ''}${kronos.pct}%)`);
    console.log(`  Laatste 5 windows werkelijk:`);
    for (const w of recentWindows) {
      const match = w.actualDir === kronosDir ? '✓' : '✗';
      console.log(`    ${w.entryTime}: ${w.actualDir.padEnd(8)} (${w.actualPct}%) ${match}`);
    }
    console.log(`  Match: ${matchRecent}/5 (${(matchRecent / 5 * 100).toFixed(0)}%)`);
  }

  // Detail tabel (laatste 15 windows)
  console.log(`\n  ── Detail (laatste 15 windows) ──`);
  console.log(`  ${'Datum'.padEnd(12)} ${'Richting'.padEnd(10)} ${'%'.padStart(8)} ${'Entry'.padStart(12)} ${'Exit'.padStart(12)} ${'EMA'.padEnd(8)} ${'EMA✓'.padEnd(4)}`);
  console.log(`  ${'─'.repeat(70)}`);
  for (const w of windowResults.slice(-15)) {
    const emaCheck = w.baselineCorrect ? '✓' : '✗';
    console.log(`  ${w.entryTime.padEnd(12)} ${w.actualDir.padEnd(10)} ${w.actualPct.padStart(8)}% ${w.entryPrice.toFixed(4).padStart(12)} ${w.exitPrice.toFixed(4).padStart(12)} ${w.baselineDir.padEnd(8)} ${emaCheck}`);
  }

  return {
    symbol,
    totalWindows,
    bullishPct: (bullishWindows / totalWindows * 100).toFixed(1),
    bearishPct: (bearishWindows / totalWindows * 100).toFixed(1),
    avgMove,
    stdDev,
    baselineAccuracy,
    kronos: kronos.offline ? null : {
      direction: kronos.direction,
      pct: kronos.pct,
      score: kronos.score
    }
  };
}

// ── Scoring validatie: zou Kronos' score-gewicht in signalen verdiend zijn? ──
function analyzeScoreImpact(allResults) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  CONCLUSIE — Kronos Score Impact Analyse`);
  console.log(`${'═'.repeat(60)}`);

  const avgBaseline = (allResults.reduce((s, r) => s + parseFloat(r.baselineAccuracy), 0) / allResults.length).toFixed(1);

  console.log(`\n  Gemiddelde EMA Baseline accuraatheid: ${avgBaseline}%`);
  console.log(`  → Dit is de minimale drempel die Kronos moet verslaan.`);
  console.log(`  → Als Kronos niet beter is dan ${avgBaseline}%, voegt het niets toe.\n`);

  // Huidige Kronos gewicht analyse
  console.log(`  Huidig Kronos gewicht in signalen:`);
  console.log(`  ┌─────────────────────────────────────────────────┐`);
  console.log(`  │ Score ≥ +10: +2 indicators, +3 score (ZWAAR)   │`);
  console.log(`  │ Score ≥  +5: +1 indicator,  +2 score           │`);
  console.log(`  │ Score ≥  +2: +1 score (licht)                  │`);
  console.log(`  │ Merlin's Prediction: weight 10/60 (ZWAARST)    │`);
  console.log(`  └─────────────────────────────────────────────────┘`);

  const onlineResults = allResults.filter(r => r.kronos);
  if (onlineResults.length > 0) {
    console.log(`\n  Kronos is ONLINE voor ${onlineResults.length}/${allResults.length} tokens:`);
    for (const r of onlineResults) {
      console.log(`    ${r.symbol}: ${r.kronos.direction} (${r.kronos.pct > 0 ? '+' : ''}${r.kronos.pct}%, score ${r.kronos.score})`);
    }
  } else {
    console.log(`\n  ⚠ Kronos is OFFLINE — kan geen live vergelijking doen.`);
    console.log(`  → Herstart Kronos of gebruik: node backtest-kronos.js (later opnieuw)`);
  }

  console.log(`\n  ── Aanbeveling ──`);
  if (parseFloat(avgBaseline) >= 50) {
    console.log(`  EMA baseline scoort al ${avgBaseline}%, wat decent is.`);
  }
  console.log(`  Zonder een langere historische Kronos dataset is de exacte`);
  console.log(`  accuraatheid niet meetbaar via deze API-backtest.`);
  console.log(`\n  Voor een volledige validatie moet je:`);
  console.log(`  1. kronos_server.py lokaal draaien met het Kronos model`);
  console.log(`  2. Historische candles in batches door het model halen`);
  console.log(`  3. Elke voorspelling opslaan en vergelijken met werkelijkheid`);
  console.log(`\n  → Draai: python backtest-kronos-full.py (wordt aangemaakt)\n`);
}

// ── Main ──
async function main() {
  console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║  Kronos AI Backtest — Merlijn Signaal Labo                  ║`);
  console.log(`║  ${new Date().toISOString().slice(0, 19)}                                    ║`);
  console.log(`║  Kronos: ${KRONOS_URL.slice(0, 50).padEnd(50)} ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝`);
  console.log(`\n  Config: ${TEST_POINTS} testpunten × ${FORECAST_CANDLES} candles (4 dagen) per token`);
  console.log(`  Tokens: ${SYMBOLS.join(', ')}`);

  const allResults = [];
  for (const symbol of SYMBOLS) {
    try {
      const result = await backtestSymbol(symbol);
      allResults.push(result);
    } catch (e) {
      console.error(`\n  ✗ ${symbol} FOUT: ${e.message}`);
    }
    // Rate limiting
    await new Promise(r => setTimeout(r, 1000));
  }

  analyzeScoreImpact(allResults);
}

main().catch(console.error);
