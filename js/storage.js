// ---------------------------------------------------------------------------
// DUSKRUNNER V2 — storage.js
// Centralized, versioned localStorage save system.
//   key: duskrunner_save_v2
// Guarantees:
//   * Never throws (corrupt / missing / blocked storage all handled).
//   * Deep-validates and merges onto defaults so unknown/invalid fields
//     can never crash the game.
//   * Falls back to an in-memory store when localStorage is unavailable.
// ---------------------------------------------------------------------------

import { clamp, todayKey } from './util.js';

const SAVE_KEY = 'duskrunner_save_v2';
const LEGACY_BEST_KEY = 'duskrunner_best';
const SAVE_VERSION = 2;

// In-memory fallback when localStorage is blocked (private mode, file://, etc.)
const memoryStore = {};
let storageOK = true;
try {
  const probe = '__dr_probe__';
  localStorage.setItem(probe, '1');
  localStorage.removeItem(probe);
} catch (e) {
  storageOK = false;
}

function rawGet(key) {
  if (storageOK) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  return Object.prototype.hasOwnProperty.call(memoryStore, key) ? memoryStore[key] : null;
}
function rawSet(key, value) {
  if (storageOK) { try { localStorage.setItem(key, value); return true; } catch (e) { return false; } }
  memoryStore[key] = value;
  return true;
}

export function isPersistent() { return storageOK; }

// --- defaults ---------------------------------------------------------------

function defaultUpgrades() { return { engine: 0, tires: 0, turbo: 0, nitro: 0 }; }

export function defaultSave() {
  return {
    v: SAVE_VERSION,
    coins: 0,
    selectedCar: 'vortex',
    unlockedCars: ['vortex'],
    upgrades: { vortex: defaultUpgrades() },
    settings: {
      sfx: true,
      music: true,
      volume: 0.7,          // master 0..1
      quality: 'auto',      // auto | low | medium | high
      shake: true,
      particles: true,
      motion: true,         // speed lines / motion blur
      touchControls: 'both' // tap | buttons | both
    },
    stats: {
      totalDistance: 0,     // meters
      totalCoins: 0,        // coins collected on road (lifetime)
      coinsEarned: 0,       // all coins ever granted (incl. rewards)
      runs: 0,
      crashes: 0,
      nearMisses: 0,
      bestCombo: 0,
      nitroUses: 0,         // number of nitro activations
      highestSpeed: 0,      // km/h
      dodged: 0,            // traffic vehicles passed
      bestScore: 0,
      bestDistance: 0,
      powerupsUsed: 0,
      nightReached: 0       // times the Neon Night env was reached
    },
    missions: {
      progress: {},         // mission-specific extra counters (e.g. comboBestRun)
      claimed: []           // ids of missions whose reward was claimed
    },
    achievements: [],       // unlocked ids
    highScores: {           // best per mode
      endless: null,        // {score,dist,coins,nearMisses,combo,topSpeed,car,date}
      time60: null,
      time90: null,
      daily: null
    },
    leaderboard: {
      endless: [], time60: [], time90: [], daily: []
    },
    daily: {
      lastPlayed: '',       // todayKey of last daily attempt
      attempts: 0,
      bestDate: '',         // date of stored best daily score
      bestScore: 0,
      completedDates: []    // dates the objective was completed (bounded)
    }
  };
}

// --- validation / merge -----------------------------------------------------

const num = (v, d, min = -Infinity, max = Infinity) =>
  (typeof v === 'number' && isFinite(v)) ? clamp(v, min, max) : d;
const bool = (v, d) => (typeof v === 'boolean' ? v : d);
const str = (v, d) => (typeof v === 'string' ? v : d);
const arr = (v, d) => (Array.isArray(v) ? v : d);

function mergeSettings(s) {
  const d = defaultSave().settings;
  if (!s || typeof s !== 'object') return d;
  return {
    sfx: bool(s.sfx, d.sfx),
    music: bool(s.music, d.music),
    volume: num(s.volume, d.volume, 0, 1),
    quality: ['auto', 'low', 'medium', 'high'].includes(s.quality) ? s.quality : d.quality,
    shake: bool(s.shake, d.shake),
    particles: bool(s.particles, d.particles),
    motion: bool(s.motion, d.motion),
    touchControls: ['tap', 'buttons', 'both'].includes(s.touchControls) ? s.touchControls : d.touchControls
  };
}

function mergeStats(s) {
  const d = defaultSave().stats;
  const out = {};
  for (const k of Object.keys(d)) out[k] = num(s && s[k], d[k], 0, 1e12);
  return out;
}

function mergeUpgrades(u) {
  const d = defaultUpgrades();
  if (!u || typeof u !== 'object') return d;
  return {
    engine: Math.round(num(u.engine, 0, 0, 5)),
    tires: Math.round(num(u.tires, 0, 0, 5)),
    turbo: Math.round(num(u.turbo, 0, 0, 5)),
    nitro: Math.round(num(u.nitro, 0, 0, 5))
  };
}

function mergeScoreEntry(e) {
  if (!e || typeof e !== 'object') return null;
  // a board entry must carry a positive numeric score; anything else is dropped
  if (typeof e.score !== 'number' || !isFinite(e.score) || e.score <= 0) return null;
  return {
    score: num(e.score, 0, 0, 1e9),
    dist: num(e.dist, 0, 0, 1e9),
    coins: num(e.coins, 0, 0, 1e9),
    nearMisses: num(e.nearMisses, 0, 0, 1e6),
    combo: num(e.combo, 0, 0, 1e6),
    topSpeed: num(e.topSpeed, 0, 0, 1e5),
    car: str(e.car, 'vortex'),
    date: str(e.date, todayKey())
  };
}

function mergeEntryList(list) {
  const out = [];
  for (const raw of arr(list, [])) {
    const e = mergeScoreEntry(raw);
    if (e) out.push(e);
    if (out.length >= 50) break; // hard bound
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, 10);
}

// --- load / save --------------------------------------------------------------

let save = null;
let saveTimer = 0;

export function loadSave() {
  const d = defaultSave();
  let parsed = null;
  const raw = rawGet(SAVE_KEY);
  if (raw) {
    try { parsed = JSON.parse(raw); } catch (e) { parsed = null; } // corrupt → defaults
  }
  if (!parsed || typeof parsed !== 'object') parsed = {};

  const s = {
    v: SAVE_VERSION,
    coins: Math.max(0, Math.floor(num(parsed.coins, 0, 0, 1e9))),
    selectedCar: str(parsed.selectedCar, d.selectedCar),
    unlockedCars: Array.from(new Set(arr(parsed.unlockedCars, d.unlockedCars).filter(x => typeof x === 'string'))),
    upgrades: {},
    settings: mergeSettings(parsed.settings),
    stats: mergeStats(parsed.stats),
    missions: {
      progress: (parsed.missions && typeof parsed.missions.progress === 'object' && parsed.missions.progress) || {},
      claimed: arr(parsed.missions && parsed.missions.claimed, []).filter(x => typeof x === 'string')
    },
    achievements: arr(parsed.achievements, []).filter(x => typeof x === 'string'),
    highScores: {
      endless: mergeScoreEntry(parsed.highScores && parsed.highScores.endless),
      time60: mergeScoreEntry(parsed.highScores && parsed.highScores.time60),
      time90: mergeScoreEntry(parsed.highScores && parsed.highScores.time90),
      daily: mergeScoreEntry(parsed.highScores && parsed.highScores.daily)
    },
    leaderboard: {
      endless: mergeEntryList(parsed.leaderboard && parsed.leaderboard.endless),
      time60: mergeEntryList(parsed.leaderboard && parsed.leaderboard.time60),
      time90: mergeEntryList(parsed.leaderboard && parsed.leaderboard.time90),
      daily: mergeEntryList(parsed.leaderboard && parsed.leaderboard.daily)
    },
    daily: {
      lastPlayed: str(parsed.daily && parsed.daily.lastPlayed, ''),
      attempts: num(parsed.daily && parsed.daily.attempts, 0, 0, 1e6),
      bestDate: str(parsed.daily && parsed.daily.bestDate, ''),
      bestScore: num(parsed.daily && parsed.daily.bestScore, 0, 0, 1e9),
      completedDates: arr(parsed.daily && parsed.daily.completedDates, []).filter(x => typeof x === 'string').slice(-40)
    }
  };

  if (!s.unlockedCars.includes(s.selectedCar)) s.unlockedCars.push(s.selectedCar);
  if (!s.unlockedCars.includes('vortex')) s.unlockedCars.push('vortex');
  for (const id of s.unlockedCars) s.upgrades[id] = mergeUpgrades(parsed.upgrades && parsed.upgrades[id]);

  // --- legacy migration: old single-key best distance ----------------------
  const legacy = num(parseInt(rawGet(LEGACY_BEST_KEY), 10) || 0, 0, 0, 1e9);
  if (legacy > 0) {
    s.stats.bestDistance = Math.max(s.stats.bestDistance, legacy);
    if (!s.highScores.endless || s.highScores.endless.dist < legacy) {
      s.highScores.endless = { score: Math.floor(legacy * 0.5), dist: legacy, coins: 0, nearMisses: 0, combo: 0, topSpeed: 0, car: s.selectedCar, date: todayKey() };
    }
  }

  save = s;
  persist(); // re-write normalized data
  return save;
}

export function getSave() {
  if (!save) loadSave();
  return save;
}

/** Immediately write to storage (guarded). */
export function persist() {
  if (!save) return false;
  return rawSet(SAVE_KEY, JSON.stringify(save));
}

/** Throttled write (used after frequent mutations). */
export function persistSoon() {
  if (!saveTimer) {
    saveTimer = setTimeout(() => { saveTimer = 0; persist(); }, 400);
  }
}

// --- coin economy helpers (never allow negatives) ---------------------------

export function addCoins(n) {
  const s = getSave();
  n = Math.max(0, Math.floor(n || 0));
  s.coins = Math.min(1e9, s.coins + n);
  s.stats.coinsEarned += n;
  persistSoon();
  return s.coins;
}

export function canAfford(n) { return getSave().coins >= n; }

export function spendCoins(n) {
  const s = getSave();
  n = Math.max(0, Math.floor(n || 0));
  if (s.coins < n) return false;
  s.coins -= n;
  persistSoon();
  return true;
}

/** Full factory reset of save data (Settings → Reset). */
export function resetSave() {
  save = null;
  if (storageOK) { try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* noop */ } }
  delete memoryStore[SAVE_KEY];
  return loadSave();
}
