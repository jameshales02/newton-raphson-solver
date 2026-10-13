# Market-making simulator

**Live demo:** `docs/market-making/index.html`

## The problem

A market maker posts a bid below fair value and an ask above it. When buyers and sellers arrive in balance, it keeps the spread without holding anything. They rarely arrive in balance. Inventory builds up, and the maker is exposed to price moves (**inventory risk**) and to traders who know where the price is going (**adverse selection**).

This project simulates a bot that quotes around a fair value, manages inventory by skewing its quotes, and decomposes P&L so you can see where money is made and lost.

## Files

| File | What it is |
|---|---|
| `marketmaker.js` | The simulator: quoting rules, path simulation with exact P&L attribution, Monte Carlo with common random numbers. |
| `app.js` | The page: controls, charts of quotes, fills, inventory and P&L, Monte Carlo comparison. |
| `../../tests/marketmaker.test.js` | Closed-form checks, attribution identity, limits, statistical comparisons. |

## Model and formulas

Following Avellaneda & Stoikov (2008):

* Mid price: arithmetic Brownian motion, simulated as a binomial walk `S(t+dt) = S(t) ± σ√dt`.
* Fills: market orders hit a quote at distance δ from the mid with Poisson intensity

  $$\lambda(\delta) = A e^{-k\delta}, \qquad P(\text{fill in } dt) = \lambda(\delta)\,dt$$

* The maker maximises `E[-exp(-γ (X_T + q_T S_T))]`. To first order in inventory, the HJB solution gives

  $$r(s,q,t) = s - q\gamma\sigma^2(T-t) \qquad \text{(reservation price)}$$

  $$\delta^a + \delta^b = \gamma\sigma^2(T-t) + \frac{2}{\gamma}\ln\left(1+\frac{\gamma}{k}\right) \qquad \text{(total spread, centred on } r\text{)}$$

Three quoting rules are compared on identical random numbers:

| Rule | Bid / ask |
|---|---|
| Inventory skew (Avellaneda–Stoikov) | `r ∓ spread/2` |
| Symmetric | `s ∓ spread/2` (same spread, ignores inventory) |
| Linear skew | `s − κq ∓ h` (fixed half-spread h, skew κ per unit) |

### Extensions

* **Adverse selection:** each fill is informed with probability π, and the mid then jumps by J against the maker.
* **Inventory limit:** stop quoting the side that would push |q| past q_max.
* **Maker rebate or fee** per unit filled.

### Exact P&L attribution

Marking inventory to the mid, terminal P&L splits exactly into:

$$\Pi_T = \underbrace{\sum_{\text{fills}} |p - s|}_{\text{spread capture}} + \underbrace{\sum_t q_t \,\Delta S^{\text{diff}}_t}_{\text{inventory P\&L}} + \underbrace{\sum_t q_t\,\Delta S^{\text{jump}}_t}_{\text{adverse selection}} + \text{rebates}$$

The tests assert this identity to 1e-9 on every path.

## Design choices

* **Binomial mid and `λ dt` fill probabilities, as in the paper**, so the results can be compared with its Table 1 directly.
* **Common random numbers:** every step draws the same five uniforms in the same order whatever happens, so path *i* sees identical randomness under every strategy. Strategy comparisons then have far lower variance than independent runs.
* **Attribution is computed as the simulation runs**, not reconstructed afterwards, so the identity is a real check.

## Results

1,000 paths with the paper's parameters (s₀=100, T=1, σ=2, dt=0.005, A=140, k=1.5):

| γ = 0.1 | Mean P&L | Std P&L | Std final q | Paper mean | Paper std | Paper std q |
|---|---|---|---|---|---|---|
| Inventory skew (A–S) | 65.1 | 6.6 | 2.9 | 62.9 | 5.9 | 2.8 |
| Symmetric | 68.1 | 12.8 | 8.3 | 67.2 | 13.4 | 8.7 |
| Linear skew (h=0.65, κ=0.05) | 67.8 | 6.9 | 2.2 | – | – | – |

* The paper's headline replicates. Inventory skew gives up about 3 of mean profit and halves the standard deviation, roughly doubling profit per unit of risk.
* One known difference: the paper's reported average spread (1.29) equals `(2/γ)ln(1+γ/k)` alone. This simulator includes the `γσ²(T−t)` term as the formula states, so its average quoted spread is 1.49.
* **Adverse selection** with 30% informed fills and J = 0.5 costs 6.6 (A–S), 10.4 (symmetric) and 6.7 (linear), 10–15% of the spread captured. The inventory-aware rules lose less because they carry less inventory into each jump.
* A hand-tuned linear skew does about as well as A–S here. The model's value is a principled mapping from γ, σ and k to the skew and the spread.

## Tests

`npm test` runs `tests/marketmaker.test.js`: closed forms for r and the spread; symmetric and linear quote placement; the attribution identity (all strategies, with toxic flow and rebates); positive spread capture per fill; inventory limits never breached; determinism; and, with a fixed seed, lower P&L and inventory dispersion under skew and lower P&L under toxic flow.

## Limitations

* Fills depend only on distance from the mid. There is no queue position, order book, latency or competing makers.
* One unit per fill, at most one fill per side per step, and a driftless mid with no volatility clustering.
* Informed flow is a stylised jump.
* The quotes come from a first-order approximation. Guéant, Lehalle & Fernandez-Tapia (2013) give the exact solution with inventory constraints.
