/**
 * ═══ EW TUNER ═══
 * Weekly self-improving Elliott Wave parameter agent.
 *
 * 1. Loads current EW params from ew-params.json
 * 2. Generates perturbation variants around current params
 * 3. For each variant: walking-window backtest across 6 tokens × 500 4H candles
 *    - At each step t, compute EW; then measure forward N-bar return
 *    - Score = Σ (signed forward return × confidence × expectedDirection(wave))
 *      where W1/W3/W5 expect +return, W2/W4/A/C expect −return, B neutral
 * 4. If winner beats baseline by +5% AND stable trade-count, commit via GitHub API
 * 5. Push audit report to ntfy
 *
 * Route: GET /api/ew-tuner  (cron: 0 3 * * 1 — Monday 03:00 UTC)
 */

const { detectElliottWave, fetchBinanceKlines, fetchBitvavoCandles } = require('./_lib/signals');

const TOKENS = [
  { symbol: 'BTCUSDT', market: 'BTC-EUR', short: 'BTC' },
  { symbol: 'ETHUSDT', market: 'ETH-EUR', short: 'ETH' },
  { symbol: 'SOLUSDT', market: 'SOL-EUR', short: 'SOL' },
  { symbol: 'BNBUSDT', market: 'BNB-EUR', short: 'BNB' },
  { symbol: 'HBARUSDT', market: 'HBAR-EUR', short: 'HBAR' },
  { symbol: 'XRPUSDT',  market: 'XRP-EUR',  short: 'XRP'  },
  { symbol: 'AVAXUSDT', market: 'AVAX-EUR', short: 'AVAX' },
  { symbol: 'LINKUSDT', market: 'LINK-EUR', short: 'LINK' },
  { symbol: 'ADAUSDT',  market: 'ADA-EUR',  short: 'ADA'  },
  { symbol: 'DOTUSDT',  market: 'DOT-EUR',  short: 'DOT'  },
  { symbol: 'POLUSDT',  market: 'POL-EUR',  short: 'POL'  },
  { symbol: 'DOGEUSDT', market: 'DOGE-EUR', short: 'DOGE' },
  // ── Universe-uitbreiding (Phase 2, 2026-04-23) ──
  // Tune EW-params ook voor de nieuwe universe — anders runnen ze op defaults
  // (suboptimal). HYPE is futures-only dus niet geschikt voor EW spot tuner.
  { symbol: 'SUIUSDT',  market: 'SUI-EUR',  short: 'SUI'  },
  { symbol: 'TRXUSDT',  market: 'TRX-EUR',  short: 'TRX'  },
  // 2026-04-23 add-on: XLM (Stellar) — Top-30, ~6yr Binance history → ruim genoeg voor EW tuning
  { symbol: 'XLMUSDT',  market: 'XLM-EUR',  short: 'XLM'  },
];

const LOOKBACK = 500;        // # 4H candles per token (~83 days)
const WARMUP = 80;           // skip first N candles (need history for EW)
const FORWARD = 20;          // bars ahead for return calc
const MIN_CONF = 0.50;       // only score calls with ≥0.5 confidence
const MIN_TRADES = 30;       // variant needs ≥30 scored calls to count
const IMPROVEMENT_THRESHOLD = 0.05; // +5% score

// Wave → expected forward direction multiplier
const DIR = { W1: +1, W3: +1, W5: +1, W2: -1, W4: -1, A: -1, B: 0, C: -1 };

function expectedDir(wave) {
  return DIR[wave] ?? 0;
}

// ── Variant generator ──
function generateVariants(current) {
  const pivots = [3, 5, 7];
  const provisionals = [2, 3];
  const variants = [];
  for (const pl of pivots) {
    for (const pr of provisionals) {
      variants.push({ pivotLen: pl, provisionalLen: pr, label: `PL${pl}_PR${pr}` });
    }
  }
  return variants;
}

// ── Backtest one variant ──
function scoreVariant(candles, variant, tokenShort) {
  const highs = candles.map(c => c.high);
  const lows  = candles.map(c => c.low);
  const closes = candles.map(c => c.close);
  let sum = 0, count = 0;
  let winners = 0, losers = 0;

  for (let t = WARMUP; t < candles.length - FORWARD; t++) {
    const hSlice = highs.slice(0, t + 1);
    const lSlice = lows.slice(0, t + 1);
    let ew;
    try {
      ew = detectElliottWave(hSlice, lSlice, variant.pivotLen, {
        token: tokenShort, timeframe: '4h', silent: true, provisionalLen: variant.provisionalLen,
      });
    } catch { continue; }
    const primary = ew.primary;
    if (!primary || primary.confidence < MIN_CONF) continue;
    const dir = expectedDir(primary.wave);
    if (dir === 0) continue;

    const p0 = closes[t], pN = closes[t + FORWARD];
    if (!p0 || !pN) continue;
    const fwdRet = (pN - p0) / p0;

    const aligned = fwdRet * dir; // positive → correct direction
    sum += aligned * primary.confidence;
    count++;
    if (aligned > 0) winners++; else losers++;
  }
  return {
    variant, score: sum / Math.max(1, count),
    trades: count, winrate: count > 0 ? winners / count : 0,
  };
}

// ── GitHub commit ──
async function commitParams(newParams, report) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) { console.warn('[ew-tuner] no GITHUB_TOKEN'); return false; }
  const REPO = 'soflabs/merlin-signal-dashboard';
  const FILE = 'ew-params.json';
  try {
    const getR = await fetch(`https://api.github.com/repos/${REPO}/contents/${FILE}`, {
      headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' },
    });
    if (!getR.ok) return false;
    const cur = await getR.json();
    const body = Buffer.from(JSON.stringify(newParams, null, 2) + '\n').toString('base64');
    const msg = `EW-tuner v${newParams._version}: ${newParams._label} (score ${newParams._scoreBaseline.toFixed(4)})`;
    const putR = await fetch(`https://api.github.com/repos/${REPO}/contents/${FILE}`, {
      method: 'PUT',
      headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: msg, content: body, sha: cur.sha,
        committer: { name: 'EW Tuner', email: 'bot@camelotlabs.be' },
      }),
    });
    return putR.ok;
  } catch (e) { console.error('[ew-tuner] commit error', e.message); return false; }
}

// ── ntfy push ──
// Aparte topic voor tuner-audits (niet merlijn-signals). Aparte env var
// zodat paper-engine topic niet per ongeluk overschreven wordt.
// Als je dit topic ook wilt reserveren op ntfy.sh Supporter: zelfde
// NTFY_TOKEN werkt voor beide reserved topics.
async function ntfyPush(title, msg) {
  const topic = process.env.NTFY_TUNER_TOPIC || 'merlijn-labo-a9c8431fe0';
  const token = (process.env.NTFY_TOKEN || '').trim();
  try {
    const headers = { Title: title, Priority: 'default', Tags: 'brain' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    await fetch(`https://ntfy.sh/${topic}`, {
      method: 'POST',
      headers,
      body: msg,
    });
  } catch (e) { console.warn('[ew-tuner] ntfy fail', e.message); }
}

// ── Main handler ──
// ── Audit handler (merged from ew-audit.js to fit Vercel Hobby 12-fn limit) ──
async function handleAudit(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
  const symbol = (req.query?.symbol || '').toString().toUpperCase();
  const tf = (req.query?.tf || '4h').toString().toLowerCase();
  if (!symbol) return res.status(400).json({ error: 'Missing symbol parameter' });
  if (!['4h', '1m', '1mo', 'monthly'].includes(tf)) return res.status(400).json({ error: 'Invalid tf — use 4h or 1M' });
  const interval = tf === '4h' ? '4h' : '1M';
  const limit = interval === '4h' ? 500 : 80;
  const TOKEN_MAP = {
    BTCUSDT:{market:'BTC-EUR',short:'BTC'}, ETHUSDT:{market:'ETH-EUR',short:'ETH'},
    SOLUSDT:{market:'SOL-EUR',short:'SOL'}, BNBUSDT:{market:'BNB-EUR',short:'BNB'},
    HBARUSDT:{market:'HBAR-EUR',short:'HBAR'}, XRPUSDT:{market:'XRP-EUR',short:'XRP'},
  };
  const tokMeta = TOKEN_MAP[symbol] || { market: null, short: symbol.replace('USDT','') };
  try {
    let candles = null;
    if (interval === '4h' && tokMeta.market) candles = await fetchBitvavoCandles(tokMeta.market, '4h', limit);
    if (!candles) candles = await fetchBinanceKlines(symbol, interval, limit);
    if (!candles || candles.length < 20) return res.status(404).json({ error: 'Insufficient candle data', symbol, timeframe: tf });
    const fs = require('fs'), path = require('path');
    let params; try { params = JSON.parse(fs.readFileSync(path.join(__dirname,'..','ew-params.json'),'utf-8')); }
    catch { params = { pivotLen: 5, provisionalLen: 2 }; }
    const ew = detectElliottWave(candles.map(c=>c.high), candles.map(c=>c.low), params.pivotLen||5,
      { token: tokMeta.short, timeframe: tf, silent: true, provisionalLen: params.provisionalLen||2 });
    return res.status(200).json({
      symbol, timeframe: tf, currentWave: ew.currentWave, status: ew.status,
      primary: ew.primary, alternate: ew.alternate,
      pivots: ew.pivots.map(p => ({ type:p.type, idx:p.idx, val:p.val, confirmed:p.confirmed })),
      rejected: ew.rejected.map(r => ({ type:r.type, wave:r.wave, rationale:r.rationale, violations:r.violations })),
      candleCount: candles.length, generatedAt: new Date().toISOString(),
    });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}

module.exports = async (req, res) => {
  // Route: /api/ew-tuner?action=audit&symbol=...  → audit (was /api/ew-audit)
  // Audit blijft public (frontend gebruikt het), tuner-run is gated.
  if ((req.query?.action || '').toLowerCase() === 'audit') return handleAudit(req, res);

  // CRON_SECRET gate — tuner committed naar GitHub, dus niet publiek triggerbaar.
  // Pattern matchent signals-cron.js + backtest-agent.js: als env gezet → enforce, anders allow (lokale dev).
  const authHeader = req.headers['authorization'];
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const started = Date.now();
  const fs = require('fs'), path = require('path');
  const PARAM_PATH = path.join(__dirname, '..', 'ew-params.json');
  let current;
  try { current = JSON.parse(fs.readFileSync(PARAM_PATH, 'utf-8')); }
  catch { current = { pivotLen: 5, provisionalLen: 2, _version: 0, _label: 'bootstrap' }; }

  // 1. Fetch candles for all tokens (with Bitvavo fallback to Binance)
  const dataset = [];
  for (const t of TOKENS) {
    let candles = null;
    try { candles = await fetchBitvavoCandles(t.market, '4h', LOOKBACK); } catch {}
    if (!candles || candles.length < WARMUP + FORWARD + 50) {
      try { candles = await fetchBinanceKlines(t.symbol, '4h', LOOKBACK); } catch {}
    }
    if (candles && candles.length >= WARMUP + FORWARD + 50) {
      dataset.push({ token: t, candles });
    }
  }
  if (dataset.length < 3) {
    return res.status(503).json({ error: 'Not enough token data', fetched: dataset.length });
  }

  // 2. Generate variants
  const variants = generateVariants(current);

  // 3. Score each variant (aggregate across tokens)
  const results = [];
  for (const v of variants) {
    let totalScore = 0, totalTrades = 0, totalWinners = 0;
    const perToken = [];
    for (const d of dataset) {
      const r = scoreVariant(d.candles, v, d.token.short);
      totalScore += r.score * r.trades; // weighted sum
      totalTrades += r.trades;
      totalWinners += r.trades * r.winrate;
      perToken.push({ token: d.token.short, ...r });
    }
    const avgScore = totalTrades > 0 ? totalScore / totalTrades : 0;
    const winrate = totalTrades > 0 ? totalWinners / totalTrades : 0;
    results.push({ ...v, score: avgScore, trades: totalTrades, winrate, perToken });
  }

  results.sort((a, b) => b.score - a.score);
  const best = results[0];
  const baseline = results.find(r => r.pivotLen === current.pivotLen && r.provisionalLen === current.provisionalLen);
  const baselineScore = baseline ? baseline.score : 0;

  // 4. Decide promotion
  const improvement = baselineScore !== 0 ? (best.score - baselineScore) / Math.abs(baselineScore) : Infinity;
  const baselineWinrate = baseline ? baseline.winrate : 0.5;
  const winrateDelta = best.winrate - baselineWinrate;
  // Fair rule: need 5%+ score improvement AND winrate ≥ baseline AND sufficient sample
  const promoted = (
    best.label !== baseline?.label &&
    best.trades >= MIN_TRADES &&
    improvement >= IMPROVEMENT_THRESHOLD &&
    winrateDelta >= 0.003 && // ≥0.3pp winrate improvement
    best.winrate >= 0.50      // never promote a losing config
  );

  const report = {
    runAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
    current: { label: current._label, pivotLen: current.pivotLen, provisionalLen: current.provisionalLen, score: baselineScore },
    best: { label: best.label, pivotLen: best.pivotLen, provisionalLen: best.provisionalLen, score: best.score, trades: best.trades, winrate: best.winrate },
    improvement,
    promoted,
    allVariants: results.map(r => ({ label: r.label, score: r.score, trades: r.trades, winrate: r.winrate })),
  };

  if (promoted) {
    const newParams = {
      _version: (current._version || 0) + 1,
      _updated: new Date().toISOString().slice(0, 10),
      _updatedBy: 'ew-tuner',
      _label: best.label,
      pivotLen: best.pivotLen,
      provisionalLen: best.provisionalLen,
      _scoreBaseline: best.score,
      _winrate: best.winrate,
      _trades: best.trades,
      _lastTunerRun: report.runAt,
    };
    const ok = await commitParams(newParams, report);
    report.committed = ok;
    if (ok) {
      await ntfyPush(
        `EW-tuner: ${current._label} → ${best.label}`,
        `Score ${baselineScore.toFixed(4)} → ${best.score.toFixed(4)} (+${(improvement*100).toFixed(1)}%)\n` +
        `Winrate ${(best.winrate*100).toFixed(1)}% over ${best.trades} calls`
      );
    }
  } else {
    await ntfyPush(
      `EW-tuner: no change`,
      `Baseline ${current._label} (${baselineScore.toFixed(4)}) remains best.\n` +
      `Top challenger: ${best.label} (${best.score.toFixed(4)})`
    );
  }

  res.status(200).json(report);
};
