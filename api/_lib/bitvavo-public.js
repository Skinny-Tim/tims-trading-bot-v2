// ═══ Bitvavo Public Data Adapter ═══
//
// Alleen PUBLIC endpoints — geen API key nodig. Voor paper trading die zo dicht
// mogelijk bij de echte Bitvavo fills wil zitten: we lezen ticker, orderbook
// en candles direct bij Bitvavo en rekenen slippage uit op basis van werkelijke
// orderbook-diepte i.p.v. bps-schattingen.
//
// Endpoints gebruikt (allemaal zonder auth):
//   GET /v2/ticker/price                    — mid prijs
//   GET /v2/{market}/book?depth=N           — orderbook (bids + asks)
//   GET /v2/{market}/candles?interval=4h    — OHLCV candles
//   GET /v2/ticker/24h                      — 24u volume
//
// Bitvavo fees (spot, 2026):
//   Taker:  0.25% = 25 bps
//   Maker:  0.15% = 15 bps
//   Volume-tiers beneden 250k EUR/30d
//
// Venue premium t.o.v. Binance:
//   Typisch 15-25 bps op majors (BTC/ETH). Tot 50+ bps op kleinere caps
//   tijdens thin-book momenten.

const BITVAVO_BASE = 'https://api.bitvavo.com/v2';

const BITVAVO_FEES = {
  takerBps: 25,      // 0.25% spot
  makerBps: 15,      // 0.15% spot
  // Volume discounts (30-day EUR volume → takerBps)
  tiers: [
    { minVol:       0, takerBps: 25, makerBps: 15 },
    { minVol:  100000, takerBps: 20, makerBps: 10 },
    { minVol:  250000, takerBps: 16, makerBps:  8 },
    { minVol: 1000000, takerBps: 12, makerBps:  4 },
  ],
};

function feesForVolume(eur30d = 0) {
  let t = BITVAVO_FEES.tiers[0];
  for (const tier of BITVAVO_FEES.tiers) {
    if (eur30d >= tier.minVol) t = tier;
  }
  return { takerBps: t.takerBps, makerBps: t.makerBps };
}

// ── Market mapping ──
// Paper-engine gebruikt korte namen (BTC, ETH...) — Bitvavo wil BTC-EUR.
function tokenToMarket(short) {
  return `${short}-EUR`;
}

async function fetchJson(url, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`Bitvavo ${r.status}: ${url}`);
    return await r.json();
  } finally { clearTimeout(to); }
}

// ── Ticker ──
async function fetchTicker(market) {
  const d = await fetchJson(`${BITVAVO_BASE}/ticker/price?market=${market}`);
  return parseFloat(d.price);
}

async function fetchAllTickers() {
  const arr = await fetchJson(`${BITVAVO_BASE}/ticker/price`);
  const out = {};
  for (const t of arr) out[t.market] = parseFloat(t.price);
  return out;
}

// ── 24u statistieken (voor volume-based size-impact als book niet geladen) ──
async function fetch24h(market) {
  const d = await fetchJson(`${BITVAVO_BASE}/ticker/24h?market=${market}`);
  return {
    high: parseFloat(d.high || 0),
    low:  parseFloat(d.low  || 0),
    volume:      parseFloat(d.volume || 0),        // in base asset
    volumeQuote: parseFloat(d.volumeQuote || 0),   // in EUR
    bid:         parseFloat(d.bid || 0),
    ask:         parseFloat(d.ask || 0),
    last:        parseFloat(d.last || 0),
  };
}

// ── Orderbook ──
// Returns { bids: [[price, qty]...], asks: [[price, qty]...] }, prijs-gesorteerd.
async function fetchBook(market, depth = 50) {
  const d = await fetchJson(`${BITVAVO_BASE}/${market}/book?depth=${depth}`);
  return {
    market,
    nonce: d.nonce,
    bids: (d.bids || []).map(([p, q]) => [parseFloat(p), parseFloat(q)]),
    asks: (d.asks || []).map(([p, q]) => [parseFloat(p), parseFloat(q)]),
  };
}

// ── Candles ──
// Bitvavo: GET /v2/{market}/candles?interval=4h&limit=500
// Response: array van [timestamp_ms, open, high, low, close, volume] strings.
async function fetchCandles(market, interval = '4h', limit = 500) {
  const d = await fetchJson(`${BITVAVO_BASE}/${market}/candles?interval=${interval}&limit=${limit}`);
  // Newest first — keren omdat de rest van de code chrono-order verwacht
  return d.map(row => ({
    time:   parseInt(row[0], 10),
    open:   parseFloat(row[1]),
    high:   parseFloat(row[2]),
    low:    parseFloat(row[3]),
    close:  parseFloat(row[4]),
    volume: parseFloat(row[5]),
  })).reverse();
}

// ── Slippage uit echt orderbook ──
//
// Stel je wil $5000 BTC kopen. We lopen door de ASK side van het boek (lowest
// first) en vullen totdat de order gematched is. De VWAP is je executieprijs.
//
// Input:
//   book       = { bids:[[p,q]...], asks:[[p,q]...] } (bids hoogst eerst,
//                 asks laagst eerst — Bitvavo levert zo)
//   sizeUsd    = bedrag in EUR dat je wil handelen (EUR ~ USD voor ons model)
//   side       = 'LONG' | 'SHORT'
//   kind       = 'ENTRY' | 'EXIT'
//
// Returns { fillPrice, filled, leftover, levelsHit, slipBps }.
// Als het boek te dun is (leftover > 0) krijgt caller een waarschuwing.
function walkBookForSize(book, sizeEur, side, kind) {
  const isBuy = (side === 'LONG' && kind === 'ENTRY') || (side === 'SHORT' && kind === 'EXIT');
  // Bitvavo: bids = hoogst eerst, asks = laagst eerst (beide al voorsorteerd)
  const levels = isBuy ? book.asks : book.bids;
  if (!levels || levels.length === 0) {
    return { fillPrice: null, filled: 0, leftover: sizeEur, levelsHit: 0, slipBps: null, error: 'empty_book' };
  }

  const refPrice = levels[0][0];   // beste tick = referentie voor slip
  let eurFilled = 0;
  let costEur   = 0;
  let hit       = 0;

  for (const [price, qty] of levels) {
    const levelEur = price * qty;
    const need = sizeEur - eurFilled;
    if (need <= 0) break;
    if (levelEur >= need) {
      const partialQty = need / price;
      eurFilled += partialQty * price;
      costEur   += partialQty * price;   // zelfde als eurFilled in spot
      hit++;
      break;
    } else {
      eurFilled += levelEur;
      costEur   += levelEur;
      hit++;
    }
  }

  if (eurFilled <= 0) return { fillPrice: null, filled: 0, leftover: sizeEur, levelsHit: 0, slipBps: null, error: 'no_fill' };
  const vwap = costEur / (eurFilled / refPrice) / refPrice * refPrice;  // gewogen gemiddelde prijs
  // Eenvoudiger: vwap = costEur / totalQty waar totalQty = eurFilled / gemiddelde
  // Berekening opnieuw voor numerieke accuracy:
  let qtyTotal = 0, eurTotal = 0;
  let eurLeft = sizeEur;
  for (const [price, qty] of levels) {
    if (eurLeft <= 0) break;
    const levelEur = price * qty;
    if (levelEur >= eurLeft) {
      const partialQty = eurLeft / price;
      qtyTotal += partialQty;
      eurTotal += partialQty * price;
      eurLeft = 0;
      break;
    } else {
      qtyTotal += qty;
      eurTotal += levelEur;
      eurLeft -= levelEur;
    }
  }
  const fillPrice = qtyTotal > 0 ? eurTotal / qtyTotal : refPrice;
  const slipBps = Math.abs(fillPrice - refPrice) / refPrice * 10000;
  return {
    fillPrice,
    filled: sizeEur - eurLeft,
    leftover: eurLeft,
    levelsHit: hit,
    refPrice,
    slipBps,
  };
}

module.exports = {
  BITVAVO_BASE,
  BITVAVO_FEES,
  feesForVolume,
  tokenToMarket,
  fetchTicker, fetchAllTickers, fetch24h, fetchBook, fetchCandles,
  walkBookForSize,
};
