# Tick-Worker Setup — ms-latency 24/7 zonder browser

Deze worker draait 24/7 als always-on Node.js proces, subscribeert op Binance
@trade WebSocket voor alle open posities, en triggert binnen ~150-300ms
(typisch warm) de Vercel close-engine wanneer een tick een stop/target raakt.

## Architectuur

```
Binance @trade WS  ──tick──>  worker (Railway/Fly)  ──HTTP──>  /api/kronos?action=run&tick=1
                                                         └─>  /api/paper-engine?action=tick

Polling /api/portfolio-state elke 10s om open-positie cache te refreshen.
```

## Latency budget

| stap                     | typ. tijd  |
|--------------------------|-----------:|
| Binance match → WS push  | 30-80 ms   |
| WS receive → check       | < 1 ms     |
| HTTP → Vercel (warm)     | 50-150 ms  |
| Vercel close + Redis     | 50-100 ms  |
| **Totaal warm**          | **~200ms** |
| HTTP → Vercel (cold)     | 1-3 s      |
| **Totaal cold**          | **~1.5-3.5s** |

Cold-start kun je beperken door Vercel function pre-warm cron (elke 4 min ping).

---

## Optie A: Fly.io (aanbevolen — gratis tier voor 1 worker)

1. Install fly CLI: `curl -L https://fly.io/install.sh | sh`
2. Login: `fly auth login` (of `fly auth signup` voor nieuwe account — vraagt CC,
   gratis tier reserveert $0)
3. Vanuit `/workers` folder:
   ```bash
   cd workers
   fly launch --copy-config --no-deploy
   # Wijzig app-naam in fly.toml als 'merlin-tick-worker' al bezet is
   ```
4. Set API_BASE secret:
   ```bash
   fly secrets set API_BASE=https://merlin-signal-dashboard.vercel.app
   # Pas URL aan naar jouw Vercel deployment
   ```
5. Deploy:
   ```bash
   fly deploy
   ```
6. Check logs:
   ```bash
   fly logs
   ```
7. Health check:
   ```bash
   curl https://merlin-tick-worker.fly.dev/health
   ```

**Free tier**: 3x shared-cpu-1x VM, 256MB RAM. Dit project heeft 1 nodig.
**Auto-stop**: STAAT UIT (`auto_stop_machines = false`) → blijft 24/7 draaien.

---

## Optie B: Railway

1. Maak account op railway.app (GitHub login).
2. New Project → Deploy from GitHub → kies merlin-signal-dashboard repo.
3. **Root Directory** → set op `workers` (anders gaat hij Vercel api/* deployen).
4. Settings → Variables:
   - `API_BASE` = `https://merlin-signal-dashboard.vercel.app`
   - (overige defaults zijn fine)
5. Deploy gaat automatisch.
6. Health check: Settings → Networking → Generate Domain → `https://xxx.up.railway.app/health`

**Pricing**: $5 trial credit, daarna $5/mo Hobby plan voor always-on. Dit
project verbruikt ~$2-3/mo aan resources.

---

## Optie C: Render.com

⚠️ Render free tier slaapt na 15 min inactiviteit → NIET geschikt voor
permanente WebSocket. Alleen voor bestaande betaalde abonnementen.

---

## Optie D: VPS (Hetzner CX11 €3.79/mo)

1. SSH naar VPS, install Node 20:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
   apt install -y nodejs
   ```
2. Clone repo & start worker:
   ```bash
   git clone https://github.com/soflabs/merlin-signal-dashboard.git
   cd merlin-signal-dashboard/workers
   npm install
   API_BASE=https://merlin-signal-dashboard.vercel.app node tick-worker.js
   ```
3. Maak een systemd service voor auto-restart:
   ```ini
   # /etc/systemd/system/merlin-worker.service
   [Unit]
   Description=Merlin tick worker
   After=network.target

   [Service]
   Type=simple
   User=root
   WorkingDirectory=/root/merlin-signal-dashboard/workers
   Environment=API_BASE=https://merlin-signal-dashboard.vercel.app
   ExecStart=/usr/bin/node tick-worker.js
   Restart=always
   RestartSec=5

   [Install]
   WantedBy=multi-user.target
   ```
   ```bash
   systemctl enable --now merlin-worker
   journalctl -u merlin-worker -f
   ```

---

## Validatie na deploy

1. Open een test-positie (bv. handmatig via paper-trading dashboard).
2. Wacht tot een prijs een stop/target raakt OF zet een testreden stop tegen
   markt aan (bv. open SHORT BTC met stop $100 → instant trigger op next tick).
3. Check worker logs:
   ```
   [I] 🎯 BREACH BTC SHORT stop@100.00 tick=79123.45
   [I] → paper_kronos HTTP 200 (143ms) BTC SHORT stop@100.00
   ```
4. Check Vercel logs (kronos.js / paper-engine.js): position closed.
5. Check dashboard: positie verdwenen, trade-log toont close.

---

## Tuning

| ENV                    | default | wat het doet                                       |
|------------------------|--------:|----------------------------------------------------|
| `POLL_INTERVAL_MS`     | 10000   | Hoe vaak open-pos cache refreshen via portfolio-state |
| `TRIGGER_COOLDOWN_MS`  | 1500    | Min tijd tussen 2 triggers per bot (debounce)      |
| `LOG_LEVEL`            | info    | `quiet` / `info` / `debug`                         |
| `PORT`                 | 3000    | Health endpoint port                               |

**Tip**: bij meerdere workers (HA setup) → laat de Vercel-side throttle (1 sec
TTL via Redis SETNX) z'n werk doen, dubbele triggers worden automatisch
weggegooid. Geen extra coordinatie nodig.

---

## Wat als worker offline is?

- Dashboard browser-tab valt terug op z'n eigen tick-trigger (sub-second).
- GitHub Actions cron blijft elke X min /api/kronos?action=run pingen.
- Server-side wick detection scant 4h + 1m candles → max gemiste latency = 1m.

De worker is dus een **performance booster**, geen single point of failure.
