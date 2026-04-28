// ═══ Binance HMAC-SHA256 signing helper ═══
//
// Binance REST API verwacht voor PRIVATE endpoints:
//   - Header: X-MBX-APIKEY: <api_key>
//   - Query param: signature=<hmac_sha256(query_string, secret)>
//   - Query param: timestamp=<ms_since_epoch>
//
// Public endpoints (prices, orderbook, klines) hebben geen signing nodig.
//
// Deze helper is gedeeld tussen spot + futures (zelfde signing schema).
//
// CLOCK SYNC (P0-4): Vercel serverless containers kunnen seconds-skew hebben t.o.v.
// Binance server-time. Als |skew| > recvWindow (default 5000ms) faalt elke signed
// call met -1021 'Timestamp ahead of server'. We houden een global offset bij die
// adapters periodiek bijwerken via setClockOffset(syncedMs - localMs). De signing
// gebruikt syncedNow() = Date.now() + offset.

const crypto = require('crypto');

let _clockOffsetMs = 0;             // serverTime - localTime (positief = local achter)
let _lastSyncMs = 0;
const CLOCK_SYNC_TTL_MS = 5 * 60 * 1000;   // sync max elke 5 min

function setClockOffset(offsetMs) {
  _clockOffsetMs = offsetMs;
  _lastSyncMs = Date.now();
}
function getClockOffset() { return _clockOffsetMs; }
function clockNeedsSync() { return Date.now() - _lastSyncMs > CLOCK_SYNC_TTL_MS; }
function syncedNow() { return Date.now() + _clockOffsetMs; }

function hmacSha256(secret, message) {
  return crypto.createHmac('sha256', secret).update(message).digest('hex');
}

// Build signed query string. Returns full URL (without base) ready for fetch.
//   path     — REST path (e.g., '/api/v3/order')
//   params   — object of query params (timestamp + signature toegevoegd)
//   secret   — API secret
//   recvWindow — optioneel, ms (default 5000)
function buildSignedUrl(path, params, secret, recvWindow = 5000) {
  const ts = syncedNow();
  const fullParams = { ...params, timestamp: ts, recvWindow };
  const qs = new URLSearchParams(fullParams).toString();
  const signature = hmacSha256(secret, qs);
  return `${path}?${qs}&signature=${signature}`;
}

// Build signed body (for POST/DELETE waar signature in body moet)
function buildSignedBody(params, secret, recvWindow = 5000) {
  const ts = syncedNow();
  const fullParams = { ...params, timestamp: ts, recvWindow };
  const qs = new URLSearchParams(fullParams).toString();
  const signature = hmacSha256(secret, qs);
  return `${qs}&signature=${signature}`;
}

module.exports = {
  hmacSha256,
  buildSignedUrl,
  buildSignedBody,
  setClockOffset, getClockOffset, clockNeedsSync, syncedNow,
};
