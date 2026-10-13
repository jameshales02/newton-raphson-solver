// Order book throughput benchmark: `npm run bench` (or node bench/orderbook-bench.js [n]).
// Reports throughput over a pre-drawn order stream, then per-call latency
// percentiles measured with process.hrtime on a second pass.

import { OrderBook } from '../docs/order-book/orderbook.js';
import { benchmark, generateOps, runOps } from '../docs/order-book/flow.js';

const n = Number(process.argv[2]) || 1_000_000;
const runs = 5;

console.log(`Order book benchmark: ${n.toLocaleString()} operations x ${runs} runs (Node ${process.version}, ${process.arch})`);
const results = [];
for (let i = 0; i < runs; i++) {
  const r = benchmark(n);
  results.push(r);
  console.log(`  run ${i + 1}: ${(r.opsPerSec / 1e6).toFixed(2)}M ops/s  (${r.nsPerOp.toFixed(0)} ns/op)`);
}
results.sort((a, b) => a.opsPerSec - b.opsPerSec);
const med = results[Math.floor(runs / 2)];
console.log(`Median: ${(med.opsPerSec / 1e6).toFixed(2)}M ops/s`);
console.log(`Mix: ${med.mix.limits.toLocaleString()} limit, ${med.mix.markets.toLocaleString()} market, ${med.mix.cancels.toLocaleString()} cancel (${med.cancelsHit.toLocaleString()} hit a live order)`);
console.log(`Trades: ${med.trades.toLocaleString()}, volume ${med.volume.toLocaleString()}`);
console.log(`End state: ${med.resting.toLocaleString()} resting orders on ${med.bidLevels} bid / ${med.askLevels} ask levels`);

const lat = [];
runOps(new OrderBook(), generateOps(n), (ns) => lat.push(ns));
lat.sort((a, b) => a - b);
const pct = (p) => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))];
console.log(`Latency per engine call (includes ~30-60 ns timer overhead): p50 ${pct(0.5)} ns, p90 ${pct(0.9)} ns, p99 ${pct(0.99)} ns, p99.9 ${pct(0.999)} ns`);
