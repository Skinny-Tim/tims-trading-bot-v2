// ═══ FX Rate Endpoint ═══
//
// Returneert actuele USD→EUR conversie-rate. Gebruikt door dashboard om
// USDT-based paper-trading bedragen om te zetten naar EUR-display.
//
// Bron: Frankfurter (free, ECB data, no auth, 200 req/dag/IP).
// Cache: 1 uur in Redis (FX bewegingen zijn traag genoeg).
//
// GET /api/fx           → { ok: true, rates: { USD: 0.92, ... }, base: 'EUR' }
// GET /api/fx?to=USDT   → { ok: true, rate: 1.087, ... }  (1 USDT = X EUR)

const path = require('path');
let redis = { isConfigured: () => false };
try { redis = require(path.join(__dirname, '_lib', 'redis.js')); } catch {}

const CACHE_KEY = 'fx:eur:rates';
const CACHE_TTL_MS = 3600 * 1000;  // 1 hour

async function fetchEcbRates() {
  // Frankfurter is gratis ECB-proxy. Geeft EUR-base rates.
  // {"amount":1,"base":"EUR","date":"2026-04-20","rates":{"USD":1.087,...}}
  const r = await fetch('https://api.frankfurter.app/latest?from=EUR', {
    headers: { 'User-Agent': 'merlin-fx/1.0' },
  });
  if (!r.ok) throw new Error(`Frankfurter ${r.status}`);
  return await r.json();
}

async function getRates() {
  // Cache check
  if (redis.isConfigured?.()) {
    try {
      const cached = await redis.get(CACHE_KEY);
      if (cached) {
        const c = typeof cached === 'string' ? JSON.parse(cached) : cached;
        if (Date.now() - (c._cachedAt || 0) < CACHE_TTL_MS) return c;
      }
    } catch {}
  }
  const ecb = await fetchEcbRates();
  const out = {
    base: 'EUR',
    date: ecb.date,
    rates: ecb.rates,            // EUR → currency (USD: 1.087 = 1 EUR = 1.087 USD)
    _cachedAt: Date.now(),
  };
  if (redis.isConfigured?.()) {
    try { await redis.set(CACHE_KEY, out); } catch {}
  }
  return out;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
  try {
    const rates = await getRates();
    const to = (req.query?.to || '').toUpperCase();
    if (to) {
      // Special-case: USDT ≈ USD voor display-doeleinden
      const symbol = to === 'USDT' ? 'USD' : to;
      const eurToFx = rates.rates[symbol];
      if (!eurToFx) return res.status(400).json({ ok: false, error: `unknown currency: ${to}` });
      // Inverteer: 1 [to] = X EUR
      const oneFxToEur = 1 / eurToFx;
      return res.status(200).json({
        ok: true,
        from: to,
        to: 'EUR',
        rate: oneFxToEur,
        date: rates.date,
        ts: rates._cachedAt,
      });
    }
    return res.status(200).json({ ok: true, ...rates });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
