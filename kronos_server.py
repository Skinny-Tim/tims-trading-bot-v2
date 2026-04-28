"""
╔══════════════════════════════════════════════════════════════════════╗
║  kronos_server.py — Kronos AI Forecast Microservice                 ║
║  Merlijn Signaal Labo — Camelot Finance                             ║
║                                                                      ║
║  Draait op http://localhost:5001                                     ║
║  Endpoint: GET /forecast?symbol=BTCUSDT                             ║
║                                                                      ║
║  Installatie:                                                        ║
║    pip install flask ccxt pandas                                     ║
║    git clone https://github.com/shiyu-coder/Kronos                  ║
║    cd Kronos && pip install -r requirements.txt                      ║
║    python kronos_server.py                                           ║
╚══════════════════════════════════════════════════════════════════════╝
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'Kronos'))

from flask import Flask, jsonify, request
import ccxt
import pandas as pd
import time
from functools import lru_cache

app = Flask(__name__)

# ── Model laden (éénmalig bij opstart) ───────────────────────────────
print("[Kronos] Model laden...")
try:
    from model import Kronos, KronosTokenizer, KronosPredictor
    tokenizer  = KronosTokenizer.from_pretrained("NeoQuasar/Kronos-Tokenizer-base")
    model      = Kronos.from_pretrained("NeoQuasar/Kronos-small")
    predictor  = KronosPredictor(model, tokenizer, max_context=512)
    print("[Kronos] ✅ Model geladen")
    KRONOS_OK = True
except Exception as e:
    print(f"[Kronos] ⚠️  Model kon niet geladen worden: {e}")
    print("[Kronos] Fallback modus — geeft neutrale scores")
    KRONOS_OK = False

# ── Exchange (Binance publiek, geen API key nodig) ────────────────────
exchange = ccxt.binance({'enableRateLimit': True})

# ── Cache: max 1 forecast per symbol per 30 min ──────────────────────
_cache = {}
CACHE_TTL = 1800  # 30 minuten

# ── Metals mapping (XAG/XAU via Binance PAXG proxy) ──────────────────
SYMBOL_MAP = {
    'XAGUSD':  'PAXGUSDT',   # Zilver proxy (PAXG ≈ XAU, beste beschikbaar)
    'XAUUSD':  'PAXGUSDT',   # Goud via PAXG
}

def get_binance_symbol(symbol):
    return SYMBOL_MAP.get(symbol.upper(), symbol.upper())


def fetch_ohlcv(symbol, lookback=450):
    """Haal OHLCV klines op van Binance."""
    binance_sym = get_binance_symbol(symbol)
    pair = binance_sym.replace('USDT', '/USDT')
    ohlcv = exchange.fetch_ohlcv(pair, timeframe='4h', limit=lookback)
    df = pd.DataFrame(ohlcv, columns=['timestamp', 'open', 'high', 'low', 'close', 'volume'])
    df['timestamps'] = pd.to_datetime(df['timestamp'], unit='ms')
    return df


def compute_forecast(symbol):
    """Bereken Kronos forecast voor een symbol. Geeft dict terug."""
    now = time.time()

    # Cache check
    if symbol in _cache and now - _cache[symbol]['ts'] < CACHE_TTL:
        print(f"[Kronos] Cache hit voor {symbol}")
        return _cache[symbol]['data']

    if not KRONOS_OK:
        return {'symbol': symbol, 'direction': 'neutral', 'pct': 0.0, 'score': 0}

    try:
        df = fetch_ohlcv(symbol)

        lookback = 400
        pred_len = 24  # 24 candles × 4H = 4 dagen vooruit

        # Zorg dat we exact genoeg data hebben, trim overtollige rijen
        if len(df) < lookback + pred_len:
            return {'symbol': symbol, 'direction': 'neutral', 'pct': 0.0, 'score': 0, 'error': f'Onvoldoende data: {len(df)} rijen'}

        # Gebruik de laatste lookback+pred_len rijen voor consistentie
        df = df.iloc[-(lookback + pred_len):].reset_index(drop=True)

        x_df        = df.iloc[:lookback][['open', 'high', 'low', 'close', 'volume']]
        x_timestamp = df.iloc[:lookback]['timestamps']
        y_timestamp = df.iloc[lookback:lookback + pred_len]['timestamps']

        pred_df = predictor.predict(
            df           = x_df,
            x_timestamp  = x_timestamp,
            y_timestamp  = y_timestamp,
            pred_len     = pred_len,
            T            = 1.0,
            top_p        = 0.9,
            sample_count = 3   # gemiddelde van 3 paden voor stabiliteit
        )

        current_close  = df.iloc[lookback - 1]['close']
        forecast_close = pred_df['close'].iloc[-1]
        pct_change     = (forecast_close - current_close) / current_close * 100

        # Score: proportioneel aan verwachte koersbeweging, max ±15 punten
        # +1.5% verwacht → ~+2.25 score, +5% → +7.5, +10% → +15 (gecapped)
        raw_score = pct_change * 1.5
        score     = int(max(-15, min(15, round(raw_score))))

        # Directional label
        if pct_change > 1.5:
            direction = 'bullish'
        elif pct_change < -1.5:
            direction = 'bearish'
        else:
            direction = 'neutral'

        result = {
            'symbol':    symbol,
            'direction': direction,
            'pct':       round(pct_change, 2),
            'score':     score,
            'forecast':  round(float(forecast_close), 6),
            'current':   round(float(current_close), 6),
        }

        # Opslaan in cache
        _cache[symbol] = {'ts': now, 'data': result}
        print(f"[Kronos] {symbol}: {direction} {pct_change:+.2f}% → score {score:+d}")
        return result

    except Exception as e:
        print(f"[Kronos] Fout bij forecast {symbol}: {e}")
        return {'symbol': symbol, 'direction': 'neutral', 'pct': 0.0, 'score': 0, 'error': str(e)}


# ── Routes ────────────────────────────────────────────────────────────

@app.route('/forecast')
def forecast():
    symbol = request.args.get('symbol', 'BTCUSDT').upper()
    result = compute_forecast(symbol)
    return jsonify(result)


@app.route('/health')
def health():
    return jsonify({'status': 'ok', 'kronos_loaded': KRONOS_OK, 'cached': list(_cache.keys())})


@app.route('/cache/clear')
def clear_cache():
    _cache.clear()
    return jsonify({'status': 'cache cleared'})


if __name__ == '__main__':
    print("[Kronos] Server start op http://localhost:5001")
    print("[Kronos] Test: http://localhost:5001/forecast?symbol=BTCUSDT")
    app.run(host='0.0.0.0', port=5001, debug=False)
