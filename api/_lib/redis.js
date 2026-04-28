// ═══ Redis helper (ioredis) ═══
// Werkt met Redis Cloud (RedisLabs), Upstash, of elke standaard Redis via REDIS_URL
// Fallback: Upstash REST API als REDIS_URL niet gezet is

const URL = process.env.REDIS_URL || '';
const REST_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const REST_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';

let _client = null;
function useIoredis() { return !!URL; }
function useRest() { return !!(REST_URL && REST_TOKEN); }

function isConfigured() {
  return useIoredis() || useRest();
}

async function getClient() {
  if (_client) return _client;
  if (!useIoredis()) throw new Error('REDIS_URL not set');
  const Redis = require('ioredis');
  _client = new Redis(URL, {
    maxRetriesPerRequest: 2,
    connectTimeout: 5000,
    lazyConnect: false,
    enableReadyCheck: false
  });
  _client.on('error', e => console.warn('[Redis] error:', e.message));
  return _client;
}

// REST helper (fallback)
async function restCall(command, ...args) {
  const resp = await fetch(REST_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${REST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([command, ...args])
  });
  if (!resp.ok) throw new Error(`Redis ${command} failed: ${resp.status}`);
  const data = await resp.json();
  return data.result;
}

// ── Public API ──
async function get(key) {
  let v;
  if (useIoredis()) { const c = await getClient(); v = await c.get(key); }
  else v = await restCall('GET', key);
  if (v === null || v === undefined) return null;
  try { return JSON.parse(v); } catch { return v; }
}

async function set(key, value) {
  const v = typeof value === 'string' ? value : JSON.stringify(value);
  if (useIoredis()) { const c = await getClient(); return c.set(key, v); }
  return restCall('SET', key, v);
}

async function del(key) {
  if (useIoredis()) { const c = await getClient(); return c.del(key); }
  return restCall('DEL', key);
}

async function lpush(key, value) {
  const v = typeof value === 'string' ? value : JSON.stringify(value);
  if (useIoredis()) { const c = await getClient(); return c.lpush(key, v); }
  return restCall('LPUSH', key, v);
}

async function lrange(key, start = 0, stop = -1) {
  let arr;
  if (useIoredis()) { const c = await getClient(); arr = await c.lrange(key, start, stop); }
  else arr = await restCall('LRANGE', key, start, stop);
  if (!Array.isArray(arr)) return [];
  return arr.map(v => { try { return JSON.parse(v); } catch { return v; } });
}

async function ltrim(key, start, stop) {
  if (useIoredis()) { const c = await getClient(); return c.ltrim(key, start, stop); }
  return restCall('LTRIM', key, start, stop);
}

// M-P0-19 fix (2026-04-23): atomic LPUSH + LTRIM in één round-trip.
//
// PROBLEEM: het oude pattern `await lpush(); await ltrim();` heeft een TOCTOU-gap.
// Als de eerste call slaagt en de tweede faalt (network blip, container crash,
// timeout), groeit de lijst ongebreideld. Bij high-frequency audit logs
// (signal_audit_events:* @ 5000 cap) leidt dit tot Redis OOM op lange termijn.
//
// FIX: ioredis MULTI (atomic transaction). REST: pipeline endpoint (non-tx maar
// single round-trip — de gap is teruggebracht naar 0ms i.p.v. tot 5s).
async function lpushTrim(key, value, trimStart, trimStop) {
  const v = typeof value === 'string' ? value : JSON.stringify(value);
  if (useIoredis()) {
    const c = await getClient();
    return c.multi().lpush(key, v).ltrim(key, trimStart, trimStop).exec();
  }
  // Upstash REST pipeline endpoint
  const url = REST_URL.replace(/\/?$/, '/pipeline');
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${REST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([
      ['LPUSH', key, v],
      ['LTRIM', key, trimStart, trimStop],
    ]),
  });
  if (!resp.ok) throw new Error(`Redis pipeline LPUSH+LTRIM failed: ${resp.status}`);
  return resp.json();
}

// SET key value NX EX ttlSec — atomic lock. Returns true if acquired.
async function setNxEx(key, value, ttlSec) {
  const v = typeof value === 'string' ? value : JSON.stringify(value);
  if (useIoredis()) {
    const c = await getClient();
    const r = await c.set(key, v, 'EX', ttlSec, 'NX');
    return r === 'OK';
  }
  const r = await restCall('SET', key, v, 'EX', ttlSec, 'NX');
  return r === 'OK' || r === true;
}

async function quit() {
  if (_client) { try { await _client.quit(); } catch {} _client = null; }
}

module.exports = { get, set, del, lpush, lrange, ltrim, lpushTrim, setNxEx, quit, isConfigured };
