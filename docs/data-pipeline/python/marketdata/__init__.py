"""Minute-bar market data pipeline: fetch from free public APIs, store in SQLite,
compute rolling statistics with SQL window functions. Standard library only."""

from .sources import Bar, fetch_coinbase, fetch_kraken, validate_bar
from .store import connect, init_schema, upsert_bars, latest_ts
from .stats import rolling_stats, rolling_corr, quality_report

__all__ = [
    "Bar",
    "fetch_coinbase",
    "fetch_kraken",
    "validate_bar",
    "connect",
    "init_schema",
    "upsert_bars",
    "latest_ts",
    "rolling_stats",
    "rolling_corr",
    "quality_report",
]
