# Options pricer and Greeks dashboard

**Live demo:** `docs/options/index.html`

## The problem

Price a European or American option three independent ways, show how its risk sensitivities (the Greeks) change as the inputs move, and invert a market price into implied volatility. The pricers check each other: if the closed form, the tree and the simulation disagree, something is wrong.

## Files

| File | What it is |
|---|---|
| `options.js` | Black–Scholes–Merton price and Greeks, CRR binomial tree (European/American), Monte Carlo with antithetic and control variates, no-arbitrage bounds, implied-vol solver. |
| `app.js` | The page: sliders, price tiles, value and Greek curves, convergence charts, solver with an iteration table. |
| `../../tests/options.test.js` | 11 tests. |
| `../../newton_solve.py` | The repository's original multi-dimensional Newton–Raphson solver. The IV solver is its scalar, safeguarded counterpart. |

## Formulas implemented

**Black–Scholes–Merton** with continuous dividend yield q:

$$d_1 = \frac{\ln(S/K) + (r - q + \tfrac12\sigma^2)T}{\sigma\sqrt T},\quad d_2 = d_1 - \sigma\sqrt T$$

$$C = Se^{-qT}N(d_1) - Ke^{-rT}N(d_2),\qquad P = Ke^{-rT}N(-d_2) - Se^{-qT}N(-d_1)$$

**Greeks** (φ = standard normal pdf):

$$\Delta_C = e^{-qT}N(d_1),\ \ \Delta_P = -e^{-qT}N(-d_1),\ \ \Gamma = \frac{e^{-qT}\varphi(d_1)}{S\sigma\sqrt T},\ \ \mathcal V = Se^{-qT}\varphi(d_1)\sqrt T$$

$$\Theta_C = -\frac{Se^{-qT}\varphi(d_1)\sigma}{2\sqrt T} - rKe^{-rT}N(d_2) + qSe^{-qT}N(d_1),\qquad \rho_C = KTe^{-rT}N(d_2)$$

(put theta and rho use N(−d₂), N(−d₁) with the signs flipped). Displayed as vega per vol point, theta per calendar day and rho per 1% in rates.

**Binomial tree (Cox–Ross–Rubinstein):**

$$u = e^{\sigma\sqrt{\Delta t}},\ d = 1/u,\ p = \frac{e^{(r-q)\Delta t}-d}{u-d},\qquad V_{i,j} = \max\left(e^{-r\Delta t}[pV_{i+1,j+1} + (1-p)V_{i+1,j}],\ \text{payoff}\right)$$

The max term is applied for American exercise only. Cost is O(N²) time and O(N) memory.

**Monte Carlo:** exact terminal sampling `S_T = S exp((r − q − σ²/2)T + σ√T Z)` with

* antithetic pairs (Z, −Z), and
* a control variate X = e^{−rT}S_T with known mean Se^{−qT}: `V̂ = Ȳ − β̂(X̄ − Se^{−qT})`, `β̂ = Cov(X,Y)/Var(X)`.

The standard error is `s/√n`, and the confidence interval is ±1.96 SE.

**Implied volatility (Newton–Raphson):**

$$\sigma_{n+1} = \sigma_n - \frac{\text{BS}(\sigma_n) - P_{\text{mkt}}}{\mathcal V(\sigma_n)}$$

Safeguards:

1. **Existence:** the price must lie strictly inside the no-arbitrage bounds, `max(Se^{−qT} − Ke^{−rT}, 0) < C < Se^{−qT}` (and the put analogue). Otherwise the solver reports that no IV exists.
2. **Start at the Manaster–Koehler point** `σ₀ = √(2|ln(F/K)|/T)`, the inflection point of price in σ. Newton then converges monotonically. At the money it uses Brenner–Subrahmanyam: `σ₀ ≈ √(2π/T) · C/(Se^{−qT})`.
3. **Bracketing:** price is increasing in σ, so each evaluation tightens [lo, hi]. A Newton step that leaves the bracket, or a near-zero vega, triggers a bisection step instead.

## Design choices

* **Accurate normal CDF** (Hart's algorithm, ~1e-16), so pricer disagreements are numerical-method error, not CDF error.
* **Three pricers from first principles**, not wrappers, so they cross-validate each other.
* **Common seed** for Monte Carlo, so moving a slider doesn't make the estimate jump from fresh noise.

## Results

* Hull's standard example (S=K=100, T=1, r=5%, σ=20%): call **10.4506**, put **5.5735**. The tree at N=1000 is within 0.003. The American put is **≈ 6.09**, an early-exercise premium of about 0.52.
* Antithetic plus control variates cut the Monte Carlo standard error by more than half at a fixed path count, worth more than 4× the paths.
* The IV solver converges in **3 Newton steps** to |error| < 1e-14 for the at-the-money example, and in at most 6 from the Manaster–Koehler start in the tests. From a deliberately bad start (σ₀ = 300%) the bisection fallback brings it back.

## Tests

`npm test` runs `tests/options.test.js`: textbook prices; put-call parity with dividends to 1e-10; all five Greeks against central finite differences; binomial convergence; American put premium and American call = European call without dividends; Monte Carlo within 4 SE; variance reduction; IV round-trips across strikes 50–200, maturities 0.05–2 years and vols 8–90%; quadratic convergence; rejection of arbitrage-violating prices; recovery from a bad start.

## Limitations

* Constant volatility and rates. Real markets have a smile and skew, so implied vol differs by strike.
* Continuous dividend yield only, no discrete dividends. Frictionless, continuous hedging is assumed.
* Plain CRR tree, without Richardson extrapolation or smoothing at the strike.
* Monte Carlo prices European payoffs only. American exercise by simulation would need Longstaff–Schwartz.
