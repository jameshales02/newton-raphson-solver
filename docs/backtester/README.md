# Event-driven backtester

**Live demo:** `docs/backtester/index.html`

## The problem

A backtest estimates what a trading rule would have earned. It is easy to get a wrong answer that looks great. The two classic ways are **look-ahead bias** (using information before it existed) and **overfitting** (trying enough variations that one fits the noise). This engine makes look-ahead impossible by construction, checks that automatically, and measures overfitting instead of ignoring it.

## Files

| File | What it is |
|---|---|
| `backtest.js` | Engine (event queue, point-in-time feed, execution, portfolio), strategies, metrics, look-ahead audit, deflated Sharpe, walk-forward. |
| `app.js` | The page: controls, equity/drawdown/exposure charts, audit table, trade list, overfitting lab. |
| `../../tests/backtest.test.js` | 12 tests covering bias, accounting, costs, sizing, metrics and the statistics. |

## Design choices

### Event loop

```
MARKET(t) -> fill orders queued at t-1 at OPEN(t) -> FILL -> portfolio
          -> strategy.onBar(feed@t) -> SIGNAL -> sizing -> ORDER -> queued for t+1
          -> mark to market at CLOSE(t)
```

* **Point-in-time feed.** The strategy receives an object with `bar(k)`, `close(k)` and `closes(n)` that only reach back from bar *t*. There is no array to index into, so future bars are unreachable by construction.
* **Incremental indicators** (ring-buffer rolling sums): O(1) per bar, and nothing is ever computed over the whole history.
* **Execution lag:** a decision on the close of bar *t* fills at the open of bar *t+1*.

### Slippage, fees, sizing

$$p_{\text{fill}} = p_{\text{open}}\left(1 + \operatorname{sign}(Q)\left[\tfrac{s}{2} + \eta\,\hat\sigma\sqrt{|Q|/V}\right]\right)$$

* Half-spread `s/2` plus **square-root market impact**, with `σ̂` (20-day daily vol) and `V` (20-day ADV) estimated from **past bars only**.
* Commission `max(c_min, c·|Q|)` plus an optional bps fee.
* **Volatility targeting:** `shares = floor(signal · min(L, σ_target/σ̂_ann) · equity / price)`, with a 20% rebalance band to avoid churn. A fixed-fraction mode is also available.

### Metrics

* Sharpe `= √252 · mean(r)/sd(r)`, with Lo's (2002) standard error `SE ≈ √252 · √((1 + SR_d²/2)/T)`.
* Sortino, CAGR, annualised vol, max drawdown `max_t(1 − E_t / max_{u≤t} E_u)` and the longest underwater period.
* **Win rate** over round trips (flat to flat, or through a reversal) using average-cost accounting with commissions, plus profit factor.

## How look-ahead bias is avoided (and proven absent)

1. **Construction:** the strategy cannot reach future bars, and fills happen at the next open.
2. **Slippage inputs** come from earlier bars, never the bar being traded.
3. **Automated audit (`lookaheadAudit`):** on days the strategy traded, change that day's close **and** scramble every later bar, then re-run. No fill on or before that day may change in time, quantity or price. The correct engine passes. Two deliberately biased fill modes (`same_close`, `same_open`) fail.
4. **Future-invariance test:** scaling every bar after day 500 by 1.3 leaves equity up to day 500 identical, bit for bit.

How much it matters: 1-day momentum on a random walk has a Sharpe of **−0.44** with correct execution (average of 10 seeds; daily turnover costs money). Filling at the open of the bar whose close produced the signal gives **+6.37**, and every seed was above 5.5.

## How overfitting is measured

* **Holdout:** a grid of 38 moving-average pairs is fitted on the first 60% of history and evaluated on the last 40%.
* **Deflated Sharpe ratio** (Bailey & López de Prado, 2014). The best of *N* trials with zero skill has an expected Sharpe of

  $$\text{SR}_0 = \sqrt{\operatorname{Var}[\widehat{\text{SR}}_n]}\left[(1-\gamma)\Phi^{-1}\!\left(1-\tfrac1N\right) + \gamma\,\Phi^{-1}\!\left(1-\tfrac{1}{Ne}\right)\right]$$

  and the DSR is

  $$\text{DSR} = \Phi\!\left(\frac{(\widehat{\text{SR}}-\text{SR}_0)\sqrt{T-1}}{\sqrt{1-\hat\gamma_3\widehat{\text{SR}}+\frac{\hat\gamma_4-1}{4}\widehat{\text{SR}}^2}}\right)$$

* **Walk-forward:** re-fit on a rolling two-year window, trade the next six months, stitch only out-of-sample periods.
* **Synthetic data with a known answer.** Log price = random walk with optional slowly varying drift, plus an optional Ornstein–Uhlenbeck deviation. On the random walk no strategy has an edge, so any profit is overfitting by definition.

## Results

Averages over 20 independent ten-year histories per process (default costs, 15% vol target):

| Process | Best in-sample Sharpe | Its out-of-sample Sharpe | Walk-forward Sharpe | DSR > 0.95 |
|---|---|---|---|---|
| Random walk (no edge) | 0.54 | 0.13 | −0.01 | 0 / 20 |
| Upward drift (no timing edge) | 0.67 | 0.11 | 0.12 | 0 / 20 |
| Persistent trends (real edge) | 1.11 | 0.71 | 0.62 | 8 / 20 |

* A parameter search always finds an in-sample Sharpe of 0.5 or more, even in noise. The out-of-sample result shows what it was worth.
* The DSR raised **no false positives in 40 histories without an edge**. It detected the real edge 8 times out of 20, which is conservative but honest: a true Sharpe near 0.7 is hard to prove with ten years of daily data (SE ≈ 0.32).
* Each synthetic process carries the edge it was designed for, and only that edge. Mean Sharpe over 30 seeds (± one standard deviation across seeds):

| Process | MA 20/100 | 60-day momentum | Z-score reversion | Buy and hold |
|---|---|---|---|---|
| Random walk | 0.00 ± 0.30 | 0.01 ± 0.27 | 0.03 ± 0.24 | 0.05 ± 0.32 |
| Persistent trends | **0.64** ± 0.35 | **0.57** ± 0.38 | −0.44 ± 0.36 | 0.06 ± 0.74 |
| Mean-reverting | −0.31 ± 0.29 | −0.54 ± 0.26 | **0.49** ± 0.27 | 0.06 ± 0.22 |
| Upward drift | 0.07 ± 0.31 | 0.03 ± 0.33 | −0.04 ± 0.27 | **0.48** ± 0.32 |

## Tests

`npm test` runs `tests/backtest.test.js`: point-in-time feed, future invariance, audit pass and fail cases, size of the look-ahead effect, next-open fills, P&L reconciliation between trades and equity, costs on every fill, vol targeting within ±2% of target, incremental against naive indicators, hand-computed metrics, PSR/DSR limiting cases, regime edges, and CSV parsing.

## Limitations

* Single instrument, daily bars. No short borrow costs, dividends or corporate actions; uploaded data should be adjusted.
* Market-on-open fills with modelled slippage. No limit orders, partial fills or intraday paths.
* The 38 MA pairs are highly correlated, so the effective number of trials is lower than 38 and the DSR is conservative.
* Walk-forward stitching ignores parameter-switch costs at window boundaries.
* Synthetic returns are Gaussian. Real returns have fat tails and volatility clustering, which make every estimate noisier.
