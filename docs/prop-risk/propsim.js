// Monte Carlo model of a funded-trader evaluation ("prop challenge") for futures.
//
// An account starts at `accountSize`. It passes when profit reaches `profitTarget`
// at a day's close after at least `minDays` trading days. It fails if the balance
// touches the drawdown floor, or (optionally) breaches the daily loss limit. If
// neither happens within `maxDays`, it times out.
//
// Drawdown floor variants:
//   static            floor = start - maxDD, fixed
//   trailing_eod      floor = max(floor, min(peak close - maxDD, lock)), updated at each close
//   trailing_intraday the same, updated after every trade (closed-trade basis)
// where `lock` = start + trailLock: the floor stops trailing once it reaches it.

import { RNG, deriveSeed } from '../assets/rng.js';
import { mean, quantile } from '../assets/stats.js';

export const DEFAULT_RULES = {
  accountSize: 50000,
  profitTarget: 3000,
  maxDrawdown: 2000,
  drawdownType: 'trailing_eod',
  trailLock: 0, // null: the floor never stops trailing
  dailyLossLimit: 1000, // null: none
  dllAction: 'stop_day', // 'stop_day' | 'fail'
  minDays: 5,
  maxDays: 60,
  coastAfterTarget: true, // once the target is hit, finish the minimum days at negligible risk
};

export const DEFAULT_STRATEGY = {
  model: 'winloss', // 'winloss' | 'bootstrap'
  winRate: 0.45,
  avgWin: 150, // per contract, $
  avgLoss: 100, // per contract, $
  dispersion: 0.5, // coefficient of variation of each win or loss
  tailProb: 0.02, // chance a loss is an outsized gap/slippage loss
  tailMult: 3,
  tradesPerDay: 3,
  contracts: 2,
  sample: [], // bootstrap: per-contract trade P&Ls in $
};

// Per-contract trade P&L moments (used for the analytic check and the page).
export function tradeMoments(s) {
  if (s.model === 'bootstrap' && s.sample.length) {
    const m = mean(s.sample);
    const v = mean(s.sample.map((x) => (x - m) ** 2));
    return { mean: m, variance: v };
  }
  const p = s.winRate;
  const cv2 = 1 + s.dispersion * s.dispersion;
  const tailMean = 1 + s.tailProb * (s.tailMult - 1);
  const tailSq = 1 + s.tailProb * (s.tailMult * s.tailMult - 1);
  const m = p * s.avgWin - (1 - p) * s.avgLoss * tailMean;
  const e2 = p * s.avgWin * s.avgWin * cv2 + (1 - p) * s.avgLoss * s.avgLoss * cv2 * tailSq;
  return { mean: m, variance: e2 - m * m };
}

function drawTrade(s, rng) {
  if (s.model === 'bootstrap' && s.sample.length) return s.sample[rng.int(s.sample.length)] * s.contracts;
  if (rng.next() < s.winRate) return s.avgWin * rng.lognormalUnitMean(s.dispersion) * s.contracts;
  const tail = rng.next() < s.tailProb ? s.tailMult : 1;
  return -s.avgLoss * rng.lognormalUnitMean(s.dispersion) * tail * s.contracts;
}

export function simulateAccount(rules, strat, rng, record = false) {
  const r = { ...DEFAULT_RULES, ...rules };
  const start = r.accountSize;
  const lock = r.trailLock === null || r.trailLock === undefined ? Infinity : start + r.trailLock;
  let bal = start;
  let floor = start - r.maxDrawdown;
  let peak = start; // the high-water mark the floor trails
  let hwm = start; // running high for the max-drawdown statistic
  let tradingDays = 0;
  let maxDD = 0;
  let dllHits = 0;
  let targetHit = false;
  const path = record ? [start] : null;
  const floors = record ? [floor] : null;

  for (let day = 1; day <= r.maxDays; day++) {
    const dayStart = bal;
    tradingDays++;
    if (!(targetHit && r.coastAfterTarget)) {
      for (let k = 0; k < strat.tradesPerDay; k++) {
        bal += drawTrade(strat, rng);
        if (r.drawdownType === 'trailing_intraday' && bal > peak) {
          peak = bal;
          floor = Math.max(floor, Math.min(peak - r.maxDrawdown, lock));
        }
        if (bal > hwm) hwm = bal;
        maxDD = Math.max(maxDD, hwm - bal);
        if (bal <= floor) {
          if (record) {
            path.push(bal);
            floors.push(floor);
          }
          return { outcome: 'fail_dd', days: day, balance: bal, maxDD, dllHits, path, floors };
        }
        if (r.dailyLossLimit !== null && r.dailyLossLimit !== undefined && dayStart - bal >= r.dailyLossLimit) {
          dllHits++;
          if (r.dllAction === 'fail') {
            if (record) {
              path.push(bal);
              floors.push(floor);
            }
            return { outcome: 'fail_dll', days: day, balance: bal, maxDD, dllHits, path, floors };
          }
          break; // stop trading for the rest of the day
        }
        if (bal - start >= r.profitTarget) {
          targetHit = true;
          break; // stop for the day once the target is reached
        }
      }
    }
    // end of day
    if (r.drawdownType === 'trailing_eod' && bal > peak) {
      peak = bal;
      floor = Math.max(floor, Math.min(peak - r.maxDrawdown, lock));
    }
    if (record) {
      path.push(bal);
      floors.push(floor);
    }
    if (bal - start >= r.profitTarget) targetHit = true;
    if (targetHit && tradingDays >= r.minDays) return { outcome: 'pass', days: day, balance: bal, maxDD, dllHits, path, floors };
  }
  return { outcome: 'timeout', days: r.maxDays, balance: bal, maxDD, dllHits, path, floors };
}

export function monteCarlo(rules, strat, { accounts = 10000, seed = 1, keepPaths = 60 } = {}) {
  const s = { ...DEFAULT_STRATEGY, ...strat };
  const counts = { pass: 0, fail_dd: 0, fail_dll: 0, timeout: 0 };
  const passDays = [];
  const failDays = [];
  const paths = [];
  let dllHits = 0;
  for (let i = 0; i < accounts; i++) {
    const rng = new RNG(deriveSeed(seed, i));
    const res = simulateAccount(rules, s, rng, i < keepPaths);
    counts[res.outcome]++;
    dllHits += res.dllHits;
    if (res.outcome === 'pass') passDays.push(res.days);
    else if (res.outcome !== 'timeout') failDays.push(res.days);
    if (i < keepPaths) paths.push(res);
  }
  const n = accounts;
  return {
    accounts: n,
    pPass: counts.pass / n,
    pFailDD: counts.fail_dd / n,
    pFailDLL: counts.fail_dll / n,
    pFail: (counts.fail_dd + counts.fail_dll) / n,
    pTimeout: counts.timeout / n,
    medianDaysToPass: passDays.length ? quantile(passDays, 0.5) : NaN,
    medianDaysToFail: failDays.length ? quantile(failDays, 0.5) : NaN,
    passDays,
    failDays,
    avgDllHits: dllHits / n,
    paths,
    // standard error of a proportion, for honest reporting
    sePass: Math.sqrt(((counts.pass / n) * (1 - counts.pass / n)) / n),
  };
}

export function expectedValue(pPass, { fee = 150, payout = 2000 } = {}) {
  return pPass * payout - fee;
}

// Brownian-motion approximation for a static floor b below and a target a above,
// with no daily limit and no time limit: probability of reaching +a before -b, and
// the expected number of trades until one of them happens. A discrete walk overshoots
// each barrier; Siegmund's corrected diffusion approximation moves both barriers out
// by RHO * sigma, where RHO = -zeta(1/2)/sqrt(2 pi) ~ 0.5826 (exact for Gaussian steps).
export const RHO = 0.5826;

export function gamblersRuin(mu, sigma2, a, b, { overshoot = false } = {}) {
  if (overshoot) {
    const shift = RHO * Math.sqrt(sigma2);
    a += shift;
    b += shift;
  }
  if (Math.abs(mu) < 1e-12) return { pPass: b / (a + b), expectedTrades: (a * b) / sigma2 };
  const k = (2 * mu) / sigma2;
  const pPass = (1 - Math.exp(-k * b)) / (1 - Math.exp(-k * (a + b)));
  return { pPass, expectedTrades: (a * pPass - b * (1 - pPass)) / mu };
}

export function sweep(rules, strat, key, values, opts = {}) {
  return values.map((v) => {
    const res = monteCarlo(rules, { ...strat, [key]: v }, { ...opts, keepPaths: 0 });
    return { value: v, ...res, passDays: undefined, failDays: undefined };
  });
}

export function parseSample(text) {
  return text
    .split(/[\s,;]+/)
    .map((x) => x.replace(/[$£€]/g, ''))
    .filter((x) => x.length)
    .map(Number)
    .filter(Number.isFinite);
}
