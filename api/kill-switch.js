// ═══ Kill-switch endpoint ═══
//
// Emergency stop voor live trading. 3 acties:
//   GET /api/kill-switch                     — status check (geen auth nodig)
//   POST /api/kill-switch?action=pause       — disable nieuwe opens (existing positions blijven)
//   POST /api/kill-switch?action=panic       — close ALL open positions + disable opens
//   POST /api/kill-switch?action=resume      — re-enable opens (na manual review)
//
// Auth: Bearer token in Authorization header (KILL_SWITCH_TOKEN env).
// Scope: per-bot of all (?bot=merlijn|kronos|all, default all).
//
// State opgeslagen in Redis key `kill_switch:state`:
//   { active, reason, scope, ts, by, closedCount }
//
// Engines (paper-engine, kronos) checken deze key bij iedere run en blokkeren
// nieuwe opens als active=true voor hun scope.

const redis = require('./_lib/redis');
const telegram = require('./_lib/telegram');

const KILL_SWITCH_KEY = 'kill_switch:state';
const KILL_SWITCH_LOCK_KEY = 'kill_switch:lock';      // M-P0-20
const KILL_SWITCH_TOKEN = process.env.KILL_SWITCH_TOKEN || '';

// ── State helpers ──
async function getKillSwitchState() {
  const s = await redis.get(KILL_SWITCH_KEY);
  if (!s || typeof s !== 'object') {
    return { active: false, reason: '', scope: 'all', ts: 0, by: '', closedCount: 0 };
  }
  return s;
}

async function setKillSwitchState(state) {
  await redis.set(KILL_SWITCH_KEY, state);
  return state;
}

// M-P0-20 fix (2026-04-23): kill-switch CAS race
//
// PROBLEEM: pause/panic/resume/autoPause schreven allemaal direct naar
// kill_switch:state zonder coördinatie. Race-scenario's:
//   1) Operator A klikt PANIC; panicCloseAll() loopt 30s. Operator B klikt
//      RESUME tussendoor. A's eindwrite (closedCount) overschrijft B's resume.
//   2) Operator klikt PANIC 2× snel achter elkaar → posities worden 2× force-closed.
//   3) Circuit autoPause() vuurt tegelijk met manual pause → metadata clobbered.
//
// FIX: setNxEx-based 60s lock rond ALLE state-mutaties (incl. panicCloseAll).
// Lock = "deze writer is exclusief eigenaar van kill_switch:state voor 60s".
// Concurrente writers krijgen 503 + duidelijke retry-hint.
async function _acquireKillSwitchLock(timeoutMs = 5000) {
  const start = Date.now();
  const ttlSec = 60;     // ruim genoeg voor panicCloseAll van max ~10 posities
  while (Date.now() - start < timeoutMs) {
    const got = await redis.setNxEx(KILL_SWITCH_LOCK_KEY, { ts: Date.now() }, ttlSec);
    if (got) return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}
async function _releaseKillSwitchLock() {
  try { await redis.del(KILL_SWITCH_LOCK_KEY); } catch {}
}

// Public helper voor engines om te checken: should we block opens?
// Returns: { blocked, reason, scope }
async function isBlocked(bot) {
  const s = await getKillSwitchState();
  if (!s.active) return { blocked: false };
  if (s.scope === 'all' || s.scope === bot) {
    return { blocked: true, reason: s.reason || 'kill-switch active', scope: s.scope };
  }
  return { blocked: false };
}

// ── Panic close: sluit alle open posities (binnen scope) ──
// Roept paper-engine of kronos aan via interne functies. Voor nu: markt-close
// via dezelfde paper-engine close path (wat in PAPER mode = simulated, in
// LIVE mode = real exchange market order).
async function panicCloseAll(scope) {
  let closedCount = 0;
  const errors = [];

  // P0-8: voorheen 'if (typeof fn === "function")' silently skipte. Nu: throw als
  // ontbrekend zodat panic-close NOOIT vals "success" rapporteert.
  // Lazy require om circular imports te vermijden
  try {
    if (scope === 'all' || scope === 'merlijn') {
      const portfolio = require('./_lib/portfolio');
      const positions = await portfolio.loadPositions();
      const merlijnPos = portfolio.listOpenPositions(positions, { bot: 'paper_4h' });
      const peng = require('./paper-engine');
      if (typeof peng.closePositionByForce !== 'function') {
        errors.push('CRITICAL: paper-engine.closePositionByForce not exported — cannot panic-close Merlijn');
      } else {
        for (const pos of merlijnPos) {
          try {
            await peng.closePositionByForce(pos.id, 'KILL_SWITCH');
            closedCount++;
          } catch (e) {
            errors.push(`merlijn ${pos.token} (id=${pos.id}): ${e.message}`);
          }
        }
      }
    }

    if (scope === 'all' || scope === 'kronos') {
      const portfolio = require('./_lib/portfolio');
      const positions = await portfolio.loadPositions();
      const kronosPos = portfolio.listOpenPositions(positions, { bot: 'paper_kronos' });
      const kron = require('./kronos');
      if (typeof kron.closePositionByForce !== 'function') {
        errors.push('CRITICAL: kronos.closePositionByForce not exported — cannot panic-close Kronos');
      } else {
        for (const pos of kronosPos) {
          try {
            await kron.closePositionByForce(pos.id, 'KILL_SWITCH');
            closedCount++;
          } catch (e) {
            errors.push(`kronos ${pos.token} (id=${pos.id}): ${e.message}`);
          }
        }
      }
    }
  } catch (e) {
    errors.push(`load_positions: ${e.message}`);
  }

  return { closedCount, errors };
}

// ── Panic dry-run: rapporteer wat een PANIC NU zou doen, zonder uit te voeren ──
//
// Doel (GO/NO-GO blocker #4): operators moeten panic-close kunnen testen
// vóór ze de echte rode knop indrukken. Een echte panic op live mainnet is
// niet "even uitproberen". Deze dryrun beantwoordt:
//   - Wat zou gesloten worden? (positions list per bot, met token/side/qty)
//   - Werkt de close-pad überhaupt? (closePositionByForce export check)
//   - Hoe groot is de blast radius? (count + indicatieve runtime)
//   - In welke mode (paper/live)? (zou orders naar exchange sturen of niet)
//
// Read-only — geen lock, geen state mutation, geen Telegram alert.
// Geen auth nodig (zelfde reden als /api/live-state public is: positie-info
// is al zichtbaar voor wie de URL kent; en lage friction = vaker gebruikt
// = veiliger).
async function panicDryrun(scope) {
  const report = {
    scope,
    ts: Date.now(),
    estimatedRuntimeSec: null,
    bots: {},
    overallReady: true,
    blockers: [],
  };

  const portfolio = require('./_lib/portfolio');
  const execution = require('./_lib/execution');
  let positions = [];
  try {
    positions = await portfolio.loadPositions();
  } catch (e) {
    report.blockers.push(`Cannot load positions: ${e.message}`);
    report.overallReady = false;
    return report;
  }

  let modeStatus = {};
  try {
    modeStatus = await execution.getModeStatus();
  } catch (e) {
    report.blockers.push(`Cannot read mode status: ${e.message}`);
  }

  let totalCount = 0;

  if (scope === 'all' || scope === 'merlijn') {
    const merlijnPos = portfolio.listOpenPositions(positions, { bot: 'paper_4h' });
    let exportOk = true;
    try {
      const peng = require('./paper-engine');
      exportOk = typeof peng.closePositionByForce === 'function';
    } catch (e) {
      exportOk = false;
      report.blockers.push(`paper-engine require failed: ${e.message}`);
    }
    const m = modeStatus.merlijn || {};
    report.bots.merlijn = {
      mode: m.mode || 'paper',
      network: m.network || null,
      closePositionByForceExported: exportOk,
      positionCount: merlijnPos.length,
      positions: merlijnPos.map(p => ({
        id: p.id,
        token: p.token,
        side: p.side,
        qty: p.qty,
        entryPrice: p.entry_price || p.entryPrice,
        openedAt: p.opened_at || p.openedAt,
        sizeUsd: p.size_usd || p.sizeUsd || null,
      })),
    };
    if (!exportOk && merlijnPos.length > 0) {
      report.overallReady = false;
      report.blockers.push('Merlijn closePositionByForce niet exported — panic zou silently 0 sluiten');
    }
    totalCount += merlijnPos.length;
  }

  if (scope === 'all' || scope === 'kronos') {
    const kronosPos = portfolio.listOpenPositions(positions, { bot: 'paper_kronos' });
    let exportOk = true;
    try {
      const kron = require('./kronos');
      exportOk = typeof kron.closePositionByForce === 'function';
    } catch (e) {
      exportOk = false;
      report.blockers.push(`kronos require failed: ${e.message}`);
    }
    const k = modeStatus.kronos || {};
    report.bots.kronos = {
      mode: k.mode || 'paper',
      network: k.network || null,
      closePositionByForceExported: exportOk,
      positionCount: kronosPos.length,
      positions: kronosPos.map(p => ({
        id: p.id,
        token: p.token,
        side: p.side,
        qty: p.qty,
        entryPrice: p.entry_price || p.entryPrice,
        openedAt: p.opened_at || p.openedAt,
        sizeUsd: p.size_usd || p.sizeUsd || null,
      })),
    };
    if (!exportOk && kronosPos.length > 0) {
      report.overallReady = false;
      report.blockers.push('Kronos closePositionByForce niet exported — panic zou silently 0 sluiten');
    }
    totalCount += kronosPos.length;
  }

  // ~2s per close gem. (1× cancel open orders + 1× market close order on exchange)
  // Lock TTL = 60s, dus warn als estimate > 50s
  report.estimatedRuntimeSec = totalCount * 2;
  if (report.estimatedRuntimeSec > 50) {
    report.blockers.push(`Estimated runtime ${report.estimatedRuntimeSec}s > 50s lock TTL — panic kan timeout. Consider scope-per-bot.`);
  }
  report.totalPositionCount = totalCount;
  return report;
}

// ── HTTP handler ──
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET ?action=panic-dryrun — read-only preview van wat een echte panic
  // zou doen. Geen auth (zie panicDryrun() comment voor reasoning).
  if (req.method === 'GET' && String(req.query.action || '').toLowerCase() === 'panic-dryrun') {
    const drScope = String(req.query.bot || req.query.scope || 'all').toLowerCase();
    if (!['merlijn', 'kronos', 'all'].includes(drScope)) {
      return res.status(400).json({ error: `invalid scope: ${drScope} (use merlijn|kronos|all)` });
    }
    try {
      const report = await panicDryrun(drScope);
      return res.status(200).json({ ok: true, action: 'panic-dryrun', ...report });
    } catch (e) {
      return res.status(500).json({ ok: false, action: 'panic-dryrun', error: e.message });
    }
  }

  // GET = public status (geen auth)
  if (req.method === 'GET' || !req.query.action) {
    const state = await getKillSwitchState();
    return res.status(200).json({
      ok: true,
      ...state,
      isoTs: state.ts ? new Date(state.ts).toISOString() : null,
    });
  }

  // Alle write actions vereisen auth
  if (!KILL_SWITCH_TOKEN) {
    return res.status(503).json({ error: 'KILL_SWITCH_TOKEN not configured on server' });
  }
  const auth = req.headers['authorization'] || req.headers['Authorization'] || '';
  if (auth !== `Bearer ${KILL_SWITCH_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const action = String(req.query.action || '').toLowerCase();
  const scope = String(req.query.bot || req.query.scope || 'all').toLowerCase();
  const reason = String(req.query.reason || req.body?.reason || 'manual');
  const by = String(req.query.by || req.body?.by || req.headers['x-user'] || 'api');

  if (!['merlijn', 'kronos', 'all'].includes(scope)) {
    return res.status(400).json({ error: `invalid scope: ${scope} (use merlijn|kronos|all)` });
  }

  if (action === 'pause') {
    // M-P0-20: lock om concurrent state-mutaties te serialiseren
    const got = await _acquireKillSwitchLock();
    if (!got) {
      return res.status(503).json({ error: 'kill-switch busy (another action in progress) — retry in 5s' });
    }
    try {
      const state = {
        active: true,
        reason: `PAUSE: ${reason}`,
        scope,
        ts: Date.now(),
        by,
        closedCount: 0,
      };
      await setKillSwitchState(state);
      await telegram.alertKillSwitch({ trigger: `pause (${reason})`, scope, closedCount: 0 });
      return res.status(200).json({ ok: true, action, ...state });
    } finally {
      await _releaseKillSwitchLock();
    }
  }

  if (action === 'panic') {
    // M-P0-20: lock zodat parallelle panic/resume/pause NIET racen met
    // de (langzame) panicCloseAll loop
    const got = await _acquireKillSwitchLock();
    if (!got) {
      return res.status(503).json({ error: 'kill-switch busy (another action in progress) — retry in 5s' });
    }
    try {
      // Pre-panic snapshot zodat we kunnen rollback'en als panic per ongeluk was
      let preSnapshot = null;
      try {
        const recover = require('./recover');
        preSnapshot = await recover.createSnapshot(`pre_panic_${scope}`);
      } catch (e) {
        console.warn('[kill-switch] pre-panic snapshot failed:', e.message);
      }
      // First: set state so any concurrent runs see the block
      await setKillSwitchState({
        active: true,
        reason: `PANIC: ${reason}`,
        scope,
        ts: Date.now(),
        by,
        closedCount: 0,
        preSnapshotId: preSnapshot?.id,
      });
      // Then: close all positions
      const { closedCount, errors } = await panicCloseAll(scope);
      // Update with final count
      const state = {
        active: true,
        reason: `PANIC: ${reason} (closed ${closedCount}${errors.length ? `, ${errors.length} errors` : ''})`,
        scope,
        ts: Date.now(),
        by,
        closedCount,
        preSnapshotId: preSnapshot?.id,
        errors: errors.length ? errors.slice(0, 10) : undefined,
      };
      await setKillSwitchState(state);
      await telegram.alertKillSwitch({ trigger: `panic (${reason})`, scope, closedCount });
      // P0-8: signal partial-failure via 207 Multi-Status zodat operator/CI weet
      // dat niet alle posities veilig gesloten zijn.
      const httpStatus = errors.length > 0 ? 207 : 200;
      return res.status(httpStatus).json({ ok: errors.length === 0, action, closedCount, errors, ...state });
    } finally {
      await _releaseKillSwitchLock();
    }
  }

  if (action === 'telegram-test') {
    // Diagnostic: check env-var presence + send test + capture raw Telegram API response.
    // Geen secrets in response — alleen lengtes + boolean flags.
    const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
    const TG_CHAT  = process.env.TELEGRAM_CHAT_ID  || '';
    const TG_DISABLE = process.env.TELEGRAM_DISABLE === '1';
    const diag = {
      env: {
        TELEGRAM_BOT_TOKEN_set: !!TG_TOKEN,
        TELEGRAM_BOT_TOKEN_len: TG_TOKEN.length,
        TELEGRAM_BOT_TOKEN_format_ok: /^\d+:[A-Za-z0-9_-]{20,}$/.test(TG_TOKEN),
        TELEGRAM_CHAT_ID_set: !!TG_CHAT,
        TELEGRAM_CHAT_ID_len: TG_CHAT.length,
        TELEGRAM_CHAT_ID_value_preview: TG_CHAT ? `${TG_CHAT.slice(0, 2)}...${TG_CHAT.slice(-2)}` : '',
        TELEGRAM_DISABLE: TG_DISABLE,
      },
      telegram_module_isConfigured: typeof telegram._isConfigured === 'function' ? telegram._isConfigured() : null,
    };
    if (!TG_TOKEN || !TG_CHAT) {
      diag.error = 'Token or chat_id missing — set both env vars on Vercel and redeploy.';
      return res.status(200).json({ ok: false, ...diag });
    }
    // Direct API call (bypasst module zodat we de raw response zien)
    try {
      const apiResp = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TG_CHAT,
          text: `🧪 Telegram diagnostic test — ${new Date().toISOString()}`,
          disable_notification: false,
        }),
      });
      const apiBody = await apiResp.text();
      diag.telegram_api = {
        status: apiResp.status,
        ok: apiResp.ok,
        body: apiBody.slice(0, 500),
      };
      return res.status(200).json({ ok: apiResp.ok, ...diag });
    } catch (e) {
      diag.telegram_api_error = e.message;
      return res.status(200).json({ ok: false, ...diag });
    }
  }

  if (action === 'binance-test') {
    // Diagnostic: verifieer Binance Spot Testnet (of Mainnet) credentials.
    // Doet 1 public call (getServerTime) + 1 signed call (getAccount).
    // Geeft env-var presence terug + flagt veelgemaakte misconfiguraties.
    // Geen secrets in response — alleen lengtes + boolean flags + niet-gevoelige info.
    const network = (process.env.BINANCE_SPOT_NETWORK || 'testnet').toLowerCase();
    const isTestnet = network === 'testnet';
    const KEY = isTestnet ? 'BINANCE_SPOT_TESTNET_KEY' : 'BINANCE_SPOT_MAINNET_KEY';
    const SEC = isTestnet ? 'BINANCE_SPOT_TESTNET_SECRET' : 'BINANCE_SPOT_MAINNET_SECRET';
    const apiKey = process.env[KEY] || '';
    const apiSec = process.env[SEC] || '';
    const merlijnLive = (process.env.MERLIJN_LIVE_NETWORK || 'off').toLowerCase();
    const liveConfirm = process.env.LIVE_MAINNET_CONFIRM === 'YES_I_UNDERSTAND';

    const diag = {
      env: {
        BINANCE_SPOT_NETWORK: network,
        [`${KEY}_set`]: !!apiKey,
        [`${KEY}_len`]: apiKey.length,
        [`${SEC}_set`]: !!apiSec,
        [`${SEC}_len`]: apiSec.length,
        MERLIJN_LIVE_NETWORK: merlijnLive,
        LIVE_MAINNET_CONFIRM_set: liveConfirm,
      },
      consistency: {
        // Veelgemaakte fout: MERLIJN_LIVE_NETWORK=mainnet maar BINANCE_SPOT_NETWORK=testnet
        // → execution.js denkt live, adapter belt testnet endpoint = orders gaan nergens heen
        merlijn_vs_spot_match: (merlijnLive === 'off' || merlijnLive === network),
        mainnet_requires_confirm: !(network === 'mainnet') || liveConfirm,
      },
      hint: {
        testnet_setup: 'https://testnet.binance.vision/ → "Generate HMAC_SHA256 Key" → set BINANCE_SPOT_TESTNET_KEY + BINANCE_SPOT_TESTNET_SECRET on Vercel',
        live_enable: 'set MERLIJN_LIVE_NETWORK=testnet (of mainnet + LIVE_MAINNET_CONFIRM=YES_I_UNDERSTAND) en redeploy',
      },
    };

    if (!apiKey || !apiSec) {
      diag.error = `Missing ${!apiKey ? KEY : SEC} env var on server.`;
      return res.status(200).json({ ok: false, ...diag });
    }

    // Test 1: public ping (geen auth) — verifieert connectivity
    try {
      const spot = require('./_lib/exchange/binance-spot');
      const t0 = Date.now();
      const serverTime = await spot.getServerTime();
      diag.public_ping = {
        ok: true,
        baseUrl: spot.baseUrl(),
        serverTime,
        clockSkewMs: Date.now() - serverTime,
        latencyMs: Date.now() - t0,
      };
    } catch (e) {
      diag.public_ping = { ok: false, error: e.message };
      return res.status(200).json({ ok: false, ...diag });
    }

    // Test 2: signed account call — verifieert API keys + IP whitelist
    try {
      const spot = require('./_lib/exchange/binance-spot');
      const balances = await spot.getAllBalances();
      // P1-12: NIET de balances-preview lekken in de response. Als KILL_SWITCH_TOKEN
      // ooit zou leaken (logs, browser history, GH workflow logs) zou de attacker
      // direct alle Binance-balances zien. We bevestigen alleen "verbinding werkt"
      // + USDT-aanwezigheid voor minimum operational signal.
      const usdtBalance = balances.find(b => b.asset === 'USDT');
      diag.account = {
        ok: true,
        network: spot.network(),
        balanceCount: balances.length,
        usdtPresent: !!(usdtBalance && (usdtBalance.free + usdtBalance.locked) > 0),
        // Geen balancesPreview — security
      };
      return res.status(200).json({ ok: true, ...diag });
    } catch (e) {
      // Common issues: wrong key, wrong secret, IP not whitelisted (mainnet),
      // wrong network (testnet keys on mainnet endpoint)
      diag.account = {
        ok: false,
        error: e.message,
        hint: e.message.includes('IP') ? 'Whitelist je server-IP in Binance API settings' :
              e.message.includes('Invalid API') ? 'Key of secret klopt niet (of mainnet keys vs testnet endpoint)' :
              e.message.includes('Signature') ? 'API secret klopt niet — copy-paste opnieuw' :
              undefined,
      };
      return res.status(200).json({ ok: false, ...diag });
    }
  }

  if (action === 'resume') {
    // M-P0-20: lock — voorkomt dat resume mid-panic schrijft (waarbij panic's
    // eindwrite de resume zou overschrijven en kill-switch actief zou blijven).
    const got = await _acquireKillSwitchLock();
    if (!got) {
      return res.status(503).json({ error: 'kill-switch busy (another action in progress) — retry in 5s' });
    }
    try {
      // P1-9: resume HONOREERT scope-param zodat operator selectief Merlijn of Kronos
      // weer kan aanzetten zonder de andere bot per ongeluk te ontpauzeren.
      // Voor scope='all' wist isBlocked() de complete kill-switch.
      // Voor scope='merlijn'/'kronos': huidige state behouden voor andere bot.
      let state;
      const current = await getKillSwitchState();
      if (scope === 'all' || current.scope === scope || current.scope === 'all') {
        // 'all' resume → wis volledig. Of: huidige scope matcht → wis volledig.
        state = {
          active: false,
          reason: `RESUMED (${scope}): ${reason}`,
          scope,
          ts: Date.now(),
          by,
          closedCount: 0,
        };
      } else {
        // Selectief resume terwijl andere bot pauze houdt — switch scope naar
        // de andere bot, niet deactiveren.
        const otherBot = scope === 'merlijn' ? 'kronos' : 'merlijn';
        state = {
          active: true,
          reason: `Partial resume — ${scope} re-enabled, ${otherBot} still paused`,
          scope: otherBot,
          ts: Date.now(),
          by,
          closedCount: 0,
        };
      }
      await setKillSwitchState(state);
      await telegram.sendAlert({
        severity: 'ok',
        title: `Kill-switch resumed (${scope})`,
        message: `Trading re-enabled for ${scope} by ${by}. Reason: ${reason}`,
      });
      return res.status(200).json({ ok: true, action, ...state });
    } finally {
      await _releaseKillSwitchLock();
    }
  }

  return res.status(400).json({ error: `unknown action: ${action} (use pause|panic|resume|clear-circuit|telegram-test|binance-test)` });
};

// ── Hoist clear-circuit BEFORE generic auth check so we can also accept
// PAPER_ENGINE_SECRET / BOT_CONFIG_TOKEN as fallback (zonder eerst KILL_SWITCH_TOKEN
// te eisen). Doel: oude kill-switch state + circuit dedupe keys wissen NA threshold-
// aanpassing, zodat de bot weer kan draaien zonder dat de oude trigger-reden blijft hangen.
//
// Wordt afgehandeld door een wrapper-handler hieronder die clear-circuit detecteert
// en doorhandelt vóór de standaard kill-switch flow.
async function _clearCircuitState(scope = 'all', botFilter = 'all', resetDayStart = true) {
  const cleared = [];
  const errors = [];

  // 1. Wis kill_switch:state (de hoofdvlag)
  try {
    await redis.del(KILL_SWITCH_KEY);
    cleared.push(KILL_SWITCH_KEY);
  } catch (e) { errors.push(`del ${KILL_SWITCH_KEY}: ${e.message}`); }

  // 2. Wis vandaag's circuit:triggered:* dedupe-keys per bot/kind zodat circuit
  //    breaker NIET denkt dat hij vandaag al gefired heeft.
  const today = (() => {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
  })();
  const bots = botFilter === 'all' ? ['merlijn', 'kronos', 'all'] : [botFilter];
  const kinds = ['daily_loss', 'weekly_loss', 'total_dd', 'trade_limit'];
  for (const b of bots) {
    for (const k of kinds) {
      const key = `circuit:triggered:${today}:${b}:${k}`;
      try {
        await redis.del(key);
        cleared.push(key);
      } catch (e) { errors.push(`del ${key}: ${e.message}`); }
    }
  }

  // 3. Wis vandaag's dayStart snapshot zodat een fresh start-of-day balance wordt
  //    genomen bij de volgende checkCircuit() call (anders blijft de oude
  //    €3989.48 dayStart referentie en triggert de circuit opnieuw).
  if (resetDayStart) {
    for (const b of [...bots, 'total']) {
      const key = `circuit:dayStart:${b}:${today}`;
      try {
        await redis.del(key);
        cleared.push(key);
      } catch (e) { errors.push(`del ${key}: ${e.message}`); }
    }
  }

  return { cleared, errors, today };
}

// Wrap default export zodat clear-circuit een eigen auth-pad heeft (PAPER_ENGINE_SECRET
// / BOT_CONFIG_TOKEN fallback) terwijl de rest van de routes onaangeroerd blijft.
const _origHandler = module.exports;
module.exports = async function killSwitchHandlerWrapper(req, res) {
  const action = String(req.query?.action || '').toLowerCase();
  if (action === 'clear-circuit') {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, x-bot-token, x-merlijn-token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(200).end();
    // Auth: accept KILL_SWITCH_TOKEN, BOT_CONFIG_TOKEN, of PAPER_ENGINE_SECRET (fallback chain).
    const auth = req.headers['authorization'] || req.headers['Authorization'] || '';
    const tok = (req.headers['x-bot-token'] || req.headers['x-merlijn-token'] || req.query?.token || '').toString();
    const candidates = [
      process.env.KILL_SWITCH_TOKEN,
      process.env.BOT_CONFIG_TOKEN,
      process.env.PAPER_ENGINE_SECRET,
    ].filter(Boolean);
    if (candidates.length === 0) {
      return res.status(503).json({ error: 'No auth token configured (set KILL_SWITCH_TOKEN, BOT_CONFIG_TOKEN, or PAPER_ENGINE_SECRET)' });
    }
    const ok = candidates.some(t => auth === `Bearer ${t}` || tok === t);
    if (!ok) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const scope = String(req.query?.bot || req.query?.scope || 'all').toLowerCase();
    const resetDayStart = String(req.query?.resetDayStart || '1') !== '0';
    try {
      const result = await _clearCircuitState('all', scope, resetDayStart);
      return res.status(200).json({ ok: true, action: 'clear-circuit', scope, ...result, ts: new Date().toISOString() });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }
  return _origHandler(req, res);
};

// Re-export helpers (anders gaan ze verloren door de wrapper-overschrijving)
module.exports.isBlocked = isBlocked;
module.exports.getKillSwitchState = getKillSwitchState;
module.exports.KILL_SWITCH_KEY = KILL_SWITCH_KEY;
module.exports._clearCircuitState = _clearCircuitState;

// Export helpers voor andere modules
module.exports.isBlocked = isBlocked;
module.exports.getKillSwitchState = getKillSwitchState;
module.exports.KILL_SWITCH_KEY = KILL_SWITCH_KEY;
