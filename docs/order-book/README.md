# Limit order book and matching engine

**Live demo:** `docs/order-book/index.html` (see the root README for how to serve the site).

## The problem

An exchange receives a stream of instructions: buy 150 at 100.02 or better, sell 40 at market, cancel order 4,812. The matching engine has to decide, deterministically and fast, who trades with whom and at what price.

Almost every venue uses **price-time priority**. The best price trades first. Among orders at the same price, the earliest trades first. This project implements that engine with limit, market and cancel orders and partial fills. The page adds a live depth chart, a price ladder, a trade tape, order entry against a simulated market, and an in-browser throughput benchmark.

## Files

| File | What it is |
|---|---|
| `orderbook.js` | The engine: `OrderBook`, `BookSide`, `PriceLevel`, `Order`. No dependencies. |
| `flow.js` | Synthetic order flow (queue-reactive model), the live-demo driver and the benchmark harness. |
| `app.js` | The page: rendering, order entry, simulation loop. |
| `../../tests/orderbook.test.js` | Rule tests, differential test against a brute-force matcher, invariant checks. |
| `../../bench/orderbook-bench.js` | Throughput and per-call latency benchmark (`npm run bench`). |

## Design choices

### Data structures

```
asks.prices  [10007, 10005, 10003]        sorted worst -> best; best ask is the LAST element
asks.levels  Map(price -> PriceLevel)
PriceLevel   head <-> order <-> order <-> tail      intrusive doubly linked FIFO
             totalQty, count                         running aggregates for depth
orders       Map(id -> Order)                        O(1) lookup for cancel
```

* **Integer tick prices.** 100.03 is stored as 10003, so equality and ordering are exact.
* **Sorted price array, best price last.** The touch is `prices[prices.length - 1]`, and removing an exhausted best level is `pop()`. A new level is placed by binary search. Most new levels are created at or near the touch, so the `splice` usually shifts only a few elements.
* **Price -> level hash map** so that joining an existing level never searches.
* **Intrusive doubly linked FIFO per level.** Each order holds its own `prev`/`next`, so append, pop-front and unlink-from-the-middle (cancel) are O(1) with no allocation.
* **Order id -> order map** so cancel never scans.

| Operation | Cost |
|---|---|
| Best bid / ask | O(1) |
| Add at an existing price | O(1) |
| Add at a new price | O(log L) search + O(k) shift, k = levels better than the new one |
| Each fill | O(1) |
| Cancel | O(1), plus O(log L) if the level empties |
| Depth snapshot of n levels | O(n) |

I chose the sorted array over a red-black tree. With L in the hundreds, a contiguous `number[]` is far friendlier to the cache than a pointer-based tree, and activity concentrates at the touch, where the array is cheapest. A tree would only win with thousands of levels and uniform insertion. Engines with a bounded price band often use a flat array indexed by tick offset, which makes every lookup O(1).

### Matching rules

* A buy matches while `bestAsk <= limit` (a sell while `bestBid >= limit`). Market orders have no limit.
* Each fill trades `q = min(q_incoming, q_resting)` at the **resting order's price**.
* A partially filled resting order keeps its place at the head of its queue. A partially filled incoming limit order rests its remainder at its limit price.
* Market orders are immediate-or-cancel: the unfilled remainder is cancelled, never rested.
* After every event the book is uncrossed: `bestBid < bestAsk`.

### Simulated order flow

The live market and the benchmark share a queue-reactive flow model, loosely after Cont, Stoikov & Talreja (2010). Limit orders arrive at rate λ_L and market orders at rate λ_M. Each resting order is cancelled at rate θ, so with N orders resting the next event is a cancel with probability

$$P(\text{cancel}) = \frac{\theta N}{\lambda_L + \lambda_M + \theta N}$$

Because cancellation grows with book size, the book has a stable equilibrium depth. With the defaults that is about 3,000 orders over 60 to 100 levels per side. Limit prices are `round(F) ∓ δ`, where `δ = floor(X) - 1`, `X ~ Exp(mean 10 ticks)` and `F` is a latent random-walk fair value. So `P(δ = -1) = 1 - e^{-0.1} ≈ 9.5%` of limit orders are priced through fair value.

## Results

`npm run bench` on Node 22, one core of a shared cloud VM, 1,000,000 events, median of 5 runs (three separate sessions):

| Metric | Result |
|---|---|
| Throughput | **3.3 to 4.0 million operations / second** (≈ 250–300 ns per operation) |
| Event mix | 65% limit, 4% market, 32% cancel |
| Trades generated | ≈ 356,000 (≈ 3.5 M shares) |
| Per-call latency | p50 ≈ 170 ns, p90 ≈ 400 ns, p99 < 1 µs, p99.9 a few µs |
| End state | ≈ 3,000 resting orders on ≈ 65 levels per side |

How it is measured: every random number in the stream is drawn **before** the clock starts. The timed loop does only two things besides calling the engine: it picks the event type from a pre-drawn uniform, and it maintains the list of resting ids that cancels target. A warm-up pass on a different stream runs first so the JIT has compiled the hot paths. The tail latency (p99.9) is dominated by garbage collection and timer resolution, not the algorithm.

## Tests

`npm test` runs `tests/orderbook.test.js`:

* **Rules:** FIFO at one price; price priority across levels; maker-price execution; partial fills on both sides; queue position kept after a partial fill; market sweep and IOC residual; cancel from the middle of a queue; idempotent cancel; rejection of invalid input.
* **Differential test:** a deliberately naive matcher re-sorts the whole book on every event. Over 15,000 random events (five seeds), the engine's trade sequence (price, qty, maker id, taker id) and final aggregated depth match it **exactly**.
* **Invariants** checked throughout a 20,000-event simulation: sorted levels, level aggregates equal their queues, FIFO sequence increasing, id index in sync, no empty levels, uncrossed book, volume conserved.

## Limitations

* Single instrument, single thread, in memory. There is no journal or replay log, so state is lost on a crash.
* No self-trade prevention, no amend (cancel and resubmit loses priority, as on most venues), and no IOC/FOK/post-only flags on limit orders.
* No auctions, and no price-band or tick-size validation beyond positive integer ticks.
* JavaScript GC adds tail latency. A production engine would pool order objects and avoid allocating trade records on the hot path.
* The price-array `splice` is O(L) in the worst case, for a new level far from the touch on a very deep book.
