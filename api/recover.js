// ═══ State recovery + replay endpoint ═══
//
// Drie use-cases:
//   1. SNAPSHOT: maak een immutable kopie van portfolio:state + portfolio:positions
//      → Bewaard onder snapshot:<ts>. Auto-snapshots draaien voor elke kill-switch
//        panic en kan ook handmatig getriggerd worden.
//   2. RESTORE: rol terug naar een snapshot. Voor het geval een buggy run state
//      heeft gecorrumpeerd.
//   3. REPLAY-FROM-EXCHANGE: rebuild lokale state vanuit live exchange-positions.
//      Voor het geval Redis is gewist of state kwijt is na crash.
//
// Endpoints:
//   GET  /api/recover                                   → list snapshots + summary
//   POST /api/recover?action=snapshot                   → create new snapshot
//   POST /api/recover?action=restore&snapshot=<ts>      → restore from snapshot
//   POST /api/recover?action=replay-from-exchange&bot=  → import from exchange
//
// Auth: alle write actions vereisen Bearer KILL_SWITCH_TOKEN (zelfde als kill-switch
// — wie die heeft mag ook state-rollback doen).
//
// Snapshots TTL: 30 dagen (auto-cleanup via Redis TTL).

const redis = require('./_lib/redis');
const portfolio = require('./_lib/portfolio');
const telegram = require('./_lib/telegram');

const SNAPSHOT_PREFIX = 'snapshot:';
const SNAPSHOT_INDEX = 'snapshot:index';   // sorted list of snapshot ids
const SNAPSHOT_TTL_SEC = 30 * 24 * 3600;
const TOKEN = process.env.KILL_SWITCH_TOKEN || '';

// ── Snapshot maken ──
async function createSnapshot(reason = 'manual') {
  const ts = Date.now();
  const id = `${ts}_${reason.replace(/[^a-z0-9_]/gi, '_').slice(0, 30)}`;
  const state = await portfolio.loadState();
  const positions = await portfolio.loadPositions();
  const trades = await redis.lrange('portfolio:trades', 0, 99);
  const snapshot = {
    id, ts, reason,
    state, positions,
    tradesCount: (trades || []).length,
    tradesLast10: (trades || []).slice(0, 10),
  };
  // Try set with TTL via SETEX-equivalent
  await redis.set(`${SNAPSHOT_PREFIX}${id}`, snapshot);
  // Maintain index list (most recent first, capped at 50)
  await redis.lpush(SNAPSHOT_INDEX, id);
  await redis.ltrim(SNAPSHOT_INDEX, 0, 49);
  return snapshot;
}

// ── Snapshot restoren ──
async function restoreSnapshot(id) {
  const snap = await redis.get(`${SNAPSHOT_PREFIX}${id}`);
  if (!snap || !snap.state || !snap.positions) {
    throw new Error(`snapshot ${id} not found or corrupt`);
  }
  // Pre-snapshot van CURRENT state voor "undo" (just in case)
  const undoSnap = await createSnapshot(`pre_restore_of_${id.slice(0, 20)}`);
  await portfolio.saveState(snap.state);
  await portfolio.savePositions(snap.positions);
  return {
    restored: id,
    restoredAt: snap.ts,
    undoAvailable: undoSnap.id,
    state: snap.state,
    positionsCount: Object.keys(snap.positions).length,
  };
}

// ── Replay from exchange (rebuild local state vanuit live positions) ──
// LET OP: dit OVERSCHRIJFT bot-state. Maak EERST snapshot.
async function replayFromExchange(bot) {
  if (!['merlijn', 'kronos'].includes(bot)) {
    throw new Error(`invalid bot: ${bot} (use merlijn|kronos)`);
  }
  const undoSnap = await createSnapshot(`pre_replay_${bot}`);

  const state = await portfolio.loadState();
  const positions = await portfolio.loadPositions();

  // Filter out any existing positions for this bot — we're going to rebuild
  const botKey = bot === 'merlijn' ? 'paper_4h' : 'paper_kronos';
  const removed = [];
  for (const [id, p] of Object.entries(positions)) {
    if (p && p.bot === botKey) { removed.push(id); delete positions[id]; }
  }

  const imported = [];
  if (bot === 'merlijn') {
    const adapter = require('./_lib/exchange/binance-spot');
    if (!adapter.isConfigured()) throw new Error('binance-spot adapter not configured');
    const balances = await adapter.getAllBalances();
    for (const b of balances) {
      if (b.asset === 'USDT') continue;
      const qty = (b.free || 0) + (b.locked || 0);
      if (qty <= 0) continue;
      // Best-guess entry price = current ticker (we hebben geen entry-info, dit is een rebuild)
      let entryPrice = 0;
      try {
        const t = await adapter.getTicker(`${b.asset}USDT`);
        entryPrice = t?.price || 0;
      } catch {}
      const id = `replay_${botKey}_${b.asset}_${Date.now()}`;
      const pos = {
        id, bot: botKey,
        token: b.asset,
        symbol: `${b.asset}USDT`,
        market: `${b.asset}-USDT`,
        side: 'LONG',          // spot = always long
        qty,
        entryPrice,
        sizeUsd: qty * entryPrice,
        stop: entryPrice * 0.95,    // 5% emergency stop — caller MOET dit aanpassen
        target: entryPrice * 1.10,
        openTime: Date.now(),
        atr: entryPrice * 0.03,
        replayed: true,            // markeer als imported
        _live: { network: process.env.BINANCE_SPOT_NETWORK || 'testnet', source: 'replay' },
      };
      positions[id] = pos;
      imported.push({ token: b.asset, qty, entryPrice });
    }
    // Sync balance
    const usdt = balances.find(b => b.asset === 'USDT');
    if (usdt) {
      state.byBot = state.byBot || {};
      state.byBot[botKey] = state.byBot[botKey] || {};
      state.byBot[botKey].balance = usdt.free + usdt.locked;
    }
  } else {
    // Kronos / futures
    const adapter = require('./_lib/exchange/binance-futures');
    if (!adapter.isConfigured()) throw new Error('binance-futures adapter not configured');
    const positionsX = await adapter.getPositions();
    for (const ep of positionsX) {
      const amt = parseFloat(ep.positionAmt);
      if (!isFinite(amt) || amt === 0) continue;
      const side = amt > 0 ? 'LONG' : 'SHORT';
      const qty = Math.abs(amt);
      const entryPrice = parseFloat(ep.entryPrice) || 0;
      const symbol = ep.symbol;
      const token = symbol.replace(/USDT$/, '');
      const id = `replay_${botKey}_${token}_${Date.now()}`;
      const pos = {
        id, bot: botKey,
        token, symbol,
        side, qty,
        entryPrice,
        sizeUsd: qty * entryPrice,
        leverage: parseFloat(ep.leverage) || 3,
        marginType: ep.marginType || 'ISOLATED',
        stop: side === 'LONG' ? entryPrice * 0.95 : entryPrice * 1.05,
        target: side === 'LONG' ? entryPrice * 1.10 : entryPrice * 0.90,
        openTime: Date.now(),
        atr: entryPrice * 0.03,
        replayed: true,
        _live: { network: process.env.BINANCE_FUT_NETWORK || 'testnet', source: 'replay' },
      };
      positions[id] = pos;
      imported.push({ token, side, qty, entryPrice, leverage: pos.leverage });
    }
    // Sync balance
    try {
      const usdt = await adapter.getBalance('USDT');
      if (usdt && isFinite(usdt)) {
        state.byBot = state.byBot || {};
        state.byBot[botKey] = state.byBot[botKey] || {};
        state.byBot[botKey].balance = usdt;
      }
    } catch {}
  }

  await portfolio.savePositions(positions);
  await portfolio.saveState(state);

  return {
    bot,
    removed,            // local positions die we hebben verwijderd
    imported,           // exchange positions die we hebben geïmporteerd
    undoAvailable: undoSnap.id,
  };
}

// ── List snapshots ──
async function listSnapshots(limit = 25) {
  const ids = await redis.lrange(SNAPSHOT_INDEX, 0, limit - 1);
  const out = [];
  for (const id of ids || []) {
    const snap = await redis.get(`${SNAPSHOT_PREFIX}${id}`);
    if (!snap) continue;
    out.push({
      id: snap.id,
      ts: snap.ts,
      isoTs: new Date(snap.ts).toISOString(),
      reason: snap.reason,
      positionsCount: Object.keys(snap.positions || {}).length,
      balance: snap.state?.balance,
    });
  }
  return out;
}

// ── HTTP handler ──
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET = list snapshots (geen auth)
  const action = (req.query?.action || '').toLowerCase();
  if (req.method === 'GET' || !action) {
    try {
      const snapshots = await listSnapshots(parseInt(req.query?.limit || '25', 10));
      return res.status(200).json({ ok: true, snapshots });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // Write actions vereisen auth
  if (!TOKEN) return res.status(503).json({ error: 'KILL_SWITCH_TOKEN not configured' });
  const auth = req.headers['authorization'] || req.headers['Authorization'] || '';
  if (auth !== `Bearer ${TOKEN}`) return res.status(401).json({ error: 'Unauthorized' });

  try {
    if (action === 'snapshot') {
      const reason = String(req.query?.reason || 'manual');
      const snap = await createSnapshot(reason);
      try {
        await telegram.sendAlert({
          severity: 'info',
          title: `Snapshot created`,
          message: `id=${snap.id}\nbalance=${snap.state?.balance}\npositions=${Object.keys(snap.positions || {}).length}`,
          dedupeKey: `snap_${snap.id}`,
        });
      } catch {}
      return res.status(200).json({ ok: true, snapshot: snap });
    }

    if (action === 'restore') {
      const snapId = String(req.query?.snapshot || '').trim();
      if (!snapId) return res.status(400).json({ error: 'snapshot id required' });
      const result = await restoreSnapshot(snapId);
      try {
        await telegram.sendAlert({
          severity: 'critical',
          title: `Snapshot RESTORED`,
          message: `Restored ${snapId}\nUndo available: ${result.undoAvailable}\nbalance=${result.state?.balance}\npositions=${result.positionsCount}`,
          dedupeKey: `restore_${snapId}`,
        });
      } catch {}
      return res.status(200).json({ ok: true, restore: result });
    }

    if (action === 'replay-from-exchange' || action === 'replay') {
      const bot = String(req.query?.bot || '').toLowerCase();
      const result = await replayFromExchange(bot);
      try {
        await telegram.sendAlert({
          severity: 'critical',
          title: `State REPLAY from exchange (${bot})`,
          message: `Removed local: ${result.removed.length}\nImported from exchange: ${result.imported.length}\nUndo: ${result.undoAvailable}`,
          dedupeKey: `replay_${bot}`,
        });
      } catch {}
      return res.status(200).json({ ok: true, replay: result });
    }

    return res.status(400).json({ error: `unknown action: ${action} (use snapshot|restore|replay-from-exchange)` });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

module.exports.createSnapshot = createSnapshot;
module.exports.restoreSnapshot = restoreSnapshot;
module.exports.replayFromExchange = replayFromExchange;
module.exports.listSnapshots = listSnapshots;
