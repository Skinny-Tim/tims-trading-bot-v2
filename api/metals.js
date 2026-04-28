const { execSync } = require('child_process');

const INTERVAL_MAP = { '1M': '1mo', '1w': '1wk', '4h': '1d', '1d': '1d' };
const RANGE_MAP = { '1mo': '20y', '1wk': '10y', '1d': '2y' };

// Simple in-memory cache (persists within same serverless instance)
const cache = {};
const CACHE_TTL = 15 * 60 * 1000;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  const { symbol = 'SI=F', interval = '1M', limit = '100' } = req.query;
  const yInterval = INTERVAL_MAP[interval] || interval;
  const range = RANGE_MAP[yInterval] || '10y';
  const cacheKey = `${symbol}_${yInterval}`;

  // Return cached data if fresh
  if (cache[cacheKey] && (Date.now() - cache[cacheKey].ts) < CACHE_TTL) {
    const klines = cache[cacheKey].data;
    const limited = parseInt(limit) ? klines.slice(-parseInt(limit)) : klines;
    return res.status(200).json(limited);
  }

  try {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${yInterval}&range=${range}`;
    const raw = execSync(`curl -s "${url}" -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"`, {
      timeout: 15000,
      encoding: 'utf8'
    });

    if (raw.startsWith('Too Many')) {
      return res.status(429).json({ error: 'Rate limited by Yahoo Finance' });
    }

    const json = JSON.parse(raw);
    if (!json.chart || !json.chart.result || json.chart.result.length === 0) {
      return res.status(404).json({ error: 'No data' });
    }

    const result = json.chart.result[0];
    const timestamps = result.timestamp || [];
    const quote = result.indicators.quote[0];
    const klines = [];
    for (let i = 0; i < timestamps.length; i++) {
      const o = quote.open[i], h = quote.high[i], l = quote.low[i], c = quote.close[i];
      if (o != null && h != null && l != null && c != null) {
        klines.push({ time: timestamps[i] * 1000, open: o, high: h, low: l, close: c, volume: quote.volume[i] || 0 });
      }
    }

    cache[cacheKey] = { data: klines, ts: Date.now() };
    const limited = parseInt(limit) ? klines.slice(-parseInt(limit)) : klines;
    res.status(200).json(limited);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
