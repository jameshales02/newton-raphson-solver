// Market-making simulator after Avellaneda & Stoikov (2008), "High-frequency
// trading in a limit order book", with three quoting strategies and an exact
// P&L attribution.
//
// Model (per step of length dt, time t in [0, T]):
//   mid:       S_{t+dt} = S_t ± sigma*sqrt(dt)          (binomial, as in the paper)
//              + adverse-selection jumps (optional extension, see below)
//   arrivals:  the bid is hit with probability lambda(delta_b)*dt, the ask lifted
//              with probability lambda(delta_a)*dt, where lambda(delta) = A*exp(-k*delta)
//              and delta is the quote's distance from the mid.
//
// Strategies:
//   inventory  (Avellaneda-Stoikov) quotes around the reservation price
//              r = s - q*gamma*sigma^2*(T - t)
//              with total spread gamma*sigma^2*(T - t) + (2/gamma)*ln(1 + gamma/k)
//   symmetric  the same spread, centred on the mid (ignores inventory)
//   linear     fixed half-spread h around the mid, shifted by -skew*q
//
// P&L attribution (exact, checked in the tests):
//   total = spread capture + inventory P&L + adverse selection + rebates
//   spread capture   = sum over fills of |fill price - mid at the fill|
//   inventory P&L    = sum_t q_t * (diffusive mid move)
//   adverse selection= sum_t q_t * (jump caused by informed flow)

import { RNG, deriveSeed } from '../assets/rng.js';
import { mean, std } from '../assets/stats.js';

export const DEFAULTS = {
  s0: 100,
  T: 1,
  dt: 0.005,
  sigma: 2,
  A: 140,
  k: 1.5,
  gamma: 0.1,
  qMax: Infinity, // stop quoting the side that would push |q| beyond this
  toxicity: 0, // probability that a fill comes from an informed trader
  jump: 0, // size of the mid move against the market maker after an informed fill
  rebate: 0, // maker rebate per unit filled (negative = fee)
  halfSpread: 0.65, // linear strategy
  skew: 0.05, // linear strategy: quote shift per unit of inventory
};

export const STRATEGIES = {
  inventory: 'Inventory skew (A–S)',
  symmetric: 'Symmetric',
  linear: 'Linear skew',
};

export function asSpread(p, t) {
  const tau = Math.max(0, p.T - t);
  return p.gamma * p.sigma * p.sigma * tau + (2 / p.gamma) * Math.log(1 + p.gamma / p.k);
}

export function reservationPrice(p, s, q, t) {
  const tau = Math.max(0, p.T - t);
  return s - q * p.gamma * p.sigma * p.sigma * tau;
}

// Returns { centre, bid, ask } for a strategy at state (s, q, t).
export function quotes(p, strategy, s, q, t) {
  if (strategy === 'linear') {
    const centre = s - p.skew * q;
    return { centre, bid: centre - p.halfSpread, ask: centre + p.halfSpread };
  }
  const half = asSpread(p, t) / 2;
  const centre = strategy === 'inventory' ? reservationPrice(p, s, q, t) : s;
  return { centre, bid: centre - half, ask: centre + half };
}

export function simulate(params = {}, strategy = 'inventory', seed = 1, { record = true } = {}) {
  const p = { ...DEFAULTS, ...params };
  const n = Math.round(p.T / p.dt);
  const rng = new RNG(seed);
  const step = p.sigma * Math.sqrt(p.dt);

  let s = p.s0;
  let q = 0;
  let cash = 0;
  let edge = 0;
  let invPnl = 0;
  let adverse = 0;
  let fees = 0;
  let bidFills = 0;
  let askFills = 0;
  let spreadSum = 0;
  let maxAbsQ = 0;
  const qPath = new Float64Array(n + 1);

  const rec = record
    ? {
        t: new Float64Array(n + 1),
        mid: new Float64Array(n + 1),
        bid: new Float64Array(n + 1).fill(NaN),
        ask: new Float64Array(n + 1).fill(NaN),
        centre: new Float64Array(n + 1).fill(NaN),
        q: new Float64Array(n + 1),
        pnl: new Float64Array(n + 1),
        edge: new Float64Array(n + 1),
        inv: new Float64Array(n + 1),
        adverse: new Float64Array(n + 1),
        fees: new Float64Array(n + 1),
        fills: [],
      }
    : null;
  if (rec) {
    rec.t[0] = 0;
    rec.mid[0] = s;
  }

  for (let i = 0; i < n; i++) {
    const t = i * p.dt;
    const qt = quotes(p, strategy, s, q, t);
    const quoteBid = q < p.qMax;
    const quoteAsk = q > -p.qMax;
    spreadSum += qt.ask - qt.bid;

    // Draw every uniform each step (even if unused) so that strategies run on the
    // same seed see identical randomness: common random numbers for fair comparison.
    const uBid = rng.next();
    const uAsk = rng.next();
    const uToxB = rng.next();
    const uToxA = rng.next();
    const uMove = rng.next();

    const pBid = Math.min(1, p.A * Math.exp(-p.k * (s - qt.bid)) * p.dt);
    const pAsk = Math.min(1, p.A * Math.exp(-p.k * (qt.ask - s)) * p.dt);
    let jumpMove = 0;
    if (quoteBid && uBid < pBid) {
      q += 1;
      cash -= qt.bid;
      edge += s - qt.bid;
      fees += p.rebate;
      bidFills++;
      if (uToxB < p.toxicity) jumpMove -= p.jump;
      if (rec) rec.fills.push({ t, side: 'buy', price: qt.bid });
    }
    if (quoteAsk && uAsk < pAsk) {
      q -= 1;
      cash += qt.ask;
      edge += qt.ask - s;
      fees += p.rebate;
      askFills++;
      if (uToxA < p.toxicity) jumpMove += p.jump;
      if (rec) rec.fills.push({ t, side: 'sell', price: qt.ask });
    }
    const diffMove = uMove < 0.5 ? step : -step;
    invPnl += q * diffMove;
    adverse += q * jumpMove;
    s += diffMove + jumpMove;
    if (Math.abs(q) > maxAbsQ) maxAbsQ = Math.abs(q);
    qPath[i + 1] = q;

    if (rec) {
      rec.bid[i] = quoteBid ? qt.bid : NaN;
      rec.ask[i] = quoteAsk ? qt.ask : NaN;
      rec.centre[i] = qt.centre;
      rec.t[i + 1] = (i + 1) * p.dt;
      rec.mid[i + 1] = s;
      rec.q[i + 1] = q;
      rec.pnl[i + 1] = cash + q * s + fees;
      rec.edge[i + 1] = edge;
      rec.inv[i + 1] = invPnl;
      rec.adverse[i + 1] = adverse;
      rec.fees[i + 1] = fees;
    }
  }

  const pnl = cash + q * s + fees;
  return {
    params: p,
    strategy,
    pnl,
    edge,
    invPnl,
    adverse,
    fees,
    finalQ: q,
    maxAbsQ,
    stdQ: std(Array.from(qPath)),
    bidFills,
    askFills,
    avgSpread: spreadSum / n,
    rec,
  };
}

// Monte Carlo over many paths. Path i uses the same seed for every strategy.
export function monteCarlo(params = {}, strategies = ['inventory', 'symmetric'], paths = 1000, seed = 2024) {
  const out = {};
  for (const strat of strategies) {
    const pnl = new Float64Array(paths);
    const finalQ = new Float64Array(paths);
    const fills = new Float64Array(paths);
    const edge = new Float64Array(paths);
    const inv = new Float64Array(paths);
    const adv = new Float64Array(paths);
    let spread = 0;
    let maxQ = 0;
    for (let i = 0; i < paths; i++) {
      const r = simulate(params, strat, deriveSeed(seed, i), { record: false });
      pnl[i] = r.pnl;
      finalQ[i] = r.finalQ;
      fills[i] = r.bidFills + r.askFills;
      edge[i] = r.edge;
      inv[i] = r.invPnl;
      adv[i] = r.adverse;
      spread += r.avgSpread;
      maxQ += r.maxAbsQ;
    }
    const m = mean(pnl);
    const sd = std(pnl);
    out[strat] = {
      pnl,
      finalQ,
      summary: {
        meanPnl: m,
        stdPnl: sd,
        ratio: m / sd,
        meanFinalQ: mean(finalQ),
        stdFinalQ: std(finalQ),
        meanFills: mean(fills),
        meanEdge: mean(edge),
        meanInv: mean(inv),
        meanAdverse: mean(adv),
        avgSpread: spread / paths,
        meanMaxAbsQ: maxQ / paths,
        pLoss: pnl.filter((x) => x < 0).length / paths,
      },
    };
  }
  return out;
}
