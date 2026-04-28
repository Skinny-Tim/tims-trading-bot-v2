// ═══ /api/config — lees en schrijf alle bot parameters ═══
//
// GET  /api/config           → alle huidige parameters (signal-params + engine constants)
// POST /api/config           → schrijf parameters naar Redis (overschrijft signal-params.json defaults)
// POST /api/config?reset=1   → reset alle Redis overrides (terug naar signal-params.json defaults)
//
// Auth: POST vereist header x-bot-token = PAPER_ENGINE_SECRET

const redis  = require('./_lib/redis');
const fs     = require('fs');
const path   = require('path');

const REDIS_KEY  = 'bot:config:overrides';
const AUTH_TOKEN = process.env.PAPER_ENGINE_SECRET || process.env.BOT_CONFIG_TOKEN || '';

// ── Engine constants (hardcoded defaults — ter referentie voor de UI) ──
const ENGINE_DEFAULTS = {
  ADAPTIVE_MIN_STARS:       4,
  MIN_RR:                   0.5,
  KRONOS_MODE:              'blend',
  KRONOS_VETO_PCT:          10,
  MTF_ALIGNMENT_REQUIRED:   true,
  VOLATILITY_MAX_ATR_PCT:   8,
  RISK_PER_TRADE:           0.01,
  MAX_POSITIONS:            4,
  MAX_CRYPTO_LONGS:         4,
  CASH_BUFFER_PCT:          0.25,
  PARTIAL_PCT:              0.50,
  MAX_HOLD_HOURS:           120,
  TRAIL_ATR_BASE:           1.5,
  BREAKEVEN_ATR:            1.0,
  EXIT_TRAIL_MULT_TIGHT:    0.5,
  PORTFOLIO_KILL_DD_PCT:    0.05,
  DD_HALVE_THRESHOLD:       0.15,
  DD_PAUSE_THRESHOLD:       0.25,
  CIRCUIT_PAUSE_HOURS:      24,
  CONSECUTIVE_LOSS_THRESHOLD: 3,
  ADAPTIVE_LOOKBACK_TRADES: 7,
  ADAPTIVE_WIN_RATE:        0.40,
  REOPEN_GUARD_HOURS:       4,
};

// ── Parameter metadata (voor UI labels en validatie) ──
const PARAM_META = {
  // Signal params (uit signal-params.json 4h sectie)
  minIndicators:        { label: 'Min. indicatoren',      min: 1,    max: 9,    step: 1,    unit: '',    group: 'Instap' },
  minScore:             { label: 'Min. score',            min: 1,    max: 20,   step: 1,    unit: '',    group: 'Instap' },
  cooldown:             { label: 'Cooldown',              min: 1,    max: 72,   step: 1,    unit: 'uur', group: 'Instap' },
  minADX:               { label: 'Min. ADX',              min: 15,   max: 50,   step: 1,    unit: '',    group: 'Instap' },
  requireVolume:        { label: 'Volume verplicht',      type: 'bool',                                  group: 'Instap' },
  reqVolMultiplier:     { label: 'Volume multiplier',     min: 1.0,  max: 5.0,  step: 0.1,  unit: '×',  group: 'Instap' },
  requireTrendAlignment:{ label: 'Trend alignment',       type: 'bool',                                  group: 'Instap' },
  antiTrendBlock:       { label: 'Anti-trend blokkeren',  type: 'bool',                                  group: 'Instap' },

  // Engine constants
  ADAPTIVE_MIN_STARS:   { label: 'Min. sterren',          min: 1,    max: 5,    step: 1,    unit: '★',  group: 'Kwaliteit' },
  MIN_RR:               { label: 'Min. Risk/Reward',      min: 0.1,  max: 5.0,  step: 0.1,  unit: '×',  group: 'Kwaliteit' },
  KRONOS_MODE:          { label: 'Kronos modus',          type: 'select', options: ['blend','veto','off'], group: 'Kwaliteit' },
  KRONOS_VETO_PCT:      { label: 'Kronos veto drempel',   min: 1,    max: 50,   step: 1,    unit: '%',  group: 'Kwaliteit' },
  MTF_ALIGNMENT_REQUIRED:{ label: 'MTF alignment',        type: 'bool',                                  group: 'Kwaliteit' },
  VOLATILITY_MAX_ATR_PCT:{ label: 'Max ATR volatiliteit', min: 1,    max: 20,   step: 0.5,  unit: '%',  group: 'Kwaliteit' },

  RISK_PER_TRADE:       { label: 'Risico per trade',      min: 0.001,max: 0.05, step: 0.001,unit: '%',  group: 'Positie', pct: true },
  MAX_POSITIONS:        { label: 'Max. posities',         min: 1,    max: 10,   step: 1,    unit: '',   group: 'Positie' },
  MAX_CRYPTO_LONGS:     { label: 'Max. crypto longs',     min: 1,    max: 10,   step: 1,    unit: '',   group: 'Positie' },
  CASH_BUFFER_PCT:      { label: 'Cash buffer',           min: 0.05, max: 0.5,  step: 0.05, unit: '%',  group: 'Positie', pct: true },
  PARTIAL_PCT:          { label: 'Partial close %',       min: 0.1,  max: 1.0,  step: 0.1,  unit: '%',  group: 'Positie', pct: true },
  MAX_HOLD_HOURS:       { label: 'Max. houdtijd',         min: 12,   max: 720,  step: 12,   unit: 'uur',group: 'Positie' },

  TRAIL_ATR_BASE:       { label: 'Trailing stop ATR',     min: 0.3,  max: 5.0,  step: 0.1,  unit: '×',  group: 'Stop/Trail' },
  BREAKEVEN_ATR:        { label: 'Break-even activatie',  min: 0.1,  max: 3.0,  step: 0.1,  unit: '×ATR',group:'Stop/Trail' },
  EXIT_TRAIL_MULT_TIGHT:{ label: 'Exit trail (tight)',    min: 0.1,  max: 2.0,  step: 0.1,  unit: '×',  group: 'Stop/Trail' },
  REOPEN_GUARD_HOURS:   { label: 'Reopen guard',          min: 0,    max: 48,   step: 1,    unit: 'uur',group: 'Stop/Trail' },

  PORTFOLIO_KILL_DD_PCT:{ label: '24u kill drempel',      min: 0.01, max: 0.2,  step: 0.01, unit: '%',  group: 'Veiligheid', pct: true },
  DD_HALVE_THRESHOLD:   { label: 'DD halveer drempel',    min: 0.05, max: 0.5,  step: 0.05, unit: '%',  group: 'Veiligheid', pct: true },
  DD_PAUSE_THRESHOLD:   { label: 'DD pauze drempel',      min: 0.1,  max: 0.6,  step: 0.05, unit: '%',  group: 'Veiligheid', pct: true },
  CIRCUIT_PAUSE_HOURS:  { label: 'Circuit breaker pauze', min: 1,    max: 168,  step: 1,    unit: 'uur',group: 'Veiligheid' },
  CONSECUTIVE_LOSS_THRESHOLD:{ label: 'Max. verliesreeks',min: 1,    max: 10,   step: 1,    unit: '',   group: 'Veiligheid' },

  ADAPTIVE_LOOKBACK_TRADES:{ label: 'Adaptief lookback',  min: 5,    max: 50,   step: 5,    unit: 'trades',group:'Adaptief' },
  ADAPTIVE_WIN_RATE:    { label: 'Adaptief winrate drempel',min:0.1,  max:0.8,  step: 0.05, unit: '%',  group: 'Adaptief', pct: true },
};

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-bot-token');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET — lees huidige config ──
  if (req.method === 'GET') {
    try {
      // Lees signal-params.json (file defaults)
      const configPath = path.join(__dirname, '..', 'signal-params.json');
      const signalParams = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const params4h = signalParams['4h'] || {};

      // Lees Redis overrides
      const overrides = await redis.get(REDIS_KEY) || {};

      // Merge: Redis wint van file defaults
      const current = {
        // Signal params
        minIndicators:        overrides.minIndicators        ?? params4h.minIndicators        ?? 3,
        minScore:             overrides.minScore             ?? params4h.minScore             ?? 3,
        cooldown:             overrides.cooldown             ?? params4h.cooldown             ?? 12,
        minADX:               overrides.minADX               ?? params4h.minADX               ?? 25,
        requireVolume:        overrides.requireVolume        ?? params4h.requireVolume        ?? true,
        reqVolMultiplier:     overrides.reqVolMultiplier     ?? params4h.reqVolMultiplier     ?? 1.3,
        requireTrendAlignment:overrides.requireTrendAlignment?? params4h.requireTrendAlignment?? false,
        antiTrendBlock:       overrides.antiTrendBlock       ?? params4h.antiTrendBlock       ?? false,
        // Engine constants (Redis of hardcoded defaults)
        ...Object.fromEntries(
          Object.keys(ENGINE_DEFAULTS).map(k => [k, overrides[k] ?? ENGINE_DEFAULTS[k]])
        ),
      };

      return res.status(200).json({
        ok:       true,
        current,
        overrides,
        defaults: { ...ENGINE_DEFAULTS, ...params4h },
        meta:     PARAM_META,
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST — schrijf overrides ──
  if (req.method === 'POST') {
    const token = req.headers['x-bot-token'] || req.query?.token || '';
    if (AUTH_TOKEN && token !== AUTH_TOKEN)
      return res.status(401).json({ error: 'Unauthorized' });

    try {
      let body = req.body;
      if (typeof body === 'string') body = JSON.parse(body);
      if (!body || typeof body !== 'object')
        return res.status(400).json({ error: 'Geen geldige JSON body' });

      // Reset alle overrides
      if (req.query?.reset === '1') {
        await redis.set(REDIS_KEY, {});
        return res.status(200).json({ ok: true, message: 'Alle overrides gereset naar defaults' });
      }

      // Schrijf nieuwe overrides (merge met bestaande)
      const existing = await redis.get(REDIS_KEY) || {};
      const updated  = { ...existing, ...body, _updatedAt: new Date().toISOString() };
      await redis.set(REDIS_KEY, updated);

      return res.status(200).json({
        ok:       true,
        message:  `${Object.keys(body).length} parameter(s) opgeslagen`,
        overrides: updated,
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
