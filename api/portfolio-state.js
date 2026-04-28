// ═══ Portfolio State — unified read endpoint ═══
// Leest portfolio:* keys (nieuwe unified model) en valt terug op paper:* (legacy).
// Dashboard/ntfy/backtest gebruiken dit endpoint als single source of truth.

const redis = require('./_lib/redis');
const portfolio = require('./_lib/portfolio');

const TOKENS = ['BTC','ETH','SOL','BNB','HBAR','XRP','AVAX','LINK','ADA','DOT','POL','DOGE','SUI','TRX','HYPE','XLM'];

const NTFY_REPORT_TOPIC = (process.env.NTFY_REPORT_TOPIC || 'merlijn-dagrapport-c4d8e9f1a2').trim();
const NTFY_REPORT_FILTER = (process.env.NTFY_REPORT_FILTER_TAG || 'rapport-x7m2k9p4').trim();
const NTFY_TOKEN = (process.env.NTFY_TOKEN || '').trim();

function fmtPrice(v) {
  if (v == null || isNaN(v)) return '—';
  if (v < 0.01) return Number(v).toFixed(6);
  if (v < 1)    return Number(v).toFixed(4);
  if (v < 100)  return Number(v).toFixed(2);
  return Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

async function sendNtfyReport(title, message) {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (NTFY_TOKEN) headers['Authorization'] = `Bearer ${NTFY_TOKEN}`;
    const tags = ['bar_chart', NTFY_REPORT_FILTER].filter(Boolean);
    const r = await fetch('https://ntfy.sh/', {
      method: 'POST', headers,
      body: JSON.stringify({ topic: NTFY_REPORT_TOPIC, title, message, tags, priority: 3 }),
    });
    return r.ok;
  } catch (e) { console.warn('[report] ntfy fail', e.message); return false; }
}

// ── Daily report builder ──
async function buildDailyReport() {
  const state = await portfolio.loadState();
  const positionsObj = await portfolio.loadPositions();
  const positions = Object.values(positionsObj || {});
  const tradesRaw = (await redis.lrange('portfolio:trades', 0, 199)) || [];
  const trades = tradesRaw.map(t => typeof t === 'string' ? JSON.parse(t) : t);

  const now = Date.now();
  const dayMs = 24 * 3600 * 1000;
  const tradesToday = trades.filter(t => (now - (t.closeTime || t.openTime || 0)) <= dayMs);

  // Aggregaten 24u
  const wins24 = tradesToday.filter(t => t.pnl > 0);
  const losses24 = tradesToday.filter(t => t.pnl <= 0);
  const pnl24 = tradesToday.reduce((s, t) => s + (t.pnl || 0), 0);
  const winrate24 = tradesToday.length > 0 ? wins24.length / tradesToday.length : 0;

  // All-time — gebruik portfolioValue (balance + open positions @ entry) ipv balance,
  // anders telt vastgezet kapitaal in open trades als "verlies".
  const winsAll = trades.filter(t => t.pnl > 0).length;
  const lossesAll = trades.filter(t => t.pnl <= 0).length;
  const winrateAll = trades.length > 0 ? winsAll / trades.length : 0;
  let pv = state.balance || 0;
  for (const p of positions) {
    const entryFee = p.fills?.entryFee || 0;
    if (p.side === 'LONG') pv += (p.qty || 0) * (p.entryPrice || 0);
    else pv += (p.sizeUsd || 0) - entryFee;
  }
  const startBal = state.startBalance || 10000;
  const pnlAll = pv - startBal;
  const pnlPctAll = (pv - startBal) / startBal * 100;

  // Open posities — gegroepeerd per bot
  const byBotPos = {};
  for (const p of positions) {
    const bot = p.bot || 'unknown';
    (byBotPos[bot] = byBotPos[bot] || []).push(p);
  }
  const openLines = [];
  for (const [bot, ps] of Object.entries(byBotPos)) {
    openLines.push(`[${bot}] ${ps.length} open:`);
    for (const p of ps) {
      const sideEmoji = p.side === 'LONG' ? '⬆' : '⬇';
      const holdH = p.openTime ? ((now - p.openTime) / 3.6e6).toFixed(1) : '—';
      openLines.push(`  ${sideEmoji} ${p.token} ${p.side} ${p.stars}★ @ ${fmtPrice(p.entryPrice)} · stop ${fmtPrice(p.stop)} · hold ${holdH}u`);
    }
  }

  // Trades 24u
  const tradeLines = tradesToday.slice(0, 10).map(t => {
    const win = (t.pnl || 0) >= 0 ? '✅' : '⛔';
    const sign = t.pnl >= 0 ? '+' : '';
    return `${win} ${t.token} ${t.side} ${t.stars || '-'}★ ${sign}$${(t.pnl || 0).toFixed(2)} (${sign}${(t.pnlPct || 0).toFixed(2)}%) · ${t.reason || '-'}`;
  });

  // Kronos snapshot — fetch lastSig per token uit Redis
  const kronosSnapshot = [];
  for (const tk of TOKENS) {
    try {
      const raw = await redis.get(`kronos:lastSig:${tk}`);
      if (!raw) continue;
      const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const ageH = obj.time ? ((now - obj.time) / 3.6e6).toFixed(1) : '?';
      const arrow = obj.type === 'BUY' ? '⬆' : '⬇';
      kronosSnapshot.push(`${arrow} ${tk} ${obj.type} ${obj.stars}★ ${obj.pct >= 0 ? '+' : ''}${obj.pct?.toFixed(2)}% (${ageH}u)`);
    } catch {}
  }

  // ── Kronos Test paper-bot (isolated namespace, €1000 base) ──
  let kronosBlock = null;
  try {
    const kStateRaw = await redis.get('kronos_paper:state');
    if (kStateRaw) {
      const kState = typeof kStateRaw === 'string' ? JSON.parse(kStateRaw) : kStateRaw;
      const kPosRaw = await redis.get('kronos_paper:positions');
      const kPos = kPosRaw ? Object.values(typeof kPosRaw === 'string' ? JSON.parse(kPosRaw) : kPosRaw) : [];
      const kTradesRaw = (await redis.lrange('kronos_paper:trades', 0, 99)) || [];
      const kTrades = kTradesRaw.map(t => typeof t === 'string' ? JSON.parse(t) : t);
      const kPv = (kState.balance || 0) + kPos.reduce((s, p) => s + (p.sizeUsd || 0), 0);
      const kPnl = kPv - (kState.startBalance || 10000);
      const kPnlPct = (kPnl / (kState.startBalance || 10000)) * 100;
      const kWins = kTrades.filter(t => t.pnl > 0).length;
      const kLosses = kTrades.filter(t => t.pnl <= 0).length;
      const kTradesToday = kTrades.filter(t => (now - (t.closeTime || t.openTime || 0)) <= dayMs);
      const kPnl24 = kTradesToday.reduce((s, t) => s + (t.pnl || 0), 0);
      kronosBlock = { kState, kPos, kTrades, kPv, kPnl, kPnlPct, kWins, kLosses, kTradesToday, kPnl24 };
    }
  } catch {}

  // Drawdown obv portfolioValue tov peak (niet balance — die zakt bij open trades)
  const peak = state.peakEquity || pv || 10000;
  const dd = peak > 0 ? Math.max(0, ((peak - pv) / peak) * 100) : 0;

  // Compose
  const dateStr = new Date().toLocaleDateString('nl-BE', { timeZone: 'Europe/Brussels', day: '2-digit', month: '2-digit', year: 'numeric' });
  const lines = [];
  lines.push(`📊 MERLIJN DAGRAPPORT — ${dateStr}`);
  lines.push('');
  lines.push(`💰 Portfolio: $${pv.toFixed(2)} (cash $${(state.balance || 0).toFixed(2)} + ${positions.length} open)`);
  lines.push(`📈 P&L all-time: ${pnlAll >= 0 ? '+' : ''}$${pnlAll.toFixed(2)} (${pnlPctAll >= 0 ? '+' : ''}${pnlPctAll.toFixed(2)}%)`);
  lines.push(`📉 Drawdown vanaf piek: ${dd.toFixed(2)}%`);
  lines.push(`🎯 Winrate all-time: ${(winrateAll * 100).toFixed(1)}% (${winsAll}W/${lossesAll}L · ${trades.length} trades)`);
  lines.push('');
  lines.push(`── Laatste 24u ──`);
  lines.push(`Trades: ${tradesToday.length} · ${wins24.length}W/${losses24.length}L · winrate ${(winrate24 * 100).toFixed(0)}%`);
  lines.push(`P&L 24u: ${pnl24 >= 0 ? '+' : ''}$${pnl24.toFixed(2)}`);
  if (tradeLines.length) {
    lines.push('');
    tradeLines.forEach(l => lines.push(l));
  }
  lines.push('');
  lines.push(`── Open posities (${positions.length}) ──`);
  if (openLines.length === 0) lines.push('(geen)');
  else openLines.forEach(l => lines.push(l));

  if (kronosSnapshot.length) {
    lines.push('');
    lines.push(`── Kronos AI snapshot ──`);
    kronosSnapshot.forEach(l => lines.push(l));
  }

  // ── Kronos Test paper-bot blok (apart) ──
  if (kronosBlock) {
    const kb = kronosBlock;
    lines.push('');
    lines.push(`── 🧪 Kronos Test (€${(kb.kState.startBalance || 10000).toFixed(0)} base) ──`);
    lines.push(`Portfolio: €${kb.kPv.toFixed(2)} · P&L ${kb.kPnl >= 0 ? '+' : ''}€${kb.kPnl.toFixed(2)} (${kb.kPnlPct >= 0 ? '+' : ''}${kb.kPnlPct.toFixed(2)}%)`);
    lines.push(`Trades all-time: ${kb.kTrades.length} · ${kb.kWins}W/${kb.kLosses}L · 24u P&L ${kb.kPnl24 >= 0 ? '+' : ''}€${kb.kPnl24.toFixed(2)}`);
    if (kb.kPos.length) {
      lines.push(`Open: ${kb.kPos.length}`);
      for (const p of kb.kPos) {
        const arr = p.side === 'LONG' ? '⬆' : '⬇';
        const holdH = p.openTime ? ((now - p.openTime)/3.6e6).toFixed(1) : '—';
        lines.push(`  ${arr} ${p.token} ${p.side} ${p.stars}★ @ ${fmtPrice(p.entryPrice)} → tgt ${fmtPrice(p.target)} · ${holdH}u`);
      }
    }
  }

  // ── Camelot paper-bot blok (apart) ──
  try {
    const cStateRaw = await redis.get('camelot:state');
    if (cStateRaw) {
      const cState = typeof cStateRaw === 'string' ? JSON.parse(cStateRaw) : cStateRaw;
      const cPosRaw = await redis.get('camelot:positions');
      const cPos = cPosRaw ? Object.values(typeof cPosRaw === 'string' ? JSON.parse(cPosRaw) : cPosRaw) : [];
      const cTradesRaw = (await redis.lrange('camelot:trades', 0, 99)) || [];
      const cTrades = cTradesRaw.map(t => typeof t === 'string' ? JSON.parse(t) : t);
      let cPv = cState.balance || 0;
      for (const p of cPos) {
        if (p.side === 'LONG') cPv += (p.qty || 0) * (p.entryPrice || 0);
        else cPv += (p.sizeUsd || 0);
      }
      const cStart = cState.startBalance || 10000;
      const cPnl = cPv - cStart;
      const cPnlPct = (cPnl / cStart) * 100;
      const cWins = cTrades.filter(t => t.pnl > 0).length;
      const cLosses = cTrades.filter(t => t.pnl <= 0).length;
      const cTradesToday = cTrades.filter(t => (now - (t.closeTime || t.openTime || 0)) <= dayMs);
      const cPnl24 = cTradesToday.reduce((s, t) => s + (t.pnl || 0), 0);
      lines.push('');
      lines.push(`── ⚔️ Camelot (€${cStart.toFixed(0)} base · regime-switch) ──`);
      lines.push(`Portfolio: €${cPv.toFixed(2)} · P&L ${cPnl >= 0 ? '+' : ''}€${cPnl.toFixed(2)} (${cPnlPct >= 0 ? '+' : ''}${cPnlPct.toFixed(2)}%)`);
      lines.push(`Trades: ${cTrades.length} · ${cWins}W/${cLosses}L · 24u P&L ${cPnl24 >= 0 ? '+' : ''}€${cPnl24.toFixed(2)}`);
      if (cPos.length) {
        lines.push(`Open: ${cPos.length}`);
        for (const p of cPos) {
          const arr = p.side === 'LONG' ? '⬆' : '⬇';
          const holdH = p.openTime ? ((now - p.openTime)/3.6e6).toFixed(1) : '—';
          lines.push(`  ${arr} ${p.token} ${p.side} [${p.regime}] @ ${fmtPrice(p.entryPrice)} → tgt ${fmtPrice(p.target)} · ${holdH}u`);
        }
      }
    }
  } catch {}

  if (state.circuit?.active) {
    lines.push('');
    lines.push(`🚨 Circuit breaker actief: ${state.circuit.reason}`);
  }

  return {
    title: `📊 Dagrapport ${dateStr} · ${pnl24 >= 0 ? '+' : ''}$${pnl24.toFixed(0)} (24u)`,
    body: lines.join('\n'),
    metrics: {
      balance: state.balance, pnlAll, pnlPctAll, drawdown: dd,
      tradesToday: tradesToday.length, winrate24, pnl24,
      winrateAll, totalTrades: trades.length,
      openPositions: positions.length,
      kronosSignals: kronosSnapshot.length,
    },
  };
}

module.exports = async (req, res) => {
  // Geen CDN-cache: positions/trades moeten realtime zijn anders krijg je
  // "gesloten trade komt terug" illusie wanneer de edge stale data serveert.
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  // ── Action: daily-report ──
  // GET /api/portfolio-state?action=daily-report  → bouw rapport en push ntfy
  // GET /api/portfolio-state?action=daily-report&push=0  → preview, geen ntfy
  const action = (req.query?.action || '').toLowerCase();
  if (action === 'daily-report') {
    try {
      if (!redis.isConfigured()) return res.status(503).json({ error: 'Redis not configured' });
      const report = await buildDailyReport();
      const push = req.query?.push !== '0';
      let pushed = false;
      if (push) pushed = await sendNtfyReport(report.title, report.body);
      return res.status(200).json({ ok: true, pushed, report });
    } catch (e) {
      console.error('[daily-report] error', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  try {
    if (!redis.isConfigured()) {
      return res.status(503).json({ error: 'Redis not configured' });
    }

    const [state, positionsObj, tradesNew, tradesLegacy, equityNew, equityLegacy] = await Promise.all([
      portfolio.loadState(),
      portfolio.loadPositions(),
      redis.lrange('portfolio:trades', 0, 199),
      redis.lrange('paper:trades',     0, 199),
      redis.lrange('portfolio:equity', 0, 499),
      redis.lrange('paper:equity',     0, 499),
    ]);

    // Prefer nieuwe keys, fallback naar legacy
    const trades = (tradesNew && tradesNew.length ? tradesNew : tradesLegacy) || [];
    const equity = (equityNew && equityNew.length ? equityNew : equityLegacy) || [];

    const rawPositions = Object.values(positionsObj || {});

    // Legacy-compat: dashboard verwacht `amount` (oude naam voor qty).
    // We injecteren ALIAS zodat zowel oude als nieuwe clients werken.
    const positions = rawPositions.map(p => ({
      ...p,
      amount: p.qty,               // legacy alias
    }));

    // Exposure per token + per cluster
    const clusters = (state.risk?.clusters) || {};
    const exposureByToken = {};
    for (const p of positions) {
      const key = p.token;
      exposureByToken[key] = (exposureByToken[key] || 0) + Math.abs(p.entryPrice - (p.initialStop || p.stop)) * p.qty;
    }
    const exposureByCluster = {};
    for (const [name, members] of Object.entries(clusters)) {
      exposureByCluster[name] = portfolio.computeExposure(positionsObj, { cluster: name, clusters });
    }
    const totalAtRisk = portfolio.computeExposure(positionsObj);

    // Per-bot breakdown uit open posities
    const byBot = { ...(state.byBot || {}) };
    for (const p of positions) {
      byBot[p.bot] = byBot[p.bot] || { openPositions: 0, atRisk: 0 };
      byBot[p.bot].openPositions = (byBot[p.bot].openPositions || 0) + 1;
      byBot[p.bot].atRisk = (byBot[p.bot].atRisk || 0) + Math.abs(p.entryPrice - (p.initialStop || p.stop)) * p.qty;
    }

    // Bereken portfolioValue = balance + marktwaarde open posities (op entry,
    // geen live prijs hier — dashboard kan zelf verbeteren met live prices).
    // Entry-fee zit voor LONG al in qty verwerkt; voor SHORT expliciet aftrekken.
    let pv = state.balance || 0;
    for (const p of positions) {
      const entryFee = p.fills?.entryFee || 0;
      if (p.side === 'LONG') pv += (p.qty || 0) * (p.entryPrice || 0);
      else pv += (p.sizeUsd || 0) - entryFee;
    }

    // Injecteer in state zodat legacy dashboard die state.positions leest WERKT.
    const stateOut = {
      ...state,
      positions,                         // legacy path
      portfolioValue: pv,                // voor dashboard P&L berekening
      totalAtRisk: portfolio.computeExposure(positionsObj),
      openPositions: positions.length,
    };

    // Optionele mode-status (paper/live + network) voor dashboard kill-switch panel.
    // Lazy require om geen circular issues te krijgen.
    let modeStatus = null;
    if ((req.query?.include || '').includes('mode')) {
      try {
        const execution = require('./_lib/execution');
        if (typeof execution.getModeStatus === 'function') {
          modeStatus = await execution.getModeStatus();
        }
      } catch (e) {
        console.warn('[portfolio-state] modeStatus skip:', e.message);
      }
    }

    return res.status(200).json({
      ok: true,
      ts: new Date().toISOString(),
      state: stateOut,
      positions,
      trades: trades.slice().reverse(),
      equity: equity.slice().reverse(),
      risk: {
        caps: state.risk,
        totalAtRisk,
        byToken: exposureByToken,
        byCluster: exposureByCluster,
      },
      byBot,
      ...(modeStatus ? { modeStatus } : {}),
    });
  } catch (e) {
    console.error('[portfolio-state] error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
