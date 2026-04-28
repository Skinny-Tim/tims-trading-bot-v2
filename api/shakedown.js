// ═══ /api/shakedown — End-to-end pre-live readiness check ═══
//
// Doel: voor je naar mainnet gaat, voer dit endpoint uit. Het exerciseert
// de hele live-trading pipeline (env / Redis / adapters / kill-switch /
// reconciliation / Telegram / signals) en geeft een PASS/FAIL rapport.
//
// Waarom dit nodig is (GO/NO-GO Blocker #1):
//   We hebben 11 P0 bugs gefixed, een live-dashboard gebouwd, een kill-
//   switch klaar staan. Maar er is nog NOOIT een end-to-end Binance-flow
//   getest. Dit endpoint is de "ground truth" check vóór mainnet.
//
// Twee modi:
//   GET /api/shakedown                  — read-only (default, veilig altijd)
//     - Env presence check (geen secrets in response)
//     - Redis ping
//     - Binance Spot adapter ping + getAccount (signed) — testnet OF mainnet
//     - Binance Futures adapter ping + getAccount (signed)
//     - Kill-switch status reachable (GET status, geen auth)
//     - Reconcile last-run age + drifts uit Redis
//     - Telegram configured (geen test-bericht tenzij gevraagd)
//     - Signal-audit Redis list reachable + count
//     - Cross-env consistency checks (BINANCE_*_NETWORK vs *_LIVE_NETWORK
//       vs LIVE_MAINNET_CONFIRM)
//
//   GET /api/shakedown?writeTest=1&token=<KILL_SWITCH_TOKEN>
//     - Read-only checks PLUS:
//     - Plaatst tiny LIMIT order ver onder mid-prijs op TESTNET enkel,
//       wacht 1s, cancelt 'm. Verifieert echte signed write-flow.
//     - Verstuurt 1 Telegram test-bericht.
//     - HARDE GUARD: weigert als BINANCE_*_NETWORK=mainnet. Geen mainnet
//       experimentele orders ooit.
//
// Response shape:
//   { ok, ts, summary: { pass, fail, warn }, checks: [...] }
//
// Per check: { id, label, status: 'pass'|'fail'|'warn'|'skip', detail?, ms? }
//
// Wat dit NIET doet:
//   - Geen panic-close test (separately doen via kill-switch)
//   - Geen full signal pipeline (separately via /api/signals-cron handmatig)
//   - Geen reconciliation trigger (separately via /api/reconcile)
//   Het is een fast pre-flight, geen full integration suite.

const redis    = require('./_lib/redis');
const botCfg   = require('./_lib/bot-config');
const telegram = require('./_lib/telegram');

const KILL_SWITCH_TOKEN = process.env.KILL_SWITCH_TOKEN || '';

function _check(id, label) {
  return {
    id,
    label,
    status: 'skip',
    detail: null,
    ms: null,
    _start: Date.now(),
    _finish(status, detail) {
      this.status = status;
      this.detail = detail || null;
      this.ms = Date.now() - this._start;
      delete this._start;
      delete this._finish;
      return this;
    },
  };
}

// ── 1. Environment presence ──
function checkEnv() {
  const c = _check('env', 'Environment variables');
  const env = {
    REDIS_URL_set: !!process.env.REDIS_URL,
    REDIS_REST_set: !!(process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL),
    KILL_SWITCH_TOKEN_set: !!KILL_SWITCH_TOKEN,
    KILL_SWITCH_TOKEN_len: KILL_SWITCH_TOKEN.length,
    TELEGRAM_BOT_TOKEN_set: !!process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID_set: !!process.env.TELEGRAM_CHAT_ID,
    BINANCE_SPOT_NETWORK: (process.env.BINANCE_SPOT_NETWORK || 'testnet').toLowerCase(),
    BINANCE_FUT_NETWORK:  (process.env.BINANCE_FUT_NETWORK  || 'testnet').toLowerCase(),
    MERLIJN_LIVE_NETWORK: (process.env.MERLIJN_LIVE_NETWORK || 'off').toLowerCase(),
    KRONOS_LIVE_NETWORK:  (process.env.KRONOS_LIVE_NETWORK  || 'off').toLowerCase(),
    LIVE_MAINNET_CONFIRM_set: process.env.LIVE_MAINNET_CONFIRM === 'YES_I_UNDERSTAND',
  };
  const missing = [];
  if (!env.REDIS_URL_set && !env.REDIS_REST_set) missing.push('Redis');
  if (!env.KILL_SWITCH_TOKEN_set) missing.push('KILL_SWITCH_TOKEN');
  if (env.KILL_SWITCH_TOKEN_set && env.KILL_SWITCH_TOKEN_len < 16) {
    missing.push('KILL_SWITCH_TOKEN too short (<16 chars)');
  }
  if (missing.length) return c._finish('fail', { missing, env });
  const warn = [];
  if (!env.TELEGRAM_BOT_TOKEN_set || !env.TELEGRAM_CHAT_ID_set) warn.push('Telegram alerts disabled');
  if (warn.length) return c._finish('warn', { warn, env });
  return c._finish('pass', { env });
}

// ── 2. Cross-env consistency ──
function checkConsistency(envCheck) {
  const c = _check('consistency', 'Cross-env consistency (network vs live-flag vs confirm)');
  const e = envCheck.detail?.env || {};
  const issues = [];
  // Merlijn: als MERLIJN_LIVE_NETWORK=mainnet maar BINANCE_SPOT_NETWORK=testnet
  // → execution.js routes naar live, adapter belt testnet — orders verdwijnen
  if (e.MERLIJN_LIVE_NETWORK !== 'off' && e.MERLIJN_LIVE_NETWORK !== e.BINANCE_SPOT_NETWORK) {
    issues.push(`MERLIJN_LIVE_NETWORK=${e.MERLIJN_LIVE_NETWORK} mismatch met BINANCE_SPOT_NETWORK=${e.BINANCE_SPOT_NETWORK}`);
  }
  if (e.KRONOS_LIVE_NETWORK !== 'off' && e.KRONOS_LIVE_NETWORK !== e.BINANCE_FUT_NETWORK) {
    issues.push(`KRONOS_LIVE_NETWORK=${e.KRONOS_LIVE_NETWORK} mismatch met BINANCE_FUT_NETWORK=${e.BINANCE_FUT_NETWORK}`);
  }
  // Mainnet zonder confirm = bot valt terug op paper — wellicht onbedoeld
  const wantsMainnet = e.MERLIJN_LIVE_NETWORK === 'mainnet' || e.KRONOS_LIVE_NETWORK === 'mainnet'
                    || e.BINANCE_SPOT_NETWORK === 'mainnet' || e.BINANCE_FUT_NETWORK === 'mainnet';
  if (wantsMainnet && !e.LIVE_MAINNET_CONFIRM_set) {
    issues.push('Mainnet network gevonden maar LIVE_MAINNET_CONFIRM=YES_I_UNDERSTAND ontbreekt — execution valt terug op paper');
  }
  if (issues.length) return c._finish('fail', { issues });
  return c._finish('pass', { e });
}

// ── 3. Redis ping ──
async function checkRedis() {
  const c = _check('redis', 'Redis connectivity (state store)');
  if (!redis.isConfigured()) return c._finish('fail', 'Redis not configured');
  try {
    const probeKey = `shakedown:probe:${Date.now()}`;
    await redis.set(probeKey, { ts: Date.now() });
    const back = await redis.get(probeKey);
    await redis.del(probeKey);
    if (!back) return c._finish('fail', 'set/get/del round-trip failed');
    return c._finish('pass', { roundtripOk: true });
  } catch (e) {
    return c._finish('fail', `Redis error: ${e.message}`);
  }
}

// ── 4. Binance Spot adapter (Merlijn) ──
async function checkSpotAdapter() {
  const c = _check('spot_adapter', 'Binance Spot adapter (Merlijn) — public ping + signed account');
  const spot = require('./_lib/exchange/binance-spot');
  if (!spot.isConfigured()) return c._finish('skip', 'Spot adapter not configured (missing API keys)');
  try {
    const t0 = Date.now();
    const serverTime = await spot.getServerTime();
    const skew = Date.now() - serverTime;
    const pingMs = Date.now() - t0;
    if (Math.abs(skew) > 5000) {
      return c._finish('warn', { network: spot.network(), serverTime, skewMs: skew, pingMs, hint: 'Clock skew > 5s — signed requests kunnen falen' });
    }
    // Signed call: getAccount
    const acc = await spot.getAccount();
    const balances = await spot.getAllBalances();
    const usdt = balances.find(b => b.asset === 'USDT');
    return c._finish('pass', {
      network: spot.network(),
      pingMs,
      skewMs: skew,
      accountType: acc?.accountType || null,
      canTrade: acc?.canTrade ?? null,
      balanceCount: balances.length,
      usdtPresent: !!(usdt && (usdt.free + usdt.locked) > 0),
      // GEEN balances-preview (security: zelfs als KILL_SWITCH_TOKEN leakt, geen account info exposure)
    });
  } catch (e) {
    const hint = /IP/i.test(e.message) ? 'Whitelist Vercel server-IP in Binance API settings'
               : /Invalid API/i.test(e.message) ? 'Key/secret klopt niet (of testnet keys op mainnet endpoint)'
               : /Signature/i.test(e.message) ? 'Secret klopt niet'
               : null;
    return c._finish('fail', { network: spot.network(), error: e.message, hint });
  }
}

// ── 5. Binance Futures adapter (Kronos) ──
async function checkFuturesAdapter() {
  const c = _check('futures_adapter', 'Binance Futures adapter (Kronos) — signed account');
  const fut = require('./_lib/exchange/binance-futures');
  if (!fut.isConfigured()) return c._finish('skip', 'Futures adapter not configured (missing API keys)');
  try {
    const t0 = Date.now();
    const acc = await fut.getAccount();
    const positions = await fut.getPositions();
    const pingMs = Date.now() - t0;
    const usdtAsset = (acc.assets || []).find(a => a.asset === 'USDT') || {};
    return c._finish('pass', {
      network: fut._network ? fut._network() : (process.env.BINANCE_FUT_NETWORK || 'testnet').toLowerCase(),
      pingMs,
      canTrade: acc?.canTrade ?? null,
      walletBalance: parseFloat(usdtAsset.walletBalance || 0),
      availableBalance: parseFloat(usdtAsset.availableBalance || 0),
      openPositionsCount: (positions || []).length,
    });
  } catch (e) {
    const hint = /IP/i.test(e.message) ? 'Whitelist Vercel server-IP'
               : /Invalid API/i.test(e.message) ? 'Key/secret klopt niet'
               : /Signature/i.test(e.message) ? 'Secret klopt niet'
               : null;
    return c._finish('fail', { error: e.message, hint });
  }
}

// ── 6. Kill-switch reachable ──
async function checkKillSwitch() {
  const c = _check('kill_switch', 'Kill-switch status reachable');
  try {
    const ks = require('./kill-switch');
    // Mock GET request, no token — public status endpoint
    let status = null;
    let statusCode = null;
    const mockReq = { method: 'GET', query: {}, body: {}, headers: {} };
    const mockRes = {
      setHeader() {},
      status(code) { statusCode = code; return this; },
      json(b) { status = b; return this; },
      end() {},
    };
    await ks(mockReq, mockRes);
    if (statusCode === 200 && status) {
      return c._finish('pass', { active: !!status.active, reason: status.reason || null, scope: status.scope || null });
    }
    return c._finish('fail', { statusCode, status });
  } catch (e) {
    return c._finish('fail', `kill-switch unreachable: ${e.message}`);
  }
}

// ── 7. Reconcile last-run ──
async function checkReconcile() {
  const c = _check('reconcile', 'Reconciliation last-run age + drifts');
  if (!redis.isConfigured()) return c._finish('skip', 'Redis not configured');
  try {
    const last = await redis.get('reconcile:last');
    if (!last || typeof last !== 'object') {
      return c._finish('warn', 'Geen reconcile:last in Redis — cron heeft nog niet gedraaid (of net cleared)');
    }
    const ageSec = last.ts ? Math.floor((Date.now() - last.ts) / 1000) : null;
    const drifts = {
      merlijn: (last.results?.merlijn?.drifts || []).length,
      kronos:  (last.results?.kronos?.drifts  || []).length,
    };
    const totalDrifts = drifts.merlijn + drifts.kronos;
    const stale = ageSec === null || ageSec > 30 * 60;   // > 2 misses op */15 cron
    if (totalDrifts > 0) {
      return c._finish('fail', { ageSec, drifts, hint: 'Drifts gevonden — fix vóór live (zie /api/reconcile)' });
    }
    if (stale) {
      return c._finish('warn', { ageSec, drifts, hint: 'Reconcile cron lijkt niet te lopen (>30 min oud) — check GH Actions reconcile-cron.yml' });
    }
    return c._finish('pass', { ageSec, drifts });
  } catch (e) {
    return c._finish('fail', `reconcile read fail: ${e.message}`);
  }
}

// ── 8. Telegram configured (no test-message unless writeTest) ──
function checkTelegram() {
  const c = _check('telegram', 'Telegram alerts configured');
  if (telegram._isConfigured()) {
    return c._finish('pass', { configured: true });
  }
  return c._finish('warn', { configured: false, hint: 'Set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID — anders krijg je geen drift/circuit alerts' });
}

// ── 9. Signal-audit reachable ──
async function checkSignalAudit() {
  const c = _check('signal_audit', 'Signal audit log reachable');
  if (!redis.isConfigured()) return c._finish('skip', 'Redis not configured');
  try {
    const m = await redis.lrange('signal_audit_events:paper_4h', 0, 0);
    const k = await redis.lrange('signal_audit_events:paper_kronos', 0, 0);
    return c._finish('pass', {
      merlijn_has_events: Array.isArray(m) && m.length > 0,
      kronos_has_events:  Array.isArray(k) && k.length > 0,
    });
  } catch (e) {
    return c._finish('warn', `signal-audit read fail (non-fatal): ${e.message}`);
  }
}

// ── 10. Bot config readable ──
async function checkBotConfig() {
  const c = _check('bot_config', 'Bot config readable');
  try {
    const merlijnMode = await botCfg.getMode('paper_4h');
    const kronosMode  = await botCfg.getMode('paper_kronos');
    const merlijnEn   = await botCfg.isEnabled('paper_4h');
    const kronosEn    = await botCfg.isEnabled('paper_kronos');
    return c._finish('pass', {
      merlijn: { mode: merlijnMode, enabled: merlijnEn },
      kronos:  { mode: kronosMode,  enabled: kronosEn },
      mainnetConfirmed: botCfg.isLiveMainnetConfirmed(),
    });
  } catch (e) {
    return c._finish('fail', `bot-config read fail: ${e.message}`);
  }
}

// ── 11. WRITE TEST (testnet only, gated) ──
// Plaatst tiny LIMIT order ver onder mid (unfillable), wacht, cancelt.
// Verifieert true signed write-flow + permissions + filter rounding.
// Faalt hard als network=mainnet. Geen mainnet experimentele orders ooit.
async function checkWriteTest() {
  const c = _check('write_test', 'Write test: place + cancel tiny LIMIT order (TESTNET)');
  const spot = require('./_lib/exchange/binance-spot');
  if (!spot.isConfigured()) return c._finish('skip', 'Spot adapter not configured');
  if (spot.network() !== 'testnet') {
    return c._finish('fail', `WRITE TEST GEWEIGERD: BINANCE_SPOT_NETWORK=${spot.network()} (alleen testnet toegestaan)`);
  }
  const symbol = 'BTCUSDT';
  const side = 'BUY';
  let orderId = null;
  try {
    // Mid-prijs, dan plaats LIMIT op 50% daaronder zodat 'ie nooit fillt
    const t = await spot.getTicker(symbol);
    const mid = t.last;
    if (!Number.isFinite(mid) || mid <= 0) return c._finish('fail', 'Ticker mid invalid');
    const limitPrice = mid * 0.5;
    // Min notional Binance Spot = 5 USDT — neem 6 om buffer te hebben
    const qty = 6 / limitPrice;
    const order = await spot.submitOrder({
      symbol, side, type: 'LIMIT', quantity: qty, price: limitPrice,
      clientOrderId: `shakedown_${Date.now()}_${Math.floor(Math.random()*1e6)}`,
    });
    orderId = order.orderId;
    // Wait 1s zodat 'ie zeker registered is
    await new Promise(r => setTimeout(r, 1000));
    await spot.cancelOrder(symbol, orderId);
    return c._finish('pass', {
      symbol, mid, limitPrice: +limitPrice.toFixed(2), qty: +qty.toFixed(6),
      orderId, placedAndCanceled: true,
    });
  } catch (e) {
    // Cleanup attempt — maybe order placed maar cancel failed
    if (orderId) {
      try { await spot.cancelOrder(symbol, orderId); } catch {}
    }
    return c._finish('fail', { error: e.message, orderId, hint: 'Check Binance testnet API permissions (Enable Spot Trading)' });
  }
}

// ── 12. WRITE TEST: Telegram (gated) ──
async function checkTelegramSend() {
  const c = _check('telegram_send', 'Telegram test message');
  if (!telegram._isConfigured()) return c._finish('skip', 'Telegram not configured');
  try {
    const sent = await telegram.alertTest();
    return sent ? c._finish('pass', { sent: true }) : c._finish('fail', 'send returned false');
  } catch (e) {
    return c._finish('fail', e.message);
  }
}

// ── Main runner ──
async function runShakedown({ writeTest = false } = {}) {
  const checks = [];
  // 1. Env first — drives others
  const envCheck = checkEnv();
  checks.push(envCheck);
  // 2. Consistency depends on env
  checks.push(checkConsistency(envCheck));

  // 3-10. Run in parallel where independent
  const [
    redisRes, spotRes, futRes, ksRes, recRes, audRes, cfgRes,
  ] = await Promise.all([
    checkRedis(),
    checkSpotAdapter(),
    checkFuturesAdapter(),
    checkKillSwitch(),
    checkReconcile(),
    checkSignalAudit(),
    checkBotConfig(),
  ]);
  checks.push(redisRes, spotRes, futRes, ksRes, recRes, audRes, cfgRes);
  checks.push(checkTelegram());

  // Optional write tests (sequential — placement requires preceding ping)
  if (writeTest) {
    checks.push(await checkWriteTest());
    checks.push(await checkTelegramSend());
  }

  const summary = { pass: 0, fail: 0, warn: 0, skip: 0, total: checks.length };
  for (const c of checks) summary[c.status]++;
  return {
    ok: summary.fail === 0,
    ts: Date.now(),
    isoTs: new Date().toISOString(),
    writeTestRan: !!writeTest,
    summary,
    checks,
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  const writeTest = String(req.query?.writeTest || '') === '1';

  // Write test requires KILL_SWITCH_TOKEN auth — voorkomt dat random visitor
  // kosten/orders triggert (zelfs op testnet betalen we geen geld, maar wel
  // rate-limit budget — én Telegram messages spam).
  if (writeTest) {
    if (!KILL_SWITCH_TOKEN) {
      return res.status(503).json({ error: 'KILL_SWITCH_TOKEN not configured — required for writeTest' });
    }
    const auth = req.headers['authorization'] || req.headers['Authorization'] || '';
    const queryToken = String(req.query?.token || '');
    const ok = auth === `Bearer ${KILL_SWITCH_TOKEN}` || queryToken === KILL_SWITCH_TOKEN;
    if (!ok) return res.status(401).json({ error: 'Unauthorized — pass Bearer or ?token= matching KILL_SWITCH_TOKEN' });
  }

  try {
    const out = await runShakedown({ writeTest });
    return res.status(out.ok ? 200 : 207).json(out);   // 207 = mixed (some failed)
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};

module.exports.runShakedown = runShakedown;
