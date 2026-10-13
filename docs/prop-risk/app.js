import { monteCarlo, sweep, gamblersRuin, tradeMoments, expectedValue, parseSample, DEFAULT_STRATEGY } from './propsim.js';
import { XYChart, HistChart } from '../assets/chart.js';
import { histogram } from '../assets/stats.js';
import { $, $$, el, bindRange, num, val, checked, fmtPct, fmtMoney, fmtInt, debounce, nextFrame } from '../assets/ui.js';

const PRESETS = {
  50: { size: 50000, target: 3000, dd: 2000, dll: 1000 },
  100: { size: 100000, target: 6000, dd: 3000, dll: 2000 },
  150: { size: 150000, target: 9000, dd: 4500, dll: 3000 },
};
const COLORS = { pass: '--s1', fail: '--s2', timeout: '--neutral-series' };

const pathsChart = new XYChart('#paths-chart', {
  title: 'Sixty simulated attempts',
  legend: true,
  height: 280,
  crosshair: false,
  x: { format: (v) => `day ${v.toFixed(0)}` },
  y: { format: (v) => '$' + (v / 1000).toFixed(1) + 'K' },
  ariaLabel: 'Account balance over trading days for sixty simulated attempts, coloured by outcome',
});
const passHist = new HistChart('#pass-hist', { title: 'Days to pass', height: 160, color: COLORS.pass, unit: 'passing attempts', x: { format: (v) => v.toFixed(0) }, pad: { left: 44 } });
const failHist = new HistChart('#fail-hist', { title: 'Days to blow up', height: 160, color: COLORS.fail, unit: 'failed attempts', x: { format: (v) => v.toFixed(0) }, pad: { left: 44 } });
const sweepChart = new XYChart('#sweep-chart', {
  legend: true,
  height: 220,
  x: { format: (v) => v.toFixed(0), label: 'contracts' },
  y: { format: (v) => (v * 100).toFixed(0) + '%', min: 0, max: 1 },
  tipY: (v) => (v * 100).toFixed(1) + '%',
  ariaLabel: 'Probability of passing, blowing up and timing out by number of contracts',
});

function rules() {
  return {
    accountSize: PRESETS[val('preset')]?.size ?? 50000,
    profitTarget: num('r-target'),
    maxDrawdown: num('r-dd'),
    drawdownType: val('r-ddtype'),
    trailLock: checked('r-lock') ? 0 : null,
    dailyLossLimit: num('r-dll') > 0 ? num('r-dll') : null,
    dllAction: val('r-dllact'),
    minDays: Math.max(1, Math.round(num('r-min'))),
    maxDays: Math.max(1, Math.round(num('r-max'))),
  };
}

function strategy() {
  const sample = parseSample(val('s-sample'));
  return {
    ...DEFAULT_STRATEGY,
    model: val('model') === 'bootstrap' && sample.length ? 'bootstrap' : 'winloss',
    winRate: num('s-win'),
    avgWin: num('s-avgwin'),
    avgLoss: num('s-avgloss'),
    dispersion: num('s-disp'),
    tailProb: num('s-tail') / 100,
    tailMult: 3,
    tradesPerDay: Math.max(1, Math.round(num('s-tpd'))),
    contracts: Math.max(1, Math.round(num('s-ct'))),
    sample,
  };
}

const econ = () => ({ fee: num('e-fee'), payout: num('e-pay') });

function riskPerTrade(s, r) {
  const loss = s.model === 'bootstrap' ? Math.abs(Math.min(...s.sample.filter((x) => x < 0), 0)) || 0 : s.avgLoss;
  return (loss * s.contracts) / r.maxDrawdown;
}

function setPct(id, p, se) {
  $(id).textContent = fmtPct(p, 1);
  return se;
}

async function run() {
  const r = rules();
  const s = strategy();
  const accounts = num('n-acc');
  const seed = Math.max(1, Math.round(num('n-seed')));
  const t0 = performance.now();
  const res = monteCarlo(r, s, { accounts, seed, keepPaths: 60 });
  const ms = performance.now() - t0;

  setPct('#t-pass', res.pPass);
  $('#t-pass-sub').textContent = `± ${(1.96 * res.sePass * 100).toFixed(1)} pts; median ${Number.isFinite(res.medianDaysToPass) ? res.medianDaysToPass : '–'} days`;
  setPct('#t-fail', res.pFail);
  $('#t-fail-sub').textContent = `${fmtPct(res.pFailDD, 1)} drawdown, ${fmtPct(res.pFailDLL, 1)} daily limit`;
  setPct('#t-time', res.pTimeout);
  $('#t-time-sub').textContent = `after ${r.maxDays} trading days`;
  const ev = expectedValue(res.pPass, econ());
  const evNode = $('#t-ev');
  evNode.textContent = fmtMoney(ev);
  evNode.className = 'value ' + (ev > 0 ? 'pos' : ev < 0 ? 'neg' : '');
  $('#t-ev-sub').textContent = res.pPass > 0 ? `≈ ${(1 / res.pPass).toFixed(1)} attempts, ${fmtMoney(econ().fee / res.pPass)} in fees per pass` : 'never passes';
  const rpt = riskPerTrade(s, r);
  $('#t-risk').textContent = fmtPct(rpt, 0);
  const m = tradeMoments(s);
  $('#t-risk-sub').textContent = `of the drawdown buffer; edge ${fmtMoney(m.mean * s.contracts)} ± ${fmtMoney(Math.sqrt(m.variance) * s.contracts)}/trade`;
  $('#t-note').textContent = `${fmtInt(accounts)} attempts in ${ms.toFixed(0)} ms`;

  // outcome bar
  const parts = [
    ['Pass', res.pPass, COLORS.pass],
    ['Blow up: drawdown', res.pFailDD, COLORS.fail],
    ['Blow up: daily limit', res.pFailDLL, '--s4'],
    ['Time out', res.pTimeout, COLORS.timeout],
  ].filter((p) => p[1] > 0 || p[0] === 'Pass');
  $('#outcome-bar').replaceChildren(...parts.filter((p) => p[1] > 0).map(([label, p, c]) => el('span', { title: `${label}: ${fmtPct(p, 1)}`, style: { width: `${p * 100}%`, background: `var(${c})` } })));
  $('#outcome-key').replaceChildren(...parts.map(([label, p, c]) => el('span', {}, el('i', { style: { background: `var(${c})` } }), el('b', { text: fmtPct(p, 1) }), label)));

  // sample paths
  const start = r.accountSize;
  const series = [];
  const seen = new Set();
  const rank = { pass: 0, fail_dd: 1, fail_dll: 1, timeout: 2 };
  const ordered = res.paths.slice().sort((a, b) => rank[a.outcome] - rank[b.outcome]);
  for (const p of ordered) {
    const kind = p.outcome === 'pass' ? 'pass' : p.outcome === 'timeout' ? 'timeout' : 'fail';
    const label = { pass: 'Passed', fail: 'Blew up', timeout: 'Timed out' }[kind];
    series.push({
      name: label,
      color: COLORS[kind],
      x: p.path.map((_, i) => i),
      y: p.path,
      width: 1.25,
      alpha: 0.6,
      noTip: true,
      noLegend: seen.has(kind),
    });
    seen.add(kind);
  }
  const hLines = [
    { y: start + r.profitTarget, label: `target ${fmtMoney(start + r.profitTarget)}`, color: '--ink-2', dash: false },
    { y: start - r.maxDrawdown, label: `initial floor ${fmtMoney(start - r.maxDrawdown)}`, color: '--ink-2' },
  ];
  if (r.drawdownType !== 'static' && r.trailLock !== null) hLines.push({ y: start, label: 'floor locks here', color: '--line-strong' });
  pathsChart.setSeries(series, { hLines });

  // histograms
  const maxDay = r.maxDays;
  const bins = Math.min(30, maxDay);
  passHist.opts.x.min = 0;
  passHist.opts.x.max = maxDay;
  failHist.opts.x.min = 0;
  failHist.opts.x.max = maxDay;
  passHist.setData(histogram(res.passDays, bins, 0, maxDay), Number.isFinite(res.medianDaysToPass) ? [{ x: res.medianDaysToPass, label: `median ${res.medianDaysToPass}` }] : []);
  failHist.setData(histogram(res.failDays, bins, 0, maxDay), Number.isFinite(res.medianDaysToFail) ? [{ x: res.medianDaysToFail, label: `median ${res.medianDaysToFail}` }] : []);

  renderCheck(r, s);
  await nextFrame();
  renderSweep(r, s, seed);
}

function renderSweep(r, s, seed) {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const res = sweep(r, s, 'contracts', values, { accounts: 4000, seed });
  sweepChart.setSeries(
    [
      { name: 'Pass', color: COLORS.pass, x: values, y: res.map((x) => x.pPass), endDot: true },
      { name: 'Blow up', color: COLORS.fail, x: values, y: res.map((x) => x.pFail) },
      { name: 'Time out', color: COLORS.timeout, x: values, y: res.map((x) => x.pTimeout) },
    ],
    { vLines: [{ x: s.contracts, color: '--ink-2' }] },
  );
  let best = res[0];
  for (const x of res) if (x.pPass > best.pPass) best = x;
  const rows = res.map((x) =>
    el(
      'tr',
      x === best ? { style: { fontWeight: 600 } } : {},
      el('td', { text: String(x.value) + (x.value === s.contracts ? ' (current)' : '') }),
      el('td', { text: fmtPct(riskPerTrade({ ...s, contracts: x.value }, r), 0) }),
      el('td', { text: fmtPct(x.pPass, 1) }),
      el('td', { text: fmtPct(x.pFail, 1) }),
      el('td', { text: fmtPct(x.pTimeout, 1) }),
      el('td', { text: Number.isFinite(x.medianDaysToPass) ? String(x.medianDaysToPass) : '–' }),
      el('td', { class: expectedValue(x.pPass, econ()) >= 0 ? 'pos' : 'neg', text: fmtMoney(expectedValue(x.pPass, econ())) }),
    ),
  );
  $('#sweep-table tbody').replaceChildren(...rows);
  $('#sweep-note').textContent = `best pass rate at ${best.value} contract${best.value === 1 ? '' : 's'} (4,000 attempts per size)`;
}

function renderCheck(r, s) {
  const simple = { ...r, drawdownType: 'static', dailyLossLimit: null, maxDays: 20000, minDays: 1, coastAfterTarget: false };
  const one = { ...s, tradesPerDay: 1 };
  const m = tradeMoments(one);
  const mu = m.mean * one.contracts;
  const v = m.variance * one.contracts * one.contracts;
  const plain = gamblersRuin(mu, v, r.profitTarget, r.maxDrawdown);
  const corr = gamblersRuin(mu, v, r.profitTarget, r.maxDrawdown, { overshoot: true });
  const mc = monteCarlo(simple, one, { accounts: 10000, seed: 99, keepPaths: 0 });
  const all = mc.passDays.concat(mc.failDays);
  const meanTrades = all.reduce((a, b) => a + b, 0) / Math.max(1, all.length);
  const row = (label, p, t, extra) => el('tr', {}, el('td', { text: label }), el('td', { text: fmtPct(p, 1) + (extra || '') }), el('td', { text: Number.isFinite(t) && t > 0 ? fmtInt(t) : '–' }));
  $('#check-table tbody').replaceChildren(
    row('Brownian gambler’s ruin', plain.pPass, plain.expectedTrades),
    row('With overshoot correction (ρσ)', corr.pPass, corr.expectedTrades),
    row('Monte Carlo, same simplified rules', mc.pPass, meanTrades, ` ± ${(1.96 * mc.sePass * 100).toFixed(1)}`),
  );
}

// ---------- wiring ----------
bindRange('s-win', (v) => fmtPct(v, 0));
function syncModel() {
  for (const f of $$('[data-model]')) f.hidden = f.getAttribute('data-model') !== val('model');
  const n = parseSample(val('s-sample')).length;
  $('#s-sample-note').textContent = n ? `${n} trades parsed. Separate values with commas, spaces or new lines.` : 'No numbers found yet.';
}
$('#preset').addEventListener('change', () => {
  const p = PRESETS[val('preset')];
  if (!p) return;
  $('#r-target').value = p.target;
  $('#r-dd').value = p.dd;
  $('#r-dll').value = p.dll;
});
for (const id of ['r-target', 'r-dd', 'r-dll']) document.getElementById(id).addEventListener('input', () => ($('#preset').value = 'custom'));

const rerun = debounce(() => {
  syncModel();
  run();
}, 200);
for (const node of $$('aside input, aside select, aside textarea')) {
  node.addEventListener('change', rerun);
  if (node.type === 'number' || node.type === 'range' || node.tagName === 'TEXTAREA') node.addEventListener('input', rerun);
}

syncModel();
run();
