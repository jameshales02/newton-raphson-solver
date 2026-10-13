import { bsPrice, bsGreeks, binomialPrice, monteCarloPrice, impliedVol, priceBounds } from './options.js';
import { XYChart } from '../assets/chart.js';
import { $, el, bindRange, num, radio, checked, fmtNum, fmtPct, debounce } from '../assets/ui.js';

const money = (v) => (Number.isFinite(v) ? v.toFixed(4) : '–');

function contract() {
  return {
    S: num('S'),
    K: num('K'),
    sigma: num('vol'),
    T: num('days') / 365,
    r: num('rate'),
    q: num('div'),
    type: radio('otype'),
  };
}

const spotFmt = (v) => v.toFixed(0);
const valueChart = new XYChart('#value-chart', {
  title: 'Option value against spot',
  legend: true,
  height: 250,
  x: { format: spotFmt, label: 'S =' },
  y: { format: (v) => v.toFixed(0), includeZero: true },
  tipY: (v) => v.toFixed(3),
  ariaLabel: 'Option value today and payoff at expiry across spot prices',
});
const greekCharts = {};
for (const [id, title, fmt] of [
  ['delta', 'Delta', (v) => v.toFixed(2)],
  ['gamma', 'Gamma', (v) => v.toFixed(3)],
  ['vega', 'Vega (per vol point)', (v) => v.toFixed(2)],
  ['theta', 'Theta (per day)', (v) => v.toFixed(3)],
]) {
  greekCharts[id] = new XYChart(`#${id}-chart`, {
    title,
    height: 160,
    x: { format: spotFmt, label: 'S =' },
    y: { format: fmt, includeZero: true },
    tipY: (v) => v.toFixed(4),
    ariaLabel: `${title} across spot prices`,
  });
}
const binChart = new XYChart('#bin-chart', {
  title: 'Binomial price as steps increase',
  legend: true,
  height: 200,
  x: { format: (v) => v.toFixed(0), label: 'N =' },
  y: { format: (v) => v.toFixed(3) },
  tipY: (v) => v.toFixed(5),
  ariaLabel: 'Binomial tree price against number of steps, converging to Black-Scholes',
});
const mcChart = new XYChart('#mc-chart', {
  title: 'Monte Carlo estimate as paths increase',
  legend: true,
  height: 200,
  x: { format: (v) => (v >= 6 ? `${Math.round(10 ** (v - 6))}M` : v >= 3 ? `${Math.round(10 ** (v - 3))}K` : `${Math.round(10 ** v)}`), label: 'paths' },
  tipX: (v) => Math.round(10 ** v).toLocaleString() + ' paths',
  y: { format: (v) => v.toFixed(2) },
  tipY: (v) => v.toFixed(4),
  ariaLabel: 'Running Monte Carlo estimate with 95% confidence band',
});
const ivChart = new XYChart('#iv-chart', {
  title: '|BS(σₙ) − P| by iteration',
  height: 220,
  x: { format: (v) => v.toFixed(0), label: 'n =' },
  y: { log: true },
  tipY: (v) => v.toExponential(2),
  ariaLabel: 'Pricing error at each Newton-Raphson iteration on a log scale',
});

function render() {
  const o = contract();
  const bs = bsPrice(o);
  const g = bsGreeks(o);
  const steps = num('steps');
  const american = radio('style') === 'am';
  const bin = binomialPrice(o, steps, american);
  const vr = checked('vr');
  const mc = monteCarloPrice(o, { paths: num('mcpaths'), antithetic: vr, control: vr, seed: 7 });

  $('#p-bs').textContent = money(bs);
  $('#p-bin').textContent = money(bin);
  $('#p-bin-sub').textContent = american ? `American, N=${steps}; early-exercise premium ${(bin - binomialPrice(o, steps, false)).toFixed(4)}` : `European, N=${steps}; vs BS ${bin - bs >= 0 ? '+' : '−'}${Math.abs(bin - bs).toExponential(1)}`;
  $('#p-mc').textContent = money(mc.price);
  $('#p-mc-sub').textContent = `± ${(1.96 * mc.se).toFixed(4)} (95%), ${(mc.paths / 1000).toFixed(0)}K paths`;
  const intrinsic = o.type === 'call' ? Math.max(0, o.S - o.K) : Math.max(0, o.K - o.S);
  $('#p-tv').textContent = `${intrinsic.toFixed(2)} / ${(bs - intrinsic).toFixed(2)}`;
  $('#p-tv-sub').textContent = o.type === 'call' ? (o.S > o.K ? 'in the money' : o.S < o.K ? 'out of the money' : 'at the money') : o.S < o.K ? 'in the money' : o.S > o.K ? 'out of the money' : 'at the money';
  $('#g-delta').textContent = g.delta.toFixed(4);
  $('#g-gamma').textContent = g.gamma.toFixed(4);
  $('#g-vega').textContent = (g.vega / 100).toFixed(4);
  $('#g-theta').textContent = (g.theta / 365).toFixed(4);
  $('#g-rho').textContent = (g.rho / 100).toFixed(4);

  // value and Greeks across spot
  const lo = Math.max(1, o.K * 0.5);
  const hi = o.K * 1.5;
  const xs = [];
  const val = [];
  const pay = [];
  const gs = { delta: [], gamma: [], vega: [], theta: [] };
  for (let i = 0; i <= 160; i++) {
    const S = lo + ((hi - lo) * i) / 160;
    xs.push(S);
    const c = { ...o, S };
    val.push(bsPrice(c));
    pay.push(o.type === 'call' ? Math.max(0, S - o.K) : Math.max(0, o.K - S));
    const gg = bsGreeks(c);
    gs.delta.push(gg.delta);
    gs.gamma.push(gg.gamma);
    gs.vega.push(gg.vega / 100);
    gs.theta.push(gg.theta / 365);
  }
  const spotLine = [{ x: o.S, color: '--ink-2' }];
  valueChart.setSeries(
    [
      { name: `Value today (${num('days')} days left)`, color: '--s1', x: xs, y: val },
      { name: 'Payoff at expiry', color: '--neutral-series', x: xs, y: pay, width: 1.5, dash: [5, 4] },
    ],
    { vLines: spotLine },
  );
  const colors = { delta: '--s1', gamma: '--s3', vega: '--s7', theta: '--s2' };
  for (const k of Object.keys(gs)) greekCharts[k].setSeries([{ name: k, color: colors[k], x: xs, y: gs[k] }], { vLines: spotLine });

  // binomial convergence
  const ns = [];
  const bp = [];
  for (let n = 5; n <= 200; n += 1) {
    ns.push(n);
    bp.push(binomialPrice(o, n, false));
  }
  binChart.setSeries([{ name: 'European tree', color: '--s1', x: ns, y: bp, width: 1.25 }], { hLines: [{ y: bs, label: `Black–Scholes ${bs.toFixed(4)}`, color: '--ink-2' }] });

  // MC convergence (log10 paths on the x axis)
  const lx = mc.run.n.map((v) => Math.log10(v));
  mcChart.setSeries(
    [
      { name: '95% confidence band', color: '--s7', type: 'band', x: lx, lower: mc.run.lo, upper: mc.run.hi },
      { name: 'Running estimate', color: '--s7', x: lx, y: mc.run.est, width: 1.5 },
    ],
    { hLines: [{ y: bs, label: `Black–Scholes ${bs.toFixed(4)}`, color: '--ink-2' }] },
  );
  mcChart.opts.y.min = bs - Math.max(0.05 * bs, 4 * mc.se * Math.sqrt(mc.paths / 1000));
  mcChart.opts.y.max = bs + Math.max(0.05 * bs, 4 * mc.se * Math.sqrt(mc.paths / 1000));
}

function solveIV() {
  const o = contract();
  const price = num('iv-price');
  const start = $('#iv-start').value;
  const res = impliedVol(price, o, start === 'auto' ? {} : { sigma0: Number(start) });
  const out = $('#iv-result');
  if (!res.history.length) {
    out.textContent = `No implied volatility: ${res.reason}.`;
    $('#iv-table tbody').replaceChildren();
    ivChart.setSeries([]);
    return;
  }
  out.textContent = res.ok ? `σ = ${fmtPct(res.sigma, 4)} after ${res.iterations} iteration${res.iterations === 1 ? '' : 's'}` : `Stopped: ${res.reason}.`;
  const rows = res.history.map((h) =>
    el(
      'tr',
      {},
      el('td', { text: String(h.iter) }),
      el('td', { class: 'mono', text: h.sigma.toFixed(10) }),
      el('td', { class: 'mono', text: h.error.toExponential(3) }),
      el('td', { class: 'mono', text: h.vega.toFixed(4) }),
      el('td', { text: h.method ? (h.method === 'newton' ? 'Newton' : 'Bisection') : 'Converged' }),
    ),
  );
  $('#iv-table tbody').replaceChildren(...rows);
  const pts = res.history.filter((h) => Math.abs(h.error) > 0);
  ivChart.setSeries([
    { name: '|error|', color: '--s2', x: pts.map((h) => h.iter), y: pts.map((h) => Math.abs(h.error)), endDot: true },
    { name: 'iterate', color: '--s2', type: 'scatter', size: 3.5, x: pts.map((h) => h.iter), y: pts.map((h) => Math.abs(h.error)) },
  ]);
}

// ---------- wiring ----------
bindRange('S', (v) => v.toFixed(1));
bindRange('K', (v) => v.toFixed(1));
bindRange('vol', (v) => fmtPct(v, 1));
bindRange('days', (v) => `${v} d (${(v / 365).toFixed(2)} y)`);
bindRange('rate', (v) => fmtPct(v, 2));
bindRange('div', (v) => fmtPct(v, 2));
bindRange('steps', (v) => String(v));

const rerender = debounce(() => {
  render();
}, 30);
for (const id of ['S', 'K', 'vol', 'days', 'rate', 'div', 'steps', 'mcpaths', 'vr', 't-call', 't-put', 's-eu', 's-am']) {
  document.getElementById(id).addEventListener('input', rerender);
  document.getElementById(id).addEventListener('change', rerender);
}
// keep the IV example meaningful when the contract changes: quote a price 5 vol points above the slider
const seedIvPrice = () => {
  const o = contract();
  const b = priceBounds(o);
  const p = bsPrice({ ...o, sigma: o.sigma + 0.05 });
  $('#iv-price').value = Math.min(b.hi - 0.01, Math.max(b.lo + 0.01, p)).toFixed(2);
};
for (const id of ['S', 'K', 'vol', 'days', 'rate', 'div', 't-call', 't-put']) {
  document.getElementById(id).addEventListener('change', () => {
    seedIvPrice();
    solveIV();
  });
}
$('#iv-form').addEventListener('submit', (e) => {
  e.preventDefault();
  solveIV();
});
$('#iv-start').addEventListener('change', solveIV);

render();
seedIvPrice();
solveIV();
