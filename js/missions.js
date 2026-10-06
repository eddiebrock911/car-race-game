// ---------------------------------------------------------------------------
// DUSKRUNNER V2 — missions.js
// One-shot missions tracked from persistent stats. Rewards are claimed
// manually from the Missions screen (claim state lives in the save).
// ---------------------------------------------------------------------------

import { addCoins, getSave } from './storage.js';
import { isFullyUpgraded, unlockedCount, UPGRADE_DEFS, getUpgradeLevel } from './garage.js';

export const MISSIONS = [
  {
    id: 'm01', num: '01', title: 'FIRST MILESTONE',
    desc: 'Drive a total of 1,000 m', reward: 100,
    target: 1000, value: s => s.stats.totalDistance
  },
  {
    id: 'm02', num: '02', title: 'BOOST ADDICT',
    desc: 'Activate Nitro 10 times', reward: 150,
    target: 10, value: s => s.stats.nitroUses
  },
  {
    id: 'm03', num: '03', title: 'CLOSE SHAVING',
    desc: 'Perform 5 Near Misses', reward: 200,
    target: 5, value: s => s.stats.nearMisses
  },
  {
    id: 'm04', num: '04', title: 'COIN HUNTER',
    desc: 'Collect 500 coins on the highway', reward: 300,
    target: 500, value: s => s.stats.totalCoins
  },
  {
    id: 'm05', num: '05', title: 'UNTOUCHABLE',
    desc: 'Dodge 100 traffic vehicles', reward: 400,
    target: 100, value: s => s.stats.dodged
  },
  {
    id: 'm06', num: '06', title: 'NIGHT OWL',
    desc: 'Reach the Neon Night environment', reward: 500,
    target: 1, value: s => s.stats.nightReached
  },
  {
    id: 'm07', num: '07', title: 'COMBO ARTIST',
    desc: 'Reach a x5 Near-Miss combo', reward: 450,
    target: 5, value: s => s.stats.bestCombo
  },
  {
    id: 'm08', num: '08', title: 'HIGH SCORER',
    desc: 'Score 10,000 points in a single run', reward: 600,
    target: 10000, value: s => s.stats.bestScore
  },
  {
    id: 'm09', num: '09', title: 'MECHANIC',
    desc: 'Purchase 5 upgrade levels (any cars)', reward: 350,
    target: 5,
    value: s => {
      let n = 0;
      for (const id of s.unlockedCars)
        for (const u of UPGRADE_DEFS) n += getUpgradeLevel(s, id, u.key);
      return n;
    }
  },
  {
    id: 'm10', num: '10', title: 'COLLECTOR',
    desc: 'Unlock 3 cars in the Garage', reward: 700,
    target: 3, value: s => unlockedCount(s)
  }
];

export function isClaimed(save, id) { return save.missions.claimed.includes(id); }

export function missionProgress(save, m) {
  const v = Math.max(0, m.value(save));
  return { value: v, pct: Math.min(1, v / m.target), done: v >= m.target };
}

export function claimMission(id) {
  const save = getSave();
  const m = MISSIONS.find(x => x.id === id);
  if (!m || isClaimed(save, id)) return { ok: false, reason: 'claimed' };
  if (missionProgress(save, m).value < m.target) return { ok: false, reason: 'incomplete' };
  save.missions.claimed.push(id);
  addCoins(m.reward);
  return { ok: true, reward: m.reward };
}

export function missionsCompletedCount(save) { return save.missions.claimed.length; }

export function anyClaimable(save) {
  return MISSIONS.some(m => !isClaimed(save, m.id) && missionProgress(save, m).done);
}
