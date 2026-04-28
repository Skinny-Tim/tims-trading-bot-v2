# Emergency Runbook — Merlijn + Kronos Live Trading

**Doel**: weet wat te doen vóór het misgaat. Lees vóór go-live. Open opnieuw bij elk incident.

> **Setup-instructies → [LIVE_TRADING.md](LIVE_TRADING.md). Dit document is voor incidenten.**

---

## 0. PANIC CHECKLIST — lees eerst bij vermoeden problemen

| Wat zie je? | Eerste actie | Tijd |
|---|---|---|
| Vermoeden van fund-verlies | **PANIC CLOSE ALL** op `/live` of `curl -X POST -H "Authorization: Bearer $TOKEN" '<base>/api/kill-switch?action=panic&scope=all&reason=manual'` | <30s |
| Bot doet rare dingen, geen acuut verlies | **PAUSE** op `/trading` (kill-switch panel) — blokkeert nieuwe opens, laat bestaande staan | <30s |
| Gewoon wantrouwen / ongerust | Check `/live` dashboard eerst, dan beslissen | 1m |
| Drift-alert in Telegram | Zie §5 Drift response | 5m |
| Alerts vanuit GH Actions cron faalt | Zie §6 Cron failures | 5m |
| Vercel deploy stuk | Zie §7 Deploy failure | 10m |

**Telefoon-nummer voor escalatie / KILL_SWITCH_TOKEN-houder**: vul in tijdens go-live setup.

---

## 1. URLs + endpoints (cheat-sheet)

Productie-base: `https://merlijn.camelotlabs.be`

| URL | Wat | Auth |
|---|---|---|
| `/trading` | Paper + live mode toggle, kill-switch panel, recente trades | nee (read) |
| `/live` | Live dashboard (real Binance state) + shakedown panel | nee (read) |
| `/api/live-state` | Spot balances + futures positions JSON | nee |
| `/api/portfolio-state?include=mode` | Bot mode + network per bot | nee |
| `/api/kill-switch` | Status (GET) of pause/panic/resume (POST + auth) | POST = Bearer |
| `/api/kill-switch?action=panic-dryrun` | Preview: wat zou panic NU sluiten? | nee |
| `/api/shakedown` | End-to-end pre-live readiness check | nee |
| `/api/shakedown?writeTest=1&token=X` | + tiny LIMIT order op testnet (alleen testnet) | token |
| `/api/reconcile` | Trigger reconciliation nu | nee |
| `/api/reconcile?inject=test&token=X` | Forceer synthetic drift-alert via Telegram | token |
| `/api/recover` | List snapshots | nee |
| `/api/recover?action=restore&snapshot=ID` | Roll back state | token |
| `/api/audit` | Vandaag's trade audit | nee |

---

## 2. Pre-flight checklist — vóór mainnet

**Doe dit minimum 24u vóór go-live, en doe daarna een tweede ronde 1u vóór go-live.**

- [ ] `/api/shakedown` → alle checks `pass` of `warn` (geen `fail`)
- [ ] `/api/shakedown?writeTest=1&token=X` op testnet → ✓ write-test pass + ✓ Telegram test ontvangen
- [ ] `/api/kill-switch?action=panic-dryrun` → `closePositionByForceExported: true` voor beide bots
- [ ] `/api/reconcile?inject=test&token=X` → Telegram drift-alert ontvangen
- [ ] GH Actions runs zichtbaar voor laatste 24u: `signals-cron`, `kronos-signals-cron`, `paper-engine-cron`, `reconcile-cron`
- [ ] Telegram bot reageert op `/start` (verifieert token werkt buiten cron)
- [ ] `BINANCE_*_NETWORK` matcht `MERLIJN_LIVE_NETWORK` / `KRONOS_LIVE_NETWORK` (zie §4)
- [ ] `LIVE_MAINNET_CONFIRM=YES_I_UNDERSTAND` ALLEEN gezet als je écht klaar bent
- [ ] `KILL_SWITCH_TOKEN` ≥ 16 chars, opgeslagen in password manager
- [ ] Operator weet waar deze runbook staat (bookmark + offline kopie)

---

## 3. Symptoom → diagnose → actie

### 3.1 "Bot opende een trade die ik niet verwacht had"

1. Open `/api/audit?action=signals&bot=paper_4h&hours=24` → zoek het signaal dat triggerde
2. Open `/live` → check actuele positie (token, side, qty, entry, mark)
3. Beslis:
   - **Trade is binnen risk-budget en signaal is geldig** → laat staan, monitor
   - **Trade is fout (drift / bug)** → kies:
     - Alleen die positie sluiten → manual close op exchange (Binance UI)
     - Alle posities sluiten → PANIC CLOSE ALL
     - Bot helemaal stoppen → PAUSE (laat positie staan, blokkeer nieuwe opens)

### 3.2 "Bot stopt met traden"

1. `/api/kill-switch` → `active: true`? → bot is gepauzeerd. Wie? Reden? Resume met `?action=resume`
2. `/api/portfolio-state?include=mode` → bot mode is `paper`? → live mode is gevallen, check env vars (zie §4)
3. `/api/audit` → laatste signal-cron run timestamp normaal? Zo nee → zie §6
4. Check GH Actions → cron failures? → zie §6

### 3.3 "Drift-alert in Telegram"

Zie §5.

### 3.4 "Telegram alerts stoppen"

1. `curl '<base>/api/kill-switch?action=telegram-test'` (vereist token via Bearer)
   - `apiResp.status: 200` → Telegram werkt, throttle is mogelijk schuld
   - `apiResp.status: 401` → token is verkeerd / ingetrokken
   - `apiResp.status: 400 + "chat not found"` → CHAT_ID is verkeerd
2. Als token of chat_id stuk: nieuwe maken op Telegram, env update op Vercel, redeploy
3. Throttle: telegram.js heeft per-key throttle (default 5min) — als alert key te vaak fired, wordt geslikt. Wacht 5min.

### 3.5 "Vercel response 500 / endpoint kapot"

1. Check Vercel dashboard → Functions → Logs voor de URL
2. Common: `MODULE_NOT_FOUND` → ontbrekende dependency in `package.json` of typo in require
3. Common: `timeout` → 60s limiet bereikt → mogelijk Binance traag, retry over 1m
4. Als persistent: rollback naar vorige deploy via Vercel dashboard (Deployments → vorige → Promote)

---

## 4. Env-var consistency — meest gemaakte misconfig

Een fail-mode die geld kost: `MERLIJN_LIVE_NETWORK=mainnet` maar `BINANCE_SPOT_NETWORK=testnet`. Resultaat: execution-router denkt LIVE, adapter belt testnet endpoint, orders verdwijnen of treffen verkeerde markt.

**`/api/shakedown` checkt dit automatisch**, maar manuele check:

| Var | Toegestane waarden | Gevolg fout |
|---|---|---|
| `BINANCE_SPOT_NETWORK` | `testnet` \| `mainnet` | Adapter route |
| `BINANCE_FUT_NETWORK` | `testnet` \| `mainnet` | Adapter route |
| `MERLIJN_LIVE_NETWORK` | `off` \| `testnet` \| `mainnet` | Execution route (paper vs live) |
| `KRONOS_LIVE_NETWORK` | `off` \| `testnet` \| `mainnet` | Execution route |
| `LIVE_MAINNET_CONFIRM` | `YES_I_UNDERSTAND` | Mainnet 3-layer gate |

**Regel**: `MERLIJN_LIVE_NETWORK` moet matchen met `BINANCE_SPOT_NETWORK` (idem Kronos). En als één van beide `mainnet` is, MOET `LIVE_MAINNET_CONFIRM` set zijn — anders valt execution silently terug op paper.

**Switchen testnet → mainnet:**
1. Set `BINANCE_*_MAINNET_KEY` + `BINANCE_*_MAINNET_SECRET` op Vercel
2. Set `BINANCE_*_NETWORK=mainnet`
3. Set `MERLIJN_LIVE_NETWORK=mainnet` (en/of `KRONOS_LIVE_NETWORK=mainnet`)
4. Set `LIVE_MAINNET_CONFIRM=YES_I_UNDERSTAND`
5. Redeploy
6. `/api/shakedown` → alle network-checks pass
7. Wacht 1 cron-cycle (15 min) → reconcile groen

---

## 5. Drift response

**Drift = bot's idee van open posities ≠ exchange's idee.** Drie typen:

| Type | Wat | Eerste actie |
|---|---|---|
| `qty_mismatch` | Bot zegt 0.1 BTC open, exchange zegt 0 (of andere qty) | Check welk klopt — exchange is ground truth |
| `side_mismatch` | Bot zegt LONG, exchange zegt SHORT | **CRITICAL** — manual close op exchange direct, dan investigeren |
| `balance_drift` | USDT balans wijkt > 5% af | Check trades-history op exchange voor un-tracked fills |

**Resolutie playbook:**

1. `curl '<base>/api/reconcile?bot=merlijn'` (of kronos) → exact drift JSON
2. Check Binance UI: spot wallet (Merlijn) of futures positions (Kronos)
3. Beslis welke ground truth is. Meestal: **exchange wint**.
4. **Bot heeft meer dan exchange (phantom position)**:
   - Bot denkt dat 'ie posities heeft die er niet zijn → bot zal proberen 'm te sluiten en falen
   - Fix: `POST /api/recover?action=replay-from-exchange&bot=X` → herbouwt state vanuit exchange
5. **Exchange heeft meer dan bot (orphan position)**:
   - Onbekende positie op exchange → manual: was dit user, of order die hangend bleef?
   - Sluit handmatig op Binance, of accepteer als "user position" (bot raakt 'm niet)
6. **Side mismatch (LONG ↔ SHORT)**:
   - **STOP TRADING DIRECT**: PAUSE de bot
   - Manual close op exchange
   - Investigate signal-audit (`/api/audit?action=signals`) voor wat ging fout
   - Redeploy/replay-from-exchange voor verder gaan

**Tolerance**: default 2% qty drift, 5% balance drift. Tunable via `RECONCILE_QTY_TOLERANCE_PCT` / `RECONCILE_BALANCE_TOLERANCE_PCT` env vars — verhogen voorkomt false-positives bij rounding.

---

## 6. Cron failures (GH Actions)

GH Actions runs `*.yml` workflows in `.github/workflows/`. Failures = misschien geen alerts gegenereerd.

| Workflow | Schedule | Wat |
|---|---|---|
| `signals-cron` | Vercel cron 07:00 daily | 4H signals scan + ntfy push |
| `kronos-signals-cron` | GH Actions */15 min | Kronos AI forecast |
| `paper-engine-cron` | GH Actions */15 min | Tick paper-engine open/close logic |
| `reconcile-cron` | GH Actions */15 min | Bot ↔ exchange drift detectie |
| `health-check` | GH Actions */5 min | Smoke test on key endpoints |

**Diagnose:**
1. GitHub → Actions tab → laatste run → klik op failed step
2. Common: `HTTP 500` / `timeout` → check Vercel logs voor de geraakte endpoint
3. Common: `secret missing` → check repo Settings → Secrets, vergelijk met workflow yaml

**Fix-procedure als cron faalt:**
- 1× failure: re-run job, kijk of het persistent is
- 2× failures: alert in Telegram (via health-check) → onderzoek root-cause
- 3+ failures: pauzeer betreffende bot tot fix in productie

---

## 7. Deploy failure

1. Check `git log -3 --oneline` lokaal — wat is er recent gepusht?
2. Vercel dashboard → Deployments → laatste failed → Build Logs
3. Common: syntax error → fix lokaal, commit+push
4. Common: ontbrekende dep in `package.json` → add + commit+push
5. **Rollback** als hotfix te lang duurt:
   - Vercel dashboard → Deployments → vorige succesvolle → ⋯ → Promote to Production
   - Terwijl je rollback hebt: alle huidige bot-state blijft (Redis is persistent)

---

## 8. Recovery procedures

### 8.1 Pre-panic snapshot herstellen (na verkeerde panic)

Elke `panic` actie maakt automatisch een pre-snapshot. Als je per ongeluk panic deed:

1. `curl '<base>/api/recover'` → lijst snapshots, zoek `pre_panic_<scope>` met juiste timestamp
2. `curl -X POST -H "Authorization: Bearer $TOKEN" '<base>/api/recover?action=restore&snapshot=<id>'`
3. **Let op**: dit herstelt alleen lokale state, NIET de gesloten exchange-posities. Die zijn gone.
4. Daarna: handmatig posities heropenen op exchange als gewenst, of `replay-from-exchange` om state te resyncen

### 8.2 Redis kwijt / corrupt

Als Redis is gewist (data loss op provider):

1. Pause beide bots IMMEDIATE: `?action=pause&scope=all`
2. `POST /api/recover?action=replay-from-exchange&bot=merlijn` → herbouw Merlijn state
3. `POST /api/recover?action=replay-from-exchange&bot=kronos` → herbouw Kronos state
4. `/api/reconcile` → verifieer geen drift
5. Resume

### 8.3 Circuit breaker fired (auto-pause)

Circuit fires bij drawdown breach (default 8% daily). Indicators:
- Telegram alert "circuit breaker fired"
- `/api/kill-switch` → `active: true, reason: "PAUSE: circuit_..."`

**Wanneer NIET clearen**: als drawdown reëel was (verlies-trade), clear pas na fix. Anders gaat de bot weer doorhandelen tegen dezelfde fout.

**Wanneer wel clearen**: false-positive (bug, data-glitch). Verifieer P&L op exchange.

```
curl -X POST -H "Authorization: Bearer $TOKEN" \
  '<base>/api/kill-switch?action=clear-circuit&scope=all'
```

---

## 9. Key rotation

**Binance API keys gecompromitteerd / vermoeden lek:**

1. **DIRECT**: PANIC CLOSE ALL via `/live` (sluit posities zodat attacker geen leverage heeft)
2. Binance UI → API Management → revoke compromised key
3. Genereer nieuwe key, set IP whitelist op Vercel server-IP (zie Vercel dashboard → Settings → Functions)
4. Update Vercel env vars (`BINANCE_*_KEY`, `BINANCE_*_SECRET`)
5. Redeploy
6. `/api/shakedown` → Spot + Futures `pass`
7. Resume trading

**KILL_SWITCH_TOKEN gecompromitteerd:**

1. Genereer nieuwe random token (`openssl rand -hex 32`)
2. Update Vercel env var
3. Redeploy
4. Distribueer nieuwe token alleen via 1Password / signal / verifieerbaar kanaal

---

## 10. Escalatie + nazorg

Na elk incident (panic / drift / outage):

- [ ] Schrijf binnen 24u een 1-pager: **wat gebeurde, wat deden we, wat was effect, wat doen we voor next time**
- [ ] Scan `/api/audit` voor de incident-window — log een copy
- [ ] Update deze runbook als nieuwe symptomen / acties zijn ontdekt
- [ ] Als config-issue: `/api/shakedown` zou het in toekomst moeten vangen — adden als check

**Contact escalation chain** (vul in tijdens go-live):
1. Primary on-call: ___
2. Secondary: ___
3. Owner / final decision-maker: ___

---

## 11. Wat dit document NIET dekt

- Setup van vanaf nul → **`LIVE_TRADING.md`**
- Strategy / Elliott Wave / Kronos AI logica → **`INSTRUCTIONS.md`** + **`PROJECT_KNOWLEDGE.md`**
- EW research history → **`EW_RESEARCH_LOG.md`**

Voor architectuur-overzicht zie het diagram boven in `LIVE_TRADING.md` §1.
