// ═══ Flow Data Aggregator ═══
//
// Combineert vier gratis Binance-flow signalen tot één composite "flow score"
// per token, ∈ [-1, +1]:
//
//   +1 = sterk bullish flow  (kopers domineren, longs bouwen, OB bid-heavy)
//   -1 = sterk bearish flow  (verkopers domineren, longs vlakken af, OB ask-heavy)
//
// Componenten (elk ∈ [-1, +1], gemiddeld met gelijke weging):
//   1. Funding rate            — > 0 = overheated long → bearish bias (geinverteerd)
//   2. Top-trader L/S ratio    — > 1 = smart money long → bullish
//   3. Taker buy/sell ratio    — > 1 = aggressive buying → bullish
//   4. Order book imbalance    — bid-heavy → bullish
//
// Caching: Redis 60s TTL per token (4 fapi calls per refresh, niet hammeren).
//
// Toepassing in Camelot:
//   - LONG signal + flowScore < -0.5 → SKIP (vangst-tegen-stroom)
//   - SHORT signal + flowScore > +0.5 → SKIP
//   - "Strong agreement" trade (flowScore zelfde kant als signal) krijgt grotere size

const path = require('path');
const bn = require(path.join(__dirname, 'binance-public.js'));
let redis = null;
try { redis = require(path.join(__dirname, 'redis.js')); } catch { redis = { isConfigured: () => false }; }

const FLOW_CACHE_MS = 60 * 1000;

// Helper: clamp + linear scale into [-1, +1]
function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Funding rate normalisation: typische range ±0.01% per 8h cycle.
// Boven ±0.05% (0.0005) = extreme. Geinverteerd: hoge funding → bearish bias.
function _scoreFunding(rate) {
  if (rate == null || !isFinite(rate)) return 0;
  // Map [-0.0005, +0.0005] → [+1, -1] (inverted)
  return _clamp(-rate / 0.0005, -1, 1);
}

// Top-trader long/short ratio: 1.0 = neutraal, 2.0 = 2× zoveel longs.
// Map log-ratio [-0.5, +0.5] → [-1, +1]
function _scoreTopTrader(ratio) {
  if (ratio == null || !isFinite(ratio) || ratio <= 0) return 0;
  const logR = Math.log(ratio);
  return _clamp(logR / 0.5, -1, 1);
}

// Taker buy/sell ratio: zelfde idee.
function _scoreTaker(ratio) {
  if (ratio == null || !isFinite(ratio) || ratio <= 0) return 0;
  const logR = Math.log(ratio);
  return _clamp(logR / 0.4, -1, 1);
}

// OB imbalance is al ∈ [-1, +1].
function _scoreOb(imb) {
  if (imb == null || !isFinite(imb)) return 0;
  return _clamp(imb, -1, 1);
}

async function fetchFlowRaw(market) {
  // Parallel — alle 4 fapi calls + 1 spot depth
  const [fund, tt, tk, book] = await Promise.allSettled([
    bn.fetchFunding(market),
    bn.fetchTopTraderRatio(market, '5m', 1),
    bn.fetchTakerRatio(market, '5m', 1),
    bn.fetchBook(market, 50),
  ]);
  const funding   = fund.status === 'fulfilled' ? fund.value : null;
  const topTrader = tt.status === 'fulfilled' ? tt.value : null;
  const taker     = tk.status === 'fulfilled' ? tk.value : null;
  const ob        = book.status === 'fulfilled' ? bn.obImbalance(book.value) : null;
  return { funding, topTrader, taker, ob };
}

function computeScore(raw) {
  const sFund = _scoreFunding(raw.funding?.lastFundingRate);
  const sTT   = _scoreTopTrader(raw.topTrader?.longShortRatio);
  const sTK   = _scoreTaker(raw.taker?.buySellRatio);
  const sOB   = _scoreOb(raw.ob?.imbalance);
  const components = { funding: sFund, topTrader: sTT, taker: sTK, ob: sOB };
  // Gelijke weging, neem alleen niet-nul componenten mee zodat een uitgevallen
  // endpoint geen valse 0-bias toevoegt.
  const active = Object.values(components).filter(v => v !== 0);
  const score = active.length ? active.reduce((s, v) => s + v, 0) / active.length : 0;
  return { score, components };
}

async function getFlow(market, { useCache = true } = {}) {
  const cacheKey = `flow:${market}`;
  if (useCache && redis.isConfigured?.()) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        const c = typeof cached === 'string' ? JSON.parse(cached) : cached;
        if (Date.now() - (c._cachedAt || 0) < FLOW_CACHE_MS) return c;
      }
    } catch {}
  }
  const raw = await fetchFlowRaw(market);
  const { score, components } = computeScore(raw);
  const result = {
    market,
    score,                // [-1, +1] composite
    components,           // per-source breakdown
    raw,                  // raw values (incl. funding rate, ratios)
    _cachedAt: Date.now(),
  };
  if (useCache && redis.isConfigured?.()) {
    // redis.set() heeft geen native TTL; we filteren op _cachedAt bij read.
    try { await redis.set(cacheKey, result); } catch {}
  }
  return result;
}

// Check of een trade-signal "tegen de stroom" gaat.
// Returnt { allow, reason }.
function checkFlowFilter(signalType, flowScore, threshold = 0.5) {
  if (flowScore == null || !isFinite(flowScore)) return { allow: true, reason: 'no_flow_data' };
  if (signalType === 'BUY' && flowScore < -threshold) {
    return { allow: false, reason: `flow ${flowScore.toFixed(2)} < -${threshold} (bearish flow blocks LONG)` };
  }
  if (signalType === 'SELL' && flowScore > threshold) {
    return { allow: false, reason: `flow ${flowScore.toFixed(2)} > +${threshold} (bullish flow blocks SHORT)` };
  }
  return { allow: true, reason: 'flow_aligned' };
}

module.exports = {
  getFlow,
  computeScore,
  checkFlowFilter,
  fetchFlowRaw,
  _scorers: { _scoreFunding, _scoreTopTrader, _scoreTaker, _scoreOb },
};
