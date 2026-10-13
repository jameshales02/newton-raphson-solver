// Minimal canvas charting used across the site: line / step / area / band /
// scatter series on one shared y-axis, histograms, and a crosshair tooltip.
// Colours are read from CSS custom properties at draw time, so charts follow
// the page theme (light or dark) without re-creating anything.

const registry = new Set();

function cssVar(name, el = document.documentElement) {
  return getComputedStyle(el).getPropertyValue(name).trim();
}

function resolveColor(c) {
  if (!c) return cssVar('--ink');
  return c.startsWith('--') ? cssVar(c) : c;
}

function withAlpha(color, alpha) {
  const c = color.trim();
  if (c.startsWith('#')) {
    let h = c.slice(1);
    if (h.length === 3) h = h.split('').map((x) => x + x).join('');
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const [r, g, b] = m[1].split(',').map((s) => parseFloat(s));
    return `rgba(${r},${g},${b},${alpha})`;
  }
  return c;
}

// "Nice" tick values covering [lo, hi] with roughly `count` ticks.
export function niceTicks(lo, hi, count = 5) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  if (hi === lo) {
    const pad = Math.abs(lo) * 0.1 || 1;
    lo -= pad;
    hi += pad;
  }
  const span = hi - lo;
  const raw = span / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const start = Math.ceil(lo / step - 1e-9) * step;
  const ticks = [];
  for (let v = start; v <= hi + step * 1e-9; v += step) ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return ticks;
}

export function compact(v, digits = 2) {
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(a >= 1e10 ? 0 : 1) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
  if (a >= 1e4) return (v / 1e3).toFixed(a >= 1e5 ? 0 : 1) + 'K';
  if (a >= 100) return v.toFixed(0);
  if (a >= 1) return +v.toFixed(digits) + '';
  if (a === 0) return '0';
  if (a < 1e-3) return v.toExponential(0);
  return +v.toPrecision(2) + '';
}

function lowerBound(xs, x) {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Index of the last point at or before x (the value a step series holds at x).
function stepIndex(xs, x) {
  const i = lowerBound(xs, x);
  if (i < xs.length && xs[i] === x) return i;
  return Math.max(0, i - 1);
}

function nearestIndex(xs, x) {
  if (!xs.length) return -1;
  const i = lowerBound(xs, x);
  if (i <= 0) return 0;
  if (i >= xs.length) return xs.length - 1;
  return x - xs[i - 1] <= xs[i] - x ? i - 1 : i;
}

class BaseChart {
  constructor(container, opts = {}) {
    this.el = typeof container === 'string' ? document.querySelector(container) : container;
    this.opts = opts;
    this.el.classList.add('chart');
    this.el.innerHTML = '';
    if (opts.title || opts.legend) {
      this.head = document.createElement('div');
      this.head.className = 'chart-head';
      this.el.appendChild(this.head);
    }
    this.wrap = document.createElement('div');
    this.wrap.className = 'chart-plot';
    this.wrap.style.height = (opts.height ?? 240) + 'px';
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('role', 'img');
    if (opts.ariaLabel) this.canvas.setAttribute('aria-label', opts.ariaLabel);
    this.tip = document.createElement('div');
    this.tip.className = 'chart-tip';
    this.tip.hidden = true;
    this.wrap.append(this.canvas, this.tip);
    this.el.appendChild(this.wrap);
    this.ctx = this.canvas.getContext('2d');
    this.pad = { top: 10, right: 14, bottom: 26, left: 52, ...(opts.pad || {}) };
    this.hoverX = null;
    this._raf = 0;
    this.ro = new ResizeObserver(() => this.schedule());
    this.ro.observe(this.wrap);
    this.canvas.addEventListener('pointermove', (e) => this.onPointer(e));
    this.canvas.addEventListener('pointerleave', () => this.onLeave());
    registry.add(this);
  }

  schedule() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this.draw();
    });
  }

  size() {
    const r = this.wrap.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(10, Math.floor(r.width));
    const h = Math.max(10, Math.floor(r.height));
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.canvas.style.width = w + 'px';
      this.canvas.style.height = h + 'px';
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h };
  }

  theme() {
    return {
      ink: cssVar('--ink'),
      ink2: cssVar('--ink-2'),
      muted: cssVar('--muted'),
      grid: cssVar('--grid'),
      axis: cssVar('--line-strong'),
      surface: cssVar('--surface'),
      font: cssVar('--font-mono') || 'monospace',
    };
  }

  renderLegend(items) {
    if (!this.head) return;
    this.head.innerHTML = '';
    if (this.opts.title) {
      const t = document.createElement('div');
      t.className = 'chart-title';
      t.textContent = this.opts.title;
      this.head.appendChild(t);
    }
    const shown = items.filter((s) => !s.noLegend);
    if (this.opts.legend && shown.length >= 1) {
      const lg = document.createElement('div');
      lg.className = 'chart-legend';
      for (const s of shown) {
        const it = document.createElement('span');
        it.className = 'lg-item';
        const key = document.createElement('i');
        key.className = 'lg-key ' + (s.type === 'scatter' ? 'dot' : s.type === 'band' || s.type === 'bar' ? 'box' : 'line');
        key.style.setProperty('--c', resolveColor(s.color));
        if (s.dash) key.classList.add('dash');
        const label = document.createElement('span');
        label.textContent = s.name;
        it.append(key, label);
        lg.appendChild(it);
      }
      this.head.appendChild(lg);
    }
  }

  onLeave() {
    this.hoverX = null;
    this.tip.hidden = true;
    this.schedule();
  }

  destroy() {
    this.ro.disconnect();
    registry.delete(this);
  }
}

// ---------------------------------------------------------------------------
// XYChart: lines, steps, areas, bands and scatter on one numeric x axis.
// series: { name, color, x: [], y: [], type: 'line'|'step'|'area'|'stepArea'|'band'|'scatter',
//           lower, upper (band), width, dash, fillTo (number), size (scatter), noTip, noLegend }
// ---------------------------------------------------------------------------
export class XYChart extends BaseChart {
  constructor(container, opts = {}) {
    super(container, opts);
    this.series = [];
    this.hLines = opts.hLines || [];
    this.vLines = opts.vLines || [];
    this.setSeries(opts.series || []);
  }

  setSeries(series, extra = {}) {
    this.series = series;
    if (extra.hLines) this.hLines = extra.hLines;
    if (extra.vLines) this.vLines = extra.vLines;
    const sig = series.map((s) => s.name + (s.color || '') + s.type).join('|');
    if (sig !== this._legendSig) {
      this._legendSig = sig;
      this.renderLegend(series);
    }
    this.schedule();
  }

  domain() {
    const o = this.opts;
    let xmin = Infinity;
    let xmax = -Infinity;
    let ymin = Infinity;
    let ymax = -Infinity;
    for (const s of this.series) {
      if (s.hidden) continue;
      const xs = s.x;
      const n = xs.length;
      for (let i = 0; i < n; i++) {
        const x = xs[i];
        if (x < xmin) xmin = x;
        if (x > xmax) xmax = x;
      }
      const ys = s.type === 'band' ? [s.lower, s.upper] : [s.y];
      for (const arr of ys) {
        for (let i = 0; i < arr.length; i++) {
          const y = arr[i];
          if (!Number.isFinite(y)) continue;
          if (o.y?.log && y <= 0) continue;
          if (y < ymin) ymin = y;
          if (y > ymax) ymax = y;
        }
      }
      if (s.fillTo !== undefined && !o.y?.log) {
        ymin = Math.min(ymin, s.fillTo);
        ymax = Math.max(ymax, s.fillTo);
      }
    }
    for (const h of this.hLines) {
      if (h.inDomain === false) continue;
      ymin = Math.min(ymin, h.y);
      ymax = Math.max(ymax, h.y);
    }
    if (o.y?.includeZero) {
      ymin = Math.min(ymin, 0);
      ymax = Math.max(ymax, 0);
    }
    if (o.x?.min !== undefined) xmin = o.x.min;
    if (o.x?.max !== undefined) xmax = o.x.max;
    if (o.y?.min !== undefined) ymin = o.y.min;
    if (o.y?.max !== undefined) ymax = o.y.max;
    if (!Number.isFinite(xmin)) {
      xmin = 0;
      xmax = 1;
    }
    if (!Number.isFinite(ymin)) {
      ymin = 0;
      ymax = 1;
    }
    if (xmax === xmin) xmax = xmin + 1;
    if (o.y?.log) {
      return { xmin, xmax, ymin: Math.log10(ymin), ymax: Math.log10(ymax) + 1e-9 };
    }
    if (ymax === ymin) {
      const p = Math.abs(ymax) * 0.05 || 1;
      ymin -= p;
      ymax += p;
    } else if (o.y?.pad !== 0) {
      const p = (ymax - ymin) * (o.y?.pad ?? 0.06);
      if (!(o.y?.min !== undefined)) ymin -= ymin === 0 && o.y?.includeZero ? 0 : p;
      if (!(o.y?.max !== undefined)) ymax += p;
    }
    return { xmin, xmax, ymin, ymax };
  }

  draw() {
    const { w, h } = this.size();
    const ctx = this.ctx;
    const th = this.theme();
    const o = this.opts;
    const pad = this.pad;
    ctx.clearRect(0, 0, w, h);
    const d = this.domain();
    const log = !!o.y?.log;
    const pw = w - pad.left - pad.right;
    const ph = h - pad.top - pad.bottom;
    const X = (x) => pad.left + ((x - d.xmin) / (d.xmax - d.xmin)) * pw;
    const Y = (y) => {
      const v = log ? Math.log10(Math.max(y, 1e-300)) : y;
      return pad.top + (1 - (v - d.ymin) / (d.ymax - d.ymin)) * ph;
    };
    this._map = { X, d, pw, ph, pad, Y };

    ctx.font = `11px ${th.font}`;
    ctx.textBaseline = 'middle';
    const yfmt = o.y?.format || ((v) => compact(v));
    const xfmt = o.x?.format || ((v) => compact(v));

    // Horizontal gridlines + y labels.
    let yt;
    if (log) {
      yt = [];
      for (let e = Math.ceil(d.ymin); e <= Math.floor(d.ymax); e++) yt.push(e);
      const stride = Math.ceil(yt.length / 6);
      yt = yt.filter((_, i) => i % stride === 0);
    } else {
      yt = niceTicks(d.ymin, d.ymax, Math.max(2, Math.round(ph / 48)));
    }
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    for (const t of yt) {
      const yy = log ? pad.top + (1 - (t - d.ymin) / (d.ymax - d.ymin)) * ph : Y(t);
      if (yy < pad.top - 0.5 || yy > pad.top + ph + 0.5) continue;
      ctx.strokeStyle = !log && t === 0 ? th.axis : th.grid;
      ctx.beginPath();
      ctx.moveTo(pad.left, Math.round(yy) + 0.5);
      ctx.lineTo(pad.left + pw, Math.round(yy) + 0.5);
      ctx.stroke();
      ctx.fillStyle = th.muted;
      ctx.fillText(log ? '1e' + t : yfmt(t), pad.left - 6, yy);
    }
    // Baseline and x labels.
    ctx.strokeStyle = th.axis;
    ctx.beginPath();
    ctx.moveTo(pad.left, pad.top + ph + 0.5);
    ctx.lineTo(pad.left + pw, pad.top + ph + 0.5);
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xt = o.x?.ticks ? o.x.ticks(d.xmin, d.xmax, pw) : niceTicks(d.xmin, d.xmax, Math.max(2, Math.round(pw / 90)));
    let lastRight = -Infinity;
    for (const t of xt) {
      const xx = X(t);
      if (xx < pad.left - 1 || xx > pad.left + pw + 1) continue;
      const label = xfmt(t);
      const tw = ctx.measureText(label).width;
      const left = Math.max(xx - tw / 2, 0);
      if (left < lastRight + 8) continue;
      const cx = Math.min(Math.max(xx, tw / 2 + 1), w - tw / 2 - 1);
      ctx.fillStyle = th.muted;
      ctx.fillText(label, cx, pad.top + ph + 7);
      lastRight = cx + tw / 2;
    }
    if (o.y?.label) {
      ctx.save();
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillStyle = th.muted;
      ctx.fillText(o.y.label, pad.left + 4, pad.top + 2);
      ctx.restore();
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(pad.left, pad.top - 4, pw, ph + 8);
    ctx.clip();

    // Reference lines.
    for (const r of this.vLines) {
      const xx = Math.round(X(r.x)) + 0.5;
      ctx.strokeStyle = resolveColor(r.color || '--line-strong');
      ctx.setLineDash(r.dash === false ? [] : [3, 3]);
      ctx.beginPath();
      ctx.moveTo(xx, pad.top);
      ctx.lineTo(xx, pad.top + ph);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    for (const r of this.hLines) {
      const yy = Math.round(Y(r.y)) + 0.5;
      ctx.strokeStyle = resolveColor(r.color || '--line-strong');
      ctx.lineWidth = r.width || 1;
      ctx.setLineDash(r.dash === false ? [] : [4, 3]);
      ctx.beginPath();
      ctx.moveTo(pad.left, yy);
      ctx.lineTo(pad.left + pw, yy);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 1;
    }

    for (const s of this.series) {
      if (s.hidden) continue;
      const color = resolveColor(s.color);
      if (s.type === 'band') this.drawBand(s, color, X, Y);
      else if (s.type === 'scatter') this.drawScatter(s, color, X, Y, th);
      else this.drawLine(s, color, X, Y, d, pw);
    }
    ctx.restore();

    // Labels on reference lines (drawn outside the clip so they stay readable).
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'right';
    for (const r of this.hLines) {
      if (!r.label) continue;
      const yy = Y(r.y);
      if (yy < pad.top || yy > pad.top + ph) continue;
      ctx.fillStyle = th.ink2;
      ctx.fillText(r.label, pad.left + pw - 2, yy - 3);
    }

    // Crosshair.
    if (this.hoverX !== null) this.drawHover(X, Y, th);
  }

  // Decimate long series to a min/max envelope per pixel column.
  envelope(xs, ys, X, i0, i1) {
    const out = [];
    let col = null;
    let mn = 0;
    let mx = 0;
    let first = 0;
    let last = 0;
    let fx = 0;
    for (let i = i0; i < i1; i++) {
      const y = ys[i];
      if (!Number.isFinite(y)) continue;
      const c = Math.round(X(xs[i]));
      if (c !== col) {
        if (col !== null) out.push([fx, first, mn, mx, last]);
        col = c;
        mn = mx = first = last = y;
        fx = xs[i];
      } else {
        if (y < mn) mn = y;
        if (y > mx) mx = y;
        last = y;
      }
    }
    if (col !== null) out.push([fx, first, mn, mx, last]);
    return out;
  }

  drawLine(s, color, X, Y, d, pw) {
    const ctx = this.ctx;
    const xs = s.x;
    const ys = s.y;
    const n = xs.length;
    if (!n) return;
    const step = s.type === 'step' || s.type === 'stepArea';
    const area = s.type === 'area' || s.type === 'stepArea' || s.fillTo !== undefined;
    const pts = [];
    if (!step && n > pw * 2) {
      for (const [x, first, mn, mx, last] of this.envelope(xs, ys, X, 0, n)) {
        const px = X(x);
        pts.push([px, Y(first)], [px, Y(mn)], [px, Y(mx)], [px, Y(last)]);
      }
    } else {
      let prevY = null;
      let prevX = null;
      for (let i = 0; i < n; i++) {
        const y = ys[i];
        if (!Number.isFinite(y)) {
          pts.push(null);
          prevY = null;
          continue;
        }
        const px = X(xs[i]);
        const py = Y(y);
        // step-after holds the previous value until the next x; step-before jumps first
        if (step && prevY !== null) pts.push(s.stepBefore ? [prevX, py] : [px, prevY]);
        pts.push([px, py]);
        prevY = py;
        prevX = px;
      }
      if (step && s.stepEnd !== undefined && prevY !== null) pts.push([X(s.stepEnd), prevY]);
    }
    if (area) {
      const base = Y(s.fillTo ?? Math.max(d.ymin, Math.min(0, d.ymax)));
      ctx.fillStyle = withAlpha(color, s.fillAlpha ?? 0.12);
      let open = false;
      let startX = 0;
      let lastX = 0;
      ctx.beginPath();
      for (const p of pts) {
        if (!p) {
          if (open) {
            ctx.lineTo(lastX, base);
            ctx.lineTo(startX, base);
            ctx.closePath();
            open = false;
          }
          continue;
        }
        if (!open) {
          ctx.moveTo(p[0], base);
          ctx.lineTo(p[0], p[1]);
          startX = p[0];
          open = true;
        } else ctx.lineTo(p[0], p[1]);
        lastX = p[0];
      }
      if (open) {
        ctx.lineTo(lastX, base);
        ctx.lineTo(startX, base);
        ctx.closePath();
      }
      ctx.fill();
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = s.width ?? 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (s.dash) ctx.setLineDash(s.dash);
    ctx.globalAlpha = s.alpha ?? 1;
    ctx.beginPath();
    let pen = false;
    for (const p of pts) {
      if (!p) {
        pen = false;
        continue;
      }
      if (!pen) {
        ctx.moveTo(p[0], p[1]);
        pen = true;
      } else ctx.lineTo(p[0], p[1]);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
    if (s.endDot && n) {
      let i = n - 1;
      while (i >= 0 && !Number.isFinite(ys[i])) i--;
      if (i >= 0) this.dot(X(xs[i]), Y(ys[i]), color, 4);
    }
  }

  drawBand(s, color, X, Y) {
    const ctx = this.ctx;
    const xs = s.x;
    const n = xs.length;
    if (!n) return;
    ctx.fillStyle = withAlpha(color, s.fillAlpha ?? 0.14);
    ctx.beginPath();
    ctx.moveTo(X(xs[0]), Y(s.upper[0]));
    for (let i = 1; i < n; i++) ctx.lineTo(X(xs[i]), Y(s.upper[i]));
    for (let i = n - 1; i >= 0; i--) ctx.lineTo(X(xs[i]), Y(s.lower[i]));
    ctx.closePath();
    ctx.fill();
  }

  drawScatter(s, color, X, Y, th) {
    const r = s.size ?? 3.5;
    const n = s.x.length;
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(s.y[i])) continue;
      this.dot(X(s.x[i]), Y(s.y[i]), color, r, th.surface, s.shape);
    }
  }

  dot(x, y, color, r, ring, shape) {
    const ctx = this.ctx;
    ring = ring ?? cssVar('--surface');
    ctx.beginPath();
    if (shape === 'up' || shape === 'down') {
      const k = r * 1.35;
      const dir = shape === 'up' ? -1 : 1;
      ctx.moveTo(x, y + dir * k);
      ctx.lineTo(x - k, y - dir * k * 0.7);
      ctx.lineTo(x + k, y - dir * k * 0.7);
      ctx.closePath();
    } else ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = ring;
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 1;
  }

  onPointer(e) {
    if (!this._map || this.opts.crosshair === false) return;
    const r = this.canvas.getBoundingClientRect();
    const px = e.clientX - r.left;
    const { pad, pw, d } = this._map;
    if (px < pad.left || px > pad.left + pw) {
      this.onLeave();
      return;
    }
    this.hoverX = d.xmin + ((px - pad.left) / pw) * (d.xmax - d.xmin);
    this.schedule();
  }

  drawHover(X, Y, th) {
    const ctx = this.ctx;
    const { pad, ph } = this._map;
    const rows = [];
    let snapX = null;
    for (const s of this.series) {
      if (s.hidden || s.noTip || s.type === 'scatter' || !s.x.length) continue;
      if (s.tipInRange && (this.hoverX < s.x[0] || this.hoverX > (s.stepEnd ?? s.x[s.x.length - 1]))) continue;
      const isStep = s.type === 'step' || s.type === 'stepArea';
      const i = !isStep ? nearestIndex(s.x, this.hoverX) : s.stepBefore ? Math.min(s.x.length - 1, lowerBound(s.x, this.hoverX)) : stepIndex(s.x, this.hoverX);
      if (i < 0) continue;
      if (snapX === null) snapX = s.x[i];
      const color = resolveColor(s.color);
      if (s.type === 'band') {
        rows.push({ name: s.name, value: `${this.fmtTip(s.lower[i])} – ${this.fmtTip(s.upper[i])}`, color });
      } else {
        const y = s.y[i];
        if (!Number.isFinite(y)) continue;
        rows.push({ name: s.name, value: this.fmtTip(y, s), color, px: X(s.x[i]), py: Y(y) });
      }
    }
    if (snapX === null) return;
    const xx = Math.round(X(snapX)) + 0.5;
    ctx.strokeStyle = th.axis;
    ctx.beginPath();
    ctx.moveTo(xx, pad.top);
    ctx.lineTo(xx, pad.top + ph);
    ctx.stroke();
    for (const r of rows) if (r.px !== undefined) this.dot(r.px, r.py, r.color, 4, th.surface);

    const xfmt = this.opts.tipX || this.opts.x?.format || ((v) => compact(v, 4));
    this.tip.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'tip-x';
    head.textContent = (this.opts.x?.label ? this.opts.x.label + ' ' : '') + xfmt(snapX);
    this.tip.appendChild(head);
    for (const r of rows) {
      const row = document.createElement('div');
      row.className = 'tip-row';
      const key = document.createElement('i');
      key.className = 'lg-key line';
      key.style.setProperty('--c', r.color);
      const v = document.createElement('b');
      v.textContent = r.value;
      const n = document.createElement('span');
      n.textContent = r.name;
      row.append(key, v, n);
      this.tip.appendChild(row);
    }
    this.tip.hidden = false;
    const tw = this.tip.offsetWidth;
    const wrapW = this.wrap.clientWidth;
    let left = xx + 12;
    if (left + tw > wrapW - 4) left = xx - tw - 12;
    this.tip.style.left = Math.max(4, left) + 'px';
    this.tip.style.top = pad.top + 4 + 'px';
  }

  fmtTip(v, s) {
    if (s?.tipFormat) return s.tipFormat(v);
    if (this.opts.tipY) return this.opts.tipY(v);
    if (this.opts.y?.format) return this.opts.y.format(v);
    return compact(v, 4);
  }
}

// ---------------------------------------------------------------------------
// HistChart: one distribution as adjacent bars with a 2px surface gap.
// bins: [{x0, x1, count}], optional markers: [{x, label, color}]
// ---------------------------------------------------------------------------
export class HistChart extends BaseChart {
  constructor(container, opts = {}) {
    super(container, opts);
    this.bins = [];
    this.markers = [];
    if (opts.legend) this.renderLegend([{ name: opts.name || '', color: opts.color, type: 'bar' }]);
    else if (opts.title) this.renderLegend([]);
  }

  setData(bins, markers = []) {
    this.bins = bins;
    this.markers = markers;
    this.schedule();
  }

  draw() {
    const { w, h } = this.size();
    const ctx = this.ctx;
    const th = this.theme();
    const pad = this.pad;
    const o = this.opts;
    ctx.clearRect(0, 0, w, h);
    const bins = this.bins;
    const pw = w - pad.left - pad.right;
    const ph = h - pad.top - pad.bottom;
    const xmin = o.x?.min ?? (bins.length ? bins[0].x0 : 0);
    const xmax = o.x?.max ?? (bins.length ? bins[bins.length - 1].x1 : 1);
    let ymax = o.y?.max ?? Math.max(1, ...bins.map((b) => b.count));
    const yt = niceTicks(0, ymax, Math.max(2, Math.round(ph / 48)));
    ymax = Math.max(ymax, yt[yt.length - 1] || ymax);
    const X = (x) => pad.left + ((x - xmin) / (xmax - xmin)) * pw;
    const Y = (y) => pad.top + (1 - y / ymax) * ph;
    this._map = { X, Y, pad, pw, ph, xmin, xmax };
    ctx.font = `11px ${th.font}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    const yfmt = o.y?.format || ((v) => compact(v));
    for (const t of yt) {
      const yy = Math.round(Y(t)) + 0.5;
      ctx.strokeStyle = t === 0 ? th.axis : th.grid;
      ctx.beginPath();
      ctx.moveTo(pad.left, yy);
      ctx.lineTo(pad.left + pw, yy);
      ctx.stroke();
      ctx.fillStyle = th.muted;
      ctx.fillText(yfmt(t), pad.left - 6, yy);
    }
    const color = resolveColor(o.color || '--s1');
    const hovered = this.hoverIndex;
    for (let i = 0; i < bins.length; i++) {
      const b = bins[i];
      if (!b.count) continue;
      const x0 = X(b.x0) + 1;
      const x1 = X(b.x1) - 1;
      const top = Y(b.count);
      const bw = Math.max(1, x1 - x0);
      const r = Math.min(4, bw / 2, (pad.top + ph - top) / 2);
      ctx.fillStyle = i === hovered ? withAlpha(color, 0.75) : color;
      ctx.beginPath();
      const base = pad.top + ph;
      ctx.moveTo(x0, base);
      ctx.lineTo(x0, top + r);
      ctx.quadraticCurveTo(x0, top, x0 + r, top);
      ctx.lineTo(x0 + bw - r, top);
      ctx.quadraticCurveTo(x0 + bw, top, x0 + bw, top + r);
      ctx.lineTo(x0 + bw, base);
      ctx.closePath();
      ctx.fill();
    }
    ctx.strokeStyle = th.axis;
    ctx.beginPath();
    ctx.moveTo(pad.left, pad.top + ph + 0.5);
    ctx.lineTo(pad.left + pw, pad.top + ph + 0.5);
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xfmt = o.x?.format || ((v) => compact(v));
    let lastRight = -Infinity;
    for (const t of niceTicks(xmin, xmax, Math.max(3, Math.round(pw / 60)))) {
      const xx = X(t);
      if (xx < pad.left - 1 || xx > pad.left + pw + 1) continue;
      const label = xfmt(t);
      const tw = ctx.measureText(label).width;
      if (xx - tw / 2 < lastRight + 8) continue;
      ctx.fillStyle = th.muted;
      ctx.fillText(label, xx, pad.top + ph + 7);
      lastRight = xx + tw / 2;
    }
    for (const m of this.markers) {
      const xx = Math.round(X(m.x)) + 0.5;
      if (xx < pad.left || xx > pad.left + pw) continue;
      ctx.strokeStyle = resolveColor(m.color || '--ink');
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(xx, pad.top);
      ctx.lineTo(xx, pad.top + ph);
      ctx.stroke();
      ctx.setLineDash([]);
      if (m.label) {
        ctx.fillStyle = th.ink2;
        ctx.textAlign = xx > pad.left + pw * 0.75 ? 'right' : 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(m.label, xx + (ctx.textAlign === 'left' ? 4 : -4), pad.top + 2);
      }
    }
  }

  onPointer(e) {
    if (!this._map) return;
    const r = this.canvas.getBoundingClientRect();
    const px = e.clientX - r.left;
    const { X } = this._map;
    let idx = -1;
    for (let i = 0; i < this.bins.length; i++) {
      if (px >= X(this.bins[i].x0) && px < X(this.bins[i].x1)) {
        idx = i;
        break;
      }
    }
    if (idx === this.hoverIndex) return;
    this.hoverIndex = idx;
    if (idx < 0 || !this.bins[idx].count) {
      this.tip.hidden = true;
      this.schedule();
      return;
    }
    const b = this.bins[idx];
    const xfmt = this.opts.tipX || this.opts.x?.format || ((v) => compact(v, 3));
    this.tip.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'tip-x';
    head.textContent = `${xfmt(b.x0)} to ${xfmt(b.x1)}`;
    const row = document.createElement('div');
    row.className = 'tip-row';
    const v = document.createElement('b');
    const total = this.bins.reduce((a, c) => a + c.count, 0);
    v.textContent = `${b.count.toLocaleString()}`;
    const n = document.createElement('span');
    n.textContent = `${((100 * b.count) / total).toFixed(1)}% of ${this.opts.unit || 'runs'}`;
    row.append(v, n);
    this.tip.append(head, row);
    this.tip.hidden = false;
    const xx = X(b.x1);
    const tw = this.tip.offsetWidth;
    let left = xx + 8;
    if (left + tw > this.wrap.clientWidth - 4) left = X(b.x0) - tw - 8;
    this.tip.style.left = Math.max(4, left) + 'px';
    this.tip.style.top = this.pad.top + 4 + 'px';
    this.schedule();
  }

  onLeave() {
    this.hoverIndex = -1;
    this.tip.hidden = true;
    this.schedule();
  }
}

// Redraw every chart when the theme changes.
function redrawAll() {
  for (const c of registry) c.schedule();
}
if (typeof window !== 'undefined') {
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', redrawAll);
  new MutationObserver(redrawAll).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
}
