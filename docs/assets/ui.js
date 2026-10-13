// Shared page behaviour: theme toggle, GitHub source links, formula rendering,
// small formatting helpers and slider bindings.

export const REPO = 'https://github.com/jameshales02/newton-raphson-solver';
export const BRANCH = 'main';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

// ---------- formatting ----------
export function fmtNum(v, dp = 2) {
  if (!Number.isFinite(v)) return '–';
  return v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export function fmtInt(v) {
  if (!Number.isFinite(v)) return '–';
  return Math.round(v).toLocaleString('en-US');
}

export function fmtPct(v, dp = 1) {
  if (!Number.isFinite(v)) return '–';
  return (v * 100).toFixed(dp) + '%';
}

export function fmtMoney(v, dp = 0) {
  if (!Number.isFinite(v)) return '–';
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  return (v < 0 ? '−$' : '$') + s;
}

export function fmtSigned(v, dp = 2) {
  if (!Number.isFinite(v)) return '–';
  return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(dp);
}

export function signClass(v) {
  return v > 0 ? 'pos' : v < 0 ? 'neg' : '';
}

// ---------- controls ----------
// Keeps <output for="id"> next to a range input in sync; returns a getter.
export function bindRange(id, format = (v) => v, onChange) {
  const input = document.getElementById(id);
  const out = document.querySelector(`output[for="${id}"]`);
  const update = () => {
    if (out) out.textContent = format(+input.value);
  };
  input.addEventListener('input', () => {
    update();
    onChange?.(+input.value);
  });
  update();
  return () => +input.value;
}

export function num(id) {
  return +document.getElementById(id).value;
}

export function val(id) {
  return document.getElementById(id).value;
}

export function radio(name) {
  return document.querySelector(`input[name="${name}"]:checked`)?.value;
}

export function checked(id) {
  return document.getElementById(id).checked;
}

export function debounce(fn, ms = 120) {
  let t = 0;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

// Let the browser paint (e.g. a "Running…" label) before heavy synchronous work.
export function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
}

export async function busy(button, label, work) {
  const old = button.textContent;
  button.disabled = true;
  button.textContent = label;
  await nextFrame();
  try {
    return await work();
  } finally {
    button.disabled = false;
    button.textContent = old;
  }
}

export const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// ---------- theme ----------
function storedTheme() {
  try {
    return localStorage.getItem('tsp-theme');
  } catch {
    return null;
  }
}

function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
}

function currentTheme() {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'light' || attr === 'dark') return attr;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function initTheme() {
  const saved = storedTheme();
  if (saved) applyTheme(saved);
  const btn = document.querySelector('.theme-toggle');
  if (!btn) return;
  const label = () => {
    btn.textContent = currentTheme() === 'dark' ? 'Light theme' : 'Dark theme';
  };
  label();
  btn.addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try {
      localStorage.setItem('tsp-theme', next);
    } catch {
      /* storage unavailable: theme still applies for this visit */
    }
    label();
  });
  new MutationObserver(label).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

// ---------- source links + maths ----------
function initSourceLinks() {
  for (const a of document.querySelectorAll('a[data-src]')) {
    const path = a.getAttribute('data-src');
    const kind = path.endsWith('/') ? 'tree' : 'blob';
    a.href = `${REPO}/${kind}/${BRANCH}/${path.replace(/\/$/, '')}`;
    a.target = '_blank';
    a.rel = 'noopener';
  }
}

function initMath() {
  if (!document.querySelector('.math, .tex')) return;
  window.MathJax = {
    tex: { inlineMath: [['\\(', '\\)']], displayMath: [['\\[', '\\]']] },
    svg: { fontCache: 'global' },
    options: { skipHtmlTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code', 'canvas'] },
  };
  const s = document.createElement('script');
  s.src = 'https://cdnjs.cloudflare.com/ajax/libs/mathjax/3.2.2/es5/tex-svg.min.js';
  s.async = true;
  document.head.appendChild(s);
}

initTheme();
initSourceLinks();
initMath();
