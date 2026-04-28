// ═══ Operations dispatcher ═══
//
// Consolideert 5 ops-endpoints in één serverless function (Vercel Hobby limit = 12).
// Routing op basis van req.url path:
//   /api/kill-switch   → kill-switch handler
//   /api/reconcile     → reconcile handler
//   /api/recover       → recover handler
//   /api/audit         → audit handler
//   /api/equity-curve  → equity-curve handler
//
// Elke onderliggende module exporteert nog steeds zijn eigen handler + helpers
// zodat de modules los testbaar blijven en imports vanuit andere code werken.

const killSwitchHandler = require('./kill-switch');
const reconcileHandler  = require('./reconcile');
const recoverHandler    = require('./recover');
const auditHandler      = require('./audit');
const equityCurveHandler = require('./equity-curve');
const botConfigHandler  = require('./bot-config-handler');

module.exports = async function handler(req, res) {
  const url = req.url || '';
  // Pak het pad-prefix uit /api/<name>?...
  const path = url.split('?')[0].replace(/\/+$/, '').toLowerCase();

  if (path === '/api/kill-switch' || path.endsWith('/kill-switch')) {
    return killSwitchHandler(req, res);
  }
  if (path === '/api/reconcile' || path.endsWith('/reconcile')) {
    return reconcileHandler(req, res);
  }
  if (path === '/api/recover' || path.endsWith('/recover')) {
    return recoverHandler(req, res);
  }
  if (path === '/api/audit' || path.endsWith('/audit')) {
    return auditHandler(req, res);
  }
  if (path === '/api/equity-curve' || path.endsWith('/equity-curve')) {
    return equityCurveHandler(req, res);
  }
  if (path === '/api/bot-config' || path.endsWith('/bot-config')) {
    return botConfigHandler(req, res);
  }

  return res.status(404).json({ error: `unknown ops path: ${path}` });
};
