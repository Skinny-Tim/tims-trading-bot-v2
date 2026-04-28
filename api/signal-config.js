/**
 * /api/signal-config — Serveert de huidige signaal parameters
 * Wordt gelezen door index.html (fetch) en signals-cron.js (require)
 * Wordt geschreven door backtest-agent.js via GitHub API
 */
const fs = require('fs');
const path = require('path');

module.exports = (req, res) => {
  try {
    const configPath = path.join(__dirname, '..', 'signal-params.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).json(config);
  } catch (e) {
    console.error('[signal-config] Error:', e.message);
    return res.status(500).json({ error: 'Config niet beschikbaar' });
  }
};
