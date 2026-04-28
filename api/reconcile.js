// ═══ Reconciliation cron — bot state ↔ exchange state ═══
//
// Doel: detecteer drift tussen wat onze bot DENKT dat open is, en wat de
// exchange ECHT laat zien. Drift = catastrophic risico in live trading.
//
// Loopt periodiek (Vercel cron / GitHub Actions / fly worker — doe maar). Elke run:
//   1. Voor elke LIVE bot, fetch open positions van exchange
//   2. Vergelijk met onze Redis-state (portfolio:positions filtered by bot)
//   3. Drift gevonden → Telegram alert (met details), mark in Redis
//   4. Daarnaast: vergelijk balance (state.balance vs exchange.availableBalance)
//
// Drift types:
//   - Bot heeft positie open, exchange niet (= ons stop is geraakt zonder dat
//     we 't doorhebben, OF we hebben order misseen)
//   - Exchange heeft positie open, bot niet (= manual order door user, OF
//     order is hangend gebleven)
//   - Beide hebben positie maar qty/side verschilt
//   - Balance > X% afwijking
//
// PAPER bots worden geskipt (geen exchange om mee te vergelijken).
//
// Endpoint: GET /api/reconcile  (geen auth — read only)
//   Optionele query: ?bot=merlijn|kronos|all  (default all)
//   Response: { ok, drifts: {merlijn:[], kronos:[]}, balances: {...} }

const portfolio = require('./_lib/portfolio');
const execution = require('./_lib/execution');
const telegram = require('./_lib/telegram');
const redis = require('./_lib/redis');

const RECONCILE_LOG_KEY = 'reconcile:last';
const DRIFT_QTY_TOLERANCE_PCT = parseFloat(process.env.RECONCILE_QTY_TOLERANCE_PCT || '2');     // 2% qty diff = drift
const DRIFT_BALANCE_TOLERANCE_PCT = parseFloat(process.env.RECONCILE_BALANCE_TOLERANCE_PCT || '5'); // 5% balance diff

// P1-11: alleen reconcileren tegen tokens die de bot daadwerkelijk traded.
// Anders triggert iedere persoonlijk-gehouden balans (bv. user heeft 0.5 ETH
// los staan op zijn account) een drift-alert. Mainnet-only relevant.
// Whitelist matcht TOKENS array uit paper-engine.js — dit MOET in sync blijven.
const MERLIJN_TRADED_TOKENS = new Set([
  'BTC','ETH','SOL','BNB','HBAR','XRP','AVAX','LINK','ADA','DOT','POL','DOGE','SUI','TRX','XLM',
]);

async function reconcileMerlijn() {
  const drifts = [];
  const mode = (await execution.getModeStatus()).merlijn;
  if (mode.mode !== 'live') {
    return { skipped: 'paper', drifts, balanceCheck: null };
  }
  const adapter = require('./_lib/exchange/binance-spot');
  if (!adapter.isConfigured()) {
    return { skipped: 'adapter not configured', drifts, balanceCheck: null };
  }

  // Fetch our state
  const positions = await portfolio.loadPositions();
  const ourPositions = portfolio.listOpenPositions(positions, { bot: 'paper_4h' });

  // Fetch exchange balances (spot heeft geen "positions" — alleen non-zero balances behalve USDT)
  const balances = await adapter.getAllBalances();
  const ourState = await portfolio.loadState();
  const exchangeUsdt = balances.find(b => b.asset === 'USDT')?.free || 0;
  const ourBalance = ourState?.byBot?.paper_4h?.balance || ourState?.balance || 0;

  // Build expected qty per token from our open positions
  const expectedByToken = {};
  for (const p of ourPositions) {
    expectedByToken[p.token] = (expectedByToken[p.token] || 0) + p.qty;
  }
  // Map exchange balances (non-USDT) to tokens.
  // P1-11: alleen tokens die de bot kan traden — anders flagt user's persoonlijke
  // holdings als drift (false positive).
  const exchangeByToken = {};
  for (const b of balances) {
    if (b.asset === 'USDT') continue;
    if (!MERLIJN_TRADED_TOKENS.has(b.asset)) continue;
    if (b.free + b.locked > 0) exchangeByToken[b.asset] = b.free + b.locked;
  }

  // Find drifts
  const allTokens = new Set([...Object.keys(expectedByToken), ...Object.keys(exchangeByToken)]);
  for (const token of allTokens) {
    const botQty = expectedByToken[token] || 0;
    const exQty = exchangeByToken[token] || 0;
    if (botQty === 0 && exQty === 0) continue;
    const maxQty = Math.max(botQty, exQty);
    const deltaPct = maxQty > 0 ? Math.abs(botQty - exQty) / maxQty * 100 : 0;
    if (deltaPct > DRIFT_QTY_TOLERANCE_PCT) {
      drifts.push({ token, botQty, exQty, deltaPct, type: 'qty_mismatch' });
    }
  }

  // Balance check
  let balanceCheck = null;
  if (ourBalance > 0 || exchangeUsdt > 0) {
    const max = Math.max(ourBalance, exchangeUsdt);
    const deltaPct = max > 0 ? Math.abs(ourBalance - exchangeUsdt) / max * 100 : 0;
    balanceCheck = { ourBalance, exchangeUsdt, deltaPct, drift: deltaPct > DRIFT_BALANCE_TOLERANCE_PCT };
    if (balanceCheck.drift) {
      drifts.push({ token: 'USDT', botQty: ourBalance, exQty: exchangeUsdt, deltaPct, type: 'balance_drift' });
    }
  }

  return { drifts, balanceCheck, network: mode.network };
}

async function reconcileKronos() {
  const drifts = [];
  const mode = (await execution.getModeStatus()).kronos;
  if (mode.mode !== 'live') {
    return { skipped: 'paper', drifts, balanceCheck: null };
  }
  const adapter = require('./_lib/exchange/binance-futures');
  if (!adapter.isConfigured()) {
    return { skipped: 'adapter not configured', drifts, balanceCheck: null };
  }

  const positions = await portfolio.loadPositions();
  const ourPositions = portfolio.listOpenPositions(positions, { bot: 'paper_kronos' });

  const exchangePositions = await adapter.getPositions();   // [{symbol, positionAmt, side, ...}]
  const ourState = await portfolio.loadState();
  const exchangeUsdt = await adapter.getBalance('USDT');
  const ourBalance = ourState?.byBot?.paper_kronos?.balance || ourState?.balance || 0;

  // Build expected per symbol (signed qty: + LONG, - SHORT)
  const expectedBySymbol = {};
  for (const p of ourPositions) {
    const sym = adapter.tokenToSymbol(p.token);
    const signedQty = p.side === 'LONG' ? p.qty : -p.qty;
    expectedBySymbol[sym] = (expectedBySymbol[sym] || 0) + signedQty;
  }
  const exchangeBySymbol = {};
  for (const ep of exchangePositions) {
    exchangeBySymbol[ep.symbol] = ep.positionAmt;
  }

  const allSymbols = new Set([...Object.keys(expectedBySymbol), ...Object.keys(exchangeBySymbol)]);
  for (const sym of allSymbols) {
    const botQty = expectedBySymbol[sym] || 0;
    const exQty = exchangeBySymbol[sym] || 0;
    if (botQty === 0 && exQty === 0) continue;
    const maxAbs = Math.max(Math.abs(botQty), Math.abs(exQty));
    const deltaPct = maxAbs > 0 ? Math.abs(botQty - exQty) / maxAbs * 100 : 0;
    // Side mismatch (one LONG, other SHORT) = altijd drift
    const sideMismatch = (botQty > 0 && exQty < 0) || (botQty < 0 && exQty > 0);
    if (sideMismatch || deltaPct > DRIFT_QTY_TOLERANCE_PCT) {
      drifts.push({ token: sym, botQty, exQty, deltaPct, type: sideMismatch ? 'side_mismatch' : 'qty_mismatch' });
    }
  }

  let balanceCheck = null;
  if (ourBalance > 0 || exchangeUsdt > 0) {
    const max = Math.max(ourBalance, exchangeUsdt);
    const deltaPct = max > 0 ? Math.abs(ourBalance - exchangeUsdt) / max * 100 : 0;
    balanceCheck = { ourBalance, exchangeUsdt, deltaPct, drift: deltaPct > DRIFT_BALANCE_TOLERANCE_PCT };
    if (balanceCheck.drift) {
      drifts.push({ token: 'USDT', botQty: ourBalance, exQty: exchangeUsdt, deltaPct, type: 'balance_drift' });
    }
  }

  return { drifts, balanceCheck, network: mode.network };
}

// ── Hoofdfunctie ──
async function runReconcile(scope = 'all') {
  const out = { ok: true, ts: Date.now(), scope, results: {} };

  if (scope === 'all' || scope === 'merlijn') {
    try {
      out.results.merlijn = await reconcileMerlijn();
      if (out.results.merlijn.drifts && out.results.merlijn.drifts.length > 0) {
        await telegram.alertReconcileDrift({
          bot: 'merlijn',
          exchange: `binance-spot (${out.results.merlijn.network})`,
          drifts: out.results.merlijn.drifts,
        });
      }
    } catch (e) {
      out.results.merlijn = { error: e.message };
      await telegram.sendAlert({
        severity: 'error', title: 'Merlijn reconciliation FAILED',
        message: e.message,
        dedupeKey: 'recon_err_merlijn',
      });
    }
  }

  if (scope === 'all' || scope === 'kronos') {
    try {
      out.results.kronos = await reconcileKronos();
      if (out.results.kronos.drifts && out.results.kronos.drifts.length > 0) {
        await telegram.alertReconcileDrift({
          bot: 'kronos',
          exchange: `binance-futures (${out.results.kronos.network})`,
          drifts: out.results.kronos.drifts,
        });
      }
    } catch (e) {
      out.results.kronos = { error: e.message };
      await telegram.sendAlert({
        severity: 'error', title: 'Kronos reconciliation FAILED',
        message: e.message,
        dedupeKey: 'recon_err_kronos',
      });
    }
  }

  // Persist last result voor health checks
  await redis.set(RECONCILE_LOG_KEY, out);
  return out;
}

// ── Drift-injection test (GO/NO-GO blocker #3) ──
//
// Doel: zonder echte drift in productie kunnen we niet bewijzen dat de
// alert-pipeline werkt. Operators moeten weten: "als drift om 3 uur 's nachts
// gebeurt, krijg ik een Telegram bericht?" Dit endpoint test dat.
//
// Wat het doet:
//   1. Genereert een synthetische drift-payload (geen state mutation!)
//   2. Roept telegram.alertReconcileDrift met de fake drift
//   3. Retourneert wat verstuurd is + Telegram-API success/fail
//
// Wat het NIET doet:
//   - Geen echte position injection (te risicovol — kan blijven hangen)
//   - Geen echte drift detection (dat doet runReconcile() bij echte run)
//   - Geen state mutatie (portfolio:positions blijft intact)
//
// Auth: KILL_SWITCH_TOKEN (anders kan iedereen Telegram spammen).
async function injectTestDrift({ bot = 'merlijn' } = {}) {
  const telegram = require('./_lib/telegram');
  const fakeDrifts = [
    { token: 'BTC',  botQty: 0.10,  exQty: 0.0,   deltaPct: 100.0, type: 'qty_mismatch' },
    { token: 'ETH',  botQty: 1.50,  exQty: 1.65,  deltaPct: 9.1,   type: 'qty_mismatch' },
    { token: 'USDT', botQty: 9500,  exQty: 10000, deltaPct: 5.0,   type: 'balance_drift' },
  ];
  const out = {
    injected: true,
    bot,
    fakeDrifts,
    telegramConfigured: telegram._isConfigured(),
    telegramSent: false,
    telegramError: null,
    note: 'Synthetic drift — geen state mutation. Verifieert alleen alert-pipeline.',
  };
  if (!out.telegramConfigured) {
    out.telegramError = 'Telegram niet configured (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID ontbreekt)';
    return out;
  }
  try {
    const sent = await telegram.alertReconcileDrift({
      bot: `${bot}_TEST`,                      // suffix zodat operators zien dat 't een test is
      exchange: 'inject-test (synthetic)',
      drifts: fakeDrifts,
    });
    out.telegramSent = !!sent;
    if (!sent) out.telegramError = 'sendAlert returned false (zie server logs voor reden — vaak rate-limit of throttle)';
  } catch (e) {
    out.telegramError = e.message;
  }
  return out;
}

const KILL_SWITCH_TOKEN = process.env.KILL_SWITCH_TOKEN || '';

// HTTP handler (Vercel serverless signature)
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const scope = (req.query?.bot || req.query?.scope || 'all').toLowerCase();
  if (!['all', 'merlijn', 'kronos'].includes(scope)) {
    return res.status(400).json({ error: `invalid scope: ${scope}` });
  }

  // Drift-injection test mode — auth-gated
  const inject = String(req.query?.inject || '').toLowerCase();
  if (inject === 'test') {
    if (!KILL_SWITCH_TOKEN) {
      return res.status(503).json({ error: 'KILL_SWITCH_TOKEN not configured — required for inject=test' });
    }
    const auth = req.headers['authorization'] || req.headers['Authorization'] || '';
    const queryToken = String(req.query?.token || '');
    const ok = auth === `Bearer ${KILL_SWITCH_TOKEN}` || queryToken === KILL_SWITCH_TOKEN;
    if (!ok) return res.status(401).json({ error: 'Unauthorized — pass Bearer or ?token= matching KILL_SWITCH_TOKEN' });
    try {
      const result = await injectTestDrift({ bot: scope === 'kronos' ? 'kronos' : 'merlijn' });
      return res.status(200).json({ ok: true, mode: 'inject-test', ts: Date.now(), ...result });
    } catch (e) {
      return res.status(500).json({ ok: false, mode: 'inject-test', error: e.message });
    }
  }

  try {
    const out = await runReconcile(scope);
    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

module.exports.runReconcile = runReconcile;
module.exports.reconcileMerlijn = reconcileMerlijn;
module.exports.reconcileKronos = reconcileKronos;
module.exports.injectTestDrift = injectTestDrift;
