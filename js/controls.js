// ---------------------------------------------------------------------------
// DUSKRUNNER V2 — controls.js
// Unified input: keyboard (desktop) + tap-sides / swipe / on-screen buttons
// (mobile). All listeners are registered EXACTLY ONCE in init(); no handler
// is ever re-added. Edge-triggered steering (one press = one lane), held
// nitro/throttle/brake, pause on P/ESC/button, auto-pause on tab hide.
// Browser scrolling/zoom gestures are prevented while playing.
// ---------------------------------------------------------------------------

import { isTouchDevice } from './util.js';

export const Input = {
  nitro: false,
  throttle: false,
  brake: false,
  pausePressed: false,
  confirmPressed: false,
  touchMode: 'both',     // 'tap' | 'buttons' | 'both'
  inGame: false,         // set by game.js each state change
  handlers: null,
  _initialized: false,
  _holdTimers: { left: 0, right: 0 },
  _gestureUnlocked: false,

  init(handlers) {
    if (this._initialized) return;   // guard against duplicate registration
    this._initialized = true;
    this.handlers = handlers;        // { onSteer(dir), onPause(), onConfirm(), onFirstGesture() }

    const H = this.handlers;
    const firstGesture = () => {
      if (!this._gestureUnlocked) {
        this._gestureUnlocked = true;
        try { H.onFirstGesture(); } catch (e) { /* noop */ }
      }
    };

    // ---------------- keyboard ----------------
    window.addEventListener('keydown', (e) => {
      firstGesture();
      const k = e.key;
      if (e.repeat) {
        // holding steer keys must not machine-gun lane changes,
        // but holding nitro/throttle is fine (state-based below)
        if (k === ' ' || k === 'ArrowUp' || k === 'ArrowDown' || k === 'w' || k === 's' || k === 'W' || k === 'S') e.preventDefault();
        return;
      }
      switch (k) {
        case 'ArrowLeft': case 'a': case 'A':
          H.onSteer(-1); e.preventDefault(); break;
        case 'ArrowRight': case 'd': case 'D':
          H.onSteer(1); e.preventDefault(); break;
        case 'ArrowUp': case 'w': case 'W':
          this.throttle = true; e.preventDefault(); break;
        case 'ArrowDown': case 's': case 'S':
          this.brake = true; e.preventDefault(); break;
        case ' ':
          if (this.inGame) { this.nitro = true; e.preventDefault(); }
          else { this.confirmPressed = true; H.onConfirm(); e.preventDefault(); }
          break;
        case 'Enter':
          if (!this.inGame) { this.confirmPressed = true; H.onConfirm(); e.preventDefault(); }
          break;
        case 'p': case 'P': case 'Escape':
          H.onPause(); e.preventDefault(); break;
        default: break;
      }
    }, { passive: false });

    window.addEventListener('keyup', (e) => {
      switch (e.key) {
        case 'ArrowUp': case 'w': case 'W': this.throttle = false; break;
        case 'ArrowDown': case 's': case 'S': this.brake = false; break;
        case ' ': this.nitro = false; break;
        default: break;
      }
    });

    // ---------------- pointer: mouse tap (v1) + touch swipe/tap ----------------
    const surface = document.getElementById('c') || window;
    const gesture = { id: -1, x0: 0, y0: 0, t0: 0, fired: false, isTouch: false };

    surface.addEventListener('pointerdown', (e) => {
      firstGesture();
      if (e.button !== undefined && e.button !== 0) return;
      gesture.id = e.pointerId;
      gesture.x0 = e.clientX;
      gesture.y0 = e.clientY;
      gesture.t0 = performance.now();
      gesture.fired = false;
      gesture.isTouch = e.pointerType === 'touch' || e.pointerType === 'pen';
      if (!this.inGame) return;
      if (this.touchMode === 'buttons') return;
      if (!gesture.isTouch) {
        // mouse: instant side-steer, exactly like v1
        H.onSteer(e.clientX < window.innerWidth / 2 ? -1 : 1);
        gesture.fired = true;
      }
    }, { passive: true });

    surface.addEventListener('pointermove', (e) => {
      if (!this.inGame || e.pointerId !== gesture.id || gesture.fired) return;
      const dx = e.clientX - gesture.x0;
      const dy = e.clientY - gesture.y0;
      if (Math.abs(dx) > 42 && Math.abs(dx) > Math.abs(dy) * 1.15) {
        gesture.fired = true; // swipe steers as soon as recognized (low latency)
        H.onSteer(dx > 0 ? 1 : -1);
      }
    }, { passive: true });

    const endPointer = (e) => {
      if (e.pointerId !== gesture.id) return;
      // touch tap without swipe → side steer (no double-fire with swipe)
      if (this.inGame && !gesture.fired && gesture.isTouch && this.touchMode !== 'buttons') {
        const dx = e.clientX - gesture.x0, dy = e.clientY - gesture.y0;
        const quick = performance.now() - gesture.t0 < 350;
        if (quick && dx * dx + dy * dy < 400) {
          H.onSteer(e.clientX < window.innerWidth / 2 ? -1 : 1);
        }
      }
      gesture.id = -1;
    };
    surface.addEventListener('pointerup', endPointer, { passive: true });
    surface.addEventListener('pointercancel', (e) => {
      if (e.pointerId === gesture.id) gesture.id = -1;
    }, { passive: true });

    // ---------------- on-screen buttons ----------------
    const bindHold = (el, dir) => {
      if (!el) return;
      const start = (e) => {
        e.preventDefault(); e.stopPropagation();
        firstGesture();
        if (!this.inGame) return;
        H.onSteer(dir);
        // auto-repeat while held (mobile comfort), first repeat after 260ms
        const key = dir < 0 ? 'left' : 'right';
        clearInterval(this._holdTimers[key]);
        this._holdTimers[key] = setInterval(() => H.onSteer(dir), 260);
      };
      const stop = (e) => {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        const key = dir < 0 ? 'left' : 'right';
        clearInterval(this._holdTimers[key]);
      };
      el.addEventListener('pointerdown', start);
      el.addEventListener('pointerup', stop);
      el.addEventListener('pointercancel', stop);
      el.addEventListener('pointerleave', stop);
      el.addEventListener('contextmenu', (e) => e.preventDefault());
    };
    bindHold(document.getElementById('btnLeft'), -1);
    bindHold(document.getElementById('btnRight'), 1);

    const nitroBtn = document.getElementById('btnNitro');
    if (nitroBtn) {
      const nDown = (e) => { e.preventDefault(); e.stopPropagation(); firstGesture(); this.nitro = true; nitroBtn.classList.add('held'); };
      const nUp = (e) => { if (e) { e.preventDefault(); e.stopPropagation(); } this.nitro = false; nitroBtn.classList.remove('held'); };
      nitroBtn.addEventListener('pointerdown', nDown);
      nitroBtn.addEventListener('pointerup', nUp);
      nitroBtn.addEventListener('pointercancel', nUp);
      nitroBtn.addEventListener('pointerleave', nUp);
      nitroBtn.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    const pauseBtn = document.getElementById('btnPause');
    if (pauseBtn) {
      pauseBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); firstGesture(); H.onPause(); });
    }

    // ---------------- scroll / gesture suppression ----------------
    document.addEventListener('touchmove', (e) => {
      if (this.inGame) e.preventDefault();
    }, { passive: false });
    document.addEventListener('gesturestart', (e) => e.preventDefault());
    document.addEventListener('contextmenu', (e) => {
      if (this.inGame) e.preventDefault();
    });
    window.addEventListener('dblclick', (e) => { if (this.inGame) e.preventDefault(); });

    // ---------------- auto-pause when the tab hides ----------------
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.inGame) {
        this.nitro = false; this.throttle = false; this.brake = false;
        H.onPause(true); // force pause
      }
    });

    // losing focus (e.g. alt-tab) also clears held keys
    window.addEventListener('blur', () => {
      this.nitro = false; this.throttle = false; this.brake = false;
    });
  },

  setTouchMode(mode) {
    this.touchMode = ['tap', 'buttons', 'both'].includes(mode) ? mode : 'both';
    const c = document.getElementById('touchControls');
    if (c) {
      // Buttons appear on touch devices (unless the player chose tap/swipe
      // only) and on any device where the player explicitly asked for them.
      const showBtns = this.touchMode === 'buttons' || (this.touchMode === 'both' && isTouchDevice());
      c.classList.toggle('btns-on', showBtns);
    }
  },

  resetHeld() {
    this.nitro = false; this.throttle = false; this.brake = false;
    clearInterval(this._holdTimers.left);
    clearInterval(this._holdTimers.right);
  }
};

export default Input;
