# DUSKRUNNER V2

Endless highway racer — a fully modular, dependency-free upgrade of the original
single-file DUSKRUNNER. Canvas rendering, vanilla ES modules, WebAudio synthesis,
localStorage persistence. Designed for static hosting (Render, Netlify, GitHub Pages…).

---

## Run it locally

ES modules **do not load over `file://`** — always serve the folder over HTTP:

```bash
cd duskrunner
python3 -m http.server 8000        # or: npx serve, php -S localhost:8000, …
# open http://localhost:8000
```

Any static file server works. There is **no build step and no `package.json`** —
the `js/` tree is shipped as-is.

## Deploy to Render

1. Create a **Static Site** in Render.
2. Point it at the repo/folder that contains `index.html` (set *Root Directory*
   to `duskrunner` if the repo holds more than the game).
3. Build command: *(leave empty)*. Publish directory: the game folder itself.
4. Done — every asset is static; no server process, no env vars required.

Notes:
- Google Fonts (Barlow / Big Shoulders Display) are loaded from the CDN with
  system-font fallbacks; the game is fully playable offline/without them.
- All progress is **local-only** (browser `localStorage`). Nothing is sent anywhere.

## Controls

| Action            | Desktop                     | Mobile                          |
|-------------------|-----------------------------|---------------------------------|
| Steer left/right  | `←`/`A`, `→`/`D`            | swipe, tap screen side, or ◀ ▶ buttons |
| Nitro             | hold `SPACE`                | hold the NITRO button           |
| Accelerate/brake  | hold `W` / `S` (optional)   | —                               |
| Pause             | `P` or `ESC`                | ⏸ button                        |

Touch control style (buttons / swipe / both) is configurable in **Settings**.

## Architecture

```
index.html          DOM shell: canvas, HUD, 11 UI panels, touch controls
css/style.css       dark glassmorphism / neon design system, responsive rules
js/
  game.js           orchestrator: state machine, rAF loop, scoring, run payout
  player.js         car physics, lanes, cruise curve (identical feel to v1)
  traffic.js        6 AI archetypes, car-following, lane changers, fairness pass
  coins.js          pickup patterns + traffic-aware placement (never inside cars)
  powerups.js       Shield / Magnet / Slow-Mo / Nitro pickups + active effects
  nitro.js          tank, drain/regen, lockout, boost curve
  environments.js   5 distance themes, smooth interpolated sky/light/fog blends
  render.js         perspective projection, world + car drawing, cached skylines
  effects.js        pooled particles, shake, flash, floating texts
  audio.js          WebAudio synth (engine pitch, 15 SFX, music), autoplay-safe
  controls.js       keyboard + pointer/swipe/on-screen buttons, registered once
  ui.js             screens, HUD, garage, toasts, settings — bindings once
  storage.js        versioned save `duskrunner_save_v2`, corruption-safe
  garage.js         6 original cars + 4 upgrade tracks (data & physics math)
  missions.js / achievements.js / leaderboard.js / daily.js
  util.js           math, RNG, color helpers, object Pool
```

Design rules honoured throughout: object pooling for cars/coins/particles/texts,
delta-time movement everywhere, capped particle counts, diffed 10 Hz HUD updates
(no per-frame DOM churn), every listener registered exactly once, and the rAF
loop is wrapped in a safety net so an unexpected exception can never freeze the
game again.

## Save data

Single versioned key **`duskrunner_save_v2`**:

```jsonc
{
  "v": 2,
  "coins": 0,
  "selectedCar": "vortex",
  "unlockedCars": ["vortex"],
  "upgrades":  { "<carId>": { "engine": 0, "tires": 0, "turbo": 0, "nitro": 0 } },
  "settings":  { "sfx": true, "music": true, "volume": 0.8, "quality": "auto",
                 "shake": true, "particles": true, "motion": true,
                 "touchControls": "both" },
  "stats":     { "runs": 0, "distance": 0, "coins": 0, "nearMisses": 0, … },
  "missions":  { "progress": {}, "claimed": [] },
  "achievements": [],
  "highScores":  { "endless": 0, "time60": 0, "time90": 0, "daily": 0 },
  "leaderboard": { "endless": [], "time60": [], "time90": [], "daily": [] },
  "daily":     { "date": "", "bestScore": 0, "completed": false }
}
```

Invalid/missing/corrupted JSON is normalised to defaults on boot; the legacy v1
`duskrunner_best` value is migrated into stats/high score once.

## Leaderboard → FastAPI later

`js/leaderboard.js` exposes an async facade (`submitScore`, `fetchBoard`,
`getHighScore`) that currently reads/writes the local save. To go online, swap
the two functions for `fetch()` calls to a FastAPI service — **and validate
scores server-side** (rate limits, sanity caps on score/distance per run time,
server-authoritative daily seeds). Never trust client-submitted scores; the
local board exists only as an offline fallback.

## Testing

- Logic/unit suite (storage, garage math, fairness sims, environment blending,
  daily determinism, pool bounds): `node test-suite/test.mjs` style — the suite
  lives outside the shipped folder during development and imports the real
  modules from `js/`.
- Headless E2E (Puppeteer): boot, attract mode, inputs, nitro, near-miss, coin
  pickup, shield absorb → crash → game over → retry, pause/resume, every screen,
  garage economy incl. MAXED cap, settings persistence, time attack countdown,
  daily determinism, corrupted/legacy/empty storage, resize + orientation
  changes, mobile touch/swipe/buttons, console hygiene, FPS and pool bounds.

## Known limitations

- Leaderboard is local-only by design (see FastAPI note above).
- Daily challenge results are stored per device; no cross-device sync or login.
- Weather effects are limited to per-theme fog/light (no rain particles yet).
- Emoji glyphs (🪙 🛡 ⚡ …) depend on the OS emoji font; on systems without one
  they degrade to placeholder boxes but never affect gameplay.
