#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// Merlin Tick Worker — ms-latency stop/target detection 24/7 zonder browser
// ═══════════════════════════════════════════════════════════════════════════
//
// Wat doet deze worker?
//   1. Subscribe op Binance @trade WebSocket voor alle open-positie tokens
//   2. Per tick (~10-50ms na execution op Binance): check elke open positie
//      tegen z'n stop / target1 / target levels
//   3. Bij breach → fire-and-forget POST naar Vercel:
//        /api/kronos?action=run&tick=1   (voor paper_kronos posities)
//        /api/paper-engine?action=tick   (voor paper_4h posities)
//      Vercel doet de actual close (ms cold-start, sub-200ms total typisch)
//
// Latency budget (Europe → Binance Tokyo → Vercel ams1):
//   • Binance WS push: ~30-80ms na trade execution
//   • Lokale check:    < 1ms
//   • HTTP naar Vercel: ~50-150ms (warm), 1-3s (cold start)
//   • Vercel close:    50-100ms
//   ───────────────────────────────────────────────
//   TOTAAL warm:       ~150-300ms
//   TOTAAL cold:       1.2-3.5s
//
// Deployment: Railway / Fly.io / Render / VPS — zie WORKER_SETUP.md
//
// Polling: elke 10s fetch /api/portfolio-state om in-memory open-positie cache
// te refreshen. Tussen polls gebruikt worker laatste bekende posities + stops.
//
// Ticker subscriptions worden dynamisch herzien wanneer open-positie set
// verandert (nieuwe trade geopend / oude gesloten).
//
// ENV:
//   API_BASE              = https://your-app.vercel.app   (verplicht)
//   POLL_INTERVAL_MS      = 10000  (default; hoe vaak posities refreshen)
//   TRIGGER_COOLDOWN_MS   = 1500   (debounce per bot; voorkomt tick-storm)
//   LOG_LEVEL             = info | debug | quiet
// ═══════════════════════════════════════════════════════════════════════════

const WebSocket = require('ws');

const API_BASE = (process.env.API_BASE || '').replace(/\/$/, '');
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '10000', 10);
const TRIGGER_COOLDOWN_MS = parseInt(process.env.TRIGGER_COOLDOWN_MS || '1500', 10);
const FULL_RUN_INTERVAL_MS = parseInt(process.env.FULL_RUN_INTERVAL_MS || '60000', 10);
const PAPER_ENGINE_SECRET = process.env.PAPER_ENGINE_SECRET || '';
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();

if (!API_BASE) {
  console.error('FATAL: API_BASE env niet gezet. Voorbeeld: API_BASE=https://merlin-signal-dashboard.vercel.app');
  process.exit(1);
}

const log = {
  debug: (...a) => { if (LOG_LEVEL === 'debug') console.log('[D]', ...a); },
  info:  (...a) => { if (LOG_LEVEL !== 'quiet') console.log('[I]', ...a); },
  warn:  (...a) => console.warn('[W]', ...a),
  error: (...a) => console.error('[E]', ...a),
};

// In-memory state
let positions = [];               // [{token, side, stop, target, target1, partialClosed, bot, id}]
let lastTrigger = { paper_kronos: 0, paper_4h: 0 };
let ws = null;
let wsTokens = [];                // huidig gesubscribede tokens
let wsReconnectDelay = 1500;

// ── Fetch open posities van Vercel (single source of truth) ──
async function refreshPositions() {
  try {
    const resp = await fetch(`${API_BASE}/api/portfolio-state`, { cache: 'no-store' });
    if (!resp.ok) {
      log.warn(`portfolio-state HTTP ${resp.status}`);
      return;
    }
    const d = await resp.json();
    if (!d || !d.ok) return;
    const all = (d.state && Array.isArray(d.state.positions)) ? d.state.positions : [];
    positions = all
      .filter(p => p && p.token && (p.status == null || p.status === 'open'))
      .map(p => ({
        id: p.id,
        token: p.token,
        side: p.side,
        stop: Number(p.stop) || null,
        target: Number(p.target) || null,
        target1: Number(p.target1) || null,
        partialClosed: !!p.partialClosed,
        bot: p.bot || 'paper_4h',
      }));
    log.info(`refreshed ${positions.length} open positions: ${positions.map(p => p.token + p.side[0]).join(',')}`);
    syncWebSocket();
  } catch (e) {
    log.warn('refreshPositions err:', e.message);
  }
}

// ── Subscribe Binance @trade WS voor alle relevante tokens ──
function syncWebSocket() {
  const tokens = Array.from(new Set(positions.map(p => p.token))).sort();
  const sameSet = (tokens.length === wsTokens.length) && tokens.every((t, i) => t === wsTokens[i]);
  if (sameSet && ws && ws.readyState === WebSocket.OPEN) return;
  if (tokens.length === 0) {
    if (ws) { try { ws.close(); } catch {} ws = null; }
    wsTokens = [];
    log.info('no positions → WS closed');
    return;
  }
  if (ws) { try { ws.close(); } catch {} }
  wsTokens = tokens;
  // @trade = elke individuele trade-print (tens of times per second voor BTC)
  // Voor minder data-volume kun je @miniTicker gebruiken (1 update/sec).
  const streams = tokens.map(t => t.toLowerCase() + 'usdt@trade').join('/');
  const url = `wss://stream.binance.com:9443/stream?streams=${streams}`;
  log.info(`WS connecting: ${tokens.join(',')}`);
  ws = new WebSocket(url);
  ws.on('open', () => {
    log.info(`WS open: ${tokens.length} streams`);
    wsReconnectDelay = 1500;
  });
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      const data = msg.data || msg;
      const sym = (data.s || '').toUpperCase();
      if (!sym.endsWith('USDT')) return;
      const token = sym.slice(0, -4);
      const price = parseFloat(data.p);
      if (!isFinite(price) || price <= 0) return;
      checkBreach(token, price);
    } catch (e) { /* parse err — ignore */ }
  });
  ws.on('close', () => {
    log.warn(`WS closed → reconnect in ${wsReconnectDelay}ms`);
    setTimeout(syncWebSocket, wsReconnectDelay);
    wsReconnectDelay = Math.min(wsReconnectDelay * 1.6, 30000);
  });
  ws.on('error', (e) => {
    log.warn('WS error:', e.message);
    try { ws.close(); } catch {}
  });
}

// ── Tick-by-tick breach check (heet pad — moet < 1ms zijn) ──
function checkBreach(token, price) {
  for (const pos of positions) {
    if (pos.token !== token) continue;
    let breach = null;
    if (pos.side === 'LONG') {
      if (pos.stop && price <= pos.stop) breach = `stop@${pos.stop.toFixed(2)}`;
      else if (pos.target && price >= pos.target) breach = `target@${pos.target.toFixed(2)}`;
      else if (!pos.partialClosed && pos.target1 && price >= pos.target1) breach = `t1@${pos.target1.toFixed(2)}`;
    } else {
      if (pos.stop && price >= pos.stop) breach = `stop@${pos.stop.toFixed(2)}`;
      else if (pos.target && price <= pos.target) breach = `target@${pos.target.toFixed(2)}`;
      else if (!pos.partialClosed && pos.target1 && price <= pos.target1) breach = `t1@${pos.target1.toFixed(2)}`;
    }
    if (breach) {
      log.info(`🎯 BREACH ${token} ${pos.side} ${breach} tick=${price}`);
      triggerEngine(pos.bot, `${token} ${pos.side} ${breach}`);
    }
  }
}

// ── Trigger Vercel engine (debounced per bot) ──
async function triggerEngine(bot, reason) {
  const now = Date.now();
  if (now - (lastTrigger[bot] || 0) < TRIGGER_COOLDOWN_MS) {
    log.debug(`debounced ${bot}: ${reason}`);
    return;
  }
  lastTrigger[bot] = now;
  const url = bot === 'paper_kronos'
    ? `${API_BASE}/api/kronos?action=run&tick=1`
    : `${API_BASE}/api/paper-engine?action=tick`;
  const t0 = Date.now();
  try {
    const resp = await fetch(url, { cache: 'no-store' });
    const dt = Date.now() - t0;
    log.info(`→ ${bot} HTTP ${resp.status} (${dt}ms) ${reason}`);
    // Force position-refresh kort na trigger zodat closed pos verdwijnt
    setTimeout(refreshPositions, 1500);
  } catch (e) {
    log.warn(`trigger err ${bot}:`, e.message);
  }
}

// ── Full-cycle runs voor NIEUWE OPENS (elke 60s) ──
// Tick-trigger doet alleen close (manageOnly) voor sub-second latency.
// Voor opens hebben we de full signal-gen pipeline nodig — die draait hier
// elke 60s. Geen auth nodig voor /api/kronos?action=run (publiek). Voor
// /api/paper-engine?action=run is PAPER_ENGINE_SECRET nodig — als die env
// var is gezet, draait Merlijn ook elke 60s; anders skippen we 'm.
async function fullRunKronos() {
  const t0 = Date.now();
  try {
    const resp = await fetch(`${API_BASE}/api/kronos?action=run`, { cache: 'no-store' });
    const dt = Date.now() - t0;
    if (resp.ok) {
      const j = await resp.json().catch(() => null);
      const opened = j?.executed?.opened?.length || 0;
      const closed = j?.managed?.closed?.length || 0;
      log.info(`⚙ kronos full HTTP ${resp.status} (${dt}ms) opens=${opened} closes=${closed}`);
      if (opened || closed) setTimeout(refreshPositions, 1500);
    } else {
      log.warn(`⚙ kronos full HTTP ${resp.status} (${dt}ms)`);
    }
  } catch (e) {
    log.warn('full kronos err:', e.message);
  }
}

async function fullRunPaper() {
  if (!PAPER_ENGINE_SECRET) return;  // skip als geen secret beschikbaar
  const t0 = Date.now();
  try {
    const resp = await fetch(`${API_BASE}/api/paper-engine`, {
      cache: 'no-store',
      headers: { 'Authorization': `Bearer ${PAPER_ENGINE_SECRET}` },
    });
    const dt = Date.now() - t0;
    if (resp.ok) {
      const j = await resp.json().catch(() => null);
      const opened = j?.openPositions || 0;
      log.info(`⚙ paper full HTTP ${resp.status} (${dt}ms) PV=$${(j?.portfolioValue||0).toFixed(0)} open=${opened}`);
      setTimeout(refreshPositions, 1500);
    } else if (resp.status === 401) {
      log.warn(`⚙ paper full 401 — PAPER_ENGINE_SECRET klopt niet`);
    } else {
      log.warn(`⚙ paper full HTTP ${resp.status} (${dt}ms)`);
    }
  } catch (e) {
    log.warn('full paper err:', e.message);
  }
}

// ── Health endpoint zodat hosting platform "healthy" ziet ──
const http = require('http');
const PORT = parseInt(process.env.PORT || '3000', 10);
http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      uptime: Math.round(process.uptime()),
      positions: positions.length,
      tokens: wsTokens,
      wsReady: ws ? ws.readyState : null,
      apiBase: API_BASE,
      fullRunMs: FULL_RUN_INTERVAL_MS,
      paperEngineAuth: !!PAPER_ENGINE_SECRET,
    }));
  } else {
    res.writeHead(404);
    res.end();
  }
}).listen(PORT, () => log.info(`health endpoint: http://0.0.0.0:${PORT}/health`));

// ── Bootstrap ──
log.info(`tick-worker starting | API=${API_BASE} | poll=${POLL_INTERVAL_MS}ms | cooldown=${TRIGGER_COOLDOWN_MS}ms | fullRun=${FULL_RUN_INTERVAL_MS}ms | paperSecret=${PAPER_ENGINE_SECRET ? 'set' : 'none'}`);
refreshPositions();
setInterval(refreshPositions, POLL_INTERVAL_MS);

// Full-run loops voor nieuwe opens (apart van tick-driven closes).
// Jitter van 5s zodat Kronos en Paper niet precies gelijk firen en Vercel
// function concurrency niet pieken krijgt.
setTimeout(() => {
  fullRunKronos();
  setInterval(fullRunKronos, FULL_RUN_INTERVAL_MS);
}, 3000);
setTimeout(() => {
  fullRunPaper();
  setInterval(fullRunPaper, FULL_RUN_INTERVAL_MS);
}, 8000);

// Graceful shutdown
['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, () => {
  log.info(`${sig} received, exit`);
  if (ws) try { ws.close(); } catch {}
  process.exit(0);
}));
