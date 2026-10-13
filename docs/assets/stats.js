// Small numerical toolkit shared by the projects: the normal distribution and
// descriptive statistics. Everything is plain JavaScript with no dependencies.

const SQRT_2PI = Math.sqrt(2 * Math.PI);

export function normPdf(x) {
  return Math.exp(-0.5 * x * x) / SQRT_2PI;
}

// Standard normal CDF, Hart (1968) algorithm 5666 as given by West (2005),
// "Better approximations to cumulative normal functions". Double precision.
export function normCdf(x) {
  const ax = Math.abs(x);
  let c;
  if (ax > 37) {
    c = 0;
  } else {
    const e = Math.exp(-0.5 * ax * ax);
    if (ax < 7.07106781186547) {
      let n = 3.52624965998911e-2 * ax + 0.700383064443688;
      n = n * ax + 6.37396220353165;
      n = n * ax + 33.912866078383;
      n = n * ax + 112.079291497871;
      n = n * ax + 221.213596169931;
      n = n * ax + 220.206867912376;
      let d = 8.83883476483184e-2 * ax + 1.75566716318264;
      d = d * ax + 16.064177579207;
      d = d * ax + 86.7807322029461;
      d = d * ax + 296.564248779674;
      d = d * ax + 637.333633378831;
      d = d * ax + 793.826512519948;
      d = d * ax + 440.413735824752;
      c = (e * n) / d;
    } else {
      let b = ax + 0.65;
      b = ax + 4 / b;
      b = ax + 3 / b;
      b = ax + 2 / b;
      b = ax + 1 / b;
      c = e / b / 2.506628274631;
    }
  }
  return x > 0 ? 1 - c : c;
}

// Inverse normal CDF: Acklam's rational approximation (relative error 1.15e-9)
// followed by one Halley step against normCdf, which brings it to ~1e-15.
export function normInv(p) {
  if (!(p > 0 && p < 1)) {
    if (p === 0) return -Infinity;
    if (p === 1) return Infinity;
    return NaN;
  }
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  let x;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= 1 - pLow) {
    const q = p - 0.5;
    const r = q * q;
    x = ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const e = normCdf(x) - p;
  const u = e * SQRT_2PI * Math.exp(0.5 * x * x);
  return x - u / (1 + 0.5 * x * u);
}

export function sum(xs) {
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i];
  return s;
}

export function mean(xs) {
  return xs.length ? sum(xs) / xs.length : NaN;
}

// Sample variance (n - 1 denominator).
export function variance(xs) {
  const n = xs.length;
  if (n < 2) return NaN;
  const m = mean(xs);
  let s = 0;
  for (let i = 0; i < n; i++) s += (xs[i] - m) ** 2;
  return s / (n - 1);
}

export function std(xs) {
  return Math.sqrt(variance(xs));
}

// Population skewness and (non-excess) kurtosis, as used by the deflated Sharpe ratio.
export function moments(xs) {
  const n = xs.length;
  const m = mean(xs);
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  for (let i = 0; i < n; i++) {
    const d = xs[i] - m;
    const d2 = d * d;
    m2 += d2;
    m3 += d2 * d;
    m4 += d2 * d2;
  }
  m2 /= n;
  m3 /= n;
  m4 /= n;
  return {
    mean: m,
    skew: m2 > 0 ? m3 / m2 ** 1.5 : 0,
    kurtosis: m2 > 0 ? m4 / (m2 * m2) : 3,
  };
}

export function quantile(xs, q) {
  if (!xs.length) return NaN;
  const s = Float64Array.from(xs).sort();
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export function correlation(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxy / Math.sqrt(sxx * syy);
}

// Equal-width histogram. Returns [{x0, x1, count}].
export function histogram(xs, bins = 30, lo, hi) {
  let min = lo ?? Infinity;
  let max = hi ?? -Infinity;
  if (lo === undefined || hi === undefined) {
    for (const x of xs) {
      if (lo === undefined && x < min) min = x;
      if (hi === undefined && x > max) max = x;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (max === min) max = min + 1;
  const w = (max - min) / bins;
  const out = Array.from({ length: bins }, (_, i) => ({ x0: min + i * w, x1: min + (i + 1) * w, count: 0 }));
  for (const x of xs) {
    let i = Math.floor((x - min) / w);
    if (i === bins) i = bins - 1;
    if (i >= 0 && i < bins) out[i].count++;
  }
  return out;
}

export const EULER_GAMMA = 0.5772156649015329;
