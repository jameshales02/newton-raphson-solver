import { simulate, monteCarlo, DEFAULTS, STRATEGIES } from './marketmaker.js';
import { XYChart, HistChart } from '../assets/chart.js';
import { histogram } from '../assets/stats.js';
import { $, $$, el, bindRange, num, val, fmtNum, fmtPct, signClass, debounce, busy } from '../assets/ui.js';

const GAMMAS = [0.01, 0.05, 0.1, 0.2, 0.5, 1, 2];

const quoteChart = new XYChart('#quote-chart', {
  title: 'Mid price, quotes and fills',
  legend: true,
  height: 280,
  x: { format: (v) => v.toFixed(2), label: 't =' },
  y: { format: (v) => v.toFixed(1) },
  tipY: (v) => v.toFixed(3),
  ariaLabel: 'Mid price with the bid and ask quotes and the fills over one simulated session',
});
const invChart = new XYChart('#inv-chart', {
  title: 'Inventory',
  height: 200,
  x: { format: (v) => v.toFixed(2), label: 't =' },
  y: { format: (v) => String(Math.round(v)), includeZero: true },
  tipY: (v) => `${v > 0 ? '+' : ''}${v} units`,
  ariaLabel: 'Inventory held over the session',
});
const pnlChart = new XYChart('#pnl-chart', {
  title: 'P&L and its parts',
  legend: true,
  height: 200,
  x: { format: (v) => v.toFixed(2), label: 't =' },
  y: { format: (v) => v.toFixed(0), includeZero: true },
  tipY: (v) => v.toFixed(2),
  ariaLabel: 'Cumulative P&L split into spread capture, inventory P&L and adverse selection',
});
const hists = {};
for (const s of ['inventory', 'symmetric', 'linear']) {
  hists[s] = new HistChart(`#hist-${s}`, {
    title: STRATEGIES[s],
    height: 150,
    color: '--s7',
    unit: 'paths',
    x: { format: (v) => v.toFixed(0) },
    pad: { left: 40 },
  });
}

function params() {
  return {
    ...DEFAULTS,
    gamma: GAMMAS[num('gamma')],
    sigma: num('sigma'),
    k: num('kk'),
    A: num('aa'),
    toxicity: num('tox'),
    jump: num('jump'),
    rebate: num('rebate'),
    halfSpread: num('half'),
    skew: num('skew'),
    qMax: Number(val('qmax')),
  };
}

function syncStrategyFields() {
  const s = val('strategy');
  for (const f of $$('[data-for]')) f.hidden = f.getAttribute('data-for') === 'linear' ? s !== 'linear' : s === 'linear';
}

function runPath() {
  const p = params();
  const strategy = val('strategy');
  const r = simulate(p, strategy, num('seed'));
  const rec = r.rec;
  const n = rec.t.length - 1;
  const tq = Array.from(rec.t.slice(0, n));
  const buys = rec.fills.filter((f) => f.side === 'buy');
  const sells = rec.fills.filter((f) => f.side === 'sell');
  const series = [
    { name: 'Mid', color: '--ink', x: rec.t, y: rec.mid, width: 1.5 },
    { name: 'Bid quote', color: '--bid', x: tq, y: Array.from(rec.bid.slice(0, n)), width: 1.25, alpha: 0.85 },
    { name: 'Ask quote', color: '--ask', x: tq, y: Array.from(rec.ask.slice(0, n)), width: 1.25, alpha: 0.85 },
  ];
  if (strategy !== 'symmetric') series.push({ name: strategy === 'inventory' ? 'Reservation price' : 'Quote centre', color: '--s7', x: tq, y: Array.from(rec.centre.slice(0, n)), width: 1.25, dash: [4, 3] });
  series.push(
    { name: 'Bought (bid hit)', color: '--bid', type: 'scatter', shape: 'up', size: 3.5, x: buys.map((f) => f.t), y: buys.map((f) => f.price) },
    { name: 'Sold (ask lifted)', color: '--ask', type: 'scatter', shape: 'down', size: 3.5, x: sells.map((f) => f.t), y: sells.map((f) => f.price) },
  );
  quoteChart.setSeries(series);

  const qLines = Number.isFinite(p.qMax) ? [{ y: p.qMax, label: `limit +${p.qMax}` }, { y: -p.qMax, label: `limit −${p.qMax}` }] : [];
  invChart.setSeries([{ name: 'Inventory', color: '--s3', type: 'stepArea', x: rec.t, y: rec.q }], { hLines: qLines });

  const pnlSeries = [
    { name: 'Total', color: '--ink', x: rec.t, y: rec.pnl, endDot: true },
    { name: 'Spread capture', color: '--s3', x: rec.t, y: rec.edge },
    { name: 'Inventory P&L', color: '--s4', x: rec.t, y: rec.inv },
  ];
  if (p.toxicity > 0 && p.jump > 0) pnlSeries.push({ name: 'Adverse selection', color: '--s5', x: rec.t, y: rec.adverse });
  if (p.rebate !== 0) pnlSeries.push({ name: 'Rebates', color: '--s7', x: rec.t, y: rec.fees });
  pnlChart.setSeries(pnlSeries);

  const set = (id, v, dp = 2) => {
    const node = $(id);
    node.textContent = (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(dp);
    node.className = 'value ' + signClass(v);
  };
  set('#t-pnl', r.pnl);
  $('#t-pnl-sub').textContent = `${r.bidFills + r.askFills} fills (${r.bidFills} bought, ${r.askFills} sold)`;
  set('#t-edge', r.edge);
  $('#t-edge-sub').textContent = `${(r.edge / Math.max(1, r.bidFills + r.askFills)).toFixed(3)} per fill, avg quoted spread ${r.avgSpread.toFixed(2)}`;
  set('#t-inv', r.invPnl);
  set('#t-adv', r.adverse);
  $('#t-adv-sub').textContent = p.toxicity > 0 && p.jump > 0 ? `${fmtPct(p.toxicity, 0)} of fills informed` : 'no informed flow (set it in the panel)';
  const q = $('#t-q');
  q.textContent = `${r.finalQ > 0 ? '+' : r.finalQ < 0 ? '−' : ''}${Math.abs(r.finalQ)}`;
  $('#t-q-sub').textContent = `at close; max |q| ${r.maxAbsQ}, std ${r.stdQ.toFixed(1)}`;
}

function runMC() {
  const p = params();
  const paths = num('paths');
  const t0 = performance.now();
  const mc = monteCarlo(p, ['inventory', 'symmetric', 'linear'], paths, 2024);
  const ms = performance.now() - t0;
  const all = Object.values(mc).flatMap((m) => Array.from(m.pnl));
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  const pad = (hi - lo) * 0.02;
  lo -= pad;
  hi += pad;
  const rows = [];
  for (const [s, m] of Object.entries(mc)) {
    const x = m.summary;
    const bins = histogram(m.pnl, 40, lo, hi);
    hists[s].opts.x.min = lo;
    hists[s].opts.x.max = hi;
    hists[s].setData(bins, [{ x: x.meanPnl, label: `mean ${x.meanPnl.toFixed(1)}`, color: '--ink' }]);
    const current = s === val('strategy');
    rows.push(
      el(
        'tr',
        current ? { style: { fontWeight: 600 } } : {},
        el('td', { text: STRATEGIES[s] }),
        el('td', { class: signClass(x.meanPnl), text: fmtNum(x.meanPnl, 1) }),
        el('td', { text: fmtNum(x.stdPnl, 1) }),
        el('td', { text: fmtNum(x.ratio, 2) }),
        el('td', { text: fmtPct(x.pLoss, 1) }),
        el('td', { text: fmtNum(x.avgSpread, 2) }),
        el('td', { text: fmtNum(x.meanFills, 0) }),
        el('td', { text: fmtNum(x.stdFinalQ, 1) }),
        el('td', { text: fmtNum(x.meanEdge, 1) }),
        el('td', { text: fmtNum(x.meanInv, 1) }),
        el('td', { class: signClass(x.meanAdverse), text: fmtNum(x.meanAdverse, 1) }),
      ),
    );
  }
  $('#mc-table tbody').replaceChildren(...rows);
  $('#mc-note').textContent = `${paths.toLocaleString()} paths × 3 strategies in ${ms.toFixed(0)} ms, γ = ${p.gamma}`;
}

// ---------- wiring ----------
bindRange('gamma', (i) => String(GAMMAS[i]));
bindRange('sigma', (v) => v.toFixed(1));
bindRange('kk', (v) => v.toFixed(1));
bindRange('aa', (v) => String(v));
bindRange('tox', (v) => fmtPct(v, 0));
bindRange('jump', (v) => v.toFixed(2));
bindRange('rebate', (v) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2));
bindRange('half', (v) => v.toFixed(2));
bindRange('skew', (v) => v.toFixed(2));

const rerun = debounce(runPath, 60);
for (const id of ['strategy', 'gamma', 'sigma', 'kk', 'aa', 'tox', 'jump', 'rebate', 'half', 'skew', 'qmax', 'seed']) {
  document.getElementById(id).addEventListener('input', () => {
    if (id === 'strategy') syncStrategyFields();
    rerun();
  });
}
$('#new-path').addEventListener('click', () => {
  $('#seed').value = 1 + Math.floor(Math.random() * 99999);
  runPath();
});
$('#run-mc').addEventListener('click', (e) => busy(e.currentTarget, 'Running…', runMC));
$('#defaults').addEventListener('click', () => {
  const set = (id, v) => {
    const node = document.getElementById(id);
    node.value = v;
    node.dispatchEvent(new Event('input'));
  };
  set('gamma', 2);
  set('sigma', 2);
  set('kk', 1.5);
  set('aa', 140);
  set('tox', 0);
  set('jump', 0.5);
  set('rebate', 0);
  set('qmax', 'Infinity');
  runPath();
  busy($('#run-mc'), 'Running…', runMC);
});

syncStrategyFields();
runPath();
runMC();
