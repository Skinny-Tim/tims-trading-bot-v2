// ═══ /api/claude-analyzer — stuurt trade log naar Claude voor analyse ═══
//
// POST /api/claude-analyzer          → analyseer laatste trades, sla aanbevelingen op in Redis
// GET  /api/claude-analyzer          → haal laatste aanbevelingen op
//
// Wordt automatisch getriggerd via cron (wekelijks) of handmatig via de config pagina.
// Vereist: ANTHROPIC_API_KEY als Vercel environment variable.

const redis = require('./_lib/redis');

const REDIS_RECOMMENDATIONS_KEY = 'bot:claude:recommendations';
const REDIS_TRADES_KEY          = 'portfolio:trades';
const AUTH_TOKEN = process.env.PAPER_ENGINE_SECRET || process.env.BOT_CONFIG_TOKEN || '';

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-bot-token');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET — haal laatste aanbevelingen op ──
  if (req.method === 'GET') {
    try {
      const recs = await redis.get(REDIS_RECOMMENDATIONS_KEY);
      return res.status(200).json({ ok: true, recommendations: recs || null });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST — analyseer trades ──
  if (req.method === 'POST') {
    const token = req.headers['x-bot-token'] || req.query?.token || '';
    if (AUTH_TOKEN && token !== AUTH_TOKEN)
      return res.status(401).json({ error: 'Unauthorized' });

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey)
      return res.status(503).json({ error: 'ANTHROPIC_API_KEY niet geconfigureerd' });

    try {
      // Haal laatste 50 gesloten trades op
      const raw = await redis.lrange(REDIS_TRADES_KEY, 0, 49) || [];

      if (raw.length < 5)
        return res.status(200).json({ ok: false, message: 'Te weinig trades voor analyse (min. 5)' });

      // Bouw statistieken
      const trades = raw.map(t => ({
        token:       t.token,
        side:        t.side,
        stars:       t.stars || t.meta?.stars || '?',
        pnl:         t.pnl   != null ? +t.pnl.toFixed(4) : null,
        pnlPct:      t.pnlPct!= null ? +t.pnlPct.toFixed(2) : null,
        durationMin: t.openTime && t.closeTime ? Math.round((t.closeTime - t.openTime) / 60000) : null,
        closeReason: t.reason || 'Onbekend',
        rr:          t.meta?.rr || null,
        atrPct:      t.atrPct  || null,
      }));

      const wins   = trades.filter(t => (t.pnl || 0) > 0);
      const losses = trades.filter(t => (t.pnl || 0) < 0);
      const winRate = trades.length ? (wins.length / trades.length * 100).toFixed(1) : 0;
      const avgWin  = wins.length   ? (wins.reduce((s,t)   => s + t.pnlPct, 0) / wins.length).toFixed(2)   : 0;
      const avgLoss = losses.length ? (losses.reduce((s,t) => s + t.pnlPct, 0) / losses.length).toFixed(2) : 0;

      // Meest voorkomende sluitredenen
      const reasons = {};
      trades.forEach(t => {
        const r = t.closeReason?.split(' ')[0] || 'Onbekend';
        reasons[r] = (reasons[r] || 0) + 1;
      });

      // Kortste trades (potentieel reversal probleem)
      const shortTrades = trades.filter(t => t.durationMin != null && t.durationMin < 60);

      // Bouw de prompt voor Claude
      const prompt = `Je bent een expert trading bot analist. Analyseer de volgende trade statistieken van een crypto paper trading bot en geef concrete aanbevelingen voor parameter aanpassingen.

## Trade Statistieken (laatste ${trades.length} trades)

**Samenvatting:**
- Winrate: ${winRate}%
- Gemiddelde winst: ${avgWin}%
- Gemiddeld verlies: ${avgLoss}%
- Wins: ${wins.length} | Verliezen: ${losses.length}
- Trades korter dan 1 uur: ${shortTrades.length}

**Sluitredenen:**
${Object.entries(reasons).map(([r, c]) => `- ${r}: ${c}×`).join('\n')}

**Laatste 20 trades (token | sterren | P&L% | duur | sluitreden):**
${trades.slice(0, 20).map(t =>
  `${t.token} | ${t.stars}★ | ${t.pnlPct != null ? t.pnlPct + '%' : '?'} | ${t.durationMin != null ? t.durationMin + 'min' : '?'} | ${t.closeReason}`
).join('\n')}

**Aanpasbare parameters (huidig):**
- MIN_RR: 0.5
- ADAPTIVE_MIN_STARS: 4
- TRAIL_ATR_BASE: 1.5
- REOPEN_GUARD_HOURS: 4
- reqVolMultiplier: 1.3
- minADX: 25
- KRONOS_MODE: blend
- MAX_POSITIONS: 4
- PORTFOLIO_KILL_DD_PCT: 5%

## Gevraagde output (ALLEEN JSON, geen markdown, geen uitleg erbuiten):

{
  "summary": "2-3 zinnen samenvatting van de botprestaties",
  "issues": ["issue 1", "issue 2"],
  "recommendations": [
    {
      "parameter": "PARAMETER_NAAM",
      "currentValue": "huidige waarde",
      "suggestedValue": "aanbevolen waarde",
      "reason": "korte uitleg waarom",
      "priority": "high|medium|low"
    }
  ],
  "positives": ["wat werkt goed"],
  "analyzedAt": "${new Date().toISOString()}",
  "tradesAnalyzed": ${trades.length}
}`;

      // Stuur naar Claude API
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model:      'claude-sonnet-4-20250514',
          max_tokens: 1500,
          messages:   [{ role: 'user', content: prompt }],
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`Claude API error: ${response.status} ${err}`);
      }

      const data = await response.json();
      const text = data.content?.find(b => b.type === 'text')?.text || '';

      // Parse JSON response
      let analysis;
      try {
        const clean = text.replace(/```json|```/g, '').trim();
        analysis = JSON.parse(clean);
      } catch {
        // Fallback: sla ruwe tekst op
        analysis = { summary: text, recommendations: [], analyzedAt: new Date().toISOString(), tradesAnalyzed: trades.length };
      }

      // Sla op in Redis (TTL 7 dagen)
      await redis.set(REDIS_RECOMMENDATIONS_KEY, analysis);

      return res.status(200).json({ ok: true, analysis });

    } catch (e) {
      console.error('[claude-analyzer]', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
