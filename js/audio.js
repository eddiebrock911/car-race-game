// ---------------------------------------------------------------------------
// DUSKRUNNER V2 — audio.js
// 100% procedural WebAudio (zero asset downloads → lightweight on Render).
//   * Engine drone whose pitch/filter track speed & nitro.
//   * Procedural synthwave music loop (lookahead scheduler).
//   * One-shot SFX.
// Autoplay-safe: the AudioContext is created/resumed only from a user
// gesture (Audio.unlock()). Every entry point is a safe no-op when WebAudio
// is unavailable or blocked, so the game is fully playable without sound.
// ---------------------------------------------------------------------------

import { clamp } from './util.js';

const LOOKAHEAD_MS = 250;      // music scheduler tick
const SCHEDULE_AHEAD = 0.7;    // seconds of music queued ahead

// A-minor synthwave progression: [rootHz, chordSemitones] x 4 bars, 2s/bar
const PROG = [
  { root: 55.00, chord: [0, 3, 7] },   // Am
  { root: 43.65, chord: [0, 4, 7] },   // F
  { root: 65.41, chord: [0, 4, 7] },   // C
  { root: 49.00, chord: [0, 4, 7] }    // G
];
const BAR = 2.0;

export const AudioSys = {
  ctx: null,
  master: null,
  sfxBus: null,
  musicBus: null,
  engine: null,      // {osc1,osc2,sub,filter,gain,nzGain}
  noiseBuf: null,
  ready: false,
  failed: false,
  settings: { sfx: true, music: true, volume: 0.7 },
  musicTimer: 0,
  musicStep: 0,
  musicNextTime: 0,
  musicPlaying: false,

  // --- lifecycle ------------------------------------------------------------

  /** Safe to call any time; real init happens in unlock() on first gesture. */
  init(settings) {
    if (settings) this.settings = { ...this.settings, ...settings };
  },

  /** Must be called from a user gesture (pointerdown/keydown). */
  unlock() {
    if (this.failed) return;
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) { this.failed = true; return; }
        this.ctx = new AC();
        this._buildBuses();
        this._buildNoise();
        this._buildEngine();
        this.ready = true;
      }
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      this._applySettings();
      if (this.settings.music && !this.musicPlaying) this.startMusic();
    } catch (e) {
      this.failed = true; // audio unavailable → game continues silently
    }
  },

  _buildBuses() {
    const c = this.ctx;
    this.master = c.createGain();
    this.master.connect(c.destination);
    this.sfxBus = c.createGain();
    this.sfxBus.connect(this.master);
    this.musicBus = c.createGain();
    this.musicBus.connect(this.master);
    this.musicBus.gain.value = 0.5;
  },

  _buildNoise() {
    const c = this.ctx;
    const len = c.sampleRate; // 1 second
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
  },

  _buildEngine() {
    const c = this.ctx;
    const g = c.createGain(); g.gain.value = 0;
    const filt = c.createBiquadFilter();
    filt.type = 'lowpass'; filt.frequency.value = 700; filt.Q.value = 0.8;
    const osc1 = c.createOscillator(); osc1.type = 'sawtooth'; osc1.frequency.value = 100;
    const osc2 = c.createOscillator(); osc2.type = 'sawtooth'; osc2.frequency.value = 100.6;
    const sub = c.createOscillator(); sub.type = 'triangle'; sub.frequency.value = 50;
    const subG = c.createGain(); subG.gain.value = 0.55;
    osc1.connect(filt); osc2.connect(filt);
    sub.connect(subG); subG.connect(filt);
    filt.connect(g); g.connect(this.master);
    osc1.start(); osc2.start(); sub.start();

    // nitro hiss layer (always-running noise, gain 0 unless boosting)
    const nz = c.createBufferSource(); nz.buffer = this.noiseBuf; nz.loop = true;
    const nzF = c.createBiquadFilter(); nzF.type = 'bandpass'; nzF.frequency.value = 2600; nzF.Q.value = 0.7;
    const nzG = c.createGain(); nzG.gain.value = 0;
    nz.connect(nzF); nzF.connect(nzG); nzG.connect(this.master);
    nz.start();

    this.engine = { osc1, osc2, sub, filt, gain: g, nzGain: nzG, level: 0 };
  },

  _applySettings() {
    if (!this.ready) return;
    const s = this.settings;
    this.master.gain.setTargetAtTime(s.volume, this.ctx.currentTime, 0.05);
    this.sfxBus.gain.setTargetAtTime(s.sfx ? 1 : 0, this.ctx.currentTime, 0.02);
    this.musicBus.gain.setTargetAtTime(s.music ? 0.5 : 0, this.ctx.currentTime, 0.1);
  },

  setSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    if (this.ready) {
      this._applySettings();
      if (this.settings.music && !this.musicPlaying) this.startMusic();
      if (!this.settings.music) this.stopMusic();
    }
  },

  // --- engine (called every frame while playing) ------------------------------

  /**
   * @param {number} v        world speed
   * @param {boolean} boost   nitro active
   * @param {boolean} active  engine should be audible (in-run, not paused)
   */
  updateEngine(v, boost, active) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const e = this.engine;
    const freq = 55 + clamp(v, 0, 170) * 1.9 * (boost ? 1.18 : 1);
    const targetLevel = active ? clamp(0.05 + v / 900, 0.05, 0.22) * (boost ? 1.35 : 1) : 0;
    e.osc1.frequency.setTargetAtTime(freq, t, 0.08);
    e.osc2.frequency.setTargetAtTime(freq * 1.007, t, 0.08);
    e.sub.frequency.setTargetAtTime(freq * 0.5, t, 0.08);
    e.filt.frequency.setTargetAtTime(500 + v * 9 + (boost ? 900 : 0), t, 0.1);
    e.gain.gain.setTargetAtTime(targetLevel, t, 0.12);
    e.nzGain.gain.setTargetAtTime(active && boost ? 0.05 : 0, t, 0.1);
  },

  silenceEngine() {
    if (!this.ready) return;
    this.engine.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.08);
    this.engine.nzGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.08);
  },

  // --- music -------------------------------------------------------------------

  startMusic() {
    if (!this.ready || this.musicPlaying) return;
    this.musicPlaying = true;
    this.musicNextTime = this.ctx.currentTime + 0.1;
    this.musicStep = 0;
    this.musicTimer = setInterval(() => this._scheduleMusic(), LOOKAHEAD_MS);
    this._scheduleMusic();
  },

  stopMusic() {
    this.musicPlaying = false;
    if (this.musicTimer) { clearInterval(this.musicTimer); this.musicTimer = 0; }
  },

  _scheduleMusic() {
    if (!this.ready || !this.musicPlaying) return;
    const c = this.ctx;
    while (this.musicNextTime < c.currentTime + SCHEDULE_AHEAD) {
      this._playMusicStep(this.musicStep, this.musicNextTime);
      this.musicNextTime += BAR / 8; // eighth-note grid
      this.musicStep = (this.musicStep + 1) % 32; // 4 bars x 8 steps
    }
  },

  _playMusicStep(step, t) {
    const bar = Math.floor(step / 8);
    const beat = step % 8;
    const p = PROG[bar];
    // pad chord on bar start
    if (beat === 0) {
      for (const semi of p.chord) {
        this._tone('triangle', p.root * 4 * Math.pow(2, semi / 12), t, BAR * 0.95, 0.028, this.musicBus);
      }
      this._tone('sine', p.root, t, BAR * 0.9, 0.09, this.musicBus); // bass drone
    }
    // bass pulse
    if (beat % 2 === 0) this._tone('sine', p.root * (beat === 6 ? 1.5 : 1), t, 0.22, 0.10, this.musicBus);
    // arp (quiet plucks, pentatonic flavor)
    const arpNotes = [0, 7, 12, 7, 3, 10, 15, 10];
    const semi = p.chord[0] + arpNotes[beat];
    this._tone('square', p.root * 8 * Math.pow(2, semi / 12), t, 0.12, 0.012, this.musicBus);
  },

  // --- generic synth primitives --------------------------------------------------

  /** One oscillator note with exponential decay; auto-disposes (no leaks). */
  _tone(type, freq, t, dur, vol, dest) {
    if (!this.ready) return;
    try {
      const c = this.ctx;
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = type;
      o.frequency.setValueAtTime(Math.max(20, freq), t);
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(dest || this.sfxBus);
      o.onended = () => { try { g.disconnect(); } catch (e) { /* noop */ } };
      o.start(t); o.stop(t + dur + 0.02);
    } catch (e) { /* noop */ }
  },

  _sweep(type, f0, f1, t, dur, vol, dest) {
    if (!this.ready) return;
    try {
      const c = this.ctx;
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(dest || this.sfxBus);
      o.onended = () => { try { g.disconnect(); } catch (e) { /* noop */ } };
      o.start(t); o.stop(t + dur + 0.02);
    } catch (e) { /* noop */ }
  },

  /** Filtered noise burst (whoosh / crash / glass). */
  _noise(t, dur, vol, filterType, f0, f1, q) {
    if (!this.ready) return;
    try {
      const c = this.ctx;
      const src = c.createBufferSource();
      src.buffer = this.noiseBuf;
      const f = c.createBiquadFilter();
      f.type = filterType || 'bandpass';
      f.frequency.setValueAtTime(f0, t);
      if (f1 && f1 !== f0) f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
      f.Q.value = q || 1;
      const g = c.createGain();
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(f); f.connect(g); g.connect(this.sfxBus);
      src.onended = () => { try { g.disconnect(); f.disconnect(); } catch (e) { /* noop */ } };
      src.start(t, Math.random() * 0.5); src.stop(t + dur + 0.02);
    } catch (e) { /* noop */ }
  },

  // --- one-shot SFX ----------------------------------------------------------------

  /** @param {'click'|'coin'|'powerup'|'nearmiss'|'crash'|'shield'|'mission'|'achieve'|'nitro'|'beep'|'timeup'|'buy'|'deny'|'start'} name */
  sfx(name) {
    if (!this.ready || !this.settings.sfx) return;
    try {
      const t = this.ctx.currentTime;
      switch (name) {
        case 'click':
          this._tone('square', 880, t, 0.05, 0.05); break;
        case 'coin':
          this._tone('sine', 1318, t, 0.07, 0.12);
          this._tone('sine', 1760, t + 0.055, 0.12, 0.12); break;
        case 'powerup':
          this._sweep('sine', 400, 1400, t, 0.28, 0.16);
          this._tone('triangle', 880, t + 0.1, 0.2, 0.07); break;
        case 'nearmiss':
          this._noise(t, 0.16, 0.10, 'bandpass', 2400, 250, 1.2); break;
        case 'crash':
          this._noise(t, 0.55, 0.5, 'lowpass', 1600, 90, 0.6);
          this._sweep('sine', 160, 38, t, 0.5, 0.4);
          this._sweep('sawtooth', 90, 30, t, 0.6, 0.2); break;
        case 'shield':
          this._noise(t, 0.18, 0.22, 'highpass', 3000, 1200, 0.8);
          this._sweep('square', 1200, 200, t, 0.25, 0.10); break;
        case 'mission':
          this._tone('triangle', 523, t, 0.14, 0.14);
          this._tone('triangle', 659, t + 0.1, 0.14, 0.14);
          this._tone('triangle', 784, t + 0.2, 0.3, 0.16); break;
        case 'achieve':
          this._tone('triangle', 523, t, 0.12, 0.15);
          this._tone('triangle', 659, t + 0.09, 0.12, 0.15);
          this._tone('triangle', 784, t + 0.18, 0.12, 0.15);
          this._tone('triangle', 1046, t + 0.27, 0.45, 0.18);
          this._noise(t + 0.27, 0.4, 0.05, 'highpass', 5000, 2000, 0.5); break;
        case 'nitro':
          this._noise(t, 0.25, 0.14, 'bandpass', 300, 3200, 0.9);
          this._sweep('sawtooth', 200, 700, t, 0.2, 0.06); break;
        case 'beep':
          this._tone('square', 660, t, 0.09, 0.08); break;
        case 'timeup':
          this._sweep('square', 600, 120, t, 0.6, 0.14); break;
        case 'buy':
          this._tone('sine', 880, t, 0.09, 0.14);
          this._tone('sine', 1174, t + 0.07, 0.16, 0.14); break;
        case 'deny':
          this._tone('square', 220, t, 0.1, 0.09);
          this._tone('square', 180, t + 0.09, 0.14, 0.09); break;
        case 'start':
          this._sweep('sawtooth', 300, 900, t, 0.3, 0.1); break;
        default: break;
      }
    } catch (e) { /* never let audio break the game */ }
  }
};

export default AudioSys;
