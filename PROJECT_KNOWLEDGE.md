# Merlin Signal Lab — Project Knowledge

## Project Overzicht
Merlin Signal Lab is een real-time crypto & metalen trading dashboard dat technische analyse combineert met Elliott Wave theorie, swing trading signalen en een AI-gewogen predictiesysteem ("Merlin's Prediction"). Het is gebouwd als een single-page HTML5 applicatie met embedded JavaScript, gehost op Vercel.

**Live URL:** Vercel productie (merlin-signal-dashboard)
**Broncode:** `/Users/steve/Downloads/TB/merlin-dashboard/`
**Lokale server:** `dashboard-server.js` op port 3001

---

## Architectuur

### Bestanden
| Bestand | Doel |
|---------|------|
| `index.html` | Volledige dashboard (~3900 regels): CSS + HTML + JavaScript |
| `api/metals.js` | Vercel serverless proxy voor Yahoo Finance (Gold/Silver) |
| `vercel.json` | Vercel deployment configuratie |
| `INSTRUCTIONS.md` | Technische audit log en regels |

### Data Bronnen
| Bron | Gebruik | Auth |
|------|---------|------|
| Binance REST API | Kline data (4H, 1M, 1W) voor crypto | Geen |
| Binance WebSocket | Real-time ticker voor live prijzen | Geen |
| Yahoo Finance (via `/api/metals`) | Gold (PAXG) en Silver (SI=F) candle data | Geen |
| Alternative.me API | Fear & Greed Index (31 dagen) | Geen |

### Tokens
```javascript
const symbols = [
  { name: 'BTCUSDT',  short: 'BTC',  source: 'binance' },
  { name: 'HBARUSDT', short: 'HBAR', source: 'binance' },
  { name: 'XRPUSDT',  short: 'XRP',  source: 'binance' },
  { name: 'PAXGUSDT', short: 'XAU',  source: 'binance', yahoo: null, label: 'Gold (PAXG)' },
  { name: 'XAGUSD',   short: 'XAG',  source: 'metals', yahoo: 'SI=F', label: 'Silver' }
];
```

### Timeframes
- **Monthly (1M):** 60 bars (~5 jaar) — hoofd analyse, EW macro, swing signalen
- **Weekly (1W):** 500 bars (~9.6 jaar) — sub-wave detectie binnen W3
- **4H:** 500 bars (~83 dagen) — korte termijn EMA/RSI/MACD

---

## Elliott Wave Systeem

### Macro Wave Detectie (`analyzeWaveDetails`)
Gebruikt `pivotLen` (standaard 3, escaleert naar 7) om swingpunten te vinden op maanddata.

**Wave Regels:**
- W0: Absolute laagste punt (cycle bottom)
- W1: Eerste impulse omhoog (W1 > W0)
- W2: Correctie (W0 < W2 < W1)
- W3: Sterkste impuls (W3 > W1) — typisch 1.618x W1
- W4: Consolidatie (W1 < W4 < W3, non-overlap regel)
- W5: Finale impuls (W5 > W4)
- A/B/C: Correctieve fase na W5

### 8 Coherentie-Checks
1. W4 boven W3 → wave te vroeg, herbereken
2. W2 boven W1 → ongeldige structuur
3. Max high > 2x W3 → swings te klein
4. In ABC maar prijs > W5 → correctie niet gestart
5. Significant hogere high NA W5 → premature W5 detectie
6. W4 < W1 → non-overlap geschonden
7. W4 > 60% onder W3 → wave ongeldig
8. 30%+ hogere high na W3 zonder W5 → W3 te vroeg

### Fallback bij Coherentie-Falen
- PivotLen escalatie: 3 → 4 → 5 → 6 → 7
- Bij maximale pivotLen: herinterpretatie als Macro W1

### MACRO Cyclus Herinterpretatie (Stap 4d) — KRITIEK
**DEZE LOGICA MAG NOOIT VERWIJDERD WORDEN.**

Als W0→W5 compleet + in correctie (ABC):
- Hele W0→W5 cyclus = **Macro W1**
- Correctie na W5 = **Macro W2**
- Huidige impuls = **Macro W3**

```javascript
if (wavePoints['W5'] && ['A','B','C'].includes(currentWave)) {
  // Hermap naar Macro W0→W1→W2, currentWave = W3
}
```

**Huidige status (april 2026):**
- BTC: Macro W3 (sub-wave i)
- HBAR: Macro W3 (sub-wave i)
- XRP: Macro W3 (sub-wave i)
- XAU: W4 (correctie)
- XAG: W4 (ABC correctie) — macro herinterpretatie geblokkeerd (ratio > 5x)

**EW Audit Agent:**
Runtime validatie bij elke 30s refresh + PDF rapport generatie.
- `ewAuditWaveCount()` functie in zowel index.html als api/report.js
- Controleert alle strikte EW regels automatisch
- Resultaten zichtbaar in browser console (`window._lastAudit`)
- Claude Code slash command: `/ew-audit` voor handmatige code audit
- Macro herinterpretatie wordt geblokkeerd als W3/W1 ratio > 5x
- **Referentie kennis:** https://www.elliottwave.com/ — officiële bron voor EW theorie
- **Audit persona:** Wereldklasse EW-analist (25+ jaar), strikt Frost & Prechter
- **Drie ijzeren regels:** W2 <100% retrace, W3 nooit kortste, W4 non-overlap
- **Dubbele verificatie:** Eerst regels, daarna Fibonacci-relaties
- **Multi-scenario:** Altijd Primary Count + Alternate Count met invalidation levels

### Sub-Wave Detectie (`analyzeSubWaves`)
Actief voor de huidige W3 EN voor alle afgeronde wave-segmenten. Analyseert weekdata.

**Minimum swing drempel:** 12% van verwachte W3 range (of 15% van W2 bottom als fallback)
**PivotLen:** 3 weken

**Sub-wave volgorde:** i → ii → iii → iv → v (binnen impulse waves)
- i: Eerste impuls omhoog vanaf W2
- ii: Correctie (nooit onder W2)
- iii: Sterkste sub-impuls (> i)
- iv: Correctie (nooit onder i top)
- v: Finale sub-impuls

**Correctie sub-waves:** A → B → C (binnen correctieve waves W1→W2, W3→W4)

**Fallback:** Als geen sub-waves gedetecteerd, schat op basis van prijspositie:
- 0-20% = i, 20-30% = ii, 30-60% = iii, 60-70% = iv, 70-100% = v

### Sub-Wave Regels voor Journey Chart — KRITIEK
**DEZE REGELS MOETEN ALTIJD WORDEN NAGELEEFD VOOR ALLE TICKERS.**

1. **Sub-wave v = macro wave top:** Sub-wave v van een impulse (W0→W1, W2→W3, W4→W5) moet ALTIJD dezelfde prijs hebben als het eindpunt van de macro wave. Voorbeeld: v van W0→W1 = W1 prijs.
2. **Wave C = macro wave bodem:** Wave C van een correctie (W1→W2, W3→W4) moet ALTIJD dezelfde prijs hebben als het eindpunt van de correctie. Voorbeeld: C van W1→W2 = W2 prijs.
3. **Geen dubbele rendering:** Als `completedW1SubWaves` (uit originalWavePoints) al getekend is voor W0→W1, skip `completedSubWaves['W0-W1']`.
4. **Extended wave iii:** Als sub-wave v < W3 prijs (iii is de peak), verbind het sub-wave pad NIET met de W3 node.
5. **Filter duplicaten:** Sub-wave punten die < 2% van de wave range afwijken van start/eindpunt worden gefilterd.
6. **Prijslabels spacing:** Sub-wave prijslabels moeten minimaal 30px boven/onder de cirkel staan om overlapping te voorkomen.
7. **In progress indicator:** Als een token in W3 zit maar nog geen gedetecteerde sub-wave punten heeft, toon een "sub-wave i in progress" stippellijn van W2 naar huidige positie.

### Completed Sub-Waves (`completedSubWaves`)
Alle afgeronde wave-segmenten worden geanalyseerd op weekly data:

| Segment | Type | Sub-waves | Eindpunt regel |
|---------|------|-----------|----------------|
| W0→W1 | Impulse | i, ii, iii, iv, v | v = W1 prijs |
| W1→W2 | Correctie | A, B, C | C = W2 prijs |
| W2→W3 | Impulse | i, ii, iii, iv, v | v = W3 prijs |
| W3→W4 | Correctie | A, B, C | C = W4 prijs |
| W4→W5 | Impulse | i, ii, iii, iv, v | v = W5 prijs |

**Mapping:** Monthly barIdx → weekly barIdx via end-relative berekening: `weeklyLen - 1 - (monthlyLen - 1 - barIdx) * 4.3`

### Target Labels
- Sub-wave targets moeten ALTIJD "W3·i TARGET" / "W3·iv TARGET" format gebruiken
- NOOIT alleen "W3 TARGET" — dit voorkomt verwarring met het macro wave target
- De $6.58 voor XRP is bijvoorbeeld het W3·i (sub-wave 1) target, NIET het volledige macro W3 target

---

## Swing Trading Signaal Engine

### Confluence Vereiste
Minimaal **2 onafhankelijke indicator-categorieen** moeten overeenstemmen.

### Indicatoren
| Indicator | BUY trigger | SELL trigger | Score |
|-----------|------------|-------------|-------|
| EMA 9/21 crossover | Golden cross | Death cross | ±3 |
| MACD crossover | Bullish cross | Bearish cross | ±2 |
| RSI extremen | ≤25/32/38 | ≥70/78/85 | ±2/3/4 |
| Prijs momentum | MoM ≥25% | MoM ≤-15% | ±1 |
| Candle patterns | Engulfing/Hammer | Engulfing/Shooting star | ±1 |
| Volume spike | Amplifier alleen | Amplifier alleen | ±1 boost |
| EMA 50 context | Amplifier alleen | Amplifier alleen | ±1 boost |

### Cooldown
3 maanden tussen signalen in dezelfde richting.

### Sterren
1-5 sterren op basis van absolute score (max 10 punten).

---

## Merlin's Prediction — Gewogen Scoring

### 10 Factoren (totaal max ±100)
| Factor | Gewicht | Bron |
|--------|---------|------|
| Elliott Wave | 20 | Maandelijkse wave positie |
| EMA Trend Monthly | 18 | EMA 9/21/50 relatie |
| RSI Monthly | 15 | Wilder's RSI |
| MACD Monthly | 12 | MACD histogram |
| EMA Trend 4H | 8 | 4H EMA richting |
| RSI 4H | 7 | 4H RSI |
| Fibonacci | 7 | Continue positie 0.0-1.0 |
| Fear & Greed | 5 | Contrarian scoring |
| MACD 4H | 5 | 4H MACD |
| Volume | 3 | Volume ratio |

### Richting Drempels
- Score > +15 → **BULLISH** (toon koersdoel)
- Score < -15 → **BEARISH** (toon koersdoel)
- -15 tot +15 → **NEUTRAAL** (geen koersdoel)

### Target Logica
1. Probeer eerst EW-target (als richting overeenkomt)
2. Als primair EW-target overschreden → gebruik deep/extended target
3. Fallback: Fibonacci-gebaseerd percentage (±15-30%)
4. NEUTRAAL → geen target

---

## UI Componenten

### Dashboard Secties (van boven naar beneden)
1. **Header** — Titel, taalswitch (EN/NL), live update timestamp
2. **Fear & Greed Index** — Meter met historisch overzicht
3. **Signal Strength Legend** — Uitleg sterren-systeem
4. **Actief Signaal Banner** — Nieuwste BUY/SELL signaal
5. **Monthly Charts** — Interactieve candlestick chart met EMA's en signalen (LightweightCharts)
6. **4H + Monthly Tabel** — Gedetailleerde indicator overzichten per token
7. **Merlin's Prediction** — AI scoring cards per token
8. **Elliott Wave - Macro Positie** — Cards met wave positie, targets, sub-wave badge in fase-balk
9. **Macro Wave Position** — Bar chart diagram per token met sub-wave badge
10. **Macro Wave Journey** — SVG pad visualisatie W0→huidige→target
11. **Macro Price Targets** — Fibonacci extensie targets

### Visuele Regels
- **Impulse waves** (W1/W3/W5): groen
- **Correctie waves** (W2/W4): lichtgrijs/blauw
- **ABC correctie**: rood
- **Sub-wave badge**: klein gekleurd cirkeltje (geel=vroeg, groen=midden, donkerblauw=laat) IN de actieve wave fase-balk
- **Journey chart**: vaste lijn = completed, stippellijn = projected, groene cirkel = "YOU ARE HERE"
- **Golden dashed lines**: extended target (MOET in Y-normalisatie meegenomen worden!)
- **Macro Positie grid**: 3 kolommen (rij 1: BTC-HBAR-XRP, rij 2: XAU-XAG)

---

## Deployment

### Vercel
```bash
cd /Users/steve/Downloads/TB/merlin-dashboard
export PATH="/usr/local/bin:$PATH"
npx vercel --prod --yes
```

### Lokaal Testen
```bash
cd /Users/steve/Downloads/TB
node dashboard-server.js
# → http://localhost:3001
```

### Yahoo Finance Proxy (`api/metals.js`)
- Gebruikt `child_process.execSync('curl ...')` om TLS fingerprinting te omzeilen
- In-memory cache met 15 min TTL
- Parameters: `symbol`, `interval`, `limit`

---

## Bekende Beperkingen & Regels

1. **EMA crossover op maandtimeframe** loopt maanden achter op top/bodem
2. **RSI extreme** is de belangrijkste sell-signal trigger op maandtimeframe
3. **Fibonacci MOET continu zijn** (0.0-1.0), nooit snappen naar discrete niveaus
4. **Volume corrigeren** voor onvolledige maanden (extrapoleer als monthProgress < 0.9)
5. **EW targets vergelijken** met huidige prijs — gebruik deep target als primair overschreden
6. **Fear & Greed** moet geladen zijn VOOR Merlin Prediction render
7. **Een EW functie** overal — nooit twee parallelle implementaties
8. **Macro cyclus herinterpretatie (stap 4d)** MAG NOOIT verwijderd worden
9. **Sub-wave minimum swing** = 12% van verwachte W3 range
10. **Golden dashed lines** → `cwTargetExt` MOET in `allPrices` array voor Y-normalisatie
11. **Live markt scanning** — Scan de markt live via TradingView en update alle indicatoren instant. Doe dit consistent en permanent. Alle technische indicatoren (EMA, RSI, MACD, Elliott Wave, Fibonacci, Volume) moeten real-time gesynchroniseerd blijven met actuele marktdata.

## Talen
- Engels (EN) en Nederlands (NL) via `translations` object
- Schakelen met knoppen rechtsboven
- Alle teksten via `t('key')` functie

## Technische Stack
- Vanilla JavaScript (geen frameworks)
- LightweightCharts v4.1.1 (interactieve charts)
- CSS Grid/Flexbox responsive layout
- Vercel serverless (Node.js) voor metals proxy
- Binance WebSocket voor real-time prijzen
