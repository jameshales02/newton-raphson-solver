import unittest
import urllib.error
from datetime import datetime, timezone

from marketdata import sources
from marketdata.sources import Bar, fetch_coinbase, fetch_kraken, http_get_json, parse_coinbase, parse_kraken


class SourceTests(unittest.TestCase):
    def test_parse_coinbase_reorders_columns_and_sorts(self):
        rows = [[120, 9.0, 11.0, 10.0, 10.5, 3.0], [60, 8.0, 10.0, 9.0, 9.5, 2.0]]  # newest first
        self.assertEqual(parse_coinbase(rows), [Bar(60, 9.0, 10.0, 8.0, 9.5, 2.0), Bar(120, 10.0, 11.0, 9.0, 10.5, 3.0)])

    def test_coinbase_pages_300_minutes_per_request(self):
        calls = []
        start = 1_700_000_000 - 1_700_000_000 % 60
        end = start + 700 * 60

        def parse(iso):
            return int(datetime.strptime(iso, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp())

        def fake_get(url, params):
            calls.append(params)
            # serve every minute in the requested [start, end] range, newest first, like the API
            s, e = parse(params["start"]), parse(params["end"])
            return [[t, 1, 2, 1.5, 1.5, 1] for t in range(e, s - 1, -60)]

        bars = fetch_coinbase("BTC-USD", start, end, http_get=fake_get, sleep=lambda s: None)
        self.assertEqual(len(calls), 3)
        self.assertEqual(len(bars), 700)
        self.assertEqual(bars[0].ts, start)
        self.assertEqual(bars[-1].ts, end - 60)
        self.assertTrue(all(b.ts - a.ts == 60 for a, b in zip(bars, bars[1:])))

    def test_coinbase_error_payload_raises(self):
        with self.assertRaises(RuntimeError):
            fetch_coinbase("NOPE", 0, 60, http_get=lambda u, p: {"message": "NotFound"})

    def test_parse_kraken(self):
        doc = {"error": [], "result": {"XXBTZUSD": [[60, "10", "11", "9", "10.5", "10.2", "3.5", 7]], "last": 60}}
        self.assertEqual(parse_kraken(doc), [Bar(60, 10.0, 11.0, 9.0, 10.5, 3.5)])
        self.assertEqual(fetch_kraken("BTC-USD", 0, http_get=lambda u, p: doc), [Bar(60, 10.0, 11.0, 9.0, 10.5, 3.5)])
        with self.assertRaises(RuntimeError):
            parse_kraken({"error": ["EQuery:Unknown asset pair"]})

    def test_http_retries_with_backoff_on_rate_limit(self):
        attempts = []
        sleeps = []

        class FakeResp:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self):
                return b"[1, 2, 3]"

        def fake_urlopen(req, timeout):
            attempts.append(req.full_url)
            if len(attempts) < 3:
                raise urllib.error.HTTPError(req.full_url, 429, "Too Many Requests", {}, None)
            return FakeResp()

        original = sources.urllib.request.urlopen
        sources.urllib.request.urlopen = fake_urlopen
        try:
            self.assertEqual(http_get_json("https://example.test/x", {"a": 1}, sleep=sleeps.append), [1, 2, 3])
        finally:
            sources.urllib.request.urlopen = original
        self.assertEqual(len(attempts), 3)
        self.assertEqual(sleeps, [1.0, 2.0])
        self.assertTrue(attempts[0].endswith("?a=1"))


if __name__ == "__main__":
    unittest.main()
