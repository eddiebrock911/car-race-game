// ---------------------------------------------------------------------------
// DUSKRUNNER V2 — util.js
// Pure math / RNG / color helpers. No DOM access. Zero per-frame allocations
// wherever possible (color helpers write into caller-provided arrays).
// ---------------------------------------------------------------------------

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (t) => t * t * (3 - 2 * t);

/** Frame-rate independent exponential approach factor. */
export const approach = (dt, rate) => 1 - Math.exp(-rate * dt);

/** Deterministic seeded PRNG (mulberry32). Returns a function yielding [0,1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a string hash → uint32. Used for the daily-challenge seed. */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function todayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function formatNum(n) {
  n = Math.floor(n || 0);
  return n.toLocaleString('en-US');
}

export function formatDistance(m) {
  m = Math.max(0, Math.floor(m || 0));
  return m >= 1000 ? (m / 1000).toFixed(2) + ' km' : m + ' m';
}

// --- color helpers ---------------------------------------------------------
// Colors are stored as [r,g,b] arrays (0-255). Blending writes into an
// out-array so the render loop never allocates.

export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h[0] + h[0] + h[1] + h[1] + h[2] + h[2] : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** out = lerp(c1, c2, t). Returns out. */
export function lerpRgb(out, c1, c2, t) {
  out[0] = c1[0] + (c2[0] - c1[0]) * t;
  out[1] = c1[1] + (c2[1] - c1[1]) * t;
  out[2] = c1[2] + (c2[2] - c1[2]) * t;
  return out;
}

export function rgbCss(c, a = 1) {
  return a >= 1
    ? `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`
    : `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
}

/** Mix a color toward black (shade<0) or white (shade>0) into out. */
export function shadeRgb(out, c, shade) {
  const t = shade < 0 ? 1 + shade : 1;
  const add = shade > 0 ? shade * 255 : 0;
  out[0] = c[0] * t + add;
  out[1] = c[1] * t + add;
  out[2] = c[2] * t + add;
  return out;
}

export function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
  // Fallback for very old browsers
  r = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Simple generic object pool. */
export class Pool {
  constructor(factory, reset, initial = 0, max = 1e9) {
    this.factory = factory;
    this.resetFn = reset;
    this.max = max;
    this.free = [];
    this.active = [];
    for (let i = 0; i < initial; i++) this.free.push(factory());
  }
  obtain() {
    if (this.active.length >= this.max) return null;
    const o = this.free.length ? this.free.pop() : this.factory();
    this.resetFn(o);
    this.active.push(o);
    return o;
  }
  release(o) {
    const i = this.active.indexOf(o);
    if (i !== -1) { this.active.splice(i, 1); this.free.push(o); }
  }
  releaseAll() {
    while (this.active.length) this.free.push(this.active.pop());
  }
  /** Iterate active items; call `release(o)` inside is safe (reverse walk). */
  each(fn) {
    for (let i = this.active.length - 1; i >= 0; i--) fn(this.active[i], i);
  }
  get count() { return this.active.length; }
}

export const isTouchDevice = () =>
  // Real touch capability only. (matchMedia('(pointer: coarse)') is unreliable:
  // headless/automation browsers report coarse pointers on keyboard machines.)
  (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0) ||
  ('ontouchstart' in globalThis);

export const TAU = Math.PI * 2;
