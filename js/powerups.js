// ---------------------------------------------------------------------------
// DUSKRUNNER V2 — powerups.js
// Floating power-up boxes (SHIELD / MAGNET / SLOW-MO / NITRO) with pooled
// spawning that avoids traffic, plus the active-effects state machine.
// Slow-motion uses a smoothly interpolated blend (never an abrupt change).
// ---------------------------------------------------------------------------

import { clamp, approach, Pool } from './util.js';

export const POWERUP_TYPES = ['shield', 'magnet', 'slow', 'nitro'];
export const POWERUP_INFO = {
  shield: { label: 'SHIELD', icon: '🛡', color: '#5cc8ff', dur: 15 },
  magnet: { label: 'MAGNET', icon: '🧲', color: '#ff5c8a', dur: 8 },
  slow:   { label: 'SLOW MOTION', icon: '🐌', color: '#9dff5c', dur: 6 },
  nitro:  { label: 'NITRO', icon: '⚡', color: '#ffd35c', dur: 0 } // instant
};

// --- active effects -----------------------------------------------------------

export const Effects = {
  shield: false,
  shieldT: 0,
  shieldPop: 0,          // break animation timer
  magnetT: 0,
  slowT: 0,
  slowBlend: 0,          // 0..1 smooth interpolation → traffic speed factor
  invulnT: 0,            // post-shield-break invulnerability
  flashT: 0,
  flashColor: '#fff',

  reset() {
    this.shield = false; this.shieldT = 0; this.shieldPop = 0;
    this.magnetT = 0; this.slowT = 0; this.slowBlend = 0;
    this.invulnT = 0; this.flashT = 0;
  },

  get magnet() { return this.magnetT > 0; },

  /**
   * Apply a collected power-up.
   * @returns {string|null} event name for game/audio hooks ('nitro' etc.)
   */
  apply(type) {
    const info = POWERUP_INFO[type];
    if (!info) return null;
    this.flash(POWERUP_INFO[type].color);
    if (type === 'shield') {
      // refresh duration; never stack more than one charge
      this.shield = true;
      this.shieldT = info.dur;
    } else if (type === 'magnet') {
      this.magnetT = Math.max(this.magnetT, 0) + info.dur;
    } else if (type === 'slow') {
      this.slowT = Math.max(this.slowT, 0) + info.dur;
    } else if (type === 'nitro') {
      return 'nitro'; // game.js refills the NitroSystem
    }
    return type;
  },

  flash(color) { this.flashT = 0.35; this.flashColor = color; },

  /** Shield absorbs a hit. @returns {boolean} true if absorbed. */
  consumeShield() {
    if (!this.shield) return false;
    this.shield = false;
    this.shieldT = 0;
    this.shieldPop = 0.5;
    this.invulnT = 1.3;
    return true;
  },

  update(dt) {
    if (this.shield) {
      this.shieldT -= dt;
      if (this.shieldT <= 0) { this.shield = false; this.shieldT = 0; }
    }
    if (this.magnetT > 0) this.magnetT = Math.max(0, this.magnetT - dt);
    if (this.slowT > 0) this.slowT = Math.max(0, this.slowT - dt);
    if (this.invulnT > 0) this.invulnT = Math.max(0, this.invulnT - dt);
    if (this.shieldPop > 0) this.shieldPop = Math.max(0, this.shieldPop - dt);
    if (this.flashT > 0) this.flashT = Math.max(0, this.flashT - dt);
    // smooth slow-mo interpolation in AND out
    const target = this.slowT > 0 ? 1 : 0;
    this.slowBlend += (target - this.slowBlend) * approach(dt, 3.0);
    if (Math.abs(this.slowBlend - target) < 0.003) this.slowBlend = target;
  },

  /** HUD chip descriptors (only active ones). */
  hudList() {
    const out = [];
    if (this.shield) out.push({ key: 'shield', icon: '🛡', label: 'SHIELD', t: this.shieldT, dur: POWERUP_INFO.shield.dur });
    if (this.magnetT > 0) out.push({ key: 'magnet', icon: '🧲', label: 'MAGNET', t: this.magnetT, dur: POWERUP_INFO.magnet.dur });
    if (this.slowT > 0) out.push({ key: 'slow', icon: '🐌', label: 'SLOW-MO', t: this.slowT, dur: POWERUP_INFO.slow.dur });
    if (this.invulnT > 0 && !this.shield) out.push({ key: 'invuln', icon: '✦', label: 'PHASE', t: this.invulnT, dur: 1.3 });
    return out;
  }
};

// --- world pickups ---------------------------------------------------------------

function makePickup() {
  return { type: 'shield', x: 0, d: 0, bob: 0 };
}
function resetPickup(p) { p.bob = Math.random() * 6.28; }

export class PowerupManager {
  constructor() {
    this.pool = new Pool(makePickup, resetPickup, 4, 6);
    this.sinceSpawn = 0;
    this.nextAt = 500;    // meters until first powerup
    this.rng = Math.random;
  }

  reset(rng) {
    this.pool.releaseAll();
    this.rng = rng || Math.random;
    this.sinceSpawn = 0;
    this.nextAt = 420 + this.rng() * 360;
  }

  get pickups() { return this.pool.active; }

  occupies(laneX, dMin, dMax) {
    for (const p of this.pool.active) {
      if (Math.abs(p.x - laneX) < 0.7 && p.d > dMin && p.d < dMax) return true;
    }
    return false;
  }

  _pickType() {
    const rng = this.rng;
    const w = [
      ['nitro', 30],
      ['magnet', 24],
      ['shield', Effects.shield ? 8 : 26],  // don't spam shields when one is up
      ['slow', 22]
    ];
    let total = 0; for (const [, wt] of w) total += wt;
    let r = rng() * total;
    for (const [t, wt] of w) { r -= wt; if (r <= 0) return t; }
    return 'nitro';
  }

  trySpawn(traffic, v = 100) {
    if (this.pool.count >= 3) return false;
    const rng = this.rng;
    const lanes = [0, 1, 2];
    for (let i = 2; i > 0; i--) { const j = (rng() * (i + 1)) | 0; const t = lanes[i]; lanes[i] = lanes[j]; lanes[j] = t; }
    const vv = Math.max(v, 40);
    for (const L of lanes) {
      const laneX = L - 1;
      const d = 152 + rng() * 16;
      // fair placement: clear of traffic now, and no catch-up collision with a
      // vehicle ahead (same precise rule as coins.js)
      if (traffic.isBlocked(laneX, d - 8, d + 8)) continue;
      let caught = false;
      for (const u of traffic.vehicles) {
        if (Math.abs(u.x - laneX) > 0.6) continue;
        if (u.d < d && u.d > d - (d + 14) * (u.sp / vv) - 2) { caught = true; break; }
      }
      if (caught) continue;
      const p = this.pool.obtain();
      if (!p) return false;
      p.type = this._pickType();
      p.x = laneX; p.d = d;
      return true;
    }
    return false;
  }

  /** @returns {string|null} collected powerup type this frame */
  update(dt, ctx) {
    const { v, px } = ctx;
    let got = null;
    this.pool.each(p => {
      p.d -= v * dt;
      p.bob += dt * 2.4;
      if (p.d < 1.9 && p.d > -2.4 && Math.abs(p.x - px) < 0.6) {
        got = p.type;
        this.pool.release(p);
      } else if (p.d < -14) {
        this.pool.release(p);
      }
    });
    return got;
  }
}
