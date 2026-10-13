import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrderBook, BUY, SELL, LIMIT, MARKET } from '../docs/order-book/orderbook.js';
import { FlowDriver, generateOps, runOps } from '../docs/order-book/flow.js';
import { RNG } from '../docs/assets/rng.js';

const lim = (side, price, qty) => ({ side, type: LIMIT, price, qty });
const mkt = (side, qty) => ({ side, type: MARKET, qty });

test('resting orders at the same price fill in time priority (FIFO)', () => {
  const b = new OrderBook();
  const a1 = b.submit(lim(SELL, 101, 5)).id;
  const a2 = b.submit(lim(SELL, 101, 5)).id;
  const r = b.submit(lim(BUY, 101, 7));
  assert.equal(r.status, 'filled');
  assert.deepEqual(r.trades.map((t) => [t.makerId, t.qty]), [[a1, 5], [a2, 2]]);
  assert.equal(b.get(a2).remaining, 3);
  b.checkInvariants();
});

test('better prices fill before worse prices regardless of arrival time', () => {
  const b = new OrderBook();
  b.submit(lim(SELL, 103, 5));
  b.submit(lim(SELL, 101, 5));
  b.submit(lim(SELL, 102, 5));
  const r = b.submit(lim(BUY, 103, 12));
  assert.deepEqual(r.trades.map((t) => t.price), [101, 102, 103]);
  assert.equal(r.avgPrice, (101 * 5 + 102 * 5 + 103 * 2) / 12);
});

test('trades execute at the resting (maker) price, not the aggressor limit', () => {
  const b = new OrderBook();
  b.submit(lim(BUY, 99, 10));
  const r = b.submit(lim(SELL, 95, 4));
  assert.equal(r.trades[0].price, 99);
});

test('partially filled aggressive limit order rests the remainder at its limit', () => {
  const b = new OrderBook();
  b.submit(lim(SELL, 100, 3));
  const r = b.submit(lim(BUY, 100, 10));
  assert.equal(r.status, 'partial');
  assert.equal(r.filled, 3);
  assert.equal(r.remaining, 7);
  assert.equal(b.bestBid(), 100);
  assert.equal(b.bestAsk(), null);
  assert.deepEqual(b.depth(1).bids[0], { price: 100, qty: 7, count: 1 });
});

test('a partially filled maker keeps its place at the front of the queue', () => {
  const b = new OrderBook();
  const first = b.submit(lim(BUY, 50, 10)).id;
  const second = b.submit(lim(BUY, 50, 10)).id;
  b.submit(mkt(SELL, 4));
  const r = b.submit(mkt(SELL, 8));
  assert.deepEqual(r.trades.map((t) => [t.makerId, t.qty]), [[first, 6], [second, 2]]);
});

test('market orders sweep levels and cancel any unfilled residual (IOC)', () => {
  const b = new OrderBook();
  b.submit(lim(SELL, 100, 5));
  b.submit(lim(SELL, 102, 5));
  const r = b.submit(mkt(BUY, 15));
  assert.equal(r.status, 'partial');
  assert.equal(r.filled, 10);
  assert.equal(r.unfilled, 5);
  assert.equal(b.bestAsk(), null);
  assert.equal(b.bestBid(), null, 'market residual must not rest on the book');
  const empty = b.submit(mkt(SELL, 3));
  assert.equal(empty.status, 'cancelled');
});

test('cancel removes the order, cleans up empty levels and is idempotent', () => {
  const b = new OrderBook();
  const id = b.submit(lim(BUY, 100, 5)).id;
  b.submit(lim(BUY, 99, 5));
  assert.equal(b.cancel(id), true);
  assert.equal(b.cancel(id), false);
  assert.equal(b.cancel(12345), false);
  assert.equal(b.bestBid(), 99);
  assert.equal(b.bids.levelCount, 1);
  b.checkInvariants();
});

test('cancelling from the middle of a queue preserves FIFO for the rest', () => {
  const b = new OrderBook();
  const ids = [1, 2, 3, 4].map(() => b.submit(lim(SELL, 200, 1)).id);
  b.cancel(ids[1]);
  const r = b.submit(mkt(BUY, 3));
  assert.deepEqual(r.trades.map((t) => t.makerId), [ids[0], ids[2], ids[3]]);
});

test('invalid orders are rejected without touching the book', () => {
  const b = new OrderBook();
  assert.equal(b.submit({ side: 'hold', type: LIMIT, price: 1, qty: 1 }).status, 'rejected');
  assert.equal(b.submit(lim(BUY, 100, 0)).status, 'rejected');
  assert.equal(b.submit(lim(BUY, 100.5, 1)).status, 'rejected');
  assert.equal(b.submit(lim(BUY, -1, 1)).status, 'rejected');
  assert.equal(b.submit(lim(BUY, 100, 2.5)).status, 'rejected');
  assert.equal(b.orders.size, 0);
  assert.equal(b.stats.orders, 0);
});

// ---------------------------------------------------------------------------
// Differential test: a deliberately naive matcher (sort everything, every time)
// must produce exactly the same trades as the optimised engine.
// ---------------------------------------------------------------------------
class ReferenceBook {
  constructor() {
    this.resting = [];
    this.seq = 0;
    this.nextId = 1;
  }

  submit({ side, type, price, qty }) {
    const id = this.nextId++;
    let remaining = qty;
    const trades = [];
    const opp = this.resting
      .filter((o) => o.side !== side)
      .sort((a, b) => (side === BUY ? a.price - b.price : b.price - a.price) || a.seq - b.seq);
    for (const o of opp) {
      if (!remaining) break;
      if (type === LIMIT && (side === BUY ? o.price > price : o.price < price)) break;
      const q = Math.min(o.remaining, remaining);
      o.remaining -= q;
      remaining -= q;
      trades.push({ price: o.price, qty: q, makerId: o.id, takerId: id });
    }
    this.resting = this.resting.filter((o) => o.remaining > 0);
    if (type === LIMIT && remaining > 0) this.resting.push({ id, side, price, remaining, seq: ++this.seq });
    return { id, trades };
  }

  cancel(id) {
    const n = this.resting.length;
    this.resting = this.resting.filter((o) => o.id !== id);
    return this.resting.length !== n;
  }
}

test('random order streams produce identical trades to a brute-force reference', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const rng = new RNG(seed);
    const fast = new OrderBook();
    const ref = new ReferenceBook();
    const ids = [];
    for (let i = 0; i < 3000; i++) {
      const u = rng.next();
      if (u < 0.25 && ids.length) {
        const id = ids[rng.int(ids.length)];
        assert.equal(fast.cancel(id), ref.cancel(id));
        continue;
      }
      const side = rng.next() < 0.5 ? BUY : SELL;
      const type = u < 0.33 ? MARKET : LIMIT;
      const price = 100 + rng.int(11) - 5;
      const qty = 1 + rng.int(20);
      const order = { side, type, price: type === LIMIT ? price : null, qty };
      const a = fast.submit(order);
      const b = ref.submit(order);
      assert.equal(a.id, b.id);
      assert.deepEqual(
        a.trades.map((t) => [t.price, t.qty, t.makerId, t.takerId]),
        b.trades.map((t) => [t.price, t.qty, t.makerId, t.takerId]),
        `seed ${seed}, event ${i}`,
      );
      ids.push(a.id);
    }
    fast.checkInvariants();
    const agg = (side) =>
      [...new Set(ref.resting.filter((o) => o.side === side).map((o) => o.price))]
        .sort((x, y) => (side === BUY ? y - x : x - y))
        .map((p) => ref.resting.filter((o) => o.side === side && o.price === p).reduce((s, o) => s + o.remaining, 0));
    assert.deepEqual(fast.depth(100).bids.map((l) => l.qty), agg(BUY));
    assert.deepEqual(fast.depth(100).asks.map((l) => l.qty), agg(SELL));
  }
});

test('long simulated flow keeps every invariant and conserves quantity', () => {
  const book = new OrderBook();
  const drv = new FlowDriver(book, { seed: 11 });
  let bought = 0;
  let sold = 0;
  for (let i = 0; i < 20000; i++) {
    const r = drv.step();
    if (r.op === 'submit') {
      for (const t of r.result.trades) {
        if (t.takerSide === BUY) bought += t.qty;
        else sold += t.qty;
      }
      assert.equal(r.result.filled, r.result.trades.reduce((s, t) => s + t.qty, 0));
    }
    if (i % 997 === 0) book.checkInvariants();
  }
  book.checkInvariants();
  assert.equal(bought + sold, book.stats.volume);
  assert.ok(book.orders.size > 100, 'the queue-reactive flow should keep a populated book');
});

test('benchmark replay is deterministic', () => {
  const ops = generateOps(20000);
  const a = runOps(new OrderBook(), ops);
  const b = runOps(new OrderBook(), ops);
  assert.deepEqual(a, b);
  assert.ok(a.cancelsHit > 0 && a.trades > 0);
});
