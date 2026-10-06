// ---------------------------------------------------------------------------
// DUSKRUNNER V2 — daily.js
// Deterministic daily challenge. Every player gets the SAME configuration on
// the SAME calendar date, derived from an FNV-1a hash of the date string.
// No login required; results are stored locally in the save file.
// ---------------------------------------------------------------------------

import { hashString, mulberry32, todayKey } from './util.js';
import { getSave, persist } from './storage.js';

/**
 * Build the daily config for a date key (YYYY-MM-DD).
 * Pure & deterministic — identical for all clients.
 */
export function getDailyConfig(dateKey = todayKey()) {
  const seed = hashString('duskrunner-daily-' + dateKey);
  const rng = mulberry32(seed);

  const distTarget = 1500 + Math.floor(rng() * 4) * 500;     // 1500..3000 m
  const nearMissTarget = 5 + Math.floor(rng() * 11);          // 5..15
  const coinTarget = 20 + Math.floor(rng() * 5) * 10;         // 20..60 road coins
  const reward = 200 + Math.round(distTarget / 10) + nearMissTarget * 10 + coinTarget * 2;
  const trafficSeed = Math.floor(rng() * 0xffffffff);         // shared run seed
  const styleIdx = Math.floor(rng() * 3);                     // cosmetic variety label
  const styles = ['SUNRISE SPRINT', 'MIDNIGHT HAUL', 'CANYON DASH'];

  return {
    dateKey,
    seed,
    trafficSeed,
    title: styles[styleIdx],
    distTarget,
    nearMissTarget,
    coinTarget,
    reward,
    objectiveText: `Drive ${distTarget.toLocaleString('en-US')} m, achieve ${nearMissTarget} Near Misses and collect ${coinTarget} coins.`
  };
}

/**
 * Seeded RNG the game must use for ALL run randomness in daily mode so that
 * every player faces the same traffic & pickup stream.
 */
export function makeDailyRng(config) {
  return mulberry32(config.trafficSeed >>> 0);
}

export function getTodayChallenge() { return getDailyConfig(todayKey()); }

/** Local daily-result bookkeeping. */
export function getDailyStatus() {
  const save = getSave();
  const key = todayKey();
  return {
    playedToday: save.daily.lastPlayed === key,
    attemptsToday: save.daily.lastPlayed === key ? save.daily.attempts : 0,
    completedToday: save.daily.completedDates.includes(key),
    bestScore: save.daily.bestDate === key ? save.daily.bestScore : 0,
    bestDate: save.daily.bestDate
  };
}

/**
 * Record the outcome of a daily run.
 * @returns {{firstCompletion:boolean, newBest:boolean, reward:number}}
 */
export function recordDailyResult(config, result) {
  const save = getSave();
  const key = config.dateKey;

  if (save.daily.lastPlayed !== key) { save.daily.lastPlayed = key; save.daily.attempts = 0; }
  save.daily.attempts += 1;

  const newBest = result.score > (save.daily.bestDate === key ? save.daily.bestScore : -1);
  if (newBest) { save.daily.bestDate = key; save.daily.bestScore = result.score; }

  const completed = result.objectiveComplete;
  let firstCompletion = false;
  if (completed && !save.daily.completedDates.includes(key)) {
    save.daily.completedDates.push(key);
    if (save.daily.completedDates.length > 40) save.daily.completedDates.shift();
    firstCompletion = true;
  }
  persist();
  return { firstCompletion, newBest, reward: firstCompletion ? config.reward : 0 };
}
