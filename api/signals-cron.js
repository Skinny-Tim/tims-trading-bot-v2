// ═══ Merlijn Signal Cron — Server-side signaal engine ═══
// Draait via Vercel Cron (dagelijks 7:00) — pusht ntfy alerts
// Gebruikt gedeelde signal engine (api/_lib/signals.js)
// Identieke signalen als paper-engine → geen drift tussen alerts en trades

const {
  detectElliottWave,
  fetchCandles, fetchBinanceKlines, fetchKronos,
  generateSignals, calc4hLevels,
  loadEwParams
} = require('./_lib/signals');

// ── Prijs formattering ──
function fmtP(v) {
  if (v < 0.01) return v.toFixed(6);
  if (v < 1) return v.toFixed(4);
  if (v < 100) return v.toFixed(2);
  return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

// ── ntfy Push ──
// Anti-rogue-bot defense via filter-tag — elke push krijgt een geheime tag
// die alleen wij + jouw phone (via ?tag=<filter> in subscribe) kennen.
// Rogue bot-pushes zonder deze tag worden door ntfy server-side weggefilterd.
//
// Twee aparte filter-tags voor defense-in-depth:
//   - 4H signals → NTFY_FILTER_TAG          (default merlin-mwur29i4qf)
//   - Monthly Swing → NTFY_MONTHLY_FILTER_TAG (default merlin-monthly-8mr29k4vqp)
// Zo blijft maandelijkse feed afgeschermd zelfs als de 4H tag zou uitlekken.
const NTFY_TOKEN = (process.env.NTFY_TOKEN || '').trim();
const NTFY_FILTER_TAG = (process.env.NTFY_FILTER_TAG || 'merlin-mwur29i4qf').trim();
const NTFY_MONTHLY_FILTER_TAG = (process.env.NTFY_MONTHLY_FILTER_TAG || 'merlin-monthly-8mr29k4vqp').trim();

// filterTagOverride: per-call override voor de filter-tag (bv. monthly krijgt
// eigen tag i.p.v. de default 4H tag). Leeg → gebruik NTFY_FILTER_TAG default.
async function sendNtfy(topic, title, message, tags, priority, expireSeconds = 0, filterTagOverride = null) {
  try {
    const tagArr = (tags || 'chart').split(',').filter(Boolean);
    const filterTag = filterTagOverride || NTFY_FILTER_TAG;
    if (filterTag) tagArr.push(filterTag);
    const payload = {
      topic,
      title: title.replace(/[^\x20-\x7E\u20AC\u2605\u2606]/g, ''),
      message,
      tags: tagArr,
      priority: parseInt(priority) || 3
    };
    if (expireSeconds > 0) payload.expires = Math.floor(Date.now() / 1000) + expireSeconds;
    const headers = { 'Content-Type': 'application/json' };
    if (NTFY_TOKEN) headers['Authorization'] = `Bearer ${NTFY_TOKEN}`;
    const resp = await fetch('https://ntfy.sh/', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });
    const ok = resp.ok;
    console.log(`ntfy ${ok ? 'OK' : 'FAIL'} (${resp.status}): ${topic} — ${title}${NTFY_TOKEN ? '' : ' [no-token]'}`);
    return ok;
  } catch (e) {
    console.error('ntfy error:', e.message);
    return false;
  }
}

// ═══ POST /api/signals — Single Source of Truth signal API (Path C) ═══
// Body: { tf:'4h'|'monthly', tokens:[{short, candles, kronosScore?, waveContext?, computeEW?}] }
// Resp: { ok, tf, results:[{short, markers, buyCount, sellCount, ema9..ema200,
//                            lastSignal:{type,stars,time,price,index,age}, ewWave?}] }
async function signalsApiHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed', hint: 'POST only' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ ok: false, error: 'invalid_json' }); }
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ ok: false, error: 'missing_body' });
  }

  const { tf, tokens: bodyTokens } = body;
  if (tf !== '4h' && tf !== 'monthly') {
    return res.status(400).json({ ok: false, error: 'invalid_tf', allowed: ['4h', 'monthly'] });
  }
  if (!Array.isArray(bodyTokens) || bodyTokens.length === 0) {
    return res.status(400).json({ ok: false, error: 'tokens_required', hint: 'array of {short, candles, ...}' });
  }
  if (bodyTokens.length > 50) {
    return res.status(400).json({ ok: false, error: 'too_many_tokens', max: 50 });
  }

  const ewP = loadEwParams();
  const results = [];

  for (const t of bodyTokens) {
    const short = t.short || 'UNKNOWN';
    const candles = Array.isArray(t.candles) ? t.candles : null;

    if (!candles || candles.length < 30) {
      results.push({ short, error: 'insufficient_candles', got: candles ? candles.length : 0, min: 30 });
      continue;
    }

    let waveContext = t.waveContext != null ? t.waveContext : null;
    let ewWave = null;

    // Backend-side EW detectie (handig voor 4H — dashboard hoeft zelf niet te rekenen)
    if (t.computeEW || waveContext == null) {
      try {
        ewWave = detectElliottWave(
          candles.map(c => c.high),
          candles.map(c => c.low),
          ewP.pivotLen,
          { token: short, timeframe: tf, silent: true, provisionalLen: ewP.provisionalLen }
        );
        if (waveContext == null) waveContext = ewWave;
      } catch (e) {
        console.warn(`[signals API] EW detect failed for ${short}: ${e.message}`);
      }
    }

    const kronosScore = (tf === '4h' && typeof t.kronosScore === 'number') ? t.kronosScore : 0;

    let sig;
    try {
      sig = generateSignals(candles, tf, kronosScore, waveContext);
    } catch (e) {
      results.push({ short, error: 'signal_compute_failed', message: e.message });
      continue;
    }

    let lastSignal = null;
    if (sig.markers.length > 0) {
      const last = sig.markers[sig.markers.length - 1];
      lastSignal = {
        type: last.type,
        stars: last.stars,
        time: last.time,
        price: last.price,
        index: last.index,
        age: candles.length - 1 - last.index,
      };
    }

    results.push({
      short,
      markers: sig.markers,
      buyCount: sig.buyCount,
      sellCount: sig.sellCount,
      ema9: sig.ema9,
      ema21: sig.ema21,
      ema50: sig.ema50,
      ema200: sig.ema200,
      lastSignal,
      ...(ewWave ? { ewWave: { currentWave: ewWave.currentWave, primary: ewWave.primary, alternate: ewWave.alternate, status: ewWave.status } } : {}),
    });
  }

  return res.status(200).json({ ok: true, tf, results });
}

// ═══ Main Cron Handler ═══
//
// Dual-purpose endpoint sinds Path C (2026-04):
//   - GET  /api/signals-cron  → Vercel Cron trigger (Bearer auth via CRON_SECRET)
//   - POST /api/signals       → On-demand signal computation API voor dashboard
//                                (zelfde JS bestand, vercel.json route alias)
//                                Hobby plan caps op 12 serverless functies, dus
//                                we hergebruiken signals-cron als host.
module.exports = async (req, res) => {
  // ─── POST = signals API (Path C — single source of truth voor dashboard) ───
  if (req.method === 'POST' || req.method === 'OPTIONS') {
    return signalsApiHandler(req, res);
  }

  const authHeader = req.headers['authorization'];
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Topic is reserved op ntfy.sh Supporter — NTFY_TOKEN is vereist voor auth.
  // 4H signals → hoofdfeed; Monthly Swing → aparte topic zodat user kan kiezen
  // welke notifs hij wil (maandelijkse signalen zijn informatief, geen trades).
  const NTFY_TOPIC = (process.env.NTFY_TOPIC || 'merlijn-signals-dc80da6186').trim();
  const NTFY_MONTHLY_TOPIC = (process.env.NTFY_MONTHLY_TOPIC || 'merlijn-maandelijksesignalen-7c4ab92e15').trim();
  // User policy: enkel signalen met ≥3 sterren doorpushen — zowel 4H trades
  // als maandelijkse swing signalen. Env override mogelijk via NTFY_MIN_STARS.
  const NTFY_MIN_STARS = parseInt(process.env.NTFY_MIN_STARS || '3', 10);
  const tokens = [
    { symbol: 'BTCUSDT', short: 'BTC', market: 'BTC-EUR' },
    { symbol: 'HBARUSDT', short: 'HBAR', market: 'HBAR-EUR' },
    { symbol: 'XRPUSDT', short: 'XRP', market: 'XRP-EUR' }
  ];

  const results = [];

  try {
    for (const token of tokens) {
      const [candles4h, candlesM, kronos] = await Promise.all([
        fetchCandles(token, '4h', 500),
        fetchBinanceKlines(token.symbol, '1M', 60),
        fetchKronos(token.symbol)
      ]);

      const ewP = loadEwParams();
      let ewWave4h = null;
      if (candles4h && candles4h.length >= 60) {
        ewWave4h = detectElliottWave(candles4h.map(c => c.high), candles4h.map(c => c.low), ewP.pivotLen, { token: token.short, timeframe: '4h', silent: false, provisionalLen: ewP.provisionalLen });
      }

      let ewWaveM = null;
      if (candlesM && candlesM.length >= 20) {
        ewWaveM = detectElliottWave(candlesM.map(c => c.high), candlesM.map(c => c.low), ewP.pivotLen, { token: token.short, timeframe: 'monthly', silent: false, provisionalLen: ewP.provisionalLen });
      }

      // Helper: format EW for ntfy message
      const fmtEW = (ew) => {
        if (!ew || ew.currentWave === 'unclear') return 'unclear';
        const primary = `${ew.currentWave} (${Math.round(ew.primary.confidence * 100)}%)`;
        if (ew.alternate) return `${primary} / alt: ${ew.alternate.wave} (${Math.round(ew.alternate.confidence * 100)}%)`;
        return primary;
      };

      // ── 4H AI Trading signalen ──
      // ⚠ DEPRECATED in deze cron — paper-engine pusht 4H ntfy nu zelf bij elke
      // candle-close-detectie (single source of truth, dedup via state.lastNtfyPush).
      // Deze block blijft staan als BACKUP voor het geval paper-engine offline is.
      if (false && candles4h && candles4h.length >= 60) {
        const kronosScore = kronos.offline ? 0 : (kronos.score || 0);
        const signals = generateSignals(candles4h, '4h', kronosScore, ewWave4h);
        if (signals.markers.length > 0) {
          const lastSignal = signals.markers[signals.markers.length - 1];
          const candleAge = candles4h.length - 1 - lastSignal.index;

          if (candleAge <= 1) {
            const isBuy = lastSignal.type === 'BUY';
            const type = isBuy ? 'KOOP' : 'VERKOOP';
            const emoji = isBuy ? '⬆' : '⬇';
            const starStr = '★'.repeat(lastSignal.stars) + '☆'.repeat(5 - lastSignal.stars);
            const tags = isBuy ? 'green_circle' : 'red_circle';
            const priority = lastSignal.stars >= 4 ? 5 : lastSignal.stars >= 3 ? 4 : 3;

            const levels = calc4hLevels(candles4h, lastSignal.type, kronos);
            const rr = Math.abs(levels.uitstap - levels.instap) / Math.abs(levels.instap - levels.stop);
            const sigDate = new Date(lastSignal.time);
            const sigWhen = sigDate.toLocaleString('nl-BE', { timeZone: 'Europe/Brussels', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

            const sent = await sendNtfy(
              NTFY_TOPIC,
              `${emoji} ${token.short} ${type} SIGNAAL [4H AI Trading]`,
              `${token.short} — ${type} ${starStr}\n` +
              `Gegenereerd: ${sigWhen} (Brussel)\n` +
              `Prijs: ${fmtP(lastSignal.price)}\n` +
              `Instap: ${fmtP(levels.instap)}\n` +
              `Uitstap (target): ${fmtP(levels.uitstap)}\n` +
              `Stop-loss: ${fmtP(levels.stop)}\n` +
              `R/R: 1:${rr.toFixed(1)}\n` +
              `Sterkte: ${lastSignal.stars}/5\n` +
              `Elliott Wave: ${fmtEW(ewWave4h)}\n` +
              `Kronos AI: ${kronos.direction} (${kronos.pct > 0 ? '+' : ''}${kronos.pct}%)\n` +
              `\nMerlijn 4H AI Trading`,
              tags, priority,
              11 * 24 * 60 * 60
            );
            results.push({ token: token.short, tf: '4H', status: 'pushed', type: lastSignal.type, stars: lastSignal.stars, ew: ewWave4h?.currentWave || null, ewAudit: ewWave4h ? { primary: ewWave4h.primary, alternate: ewWave4h.alternate, status: ewWave4h.status } : null, sent });
          } else {
            results.push({ token: token.short, tf: '4H', status: 'old_signal', age: candleAge + ' candles' });
          }
        } else {
          results.push({ token: token.short, tf: '4H', status: 'no_signals' });
        }
      }

      // ── Monthly Swing Trading signalen ──
      // User policy: enkel signalen ≥ NTFY_MIN_STARS pushen (default 3).
      // Monthly swing wordt NIET getraded door paper/live bot (die draaien
      // uitsluitend 4H) — dit blijft een informatief alert-kanaal.
      if (candlesM && candlesM.length >= 10) {
        const signals = generateSignals(candlesM, 'monthly', 0, ewWaveM);
        if (signals.markers.length > 0) {
          const lastSignal = signals.markers[signals.markers.length - 1];
          const recentTimes = candlesM.slice(-3).map(c => c.time);

          if (!recentTimes.includes(lastSignal.time)) {
            results.push({ token: token.short, tf: 'M', status: 'old_signal' });
          } else if (lastSignal.stars < NTFY_MIN_STARS) {
            results.push({ token: token.short, tf: 'M', status: 'below_min_stars', stars: lastSignal.stars, min: NTFY_MIN_STARS });
          } else {
            const isBuy = lastSignal.type === 'BUY';
            const type = isBuy ? 'KOOP' : 'VERKOOP';
            const emoji = isBuy ? '⬆' : '⬇';
            const starStr = '★'.repeat(lastSignal.stars) + '☆'.repeat(5 - lastSignal.stars);
            const tags = isBuy ? 'green_circle' : 'red_circle';
            const priority = lastSignal.stars >= 4 ? 5 : lastSignal.stars >= 3 ? 4 : 3;

            const sigDateM = new Date(lastSignal.time);
            const sigWhenM = sigDateM.toLocaleString('nl-BE', { timeZone: 'Europe/Brussels', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
            // Monthly Swing → eigen topic + eigen filter-tag (defense-in-depth).
            // Topic suffix is onraadbaar zodat rogue bots niet kunnen spammen,
            // filter-tag scheidt 'm bovendien van de hoofdfeed.
            const sent = await sendNtfy(
              NTFY_MONTHLY_TOPIC,
              `${emoji} ${token.short} ${type} SIGNAAL [Monthly Swing Trading]`,
              `${token.short} — ${type} ${starStr}\n` +
              `Gegenereerd: ${sigWhenM} (Brussel)\n` +
              `Prijs: ${fmtP(lastSignal.price)}\n` +
              `Sterkte: ${lastSignal.stars}/5 (min ${NTFY_MIN_STARS}★)\n` +
              `Elliott Wave: ${fmtEW(ewWaveM)}\n` +
              `Maandgrafiek signaal (EMA/RSI/MACD)\n` +
              `\nMerlijn Monthly Swing Trading`,
              tags, priority,
              0,  // expireSeconds (default)
              NTFY_MONTHLY_FILTER_TAG  // filterTagOverride
            );
            results.push({ token: token.short, tf: 'M', status: 'pushed', type: lastSignal.type, stars: lastSignal.stars, ew: ewWaveM?.currentWave || null, ewAudit: ewWaveM ? { primary: ewWaveM.primary, alternate: ewWaveM.alternate, status: ewWaveM.status } : null, sent });
          }
        } else {
          results.push({ token: token.short, tf: 'M', status: 'no_signals' });
        }
      }
    }

    console.log('📲 Cron signaal check:', JSON.stringify(results));
    return res.status(200).json({ ok: true, checked: new Date().toISOString(), results });

  } catch (err) {
    console.error('Cron error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
