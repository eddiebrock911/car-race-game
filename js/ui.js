// ---------------------------------------------------------------------------
// DUSKRUNNER V2 — ui.js
// All DOM screens: main menu, time-attack select, daily challenge, garage
// (preview + stats + unlock/select + upgrades), missions, achievements,
// leaderboard, statistics, settings, pause, game over, HUD, toasts.
// Every element is queried once; listeners are registered once; HUD text is
// diffed before writing to avoid layout thrash.
// ---------------------------------------------------------------------------

import { clamp, formatNum, formatDistance, todayKey } from './util.js';
import { getSave, persist, addCoins, spendCoins, canAfford, resetSave, isPersistent } from './storage.js';
import {
  CARS, getCar, UPGRADE_DEFS, STAT_BAR_MAX, effectiveStats, effectiveStat,
  isUnlocked, getUpgradeLevel, upgradeCost, isFullyUpgraded
} from './garage.js';
import { MISSIONS, missionProgress, claimMission, isClaimed, anyClaimable } from './missions.js';
import { ACHIEVEMENTS, isUnlocked as achUnlocked, checkAchievements } from './achievements.js';
import { MODES, MODE_LABELS, fetchBoard, getHighScore } from './leaderboard.js';
import { getTodayChallenge, getDailyStatus } from './daily.js';
import { AudioSys } from './audio.js';
import { R } from './render.js';

const $ = (id) => document.getElementById(id);

export const UI = {
  handlers: null,       // { play(mode,opts), resume(), restart(), home(), retry(), applySettings() }
  screens: {},
  hud: {},
  _lastHud: {},
  _garageIdx: 0,
  _previewRAF: 0,
  _previewT0: 0,
  _leaderMode: 'endless',
  _resetArmed: 0,
  _toastPool: [],

  // ===========================================================================

  init(handlers) {
    this.handlers = handlers;

    // cache screen + hud elements once
    for (const id of ['menu', 'time', 'daily', 'garage', 'missions', 'achieves', 'leader', 'stats', 'settings', 'pause', 'over']) {
      this.screens[id] = $('screen-' + id);
    }
    const hudIds = ['score', 'dist', 'speed', 'coins', 'nitroFill', 'nitroPct', 'timer', 'env', 'objective', 'powerups', 'combo'];
    for (const id of hudIds) this.hud[id] = $('hud-' + id);
    this.hud.root = $('hud');

    this._bindMenu();
    this._bindGarage();
    this._bindSettings();
    this._bindPause();
    this._bindOver();
    this._bindGeneric();

    if (!isPersistent()) {
      this.showToast('⚠', 'STORAGE UNAVAILABLE', 'Progress will not be saved this session', '#ffb02e');
    }
  },

  _click(fn) {
    return (e) => {
      if (e) e.preventDefault();
      AudioSys.unlock();
      AudioSys.sfx('click');
      try { fn(); } catch (err) { console.error('[ui]', err); }
    };
  },

  _bindGeneric() {
    document.querySelectorAll('[data-back]').forEach(b =>
      b.addEventListener('click', this._click(() => this.show('menu'))));
  },

  // --- screens -----------------------------------------------------------------

  show(name) {
    this.stopPreviewLoop();
    for (const key of Object.keys(this.screens)) {
      const el = this.screens[key];
      if (!el) continue;
      el.classList.toggle('hide', key !== name);
    }
    this.hud.root.classList.toggle('on', name === null);
    document.body.classList.toggle('in-game', name === null);

    switch (name) {
      case 'menu': this.refreshMenu(); break;
      case 'garage': this.refreshGarage(); this.startPreviewLoop(); break;
      case 'missions': this.refreshMissions(); break;
      case 'achieves': this.refreshAchievements(); break;
      case 'leader': this.refreshLeaderboard(); break;
      case 'stats': this.refreshStats(); break;
      case 'daily': this.refreshDaily(); break;
      case 'settings': this.refreshSettings(); break;
      default: break;
    }
    this.updateCoinChips();
  },

  hideAll() {
    this.stopPreviewLoop();
    for (const key of Object.keys(this.screens)) {
      const el = this.screens[key];
      if (el) el.classList.add('hide');
    }
  },

  // --- menu ----------------------------------------------------------------------

  _bindMenu() {
    $('btn-endless').addEventListener('click', this._click(() => this.handlers.play('endless')));
    $('btn-time').addEventListener('click', this._click(() => this.show('time')));
    $('btn-daily').addEventListener('click', this._click(() => this.show('daily')));
    $('btn-garage').addEventListener('click', this._click(() => this.show('garage')));
    $('btn-missions').addEventListener('click', this._click(() => this.show('missions')));
    $('btn-achieves').addEventListener('click', this._click(() => this.show('achieves')));
    $('btn-leader').addEventListener('click', this._click(() => this.show('leader')));
    $('btn-stats').addEventListener('click', this._click(() => this.show('stats')));
    $('btn-settings').addEventListener('click', this._click(() => this.show('settings')));
    $('btn-t60').addEventListener('click', this._click(() => this.handlers.play('time', { seconds: 60 })));
    $('btn-t90').addEventListener('click', this._click(() => this.handlers.play('time', { seconds: 90 })));
    $('btn-daily-play').addEventListener('click', this._click(() => this.handlers.play('daily')));
  },

  refreshMenu() {
    const save = getSave();
    const car = getCar(save.selectedCar);
    $('menu-car').textContent = car.name;
    const hs = save.highScores.endless;
    $('menu-best-score').textContent = formatNum(hs ? hs.score : 0);
    $('menu-best-dist').textContent = formatDistance(save.stats.bestDistance);
    $('menu-runs').textContent = formatNum(save.stats.runs);

    // badges
    $('badge-missions').classList.toggle('on', anyClaimable(save));
    const daily = getDailyStatus();
    $('badge-daily').classList.toggle('on', !daily.completedToday);
  },

  updateCoinChips() {
    const save = getSave();
    const txt = formatNum(save.coins);
    for (const id of ['menu-coins', 'garage-coins', 'hud-coins', 'over-coins-balance', 'missions-coins']) {
      const el = $(id);
      if (el && el.textContent !== txt) el.textContent = txt;
    }
  },

  // --- garage ---------------------------------------------------------------------

  _bindGarage() {
    $('btn-car-prev').addEventListener('click', this._click(() => { this._garageIdx = (this._garageIdx + CARS.length - 1) % CARS.length; this.refreshGarage(); }));
    $('btn-car-next').addEventListener('click', this._click(() => { this._garageIdx = (this._garageIdx + 1) % CARS.length; this.refreshGarage(); }));
    $('btn-car-select').addEventListener('click', this._click(() => {
      const save = getSave();
      const car = CARS[this._garageIdx];
      if (!isUnlocked(save, car.id)) { AudioSys.sfx('deny'); return; }
      save.selectedCar = car.id;
      persist();
      AudioSys.sfx('buy');
      this.refreshGarage();
    }));
    $('btn-car-unlock').addEventListener('click', this._click(() => {
      const save = getSave();
      const car = CARS[this._garageIdx];
      if (isUnlocked(save, car.id)) return;
      if (!canAfford(car.price)) {
        AudioSys.sfx('deny');
        const el = $('garage-buy-row');
        el.classList.remove('shake');
        void el.offsetWidth; // restart animation
        el.classList.add('shake');
        this.showToast('🪙', 'NOT ENOUGH COINS', `Keep driving — ${car.name} costs ${formatNum(car.price)}`, '#ff5c5c');
        return;
      }
      spendCoins(car.price);
      save.unlockedCars.push(car.id);
      save.upgrades[car.id] = { engine: 0, tires: 0, turbo: 0, nitro: 0 };
      persist();
      AudioSys.sfx('achieve');
      this.showToast('🔓', 'CAR UNLOCKED', car.name, '#3dffc0');
      this._checkAchievements();
      this.refreshGarage();
      this.refreshMenu();
    }));
  },

  startPreviewLoop() {
    if (this._previewRAF) return;
    const cv = $('garage-preview');
    const fit = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = cv.clientWidth, h = cv.clientHeight;
      if (w > 0 && h > 0 && (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr))) {
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(h * dpr);
      }
    };
    this._previewT0 = performance.now();
    const loop = (t) => {
      this._previewRAF = requestAnimationFrame(loop);
      fit();
      const car = CARS[this._garageIdx];
      const ctx = cv.getContext('2d');
      if (!ctx || !cv.width) return;
      ctx.setTransform(cv.width / (cv.clientWidth || 1), 0, 0, cv.height / (cv.clientHeight || 1), 0, 0);
      R.drawCarPreview(ctx, cv.clientWidth, cv.clientHeight, car, (t - this._previewT0) / 1000);
    };
    this._previewRAF = requestAnimationFrame(loop);
  },

  stopPreviewLoop() {
    if (this._previewRAF) { cancelAnimationFrame(this._previewRAF); this._previewRAF = 0; }
  },

  refreshGarage() {
    const save = getSave();
    const car = CARS[this._garageIdx];
    const unlocked = isUnlocked(save, car.id);
    const selected = save.selectedCar === car.id;
    const stats = effectiveStats(save, car.id);

    $('garage-car-name').textContent = car.name;
    $('garage-car-tag').textContent = car.tagline;
    $('garage-car-pos').textContent = `${this._garageIdx + 1} / ${CARS.length}`;
    $('garage-car-name').style.color = car.look.body;

    // stat bars
    for (const key of ['speed', 'handling', 'accel', 'nitro']) {
      const fill = $('stat-' + key);
      const label = $('statv-' + key);
      if (fill) fill.style.width = (clamp(stats[key] / STAT_BAR_MAX, 0, 1) * 100).toFixed(1) + '%';
      if (label) label.textContent = stats[key];
    }

    // buy row
    const buyRow = $('garage-buy-row');
    const unlockBtn = $('btn-car-unlock');
    const selectBtn = $('btn-car-select');
    if (unlocked) {
      buyRow.classList.add('hide');
      selectBtn.classList.remove('hide');
      selectBtn.disabled = selected;
      selectBtn.textContent = selected ? '✓ SELECTED' : 'SELECT';
    } else {
      buyRow.classList.remove('hide');
      selectBtn.classList.add('hide');
      $('garage-price').textContent = formatNum(car.price);
      unlockBtn.textContent = canAfford(car.price) ? 'UNLOCK' : 'LOCKED';
      unlockBtn.classList.toggle('poor', !canAfford(car.price));
    }

    // upgrades
    this._renderUpgrades(car, unlocked);
    this.updateCoinChips();
  },

  _renderUpgrades(car, unlocked) {
    const save = getSave();
    const wrap = $('garage-upgrades');
    // build rows once, reuse nodes
    if (wrap.childElementCount !== UPGRADE_DEFS.length) {
      wrap.innerHTML = '';
      for (const u of UPGRADE_DEFS) {
        const row = document.createElement('div');
        row.className = 'upg-row';
        row.dataset.key = u.key;
        row.innerHTML = `
          <div class="upg-head"><span class="upg-icon">${u.icon}</span><span class="upg-name">${u.name}</span>
            <span class="upg-pips"></span></div>
          <div class="upg-desc">${u.desc}</div>
          <div class="upg-foot">
            <span class="upg-delta"></span>
            <button class="btn small upg-buy"></button>
          </div>`;
        wrap.appendChild(row);
      }
    }
    for (const u of UPGRADE_DEFS) {
      const row = wrap.querySelector(`[data-key="${u.key}"]`);
      if (!row) continue;
      const lvl = getUpgradeLevel(save, car.id, u.key);
      const cur = effectiveStat(save, car.id, u.stat);
      const cost = upgradeCost(lvl);
      const pips = row.querySelector('.upg-pips');
      let pipHtml = '';
      for (let i = 0; i < 5; i++) pipHtml += `<i class="${i < lvl ? 'on' : ''}"></i>`;
      pips.innerHTML = pipHtml;

      const delta = row.querySelector('.upg-delta');
      const btn = row.querySelector('.upg-buy');
      if (cost < 0) {
        delta.innerHTML = `<b>${cur}</b> <em>MAX</em>`;
        btn.textContent = 'MAXED';
        btn.disabled = true;
        btn.classList.remove('poor');
      } else {
        delta.innerHTML = `<b>${cur}</b> → <b class="good">${cur + 3}</b>`;
        btn.textContent = `🪙 ${formatNum(cost)}`;
        btn.disabled = !unlocked;
        const poor = !canAfford(cost) || !unlocked;
        btn.classList.toggle('poor', poor);
        btn.onclick = this._click(() => {
          const s = getSave();
          const l = getUpgradeLevel(s, car.id, u.key);
          const c = upgradeCost(l);
          if (c < 0) return;
          if (!isUnlocked(s, car.id)) { AudioSys.sfx('deny'); return; }
          if (!spendCoins(c)) {
            AudioSys.sfx('deny');
            this.showToast('🪙', 'NOT ENOUGH COINS', `${u.name} upgrade costs ${formatNum(c)}`, '#ff5c5c');
            return;
          }
          s.upgrades[car.id][u.key] = l + 1;
          persist();
          AudioSys.sfx('buy');
          this.showToast(u.icon, `${u.name} LV ${l + 1}`, `${u.stat.toUpperCase()} +3 installed`, '#3dffc0');
          if (isFullyUpgraded(s, car.id)) this.showToast('🔧', 'FULLY LOADED', `${car.name} is maxed out!`, '#ffd35c');
          this._checkAchievements();
          this.refreshGarage();
        });
      }
    }
  },

  // --- missions --------------------------------------------------------------------

  refreshMissions() {
    const save = getSave();
    const wrap = $('mission-list');
    wrap.innerHTML = '';
    for (const m of MISSIONS) {
      const p = missionProgress(save, m);
      const claimed = isClaimed(save, m.id);
      const card = document.createElement('div');
      card.className = 'mission' + (claimed ? ' done' : '');
      card.innerHTML = `
        <div class="mission-top">
          <span class="mission-num">MISSION ${m.num}</span>
          <span class="mission-reward">🪙 ${formatNum(m.reward)}</span>
        </div>
        <div class="mission-title">${m.title}</div>
        <div class="mission-desc">${m.desc}</div>
        <div class="bar"><div class="bar-fill ${p.done ? 'good' : ''}" style="width:${(p.pct * 100).toFixed(1)}%"></div></div>
        <div class="mission-foot">
          <span class="mission-prog">${formatNum(Math.min(p.value, m.target))} / ${formatNum(m.target)} · ${Math.round(p.pct * 100)}%</span>
          <button class="btn small ${claimed ? '' : p.done ? 'glow' : ''}" ${claimed || !p.done ? 'disabled' : ''}>${claimed ? '✓ CLAIMED' : p.done ? 'CLAIM' : 'IN PROGRESS'}</button>
        </div>`;
      if (!claimed && p.done) {
        card.querySelector('button').addEventListener('click', this._click(() => {
          const res = claimMission(m.id);
          if (res.ok) {
            AudioSys.sfx('mission');
            this.showToast('🎯', 'MISSION COMPLETE', `${m.title} — +${formatNum(res.reward)} coins`, '#3dffc0');
          }
          this.refreshMissions();
          this.refreshMenu();
        }));
      }
      wrap.appendChild(card);
    }
  },

  // --- achievements -------------------------------------------------------------------

  refreshAchievements() {
    const save = getSave();
    const wrap = $('achieve-list');
    wrap.innerHTML = '';
    let count = 0;
    for (const a of ACHIEVEMENTS) {
      const un = achUnlocked(save, a.id);
      if (un) count++;
      const card = document.createElement('div');
      card.className = 'achv' + (un ? ' un' : '');
      card.innerHTML = `
        <div class="achv-icon">${un ? a.icon : '🔒'}</div>
        <div class="achv-body">
          <div class="achv-name">${a.name}</div>
          <div class="achv-desc">${a.desc}</div>
          <div class="achv-reward">${un ? '✓ UNLOCKED' : `Reward: 🪙 ${formatNum(a.reward)}`}</div>
        </div>`;
      wrap.appendChild(card);
    }
    $('achieve-count').textContent = `${count} / ${ACHIEVEMENTS.length} UNLOCKED`;
  },

  // --- leaderboard ----------------------------------------------------------------------

  _bindLeaderTabs() { /* tabs are rendered in refreshLeaderboard */ },

  refreshLeaderboard() {
    const tabs = $('leader-tabs');
    tabs.innerHTML = '';
    for (const m of MODES) {
      const b = document.createElement('button');
      b.className = 'tab' + (m === this._leaderMode ? ' on' : '');
      b.textContent = MODE_LABELS[m];
      b.addEventListener('click', this._click(() => { this._leaderMode = m; this.refreshLeaderboard(); }));
      tabs.appendChild(b);
    }
    const list = $('leader-list');
    list.innerHTML = '';
    fetchBoard(this._leaderMode).then(entries => {
      if (!entries.length) {
        list.innerHTML = '<div class="empty">NO RECORDS YET<br><small>Finish a run to claim the top spot.</small></div>';
        return;
      }
      entries.forEach((e, i) => {
        const row = document.createElement('div');
        row.className = 'lb-row' + (i === 0 ? ' gold' : '');
        row.innerHTML = `
          <span class="lb-rank">${i + 1}</span>
          <span class="lb-score">${formatNum(e.score)}</span>
          <span class="lb-meta">${formatDistance(e.dist)} · ${getCar(e.car).name}</span>
          <span class="lb-date">${e.date || ''}</span>`;
        list.appendChild(row);
      });
    }).catch(() => {
      list.innerHTML = '<div class="empty">BOARD UNAVAILABLE</div>';
    });
    const hs = getHighScore(this._leaderMode);
    $('leader-personal').textContent = hs
      ? `PERSONAL BEST: ${formatNum(hs.score)} pts · ${formatDistance(hs.dist)}`
      : 'PERSONAL BEST: —';
  },

  // --- stats ---------------------------------------------------------------------------

  refreshStats() {
    const s = getSave().stats;
    const save = getSave();
    const rows = [
      ['TOTAL DISTANCE', formatDistance(s.totalDistance)],
      ['TOTAL RUNS', formatNum(s.runs)],
      ['HIGHWAY COINS COLLECTED', formatNum(s.totalCoins)],
      ['COINS EARNED (ALL TIME)', formatNum(s.coinsEarned)],
      ['NEAR MISSES', formatNum(s.nearMisses)],
      ['BEST COMBO', 'x' + formatNum(s.bestCombo)],
      ['TRAFFIC DODGED', formatNum(s.dodged)],
      ['NITRO ACTIVATIONS', formatNum(s.nitroUses)],
      ['HIGHEST SPEED', Math.round(s.highestSpeed) + ' km/h'],
      ['BEST SCORE', formatNum(s.bestScore)],
      ['CARS UNLOCKED', `${save.unlockedCars.length} / ${CARS.length}`],
      ['MISSIONS COMPLETED', `${save.missions.claimed.length} / ${MISSIONS.length}`],
      ['ACHIEVEMENTS', `${save.achievements.length} / ${ACHIEVEMENTS.length}`],
      ['NIGHT RUNS', formatNum(s.nightReached)]
    ];
    const wrap = $('stats-list');
    wrap.innerHTML = '';
    for (const [k, v] of rows) {
      const row = document.createElement('div');
      row.className = 'stat-row';
      row.innerHTML = `<span>${k}</span><b>${v}</b>`;
      wrap.appendChild(row);
    }
  },

  // --- daily -----------------------------------------------------------------------------

  refreshDaily() {
    const cfg = getTodayChallenge();
    const st = getDailyStatus();
    $('daily-date').textContent = cfg.dateKey;
    $('daily-title').textContent = cfg.title;
    $('daily-objective').textContent = cfg.objectiveText;
    $('daily-reward').textContent = `🪙 ${formatNum(cfg.reward)}`;
    $('daily-status').innerHTML = st.completedToday
      ? `<span class="good">✓ COMPLETED TODAY</span> · Best: ${formatNum(st.bestScore)} pts`
      : st.playedToday
        ? `Attempted today · Best: ${formatNum(st.bestScore)} pts`
        : 'Fresh challenge — same for every driver today.';
    $('daily-seed').textContent = 'SEED #' + (cfg.seed % 100000);
  },

  // --- settings ---------------------------------------------------------------------------

  _bindSettings() {
    const save = () => getSave().settings;
    const apply = () => { persist(); this.handlers.applySettings(); };

    const toggle = (id, key) => {
      const el = $(id);
      el.addEventListener('click', this._click(() => {
        save()[key] = !save()[key];
        el.classList.toggle('on', save()[key]);
        apply();
      }));
    };
    toggle('set-sfx', 'sfx');
    toggle('set-music', 'music');
    toggle('set-shake', 'shake');
    toggle('set-particles', 'particles');
    toggle('set-motion', 'motion');

    $('set-volume').addEventListener('input', () => {
      save().volume = clamp(parseInt($('set-volume').value, 10) / 100, 0, 1);
      $('set-volume-val').textContent = $('set-volume').value + '%';
      apply();
    });
    $('set-quality').addEventListener('change', () => {
      save().quality = $('set-quality').value;
      apply();
    });
    $('set-touch').addEventListener('change', () => {
      save().touchControls = $('set-touch').value;
      apply();
    });
    $('set-reset').addEventListener('click', this._click(() => {
      const now = performance.now();
      if (now - this._resetArmed < 3000 && this._resetArmed > 0) {
        this._resetArmed = 0;
        $('set-reset').textContent = 'RESET SAVE DATA';
        resetSave();
        AudioSys.sfx('crash');
        this.showToast('🗑', 'SAVE RESET', 'All progress cleared', '#ff5c5c');
        this.refreshSettings();
        this.refreshMenu();
        this.handlers.applySettings();
      } else {
        this._resetArmed = now;
        $('set-reset').textContent = 'TAP AGAIN TO CONFIRM';
        AudioSys.sfx('deny');
        setTimeout(() => {
          if (performance.now() - this._resetArmed >= 2900) {
            this._resetArmed = 0;
            const b = $('set-reset');
            if (b) b.textContent = 'RESET SAVE DATA';
          }
        }, 3100);
      }
    }));
  },

  refreshSettings() {
    const s = getSave().settings;
    $('set-sfx').classList.toggle('on', s.sfx);
    $('set-music').classList.toggle('on', s.music);
    $('set-shake').classList.toggle('on', s.shake);
    $('set-particles').classList.toggle('on', s.particles);
    $('set-motion').classList.toggle('on', s.motion);
    $('set-volume').value = Math.round(s.volume * 100);
    $('set-volume-val').textContent = Math.round(s.volume * 100) + '%';
    $('set-quality').value = s.quality;
    $('set-touch').value = s.touchControls;
    $('set-quality-now').textContent = R.quality.toUpperCase();
    $('set-storage-note').textContent = isPersistent() ? 'localStorage: OK' : 'localStorage blocked — progress is session-only';
  },

  // --- pause / over -------------------------------------------------------------------------

  _bindPause() {
    $('btn-resume').addEventListener('click', this._click(() => this.handlers.resume()));
    $('btn-prestart').addEventListener('click', this._click(() => this.handlers.restart()));
    $('btn-pause-home').addEventListener('click', this._click(() => this.handlers.home()));
  },

  _bindOver() {
    $('btn-retry').addEventListener('click', this._click(() => this.handlers.retry()));
    $('btn-over-garage').addEventListener('click', this._click(() => { this.handlers.home(); this.show('garage'); }));
    $('btn-over-home').addEventListener('click', this._click(() => this.handlers.home()));
  },

  showPause() { this.screens.pause.classList.remove('hide'); },
  hidePause() { this.screens.pause.classList.add('hide'); },

  showGameOver(d) {
    $('over-title').textContent = d.title;
    $('over-title').style.color = d.titleColor || '#ff5c6e';
    $('over-newbest').classList.toggle('show', !!d.newBest);
    $('over-score').textContent = formatNum(d.score);
    $('over-best').textContent = formatNum(d.best);
    $('over-mode').textContent = d.modeLabel;

    const rows = [
      ['DISTANCE', formatDistance(d.dist)],
      ['COINS EARNED', '🪙 ' + formatNum(d.coinsEarned)],
      ['NEAR MISSES', formatNum(d.nearMisses)],
      ['BEST COMBO', 'x' + d.bestCombo],
      ['TOP SPEED', Math.round(d.topSpeed) + ' km/h'],
      ['NITRO USED', formatNum(d.nitroUses) + (d.nitroUses === 1 ? ' boost' : ' boosts')]
    ];
    const wrap = $('over-stats');
    wrap.innerHTML = '';
    for (const [k, v] of rows) {
      const row = document.createElement('div');
      row.className = 'over-stat';
      row.innerHTML = `<small>${k}</small><b>${v}</b>`;
      wrap.appendChild(row);
    }

    const bd = $('over-breakdown');
    bd.innerHTML = '';
    for (const [k, v] of d.breakdown) {
      if (v <= 0) continue;
      const row = document.createElement('div');
      row.className = 'bd-row';
      row.innerHTML = `<span>${k}</span><b>+${formatNum(v)}</b>`;
      bd.appendChild(row);
    }
    if (d.dailyResult) {
      const row = document.createElement('div');
      row.className = 'bd-row daily';
      row.innerHTML = `<span>${d.dailyResult}</span>`;
      bd.appendChild(row);
    }

    this.screens.over.classList.remove('hide');
    this.updateCoinChips();
    const btn = $('btn-retry');
    if (btn) setTimeout(() => { try { btn.focus(); } catch (e) { /* noop */ } }, 60);
  },

  // --- HUD ----------------------------------------------------------------------------------

  setHudVisible(on) {
    this.hud.root.classList.toggle('on', on);
    document.body.classList.toggle('in-game', on);
  },

  /**
   * Diffed HUD write — only touches DOM nodes whose value changed.
   * d: {score, dist, speed, coins, nitroPct, nitroActive, timer, env,
   *     objective, combo, powerups:[{key,icon,label,t,dur}]}
   */
  updateHud(d) {
    const h = this.hud, L = this._lastHud;
    if (L.score !== d.score) { h.score.textContent = d.score; L.score = d.score; }
    if (L.dist !== d.dist) { h.dist.textContent = d.dist; L.dist = d.dist; }
    if (L.speed !== d.speed) { h.speed.textContent = d.speed; L.speed = d.speed; }
    if (L.coins !== d.coins) { h.coins.textContent = d.coins; L.coins = d.coins; }

    const nitroW = (d.nitroPct * 100).toFixed(0) + '%';
    if (L.nitroW !== nitroW) { h.nitroFill.style.width = nitroW; L.nitroW = nitroW; }
    const nitroP = Math.round(d.nitroPct * 100) + '%';
    if (L.nitroP !== nitroP) { h.nitroPct.textContent = nitroP; L.nitroP = nitroP; }
    const na = d.nitroActive ? 1 : 0;
    if (L.nitroA !== na) { h.nitroFill.parentElement.classList.toggle('boosting', !!na); L.nitroA = na; }
    const low = d.nitroPct < 0.15 ? 1 : 0;
    if (L.nitroL !== low) { h.nitroFill.parentElement.classList.toggle('low', !!low); L.nitroL = low; }

    const timerTxt = d.timer == null ? '' : d.timer;
    if (L.timer !== timerTxt) {
      h.timer.textContent = timerTxt;
      h.timer.parentElement.classList.toggle('hide', !timerTxt);
      h.timer.parentElement.classList.toggle('urgent', timerTxt !== '' && parseFloat(timerTxt) <= 10);
      L.timer = timerTxt;
    }
    if (L.env !== d.env) { h.env.textContent = d.env; L.env = d.env; }
    if (L.objective !== d.objective) {
      h.objective.textContent = d.objective || '';
      h.objective.parentElement.classList.toggle('hide', !d.objective);
      L.objective = d.objective;
    }
    const comboTxt = d.combo > 1 ? `COMBO x${d.combo}` : '';
    if (L.combo !== comboTxt) {
      h.combo.textContent = comboTxt;
      h.combo.classList.toggle('show', !!comboTxt);
      L.combo = comboTxt;
    }

    // power-up chips — rebuild only when the signature changes
    const sig = d.powerups.map(p => p.key + Math.ceil(p.t)).join('|');
    if (L.puSig !== sig) {
      L.puSig = sig;
      const wrap = h.powerups;
      // reuse children when possible
      while (wrap.childElementCount > d.powerups.length) wrap.removeChild(wrap.lastElementChild);
      d.powerups.forEach((p, i) => {
        let chip = wrap.children[i];
        if (!chip) {
          chip = document.createElement('div');
          chip.className = 'pu-chip';
          chip.innerHTML = '<span class="pu-icon"></span><span class="pu-label"></span><i class="pu-bar"><b></b></i>';
          wrap.appendChild(chip);
        }
        chip.querySelector('.pu-icon').textContent = p.icon;
        chip.querySelector('.pu-label').textContent = p.label;
        chip.querySelector('.pu-bar b').style.width = (clamp(p.t / p.dur, 0, 1) * 100).toFixed(0) + '%';
      });
    } else if (d.powerups.length) {
      // animate bars smoothly between signature changes
      d.powerups.forEach((p, i) => {
        const chip = h.powerups.children[i];
        if (chip) chip.querySelector('.pu-bar b').style.width = (clamp(p.t / p.dur, 0, 1) * 100).toFixed(0) + '%';
      });
    }
  },

  // --- toasts --------------------------------------------------------------------------------

  /** Evaluate achievements after economy events (purchases/unlocks). */
  _checkAchievements() {
    try {
      const fresh = checkAchievements(getSave());
      for (const a of fresh) {
        this.showToast(a.icon, 'ACHIEVEMENT UNLOCKED', `${a.name} — +${formatNum(a.reward)} coins`, '#ffd35c');
      }
      if (fresh.length) {
        AudioSys.sfx('achieve');
        this.updateCoinChips();
      }
    } catch (e) { console.error('[ui] achievements', e); }
  },

  showToast(icon, title, sub, color) {
    const wrap = $('toasts');
    if (!wrap) return;
    let el = this._toastPool.pop();
    if (!el) {
      el = document.createElement('div');
      el.className = 'toast';
      el.innerHTML = '<span class="t-icon"></span><div class="t-body"><b class="t-title"></b><span class="t-sub"></span></div>';
    }
    el.querySelector('.t-icon').textContent = icon;
    el.querySelector('.t-title').textContent = title;
    el.querySelector('.t-sub').textContent = sub || '';
    el.style.setProperty('--tc', color || '#3dffc0');
    wrap.appendChild(el);
    requestAnimationFrame(() => el.classList.add('in'));
    setTimeout(() => {
      el.classList.remove('in');
      setTimeout(() => {
        if (el.parentNode) el.parentNode.removeChild(el);
        if (this._toastPool.length < 4) this._toastPool.push(el);
      }, 400);
    }, 3200);
  }
};

export default UI;
