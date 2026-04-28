// ═══ Backtest-parity endpoint ═══
// Draait de LIVE paper-engine logica (via api/_lib/sim.js) op historische
// candles. Als dit endpoint iets anders zegt dan paper-engine live doet is er
// drift — dan is er een bug in of sim.js of paper-engine.js.
//
// Gebruikt IDENTIEKE:
//   - signals.js  (generateSignals, detectElliottWave, calc4hLevels)
//   - fills.js    (slippage, fee, latency)
//   - sim.js      (entry/manage/exit logic = kopie van paper-engine flow)
//   - ew-params.json (getunede pivotLen/provisionalLen)
//
// Query:
//   GET /api/backtest-parity?tokens=BTC,ETH,SOL&timeframe=4h&limit=500
//
// Response: { trades, equityCurve, stats, config }

const { fetchCandles, fetchKronos, detectElliottWave, loadEwParams } = require('./_lib/signals');
const { simulateRun, DEFAULT_CFG } = require('./_lib/sim');

const ALL_TOKENS = [
  { symbol: 'BTCUSDT',  short: 'BTC' },
  { symbol: 'ETHUSDT',  short: 'ETH' },
  { symbol: 'SOLUSDT',  short: 'SOL' },
  { symbol: 'BNBUSDT',  short: 'BNB' },
  { symbol: 'HBARUSDT', short: 'HBAR' },
  { symbol: 'XRPUSDT',  short: 'XRP' },
  { symbol: 'AVAXUSDT', short: 'AVAX' },
  { symbol: 'LINKUSDT', short: 'LINK' },
  { symbol: 'ADAUSDT',  short: 'ADA' },
  { symbol: 'DOTUSDT',  short: 'DOT' },
  { symbol: 'POLUSDT',  short: 'POL' },
  { symbol: 'DOGEUSDT', short: 'DOGE' },
  { symbol: 'SUIUSDT',  short: 'SUI' },
  { symbol: 'TRXUSDT',  short: 'TRX' },
  { symbol: 'XLMUSDT',  short: 'XLM' }
];

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const requested = (url.searchParams.get('tokens') || 'BTC,ETH,SOL,HBAR,XRP').split(',').map(s => s.trim().toUpperCase());
    const limit = Math.min(1000, parseInt(url.searchParams.get('limit') || '500', 10));
    const tokens = ALL_TOKENS.filter(t => requested.includes(t.short));

    // Query overrides for A/B testing strategy knobs
    const cfgOverride = {};
    const num = (k, parser=parseFloat) => { const v = url.searchParams.get(k); if (v != null && v !== '') cfgOverride[k.replace('cfg_','')] = parser(v); };
    num('cfg_minRR'); num('cfg_riskPerTrade'); num('cfg_maxPositions', parseInt);
    num('cfg_maxCryptoLongs', parseInt); num('cfg_kronosVetoPct'); num('cfg_breakevenAtr');
    num('cfg_trailAtrBase'); num('cfg_maxHoldHours', parseInt); num('cfg_volatilityMaxAtrPct');
    // Optional: minStars override (sim hardcodes 4 in `if (sig.stars < 4 && rr < C.minRR)`)
    const minStarsOverride = parseInt(url.searchParams.get('cfg_minStars') || '0', 10);
    if (minStarsOverride > 0) cfgOverride.minStars = minStarsOverride;
    // Hardening toggles
    const blOverride = url.searchParams.get('cfg_blacklist');
    if (blOverride != null) cfgOverride.blacklist = blOverride.trim() === '' ? [] : blOverride.split(',').map(s=>s.trim().toUpperCase()).filter(Boolean);
    const mtfOverride = url.searchParams.get('cfg_mtf');
    if (mtfOverride != null) cfgOverride.mtfAlignment = mtfOverride === '1' || mtfOverride.toLowerCase() === 'true';
    const ema200Override = url.searchParams.get('cfg_ema200');
    if (ema200Override != null) cfgOverride.ema200Regime = ema200Override === '1' || ema200Override.toLowerCase() === 'true';
    const killOverride = url.searchParams.get('cfg_kill');
    if (killOverride != null) cfgOverride.portfolioKillDdPct = parseFloat(killOverride);
    const cashOverride = url.searchParams.get('cfg_cash');
    if (cashOverride != null) cfgOverride.cashBufferPct = parseFloat(cashOverride);

    const ewP = loadEwParams();
    const perToken = {};
    const ewPerToken = {};

    for (const t of tokens) {
      const [candles, kronos] = await Promise.all([
        fetchCandles(t, '4h', limit),
        fetchKronos(t.symbol),
      ]);
      if (!candles || candles.length < 60) continue;
      const ew = detectElliottWave(
        candles.map(c => c.high), candles.map(c => c.low),
        ewP.pivotLen, { token: t.short, timeframe: '4h', silent: true, provisionalLen: ewP.provisionalLen }
      );
      perToken[t.short] = { candles, kronos };
      ewPerToken[t.short] = ew;
    }

    if (Object.keys(perToken).length === 0) {
      return res.status(500).json({ error: 'no tokens fetched' });
    }

    const result = simulateRun({ perToken, ewPerToken, cfg: cfgOverride });

    return res.status(200).json({
      ok: true,
      ts: new Date().toISOString(),
      config: { ewParams: ewP, simDefaults: DEFAULT_CFG, cfgOverride, tokens: Object.keys(perToken), limit },
      stats: result.stats,
      trades: result.trades.slice(-50),           // laatste 50 trades
      equityCurve: result.equityCurve.filter((_, i, a) => i % Math.max(1, Math.floor(a.length/200)) === 0), // downsample naar ~200 punten
      finalBalance: result.finalBalance,
      openAtEnd: result.openAtEnd,
    });

  } catch (e) {
    console.error('[backtest-parity]', e.message);
    return res.status(500).json({ error: e.message });
  }
};
