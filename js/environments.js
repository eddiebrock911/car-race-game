// ---------------------------------------------------------------------------
// DUSKRUNNER V2 — environments.js
// Distance-driven environment themes with fully interpolated transitions.
// The blended runtime palette is mutated in place every frame (no GC churn).
//
// Progression (spec §8/§9):
//   0-1km    DAWN CITY      (morning)
//   1-2km    DESERT RUN     (bright day)
//   2-3km    SUNSET HIGHWAY (classic DUSKRUNNER dusk)
//   3-4km    NEON NIGHT     (night, headlights + neon)
//   4km+     MOUNTAIN NIGHT (deep night, stars + moon)
// ---------------------------------------------------------------------------

import { clamp, lerp, lerpRgb, smoothstep, hexToRgb } from './util.js';

const SPAN = 1000;      // meters per theme
const TRANS = 260;      // transition length in meters (centered on boundary)

function theme(o) {
  // convert hex palettes to rgb arrays once at load
  const h = hexToRgb;
  return {
    name: o.name,
    start: o.start,
    sky: o.sky.map(h),                 // 4 gradient stops top→horizon
    sunColor: h(o.sunColor),
    sunGlow: h(o.sunGlow),
    sunY: o.sunY,                      // 0..1 of sky height above horizon
    sunR: o.sunR,                      // radius factor of H
    sunType: o.sunType,                // 'sun' | 'moon' | 'none'
    starAlpha: o.starAlpha,
    ridgeFar: h(o.ridgeFar),
    ridgeNear: h(o.ridgeNear),
    ridgeType: o.ridgeType,            // 'mountain' | 'city' | 'dunes'
    ridgeH: o.ridgeH,                  // max ridge height factor of H
    ground: h(o.ground),
    groundAlt: h(o.groundAlt),         // parallax stripe alternate
    road: h(o.road),
    roadAlt: h(o.roadAlt),
    edge: h(o.edge),                   // road edge stripe color A
    edgeAlt: h(o.edgeAlt),             // edge stripe color B
    laneLine: h(o.laneLine),
    haze: [o.haze[0], o.haze[1], o.haze[2]], // rgb array + alpha below
    hazeA: o.hazeA,
    light: o.light,                    // 1 = day, 0 = deep night (headlights etc.)
    lampGlow: o.lampGlow,              // street lamp intensity
    neon: o.neon || 0,                 // neon signage amount (city themes)
    neonA: h(o.neonA || '#ff3df0'),
    neonB: h(o.neonB || '#3dfff0'),
    ambient: o.ambient || 'none',      // 'none'|'dust'|'embers'|'rain'|'fireflies'
    ambientColor: h(o.ambientColor || '#ffffff'),
    headlights: o.light < 0.45
  };
}

export const THEMES = [
  theme({
    name: 'DAWN CITY', start: 0,
    sky: ['#20346b', '#5b6bb0', '#c98fb8', '#ffd9a8'],
    sunColor: '#fff2c8', sunGlow: '#ffcf9a', sunY: 1.05, sunR: 0.10, sunType: 'sun',
    starAlpha: 0.12,
    ridgeFar: '#3a3f6e', ridgeNear: '#2a2c50', ridgeType: 'city', ridgeH: 0.10,
    ground: '#39465c', groundAlt: '#33405a',
    road: '#3b3f4f', roadAlt: '#353947',
    edge: '#e8556d', edgeAlt: '#eef0f6',
    laneLine: '#ffe9ae',
    haze: '#ffb98a', hazeA: 0.35,
    light: 0.8, lampGlow: 0.35, neon: 0.25,
    ambient: 'none'
  }),
  theme({
    name: 'DESERT RUN', start: SPAN,
    sky: ['#3f7fd4', '#7db4e8', '#cfe4f4', '#ffe9c4'],
    sunColor: '#fffbe8', sunGlow: '#ffe9a8', sunY: 1.75, sunR: 0.08, sunType: 'sun',
    starAlpha: 0,
    ridgeFar: '#c99a63', ridgeNear: '#a97844', ridgeType: 'dunes', ridgeH: 0.07,
    ground: '#b08a55', groundAlt: '#a68049',
    road: '#4a4640', roadAlt: '#433f38',
    edge: '#e8553d', edgeAlt: '#f6f2e8',
    laneLine: '#fff3cf',
    haze: '#ffdca8', hazeA: 0.4,
    light: 1.0, lampGlow: 0.12, neon: 0,
    ambient: 'dust', ambientColor: '#e8c98a'
  }),
  theme({
    name: 'SUNSET HIGHWAY', start: SPAN * 2,
    // Classic DUSKRUNNER identity — preserved from v1 palette
    sky: ['#150b30', '#6a2a6e', '#ff6a5c', '#ffb55c'],
    sunColor: '#ffe27a', sunGlow: '#ff965a', sunY: 0.30, sunR: 0.13, sunType: 'sun',
    starAlpha: 0.45,
    ridgeFar: '#2c1857', ridgeNear: '#1d1040', ridgeType: 'mountain', ridgeH: 0.09,
    ground: '#241a45', groundAlt: '#2b1f52',
    road: '#2a2c3c', roadAlt: '#2f3244',
    edge: '#ff4d5e', edgeAlt: '#f4f4f8',
    laneLine: '#ffecaa',
    haze: '#ff9664', hazeA: 0.5,
    light: 0.42, lampGlow: 0.9, neon: 0.15,
    ambient: 'embers', ambientColor: '#ff9a5c'
  }),
  theme({
    name: 'NEON NIGHT', start: SPAN * 3,
    sky: ['#05020f', '#0d0630', '#1c0f4a', '#3a1460'],
    sunColor: '#b8a8ff', sunGlow: '#6a3df0', sunY: 0.0, sunR: 0.06, sunType: 'none',
    starAlpha: 0.5,
    ridgeFar: '#140c30', ridgeNear: '#0d0820', ridgeType: 'city', ridgeH: 0.13,
    ground: '#0c0a1e', groundAlt: '#110d26',
    road: '#191a28', roadAlt: '#1e1f30',
    edge: '#ff3df0', edgeAlt: '#3dfff0',
    laneLine: '#9be8ff',
    haze: '#7a3df0', hazeA: 0.32,
    light: 0.12, lampGlow: 1.35, neon: 1.0,
    neonA: '#ff3df0', neonB: '#3dfff0',
    ambient: 'rain', ambientColor: '#8ab8ff'
  }),
  theme({
    name: 'MOUNTAIN NIGHT', start: SPAN * 4,
    sky: ['#020208', '#070b22', '#0d1436', '#16204d'],
    sunColor: '#e8eeff', sunGlow: '#9ab4ff', sunY: 1.35, sunR: 0.07, sunType: 'moon',
    starAlpha: 1.0,
    ridgeFar: '#0e1430', ridgeNear: '#080c1e', ridgeType: 'mountain', ridgeH: 0.12,
    ground: '#0a0e20', groundAlt: '#0e1328',
    road: '#151826', roadAlt: '#1a1e2e',
    edge: '#5ce8ff', edgeAlt: '#eef4ff',
    laneLine: '#d8e8ff',
    haze: '#3a5aa8', hazeA: 0.22,
    light: 0.08, lampGlow: 1.1, neon: 0.05,
    ambient: 'fireflies', ambientColor: '#b8ffe8'
  })
];

// --- runtime blended palette (pre-allocated, mutated) -------------------------

function makePalette() {
  const t = THEMES[0];
  const cloneArr = a => a.map(c => c.slice());
  return {
    themeIdx: 0,
    nextIdx: 0,
    t: 0,            // 0 = fully current theme, →1 = next theme
    name: t.name,
    sky: cloneArr(t.sky),
    sunColor: t.sunColor.slice(),
    sunGlow: t.sunGlow.slice(),
    sunY: t.sunY, sunR: t.sunR,
    starAlpha: t.starAlpha,
    ridgeFar: t.ridgeFar.slice(), ridgeNear: t.ridgeNear.slice(),
    ridgeH: t.ridgeH,
    ground: t.ground.slice(), groundAlt: t.groundAlt.slice(),
    road: t.road.slice(), roadAlt: t.roadAlt.slice(),
    edge: t.edge.slice(), edgeAlt: t.edgeAlt.slice(),
    laneLine: t.laneLine.slice(),
    haze: t.haze.slice(), hazeA: t.hazeA,
    light: t.light,
    lampGlow: t.lampGlow,
    neon: t.neon,
    neonA: t.neonA.slice(), neonB: t.neonB.slice(),
    headlights: t.headlights,
    ambient: t.ambient,
    ambientColor: t.ambientColor.slice(),
    // crossfade alphas for scenery/sun that can't be color-lerped
    fadeCur: 1, fadeNext: 0
  };
}

export const palette = makePalette();

const NUM_KEYS = ['sunY', 'sunR', 'starAlpha', 'ridgeH', 'hazeA', 'light', 'lampGlow', 'neon'];
const RGB_KEYS = ['sunColor', 'sunGlow', 'ridgeFar', 'ridgeNear', 'ground', 'groundAlt', 'road', 'roadAlt', 'edge', 'edgeAlt', 'laneLine', 'haze', 'neonA', 'neonB', 'ambientColor'];

/**
 * Recompute the blended palette for a distance (meters).
 * Mutates `palette` in place. Allocation-free.
 *
 * Transition windows are centered on each theme boundary [b-TRANS, b+TRANS].
 * Before the boundary we blend cur→next; after it we keep blending from the
 * previous theme until the window closes (so t never snaps back to 0).
 */
export function updateEnvironment(dist) {
  let idx = 0;
  for (let i = THEMES.length - 1; i >= 0; i--) {
    if (dist >= THEMES[i].start) { idx = i; break; }
  }

  let curIdx = idx;
  let nextIdx = idx;
  let t = 0;

  // approaching the next boundary?
  if (idx < THEMES.length - 1) {
    const b = THEMES[idx + 1].start;
    if (dist > b - TRANS) {
      t = smoothstep(clamp((dist - (b - TRANS)) / (TRANS * 2), 0, 1));
      nextIdx = idx + 1;
    }
  }
  // just crossed a boundary? → keep blending from the previous theme
  if (t < 1 && idx > 0) {
    const bPrev = THEMES[idx].start;
    if (dist < bPrev + TRANS) {
      const t2 = smoothstep(clamp((dist - (bPrev - TRANS)) / (TRANS * 2), 0, 1));
      if (t2 < 1) { curIdx = idx - 1; nextIdx = idx; t = t2; }
    }
  }

  const cur = THEMES[curIdx];
  const next = THEMES[nextIdx];

  palette.themeIdx = curIdx;
  palette.nextIdx = nextIdx;
  palette.t = t;
  palette.name = t < 0.5 ? cur.name : next.name;
  palette.fadeCur = 1;
  palette.fadeNext = t;
  palette.ambient = t < 0.5 ? cur.ambient : next.ambient;

  for (const k of NUM_KEYS) palette[k] = lerp(cur[k], next[k], t);
  for (const k of RGB_KEYS) lerpRgb(palette[k], cur[k], next[k], t);
  for (let i = 0; i < 4; i++) lerpRgb(palette.sky[i], cur.sky[i], next.sky[i], t);

  palette.headlights = palette.light < 0.45;
  return palette;
}

/** Theme index a given distance falls in (for stats: night reached, etc.). */
export function themeIndexAt(dist) {
  let idx = 0;
  for (let i = THEMES.length - 1; i >= 0; i--) if (dist >= THEMES[i].start) { idx = i; break; }
  return idx;
}

export const NIGHT_THEME_IDX = 3; // Neon Night
