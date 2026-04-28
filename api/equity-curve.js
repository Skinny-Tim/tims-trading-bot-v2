// ═══ Equity Curve endpoint ═══
//
// Reconstrueert de portfolio equity curve van startDate tot heden.
//
// Twee bronnen, in volgorde van voorkeur:
//   1. portfolio:equity  → tick-snapshots {time, value, byBot} gevuld door
//      paper-engine.js / kronos.js bij elke run. Max 2000 entries → typisch
//      1-2 weken historie op 5-10 min granulariteit. Geeft een NATUURLIJK
//      wavy lijn (zoals "Equity Curve (live)") want elke snapshot is een
//      mark-to-market sample met open posities én closed pnl.
//   2. portfolio:trades  → per-trade close events. Stappen-pattern lijn
//      (alleen realized pnl, vlak tussen trades). Fallback wanneer
//      portfolio:equity leeg is, en aanvulling voor history vóór de eerste
//      equity snapshot.
//
// Endpoint: GET /api/equity-curve
//
// Query:
//   ?bot=merlijn|kronos|all|total  (default: all → returnt total + per-bot decompose)
//   ?days=N                          (max 730, default: alles sinds startDate)
//   ?compact=1                       (laat summary weg — alleen { date, value })
//   ?source=auto|snapshots|trades    (default auto: snapshots als beschikbaar, anders trades)
//   ?granularity=auto|raw|day        (default auto: ~ 600 punten max, behoudt wave)
//
// Response: {
//   ok, source, granularity, startBalance, startDate, daysCount, tradesUsed, snapshotsUsed,
//   curve: [
//     { date: 'YYYY-MM-DD', ts: 1710..., total, merlijnPnl, kronosPnl },
//     ...
//   ],
//   summary: {
//     total:   { start, end, pnl, pnlPct, peak, maxDdPct },
//     merlijn: { start, end, pnl, pnlPct, peak, maxDdPct },
//     kronos:  { ... },
//   }
// }
//
// Deze module is GEEN aparte serverless function — wordt via ops.js dispatched.
// Routing: /api/equity-curve → /api/ops.js → equityCurveHandler

const portfolio = require('./_lib/portfolio');
const redis = require('./_lib/redis');

const BOT_KEY = { paper_4h: 'merlijn', paper_kronos: 'kronos' };
const MAX_POINTS_RETURN = 600;       // cap voor canvas-render performance
const MAX_SNAPSHOTS_FETCH = 2000;    // overeen met ltrim cap in portfolio.recordEquity

function ymd(ts) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function round2(n) { return Math.round(n * 100) / 100; }

// Statistiek op een 1-dimensionale serie (start = baseline)
function seriesStats(series, start) {
  if (!series.length) return { start, end: start, pnl: 0, pnlPct: 0, peak: start, maxDdPct: 0 };
  let runningPeak = start;
  let maxDd = 0;
  let peak = Math.max(start, ...series);
  for (const v of series) {
    if (v > runningPeak) runningPeak = v;
    const dd = runningPeak > 0 ? (runningPeak - v) / runningPeak : 0;
    if (dd > maxDd) maxDd = dd;
  }
  const end = series[series.length - 1];
  const pnl = end - start;
  const pnlPct = start !== 0 ? (pnl / Math.abs(start)) * 100 : 0;
  return {
    start: round2(start), end: round2(end),
    pnl: round2(pnl), pnlPct: round2(pnlPct),
    peak: round2(peak), maxDdPct: round2(maxDd * 100),
  };
}

// LTTB-light downsample: behoud eerste/laatste, sla regelmatig over zodat we
// onder MAX_POINTS_RETURN blijven zonder peaks/troughs te verliezen via een
// peak-aware bucket-pick.
function downsample(curve, maxPoints) {
  if (curve.length <= maxPoints) return curve;
  const bucketSize = curve.length / maxPoints;
  const out = [curve[0]];
  for (let b = 1; b < maxPoints - 1; b++) {
    const startIdx = Math.floor(b * bucketSize);
    const endIdx = Math.min(curve.length - 1, Math.floor((b + 1) * bucketSize));
    // Pak het punt met grootste |delta vs vorige out| — bewaart peaks
    let pick = startIdx;
    let bestDelta = -1;
    const prev = out[out.length - 1].total;
    for (let i = startIdx; i <= endIdx; i++) {
      const d = Math.abs((curve[i].total ?? 0) - prev);
      if (d > bestDelta) { bestDelta = d; pick = i; }
    }
    out.push(curve[pick]);
  }
  out.push(curve[curve.length - 1]);
  return out;
}

// Bouw curve uit portfolio:trades (per-trade granulariteit, stap-pattern).
// startDateMs: echte project-start (state.startDate) — anker komt daar te
// liggen zodat "Equity Curve sinds start" écht vanaf dag 0 vertrekt, niet
// pas vanaf de eerste trade.
function buildCurveFromTrades(trades, startBalance, startDateMs) {
  let totalBal = startBalance;
  let merlijnPnl = 0;
  let kronosPnl = 0;
  const curve = [];
  // Anker op echte startDate. Fallback: 1d vóór eerste trade als startDate
  // niet beschikbaar is; uiteindelijke fallback = nu (lege canvas voorkomen).
  const firstTradeTs = trades.length ? (trades[0].closeTime || Date.now()) : Date.now();
  const anchorTs = startDateMs && startDateMs < firstTradeTs
    ? startDateMs
    : (trades.length ? firstTradeTs - 1 : Date.now() - 24 * 3600 * 1000);
  curve.push({ date: ymd(anchorTs), ts: anchorTs, total: round2(totalBal), merlijnPnl: 0, kronosPnl: 0 });
  for (const t of trades) {
    const pnl = t.pnl || 0;
    totalBal += pnl;
    const botName = BOT_KEY[t.bot];
    if (botName === 'merlijn') merlijnPnl += pnl;
    else if (botName === 'kronos') kronosPnl += pnl;
    curve.push({
      date: ymd(t.closeTime || Date.now()),
      ts: t.closeTime || Date.now(),
      total: round2(totalBal),
      merlijnPnl: round2(merlijnPnl),
      kronosPnl: round2(kronosPnl),
    });
  }
  return curve;
}

// Bouw curve uit portfolio:equity snapshots. Snapshots geven al PV
// (mark-to-market), dus we hoeven niet te accumuleren — gewoon mappen.
// Per-bot pnl berekenen we cumulatief uit trades en alignen we per timestamp
// met de dichtstbijzijnde gesloten trade tot dat moment (zodat je de Merlijn
// en Kronos lijnen synchroon ziet bewegen met total).
//
// startDateMs: echte project-start. Het start-anker komt daar te liggen
// zodat "Equity Curve sinds start" altijd vanaf dag 0 vertrekt, ook als
// portfolio:equity pas later begon te samplen (snapshots ringbuffer = 2000
// entries → typisch 1-2 weken historie, terwijl het portfolio maanden oud
// kan zijn).
function buildCurveFromSnapshots(snapshots, trades, startBalance, startDateMs) {
  // Sort snapshots oldest-first (Redis lpush + lrange = newest-first)
  const ordered = snapshots
    .map(s => (typeof s === 'string' ? safeParse(s) : s))
    .filter(s => s && typeof s.value === 'number' && s.value > 0 && s.time)
    .sort((a, b) => a.time - b.time);

  if (ordered.length === 0) return [];

  // Cumulatieve per-bot pnl loopt mee met trades-tijdlijn
  let merlijnPnl = 0;
  let kronosPnl = 0;
  let tradeIdx = 0;
  const sortedTrades = (trades || []).slice().sort((a, b) => (a.closeTime || 0) - (b.closeTime || 0));

  const curve = [];
  for (const snap of ordered) {
    // Apply alle trades die tot/voor deze snap.time gesloten zijn
    while (tradeIdx < sortedTrades.length && (sortedTrades[tradeIdx].closeTime || 0) <= snap.time) {
      const t = sortedTrades[tradeIdx];
      const pnl = t.pnl || 0;
      const botName = BOT_KEY[t.bot];
      if (botName === 'merlijn') merlijnPnl += pnl;
      else if (botName === 'kronos') kronosPnl += pnl;
      tradeIdx++;
    }
    curve.push({
      date: ymd(snap.time),
      ts: snap.time,
      total: round2(snap.value),
      merlijnPnl: round2(merlijnPnl),
      kronosPnl: round2(kronosPnl),
    });
  }

  // Insert anchor at echte start zodat de lijn ALTIJD vanaf startBalance op
  // de werkelijke startDate vertrekt (niet pas vanaf eerste snapshot, die
  // dagen/weken later kan zijn dan de project start).
  // Twee gevallen:
  //   1. startDateMs beschikbaar én vóór eerste snapshot → anker op startDate
  //   2. anders → anker op (eerste snapshot - 1ms), oude gedrag
  if (curve.length) {
    const earliestSnapTs = curve[0].ts;
    const useExplicitStart = startDateMs && startDateMs < earliestSnapTs;
    const anchorTs = useExplicitStart ? startDateMs : earliestSnapTs - 1;
    const anchorBal = round2(startBalance);
    // Skip anker als eerste snapshot toevallig al exact startBalance toont
    // op exact startDate (zeldzaam; voorkomt dubbel anker-punt).
    const dupes = curve[0].total === anchorBal && curve[0].ts === anchorTs;
    if (!dupes) {
      curve.unshift({
        date: ymd(anchorTs),
        ts: anchorTs,
        total: anchorBal,
        merlijnPnl: 0,
        kronosPnl: 0,
      });
    }
  }
  return curve;
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const botFilter = String(req.query?.bot || 'all').toLowerCase();
    const daysCap = Math.min(parseInt(req.query?.days || '730', 10) || 730, 730);
    const compact = req.query?.compact === '1' || req.query?.compact === 'true';
    const sourcePref = String(req.query?.source || 'auto').toLowerCase();
    const granReq = String(req.query?.granularity || 'auto').toLowerCase();

    const state = await portfolio.loadState();
    const startBalance = state.startBalance || 10000;
    const startDateMs = state.startDate || Date.now() - 30 * 24 * 3600 * 1000;
    const startDateYmd = ymd(startDateMs);

    // Fetch beide bronnen parallel
    const [snapsRaw, allTradesRaw] = await Promise.all([
      sourcePref === 'trades'
        ? Promise.resolve([])
        : (redis.lrange('portfolio:equity', 0, MAX_SNAPSHOTS_FETCH - 1).catch(() => [])),
      redis.lrange('portfolio:trades', 0, 999).catch(() => []),
    ]);

    const snapshots = (snapsRaw || []).map(s => (typeof s === 'string' ? safeParse(s) : s)).filter(Boolean);
    const trades = (allTradesRaw || [])
      .filter(t => (t.closeTime || 0) > 0)
      .sort((a, b) => (a.closeTime || 0) - (b.closeTime || 0));

    // Kies bron + bouw curve. startDateMs zorgt dat het anker op de echte
    // project-start ligt (i.p.v. pas vanaf eerste snapshot/trade).
    let curve;
    let source;
    if (sourcePref === 'snapshots' || (sourcePref !== 'trades' && snapshots.length >= 5)) {
      curve = buildCurveFromSnapshots(snapshots, trades, startBalance, startDateMs);
      source = 'snapshots';
    } else {
      curve = buildCurveFromTrades(trades, startBalance, startDateMs);
      source = 'trades';
    }

    // Days cap (clip vanaf het einde, behoud meest recente).
    // BELANGRIJK: het start-anker (startBalance op startDate) wordt altijd
    // bewaard zodat "Equity Curve sinds start" zijn anker niet verliest, ook
    // niet als ?days= een korter venster vraagt.
    if (daysCap < 730 && curve.length) {
      const cutoff = Date.now() - daysCap * 24 * 3600 * 1000;
      const anchor = curve[0];
      curve = curve.filter(c => c.ts >= cutoff);
      // Plak anker terug aan het begin als het buiten het venster valt
      if (curve.length === 0 || curve[0].ts !== anchor.ts) {
        curve.unshift(anchor);
      }
    }

    // Granulariteit / downsample
    let granularity = 'raw';
    if (granReq === 'day') {
      // 1 punt per dag (laatste van die dag)
      const byDay = {};
      for (const c of curve) byDay[c.date] = c;
      curve = Object.values(byDay).sort((a, b) => (a.ts || 0) - (b.ts || 0));
      granularity = 'day';
    } else if (curve.length > MAX_POINTS_RETURN) {
      curve = downsample(curve, MAX_POINTS_RETURN);
      granularity = `lttb-${MAX_POINTS_RETURN}`;
    }

    // Summary op de finale curve
    const totalSeries = curve.map(c => c.total);
    const merlijnSeries = curve.map(c => c.merlijnPnl);
    const kronosSeries  = curve.map(c => c.kronosPnl);
    const summary = {
      total:   seriesStats(totalSeries, startBalance),
      merlijn: seriesStats(merlijnSeries, 0),
      kronos:  seriesStats(kronosSeries, 0),
    };

    // Filter response by bot if requested
    let outCurve = curve;
    if (botFilter === 'total') {
      outCurve = curve.map(c => ({ date: c.date, ts: c.ts, value: c.total }));
    } else if (botFilter === 'merlijn') {
      outCurve = curve.map(c => ({ date: c.date, ts: c.ts, value: c.merlijnPnl }));
    } else if (botFilter === 'kronos') {
      outCurve = curve.map(c => ({ date: c.date, ts: c.ts, value: c.kronosPnl }));
    }
    if (compact) outCurve = outCurve.map(c => ({ date: c.date, ts: c.ts, value: c.value ?? c.total }));

    return res.status(200).json({
      ok: true,
      source,
      granularity,
      startBalance,
      startDate: startDateYmd,
      generatedAt: new Date().toISOString(),
      daysCount: outCurve.length,         // legacy naam (eigenlijk pointsCount)
      pointsCount: outCurve.length,
      tradesUsed: trades.length,
      snapshotsUsed: snapshots.length,
      curve: outCurve,
      summary,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
