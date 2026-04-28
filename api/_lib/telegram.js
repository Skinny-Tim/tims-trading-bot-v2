// ═══ Telegram alert module ═══
//
// Stuurt push notifications naar je Telegram via Bot API.
// Setup eenmalig:
//   1. Open Telegram, zoek @BotFather, /newbot → krijg TELEGRAM_BOT_TOKEN
//   2. Stuur /start naar je nieuwe bot
//   3. Open https://api.telegram.org/bot<TOKEN>/getUpdates → vind chat.id
//   4. Set env vars TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
//
// Gebruikt voor live trading alerts (orders, fails, circuit fires, kill-switch).
// Failsafe: alle calls zijn fire-and-forget — falen blokkeert nooit trading.
//
// Severity levels:
//   info    — normale events (order placed, position closed)
//   warn    — interventie aanbevolen (high slippage, partial fill, reconciliation drift)
//   error   — direct actie nodig (order rejected, exchange API down, balance mismatch)
//   critical — emergency (kill-switch fired, max-loss circuit triggered, auth lost)

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const TELEGRAM_DISABLE = process.env.TELEGRAM_DISABLE === '1';

// Throttle: voorkom spam (bv. exchange-down die 100x/min fired). Per dedupe-key
// max 1 message per N seconden.
const THROTTLE_SEC = parseInt(process.env.TELEGRAM_THROTTLE_SEC || '30', 10);
const _throttleCache = new Map();   // key → lastSentMs

const SEVERITY_EMOJI = {
  info:     'ℹ️',
  warn:     '⚠️',
  error:    '🚨',
  critical: '🆘',
  ok:       '✅',
  trade:    '💱',
};

function _isConfigured() {
  return TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID && !TELEGRAM_DISABLE;
}

function _shouldThrottle(key) {
  if (!key) return false;
  const last = _throttleCache.get(key) || 0;
  const now = Date.now();
  if (now - last < THROTTLE_SEC * 1000) return true;
  _throttleCache.set(key, now);
  // Cleanup oude entries (>1u oud)
  if (_throttleCache.size > 200) {
    for (const [k, t] of _throttleCache) {
      if (now - t > 3600 * 1000) _throttleCache.delete(k);
    }
  }
  return false;
}

// Hoofdfunctie. Returns Promise<boolean> (sent succesvol).
// Throws never — alle errors worden geslikt en console.warn'd.
async function sendAlert({
  severity = 'info',
  title,
  message,
  dedupeKey = null,         // optioneel: throttle per key
  silent = false,           // true = geen sound op user's phone
  parseMode = 'HTML',       // 'HTML' of 'Markdown' of null
}) {
  if (!_isConfigured()) {
    console.warn('[telegram] not configured (TELEGRAM_BOT_TOKEN/CHAT_ID missing) — skipping alert:', title);
    return false;
  }
  if (_shouldThrottle(dedupeKey)) {
    console.log(`[telegram] throttled (dedupeKey=${dedupeKey}):`, title);
    return false;
  }

  const emoji = SEVERITY_EMOJI[severity] || 'ℹ️';
  const sevTag = severity.toUpperCase();
  const text = `${emoji} <b>[${sevTag}]</b> ${title || ''}\n${message || ''}`.trim();

  try {
    const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: parseMode,
        disable_notification: silent || severity === 'info',   // info = silent, others ping
        disable_web_page_preview: true,
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      console.warn(`[telegram] HTTP ${resp.status}:`, errText.slice(0, 200));
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[telegram] send error:', e.message);
    return false;
  }
}

// ── Convenience wrappers per gebeurtenistype ──

// Live order geplaatst (entry of exit)
async function alertOrderPlaced({ bot, network, side, token, qty, price, sizeUsd, orderId, kind = 'ENTRY' }) {
  return sendAlert({
    severity: 'trade',
    title: `${bot.toUpperCase()} ${kind} ${side} ${token}`,
    message: [
      `Network: <code>${network}</code>`,
      `Qty: <code>${qty}</code> @ <code>$${Number(price).toFixed(4)}</code>`,
      `Size: <code>$${Number(sizeUsd).toFixed(2)}</code>`,
      `OrderID: <code>${orderId}</code>`,
    ].join('\n'),
    dedupeKey: `order_${orderId}`,
  });
}

// Order failed/rejected
async function alertOrderFailed({ bot, network, side, token, reason, errorCode, errorMsg }) {
  return sendAlert({
    severity: 'error',
    title: `${bot.toUpperCase()} ORDER FAILED ${side} ${token}`,
    message: [
      `Network: <code>${network}</code>`,
      `Reason: ${reason || 'unknown'}`,
      errorCode ? `Code: <code>${errorCode}</code>` : '',
      errorMsg ? `Error: <code>${String(errorMsg).slice(0, 200)}</code>` : '',
    ].filter(Boolean).join('\n'),
    dedupeKey: `order_fail_${bot}_${token}_${errorCode || 'unknown'}`,
  });
}

// Reconciliation drift gevonden
async function alertReconcileDrift({ bot, exchange, drifts }) {
  const summary = drifts.slice(0, 5).map(d => `• ${d.token}: bot=${d.botQty} ↔ ex=${d.exQty} (Δ${d.deltaPct.toFixed(1)}%)`).join('\n');
  return sendAlert({
    severity: 'warn',
    title: `${bot.toUpperCase()} reconciliation drift (${drifts.length})`,
    message: `Exchange: ${exchange}\n${summary}${drifts.length > 5 ? `\n…+${drifts.length - 5} more` : ''}`,
    dedupeKey: `recon_drift_${bot}`,
  });
}

// Circuit breaker fired
async function alertCircuitFired({ bot, reason, drawdownPct, untilTs, kind, detail }) {
  const untilStr = untilTs ? new Date(untilTs).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : null;
  // Accept BOTH legacy (reason/drawdownPct/untilTs) en nieuwe (kind/detail) shape
  const lines = [];
  if (detail) lines.push(`Detail: ${detail}`);
  else if (reason) lines.push(`Reason: ${reason}`);
  if (kind) lines.push(`Kind: <code>${kind}</code>`);
  if (drawdownPct != null) lines.push(`Drawdown: <code>${(drawdownPct * 100).toFixed(2)}%</code>`);
  if (untilStr) lines.push(`Paused until: <code>${untilStr}</code>`);
  lines.push('');
  lines.push(`<i>Auto-pause active. Manual resume required via dashboard.</i>`);
  return sendAlert({
    severity: 'critical',
    title: `${(bot || 'ALL').toUpperCase()} CIRCUIT BREAKER FIRED`,
    message: lines.join('\n'),
    dedupeKey: `circuit_${bot || 'all'}_${kind || 'generic'}`,
  });
}

// Kill-switch geactiveerd
async function alertKillSwitch({ trigger, scope = 'all', closedCount = 0 }) {
  return sendAlert({
    severity: 'critical',
    title: `🛑 KILL-SWITCH ACTIVATED`,
    message: [
      `Trigger: <code>${trigger}</code>`,
      `Scope: <code>${scope}</code>`,
      `Positions closed: <code>${closedCount}</code>`,
      ``,
      `<i>All new entries disabled. Manual re-enable required.</i>`,
    ].join('\n'),
  });
}

// Daily summary (info)
async function alertDailySummary({ bots }) {
  const lines = bots.map(b => `• ${b.name}: PV $${b.pv.toFixed(0)} | P&L ${b.pnlPct >= 0 ? '+' : ''}${b.pnlPct.toFixed(2)}% | trades ${b.trades24h} | open ${b.open}`);
  return sendAlert({
    severity: 'info',
    title: `Daily summary`,
    message: lines.join('\n'),
    silent: true,
  });
}

// Generic test
async function alertTest() {
  return sendAlert({
    severity: 'ok',
    title: `Telegram alerts werken`,
    message: `Bot token + chat ID correct geconfigureerd.\nTime: <code>${new Date().toISOString()}</code>`,
  });
}

module.exports = {
  sendAlert,
  alertOrderPlaced,
  alertOrderFailed,
  alertReconcileDrift,
  alertCircuitFired,
  alertKillSwitch,
  alertDailySummary,
  alertTest,
  _isConfigured,
};
