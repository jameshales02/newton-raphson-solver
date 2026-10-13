"""Command-line interface.

    python -m marketdata ingest  --db market.db --source coinbase --symbols BTC-USD ETH-USD --hours 24
    python -m marketdata stats   --db market.db --symbol BTC-USD --window 30
    python -m marketdata corr    --db market.db --a BTC-USD --b ETH-USD --window 60
    python -m marketdata quality --db market.db
    python -m marketdata export  --db market.db --symbols BTC-USD ETH-USD --out ../sample/btc_eth_1m.json
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone

from . import sources
from .stats import quality_report, rolling_corr, rolling_stats
from .store import connect, init_schema, latest_ts, log_run, upsert_bars


def fmt_ts(ts: int | None) -> str:
    return "-" if ts is None else datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def cmd_ingest(args) -> int:
    conn = connect(args.db)
    init_schema(conn)
    now = int(time.time())
    end = now - now % 60  # exclude the minute that is still forming
    for symbol in args.symbols:
        last = latest_ts(conn, symbol)
        start = max(end - args.hours * 3600, (last + 60) if last is not None else 0)
        started = int(time.time())
        status = "ok"
        fetched = written = 0
        rejected: list = []
        first = last_bar = None
        try:
            if args.source == "coinbase":
                bars = sources.fetch_coinbase(symbol, start, end)
            else:
                bars = [b for b in sources.fetch_kraken(symbol, start - 60) if b.ts < end]
            fetched = len(bars)
            written, rejected = upsert_bars(conn, symbol, args.source, bars)
            if bars:
                first, last_bar = bars[0].ts, bars[-1].ts
        except Exception as e:  # record the failure, keep going with other symbols
            status = f"error: {e}"
        log_run(conn, source=args.source, symbol=symbol, started_at=started, finished_at=int(time.time()), rows_fetched=fetched, rows_written=written, rows_rejected=len(rejected), first_ts=first, last_ts=last_bar, status=status)
        print(f"{symbol:<8} {args.source:<8} fetched {fetched:>5}  written {written:>5}  rejected {len(rejected):>3}  {fmt_ts(first)} -> {fmt_ts(last_bar)}  [{status}]")
        for b, reason in rejected[:5]:
            print(f"    rejected {fmt_ts(b.ts)}: {reason}")
    return 0


def cmd_stats(args) -> int:
    conn = connect(args.db)
    rows = [r for r in rolling_stats(conn, args.symbol, args.window) if r["rv_ann"] is not None]
    if not rows:
        print("not enough data")
        return 1
    print(f"{'time (UTC)':<22}{'close':>12}{'vwap':>12}{'session vwap':>14}{'RV ann':>9}{'Parkinson':>11}")
    for r in rows[-args.tail:]:
        print(f"{fmt_ts(r['ts']):<22}{r['close']:>12.2f}{r['vwap']:>12.2f}{r['session_vwap']:>14.2f}{r['rv_ann']:>9.1%}{r['park_ann']:>11.1%}")
    return 0


def cmd_corr(args) -> int:
    conn = connect(args.db)
    rows = [r for r in rolling_corr(conn, args.a, args.b, args.window) if r["corr"] is not None]
    for r in rows[-args.tail:]:
        print(f"{fmt_ts(r['ts']):<22} n={r['n']:<4} corr={r['corr']:+.3f}")
    return 0


def cmd_quality(args) -> int:
    conn = connect(args.db)
    for r in quality_report(conn):
        print(f"{r['symbol']:<8} bars {r['bars']:>6}  {fmt_ts(r['first_ts'])} -> {fmt_ts(r['last_ts'])}  missing {r['missing_minutes']:>4} min in {r['gaps']:>3} gaps (longest {r['longest_gap_minutes']} min)  OHLC violations {r['ohlc_violations']}  zero-volume {r['zero_volume_bars']}")
    for r in conn.execute("SELECT * FROM ingest_runs ORDER BY run_id DESC LIMIT 6"):
        print(f"  run {r['run_id']}: {r['symbol']} {r['source']} wrote {r['rows_written']} at {fmt_ts(r['finished_at'])} [{r['status']}]")
    return 0


def cmd_export(args) -> int:
    conn = connect(args.db)
    out = {"source": None, "exported_at": int(time.time()), "symbols": {}}
    for symbol in args.symbols:
        rows = conn.execute("SELECT ts, open, high, low, close, volume, source FROM bars WHERE symbol = ? ORDER BY ts", (symbol,)).fetchall()
        if args.minutes:
            rows = rows[-args.minutes:]
        out["symbols"][symbol] = [[r["ts"], r["open"], r["high"], r["low"], r["close"], round(r["volume"], 8)] for r in rows]
        if rows:
            out["source"] = rows[-1]["source"]
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"wrote {args.out}: " + ", ".join(f"{s} {len(v)} bars" for s, v in out["symbols"].items()))
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="marketdata", description="Minute-bar market data pipeline")
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ("ingest", "stats", "corr", "quality", "export"):
        sp = sub.add_parser(name)
        sp.add_argument("--db", default="market.db")
        if name == "ingest":
            sp.add_argument("--source", choices=("coinbase", "kraken"), default="coinbase")
            sp.add_argument("--symbols", nargs="+", default=["BTC-USD", "ETH-USD"])
            sp.add_argument("--hours", type=float, default=24)
            sp.set_defaults(func=cmd_ingest)
        elif name == "stats":
            sp.add_argument("--symbol", default="BTC-USD")
            sp.add_argument("--window", type=int, default=30)
            sp.add_argument("--tail", type=int, default=10)
            sp.set_defaults(func=cmd_stats)
        elif name == "corr":
            sp.add_argument("--a", default="BTC-USD")
            sp.add_argument("--b", default="ETH-USD")
            sp.add_argument("--window", type=int, default=60)
            sp.add_argument("--tail", type=int, default=10)
            sp.set_defaults(func=cmd_corr)
        elif name == "quality":
            sp.set_defaults(func=cmd_quality)
        else:
            sp.add_argument("--symbols", nargs="+", default=["BTC-USD", "ETH-USD"])
            sp.add_argument("--minutes", type=int, default=0, help="keep only the most recent N bars per symbol")
            sp.add_argument("--out", required=True)
            sp.set_defaults(func=cmd_export)
    args = p.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
