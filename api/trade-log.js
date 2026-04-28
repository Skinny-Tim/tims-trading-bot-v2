// ═══ /api/trade-log — volledige trade log met open- en sluitreden ═══
//
// GET /api/trade-log               → laatste 200 gesloten trades
// GET /api/trade-log?limit=50      → laatste N trades
// GET /api/trade-log?token=BTC     → filter op coin
// GET /api/trade-log?format=csv    → CSV export

const redis = require('./_lib/redis');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const limit  = Math.min(parseInt(req.query?.limit  || '200', 10), 500);
    const token  = (req.query?.token || '').toUpperCase();
    const format = (req.query?.format || 'json').toLowerCase();

    // Haal trades op uit Redis
    let trades = await redis.lrange('portfolio:trades', 0, limit - 1) || [];

    // Filter op coin indien gevraagd
    if (token) trades = trades.filter(t => (t.token || '').toUpperCase() === token);

    // Verrijk elke trade met leesbare open- en sluitreden
    const enriched = trades.map(t => ({
      id:          t.id || t.posId || null,
      token:       t.token || '?',
      side:        t.side  || '?',
      bot:         t.bot   || 'paper_4h',
      stars:       t.stars || t.meta?.stars || null,

      // Timing
      openTime:    t.openTime  ? new Date(t.openTime).toISOString()  : null,
      closeTime:   t.closeTime ? new Date(t.closeTime).toISOString() : null,
      durationMin: t.openTime && t.closeTime
                     ? Math.round((t.closeTime - t.openTime) / 60000)
                     : null,

      // Prijzen
      entryPrice:  t.entryPrice  || null,
      exitPrice:   t.exitPrice   || null,
      stop:        t.stopAtOpen  || t.meta?.stopAtOpen || null,
      target1:     t.target1     || null,
      target:      t.target      || null,

      // P&L
      pnl:         t.pnl    != null ? +t.pnl.toFixed(4)    : null,
      pnlPct:      t.pnlPct != null ? +t.pnlPct.toFixed(2) : null,

      // ── Reden van OPENEN ──
      openReason: buildOpenReason(t),

      // ── Reden van SLUITEN ──
      closeReason: t.reason || 'Onbekend',

      // Extra context
      atrPct:      t.atrPct  != null ? +t.atrPct.toFixed(2)  : null,
      rr:          t.meta?.rr || null,
      kronosMode:  t.meta?.kronosMode || null,
      partial:     !!t.partialClosed,
    }));

    if (format === 'csv') {
      const cols = ['closeTime','token','side','stars','openReason','closeReason',
                    'entryPrice','exitPrice','pnl','pnlPct','durationMin','rr'];
      const rows = [cols.join(',')];
      for (const t of enriched) {
        rows.push(cols.map(c => {
          const v = t[c];
          if (v == null) return '';
          if (typeof v === 'string' && v.includes(',')) return `"${v.replace(/"/g,'""')}"`;
          return v;
        }).join(','));
      }
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="trade-log.csv"');
      return res.status(200).send(rows.join('\n'));
    }

    return res.status(200).json({
      ok: true,
      count: enriched.length,
      trades: enriched,
    });

  } catch (e) {
    console.error('[trade-log]', e.message);
    return res.status(500).json({ error: e.message });
  }
};

// ── Bouw een leesbare openingsreden uit trade metadata ──
function buildOpenReason(t) {
  const parts = [];

  // Sterren
  const stars = t.stars || t.meta?.stars;
  if (stars) parts.push(`${stars}★ confluence`);

  // Welke indicatoren gaven signaal
  const ind = t.meta?.indicators || t.indicators;
  if (Array.isArray(ind) && ind.length) {
    parts.push(`Indicatoren: ${ind.join(', ')}`);
  } else if (t.meta?.indicatorCount) {
    parts.push(`${t.meta.indicatorCount} indicatoren`);
  }

  // Elliott Wave info
  const ew = t.meta?.ew || t.ew;
  if (ew?.wave) parts.push(`EW Wave ${ew.wave}${ew.progress ? ` (${ew.progress}%)` : ''}`);

  // Kronos
  const kron = t.meta?.kronos || t.kronos;
  if (kron?.direction) parts.push(`Kronos: ${kron.direction} ${kron.pct ? kron.pct + '%' : ''}`);

  // R/R
  const rr = t.meta?.rr;
  if (rr) parts.push(`R/R ${rr}`);

  // ATR
  const atr = t.atrPct || t.meta?.atrPct;
  if (atr) parts.push(`ATR ${atr}%`);

  // Signaaltype
  const type = t.signalType || t.meta?.type || t.type;
  if (type && type !== t.side) parts.push(`Signaal: ${type}`);

  return parts.length ? parts.join(' · ') : `${t.side || '?'} signaal`;
}
