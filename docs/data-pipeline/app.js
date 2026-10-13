import { fetchCoinbase, fetchKraken, validateAll, UPSERT_SQL } from './pipeline.js';
import { XYChart } from '../assets/chart.js';
import { quantile } from '../assets/stats.js';
import { $, $$, el, val, fmtInt, fmtPct, busy } from '../assets/ui.js';

const SQLJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/sql-asm.js';
const SQL_FILES = ['schema.sql', 'rolling_stats.sql', 'rolling_corr.sql', 'quality.sql'];
const SYMBOLS = ['BTC-USD', 'ETH-USD'];

let SQL = null;
let db = null;
const sqlText = {};
let lastIngest = null;

// ---------- time axis ----------
const pad2 = (n) => String(n).padStart(2, '0');
const hhmm = (ts) => {
  const d = new Date(ts * 1000);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
};
const stamp = (ts) => {
  const d = new Date(ts * 1000);
  return `${d.toISOString().slice(5, 10)} ${hhmm(ts)} UTC`;
};
function timeTicks(lo, hi, pw) {
  const steps = [900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];
  const step = steps.find((s) => (hi - lo) / s <= pw / 70) || 86400;
  const out = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) out.push(t);
  return out;
}
const timeAxis = { format: hhmm, ticks: timeTicks };

const priceChart = new XYChart('#price-chart', {
  title: 'Price and VWAP',
  legend: true,
  height: 270,
  x: timeAxis,
  tipX: stamp,
  y: { format: (v) => (v >= 10000 ? (v / 1000).toFixed(1) + 'K' : v.toFixed(0)) },
  tipY: (v) => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  ariaLabel: 'Close price with rolling and session VWAP',
});
const volChart = new XYChart('#vol-chart', {
  title: 'Realised volatility (annualised)',
  legend: true,
  height: 220,
  x: timeAxis,
  tipX: stamp,
  y: { format: (v) => (v * 100).toFixed(0) + '%', includeZero: true },
  tipY: (v) => (v * 100).toFixed(1) + '%',
  ariaLabel: 'Rolling realised and Parkinson volatility for BTC and ETH',
});
const corrChart = new XYChart('#corr-chart', {
  title: 'Rolling BTC–ETH return correlation',
  height: 220,
  x: timeAxis,
  tipX: stamp,
  y: { format: (v) => v.toFixed(1), max: 1 },
  tipY: (v) => v.toFixed(3),
  ariaLabel: 'Rolling correlation of one-minute returns between BTC and ETH',
});

// ---------- step indicator ----------
function step(name, state, meta = '') {
  const li = $(`#steps [data-step="${name}"]`);
  li.dataset.state = state;
  li.querySelector('.meta').textContent = meta;
}
function resetSteps() {
  for (const li of $$('#steps li')) {
    li.dataset.state = '';
    li.querySelector('.meta').textContent = '';
  }
}

// ---------- engine ----------
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('could not load sql.js from cdnjs'));
    document.head.appendChild(s);
  });
}

async function loadEngine() {
  if (SQL) return;
  await loadScript(SQLJS_URL);
  SQL = await window.initSqlJs();
  for (const f of SQL_FILES) {
    const res = await fetch(`sql/${f}`);
    if (!res.ok) throw new Error(`could not load sql/${f}`);
    sqlText[f] = await res.text();
  }
  $('#sql-stats-src').textContent = sqlText['rolling_stats.sql'];
  $('#sql-corr-src').textContent = sqlText['rolling_corr.sql'];
}

function freshDb() {
  db?.close();
  db = new SQL.Database();
  try {
    db.exec('SELECT ln(2.0), sqrt(4.0)');
  } catch {
    db.create_function('ln', (x) => (x > 0 ? Math.log(x) : null));
    db.create_function('sqrt', (x) => (x >= 0 ? Math.sqrt(x) : null));
  }
  db.exec(sqlText['schema.sql']);
}

function query(sql, params = {}) {
  const stmt = db.prepare(sql);
  const bound = {};
  for (const [k, v] of Object.entries(params)) bound[':' + k] = v;
  stmt.bind(bound);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

// ---------- pipeline ----------
async function fetchSample() {
  const res = await fetch('sample/btc_eth_1m.json');
  if (!res.ok) throw new Error('could not load the bundled sample');
  const doc = await res.json();
  const data = {};
  for (const s of SYMBOLS) data[s] = doc.symbols[s].map(([ts, open, high, low, close, volume]) => ({ ts, open, high, low, close, volume }));
  return { data, requests: 1, source: 'sample', label: `recorded ${stamp(doc.symbols[SYMBOLS[0]].at(-1)[0]).slice(0, 5)} from ${doc.source}` };
}

async function fetchLive(source, hours) {
  const now = Math.floor(Date.now() / 1000);
  const end = now - (now % 60); // skip the minute that is still forming
  const start = end - hours * 3600;
  const data = {};
  let requests = 0;
  for (const s of SYMBOLS) {
    const r = source === 'coinbase' ? await fetchCoinbase(s, start, end, { onRequest: () => step('fetch', 'run', `${requests + 1} requests…`) }) : await fetchKraken(s, start - 60);
    data[s] = r.bars.filter((b) => b.ts < end);
    requests += r.requests;
  }
  return { data, requests, source, label: `live from ${source === 'coinbase' ? 'Coinbase' : 'Kraken'}` };
}

async function runPipeline() {
  resetSteps();
  const source = val('source');
  const note = $('#source-note');
  try {
    step('engine', 'run');
    const te = performance.now();
    await loadEngine();
    step('engine', 'done', `sql.js · ${(performance.now() - te).toFixed(0)} ms`);
  } catch (e) {
    step('engine', 'fail', 'failed');
    note.textContent = `The SQLite engine could not load (${e.message}). Check your connection and run again.`;
    return;
  }

  step('fetch', 'run');
  const tf = performance.now();
  let got;
  try {
    got = source === 'sample' ? await fetchSample() : await fetchLive(source, Number(val('hours')));
    note.textContent = source === 'sample' ? 'The sample was recorded by the Python pipeline. Live sources fetch straight from the exchange’s public API in your browser.' : `Fetched live in your browser at ${stamp(Math.floor(Date.now() / 1000))}.`;
  } catch (e) {
    step('fetch', 'fail', 'live fetch failed');
    note.textContent = `Live fetch failed (${e.message}). This host may block requests to exchange APIs. Falling back to the recorded sample.`;
    got = await fetchSample();
  }
  const fetched = SYMBOLS.reduce((s, k) => s + got.data[k].length, 0);
  step('fetch', 'done', `${fmtInt(fetched)} bars · ${got.requests} req · ${(performance.now() - tf).toFixed(0)} ms`);

  step('validate', 'run');
  const checked = {};
  let rejected = 0;
  for (const s of SYMBOLS) {
    checked[s] = validateAll(got.data[s]);
    rejected += checked[s].rejected.length;
  }
  step('validate', 'done', `${rejected} rejected`);

  step('store', 'run');
  const ts0 = performance.now();
  freshDb();
  const now = Math.floor(Date.now() / 1000);
  db.exec('BEGIN');
  const stmt = db.prepare(UPSERT_SQL);
  for (const s of SYMBOLS) {
    for (const b of checked[s].good) stmt.run([s, b.ts, b.open, b.high, b.low, b.close, b.volume, got.source, now]);
  }
  stmt.free();
  for (const s of SYMBOLS) {
    const bars = checked[s].good;
    db.run('INSERT INTO ingest_runs (source, symbol, started_at, finished_at, rows_fetched, rows_written, rows_rejected, first_ts, last_ts, status) VALUES (?,?,?,?,?,?,?,?,?,?)', [
      got.source,
      s,
      now,
      Math.floor(Date.now() / 1000),
      got.data[s].length,
      bars.length,
      checked[s].rejected.length,
      bars[0]?.ts ?? null,
      bars.at(-1)?.ts ?? null,
      'ok',
    ]);
  }
  db.exec('COMMIT');
  const stored = query('SELECT COUNT(*) AS n FROM bars')[0].n;
  step('store', 'done', `${fmtInt(stored)} rows · ${(performance.now() - ts0).toFixed(0)} ms`);
  lastIngest = { stored, rejected, label: got.label };

  step('quality', 'run');
  renderQuality();
  step('quality', 'done', 'ok');
  analyse();
  runConsole();
}

function renderQuality() {
  const rows = query(sqlText['quality.sql']);
  const tr = rows.map((r) =>
    el(
      'tr',
      {},
      el('td', { text: r.symbol }),
      el('td', { text: fmtInt(r.bars) }),
      el('td', { class: 'mono', text: stamp(r.first_ts) }),
      el('td', { class: 'mono', text: stamp(r.last_ts) }),
      el('td', { text: fmtInt(r.missing_minutes) }),
      el('td', { text: fmtInt(r.gaps) }),
      el('td', { text: `${r.longest_gap_minutes} min` }),
      el('td', {}, el('span', { class: `pill ${r.ohlc_violations ? 'bad' : 'good'}`, text: r.ohlc_violations ? String(r.ohlc_violations) : 'none' })),
      el('td', { text: fmtInt(r.zero_volume_bars) }),
    ),
  );
  $('#quality-table tbody').replaceChildren(...tr);
}

function analyse() {
  if (!db) return;
  step('stats', 'run');
  const t0 = performance.now();
  const window = Number(val('window'));
  const sym = val('symbol');
  const stats = {};
  for (const s of SYMBOLS) stats[s] = query(sqlText['rolling_stats.sql'], { symbol: s, window });
  const corr = query(sqlText['rolling_corr.sql'], { a: 'BTC-USD', b: 'ETH-USD', window });
  const ms = performance.now() - t0;
  step('stats', 'done', `3 queries · ${ms.toFixed(0)} ms`);

  const st = stats[sym];
  const xs = st.map((r) => r.ts);
  const num = (v) => (v === null || v === undefined ? NaN : v);
  priceChart.setSeries([
    { name: `${sym} close`, color: '--ink', x: xs, y: st.map((r) => r.close), width: 1.5 },
    { name: `${window}-minute VWAP`, color: '--s2', x: xs, y: st.map((r) => num(r.vwap)) },
    { name: 'Session VWAP (from 00:00 UTC)', color: '--s7', x: xs, y: st.map((r) => num(r.session_vwap)), dash: [5, 4], width: 1.5 },
  ]);
  priceChart.opts.title = `${sym} price and VWAP`;
  const volSeries = [];
  const cols = { 'BTC-USD': '--s1', 'ETH-USD': '--s3' };
  for (const s of SYMBOLS) {
    const x = stats[s].map((r) => r.ts);
    volSeries.push({ name: `${s.slice(0, 3)} close-to-close`, color: cols[s], x, y: stats[s].map((r) => num(r.rv_ann)), width: 1.75 });
    volSeries.push({ name: `${s.slice(0, 3)} Parkinson`, color: cols[s], x, y: stats[s].map((r) => num(r.park_ann)), width: 1.25, dash: [4, 3], alpha: 0.8 });
  }
  volChart.setSeries(volSeries);
  const cv = corr.map((r) => num(r.corr));
  const finiteCorr = cv.filter(Number.isFinite);
  corrChart.opts.y.min = Math.min(0, ...finiteCorr);
  corrChart.setSeries([{ name: 'Correlation', color: '--s7', type: 'area', fillTo: 0, x: corr.map((r) => r.ts), y: cv }], { hLines: [{ y: quantile(finiteCorr, 0.5), label: `median ${quantile(finiteCorr, 0.5).toFixed(2)}`, color: '--ink-2' }] });

  // tiles
  const last = [...st].reverse().find((r) => r.vwap !== null) || st.at(-1);
  $('#t-bars').textContent = fmtInt(lastIngest.stored);
  $('#t-bars-sub').textContent = `${lastIngest.rejected} rejected · ${lastIngest.label}`;
  $('#t-last').textContent = last.close.toLocaleString('en-US', { maximumFractionDigits: 2 });
  $('#t-last-sub').textContent = `${sym} at ${stamp(last.ts)}`;
  const dev = (last.close / last.vwap - 1) * 1e4;
  $('#t-vwap').textContent = `${dev >= 0 ? '+' : '−'}${Math.abs(dev).toFixed(1)} bp`;
  $('#t-vwap-sub').textContent = `${window}-min VWAP ${last.vwap.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  $('#t-rv').textContent = fmtPct(last.rv_ann, 1);
  $('#t-rv-sub').textContent = `${sym.slice(0, 3)}, ${window} min; Parkinson ${fmtPct(last.park_ann, 1)}`;
  const lastCorr = [...corr].reverse().find((r) => r.corr !== null);
  $('#t-corr').textContent = lastCorr ? lastCorr.corr.toFixed(2) : '–';
  $('#t-corr-sub').textContent = finiteCorr.length ? `${window}-min window; median ${quantile(finiteCorr, 0.5).toFixed(2)}` : 'not enough overlapping minutes';
}

// ---------- SQL console ----------
const EXAMPLES = {
  hourly: `-- Hourly bars aggregated from the minute table
SELECT symbol,
       datetime(ts / 3600 * 3600, 'unixepoch') AS hour_utc,
       MAX(high)               AS high,
       MIN(low)                AS low,
       ROUND(SUM(volume), 2)   AS volume,
       COUNT(*)                AS bars
FROM bars
GROUP BY symbol, ts / 3600
ORDER BY hour_utc DESC, symbol
LIMIT 48;`,
  moves: `-- The largest one-minute moves, in basis points
SELECT symbol,
       datetime(ts, 'unixepoch') AS minute_utc,
       ROUND(r * 1e4, 1)          AS move_bp
FROM returns
WHERE r IS NOT NULL
ORDER BY ABS(r) DESC
LIMIT 20;`,
  beta: `-- Hourly OLS beta of ETH returns on BTC returns (synchronous minutes only)
WITH x AS (SELECT ts, r FROM returns WHERE symbol = 'BTC-USD' AND dt = 60),
     y AS (SELECT ts, r FROM returns WHERE symbol = 'ETH-USD' AND dt = 60)
SELECT datetime(x.ts / 3600 * 3600, 'unixepoch') AS hour_utc,
       COUNT(*) AS n,
       ROUND((COUNT(*) * SUM(x.r * y.r) - SUM(x.r) * SUM(y.r))
           / (COUNT(*) * SUM(x.r * x.r) - SUM(x.r) * SUM(x.r)), 3) AS beta_eth_on_btc
FROM x JOIN y USING (ts)
GROUP BY x.ts / 3600
ORDER BY hour_utc DESC;`,
  runs: `SELECT * FROM ingest_runs ORDER BY run_id DESC;`,
};

function runConsole() {
  if (!db) return;
  const sql = $('#sql-input').value;
  const status = $('#sql-status');
  const table = $('#sql-result');
  try {
    const t0 = performance.now();
    const res = db.exec(sql);
    const ms = performance.now() - t0;
    if (!res.length) {
      table.replaceChildren();
      status.textContent = `Done in ${ms.toFixed(1)} ms; no rows returned.`;
      return;
    }
    const { columns, values } = res[res.length - 1];
    const shown = values.slice(0, 200);
    table.replaceChildren(
      el('thead', {}, el('tr', {}, ...columns.map((c) => el('th', { text: c })))),
      el('tbody', {}, ...shown.map((row) => el('tr', {}, ...row.map((v) => el('td', { text: v === null ? 'NULL' : typeof v === 'number' && !Number.isInteger(v) ? String(+v.toPrecision(10)) : String(v) }))))),
    );
    status.textContent = `${values.length} row${values.length === 1 ? '' : 's'} in ${ms.toFixed(1)} ms${values.length > 200 ? ', first 200 shown' : ''}.`;
  } catch (e) {
    status.textContent = `SQL error: ${e.message}`;
  }
}

// ---------- wiring ----------
$('#sql-input').value = EXAMPLES.hourly;
for (const b of $$('[data-example]')) {
  b.addEventListener('click', () => {
    $('#sql-input').value = EXAMPLES[b.getAttribute('data-example')];
    runConsole();
  });
}
$('#sql-run').addEventListener('click', runConsole);
$('#sql-input').addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') runConsole();
});
$('#source').addEventListener('change', () => {
  $('#hours-field').hidden = val('source') !== 'coinbase';
});
$('#run').addEventListener('click', (e) => busy(e.currentTarget, 'Running…', runPipeline));
$('#window').addEventListener('change', analyse);
$('#symbol').addEventListener('change', analyse);

busy($('#run'), 'Running…', runPipeline);
