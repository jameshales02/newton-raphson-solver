import math
import random
import unittest

from marketdata.stats import quality_report, ref_corr, ref_realised_vol, ref_returns, ref_vwap, rolling_corr, rolling_stats
from marketdata.store import connect, init_schema, upsert_bars

from .helpers import as_dicts, synthetic_bars


class StatsTests(unittest.TestCase):
    def setUp(self):
        self.conn = connect(":memory:")
        self.addCleanup(self.conn.close)
        init_schema(self.conn)
        self.gaps = {50, 51, 52, 300, 301, 302, 303, 304, 305, 306, 307}  # 3- and 8-minute holes
        self.bars = synthetic_bars(900, seed=3, gaps=self.gaps)
        upsert_bars(self.conn, "AAA", "test", self.bars)

    def test_rolling_vwap_matches_reference(self):
        for window in (5, 30):
            sql = rolling_stats(self.conn, "AAA", window)
            ref = ref_vwap(as_dicts(self.bars), window)
            checked = 0
            for row, expected in zip(sql, ref):
                if row["vwap"] is not None:
                    self.assertAlmostEqual(row["vwap"], expected, places=9)
                    checked += 1
            self.assertGreater(checked, 700)

    def test_realised_vol_matches_reference_and_respects_gaps(self):
        window = 30
        sql = rolling_stats(self.conn, "AAA", window)
        ref = ref_realised_vol(as_dicts(self.bars), window)
        for row, expected in zip(sql, ref):
            if row["rv_ann"] is not None:
                self.assertAlmostEqual(row["rv_ann"], expected, places=9)
        # the 8-minute hole is longer than 5 minutes, so the return across it is NULL
        r = ref_returns(as_dicts(self.bars))
        self.assertEqual(sum(x is None for x in r), 2)  # the first bar and the 8-minute gap
        view = self.conn.execute("SELECT COUNT(*) FROM returns WHERE symbol = 'AAA' AND r IS NULL").fetchone()[0]
        self.assertEqual(view, 2)

    def test_realised_vol_recovers_the_true_volatility(self):
        bars = synthetic_bars(20000, seed=8, vol=0.0005)
        conn = connect(":memory:")
        self.addCleanup(conn.close)
        init_schema(conn)
        upsert_bars(conn, "VOL", "test", bars)
        rows = [r for r in rolling_stats(conn, "VOL", 20000) if r["rv_ann"] is not None]
        true_ann = 0.0005 * math.sqrt(525600)
        self.assertAlmostEqual(rows[-1]["rv_ann"] / true_ann, 1.0, delta=0.02)

    def test_session_vwap_resets_at_utc_midnight(self):
        rows = rolling_stats(self.conn, "AAA", 10)
        for i, row in enumerate(rows):
            if row["ts"] % 86400 == 0:
                b = self.bars[i]
                self.assertAlmostEqual(row["session_vwap"], (b.high + b.low + b.close) / 3, places=9)
                break
        else:
            self.fail("synthetic data should cross midnight")

    def test_constant_price_has_zero_volatility(self):
        from marketdata.sources import Bar

        conn = connect(":memory:")
        self.addCleanup(conn.close)
        init_schema(conn)
        upsert_bars(conn, "FLAT", "test", [Bar(60 * i, 5, 5, 5, 5, 1) for i in range(1, 100)])
        rows = [r for r in rolling_stats(conn, "FLAT", 20) if r["rv_ann"] is not None]
        self.assertTrue(rows)
        self.assertTrue(all(r["rv_ann"] == 0 and r["park_ann"] == 0 for r in rows))

    def test_rolling_correlation_matches_reference(self):
        rng = random.Random(5)
        shock = [rng.gauss(0, 1) for _ in range(900)]
        a = synthetic_bars(900, seed=11, shock=shock, gaps={100, 400})
        b = synthetic_bars(900, seed=12, shock=shock, price=50, gaps={200})
        upsert_bars(self.conn, "A", "test", a)
        upsert_bars(self.conn, "B", "test", b)
        rows = rolling_corr(self.conn, "A", "B", 60)
        # rebuild the aligned return pairs in Python
        ra = {cur.ts: math.log(cur.close / prev.close) for prev, cur in zip(a, a[1:]) if cur.ts - prev.ts == 60}
        rb = {cur.ts: math.log(cur.close / prev.close) for prev, cur in zip(b, b[1:]) if cur.ts - prev.ts == 60}
        common = sorted(set(ra) & set(rb))
        checked = 0
        for row in rows:
            if row["corr"] is None:
                continue
            win = [t for t in common if row["ts"] - 59 * 60 <= t <= row["ts"]]
            self.assertEqual(row["n"], len(win))
            self.assertAlmostEqual(row["corr"], ref_corr([ra[t] for t in win], [rb[t] for t in win]), places=9)
            checked += 1
        self.assertGreater(checked, 700)
        # the shared shock has loading 0.7 on both series, so the true correlation is 0.49
        mean_corr = sum(r["corr"] for r in rows if r["corr"] is not None) / checked
        self.assertAlmostEqual(mean_corr, 0.49, delta=0.06)

    def test_correlation_of_a_series_with_itself_is_one(self):
        rows = [r for r in rolling_corr(self.conn, "AAA", "AAA", 30) if r["corr"] is not None]
        self.assertTrue(rows)
        for r in rows:
            self.assertAlmostEqual(r["corr"], 1.0, places=9)

    def test_quality_report_counts_gaps(self):
        (q,) = quality_report(self.conn)
        self.assertEqual(q["bars"], 900 - len(self.gaps))
        self.assertEqual(q["missing_minutes"], len(self.gaps))
        self.assertEqual(q["gaps"], 2)
        self.assertEqual(q["longest_gap_minutes"], 8)
        self.assertEqual(q["ohlc_violations"], 0)
        self.assertEqual(q["zero_volume_bars"], 0)


if __name__ == "__main__":
    unittest.main()
