import sqlite3
import unittest

from marketdata.sources import Bar, validate_bar
from marketdata.store import connect, init_schema, latest_ts, log_run, upsert_bars

from .helpers import synthetic_bars


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.conn = connect(":memory:")
        self.addCleanup(self.conn.close)
        init_schema(self.conn)

    def count(self):
        return self.conn.execute("SELECT COUNT(*) FROM bars").fetchone()[0]

    def test_math_functions_available(self):
        ln2, s = self.conn.execute("SELECT ln(2.0), sqrt(16.0)").fetchone()
        self.assertAlmostEqual(ln2, 0.6931471805599453)
        self.assertEqual(s, 4.0)

    def test_upsert_is_idempotent(self):
        bars = synthetic_bars(200)
        written, rejected = upsert_bars(self.conn, "BTC-USD", "test", bars, now=1)
        self.assertEqual((written, rejected), (200, []))
        upsert_bars(self.conn, "BTC-USD", "test", bars, now=2)
        self.assertEqual(self.count(), 200)

    def test_newer_version_of_a_bar_replaces_the_old_one(self):
        b = Bar(1_700_000_040 - 1_700_000_040 % 60, 10, 11, 9, 10.5, 3)
        upsert_bars(self.conn, "X", "test", [b], now=1)
        b2 = Bar(b.ts, 10, 12, 9, 11.5, 7)  # the minute kept trading after the first fetch
        upsert_bars(self.conn, "X", "test", [b2], now=2)
        row = self.conn.execute("SELECT high, close, volume, ingested_at FROM bars").fetchone()
        self.assertEqual(tuple(row), (12, 11.5, 7, 2))

    def test_invalid_bars_are_rejected_with_reasons(self):
        ts = 1_700_000_000 - 1_700_000_000 % 60
        bad = [
            Bar(ts + 7, 10, 11, 9, 10, 1),
            Bar(ts + 60, 10, 11, 10.5, 10, 1),
            Bar(ts + 120, -1, 11, 9, 10, 1),
            Bar(ts + 180, 10, 11, 9, 10, -5),
        ]
        good = Bar(ts + 240, 10, 11, 9, 10, 1)
        written, rejected = upsert_bars(self.conn, "X", "test", bad + [good])
        self.assertEqual(written, 1)
        self.assertEqual([r for _, r in rejected], [validate_bar(b) for b in bad])
        self.assertTrue(all(r for _, r in rejected))

    def test_schema_constraints_are_a_second_line_of_defence(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.conn.execute(
                "INSERT INTO bars VALUES ('X', 60, 10, 9, 11, 10, 1, 'test', 0)"  # high < low
            )

    def test_latest_ts_and_run_log(self):
        self.assertIsNone(latest_ts(self.conn, "BTC-USD"))
        bars = synthetic_bars(50)
        upsert_bars(self.conn, "BTC-USD", "test", bars)
        self.assertEqual(latest_ts(self.conn, "BTC-USD"), bars[-1].ts)
        run = log_run(self.conn, source="test", symbol="BTC-USD", started_at=1, finished_at=2, rows_fetched=50, rows_written=50, rows_rejected=0, status="ok")
        self.assertEqual(self.conn.execute("SELECT status FROM ingest_runs WHERE run_id = ?", (run,)).fetchone()[0], "ok")


if __name__ == "__main__":
    unittest.main()
