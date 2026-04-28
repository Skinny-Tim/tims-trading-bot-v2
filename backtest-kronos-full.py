"""
╔══════════════════════════════════════════════════════════════════╗
║  Kronos AI Full Backtest — Merlijn Signaal Labo                  ║
║                                                                  ║
║  Draait het echte Kronos model lokaal op historische data.        ║
║  Elke voorspelling wordt vergeleken met werkelijke koers.        ║
║                                                                  ║
║  Vereisten:                                                      ║
║    pip install ccxt pandas numpy tabulate                        ║
║    git clone https://github.com/shiyu-coder/Kronos              ║
║    cd Kronos && pip install -r requirements.txt                  ║
║                                                                  ║
║  Gebruik: python backtest-kronos-full.py                         ║
╚══════════════════════════════════════════════════════════════════╝
"""

import sys
import os
import json
import time
from datetime import datetime

# Kronos model importeren
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'Kronos'))

try:
    from model import Kronos, KronosTokenizer, KronosPredictor
    KRONOS_OK = True
except ImportError:
    print("[!] Kronos model niet gevonden. Clone eerst:")
    print("    git clone https://github.com/shiyu-coder/Kronos")
    print("    cd Kronos && pip install -r requirements.txt")
    KRONOS_OK = False

import ccxt
import pandas as pd
import numpy as np

# ── Config ──
SYMBOLS     = ['BTCUSDT', 'HBARUSDT', 'XRPUSDT']
LOOKBACK    = 400       # Input candles voor Kronos
PRED_LEN    = 24        # Forecast: 24 × 4H = 4 dagen
STEP        = 24        # Stap tussen testpunten (4 dagen)
MAX_TESTS   = 40        # Max testpunten per token
CANDLES_NEEDED = LOOKBACK + PRED_LEN + MAX_TESTS * STEP

# ── Model laden ──
if KRONOS_OK:
    print("[Kronos] Model laden...")
    tokenizer = KronosTokenizer.from_pretrained("NeoQuasar/Kronos-Tokenizer-base")
    model     = Kronos.from_pretrained("NeoQuasar/Kronos-small")
    predictor = KronosPredictor(model, tokenizer, max_context=512)
    print("[Kronos] Model geladen\n")

# ── Binance data ophalen ──
exchange = ccxt.binance({'enableRateLimit': True})

def fetch_candles(symbol, limit=1500):
    """Haal 4H candles op van Binance."""
    pair = symbol.replace('USDT', '/USDT')
    all_candles = []
    since = None

    # Binance max 1000 per request, haal meerdere batches
    while len(all_candles) < limit:
        batch = exchange.fetch_ohlcv(pair, timeframe='4h', limit=min(1000, limit - len(all_candles)), since=since)
        if not batch:
            break
        all_candles.extend(batch)
        since = batch[-1][0] + 1
        time.sleep(0.5)

    df = pd.DataFrame(all_candles, columns=['timestamp', 'open', 'high', 'low', 'close', 'volume'])
    df['timestamps'] = pd.to_datetime(df['timestamp'], unit='ms')
    df = df.drop_duplicates(subset='timestamp').sort_values('timestamp').reset_index(drop=True)
    return df

def run_kronos_forecast(df, start_idx):
    """Draai Kronos model op een specifiek window."""
    x_df        = df.iloc[start_idx:start_idx + LOOKBACK][['open', 'high', 'low', 'close', 'volume']]
    x_timestamp = df.iloc[start_idx:start_idx + LOOKBACK]['timestamps']
    y_timestamp = df.iloc[start_idx + LOOKBACK:start_idx + LOOKBACK + PRED_LEN]['timestamps']

    if len(x_df) < LOOKBACK or len(y_timestamp) < PRED_LEN:
        return None

    pred_df = predictor.predict(
        df           = x_df,
        x_timestamp  = x_timestamp,
        y_timestamp  = y_timestamp,
        pred_len     = PRED_LEN,
        T            = 1.0,
        top_p        = 0.9,
        sample_count = 3
    )

    current_close  = df.iloc[start_idx + LOOKBACK - 1]['close']
    forecast_close = pred_df['close'].iloc[-1]
    actual_close   = df.iloc[start_idx + LOOKBACK + PRED_LEN - 1]['close']

    pct_forecast = (forecast_close - current_close) / current_close * 100
    pct_actual   = (actual_close - current_close) / current_close * 100

    raw_score = pct_forecast * 1.5
    score     = int(max(-15, min(15, round(raw_score))))

    if pct_forecast > 1.5:
        dir_forecast = 'bullish'
    elif pct_forecast < -1.5:
        dir_forecast = 'bearish'
    else:
        dir_forecast = 'neutral'

    if pct_actual > 1.5:
        dir_actual = 'bullish'
    elif pct_actual < -1.5:
        dir_actual = 'bearish'
    else:
        dir_actual = 'neutral'

    return {
        'date':           df.iloc[start_idx + LOOKBACK - 1]['timestamps'].strftime('%Y-%m-%d'),
        'current_close':  round(current_close, 6),
        'forecast_close': round(float(forecast_close), 6),
        'actual_close':   round(actual_close, 6),
        'pct_forecast':   round(pct_forecast, 2),
        'pct_actual':     round(pct_actual, 2),
        'score':          score,
        'dir_forecast':   dir_forecast,
        'dir_actual':     dir_actual,
        'dir_correct':    dir_forecast == dir_actual,
        'error_pct':      round(abs(pct_forecast - pct_actual), 2),
    }

def calc_ema_baseline(closes, idx):
    """EMA 9/21 baseline op een specifiek punt."""
    data = closes[:idx + 1]
    if len(data) < 21:
        return 'neutral'
    k9 = 2 / 10
    k21 = 2 / 22
    ema9 = data[0]
    ema21 = data[0]
    for v in data[1:]:
        ema9 = v * k9 + ema9 * (1 - k9)
        ema21 = v * k21 + ema21 * (1 - k21)
    if ema9 > ema21:
        return 'bullish'
    elif ema9 < ema21:
        return 'bearish'
    return 'neutral'

def backtest_symbol(symbol):
    """Volledige backtest voor één token."""
    print(f"\n{'═' * 60}")
    print(f"  {symbol} — Full Kronos Backtest")
    print(f"{'═' * 60}")

    df = fetch_candles(symbol, CANDLES_NEEDED)
    print(f"  Data: {len(df)} candles ({len(df) * 4 // 24} dagen)")

    if len(df) < LOOKBACK + PRED_LEN + STEP:
        print(f"  ✗ Onvoldoende data!")
        return None

    closes = df['close'].tolist()
    results = []
    max_start = len(df) - LOOKBACK - PRED_LEN
    start_points = list(range(0, max_start, STEP))[-MAX_TESTS:]

    print(f"  Testpunten: {len(start_points)}")
    print(f"  Draaien...\n")

    for i, start_idx in enumerate(start_points):
        result = run_kronos_forecast(df, start_idx)
        if result:
            # EMA baseline
            ema_dir = calc_ema_baseline(closes, start_idx + LOOKBACK - 1)
            result['ema_dir'] = ema_dir
            result['ema_correct'] = ema_dir == result['dir_actual']
            results.append(result)

            marker = '✓' if result['dir_correct'] else '✗'
            print(f"  [{i+1:2d}/{len(start_points)}] {result['date']} "
                  f"Kronos: {result['dir_forecast']:8s} ({result['pct_forecast']:+6.2f}%) "
                  f"Actual: {result['dir_actual']:8s} ({result['pct_actual']:+6.2f}%) "
                  f"{marker}")

    if not results:
        print("  Geen resultaten!")
        return None

    # ── Statistieken ──
    total = len(results)
    kronos_correct = sum(1 for r in results if r['dir_correct'])
    ema_correct    = sum(1 for r in results if r['ema_correct'])
    kronos_acc = kronos_correct / total * 100
    ema_acc    = ema_correct / total * 100

    # Score correlatie
    forecasts = [r['pct_forecast'] for r in results]
    actuals   = [r['pct_actual'] for r in results]
    if len(forecasts) > 2:
        correlation = np.corrcoef(forecasts, actuals)[0, 1]
    else:
        correlation = 0.0

    avg_error = np.mean([r['error_pct'] for r in results])
    avg_forecast = np.mean([abs(r['pct_forecast']) for r in results])
    avg_actual   = np.mean([abs(r['pct_actual']) for r in results])

    # Score-gebaseerde analyse: werkt hogere score = betere voorspelling?
    high_score = [r for r in results if abs(r['score']) >= 5]
    low_score  = [r for r in results if abs(r['score']) < 5]
    high_acc = sum(1 for r in high_score if r['dir_correct']) / max(1, len(high_score)) * 100
    low_acc  = sum(1 for r in low_score if r['dir_correct']) / max(1, len(low_score)) * 100

    print(f"\n  {'─' * 56}")
    print(f"  RESULTATEN {symbol}")
    print(f"  {'─' * 56}")
    print(f"  Kronos accuraatheid:    {kronos_correct}/{total} = {kronos_acc:.1f}%")
    print(f"  EMA baseline:           {ema_correct}/{total} = {ema_acc:.1f}%")
    print(f"  Verschil:               {kronos_acc - ema_acc:+.1f}% {'(BETER)' if kronos_acc > ema_acc else '(SLECHTER)' if kronos_acc < ema_acc else '(GELIJK)'}")
    print(f"  Correlatie (forecast/actual): {correlation:.3f}")
    print(f"  Gem. forecast afwijking:      {avg_error:.2f}%")
    print(f"  Gem. |forecast|:              {avg_forecast:.2f}%")
    print(f"  Gem. |actual|:                {avg_actual:.2f}%")
    print(f"\n  Score-gebaseerde analyse:")
    print(f"  Hoge score (|score|≥5): {len(high_score)}x, accuraat {high_acc:.0f}%")
    print(f"  Lage score (|score|<5): {len(low_score)}x, accuraat {low_acc:.0f}%")
    print(f"  → {'Hoge scores zijn betrouwbaarder' if high_acc > low_acc else 'Geen verschil in betrouwbaarheid per score'}")

    return {
        'symbol':         symbol,
        'total':          total,
        'kronos_acc':     round(kronos_acc, 1),
        'ema_acc':        round(ema_acc, 1),
        'delta':          round(kronos_acc - ema_acc, 1),
        'correlation':    round(correlation, 3),
        'avg_error':      round(avg_error, 2),
        'high_score_acc': round(high_acc, 1),
        'low_score_acc':  round(low_acc, 1),
        'results':        results,
    }


def print_summary(all_results):
    """Print finale samenvatting met aanbevelingen."""
    print(f"\n{'═' * 60}")
    print(f"  FINALE SAMENVATTING")
    print(f"{'═' * 60}\n")

    valid = [r for r in all_results if r is not None]
    if not valid:
        print("  Geen resultaten beschikbaar.")
        return

    avg_kronos = np.mean([r['kronos_acc'] for r in valid])
    avg_ema    = np.mean([r['ema_acc'] for r in valid])
    avg_corr   = np.mean([r['correlation'] for r in valid])
    avg_delta  = np.mean([r['delta'] for r in valid])

    print(f"  {'Token':<10} {'Kronos':>8} {'EMA':>8} {'Delta':>8} {'Corr':>8}")
    print(f"  {'─' * 46}")
    for r in valid:
        delta_str = f"{r['delta']:+.1f}%"
        print(f"  {r['symbol']:<10} {r['kronos_acc']:>7.1f}% {r['ema_acc']:>7.1f}% {delta_str:>8} {r['correlation']:>8.3f}")
    print(f"  {'─' * 46}")
    print(f"  {'Gemiddeld':<10} {avg_kronos:>7.1f}% {avg_ema:>7.1f}% {avg_delta:+7.1f}% {avg_corr:>8.3f}")

    print(f"\n  ── Aanbeveling ──")
    if avg_kronos >= avg_ema + 5:
        print(f"  ✅ Kronos voegt {avg_delta:+.1f}% accuraatheid toe vs EMA baseline.")
        print(f"  → Huidig gewicht (weight=10, indicator boost) is GERECHTVAARDIGD.")
        if avg_corr > 0.3:
            print(f"  → Correlatie {avg_corr:.3f} is positief — score-mapping werkt.")
    elif avg_kronos >= avg_ema:
        print(f"  ⚠ Kronos is marginaal beter ({avg_delta:+.1f}%) dan EMA baseline.")
        print(f"  → Verlaag gewicht van 10 naar 5 in Merlin's Prediction.")
        print(f"  → Verlaag indicator boost: score≥10 → +1 indicator (was +2).")
    else:
        print(f"  ❌ Kronos ({avg_kronos:.1f}%) is SLECHTER dan EMA ({avg_ema:.1f}%).")
        print(f"  → Verlaag gewicht van 10 naar 2-3 in Merlin's Prediction.")
        print(f"  → Verwijder indicator boost (geen +2 indicators meer).")
        print(f"  → Of: schakel Kronos uit tot model verbeterd is.")

    if avg_corr < 0.1:
        print(f"\n  ⚠ Correlatie {avg_corr:.3f} is zeer laag — Kronos scores")
        print(f"     correleren nauwelijks met werkelijke koersbewegingen.")

    # Save results
    output = {
        'timestamp': datetime.now().isoformat(),
        'summary': {
            'avg_kronos_acc': round(avg_kronos, 1),
            'avg_ema_acc':    round(avg_ema, 1),
            'avg_delta':      round(avg_delta, 1),
            'avg_correlation': round(avg_corr, 3),
        },
        'tokens': [{k: v for k, v in r.items() if k != 'results'} for r in valid],
    }
    with open('backtest-kronos-results.json', 'w') as f:
        json.dump(output, f, indent=2)
    print(f"\n  Resultaten opgeslagen: backtest-kronos-results.json")


if __name__ == '__main__':
    if not KRONOS_OK:
        sys.exit(1)

    all_results = []
    for symbol in SYMBOLS:
        try:
            result = backtest_symbol(symbol)
            all_results.append(result)
        except Exception as e:
            print(f"\n  ✗ {symbol} FOUT: {e}")
            import traceback
            traceback.print_exc()
            all_results.append(None)

    print_summary(all_results)
