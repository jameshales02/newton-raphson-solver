import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchCoinbase, parseCoinbase, parseKraken, validateAll, validateBar } from '../docs/data-pipeline/pipeline.js';
import { readFileSync } from 'node:fs';

test('Coinbase rows are reordered (time, low, high, open, close, volume) and sorted', () => {
  const bars = parseCoinbase([
    [120, 9, 11, 10, 10.5, 3],
    [60, 8, 10, 9, 9.5, 2],
  ]);
  assert.deepEqual(bars, [
    { ts: 60, open: 9, high: 10, low: 8, close: 9.5, volume: 2 },
    { ts: 120, open: 10, high: 11, low: 9, close: 10.5, volume: 3 },
  ]);
});

test('Coinbase fetch pages 300 minutes per request and de-duplicates', async () => {
  const start = 1_700_000_000 - (1_700_000_000 % 60);
  const end = start + 650 * 60;
  const urls = [];
  const fetchJson = async (url) => {
    urls.push(url);
    const q = new URL(url).searchParams;
    const s = Date.parse(q.get('start')) / 1000;
    const e = Date.parse(q.get('end')) / 1000;
    const rows = [];
    for (let t = e; t >= s - 60; t -= 60) rows.push([t, 1, 2, 1.5, 1.5, 1]); // one extra overlapping minute
    return rows;
  };
  const { bars, requests } = await fetchCoinbase('BTC-USD', start, end, { fetchJson });
  assert.equal(requests, 3);
  assert.equal(bars.length, 650);
  assert.equal(bars[0].ts, start);
  assert.ok(bars.every((b, i) => i === 0 || b.ts - bars[i - 1].ts === 60));
});

test('Kraken payloads parse and errors surface', () => {
  const doc = { error: [], result: { XXBTZUSD: [[60, '10', '11', '9', '10.5', '10.2', '3.5', 7]], last: 60 } };
  assert.deepEqual(parseKraken(doc), [{ ts: 60, open: 10, high: 11, low: 9, close: 10.5, volume: 3.5 }]);
  assert.throws(() => parseKraken({ error: ['EQuery:Unknown asset pair'] }), /Unknown asset pair/);
});

test('validation matches the Python rules', () => {
  assert.equal(validateBar({ ts: 61, open: 1, high: 1, low: 1, close: 1, volume: 1 }), 'timestamp not aligned to a minute');
  assert.equal(validateBar({ ts: 60, open: 1, high: 1, low: 1.5, close: 1, volume: 1 }), 'high/low inconsistent with open/close');
  assert.equal(validateBar({ ts: 60, open: 1, high: 1, low: 1, close: 1, volume: -1 }), 'negative volume');
  const { good, rejected } = validateAll([{ ts: 60, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 }, { ts: 120, open: 0, high: 1, low: 0, close: 1, volume: 1 }]);
  assert.equal(good.length, 1);
  assert.equal(rejected[0].reason, 'non-positive price');
});

test('the bundled sample is real, complete and valid', () => {
  const doc = JSON.parse(readFileSync(new URL('../docs/data-pipeline/sample/btc_eth_1m.json', import.meta.url)));
  for (const sym of ['BTC-USD', 'ETH-USD']) {
    const rows = doc.symbols[sym];
    assert.ok(rows.length >= 1000, `${sym} has ${rows.length} rows`);
    const bars = rows.map(([ts, open, high, low, close, volume]) => ({ ts, open, high, low, close, volume }));
    assert.equal(validateAll(bars).rejected.length, 0);
    assert.ok(bars.every((b, i) => i === 0 || b.ts > bars[i - 1].ts));
  }
});
