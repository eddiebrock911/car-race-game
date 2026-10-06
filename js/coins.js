// ---------------------------------------------------------------------------
// DUSKRUNNER V2 — coins.js
// Highway coin pickups: pooled, pattern-based spawning that never places a
// coin inside traffic (or in a lane walled-off ahead → always reachable),
// magnet attraction, and collect checks in depth space.
// ---------------------------------------------------------------------------

import { clamp, approach, Pool } from './util.js';

export const COIN_VALUE = 2;      // coins granted per pickup
export const COIN_SCORE = 25;     // score per pickup

function makeCoin() {
  return { x: 0, d: 0, spin: 0, pulling: false };
}
function resetCoin(c) { c.spin = Math.random() * 6.28; c.pulling = false; }

const PATTERNS = ['line', 'line', 'zig', 'arc', 'pair', 'single'];

export class CoinManager {
  constructor() {
    this.pool = new Pool(makeCoin, resetCoin, 24, 48);
    this.sinceWave = 0;       // meters since last wave
    this.nextWaveAt = 180;    // first wave distance
    this.rng = Math.random;
    this.collectedRun = 0;
  }

  reset(rng) {
    this.pool.releaseAll();
    this.rng = rng || Math.random;
    this.sinceWave = 0;
    this.nextWaveAt = 140 + this.rng() * 120;
    this.collectedRun = 0;
  }

  get coins() { return this.pool.active; }

  /** Occupancy callback used by traffic spawner (never spawn a car on coins). */
  occupies(laneX, dMin, dMax) {
    for (const c of this.pool.active) {
      if (Math.abs(c.x - laneX) < 0.7 && c.d > dMin && c.d < dMax) return true;
    }
    return false;
  }

  /**
   * Lane is a valid coin target:
   *  - never inside a vehicle body right now
   *  - never on a collision course with a vehicle AHEAD: the coin travels at
   *    player speed v while a car ahead travels at (v - sp), so the coin would
   *    visually rear-end it unless that car despawns first. Meeting depth is
   *    x* = d − v·(d − u.d)/sp; any x* above the despawn plane (−14) means a
   *    visible drive-over → reject the cell. Algebraically:
   *        reject if  u.d > d − (d + 14)·(sp/v) − 2
   *    (guarantees no coin ever appears inside traffic, at any speed).
   */
  _laneOK(traffic, laneX, d, v) {
    if (traffic.isBlocked(laneX, d - 5, d + 5)) return false;
    const vv = Math.max(v || 100, 40);
    for (const u of traffic.vehicles) {
      if (Math.abs(u.x - laneX) > 0.6) continue;
      if (u.d >= d) continue;                                   // behind → drifts away
      if (u.d > d - (d + 14) * (u.sp / vv) - 2) return false;   // catch-up collision course
    }
    return true;
  }

  _place(traffic, laneX, d, v) {
    if (d < 60 || d > 175) return false;
    if (!this._laneOK(traffic, laneX, d, v)) return false;
    const c = this.pool.obtain();
    if (!c) return false;
    c.x = laneX; c.d = d; c.pulling = false;
    return true;
  }

  /**
   * Spawn a wave far ahead of the player (around the traffic spawn band).
   * Called when the player has driven `nextWaveAt` meters since the last one.
   */
  trySpawnWave(traffic, v = 100) {
    const rng = this.rng;
    const pattern = PATTERNS[(rng() * PATTERNS.length) | 0];
    const baseD = 150 + rng() * 18;
    let placed = 0;

    const lanes = [0, 1, 2];
    for (let i = 2; i > 0; i--) { const j = (rng() * (i + 1)) | 0; const t = lanes[i]; lanes[i] = lanes[j]; lanes[j] = t; }

    if (pattern === 'line') {
      const L = lanes[0] - 1;
      const n = 4 + ((rng() * 4) | 0);
      for (let k = 0; k < n; k++) if (this._place(traffic, L, baseD - k * 7, v)) placed++;
    } else if (pattern === 'zig') {
      const A = lanes[0] - 1, B = lanes[1] - 1;
      for (let k = 0; k < 6; k++) if (this._place(traffic, k & 1 ? B : A, baseD - k * 8, v)) placed++;
    } else if (pattern === 'arc') {
      for (let k = 0; k < 3; k++)
        for (let j = 0; j < 2; j++)
          if (this._place(traffic, lanes[k] - 1, baseD - j * 9 - k * 2, v)) placed++;
    } else if (pattern === 'pair') {
      const A = lanes[0] - 1, B = lanes[1] - 1;
      for (let k = 0; k < 3; k++) {
        if (this._place(traffic, A, baseD - k * 8, v)) placed++;
        if (this._place(traffic, B, baseD - k * 8, v)) placed++;
      }
    } else {
      for (let k = 0; k < 3; k++) if (this._place(traffic, lanes[k] - 1, baseD - k * 12, v)) placed++;
    }

    // schedule next wave: denser a bit, then space out (fair pacing)
    this.nextWaveAt = placed > 0 ? 110 + rng() * 150 : 60 + rng() * 60;
    this.sinceWave = 0;
  }

  /**
   * @param {number} dt
   * @param {{v:number, driven:number, px:number, magnet:boolean}} ctx
   * @returns {number} number of coins collected this frame
   */
  update(dt, ctx) {
    const { v, px, magnet } = ctx;
    this.sinceWave += ctx.driven;
    let collected = 0;

    // reverse walk via Pool.each → safe to release() inside the loop
    this.pool.each(c => {
      c.d -= v * dt;
      c.spin += dt * 4.5;

      if (magnet && c.d < 52 && c.d > -3 && Math.abs(c.x - px) < 1.9) {
        c.pulling = true;
        c.x += (px - c.x) * approach(dt, 4.2);
        c.d -= 30 * dt; // reel toward the player
      } else if (c.pulling && c.d > 3) {
        c.x += (px - c.x) * approach(dt, 1.5);
      }

      if (c.d < 1.7 && c.d > -2.4 && Math.abs(c.x - px) < (c.pulling ? 0.75 : 0.55)) {
        collected++;
        this.collectedRun++;
        this.pool.release(c);
      } else if (c.d < -14) {
        this.pool.release(c);
      }
    });
    return collected;
  }
}
