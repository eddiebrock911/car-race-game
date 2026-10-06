// ---------------------------------------------------------------------------
// DUSKRUNNER V2 — achievements.js
// Auto-unlocking, persistent achievements with coin rewards.
// Call checkAchievements(save) after runs/purchases; it returns the list of
// newly unlocked entries so the caller can show toasts / play sounds.
// ---------------------------------------------------------------------------

import { addCoins } from './storage.js';
import { CARS, isFullyUpgraded } from './garage.js';

export const ACHIEVEMENTS = [
  { id: 'first_drive',  icon: '🏁', name: 'FIRST DRIVE',    desc: 'Complete your first run',            reward: 150, test: s => s.stats.runs >= 1 },
  { id: 'speed_demon',  icon: '🔥', name: 'SPEED DEMON',    desc: 'Reach 280 km/h',                     reward: 300, test: s => s.stats.highestSpeed >= 280 },
  { id: 'nitro_master', icon: '⚡', name: 'NITRO MASTER',   desc: 'Activate Nitro 50 times',            reward: 300, test: s => s.stats.nitroUses >= 50 },
  { id: 'nearmiss_pro', icon: '💨', name: 'NEAR MISS PRO',  desc: 'Reach a x10 Near-Miss combo',        reward: 400, test: s => s.stats.bestCombo >= 10 },
  { id: 'coin_hoarder', icon: '🪙', name: 'COIN COLLECTOR', desc: 'Collect 2,000 highway coins',        reward: 400, test: s => s.stats.totalCoins >= 2000 },
  { id: 'road_eater',   icon: '🛣', name: 'DISTANCE RUNNER', desc: 'Travel 20,000 m in total',          reward: 500, test: s => s.stats.totalDistance >= 20000 },
  { id: 'night_rider',  icon: '🌙', name: 'NIGHT RIDER',    desc: 'Reach the Neon Night environment',   reward: 350, test: s => s.stats.nightReached >= 1 },
  { id: 'champion',     icon: '🏆', name: 'CHAMPION',       desc: 'Score 25,000 in a single run',       reward: 800, test: s => s.stats.bestScore >= 25000 },
  { id: 'garage_king',  icon: '🔑', name: 'GARAGE KING',    desc: 'Unlock 4 cars',                      reward: 500, test: s => s.unlockedCars.length >= 4 },
  { id: 'full_load',    icon: '🔧', name: 'FULLY LOADED',   desc: 'Max every upgrade on any one car',   reward: 1000, test: s => s.unlockedCars.some(id => isFullyUpgraded(s, id)) }
];

export function isUnlocked(save, id) { return save.achievements.includes(id); }

/**
 * Evaluate all achievements; unlock + reward any newly satisfied ones.
 * Mutates save.achievements. Returns newly unlocked achievement objects.
 */
export function checkAchievements(save) {
  const fresh = [];
  for (const a of ACHIEVEMENTS) {
    if (save.achievements.includes(a.id)) continue;
    let ok = false;
    try { ok = !!a.test(save); } catch (e) { ok = false; }
    if (ok) {
      save.achievements.push(a.id);
      addCoins(a.reward);
      fresh.push(a);
    }
  }
  return fresh;
}

export function achievementsUnlockedCount(save) { return save.achievements.length; }
export const ACHIEVEMENT_TOTAL = ACHIEVEMENTS.length;
export const CAR_TOTAL = CARS.length;
