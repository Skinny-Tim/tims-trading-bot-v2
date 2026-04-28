# Live Trading Setup — Merlijn (spot) + Kronos (futures)

**Doel**: van paper → testnet → mainnet zonder dat je per ongeluk live geld gebruikt.

⚠️ **Alles is by-default PAPER.** Live mode vereist expliciete env-vars + double-confirm voor mainnet.

---

## 1. Architectuur in 1 plaatje

```
signal-cron (Merlijn 4H signals)
        │
        ▼
  paper-engine.js ──────┐
                        │           ┌──────────────────────┐
                        ├──► execution.js (router) ──► PAPER (sim) of LIVE (Binance)
                        │                                    │
  kronos.js (signals) ──┤                                    ├─ binance-spot.js (Merlijn)
                        │                                    └─ binance-futures.js (Kronos)
                        │
                        ▼
                 kill-switch.js  ←───  /api/kill-switch (Pause/Panic/Resume)
                        │
                        ▼
                 telegram.js  ───► alle alerts (open/close/drift/panic)
                        │
                        ▼
                 reconcile.js  ←──  cron 5-min: bot ↔ exchange drift detectie
```

**Per-bot toggle**: Merlijn en Kronos zijn onafhankelijk paper/live schakelbaar.

---

## 2. Env-vars (compleet overzicht)

### A. Telegram (verplicht voor live)

| Var | Doel | Voorbeeld |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | bot-token van @BotFather | `123456:AAH...` |
| `TELEGRAM_CHAT_ID` | jouw chat id (start bot, dan `getUpdates`) | `987654321` |
| `TELEGRAM_THROTTLE_SEC` | dedupe-window (default 60s) | `60` |

**Bot setup** (eenmalig):
1. Telegram → `@BotFather` → `/newbot` → naam + username → kopieer token
2. Open een chat met je nieuwe bot, stuur `/start`
3. `curl https://api.telegram.org/bot<TOKEN>/getUpdates` → kopieer `chat.id` uit JSON
4. Test: `curl -X POST 'https://your-app/api/telegram-test'` (voeg endpoint toe of gebruik `node -e "require('./api/_lib/telegram').alertTest()"`)

### B. Kill-switch (verplicht voor live)

| Var | Doel |
|---|---|
| `KILL_SWITCH_TOKEN` | Bearer-token voor pause/panic/resume actions |

Zet een sterke random string (`openssl rand -hex 32`). Bewaar veilig — wie deze token heeft kan ALLE posities sluiten.

### C. Merlijn (Spot)

| Var | Default | Doel |
|---|---|---|
| `MERLIJN_LIVE_NETWORK` | `paper` | `paper`, `testnet`, of `mainnet` |
| `BINANCE_SPOT_NETWORK` | `testnet` | overschrijft adapter base-URL |
| `BINANCE_SPOT_API_KEY` | — | API key (testnet: testnet.binance.vision) |
| `BINANCE_SPOT_API_SECRET` | — | API secret |
| `BINANCE_SPOT_RECV_WINDOW_MS` | `5000` | timestamp-tolerance |

### D. Kronos (Futures)

| Var | Default | Doel |
|---|---|---|
| `KRONOS_LIVE_NETWORK` | `paper` | `paper`/`testnet`/`mainnet` |
| `BINANCE_FUT_NETWORK` | `testnet` | adapter base-URL |
| `BINANCE_FUT_API_KEY` | — | testnet: testnet.binancefuture.com |
| `BINANCE_FUT_API_SECRET` | — | |
| `BINANCE_FUT_LEVERAGE` | `3` | default leverage (max 5 hardcap aanbevolen) |
| `BINANCE_FUT_MARGIN_TYPE` | `ISOLATED` | `ISOLATED` of `CROSSED` |

### E. Mainnet double-gate (verplicht voor mainnet)

```
LIVE_MAINNET_CONFIRM=YES_I_UNDERSTAND
```

Zonder deze exacte string blijft de execution-layer in paper mode, ook als `*_LIVE_NETWORK=mainnet`. Dit is een tweede vangrail.

### F. Reconciliation tolerances (optioneel)

| Var | Default | Doel |
|---|---|---|
| `RECONCILE_QTY_TOLERANCE_PCT` | `2` | qty-drift threshold |
| `RECONCILE_BALANCE_TOLERANCE_PCT` | `5` | balance-drift threshold |

---

## 3. Setup checklist (paper → testnet → mainnet)

### Stap 1: Paper draait stabiel
- [ ] `npm run dev` of Vercel deploy
- [ ] `/api/paper-engine` cron draait (GitHub Actions / Vercel cron)
- [ ] `/api/kronos?action=run` cron draait
- [ ] Posities openen/sluiten in dashboard zichtbaar
- [ ] Telegram test-alert ontvangen

### Stap 2: Testnet (Merlijn spot)
1. Maak testnet account: https://testnet.binance.vision/ (login met GitHub)
2. Genereer API key (Spot trading enabled, GEEN withdrawals)
3. Set env vars:
   ```
   MERLIJN_LIVE_NETWORK=testnet
   BINANCE_SPOT_NETWORK=testnet
   BINANCE_SPOT_API_KEY=...
   BINANCE_SPOT_API_SECRET=...
   ```
4. Deploy → check dashboard kill-switch panel: badge moet "Merlijn: LIVE (TESTNET)" tonen
5. Wacht op signaal of trigger handmatig via `/api/paper-engine`
6. Verify in Telegram: "Merlijn order placed BUY BTC ..."
7. Verify op testnet UI: order verschijnt
8. Reconcile-check: `curl /api/reconcile?bot=merlijn` → drifts moet leeg zijn

### Stap 3: Testnet (Kronos futures)
1. Maak futures testnet account: https://testnet.binancefuture.com/
2. API key (Futures trading enabled)
3. Env:
   ```
   KRONOS_LIVE_NETWORK=testnet
   BINANCE_FUT_NETWORK=testnet
   BINANCE_FUT_API_KEY=...
   BINANCE_FUT_API_SECRET=...
   BINANCE_FUT_LEVERAGE=3
   BINANCE_FUT_MARGIN_TYPE=ISOLATED
   ```
4. Deploy → badge "Kronos: LIVE (TESTNET)"
5. Trigger run: `curl /api/kronos?action=run`
6. Verify Telegram + futures testnet UI
7. Test panic: dashboard → token invullen → PANIC CLOSE (scope=kronos) → check beide UI's

### Stap 4: Mainnet (na 1+ week stabiele testnet)
**Pre-flight checklist** (alles JA voor mainnet-go):
- [ ] Telegram alerts werken (test alle 6 severity-levels)
- [ ] Kill-switch panic werkt (testnet) — closed alle posities, drift=0 na execute
- [ ] Reconcile cron heeft 0 drifts gevonden over 24h+
- [ ] Daily P&L op testnet matcht paper-sim binnen ±10% (track 1 week)
- [ ] Risico-caps in `portfolio.js` correct (max 5% balance per trade)
- [ ] IP whitelist actief op exchange API keys (zie §5)
- [ ] `KRONOS_DAILY_DD_PCT=10` of lager (kill bij 10% daily drawdown)
- [ ] `LIVE_MAINNET_CONFIRM=YES_I_UNDERSTAND` gezet

Mainnet flip:
1. Maak mainnet API keys (LIMITED scope: trade enabled, withdraw DISABLED, IP whitelist)
2. Set env:
   ```
   LIVE_MAINNET_CONFIRM=YES_I_UNDERSTAND
   MERLIJN_LIVE_NETWORK=mainnet
   BINANCE_SPOT_NETWORK=mainnet
   KRONOS_LIVE_NETWORK=mainnet
   BINANCE_FUT_NETWORK=mainnet
   ```
3. Deploy MET KLEINE START-BALANCE (€100-€500) — eerste week
4. Watch dashboard kill-switch panel: badges rood = mainnet
5. Alle alerts dubbel-checken in Telegram

---

## 4. Crons (Vercel of GitHub Actions)

Voeg deze toe aan `vercel.json` of GitHub Actions:

```json
{
  "crons": [
    { "path": "/api/paper-engine", "schedule": "*/5 * * * *" },
    { "path": "/api/kronos?action=run", "schedule": "*/15 * * * *" },
    { "path": "/api/reconcile", "schedule": "*/5 * * * *" },
    { "path": "/api/portfolio-state?action=daily-report", "schedule": "0 22 * * *" }
  ]
}
```

`/api/reconcile` mag publiek (read-only). Andere endpoints moeten `CRON_SECRET` of `PAPER_ENGINE_SECRET` Bearer header hebben.

---

## 5. Security hardening

### A. Exchange API keys
- **Withdrawals UIT** (altijd, geen uitzonderingen)
- **IP whitelist AAN** — wit Vercel egress IPs of jouw VPS IP
  - Vercel egress: zie [Vercel docs](https://vercel.com/docs/edge-network/regions) of gebruik vaste outbound IP via Fly/Railway als je vaste IP nodig hebt
  - Aanbevolen: deploy op VPS (Fly.io, Hetzner, DigitalOcean) ipv Vercel zodra mainnet → vaste IP
- **Sub-account** per bot indien mogelijk (Binance ondersteunt dit) — Merlijn en Kronos gescheiden funds
- **Rotate keys** elke 90 dagen

### B. Server-side secrets
- Gebruik Vercel Environment Variables (encrypted at rest) of `.env` met `chmod 600`
- NIET committen: `.env`, `secrets.json`, alle `*_API_KEY` waarden
- `.gitignore` check: `.env*` moet uitgesloten zijn

### C. Kill-switch token
- Random 32-byte hex (`openssl rand -hex 32`)
- Bewaar in password manager + sessionStorage van browser (vergrendel scherm)
- Rotate na elke "panic" actie

### D. Webhook + Telegram
- Telegram chat liefst privé chat (jij + bot)
- Bot token heeft alleen send-message rechten
- Webhook signature verification voor cron endpoints (`CRON_SECRET`)

### E. Monitoring
- Reconcile alert binnen 5 min van drift
- Daily summary om 22:00 UTC
- Heartbeat cron (`/api/health` → ping om 5 min) → telegram alert als down

---

## 6. Disaster recovery

### Drift gedetecteerd
1. Check Telegram alert details
2. Open dashboard → kill-switch panel → status
3. Beslis:
   - **Bot heeft positie open, exchange niet** = order is gemist of stop is geraakt → markeer in Redis als gesloten via reconcile
   - **Exchange heeft positie, bot niet** = manual order door jou OF geblokkeerde sync → bekijk audit trail, sluit handmatig op exchange of importeer in Redis
   - **Qty/side mismatch** = partial fill of partial close mislukt → kill-switch PANIC scope=`<bot>` om alles terug naar 0 te brengen

### Exchange API down
- Telegram alert: "Merlijn entry FAILED: timeout"
- Bot blijft in paper-mode voor die ene trade (positie wordt NIET geopend in state)
- Geen actie nodig — wacht tot exchange terug is

### Bot crash mid-trade
- Live order is geplaatst maar Redis state is stuk
- Reconcile detecteert dit binnen 5 min → drift alert
- Manueel: load Redis snapshot of importeer position uit exchange via reconcile-helper (TODO Item 6)

### Mainnet account compromise
1. Direct: dashboard → PANIC CLOSE (all)
2. Direct: Binance UI → revoke API key
3. Telegram bericht aan jezelf: "key compromised"
4. Genereer nieuwe key + IP whitelist → re-deploy

---

## 7. Test scripts

Test Telegram:
```bash
node -e "require('./api/_lib/telegram').alertTest().then(r => console.log(r))"
```

Test kill-switch (geen auth, status only):
```bash
curl https://your-app/api/kill-switch
```

Test panic (DRY RUN — gebruik scope=merlijn op paper):
```bash
curl -X POST -H "Authorization: Bearer $KILL_SWITCH_TOKEN" \
  "https://your-app/api/kill-switch?action=panic&bot=merlijn&reason=test_drill"
```

Test reconcile:
```bash
curl https://your-app/api/reconcile
```

Test live mode badge endpoint:
```bash
curl "https://your-app/api/portfolio-state?include=mode" | jq .modeStatus
```

---

## 8. Verboden / disabled features

- **Withdrawals**: code stuurt nooit withdraw-orders. API keys mogen ook geen withdraw scope hebben.
- **Cross-margin**: futures default = ISOLATED. Cross alleen na expliciete env-flip.
- **Shorts op spot**: blocked in `execution.js` (`SHORTS_ENABLED` voor Bitvavo legacy).
- **Leverage > 5**: hardcap aanbevolen — pas `binance-futures.js` `ensureLeverage` aan met clamp.
- **Auto-resume kill-switch**: na panic blijft systeem geblokkeerd tot manual `resume` action via dashboard. Geen auto-reset.

---

**Last updated**: 2026-04-22 — initial live-trading buildout (Merlijn spot + Kronos futures, Telegram alerts, kill-switch, reconcile).
