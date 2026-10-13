import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bsPrice, bsGreeks, binomialPrice, monteCarloPrice, impliedVol, priceBounds } from '../docs/options/options.js';

const base = { S: 100, K: 100, T: 1, r: 0.05, q: 0, sigma: 0.2 };
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b} (tol ${tol})`);

test('Black-Scholes matches textbook values', () => {
  // Hull's standard example: S=K=100, T=1, r=5%, sigma=20%
  close(bsPrice({ ...base, type: 'call' }), 10.450583572185565, 1e-10, 'call');
  close(bsPrice({ ...base, type: 'put' }), 5.573526022256971, 1e-10, 'put');
  // Hull example 15.6: S=42, K=40, r=10%, sigma=20%, T=0.5 -> c=4.76, p=0.81
  const h = { S: 42, K: 40, r: 0.1, sigma: 0.2, T: 0.5 };
  close(bsPrice({ ...h, type: 'call' }), 4.7594, 1e-4);
  close(bsPrice({ ...h, type: 'put' }), 0.8086, 1e-4);
});

test('put-call parity holds with dividends: C - P = S e^{-qT} - K e^{-rT}', () => {
  for (const S of [60, 95, 100, 130]) {
    for (const q of [0, 0.03]) {
      const o = { ...base, S, q, K: 105, T: 0.7, sigma: 0.35 };
      const lhs = bsPrice({ ...o, type: 'call' }) - bsPrice({ ...o, type: 'put' });
      close(lhs, S * Math.exp(-q * o.T) - o.K * Math.exp(-o.r * o.T), 1e-10);
    }
  }
});

test('analytic Greeks agree with finite differences', () => {
  for (const type of ['call', 'put']) {
    for (const S of [80, 100, 125]) {
      const o = { ...base, S, q: 0.02, type };
      const g = bsGreeks(o);
      const h = 1e-4;
      const p = (x) => bsPrice({ ...o, ...x });
      close(g.delta, (p({ S: S + h }) - p({ S: S - h })) / (2 * h), 1e-6, `${type} delta`);
      close(g.gamma, (p({ S: S + h }) - 2 * p({}) + p({ S: S - h })) / (h * h), 1e-4, `${type} gamma`);
      close(g.vega, (p({ sigma: o.sigma + h }) - p({ sigma: o.sigma - h })) / (2 * h), 1e-5, `${type} vega`);
      close(g.rho, (p({ r: o.r + h }) - p({ r: o.r - h })) / (2 * h), 1e-5, `${type} rho`);
      // theta is the derivative with respect to calendar time, i.e. -dV/dT
      close(g.theta, -(p({ T: o.T + h }) - p({ T: o.T - h })) / (2 * h), 1e-5, `${type} theta`);
    }
  }
});

test('the binomial tree converges to Black-Scholes', () => {
  for (const type of ['call', 'put']) {
    const exact = bsPrice({ ...base, type });
    const err = (n) => Math.abs(binomialPrice({ ...base, type }, n) - exact);
    assert.ok(err(1000) < 0.003, `${type} N=1000 error ${err(1000)}`);
    assert.ok(err(1000) < err(50), 'error should shrink with more steps');
  }
});

test('American options: early exercise premium for puts, none for calls without dividends', () => {
  const euPut = binomialPrice({ ...base, type: 'put' }, 800, false);
  const amPut = binomialPrice({ ...base, type: 'put' }, 800, true);
  assert.ok(amPut > euPut + 0.2, `American put ${amPut} vs European ${euPut}`);
  const euCall = binomialPrice({ ...base, type: 'call' }, 800, false);
  const amCall = binomialPrice({ ...base, type: 'call' }, 800, true);
  close(amCall, euCall, 1e-9, 'never optimal to exercise a call early without dividends');
  // Known value: American put S=K=100, T=1, r=5%, sigma=20% is about 6.09
  close(amPut, 6.09, 0.01);
});

test('Monte Carlo lies within its confidence interval of the exact price', () => {
  for (const type of ['call', 'put']) {
    const exact = bsPrice({ ...base, type });
    const mc = monteCarloPrice({ ...base, type }, { paths: 200000, seed: 11 });
    assert.ok(Math.abs(mc.price - exact) < 4 * mc.se, `${type}: ${mc.price} vs ${exact}, se ${mc.se}`);
  }
});

test('variance reduction shrinks the Monte Carlo standard error', () => {
  const o = { ...base, type: 'call' };
  const plain = monteCarloPrice(o, { paths: 100000, antithetic: false, control: false });
  const both = monteCarloPrice(o, { paths: 100000, antithetic: true, control: true });
  assert.ok(both.se < plain.se / 2, `plain ${plain.se}, reduced ${both.se}`);
});

test('implied volatility recovers the input volatility across strikes and maturities', () => {
  for (const type of ['call', 'put']) {
    for (const K of [50, 80, 100, 120, 200]) {
      for (const T of [0.05, 0.5, 2]) {
        for (const sigma of [0.08, 0.25, 0.9]) {
          const o = { ...base, K, T, type };
          const price = bsPrice({ ...o, sigma });
          const b = priceBounds(o);
          if (price - b.lo < 1e-9 || b.hi - price < 1e-9) continue; // no vega left to invert
          const iv = impliedVol(price, o);
          assert.ok(iv.ok, `${type} K=${K} T=${T} sigma=${sigma}: ${iv.reason}`);
          close(iv.sigma, sigma, 1e-6, `${type} K=${K} T=${T}`);
        }
      }
    }
  }
});

test('Newton-Raphson converges quadratically from the Manaster-Koehler start', () => {
  const o = { ...base, K: 110, type: 'call' };
  const iv = impliedVol(bsPrice({ ...o, sigma: 0.3 }), o);
  assert.ok(iv.ok);
  assert.ok(iv.iterations <= 6, `took ${iv.iterations} iterations`);
  assert.ok(iv.history.every((h) => h.method !== 'bisection'), 'pure Newton from this start');
  const errs = iv.history.map((h) => Math.abs(h.sigma - 0.3)).filter((e) => e > 1e-12);
  for (let i = 2; i < errs.length; i++) assert.ok(errs[i] < 10 * errs[i - 1] ** 2 + 1e-12, 'error should roughly square each step');
});

test('implied volatility rejects prices outside the no-arbitrage bounds', () => {
  const o = { ...base, type: 'call' };
  assert.equal(impliedVol(0.0, o).ok, false);
  assert.equal(impliedVol(150, o).ok, false);
  const put = { ...base, K: 120, type: 'put' };
  assert.equal(impliedVol(priceBounds(put).lo - 0.01, put).ok, false);
});

test('a bad starting guess falls back to bisection and still converges', () => {
  const o = { ...base, K: 100, type: 'call' };
  const iv = impliedVol(bsPrice({ ...o, sigma: 0.2 }), o, { sigma0: 9 });
  assert.ok(iv.ok);
  close(iv.sigma, 0.2, 1e-8);
  assert.ok(iv.history.some((h) => h.method === 'bisection'));
});
