// Limit order book and matching engine with price-time priority.
//
// Prices are integers (ticks) so that equality and ordering are exact.
// Data structures:
//   * Each side keeps a sorted array of the prices that currently have orders,
//     ordered worst -> best so the best price is always at the END of the array.
//     Best-price lookup is O(1) and removing an exhausted best level is pop().
//   * A Map from price -> PriceLevel gives O(1) access to a level.
//   * Each PriceLevel is a FIFO queue implemented as an intrusive doubly linked
//     list of orders, so append, pop-front and cancel-from-the-middle are O(1).
//   * A Map from order id -> Order lets cancel find an order in O(1).

export const BUY = 'buy';
export const SELL = 'sell';
export const LIMIT = 'limit';
export const MARKET = 'market';

export class Order {
  constructor(id, side, type, price, qty, seq) {
    this.id = id;
    this.side = side;
    this.type = type;
    this.price = price;
    this.qty = qty;
    this.remaining = qty;
    this.seq = seq;
    this.prev = null;
    this.next = null;
    this.level = null;
  }

  get filled() {
    return this.qty - this.remaining;
  }
}

export class PriceLevel {
  constructor(price) {
    this.price = price;
    this.head = null;
    this.tail = null;
    this.totalQty = 0;
    this.count = 0;
  }

  push(order) {
    order.level = this;
    order.prev = this.tail;
    order.next = null;
    if (this.tail) this.tail.next = order;
    else this.head = order;
    this.tail = order;
    this.totalQty += order.remaining;
    this.count++;
  }

  remove(order) {
    if (order.prev) order.prev.next = order.next;
    else this.head = order.next;
    if (order.next) order.next.prev = order.prev;
    else this.tail = order.prev;
    this.totalQty -= order.remaining;
    this.count--;
    order.prev = order.next = order.level = null;
  }

  *orders() {
    for (let o = this.head; o; o = o.next) yield o;
  }
}

export class BookSide {
  constructor(isBid) {
    this.isBid = isBid;
    this.prices = []; // worst ... best
    this.levels = new Map();
  }

  // true if price a is strictly better than price b for this side
  better(a, b) {
    return this.isBid ? a > b : a < b;
  }

  best() {
    const n = this.prices.length;
    return n ? this.levels.get(this.prices[n - 1]) : null;
  }

  bestPrice() {
    const n = this.prices.length;
    return n ? this.prices[n - 1] : null;
  }

  // First index whose price is better than or equal to `price` (binary search).
  _search(price) {
    const ps = this.prices;
    let lo = 0;
    let hi = ps.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const p = ps[mid];
      if (p === price || this.better(p, price)) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  getOrCreate(price) {
    let level = this.levels.get(price);
    if (level) return level;
    level = new PriceLevel(price);
    this.levels.set(price, level);
    const ps = this.prices;
    // Fast path: new best price (the common case near the touch).
    if (!ps.length || this.better(price, ps[ps.length - 1])) ps.push(price);
    else ps.splice(this._search(price), 0, price);
    return level;
  }

  removeLevel(price) {
    this.levels.delete(price);
    const ps = this.prices;
    if (ps[ps.length - 1] === price) ps.pop();
    else ps.splice(this._search(price), 1);
  }

  // Top-n aggregated levels, best first.
  depth(n = 10) {
    const out = [];
    const ps = this.prices;
    for (let i = ps.length - 1; i >= 0 && out.length < n; i--) {
      const lvl = this.levels.get(ps[i]);
      out.push({ price: lvl.price, qty: lvl.totalQty, count: lvl.count });
    }
    return out;
  }

  get levelCount() {
    return this.prices.length;
  }
}

export class OrderBook {
  constructor() {
    this.bids = new BookSide(true);
    this.asks = new BookSide(false);
    this.orders = new Map();
    this.seq = 0;
    this.nextId = 1;
    this.tradeId = 0;
    this.stats = { orders: 0, trades: 0, volume: 0, cancels: 0 };
  }

  bestBid() {
    return this.bids.bestPrice();
  }

  bestAsk() {
    return this.asks.bestPrice();
  }

  spread() {
    const b = this.bestBid();
    const a = this.bestAsk();
    return b === null || a === null ? null : a - b;
  }

  mid() {
    const b = this.bestBid();
    const a = this.bestAsk();
    return b === null || a === null ? null : (a + b) / 2;
  }

  depth(n = 10) {
    return { bids: this.bids.depth(n), asks: this.asks.depth(n) };
  }

  get(id) {
    return this.orders.get(id) || null;
  }

  // Submit an order. Returns { id, status, filled, remaining, trades, avgPrice }.
  //   status: 'filled' | 'partial' (limit rested with some fill, or market with
  //   unfilled residual cancelled) | 'resting' | 'cancelled' | 'rejected'
  submit({ side, type = LIMIT, price = null, qty, id }) {
    if (side !== BUY && side !== SELL) return reject('side must be buy or sell');
    if (type !== LIMIT && type !== MARKET) return reject('type must be limit or market');
    if (!Number.isInteger(qty) || qty <= 0) return reject('qty must be a positive integer');
    if (type === LIMIT && (!Number.isInteger(price) || price <= 0)) return reject('limit price must be a positive integer number of ticks');
    if (id === undefined) id = this.nextId++;
    else if (this.orders.has(id)) return reject('duplicate order id');

    const order = new Order(id, side, type, type === LIMIT ? price : null, qty, ++this.seq);
    this.stats.orders++;
    const trades = [];
    this._match(order, trades);

    const filled = order.qty - order.remaining;
    let status;
    if (order.remaining === 0) status = 'filled';
    else if (type === LIMIT) {
      const own = order.side === BUY ? this.bids : this.asks;
      own.getOrCreate(order.price).push(order);
      this.orders.set(order.id, order);
      status = filled > 0 ? 'partial' : 'resting';
    } else status = filled > 0 ? 'partial' : 'cancelled'; // market residual is IOC

    let notional = 0;
    for (const t of trades) notional += t.price * t.qty;
    return {
      id: order.id,
      status,
      filled,
      remaining: type === LIMIT ? order.remaining : 0,
      unfilled: order.remaining,
      avgPrice: filled ? notional / filled : null,
      trades,
    };
  }

  _match(order, trades) {
    const book = order.side === BUY ? this.asks : this.bids;
    const isBuy = order.side === BUY;
    const limit = order.type === LIMIT;
    while (order.remaining > 0) {
      const level = book.best();
      if (!level) break;
      if (limit && (isBuy ? level.price > order.price : level.price < order.price)) break;
      let maker = level.head;
      while (maker && order.remaining > 0) {
        const q = maker.remaining < order.remaining ? maker.remaining : order.remaining;
        maker.remaining -= q;
        order.remaining -= q;
        level.totalQty -= q;
        this.stats.trades++;
        this.stats.volume += q;
        trades.push({
          id: ++this.tradeId,
          price: level.price,
          qty: q,
          makerId: maker.id,
          takerId: order.id,
          takerSide: order.side,
          seq: this.seq,
        });
        const next = maker.next;
        if (maker.remaining === 0) {
          // remove() subtracts maker.remaining (now 0), so totalQty is not double-counted
          level.remove(maker);
          this.orders.delete(maker.id);
        }
        maker = next;
      }
      if (level.count === 0) book.removeLevel(level.price);
    }
  }

  // Cancel the remaining quantity of a resting order. Returns true if found.
  cancel(id) {
    const order = this.orders.get(id);
    if (!order) return false;
    const level = order.level;
    const side = order.side === BUY ? this.bids : this.asks;
    level.remove(order);
    if (level.count === 0) side.removeLevel(level.price);
    this.orders.delete(id);
    this.stats.cancels++;
    return true;
  }

  // Consistency check used by the tests: aggregates match the queues and the book is not crossed.
  checkInvariants() {
    for (const side of [this.bids, this.asks]) {
      for (let i = 1; i < side.prices.length; i++) {
        if (!side.better(side.prices[i], side.prices[i - 1])) throw new Error('price levels out of order');
      }
      if (side.prices.length !== side.levels.size) throw new Error('level map and price array differ');
      for (const level of side.levels.values()) {
        let q = 0;
        let c = 0;
        let lastSeq = -Infinity;
        for (const o of level.orders()) {
          if (o.seq <= lastSeq) throw new Error('FIFO order violated');
          lastSeq = o.seq;
          if (o.remaining <= 0) throw new Error('empty order resting on book');
          if (this.orders.get(o.id) !== o) throw new Error('order index out of sync');
          q += o.remaining;
          c++;
        }
        if (q !== level.totalQty || c !== level.count) throw new Error('level aggregates out of sync');
        if (c === 0) throw new Error('empty level left on book');
      }
    }
    const b = this.bestBid();
    const a = this.bestAsk();
    if (b !== null && a !== null && b >= a) throw new Error('book is crossed');
    return true;
  }
}

function reject(reason) {
  return { id: null, status: 'rejected', reason, filled: 0, remaining: 0, unfilled: 0, avgPrice: null, trades: [] };
}
