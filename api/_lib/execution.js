// ═══ Execution layer — paper/live router ═══
//
// Single point waar alle bot-executions doorheen gaan. Beslist op basis van
// per-bot env flags of we paper-simuleren of een echte exchange order plaatsen.
//
// Flags (default: ALLES paper):
//   MERLIJN_LIVE_NETWORK = (off|testnet|mainnet)   default off
//   KRONOS_LIVE_NETWORK  = (off|testnet|mainnet)   default off
//
// Per bot wordt een aparte exchange adapter gekozen:
//   merlijn (paper_4h)       → binance-spot
//   kronos  (paper_kronos)   → binance-futures
//
// Iedere execute*() functie geeft hetzelfde shape terug als de paper fills.js
// equivalents zodat de calling code (paper-engine, kronos) ongewijzigd blijft.
//
// SAFETY:
//   1. LIVE mode default OFF — moet expliciet per bot aangezet worden
//   2. mainnet vereist tweede confirmation env: LIVE_MAINNET_CONFIRM=YES_I_UNDERSTAND
//   3. Alle live orders worden naar Telegram geduwd
//   4. Kill-switch wordt gechecked vóór elke entry
//   5. Mainnet requires IP whitelist (gedocumenteerd, niet enforced in code)

const fills = require('./fills');
const telegram = require('./telegram');

// ── Mode detection per bot ──
//
// Resolutie-volgorde (eerste die hit wint):
//   1. Redis `bot:mode:<id>` (user-toggle via /api/bot-config UI)
//   2. Env var MERLIJN_LIVE_NETWORK / KRONOS_LIVE_NETWORK (legacy / ops override)
//   3. Default: paper
//
// Mainnet vereist ALTIJD `LIVE_MAINNET_CONFIRM=YES_I_UNDERSTAND` env, ongeacht
// of de mode via Redis of env gezet is — defense in depth zodat een per ongeluk
// gezette toggle nog steeds geblokkeerd wordt op operator-niveau.
async function _modeFor(bot) {
  const env = bot === 'paper_4h' ? 'MERLIJN_LIVE_NETWORK'
            : bot === 'paper_kronos' ? 'KRONOS_LIVE_NETWORK'
            : null;
  if (!env) return { mode: 'paper', network: null, reason: 'unknown bot, fallback paper' };

  // 1) Redis user-toggle (priority)
  let redisMode = null;
  try {
    const cfg = require('./bot-config');
    redisMode = await cfg.getMode(bot);   // 'paper' | 'live' | null
  } catch (e) {
    // Redis hiccup → val terug op env (en uiteindelijk paper)
    console.warn(`[execution] bot-config read for ${bot} failed: ${e.message}`);
  }

  if (redisMode === 'live') {
    if (process.env.LIVE_MAINNET_CONFIRM !== 'YES_I_UNDERSTAND') {
      console.warn(`[execution] ${bot} mode=live (Redis) but LIVE_MAINNET_CONFIRM not set → fallback paper`);
      return { mode: 'paper', network: null, reason: 'mainnet not confirmed (env)' };
    }
    return { mode: 'live', network: 'mainnet', source: 'redis' };
  }
  if (redisMode === 'paper') {
    return { mode: 'paper', network: null, source: 'redis' };
  }

  // 2) Env var fallback (legacy)
  const v = (process.env[env] || 'off').toLowerCase();
  if (v === 'off' || v === '0' || v === 'false' || v === '') return { mode: 'paper', network: null, source: 'env' };
  if (v === 'testnet') return { mode: 'live', network: 'testnet', source: 'env' };
  if (v === 'mainnet') {
    if (process.env.LIVE_MAINNET_CONFIRM !== 'YES_I_UNDERSTAND') {
      console.warn(`[execution] ${env}=mainnet but LIVE_MAINNET_CONFIRM not set → falling back to paper`);
      return { mode: 'paper', network: null, reason: 'mainnet not confirmed', source: 'env' };
    }
    return { mode: 'live', network: 'mainnet', source: 'env' };
  }
  return { mode: 'paper', network: null, reason: `unknown ${env} value: ${v}`, source: 'env' };
}

function _adapterFor(bot) {
  if (bot === 'paper_4h') return require('./exchange/binance-spot');
  if (bot === 'paper_kronos') return require('./exchange/binance-futures');
  return null;
}

// Shape return zodat paper-engine.js en kronos.js dezelfde key shape krijgen
// als ze nu van fills.computeEntry() krijgen:
//   { entryPrice, qty, sizeUsd, entryFee, slippageCost, riskUsd, effectiveRiskPct, _live? }
//
// _live veld bevat extra info wanneer live: { orderId, network, status, raw }
async function executeEntry({
  bot,                         // 'paper_4h' of 'paper_kronos'
  state,                       // { balance, ... }
  token,                       // 'BTC'
  side,                        // 'LONG' | 'SHORT'
  signalPrice,                 // candle close
  stopPrice,                   // stop level
  stars,                       // 1..5
  riskPct = 0.02,
  riskMultiplier = 1.0,
  starMultMap = null,
  maxSizePctOfBalance = 0.25,
  atrPct = null,
  book = null,
  // Live-only:
  leverage = null,             // alleen futures
  clientOrderId = null,
}) {
  const m = await _modeFor(bot);

  // ───── PAPER MODE — gebruik bestaande sim ─────
  if (m.mode === 'paper') {
    const result = fills.computeEntry({
      state, token, side, signalPrice, stopPrice, stars,
      riskPct, riskMultiplier, starMultMap: starMultMap || undefined,
      maxSizePctOfBalance, atrPct, stochastic: true, book,
    });
    return result;  // null als invalid, anders shape
  }

  // ───── LIVE MODE ─────
  const adapter = _adapterFor(bot);
  if (!adapter) {
    throw new Error(`No exchange adapter for bot ${bot}`);
  }
  if (!adapter.isConfigured()) {
    await telegram.alertOrderFailed({
      bot, network: m.network, side, token,
      reason: 'adapter not configured',
      errorMsg: `Missing API keys for ${bot} on ${m.network}`,
    });
    throw new Error(`${bot} live=${m.network} but exchange adapter not configured (missing API keys)`);
  }

  // Sizing op basis van risk/star (zelfde formule als paper computeEntry)
  const sm = starMultMap || { 1:0.5, 2:0.75, 3:1.0, 4:1.5, 5:2.0 };
  const starMult = sm[Math.min(5, Math.max(1, stars))] || 1.0;
  const effectiveRiskPct = riskPct * starMult * riskMultiplier;
  const riskAmount = state.balance * effectiveRiskPct;

  // Schat entry mid (we krijgen real fillPrice terug van exchange)
  const symbol = adapter.tokenToSymbol(token);
  const ticker = await adapter.getTicker(symbol);
  const mid = ticker.last;

  const riskPerUnit = Math.abs(mid - stopPrice);
  if (riskPerUnit <= 0) {
    throw new Error(`Invalid risk per unit (mid=${mid}, stop=${stopPrice})`);
  }
  let units = riskAmount / riskPerUnit;
  let sizeUsd = units * mid;
  const maxSize = state.balance * maxSizePctOfBalance;
  if (sizeUsd > maxSize) { sizeUsd = maxSize; units = sizeUsd / mid; }

  // Min trade size guard
  if (sizeUsd < 10) {
    return null;   // skip silently zoals paper doet
  }

  // Place market order
  const exchSide = bot === 'paper_kronos'
    ? require('./exchange/binance-futures').botToExchangeSide(side, 'ENTRY')
    : (side === 'LONG' ? 'BUY' : 'SELL');   // spot: SHORT niet mogelijk

  if (bot === 'paper_4h' && side === 'SHORT') {
    throw new Error(`Cannot SHORT on spot (Merlijn). Token=${token}`);
  }

  // ─── M-P0-13 + M-P0-14 fix (2026-04-23): pre-flight checks for futures LIVE ───
  // M-P0-13 (margin): Voor LIVE futures moet de daadwerkelijke margin op de exchange
  // beschikbaar zijn. Onze interne state.balance reserveert volle notional, maar de
  // exchange ziet alleen sizeUsd/leverage als initial margin. Als availableBalance
  // op Binance lager is dan benodigd → bail vroeg met een nette error i.p.v. een
  // -2019 INSUFFICIENT_MARGIN response halverwege submitOrder().
  //
  // M-P0-14 (orphan position): Als er al een positie open staat op deze symbol op
  // de exchange (bijv. uit een eerdere failed close die we niet correct hebben
  // gereconcileerd), dan zou een nieuwe open in dezelfde richting de positie
  // VERGROTEN, en in tegenovergestelde richting (in one-way mode) de positie
  // gedeeltelijk SLUITEN — beide zijn data-inconsistent met onze interne staat.
  // Bail met duidelijke error zodat operator de orphan kan reconcilen.
  if (bot === 'paper_kronos') {
    try {
      // Margin pre-check (M-P0-13)
      const lev = leverage || parseInt(process.env.BINANCE_FUT_LEVERAGE || '3', 10);
      const requiredMargin = sizeUsd / lev;
      const availableMargin = await adapter.getBalance('USDT');
      if (Number.isFinite(availableMargin) && availableMargin > 0) {
        // 5% buffer voor fees + slippage + price-move tussen check en submit
        if (requiredMargin > availableMargin * 0.95) {
          const msg = `LIVE futures margin pre-check FAIL: required $${requiredMargin.toFixed(2)} > available $${availableMargin.toFixed(2)} × 0.95 (lev=${lev}x, sizeUsd=$${sizeUsd.toFixed(2)})`;
          console.warn(`[execution] ${msg}`);
          await telegram.alertOrderFailed({
            bot, network: m.network, side, token,
            reason: 'margin pre-check', errorMsg: msg,
          });
          throw new Error(msg);
        }
      } else {
        console.warn(`[execution] LIVE futures margin pre-check: availableBalance=${availableMargin} (geen geldige waarde — ga door op eigen risico)`);
      }
      // Orphan position check (M-P0-14)
      const existingPos = await adapter.getPositions(symbol);
      if (Array.isArray(existingPos) && existingPos.length > 0) {
        const p = existingPos[0];
        const msg = `LIVE futures orphan position detected on ${symbol}: positionAmt=${p.positionAmt} (${p.side}, entry=$${p.entryPrice}, unrealized=$${p.unrealizedPnl}). Reconcile via /api/reconcile vóór nieuwe entries.`;
        console.warn(`[execution] ${msg}`);
        await telegram.alertOrderFailed({
          bot, network: m.network, side, token,
          reason: 'orphan position', errorMsg: msg,
        });
        throw new Error(msg);
      }
    } catch (e) {
      // Re-throw — pre-checks falen = HARD STOP. Geen orders zonder verified state.
      // (Network errors op de check-call bubbelen ook door — beter falen dan blind orderen.)
      if (!e.message.startsWith('LIVE futures')) {
        // Eigen wrapper zodat telegram alert + audit duidelijk laten zien dat dit pre-check is
        const wrapped = new Error(`pre-check infra error: ${e.message}`);
        wrapped.code = e.code;
        throw wrapped;
      }
      throw e;
    }
  }

  let order;
  try {
    order = await adapter.submitOrder({
      symbol,
      side: exchSide,
      type: 'MARKET',
      quantity: units,
      // P0-3: random suffix tegen ms-collision (twee orders binnen zelfde ms = duplicate)
      clientOrderId: clientOrderId || `${bot.slice(0,3)}-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
      ...(leverage && bot === 'paper_kronos' ? { leverage } : {}),
    });
  } catch (e) {
    await telegram.alertOrderFailed({
      bot, network: m.network, side, token,
      reason: 'submit failed', errorCode: e.code, errorMsg: e.message,
    });
    throw e;
  }

  // Validate fill
  if (!order.filledQty || order.filledQty <= 0) {
    await telegram.alertOrderFailed({
      bot, network: m.network, side, token,
      reason: `order status ${order.status} no fill`,
      errorMsg: JSON.stringify(order.raw).slice(0, 300),
    });
    throw new Error(`${bot} ${token} order ${order.orderId} status=${order.status} no fill`);
  }

  const entryPrice = order.avgPrice;
  const qty = order.filledQty;
  const realSizeUsd = order.cumQuote || (qty * entryPrice);
  const entryFee = order.fees || 0;     // in quote (USDT) of base depending on adapter
  const slippageCost = Math.abs(entryPrice - signalPrice) * qty;
  const riskUsd = Math.abs(entryPrice - stopPrice) * qty;

  // Push success alert
  await telegram.alertOrderPlaced({
    bot, network: m.network, side, token,
    qty, price: entryPrice, sizeUsd: realSizeUsd, orderId: order.orderId,
    kind: 'ENTRY',
  });

  return {
    entryPrice, qty,
    sizeUsd: realSizeUsd,
    entryFee, slippageCost, riskUsd,
    effectiveRiskPct,
    _live: {
      orderId: order.orderId,
      clientOrderId: order.clientOrderId,
      network: m.network,
      status: order.status,
      symbol,
    },
  };
}

// ── Exit execution ──
//
// Returns shape compatible met fills.computeExit():
//   { exitPrice, closeQty, closeSizeUsd, pnl, exitFee, slippageCost, reason, _live? }
async function executeExit({
  bot,                         // 'paper_4h' of 'paper_kronos'
  pos,                         // existing position record
  exitSignalPrice,             // candle close (gebruikt bij paper en als reference bij live)
  reason,                      // 'Stop' | 'Target' | 'Target1' | 'Trailing' | 'Time Exit' | etc.
  partialPct = 1.0,            // 1.0 = full close
  atrPct = null,
  book = null,
  clientOrderId = null,
}) {
  const m = await _modeFor(bot);

  // ───── PAPER ─────
  if (m.mode === 'paper') {
    return fills.computeExit({ pos, exitSignalPrice, reason, partialPct, atrPct, stochastic: true, book });
  }

  // ───── LIVE ─────
  const adapter = _adapterFor(bot);
  if (!adapter || !adapter.isConfigured()) {
    throw new Error(`${bot} live=${m.network} but exchange adapter not configured`);
  }

  const symbol = adapter.tokenToSymbol(pos.token);
  let closeQty = pos.qty * partialPct;
  // Voor futures: exit kant is OPPOSITE van entry, met reduceOnly
  const exchSide = bot === 'paper_kronos'
    ? adapter.botToExchangeSide(pos.side, 'EXIT')
    : 'SELL';                          // spot: altijd SELL bij exit (we hadden LONG)

  // M-P0-11 fix (2026-04-23): spot SELL met internal qty kan -2010 INSUFFICIENT_BALANCE
  // gooien als de werkelijke base-asset balance lager is dan onze in-memory qty.
  // Oorzaken: BNB-fee discount op entry werd niet exact ingerekend, partial fill
  // in entry-stage, parallel withdrawal door user, etc.
  // Fix: pre-flight balance check + clamp + 0.05% haircut → laat dust achter.
  if (bot === 'paper_4h' && exchSide === 'SELL') {
    try {
      const baseAsset = pos.token.toUpperCase();   // BTC, ETH, etc. (matches Binance asset code)
      const free = await adapter.getBalance(baseAsset);
      if (Number.isFinite(free) && free > 0) {
        // 0.05% haircut zodat we nooit op de absolute boven-limiet duwen (rounding+fee buffer)
        const safeMax = free * 0.9995;
        if (safeMax < closeQty) {
          // Log to audit but proceed met clamped qty — beter een partial close dan een hard fail
          console.warn(`[execution] SPOT EXIT ${pos.token}: clamping qty ${closeQty.toFixed(8)} → ${safeMax.toFixed(8)} (free=${free.toFixed(8)}, haircut 0.05%)`);
          closeQty = safeMax;
        }
      }
    } catch (e) {
      // Balance fetch fail → log + ga door met origineel qty (oude gedrag, fail-open op pre-check)
      console.warn(`[execution] SPOT EXIT ${pos.token}: balance pre-check fail (${e.message}) — ga door met internal qty`);
    }
  }

  let order;
  try {
    order = await adapter.submitOrder({
      symbol,
      side: exchSide,
      type: 'MARKET',
      quantity: closeQty,
      reduceOnly: bot === 'paper_kronos',
      // P0-3: random suffix tegen ms-collision
      clientOrderId: clientOrderId || `${bot.slice(0,3)}x-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
    });
  } catch (e) {
    await telegram.alertOrderFailed({
      bot, network: m.network, side: pos.side, token: pos.token,
      reason: `EXIT submit failed (${reason})`,
      errorCode: e.code, errorMsg: e.message,
    });
    throw e;
  }

  if (!order.filledQty || order.filledQty <= 0) {
    await telegram.alertOrderFailed({
      bot, network: m.network, side: pos.side, token: pos.token,
      reason: `EXIT order status ${order.status} no fill`,
      errorMsg: JSON.stringify(order.raw).slice(0, 300),
    });
    throw new Error(`${bot} EXIT ${pos.token} order ${order.orderId} status=${order.status} no fill`);
  }

  const exitPrice = order.avgPrice;
  const realCloseQty = order.filledQty;
  const closeSizeUsd = order.cumQuote || (realCloseQty * exitPrice);

  let grossPnl;
  if (pos.side === 'LONG') grossPnl = (exitPrice - pos.entryPrice) * realCloseQty;
  else grossPnl = (pos.entryPrice - exitPrice) * realCloseQty;

  const exitFee = order.fees || 0;
  const slippageCost = Math.abs(exitPrice - exitSignalPrice) * realCloseQty;

  await telegram.alertOrderPlaced({
    bot, network: m.network, side: pos.side, token: pos.token,
    qty: realCloseQty, price: exitPrice, sizeUsd: closeSizeUsd,
    orderId: order.orderId, kind: `EXIT (${reason})`,
  });

  return {
    exitPrice,
    closeQty: realCloseQty,
    closeSizeUsd,
    pnl: grossPnl - exitFee,
    exitFee,
    slippageCost,
    reason,
    _live: {
      orderId: order.orderId,
      clientOrderId: order.clientOrderId,
      network: m.network,
      status: order.status,
      symbol,
    },
  };
}

// ── Mode introspection (voor health endpoints, dashboard) ──
async function getModeStatus() {
  const merlijn = await _modeFor('paper_4h');
  const kronos = await _modeFor('paper_kronos');
  const spotAdapter = require('./exchange/binance-spot');
  const futAdapter = require('./exchange/binance-futures');
  return {
    merlijn: {
      mode: merlijn.mode,
      network: merlijn.network,
      adapterConfigured: spotAdapter.isConfigured(),
      reason: merlijn.reason,
      source: merlijn.source,
    },
    kronos: {
      mode: kronos.mode,
      network: kronos.network,
      adapterConfigured: futAdapter.isConfigured(),
      reason: kronos.reason,
      source: kronos.source,
      defaultLeverage: futAdapter.defaultLeverage(),
      marginType: futAdapter.marginType(),
    },
  };
}

module.exports = {
  executeEntry,
  executeExit,
  getModeStatus,
  _modeFor,        // exported voor tests
};
