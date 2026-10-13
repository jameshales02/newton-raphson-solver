import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeFeed,
  generateBars,
  runBacktest,
  lookaheadAudit,
  makeStrategy,
  maxDrawdown,
  sharpe,
  computeMetrics,
  probabilisticSharpe,
  expectedMaxSharpe,
  deflatedSharpe,
  parseCsv,
} from '../docs/backtester/backtest.js';
import { mean, std } from '../docs/assets/stats.js';

const NO_COSTS = { halfSpreadBps: 0, impactCoef: 0, commissionPerShare: 0, minCommission: 0, feeBps: 0 };

function flatBars(closes) {
  return closes.map((c, i) => ({ date: `2020-01-${String(i + 1).padStart(2, '0')}`, open: c, high: c, low: c, close: c, volume: 1e6 }));
}

test('the feed only exposes bars up to the current one', () => {
  const bars = generateBars({ n: 10, seed: 1 });
  const { feed, advance } = makeFeed(bars);
  advance();
  advance();
  assert.equal(feed.t, 1);
  assert.equal(feed.close(), bars[1].close);
  assert.equal(feed.close(1), bars[0].close);
  assert.throws(() => feed.bar(-1), /look-ahead/);
  assert.throws(() => feed.bar(2), /history/);
  assert.throws(() => feed.closes(3), /history/);
  assert.deepEqual(Object.keys(feed).sort(), ['bar', 'close', 'closes', 'length', 't']);
});

test('changing the future never changes the past (next-open execution)', () => {
  const bars = generateBars({ n: 800, seed: 4, regime: 'trend' });
  const k = 500;
  const alt = bars.map((b, i) => (i <= k ? b : { ...b, open: b.open * 1.3, high: b.high * 1.3, low: b.low * 1.3, close: b.close * 1.3 }));
  for (const spec of [{ kind: 'sma', params: { fast: 10, slow: 50 } }, { kind: 'momentum', params: { lookback: 20 } }, { kind: 'zscore', params: {} }]) {
    const a = runBacktest(bars, spec);
    const b = runBacktest(alt, spec);
    for (let i = 0; i <= k; i++) assert.equal(a.equity[i], b.equity[i], `${spec.kind} diverged at ${i}`);
  }
});

test('look-ahead audit passes the correct engine and catches both biased modes', () => {
  const bars = generateBars({ n: 1000, seed: 9, regime: 'random_walk' });
  for (const spec of [{ kind: 'sma', params: { fast: 10, slow: 40 } }, { kind: 'momentum', params: { lookback: 5 } }, { kind: 'zscore', params: {} }]) {
    assert.equal(lookaheadAudit(bars, spec, { timing: 'next_open' }).pass, true, `${spec.kind} next_open`);
    assert.equal(lookaheadAudit(bars, spec, { timing: 'same_open' }).pass, false, `${spec.kind} same_open`);
    assert.equal(lookaheadAudit(bars, spec, { timing: 'same_close' }).pass, false, `${spec.kind} same_close`);
  }
});

test('the look-ahead bug manufactures a large fake edge on a random walk', () => {
  const sr = { next_open: [], same_open: [] };
  for (let seed = 1; seed <= 5; seed++) {
    const bars = generateBars({ n: 1500, seed, regime: 'random_walk' });
    for (const timing of Object.keys(sr)) sr[timing].push(runBacktest(bars, { kind: 'momentum', params: { lookback: 1 } }, { timing }).metrics.sharpe);
  }
  assert.ok(Math.abs(mean(sr.next_open)) < 0.6, `honest Sharpe ${mean(sr.next_open)}`);
  assert.ok(mean(sr.same_open) > 3, `biased Sharpe ${mean(sr.same_open)}`);
});

test('fills happen at the next bar open and trade P&L reconciles with equity', () => {
  // price path designed so a 2-bar momentum strategy goes long, then short
  const closes = [100, 101, 102, 104, 103, 101, 99, 98, 100, 103, 106, 105];
  const bars = flatBars(closes).map((b, i) => ({ ...b, open: i ? closes[i - 1] + 0.5 : b.open }));
  const res = runBacktest(bars, { kind: 'momentum', params: { lookback: 2 } }, { ...NO_COSTS, sizing: 'fixed', fraction: 1, rebalanceBand: 10 });
  assert.ok(res.fills.length >= 2);
  for (const f of res.fills) assert.equal(f.price, bars[f.t].open, 'fill must be at the open of the bar after the signal');
  const first = res.fills[0];
  assert.equal(first.t, 3, 'signal on bar 2 (first bar with 2 bars of history) fills on bar 3');
  const tradePnl = res.trades.reduce((s, t) => s + t.pnl, 0);
  const equityPnl = res.equity[res.equity.length - 1] - res.config.capital;
  assert.ok(Math.abs(tradePnl - equityPnl) < 1e-6, `${tradePnl} vs ${equityPnl}`);
});

test('costs are charged on every fill and reduce returns', () => {
  const bars = generateBars({ n: 1200, seed: 2 });
  const spec = { kind: 'sma', params: { fast: 5, slow: 20 } };
  const free = runBacktest(bars, spec, NO_COSTS);
  const costly = runBacktest(bars, spec, { halfSpreadBps: 10, impactCoef: 0.5, commissionPerShare: 0.01 });
  assert.equal(free.costs.commission + free.costs.spread + free.costs.impact, 0);
  assert.ok(costly.costs.commission > 0 && costly.costs.spread > 0 && costly.costs.impact > 0);
  assert.ok(costly.equity[costly.equity.length - 1] < free.equity[free.equity.length - 1]);
});

test('volatility targeting keeps realised volatility near target', () => {
  const vols = [];
  for (let seed = 1; seed <= 4; seed++) {
    const bars = generateBars({ n: 2000, seed });
    const r = runBacktest(bars, { kind: 'sma', params: { fast: 10, slow: 50 } }, { sizing: 'vol_target', targetVol: 0.1, rebalanceBand: 0.05, ...NO_COSTS });
    vols.push(r.metrics.annVol);
  }
  const v = mean(vols);
  assert.ok(v > 0.08 && v < 0.12, `realised vol ${v}`);
});

test('incremental strategies match a naive recomputation', () => {
  const bars = generateBars({ n: 400, seed: 5 });
  const strat = makeStrategy('sma', { fast: 7, slow: 30 });
  const { feed, advance } = makeFeed(bars);
  let i = 0;
  while (advance()) {
    const s = strat.onBar(feed);
    if (i >= 29) {
      const c = bars.slice(0, i + 1).map((b) => b.close);
      const f = mean(c.slice(-7));
      const sl = mean(c.slice(-30));
      assert.equal(s, f > sl ? 1 : -1, `bar ${i}`);
    } else assert.equal(s, null);
    i++;
  }
});

test('max drawdown, Sharpe and win rate on known inputs', () => {
  const eq = Float64Array.from([100, 120, 90, 130, 65, 70]);
  const dd = maxDrawdown(eq);
  assert.equal(dd.maxDD, 0.5);
  assert.equal(dd.peakT, 3);
  assert.equal(dd.troughT, 4);
  const r = [0.01, -0.005, 0.02, 0.0, -0.01];
  assert.ok(Math.abs(sharpe(r, 252) - (mean(r) / std(r)) * Math.sqrt(252)) < 1e-12);
  const m = computeMetrics(eq, [{ pnl: 10 }, { pnl: -5 }, { pnl: 3 }, { pnl: 7, open: true }]);
  assert.equal(m.trades, 3);
  assert.equal(m.winRate, 2 / 3);
  assert.equal(m.profitFactor, 13 / 5);
});

test('probabilistic and deflated Sharpe behave as the formulas require', () => {
  assert.ok(Math.abs(probabilisticSharpe(0, 0, 1000, 0, 3) - 0.5) < 1e-12);
  assert.ok(probabilisticSharpe(0.1, 0, 1000, 0, 3) > 0.99);
  assert.ok(expectedMaxSharpe(100, 0.01) > expectedMaxSharpe(10, 0.01));
  assert.equal(expectedMaxSharpe(1, 0.01), 0);
  // E[max of N standard normals] for N=100 is about 2.5; the approximation should be close
  assert.ok(Math.abs(expectedMaxSharpe(100, 1) - 2.5) < 0.1);
  const rets = generateBars({ n: 1000, seed: 3 }).map((b, i, a) => (i ? b.close / a[i - 1].close - 1 : 0)).slice(1);
  const one = deflatedSharpe(rets, [mean(rets) / std(rets)]);
  const many = deflatedSharpe(rets, Array.from({ length: 50 }, (_, i) => (i - 25) / 500));
  assert.ok(many.dsr < one.dsr, 'more trials must deflate the Sharpe ratio');
});

test('synthetic regimes contain the edges they are designed to contain', () => {
  const sr = { rw: [], trend: [], mr: [] };
  for (let seed = 1; seed <= 8; seed++) {
    sr.rw.push(runBacktest(generateBars({ seed, regime: 'random_walk' }), { kind: 'sma', params: { fast: 20, slow: 100 } }).metrics.sharpe);
    sr.trend.push(runBacktest(generateBars({ seed, regime: 'trend' }), { kind: 'sma', params: { fast: 20, slow: 100 } }).metrics.sharpe);
    sr.mr.push(runBacktest(generateBars({ seed, regime: 'mean_revert' }), { kind: 'zscore', params: {} }).metrics.sharpe);
  }
  assert.ok(Math.abs(mean(sr.rw)) < 0.3, `random walk ${mean(sr.rw)}`);
  assert.ok(mean(sr.trend) > 0.3, `trend ${mean(sr.trend)}`);
  assert.ok(mean(sr.mr) > 0.3, `mean reversion ${mean(sr.mr)}`);
});

test('CSV parsing accepts common headers and sorts by date', () => {
  const rows = ['Date,Open,High,Low,Close,Adj Close,Volume'];
  for (let i = 150; i >= 1; i--) rows.push(`2021-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')},10,11,9,10.5,10.4,1000`);
  const bars = parseCsv(rows.join('\n'));
  assert.equal(bars.length, 150);
  assert.ok(bars[0].date < bars[149].date);
  assert.equal(bars[0].close, 10.5, 'uses Close, not Adj Close, when both exist');
  assert.throws(() => parseCsv('date,open\n2020-01-01,1'), /Missing/);
});
