// Synthetic order flow for the live demo and the benchmark.
//
// Event rates follow the spirit of Cont, Stoikov & Talreja (2010): limit orders
// and market orders arrive at constant rates, while each resting order is
// cancelled at its own constant rate, so the total cancel rate is proportional
// to the number of resting orders N. That gives the book a stable equilibrium
// depth instead of draining to empty or growing without bound.
//
//   P(next event is a cancel) = theta*N / (lambdaL + lambdaM + theta*N)
//
// A latent fair value follows a random walk (in ticks). Limit prices sit at an
// exponentially distributed distance from it; about one in ten is marketable.

import { RNG } from '../assets/rng.js';
import { OrderBook, BUY, SELL, LIMIT, MARKET } from './orderbook.js';

export const DEFAULT_FLOW = {
  seed: 7,
  startPrice: 10000, // ticks: 100.00 with a 0.01 tick
  vol: 0.3, // fair-value std dev per event, in ticks
  meanOffset: 10, // mean distance of passive limit orders from fair value, in ticks
  lambdaLimit: 1,
  lambdaMarket: 0.06,
  theta: 1 / 8000, // cancel rate per resting order
  meanQty: 20,
};

// Raw random draws for one event; decide() turns them into an action given the
// current number of resting orders. Splitting the two lets the benchmark draw
// every random number before the clock starts.
export class OrderFlow {
  constructor(opts = {}) {
    this.o = { ...DEFAULT_FLOW, ...opts };
    this.rng = new RNG(this.o.seed);
    this.fair = this.o.startPrice;
  }

  draw() {
    const r = this.rng;
    this.fair += this.o.vol * r.normal();
    return {
      fair: Math.round(this.fair),
      u: r.next(),
      buy: r.next() < 0.5,
      offset: Math.floor(r.exponential(1 / this.o.meanOffset)) - 1,
      qty: Math.max(1, Math.round(this.o.meanQty * r.lognormalUnitMean(0.9))),
      pick: r.next(),
    };
  }

  decide(d, resting) {
    const { lambdaLimit: L, lambdaMarket: M, theta } = this.o;
    const c = theta * resting;
    const total = L + M + c;
    const side = d.buy ? BUY : SELL;
    if (d.u * total < c) return { op: 'cancel', pick: d.pick };
    if (d.u * total < c + M) return { op: 'submit', side, type: MARKET, price: null, qty: Math.max(1, Math.round(d.qty * 0.6)) };
    const price = Math.max(1, d.buy ? d.fair - d.offset : d.fair + d.offset);
    return { op: 'submit', side, type: LIMIT, price, qty: d.qty };
  }

  next(resting) {
    return this.decide(this.draw(), resting);
  }
}

// Drives a book with an OrderFlow and tracks the simulator's own resting orders,
// so cancels only ever target simulated orders (orders entered by a person on
// the page are never cancelled by the simulator).
export class FlowDriver {
  constructor(book, opts = {}) {
    this.book = book;
    this.flow = new OrderFlow(opts);
    this.live = [];
  }

  step() {
    const a = this.flow.next(this.live.length);
    if (a.op === 'cancel') {
      while (this.live.length) {
        const i = Math.floor(a.pick * this.live.length);
        const id = this.live[i];
        this.live[i] = this.live[this.live.length - 1];
        this.live.pop();
        if (this.book.cancel(id)) return { op: 'cancel', id };
      }
      return { op: 'noop' };
    }
    const res = this.book.submit(a);
    if (a.type === LIMIT && res.remaining > 0) this.live.push(res.id);
    return { op: 'submit', order: a, result: res };
  }

  warmUp(n = 6000) {
    for (let i = 0; i < n; i++) this.step();
  }
}

// ---------------------------------------------------------------------------
// Benchmark: draw every random number up front (not timed), then time the
// engine processing the stream. The only work in the timed loop besides the
// engine is choosing the event type from the pre-drawn uniform and keeping
// the list of resting ids that cancels pick from.
// ---------------------------------------------------------------------------
export function generateOps(n, opts = {}) {
  const flow = new OrderFlow({ seed: 42, ...opts });
  const fair = new Int32Array(n);
  const u = new Float64Array(n);
  const buy = new Uint8Array(n);
  const offset = new Int32Array(n);
  const qty = new Int32Array(n);
  const pick = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const d = flow.draw();
    fair[i] = d.fair;
    u[i] = d.u;
    buy[i] = d.buy ? 1 : 0;
    offset[i] = d.offset;
    qty[i] = d.qty;
    pick[i] = d.pick;
  }
  return { n, fair, u, buy, offset, qty, pick, params: flow.o };
}

export function runOps(book, ops, onLatency) {
  const { n, fair, u, buy, offset, qty, pick, params } = ops;
  const L = params.lambdaLimit;
  const M = params.lambdaMarket;
  const theta = params.theta;
  let live = new Int32Array(1 << 15);
  let liveLen = 0;
  const counts = { limits: 0, markets: 0, cancels: 0, cancelsHit: 0, trades: 0 };
  const clock = onLatency ? () => process.hrtime.bigint() : null;
  for (let i = 0; i < n; i++) {
    const c = theta * liveLen;
    const x = u[i] * (L + M + c);
    if (x < c) {
      counts.cancels++;
      // pick a random resting id; skip ids that have since traded
      while (liveLen > 0) {
        const j = Math.floor(pick[i] * liveLen);
        const id = live[j];
        live[j] = live[--liveLen];
        let ok;
        if (clock) {
          const t0 = clock();
          ok = book.cancel(id);
          onLatency(Number(clock() - t0));
        } else ok = book.cancel(id);
        if (ok) {
          counts.cancelsHit++;
          break;
        }
      }
      continue;
    }
    const isMarket = x < c + M;
    const side = buy[i] ? BUY : SELL;
    const order = isMarket
      ? { side, type: MARKET, price: null, qty: Math.max(1, Math.round(qty[i] * 0.6)) }
      : { side, type: LIMIT, price: Math.max(1, buy[i] ? fair[i] - offset[i] : fair[i] + offset[i]), qty: qty[i] };
    let r;
    if (clock) {
      const t0 = clock();
      r = book.submit(order);
      onLatency(Number(clock() - t0));
    } else r = book.submit(order);
    counts.trades += r.trades.length;
    if (isMarket) counts.markets++;
    else {
      counts.limits++;
      if (r.remaining > 0) {
        if (liveLen === live.length) {
          const grown = new Int32Array(live.length * 2);
          grown.set(live);
          live = grown;
        }
        live[liveLen++] = r.id;
      }
    }
  }
  return counts;
}

export function benchmark(n = 1_000_000, opts = {}) {
  const now = typeof performance !== 'undefined' ? () => performance.now() : () => Date.now();
  const ops = generateOps(n, opts);
  // warm-up so the JIT has compiled the hot paths before timing
  runOps(new OrderBook(), generateOps(Math.min(100_000, n), { seed: 99 }));
  const book = new OrderBook();
  const t0 = now();
  const r = runOps(book, ops);
  const ms = now() - t0;
  return {
    n,
    ms,
    opsPerSec: n / (ms / 1000),
    nsPerOp: (ms * 1e6) / n,
    trades: r.trades,
    volume: book.stats.volume,
    cancelsHit: r.cancelsHit,
    mix: { limits: r.limits, markets: r.markets, cancels: r.cancels },
    resting: book.orders.size,
    bidLevels: book.bids.levelCount,
    askLevels: book.asks.levelCount,
  };
}
