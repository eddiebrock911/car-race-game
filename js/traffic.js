// ---------------------------------------------------------------------------
// DUSKRUNNER V2 — traffic.js
// Smart traffic: 6 vehicle archetypes with distinct speed/size/behavior,
// pooled objects, difficulty-scaled spawning, and safe lane-changing AI
// (signals first, checks traffic + the player, never forms an unavoidable
// wall). Spawn randomness uses an injectable RNG so Daily Challenge runs are
// deterministic for every player.
// ---------------------------------------------------------------------------

import { clamp, lerp, approach, Pool } from './util.js';

export const SPAWN_D = 170;      // depth vehicles appear at (same as v1)
export const DESPAWN_D = -16;

// Archetypes. hitW = combined half-width for collision (lane units),
// len = forward hit extent, nearW = near-miss lateral band.
export const VTYPES = {
  car:     { sp: [26, 34], w: 0.62, len: 2.5, back: -2.2, hitW: 0.62, nearW: 1.02, shape: 'car' },
  suv:     { sp: [19, 25], w: 0.72, len: 2.9, back: -2.4, hitW: 0.66, nearW: 1.06, shape: 'suv' },
  truck:   { sp: [15, 21], w: 0.78, len: 3.4, back: -3.0, hitW: 0.70, nearW: 1.10, shape: 'truck' },
  sport:   { sp: [42, 58], w: 0.58, len: 2.4, back: -2.2, hitW: 0.60, nearW: 1.00, shape: 'sport' },
  bus:     { sp: [13, 18], w: 0.82, len: 3.6, back: -3.6, hitW: 0.72, nearW: 1.12, shape: 'bus' },
  changer: { sp: [27, 35], w: 0.62, len: 2.5, back: -2.2, hitW: 0.62, nearW: 1.02, shape: 'changer' }
};

export const TRAFFIC_PALETTES = [
  { b: '#6b7a94', d: '#4a5670' },
  { b: '#d9a441', d: '#a67a22' },
  { b: '#6aa37b', d: '#47775a' },
  { b: '#9a70c4', d: '#6c4a92' },
  { b: '#dfe3ec', d: '#a9afbf' },
  { b: '#c96a5a', d: '#8f4438' },
  { b: '#5a86c9', d: '#3a5c93' }
];
export const TRUCK_PALETTES = [
  { b: '#3a6ea5', d: '#e8742a' },
  { b: '#c9c3b6', d: '#d9453a' },
  { b: '#5c8a5e', d: '#d9b23a' },
  { b: '#8a6aa8', d: '#e0d0f0' }
];

function makeVehicle() {
  return {
    type: 'car', shape: 'car',
    lane: 1,          // home integer lane
    x: 0,             // float lane position (-1..1)
    d: SPAWN_D,       // depth
    sp: 30,           // own speed
    len: 2.4, back: -2.2, hitW: 0.62, nearW: 1.02, w: 0.62,
    col: TRAFFIC_PALETTES[0],
    // behavior
    phase: 'cruise',  // changer AI: cruise | signal | move
    thinkT: 2,
    blinkT: 0,
    blinkSide: 0,
    targetX: 0,
    targetLane: 1,
    // flags
    wallCd: 0,        // cooldown for the wall-breaker nudge
    nm: false,        // near-miss already rewarded
    passed: false,    // fully passed the player (dodge counted)
    alpha: 0
  };
}

function resetVehicle(v) {
  v.phase = 'cruise'; v.thinkT = 2; v.blinkT = 0; v.blinkSide = 0;
  v.wallCd = 0;
  v.nm = false; v.passed = false; v.alpha = 0;
}

export class TrafficManager {
  constructor() {
    this.pool = new Pool(makeVehicle, resetVehicle, 12, 20);
    this.spawnSince = 0;   // meters since last spawn attempt
    this.rng = Math.random;
    this.activeCount = 0;
  }

  reset(rng) {
    this.pool.releaseAll();
    this.spawnSince = 0;
    this.rng = rng || Math.random;
    this.activeCount = 0;
  }

  get vehicles() { return this.pool.active; }

  /**
   * Composition weights morph with distance (spec §10/§11):
   * gentle start (cars/SUVs/trucks), fast + lane-changing traffic and buses
   * join as the run matures. Never a sudden spike — all linear ramps.
   */
  _weights(dist) {
    const d = Math.max(0, dist);
    return [
      ['car', 46],
      ['suv', 20],
      ['truck', 15],
      ['sport', clamp(d / 220, 0, 22)],      // full weight at ~4.8 km
      ['changer', clamp(d / 320, 0, 20)],    // full weight at ~6.4 km
      ['bus', d > 700 ? clamp((d - 700) / 260, 0, 9) : 0]
    ];
  }

  _pickType(dist) {
    const w = this._weights(dist);
    let total = 0;
    for (const [, wt] of w) total += wt;
    let r = this.rng() * total;
    for (const [type, wt] of w) { r -= wt; if (r <= 0) return type; }
    return 'car';
  }

  /** Is a lane occupied around depth d? (used for coin/powerup placement) */
  isBlocked(laneX, dMin, dMax) {
    for (const v of this.pool.active) {
      if (Math.abs(v.x - laneX) < 0.75 && v.d + v.len > dMin && v.d < dMax) return true;
    }
    return false;
  }

  /** Count vehicles close to the spawn band per lane. */
  _laneOccupancy(dMin) {
    const occ = [0, 0, 0];
    for (const v of this.pool.active) {
      if (v.d > dMin) {
        const l = clamp(Math.round(v.x + 1), 0, 2);
        occ[l]++;
      }
    }
    return occ;
  }

  /**
   * Try to spawn one vehicle, honoring fairness rules:
   *  - same-lane gap behind spawn point ≥ 26 m (scaled by length)
   *  - never a full 3-lane wall at the spawn band
   *  - never spawn on top of coins / powerups (checked via `pickupCheck`)
   */
  trySpawn(dist, pickupCheck) {
    if (this.pool.count >= 16) return false;
    const rng = this.rng;

    // shuffle lane order
    const order = [0, 1, 2];
    for (let i = 2; i > 0; i--) {
      const j = (rng() * (i + 1)) | 0;
      const t = order[i]; order[i] = order[j]; order[j] = t;
    }

    const occ = this._laneOccupancy(SPAWN_D - 26);
    let occupiedLanes = 0;
    for (const n of occ) if (n > 0) occupiedLanes++;

    for (const L of order) {
      if (occ[L] > 0) continue;                       // too close to existing car
      if (occupiedLanes >= 2) {
        // two lanes already busy near the band → keep the last one open
        const othersOccupied = occ.filter((n, i) => i !== L && n > 0).length;
        if (othersOccupied >= 2) continue;
        if (occ[0] + occ[1] + occ[2] >= 2) continue;  // never complete the wall
      }
      const laneX = L - 1;
      if (pickupCheck && pickupCheck(laneX, SPAWN_D - 6, SPAWN_D + 14)) continue;

      const type = this._pickType(dist);
      const vt = VTYPES[type];
      const v = this.pool.obtain();
      if (!v) return false;

      const speedScale = 1 + Math.min(0.4, Math.max(0, dist) / 25000);
      v.type = type;
      v.shape = vt.shape;
      v.lane = L;
      v.x = laneX;
      v.d = SPAWN_D + rng() * 6;
      v.sp = lerp(vt.sp[0], vt.sp[1], rng()) * speedScale;
      v.len = vt.len; v.back = vt.back; v.hitW = vt.hitW; v.nearW = vt.nearW; v.w = vt.w;
      const pal = (type === 'truck' || type === 'bus') ? TRUCK_PALETTES : TRAFFIC_PALETTES;
      v.col = pal[(rng() * pal.length) | 0];
      v.phase = 'cruise';
      v.thinkT = 1.6 + rng() * 2.2;
      v.blinkT = 0; v.blinkSide = 0;
      v.wallCd = 0;
      v.nm = false; v.passed = false; v.alpha = 0;
      this.activeCount++;
      return true;
    }
    return false;
  }

  /** Lane-change decision for one changer vehicle (safe-move rules). */
  _changerThink(v, px, dist) {
    const rng = this.rng;
    const aggression = clamp(0.35 + dist / 8000, 0.35, 0.9); // bolder over time
    if (rng() > aggression) { v.thinkT = 2 + rng() * 2; return; }

    const dirs = rng() < 0.5 ? [-1, 1] : [1, -1];
    for (const dir of dirs) {
      const targetLane = clamp(v.lane + dir, 0, 2);
      if (targetLane === v.lane) continue;
      const tx = targetLane - 1;
      if (this._laneSafeFor(v, tx, px)) {
        v.phase = 'signal';
        v.blinkT = 0.75;           // signal before moving (spec §10)
        v.blinkSide = dir;
        v.targetX = tx;
        v.targetLane = targetLane;
        v.thinkT = 2.5 + rng() * 2;
        return;
      }
    }
    v.thinkT = 1.5 + rng() * 2;
  }

  /**
   * Lane safety: no vehicle overlapping the target lane within a depth band,
   * not cutting directly in front of a close player, and the move must never
   * seal the last open lane in the local band (no impossible walls).
   */
  _laneSafeFor(v, tx, px) {
    const bandBack = v.d - 14, bandFront = v.d + 28;
    let blocked = 0;
    for (const u of this.pool.active) {
      if (u === v) continue;
      if (Math.abs(u.d - v.d) > 48) continue;
      const uLaneOpen = Math.abs(u.x - tx) >= 0.85;
      if (!uLaneOpen && u.d + u.len > bandBack && u.d < bandFront) return false;
      // count distinct lanes occupied in the local band (for wall check)
      if (u.d + u.len > bandBack - 8 && u.d < bandFront + 8) {
        const l = clamp(Math.round(u.x + 1), 0, 2);
        blocked |= 1 << l;
      }
    }
    blocked |= 1 << clamp(Math.round(v.x + 1), 0, 2); // current lane stays busy briefly
    const targetLaneIdx = clamp(Math.round(tx + 1), 0, 2);
    blocked |= 1 << targetLaneIdx;
    if ((blocked & 0b111) === 0b111) return false;     // would wall all 3 lanes

    // player protection: don't swerve into the player when they're close behind
    if (v.d < 46 && Math.abs(px - tx) < 1.35) return false;
    // ...and don't swerve across a player who is right alongside
    if (v.d < 8 && Math.abs(px - v.x) < 1.2) return false;
    return true;
  }

  /**
   * Advance all vehicles.
   * @param {number} dt
   * @param {{v:number, dist:number, px:number, slowBlend:number}} ctx
   */
  update(dt, ctx) {
    const { v: pv, dist, px, slowBlend } = ctx;
    const slowMul = 1 - 0.72 * slowBlend; // slow-mo powerup: relative world slows

    for (const v of this.pool.active) {
      if (v.wallCd > 0) v.wallCd -= dt;
      // car-following: a faster vehicle closing on a slower one in the same
      // lane matches its speed instead of visually overlapping it (fairness)
      for (const u of this.pool.active) {
        if (u === v || Math.abs(u.x - v.x) > 0.55) continue;
        const gap = u.d - v.d;
        if (gap > 0 && gap < 14) { v.sp = Math.min(v.sp, u.sp); break; }
      }
      // relative closing speed (traffic sp partially offsets player speed)
      v.d -= (pv - v.sp) * dt * slowMul;
      v.alpha = Math.min(1, (SPAWN_D + 14 - v.d) / 34); // fade in near horizon

      if (v.type === 'changer') {
        v.thinkT -= dt;
        if (v.phase === 'cruise') {
          if (v.thinkT <= 0 && v.d > 12 && v.d < 120) this._changerThink(v, px, dist);
        } else if (v.phase === 'signal') {
          v.blinkT -= dt;
          if (v.blinkT <= 0) {
            // re-check at execution time — abort if it became unsafe
            if (this._laneSafeFor(v, v.targetX, px)) v.phase = 'move';
            else { v.phase = 'cruise'; v.blinkSide = 0; v.thinkT = 1.2 + this.rng(); }
          }
        } else if (v.phase === 'move') {
          v.x += (v.targetX - v.x) * approach(dt, 3.2);
          if (Math.abs(v.x - v.targetX) < 0.03) {
            v.x = v.targetX;
            v.lane = v.targetLane;
            v.phase = 'cruise';
            v.blinkSide = 0;
            v.thinkT = 2 + this.rng() * 2.5;
          }
          // abort mid-move if the player surged into the target lane alongside
          if (v.d < 6 && Math.abs(px - v.targetX) < 0.7) {
            v.targetX = v.lane - 1; // slide back home
          }
        }
      }
    }

    // --- fairness pass: never allow a persistent 3-lane wall ---
    // Speed drift can align one vehicle per lane at the same depth. Nudge the
    // offender so it drops back relative to the others → a gap always opens.
    this._breakWalls(pv);

    // release despawned (reverse walk — Pool.each is already reverse)
    this.pool.each(v => {
      if (v.d < DESPAWN_D) this.pool.release(v);
    });
    this.activeCount = this.pool.count;
  }

  _breakWalls(pv) {
    const act = this.pool.active;
    const n = act.length;
    if (n < 3) return;
    for (let i = 0; i < n; i++) {
      const a = act[i];
      if (a.wallCd > 0 || a.d < 4 || a.d > 160) continue;
      const lo = a.d - 2, hi = a.d + a.len + 2;
      let lanes = 0;
      for (let j = 0; j < n; j++) {
        const u = act[j];
        if (u.d + u.len > lo && u.d < hi) {
          const l = u.x < -0.5 ? 0 : u.x > 0.5 ? 2 : 1;
          lanes |= 1 << l;
        }
      }
      if (lanes === 0b111) {
        a.sp = Math.min(a.sp + 10, Math.max(24, pv * 0.78));
        a.wallCd = 1.5;
      }
    }
  }
}
