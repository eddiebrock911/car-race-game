// ---------------------------------------------------------------------------
// DUSKRUNNER V2 — game.js
// Orchestrator & main loop. State machine (menu attract → play → crash/finish
// → over, with pause overlay), game modes (ENDLESS / TIME ATTACK 60-90 /
// DETERMINISTIC DAILY), advanced scoring, near-miss combos, high-speed
// streaks, shield saves, economy payouts, stats/mission/achievement
// bookkeeping, quality control and the delta-time rAF loop.
// ---------------------------------------------------------------------------

import { clamp, formatNum, isTouchDevice, todayKey } from './util.js';
import { getSave, loadSave, addCoins, persist } from './storage.js';
import { getCar, physicsForCar, effectiveStats } from './garage.js';
import { AudioSys } from './audio.js';
import { R } from './render.js';
import { palette, updateEnvironment, themeIndexAt, NIGHT_THEME_IDX } from './environments.js';
import { Effects as Fx } from './powerups.js';
import { TrafficManager } from './traffic.js';
import { CoinManager, COIN_VALUE, COIN_SCORE } from './coins.js';
import { PowerupManager, POWERUP_INFO } from './powerups.js';
import { NitroSystem } from './nitro.js';
import { Player, PLAYER_HIT_BACK } from './player.js';
import { Effects } from './effects.js';
import { Input } from './controls.js';
import { UI } from './ui.js';
import { submitScore, MODE_LABELS } from './leaderboard.js';
import { getTodayChallenge, makeDailyRng, recordDailyResult } from './daily.js';
import { checkAchievements } from './achievements.js';

// --- singleton systems -------------------------------------------------------

const traffic = new TrafficManager();
const coins = new CoinManager();
const powerups = new PowerupManager();
const nitro = new NitroSystem();
const player = new Player();
const fx = new Effects();

// --- run / game state ----------------------------------------------------------

const G = {
  state: 'menu',        // menu | play | crash | finish | over
  paused: false,
  tNow: 0,
  dist: 0,              // run distance (also attract scroll in menu)
  driven: 0,            // per-frame driven delta (meters)

  // mode
  mode: 'endless',      // endless | time | daily
  timeLimit: 0,         // seconds (time attack)
  timeLeft: 0,
  dailyCfg: null,
  rng: Math.random,

  // scoring buckets
  sDist: 0, sSpeed: 0, sNear: 0, sCoin: 0, sBonus: 0,

  // run stats
  collectedRun: 0,      // road coins picked up (count)
  coinsEarnedRun: 0,    // total coins granted this run (incl. bonuses)
  nearMissRun: 0,
  dodgedRun: 0,
  combo: 0,
  comboT: 0,
  bestComboRun: 0,
  topSpeedRun: 0,
  nightReached: false,
  hsTime: 0,            // high-speed streak seconds
  hsNext: 3,            // next streak payout threshold
  crashT: 0,
  finishT: 0,
  lastBeep: 99,
  lastMilestone: 0,

  // quality / fps watchdog
  qualityMode: 'auto',
  resolvedQuality: 'high',
  fpsAccum: 0, fpsFrames: 0, fpsTimer: 0, downgraded: false,

  // preallocated scene object (zero per-frame garbage)
  scene: {
    state: 'menu', tNow: 0, dist: 0, v: 0, boost: 0, zoom: 1,
    slowBlend: 0, motionOn: true, showPlayer: true, crashT: 0,
    player: { x: 0, tilt: 0, car: null, shield: false, shieldT: 0, invulnT: 0 },
    traffic: traffic.pool.active,
    coins: coins.pool.active,
    pickups: powerups.pool.active,
    fx
  },
  hudAccum: 0,
  _proj: { x: 0, y: 0, s: 1 }
};

// --- quality -------------------------------------------------------------------

function detectQuality() {
  const s = getSave().settings;
  if (s.quality !== 'auto') return s.quality;
  const cores = navigator.hardwareConcurrency || 4;
  if (isTouchDevice() && cores <= 4) return 'medium';
  if (isTouchDevice()) return 'medium';
  return cores >= 4 ? 'high' : 'medium';
}

function applySettings() {
  const s = getSave().settings;
  G.qualityMode = s.quality;
  G.resolvedQuality = detectQuality();
  R.setQuality(G.resolvedQuality);
  fx.setQuality(G.resolvedQuality, { particles: s.particles, shake: s.shake, motion: s.motion });
  Input.setTouchMode(s.touchControls);
  AudioSys.setSettings({ sfx: s.sfx, music: s.music, volume: s.volume });
}

// --- run lifecycle ---------------------------------------------------------------

function configurePlayerFromSave() {
  const save = getSave();
  const car = getCar(save.selectedCar);
  const stats = effectiveStats(save, car.id);
  const phys = physicsForCar(save, car.id);
  player.configure(phys);
  nitro.configure(phys);
  G.scene.player.car = car;
}

function startRun(mode, opts = {}) {
  configurePlayerFromSave();
  const save = getSave();

  G.mode = mode;
  G.rng = Math.random;
  G.dailyCfg = null;
  G.timeLimit = 0;

  if (mode === 'time') {
    G.timeLimit = opts.seconds === 90 ? 90 : 60;
    G.timeLeft = G.timeLimit;
    G.lastBeep = 99;
  } else if (mode === 'daily') {
    G.dailyCfg = getTodayChallenge();
    G.rng = makeDailyRng(G.dailyCfg);
  }

  G.dist = 0; G.driven = 0;
  G.sDist = 0; G.sSpeed = 0; G.sNear = 0; G.sCoin = 0; G.sBonus = 0;
  G.collectedRun = 0; G.coinsEarnedRun = 0; G.nearMissRun = 0; G.dodgedRun = 0;
  G.combo = 0; G.comboT = 0; G.bestComboRun = 0; G.topSpeedRun = 0;
  G.nightReached = false;
  G.hsTime = 0; G.hsNext = 3;
  G.crashT = 0; G.finishT = 0; G.lastMilestone = 0;

  player.reset(30);
  nitro.reset();
  traffic.reset(G.rng);
  coins.reset(G.rng);
  powerups.reset(G.rng);
  Fx.reset();
  fx.reset();
  updateEnvironment(0);

  G.state = 'play';
  G.paused = false;
  Input.inGame = true;
  Input.resetHeld();
  UI.hideAll();
  UI.setHudVisible(true);
  AudioSys.unlock();
  AudioSys.sfx('start');

  const cx = R.CX, cy = R.BOT - R.LW * 1.4;
  fx.popText(cx, cy, 'GO!', '#ffd35c', Math.round(R.LW * 0.55), { max: 0.8, vy: -30 });
  if (mode === 'daily' && G.dailyCfg) {
    fx.popText(cx, R.HOR + R.H * 0.08, G.dailyCfg.title, '#3dffc0', 26, { max: 1.6, vy: -14 });
  }
  if (mode === 'time') {
    fx.popText(cx, R.HOR + R.H * 0.08, `${G.timeLimit}s TIME ATTACK`, '#ff8a5c', 26, { max: 1.6, vy: -14 });
  }
}

function modeKey() {
  if (G.mode === 'time') return G.timeLimit === 90 ? 'time90' : 'time60';
  if (G.mode === 'daily') return 'daily';
  return 'endless';
}

async function endRun(reason) {
  if (G.state === 'over') return;
  G.state = 'over';
  Input.inGame = false;
  Input.resetHeld();
  AudioSys.silenceEngine();

  const save = getSave();
  const dist = Math.floor(G.dist);
  const score = totalScore();
  const topSpeed = G.topSpeedRun;

  // --- persistent stats ---
  const st = save.stats;
  st.runs += 1;
  if (reason === 'crash') st.crashes += 1;
  st.totalDistance += dist;
  st.totalCoins += G.collectedRun * COIN_VALUE;
  st.nearMisses += G.nearMissRun;
  st.dodged += G.dodgedRun;
  st.nitroUses += nitro.useCount;
  st.bestCombo = Math.max(st.bestCombo, G.bestComboRun);
  st.highestSpeed = Math.max(st.highestSpeed, topSpeed);
  st.bestScore = Math.max(st.bestScore, score);
  st.bestDistance = Math.max(st.bestDistance, dist);
  if (G.nightReached) st.nightReached += 1;

  // --- payout: distance + near misses (road coins already granted live) ---
  let payout = Math.floor(dist / 150) + G.nearMissRun;
  let dailyResult = null;

  if (G.mode === 'daily' && G.dailyCfg) {
    const cfg = G.dailyCfg;
    const objectiveComplete =
      dist >= cfg.distTarget &&
      G.nearMissRun >= cfg.nearMissTarget &&
      G.collectedRun >= cfg.coinTarget;
    const res = recordDailyResult(cfg, { score, objectiveComplete });
    if (res.firstCompletion) payout += res.reward;
    dailyResult = objectiveComplete
      ? `✓ DAILY OBJECTIVE COMPLETE ${res.firstCompletion ? `· +${formatNum(res.reward)} COINS` : '(reward already claimed today)'}`
      : `✗ DAILY OBJECTIVE MISSED${res.newBest ? ' · NEW DAILY BEST' : ''}`;
  }

  payout = Math.max(0, payout);
  if (payout > 0) addCoins(payout);
  G.coinsEarnedRun += payout;

  // --- leaderboard + high score ---
  const entry = {
    score, dist,
    coins: G.coinsEarnedRun,
    nearMisses: G.nearMissRun,
    combo: G.bestComboRun,
    topSpeed: Math.round(topSpeed),
    car: save.selectedCar,
    date: todayKey()
  };
  const lb = await submitScore(modeKey(), entry);
  const newBest = lb.isBest && score > 0;

  // --- achievements ---
  const fresh = checkAchievements(save);
  persist();

  // --- game over UI ---
  UI.setHudVisible(false);
  UI.showGameOver({
    title: reason === 'crash' ? 'CRASHED' : reason === 'time' ? 'TIME UP' : 'RUN COMPLETE',
    titleColor: reason === 'crash' ? '#ff5c6e' : '#ffd35c',
    newBest,
    score,
    best: Math.max(score, save.highScores[modeKey()] ? save.highScores[modeKey()].score : 0),
    modeLabel: MODE_LABELS[modeKey()],
    dist,
    coinsEarned: G.coinsEarnedRun,
    nearMisses: G.nearMissRun,
    bestCombo: G.bestComboRun,
    topSpeed,
    nitroUses: nitro.useCount,
    breakdown: [
      ['DISTANCE', Math.floor(G.sDist)],
      ['SPEED BONUS', Math.floor(G.sSpeed)],
      ['NEAR MISS × COMBO', Math.floor(G.sNear)],
      ['COINS', Math.floor(G.sCoin)],
      ['HIGH-SPEED / CHALLENGE', Math.floor(G.sBonus)]
    ],
    dailyResult
  });
  UI.updateCoinChips();

  // achievement toasts (after panel so they stack above it)
  for (const a of fresh) {
    UI.showToast(a.icon, 'ACHIEVEMENT UNLOCKED', `${a.name} — +${formatNum(a.reward)} coins`, '#ffd35c');
  }
  if (fresh.length) AudioSys.sfx('achieve');
  if (newBest) AudioSys.sfx('mission');
}

function totalScore() {
  return Math.max(0, Math.floor(G.sDist + G.sSpeed + G.sNear + G.sCoin + G.sBonus));
}

function pauseGame(force) {
  if (G.state !== 'play' && G.state !== 'crash' && G.state !== 'finish') return;
  if (G.paused && !force) return;
  G.paused = true;
  Input.resetHeld();
  AudioSys.silenceEngine();
  UI.showPause();
}

function resumeGame() {
  if (!G.paused) return;
  G.paused = false;
  UI.hidePause();
  AudioSys.unlock();
}

function goHome() {
  G.paused = false;
  G.state = 'menu';
  Input.inGame = false;
  Input.resetHeld();
  AudioSys.silenceEngine();
  Fx.reset();
  UI.hidePause();
  UI.setHudVisible(false);
  UI.show('menu');
}

// --- near miss / collision ---------------------------------------------------------

function handleNearMiss(v) {
  const pts = 100 * Math.max(1, G.combo);
  G.combo += 1;
  G.comboT = 2.6;
  G.bestComboRun = Math.max(G.bestComboRun, G.combo);
  G.nearMissRun += 1;
  G.sNear += pts;
  nitro.add(6); // near misses trickle-charge the tank

  const p = R.project(Math.max(v.d, 0.4), v.x, G._proj);
  fx.popText(p.x, p.y - R.LW * 0.5 * p.s, `NEAR MISS +${pts}`, '#ffd35c', Math.max(16, Math.round(22 * clamp(p.s * 1.6, 0.7, 1.4))), { max: 0.9 });
  if (G.combo > 1) {
    fx.popText(p.x, p.y - R.LW * 0.5 * p.s + 24, `COMBO x${G.combo}`, '#3dffc0', 17, { max: 0.9, vy: -46 });
  }
  fx.burst(p.x, p.y, 6, { colors: ['#ffd35c', '#fff'], speed: 120, life: 0.35, r: 2, grav: 200, glow: true });
  AudioSys.sfx('nearmiss');
}

function handleCrash(v) {
  G.state = 'crash';
  G.crashT = 0;
  fx.crashBurst(R.CX + player.x * R.LW, R.BOT - R.LW * 0.2);
  fx.addShake(1.1);
  fx.addFlash('255,60,70', 1);
  AudioSys.sfx('crash');
  AudioSys.silenceEngine();
  if (v) { v.nm = true; v.passed = true; }
}

function handleShieldSave(v) {
  Fx.consumeShield();
  player.v *= 0.55;                       // speed penalty but keep driving
  fx.shieldShatter(R.CX + player.x * R.LW, R.BOT - R.LW * 0.35);
  fx.addShake(0.75);
  fx.addFlash('140,220,255', 0.9);
  fx.popText(R.CX + player.x * R.LW, R.BOT - R.LW * 1.2, 'SHIELD SAVED YOU!', '#9be8ff', 26, { max: 1.2 });
  AudioSys.sfx('shield');
  if (v) { v.nm = true; v.passed = true; }
}

// --- update ------------------------------------------------------------------------

function update(dt) {
  G.tNow += dt;
  const save = getSave();
  const settings = save.settings;

  updateEnvironment(G.dist);
  if (themeIndexAt(G.dist) >= NIGHT_THEME_IDX) G.nightReached = true;

  // ---- attract / menu ----
  if (G.state === 'menu') {
    G.driven = 30 * dt;
    G.dist += G.driven;
    player.v = 30;
    player.x += (0 - player.x) * Math.min(1, dt * 4);
    player.tilt *= 0.9;
    traffic.spawnSince += G.driven;
    const gap = Math.max(30, 90 - G.dist / 2000) * 1.6; // sparse showcase traffic
    if (traffic.spawnSince > gap) {
      if (traffic.trySpawn(G.dist, null)) traffic.spawnSince = 0;
    }
    traffic.update(dt, { v: 30, dist: G.dist, px: 0, slowBlend: 0 });
    fx.update(dt, { v: 30 });
    AudioSys.updateEngine(0, false, false);
    return;
  }

  // ---- crash / finish sequences ----
  if (G.state === 'crash') {
    player.v *= Math.max(0, 1 - dt * 2.4);
    G.driven = player.v * dt;
    G.dist += G.driven;
    G.crashT += dt;
    traffic.update(dt, { v: player.v, dist: G.dist, px: player.x, slowBlend: Fx.slowBlend });
    fx.update(dt, { v: player.v });
    Fx.update(dt);
    if (G.crashT > 1.1) endRun('crash');
    return;
  }
  if (G.state === 'finish') {
    player.v *= Math.max(0, 1 - dt * 1.8);
    G.driven = player.v * dt;
    G.dist += G.driven;
    G.finishT += dt;
    traffic.update(dt, { v: player.v, dist: G.dist, px: player.x, slowBlend: Fx.slowBlend });
    fx.update(dt, { v: player.v });
    if (G.finishT > 0.9) endRun('time');
    return;
  }
  if (G.state !== 'play') return;

  // ---- playing ----
  const pPhys = player.physics;

  // nitro (press returns true on ignition frame)
  if (nitro.press(Input.nitro)) {
    AudioSys.sfx('nitro');
    fx.popText(R.CX + player.x * R.LW, R.BOT - R.LW * 1.3, 'NITRO!', '#7df9ff', 24, { max: 0.7 });
  }
  nitro.update(dt);

  player.update(dt, { throttle: Input.throttle, brake: Input.brake }, G.dist, nitro.boost);

  const kmh = player.kmh;
  if (kmh > G.topSpeedRun) G.topSpeedRun = kmh;

  G.driven = player.v * dt;
  G.dist += G.driven;

  // time attack countdown
  if (G.mode === 'time') {
    G.timeLeft -= dt;
    const sec = Math.ceil(G.timeLeft);
    if (sec <= 5 && sec >= 1 && sec !== G.lastBeep) { G.lastBeep = sec; AudioSys.sfx('beep'); }
    if (G.timeLeft <= 0) {
      G.timeLeft = 0;
      G.state = 'finish';
      G.finishT = 0;
      AudioSys.sfx('timeup');
      AudioSys.silenceEngine();
      fx.popText(R.CX, R.H * 0.42, 'TIME UP', '#ff8a5c', Math.round(R.LW * 0.6), { max: 1.1, vy: -18 });
      return;
    }
  }

  // difficulty-scaled spawn cadence (v1 curve, deeper floor over distance)
  traffic.spawnSince += G.driven;
  const gap = Math.max(9, 34 - G.dist / 1100) * (0.8 + G.rng() * 0.7);
  if (traffic.spawnSince > gap) {
    if (traffic.trySpawn(G.dist, (lx, d0, d1) => coins.occupies(lx, d0, d1) || powerups.occupies(lx, d0, d1))) {
      traffic.spawnSince = 0;
    } else {
      traffic.spawnSince = gap * 0.5; // retry soon
    }
  }
  traffic.update(dt, { v: player.v, dist: G.dist, px: player.x, slowBlend: Fx.slowBlend });

  // coin waves & powerups
  coins.sinceWave += G.driven;
  if (coins.sinceWave >= coins.nextWaveAt) coins.trySpawnWave(traffic, player.v);
  const gotCoins = coins.update(dt, { v: player.v, px: player.x, magnet: Fx.magnet, driven: 0 });
  if (gotCoins > 0) {
    for (let i = 0; i < gotCoins; i++) {
      G.collectedRun += 1;
      G.sCoin += COIN_SCORE;
      addCoins(COIN_VALUE);
      AudioSys.sfx('coin');
      fx.popText(R.CX + player.x * R.LW + (Math.random() - 0.5) * 40, R.BOT - R.LW * 0.9, `+${COIN_VALUE}🪙`, '#ffd35c', 20, { max: 0.7 });
    }
    fx.coinBurst(R.CX + player.x * R.LW, R.BOT - R.LW * 0.3);
    UI.updateCoinChips();
  }

  powerups.sinceSpawn += G.driven;
  if (powerups.sinceSpawn >= powerups.nextAt) {
    if (powerups.trySpawn(traffic, player.v)) {
      powerups.sinceSpawn = 0;
      powerups.nextAt = 420 + G.rng() * 380;
    } else {
      powerups.sinceSpawn = powerups.nextAt * 0.85;
    }
  }
  const gotPu = powerups.update(dt, { v: player.v, px: player.x });
  if (gotPu) {
    const info = POWERUP_INFO[gotPu];
    const ev = Fx.apply(gotPu);
    save.stats.powerupsUsed += 1;
    if (ev === 'nitro') {
      nitro.refill(0.45);
      AudioSys.sfx('nitro');
    } else {
      AudioSys.sfx('powerup');
    }
    fx.popText(R.CX + player.x * R.LW, R.BOT - R.LW * 1.5, `${info.icon} ${info.label}!`, info.color, 28, { max: 1.1 });
    fx.burst(R.CX + player.x * R.LW, R.BOT - R.LW * 0.5, 18, { colors: [info.color, '#ffffff'], speed: 240, life: 0.6, r: 3, glow: true, grav: 300 });
  }

  Fx.update(dt);

  // combo decay
  if (G.comboT > 0) {
    G.comboT -= dt;
    if (G.comboT <= 0) G.combo = 0;
  }

  // --- collisions, near misses, dodges (single pass over traffic) ---
  let crashed = false;
  for (const v of traffic.pool.active) {
    const dx = Math.abs(v.x - player.x);
    if (!v.passed && v.d < PLAYER_HIT_BACK) {
      v.passed = true;
      G.dodgedRun += 1;
    }
    if (!v.nm && v.d < 0.6 && v.d > PLAYER_HIT_BACK && dx >= v.hitW && dx < v.nearW && Fx.invulnT <= 0) {
      v.nm = true;
      handleNearMiss(v);
    }
    if (dx < v.hitW && v.d < v.len && v.d > v.back) {
      if (Fx.invulnT > 0) continue;                 // phase-through after shield save
      if (Fx.shield) { handleShieldSave(v); continue; }
      crashed = true;
      handleCrash(v);
      break;
    }
  }
  if (crashed) return;

  // --- scoring accrual ---
  G.sDist = G.dist * 0.5;
  // speed bonus: quadratic in velocity → faster is meaningfully better
  G.sSpeed += (player.v * player.v) / 230 * dt;
  // high-speed streak (km/h ≥ 210)
  if (kmh >= 210) {
    G.hsTime += dt;
    if (G.hsTime >= G.hsNext) {
      const level = clamp(Math.floor(G.hsTime / 3), 1, 5);
      const bonus = 250 * level;
      G.sBonus += bonus;
      G.hsNext += 3;
      fx.popText(R.CX, R.H * 0.3, `HIGH SPEED +${bonus}`, '#ff5cd0', 30, { max: 1.0, vy: -36 });
      AudioSys.sfx('beep');
    }
  } else {
    G.hsTime = 0;
    G.hsNext = 3;
  }

  // distance milestones
  const milestone = Math.floor(G.dist / 1000);
  if (milestone > G.lastMilestone) {
    G.lastMilestone = milestone;
    fx.popText(R.CX, R.H * 0.34, `${milestone} KM`, '#9be8ff', 26, { max: 1.0 });
  }

  // nitro trail particles
  if (nitro.boost > 0.1 && settings.particles) {
    fx.nitroFlame(R.CX + player.x * R.LW, R.BOT - 4, nitro.boost);
  }
  // tire smoke on hard lateral moves at speed
  if (Math.abs(player.tilt) > 0.1 && player.v > 70 && settings.particles && G.rng() < 0.4) {
    fx.burst(R.CX + player.x * R.LW - Math.sign(player.tilt) * R.LW * 0.3, R.BOT, 1,
      { color: 'rgba(200,200,220,0.7)', speed: 40, life: 0.5, r: 4, smoke: true, grav: -30 });
  }

  fx.update(dt, { v: player.v });
  AudioSys.updateEngine(player.v, nitro.active && nitro.boost > 0.3, true);

  // --- fps watchdog (auto quality only, one-way downgrade) ---
  if (G.qualityMode === 'auto' && !G.downgraded) {
    G.fpsAccum += dt; G.fpsFrames++;
    if (G.fpsAccum >= 3) {
      const fps = G.fpsFrames / G.fpsAccum;
      G.fpsAccum = 0; G.fpsFrames = 0;
      if (fps < 38 && G.resolvedQuality !== 'low') {
        G.downgraded = true;
        G.resolvedQuality = G.resolvedQuality === 'high' ? 'medium' : 'low';
        R.setQuality(G.resolvedQuality);
        fx.setQuality(G.resolvedQuality, { particles: settings.particles, shake: settings.shake, motion: settings.motion });
      }
    }
  }

  updateHud(dt);
}

// --- HUD -----------------------------------------------------------------------------

function updateHud(dt) {
  G.hudAccum += dt;
  if (G.hudAccum < 0.1) return;
  G.hudAccum = 0;

  let objective = '';
  if (G.mode === 'daily' && G.dailyCfg) {
    const c = G.dailyCfg;
    objective = `${Math.min(Math.floor(G.dist), c.distTarget)}/${c.distTarget}m · NM ${Math.min(G.nearMissRun, c.nearMissTarget)}/${c.nearMissTarget} · 🪙 ${Math.min(G.collectedRun, c.coinTarget)}/${c.coinTarget}`;
  }

  UI.updateHud({
    score: formatNum(totalScore()),
    dist: Math.floor(G.dist) + 'm',
    speed: player.kmh,
    coins: formatNum(getSave().coins),
    nitroPct: nitro.pct,
    nitroActive: nitro.boost > 0.3,
    timer: G.mode === 'time' ? G.timeLeft.toFixed(1) : null,
    env: palette.name,
    objective,
    combo: G.combo,
    powerups: Fx.hudList()
  });
}

// --- draw ------------------------------------------------------------------------------

function draw() {
  const sc = G.scene;
  sc.state = G.state;
  sc.tNow = G.tNow;
  sc.dist = G.dist;
  sc.v = player.v;
  sc.boost = nitro.boost;
  const motionOn = getSave().settings.motion;
  sc.motionOn = motionOn;
  sc.zoom = motionOn ? 1 + 0.05 * nitro.boost + 0.012 * clamp((player.v - 90) / 40, 0, 1) : 1;
  sc.slowBlend = Fx.slowBlend;
  sc.showPlayer = true;
  sc.crashT = G.crashT;
  sc.player.x = player.x;
  sc.player.tilt = player.tilt;
  sc.player.shield = Fx.shield;
  sc.player.shieldT = Fx.shieldT;
  sc.player.invulnT = Fx.invulnT;
  sc.traffic = traffic.pool.active;
  sc.coins = coins.pool.active;
  sc.pickups = powerups.pool.active;
  R.drawFrame(sc);
}

// --- main loop ---------------------------------------------------------------------------

let last = performance.now();
let loopErrors = 0;
function frame(t) {
  const dt = Math.min(0.05, (t - last) / 1000);
  last = t;
  // Safety net: an unexpected exception must never kill the rAF loop
  // (the game would freeze). Log the first few, then keep running silently.
  try {
    if (!G.paused) update(dt);
    draw();
  } catch (err) {
    if (loopErrors < 5) { loopErrors++; console.error('[duskrunner] loop error:', err); }
  }
  requestAnimationFrame(frame);
}

// --- boot ----------------------------------------------------------------------------------

function boot() {
  loadSave();
  const canvas = document.getElementById('c');
  R.init(canvas);
  configurePlayerFromSave();
  applySettings();
  AudioSys.init(getSave().settings);

  UI.init({
    play: (mode, opts) => startRun(mode, opts),
    resume: () => resumeGame(),
    restart: () => { UI.hidePause(); G.paused = false; startRun(G.mode, { seconds: G.timeLimit || 60 }); },
    home: () => goHome(),
    retry: () => startRun(G.mode, { seconds: G.timeLimit || 60 }),
    applySettings: () => applySettings()
  });

  Input.init({
    onSteer: (dir) => {
      if (G.state === 'play' && !G.paused) player.steer(dir);
    },
    onPause: (force) => {
      if (force) { if (!G.paused) pauseGame(true); }
      else if (G.paused) resumeGame();
      else pauseGame(false);
    },
    onConfirm: () => {
      if (G.state === 'over') startRun(G.mode, { seconds: G.timeLimit || 60 });
      else if (G.state === 'menu') startRun('endless');
    },
    onFirstGesture: () => {
      AudioSys.unlock();
      const s = getSave().settings;
      if (s.music) AudioSys.startMusic();
    }
  });

  // resize handling (debounced via rAF, single listener)
  let resizeQueued = false;
  const onResize = () => {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => { resizeQueued = false; R.resize(); });
  };
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);

  // menu state setup
  G.state = 'menu';
  UI.show('menu');
  updateEnvironment(0);
  requestAnimationFrame(frame);
}

// expose a tiny debug hook (harmless, helps testing)
window.DUSKRUNNER = {
  get state() { return G.state; },
  get dist() { return G.dist; },
  get score() { return totalScore(); },
  get paused() { return G.paused; },
  get mode() { return G.mode; },
  systems: { traffic, coins, powerups, nitro, player, fx, effects: Fx },
  startRun, endRun, goHome, pauseGame, resumeGame,
  nearMissRun: () => G.nearMissRun,
  combo: () => G.combo
};

// global error guard — never white-screen
window.addEventListener('error', (e) => {
  try { console.error('[duskrunner]', e.message); } catch (err) { /* noop */ }
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
