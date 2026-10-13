// Event-driven backtesting engine.
//
// Events flow through one queue in time order:
//   MARKET (bar t)  -> execution fills orders queued on bar t-1 at bar t's OPEN
//                   -> portfolio marks to market at bar t's CLOSE
//                   -> strategy sees bars 0..t (never t+1) and emits a SIGNAL
//   SIGNAL          -> portfolio sizes it into an ORDER (shares)
//   ORDER           -> execution queues it for the next bar's open
//   FILL            -> portfolio updates cash, position and trade records
//
// The strategy only ever receives a `Feed` view whose accessors stop at the
// current bar, so look-ahead is impossible by construction in the default
// 'next_open' execution mode. Two deliberately biased modes exist to show
// what look-ahead does to results:
//   'same_close' fills at the close of the bar that produced the signal
//   'same_open'  fills at the OPEN of that bar: a blatant look-ahead bug

import { RNG } from '../assets/rng.js';
import { mean, std, moments, normCdf, normInv, EULER_GAMMA } from '../assets/stats.js';

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

// A read-only, point-in-time view over bars. Nothing beyond index t is reachable.
export function makeFeed(bars) {
  let t = -1;
  const feed = {
    get t() {
      return t;
    },
    get length() {
      return t + 1;
    },
    bar(k = 0) {
      if (k < 0) throw new RangeError('look-ahead: negative lag');
      if (k > t) throw new RangeError('not enough history');
      return bars[t - k];
    },
    close(k = 0) {
      return feed.bar(k).close;
    },
    closes(n) {
      if (n > t + 1) throw new RangeError('not enough history');
      const out = new Array(n);
      for (let i = 0; i < n; i++) out[i] = bars[t - n + 1 + i].close;
      return out;
    },
  };
  const advance = () => {
    if (t + 1 >= bars.length) return false;
    t++;
    return true;
  };
  return { feed, advance };
}

// Synthetic daily OHLCV with a known data-generating process, so we know the truth.
// Log price = w_t + m_t, where w is a random walk with (possibly time-varying) drift
// and m is an Ornstein-Uhlenbeck deviation:
//   w_t = w_{t-1} + mu_t + sigma_w * e_t,     mu_t = rho * mu_{t-1} + sigma_mu * u_t
//   m_t = kappa * m_{t-1} + sigma_m * v_t
//   random_walk  mu = 0, no m: no strategy has a real edge
//   trend        slowly varying drift (half-life ~140 days): trend following has an edge
//   mean_revert  strong OU component (half-life ~7 days): mean reversion has an edge
//   drift        constant positive drift, like a broad equity index
export const REGIMES = {
  random_walk: { label: 'Random walk (no edge exists)', sigmaW: 0.012, mu0: 0, rho: 0, sigmaMu: 0, kappa: 0, sigmaM: 0 },
  trend: { label: 'Persistent trends (trend edge)', sigmaW: 0.012, mu0: 0, rho: 0.995, sigmaMu: 0.00012, kappa: 0, sigmaM: 0 },
  mean_revert: { label: 'Mean-reverting (reversal edge)', sigmaW: 0.008, mu0: 0, rho: 0, sigmaMu: 0, kappa: 0.9, sigmaM: 0.008 },
  drift: { label: 'Upward drift (index-like)', sigmaW: 0.011, mu0: 0.0003, rho: 1, sigmaMu: 0, kappa: 0, sigmaM: 0 },
};

export function generateBars({ n = 2520, seed = 1, regime = 'random_walk', start = 100, startDate = '2015-01-02' } = {}) {
  const cfg = REGIMES[regime] || REGIMES.random_walk;
  const rng = new RNG(seed);
  const bars = [];
  let w = Math.log(start);
  let m = 0;
  let mu = cfg.mu0;
  let close = start;
  let d = new Date(startDate + 'T00:00:00Z');
  const sigmaClose = Math.sqrt(cfg.sigmaW ** 2 + 2 * cfg.sigmaM ** 2 / (1 + cfg.kappa || 1));
  for (let i = 0; i < n; i++) {
    mu = cfg.rho * mu + cfg.sigmaMu * rng.normal();
    w += mu + cfg.sigmaW * rng.normal();
    m = cfg.kappa * m + cfg.sigmaM * rng.normal();
    const newClose = Math.exp(w + m);
    const r = Math.log(newClose / close);
    // split the close-to-close log return into an overnight gap and an intraday move
    const gap = 0.35 * r + 0.004 * rng.normal();
    const open = close * Math.exp(gap);
    const wick = sigmaClose * 0.3;
    const high = Math.max(open, newClose) * Math.exp(Math.abs(rng.normal()) * wick);
    const low = Math.min(open, newClose) * Math.exp(-Math.abs(rng.normal()) * wick);
    const volume = Math.round(2_000_000 * Math.exp(0.35 * rng.normal() + 25 * Math.abs(r)));
    bars.push({ date: isoDate(d), open, high, low, close: newClose, volume });
    close = newClose;
    d = nextWeekday(d);
  }
  return bars;
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function nextWeekday(d) {
  const n = new Date(d.getTime() + 86400000);
  const w = n.getUTCDay();
  if (w === 6) return new Date(n.getTime() + 2 * 86400000);
  if (w === 0) return new Date(n.getTime() + 86400000);
  return n;
}

// Parse a CSV with a header containing date, open, high, low, close[, volume].
export function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error('The file needs a header row and at least one data row.');
  const head = lines[0].split(/[,;\t]/).map((h) => h.trim().toLowerCase().replace(/["']/g, ''));
  const col = (names) => head.findIndex((h) => names.includes(h));
  const ci = {
    date: col(['date', 'time', 'timestamp', 'datetime']),
    open: col(['open', 'o']),
    high: col(['high', 'h']),
    low: col(['low', 'l']),
    close: col(['adj close', 'adj_close', 'adjclose', 'close', 'c']),
    volume: col(['volume', 'vol', 'v']),
  };
  if (head.includes('close') && head.includes('adj close')) ci.close = head.indexOf('close');
  for (const k of ['date', 'open', 'high', 'low', 'close']) {
    if (ci[k] < 0) throw new Error(`Missing a "${k}" column. Expected a header like date,open,high,low,close,volume.`);
  }
  const bars = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(/[,;\t]/).map((x) => x.trim().replace(/["']/g, ''));
    const bar = {
      date: c[ci.date],
      open: +c[ci.open],
      high: +c[ci.high],
      low: +c[ci.low],
      close: +c[ci.close],
      volume: ci.volume >= 0 ? +c[ci.volume] : 1e6,
    };
    if ([bar.open, bar.high, bar.low, bar.close].every((v) => Number.isFinite(v) && v > 0)) bars.push(bar);
  }
  bars.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (bars.length < 100) throw new Error(`Only ${bars.length} valid rows; at least 100 are needed.`);
  return bars;
}

// ---------------------------------------------------------------------------
// Strategies: incremental, O(1) per bar, see only the feed.
// onBar(feed) returns a target exposure in [-1, 1], or null to hold.
// ---------------------------------------------------------------------------
class RollingWindow {
  constructor(n) {
    this.n = n;
    this.buf = new Float64Array(n);
    this.i = 0;
    this.count = 0;
    this.sum = 0;
    this.sumSq = 0;
  }

  push(x) {
    if (this.count === this.n) {
      const old = this.buf[this.i];
      this.sum -= old;
      this.sumSq -= old * old;
    } else this.count++;
    this.buf[this.i] = x;
    this.sum += x;
    this.sumSq += x * x;
    this.i = (this.i + 1) % this.n;
  }

  get full() {
    return this.count === this.n;
  }

  get mean() {
    return this.sum / this.count;
  }

  get std() {
    const m = this.mean;
    return Math.sqrt(Math.max(0, this.sumSq / this.count - m * m));
  }
}

export const STRATEGY_INFO = {
  sma: { label: 'Moving-average crossover', params: { fast: 20, slow: 100 } },
  momentum: { label: 'Time-series momentum', params: { lookback: 60 } },
  zscore: { label: 'Z-score mean reversion', params: { lookback: 20, entry: 1.5, exit: 0.25 } },
};

export function makeStrategy(kind, params = {}, { longOnly = false } = {}) {
  const p = { ...STRATEGY_INFO[kind].params, ...params };
  const clamp = (x) => (longOnly ? Math.max(0, x) : x);
  if (kind === 'sma') {
    const fast = new RollingWindow(p.fast);
    const slow = new RollingWindow(p.slow);
    return {
      warmup: p.slow,
      onBar(feed) {
        const c = feed.close();
        fast.push(c);
        slow.push(c);
        if (!slow.full) return null;
        return clamp(fast.mean > slow.mean ? 1 : -1);
      },
    };
  }
  if (kind === 'momentum') {
    return {
      warmup: p.lookback + 1,
      onBar(feed) {
        if (feed.length <= p.lookback) return null;
        return clamp(feed.close() > feed.close(p.lookback) ? 1 : -1);
      },
    };
  }
  if (kind === 'zscore') {
    const w = new RollingWindow(p.lookback);
    let pos = 0;
    return {
      warmup: p.lookback,
      onBar(feed) {
        const c = feed.close();
        w.push(c);
        if (!w.full) return null;
        const sd = w.std;
        if (sd === 0) return clamp(pos);
        const z = (c - w.mean) / sd;
        if (pos === 0 && z < -p.entry) pos = 1;
        else if (pos === 0 && z > p.entry) pos = -1;
        else if (pos !== 0 && Math.abs(z) < p.exit) pos = 0;
        return clamp(pos);
      },
    };
  }
  throw new Error('unknown strategy ' + kind);
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------
export const DEFAULT_CONFIG = {
  capital: 1_000_000,
  timing: 'next_open', // 'next_open' | 'same_close' | 'same_open'
  halfSpreadBps: 2, // paid on every fill
  impactCoef: 0.1, // square-root impact: coef * sigma_daily * sqrt(qty / ADV)
  commissionPerShare: 0.005,
  minCommission: 1,
  feeBps: 0, // exchange/regulatory fee on notional
  sizing: 'vol_target', // 'fixed' | 'vol_target'
  fraction: 1, // fixed: fraction of equity per unit of signal
  targetVol: 0.15, // vol_target: annualised volatility target
  maxLeverage: 2,
  volLookback: 20,
  rebalanceBand: 0.2, // trade only if the position is off target by more than 20%
  longOnly: false,
  periodsPerYear: 252,
};

export function runBacktest(bars, strategySpec, cfg = {}) {
  const c = { ...DEFAULT_CONFIG, ...cfg };
  const strategy = typeof strategySpec.onBar === 'function' ? strategySpec : makeStrategy(strategySpec.kind, strategySpec.params, { longOnly: c.longOnly });
  const { feed, advance } = makeFeed(bars);

  // Portfolio state
  let cash = c.capital;
  let pos = 0;
  let avgCost = 0;
  const n = bars.length;
  const equity = new Float64Array(n);
  const position = new Float64Array(n);
  const exposure = new Float64Array(n);
  const fills = [];
  const trades = [];
  let openTrade = null;
  let costs = { commission: 0, spread: 0, impact: 0 };

  // Rolling estimates built only from bars already seen
  const rets = new RollingWindow(c.volLookback);
  const vols = new RollingWindow(c.volLookback);

  let pending = null; // order queued for the next bar's open
  const queue = [];

  function fillOrder(qty, refPrice, t) {
    if (qty === 0) return;
    const side = Math.sign(qty);
    const sigma = rets.full ? rets.std : 0.02;
    const adv = vols.count ? vols.mean : 1e6; // never the volume of the bar being traded
    const impact = c.impactCoef * sigma * Math.sqrt(Math.abs(qty) / Math.max(1, adv));
    const slip = c.halfSpreadBps / 1e4 + impact;
    const price = refPrice * (1 + side * slip);
    const notional = Math.abs(qty) * price;
    const commission = Math.max(c.minCommission, Math.abs(qty) * c.commissionPerShare) + (notional * c.feeBps) / 1e4;
    costs.commission += commission;
    costs.spread += Math.abs(qty) * refPrice * (c.halfSpreadBps / 1e4);
    costs.impact += Math.abs(qty) * refPrice * impact;
    queue.push({ type: 'FILL', t, qty, price, commission, refPrice });
  }

  function onFill(ev) {
    const { qty, price, commission, t } = ev;
    fills.push({ t, date: bars[t].date, qty, price, commission });
    cash -= qty * price + commission;
    const newPos = pos + qty;
    // round-trip trade accounting with average cost
    if (pos === 0 || Math.sign(pos) === Math.sign(qty)) {
      if (pos === 0) openTrade = { entryT: t, entryDate: bars[t].date, side: Math.sign(qty), pnl: 0, costs: 0, maxShares: 0 };
      avgCost = (avgCost * Math.abs(pos) + price * Math.abs(qty)) / Math.abs(newPos);
      openTrade.costs += commission;
      openTrade.pnl -= commission;
    } else {
      const closing = Math.min(Math.abs(qty), Math.abs(pos));
      openTrade.pnl += closing * (price - avgCost) * Math.sign(pos);
      const share = closing / Math.abs(qty);
      openTrade.pnl -= commission * share;
      openTrade.costs += commission * share;
      if (Math.abs(qty) >= Math.abs(pos)) {
        trades.push({ ...openTrade, exitT: t, exitDate: bars[t].date, bars: t - openTrade.entryT });
        openTrade = null;
        const remainder = Math.abs(qty) - Math.abs(pos);
        if (remainder > 0) {
          openTrade = { entryT: t, entryDate: bars[t].date, side: Math.sign(qty), pnl: -commission * (1 - share), costs: commission * (1 - share), maxShares: 0 };
          avgCost = price;
        } else avgCost = 0;
      }
    }
    pos = newPos;
    if (openTrade) openTrade.maxShares = Math.max(openTrade.maxShares, Math.abs(pos));
  }

  function targetShares(signal, t) {
    const price = bars[t].close;
    const eq = cash + pos * price;
    let weight;
    if (c.sizing === 'vol_target') {
      if (!rets.full) return null;
      const annVol = rets.std * Math.sqrt(c.periodsPerYear);
      weight = Math.min(c.maxLeverage, c.targetVol / Math.max(annVol, 1e-4));
    } else weight = Math.min(c.maxLeverage, c.fraction);
    return Math.trunc((signal * weight * eq) / price);
  }

  function onSignal(signal, t) {
    const target = targetShares(signal, t);
    if (target === null) return;
    const delta = target - pos;
    if (delta === 0) return;
    const flip = Math.sign(target) !== Math.sign(pos);
    const offBy = Math.abs(delta) / Math.max(1, Math.abs(target));
    if (!flip && offBy < c.rebalanceBand) return;
    queue.push({ type: 'ORDER', t, qty: delta });
  }

  while (advance()) {
    const t = feed.t;
    queue.push({ type: 'MARKET', t });
    while (queue.length) {
      const ev = queue.shift();
      if (ev.type === 'MARKET') {
        const bar = bars[t];
        // 1. fill yesterday's order at today's open
        if (pending) {
          fillOrder(pending.qty, bar.open, t);
          pending = null;
        }
        // drain fills before marking
        while (queue.length && queue[0].type === 'FILL') onFill(queue.shift());
        // 2. strategy sees bar t (close known) and decides
        const signal = strategy.onBar(feed);
        // 3. update the rolling estimates with bar t (after sizing would use them, they only include <= t)
        if (t > 0) rets.push(Math.log(bar.close / bars[t - 1].close));
        vols.push(bar.volume);
        if (signal !== null && signal !== undefined) onSignal(signal, t);
      } else if (ev.type === 'ORDER') {
        if (c.timing === 'next_open') pending = ev;
        else if (c.timing === 'same_close') fillOrder(ev.qty, bars[t].close, t);
        else if (c.timing === 'same_open') fillOrder(ev.qty, bars[t].open, t); // look-ahead bug, on purpose
      } else if (ev.type === 'FILL') onFill(ev);
    }
    // 4. mark to market at the close
    const bar = bars[t];
    equity[t] = cash + pos * bar.close;
    position[t] = pos;
    exposure[t] = equity[t] > 0 ? (pos * bar.close) / equity[t] : 0;
  }
  if (openTrade) {
    const last = n - 1;
    const pnl = openTrade.pnl + Math.abs(pos) * (bars[last].close - avgCost) * Math.sign(pos);
    trades.push({ ...openTrade, pnl, exitT: last, exitDate: bars[last].date, bars: last - openTrade.entryT, open: true });
  }

  return {
    bars,
    config: c,
    equity,
    position,
    exposure,
    fills,
    trades,
    costs,
    warmup: strategy.warmup ?? 0,
    metrics: computeMetrics(equity, trades, { periodsPerYear: c.periodsPerYear, start: firstActive(position) }),
  };
}

function firstActive(position) {
  for (let i = 0; i < position.length; i++) if (position[i] !== 0) return Math.max(0, i - 1);
  return 0;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------
export function returnsFrom(equity, start = 0, end = equity.length) {
  const r = [];
  for (let i = Math.max(1, start + 1); i < end; i++) r.push(equity[i] / equity[i - 1] - 1);
  return r;
}

export function maxDrawdown(equity, start = 0) {
  let peak = -Infinity;
  let mdd = 0;
  let peakT = start;
  let troughT = start;
  let mddPeakT = start;
  let longest = 0;
  let underwaterSince = null;
  for (let i = start; i < equity.length; i++) {
    if (equity[i] > peak) {
      peak = equity[i];
      peakT = i;
      if (underwaterSince !== null) longest = Math.max(longest, i - underwaterSince);
      underwaterSince = null;
    } else if (underwaterSince === null && equity[i] < peak) underwaterSince = peakT;
    const dd = 1 - equity[i] / peak;
    if (dd > mdd) {
      mdd = dd;
      troughT = i;
      mddPeakT = peakT;
    }
  }
  if (underwaterSince !== null) longest = Math.max(longest, equity.length - 1 - underwaterSince);
  return { maxDD: mdd, peakT: mddPeakT, troughT, longestDays: longest };
}

export function drawdownSeries(equity) {
  const out = new Float64Array(equity.length);
  let peak = -Infinity;
  for (let i = 0; i < equity.length; i++) {
    peak = Math.max(peak, equity[i]);
    out[i] = equity[i] / peak - 1;
  }
  return out;
}

export function sharpe(returns, periodsPerYear = 252, rf = 0) {
  if (returns.length < 2) return NaN;
  const ex = returns.map((r) => r - rf / periodsPerYear);
  const sd = std(ex);
  return sd > 0 ? (mean(ex) / sd) * Math.sqrt(periodsPerYear) : NaN;
}

export function computeMetrics(equity, trades, { periodsPerYear = 252, start = 0 } = {}) {
  const r = returnsFrom(equity, start);
  const years = r.length / periodsPerYear;
  const total = equity[equity.length - 1] / equity[start] - 1;
  const downside = r.filter((x) => x < 0);
  const dd = maxDrawdown(equity, start);
  const closed = trades.filter((t) => !t.open);
  const wins = closed.filter((t) => t.pnl > 0);
  const losses = closed.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = -losses.reduce((s, t) => s + t.pnl, 0);
  const cagr = years > 0 ? Math.pow(Math.max(1e-12, 1 + total), 1 / years) - 1 : NaN;
  const sr = sharpe(r, periodsPerYear);
  const srPeriod = sr / Math.sqrt(periodsPerYear);
  return {
    sharpe: sr,
    // Lo (2002): standard error of a Sharpe estimate from T iid returns
    sharpeSE: Math.sqrt((1 + 0.5 * srPeriod * srPeriod) / Math.max(1, r.length)) * Math.sqrt(periodsPerYear),
    sortino: downside.length > 1 ? (mean(r) / Math.sqrt(downside.reduce((s, x) => s + x * x, 0) / r.length)) * Math.sqrt(periodsPerYear) : NaN,
    cagr,
    totalReturn: total,
    annVol: std(r) * Math.sqrt(periodsPerYear),
    maxDD: dd.maxDD,
    ddPeakT: dd.peakT,
    ddTroughT: dd.troughT,
    longestDDDays: dd.longestDays,
    calmar: dd.maxDD > 0 ? cagr / dd.maxDD : NaN,
    trades: closed.length,
    winRate: closed.length ? wins.length / closed.length : NaN,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : NaN,
    avgWin: wins.length ? grossWin / wins.length : NaN,
    avgLoss: losses.length ? -grossLoss / losses.length : NaN,
    days: r.length,
  };
}

// ---------------------------------------------------------------------------
// Look-ahead audit. For a bar k on which the strategy traded, change bar k's
// close and scramble every later bar, then re-run. A fill executed at or before
// bar k may only depend on information that existed before it was executed, so
// none of those fills (time, quantity or price) may change. Any change is
// look-ahead. Bars with fills are targeted because a bug can only show up on a
// bar where a decision was made.
// ---------------------------------------------------------------------------
export function lookaheadAudit(bars, strategySpec, cfg = {}, { samples = 8, seed = 3 } = {}) {
  const base = runBacktest(bars, strategySpec, cfg);
  const rng = new RNG(seed);
  const fillTimes = [...new Set(base.fills.map((f) => f.t))].filter((t) => t > 1 && t < bars.length - 1);
  const picks = [];
  const pool = fillTimes.slice();
  while (picks.length < samples && pool.length) picks.push(pool.splice(rng.int(pool.length), 1)[0]);
  const key = (r, k) =>
    r.fills
      .filter((f) => f.t <= k)
      .map((f) => `${f.t}:${f.qty}:${f.price.toFixed(8)}`)
      .join('|');
  const violations = [];
  for (const k of picks) {
    const perturbed = bars.slice();
    const b = bars[k];
    const close = b.close * (rng.next() < 0.5 ? 1.06 : 0.94);
    perturbed[k] = { ...b, close, high: Math.max(b.high, close), low: Math.min(b.low, close) };
    let m = close / b.close;
    for (let i = k + 1; i < bars.length; i++) {
      m *= Math.exp(0.02 * rng.normal());
      const x = bars[i];
      perturbed[i] = { ...x, open: x.open * m, high: x.high * m, low: x.low * m, close: x.close * m, volume: x.volume * (0.5 + rng.next()) };
    }
    const alt = runBacktest(perturbed, strategySpec, cfg);
    if (key(base, k) !== key(alt, k)) violations.push({ t: k, date: bars[k].date });
  }
  return { pass: violations.length === 0, samples: picks.length, violations };
}

// ---------------------------------------------------------------------------
// Overfitting tools
// ---------------------------------------------------------------------------
export function smaGrid() {
  const fasts = [5, 10, 15, 20, 30, 40, 50];
  const slows = [30, 50, 75, 100, 150, 200];
  return { fasts, slows };
}

// Run every parameter set once over the full history and keep its daily returns.
// Window statistics then come from slicing those returns: each run only ever uses
// data up to each day, so slicing does not leak.
export function gridReturns(bars, cfg = {}) {
  const { fasts, slows } = smaGrid();
  const runs = [];
  for (const slow of slows) {
    for (const fast of fasts) {
      if (fast >= slow) {
        runs.push({ fast, slow, valid: false });
        continue;
      }
      const res = runBacktest(bars, { kind: 'sma', params: { fast, slow } }, cfg);
      const r = new Float64Array(bars.length);
      for (let i = 1; i < bars.length; i++) r[i] = res.equity[i] / res.equity[i - 1] - 1;
      runs.push({ fast, slow, valid: true, returns: r });
    }
  }
  return { fasts, slows, runs };
}

export function windowSharpe(r, a, b, periodsPerYear = 252) {
  const xs = Array.from(r.subarray(Math.max(1, a), b));
  return sharpe(xs, periodsPerYear);
}

// Expected maximum Sharpe ratio among N independent trials with zero true Sharpe
// (Bailey & Lopez de Prado), in per-period units given the variance of trial Sharpes.
export function expectedMaxSharpe(nTrials, varSR) {
  if (nTrials < 2) return 0;
  return Math.sqrt(varSR) * ((1 - EULER_GAMMA) * normInv(1 - 1 / nTrials) + EULER_GAMMA * normInv(1 - 1 / (nTrials * Math.E)));
}

// Probabilistic Sharpe ratio: P(true SR > benchmark) given a per-period SR estimate
// from T observations with skewness and (non-excess) kurtosis.
export function probabilisticSharpe(sr, benchmark, T, skew, kurt) {
  const denom = Math.sqrt(Math.max(1e-12, 1 - skew * sr + ((kurt - 1) / 4) * sr * sr));
  return normCdf(((sr - benchmark) * Math.sqrt(T - 1)) / denom);
}

// Deflated Sharpe ratio for the best of N trials.
export function deflatedSharpe(bestReturns, trialSharpes) {
  const T = bestReturns.length;
  const sr = mean(bestReturns) / std(bestReturns);
  const m = moments(bestReturns);
  const finite = trialSharpes.filter(Number.isFinite);
  const varSR = finite.length > 1 ? std(finite) ** 2 : 0;
  const sr0 = expectedMaxSharpe(finite.length, varSR);
  return { dsr: probabilisticSharpe(sr, sr0, T, m.skew, m.kurtosis), srPeriod: sr, sr0, nTrials: finite.length, T, skew: m.skew, kurtosis: m.kurtosis };
}

// In-sample / out-of-sample split plus deflated Sharpe of the in-sample winner.
export function overfitStudy(bars, cfg = {}, split = 0.6) {
  const grid = gridReturns(bars, cfg);
  const cut = Math.floor(bars.length * split);
  const warm = 200; // skip the longest warm-up so every config is fully invested
  const valid = grid.runs.filter((r) => r.valid);
  for (const run of valid) {
    run.isSharpe = windowSharpe(run.returns, warm, cut);
    run.oosSharpe = windowSharpe(run.returns, cut, bars.length);
  }
  let best = valid[0];
  for (const run of valid) if (run.isSharpe > best.isSharpe) best = run;
  const perPeriod = valid.map((r) => {
    const xs = Array.from(r.returns.subarray(warm, cut));
    return mean(xs) / std(xs);
  });
  const dsr = deflatedSharpe(Array.from(best.returns.subarray(warm, cut)), perPeriod);
  const is = valid.map((r) => r.isSharpe);
  const oos = valid.map((r) => r.oosSharpe);
  return { grid, cut, warm, best, dsr, isOosCorr: pearson(is, oos), medianOos: median(oos) };
}

// Walk-forward: re-optimise on a rolling training window, trade the next window.
export function walkForward(bars, cfg = {}, { train = 504, test = 126 } = {}, grid = null) {
  const g = grid || gridReturns(bars, cfg);
  const valid = g.runs.filter((r) => r.valid);
  const n = bars.length;
  const oos = new Float64Array(n);
  const chosen = [];
  let start = 200 + train;
  while (start < n) {
    const end = Math.min(n, start + test);
    let best = valid[0];
    let bestS = -Infinity;
    for (const run of valid) {
      const s = windowSharpe(run.returns, start - train, start);
      if (s > bestS) {
        bestS = s;
        best = run;
      }
    }
    for (let i = start; i < end; i++) oos[i] = best.returns[i];
    chosen.push({ start, end, fast: best.fast, slow: best.slow, trainSharpe: bestS });
    start = end;
  }
  const first = 200 + train;
  const curve = new Float64Array(n).fill(NaN);
  let eq = 1;
  for (let i = first; i < n; i++) {
    eq *= 1 + oos[i];
    curve[i] = eq;
  }
  const rs = Array.from(oos.subarray(first));
  return { curve, chosen, sharpe: sharpe(rs), first };
}

function pearson(a, b) {
  const ma = mean(a);
  const mb = mean(b);
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < a.length; i++) {
    sab += (a[i] - ma) * (b[i] - mb);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  }
  return sab / Math.sqrt(saa * sbb);
}

function median(xs) {
  const s = xs.filter(Number.isFinite).sort((x, y) => x - y);
  if (!s.length) return NaN;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
