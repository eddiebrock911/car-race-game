// ---------------------------------------------------------------------------
// DUSKRUNNER V2 — nitro.js
// Nitro tank + smooth activation blend. Capacity/drain come from the selected
// car's stats (garage.physicsFor). No DOM. game.js feeds input; render.js and
// audio read `boost` (0..1 blend) for zoom / flames / engine pitch.
// ---------------------------------------------------------------------------

import { clamp } from './util.js';

const MIN_START = 6;        // minimum tank units required to ignite
const BLEND_UP = 6.5;       // blend-in rate (smooth activation)
const BLEND_DOWN = 4.0;     // blend-out rate (smooth deactivation)

export class NitroSystem {
  constructor() {
    this.capacity = 100;
    this.drain = 30;
    this.regen = 4;
    this.amount = 100;
    this.active = false;
    this.boost = 0;         // 0..1 smooth blend for visuals/audio/physics
    this.useCount = 0;      // ignitions this run
    this.unitsUsed = 0;     // total units burned this run
    this.empty = false;
  }

  configure(physics) {
    this.capacity = physics.nitroCapacity;
    this.drain = physics.nitroDrain;
    this.regen = physics.nitroRegen;
  }

  reset() {
    this.amount = this.capacity;
    this.active = false;
    this.boost = 0;
    this.useCount = 0;
    this.unitsUsed = 0;
    this.empty = false;
  }

  get pct() { return clamp(this.amount / this.capacity, 0, 1); }

  /** @returns {boolean} true on ignition frame (for sound + stats). */
  press(wantBoost) {
    if (wantBoost && !this.active && this.amount >= MIN_START && !this.empty) {
      this.active = true;
      this.useCount++;
      return true;
    }
    if (!wantBoost) this.active = false;
    return false;
  }

  add(n) {
    this.amount = clamp(this.amount + n, 0, this.capacity);
    if (this.amount > MIN_START) this.empty = false;
  }

  /** Refill a fraction of capacity (nitro pickup). */
  refill(frac = 0.45) {
    this.add(this.capacity * frac);
  }

  update(dt) {
    if (this.active) {
      const burn = Math.min(this.amount, this.drain * dt);
      this.amount -= burn;
      this.unitsUsed += burn;
      if (this.amount <= 0) { this.active = false; this.empty = true; }
    } else {
      this.amount = clamp(this.amount + this.regen * dt, 0, this.capacity);
      if (this.amount > MIN_START * 2) this.empty = false;
    }
    const target = this.active ? 1 : 0;
    const rate = target > this.boost ? BLEND_UP : BLEND_DOWN;
    this.boost += (target - this.boost) * Math.min(1, dt * rate);
    if (Math.abs(this.boost - target) < 0.002) this.boost = target;
  }
}
