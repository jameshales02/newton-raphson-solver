// Browser side of the market-data pipeline. Mirrors python/marketdata/sources.py:
// fetch one-minute candles from public endpoints, validate them, and turn them into
// rows for the shared SQLite schema (sql/schema.sql), executed here by sql.js.

export const COINBASE_URL = 'https://api.exchange.coinbase.com/products/{product}/candles';
export const KRAKEN_URL = 'https://api.kraken.com/0/public/OHLC';
export const KRAKEN_PAIRS = { 'BTC-USD': 'XBTUSD', 'ETH-USD': 'ETHUSD' };

export function validateBar(b) {
  if (b.ts % 60) return 'timestamp not aligned to a minute';
  if (Math.min(b.open, b.high, b.low, b.close) <= 0) return 'non-positive price';
  if (b.low > Math.min(b.open, b.close) || b.high < Math.max(b.open, b.close)) return 'high/low inconsistent with open/close';
  if (b.volume < 0) return 'negative volume';
  return null;
}

const iso = (ts) => new Date(ts * 1000).toISOString().slice(0, 19) + 'Z';

export function parseCoinbase(rows) {
  return rows.map(([ts, low, high, open, close, volume]) => ({ ts, open, high, low, close, volume })).sort((a, b) => a.ts - b.ts);
}

// All candles with start <= ts < end, 300 minutes per request.
export async function fetchCoinbase(product, start, end, { fetchJson = defaultFetchJson, onRequest } = {}) {
  const out = new Map();
  const chunk = 300 * 60;
  let t = start - (start % 60);
  let requests = 0;
  while (t < end) {
    const tEnd = Math.min(end, t + chunk);
    const url = `${COINBASE_URL.replace('{product}', encodeURIComponent(product))}?granularity=60&start=${iso(t)}&end=${iso(tEnd - 60)}`;
    const rows = await fetchJson(url);
    requests++;
    onRequest?.(requests);
    if (!Array.isArray(rows)) throw new Error(`Coinbase error for ${product}: ${rows?.message ?? 'unexpected response'}`);
    for (const b of parseCoinbase(rows)) if (b.ts >= start && b.ts < end) out.set(b.ts, b);
    t = tEnd;
  }
  return { bars: [...out.values()].sort((a, b) => a.ts - b.ts), requests };
}

export function parseKraken(doc) {
  if (doc.error && doc.error.length) throw new Error(`Kraken error: ${doc.error.join(', ')}`);
  const key = Object.keys(doc.result).find((k) => k !== 'last');
  return doc.result[key].map((r) => ({ ts: +r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[6] }));
}

export async function fetchKraken(symbol, since, { fetchJson = defaultFetchJson } = {}) {
  const pair = KRAKEN_PAIRS[symbol] ?? symbol.replace('-', '');
  const doc = await fetchJson(`${KRAKEN_URL}?pair=${pair}&interval=1&since=${since}`);
  return { bars: parseKraken(doc).filter((b) => b.ts > since), requests: 1 };
}

async function defaultFetchJson(url, { timeoutMs = 10000, retries = 2 } = {}) {
  let delay = 800;
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
      if ((res.status === 429 || res.status >= 500) && attempt < retries) throw Object.assign(new Error(`HTTP ${res.status}`), { retry: true });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
      return await res.json();
    } catch (e) {
      if (attempt >= retries || !(e.retry || e.name === 'AbortError')) throw e;
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
    } finally {
      clearTimeout(timer);
    }
  }
}

// Split into valid rows and rejects (with reasons).
export function validateAll(bars) {
  const good = [];
  const rejected = [];
  for (const b of bars) {
    const reason = validateBar(b);
    if (reason) rejected.push({ bar: b, reason });
    else good.push(b);
  }
  return { good, rejected };
}

export const UPSERT_SQL = `INSERT INTO bars (symbol, ts, open, high, low, close, volume, source, ingested_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (symbol, ts) DO UPDATE SET
  open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close,
  volume = excluded.volume, source = excluded.source, ingested_at = excluded.ingested_at`;
