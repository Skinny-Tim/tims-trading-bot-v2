// ═══════════════════════════════════════════════════════════
// CENTRAAL EW AUDIT — client-side delegatie naar /api/ew-audit
// Gedeeld door index.html (Merlijn) + paper-trading.html (NØA Trading Arena).
// Camelot.html gebruikt geen Elliott Wave (regime-switch strategy).
// ═══════════════════════════════════════════════════════════
// Eén bron van waarheid: de server-side audit engine (_lib/signals.js).
// In-memory cache + localStorage persistence. Geen legacy fallback meer:
// bij cache-miss wordt een "pending" placeholder geretourneerd zodat het
// dashboard nooit een inconsistent lokaal-berekend label toont.
//
// Vóór 2026-04-22 stond dit blok 2× gedefinieerd (~100 regels duplicate).
// Bij refactor van één van de twee kon de andere drift veroorzaken
// (paper-trading vs. index zou voor zelfde token verschillende wave kunnen tonen).

(function (global) {
  'use strict';
  if (global._waveEngineLoaded) return;  // idempotent — als dit script per ongeluk 2× geladen wordt

  const _EW_LS_KEY = 'merlin_ew_cache_v1';
  const _EW_LS_MAX_AGE = 6 * 60 * 60 * 1000; // 6u — stale maar gealigneerd met server

  function _ewLoadFromLS() {
    try {
      const raw = localStorage.getItem(_EW_LS_KEY);
      if (!raw) return { cache: {}, ts: {} };
      const obj = JSON.parse(raw);
      const now = Date.now();
      const cache = {}, ts = {};
      for (const k of Object.keys(obj.ts || {})) {
        if (now - obj.ts[k] < _EW_LS_MAX_AGE) {
          cache[k] = obj.cache[k];
          ts[k] = obj.ts[k];
          if (cache[k]) cache[k].toString = function () { return this.currentWave; };
        }
      }
      return { cache, ts };
    } catch { return { cache: {}, ts: {} }; }
  }

  function _ewSaveToLS() {
    try {
      localStorage.setItem(_EW_LS_KEY, JSON.stringify({
        cache: global._ewAuditCache, ts: global._ewAuditFetchedAt
      }));
    } catch {}
  }

  const _ewBoot = _ewLoadFromLS();
  global._ewAuditCache = global._ewAuditCache || _ewBoot.cache;
  global._ewAuditFetchedAt = global._ewAuditFetchedAt || _ewBoot.ts;

  // Pending-placeholder: consistent shape, confidence 0 → signals-logic negeert het
  function _ewPending(symbol, tf) {
    return {
      symbol, timeframe: tf,
      currentWave: '…',
      status: 'pending',
      primary: { wave: null, confidence: 0, rationale: 'audit loading' },
      alternate: null,
      pivots: [], rejected: [],
      toString() { return '…'; },
    };
  }

  async function fetchEWAudit(symbol, tf) {
    const key = `${symbol}_${tf}`;
    const now = Date.now();
    const last = global._ewAuditFetchedAt[key] || 0;
    const ttl = tf === '1M' ? 10 * 60 * 1000 : 2 * 60 * 1000;
    if (now - last < ttl && global._ewAuditCache[key]) return global._ewAuditCache[key];
    try {
      const r = await fetch(`/api/ew-audit?symbol=${symbol}&tf=${tf}`);
      if (!r.ok) return global._ewAuditCache[key] || null;
      const d = await r.json();
      d.toString = function () { return this.currentWave; };
      global._ewAuditCache[key] = d;
      global._ewAuditFetchedAt[key] = now;
      _ewSaveToLS();
      return d;
    } catch (e) {
      console.warn('[EW] fetch failed:', e.message);
      return global._ewAuditCache[key] || null;
    }
  }

  // Prefetch — pages kunnen eigen token+tf list opgeven.
  // Default: 6 hoofd-tokens × ['4h','1M'] (zelfde als oude index.html)
  async function prefetchAllEW(opts) {
    const tokens = (opts && opts.tokens) || ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'HBARUSDT', 'XRPUSDT'];
    const tfs = (opts && opts.tfs) || ['4h', '1M'];
    const ps = [];
    for (const t of tokens) for (const tf of tfs) ps.push(fetchEWAudit(t, tf));
    await Promise.allSettled(ps);
    console.log(`[EW] Central audit cache synced (${tokens.length} tokens × ${tfs.length} tf)`);
  }

  // Publieke API — uitsluitend server-audit. Cache-miss → pending placeholder.
  // Start async fetch in background zodat volgende render wel een echt resultaat heeft.
  function detectElliottWave(highs, lows, pivotLen, opts) {
    const sym = opts && opts.symbol, tf = opts && opts.tf;
    if (!sym || !tf) return _ewPending(sym || 'UNKNOWN', tf || '4h');
    const key = `${sym}_${tf}`;
    const cached = global._ewAuditCache[key];
    if (cached) return cached;
    fetchEWAudit(sym, tf);  // trigger background fetch
    return _ewPending(sym, tf);
  }

  // Helper: extract wave-string uit result (string | object)
  function _ewStr(r) {
    if (r == null) return null;
    if (typeof r === 'string') return r;
    return r.currentWave || (r.primary && r.primary.wave) || null;
  }

  // Expose op window — bestaande code in index.html + paper-trading.html
  // verwacht globale functies (geen import). Dit is bewust geen ES module.
  global._ewPending = _ewPending;
  global.fetchEWAudit = fetchEWAudit;
  global.prefetchAllEW = prefetchAllEW;
  global.detectElliottWave = detectElliottWave;
  global._ewStr = _ewStr;
  global._waveEngineLoaded = true;
})(typeof window !== 'undefined' ? window : globalThis);
