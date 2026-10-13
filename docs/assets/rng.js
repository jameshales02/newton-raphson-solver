// Seeded pseudo-random numbers so every simulation on the site is reproducible.
// mulberry32 is a small, fast 32-bit generator with good statistical quality for
// Monte Carlo work of this size (it is not cryptographic).

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Derive independent stream seeds from one master seed (splitmix-style hash).
export function deriveSeed(seed, stream) {
  let z = (seed ^ Math.imul(stream + 1, 0x9e3779b9)) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
  return (z ^ (z >>> 16)) >>> 0;
}

export class RNG {
  constructor(seed = 1) {
    this.next = mulberry32(seed);
    this._spare = null;
  }

  uniform(lo = 0, hi = 1) {
    return lo + (hi - lo) * this.next();
  }

  int(n) {
    return Math.floor(this.next() * n);
  }

  // Standard normal via the Marsaglia polar method (keeps the second draw).
  normal() {
    if (this._spare !== null) {
      const s = this._spare;
      this._spare = null;
      return s;
    }
    let u, v, s;
    do {
      u = 2 * this.next() - 1;
      v = 2 * this.next() - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const m = Math.sqrt((-2 * Math.log(s)) / s);
    this._spare = v * m;
    return u * m;
  }

  exponential(rate = 1) {
    return -Math.log(1 - this.next()) / rate;
  }

  // Poisson: Knuth's product method for small means, normal approximation above 30.
  poisson(lambda) {
    if (lambda <= 0) return 0;
    if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * this.normal()));
    const L = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= this.next();
    } while (p > L);
    return k - 1;
  }

  // Gamma(shape, 1) by Marsaglia & Tsang; used for Student-t draws.
  gamma(shape) {
    if (shape < 1) return this.gamma(shape + 1) * Math.pow(this.next(), 1 / shape);
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x, v;
      do {
        x = this.normal();
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = this.next();
      if (u < 1 - 0.0331 * x ** 4) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }

  // Student-t with nu degrees of freedom, scaled to unit variance (nu > 2).
  studentT(nu) {
    const z = this.normal();
    const chi2 = 2 * this.gamma(nu / 2);
    return (z / Math.sqrt(chi2 / nu)) * Math.sqrt((nu - 2) / nu);
  }

  // Lognormal multiplier with mean 1 and coefficient of variation cv.
  lognormalUnitMean(cv) {
    if (cv <= 0) return 1;
    const s = Math.sqrt(Math.log(1 + cv * cv));
    return Math.exp(s * this.normal() - 0.5 * s * s);
  }
}
