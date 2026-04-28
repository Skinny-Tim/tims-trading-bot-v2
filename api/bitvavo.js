// ═══ Bitvavo API Proxy — Vercel Serverless ═══
// Houdt API keys server-side, browser stuurt alleen acties
// Env vars: BITVAVO_KEY, BITVAVO_SECRET

const crypto = require('crypto');

const BASE = 'https://api.bitvavo.com/v2';

// M-P0-18 fix (2026-04-23): Bitvavo timestamp precision + clock-skew safety.
//
// PROBLEEM: Bitvavo verifieert dat (server-time - request-timestamp) ≤ accessWindow.
// Default accessWindow = 10000 ms (10 sec). Vercel containers kunnen drift hebben:
// als de host-clock 11+ seconden vóór of achter Bitvavo loopt, falen ALLE signed
// requests met "Window violated" — onzichtbaar en niet-debugbaar zonder skew-check.
//
// Twee verbeteringen:
//   1. Stuur expliciet `Bitvavo-Access-Window: 60000` (max toegestaan = 60s).
//      Dit geeft 6× meer tolerance voor Vercel's variabele NTP-sync.
//   2. Cache server-time skew bij eerste call en pas 'm toe op timestamp.
//      Skew = serverTime - localNow. Wordt elke 5 min ververst.
//
// Bitvavo accessWindow header docs:
//   https://docs.bitvavo.com/#section/General/Authentication

const ACCESS_WINDOW_MS = 60000;        // max allowed = 60s
const SKEW_REFRESH_MS = 5 * 60 * 1000; // her-meet skew elke 5 min
let _bvSkewMs = 0;
let _bvSkewCheckedAt = 0;

async function _refreshSkewIfStale() {
  if (Date.now() - _bvSkewCheckedAt < SKEW_REFRESH_MS) return;
  try {
    const r = await fetch(`${BASE}/time`);
    if (!r.ok) throw new Error(`Bitvavo /time HTTP ${r.status}`);
    const d = await r.json();
    const serverTime = parseInt(d.time, 10);
    const localNow = Date.now();
    if (Number.isFinite(serverTime) && serverTime > 0) {
      _bvSkewMs = serverTime - localNow;
      _bvSkewCheckedAt = localNow;
      if (Math.abs(_bvSkewMs) > 5000) {
        console.warn(`[bitvavo] Significant clock skew detected: ${_bvSkewMs}ms (server=${serverTime}, local=${localNow}). Compensating.`);
      }
    }
  } catch (e) {
    // Niet-fataal — gebruik vorige skew (kan 0 zijn) en hoop dat het werkt
    console.warn(`[bitvavo] skew refresh failed: ${e.message}`);
  }
}

function sign(method, url, body, timestamp, secret) {
  const bodyStr = body ? JSON.stringify(body) : '';
  const msg = timestamp + method + '/v2' + url + bodyStr;
  return crypto.createHmac('sha256', secret).update(msg).digest('hex');
}

async function bitvavo(method, path, body = null) {
  const key = process.env.BITVAVO_KEY;
  const secret = process.env.BITVAVO_SECRET;
  if (!key || !secret) throw new Error('BITVAVO_KEY/SECRET niet geconfigureerd');

  // M-P0-18: refresh skew (no-op als al recent gedaan)
  await _refreshSkewIfStale();

  // Compensate local clock met gemeten skew zodat we Bitvavo's notion van "now" gebruiken
  const timestamp = (Date.now() + _bvSkewMs).toString();
  const signature = sign(method, path, body, timestamp, secret);

  const headers = {
    'Bitvavo-Access-Key': key,
    'Bitvavo-Access-Signature': signature,
    'Bitvavo-Access-Timestamp': timestamp,
    'Bitvavo-Access-Window': String(ACCESS_WINDOW_MS),   // M-P0-18
    'Content-Type': 'application/json',
  };

  const resp = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await resp.json();
  if (!resp.ok) {
    // Force re-meet skew on next call als window-error → wellicht clock gedrift
    if (data && (data.errorCode === 110 || /window/i.test(JSON.stringify(data)))) {
      _bvSkewCheckedAt = 0;
    }
    throw new Error(data.errorCode || JSON.stringify(data));
  }
  return data;
}

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action || (req.body && req.body.action);

  try {
    // ── Status: check of Bitvavo keys geconfigureerd zijn ──
    if (action === 'status') {
      const hasKeys = !!(process.env.BITVAVO_KEY && process.env.BITVAVO_SECRET);
      return res.json({ configured: hasKeys, v: 'bitvavo-proxy-v2' });
    }

    // ── Health: public-only paper-trading readiness check ──
    // Toont Bitvavo vs Binance premium per token + book-diepte schatting.
    // Geen auth nodig.
    if (action === 'health') {
      const bp = require('./_lib/bitvavo-public');
      const tokens = ['BTC','ETH','SOL','BNB','XRP','HBAR'];
      const out = { ts: new Date().toISOString(), venue: process.env.VENUE || 'bitvavo', tokens: {} };
      for (const t of tokens) {
        const market = `${t}-EUR`;
        try {
          const [tick, d24, book] = await Promise.all([
            bp.fetchTicker(market), bp.fetch24h(market), bp.fetchBook(market, 25)
          ]);
          // Slippage-schatting voor 5k en 50k fills
          const slip5k  = bp.walkBookForSize(book, 5000,  'LONG', 'ENTRY');
          const slip50k = bp.walkBookForSize(book, 50000, 'LONG', 'ENTRY');
          out.tokens[t] = {
            market,
            price: tick,
            bid: d24.bid, ask: d24.ask,
            spreadBps: d24.ask > 0 ? ((d24.ask - d24.bid)/d24.bid * 10000) : null,
            volume24hEur: Math.round(d24.volumeQuote),
            bookLevels: book.asks.length,
            slip5kBps:  slip5k?.slipBps?.toFixed(2) || null,
            slip50kBps: slip50k?.slipBps?.toFixed(2) || null,
            slip50kLeftover: slip50k?.leftover || 0,
          };
        } catch (e) {
          out.tokens[t] = { market, error: e.message };
        }
      }
      return res.json(out);
    }

    // ── Balans ophalen ──
    if (action === 'balance') {
      const data = await bitvavo('GET', '/balance');
      return res.json(data);
    }

    // ── Ticker prijs ──
    if (action === 'ticker') {
      const market = req.query.market || 'HBAR-EUR';
      const data = await bitvavo('GET', `/ticker/price?market=${market}`);
      return res.json(data);
    }

    // ── Meerdere tickers ──
    if (action === 'tickers') {
      const data = await bitvavo('GET', '/ticker/price');
      return res.json(data);
    }

    // ── Open orders ──
    if (action === 'orders') {
      const market = req.query.market;
      const path = market ? `/orders?market=${market}` : '/orders';
      const data = await bitvavo('GET', path);
      return res.json(data);
    }

    // ── Order plaatsen ──
    if (action === 'order' && req.method === 'POST') {
      const { market, side, orderType, amount, price } = req.body;
      if (!market || !side || !orderType) {
        return res.status(400).json({ error: 'market, side, orderType vereist' });
      }
      const order = { market, side, orderType };
      if (amount) order.amount = amount.toString();
      if (price) order.price = price.toString();
      // amountQuote voor market orders in EUR
      if (req.body.amountQuote) order.amountQuote = req.body.amountQuote.toString();

      const data = await bitvavo('POST', '/order', order);
      return res.json(data);
    }

    // ── Order annuleren ──
    if (action === 'cancel' && req.method === 'POST') {
      const { market, orderId } = req.body;
      const data = await bitvavo('DELETE', `/order?market=${market}&orderId=${orderId}`);
      return res.json(data);
    }

    // ── Trades history ──
    if (action === 'trades') {
      const market = req.query.market || '';
      const limit = req.query.limit || '25';
      const path = market ? `/trades?market=${market}&limit=${limit}` : `/trades?limit=${limit}`;
      const data = await bitvavo('GET', path);
      return res.json(data);
    }

    return res.status(400).json({ error: 'Onbekende actie', actions: ['status', 'health', 'balance', 'ticker', 'tickers', 'orders', 'order', 'cancel', 'trades'] });

  } catch (err) {
    console.error('[Bitvavo]', err.message);
    return res.status(500).json({ error: err.message });
  }
};
