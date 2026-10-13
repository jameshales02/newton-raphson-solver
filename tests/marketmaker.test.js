import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulate, monteCarlo, quotes, asSpread, reservationPrice, DEFAULTS } from '../docs/market-making/marketmaker.js';

test('Avellaneda-Stoikov reservation price and spread match the closed form', () => {
  const p = { ...DEFAULTS };
  // r = s - q*gamma*sigma^2*(T-t); at t=0, q=3: 100 - 3*0.1*4*1 = 98.8
  assert.ok(Math.abs(reservationPrice(p, 100, 3, 0) - 98.8) < 1e-12);
  // spread = gamma*sigma^2*(T-t) + (2/gamma)*ln(1+gamma/k)
  const expected = 0.1 * 4 * 0.5 + 20 * Math.log(1 + 0.1 / 1.5);
  assert.ok(Math.abs(asSpread(p, 0.5) - expected) < 1e-12);
  const qt = quotes(p, 'inventory', 100, 3, 0);
  assert.ok(Math.abs((qt.bid + qt.ask) / 2 - 98.8) < 1e-12);
});

test('symmetric quotes are centred on the mid; linear quotes shift by -skew*q', () => {
  const p = { ...DEFAULTS, skew: 0.1, halfSpread: 0.5 };
  const s = quotes(p, 'symmetric', 101, 7, 0.2);
  assert.ok(Math.abs((s.bid + s.ask) / 2 - 101) < 1e-12);
  const l = quotes(p, 'linear', 101, 4, 0.2);
  assert.ok(Math.abs(l.bid - (101 - 0.4 - 0.5)) < 1e-12);
  assert.ok(Math.abs(l.ask - (101 - 0.4 + 0.5)) < 1e-12);
});

test('P&L attribution is exact: total = spread capture + inventory + adverse selection + rebates', () => {
  for (const strategy of ['inventory', 'symmetric', 'linear']) {
    for (const seed of [1, 2, 3]) {
      const r = simulate({ toxicity: 0.3, jump: 0.4, rebate: 0.02 }, strategy, seed);
      const parts = r.edge + r.invPnl + r.adverse + r.fees;
      assert.ok(Math.abs(r.pnl - parts) < 1e-9, `${strategy}/${seed}: ${r.pnl} vs ${parts}`);
      const last = r.rec.pnl.length - 1;
      assert.ok(Math.abs(r.rec.pnl[last] - r.pnl) < 1e-9);
      assert.ok(Math.abs(r.rec.edge[last] + r.rec.inv[last] + r.rec.adverse[last] + r.rec.fees[last] - r.rec.pnl[last]) < 1e-9);
    }
  }
});

test('spread capture is positive for every fill when quotes straddle the mid', () => {
  const r = simulate({}, 'symmetric', 5);
  for (const f of r.rec.fills) {
    const i = Math.round(f.t / DEFAULTS.dt);
    const mid = r.rec.mid[i];
    if (f.side === 'buy') assert.ok(f.price < mid);
    else assert.ok(f.price > mid);
  }
  assert.ok(r.edge > 0);
});

test('inventory limit is never breached', () => {
  for (const strategy of ['inventory', 'symmetric', 'linear']) {
    for (let seed = 1; seed <= 20; seed++) {
      const r = simulate({ qMax: 3 }, strategy, seed, { record: false });
      assert.ok(r.maxAbsQ <= 3, `${strategy} seed ${seed} reached ${r.maxAbsQ}`);
    }
  }
});

test('simulation is deterministic for a given seed', () => {
  const a = simulate({}, 'inventory', 42, { record: false });
  const b = simulate({}, 'inventory', 42, { record: false });
  assert.equal(a.pnl, b.pnl);
  assert.equal(a.finalQ, b.finalQ);
});

test('inventory skew cuts P&L variance and inventory risk versus symmetric quoting', () => {
  const mc = monteCarlo({}, ['inventory', 'symmetric'], 500, 7);
  const inv = mc.inventory.summary;
  const sym = mc.symmetric.summary;
  assert.ok(inv.stdPnl < 0.7 * sym.stdPnl, `std ${inv.stdPnl} vs ${sym.stdPnl}`);
  assert.ok(inv.stdFinalQ < 0.5 * sym.stdFinalQ, `std q ${inv.stdFinalQ} vs ${sym.stdFinalQ}`);
  assert.ok(inv.ratio > sym.ratio);
  // Same order of magnitude of profit as Avellaneda & Stoikov (2008), Table 1, gamma = 0.1.
  assert.ok(inv.meanPnl > 55 && inv.meanPnl < 75);
  assert.ok(sym.meanPnl > 55 && sym.meanPnl < 80);
});

test('toxic flow costs money through adverse selection', () => {
  const clean = monteCarlo({}, ['symmetric'], 300, 3).symmetric.summary;
  const toxic = monteCarlo({ toxicity: 0.4, jump: 0.6 }, ['symmetric'], 300, 3).symmetric.summary;
  assert.ok(toxic.meanAdverse < 0);
  assert.ok(toxic.meanPnl < clean.meanPnl);
});
