// Landing page: a small live order book driven by the real matching engine.
import { OrderBook, BUY } from './order-book/orderbook.js';
import { FlowDriver } from './order-book/flow.js';
import { XYChart } from './assets/chart.js';
import { $, el, fmtInt, reducedMotion } from './assets/ui.js';

const TICK = 0.01;
const book = new OrderBook();
const driver = new FlowDriver(book, { seed: 21 });
driver.warmUp(8000);
const tape = [];

const chart = new XYChart('#hero-depth', {
  legend: false,
  height: 170,
  pad: { left: 40, bottom: 22 },
  x: { format: (v) => v.toFixed(2) },
  y: { format: (v) => (v >= 1000 ? (v / 1000).toFixed(0) + 'K' : String(Math.round(v))), includeZero: true },
  tipY: (v) => fmtInt(v),
  ariaLabel: 'Cumulative bid and ask depth',
});

function render() {
  const d = book.depth(25);
  const bids = d.bids.slice().reverse();
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
  chart.setSeries([
    { name: 'Bids', color: '--bid', type: 'stepArea', stepBefore: true, x: bx, y: by, tipInRange: true },
    { name: 'Asks', color: '--ask', type: 'stepArea', x: ax, y: ay, stepEnd: d.asks.length ? (d.asks.at(-1).price + 1) * TICK : undefined, tipInRange: true },
  ]);
  const bb = d.bids[0];
  const ba = d.asks[0];
  $('#touch').replaceChildren(
    el('span', {}, el('span', { class: 'side-tag buy', text: 'BID' }), bb ? `${(bb.price * TICK).toFixed(2)} × ${fmtInt(bb.qty)}` : '–'),
    el('span', {}, el('span', { class: 'side-tag sell', text: 'ASK' }), ba ? `${(ba.price * TICK).toFixed(2)} × ${fmtInt(ba.qty)}` : '–'),
    el('span', { text: `${fmtInt(book.orders.size)} resting orders` }),
  );
  $('#hero-tape').replaceChildren(
    ...tape.slice(0, 5).map((t) => el('div', {}, el('span', { class: `side-tag ${t.side}`, text: t.side === BUY ? 'BUY' : 'SELL' }), el('span', { text: (t.price * TICK).toFixed(2) }), el('span', { text: fmtInt(t.qty) }))),
  );
}

function step(n) {
  for (let i = 0; i < n; i++) {
    const r = driver.step();
    if (r.op === 'submit') for (const t of r.result.trades) tape.unshift({ side: t.takerSide, price: t.price, qty: t.qty });
  }
  if (tape.length > 20) tape.length = 20;
}

step(400);
render();
if (!reducedMotion()) {
  setInterval(() => {
    if (document.hidden) return;
    step(6);
    render();
  }, 200);
}
