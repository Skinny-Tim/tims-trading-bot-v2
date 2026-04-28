// ═══ Bot enable/disable configuration ═══
//
// Per-bot opt-out om gebruikers te laten kiezen welke bots mogen traden.
// State leeft in Redis onder `bot:enabled:<id>` (boolean).
//
// FAIL MODE: voor LIVE trading default = fail-CLOSED (Redis-storing → bot stop).
// Voor paper kun je via env BOT_CONFIG_FAIL_MODE=open de oude fail-open keuze
// terughalen. M-P0-5 fix (2026-04-23): voorheen was fail-open default → een
// disabled bot kon doortraden bij Redis hiccup, met financieel verlies in live.
//
// "Disabled" betekent: GEEN nieuwe entries. Bestaande posities blijven managed
// (stops, targets, trails, time-exits) zodat we nooit hangen op een open
// trade die niet meer kan sluiten. Engines roepen isEnabled() aan vóór de
// entry-loop, niet vóór de exit-loop.
//
// Bot-IDs (sluiten aan op portfolio.BOTS):
//   paper_4h        → Merlijn Elliott (op /trading)
//   paper_kronos    → Merlijn Kronos  (op /trading)
//
// Camelot zit NIET in deze selector (eigen page /camelot, eigen lifecycle).
// Wel houdt camelot-engine.js zijn eigen toggle in env (CAMELOT_ENABLED) als
// kill-switch nodig is.

const redis = require('./redis');

const ALL_BOTS = ['paper_4h', 'paper_kronos'];

const LABELS = {
  paper_4h:     { name: 'NØA Elliot Wave',  short: 'Elliot Wave',  page: '/trading' },
  paper_kronos: { name: 'NØA Kronos',       short: 'Kronos',       page: '/trading' },
};

// ── Trading mode (paper vs live Binance) ──
//
// Modes:
//   'paper'    → simulatie via fills.js (default — fail-safe)
//   'live'     → echte orders via Binance adapter (mainnet)
//
// Storage in Redis onder `bot:mode:<id>`. Default = 'paper'.
//
// SAFETY: mainnet vereist ÓÓK env LIVE_MAINNET_CONFIRM=YES_I_UNDERSTAND
// (defense in depth — als de Redis-toggle per ongeluk op live staat zonder
// dat env-confirm gezet is, valt execution.js terug op paper).
const ALL_MODES = ['paper', 'live'];
const DEFAULT_MODE = 'paper';

function _key(bot) { return `bot:enabled:${bot}`; }
function _modeKey(bot) { return `bot:mode:${bot}`; }

function _coerceMode(v) {
  if (typeof v !== 'string') return DEFAULT_MODE;
  const s = v.toLowerCase().trim();
  if (s === 'live' || s === 'mainnet' || s === 'live-mainnet') return 'live';
  return 'paper';   // alle andere waarden (incl. testnet, off, junk) → fail-safe paper
}

// Strict boolean coercion van wat Redis ook teruggeeft (json bool, string,
// nummer of null=default).
function _coerce(v, defaultVal = true) {
  if (v === null || v === undefined) return defaultVal;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.toLowerCase();
    if (s === 'false' || s === '0' || s === 'off' || s === '') return false;
    if (s === 'true' || s === '1' || s === 'on') return true;
  }
  return defaultVal;
}

// M-P0-5 fix (2026-04-23): default = fail-CLOSED voor LIVE safety. Override via
// env BOT_CONFIG_FAIL_MODE=open als je expliciet de oude fail-open semantics wilt
// (bijv. tijdens local dev / paper-only met flaky Redis).
const FAIL_MODE = (process.env.BOT_CONFIG_FAIL_MODE || 'closed').toLowerCase();
const FAIL_OPEN = FAIL_MODE === 'open';

async function isEnabled(bot) {
  if (!ALL_BOTS.includes(bot)) return true;          // unknown bot → fail-open (allow)
  if (!redis.isConfigured()) {
    console.warn(`[bot-config] no redis configured for ${bot} → ${FAIL_OPEN ? 'fail-OPEN (allow)' : 'fail-CLOSED (block)'}`);
    return FAIL_OPEN;
  }
  try {
    const v = await redis.get(_key(bot));
    return _coerce(v, true);
  } catch (e) {
    console.warn(`[bot-config] read error for ${bot}: ${e.message} → ${FAIL_OPEN ? 'fail-OPEN (allow)' : 'fail-CLOSED (block)'}`);
    return FAIL_OPEN;
  }
}

async function setEnabled(bot, enabled) {
  if (!ALL_BOTS.includes(bot)) throw new Error(`unknown bot: ${bot}`);
  if (!redis.isConfigured()) throw new Error('Redis not configured');
  await redis.set(_key(bot), !!enabled);
  return { bot, enabled: !!enabled };
}

// ── Mode read/write ──
async function getMode(bot) {
  if (!ALL_BOTS.includes(bot)) return DEFAULT_MODE;
  if (!redis.isConfigured()) return DEFAULT_MODE;
  try {
    const v = await redis.get(_modeKey(bot));
    return _coerceMode(v);
  } catch (e) {
    console.warn(`[bot-config] mode read error for ${bot}: ${e.message} → fail-safe paper`);
    return DEFAULT_MODE;
  }
}

async function setMode(bot, mode) {
  if (!ALL_BOTS.includes(bot)) throw new Error(`unknown bot: ${bot}`);
  if (!redis.isConfigured()) throw new Error('Redis not configured');
  const m = _coerceMode(mode);
  if (!ALL_MODES.includes(m)) throw new Error(`invalid mode: ${mode}`);
  await redis.set(_modeKey(bot), m);
  return { bot, mode: m };
}

// ── Live-mainnet env-gate check (gebruikt door UI om "live" knop te disablen
// als operator het env-confirm nog niet gezet heeft) ──
function isLiveMainnetConfirmed() {
  return process.env.LIVE_MAINNET_CONFIRM === 'YES_I_UNDERSTAND';
}

async function getAll() {
  const out = {};
  for (const b of ALL_BOTS) {
    out[b] = {
      enabled:  await isEnabled(b),
      mode:     await getMode(b),
      label:    LABELS[b]?.name  || b,
      short:    LABELS[b]?.short || b,
      page:     LABELS[b]?.page  || null,
    };
  }
  return out;
}

module.exports = {
  ALL_BOTS,
  ALL_MODES,
  DEFAULT_MODE,
  LABELS,
  isEnabled,
  setEnabled,
  getMode,
  setMode,
  isLiveMainnetConfirmed,
  getAll,
};
