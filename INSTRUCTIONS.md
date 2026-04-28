# Merlin Signal Lab — Instructies & Audit Bevindingen

## 1. Elliott Wave Detectie — Kritieke Regels

### Coherentie-validatie (toegevoegd april 2026)
De `analyzeWaveDetails()` functie bevat een multi-stap coherentie-check die voorkomt dat de wave-telling inconsistent is met de huidige prijs:

1. **W4 boven W3**: Als currentWave=W4 maar prijs > W3 → wave telling te vroeg, herbereken met grotere pivotLen
2. **W2 boven W1**: Zelfde logica voor W2/W1
3. **W3 te klein**: Als de werkelijke max high > 2x de gedetecteerde W3 → waves werden te vroeg gelabeld op kleine swings
4. **ABC boven W5**: Als in correctie maar prijs nog boven W5 → correctie niet gestart
5. **Max high na W5**: Als er een significant hogere high NA W5 komt → W5 was niet de echte top
6. **W4 non-overlap**: Als prijs onder W1 terwijl we in W4 zitten → Elliott Wave non-overlap regel geschonden
7. **W4 te diep**: Als prijs > 60% onder W3 → wave telling ongeldig
8. **Hogere high na W3**: Als er een 30%+ hogere high na W3 komt (zonder W5) → W3 was te vroeg

### Fallback herinterpretatie (pivotLen >= 7)
Als coherentie faalt bij maximale pivotLen: de hele W0→W3/W5 move wordt geherinterpreteerd als één W1 impulsgolf, en de huidige correctie is W2.

### Bewezen correcte wave punten (april 2026)

**BTC** (pivotLen=3, geen retry nodig):
- W0=$15,476 (Nov 2022) → W1=$73,777 (Mar 2024) → W2=$49,000 (Aug 2024) → W3=$109,588 (Jan 2025) → W4=$74,508 (Apr 2025) → W5=$126,200 (Okt 2025)
- Huidige wave: **A** (correctie), prijs ~$67,000
- Target: $83,903 (38.2%) / $57,772 (61.8% deep)

**HBAR** (pivotLen escalatie 3→7, fallback herinterpretatie):
- W0=$0.0356 (Dec 2022) → W1=$0.4014 (Jan 2025) → W2=$0.0722 (Feb 2026)
- Huidige wave: **W3** (impulse), prijs ~$0.089
- Target: $0.664 (1.618x) / $1.03 (2.618x extended)

**XRP** (pivotLen escalatie 3→5):
- W0=$0.287 (Jun 2022) → W1=$0.938 (Jul 2023) → W2=$0.382 (Jul 2024) → W3=$3.40 (Jan 2025) → W4=$1.61 (Apr 2025) → W5=$3.66 (Jul 2025)
- Huidige wave: **A** (correctie), prijs ~$1.32
- Target: $2.37 (38.2%) / $1.58 (61.8% deep) — beide overschreden

---

## 2. Swing Trading Signaal Engine — Regels

### Confluence vereiste
Minimaal **2 onafhankelijke indicator-categorieën** moeten overeenstemmen:
1. EMA 9/21 crossover (+2 indicatoren, +3 score)
2. MACD crossover (+1, +2)
3. RSI extremen: ≥85 (+2, +4), ≥78 (+2, +3), ≥70 (+1, +2), ≤25 (+2, +4), ≤30 (+2, +3), ≤35 (+1, +2)
4. Prijs momentum: pctChange ≤-15% of riseFromLow >80%
5. Candle patterns: engulfing, shooting star, hammer
6. Volume spike: alleen amplifier (geen zelfstandige trigger)
7. Trend context: alleen amplifier

### Cooldown
Minimaal **3 maanden** tussen signalen in dezelfde richting.

### Bekende beperkingen
- EMA crossover op maandtimeframe loopt maanden achter op de top/bodem
- RSI extreme als onafhankelijke trigger is essentieel voor het detecteren van toppen
- SELL signalen bij RSI ≥78 met bevestiging door een tweede indicator zijn het meest betrouwbaar

---

## 3. Merlin's Prediction — Gewogen Scoring

### 10 factoren (totaal max ±100):
| Factor | Gewicht | Bron |
|--------|---------|------|
| Elliott Wave | 20 | Monthly wave positie |
| EMA Trend Monthly | 18 | EMA 9/21/50 relatie |
| RSI Monthly | 15 | Wilder's RSI |
| MACD Monthly | 12 | MACD histogram |
| EMA Trend 4H | 8 | 4H EMA richting |
| RSI 4H | 7 | 4H RSI |
| Fibonacci | 7 | Continue positie 0.0-1.0 |
| Fear & Greed | 5 | Contrarian scoring |
| MACD 4H | 5 | 4H MACD |
| Volume | 3 | Volume ratio |

### Richting drempels
- Score > +15 → BULLISH
- Score < -15 → BEARISH
- -15 tot +15 → NEUTRAAL (geen koersdoel tonen)

### Target logica
1. Probeer eerst EW-target (als richting overeenkomt en target past bij prijs)
2. Als primair EW-target overschreden → gebruik deep/extended target
3. Fallback: Fibonacci-gebaseerd percentage (±15-30%)
4. NEUTRAAL → geen target (voorkom misleiding)

---

## 4. Technische Fixes — Audit Log

### Fix 1: Fibonacci continue positie
**Probleem**: `calcFib` snapte naar discrete niveaus (0.236, 0.382, etc.) met exacte vergelijking
**Fix**: Return continue waarde `(close - swL) / range` als 0.0-1.0

### Fix 2: Fear & Greed timing
**Probleem**: FG werd gefetcht NA Merlin render
**Fix**: `await fetchFearGreed()` VOOR `renderMerlinPrediction()`

### Fix 3: Volume correctie incomplete maand
**Probleem**: Huidige maand volume altijd laag (0.4x) door incomplete data
**Fix**: Extrapoleer: `volR = volR / monthProgress` als `monthProgress < 0.9`

### Fix 4: 4H candle limiet
**Probleem**: Limiet 100 onvoldoende voor EMA-200 berekening
**Fix**: Verhoogd naar 500

### Fix 5: Unified Elliott Wave
**Probleem**: Twee functies (`detectElliottWave` en `analyzeWaveDetails`) gaven verschillende resultaten
**Fix**: Overal `analyzeWaveDetails` gebruiken via `wave: waveDetails ? waveDetails.currentWave : m.wave`

### Fix 6: Score systeem
**Probleem**: Legende claimde 8 componenten maar code had slechts 5 checks
**Fix**: 3 componenten toegevoegd (structuur, EW bonus, MACD crossover)

### Fix 7: Elliott Wave coherentie (KRITIEK)
**Probleem**: Kleine swings werden als W1/W3 gelabeld, grote moves gemist. XRP had W3=$0.94 maar werkelijke top was $3.66. HBAR had W3=$0.18 maar werkelijke top was $0.40.
**Fix**: 8 coherentie-checks + pivotLen escalatie (3→7) + fallback herinterpretatie

### Fix 8: EW deep target in Merlin Prediction
**Probleem**: Als primair EW-target overschreden was, viel code terug op generiek percentage
**Fix**: Check deep target / extended target als primair target al gepasseerd is

---

## 5. Continue Markt Monitoring (april 2026)

Het dashboard monitort continu de markt en past de Macro Wave Reis grafiek automatisch aan:

- **Auto-refresh**: Elke 30 seconden (`setInterval(update, 30000)`) worden alle tokens opnieuw geanalyseerd
- **WebSocket**: Real-time prijsupdates via Binance WebSocket (`wss://stream.binance.com:9443/ws/{symbol}@ticker`)
- **Auto-reconnect**: Bij WebSocket-verbreking automatisch opnieuw verbinden na 5 seconden
- **Journey charts**: Bij elke update-cyclus wordt `renderMacroWavePath(data)` aangeroepen → alle Journey grafieken worden opnieuw getekend met verse wave-detectie
- **Sub-wave detectie**: Wordt bij elke refresh opnieuw uitgevoerd op basis van wekelijkse kaarsen

---

## 6. Strikte Elliott Wave Regels (april 2026)

Alle onderstaande regels worden strikt toegepast in zowel de app (`index.html`) als het PDF rapport (`api/report.js`).

### 6.1 Hoofdgolven — Harde Regels

| Regel | Beschrijving | Actie bij schending |
|-------|-------------|---------------------|
| **W2 retrace 23.6%-99%** | W2 mag nooit 100% retracen (nooit onder W0), en moet minimaal 23.6% retracen | Verwijder W2 en alles daarna |
| **W3 niet kortste** | W3 mag NOOIT de kortste impulsgolf zijn (vergelijk W1, W3, W5 ranges) | Escaleer pivotLen |
| **W4 non-overlap** | W4 mag STRIKT niet onder W1 top komen | Verwijder W4 en alles daarna |
| **W4 retrace 14.6%-50%** | W4 retrace moet minimaal 14.6% van W3 zijn | Te ondiepe W4 wordt verwijderd |
| **W5 minimum 23.6%** | W5 range moet minstens 23.6% van W1 range zijn | Te kleine W5 wordt verwijderd |
| **Alternatie** | W2 diep → W4 ondiep (en omgekeerd) | Richtlijn, opgeslagen als `_alternation` flag |

### 6.2 Sub-golven (i–v binnen W3) — Harde Regels

| Regel | Beschrijving | Actie bij schending |
|-------|-------------|---------------------|
| **ii boven W2** | Sub-wave ii mag NOOIT onder macro W2 komen | Alle sub-waves worden verwijderd |
| **ii retrace ≥23.6%** | Sub-wave ii moet minstens 23.6% van wave i retracen | ii wordt overgeslagen |
| **iii ≥ i** | Sub-wave iii range moet groter of gelijk zijn aan wave i range | iii wordt pas geaccepteerd als voldoende |
| **iii langste** | Sub-wave iii mag niet de kortste van i, iii, v zijn | Escaleer pivotLen |
| **iv non-overlap** | Sub-wave iv mag niet onder wave i top komen | iv wordt overgeslagen |
| **iv retrace 23.6%-61.8%** | Sub-wave iv retrace moet binnen dit bereik vallen | Buiten bereik wordt overgeslagen |
| **v ≥ 38.2% van i** | Sub-wave v range moet minstens 38.2% van i range zijn | v wordt overgeslagen (truncatie-limiet) |
| **v ≤ 1.5x iii** | Sub-wave v mag niet > 1.5x wave iii range zijn | Escaleer pivotLen |

### 6.3 Macro Cyclus & Fibonacci Escalatie

- W0→W5 compleet + ABC → Macro W1 + Macro W2, dan Macro W3
- W3 targets: Fibonacci escalatie [1.618, 2.618, 4.236, 6.854, 11.09, 17.944]
- Escaleer tot target > prijs × 1.05
- Originele wave punten bewaard voor sub-wave detectie

### 6.4 Sub-wave Startpunt Strategie

1. **Macro reinterpretatie** → gebruik origineel W2 (pre-macro)
2. **W1 piek >> huidige prijs** → gebruik W0
3. **Anders** → gebruik regulier W2

---

## 7. Verbeterregels voor de Toekomst

1. **Altijd coherentie checken** na wave detectie — prijs moet consistent zijn met wave positie
2. **RSI extreme** is de belangrijkste sell-signal trigger op maandtimeframe
3. **Fibonacci moet continu zijn** (0.0-1.0), nooit snappen naar discrete niveaus
4. **Volume corrigeren** voor onvolledige maanden
5. **EW targets vergelijken** met huidige prijs — gebruik deep target als primair overschreden
6. **Fear & Greed** moet geladen zijn VOOR Merlin Prediction render
7. **Één EW functie** gebruiken overal — nooit twee parallelle implementaties
8. **Backtesting**: BUY signalen 92% accuraat, SELL signalen verbetering nodig (RSI extreme als trigger)
9. **Live markt scanning**: Scan de markt live via TradingView en update alle indicatoren instant. Doe dit consistent en permanent — alle technische indicatoren (EMA, RSI, MACD, Elliott Wave, Fibonacci, Volume) moeten real-time gesynchroniseerd blijven met de actuele marktdata.
10. **Strikte EW regels**: Pas ALTIJD de volledige set Elliott Wave regels toe (sectie 6). Geen enkele regel mag worden overgeslagen of afgezwakt.
11. **Sub-wave eindpunt consistentie**: Sub-wave v van een impulse wave MOET altijd exact samenvallen met de macro wave top (v=W1, v=W3, v=W5). Wave C van een correctie MOET altijd exact samenvallen met de macro wave bodem (C=W2, C=W4). Dit geldt voor ALLE tickers zonder uitzondering.
12. **Completed sub-waves**: Toon sub-waves voor ALLE afgeronde wave-segmenten (W0→W1, W1→W2, W2→W3, W3→W4), niet alleen de huidige W3. Gebruik weekly data met end-relative barIdx mapping.
13. **Extended iii scenario**: Bij extended wave iii (iii > v), verbind het sub-wave pad NIET met de macro wave node. De iii IS de peak.
