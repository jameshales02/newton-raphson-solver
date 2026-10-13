import math
import random

from marketdata.sources import Bar


def synthetic_bars(n=600, seed=1, start=1_700_000_000 - 1_700_000_000 % 86400 - 3600, price=100.0, gaps=(), vol=0.0008, shock=None):
    """Deterministic minute bars with optional missing minutes (gaps: set of indices to drop).
    `shock` is a list of common shocks to correlate two series."""
    rng = random.Random(seed)
    out = []
    p = price
    for i in range(n):
        z = rng.gauss(0, 1)
        if shock is not None:
            z = 0.7 * shock[i] + math.sqrt(1 - 0.49) * z
        o = p
        c = o * math.exp(vol * z)
        h = max(o, c) * math.exp(abs(rng.gauss(0, vol / 2)))
        lo = min(o, c) * math.exp(-abs(rng.gauss(0, vol / 2)))
        v = rng.uniform(0.5, 5.0)
        if i not in gaps:
            out.append(Bar(start + 60 * i, o, h, lo, c, v))
        p = c
    return out


def as_dicts(bars):
    return [dict(ts=b.ts, open=b.open, high=b.high, low=b.low, close=b.close, volume=b.volume) for b in bars]
