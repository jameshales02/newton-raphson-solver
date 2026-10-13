// Option pricing: Black-Scholes-Merton with analytic Greeks, a Cox-Ross-Rubinstein
// binomial tree (European and American), Monte Carlo with antithetic variates and
// a control variate, and an implied-volatility solver (safeguarded Newton-Raphson).
//
// Conventions: S spot, K strike, T years, r continuously compounded risk-free rate,
// q continuous dividend yield, sigma annualised volatility, type 'call' | 'put'.

import { normCdf, normPdf } from '../assets/stats.js';
import { RNG } from '../assets/rng.js';

export function d1d2({ S, K, T, r, q = 0, sigma }) {
  const v = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / v;
  return { d1, d2: d1 - v };
}

export function bsPrice(o) {
  const { S, K, T, r, q = 0, sigma, type } = o;
  const dfq = Math.exp(-q * T);
  const dfr = Math.exp(-r * T);
  if (T <= 0 || sigma <= 0) {
    // limit: the discounted forward intrinsic value
    const fwd = S * dfq - K * dfr;
    return type === 'call' ? Math.max(0, fwd) : Math.max(0, -fwd);
  }
  const { d1, d2 } = d1d2(o);
  return type === 'call' ? S * dfq * normCdf(d1) - K * dfr * normCdf(d2) : K * dfr * normCdf(-d2) - S * dfq * normCdf(-d1);
}

// Greeks in raw units: vega per 1.00 of vol, theta per year, rho per 1.00 of rate.
export function bsGreeks(o) {
  const { S, K, T, r, q = 0, sigma, type } = o;
  const dfq = Math.exp(-q * T);
  const dfr = Math.exp(-r * T);
  const { d1, d2 } = d1d2(o);
  const pdf = normPdf(d1);
  const sqrtT = Math.sqrt(T);
  const gamma = (dfq * pdf) / (S * sigma * sqrtT);
  const vega = S * dfq * pdf * sqrtT;
  const common = (-S * dfq * pdf * sigma) / (2 * sqrtT);
  if (type === 'call') {
    return {
      delta: dfq * normCdf(d1),
      gamma,
      vega,
      theta: common - r * K * dfr * normCdf(d2) + q * S * dfq * normCdf(d1),
      rho: K * T * dfr * normCdf(d2),
    };
  }
  return {
    delta: -dfq * normCdf(-d1),
    gamma,
    vega,
    theta: common + r * K * dfr * normCdf(-d2) - q * S * dfq * normCdf(-d1),
    rho: -K * T * dfr * normCdf(-d2),
  };
}

// Cox-Ross-Rubinstein tree. O(N^2) time, O(N) memory.
export function binomialPrice({ S, K, T, r, q = 0, sigma, type }, steps = 200, american = false) {
  const dt = T / steps;
  const u = Math.exp(sigma * Math.sqrt(dt));
  const d = 1 / u;
  const growth = Math.exp((r - q) * dt);
  const p = (growth - d) / (u - d);
  if (!(p > 0 && p < 1)) throw new RangeError('no-arbitrage violated: increase steps or check inputs');
  const disc = Math.exp(-r * dt);
  const pay = type === 'call' ? (x) => Math.max(0, x - K) : (x) => Math.max(0, K - x);
  const v = new Float64Array(steps + 1);
  for (let j = 0; j <= steps; j++) v[j] = pay(S * Math.pow(u, j) * Math.pow(d, steps - j));
  for (let i = steps - 1; i >= 0; i--) {
    for (let j = 0; j <= i; j++) {
      const cont = disc * (p * v[j + 1] + (1 - p) * v[j]);
      v[j] = american ? Math.max(cont, pay(S * Math.pow(u, j) * Math.pow(d, i - j))) : cont;
    }
  }
  return v[0];
}

// Monte Carlo under the risk-neutral measure: S_T = S exp((r - q - sigma^2/2)T + sigma sqrt(T) Z).
// Antithetic pairs (Z, -Z) and, optionally, the discounted terminal price as a control
// variate (its expectation S e^{-qT} is known exactly). Returns the estimate, its
// standard error and a running estimate for convergence plots.
export function monteCarloPrice(o, { paths = 100000, seed = 7, antithetic = true, control = true, checkpoints = 60 } = {}) {
  const { S, K, T, r, q = 0, sigma, type } = o;
  const rng = new RNG(seed);
  const drift = (r - q - 0.5 * sigma * sigma) * T;
  const vol = sigma * Math.sqrt(T);
  const disc = Math.exp(-r * T);
  const pay = type === 'call' ? (x) => Math.max(0, x - K) : (x) => Math.max(0, K - x);
  const n = antithetic ? Math.floor(paths / 2) : paths; // number of independent samples
  const ys = new Float64Array(n);
  const xs = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const z = rng.normal();
    const s1 = S * Math.exp(drift + vol * z);
    if (antithetic) {
      const s2 = S * Math.exp(drift - vol * z);
      ys[i] = 0.5 * disc * (pay(s1) + pay(s2));
      xs[i] = 0.5 * disc * (s1 + s2);
    } else {
      ys[i] = disc * pay(s1);
      xs[i] = disc * s1;
    }
  }
  const ex = S * Math.exp(-q * T); // E[x], known
  let b = 0;
  if (control) {
    let mx = 0;
    let my = 0;
    for (let i = 0; i < n; i++) {
      mx += xs[i];
      my += ys[i];
    }
    mx /= n;
    my /= n;
    let cov = 0;
    let vx = 0;
    for (let i = 0; i < n; i++) {
      cov += (xs[i] - mx) * (ys[i] - my);
      vx += (xs[i] - mx) ** 2;
    }
    b = vx > 0 ? cov / vx : 0;
  }
  // running mean and standard error with Welford's algorithm
  let mean = 0;
  let m2 = 0;
  const run = { n: [], est: [], lo: [], hi: [] };
  const marks = new Set();
  for (let k = 0; k < checkpoints; k++) marks.add(Math.max(10, Math.round(n ** ((k + 1) / checkpoints))));
  for (let i = 0; i < n; i++) {
    const y = ys[i] - b * (xs[i] - ex);
    const delta = y - mean;
    mean += delta / (i + 1);
    m2 += delta * (y - mean);
    if (marks.has(i + 1)) {
      const se = Math.sqrt(m2 / i / (i + 1));
      run.n.push((i + 1) * (antithetic ? 2 : 1));
      run.est.push(mean);
      run.lo.push(mean - 1.96 * se);
      run.hi.push(mean + 1.96 * se);
    }
  }
  const se = Math.sqrt(m2 / (n - 1) / n);
  return { price: mean, se, ci: [mean - 1.96 * se, mean + 1.96 * se], paths: n * (antithetic ? 2 : 1), beta: b, run };
}

// Model-free no-arbitrage bounds for a European option.
export function priceBounds({ S, K, T, r, q = 0, type }) {
  const fs = S * Math.exp(-q * T);
  const fk = K * Math.exp(-r * T);
  return type === 'call' ? { lo: Math.max(0, fs - fk), hi: fs } : { lo: Math.max(0, fk - fs), hi: fk };
}

// Implied volatility by Newton-Raphson on f(sigma) = BS(sigma) - price, with f'(sigma) = vega.
//   * starts at the Manaster-Koehler point sigma0 = sqrt(2|ln(F/K)|/T), where vega peaks
//     and the price is convex/concave on either side, so Newton converges monotonically;
//     at the money it uses the Brenner-Subrahmanyam estimate sqrt(2 pi / T) * C / S
//   * keeps a bracket [lo, hi] and falls back to bisection whenever a Newton step would
//     leave it or vega is tiny, so it always converges
export function impliedVol(price, o, { tol = 1e-10, maxIter = 100, sigma0 } = {}) {
  const b = priceBounds(o);
  if (!(price > b.lo && price < b.hi)) {
    return { ok: false, reason: `price must lie strictly between the no-arbitrage bounds ${b.lo.toFixed(4)} and ${b.hi.toFixed(4)}`, history: [] };
  }
  const F = o.S * Math.exp((o.r - (o.q || 0)) * o.T);
  const m = Math.abs(Math.log(F / o.K));
  let sigma = sigma0 ?? (m > 1e-3 ? Math.sqrt((2 * m) / o.T) : Math.sqrt((2 * Math.PI) / o.T) * (price / (o.S * Math.exp(-(o.q || 0) * o.T))));
  let lo = 1e-9;
  let hi = 10;
  sigma = Math.min(Math.max(sigma, 1e-4), hi);
  const history = [];
  for (let it = 0; it < maxIter; it++) {
    const f = bsPrice({ ...o, sigma }) - price;
    const vega = bsGreeks({ ...o, sigma }).vega;
    history.push({ iter: it, sigma, error: f, vega });
    if (Math.abs(f) < tol) return { ok: true, sigma, iterations: it, history };
    if (f > 0) hi = sigma;
    else lo = sigma;
    let next = sigma - f / vega;
    let method = 'newton';
    if (!(vega > 1e-12) || !(next > lo && next < hi)) {
      next = 0.5 * (lo + hi);
      method = 'bisection';
    }
    history[history.length - 1].method = method;
    if (Math.abs(next - sigma) < 1e-15) return { ok: true, sigma: next, iterations: it + 1, history };
    sigma = next;
  }
  return { ok: false, reason: 'did not converge', sigma, history };
}
