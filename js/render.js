// ---------------------------------------------------------------------------
// DUSKRUNNER V2 — render.js
// Canvas renderer. Preserves the v1 pseudo-3D projection & look (ys/sc depth
// math, striped road, lamp posts, radial speed streaks) and extends it with:
//   * blended environment palettes + cached, crossfaded skylines/sun
//   * per-type traffic shapes (car/suv/truck/sport/bus/changer + blinkers)
//   * per-car player shapes (coupe/suv/muscle/ev/sport/gt) with headlights,
//     nitro flames, shield bubble
//   * coins (spinning), power-up boxes (bobbing, glowing)
//   * ambient weather, road motion streaks, nitro FOV zoom
//   * depth-sorted draw list with REUSED entry objects (zero per-frame garbage)
// ---------------------------------------------------------------------------

import { clamp, rgbCss, roundRectPath, TAU } from './util.js';
import { THEMES, palette } from './environments.js';
import { VTYPES } from './traffic.js';
import { POWERUP_INFO } from './powerups.js';

const F = 14;        // focal depth (v1)
const RH_K = 1.75;   // road half-width factor (v1)

export const R = {
  cv: null, ctx: null,
  W: 0, H: 0, HOR: 0, BOT: 0, LW: 0, CX: 0, dpr: 1,
  quality: 'high',
  stars: [],
  _dl: [],      // reused depth-sorted draw list entries
  _dlLen: 0,
  _skyCache: null,   // { key, layers: Map(themeIdx → [farCanvas, nearCanvas]) }

  init(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.resize();
  },

  setQuality(q) {
    this.quality = q;
    this.resize();
  },

  resize() {
    if (!this.cv) return;
    const cap = this.quality === 'low' ? 1 : this.quality === 'medium' ? 1.5 : 2;
    const d = Math.min(window.devicePixelRatio || 1, cap);
    this.dpr = d;
    const W = window.innerWidth, H = window.innerHeight;
    this.cv.width = Math.round(W * d);
    this.cv.height = Math.round(H * d);
    this.ctx.setTransform(d, 0, 0, d, 0, 0);
    this.W = W; this.H = H;
    this.HOR = H * 0.4;
    this.BOT = H * 0.9;
    this.LW = Math.min(W * 0.27, H * 0.24);
    this.CX = W / 2;
    // stars — deterministic, fixed allocation (v1 heritage)
    if (this.stars.length !== 50) this.stars = new Array(50);
    for (let i = 0; i < 50; i++) {
      if (!this.stars[i]) this.stars[i] = { x: 0, y: 0, r: 0 };
      const s = this.stars[i];
      s.x = ((i * 7919) % 1000) / 1000 * W;
      s.y = ((i * 104729) % 1000) / 1000 * this.HOR * 0.75;
      s.r = 0.4 + (i % 3) * 0.4;
    }
    this._skyCache = null; // rebuild skylines for the new size
  },

  ys(d) { return this.HOR + (this.BOT - this.HOR) * F / (d + F); },
  sc(d) { return F / (d + F); },

  /** Project (depth, laneX) → screen. Writes into out {x,y,s}; returns out. */
  project(d, laneX, out) {
    const s = this.sc(d);
    out.s = s;
    out.x = this.CX + laneX * this.LW * s;
    out.y = this.ys(d);
    return out;
  },

  // --- depth-sorted draw list (reused objects) --------------------------------

  _push(d, kind, a, b) {
    let e = this._dl[this._dlLen];
    if (!e) { e = { d: 0, kind: 0, a: null, b: 0 }; this._dl[this._dlLen] = e; }
    e.d = d; e.kind = kind; e.a = a; e.b = b || 0;
    this._dlLen++;
  },

  // ===========================================================================
  //  SKYLINE CACHE (static per theme → rendered once to offscreen canvases)
  // ===========================================================================

  _ensureSkyCache() {
    const key = `${this.W}x${this.H}x${this.dpr}`;
    if (!this._skyCache || this._skyCache.key !== key) {
      this._skyCache = { key, layers: new Map() };
    }
    const cache = this._skyCache;
    const needed = [palette.themeIdx, palette.nextIdx];
    for (const idx of needed) {
      if (cache.layers.has(idx)) continue;
      // bound cache size (themes change slowly; drop anything not needed)
      if (cache.layers.size > 4) {
        for (const k of Array.from(cache.layers.keys())) {
          if (!needed.includes(k)) cache.layers.delete(k);
        }
      }
      cache.layers.set(idx, [
        this._paintRidgeLayer(THEMES[idx], 1),
        this._paintRidgeLayer(THEMES[idx], 2)
      ]);
    }
  },

  _paintRidgeLayer(theme, layer) {
    const W = this.W, HOR = this.HOR, H = this.H;
    const cnv = document.createElement('canvas');
    const d = Math.min(this.dpr, 1.5);
    cnv.width = Math.round(W * d);
    cnv.height = Math.round((HOR + H * 0.16) * d);
    const ctx = cnv.getContext('2d');
    ctx.setTransform(d, 0, 0, d, 0, 0);

    const col = layer === 1 ? theme.ridgeFar : theme.ridgeNear;
    const hF = theme.ridgeH * (layer === 1 ? 1 : 0.62);
    const seed = layer * 2;

    ctx.fillStyle = rgbCss(col);
    ctx.beginPath();
    ctx.moveTo(0, HOR + 1);
    if (theme.ridgeType === 'city') {
      const blds = [];
      let x = 0, i = 0;
      while (x < W) {
        const bw = Math.max(10, (34 + ((i * 53 + seed * 97) % 46)) * (W / 900));
        const bh = H * hF * (0.35 + ((i * 7919 + seed * 104729) % 1000) / 1000 * 0.65);
        blds.push({ x, bw, bh, i });
        ctx.lineTo(x, HOR - bh);
        ctx.lineTo(x + bw, HOR - bh);
        x += bw + 2;
        i++;
      }
      ctx.lineTo(W, HOR + 1);
      ctx.fill();
      // lit windows (night-ish themes) — baked once, free per frame
      const winA = clamp((0.6 - theme.light) * 2.2, 0, 1);
      if (winA > 0.05) {
        for (const b of blds) {
          const cols = Math.max(1, Math.floor(b.bw / 10));
          const rows = Math.min(7, Math.max(1, Math.floor(b.bh / 12)));
          for (let cx2 = 0; cx2 < cols; cx2++) {
            for (let ry = 0; ry < rows; ry++) {
              if (((cx2 * 31 + ry * 17 + b.i * 7) % 5) < 2) continue;
              ctx.fillStyle = `rgba(255,224,140,${winA * 0.7})`;
              ctx.fillRect(b.x + 3 + cx2 * 10, HOR - b.bh + 4 + ry * 12, 3, 4);
            }
          }
        }
      }
      // neon signage strips
      if (theme.neon > 0.3) {
        for (const b of blds) {
          if (b.i % 3 !== 0) continue;
          const nc = (b.i % 2) ? theme.neonA : theme.neonB;
          ctx.fillStyle = rgbCss(nc, 0.6 * theme.neon);
          ctx.fillRect(b.x + 2, HOR - b.bh * 0.55, b.bw - 4, 3);
          if (b.i % 6 === 0) {
            ctx.fillStyle = rgbCss(nc, 0.22 * theme.neon);
            ctx.fillRect(b.x + 2, HOR - b.bh * 0.55 - 4, b.bw - 4, 11);
          }
        }
      }
    } else if (theme.ridgeType === 'dunes') {
      for (let x = 0; x <= W; x += 14) {
        ctx.lineTo(x, HOR - (Math.sin(x * 0.003 + seed) * 0.5 + 0.5) * H * hF - Math.sin(x * 0.011 + seed * 3) * H * 0.008);
      }
      ctx.lineTo(W, HOR + 1);
      ctx.fill();
    } else {
      for (let x = 0; x <= W; x += 12) {
        ctx.lineTo(x, HOR - (Math.sin(x * 0.004 + seed) * 0.5 + 0.5) * H * hF - Math.sin(x * 0.013 + seed) * H * 0.012);
      }
      ctx.lineTo(W, HOR + 1);
      ctx.fill();
    }
    return cnv;
  },

  // ===========================================================================
  //  MAIN FRAME
  // ===========================================================================
  // scene: { state, tNow, dist, v, boost, zoom, slowBlend, motionOn,
  //          showPlayer, crashT, player:{x,tilt,car,shield,shieldT,invulnT},
  //          traffic[], coins[], pickups[], fx }

  drawFrame(scene) {
    const ctx = this.ctx;
    const fx = scene.fx;
    this._ensureSkyCache();

    ctx.save();
    if (fx.shake > 0) {
      ctx.translate((Math.random() - 0.5) * 22 * fx.shake, (Math.random() - 0.5) * 22 * fx.shake);
    }
    const zoom = scene.zoom > 1.001 ? scene.zoom : 0;
    if (zoom) { // FOV punch anchored at the player → player stays fixed
      ctx.translate(this.CX, this.BOT);
      ctx.scale(zoom, zoom);
      ctx.translate(-this.CX, -this.BOT);
    }

    this._drawSky(scene);
    this._drawRidges();
    this._drawGroundRoad(scene);

    // --- entities, far → near ---
    this._dlLen = 0;
    const dist = scene.dist;
    const lampStep = this.quality === 'low' ? 30 : 18;
    const lampCount = this.quality === 'low' ? 8 : 14;
    for (let k = 0; k < lampCount; k++) {
      const d = k * lampStep - (dist % lampStep);
      if (d > -6) { this._push(d, 0, -1, 0); this._push(d, 0, 1, 0); }
    }
    for (const v of scene.traffic) if (v.d > -6) this._push(v.d, 1, v, 0);
    for (const c of scene.coins) if (c.d > -4) this._push(c.d, 2, c, 0);
    for (const p of scene.pickups) if (p.d > -4) this._push(p.d, 3, p, 0);
    if (scene.showPlayer) this._push(0, 4, scene.player, 0);

    const dl = this._dl;
    for (let i = 1; i < this._dlLen; i++) { // insertion sort — small, nearly ordered
      const e = dl[i];
      let j = i - 1;
      while (j >= 0 && dl[j].d < e.d) { dl[j + 1] = dl[j]; j--; }
      dl[j + 1] = e;
    }
    for (let i = 0; i < this._dlLen; i++) {
      const e = dl[i];
      switch (e.kind) {
        case 0: this._drawLamp(e.a, e.d); break;
        case 1: this._drawTraffic(e.a); break;
        case 2: this._drawCoin(e.a); break;
        case 3: this._drawPickup(e.a); break;
        case 4: this._drawPlayer(scene, e.a); break;
      }
    }

    this._drawSpeedLines(scene);
    this._drawAmbient(scene);
    ctx.restore();

    this._drawParticles(fx);
    this._drawTexts(fx);

    if (fx.flash > 0.01) {
      ctx.fillStyle = `rgba(${fx.flashColor},${(fx.flash * 0.45).toFixed(3)})`;
      ctx.fillRect(0, 0, this.W, this.H);
    }
    if (fx.flashT > 0.01) {
      ctx.globalAlpha = fx.flashT * 0.16;
      ctx.fillStyle = fx.flashColor;
      ctx.fillRect(0, 0, this.W, this.H);
      ctx.globalAlpha = 1;
    }
    if (scene.slowBlend > 0.02) {
      ctx.fillStyle = `rgba(140,255,170,${(scene.slowBlend * 0.05).toFixed(3)})`;
      ctx.fillRect(0, 0, this.W, this.H);
    }
  },

  // --- sky --------------------------------------------------------------------

  _drawSky(scene) {
    const ctx = this.ctx, W = this.W, HOR = this.HOR, H = this.H;
    const p = palette;
    const g = ctx.createLinearGradient(0, 0, 0, HOR);
    g.addColorStop(0, rgbCss(p.sky[0]));
    g.addColorStop(0.55, rgbCss(p.sky[1]));
    g.addColorStop(0.85, rgbCss(p.sky[2]));
    g.addColorStop(1, rgbCss(p.sky[3]));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, HOR + 2);

    if (p.starAlpha > 0.02) {
      ctx.fillStyle = '#fff';
      const t = scene.tNow;
      for (const s of this.stars) {
        ctx.globalAlpha = p.starAlpha * (0.25 + 0.45 * Math.abs(Math.sin(t * 0.8 + s.x)));
        ctx.fillRect(s.x, s.y, s.r, s.r);
      }
      ctx.globalAlpha = 1;
    }

    const idx = p.themeIdx, nidx = p.nextIdx, t = p.t;
    if (THEMES[idx].sunType !== 'none') this._drawSun(THEMES[idx], 1 - t, scene);
    if (t > 0.01 && nidx !== idx && THEMES[nidx].sunType !== 'none') this._drawSun(THEMES[nidx], t, scene);

    // warm horizon glow
    const glow = ctx.createRadialGradient(this.CX, HOR, H * 0.02, this.CX, HOR, H * 0.3);
    glow.addColorStop(0, rgbCss(p.sunGlow, 0.28));
    glow.addColorStop(1, rgbCss(p.sunGlow, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, HOR + H * 0.1);
  },

  _drawSun(theme, alpha, scene) {
    if (alpha <= 0.01) return;
    const ctx = this.ctx;
    const sr = this.H * theme.sunR;
    const sy = this.HOR - sr * theme.sunY;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.rect(0, 0, this.W, this.HOR + 2);
    ctx.clip();
    if (theme.sunType === 'moon') {
      ctx.fillStyle = rgbCss(theme.sunColor);
      ctx.beginPath(); ctx.arc(this.CX, sy, sr, 0, TAU); ctx.fill();
      ctx.fillStyle = rgbCss(theme.sky[1], 0.9);
      ctx.beginPath(); ctx.arc(this.CX + sr * 0.42, sy - sr * 0.18, sr * 0.86, 0, TAU); ctx.fill();
    } else {
      const g = ctx.createLinearGradient(0, sy - sr, 0, sy + sr);
      g.addColorStop(0, rgbCss(theme.sunColor));
      g.addColorStop(1, rgbCss(theme.sunGlow));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(this.CX, sy, sr, 0, TAU); ctx.fill();
      // retro sun bands (v1 signature)
      ctx.fillStyle = rgbCss(theme.sky[2], 0.85);
      for (let i = 0; i < 4; i++) ctx.fillRect(this.CX - sr, sy + sr * (0.15 + i * 0.2), sr * 2, 2 + i * 2);
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  },

  _drawRidges() {
    const ctx = this.ctx;
    const idx = palette.themeIdx, nidx = palette.nextIdx, t = palette.t;
    const cur = this._skyCache.layers.get(idx);
    if (cur) {
      ctx.drawImage(cur[0], 0, 0, this.W, this.HOR + this.H * 0.16);
      ctx.drawImage(cur[1], 0, 0, this.W, this.HOR + this.H * 0.16);
    }
    if (t > 0.01 && nidx !== idx) {
      const nxt = this._skyCache.layers.get(nidx);
      if (nxt) {
        ctx.save();
        ctx.globalAlpha = t;
        ctx.drawImage(nxt[0], 0, 0, this.W, this.HOR + this.H * 0.16);
        ctx.drawImage(nxt[1], 0, 0, this.W, this.HOR + this.H * 0.16);
        ctx.restore();
        ctx.globalAlpha = 1;
      }
    }
  },

  // --- ground + road ----------------------------------------------------------

  _drawGroundRoad(scene) {
    const ctx = this.ctx, W = this.W, H = this.H, HOR = this.HOR, CX = this.CX, LW = this.LW;
    const p = palette;
    const RH = RH_K * LW;
    const dist = scene.dist;

    const groundCss = rgbCss(p.ground);
    ctx.fillStyle = groundCss;
    ctx.fillRect(0, HOR, W, H - HOR);

    const off = dist % 5;
    const base = Math.floor(dist / 5);
    const roadCss = rgbCss(p.road), roadAltCss = rgbCss(p.roadAlt);
    const gndAltCss = rgbCss(p.groundAlt);
    const edgeCss = rgbCss(p.edge), edgeAltCss = rgbCss(p.edgeAlt);
    const laneCss = rgbCss(p.laneLine, 0.9);
    const whiteCss = 'rgba(255,255,255,0.85)';

    for (let i = 70; i >= -1; i--) {
      const d0 = i * 5 - off;
      const yN = this.ys(d0), yF = this.ys(d0 + 5);
      const sN = this.sc(d0), sF = this.sc(d0 + 5);
      const par = (base + i) & 1;

      ctx.fillStyle = par ? gndAltCss : groundCss;
      ctx.fillRect(0, yF, W, yN - yF + 1);

      ctx.fillStyle = par ? roadAltCss : roadCss;
      ctx.beginPath();
      ctx.moveTo(CX - RH * sF, yF); ctx.lineTo(CX + RH * sF, yF);
      ctx.lineTo(CX + RH * sN, yN + 1); ctx.lineTo(CX - RH * sN, yN + 1);
      ctx.fill();

      // edge rumble strips
      const rw = LW * 0.09;
      ctx.fillStyle = par ? edgeCss : edgeAltCss;
      for (const sd of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(CX + sd * RH * sF, yF);
        ctx.lineTo(CX + (sd * RH + sd * rw) * sF, yF);
        ctx.lineTo(CX + (sd * RH + sd * rw) * sN, yN + 1);
        ctx.lineTo(CX + sd * RH * sN, yN + 1);
        ctx.fill();
      }

      // solid white boundary lines
      ctx.fillStyle = whiteCss;
      for (const sd of [-1, 1]) {
        const o1 = sd * (RH - LW * 0.12), o2 = o1 - sd * LW * 0.05;
        ctx.beginPath();
        ctx.moveTo(CX + o1 * sF, yF); ctx.lineTo(CX + o2 * sF, yF);
        ctx.lineTo(CX + o2 * sN, yN + 1); ctx.lineTo(CX + o1 * sN, yN + 1);
        ctx.fill();
      }

      // dashed lane dividers (parity-gated, v1 math)
      if (par) {
        ctx.fillStyle = laneCss;
        for (const sd of [-0.5, 0.5]) {
          const a = sd * LW, b = a + LW * 0.05;
          ctx.beginPath();
          ctx.moveTo(CX + a * sF, yF); ctx.lineTo(CX + b * sF, yF);
          ctx.lineTo(CX + b * sN, yN + 1); ctx.lineTo(CX + a * sN, yN + 1);
          ctx.fill();
        }
      }
    }

    // nitro road motion streaks
    if (scene.boost > 0.05 && scene.motionOn) {
      ctx.strokeStyle = `rgba(200,235,255,${(0.12 * scene.boost).toFixed(3)})`;
      ctx.lineWidth = 2;
      for (let k = 0; k < 6; k++) {
        const laneX = -1.45 + k * 0.58;
        const dA = 420 - ((dist * 3 + k * 90) % 420);
        const dB = dA + 26;
        if (dA < 3) continue;
        const y1 = this.ys(dA), y2 = this.ys(dB);
        const lx1 = CX + laneX * LW * this.sc(dA);
        const lx2 = CX + laneX * LW * this.sc(dB);
        ctx.beginPath(); ctx.moveTo(lx1, y1); ctx.lineTo(lx2, y2); ctx.stroke();
      }
    }

    // horizon haze
    const hz = ctx.createLinearGradient(0, HOR - 6, 0, HOR + H * 0.08);
    hz.addColorStop(0, rgbCss(p.haze, p.hazeA));
    hz.addColorStop(1, rgbCss(p.haze, 0));
    ctx.fillStyle = hz;
    ctx.fillRect(0, HOR - 6, W, H * 0.09);
  },

  // --- lamps -------------------------------------------------------------------

  _drawLamp(side, d) {
    const ctx = this.ctx, LW = this.LW, CX = this.CX;
    const s = this.sc(d);
    const x = CX + side * (RH_K * LW + LW * 0.38) * s;
    const y = this.ys(d);
    const hgt = LW * 1.7 * s;
    const glow = palette.lampGlow;

    ctx.strokeStyle = '#1a1530';
    ctx.lineWidth = Math.max(1, LW * 0.045 * s);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y - hgt);
    ctx.lineTo(x - side * LW * 0.28 * s, y - hgt - LW * 0.05 * s);
    ctx.stroke();

    const lx = x - side * LW * 0.28 * s;
    const ly = y - hgt - LW * 0.05 * s;
    const r = LW * 0.2 * s;

    if (glow > 0.05 && r > 0.8) {
      const g = ctx.createRadialGradient(lx, ly, 0, lx, ly, r * 2.2);
      g.addColorStop(0, `rgba(255,214,120,${(0.9 * clamp(glow, 0, 1.4)).toFixed(3)})`);
      g.addColorStop(1, 'rgba(255,214,120,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(lx, ly, r * 2.2, 0, TAU); ctx.fill();
    }
    ctx.fillStyle = '#fff3c8';
    ctx.beginPath(); ctx.arc(lx, ly, Math.max(1, r * 0.32), 0, TAU); ctx.fill();

    if (glow > 0.6 && d < 150 && this.quality !== 'low') {
      const px2 = x - side * LW * 0.5 * s;
      const pg = ctx.createRadialGradient(px2, y, 0, px2, y, LW * 1.1 * s);
      pg.addColorStop(0, `rgba(255,214,140,${(0.10 * glow).toFixed(3)})`);
      pg.addColorStop(1, 'rgba(255,214,140,0)');
      ctx.fillStyle = pg;
      ctx.beginPath();
      ctx.ellipse(px2, y, LW * 1.1 * s, LW * 0.24 * s, 0, 0, TAU);
      ctx.fill();
    }
  },

  // --- traffic -------------------------------------------------------------------

  _drawTraffic(v) {
    const ctx = this.ctx;
    const s = this.sc(v.d);
    const x = this.CX + v.x * this.LW * s;
    const y = this.ys(v.d);
    ctx.globalAlpha = clamp(v.alpha, 0, 1);
    this.drawVehicle(x, y, s, v.shape, v.col, {
      blink: (v.phase === 'signal' || v.phase === 'move') ? v.blinkSide : 0,
      blinkT: v.blinkT
    });
    ctx.globalAlpha = 1;
  },

  drawVehicle(x, y, s, shape, col, opts = {}) {
    const ctx = this.ctx, LW = this.LW;
    const vt = VTYPES[shape] || VTYPES.car;
    const long = (shape === 'truck' || shape === 'bus');
    const w = LW * (long ? 0.78 : vt.w) * s;
    const h = w * (shape === 'truck' ? 1.2 : shape === 'bus' ? 1.7 : shape === 'suv' ? 0.78 : 0.6);

    ctx.save();
    ctx.translate(x, y);

    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.beginPath(); ctx.ellipse(0, 0, w * 0.62, w * 0.12, 0, 0, TAU); ctx.fill();

    ctx.fillStyle = '#0b0b12';
    const wh = long ? h * 0.16 : h * 0.3;
    roundRectPath(ctx, -w * 0.5, -wh, w * 0.17, wh, w * 0.03); ctx.fill();
    roundRectPath(ctx, w * 0.33, -wh, w * 0.17, wh, w * 0.03); ctx.fill();
    if (long) {
      roundRectPath(ctx, -w * 0.5, -h * 0.72, w * 0.17, wh, w * 0.03); ctx.fill();
      roundRectPath(ctx, w * 0.33, -h * 0.72, w * 0.17, wh, w * 0.03); ctx.fill();
    }

    if (shape === 'truck') {
      roundRectPath(ctx, -w / 2, -h, w, h * 0.88, w * 0.04);
      ctx.fillStyle = col.b; ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,0.16)';
      for (let i = 1; i < 6; i++) ctx.fillRect(-w / 2 + i * w / 6 - w * 0.008, -h * 0.96, w * 0.016, h * 0.8);
      ctx.fillStyle = col.d; ctx.fillRect(-w / 2, -h * 0.62, w, h * 0.14);
      ctx.fillStyle = '#14141c'; ctx.fillRect(-w * 0.5, -h * 0.16, w, h * 0.1);
    } else if (shape === 'bus') {
      roundRectPath(ctx, -w / 2, -h, w, h * 0.94, w * 0.06);
      ctx.fillStyle = col.b; ctx.fill();
      ctx.fillStyle = '#101826';
      roundRectPath(ctx, -w * 0.4, -h * 0.92, w * 0.8, h * 0.62, w * 0.04); ctx.fill();
      ctx.fillStyle = 'rgba(160,200,255,0.22)';
      for (let i = 0; i < 5; i++) ctx.fillRect(-w * 0.36 + i * w * 0.155, -h * 0.88, w * 0.11, h * 0.54);
      ctx.fillStyle = col.d; ctx.fillRect(-w / 2, -h * 0.24, w, h * 0.09);
    } else {
      const cabTop = shape === 'suv' ? -h * 1.02 : shape === 'sport' ? -h * 0.86 : -h * 0.98;
      roundRectPath(ctx, -w / 2, -h * 0.62, w, h * 0.5, w * 0.09);
      ctx.fillStyle = col.b; ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-w * 0.4, -h * 0.6);
      ctx.lineTo(-w * 0.29, cabTop);
      ctx.lineTo(w * 0.29, cabTop);
      ctx.lineTo(w * 0.4, -h * 0.6);
      ctx.closePath();
      ctx.fillStyle = col.d; ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-w * 0.33, -h * 0.64);
      ctx.lineTo(-w * 0.24, cabTop * 0.96);
      ctx.lineTo(w * 0.24, cabTop * 0.96);
      ctx.lineTo(w * 0.33, -h * 0.64);
      ctx.closePath();
      ctx.fillStyle = '#0d1424'; ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-w * 0.33, -h * 0.64);
      ctx.lineTo(-w * 0.24, cabTop * 0.96);
      ctx.lineTo(-w * 0.04, cabTop * 0.96);
      ctx.lineTo(-w * 0.15, -h * 0.64);
      ctx.closePath();
      ctx.fillStyle = 'rgba(255,255,255,0.10)'; ctx.fill();
      ctx.fillStyle = '#14141c';
      roundRectPath(ctx, -w * 0.5, -h * 0.22, w, h * 0.12, w * 0.03); ctx.fill();

      if (shape === 'suv') {
        ctx.fillStyle = '#22222c';
        ctx.fillRect(-w * 0.32, cabTop - w * 0.02, w * 0.06, h * 0.4);
        ctx.fillRect(w * 0.26, cabTop - w * 0.02, w * 0.06, h * 0.4);
      }
      if (shape === 'sport') {
        ctx.fillStyle = '#181820';
        roundRectPath(ctx, -w * 0.46, -h * 0.34, w * 0.92, h * 0.07, w * 0.02); ctx.fill();
        ctx.fillRect(-w * 0.36, -h * 0.3, w * 0.05, h * 0.1);
        ctx.fillRect(w * 0.31, -h * 0.3, w * 0.05, h * 0.1);
      }
      if (shape === 'changer') {
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.fillRect(-w * 0.05, -h * 0.6, w * 0.1, h * 0.42);
      }
    }

    // tail lights
    const ty = long ? -h * (shape === 'bus' ? 0.1 : 0.36) : -h * 0.5;
    const th = long ? h * 0.08 : h * 0.12;
    if (s > 0.25 && this.quality !== 'low') { ctx.shadowBlur = 14 * s; ctx.shadowColor = '#ff2d3d'; }
    ctx.fillStyle = '#ff2d3d';
    roundRectPath(ctx, -w * 0.46, ty, w * 0.24, th, w * 0.02); ctx.fill();
    roundRectPath(ctx, w * 0.22, ty, w * 0.24, th, w * 0.02); ctx.fill();
    ctx.shadowBlur = 0;

    // faint headlight spill (traffic faces away)
    if (palette.headlights && s > 0.35 && !long && this.quality !== 'low') {
      const g = ctx.createRadialGradient(0, -h * 1.15, 0, 0, -h * 1.15, w * 0.8);
      g.addColorStop(0, 'rgba(255,244,214,0.14)');
      g.addColorStop(1, 'rgba(255,244,214,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.ellipse(0, -h * 1.15, w * 0.8, w * 0.34, 0, 0, TAU); ctx.fill();
    }

    // lane-change blinker
    if (opts.blink) {
      const on = Math.floor(performance.now() * 0.007) % 2 === 0;
      if (on) {
        ctx.fillStyle = '#ffb02e';
        if (s > 0.2 && this.quality !== 'low') { ctx.shadowBlur = 10 * s; ctx.shadowColor = '#ffb02e'; }
        const bx = opts.blink > 0 ? w * 0.4 : -w * 0.5;
        roundRectPath(ctx, bx, -h * 0.52, w * 0.12, h * 0.09, w * 0.02); ctx.fill();
        ctx.shadowBlur = 0;
      }
    }
    ctx.restore();
  },

  // --- player -------------------------------------------------------------------

  _drawPlayer(scene, pl) {
    const ctx = this.ctx;
    const x = this.CX + pl.x * this.LW;
    const y = this.BOT;
    if (pl.invulnT > 0 && Math.floor(scene.tNow * 14) % 2 === 0) ctx.globalAlpha = 0.55;
    this.drawPlayerCar(x, y, 1, pl.car, {
      tilt: pl.tilt + (scene.state === 'crash' ? Math.sin(scene.crashT * 30) * 0.1 : 0),
      boost: scene.boost,
      shield: pl.shield,
      headlights: palette.headlights,
      tNow: scene.tNow
    });
    ctx.globalAlpha = 1;
  },

  drawPlayerCar(x, y, s, car, opts = {}) {
    const ctx = this.ctx, LW = this.LW;
    const look = car.look;
    const shape = look.shape;
    const w = LW * (shape === 'suv' ? 0.68 : 0.62) * s;
    const h = w * (shape === 'suv' ? 0.78 : 0.6);
    const tNow = opts.tNow || 0;

    ctx.save();
    ctx.translate(x, y);

    // hero underglow (v1 cyan pool → tinted per car)
    const g = ctx.createRadialGradient(0, 0, 2, 0, 0, w * 0.85);
    g.addColorStop(0, look.glow + '0.55)');
    g.addColorStop(1, look.glow + '0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.ellipse(0, 0, w * 0.85, w * 0.22, 0, 0, TAU); ctx.fill();

    // nitro flames
    if (opts.boost > 0.05) {
      const fl = opts.boost;
      for (const fxo of [-0.26, 0.26]) {
        const len = w * (0.5 + 0.55 * fl) * (0.8 + Math.random() * 0.4);
        const fg = ctx.createLinearGradient(0, 0, 0, len);
        fg.addColorStop(0, `rgba(190,240,255,${0.9 * fl})`);
        fg.addColorStop(0.5, `rgba(80,160,255,${0.55 * fl})`);
        fg.addColorStop(1, 'rgba(80,160,255,0)');
        ctx.fillStyle = fg;
        ctx.beginPath();
        ctx.moveTo(fxo * w - w * 0.07, -h * 0.05);
        ctx.lineTo(fxo * w + w * 0.07, -h * 0.05);
        ctx.lineTo(fxo * w, len * 0.8);
        ctx.closePath();
        ctx.fill();
      }
    }

    ctx.rotate(opts.tilt || 0);

    // wheels
    ctx.fillStyle = '#0b0b12';
    const wh = h * 0.3;
    roundRectPath(ctx, -w * 0.5, -wh, w * 0.17, wh, w * 0.03); ctx.fill();
    roundRectPath(ctx, w * 0.33, -wh, w * 0.17, wh, w * 0.03); ctx.fill();

    const cabTop = shape === 'sport' ? -h * 0.86 : shape === 'suv' ? -h * 1.06 : shape === 'ev' ? -h * 0.94 : -h;
    roundRectPath(ctx, -w / 2, -h * 0.62, w, h * 0.5, w * 0.09);
    ctx.fillStyle = look.body; ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-w * 0.4, -h * 0.6);
    ctx.lineTo(-w * 0.29, cabTop);
    ctx.lineTo(w * 0.29, cabTop);
    ctx.lineTo(w * 0.4, -h * 0.6);
    ctx.closePath();
    ctx.fillStyle = look.dark; ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-w * 0.33, -h * 0.64);
    ctx.lineTo(-w * 0.24, cabTop * 0.94);
    ctx.lineTo(w * 0.24, cabTop * 0.94);
    ctx.lineTo(w * 0.33, -h * 0.64);
    ctx.closePath();
    ctx.fillStyle = '#0d1424'; ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-w * 0.33, -h * 0.64);
    ctx.lineTo(-w * 0.24, cabTop * 0.94);
    ctx.lineTo(-w * 0.04, cabTop * 0.94);
    ctx.lineTo(-w * 0.15, -h * 0.64);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,0.10)'; ctx.fill();
    ctx.fillStyle = '#14141c';
    roundRectPath(ctx, -w * 0.5, -h * 0.22, w, h * 0.12, w * 0.03); ctx.fill();

    // liveries
    ctx.fillStyle = look.accent;
    ctx.globalAlpha = 0.9;
    if (shape === 'coupe' || shape === 'gt') {
      ctx.fillRect(-w * 0.06, -h * 0.62, w * 0.12, h * 0.4);
    } else if (shape === 'muscle') {
      ctx.fillRect(-w * 0.16, -h * 0.62, w * 0.09, h * 0.4);
      ctx.fillRect(w * 0.07, -h * 0.62, w * 0.09, h * 0.4);
    }
    ctx.globalAlpha = 1;

    if (shape === 'coupe') {
      ctx.fillStyle = look.dark;
      ctx.fillRect(-w * 0.4, cabTop * 0.98, w * 0.05, h * 0.4);
      ctx.fillRect(w * 0.35, cabTop * 0.98, w * 0.05, h * 0.4);
    }
    if (shape === 'coupe' || shape === 'suv') {
      roundRectPath(ctx, -w * 0.5, cabTop - h * 0.06, w, h * 0.1, w * 0.02);
      ctx.fillStyle = shape === 'coupe' ? '#0a3d4a' : '#3a3325'; ctx.fill();
    }
    if (shape === 'ev' || shape === 'gt') {
      ctx.fillStyle = look.glow + (0.55 + 0.3 * Math.sin(tNow * 3)).toFixed(3) + ')';
      ctx.fillRect(-w * 0.42, -h * 0.6, w * 0.84, h * 0.035);
    }
    if (shape === 'sport' || shape === 'muscle') {
      ctx.fillStyle = '#181820';
      const wy = -h * (shape === 'sport' ? 0.4 : 0.34);
      roundRectPath(ctx, -w * 0.5, wy, w, h * 0.08, w * 0.02); ctx.fill();
      ctx.fillRect(-w * 0.38, wy + h * 0.06, w * 0.06, h * 0.1);
      ctx.fillRect(w * 0.32, wy + h * 0.06, w * 0.06, h * 0.1);
    }
    ctx.fillStyle = '#e8f6ff';
    roundRectPath(ctx, -w * 0.1, -h * 0.2, w * 0.2, h * 0.08, 2); ctx.fill();

    // tail lights
    if (s > 0.25 && this.quality !== 'low') { ctx.shadowBlur = 14 * s; ctx.shadowColor = '#ff2d3d'; }
    ctx.fillStyle = '#ff2d3d';
    roundRectPath(ctx, -w * 0.46, -h * 0.5, w * 0.24, h * 0.12, w * 0.02); ctx.fill();
    roundRectPath(ctx, w * 0.22, -h * 0.5, w * 0.24, h * 0.12, w * 0.02); ctx.fill();
    ctx.shadowBlur = 0;

    if (opts.headlights) {
      const hg = ctx.createRadialGradient(0, -h * 1.5, 0, 0, -h * 1.5, w * 1.5);
      hg.addColorStop(0, 'rgba(255,246,220,0.28)');
      hg.addColorStop(1, 'rgba(255,246,220,0)');
      ctx.fillStyle = hg;
      ctx.beginPath(); ctx.ellipse(0, -h * 1.5, w * 1.5, w * 0.66, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = '#fff8e0';
      ctx.beginPath(); ctx.arc(-w * 0.32, cabTop * 0.9, w * 0.045, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.arc(w * 0.32, cabTop * 0.9, w * 0.045, 0, TAU); ctx.fill();
    }

    ctx.restore();

    if (opts.shield) {
      const pulse = 0.5 + 0.25 * Math.sin(tNow * 5);
      ctx.save();
      ctx.translate(x, y - h * 0.4);
      const r = w * 0.95;
      const bg = ctx.createRadialGradient(0, 0, r * 0.6, 0, 0, r);
      bg.addColorStop(0, 'rgba(92,200,255,0)');
      bg.addColorStop(0.85, `rgba(92,200,255,${(0.10 + 0.06 * pulse).toFixed(3)})`);
      bg.addColorStop(1, `rgba(140,220,255,${(0.34 + 0.12 * pulse).toFixed(3)})`);
      ctx.fillStyle = bg;
      ctx.beginPath(); ctx.ellipse(0, 0, r, r * 0.86, 0, 0, TAU); ctx.fill();
      ctx.strokeStyle = `rgba(160,225,255,${(0.5 + 0.2 * pulse).toFixed(3)})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.ellipse(0, 0, r, r * 0.86, 0, 0, TAU); ctx.stroke();
      ctx.restore();
    }
  },

  // --- coins & powerups ------------------------------------------------------------

  _drawCoin(c) {
    const ctx = this.ctx;
    const s = this.sc(c.d);
    const x = this.CX + c.x * this.LW * s;
    const y = this.ys(c.d) - this.LW * 0.18 * s;
    const r = this.LW * 0.15 * s;
    if (r < 0.7) return;
    const sq = Math.abs(Math.cos(c.spin));

    if (this.quality !== 'low') {
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = '#ffcd50';
      ctx.beginPath(); ctx.arc(x, y, r * 2.1, 0, TAU); ctx.fill();
      ctx.globalAlpha = 1;
    }

    ctx.save();
    ctx.translate(x, y);
    ctx.scale(Math.max(0.12, sq), 1);
    const cg = ctx.createLinearGradient(0, -r, 0, r);
    cg.addColorStop(0, '#ffe98a');
    cg.addColorStop(0.5, '#ffc531');
    cg.addColorStop(1, '#e08a00');
    ctx.fillStyle = cg;
    ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(140,80,0,0.65)';
    ctx.lineWidth = Math.max(0.7, r * 0.14);
    ctx.beginPath(); ctx.arc(0, 0, r * 0.72, 0, TAU); ctx.stroke();
    if (sq > 0.55 && r > 7) {
      ctx.fillStyle = 'rgba(255,250,220,0.9)';
      ctx.font = `${Math.round(r * 1.1)}px "Big Shoulders Display", Impact, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('$', 0, r * 0.06);
    }
    ctx.restore();
  },

  _drawPickup(p) {
    const ctx = this.ctx;
    const s = this.sc(p.d);
    const x = this.CX + p.x * this.LW * s;
    const bob = Math.sin(p.bob) * this.LW * 0.05 * s;
    const y = this.ys(p.d) - this.LW * 0.34 * s + bob;
    const r = this.LW * 0.2 * s;
    if (r < 1.2) return;
    const info = POWERUP_INFO[p.type];

    ctx.globalAlpha = 0.35;
    ctx.fillStyle = info.color;
    ctx.beginPath(); ctx.arc(x, y, r * 2.1, 0, TAU); ctx.fill();
    ctx.globalAlpha = 1;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.sin(p.bob * 0.7) * 0.14);
    ctx.fillStyle = 'rgba(10,10,24,0.88)';
    roundRectPath(ctx, -r, -r, r * 2, r * 2, r * 0.4); ctx.fill();
    ctx.strokeStyle = info.color;
    ctx.lineWidth = Math.max(1, r * 0.14);
    roundRectPath(ctx, -r, -r, r * 2, r * 2, r * 0.4); ctx.stroke();
    if (r > 6) {
      ctx.font = `${Math.round(r * 1.15)}px sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(info.icon, 0, r * 0.08);
    }
    ctx.restore();
  },

  // --- post effects ---------------------------------------------------------------

  _drawSpeedLines(scene) {
    if (!scene.motionOn) return;
    const ctx = this.ctx;
    const boost = scene.boost || 0;
    const a = Math.max(0, (scene.v - 55) / 60) + boost * 0.5;
    if (a <= 0.02) return;
    ctx.lineWidth = 2;
    for (const st of scene.fx.streaks) {
      const r0 = st.p * st.p * this.W * 0.8;
      const r1 = r0 + st.p * this.W * 0.12;
      ctx.strokeStyle = `rgba(255,255,255,${(0.1 * a * st.p).toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(this.CX + Math.cos(st.a) * r0, this.HOR + Math.sin(st.a) * r0 * 0.6);
      ctx.lineTo(this.CX + Math.cos(st.a) * r1, this.HOR + Math.sin(st.a) * r1 * 0.6);
      ctx.stroke();
    }
  },

  _drawAmbient(scene) {
    const type = palette.ambient;
    if (type === 'none' || this.quality === 'low' || !scene.motionOn) return;
    const ctx = this.ctx;
    const col = palette.ambientColor;
    const n = this.quality === 'high' ? scene.fx.ambient.length : (scene.fx.ambient.length >> 1);
    ctx.fillStyle = rgbCss(col, type === 'rain' ? 0.28 : 0.5);
    for (let i = 0; i < n; i++) {
      const m = scene.fx.ambient[i];
      const x = m.x * this.W, y = m.y * this.H;
      if (type === 'rain') {
        ctx.fillRect(x, y, 1.2, 9 * m.s);
      } else if (type === 'fireflies') {
        ctx.globalAlpha = 0.25 + 0.5 * Math.abs(Math.sin(m.ph * 1.7));
        ctx.fillRect(x, y, 2 * m.s, 2 * m.s);
        ctx.globalAlpha = 1;
      } else {
        ctx.globalAlpha = 0.26;
        ctx.fillRect(x, y, 1.8 * m.s, 1.8 * m.s);
        ctx.globalAlpha = 1;
      }
    }
  },

  _drawParticles(fx) {
    const ctx = this.ctx;
    for (const p of fx.particles.active) {
      const k = p.life / p.max;
      ctx.globalAlpha = (p.smoke ? 0.5 * (1 - k) : 1 - k);
      ctx.fillStyle = p.c;
      if (p.glow && this.quality !== 'low') {
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 2.6);
        g.addColorStop(0, p.c);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 2.6 * (1 - k * 0.4), 0, TAU); ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.smoke ? p.r * (1 + k * 1.5) : p.r * (1 - k * 0.5), 0, TAU);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  },

  _drawTexts(fx) {
    const ctx = this.ctx;
    for (const t of fx.texts.active) {
      const k = t.life / t.max;
      ctx.globalAlpha = k < 0.15 ? k / 0.15 : (1 - Math.max(0, k - 0.6) / 0.4);
      ctx.font = `${t.weight} ${t.size}px "Big Shoulders Display", Impact, sans-serif`;
      ctx.textAlign = t.align;
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(5,5,15,0.75)';
      ctx.strokeText(t.text, t.x, t.y);
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, t.x, t.y);
    }
    ctx.globalAlpha = 1;
  },

  // ===========================================================================
  //  GARAGE PREVIEW (separate small canvas)
  // ===========================================================================

  drawCarPreview(pctx, w, h, car, t) {
    pctx.clearRect(0, 0, w, h);
    const bg = pctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#171031');
    bg.addColorStop(1, '#0c0818');
    pctx.fillStyle = bg;
    pctx.fillRect(0, 0, w, h);

    pctx.strokeStyle = 'rgba(120,90,255,0.22)';
    pctx.lineWidth = 1;
    for (let i = 1; i < 7; i++) {
      const y = h * 0.62 + i * i * h * 0.011;
      pctx.beginPath(); pctx.moveTo(0, y); pctx.lineTo(w, y); pctx.stroke();
    }
    for (let i = -6; i <= 6; i++) {
      pctx.beginPath();
      pctx.moveTo(w / 2 + i * w * 0.045, h * 0.62);
      pctx.lineTo(w / 2 + i * w * 0.2, h);
      pctx.stroke();
    }

    const pulse = 0.5 + 0.5 * Math.sin(t * 2);
    const g = pctx.createRadialGradient(w / 2, h * 0.74, 4, w / 2, h * 0.74, w * 0.45);
    g.addColorStop(0, car.look.glow + (0.30 + 0.12 * pulse).toFixed(3) + ')');
    g.addColorStop(1, car.look.glow + '0)');
    pctx.fillStyle = g;
    pctx.beginPath(); pctx.ellipse(w / 2, h * 0.74, w * 0.42, h * 0.14, 0, 0, TAU); pctx.fill();

    // temporarily swap context + LW so the shared painter can be reused
    const savedLW = this.LW, savedCtx = this.ctx, savedQ = this.quality;
    this.LW = w * 0.52;
    this.ctx = pctx;
    this.quality = 'high';
    this.drawPlayerCar(w / 2, h * 0.74 + Math.sin(t * 1.6) * h * 0.012, 1, car, {
      tilt: Math.sin(t * 1.1) * 0.03,
      boost: 0,
      shield: false,
      headlights: true,
      tNow: t
    });
    this.ctx = savedCtx;
    this.LW = savedLW;
    this.quality = savedQ;
  }
};

export default R;
