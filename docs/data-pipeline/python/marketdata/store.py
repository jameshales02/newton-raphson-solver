"""SQLite storage. The schema and queries live in docs/data-pipeline/sql/ and are
shared byte-for-byte with the browser demo."""

from __future__ import annotations

import math
import os
import sqlite3
import time
from pathlib import Path
from typing import Iterable

from .sources import Bar, validate_bar

SQL_DIR = Path(os.environ.get("MARKETDATA_SQL_DIR", Path(__file__).resolve().parents[2] / "sql"))


def load_sql(name: str) -> str:
    return (SQL_DIR / name).read_text(encoding="utf-8")


def _has_function(conn: sqlite3.Connection, expr: str) -> bool:
    try:
        conn.execute(f"SELECT {expr}").fetchone()
        return True
    except sqlite3.OperationalError:
        return False


def connect(path: str | os.PathLike = ":memory:") -> sqlite3.Connection:
    """Open a database and make sure ln() and sqrt() exist (SQLite only ships them
    when compiled with SQLITE_ENABLE_MATH_FUNCTIONS)."""
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    if not _has_function(conn, "ln(2.0)"):
        conn.create_function("ln", 1, lambda x: math.log(x) if x is not None and x > 0 else None, deterministic=True)
    if not _has_function(conn, "sqrt(4.0)"):
        conn.create_function("sqrt", 1, lambda x: math.sqrt(x) if x is not None and x >= 0 else None, deterministic=True)
    if str(path) != ":memory:":
        conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(load_sql("schema.sql"))


UPSERT = """
INSERT INTO bars (symbol, ts, open, high, low, close, volume, source, ingested_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (symbol, ts) DO UPDATE SET
  open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close,
  volume = excluded.volume, source = excluded.source, ingested_at = excluded.ingested_at
"""


def upsert_bars(conn: sqlite3.Connection, symbol: str, source: str, bars: Iterable[Bar], *, now: int | None = None) -> tuple[int, list[tuple[Bar, str]]]:
    """Validate and upsert bars in one transaction. Re-running with the same data is a
    no-op in effect (idempotent); a newer version of a bar replaces the older one, which
    matters because the most recent minute is still forming when it is first fetched.
    Returns (rows written, [(rejected bar, reason)])."""
    now = int(time.time()) if now is None else now
    good = []
    rejected = []
    for b in bars:
        reason = validate_bar(b)
        if reason:
            rejected.append((b, reason))
        else:
            good.append((symbol, b.ts, b.open, b.high, b.low, b.close, b.volume, source, now))
    with conn:
        conn.executemany(UPSERT, good)
    return len(good), rejected


def latest_ts(conn: sqlite3.Connection, symbol: str) -> int | None:
    row = conn.execute("SELECT MAX(ts) FROM bars WHERE symbol = ?", (symbol,)).fetchone()
    return row[0]


def log_run(conn: sqlite3.Connection, **fields) -> int:
    cols = ", ".join(fields)
    marks = ", ".join("?" for _ in fields)
    with conn:
        cur = conn.execute(f"INSERT INTO ingest_runs ({cols}) VALUES ({marks})", tuple(fields.values()))
    return cur.lastrowid
