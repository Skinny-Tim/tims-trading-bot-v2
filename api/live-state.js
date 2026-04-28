// ═══ /api/live-state — Real Binance data endpoint voor /live dashboard ═══
//
// Vervangt /api/portfolio-state voor het LIVE dashboard. Verschil:
//   portfolio-state = Redis paper-state (virtueel geld, simulatie)
//   live-state      = ECHTE Binance wallet/positions via signed API calls
//
// Scope:
//   GET /api/live-state?bot=paper_4h          → Binance Spot (Merlijn)
//   GET /api/live-state?bot=paper_kronos      → Binance Futures (Kronos)
//   GET /api/live-state                       → beide bots tegelijk (default)
//
// Response shape (ok path):
// {
//   ok: true, ts, env: { liveMainnetConfirmed, merlijnNetwork, kronosNetwork },
//   bots: {
//     paper_4h: {
//       mode, enabled, network, adapter, connected, error?,
//       balances: [{asset, free, locked, usdValue}],
//       totalUsdValue, openOrders, openOrdersCount
//     },
//     paper_kronos: {
//       mode, enabled, network, adapter, connected, error?,
//       totalWalletBalance, availableBalance, unrealizedPnl,
//       positions: [{symbol, side, positionAmt, entryPrice, markPrice,
//                    unrealizedPnl, leverage, notional, pnlPct}],
//       openOrders, openOrdersCount
//     }
//   }
// }
//
// Auth: GEEN (read-only, geen secrets in response). Live dashboard is hetzelfde
// toegankelijk als /trading — als je de URL weet zie je de data. Dat is OK omdat:
//   1. Binance keys zitten server-side (Vercel env), nooit in response
//   2. Dashboard toont geen write-actions
//   3. Als iemand panic wil drukken → die knop gaat door /api/kill-switch met auth
//
// Fail-modes:
//   - adapter not configured (missing keys) → ok:true, bot.connected=false, bot.error
//   - adapter network error                  → ok:true, bot.connected=false, bot.error
//   - bot niet in live mode                  → bot.connected=false, mode='paper'
//   - LIVE_MAINNET_CONFIRM missing + network=mainnet → connected=false met waarschuwing

const botCfg = require('./_lib/bot-config');
const redis = require('./_lib/redis');

// ── Bot trade ledger ──────────────────────────────────────────────────────
// Leest open posities + recent gesloten trades uit Redis voor dashboard
// weergave. Geeft realized PnL (24h + all-time) zodat operators meteen zien
// of de bot vandaag winst maakt los van Binance unrealized.
//
// Unified schema (sinds portfolio.js consolidatie):
//   portfolio:positions  — { [id]: PositionRecord }, filter op p.bot
//   portfolio:trades     — list ClosedTrade (newest first), filter op t.bot
//   portfolio:state      — { equity:{bot→n,total}, balance, startBalance }
//
// Legacy fallback:
//   - paper:trades (oude paper-engine writes vóór unified store)
//   - kronos_paper:* (oude geïsoleerde Kronos namespace, nu meestal leeg)
async function _botLedger(bot) {
  const out = {
    openPositions: [],
    recentTrades: [],
    realizedPnl24h: 0,
    realizedPnlAll: 0,
    winsAll: 0, lossesAll: 0, winrateAll: 0,
    totalTrades: 0,
    startBalance: null,
    botBalance: null,
    botEquity: null,
  };
  if (!redis.isConfigured()) return out;
  try {
    const [posObj, tradesNew, tradesLegacy, stateRaw, kronosLegacyPos, kronosLegacyTrades, kronosLegacyState] = await Promise.all([
      redis.get('portfolio:positions').catch(() => null),
      redis.lrange('portfolio:trades', 0, 199).catch(() => []),
      redis.lrange('paper:trades', 0, 199).catch(() => []),
      redis.get('portfolio:state').catch(() => null),
      bot === 'paper_kronos' ? redis.get('kronos_paper:positions').catch(() => null) : Promise.resolve(null),
      bot === 'paper_kronos' ? redis.lrange('kronos_paper:trades', 0, 99).catch(() => []) : Promise.resolve([]),
      bot === 'paper_kronos' ? redis.get('kronos_paper:state').catch(() => null) : Promise.resolve(null),
    ]);

    // Open posities — filter unified store op bot, merge met legacy kronos namespace
    const positionsUnified = (() => {
      if (!posObj) return [];
      const obj = typeof posObj === 'string' ? JSON.parse(posObj) : posObj;
      return Object.values(obj || {}).filter(p => p.bot === bot);
    })();
    const positionsLegacyKronos = (() => {
      if (!kronosLegacyPos || bot !== 'paper_kronos') return [];
      const obj = typeof kronosLegacyPos === 'string' ? JSON.parse(kronosLegacyPos) : kronosLegacyPos;
      return Object.values(obj || {});
    })();
    // Dedupe by id (unified is canonical, legacy alleen als unified leeg)
    const positions = positionsUnified.length > 0
      ? positionsUnified
      : positionsLegacyKronos;

    // Trades — prefer unified, fallback naar legacy paper:trades, dan kronos_paper:trades
    const parseTrades = raw => (raw || []).map(t => typeof t === 'string' ? JSON.parse(t) : t);
    const tradesNewParsed = parseTrades(tradesNew).filter(t => t.bot === bot);
    const tradesLegacyParsed = parseTrades(tradesLegacy).filter(t => t.bot === bot);
    const tradesKronosLegacyParsed = bot === 'paper_kronos' ? parseTrades(kronosLegacyTrades) : [];
    const trades = tradesNewParsed.length > 0
      ? tradesNewParsed
      : (tradesLegacyParsed.length > 0 ? tradesLegacyParsed : tradesKronosLegacyParsed);

    const state = stateRaw ? (typeof stateRaw === 'string' ? JSON.parse(stateRaw) : stateRaw) : null;
    const kronosState = kronosLegacyState ? (typeof kronosLegacyState === 'string' ? JSON.parse(kronosLegacyState) : kronosLegacyState) : null;
    if (state) {
      out.startBalance = state.startBalance ?? null;
      out.botBalance   = state.balance ?? null;
      // Per-bot equity uit unified state.equity object
      if (state.equity && typeof state.equity === 'object' && state.equity[bot] != null) {
        out.botEquity = +Number(state.equity[bot]).toFixed(2);
      }
    }
    // Kronos legacy state als fallback (alleen als unified leeg is)
    if (bot === 'paper_kronos' && kronosState && out.botBalance == null) {
      out.startBalance = kronosState.startBalance ?? out.startBalance;
      out.botBalance   = kronosState.balance ?? out.botBalance;
    }

    const now = Date.now();
    out.openPositions = positions.map(p => ({
      id: p.id,
      token: p.token,
      side: p.side,
      qty: p.qty,
      entryPrice: p.entryPrice,
      stop: p.stop,
      target: p.target ?? p.target1,
      stars: p.stars,
      sizeUsd: p.sizeUsd,
      openTime: p.openTime,
      hours: p.openTime ? +((now - p.openTime) / 3.6e6).toFixed(1) : null,
    }));

    out.recentTrades = trades.slice(0, 25).map(t => ({
      token: t.token,
      side: t.side,
      pnl: +Number(t.pnl || 0).toFixed(2),
      pnlPct: +Number(t.pnlPct || 0).toFixed(2),
      stars: t.stars,
      reason: t.reason,
      openTime: t.openTime,
      closeTime: t.closeTime,
      hours: (t.openTime && t.closeTime) ? +((t.closeTime - t.openTime) / 3.6e6).toFixed(1) : null,
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
    }));

    const dayMs = 24 * 3600 * 1000;
    const tradesToday = trades.filter(t => (now - (t.closeTime || t.openTime || 0)) <= dayMs);
    out.realizedPnl24h = +tradesToday.reduce((s, t) => s + (+t.pnl || 0), 0).toFixed(2);
    out.realizedPnlAll = +trades.reduce((s, t) => s + (+t.pnl || 0), 0).toFixed(2);
    out.winsAll = trades.filter(t => +t.pnl > 0).length;
    out.lossesAll = trades.filter(t => +t.pnl <= 0).length;
    out.totalTrades = trades.length;
    out.winrateAll = trades.length ? +(out.winsAll / trades.length).toFixed(4) : 0;
  } catch (e) {
    out.error = `bot-ledger read fail: ${e.message}`;
  }
  return out;
}

async function _spotBotState(bot) {
  const out = {
    mode: 'paper',
    enabled: true,
    network: 'off',
    adapter: 'binance-spot',
    connected: false,
    error: null,
    balances: [],
    totalUsdValue: 0,
    openOrders: [],
    openOrdersCount: 0,
  };
  try {
    out.mode = await botCfg.getMode(bot);
    out.enabled = await botCfg.isEnabled(bot);
  } catch (e) {
    out.error = `bot-config read fail: ${e.message}`;
    return out;
  }

  const network = (process.env.BINANCE_SPOT_NETWORK || 'testnet').toLowerCase();
  out.network = network;

  if (out.mode !== 'live') {
    out.error = 'bot mode != live — switch naar live op /trading eerst';
    return out;
  }

  const spot = require('./_lib/exchange/binance-spot');
  if (!spot.isConfigured()) {
    out.error = `Binance Spot adapter niet geconfigureerd (ontbrekende API keys voor ${network})`;
    return out;
  }

  // Mainnet extra-gate
  if (network === 'mainnet' && !botCfg.isLiveMainnetConfirmed()) {
    out.error = 'LIVE_MAINNET_CONFIRM env ontbreekt — executie valt terug op paper';
    return out;
  }

  try {
    const [balances, openOrders] = await Promise.all([
      spot.getAllBalances(),
      spot.listOpenOrders().catch(() => []),
    ]);

    // Verrijk balances met USD value (voor non-stable assets fetch ticker)
    const enriched = [];
    let total = 0;
    for (const b of balances) {
      const total_b = b.free + b.locked;
      if (total_b <= 0) continue;
      let usdValue = 0;
      if (b.asset === 'USDT' || b.asset === 'USDC' || b.asset === 'BUSD' || b.asset === 'USD') {
        usdValue = total_b;
      } else {
        try {
          const sym = spot.tokenToSymbol(b.asset);
          const t = await spot.getTicker(sym);
          usdValue = total_b * (t.last || 0);
        } catch {
          // Niet alle assets zijn USDT-paired (bijv. stuf van airdrops) — sla over
          usdValue = 0;
        }
      }
      total += usdValue;
      enriched.push({
        asset: b.asset,
        free: b.free,
        locked: b.locked,
        total: total_b,
        usdValue: +usdValue.toFixed(2),
      });
    }
    enriched.sort((a, b) => b.usdValue - a.usdValue);

    out.connected = true;
    out.balances = enriched;
    out.totalUsdValue = +total.toFixed(2);
    out.openOrders = (openOrders || []).map(o => ({
      orderId: o.orderId,
      symbol: o.symbol,
      side: o.side,
      type: o.type,
      price: parseFloat(o.price || 0),
      origQty: parseFloat(o.origQty || 0),
      executedQty: parseFloat(o.executedQty || 0),
      status: o.status,
      time: o.time,
    }));
    out.openOrdersCount = out.openOrders.length;
  } catch (e) {
    out.error = `Binance Spot API error: ${e.message}`;
  }
  return out;
}

async function _futuresBotState(bot) {
  const out = {
    mode: 'paper',
    enabled: true,
    network: 'off',
    adapter: 'binance-futures',
    connected: false,
    error: null,
    totalWalletBalance: 0,
    availableBalance: 0,
    unrealizedPnl: 0,
    marginBalance: 0,
    positions: [],
    openOrders: [],
    openOrdersCount: 0,
  };
  try {
    out.mode = await botCfg.getMode(bot);
    out.enabled = await botCfg.isEnabled(bot);
  } catch (e) {
    out.error = `bot-config read fail: ${e.message}`;
    return out;
  }

  const network = (process.env.BINANCE_FUT_NETWORK || 'testnet').toLowerCase();
  out.network = network;

  if (out.mode !== 'live') {
    out.error = 'bot mode != live — switch naar live op /trading eerst';
    return out;
  }

  const fut = require('./_lib/exchange/binance-futures');
  if (!fut.isConfigured()) {
    out.error = `Binance Futures adapter niet geconfigureerd (ontbrekende API keys voor ${network})`;
    return out;
  }

  if (network === 'mainnet' && !botCfg.isLiveMainnetConfirmed()) {
    out.error = 'LIVE_MAINNET_CONFIRM env ontbreekt — executie valt terug op paper';
    return out;
  }

  try {
    const [acc, positions, openOrders] = await Promise.all([
      fut.getAccount(),
      fut.getPositions(),
      fut.listOpenOrders().catch(() => []),
    ]);

    const usdtAsset = (acc.assets || []).find(a => a.asset === 'USDT') || {};
    out.totalWalletBalance = +parseFloat(usdtAsset.walletBalance || 0).toFixed(2);
    out.availableBalance   = +parseFloat(usdtAsset.availableBalance || 0).toFixed(2);
    out.unrealizedPnl      = +parseFloat(usdtAsset.unrealizedProfit || 0).toFixed(2);
    out.marginBalance      = +parseFloat(usdtAsset.marginBalance || 0).toFixed(2);

    // Verrijk positions met markPrice + pnlPct
    const enrichedPos = [];
    for (const p of positions || []) {
      let markPrice = null;
      try {
        const t = await fut.getTicker(p.symbol);
        markPrice = t.last;
      } catch {}
      const notional = Math.abs(p.positionAmt * (markPrice || p.entryPrice));
      const pnlPct = p.entryPrice > 0
        ? ((markPrice || p.entryPrice) - p.entryPrice) / p.entryPrice * 100 * (p.side === 'LONG' ? 1 : -1)
        : 0;
      enrichedPos.push({
        symbol: p.symbol,
        side: p.side,
        positionAmt: p.positionAmt,
        entryPrice: p.entryPrice,
        markPrice: markPrice || p.entryPrice,
        unrealizedPnl: +p.unrealizedPnl.toFixed(2),
        leverage: p.leverage,
        notional: +notional.toFixed(2),
        pnlPct: +pnlPct.toFixed(2),
        isolatedMargin: p.isolatedMargin,
      });
    }

    out.connected = true;
    out.positions = enrichedPos;
    out.openOrders = (openOrders || []).map(o => ({
      orderId: o.orderId,
      symbol: o.symbol,
      side: o.side,
      type: o.type,
      price: parseFloat(o.price || 0),
      stopPrice: parseFloat(o.stopPrice || 0),
      origQty: parseFloat(o.origQty || 0),
      executedQty: parseFloat(o.executedQty || 0),
      status: o.status,
      reduceOnly: !!o.reduceOnly,
      time: o.time,
    }));
    out.openOrdersCount = out.openOrders.length;
  } catch (e) {
    out.error = `Binance Futures API error: ${e.message}`;
  }
  return out;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  const botFilter = String(req.query?.bot || '').toLowerCase();
  const env = {
    liveMainnetConfirmed: botCfg.isLiveMainnetConfirmed(),
    merlijnNetwork: (process.env.BINANCE_SPOT_NETWORK || 'testnet').toLowerCase(),
    kronosNetwork:  (process.env.BINANCE_FUT_NETWORK  || 'testnet').toLowerCase(),
    merlijnLiveEnabled: (process.env.MERLIJN_LIVE_NETWORK || 'off').toLowerCase() !== 'off',
    kronosLiveEnabled:  (process.env.KRONOS_LIVE_NETWORK  || 'off').toLowerCase() !== 'off',
  };

  const wantMerlijn = !botFilter || botFilter === 'paper_4h' || botFilter === 'merlijn';
  const wantKronos  = !botFilter || botFilter === 'paper_kronos' || botFilter === 'kronos';

  try {
    const [merlijn, kronos, merlijnLedger, kronosLedger] = await Promise.all([
      wantMerlijn ? _spotBotState('paper_4h') : Promise.resolve(null),
      wantKronos  ? _futuresBotState('paper_kronos') : Promise.resolve(null),
      wantMerlijn ? _botLedger('paper_4h') : Promise.resolve(null),
      wantKronos  ? _botLedger('paper_kronos') : Promise.resolve(null),
    ]);

    const bots = {};
    if (merlijn) { merlijn.ledger = merlijnLedger; bots.paper_4h = merlijn; }
    if (kronos)  { kronos.ledger  = kronosLedger;  bots.paper_kronos = kronos; }

    return res.status(200).json({
      ok: true,
      ts: Date.now(),
      isoTs: new Date().toISOString(),
      env,
      bots,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
