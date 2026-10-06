// ---------------------------------------------------------------------------
// DUSKRUNNER V2 — effects.js
// All screen-space juice, fully pooled and quality-scaled:
//   particles (sparks/smoke/flames/glass), floating score text, screen shake,
//   color flashes, radial speed streaks (from v1), ambient weather motes.
// Caps follow the graphics quality setting; every emitter respects the
// particles/motion/shake toggles from Settings.
// ---------------------------------------------------------------------------

import { clamp, Pool } from './util.js';

const QUALITY_CAPS = { low: 70, medium: 180, high: 340 };
const AMBIENT_MAX = 34;

function makeParticle() {
  return { x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 1, r: 2, c: '#fff', smoke: false, grav: 700, glow: false, fade: 1 };
}
function resetParticle(p) {
  p.life = 0; p.smoke = false; p.grav = 700; p.glow = false; p.fade = 1; p.max = 1; p.r = 2;
}

function makeText() {
  return { x: 0, y: 0, vy: -60, life: 0, max: 1, text: '', color: '#fff', size: 20, weight: 800, align: 'center', vx: 0 };
}
function resetText(t) { t.vy = -60; t.vx = 0; t.life = 0; t.max = 1; t.size = 20; t.weight = 800; t.align = 'center'; t.color = '#fff'; }

export class Effects {
  constructor() {
    this.particles = new Pool(makeParticle, resetParticle, 40, QUALITY_CAPS.high);
    this.texts = new Pool(makeText, resetText, 12, 24);
    this.shake = 0;
    this.flash = 0;
    this.flashColor = '255,60,70';
    this.quality = 'high';
    this.particlesOn = true;
    this.shakeOn = true;
    this.motionOn = true;
    // radial speed streaks (v1 heritage, fixed allocation)
    this.streaks = Array.from({ length: 18 }, (_, i) => ({ a: (i / 18) * 6.283 + Math.random(), p: Math.random() }));
    // ambient motes
    this.ambient = Array.from({ length: AMBIENT_MAX }, () => ({ x: Math.random(), y: Math.random(), s: 0.4 + Math.random() * 1.4, sp: 0.2 + Math.random() * 0.8, ph: Math.random() * 6.28 }));
    this.ambientType = 'none';
  }

  setQuality(q, opts = {}) {
    this.quality = q;
    this.particles.max = QUALITY_CAPS[q] || QUALITY_CAPS.medium;
    if (opts.particles !== undefined) this.particlesOn = opts.particles;
    if (opts.shake !== undefined) this.shakeOn = opts.shake;
    if (opts.motion !== undefined) this.motionOn = opts.motion;
  }

  get cap() { return QUALITY_CAPS[this.quality] || 180; }
  /** Emit scale: low quality uses fewer particles per burst. */
  get scale() { return this.quality === 'low' ? 0.4 : this.quality === 'medium' ? 0.7 : 1; }

  reset() {
    this.particles.releaseAll();
    this.texts.releaseAll();
    this.shake = 0; this.flash = 0;
  }

  // --- emitters -------------------------------------------------------------

  addShake(amount) {
    if (!this.shakeOn) return;
    this.shake = Math.min(1.4, this.shake + amount);
  }

  addFlash(rgb, amount = 1) {
    this.flash = Math.min(1, this.flash + amount);
    this.flashColor = rgb;
  }

  burst(x, y, n, opts = {}) {
    if (!this.particlesOn) return;
    n = Math.max(1, Math.round(n * this.scale));
    for (let i = 0; i < n; i++) {
      const p = this.particles.obtain();
      if (!p) return;
      const a = opts.angle !== undefined
        ? opts.angle + (Math.random() - 0.5) * (opts.spread || 1.2)
        : Math.random() * 6.283;
      const sp = (opts.speed || 200) * (0.3 + Math.random() * 0.9);
      p.x = x + (Math.random() - 0.5) * (opts.jitter || 6);
      p.y = y + (Math.random() - 0.5) * (opts.jitter || 6);
      p.vx = Math.cos(a) * sp + (opts.vx || 0);
      p.vy = Math.sin(a) * sp + (opts.vy || 0);
      p.max = (opts.life || 0.7) * (0.6 + Math.random() * 0.8);
      p.r = (opts.r || 3) * (0.6 + Math.random() * 0.9);
      p.c = Array.isArray(opts.colors) ? opts.colors[(Math.random() * opts.colors.length) | 0] : (opts.color || '#ffd36e');
      p.smoke = !!opts.smoke;
      p.grav = opts.grav !== undefined ? opts.grav : (p.smoke ? -40 : 700);
      p.glow = !!opts.glow;
    }
  }

  /** Big crash explosion — matches v1 look (sparks + smoke). */
  crashBurst(x, y) {
    if (!this.particlesOn) return;
    const n = Math.round(80 * this.scale);
    for (let i = 0; i < n; i++) {
      const p = this.particles.obtain();
      if (!p) return;
      const a = Math.random() * 6.283;
      const sp = 60 + Math.random() * 380;
      const spark = i < n * 0.56;
      p.x = x; p.y = y;
      p.vx = Math.cos(a) * sp; p.vy = Math.sin(a) * sp - 120;
      p.max = spark ? 0.5 + Math.random() * 0.6 : 0.9 + Math.random() * 0.9;
      p.r = spark ? 1.5 + Math.random() * 2.5 : 8 + Math.random() * 16;
      p.c = spark ? (i % 2 ? '#ffd36e' : '#fff') : '#6c6478';
      p.smoke = !spark;
      p.grav = spark ? 700 : -40;
      p.glow = false;
    }
  }

  /** Nitro flame trail behind the player car. */
  nitroFlame(x, y, intensity) {
    if (!this.particlesOn) return;
    const n = Math.random() < intensity ? 2 : 1;
    for (let i = 0; i < n; i++) {
      const p = this.particles.obtain();
      if (!p) return;
      p.x = x + (Math.random() - 0.5) * 14;
      p.y = y + 4 + Math.random() * 6;
      p.vx = (Math.random() - 0.5) * 60;
      p.vy = 130 + Math.random() * 180;
      p.max = 0.22 + Math.random() * 0.25;
      p.r = 3 + Math.random() * 5;
      p.c = Math.random() < 0.5 ? '#7df9ff' : (Math.random() < 0.5 ? '#ffffff' : '#5c9dff');
      p.smoke = false; p.grav = 120; p.glow = true;
    }
  }

  coinBurst(x, y) {
    this.burst(x, y, 10, { colors: ['#ffd35c', '#fff2b0', '#ffaa2e'], speed: 150, life: 0.5, r: 2.4, grav: 420, glow: true });
  }

  shieldShatter(x, y) {
    this.burst(x, y, 26, { colors: ['#9be8ff', '#ffffff', '#5cc8ff'], speed: 320, life: 0.6, r: 3, grav: 500, glow: true });
  }

  /** Floating score/feedback text (screen space). */
  popText(x, y, text, color = '#fff', size = 20, opts = {}) {
    const t = this.texts.obtain();
    if (!t) return;
    t.x = x; t.y = y; t.text = text; t.color = color; t.size = size;
    t.max = opts.max || 1.0;
    t.vy = opts.vy !== undefined ? opts.vy : -64;
    t.vx = opts.vx || 0;
    t.weight = opts.weight || 800;
    t.align = opts.align || 'center';
  }

  updateAmbient(dt, type) { this.ambientType = type; }

  // --- update ------------------------------------------------------------------

  update(dt, ctx = {}) {
    // particles
    this.particles.each(p => {
      p.life += dt;
      if (p.life >= p.max) { this.particles.release(p); return; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += p.grav * dt;
      p.vx *= 0.99;
    });
    // floating texts
    this.texts.each(t => {
      t.life += dt;
      if (t.life >= t.max) { this.texts.release(t); return; }
      t.x += t.vx * dt;
      t.y += t.vy * dt;
      t.vy *= 0.985;
    });
    // shake & flash decay
    this.shake = Math.max(0, this.shake - dt * 1.8);
    this.flash = Math.max(0, this.flash - dt * 2.5);
    // speed streaks
    const v = ctx.v || 0;
    for (const s of this.streaks) s.p = (s.p + dt * v * 0.012) % 1;
    // ambient motes
    const wind = ctx.v ? clamp(ctx.v / 120, 0, 1.4) : 0;
    for (const m of this.ambient) {
      m.ph += dt * 1.4;
      if (this.ambientType === 'rain') {
        m.y += dt * (0.9 + m.sp) * (1 + wind);
        m.x -= dt * 0.06;
      } else if (this.ambientType === 'dust') {
        m.y += dt * 0.10 * m.sp;
        m.x += Math.sin(m.ph) * dt * 0.03 + dt * wind * 0.05;
      } else { // embers / fireflies drift upward-ish
        m.y -= dt * 0.06 * m.sp;
        m.x += Math.sin(m.ph * 0.8) * dt * 0.04;
      }
      if (m.y > 1.05) { m.y = -0.05; m.x = Math.random(); }
      if (m.y < -0.05) { m.y = 1.05; m.x = Math.random(); }
      if (m.x > 1.05) m.x = -0.05;
      if (m.x < -0.05) m.x = 1.05;
    }
  }
}
