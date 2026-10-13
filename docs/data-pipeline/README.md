# Market data pipeline

**Live demo:** `docs/data-pipeline/index.html`. It runs the pipeline in your browser on a recorded sample, or live against Coinbase or Kraken.

## The problem

Every strategy and risk report sits on a market-data pipeline, and most research bugs are data bugs: duplicated bars, silent gaps, returns computed across an outage, a VWAP over the wrong window. This project pulls one-minute bars from free public APIs, stores them in SQL with constraints, keeps ingestion idempotent and incremental, reports data quality, and computes rolling VWAP, realised volatility and correlation with SQL window functions.

## Layout

```
docs/data-pipeline/
├── sql/                     shared by Python and the browser, executed unchanged by both
│   ├── schema.sql           bars (PK symbol, ts; CHECK constraints), ingest_runs, returns view
│   ├── rolling_stats.sql    rolling + session VWAP, realised vol, Parkinson vol
│   ├── rolling_corr.sql     rolling correlation of synchronous returns
│   └── quality.sql          coverage, gaps, OHLC violations, zero volume
├── python/
│   ├── marketdata/          standard library only (urllib, sqlite3, argparse)
│   │   ├── sources.py       Coinbase + Kraken fetchers, paging, retry/backoff, validation
│   │   ├── store.py         connect (registers ln/sqrt if missing), schema, upsert, run log
│   │   ├── stats.py         runs the SQL; naive Python references used by the tests
│   │   └── cli.py           ingest | stats | corr | quality | export
│   └── tests/               19 unittest tests, no network
├── pipeline.js              browser fetchers + validation (mirrors sources.py)
├── app.js                   page: sql.js engine, pipeline steps, charts, SQL console
└── sample/btc_eth_1m.json   24 h of BTC-USD and ETH-USD minute bars recorded by the CLI
```

## Running it

```bash
cd docs/data-pipeline/python
python -m marketdata ingest  --db market.db --source coinbase --symbols BTC-USD ETH-USD --hours 24
python -m marketdata quality --db market.db
python -m marketdata stats   --db market.db --symbol BTC-USD --window 30
python -m marketdata corr    --db market.db --a BTC-USD --b ETH-USD --window 60
python -m marketdata export  --db market.db --out ../sample/btc_eth_1m.json
python -m unittest discover -s tests -t .
```

Python 3.10+, no third-party packages. Ingest is incremental: re-running fetches only minutes after the last stored bar. Schedule it with cron or a CI workflow.

## Design choices

* **Sources.** Coinbase Exchange candles (300 per request, paged; minutes with no trades are absent) and Kraken OHLC (latest 720 minutes). Both are free and need no key. HTTP 429 and 5xx retry with exponential backoff (1 s, 2 s, 4 s, …).
* **Validate, then constrain.** Bars must be minute-aligned, have positive prices, have a high/low that brackets the open/close, and have non-negative volume. Rejects are counted and printed, not silently dropped. The schema repeats the rules as `CHECK` constraints in case validation is ever bypassed.
* **Idempotent upsert.** Primary key `(symbol, ts)` with `INSERT … ON CONFLICT DO UPDATE`. Re-running is harmless, and the still-forming latest minute is corrected on the next run. Every run writes an audit row to `ingest_runs`.
* **Analytics in the database.** Window functions compute everything. Windows are defined in **time**, with `RANGE BETWEEN (w−1)·60 PRECEDING` on the timestamp rather than `ROWS`, so a missing minute shrinks the sample instead of silently stretching the window. Values stay NULL until 80% of the window is present.
* **One SQL source of truth.** The Python CLI and the web page execute the same `.sql` files (sqlite3 and sql.js respectively), so the demo cannot drift from the pipeline.
* **No joins on the hot path.** The correlation query pivots both symbols onto one row per minute with a single `GROUP BY` instead of joining two return series. The first version used a join and ran as a nested loop; the rewrite took it from 123 ms to 11 ms natively and from about 5 s to under 1 s in the browser.

## Formulas

Typical price `p̃ = (H + L + C)/3` (a proxy, since bars do not reveal where in the minute each trade happened).

$$\text{VWAP}_t = \frac{\sum_{i\in W_t}\tilde p_i v_i}{\sum_{i\in W_t} v_i}\qquad\text{(session VWAP: } W_t \text{ = since 00:00 UTC)}$$

Log returns `r_i = ln(C_i/C_{i−1})` between consecutive bars. A return spanning more than 5 minutes is NULL, not stitched across an outage. Variance is additive in time, so normalise by the minutes actually covered, and annualise by 525,600 minutes because crypto trades 24/7:

$$\hat\sigma_{\text{ann}} = \sqrt{\frac{\sum_{i\in W_t} r_i^2}{\sum_{i\in W_t}\Delta t_i/60}\times 525{,}600}\qquad \hat\sigma^{\text{Park}}_{\text{ann}} = \sqrt{\frac{\overline{(\ln H_i/L_i)^2}}{4\ln 2}\times 525{,}600}$$

Correlation of **synchronous** returns (both symbols traded in that minute and the previous one), in one pass from running sums:

$$\hat\rho = \frac{nS_{xy} - S_xS_y}{\sqrt{(nS_{xx}-S_x^2)(nS_{yy}-S_y^2)}}$$

## Results

A live run against Coinbase recorded the bundled sample: 24 hours to 13 Oct 2026, 20:28 UTC, 1,440 bars per symbol, no gaps, no rejects. The ingest took about 4 seconds; an immediate second ingest fetched 0 rows (incremental).

| 60-minute window | BTC-USD | ETH-USD |
|---|---|---|
| Realised vol, median (annualised) | 34% | 51% |
| Realised vol, range | 18–71% | 25–108% |
| Parkinson vol, median | 31% | 45% |

* BTC–ETH 60-minute return correlation: median **0.88**, range 0.71–0.97.
* Parkinson ran about 10% below close-to-close volatility for both coins. That is consistent with bid-ask bounce (microstructure noise) inflating one-minute close-to-close variance.
* In the browser, the whole pipeline on the sample (engine load, upsert of 2,880 rows, quality checks, three analytic queries) completes in about 1.7 s. A live 3-hour Coinbase fetch takes about 0.35 s.

## Tests

`python -m unittest discover -s tests -t .` (19 tests, no network):

* **SQL against Python references** on synthetic bars with 3- and 8-minute holes: rolling VWAP, realised vol and rolling correlation (including window membership and `n`) match naive Python loops to 9 decimal places.
* **Statistical sanity:** realised vol recovers the true vol of a 20,000-minute simulated series within 2%; correlation of two series sharing a known factor recovers 0.49; a self-correlation is exactly 1; a flat price gives zero vol.
* **Storage:** idempotent upsert, newer bar versions replace old ones, invalid bars rejected with reasons, `CHECK` constraints enforced, session VWAP resets at midnight UTC, quality report counts gaps exactly.
* **Sources:** Coinbase paging (3 requests for 700 minutes), column order and error payloads; Kraken parsing and errors; retry with backoff on 429, using a fake transport.

`npm test` also covers the JavaScript fetchers, validation and the bundled sample file.

## Limitations

* Minute bars, not ticks. VWAP uses the typical price, and nothing inside a minute is visible.
* One venue per run. Consolidation would need symbol mapping, clock alignment and handling for venue-specific outages.
* SQLite fits millions of rows on a laptop. Tick data for many symbols belongs in a columnar store (DuckDB, ClickHouse, kdb+, Parquet), partitioned by date and symbol.
* No scheduler is included. The CLI is safe to run repeatedly from cron or CI.
