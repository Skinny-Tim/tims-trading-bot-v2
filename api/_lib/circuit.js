// ═══ Hard circuit breakers — auto-trigger kill-switch ═══
//
// Bestaande circuit breakers in paper-engine.js / kronos.js doen "soft" pause
// (24u block) per-bot. Voor LIVE TRADING willen we OOK een hard guard die
// auto-pauseert via kill-switch als P&L door een vloer gaat. Dat zorgt ervoor
// dat NIEUWE trades worden geblokkeerd (kill-switch isBlocked()) totdat een
// mens manueel resume drukt.
//
// Thresholds (env-driven, defaults conservatief):
//   CIRCUIT_DAILY_LOSS_PCT     — als balance < startOfDayBalance * (1 - X%), trigger pause
//                                 default: 5% (live), 25% (paper)
//   CIRCUIT_WEEKLY_LOSS_PCT    — wekelijkse vloer (startOfWeek).
//                                 default: 15% (live), 50% (paper)
//   CIRCUIT_TOTAL_DD_PCT       — drawdown van peak equity ALL-TIME.
//                                 default: 30% (live), 80% (paper) — paper mag groter ademen
//   CIRCUIT_DAILY_TRADE_LIMIT  — max # trades per dag (volume-spike guard). default: 30 (live), 60 (paper)
//
// RATIONALE (paper-modus): paper trading = forward-test van een strategy-edge,
// NIET kapitaalbescherming. De enige reden om paper te pauzeren is een
// runaway-bug (engine spamt orders, loop-bug). Een rotte trading-dag van
// 12-20% verlies is geen reden om de bot te stoppen — dan zou je geen data
// meer verzamelen om te zien of de strategy zich herstelt of structureel
// faalt. Daarom paper-thresholds aanzienlijk hoger dan live.
//
// Per-bot variants: prefix CIRCUIT_<BOT>_*  e.g. CIRCUIT_MERLIJN_DAILY_LOSS_PCT
//
// Bij trigger:
//   1. Telegram alert (severity=critical)
//   2. Auto-pause via kill-switch (action=pause, scope=<bot>)
//   3. Audit-snapshot via recover.createSnapshot()
//
// Engines roepen `checkCircuit(bot)` aan AAN HET BEGIN van elke run.
// Als geblokkeerd, return early.

const redis = require('./redis');
const portfolio = require('./portfolio');

const TRIGGERED_KEY = 'circuit:triggered';     // dedupe → fire 1× per bot per dag

function envFloat(name, def) {
  const v = parseFloat(process.env[name] || '');
  return isFinite(v) && v > 0 ? v : def;
}
function envInt(name, def) {
  const v = parseInt(process.env[name] || '', 10);
  return isFinite(v) && v > 0 ? v : def;
}

// Get thresholds (with per-bot override fallback)
//
// Async ivm bot-config.getMode() Redis-read. Live-detection is nu de
// canonieke Redis-toggle (gezet via /api/bot-config UI), met env-fallback
// voor legacy operator overrides.
async function getThresholds(bot) {
  const upper = bot ? bot.toUpperCase() : '';
  // Resolve live status — Redis FIRST, env fallback (zelfde precedentie als execution._modeFor)
  let isLive = false;
  try {
    const cfg = require('./bot-config');
    const botKey = bot === 'merlijn' ? 'paper_4h' : (bot === 'kronos' ? 'paper_kronos' : null);
    if (botKey) {
      const m = await cfg.getMode(botKey);
      isLive = (m === 'live') && (process.env.LIVE_MAINNET_CONFIRM === 'YES_I_UNDERSTAND');
    }
  } catch (e) {
    console.warn(`[circuit] bot-config read failed for ${bot}: ${e.message} → env fallback`);
  }
  // Env fallback (legacy)
  if (!isLive) {
    isLive = (process.env.LIVE_MAINNET_CONFIRM === 'YES_I_UNDERSTAND') &&
             ((bot === 'merlijn' && process.env.MERLIJN_LIVE_NETWORK === 'mainnet') ||
              (bot === 'kronos' && process.env.KRONOS_LIVE_NETWORK === 'mainnet'));
  }
  // Paper mode = forward-test, niet kapitaalbescherming. Alleen vangnet voor
  // runaway-bugs (engine spamt orders, loop-bug). Defaults BEWUST hoog gezet.
  const dailyDefault       = isLive ? 5  : 25;
  const weeklyDefault      = isLive ? 15 : 50;
  const totalDdDefault     = isLive ? 30 : 80;
  const tradeLimitDefault  = isLive ? 30 : 60;
  return {
    dailyLossPct:   envFloat(`CIRCUIT_${upper}_DAILY_LOSS_PCT`,  envFloat('CIRCUIT_DAILY_LOSS_PCT',  dailyDefault)),
    weeklyLossPct:  envFloat(`CIRCUIT_${upper}_WEEKLY_LOSS_PCT`, envFloat('CIRCUIT_WEEKLY_LOSS_PCT', weeklyDefault)),
    totalDdPct:     envFloat(`CIRCUIT_${upper}_TOTAL_DD_PCT`,    envFloat('CIRCUIT_TOTAL_DD_PCT',    totalDdDefault)),
    dailyTradeLimit: envInt(`CIRCUIT_${upper}_DAILY_TRADE_LIMIT`, envInt('CIRCUIT_DAILY_TRADE_LIMIT', tradeLimitDefault)),
    isLive,
  };
}

function ymd(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}
function startOfTodayMs() {
  return Date.parse(ymd(Date.now()) + 'T00:00:00Z');
}
function startOfWeekMs() {
  const now = new Date();
  const dayOfWeek = (now.getUTCDay() + 6) % 7;   // monday=0
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - dayOfWeek));
  return monday.getTime();
}

// Compute P&L for a bot since `sinceMs`
async function computePnLSince(bot, sinceMs) {
  const trades = await redis.lrange('portfolio:trades', 0, 499) || [];
  const botKey = bot === 'merlijn' ? 'paper_4h' : (bot === 'kronos' ? 'paper_kronos' : null);
  let pnl = 0;
  let count = 0;
  for (const t of trades) {
    const ts = t.closeTime || t.openTime || 0;
    if (ts < sinceMs) continue;
    if (botKey && t.bot !== botKey) continue;
    pnl += (t.pnl || 0);
    count++;
  }
  return { pnl, count };
}

// Has this circuit fired today already? (dedupe)
async function alreadyFired(bot, kind) {
  const today = ymd();
  const key = `${TRIGGERED_KEY}:${today}:${bot}:${kind}`;
  const v = await redis.get(key);
  return !!v;
}
async function markFired(bot, kind) {
  const today = ymd();
  const key = `${TRIGGERED_KEY}:${today}:${bot}:${kind}`;
  await redis.set(key, { ts: Date.now() });
}

// Trigger kill-switch via direct state-write (bypass HTTP roundtrip)
// M-P0-20 fix (2026-04-23): acquire kill_switch:lock vóór write zodat we NOOIT
// een concurrent pause/panic/resume (vanuit kill-switch.js HTTP handler) clobberen.
// Als lock niet beschikbaar → skip deze fire (caller weet het al: alreadyFired()
// dedupe speelt ook alsnog z'n rol als de lock-houder klaar is).
async function autoPause(bot, kind, detail) {
  const KILL_SWITCH_KEY = 'kill_switch:state';
  const KILL_SWITCH_LOCK_KEY = 'kill_switch:lock';
  const reason = `AUTO ${kind.toUpperCase()}: ${detail}`;

  // Try-acquire lock met korte retry-budget — we willen de tick niet te lang blokkeren
  let locked = false;
  const start = Date.now();
  while (Date.now() - start < 3000) {
    const got = await redis.setNxEx(KILL_SWITCH_LOCK_KEY, { ts: Date.now(), by: 'circuit_autoPause' }, 60);
    if (got) { locked = true; break; }
    await new Promise(r => setTimeout(r, 200));
  }
  if (!locked) {
    console.warn(`[circuit] autoPause skipped — kill_switch:lock busy (${kind}/${bot}). Next tick retries.`);
    return { skipped: true, reason: 'lock_busy' };
  }

  try {
    const state = {
      active: true,
      reason: `PAUSE: ${reason}`,
      scope: bot || 'all',
      ts: Date.now(),
      by: 'circuit_monitor',
      closedCount: 0,
      autoTriggered: true,
    };
    await redis.set(KILL_SWITCH_KEY, state);

    // Pre-pause snapshot voor audit trail
    try {
      const recover = require('../recover');
      await recover.createSnapshot(`circuit_${kind}_${bot || 'all'}`);
    } catch (e) {
      console.warn('[circuit] snapshot fail:', e.message);
    }

    // Telegram alert
    try {
      const telegram = require('./telegram');
      await telegram.alertCircuitFired({
        bot: bot || 'all',
        kind,
        detail,
      });
    } catch (e) {
      console.warn('[circuit] telegram fail:', e.message);
    }

    await markFired(bot || 'all', kind);
    return state;
  } finally {
    try { await redis.del(KILL_SWITCH_LOCK_KEY); } catch {}
  }
}

// ── Hoofdcheck — roep dit aan in run-loop van paper-engine + kronos ──
// Returns: { tripped: bool, reason?, autoMode?, thresholds? }
async function checkCircuit(bot) {
  const t = await getThresholds(bot);
  const state = await portfolio.loadState();
  const balance = state?.balance || 0;
  const peakEquity = state?.peakEquity || balance;
  const startOfDay = startOfTodayMs();
  const startOfWeek = startOfWeekMs();

  // Snapshot van balance bij start-of-day — opgeslagen in state.byDay[ymd].startBalance
  // Lazy init: gebruik state.byBot[bot].balance als fallback
  const todayKey = ymd();
  const dayStartKey = `circuit:dayStart:${bot || 'total'}:${todayKey}`;
  let dayStartBalance = await redis.get(dayStartKey);
  if (!dayStartBalance) {
    dayStartBalance = { balance };
    await redis.set(dayStartKey, dayStartBalance);
  }

  // 1. DAILY LOSS check
  const { pnl: dailyPnl, count: dailyCount } = await computePnLSince(bot, startOfDay);
  const dayStart = dayStartBalance.balance || balance;
  const dailyLossPct = dayStart > 0 ? ((dayStart - balance) / dayStart) * 100 : 0;
  if (dailyLossPct >= t.dailyLossPct && !(await alreadyFired(bot, 'daily_loss'))) {
    const detail = `Daily loss ${dailyLossPct.toFixed(2)}% ≥ ${t.dailyLossPct}% (€${dayStart.toFixed(2)} → €${balance.toFixed(2)}, ${dailyCount} trades)`;
    await autoPause(bot, 'daily_loss', detail);
    return { tripped: true, reason: detail, kind: 'daily_loss', thresholds: t };
  }

  // 2. WEEKLY LOSS
  const { pnl: weeklyPnl } = await computePnLSince(bot, startOfWeek);
  const weeklyLossPct = peakEquity > 0 ? -(weeklyPnl / peakEquity) * 100 : 0;
  if (weeklyLossPct >= t.weeklyLossPct && !(await alreadyFired(bot, 'weekly_loss'))) {
    const detail = `Weekly loss ${weeklyLossPct.toFixed(2)}% ≥ ${t.weeklyLossPct}% (P&L since week start: $${weeklyPnl.toFixed(2)})`;
    await autoPause(bot, 'weekly_loss', detail);
    return { tripped: true, reason: detail, kind: 'weekly_loss', thresholds: t };
  }

  // 3. TOTAL DRAWDOWN from peak
  const totalDdPct = peakEquity > 0 ? ((peakEquity - balance) / peakEquity) * 100 : 0;
  if (totalDdPct >= t.totalDdPct && !(await alreadyFired(bot, 'total_dd'))) {
    const detail = `Total DD ${totalDdPct.toFixed(2)}% ≥ ${t.totalDdPct}% (peak $${peakEquity.toFixed(2)} → $${balance.toFixed(2)})`;
    await autoPause(bot, 'total_dd', detail);
    return { tripped: true, reason: detail, kind: 'total_dd', thresholds: t };
  }

  // 4. DAILY TRADE LIMIT (volume spike — bot loop bug?)
  if (dailyCount >= t.dailyTradeLimit && !(await alreadyFired(bot, 'trade_limit'))) {
    const detail = `Daily trade count ${dailyCount} ≥ ${t.dailyTradeLimit} (mogelijk loop-bug?)`;
    await autoPause(bot, 'trade_limit', detail);
    return { tripped: true, reason: detail, kind: 'trade_limit', thresholds: t };
  }

  return { tripped: false, daily: { pnl: dailyPnl, count: dailyCount, lossPct: dailyLossPct }, weekly: { pnl: weeklyPnl, lossPct: weeklyLossPct }, totalDdPct, thresholds: t };
}

module.exports = {
  checkCircuit,
  getThresholds,
  computePnLSince,
  autoPause,
};
