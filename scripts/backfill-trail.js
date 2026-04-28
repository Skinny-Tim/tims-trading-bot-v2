#!/usr/bin/env node
/**
 * ═══ One-shot backfill: voeg 'trail' veld toe aan bestaande closed trades ═══
 *
 * Loopt `portfolio:trades` af, vindt trades zónder trail-data, en reconstrueert
 * initialStop / target / target1 / peakPrice / peakPct via historische 4H candles.
 *
 * Usage:
 *   1. `vercel env pull .env.local`      (haalt REDIS_URL of UPSTASH keys binnen)
 *   2. `node scripts/backfill-trail.js`  (script leest .env.local automatisch)
 *
 * Idempotent: trades met een al-bestaand `trail.initialStop` veld worden
 * overgeslagen. Backfilled trades krijgen `trail._reconstructed = true` vlag
 * zodat je in de code kunt filteren op live vs reconstructed data.
 */

const fs = require('fs');
const path = require('path');

// ── Laad .env.prod of .env.local indien aanwezig ──
// .env.prod heeft voorrang (bevat REDIS_URL — gepulled via `vercel env pull
// --environment=production .env.prod`). .env.local heeft meestal alleen
// development vars (OIDC token) dus dat werkt niet voor Redis.
(function loadEnvFiles() {
  for (const name of ['.env.prod', '.env.local']) {
    const envPath = path.join(__dirname, '..', name);
    if (!fs.existsSync(envPath)) continue;
    const raw = fs.readFileSync(envPath, 'utf-8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?(.*?)"?\s*$/i);
      if (!m) continue;
      if (!process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
})();

const redis = require('../api/_lib/redis');
const signals = require('../api/_lib/signals');

const TOKENS = [
  { symbol: 'BTCUSDT',  short: 'BTC',  market: 'BTC-EUR' },
  { symbol: 'ETHUSDT',  short: 'ETH',  market: 'ETH-EUR' },
  { symbol: 'SOLUSDT',  short: 'SOL',  market: 'SOL-EUR' },
  { symbol: 'BNBUSDT',  short: 'BNB',  market: 'BNB-EUR' },
  { symbol: 'HBARUSDT', short: 'HBAR', market: 'HBAR-EUR' },
  { symbol: 'XRPUSDT',  short: 'XRP',  market: 'XRP-EUR' }
];
const tokenMap = Object.fromEntries(TOKENS.map(t => [t.short, t]));

async function main() {
  if (!redis.isConfigured()) {
    console.error('❌ Redis niet geconfigureerd. Run eerst: vercel env pull .env.local');
    process.exit(1);
  }

  const trades = await redis.lrange('portfolio:trades', 0, 999);
  console.log(`\n📦 Geladen: ${trades.length} trades uit portfolio:trades\n`);

  // Groepeer fetches per token (1x per token i.p.v. per trade)
  const candleCache = {};
  const neededTokens = new Set(trades.filter(t => !t.trail).map(t => t.token));
  for (const tk of neededTokens) {
    const tokInfo = tokenMap[tk];
    if (!tokInfo) { console.warn(`⚠ ${tk}: niet in TOKENS map, skip`); continue; }
    try {
      candleCache[tk] = await signals.fetchCandles(tokInfo, '4h', 500);
      console.log(`  ✓ ${tk}: ${candleCache[tk]?.length || 0} candles opgehaald`);
    } catch (e) {
      console.warn(`  ✗ ${tk}: fetch failed — ${e.message}`);
    }
  }
  console.log();

  let reconstructed = 0, skipped = 0, failed = 0;

  for (const t of trades) {
    if (t.trail && t.trail.initialStop != null) { skipped++; continue; }
    const candles = candleCache[t.token];
    if (!candles || candles.length < 30) { failed++; continue; }

    // Candle at or before openTime — dit is wat de engine zag toen het signaal fired
    // (laatste gesloten 4H candle ≤ openTime). We gebruiken alle candles t/m die
    // index om calc4hLevels aan te roepen (recomputing wat levels was bij open).
    let openIdx = -1;
    for (let i = candles.length - 1; i >= 0; i--) {
      if (candles[i].time <= t.openTime) { openIdx = i; break; }
    }
    if (openIdx < 30) { failed++; continue; }

    const candlesForLevels = candles.slice(0, openIdx + 1);
    const signalType = t.side === 'LONG' ? 'BUY' : 'SELL';
    // Kronos data ontbreekt historisch — levels worden zonder kronos boost berekend.
    // Acceptabel voor backfill: initialStop/target zijn ATR-based fallback zonder kronos.
    const levels = signals.calc4hLevels(candlesForLevels, signalType, { offline: true });

    // Peak favorable excursion — scan candles in [openTime, closeTime]
    let peakPrice = t.entryPrice;
    for (const c of candles) {
      if (c.time < t.openTime || c.time > t.closeTime) continue;
      if (t.side === 'LONG' && c.high > peakPrice) peakPrice = c.high;
      if (t.side === 'SHORT' && (c.low < peakPrice || peakPrice === t.entryPrice)) peakPrice = c.low;
    }
    const peakPct = t.side === 'LONG'
      ? ((peakPrice - t.entryPrice) / t.entryPrice) * 100
      : ((t.entryPrice - peakPrice) / t.entryPrice) * 100;

    // Target1 zoals paper-engine berekent: 60% van weg naar target
    const target1 = t.side === 'LONG'
      ? t.entryPrice + (levels.uitstap - t.entryPrice) * 0.6
      : t.entryPrice - (t.entryPrice - levels.uitstap) * 0.6;

    // Voor stop-closes is exitPrice ≈ de finale (getrailde of originele) stop.
    // Voor target/partial closes is er geen "final stop" relevant.
    const isStop = /stop/i.test(t.reason || '');
    const finalStop = isStop ? t.exitPrice : null;

    // Breakeven inferentie: activatie gebeurde als peak ≥ 1 ATR in gunstige richting
    const atrDist = t.side === 'LONG'
      ? peakPrice - t.entryPrice
      : t.entryPrice - peakPrice;
    const breakevenLikely = atrDist >= levels.atr * 1.0;   // BREAKEVEN_ATR = 1.0

    t.trail = {
      initialStop: levels.stop,
      finalStop,
      target: levels.uitstap,
      target1,
      breakeven: breakevenLikely,
      peakPrice,
      peakPct,
      atr: levels.atr,
      _reconstructed: true
    };
    reconstructed++;
    console.log(`  ✓ ${t.token} ${t.side} ${new Date(t.closeTime).toISOString().slice(0,16)} | peak ${peakPrice.toFixed(4)} (${peakPct >= 0 ? '+' : ''}${peakPct.toFixed(2)}%) | iSL ${levels.stop.toFixed(4)} fSL ${finalStop != null ? finalStop.toFixed(4) : '-'} | BE ${breakevenLikely ? '✓' : '✗'}`);
  }

  console.log(`\n📊 Resultaat: ${reconstructed} reconstructed · ${skipped} al ok · ${failed} failed\n`);

  if (reconstructed === 0) {
    console.log('ℹ Niets om te schrijven, afsluiten.');
    await redis.quit();
    return;
  }

  // Herschrijf beide lijsten (portfolio:trades en legacy paper:trades)
  // Volgorde: lrange gaf newest→oldest; om hetzelfde resultaat na lpush te
  // krijgen, pushen we in omgekeerde volgorde (oldest first, newest last).
  console.log('💾 Schrijven naar Redis...');
  await redis.del('portfolio:trades');
  for (let i = trades.length - 1; i >= 0; i--) {
    await redis.lpush('portfolio:trades', trades[i]);
  }
  console.log('  ✓ portfolio:trades herschreven');

  await redis.del('paper:trades');
  for (let i = trades.length - 1; i >= 0; i--) {
    await redis.lpush('paper:trades', trades[i]);
  }
  console.log('  ✓ paper:trades (legacy mirror) herschreven');

  console.log('\n✅ Backfill compleet. Refresh je dashboard om de details te zien.\n');
  await redis.quit();
}

main().catch(e => {
  console.error('❌ Backfill fout:', e);
  process.exit(1);
});
