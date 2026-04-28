// ═══ /api/bot-config — gebruikers-toggles voor welke bots traden ═══
//
// Geen aparte Vercel serverless function: dispatched door ops.js (route in
// vercel.json wijst /api/bot-config naar /api/ops.js). Houdt function-count
// onder de Hobby-limit van 12.
//
// Endpoints (via dispatcher):
//   GET  /api/bot-config              → { ok, bots: { paper_4h:{enabled,mode,label,...}, ... },
//                                              env: { liveMainnetConfirmed: bool }, ts }
//   POST /api/bot-config              → body: { bot, enabled }                sets enabled
//                                     OR body: { bot, mode }                  sets mode (paper|live)
//                                     OR body: { updates: {paper_4h: false} }                  batch enabled
//                                     OR body: { updates: {paper_4h: {enabled?, mode?}} }      batch mixed
//
// Auth:
//   - GET is open (read-only state, geen secrets)
//   - POST eist BOT_CONFIG_TOKEN env (header: x-bot-token of query ?token=)
//     fallback: PAPER_ENGINE_SECRET (zelfde token als reset-flow)
//
// SAFETY: live-mode vereist ÓÓK env LIVE_MAINNET_CONFIRM=YES_I_UNDERSTAND op
// de execution-laag. Toggle via UI is dus alleen "intent" — als env mist
// blijft engine paper. UI toont dit via /api/bot-config response.env.liveMainnetConfirmed.

const cfg = require('./_lib/bot-config');

function _getToken(req) {
  const h = req.headers || {};
  return (h['x-bot-token'] || h['x-merlijn-token'] || req.query?.token || '').toString();
}
function _expectedToken() {
  return process.env.BOT_CONFIG_TOKEN || process.env.PAPER_ENGINE_SECRET || '';
}
function _setCors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-bot-token, x-merlijn-token');
}

async function _readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;          // Vercel auto-parsed
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  // Fallback voor edge-runtime / raw stream
  return await new Promise((resolve) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

module.exports = async function botConfigHandler(req, res) {
  _setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'GET') {
      const bots = await cfg.getAll();
      return res.status(200).json({
        ok: true,
        bots,
        env: { liveMainnetConfirmed: cfg.isLiveMainnetConfirmed() },
        ts: new Date().toISOString(),
      });
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ ok: false, error: 'method not allowed' });
    }

    // ── POST: write toggle(s) ──
    const expected = _expectedToken();
    if (expected) {
      const tok = _getToken(req);
      if (tok !== expected) {
        return res.status(401).json({ ok: false, error: 'unauthorized' });
      }
    }

    const body = await _readJsonBody(req);

    // Normaliseer payload naar `updates: { bot: {enabled?, mode?} }` shape
    let updates = null;
    if (body.updates && typeof body.updates === 'object') {
      updates = {};
      for (const [bot, val] of Object.entries(body.updates)) {
        if (val === null || val === undefined) continue;
        if (typeof val === 'boolean') updates[bot] = { enabled: val };
        else if (typeof val === 'object') updates[bot] = val;
        else updates[bot] = { enabled: !!val };   // truthy fallback
      }
    } else if (body.bot) {
      updates = { [body.bot]: {} };
      if ('enabled' in body) updates[body.bot].enabled = !!body.enabled;
      if ('mode'    in body) updates[body.bot].mode    = body.mode;
    }

    if (!updates || Object.keys(updates).length === 0) {
      return res.status(400).json({
        ok: false,
        error: 'expected { bot, enabled|mode } or { updates: { bot: bool|{enabled?, mode?} } }',
      });
    }

    const results = [];
    for (const [bot, change] of Object.entries(updates)) {
      const r = { bot, ok: true };
      try {
        if ('enabled' in change) {
          const er = await cfg.setEnabled(bot, !!change.enabled);
          r.enabled = er.enabled;
        }
        if ('mode' in change && change.mode !== undefined && change.mode !== null) {
          // Live-mode vereist env-confirm — anders blocken op API niveau zodat
          // user direct feedback krijgt ipv stille fallback in execution.js.
          if (change.mode === 'live' && !cfg.isLiveMainnetConfirmed()) {
            r.ok = false;
            r.error = 'LIVE_MAINNET_CONFIRM env niet gezet — set LIVE_MAINNET_CONFIRM=YES_I_UNDERSTAND in Vercel env eerst';
            results.push(r);
            continue;
          }
          const mr = await cfg.setMode(bot, change.mode);
          r.mode = mr.mode;
        }
      } catch (e) {
        r.ok = false;
        r.error = e.message;
      }
      results.push(r);
    }

    const bots = await cfg.getAll();
    return res.status(200).json({
      ok: true,
      results,
      bots,
      env: { liveMainnetConfirmed: cfg.isLiveMainnetConfirmed() },
      ts: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[bot-config] error:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};
