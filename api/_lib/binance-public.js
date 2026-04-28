// ═══ Binance Public Data Adapter ═══
//
// Mirror van bitvavo-public.js maar tegen Binance spot. Alleen public endpoints,
// geen API key nodig. Camelot draait op deze adapter zodat we de wereld's meest
// liquide spot-venue gebruiken (lagere fees, tighter spreads, dieper boek).
//
// Binance fees (spot, 2026):
//   Taker:  0.10% = 10 bps  (0.075% met BNB-discount)
//   Maker:  0.10% = 10 bps
//
// Endpoints (allemaal public, geen auth):
//   GET /api/v3/ticker/price                      — single of all tickers
//   GET /api/v3/depth?symbol=BTCUSDT&limit=N      — orderbook
//   GET /api/v3/klines?symbol=...&interval=1h     — OHLCV candles
//   GET /api/v3/ticker/24hr                       — 24u stats
//
// Vercel kan Binance soms geo-blokken. We proberen api.binance.com → data-api → us
// fallback chain; alle drie zijn dezelfde data voor public endpoints.

const HOSTS = [
  'https://api.binance.com',
  'https://data-api.binance.vision',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
];

const BINANCE_FEES = {
  takerBps: 10,
  makerBps: 10,
};

// ── Market mapping ──
// Camelot gebruikt korte namen (BTC, ETH...) — Binance wil BTCUSDT.
function tokenToMarket(short) {
  return `${short}USDT`;
}

async function fetchJson(path, timeoutMs = 5000) {
  let lastErr = null;
  for (const host of HOSTS) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(`${host}${path}`, {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'camelot/1.0' },
      });
      clearTimeout(to);
      if (!r.ok) { lastErr = new Error(`Binance ${r.status} ${host}${path}`); continue; }
      return await r.json();
    } catch (e) {
      clearTimeout(to);
      lastErr = e;
      continue;
    }
  }
  throw lastErr || new Error('Binance unreachable');
}

// ── Ticker ──
async function fetchTicker(market) {
  const d = await fetchJson(`/api/v3/ticker/price?symbol=${market}`);
  return parseFloat(d.price);
}

async function fetchAllTickers() {
  const arr = await fetchJson(`/api/v3/ticker/price`);
  const out = {};
  for (const t of arr) out[t.symbol] = parseFloat(t.price);
  return out;
}

// ── 24u stats ──
async function fetch24h(market) {
  const d = await fetchJson(`/api/v3/ticker/24hr?symbol=${market}`);
  return {
    high: parseFloat(d.highPrice || 0),
    low:  parseFloat(d.lowPrice  || 0),
    volume:      parseFloat(d.volume      || 0),
    volumeQuote: parseFloat(d.quoteVolume || 0),
    bid:         parseFloat(d.bidPrice    || 0),
    ask:         parseFloat(d.askPrice    || 0),
    last:        parseFloat(d.lastPrice   || 0),
  };
}

// ── Orderbook ──
async function fetchBook(market, depth = 50) {
  const d = await fetchJson(`/api/v3/depth?symbol=${market}&limit=${depth}`);
  return {
    market,
    nonce: d.lastUpdateId,
    bids: (d.bids || []).map(([p, q]) => [parseFloat(p), parseFloat(q)]),
    asks: (d.asks || []).map(([p, q]) => [parseFloat(p), parseFloat(q)]),
  };
}

// ── Candles ──
// Binance: GET /api/v3/klines?symbol=BTCUSDT&interval=1h&limit=500
// Response: [openTime, open, high, low, close, volume, closeTime, quoteVol, trades, takerBuyBase, takerBuyQuote, ignore]
async function fetchCandles(market, interval = '1h', limit = 500) {
  const d = await fetchJson(`/api/v3/klines?symbol=${market}&interval=${interval}&limit=${limit}`);
  return d.map(row => ({
    time:   parseInt(row[0], 10),
    open:   parseFloat(row[1]),
    high:   parseFloat(row[2]),
    low:    parseFloat(row[3]),
    close:  parseFloat(row[4]),
    volume: parseFloat(row[5]),
  }));
}

// ── Slippage uit echt orderbook (zelfde algoritme als Bitvavo-adapter) ──
function walkBookForSize(book, sizeQuote, side, kind) {
  const isBuy = (side === 'LONG' && kind === 'ENTRY') || (side === 'SHORT' && kind === 'EXIT');
  const levels = isBuy ? book.asks : book.bids;
  if (!levels || levels.length === 0) {
    return { fillPrice: null, filled: 0, leftover: sizeQuote, levelsHit: 0, slipBps: null, error: 'empty_book' };
  }
  const refPrice = levels[0][0];
  let qtyTotal = 0, quoteTotal = 0, hit = 0;
  let quoteLeft = sizeQuote;
  for (const [price, qty] of levels) {
    if (quoteLeft <= 0) break;
    const levelQuote = price * qty;
    if (levelQuote >= quoteLeft) {
      const partialQty = quoteLeft / price;
      qtyTotal += partialQty;
      quoteTotal += partialQty * price;
      quoteLeft = 0;
      hit++;
      break;
    } else {
      qtyTotal += qty;
      quoteTotal += levelQuote;
      quoteLeft -= levelQuote;
      hit++;
    }
  }
  if (qtyTotal <= 0) return { fillPrice: null, filled: 0, leftover: sizeQuote, levelsHit: 0, slipBps: null, error: 'no_fill' };
  const fillPrice = quoteTotal / qtyTotal;
  const slipBps = Math.abs(fillPrice - refPrice) / refPrice * 10000;
  return { fillPrice, filled: sizeQuote - quoteLeft, leftover: quoteLeft, levelsHit: hit, refPrice, slipBps };
}

// ═══ Futures / flow-data endpoints ═══
// Public, geen key. fapi.binance.com is de futures-host (perp swaps).
// Wij gebruiken alleen voor *signaal*: funding rate, open interest, taker
// long/short ratio en top-trader long/short ratio. Zelfs als Camelot zelf
// spot trade, geven deze perp-flows een vroege indicatie van sentiment.

const FAPI_HOSTS = [
  'https://fapi.binance.com',
  'https://fapi1.binance.com',
  'https://fapi2.binance.com',
];

async function fetchFapi(path, timeoutMs = 5000) {
  let lastErr = null;
  for (const host of FAPI_HOSTS) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(`${host}${path}`, {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'camelot/1.0' },
      });
      clearTimeout(to);
      if (!r.ok) { lastErr = new Error(`Binance fapi ${r.status} ${host}${path}`); continue; }
      return await r.json();
    } catch (e) {
      clearTimeout(to);
      lastErr = e;
      continue;
    }
  }
  throw lastErr || new Error('Binance fapi unreachable');
}

// Funding rate: positief = longs betalen shorts (markt overheated long).
// Returnt fractie (0.0001 = 0.01% per 8h cycle).
async function fetchFunding(market) {
  const d = await fetchFapi(`/fapi/v1/premiumIndex?symbol=${market}`);
  return {
    market,
    markPrice: parseFloat(d.markPrice || 0),
    indexPrice: parseFloat(d.indexPrice || 0),
    lastFundingRate: parseFloat(d.lastFundingRate || 0),
    nextFundingTime: parseInt(d.nextFundingTime || 0, 10),
    time: parseInt(d.time || Date.now(), 10),
  };
}

// Open interest in base-asset units (BTC, ETH, etc.).
async function fetchOpenInterest(market) {
  const d = await fetchFapi(`/fapi/v1/openInterest?symbol=${market}`);
  return {
    market,
    openInterest: parseFloat(d.openInterest || 0),
    time: parseInt(d.time || Date.now(), 10),
  };
}

// Top traders long/short account ratio (laatste 5m bucket).
// > 1 = meer top-traders long, < 1 = meer short. Smart-money sentiment proxy.
async function fetchTopTraderRatio(market, period = '5m', limit = 1) {
  const d = await fetchFapi(`/futures/data/topLongShortAccountRatio?symbol=${market}&period=${period}&limit=${limit}`);
  if (!Array.isArray(d) || !d.length) return null;
  const last = d[d.length - 1];
  return {
    market,
    longShortRatio: parseFloat(last.longShortRatio || 0),
    longAccount: parseFloat(last.longAccount || 0),
    shortAccount: parseFloat(last.shortAccount || 0),
    time: parseInt(last.timestamp || Date.now(), 10),
  };
}

// Taker buy/sell volume ratio (aggressors). > 1 = market-buy domineert.
async function fetchTakerRatio(market, period = '5m', limit = 1) {
  const d = await fetchFapi(`/futures/data/takerlongshortRatio?symbol=${market}&period=${period}&limit=${limit}`);
  if (!Array.isArray(d) || !d.length) return null;
  const last = d[d.length - 1];
  return {
    market,
    buySellRatio: parseFloat(last.buySellRatio || 0),
    buyVol: parseFloat(last.buyVol || 0),
    sellVol: parseFloat(last.sellVol || 0),
    time: parseInt(last.timestamp || Date.now(), 10),
  };
}

// ═══ Order book imbalance ═══
// Som de bid- en ask-volumes binnen `pctBand` van mid-price (default 0.5%).
// Returnt imbalance ∈ [-1, +1]: +1 = volledig bid-heavy (koopdruk), -1 = ask-heavy.
function obImbalance(book, pctBand = 0.005) {
  if (!book || !book.bids?.length || !book.asks?.length) return null;
  const bestBid = book.bids[0][0];
  const bestAsk = book.asks[0][0];
  const mid = (bestBid + bestAsk) / 2;
  const lo = mid * (1 - pctBand);
  const hi = mid * (1 + pctBand);
  let bidQuote = 0, askQuote = 0;
  for (const [p, q] of book.bids) { if (p < lo) break; bidQuote += p * q; }
  for (const [p, q] of book.asks) { if (p > hi) break; askQuote += p * q; }
  const total = bidQuote + askQuote;
  if (total <= 0) return null;
  const imbalance = (bidQuote - askQuote) / total;
  return {
    imbalance,             // [-1, +1]
    bidQuote, askQuote,
    spreadBps: (bestAsk - bestBid) / mid * 10000,
    mid,
  };
}

module.exports = {
  HOSTS,
  FAPI_HOSTS,
  BINANCE_FEES,
  tokenToMarket,
  fetchTicker, fetchAllTickers, fetch24h, fetchBook, fetchCandles,
  walkBookForSize,
  // ── flow data ──
  fetchFunding, fetchOpenInterest, fetchTopTraderRatio, fetchTakerRatio,
  obImbalance,
};
