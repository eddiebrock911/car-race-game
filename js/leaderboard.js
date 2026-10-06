// ---------------------------------------------------------------------------
// DUSKRUNNER V2 — leaderboard.js
// Local top-10 leaderboard per game mode, wrapped in an async, backend-ready
// interface.
//
// FUTURE ONLINE LEADERBOARD (FastAPI) — swap-in plan:
//   * Keep the exported function signatures (they are already Promise-based).
//   * Replace the bodies of `fetchBoard` / `submitScore` with authenticated
//     POST/GET calls, e.g.:
//         POST {API}/scores   {mode, score, dist, token, clientSeed, replay}
//         GET  {API}/scores?mode=endless&limit=10
//   * NEVER trust client scores: the server should require a run token issued
//     at race start plus a signed event summary (inputs/timeline) or a
//     server-side replay simulation before accepting a score. The local
//     board here is display-only and trivially editable — that is expected.
//   * `submitScore` returns {rank, isBest} today; the online version can
//     return the same shape so no UI code needs to change.
// ---------------------------------------------------------------------------

import { getSave, persist } from './storage.js';

export const MODES = ['endless', 'time60', 'time90', 'daily'];
export const MODE_LABELS = {
  endless: 'ENDLESS',
  time60: 'TIME 60s',
  time90: 'TIME 90s',
  daily: 'DAILY'
};

/**
 * Submit a finished run. Updates the per-mode top-10 board AND the
 * per-mode high score. Returns { rank, isBest, entries }.
 * @param {string} mode
 * @param {{score:number,dist:number,coins:number,nearMisses:number,combo:number,topSpeed:number,car:string,date:string}} entry
 */
export async function submitScore(mode, entry) {
  const save = getSave();
  if (!MODES.includes(mode) || !entry || !(entry.score > 0)) {
    return { rank: -1, isBest: false, entries: [] };
  }
  const list = save.leaderboard[mode];
  list.push(entry);
  list.sort((a, b) => b.score - a.score);
  if (list.length > 10) list.length = 10;
  const rank = list.indexOf(entry) + 1;

  const prev = save.highScores[mode];
  const isBest = !prev || entry.score > prev.score;
  if (isBest) save.highScores[mode] = { ...entry };

  persist();
  return { rank, isBest, entries: list.slice() };
}

/** Fetch the top-10 board for a mode (async for backend compatibility). */
export async function fetchBoard(mode) {
  const save = getSave();
  if (!MODES.includes(mode)) return [];
  return save.leaderboard[mode].slice();
}

export function getHighScore(mode) {
  const save = getSave();
  return (MODES.includes(mode) && save.highScores[mode]) || null;
}

/** Local-only board wipe (Settings). */
export function clearBoard(mode) {
  const save = getSave();
  if (MODES.includes(mode)) { save.leaderboard[mode] = []; persist(); }
}
