import {
  generateBars,
  parseCsv,
  runBacktest,
  lookaheadAudit,
  overfitStudy,
  walkForward,
  drawdownSeries,
} from './backtest.js';
import { XYChart } from '../assets/chart.js';
import { mean, std } from '../assets/stats.js';
import { $, $$, el, num, val, checked, fmtPct, fmtNum, fmtMoney, fmtInt, signClass, debounce, busy, nextFrame } from '../assets/ui.js';

let csvBars = null;
let bars = null;
let lastKey = '';

const dateTicks = () => (lo, hi, pw) => {
  // ticks on year boundaries (x is a bar index)
  if (!bars) return [];
  const out = [];
  let lastYear = null;
  const step = Math.max(1, Math.ceil((hi - lo) / Math.max(1, pw / 70) / 252));
  for (let i = Math.max(0, Math.ceil(lo)); i <= Math.min(bars.length - 1, hi); i++) {
    const y = +bars[i].date.slice(0, 4);
    if (y !== lastYear) {
      if (lastYear !== null && y % step === 0) out.push(i);
      lastYear = y;
    }
  }
  return out;
};
const dateFmt = (i) => (bars && bars[Math.round(i)] ? bars[Math.round(i)].date.slice(0, 4) : '');
const dateTip = (i) => (bars && bars[Math.round(i)] ? bars[Math.round(i)].date : '');

const equityChart = new XYChart('#equity-chart', {
  title: 'Growth of $1',
  legend: true,
  height: 260,
  x: { format: dateFmt, ticks: dateTicks() },
  tipX: dateTip,
  y: { format: (v) => '$' + v.toFixed(2) },
  ariaLabel: 'Strategy equity against buy and hold',
});
const ddChart = new XYChart('#dd-chart', {
  title: 'Drawdown',
  height: 170,
  x: { format: dateFmt, ticks: dateTicks() },
  tipX: dateTip,
  y: { format: (v) => (v * 100).toFixed(0) + '%', max: 0 },
  tipY: (v) => (v * 100).toFixed(1) + '%',
  ariaLabel: 'Strategy drawdown from its running peak',
});
const expChart = new XYChart('#exp-chart', {
  title: 'Exposure (position value / equity)',
  height: 170,
  x: { format: dateFmt, ticks: dateTicks() },
  tipX: dateTip,
  y: { format: (v) => v.toFixed(1) + '×', includeZero: true },
  tipY: (v) => v.toFixed(2) + '×',
  ariaLabel: 'Position exposure over time',
});
const scatterChart = new XYChart('#scatter-chart', {
  title: 'Does in-sample rank predict out-of-sample?',
  height: 220,
  crosshair: false,
  x: { format: (v) => v.toFixed(1), label: 'IS', pad: 0.06 },
  y: { format: (v) => v.toFixed(1), pad: 0.12 },
  ariaLabel: 'Scatter of in-sample against out-of-sample Sharpe for each parameter pair',
});
const wfChart = new XYChart('#wf-chart', {
  title: 'Out-of-sample growth of $1',
  legend: true,
  height: 220,
  x: { format: dateFmt, ticks: dateTicks() },
  tipX: dateTip,
  y: { format: (v) => '$' + v.toFixed(2) },
  ariaLabel: 'Walk-forward equity against the in-sample winner traded out of sample',
});

// ---------- inputs ----------
function strategySpec() {
  const kind = val('strat');
  if (kind === 'sma') {
    const fast = Math.max(2, Math.round(num('p-fast')));
    const slow = Math.max(fast + 1, Math.round(num('p-slow')));
    return { kind, params: { fast, slow }, label: `MA ${fast}/${slow}` };
  }
  if (kind === 'momentum') {
    const lookback = Math.max(1, Math.round(num('p-look')));
    return { kind, params: { lookback }, label: `${lookback}-day momentum` };
  }
  const lookback = Math.max(3, Math.round(num('p-zlook')));
  const entry = Math.max(0.25, num('p-entry'));
  return { kind, params: { lookback, entry, exit: 0.25 }, label: `z-score ${lookback}, entry ${entry}` };
}

function config() {
  return {
    timing: val('timing'),
    halfSpreadBps: num('c-spread'),
    impactCoef: num('c-impact'),
    commissionPerShare: num('c-comm'),
    minCommission: num('c-min'),
    sizing: val('sizing'),
    targetVol: num('s-vol') / 100,
    fraction: num('s-frac') / 100,
    maxLeverage: num('s-lev'),
    longOnly: checked('long-only'),
  };
}

function loadBars() {
  if (val('source') === 'csv') return csvBars;
  const years = Math.min(30, Math.max(3, Math.round(num('years'))));
  return generateBars({ n: years * 252, seed: Math.max(1, Math.round(num('seed'))), regime: val('regime') });
}

function syncVisibility() {
  const src = val('source');
  for (const f of $$('[data-src-for]')) f.hidden = f.getAttribute('data-src-for') !== src;
  const s = val('strat');
  for (const f of $$('[data-strat]')) f.hidden = f.getAttribute('data-strat') !== s;
  const z = val('sizing');
  for (const f of $$('[data-size]')) f.hidden = f.getAttribute('data-size') !== z;
}

// ---------- main backtest ----------
function runMain() {
  bars = loadBars();
  if (!bars) {
    $('#m-sharpe').textContent = '–';
    $('#csv-status').textContent = 'Choose a CSV file to backtest it.';
    return;
  }
  const spec = strategySpec();
  const cfg = config();
  const res = runBacktest(bars, spec, cfg);
  const m = res.metrics;
  const x = Array.from({ length: bars.length }, (_, i) => i);
  const start = res.metrics.days ? bars.length - 1 - res.metrics.days : 0;
  const eq = Array.from(res.equity, (v) => v / res.equity[Math.max(0, start)]);
  const p0 = bars[Math.max(0, start)].close;
  const bh = bars.map((b) => b.close / p0);
  for (let i = 0; i < start; i++) {
    eq[i] = NaN;
    bh[i] = NaN;
  }
  equityChart.setSeries([
    { name: spec.label, color: '--s1', x, y: eq, endDot: true },
    { name: 'Buy and hold', color: '--neutral-series', x, y: bh, width: 1.5 },
  ], { hLines: [{ y: 1, color: '--line-strong', dash: false }] });
  ddChart.setSeries([{ name: 'Drawdown', color: '--s8', type: 'area', x, y: Array.from(drawdownSeries(res.equity)) }]);
  expChart.setSeries([{ name: 'Exposure', color: '--s3', type: 'stepArea', x, y: Array.from(res.exposure) }]);

  const sr = $('#m-sharpe');
  sr.textContent = fmtNum(m.sharpe, 2);
  sr.className = 'value ' + signClass(m.sharpe);
  $('#m-sharpe-sub').textContent = `± ${m.sharpeSE.toFixed(2)} std error`;
  const cg = $('#m-cagr');
  cg.textContent = fmtPct(m.cagr, 1);
  cg.className = 'value ' + signClass(m.cagr);
  $('#m-cagr-sub').textContent = `vol ${fmtPct(m.annVol, 1)}, Sortino ${fmtNum(m.sortino, 2)}`;
  $('#m-dd').textContent = fmtPct(-m.maxDD, 1);
  $('#m-dd-sub').textContent = `longest underwater ${fmtInt(m.longestDDDays)} days`;
  $('#m-win').textContent = Number.isFinite(m.winRate) ? fmtPct(m.winRate, 0) : '–';
  $('#m-win-sub').textContent = `${m.trades} round trips, profit factor ${Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : '–'}`;
  const totalCosts = res.costs.commission + res.costs.spread + res.costs.impact;
  $('#m-cost').textContent = fmtMoney(totalCosts);
  $('#m-cost-sub').textContent = `${fmtMoney(res.costs.commission)} fees, ${fmtMoney(res.costs.spread + res.costs.impact)} slippage`;

  renderTrades(res);
  return res;
}

function renderTrades(res) {
  const rows = res.trades.slice(-12).reverse().map((t) =>
    el(
      'tr',
      {},
      el('td', { class: 'mono', text: t.entryDate }),
      el('td', { class: 'mono', text: t.open ? `${t.exitDate} (open)` : t.exitDate }),
      el('td', {}, el('span', { class: `side-tag ${t.side > 0 ? 'buy' : 'sell'}`, text: t.side > 0 ? 'Long' : 'Short' })),
      el('td', { text: fmtInt((Date.parse(t.exitDate) - Date.parse(t.entryDate)) / 86400000) }),
      el('td', { text: fmtInt(t.maxShares) }),
      el('td', { text: fmtMoney(t.costs) }),
      el('td', { class: signClass(t.pnl), text: fmtMoney(t.pnl) }),
    ),
  );
  if (!rows.length) rows.push(el('tr', {}, el('td', { colspan: 7, class: 'hint', text: 'No trades yet: the strategy is still warming up or never signalled.' })));
  $('#trades-table tbody').replaceChildren(...rows);
  $('#trades-note').textContent = `latest ${Math.min(12, res.trades.length)} of ${res.trades.length}`;
}

// ---------- look-ahead audit ----------
const TIMINGS = [
  ['next_open', "Next bar's open (correct)"],
  ['same_close', "Signal bar's close (optimistic)"],
  ['same_open', "Signal bar's open (look-ahead bug)"],
];

function runAudit() {
  if (!bars) return;
  const spec = strategySpec();
  const base = config();
  const rows = [];
  let currentPass = true;
  for (const [timing, label] of TIMINGS) {
    const cfg = { ...base, timing };
    const r = runBacktest(bars, spec, cfg);
    const mom = runBacktest(bars, { kind: 'momentum', params: { lookback: 1 } }, cfg);
    const audit = lookaheadAudit(bars, spec, cfg, { samples: 6 });
    if (timing === base.timing) currentPass = audit.pass;
    const pill = audit.samples === 0 ? el('span', { class: 'pill', text: 'No trades to audit' }) : el('span', { class: `pill ${audit.pass ? 'good' : 'bad'}`, text: audit.pass ? `Pass (${audit.samples} trade days)` : `Fail on ${audit.violations.length} of ${audit.samples} days` });
    rows.push(
      el(
        'tr',
        timing === base.timing ? { style: { fontWeight: 600 } } : {},
        el('td', { text: label }),
        el('td', { class: signClass(r.metrics.sharpe), text: fmtNum(r.metrics.sharpe, 2) }),
        el('td', { class: signClass(r.metrics.cagr), text: fmtPct(r.metrics.cagr, 1) }),
        el('td', { class: signClass(mom.metrics.sharpe), text: fmtNum(mom.metrics.sharpe, 2) }),
        el('td', {}, pill),
      ),
    );
  }
  $('#bias-table tbody').replaceChildren(...rows);
  $('#audit-pill').replaceChildren(el('span', { class: `pill ${currentPass ? 'good' : 'bad'}`, text: currentPass ? 'Current settings: no look-ahead found' : 'Current settings: look-ahead detected' }));
}

// ---------- overfitting lab ----------
function divergingColor(v, vmax = 1.5) {
  const css = getComputedStyle(document.documentElement);
  const hex = (name) => css.getPropertyValue(name).trim();
  const parse = (h) => {
    const m = h.match(/^#?([0-9a-f]{6})$/i);
    if (!m) return [128, 128, 128];
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const mid = parse(hex('--surface-2'));
  const pole = parse(hex(v >= 0 ? '--s1' : '--s8'));
  const t = Math.min(1, Math.abs(v) / vmax);
  const c = mid.map((m, i) => Math.round(m + (pole[i] - m) * t));
  const lum = (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
  return { bg: `rgb(${c.join(',')})`, fg: lum > 0.55 ? '#0f151c' : '#ffffff' };
}

function heatmap(container, study, field) {
  const { fasts, slows, runs } = study.grid;
  const node = $(container);
  node.style.gridTemplateColumns = `44px repeat(${fasts.length}, minmax(0, 1fr))`;
  const cells = [el('div', { class: 'heat-lab', text: '' })];
  for (const f of fasts) cells.push(el('div', { class: 'heat-lab', text: String(f) }));
  let idx = 0;
  for (const s of slows) {
    cells.push(el('div', { class: 'heat-lab', text: String(s) }));
    for (const f of fasts) {
      const run = runs[idx++];
      if (!run.valid) {
        cells.push(el('div', { class: 'heat-cell', style: { background: 'transparent' } }));
        continue;
      }
      const v = run[field];
      const col = divergingColor(v);
      const best = run === study.best;
      cells.push(
        el('div', {
          class: 'heat-cell' + (best ? ' best' : ''),
          style: { background: col.bg, color: col.fg },
          title: `MA ${f}/${s}: ${field === 'isSharpe' ? 'in-sample' : 'out-of-sample'} Sharpe ${v.toFixed(2)}${best ? ' (in-sample winner)' : ''}`,
          text: v.toFixed(1),
        }),
      );
    }
  }
  node.replaceChildren(...cells);
}

function renderLegend() {
  const lo = divergingColor(-1.5).bg;
  const mid = divergingColor(0).bg;
  const hi = divergingColor(1.5).bg;
  const ramp = el('span', { class: 'ramp', style: { background: `linear-gradient(90deg, ${lo}, ${mid}, ${hi})` } });
  $('#heat-legend').replaceChildren(el('span', { text: '−1.5' }), ramp, el('span', { text: '+1.5' }));
}

let lastStudy = null;
function runOverfit() {
  if (!bars || bars.length < 900) {
    $('#of-note').textContent = 'Needs at least 900 bars (about 3.5 years).';
    return;
  }
  const cfg = { ...config(), timing: 'next_open' };
  const t0 = performance.now();
  const study = overfitStudy(bars, cfg);
  const wf = walkForward(bars, cfg, undefined, study.grid);
  lastStudy = study;
  const ms = performance.now() - t0;
  heatmap('#heat-is', study, 'isSharpe');
  heatmap('#heat-oos', study, 'oosSharpe');
  renderLegend();
  const b = study.best;
  $('#of-best').textContent = `${b.fast} / ${b.slow}`;
  $('#of-is').textContent = fmtNum(b.isSharpe, 2);
  $('#of-is-sub').textContent = `${bars[study.warm].date.slice(0, 7)} to ${bars[study.cut - 1].date.slice(0, 7)}`;
  const oos = $('#of-oos');
  oos.textContent = fmtNum(b.oosSharpe, 2);
  oos.className = 'value ' + signClass(b.oosSharpe);
  $('#of-oos-sub').textContent = `median of all 38: ${fmtNum(study.medianOos, 2)}`;
  const d = study.dsr;
  $('#of-dsr').textContent = fmtPct(d.dsr, 0);
  $('#of-dsr-sub').replaceChildren(el('span', { class: `pill ${d.dsr > 0.95 ? 'good' : 'warn'}`, text: d.dsr > 0.95 ? 'significant at 95%' : 'not significant' }));
  const wfNode = $('#of-wf');
  wfNode.textContent = fmtNum(wf.sharpe, 2);
  wfNode.className = 'value ' + signClass(wf.sharpe);
  $('#of-note').textContent = `${study.grid.runs.filter((r) => r.valid).length} backtests in ${ms.toFixed(0)} ms · noise benchmark SR₀ = ${(d.sr0 * Math.sqrt(252)).toFixed(2)} annualised`;

  const valid = study.grid.runs.filter((r) => r.valid);
  const xs = valid.map((r) => r.isSharpe);
  const order = xs.map((_, i) => i).sort((i, j) => xs[i] - xs[j]);
  scatterChart.setSeries([
    { name: 'Parameter pair', color: '--s7', type: 'scatter', size: 4, x: order.map((i) => xs[i]), y: order.map((i) => valid[i].oosSharpe) },
    { name: 'In-sample winner', color: '--s2', type: 'scatter', size: 6, x: [b.isSharpe], y: [b.oosSharpe] },
  ], { hLines: [{ y: 0, color: '--line-strong', dash: false, label: `correlation ${study.isOosCorr.toFixed(2)}` }] });

  const n = bars.length;
  const x = Array.from({ length: n }, (_, i) => i);
  const bestCurve = new Array(n).fill(NaN);
  let e = 1;
  for (let i = wf.first; i < n; i++) {
    e *= 1 + b.returns[i];
    bestCurve[i] = e;
  }
  wfChart.opts.x.min = wf.first;
  wfChart.setSeries([
    { name: 'Walk-forward (re-fit every 6 months)', color: '--s1', x, y: Array.from(wf.curve), endDot: true },
    { name: `Full-sample winner ${b.fast}/${b.slow}`, color: '--s2', x, y: bestCurve, width: 1.5 },
  ], { hLines: [{ y: 1, color: '--line-strong', dash: false }] });
}

async function repeatStudy(btn) {
  const regime = val('regime');
  const years = Math.min(30, Math.max(3, Math.round(num('years'))));
  const cfg = { ...config(), timing: 'next_open' };
  const acc = { is: [], oos: [], wf: [], dsr: [], sig: 0 };
  await busy(btn, 'Running 0 / 20…', async () => {
    for (let seed = 1; seed <= 20; seed++) {
      const b = generateBars({ n: years * 252, seed, regime });
      const st = overfitStudy(b, cfg);
      const wf = walkForward(b, cfg, undefined, st.grid);
      acc.is.push(st.best.isSharpe);
      acc.oos.push(st.best.oosSharpe);
      acc.wf.push(wf.sharpe);
      acc.dsr.push(st.dsr.dsr);
      if (st.dsr.dsr > 0.95) acc.sig++;
      btn.textContent = `Running ${seed} / 20…`;
      await nextFrame();
    }
  });
  const row = (label, xs, pct = false) => el('tr', {}, el('td', { text: label }), el('td', { text: pct ? fmtPct(mean(xs), 0) : fmtNum(mean(xs), 2) }), el('td', { text: pct ? fmtPct(std(xs), 0) : fmtNum(std(xs), 2) }));
  $('#repeat-table tbody').replaceChildren(
    row('Best in-sample Sharpe', acc.is),
    row('Same parameters, out-of-sample', acc.oos),
    row('Walk-forward Sharpe', acc.wf),
    row('Deflated Sharpe', acc.dsr, true),
    el('tr', {}, el('td', { text: 'Histories where DSR > 95%' }), el('td', { text: `${acc.sig} of 20` }), el('td', { text: '' })),
  );
  $('#repeat-wrap').hidden = false;
  $('#repeat-note').textContent = `${document.querySelector('#regime option:checked').textContent}, ${years} years each.`;
}

// ---------- wiring ----------
function key() {
  return JSON.stringify([val('source'), val('regime'), num('seed'), num('years'), csvBars?.length, config()]);
}

const runAll = debounce(async () => {
  syncVisibility();
  runMain();
  await nextFrame();
  runAudit();
  const k = key();
  if (k !== lastKey) {
    lastKey = k;
    await nextFrame();
    runOverfit();
  }
}, 150);

for (const node of $$('aside input, aside select')) {
  if (node.id === 'csv-file') continue;
  node.addEventListener('change', runAll);
  if (node.type === 'number') node.addEventListener('input', runAll);
}

$('#csv-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    csvBars = parseCsv(await file.text());
    $('#csv-status').textContent = `${fmtInt(csvBars.length)} bars, ${csvBars[0].date} to ${csvBars[csvBars.length - 1].date}.`;
  } catch (err) {
    csvBars = null;
    $('#csv-status').textContent = err.message;
  }
  runAll();
});

$('#repeat').addEventListener('click', (e) => repeatStudy(e.currentTarget));
new MutationObserver(() => {
  if (lastStudy) {
    heatmap('#heat-is', lastStudy, 'isSharpe');
    heatmap('#heat-oos', lastStudy, 'oosSharpe');
    renderLegend();
  }
}).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => lastStudy && (heatmap('#heat-is', lastStudy, 'isSharpe'), heatmap('#heat-oos', lastStudy, 'oosSharpe'), renderLegend()));

syncVisibility();
runAll();
