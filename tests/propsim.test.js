import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulateAccount, monteCarlo, gamblersRuin, tradeMoments, sweep, parseSample, expectedValue, DEFAULT_RULES, DEFAULT_STRATEGY } from '../docs/prop-risk/propsim.js';
import { RNG } from '../docs/assets/rng.js';

const fixed = (pnl, extra = {}) => ({ ...DEFAULT_STRATEGY, winRate: pnl > 0 ? 1 : 0, avgWin: Math.abs(pnl), avgLoss: Math.abs(pnl), dispersion: 0, tailProb: 0, contracts: 1, tradesPerDay: 1, ...extra });

test('outcome probabilities sum to one', () => {
  const r = monteCarlo(DEFAULT_RULES, DEFAULT_STRATEGY, { accounts: 3000 });
  assert.ok(Math.abs(r.pPass + r.pFailDD + r.pFailDLL + r.pTimeout - 1) < 1e-12);
});

test('a strategy that always wins passes once the minimum days are met', () => {
  const res = simulateAccount({ ...DEFAULT_RULES, minDays: 5 }, fixed(1000), new RNG(1), true);
  assert.equal(res.outcome, 'pass');
  assert.equal(res.days, 5, 'target hit on day 3, minimum of 5 trading days');
  assert.equal(res.balance, 53000, 'coasts after the target');
});

test('a strategy that always loses hits the static floor on schedule', () => {
  const res = simulateAccount({ ...DEFAULT_RULES, drawdownType: 'static', dailyLossLimit: null }, fixed(-500), new RNG(1));
  assert.equal(res.outcome, 'fail_dd');
  assert.equal(res.days, 4, '4 x $500 = $2,000 reaches the floor');
});

test('the daily loss limit stops the day, or fails the account, as configured', () => {
  const s = fixed(-600, { tradesPerDay: 3 });
  const rules = { ...DEFAULT_RULES, drawdownType: 'static', dailyLossLimit: 1000 };
  const stop = simulateAccount({ ...rules, dllAction: 'stop_day' }, s, new RNG(1), true);
  assert.equal(stop.outcome, 'fail_dd');
  assert.equal(stop.days, 2);
  assert.deepEqual(stop.path, [50000, 48800, 47600]);
  const fail = simulateAccount({ ...rules, dllAction: 'fail' }, s, new RNG(1));
  assert.equal(fail.outcome, 'fail_dll');
  assert.equal(fail.days, 1);
});

test('the end-of-day trailing floor follows new highs and locks at the starting balance', () => {
  const res = simulateAccount({ ...DEFAULT_RULES, profitTarget: 100000, maxDays: 5, trailLock: 0 }, fixed(1000), new RNG(1), true);
  assert.deepEqual(res.floors, [48000, 49000, 50000, 50000, 50000, 50000]);
  const never = simulateAccount({ ...DEFAULT_RULES, profitTarget: 100000, maxDays: 5, trailLock: null }, fixed(1000), new RNG(1), true);
  assert.deepEqual(never.floors, [48000, 49000, 50000, 51000, 52000, 53000]);
});

test('intraday trailing is at least as strict as end-of-day trailing', () => {
  const eod = monteCarlo({ ...DEFAULT_RULES, drawdownType: 'trailing_eod' }, DEFAULT_STRATEGY, { accounts: 4000, seed: 3 });
  const intra = monteCarlo({ ...DEFAULT_RULES, drawdownType: 'trailing_intraday' }, DEFAULT_STRATEGY, { accounts: 4000, seed: 3 });
  const stat = monteCarlo({ ...DEFAULT_RULES, drawdownType: 'static' }, DEFAULT_STRATEGY, { accounts: 4000, seed: 3 });
  assert.ok(intra.pFail >= eod.pFail, `intraday ${intra.pFail} vs eod ${eod.pFail}`);
  assert.ok(eod.pFail >= stat.pFail, `eod ${eod.pFail} vs static ${stat.pFail}`);
});

test('Monte Carlo agrees with the overshoot-corrected gambler’s-ruin formula', () => {
  const rules = { ...DEFAULT_RULES, drawdownType: 'static', dailyLossLimit: null, maxDays: 100000, minDays: 1, coastAfterTarget: false };
  for (const c of [1, 2, 4]) {
    const s = { ...DEFAULT_STRATEGY, contracts: c, tradesPerDay: 1 };
    const m = tradeMoments(s);
    const g = gamblersRuin(m.mean * c, m.variance * c * c, rules.profitTarget, rules.maxDrawdown, { overshoot: true });
    const mc = monteCarlo(rules, s, { accounts: 20000, seed: 9 });
    assert.ok(Math.abs(mc.pPass - g.pPass) < 0.015, `c=${c}: MC ${mc.pPass} vs analytic ${g.pPass}`);
  }
});

test('trade moments match the sample moments of simulated trades', () => {
  const s = { ...DEFAULT_STRATEGY, contracts: 1, tradesPerDay: 1 };
  const m = tradeMoments(s);
  const rng = new RNG(4);
  let sum = 0;
  let sq = 0;
  const n = 400000;
  for (let i = 0; i < n; i++) {
    const r = simulateAccount({ ...DEFAULT_RULES, maxDays: 1, profitTarget: 1e9, maxDrawdown: 1e9, dailyLossLimit: null }, s, rng);
    const x = r.balance - 50000;
    sum += x;
    sq += x * x;
  }
  const mean = sum / n;
  assert.ok(Math.abs(mean - m.mean) < 1, `mean ${mean} vs ${m.mean}`);
  assert.ok(Math.abs(sq / n - mean * mean - m.variance) / m.variance < 0.02);
});

test('gambler’s ruin has the right limits', () => {
  assert.equal(gamblersRuin(0, 1, 3, 2).pPass, 0.4);
  assert.ok(gamblersRuin(2, 1, 3, 2).pPass > 0.99);
  assert.ok(gamblersRuin(-2, 1, 3, 2).pPass < 0.01);
  // k = 2mu/sigma^2 = 2: (1 - e^-4) / (1 - e^-10)
  assert.ok(Math.abs(gamblersRuin(1, 1, 3, 2).pPass - (1 - Math.exp(-4)) / (1 - Math.exp(-10))) < 1e-15);
});

test('bigger size trades timeouts for blow-ups', () => {
  const res = sweep(DEFAULT_RULES, DEFAULT_STRATEGY, 'contracts', [1, 2, 6], { accounts: 3000 });
  assert.ok(res[0].pTimeout > res[1].pTimeout && res[1].pTimeout >= res[2].pTimeout);
  assert.ok(res[2].pFail > res[0].pFail);
});

test('bootstrap mode samples the pasted trades', () => {
  assert.deepEqual(parseSample('120, -80 $45\n-30;  10'), [120, -80, 45, -30, 10]);
  const s = { ...DEFAULT_STRATEGY, model: 'bootstrap', sample: [500, 700], contracts: 1 };
  const r = monteCarlo(DEFAULT_RULES, s, { accounts: 200 });
  assert.equal(r.pPass, 1);
  assert.equal(expectedValue(0.5, { fee: 100, payout: 1000 }), 400);
});
