"""Rolling statistics, computed in SQL with window functions, plus small pure-Python
reference implementations used by the tests to check the SQL."""

from __future__ import annotations

import math
import sqlite3
from collections.abc import Sequence

from .store import load_sql

MINUTES_PER_YEAR = 525_600  # crypto trades around the clock


def rolling_stats(conn: sqlite3.Connection, symbol: str, window: int) -> list[dict]:
    rows = conn.execute(load_sql("rolling_stats.sql"), {"symbol": symbol, "window": int(window)}).fetchall()
    return [dict(r) for r in rows]


def rolling_corr(conn: sqlite3.Connection, a: str, b: str, window: int) -> list[dict]:
    rows = conn.execute(load_sql("rolling_corr.sql"), {"a": a, "b": b, "window": int(window)}).fetchall()
    return [dict(r) for r in rows]


def quality_report(conn: sqlite3.Connection) -> list[dict]:
    return [dict(r) for r in conn.execute(load_sql("quality.sql")).fetchall()]


# ---------------------------------------------------------------------------
# Reference implementations (deliberately naive: loop over each window)
# ---------------------------------------------------------------------------
def ref_window(ts: Sequence[int], i: int, window: int) -> range:
    lo = ts[i] - (window - 1) * 60
    j = i
    while j > 0 and ts[j - 1] >= lo:
        j -= 1
    return range(j, i + 1)


def ref_vwap(bars: Sequence[dict], window: int) -> list[float]:
    ts = [b["ts"] for b in bars]
    out = []
    for i in range(len(bars)):
        idx = ref_window(ts, i, window)
        pv = sum((bars[k]["high"] + bars[k]["low"] + bars[k]["close"]) / 3 * bars[k]["volume"] for k in idx)
        v = sum(bars[k]["volume"] for k in idx)
        out.append(pv / v if v else math.nan)
    return out


def ref_returns(bars: Sequence[dict]) -> list[float | None]:
    out: list[float | None] = [None]
    for prev, cur in zip(bars, bars[1:]):
        dt = cur["ts"] - prev["ts"]
        out.append(math.log(cur["close"] / prev["close"]) if dt <= 300 else None)
    return out


def ref_realised_vol(bars: Sequence[dict], window: int) -> list[float]:
    ts = [b["ts"] for b in bars]
    r = ref_returns(bars)
    out = []
    for i in range(len(bars)):
        idx = [k for k in ref_window(ts, i, window) if r[k] is not None]
        covered = sum(ts[k] - ts[k - 1] for k in idx) / 60
        out.append(math.sqrt(sum(r[k] ** 2 for k in idx) / covered * MINUTES_PER_YEAR) if covered else math.nan)
    return out


def ref_corr(x: Sequence[float], y: Sequence[float]) -> float:
    n = len(x)
    mx = sum(x) / n
    my = sum(y) / n
    sxy = sum((a - mx) * (b - my) for a, b in zip(x, y))
    sxx = sum((a - mx) ** 2 for a in x)
    syy = sum((b - my) ** 2 for b in y)
    return sxy / math.sqrt(sxx * syy)
