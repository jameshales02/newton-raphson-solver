# Prop account risk model

**Live demo:** `docs/prop-risk/index.html`

## The problem

Funded-trader evaluations for futures ("prop challenges") charge a fee and set a profit target, a drawdown floor that often trails the best balance, a daily loss limit, a minimum number of trading days and often a time limit. A strategy with a positive expectancy can still fail most attempts, because the rules depend on the whole path, not just the average. This project simulates whole paths to answer the real questions: how likely am I to pass or blow up, how long will it take, what does each funded account cost in fees, and what position size gives the best odds?

## Files

| File | What it is |
|---|---|
| `propsim.js` | Rules engine (`simulateAccount`), Monte Carlo, size sweep, trade moments, gambler's-ruin formula with overshoot correction, expected value. |
| `app.js` | The page: rule and strategy inputs, outcome breakdown, sample paths, time-to-outcome histograms, size sweep, analytic cross-check. |
| `../../tests/propsim.test.js` | 11 tests. |

## Rules modelled

* **Target** `a` above the start balance `B₀`, checked at the close, after at least `minDays` trading days. After hitting it the trader stops for the day, and completes any remaining minimum days at negligible risk.
* **Drawdown floor** `F`, initially `B₀ − b`:
  * static: fixed;
  * trailing end-of-day: `F_t = max(F_{t−1}, min(H_t − b, L))`, where `H_t` is the highest close so far and `L` the lock level (the start balance by default);
  * trailing intraday: the same, updated after every trade.

  Touching the floor fails the account immediately.
* **Daily loss limit** `D`: stop for the day, or fail, depending on the firm.
* **Time limit** `T_max` trading days, otherwise the attempt times out.

## Strategy model

Per contract, a trade wins with probability `p`. Win and loss sizes are lognormal around `W` and `L$` with coefficient of variation `c`. With probability `π` a loss is a gap/slippage loss `m` times larger. Then

$$\mu = pW - (1-p)L_\$\big(1+\pi(m-1)\big),\qquad \sigma^2 = pW^2(1+c^2) + (1-p)L_\$^2(1+c^2)\big(1+\pi(m^2-1)\big) - \mu^2$$

With `n` contracts the mean is `nμ` and the variance `n²σ²`. Alternatively, paste real trade results and the model resamples them (iid bootstrap).

Defaults: 45% win rate, $150 average win, $100 average loss per contract (for example an MES trade risking 20 points for 30), 2% of losses three times larger, 3 trades a day. That gives an edge of about $10 per contract per trade against a standard deviation of about $143.

## The maths: why size matters

Without the daily limit, trailing and the clock, the balance is a random walk with drift `nμ` and variance `n²σ²` between barriers `+a` and `−b`. Gambler's ruin for Brownian motion gives

$$P(\text{pass}) = \frac{1 - e^{-2\mu b/(n\sigma^2)}}{1 - e^{-2\mu(a+b)/(n\sigma^2)}},\qquad \mathbb E[\text{trades}] = \frac{aP - b(1-P)}{n\mu}$$

* Bigger `n` shrinks the exponent. Odds drift towards `b/(a+b)` (a weighted coin toss) and the edge stops mattering.
* Smaller `n` makes the expected time grow like `1/n`, so a time limit bites.
* **Overshoot correction:** a real walk jumps past a barrier. Siegmund's corrected diffusion approximation moves both barriers out by `ρ·nσ`, with `ρ = −ζ(½)/√(2π) ≈ 0.583`.

Economics: `EV = P(pass) · V_funded − fee`, and the expected number of attempts per pass is `1/P(pass)`.

## Results (defaults: $50k account, $3k target, $2k EOD trailing drawdown locking at start, $1k daily limit, 60 days)

| Contracts | Risk per trade | Pass | Blow up | Time out | Median days to pass |
|---|---|---|---|---|---|
| 1 | 5% of buffer | 37% | 19% | 44% | 40 |
| **2** | 10% | **54%** | 45% | 1% | 18 |
| 3 | 15% | 48% | 52% | 0% | 9 |
| 6 | 30% | 45% | 55% | 0% | 5 |

* The best size is 2 contracts (10% of the drawdown buffer per trade). Smaller sizes run out of time; larger ones turn each attempt into a coin toss.
* Even with a real edge, about half of attempts fail. Expect roughly two fees per funded account.
* Rules matter as much as the strategy. At 2 contracts: static floor 65% pass, end-of-day trailing 54%, intraday trailing 51%; making the daily limit a hard fail cuts the pass rate to 48%.

**Analytic cross-check** (static floor, no daily limit, no time limit, one trade per day). The overshoot-corrected formula matches the simulation within sampling error:

| Contracts | Plain Brownian | Overshoot-corrected | Monte Carlo (40,000 attempts) |
|---|---|---|---|
| 1 | 87.1% | 88.1% | 88.5% ± 0.3 |
| 2 | 69.0% | 71.2% | 71.3% ± 0.5 |
| 4 | 55.2% | 58.4% | 58.1% ± 0.5 |
| 8 | 47.6% | 51.9% | 51.2% ± 0.5 |

(The ρ constant is exact for Gaussian steps. For a fixed-size two-point trade distribution it over-corrects slightly, as expected, because the overshoot depends on the step distribution.)

## Tests

`npm test` runs `tests/propsim.test.js`: outcomes sum to 1; deterministic always-win and always-lose paths hit the target and floor on the exact expected day; daily-limit stop and fail behaviour; the trailing floor follows highs and locks; intraday ≥ EOD ≥ static failure ordering; simulated trade moments match the formulas; Monte Carlo matches the corrected gambler's ruin within 1.5 percentage points; size sweep monotonicity; bootstrap parsing and sampling.

## Limitations

* Trades are iid. Real results cluster (tilt, regimes, volatility), which lowers pass rates. A block bootstrap of real history would help.
* Trades are atomic. Many firms trail open (unrealised) equity, which is stricter, and some auto-liquidate exactly at the daily limit where this model allows overshoot.
* No consistency rules, scaling plans or payout rules. The value of a funded account is one number you supply.
* Fixed size and trade count. Adapting size to the distance from the floor is the natural next model.
