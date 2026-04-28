// ═══ Binance USDT-M Futures adapter ═══
//
// Wrapt Binance Futures REST API voor live order submission. Default = TESTNET.
// Mainnet enabled wanneer BINANCE_FUT_NETWORK=mainnet expliciet gezet is.
//
// Setup TESTNET:
//   1. https://testnet.binancefuture.com/ → register → API key
//   2. Default 100,000 USDT testnet balance
//   3. Set env: BINANCE_FUT_TESTNET_KEY + BINANCE_FUT_TESTNET_SECRET
//
// Setup MAINNET:
//   1. https://www.binance.com/en/my/settings/api-management
//   2. Create API → IP whitelist je server-IP → enable "Futures" only
//   3. NIET enable: Withdrawals, Universal Transfer
//   4. Set env: BINANCE_FUT_MAINNET_KEY + BINANCE_FUT_MAINNET_SECRET
//   5. Set env: BINANCE_FUT_NETWORK=mainnet
//
// Gebruikt voor: Kronos (paper_kronos) live trading. Ondersteunt SHORT.
//
// Belangrijke verschillen vs spot:
//   - Position-based (niet asset-based): je hebt een netto LONG/SHORT positie
//   - Default leverage = 20x — ALTIJD setLeverage() naar gewenste waarde voor order
//   - Margin type: ISOLATED (per positie) of CROSSED (gedeeld) — wij default ISOLATED
//   - reduceOnly flag: voorkomt accidenteel openen tegenovergestelde positie bij sluiten
//   - Funding rate elke 8u (LONG betaalt SHORT bij positive rate)

const signing = require('./_signing');
const { buildSignedUrl, buildSignedBody } = signing;

const NETWORK = (process.env.BINANCE_FUT_NETWORK || 'testnet').toLowerCase();
const IS_TESTNET = NETWORK === 'testnet';

const BASE_URL = IS_TESTNET
  ? 'https://testnet.binancefuture.com'
  : 'https://fapi.binance.com';

const API_KEY = IS_TESTNET
  ? (process.env.BINANCE_FUT_TESTNET_KEY || '')
  : (process.env.BINANCE_FUT_MAINNET_KEY || '');

const API_SECRET = IS_TESTNET
  ? (process.env.BINANCE_FUT_TESTNET_SECRET || '')
  : (process.env.BINANCE_FUT_MAINNET_SECRET || '');

// P0-FIX (audit-2026-04-23): valideer recvWindow — zie binance-spot.js voor uitleg.
const _rwFut = parseInt(process.env.BINANCE_RECV_WINDOW || '5000', 10);
const RECV_WINDOW = (Number.isFinite(_rwFut) && _rwFut > 0 && _rwFut <= 60000)
  ? _rwFut
  : 5000;
const DEFAULT_LEVERAGE = parseInt(process.env.BINANCE_FUT_LEVERAGE || '3', 10);   // conservative default
const MARGIN_TYPE = (process.env.BINANCE_FUT_MARGIN_TYPE || 'ISOLATED').toUpperCase();

function isConfigured() {
  return !!(API_KEY && API_SECRET);
}
function _network() { return NETWORK; }

// ── Clock sync (P0-4) — voorkomt -1021 timestamp errors ──
async function _maybeSyncClock() {
  if (!signing.clockNeedsSync()) return;
  try {
    const t0 = Date.now();
    const j = await (await fetch(BASE_URL + '/fapi/v1/time')).json();
    const rtt = Date.now() - t0;
    const offset = j.serverTime - (Date.now() - rtt / 2);
    signing.setClockOffset(offset);
    if (Math.abs(offset) > 1000) {
      console.warn(`[binance-futures] clock skew ${offset}ms — synced`);
    }
  } catch (e) {
    console.warn(`[binance-futures] clock sync failed: ${e.message}`);
  }
}

// ── Low-level HTTP ──
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
        const err = new Error(`BinanceFut ${method} ${path} HTTP ${resp.status}: ${json?.msg || text.slice(0, 200)}`);
        err.code = json?.code;
        err.status = resp.status;
        err.body = text;
        if ((resp.status === 429 || resp.status >= 500) && attempt < retries) {
          await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
          continue;
        }
        throw err;
      }
      return json;
    } catch (e) {
      // P0-FIX (audit-2026-04-23): NIET retryen op POST/DELETE bij network errors.
      // Op futures = nog kritischer dan spot want hefboom — duplicate order kan
      // 2-20x notional fillen en risk-cap onmiddellijk doorbreken. Caller moet
      // zelf via getOrder() / getPositions() idempotency checken.
      if (method !== 'GET' || attempt === retries) throw e;
      await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
    }
  }
}

// ── Public ──
async function getExchangeInfo() {
  return _request('GET', '/fapi/v1/exchangeInfo');
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
  if (!sym) throw new Error(`Symbol ${symbol} not found in futures exchange info`);
  const lotSize = sym.filters.find(f => f.filterType === 'LOT_SIZE') || {};
  const priceFilter = sym.filters.find(f => f.filterType === 'PRICE_FILTER') || {};
  const minNotional = sym.filters.find(f => f.filterType === 'MIN_NOTIONAL' || f.filterType === 'NOTIONAL') || {};
  return {
    symbol,
    status: sym.status,
    baseAsset: sym.baseAsset,
    quoteAsset: sym.quoteAsset,
    contractType: sym.contractType,    // PERPETUAL, etc.
    minQty: parseFloat(lotSize.minQty || '0'),
    maxQty: parseFloat(lotSize.maxQty || '0'),
    stepSize: parseFloat(lotSize.stepSize || '0'),
    tickSize: parseFloat(priceFilter.tickSize || '0'),
    minNotional: parseFloat(minNotional.notional || minNotional.minNotional || '0'),
  };
}

async function getTicker(symbol) {
  const j = await _request('GET', '/fapi/v1/ticker/bookTicker', { symbol });
  return {
    symbol: j.symbol,
    bid: parseFloat(j.bidPrice),
    ask: parseFloat(j.askPrice),
    last: (parseFloat(j.bidPrice) + parseFloat(j.askPrice)) / 2,
  };
}

async function getFundingRate(symbol) {
  const j = await _request('GET', '/fapi/v1/premiumIndex', { symbol });
  return {
    symbol: j.symbol,
    markPrice: parseFloat(j.markPrice),
    indexPrice: parseFloat(j.indexPrice),
    fundingRate: parseFloat(j.lastFundingRate),
    nextFundingTime: parseInt(j.nextFundingTime, 10),
  };
}

// ── Private ──
async function getAccount() {
  return _request('GET', '/fapi/v2/account', {}, true);
}

async function getBalance(asset = 'USDT') {
  const acc = await getAccount();
  const b = (acc.assets || []).find(x => x.asset === asset);
  return b ? parseFloat(b.availableBalance) : 0;
}

async function getAllBalances() {
  const acc = await getAccount();
  return (acc.assets || [])
    .map(b => ({
      asset: b.asset,
      free: parseFloat(b.availableBalance),
      walletBalance: parseFloat(b.walletBalance),
      unrealizedPnl: parseFloat(b.unrealizedProfit),
    }))
    .filter(b => b.walletBalance > 0);
}

// ── Position info (futures specific) ──
async function getPositions(symbol = null) {
  const acc = await getAccount();
  let positions = (acc.positions || []).map(p => ({
    symbol: p.symbol,
    positionAmt: parseFloat(p.positionAmt),                  // signed: + = LONG, - = SHORT
    entryPrice: parseFloat(p.entryPrice),
    leverage: parseFloat(p.leverage),
    unrealizedPnl: parseFloat(p.unrealizedProfit),
    notional: parseFloat(p.notional || '0'),
    isolatedMargin: parseFloat(p.isolatedMargin || '0'),
    side: parseFloat(p.positionAmt) > 0 ? 'LONG' : (parseFloat(p.positionAmt) < 0 ? 'SHORT' : 'FLAT'),
  })).filter(p => p.positionAmt !== 0);
  if (symbol) positions = positions.filter(p => p.symbol === symbol);
  return positions;
}

// ── Leverage + margin type setup (run once per symbol per session) ──
const _leverageSet = new Set();
async function ensureLeverage(symbol, leverage = DEFAULT_LEVERAGE) {
  const key = `${symbol}_${leverage}`;
  if (_leverageSet.has(key)) return;
  try {
    await _request('POST', '/fapi/v1/leverage', { symbol, leverage }, true);
    _leverageSet.add(key);
  } catch (e) {
    // Bestaande leverage al gelijk → geen probleem; log + skip
    console.warn(`[binance-fut] setLeverage ${symbol}=${leverage}x: ${e.message}`);
  }
}

const _marginTypeSet = new Set();
async function ensureMarginType(symbol, marginType = MARGIN_TYPE) {
  const key = `${symbol}_${marginType}`;
  if (_marginTypeSet.has(key)) return;
  try {
    await _request('POST', '/fapi/v1/marginType', { symbol, marginType }, true);
    _marginTypeSet.add(key);
  } catch (e) {
    // Code -4046 = "No need to change margin type" — ignore
    if (e.code !== -4046) {
      console.warn(`[binance-fut] setMarginType ${symbol}=${marginType}: ${e.message}`);
    }
    _marginTypeSet.add(key);
  }
}

// ── Round helpers (zelfde als spot) ──
// P0-6: voorkom IEEE-754 floating-point artefacten via toFixed()-clamp.
function _roundDown(value, step) {
  if (!step || step <= 0) return value;
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  const rounded = Math.floor(value / step) * step;
  return parseFloat(rounded.toFixed(decimals));
}

// P0-5: minNotional check (~$5 voor futures) op leverage-genoteerde notional.
// Zonder midPrice slaan we de check over (caller moet 'm meegeven).
async function _normalizeQty(symbol, qty, midPrice = null) {
  const f = await getSymbolFilters(symbol);
  const q = _roundDown(qty, f.stepSize);
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
// side: BUY = open LONG of close SHORT; SELL = open SHORT of close LONG
// Voor close: gebruik reduceOnly:true (failsafe)
//
// type: MARKET | LIMIT | STOP_MARKET | TAKE_PROFIT_MARKET | STOP | TAKE_PROFIT
//
// positionSide: BOTH (one-way mode, default) | LONG | SHORT (hedge mode)
// We assumeren one-way mode (Binance default voor nieuwe accounts).
async function submitOrder({ symbol, side, type = 'MARKET', quantity, price = null, stopPrice = null, reduceOnly = false, clientOrderId = null, leverage = null }) {
  // Setup leverage + margin type voor dit symbool (idempotent)
  await ensureMarginType(symbol);
  if (leverage) await ensureLeverage(symbol, leverage);
  else await ensureLeverage(symbol);

  const params = {
    symbol,
    side: side.toUpperCase(),                 // BUY of SELL
    type: type.toUpperCase(),
    newOrderRespType: 'RESULT',
  };

  // P0-5: pak mid-price voor minNotional validatie als price niet gegeven
  let _midForNotional = price || stopPrice;
  if (!_midForNotional) {
    try { const t = await getTicker(symbol); _midForNotional = t.last; } catch {}
  }
  const norm = await _normalizeQty(symbol, quantity, _midForNotional);
  params.quantity = norm.qty;

  if (price != null && type !== 'MARKET' && !type.includes('STOP') && !type.includes('TAKE')) {
    params.price = price;
    params.timeInForce = 'GTC';
  }
  if (stopPrice != null) params.stopPrice = stopPrice;
  if (reduceOnly) params.reduceOnly = 'true';
  if (clientOrderId) params.newClientOrderId = clientOrderId;

  const j = await _request('POST', '/fapi/v1/order', params, true);

  const filledQty = parseFloat(j.executedQty || '0');
  const cumQuote = parseFloat(j.cumQuote || j.cummulativeQuoteQty || '0');
  const avgPrice = parseFloat(j.avgPrice || '0') || (filledQty > 0 ? cumQuote / filledQty : 0);

  return {
    orderId: j.orderId,
    clientOrderId: j.clientOrderId,
    symbol: j.symbol,
    status: j.status,
    side: j.side,
    type: j.type,
    filledQty,
    cumQuote,
    avgPrice,
    reduceOnly: j.reduceOnly,
    raw: j,
  };
}

async function getOrder(symbol, orderId) {
  const j = await _request('GET', '/fapi/v1/order', { symbol, orderId }, true);
  const filledQty = parseFloat(j.executedQty || '0');
  const cumQuote = parseFloat(j.cumQuote || '0');
  return {
    orderId: j.orderId,
    clientOrderId: j.clientOrderId,
    symbol: j.symbol,
    status: j.status,
    side: j.side,
    type: j.type,
    filledQty,
    cumQuote,
    avgPrice: parseFloat(j.avgPrice || '0') || (filledQty > 0 ? cumQuote / filledQty : 0),
    raw: j,
  };
}

async function cancelOrder(symbol, orderId) {
  const j = await _request('DELETE', '/fapi/v1/order', { symbol, orderId }, true);
  return { orderId: j.orderId, status: j.status };
}

async function listOpenOrders(symbol = null) {
  const params = symbol ? { symbol } : {};
  return _request('GET', '/fapi/v1/openOrders', params, true);
}

async function getUserTrades(symbol, fromId = null, limit = 500) {
  const params = { symbol, limit };
  if (fromId) params.fromId = fromId;
  return _request('GET', '/fapi/v1/userTrades', params, true);
}

// ── Convenience: convert MERLIN token → Binance Futures symbol ──
// Binance perp futures = base + USDT (e.g. BTCUSDT, ETHUSDT). Same as spot here.
function tokenToSymbol(token, quote = 'USDT') {
  return `${token.toUpperCase()}${quote}`;
}

// ── Side mapping voor onze bot-conventie ──
//   bot side LONG  + ENTRY → exchange BUY
//   bot side LONG  + EXIT  → exchange SELL (reduceOnly)
//   bot side SHORT + ENTRY → exchange SELL
//   bot side SHORT + EXIT  → exchange BUY (reduceOnly)
function botToExchangeSide(botSide, kind) {
  const isBuy = (botSide === 'LONG' && kind === 'ENTRY') || (botSide === 'SHORT' && kind === 'EXIT');
  return isBuy ? 'BUY' : 'SELL';
}

module.exports = {
  isConfigured,
  network: _network,
  baseUrl: () => BASE_URL,
  defaultLeverage: () => DEFAULT_LEVERAGE,
  marginType: () => MARGIN_TYPE,
  // Public
  getExchangeInfo,
  getSymbolFilters,
  getTicker,
  getFundingRate,
  // Private
  getAccount,
  getBalance,
  getAllBalances,
  getPositions,
  ensureLeverage,
  ensureMarginType,
  submitOrder,
  getOrder,
  cancelOrder,
  listOpenOrders,
  getUserTrades,
  // Helpers
  tokenToSymbol,
  botToExchangeSide,
};
