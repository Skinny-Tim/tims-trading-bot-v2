// ═══ Signal-audit logger — wat reject welke filter? ═══
//
// Doel: empirische data verzamelen vóór live trading. Voor elk signaal dat
// tryOpen (paper) of executeKronosTrades (kronos) verwerkt, log het outcome:
//
//   outcome ∈ { 'opened' | 'rejected' | 'skipped' }
//   tag     = machine-friendly korte naam (bv. 'mtf_ema600', 'risk_cap')
//   reason  = full human-readable string (zoals nu in logs)
//
// Daarmee kun je over 48u testnet harde stats hebben:
//   "37% van BUY signals reject door MTF EMA600 macro-bias"
//   "12% van Kronos signals reject door price-drift"
//   "5% van opens worden post-fill weggekapt door risk-cap"
//
// Schema (Redis LIST, newest first):
//   signal_audit_events:paper_4h    — list van {ts,token,outcome,tag,reason,meta?}
//   signal_audit_events:paper_kronos
//
// Storage cap: ltrim @ 5000 events. Bij ~50 signals/uur × 12 tokens = 600/uur,
// dus dekt ~8u back. Voldoende voor 48u rolling stats want we re-aggregeren live.
// (Voor langere retentie: aparte daily-archive cron, niet hier.)
//
// All writes zijn best-effort: een Redis-fout mag NOOIT trade-flow breken.

const redis = require('./redis');

const KEY_PREFIX = 'signal_audit_events';
const MAX_EVENTS = 5000;

// ── Tag normalizer — extract korte machine-tag uit human-readable reason ──
// Heuristieken: matchen op bekende fragmenten in de reason-strings van
// paper-engine.js tryOpen() en kronos.js executeKronosTrades().
// Caller mag override leveren; anders inferren we hier.
function normalizeTag(reason) {
  if (!reason) return 'unknown';
  const s = String(reason).toLowerCase();

  // Filter-buckets — volgorde: meest-specifiek eerst
  if (s.includes('post-fill'))                                 return 'risk_cap_postfill';
  if (s.includes('risk-cap') || s.includes('risk cap'))        return 'risk_cap';
  if (s.includes('mtf macro'))                                 return 'mtf_ema600';
  if (s.includes('regime bull') || s.includes('regime bear'))  return 'regime_ema200';
  if (s.includes('kronos veto'))                               return 'kronos_veto';
  if (s.includes('kronos forecast') || s.includes('forecast stale')) return 'kronos_stale';
  if (s.includes('price-drift'))                               return 'price_drift';
  if (s.includes('cash buffer'))                               return 'cash_buffer';
  if (s.includes('portfolio kill-switch') || s.includes('24h drop')) return 'portfolio_killswitch';
  if (s.includes('kill-switch active'))                        return 'killswitch';
  if (s.includes('blacklist'))                                 return 'blacklist';
  if (s.includes('correlation guard'))                         return 'correlation';
  if (s.includes('cluster'))                                   return 'cluster';
  if (s.includes('per-token'))                                 return 'per_token_risk';
  if (s.includes('al open positie') || s.includes('al open'))  return 'already_open';
  if (s.includes('max positions') || s.includes('max ') && s.includes('open bereikt')) return 'max_open';
  if (s.includes('adaptive min'))                              return 'min_stars_adaptive';
  if (s.includes('min stars') || s.match(/★\s*<\s*\d+★/))      return 'min_stars';
  if (s.includes('atr ') && s.includes('te volatiel'))         return 'volatility_atr';
  if (s.includes('r/r ') && s.includes('< ') && s.includes(' min')) return 'min_rr';
  if (s.includes('te oud') || s.includes('latency'))           return 'latency';
  if (s.includes('venue') || s.includes('shorts_enabled') || s.includes('spot-only')) return 'venue_filter';
  if (s.includes('balance') && s.includes('< size'))           return 'insufficient_balance';
  if (s.includes('size') && s.includes('< min'))               return 'min_size';
  if (s.includes('no current price') || s.includes('geen current price')) return 'no_price';
  if (s.includes('live order failed') || s.includes('live-entry failed')) return 'live_entry_failed';
  if (s.includes('execution returned null'))                   return 'exec_null';
  if (s.includes('invalid entry sizing'))                      return 'invalid_sizing';
  if (s.includes('disabled'))                                  return 'bot_disabled';

  // Fallback: pak eerste 2-3 woorden, sanitize
  const words = s.split(/\s+/).slice(0, 3).join('_').replace(/[^a-z0-9_]/g, '');
  return words.slice(0, 30) || 'unknown';
}

// ── Best-effort recorder ──
// Throws nooit, returned silently bij elke fout. Failure modes:
//   - Redis niet configured → skip
//   - Redis write error → log warn, return
//   - Missing required arg → skip
async function record({ bot, token, outcome, reason = null, tag = null, meta = null }) {
  try {
    if (!redis.isConfigured()) return;
    if (!bot || !token || !outcome) return;
    const event = {
      ts: Date.now(),
      token: String(token).toUpperCase().slice(0, 12),
      outcome: String(outcome).toLowerCase().slice(0, 16),
      tag: tag || normalizeTag(reason),
      reason: reason ? String(reason).slice(0, 200) : null,
    };
    if (meta && typeof meta === 'object' && Object.keys(meta).length > 0) {
      // Slank metadata; voorkom dat we per ongeluk hele candle-arrays opslaan
      event.meta = {};
      for (const [k, v] of Object.entries(meta)) {
        if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') {
          event.meta[k] = v;
        }
      }
    }
    const key = `${KEY_PREFIX}:${bot}`;
    // M-P0-19 fix (2026-04-23): atomic lpush+ltrim om TOCTOU-gap te dichten
    // (zie redis.js lpushTrim — voorkomt unbounded list growth bij failed ltrim).
    await redis.lpushTrim(key, event, 0, MAX_EVENTS - 1);
  } catch (e) {
    console.warn(`[signal-audit] record fail (non-fatal): ${e.message}`);
  }
}

// ── Read + aggregate stats ──
// Returns:
// {
//   bot, hours, since, until, total: N, byOutcome: {opened: x, rejected: y, skipped: z},
//   byTag: { tag1: { count, byToken: { BTC: 5, ETH: 3 }, byOutcome: {...} }, ... },
//   byToken: { BTC: { count, byTag: {...}, byOutcome: {...} }, ... },
//   recent: [...last 50 events]
// }
async function getStats(bot, hoursBack = 48) {
  if (!redis.isConfigured()) return { error: 'redis not configured' };
  if (!bot) return { error: 'bot required' };

  const key = `${KEY_PREFIX}:${bot}`;
  const since = Date.now() - hoursBack * 3600 * 1000;
  const events = (await redis.lrange(key, 0, MAX_EVENTS - 1)) || [];

  const filtered = events.filter(e => e && e.ts && e.ts >= since);

  const byOutcome = { opened: 0, rejected: 0, skipped: 0 };
  const byTag = {};
  const byToken = {};

  for (const e of filtered) {
    const outcome = e.outcome || 'unknown';
    const tag = e.tag || 'unknown';
    const token = e.token || 'UNKNOWN';

    byOutcome[outcome] = (byOutcome[outcome] || 0) + 1;

    byTag[tag] = byTag[tag] || { count: 0, byToken: {}, byOutcome: {} };
    byTag[tag].count++;
    byTag[tag].byToken[token] = (byTag[tag].byToken[token] || 0) + 1;
    byTag[tag].byOutcome[outcome] = (byTag[tag].byOutcome[outcome] || 0) + 1;

    byToken[token] = byToken[token] || { count: 0, byTag: {}, byOutcome: {} };
    byToken[token].count++;
    byToken[token].byTag[tag] = (byToken[token].byTag[tag] || 0) + 1;
    byToken[token].byOutcome[outcome] = (byToken[token].byOutcome[outcome] || 0) + 1;
  }

  // Compute pass-rate per filter: voor elke "rejected" tag, wat is het aandeel?
  const totalSignals = filtered.length;
  const tagSummary = Object.entries(byTag).map(([tag, info]) => ({
    tag,
    count: info.count,
    pct: totalSignals > 0 ? +(info.count / totalSignals * 100).toFixed(1) : 0,
    byOutcome: info.byOutcome,
    topTokens: Object.entries(info.byToken)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([token, count]) => ({ token, count })),
  })).sort((a, b) => b.count - a.count);

  return {
    bot,
    hoursBack,
    since: new Date(since).toISOString(),
    until: new Date().toISOString(),
    totalEvents: totalSignals,
    byOutcome,
    openRate: totalSignals > 0 ? +(byOutcome.opened / totalSignals * 100).toFixed(1) : 0,
    rejectRate: totalSignals > 0 ? +((byOutcome.rejected + byOutcome.skipped) / totalSignals * 100).toFixed(1) : 0,
    tagSummary,
    byToken: Object.fromEntries(
      Object.entries(byToken)
        .sort((a, b) => b[1].count - a[1].count)
        .map(([token, info]) => [token, {
          count: info.count,
          byOutcome: info.byOutcome,
          topRejectTags: Object.entries(info.byTag)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([tag, count]) => ({ tag, count })),
        }])
    ),
    recent: filtered.slice(0, 50),
  };
}

module.exports = { record, getStats, normalizeTag };
