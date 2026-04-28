// ═══ Audit trail endpoint ═══
//
// Doel: dagelijks immutable export van alles wat een trade beïnvloed heeft.
//   - state snapshot
//   - alle trades vandaag (paper_4h + paper_kronos)
//   - alle live order IDs (uit trade._live + position._live)
//   - kill-switch events vandaag
//   - reconcile drifts vandaag
//   - balance trajectory
//
// Output formaat: JSON (default) of CSV via ?format=csv
//
// Endpoints:
//   GET  /api/audit                                  → vandaag's audit (live build)
//   GET  /api/audit?date=YYYY-MM-DD                  → specifieke dag (uit Redis archive)
//   GET  /api/audit?range=N                          → laatste N dagen samengevat
//   GET  /api/audit?action=rejects&bot=paper_4h&hours=48
//                                                    → signal-audit stats (welke filters
//                                                       rejecten welke %, top tokens per filter)
//   POST /api/audit?action=archive                   → snapshot vandaag → cold archive (Redis key)
//
// Auto-archive draait via cron (1× per dag om 23:55 UTC).
// Archives bewaard in Redis: audit:archive:YYYY-MM-DD (TTL 365d).

const redis = require('./_lib/redis');
const portfolio = require('./_lib/portfolio');
const signalAudit = require('./_lib/signal-audit');

const ARCHIVE_PREFIX = 'audit:archive:';
const ARCHIVE_TTL_SEC = 365 * 24 * 3600;
const TOKEN = process.env.KILL_SWITCH_TOKEN || '';

function ymd(ts) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

function isToday(ts) {
  return ymd(ts) === ymd(Date.now());
}

// ── Bouw audit-bundel voor een dag ──
async function buildAudit(targetDate = null) {
  const today = targetDate || ymd(Date.now());
  const startOfDay = Date.parse(`${today}T00:00:00Z`);
  const endOfDay = startOfDay + 24 * 3600 * 1000;

  // State + posities (current — alleen relevant voor "today")
  const isLiveBuild = today === ymd(Date.now());
  const state = isLiveBuild ? await portfolio.loadState() : null;
  const positions = isLiveBuild ? await portfolio.loadPositions() : null;

  // Trades vandaag
  const allTrades = await redis.lrange('portfolio:trades', 0, 499) || [];
  const tradesToday = allTrades.filter(t => {
    const ts = t.closeTime || t.openTime || 0;
    return ts >= startOfDay && ts < endOfDay;
  });

  // Live order IDs (audit chain)
  const liveOrderIds = [];
  for (const t of tradesToday) {
    if (t._live?.orderId) liveOrderIds.push({ kind: 'entry', token: t.token, side: t.side, orderId: t._live.orderId, network: t._live.network });
    if (t._liveExit?.orderId) liveOrderIds.push({ kind: 'exit', token: t.token, side: t.side, orderId: t._liveExit.orderId, network: t._liveExit.network });
  }

  // Kill-switch state (current — full event log zou apart key vereisen)
  const ksState = await redis.get('kill_switch:state');
  const ksToday = ksState && ksState.ts && ksState.ts >= startOfDay && ksState.ts < endOfDay ? ksState : null;

  // Reconcile last result
  const reconLast = await redis.get('reconcile:last');
  const reconToday = reconLast && reconLast.ts >= startOfDay && reconLast.ts < endOfDay ? reconLast : null;

  // Equity curve points vandaag
  const equity = await redis.lrange('portfolio:equity', 0, 999) || [];
  const equityToday = equity.filter(e => e.ts >= startOfDay && e.ts < endOfDay);

  // P&L breakdown
  const pnl = {
    total: tradesToday.reduce((s, t) => s + (t.pnl || 0), 0),
    merlijn: tradesToday.filter(t => t.bot === 'paper_4h').reduce((s, t) => s + (t.pnl || 0), 0),
    kronos: tradesToday.filter(t => t.bot === 'paper_kronos').reduce((s, t) => s + (t.pnl || 0), 0),
    wins: tradesToday.filter(t => (t.pnl || 0) > 0).length,
    losses: tradesToday.filter(t => (t.pnl || 0) < 0).length,
    fees: tradesToday.reduce((s, t) => s + (t.fills?.totalCosts || 0), 0),
  };

  return {
    date: today,
    builtAt: new Date().toISOString(),
    pnl,
    tradesCount: tradesToday.length,
    trades: tradesToday,
    liveOrderIds,
    killSwitchEvent: ksToday,
    reconcileResult: reconToday,
    state: isLiveBuild ? {
      balance: state?.balance,
      peakEquity: state?.peakEquity,
      circuit: state?.circuit,
      byBot: state?.byBot,
    } : null,
    positionsOpen: isLiveBuild && positions ? Object.keys(positions).length : null,
    equityPoints: equityToday.length,
    integrity: {
      tradesWithLiveLink: tradesToday.filter(t => t._live || t._liveExit).length,
      tradesPaperOnly: tradesToday.filter(t => !t._live && !t._liveExit).length,
    },
  };
}

// ── Archive vandaag's audit ──
async function archiveToday() {
  const today = ymd(Date.now());
  const audit = await buildAudit(today);
  await redis.set(`${ARCHIVE_PREFIX}${today}`, audit);
  return { archived: today, tradesCount: audit.tradesCount, pnl: audit.pnl.total };
}

// ── Get archived audit ──
async function getArchived(date) {
  return redis.get(`${ARCHIVE_PREFIX}${date}`);
}

// ── Range summary (laatste N dagen) ──
async function rangeSummary(daysBack) {
  const out = [];
  const now = Date.now();
  for (let i = 0; i < daysBack; i++) {
    const d = ymd(now - i * 24 * 3600 * 1000);
    const archived = await getArchived(d);
    if (archived) {
      out.push({
        date: archived.date,
        tradesCount: archived.tradesCount,
        pnl: archived.pnl,
        positionsOpen: archived.positionsOpen,
        balance: archived.state?.balance,
      });
    } else if (i === 0) {
      // today fallback — live build
      const live = await buildAudit();
      out.push({
        date: live.date,
        tradesCount: live.tradesCount,
        pnl: live.pnl,
        positionsOpen: live.positionsOpen,
        balance: live.state?.balance,
        live: true,
      });
    }
  }
  return out;
}

// ── CSV exporter (voor accountant / spreadsheet) ──
function tradesToCSV(trades) {
  const cols = ['closeTime','bot','token','side','qty','entryPrice','exitPrice','pnl','pnlPct','reason','liveOrderId'];
  const rows = [cols.join(',')];
  for (const t of trades) {
    rows.push([
      t.closeTime ? new Date(t.closeTime).toISOString() : '',
      t.bot || '',
      t.token || '',
      t.side || '',
      t.qty != null ? t.qty : '',
      t.entryPrice != null ? t.entryPrice : '',
      t.exitPrice != null ? t.exitPrice : '',
      t.pnl != null ? t.pnl.toFixed(4) : '',
      t.pnlPct != null ? t.pnlPct.toFixed(2) : '',
      `"${(t.reason || '').replace(/"/g, '""')}"`,
      t._live?.orderId || t._liveExit?.orderId || '',
    ].join(','));
  }
  return rows.join('\n');
}

// ── HTTP handler ──
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const action = (req.query?.action || '').toLowerCase();
  const format = (req.query?.format || 'json').toLowerCase();

  // GET rejects — signal-audit stats (geen auth, public read-only diagnostics)
  if (action === 'rejects') {
    try {
      const bot = String(req.query?.bot || 'paper_4h').toLowerCase();
      const hours = Math.min(Math.max(parseInt(req.query?.hours, 10) || 48, 1), 168);
      const stats = await signalAudit.getStats(bot, hours);
      return res.status(200).json({ ok: true, ...stats });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // POST archive vereist auth
  if (action === 'archive') {
    if (!TOKEN) return res.status(503).json({ error: 'KILL_SWITCH_TOKEN not configured' });
    const auth = req.headers['authorization'] || req.headers['Authorization'] || '';
    // Cron secret ook accepteren zodat cron dit kan triggeren
    const cronSecret = process.env.CRON_SECRET || '';
    const okAuth = auth === `Bearer ${TOKEN}` || (cronSecret && auth === `Bearer ${cronSecret}`);
    if (!okAuth) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const result = await archiveToday();
      return res.status(200).json({ ok: true, ...result });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  try {
    // Range summary mode
    if (req.query?.range) {
      const days = Math.min(parseInt(req.query.range, 10) || 7, 90);
      const summary = await rangeSummary(days);
      return res.status(200).json({ ok: true, days, summary });
    }

    // Specific date mode
    if (req.query?.date) {
      const date = String(req.query.date);
      const archived = await getArchived(date);
      if (!archived) return res.status(404).json({ error: `no archive for ${date}` });
      if (format === 'csv') {
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="audit_${date}.csv"`);
        return res.status(200).send(tradesToCSV(archived.trades || []));
      }
      return res.status(200).json({ ok: true, audit: archived });
    }

    // Default: today's live audit
    const audit = await buildAudit();
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="audit_${audit.date}.csv"`);
      return res.status(200).send(tradesToCSV(audit.trades || []));
    }
    return res.status(200).json({ ok: true, audit });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

module.exports.buildAudit = buildAudit;
module.exports.archiveToday = archiveToday;
module.exports.getArchived = getArchived;
module.exports.rangeSummary = rangeSummary;
