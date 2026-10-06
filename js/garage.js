// ---------------------------------------------------------------------------
// DUSKRUNNER V2 — garage.js
// Original fictional car roster, balanced stats, upgrade economy, and the
// mapping from stats → concrete gameplay physics. No DOM access.
//
// Balance notes:
//   * Every car wins at least one stat category; none is universally best.
//   * Upgrades add +3 to the underlying stat per level (5 levels max), so a
//     weak car can close part of the gap but never flips the roster order.
// ---------------------------------------------------------------------------

import { clamp } from './util.js';

export const MAX_LEVEL = 5;
export const STAT_PER_LEVEL = 3;
export const UPGRADE_COSTS = [300, 600, 1100, 1800, 2800]; // cost to buy level index+1
export const STAT_BAR_MAX = 120; // display scale for stat bars

// --- car roster (all names/designs are original & fictional) -----------------

export const CARS = [
  {
    id: 'vortex',
    name: 'VORTEX GT',
    tagline: 'The balanced street runner. Forgiving handling, honest speed.',
    price: 0,
    stats: { speed: 70, handling: 90, accel: 75, nitro: 80 },
    look: { shape: 'coupe', body: '#19e3ff', dark: '#0f9db5', accent: '#ffffff', glow: 'rgba(25,227,255,' }
  },
  {
    id: 'bastion',
    name: 'BASTION XR',
    tagline: 'Heavy utility rig with a monstrous nitro tank. Slow but relentless.',
    price: 900,
    stats: { speed: 60, handling: 78, accel: 65, nitro: 95 },
    look: { shape: 'suv', body: '#e8a33d', dark: '#a56d1c', accent: '#2b2b33', glow: 'rgba(232,163,61,' }
  },
  {
    id: 'riptide',
    name: 'RIPTIDE RS',
    tagline: 'Raw muscle. Big top end, wide turns — reward the brave.',
    price: 1800,
    stats: { speed: 88, handling: 70, accel: 85, nitro: 70 },
    look: { shape: 'muscle', body: '#ff4d5e', dark: '#b32135', accent: '#ffd9dc', glow: 'rgba(255,77,94,' }
  },
  {
    id: 'phantom',
    name: 'PHANTOM EV',
    tagline: 'Electric scalpel. Best handling in class, tiny nitro cell.',
    price: 3200,
    stats: { speed: 80, handling: 95, accel: 90, nitro: 58 },
    look: { shape: 'ev', body: '#9a70ff', dark: '#5f3fc4', accent: '#d8ccff', glow: 'rgba(154,112,255,' }
  },
  {
    id: 'comet',
    name: 'COMET S1',
    tagline: 'Qualifying trim. Fastest & sharpest acceleration — twitchy grip.',
    price: 5200,
    stats: { speed: 100, handling: 58, accel: 95, nitro: 88 },
    look: { shape: 'sport', body: '#ffe14d', dark: '#c9a300', accent: '#3a3a44', glow: 'rgba(255,225,77,' }
  },
  {
    id: 'aurora',
    name: 'AURORA ZX',
    tagline: 'Flagship grand tourer. No weak link, no single crown.',
    price: 9000,
    stats: { speed: 90, handling: 86, accel: 88, nitro: 92 },
    look: { shape: 'gt', body: '#3dffc0', dark: '#12a87c', accent: '#ffffff', glow: 'rgba(61,255,192,' }
  }
];

export const CAR_BY_ID = Object.fromEntries(CARS.map(c => [c.id, c]));

export function getCar(id) { return CAR_BY_ID[id] || CARS[0]; }

// --- upgrade definitions ------------------------------------------------------

export const UPGRADE_DEFS = [
  { key: 'engine', stat: 'accel',    name: 'ENGINE', icon: '⚙', desc: 'Acceleration — reach top speed faster' },
  { key: 'tires',  stat: 'handling', name: 'TIRES',  icon: '◎', desc: 'Handling — sharper lane changes' },
  { key: 'turbo',  stat: 'speed',    name: 'TURBO',  icon: '»', desc: 'Top speed — higher velocity ceiling' },
  { key: 'nitro',  stat: 'nitro',    name: 'NITRO',  icon: '⚡', desc: 'Nitro capacity — bigger boost tank' }
];

// --- save-backed queries -------------------------------------------------------

export function isUnlocked(save, carId) { return save.unlockedCars.includes(carId); }

export function getUpgrades(save, carId) {
  if (!save.upgrades[carId]) save.upgrades[carId] = { engine: 0, tires: 0, turbo: 0, nitro: 0 };
  return save.upgrades[carId];
}

export function getUpgradeLevel(save, carId, key) {
  const u = getUpgrades(save, carId);
  return clamp(Math.round(u[key] || 0), 0, MAX_LEVEL);
}

/** Cost to move from current level → next, or -1 when maxed. */
export function upgradeCost(level) {
  return level >= MAX_LEVEL ? -1 : UPGRADE_COSTS[level];
}

/** Effective stat (base + upgrade levels), for display and physics. */
export function effectiveStat(save, carId, statKey) {
  const car = getCar(carId);
  const def = UPGRADE_DEFS.find(u => u.stat === statKey);
  const lvl = def ? getUpgradeLevel(save, carId, def.key) : 0;
  return car.stats[statKey] + lvl * STAT_PER_LEVEL;
}

export function effectiveStats(save, carId) {
  return {
    speed: effectiveStat(save, carId, 'speed'),
    handling: effectiveStat(save, carId, 'handling'),
    accel: effectiveStat(save, carId, 'accel'),
    nitro: effectiveStat(save, carId, 'nitro')
  };
}

// --- stats → physics ------------------------------------------------------------
// World units are the same as the original game (v≈30 start, display km/h = v*2).

export function physicsFor(stats) {
  return {
    vMax: 72 + stats.speed * 0.45,             // cruise ceiling (world u/s)
    vNitroMul: 1.28,                            // ceiling multiplier while boosting
    accelRate: 1.0 + stats.accel * 0.012,       // lerp rate toward target speed
    steerRate: 7.5 + stats.handling * 0.07,     // lateral lerp rate
    nitroCapacity: 50 + stats.nitro * 0.6,      // tank units
    nitroDrain: 30,                             // units/s while boosting
    nitroRegen: 4,                              // passive units/s
    kmh: 2.0                                    // display multiplier
  };
}

/** Convenience: physics for a car as currently configured in the save. */
export function physicsForCar(save, carId) {
  return physicsFor(effectiveStats(save, carId));
}

/** Number of cars unlocked (for achievements). */
export function unlockedCount(save) { return save.unlockedCars.length; }

/** True when every category of one car is at MAX_LEVEL. */
export function isFullyUpgraded(save, carId) {
  return UPGRADE_DEFS.every(u => getUpgradeLevel(save, carId, u.key) >= MAX_LEVEL);
}
