// ---------------------------------------------------------------------------
// DUSKRUNNER V2 — player.js
// Player physics: lane stepping (same feel as v1), stat-driven lateral lerp,
// speed model with acceleration curve, throttle/brake modifiers and nitro
// ceiling boost. All numbers derive from garage stats → upgrades matter.
// ---------------------------------------------------------------------------

import { clamp, approach } from './util.js';

export const LANES = 3;
export const PLAYER_HIT_HALF_W = 0.30; // lateral half width in lane units
export const PLAYER_HIT_FRONT = 1.0;   // depth extent in front
export const PLAYER_HIT_BACK = -1.8;   // depth extent behind

export class Player {
  constructor() {
    this.lane = 1;
    this.x = 0;            // float lane position, -1..1
    this.v = 30;           // world speed
    this.tilt = 0;
    this.physics = null;   // from garage.physicsFor
    this.steerLock = 0;    // tiny cooldown so one input = one lane change
  }

  configure(physics) { this.physics = physics; }

  reset(v0 = 30) {
    this.lane = 1;
    this.x = 0;
    this.v = v0;
    this.tilt = 0;
    this.steerLock = 0;
  }

  steer(dir) {
    if (this.steerLock > 0) return false;
    const next = clamp(this.lane + dir, 0, LANES - 1);
    if (next === this.lane) return false;
    this.lane = next;
    this.steerLock = 0.12;
    return true;
  }

  /** Cruise target speed for a distance (v1 curve, scaled to car vMax). */
  cruiseTarget(dist) {
    const p = this.physics;
    return p.vMax * (0.34 + 0.66 * (1 - Math.exp(-dist / 9000)));
  }

  /**
   * @param {number} dt
   * @param {{throttle:boolean, brake:boolean}} input
   * @param {number} dist
   * @param {number} boostBlend 0..1 from NitroSystem
   */
  update(dt, input, dist, boostBlend) {
    const p = this.physics;
    this.steerLock = Math.max(0, this.steerLock - dt);

    // --- longitudinal ---
    let target = this.cruiseTarget(dist);
    if (input.throttle) target *= 1.16;
    if (input.brake) target *= 0.58;
    target *= 1 + (p.vNitroMul - 1) * boostBlend;
    target = Math.min(target, p.vMax * p.vNitroMul);
    this.v += (target - this.v) * Math.min(1, dt * p.accelRate);

    // --- lateral ---
    const tx = this.lane - 1;
    this.x += (tx - this.x) * approach(dt, p.steerRate);
    this.tilt = clamp((tx - this.x) * 0.34, -0.16, 0.16);
  }

  get kmh() { return Math.round(this.v * (this.physics ? this.physics.kmh : 2)); }
}
