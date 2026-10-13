# Trading Systems Portfolio

Six trading systems that run in the browser, each with its own README, written-out formulas, stated limitations and tests:

| # | Project | What it shows | Demo | README | Tests |
|---|---|---|---|---|---|
| 1 | **Order book & matching engine** | Price-time priority; limit, market and cancel orders; partial fills; live depth chart and tape; 3.3–4.0M orders/s | [page](docs/order-book/index.html) | [README](docs/order-book/README.md) | [12](tests/orderbook.test.js) |
| 2 | **Market-making simulator** | Avellaneda–Stoikov quoting with inventory skew; exact P&L attribution; replicates the paper's Table 1 | [page](docs/market-making/index.html) | [README](docs/market-making/README.md) | [8](tests/marketmaker.test.js) |
| 3 | **Event-driven backtester** | Next-open fills, square-root impact, fees, vol targeting; look-ahead audit; deflated Sharpe; walk-forward | [page](docs/backtester/index.html) | [README](docs/backtester/README.md) | [12](tests/backtest.test.js) |
| 4 | **Options pricer & Greeks** | Black–Scholes, binomial (American), Monte Carlo with variance reduction; Newton–Raphson implied vol | [page](docs/options/index.html) | [README](docs/options/README.md) | [11](tests/options.test.js) |
| 5 | **Prop account risk model** | Monte Carlo of a futures strategy against trailing drawdown, daily loss limit, target and time limit | [page](docs/prop-risk/index.html) | [README](docs/prop-risk/README.md) | [11](tests/propsim.test.js) |
| 6 | **Market data pipeline** | Coinbase/Kraken minute bars into SQLite; VWAP, realised vol and correlation as SQL window functions | [page](docs/data-pipeline/index.html) | [README](docs/data-pipeline/README.md) | [19 Python](docs/data-pipeline/python/tests) + [5](tests/pipeline.test.js) |

The live site is the `docs/` folder, served as-is by GitHub Pages: no build step, no bundler, no npm dependencies.

## Run it

```bash
# the site (ES modules need a web server, not file://)
python3 -m http.server 8000 --directory docs     # then open http://localhost:8000

# tests: 59 JavaScript (Node 22+, no packages to install) + 19 Python (3.10+, stdlib only)
npm test
cd docs/data-pipeline/python && python -m unittest discover -s tests -t .

# order book throughput and latency benchmark
npm run bench

# market data pipeline CLI
cd docs/data-pipeline/python
python -m marketdata ingest --db market.db --symbols BTC-USD ETH-USD --hours 24
python -m marketdata stats  --db market.db --symbol BTC-USD --window 30
```

### Publish with GitHub Pages

Settings → Pages → *Build and deployment* → Source: **Deploy from a branch**, Branch: `main`, folder: **`/docs`**. The site then appears at `https://jameshales02.github.io/newton-raphson-solver/`. GitHub Actions (`.github/workflows/ci.yml`) runs both test suites on every push.

## Layout

```
docs/                          GitHub Pages root
├── index.html, home.js        landing page with a live order book
├── assets/                    shared: site.css, chart.js (canvas charts), rng.js (seeded RNG), stats.js, ui.js
├── order-book/                orderbook.js (engine), flow.js (order flow + benchmark), app.js, README.md
├── market-making/             marketmaker.js, app.js, README.md
├── backtester/                backtest.js, app.js, README.md
├── options/                   options.js, app.js, README.md
├── prop-risk/                 propsim.js, app.js, README.md
└── data-pipeline/             sql/ (shared), python/marketdata/ (CLI), pipeline.js, app.js, sample/, README.md
tests/                         node:test suites, one per project
bench/orderbook-bench.js       throughput + latency percentiles
```

Each engine (`orderbook.js`, `marketmaker.js`, `backtest.js`, `options.js`, `propsim.js`, `pipeline.js`) is a plain ES module with no DOM access. The page imports it and so do the tests, so **what you see in the browser is the tested code**.

## Principles

* **Honest maths.** Every page and README writes out the formulas implemented, reports uncertainty (standard errors, confidence intervals) next to estimates, and says where results differ from theory or the literature, and why.
* **Test against something independent.** Rule tests, plus comparisons with naive reference implementations (a brute-force matcher, Python loops for SQL window functions), closed forms (put-call parity, gambler's ruin, Greeks against finite differences) and published results (Avellaneda–Stoikov Table 1, Hull's textbook values).
* **Reproducible.** All simulations use a seeded PRNG, so the same seed gives the same result on every machine.

## The original Newton–Raphson solver

This repository started as a Newton–Raphson solver for nonlinear systems (`newton_solve.py`), applied to the equilibrium of a hanging chain (`Chain_N*.py`, `EnergyMinimisation.py`, `run_convergence_export_csv.py`). Those files are unchanged at the repository root. The options project's implied-volatility solver is the scalar, safeguarded version of the same method: Newton steps with the analytic derivative (vega), a starting point chosen where convergence is monotone, and a bisection fallback that keeps the iterate inside a bracket.
