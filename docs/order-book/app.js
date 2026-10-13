import { OrderBook, BUY, SELL, LIMIT, MARKET } from './orderbook.js';
import { FlowDriver, benchmark } from './flow.js';
import { XYChart } from '../assets/chart.js';
import { $, el, fmtInt, bindRange, radio, busy, reducedMotion } from '../assets/ui.js';

const TICK = 0.01;
const toPx = (ticks) => (ticks * TICK).toFixed(2);
const DEPTH_LEVELS = 30;
const TAPE_MAX = 60;

let book;
let driver;
let resetCount = 0;
let running = !reducedMotion();
let tape = [];
let lastTrade = null;
let tradeCount = 0;
let volumeBase = 0;
const levelText = (l) => `${fmtInt(l.qty)} on ${l.count} order${l.count === 1 ? '' : 's'}`;
const mine = new Map(); // id -> { side, type, price, qty, filled, notional, status }

const depthChart = new XYChart('#depth-chart', {
  title: 'Market depth',
  legend: true,
  height: 260,
  x: { format: (v) => v.toFixed(2), label: 'Price' },
  y: { format: (v) => (v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 0 : 1) + 'K' : String(Math.round(v))), includeZero: true, label: 'Cumulative quantity' },
  tipY: (v) => fmtInt(v),
  ariaLabel: 'Cumulative depth of bids and asks around the mid price',
});

function reset() {
  book = new OrderBook();
  driver = new FlowDriver(book, { seed: 7 + resetCount++ });
  driver.warmUp(6000);
  tape = [];
  lastTrade = null;
  tradeCount = book.stats.trades;
  volumeBase = book.stats.volume;
  mine.clear();
  renderOrders();
  render();
}

// ---------- trades bookkeeping ----------
function recordTrades(trades, fromUser = false) {
  for (const t of trades) {
    const maker = mine.get(t.makerId);
    if (maker) {
      maker.filled += t.qty;
      maker.notional += t.qty * t.price;
    }
    tape.unshift({ time: new Date(), side: t.takerSide, price: t.price, qty: t.qty, mine: fromUser || !!maker, id: t.id });
    lastTrade = t;
  }
  if (tape.length > TAPE_MAX) tape.length = TAPE_MAX;
  if (trades.length && [...mine.values()].some((o) => o.status === 'resting' || o.status === 'partial')) ordersDirty = true;
}

// ---------- simulation loop ----------
let speed = 60;
let carry = 0;
let lastFrame = performance.now();
let lastRender = 0;
let ordersDirty = false;

function frame(now) {
  const dt = Math.min(0.25, (now - lastFrame) / 1000);
  lastFrame = now;
  if (running) {
    carry += dt * speed;
    let steps = Math.floor(carry);
    carry -= steps;
    steps = Math.min(steps, 2000);
    for (let i = 0; i < steps; i++) {
      const r = driver.step();
      if (r.op === 'submit' && r.result.trades.length) recordTrades(r.result.trades);
    }
  }
  if (now - lastRender > 110) {
    lastRender = now;
    render();
    if (ordersDirty) {
      ordersDirty = false;
      renderOrders();
    }
  }
  requestAnimationFrame(frame);
}

// ---------- rendering ----------
function render() {
  const bb = book.bestBid();
  const ba = book.bestAsk();
  const d = book.depth(DEPTH_LEVELS);
  $('#t-bid').textContent = bb === null ? '–' : toPx(bb);
  $('#t-bidq').textContent = d.bids[0] ? levelText(d.bids[0]) : 'empty';
  $('#t-ask').textContent = ba === null ? '–' : toPx(ba);
  $('#t-askq').textContent = d.asks[0] ? levelText(d.asks[0]) : 'empty';
  const sp = book.spread();
  $('#t-spread').textContent = sp === null ? '–' : `${sp} tick${sp === 1 ? '' : 's'}`;
  $('#t-spreadbps').textContent = sp === null ? ' ' : `${((sp / book.mid()) * 1e4).toFixed(1)} bp of mid`;
  $('#t-last').textContent = lastTrade ? toPx(lastTrade.price) : '–';
  $('#t-lastside').textContent = lastTrade ? `${fmtInt(lastTrade.qty)} · ${lastTrade.takerSide === BUY ? 'buyer lifted the offer' : 'seller hit the bid'}` : ' ';
  $('#t-resting').textContent = fmtInt(book.orders.size);
  $('#t-levels').textContent = `${book.bids.levelCount} bid / ${book.asks.levelCount} ask levels`;
  $('#t-trades').textContent = fmtInt(book.stats.trades - tradeCount);
  $('#t-volume').textContent = `${fmtInt(book.stats.volume - volumeBase)} shares since reset`;
  renderDepth(d);
  renderLadder();
  renderTape();
}

function renderDepth(d) {
  const bids = d.bids.slice().reverse(); // ascending price
  const bx = [];
  const by = [];
  let cum = d.bids.reduce((s, l) => s + l.qty, 0);
  if (bids.length) {
    bx.push((bids[0].price - 1) * TICK);
    by.push(cum);
  }
  for (const l of bids) {
    bx.push(l.price * TICK);
    by.push(cum);
    cum -= l.qty;
  }
  const ax = [];
  const ay = [];
  cum = 0;
  for (const l of d.asks) {
    cum += l.qty;
    ax.push(l.price * TICK);
    ay.push(cum);
  }
  const mid = book.mid();
  depthChart.setSeries(
    [
      { name: 'Bids', color: '--bid', type: 'stepArea', stepBefore: true, x: bx, y: by, tipInRange: true },
      { name: 'Asks', color: '--ask', type: 'stepArea', x: ax, y: ay, stepEnd: d.asks.length ? (d.asks[d.asks.length - 1].price + 1) * TICK : undefined, tipInRange: true },
    ],
    { vLines: mid === null ? [] : [{ x: mid * TICK, color: '--muted' }] },
  );
}

function ladderRow(cls, l, maxQty, mineQty) {
  const row = el('div', { class: `ladder-row ${cls}` });
  const bar = el('i', { class: 'bar' });
  bar.style.width = `${Math.max(2, (100 * l.qty) / maxQty)}%`;
  row.append(
    bar,
    el('span', { class: 'px', text: toPx(l.price) }),
    el('span', { text: fmtInt(l.qty) + (mineQty ? ` (${fmtInt(mineQty)} yours)` : '') }),
    el('span', { text: String(l.count) }),
  );
  return row;
}

function renderLadder() {
  const d = book.depth(10);
  const maxQty = Math.max(1, ...d.bids.map((l) => l.qty), ...d.asks.map((l) => l.qty));
  const mineAt = new Map();
  for (const [id, o] of mine) {
    const live = book.get(id);
    if (live) mineAt.set(`${o.side}:${live.price}`, (mineAt.get(`${o.side}:${live.price}`) || 0) + live.remaining);
  }
  const frag = document.createDocumentFragment();
  const head = el('div', { class: 'ladder-row ladder-head' }, el('span', { text: 'Price' }), el('span', { text: 'Size' }), el('span', { text: 'Orders' }));
  frag.append(head);
  for (let i = d.asks.length - 1; i >= 0; i--) frag.append(ladderRow('ask', d.asks[i], maxQty, mineAt.get(`sell:${d.asks[i].price}`)));
  const sp = book.spread();
  frag.append(el('div', { class: 'ladder-spread', text: sp === null ? 'one side empty' : `spread ${sp} tick${sp === 1 ? '' : 's'} · mid ${(book.mid() * TICK).toFixed(3)}` }));
  for (const l of d.bids) frag.append(ladderRow('bid', l, maxQty, mineAt.get(`buy:${l.price}`)));
  $('#ladder').replaceChildren(frag);
}

let lastTapeTop = null;
function renderTape() {
  const frag = document.createDocumentFragment();
  const topId = tape[0]?.id ?? null;
  for (const t of tape) {
    const fresh = lastTapeTop !== null && t.id > lastTapeTop && !reducedMotion();
    const row = el(
      'div',
      { class: 'tape-row' + (fresh ? ' flash' : '') },
      el('span', { class: 't', text: t.time.toTimeString().slice(0, 8) }),
      el('span', { class: `side-tag ${t.side}`, text: t.side === BUY ? 'BUY' : 'SELL' }),
      el('span', { text: toPx(t.price) }),
      el('span', { text: fmtInt(t.qty) + (t.mine ? ' ◆' : '') }),
    );
    if (t.mine) row.title = 'Involves one of your orders';
    frag.append(row);
  }
  if (!tape.length) frag.append(el('div', { class: 'hint', text: 'Waiting for the first trade…' }));
  $('#tape').replaceChildren(frag);
  lastTapeTop = topId;
}

function renderOrders() {
  const tbody = $('#my-orders tbody');
  if (!mine.size) return;
  const rows = [];
  const entries = [...mine.entries()].reverse().slice(0, 10);
  for (const [id, o] of entries) {
    const live = book.get(id);
    if (o.status === 'resting' || o.status === 'partial') {
      if (!live) o.status = 'filled';
      else o.status = live.remaining < o.qty ? 'partial' : 'resting';
    }
    const statusLabel = { filled: 'Filled', partial: 'Partly filled', resting: 'Resting', cancelled: 'Cancelled', rejected: 'Rejected', expired: 'Unfilled part cancelled' }[o.status];
    const pill = { filled: 'good', partial: 'warn', resting: '', cancelled: '', rejected: 'bad', expired: 'warn' }[o.status];
    const canCancel = !!live;
    rows.push(
      el(
        'tr',
        {},
        el('td', { class: 'mono', text: '#' + id }),
        el('td', {}, el('span', { class: `side-tag ${o.side}`, text: o.side === BUY ? 'Buy' : 'Sell' })),
        el('td', { text: o.type === LIMIT ? 'Limit' : 'Market' }),
        el('td', { class: 'mono', text: o.type === LIMIT ? toPx(o.price) : '–' }),
        el('td', { class: 'mono', text: fmtInt(o.qty) }),
        el('td', { class: 'mono', text: fmtInt(o.filled) }),
        el('td', { class: 'mono', text: o.filled ? (o.notional / o.filled / 100).toFixed(4) : '–' }),
        el('td', {}, el('span', { class: `pill ${pill}`, text: statusLabel })),
        el('td', {}, canCancel ? el('button', { class: 'btn ghost small', type: 'button', 'data-cancel': id, text: 'Cancel' }) : ''),
      ),
    );
  }
  tbody.replaceChildren(...rows);
}

// ---------- order entry ----------
function syncSubmitLabel() {
  const side = radio('side');
  const type = radio('otype');
  $('#o-submit').textContent = `Submit ${side} ${type}`;
  $('#o-price').disabled = type === MARKET;
}

$('#order-form').addEventListener('change', syncSubmitLabel);
$('#o-touch').addEventListener('click', () => {
  const side = radio('side');
  const p = side === BUY ? book.bestAsk() : book.bestBid();
  if (p !== null) $('#o-price').value = toPx(p);
});

$('#order-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const side = radio('side');
  const type = radio('otype');
  const qty = Number($('#o-qty').value);
  const priceTicks = Math.round(Number($('#o-price').value) / TICK);
  const out = $('#o-result');
  if (!Number.isInteger(qty) || qty <= 0) {
    out.textContent = 'Quantity must be a whole number above zero.';
    return;
  }
  if (type === LIMIT && !(priceTicks > 0)) {
    out.textContent = 'Enter a limit price above 0.00.';
    return;
  }
  const r = book.submit({ side, type, price: type === LIMIT ? priceTicks : null, qty });
  if (r.status === 'rejected') {
    out.textContent = `Rejected: ${r.reason}.`;
    return;
  }
  const notional = r.trades.reduce((s, t) => s + t.price * t.qty, 0);
  const status = r.status === 'filled' ? 'filled' : type === MARKET ? (r.filled ? 'expired' : 'cancelled') : r.status;
  mine.set(r.id, { side, type, price: priceTicks, qty, filled: r.filled, notional, status });
  recordTrades(r.trades, true);
  const avg = r.filled ? ` at an average of ${(notional / r.filled / 100).toFixed(4)}` : '';
  const levels = new Set(r.trades.map((t) => t.price)).size;
  if (r.status === 'filled') out.textContent = `Order #${r.id} filled: ${fmtInt(r.filled)}${avg} across ${levels} level${levels === 1 ? '' : 's'}.`;
  else if (r.status === 'partial' && type === LIMIT) out.textContent = `Order #${r.id} filled ${fmtInt(r.filled)}${avg}; ${fmtInt(r.remaining)} now rests at ${toPx(priceTicks)}.`;
  else if (r.status === 'partial') out.textContent = `Order #${r.id} filled ${fmtInt(r.filled)}${avg}; the book ran out, so ${fmtInt(r.unfilled)} was cancelled.`;
  else if (r.status === 'resting') out.textContent = `Order #${r.id} rests at ${toPx(priceTicks)} behind ${fmtInt((book.get(r.id).level.totalQty - qty))} already queued there.`;
  else out.textContent = `Order #${r.id} found no liquidity and was cancelled.`;
  renderOrders();
  render();
});

$('#my-orders').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-cancel]');
  if (!btn) return;
  const id = Number(btn.getAttribute('data-cancel'));
  const o = mine.get(id);
  const live = book.get(id);
  const rem = live ? live.remaining : 0;
  if (book.cancel(id)) {
    o.status = 'cancelled';
    $('#o-result').textContent = `Order #${id} cancelled; ${fmtInt(rem)} removed from the book.`;
  }
  renderOrders();
  render();
});

// ---------- simulation controls ----------
bindRange('sim-speed', (v) => `${v}/s`, (v) => (speed = v));
speed = Number($('#sim-speed').value);
const toggle = $('#sim-toggle');
const syncToggle = () => (toggle.textContent = running ? 'Pause flow' : 'Resume flow');
toggle.addEventListener('click', () => {
  running = !running;
  syncToggle();
});
$('#sim-reset').addEventListener('click', () => {
  reset();
  $('#o-result').textContent = 'Book reset with a new seed.';
});

// ---------- benchmark ----------
$('#bench-run').addEventListener('click', (e) => {
  const n = Number($('#bench-n').value);
  const wasRunning = running;
  running = false;
  busy(e.currentTarget, 'Running…', () => {
    const r = benchmark(n);
    $('#b-ops').textContent = r.opsPerSec >= 1e6 ? `${(r.opsPerSec / 1e6).toFixed(2)}M` : `${fmtInt(r.opsPerSec / 1e3)}K`;
    $('#b-ns').textContent = `${r.nsPerOp.toFixed(0)} ns`;
    $('#b-trades').textContent = fmtInt(r.trades);
    $('#b-vol').textContent = `${fmtInt(r.volume)} shares in ${r.ms.toFixed(0)} ms`;
    const pct = (x) => Math.round((100 * x) / r.n);
    $('#b-mix').textContent = `${pct(r.mix.limits)} / ${pct(r.mix.markets)} / ${pct(r.mix.cancels)}%`;
    $('#bench-env').textContent = `${fmtInt(r.n)} orders in this browser`;
  }).finally(() => {
    running = wasRunning;
    syncToggle();
  });
});

syncSubmitLabel();
syncToggle();
reset();
requestAnimationFrame(frame);
