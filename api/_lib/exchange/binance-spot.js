// ═══ Binance Spot adapter ═══
//
// Wrapt Binance Spot REST API voor live order submission. Default = TESTNET.
// Mainnet enabled wanneer BINANCE_SPOT_NETWORK=mainnet expliciet gezet is.
//
// Setup TESTNET:
//   1. https://testnet.binance.vision/ → "Generate HMAC_SHA256 Key"
//   2. Set env: BINANCE_SPOT_TESTNET_KEY + BINANCE_SPOT_TESTNET_SECRET
//   3. Default 10000 USDT testnet balance ge-faucet'd
//
// Setup MAINNET:
//   1. https://www.binance.com/en/my/settings/api-management
//   2. Create API → IP whitelist je server-IP → enable "Spot Trading" only
//   3. NIET enable: Withdrawals, Margin, Futures
//   4. Set env: BINANCE_SPOT_MAINNET_KEY + BINANCE_SPOT_MAINNET_SECRET
//   5. Set env: BINANCE_SPOT_NETWORK=mainnet (gate)
//
// Gebruikt voor: Merlijn (paper_4h) live trading.
//
// Interface (alle async, throws on error met context):
//   getBalance(asset='USDT')              → number (free balance)
//   getAllBalances()                       → [{asset, free, locked}]
//   getSymbolFilters(symbol)               → {minQty, stepSize, tickSize, minNotional}
//   getTicker(symbol)                      → {bid, ask, last}
//   submitOrder({symbol, side, type, quantity, price?, stopPrice?, clientOrderId?})
//                                          → {orderId, status, filledQty, avgPrice, fees}
//   getOrder(symbol, orderId)              → same as submitOrder return
//   cancelOrder(symbol, orderId)           → {orderId, status}
//   listOpenOrders(symbol?)                → [orders]
//   getMyTrades(symbol, fromId?)           → [trades] (executed fills)

const signing = require('./_signing');
const { buildSignedUrl, buildSignedBody } = signing;

const NETWORK = (process.env.BINANCE_SPOT_NETWORK || 'testnet').toLowerCase();
const IS_TESTNET = NETWORK === 'testnet';

const BASE_URL = IS_TESTNET
  ? 'https://testnet.binance.vision'
  : 'https://api.binance.com';

const API_KEY = IS_TESTNET
  ? (process.env.BINANCE_SPOT_TESTNET_KEY || '')
  : (process.env.BINANCE_SPOT_MAINNET_KEY || '');

const API_SECRET = IS_TESTNET
  ? (process.env.BINANCE_SPOT_TESTNET_SECRET || '')
  : (process.env.BINANCE_SPOT_MAINNET_SECRET || '');

// P0-FIX (audit-2026-04-23): valideer recvWindow — Binance hard cap = 60000ms.
// Malformed env (NaN, 0, negatief, > 60000) → elke signed call faalt met -1101
// "Illegal value for recvWindow". Fall back naar 5000 als default ongeldig is.
const _rwSpot = parseInt(process.env.BINANCE_RECV_WINDOW || '5000', 10);
const RECV_WINDOW = (Number.isFinite(_rwSpot) && _rwSpot > 0 && _rwSpot <= 60000)
  ? _rwSpot
  : 5000;

function isConfigured() {
  return !!(API_KEY && API_SECRET);
}

function _network() { return NETWORK; }

// ── Clock sync (P0-4) — voorkomt -1021 timestamp errors ──
async function _maybeSyncClock() {
  if (!signing.clockNeedsSync()) return;
  try {
    const t0 = Date.now();
    const j = await (await fetch(BASE_URL + '/api/v3/time')).json();
    const rtt = Date.now() - t0;
    // serverTime is geldig op ~ moment van response — corrigeer met half RTT
    const offset = j.serverTime - (Date.now() - rtt / 2);
    signing.setClockOffset(offset);
    if (Math.abs(offset) > 1000) {
      console.warn(`[binance-spot] clock skew ${offset}ms — synced`);
    }
  } catch (e) {
    console.warn(`[binance-spot] clock sync failed: ${e.message}`);
  }
}

// ── Low-level HTTP with retry ──
async function _request(method, path, params = {}, signed = false, retries = 2) {
  if (signed) await _maybeSyncClock();
  let url, body, headers = { 'X-MBX-APIKEY': API_KEY };

  if (signed) {
    if (method === 'GET' || method === 'DELETE') {
      url = BASE_URL + buildSignedUrl(path, params, API_SECRET, RECV_WINDOW);
    } else {
      url = BASE_URL + path;
      body = buildSignedBody(params, API_SECRET, RECV_WINDOW);
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
  } else {
    const qs = new URLSearchParams(params).toString();
    url = BASE_URL + path + (qs ? `?${qs}` : '');
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(url, { method, headers, body });
      const text = await resp.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}

      if (!resp.ok) {
        // Binance error format: { code: -1234, msg: "..." }
        const err = new Error(`Binance ${method} ${path} HTTP ${resp.status}: ${json?.msg || text.slice(0, 200)}`);
        err.code = json?.code;
        err.status = resp.status;
        err.body = text;
        // Retry op transient errors (rate limit, server)
        if ((resp.status === 429 || resp.status >= 500) && attempt < retries) {
          await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
          continue;
        }
        throw err;
      }
      return json;
    } catch (e) {
      // P0-FIX (audit-2026-04-23): NIET retryen op POST/DELETE bij network errors.
      // Reden: als Binance de order accepteerde maar response verloren ging in transit,
      // resubmit = mogelijk DUPLICATE order op het exchange. clientOrderId is wel
      // preserved (body buiten loop berekend), maar dedup op duplicate is best-effort.
      // GET retry blijft veilig (idempotent). Caller moet zelf via getOrder() checken.
      if (method !== 'GET' || attempt === retries) throw e;
      await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
    }
  }
}

// ── Public endpoints (no auth) ──
async function getServerTime() {
  const j = await _request('GET', '/api/v3/time');
  return j.serverTime;
}

async function getExchangeInfo() {
  return _request('GET', '/api/v3/exchangeInfo');
}

let _exchangeInfoCache = null;
let _exchangeInfoCacheTs = 0;
async function getSymbolFilters(symbol) {
  const now = Date.now();
  if (!_exchangeInfoCache || now - _exchangeInfoCacheTs > 3600 * 1000) {
    _exchangeInfoCache = await getExchangeInfo();
    _exchangeInfoCacheTs = now;
  }
  const sym = (_exchangeInfoCache.symbols || []).find(s => s.symbol === symbol);
  if (!sym) throw new Error(`Symbol ${symbol} not found in exchange info`);

  const lotSize = sym.filters.find(f => f.filterType === 'LOT_SIZE') || {};
  const priceFilter = sym.filters.find(f => f.filterType === 'PRICE_FILTER') || {};
  const minNotional = sym.filters.find(f => f.filterType === 'MIN_NOTIONAL' || f.filterType === 'NOTIONAL') || {};

  return {
    symbol,
    status: sym.status,
    baseAsset: sym.baseAsset,
    quoteAsset: sym.quoteAsset,
    minQty: parseFloat(lotSize.minQty || '0'),
    maxQty: parseFloat(lotSize.maxQty || '0'),
    stepSize: parseFloat(lotSize.stepSize || '0'),
    tickSize: parseFloat(priceFilter.tickSize || '0'),
    minPrice: parseFloat(priceFilter.minPrice || '0'),
    maxPrice: parseFloat(priceFilter.maxPrice || '0'),
    minNotional: parseFloat(minNotional.minNotional || minNotional.notional || '0'),
  };
}

async function getTicker(symbol) {
  const j = await _request('GET', '/api/v3/ticker/bookTicker', { symbol });
  return {
    symbol: j.symbol,
    bid: parseFloat(j.bidPrice),
    ask: parseFloat(j.askPrice),
    last: (parseFloat(j.bidPrice) + parseFloat(j.askPrice)) / 2,
  };
}

// ── Private endpoints (signed) ──
async function getAccount() {
  return _request('GET', '/api/v3/account', {}, true);
}

async function getBalance(asset = 'USDT') {
  const acc = await getAccount();
  const b = (acc.balances || []).find(x => x.asset === asset);
  return b ? parseFloat(b.free) : 0;
}

async function getAllBalances() {
  const acc = await getAccount();
  return (acc.balances || [])
    .map(b => ({ asset: b.asset, free: parseFloat(b.free), locked: parseFloat(b.locked) }))
    .filter(b => b.free > 0 || b.locked > 0);
}

// ── Quantity rounding helpers ──
// Binance vereist dat qty een veelvoud van stepSize is. Round DOWN.
// P0-6: voorkom IEEE-754 floating-point artefacten (0.123 * 1.0 = 0.12300000000001)
// door toFixed() naar het juiste aantal decimals te clampen — anders rejects Binance
// met -1013 LOT_SIZE filter failure.
function _roundDown(value, step) {
  if (!step || step <= 0) return value;
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  const rounded = Math.floor(value / step) * step;
  return parseFloat(rounded.toFixed(decimals));
}

// P0-5: minNotional = qty * price minimum (default ~$10 voor spot, $5 voor futures).
// midPrice nodig om dit te kunnen valideren — anders accepteren we orders die de
// exchange direct rejected met -1013 NOTIONAL filter failure.
async function _normalizeQty(symbol, qty, midPrice = null) {
  const f = await getSymbolFilters(symbol);
  let q = _roundDown(qty, f.stepSize);
  if (q < f.minQty) throw new Error(`qty ${q} < minQty ${f.minQty} for ${symbol}`);
  if (midPrice && f.minNotional > 0) {
    const notional = q * midPrice;
    if (notional < f.minNotional) {
      throw new Error(`notional $${notional.toFixed(2)} < minNotional $${f.minNotional} for ${symbol} (qty=${q} @ ~$${midPrice})`);
    }
  }
  return { qty: q, filters: f };
}

// ── Order submission ──
//
// type:
//   MARKET            — direct fill at best available
//   LIMIT             — fills at price or better, time-in-force GTC
//   STOP_LOSS         — market order triggered at stopPrice
//   STOP_LOSS_LIMIT   — limit order triggered at stopPrice
//   TAKE_PROFIT
//   TAKE_PROFIT_LIMIT
//
// Voor onze use case:
//   ENTRY = MARKET  (snel filled, geen prijs-risico tussen signal en fill)
//   EXIT  = MARKET  (idem; stops en targets worden door ons monitored, niet exchange-side)
//
// Optioneel kun je later OCO orders gebruiken (entry + stop + target tegelijk
// naar exchange). Voor nu: bot houdt SL/TP in memory + closes via market.
async function submitOrder({ symbol, side, type = 'MARKET', quantity, price = null, stopPrice = null, clientOrderId = null, quoteOrderQty = null }) {
  const params = {
    symbol,
    side: side.toUpperCase(),                     // BUY of SELL
    type: type.toUpperCase(),
    newOrderRespType: 'FULL',                     // krijg fill detail terug
  };

  // Voor MARKET kun je quantity (in base) of quoteOrderQty (in quote, e.g. USDT) geven.
  // We prefereren quantity (zodat we exact qty controle hebben).
  if (quoteOrderQty != null) {
    params.quoteOrderQty = quoteOrderQty;
  } else {
    // P0-5: pak best-bid/ask voor minNotional-validatie. Type=LIMIT? gebruik price.
    let mid = price;
    if (!mid) {
      try { const t = await getTicker(symbol); mid = t.last; } catch {}
    }
    const norm = await _normalizeQty(symbol, quantity, mid);
    params.quantity = norm.qty;
  }

  if (price != null && type !== 'MARKET') {
    params.price = price;
    params.timeInForce = 'GTC';
  }
  if (stopPrice != null) params.stopPrice = stopPrice;
  if (clientOrderId) params.newClientOrderId = clientOrderId;

  const j = await _request('POST', '/api/v3/order', params, true);

  // Aggregate fills voor avg price + total fees
  let filledQty = parseFloat(j.executedQty || '0');
  let cumQuote = parseFloat(j.cummulativeQuoteQty || '0');
  let avgPrice = filledQty > 0 ? cumQuote / filledQty : 0;
  let fees = 0, feeAsset = null;
  if (Array.isArray(j.fills)) {
    for (const f of j.fills) {
      fees += parseFloat(f.commission || '0');
      feeAsset = f.commissionAsset;
    }
  }

  return {
    orderId: j.orderId,
    clientOrderId: j.clientOrderId,
    symbol: j.symbol,
    status: j.status,        // FILLED, PARTIALLY_FILLED, NEW, CANCELED, ...
    side: j.side,
    type: j.type,
    filledQty,
    cumQuote,
    avgPrice,
    fees,
    feeAsset,
    raw: j,
  };
}

async function getOrder(symbol, orderId) {
  const j = await _request('GET', '/api/v3/order', { symbol, orderId }, true);
  const filledQty = parseFloat(j.executedQty || '0');
  const cumQuote = parseFloat(j.cummulativeQuoteQty || '0');
  return {
    orderId: j.orderId,
    clientOrderId: j.clientOrderId,
    symbol: j.symbol,
    status: j.status,
    side: j.side,
    type: j.type,
    filledQty,
    cumQuote,
    avgPrice: filledQty > 0 ? cumQuote / filledQty : 0,
    raw: j,
  };
}

async function cancelOrder(symbol, orderId) {
  const j = await _request('DELETE', '/api/v3/order', { symbol, orderId }, true);
  return { orderId: j.orderId, status: j.status };
}

async function listOpenOrders(symbol = null) {
  const params = symbol ? { symbol } : {};
  return _request('GET', '/api/v3/openOrders', params, true);
}

async function getMyTrades(symbol, fromId = null, limit = 500) {
  const params = { symbol, limit };
  if (fromId) params.fromId = fromId;
  return _request('GET', '/api/v3/myTrades', params, true);
}

// ── Convenience: convert MERLIN token (e.g. 'BTC') → Binance Spot symbol (e.g. 'BTCUSDT') ──
function tokenToSymbol(token, quote = 'USDT') {
  return `${token.toUpperCase()}${quote}`;
}

module.exports = {
  isConfigured,
  network: _network,
  baseUrl: () => BASE_URL,
  // Public
  getServerTime,
  getExchangeInfo,
  getSymbolFilters,
  getTicker,
  // Private
  getAccount,
  getBalance,
  getAllBalances,
  submitOrder,
  getOrder,
  cancelOrder,
  listOpenOrders,
  getMyTrades,
  // Helpers
  tokenToSymbol,
};
