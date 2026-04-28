#!/usr/bin/env node
// ═══ DefendDark Public Scan ═══
//
// Scans DefendDark's public outlets (Twitter/X via Nitter/RSSHub, Reddit, YouTube)
// and forwards new posts to merlin-dashboard ingest endpoint (same Redis store
// the Discord monitor would use). Runs as GitHub Actions cron — 100% cloud-side,
// zero account risk.
//
// Required env:
//   INGEST_URL          https://merlin-dashboard.vercel.app/api/kronos?action=defenddark_ingest
//   INGEST_TOKEN        must match DEFENDDARK_INGEST_TOKEN on Vercel
//
// Sources tried (in order, first that works wins per source-type):
//   X / Twitter:  rsshub.app/twitter/user/defenddark, nitter.net/defenddark/rss
//   Reddit:       reddit.com/search.json?q=defenddark
//   YouTube:      best-effort channel feed if DEFENDDARK_YT_CHANNEL_ID set

const INGEST_URL   = process.env.INGEST_URL || 'https://merlin-dashboard.vercel.app/api/kronos?action=defenddark_ingest';
const INGEST_TOKEN = process.env.INGEST_TOKEN || '';
const YT_CHANNEL   = process.env.DEFENDDARK_YT_CHANNEL_ID || '';
const TWITTER_HANDLE = process.env.DEFENDDARK_TWITTER || 'defenddark';
const LOOKBACK_HOURS = parseInt(process.env.LOOKBACK_HOURS || '6', 10);

if (!INGEST_TOKEN) { console.error('FATAL: INGEST_TOKEN missing'); process.exit(1); }

const cutoff = Date.now() - LOOKBACK_HOURS * 3600 * 1000;

// ─── Tiny utils ───────────────────────────────────────────────────────────
async function safeFetch(url, opts = {}, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal, headers: { 'User-Agent': 'merlin-dashboard-public-scan/1.0', ...(opts.headers||{}) } });
    return r;
  } finally { clearTimeout(t); }
}

function stripHtml(s='') { return s.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim(); }

// extract <item>...</item> blocks from RSS
function parseRssItems(xml) {
  const items = [];
  const re = /<item[\s\S]*?<\/item>/gi;
  const blocks = xml.match(re) || [];
  for (const b of blocks) {
    const get = (tag) => {
      const m = b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
      if (!m) return '';
      let v = m[1];
      const cdata = v.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
      if (cdata) v = cdata[1];
      return v.trim();
    };
    items.push({
      guid: get('guid') || get('link'),
      title: stripHtml(get('title')),
      desc: stripHtml(get('description')),
      link: get('link'),
      pubDate: get('pubDate'),
    });
  }
  return items;
}

// extract <entry>...</entry> from Atom (YouTube)
function parseAtomEntries(xml) {
  const items = [];
  const re = /<entry[\s\S]*?<\/entry>/gi;
  const blocks = xml.match(re) || [];
  for (const b of blocks) {
    const get = (tag) => {
      const m = b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
      return m ? stripHtml(m[1]) : '';
    };
    const linkMatch = b.match(/<link[^>]*href="([^"]+)"/i);
    items.push({
      guid: get('id'),
      title: get('title'),
      desc: get('media:description') || '',
      link: linkMatch ? linkMatch[1] : '',
      pubDate: get('published') || get('updated'),
    });
  }
  return items;
}

// ─── Source: Twitter/X (via RSSHub or Nitter) ────────────────────────────
async function fetchTwitter() {
  const sources = [
    `https://rsshub.app/twitter/user/${TWITTER_HANDLE}`,
    `https://nitter.privacydev.net/${TWITTER_HANDLE}/rss`,
    `https://nitter.net/${TWITTER_HANDLE}/rss`,
  ];
  for (const url of sources) {
    try {
      console.log(`[twitter] try ${url}`);
      const r = await safeFetch(url);
      if (!r.ok) { console.log(`[twitter]   HTTP ${r.status}`); continue; }
      const xml = await r.text();
      const items = parseRssItems(xml);
      if (items.length) { console.log(`[twitter]   ✓ ${items.length} items from ${url}`); return items.map(it => ({ ...it, source: 'twitter' })); }
    } catch (e) { console.log(`[twitter]   err ${e.message}`); }
  }
  console.log('[twitter] no source worked');
  return [];
}

// ─── Source: Reddit ──────────────────────────────────────────────────────
async function fetchReddit() {
  // Reddit blocks GitHub Actions IPs on www.reddit.com → use old.reddit.com RSS instead
  const sources = [
    `https://old.reddit.com/search.rss?q=${encodeURIComponent(TWITTER_HANDLE + ' OR DefendDark')}&sort=new&t=week`,
    `https://www.reddit.com/search.json?q=${encodeURIComponent(TWITTER_HANDLE + ' OR DefendDark')}&sort=new&t=week&limit=25`,
  ];
  for (const url of sources) {
    try {
      console.log(`[reddit] try ${url.split('?')[0]}`);
      const r = await safeFetch(url, { headers: { 'Accept': url.includes('.rss') ? 'application/rss+xml' : 'application/json' } });
      if (!r.ok) { console.log(`[reddit]   HTTP ${r.status}`); continue; }
      if (url.includes('.rss')) {
        const xml = await r.text();
        const items = parseRssItems(xml);
        if (items.length) { console.log(`[reddit]   ✓ ${items.length} via RSS`); return items.map(it => ({ ...it, source: 'reddit' })); }
      } else {
        const j = await r.json();
        const posts = (j.data?.children || []).map(c => c.data).filter(Boolean);
        if (posts.length) {
          console.log(`[reddit]   ✓ ${posts.length} via JSON`);
          return posts.map(p => ({
            guid: 'reddit:' + p.id,
            title: stripHtml(p.title || ''),
            desc: stripHtml((p.selftext || '').slice(0, 1500)),
            link: 'https://reddit.com' + (p.permalink || ''),
            pubDate: new Date((p.created_utc || 0) * 1000).toISOString(),
            source: 'reddit',
          }));
        }
      }
    } catch (e) { console.log(`[reddit]   err ${e.message}`); }
  }
  console.log('[reddit] no source worked');
  return [];
}

// ─── Source: YouTube ─────────────────────────────────────────────────────
async function fetchYouTube() {
  if (!YT_CHANNEL) return [];
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${YT_CHANNEL}`;
  try {
    const r = await safeFetch(url);
    if (!r.ok) { console.log(`[yt] HTTP ${r.status}`); return []; }
    const xml = await r.text();
    return parseAtomEntries(xml).map(it => ({ ...it, source: 'youtube' }));
  } catch (e) { console.log('[yt] err', e.message); return []; }
}

// ─── Ingest ──────────────────────────────────────────────────────────────
async function ingest(item) {
  const ts = item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString();
  if (new Date(ts).getTime() < cutoff) return { skipped: 'too-old' };
  const id = `public:${item.source}:${(item.guid || item.link || item.title).replace(/[^a-z0-9]/gi, '').slice(0, 40)}`;
  const content = [item.title, item.desc].filter(Boolean).join('\n\n').slice(0, 4000);
  if (!content.trim()) return { skipped: 'empty' };
  const payload = {
    message: {
      id,
      channelId: 'public-scan',
      channelName: item.source,
      author: 'defenddark',
      content,
      attachments: item.link ? [{ url: item.link, name: 'source-link', contentType: 'text/html' }] : [],
      ts,
    },
  };
  const r = await safeFetch(INGEST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-ingest-token': INGEST_TOKEN },
    body: JSON.stringify(payload),
  });
  if (!r.ok) return { error: `HTTP ${r.status}` };
  return { ok: true, id };
}

(async () => {
  const all = [
    ...(await fetchTwitter()),
    ...(await fetchReddit()),
    ...(await fetchYouTube()),
  ];
  console.log(`[scan] ${all.length} total candidates`);
  let ok = 0, skip = 0, err = 0;
  for (const it of all) {
    const r = await ingest(it);
    if (r.ok)        { ok++; }
    else if (r.skipped) { skip++; }
    else             { err++; console.log(`[ingest] err ${it.source} ${r.error}`); }
  }
  console.log(`[scan] done · ingested=${ok} skipped=${skip} errors=${err}`);
  process.exit(err > 0 && ok === 0 ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
