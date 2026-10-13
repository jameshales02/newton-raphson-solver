"""Data sources: public, key-free REST endpoints for one-minute candles.

Coinbase Exchange  GET /products/{product}/candles?granularity=60&start=..&end=..
                   -> [[time, low, high, open, close, volume], ...] newest first,
                   at most 300 candles per request. Minutes with no trades are omitted.
Kraken             GET /0/public/OHLC?pair=..&interval=1&since=..
                   -> {"result": {PAIR: [[time, open, high, low, close, vwap, volume, count], ...],
                   "last": ..}}, the most recent 720 candles at most.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable, Iterable

USER_AGENT = "trading-systems-portfolio/1.0 (+https://github.com/jameshales02/newton-raphson-solver)"
COINBASE_URL = "https://api.exchange.coinbase.com/products/{product}/candles"
KRAKEN_URL = "https://api.kraken.com/0/public/OHLC"
KRAKEN_PAIRS = {"BTC-USD": "XBTUSD", "ETH-USD": "ETHUSD", "SOL-USD": "SOLUSD"}
COINBASE_MAX = 300


@dataclass(frozen=True)
class Bar:
    ts: int  # bar open time, Unix seconds UTC
    open: float
    high: float
    low: float
    close: float
    volume: float


def validate_bar(b: Bar) -> str | None:
    """Return a reason the bar is unusable, or None if it is fine."""
    if b.ts % 60:
        return "timestamp not aligned to a minute"
    if min(b.open, b.high, b.low, b.close) <= 0:
        return "non-positive price"
    if b.low > min(b.open, b.close) or b.high < max(b.open, b.close):
        return "high/low inconsistent with open/close"
    if b.volume < 0:
        return "negative volume"
    return None


HttpGet = Callable[[str, dict], object]


def http_get_json(url: str, params: dict, *, retries: int = 4, timeout: float = 15.0, sleep: Callable[[float], None] = time.sleep) -> object:
    """GET a JSON document with retries and exponential backoff on 429 and 5xx."""
    full = url + ("?" + urllib.parse.urlencode(params) if params else "")
    delay = 1.0
    for attempt in range(retries + 1):
        req = urllib.request.Request(full, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code not in (429, 500, 502, 503, 504) or attempt == retries:
                raise
        except urllib.error.URLError:
            if attempt == retries:
                raise
        sleep(delay)
        delay *= 2
    raise RuntimeError("unreachable")


def _iso(ts: int) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_coinbase(rows: Iterable[list]) -> list[Bar]:
    bars = [Bar(int(t), float(o), float(h), float(lo), float(c), float(v)) for t, lo, h, o, c, v in rows]
    return sorted(bars, key=lambda b: b.ts)


def fetch_coinbase(product: str, start: int, end: int, *, http_get: HttpGet = http_get_json, pause: float = 0.25, sleep: Callable[[float], None] = time.sleep) -> list[Bar]:
    """All one-minute candles with start <= ts < end, paging 300 minutes per request."""
    out: dict[int, Bar] = {}
    chunk = COINBASE_MAX * 60
    t = start - start % 60
    while t < end:
        t_end = min(end, t + chunk)
        rows = http_get(COINBASE_URL.format(product=product), {"granularity": 60, "start": _iso(t), "end": _iso(t_end - 60)})
        if isinstance(rows, dict):  # error payloads are objects, data are lists
            raise RuntimeError(f"Coinbase error for {product}: {rows.get('message', rows)}")
        for b in parse_coinbase(rows):
            if start <= b.ts < end:
                out[b.ts] = b
        t = t_end
        if t < end and pause:
            sleep(pause)
    return [out[k] for k in sorted(out)]


def parse_kraken(doc: dict) -> list[Bar]:
    if doc.get("error"):
        raise RuntimeError(f"Kraken error: {doc['error']}")
    result = doc["result"]
    key = next(k for k in result if k != "last")
    return [Bar(int(r[0]), float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[6])) for r in result[key]]


def fetch_kraken(symbol: str, since: int, *, http_get: HttpGet = http_get_json) -> list[Bar]:
    """One-minute candles after `since` (Kraken only serves the latest 720)."""
    pair = KRAKEN_PAIRS.get(symbol, symbol.replace("-", ""))
    doc = http_get(KRAKEN_URL, {"pair": pair, "interval": 1, "since": since})
    return [b for b in parse_kraken(doc) if b.ts > since]
