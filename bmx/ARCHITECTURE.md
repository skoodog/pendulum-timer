# MIRRA CITY — Architecture & Module Contracts

A third-person BMX freestyle game in Three.js (r185, ES modules, Vite).
Design target: Dave Mirra Freestyle BMX 2 / Tony Hawk's Pro Skater 3 gameplay feel,
rendered at a modern AAA visual bar.

## Hard rules for every module

1. **Zero network assets.** No CDN, no image/GLTF/audio downloads. Every texture is
   generated procedurally (canvas 2D / DataTexture / shaders), every mesh is built
   from Three.js geometry, all audio is synthesized with WebAudio. The game must run
   fully offline from `dist/`.
2. **One module owns its file(s).** Never edit a file you do not own — cross-module
   changes go through the contracts below.
3. `import * as THREE from 'three'` and `import { X } from 'three/addons/...'` only.
4. No `console.log` spam in the frame loop. No `alert`. No blocking work > 8 ms per
   frame after init; heavy generation happens once at load.
5. Everything is deterministic: use `rng()` from `src/core/mathx.js`, never `Math.random()`.
6. Budget: keep the whole park under ~600 draw calls and ~1.5 M triangles. Use
   `InstancedMesh` for repeated props, merge static geometry, share materials.
7. 60 fps at 1600×900 on a mid GPU is a requirement, not a goal.

## Shared context object

`main.js` builds a single `ctx` and passes it everywhere:

```js
ctx = {
  engine,        // Engine (src/core/engine.js)
  scene,         // THREE.Scene
  renderer,      // THREE.WebGLRenderer
  camera,        // THREE.PerspectiveCamera
  input,         // Input (src/core/input.js)
  time: { elapsed, dt, fixedDt, frame },
  world,         // { park, collision, environment }
  player,        // { object3D, physics, bike, anim, tricks, grind, scoring }
  fx, audio, hud, screens,
  debug: { enabled, draw(...) },
}
```

## Lifecycle

Every system exposes:

```js
export function createX(ctx) -> instance          // build meshes/state, may be async
instance.fixedUpdate(fdt, ctx)                     // 120 Hz, physics/gameplay only
instance.update(dt, ctx)                           // once per frame, visuals/audio
instance.dispose()
```

`main.js` order per frame:
`input.poll()` → N× `fixedUpdate` (physics → grind → tricks → scoring) →
`update` (anim → camera → fx → audio → hud) → `engine.render()`.

## Module contracts

### `src/core/engine.js` (OWNED: spine — do not rewrite)
Renderer, PMREM env, post-processing chain, quality tiers, `render()`.
Exposes `engine.composer`, `engine.setQuality(tier)`, `engine.registerResize(fn)`,
`engine.sunLight`, `engine.envScene`.

### `src/core/input.js` (OWNED: spine)
`input.state = { steer, throttle, brake, hop, spin, grind, tweak[8], look:{x,y}, ... }`
Edge helpers: `input.pressed(name)`, `input.released(name)`, `input.held(name)`,
`input.bufferedIn(name, ms)`. Keyboard + Gamepad, remappable.

### `src/world/materials.js` — MaterialLibrary
```js
createMaterials(renderer) -> {
  concrete, concreteWorn, asphalt, plywood, skatelite, metalCoping, railSteel,
  paintedMetal, chainlink, brick, glass, grass, dirt, decalAtlas, ...
  get(name), dispose()
}
```
Every material is `MeshStandardMaterial`/`MeshPhysicalMaterial` with, at minimum:
`map`, `normalMap`, `roughnessMap`, `aoMap` generated procedurally at 1024² with
correct `repeat`/`anisotropy` (use `renderer.capabilities.getMaxAnisotropy()`),
`colorSpace = THREE.SRGBColorSpace` on color maps only. Provide triplanar-ish
UV setup helpers for large surfaces so texel density stays ~256 px/m.

### `src/world/environment.js`
Sky (physical sky shader or gradient dome), sun + fill + bounce lights, PMREM
environment from the sky, cascaded-feel shadow setup, exponential height fog,
time-of-day preset (late-afternoon golden hour is the target look), lightmap-ish
ambient occlusion boost. Exposes `environment.setTimeOfDay(t)`.

### `src/world/park.js`
The skatepark/level. Must contain, at DMFBMX2 scale (metres):
quarterpipes (2.4 m + 3.6 m), spine, vert wall, bowl with pool coping, hips,
funbox with rails, flat ledges, kinked handrail, wallride wall, dirt jump line
(3 doubles), roll-in, half-pipe, plus set dressing (fence, bleachers, banners,
lightposts, graffiti, litter, parked truck) and a city skyline backdrop.
Exports `createPark(ctx)` returning `{ group, colliders, rails, spawnPoints, bounds }`.
- `colliders`: array of `{ mesh, type: 'ground'|'ramp'|'wall', friction }` — geometry
  used for raycast collision. May be lower-poly proxies of the visual mesh.
- `rails`: array of `{ curve: THREE.Curve, radius, type: 'rail'|'coping'|'ledge' }`.

### `src/physics/collision.js`
BVH-free but fast: uniform grid of triangles built from `colliders`.
```js
createCollision(colliders) -> {
  raycastDown(origin, maxDist) -> { hit, point, normal, friction, surface } | null
  sweepSphere(from, to, radius) -> { hit, point, normal, depth } | null
  nearestRail(point, maxDist, velocity) -> { rail, t, point, tangent } | null
}
```
Must handle 20 k+ triangles with < 0.2 ms per query.

### `src/physics/bikePhysics.js`
Arcade-sim bike: two contact points (front/rear wheel) raycast to the ground,
suspension-free but with a lean/pitch model, momentum-preserving transitions,
pumping on transitions, air control, manual/nose-manual balance, bail detection.
Tuned constants live in one exported `TUNING` object with comments.
```js
createBikePhysics(ctx) -> {
  state: { position, velocity, quaternion, grounded, airTime, speed, lean, pitch,
           mode: 'ride'|'air'|'grind'|'manual'|'bail', crank, steer },
  fixedUpdate(fdt, ctx), respawn(spawn), applyTrickRotation(axis, rate)
}
```
Feel targets: top speed ~14 m/s, hop height ~0.9 m, pumped air off a 3.6 m QP ~3 m,
landing tolerance ±35° yaw / ±25° pitch relative to surface, spin rate ~540°/s max.

### `src/gameplay/tricks.js`
Full DMFBMX2-style trick vocabulary driven by modifier + direction:
airs (tabletop, superman, no-hander, toboggan, tailwhip, barspin, X-up, can-can,
360/540/720 spins, backflip, frontflip, flair), grinds (feeble, ice pick, smith,
double peg, toothpick, luc-e), manuals (manual, nose manual), lip tricks
(nose pick, abubaca, footjam whip), flatland (bunnyhop, hang five, etc.).
```js
createTricks(ctx) -> {
  current: { name, points, spinDeg, flipDeg } | null,
  combo: [ { name, points } ], comboActive: bool,
  fixedUpdate(fdt, ctx), onLand(quality), onBail(reason)
}
```
Each trick declares `base` points, `holdBonus`, animation pose id, and the input
recipe. Balance so a good 8-trick line reads ~40–120 k points.

### `src/gameplay/grind.js`
Rail/coping/ledge grinding: snap to `nearestRail`, ride the spline with a balance
meter (left/right correction), grind types by input, transfer/hop-out, revert.

### `src/gameplay/scoring.js`
Score, multiplier (one per trick in combo), combo timer with air/grind extension,
bail = lose combo, special/"Mirra" meter that fills with style and unlocks
signature tricks, 2:00 session timer, goal list (score goals, gaps, collect
letters B-M-X, smash objects), session summary stats.

### `src/rider/bike.js`
A real BMX geometry model: 20.5" top tube frame (down tube, top tube, seat tube,
chainstays, seatstays), fork with dropouts, 36-spoke wheels with hub/nipples/rim
profile, tyre with tread, cranks + chain + sprocket, pegs, bars with grips, stem,
seat, brake levers/cable. Materials from the library (anodised metal, rubber,
chrome). Rider: articulated body with shoulder/elbow/wrist/hip/knee/ankle joints,
helmet, jersey with cloth-ish shading, gloves, shoes. Bones exposed for `riderAnim`.
```js
createRider(ctx) -> { group, bike: {frame, wheels[], cranks, bars, ...},
                      rig: { hips, spine, head, armL[], armR[], legL[], legR[] } }
```

### `src/rider/riderAnim.js`
Procedural pose blending: ride idle, pedal cycle driven by speed, crouch/hop,
air tuck, per-trick poses, grind poses, manual lean, bail ragdoll (simple verlet).
Wheel spin, bar steer, crank rotation, tyre squash, chain motion.
```js
createRiderAnim(rider, ctx) -> { update(dt, ctx), setPose(id, weight), playBail() }
```

### `src/core/camera.js` (OWNED: spine)
Chase camera with spring-damper follow, speed FOV, air pull-back, grind framing,
bail orbit, screen shake hookup, collision push-in against `collision`.

### `src/fx/particles.js`
GPU-instanced particles: tyre dust on dirt, concrete grind sparks (with light
flash), tyre smoke on skids, speed lines, impact debris, landing puff,
crowd flashbulbs. Additive sparks must cast a small point light on hard grinds.
```js
createFX(ctx) -> { spark(pos, dir, n), dust(pos, n), smoke(...), update(dt), shake(a) }
```

### `src/audio/audio.js`
Synthesized: tyre roll (filtered noise scaled by speed/surface), grind (sawtooth +
noise per rail material), chain clicks, hop/land thuds, wind by airspeed, crowd
reactions, bail crunch, plus a loopable drum+bass punk-ish backing track built
from oscillators/noise. Master bus with compressor + reverb send.

### `src/ui/hud.js` + `hud.css`
DOM overlay: score, live combo string with multiplier, session timer, special
meter, balance meter for grinds/manuals, goal tracker, gap names, big-score
popups. Style: bold condensed type, subtle motion, no default browser look.

### `src/ui/screens.js`
Title, park select, controls, pause, session results with stat breakdown.

## Quality bar (what "AAA" means here, concretely)

- Correct PBR: metals metallic=1 with tinted colour, dielectrics with real roughness
  variation, no flat-untextured surfaces anywhere in frame.
- Contact hardening shadows (PCF soft, high-res, tight frustum), ambient occlusion
  in every crevice, no light leaking at the base of geometry.
- Post: ACES tonemapping, bloom on speculars only (threshold ~1.0), SSAO, SMAA,
  subtle chromatic aberration + vignette + film grain, motion-blur-flavoured
  speed effect above 10 m/s.
- Silhouette readability: rider always reads against the sky/ground.
- No z-fighting, no visible tiling repetition, no untextured "programmer grey".

---

# Career structure (THPS-style) — added after the first fan-out

The game is a career of timed 2:00 runs across four levels. This section supersedes
anything above that assumes a single park.

## `src/world/kit.js` — shared construction kit
Reusable, correctly-shaped park primitives every level builds from:
`quarterPipe(opts)`, `bank(opts)`, `spine(opts)`, `halfPipe(opts)`, `bowl(opts)`,
`funbox(opts)`, `stairSet(opts)`, `handrail(curve, opts)`, `ledge(opts)`,
`hubba(opts)`, `wallrideWall(opts)`, `dirtDouble(opts)`, `berm(opts)`,
`rollIn(opts)`, `pyramid(opts)`, `flatRail(opts)`, `copingTube(curve)`.
Each returns `{ mesh|group, colliders[], rails[] }` with correct arcs, coping at the
lip, UVs at ~256 px/m, and shadow flags set. Levels compose these, never re-derive them.

## `src/world/levels/*.js` — one module per level
```js
export const meta = { id, name, subtitle, order, unlockAt, timeOfDay, ambience }
export async function build(ctx) -> {
  group, colliders, rails, spawnPoints, bounds,
  gaps:    [ { name, points, box: THREE.Box3, requiresAir? } ],
  letters: [ THREE.Vector3 x5 ],          // B-M-X-E-R letter pickup positions
  collectibles: [ { id, position, kind } ],// 5 hidden items (level-specific object)
  smashables:   [ { object3D, points, kind } ],
  update(dt, ctx), dispose()
}
```
Levels: `cityLot.js` (the original park, order 0), `warehouse.js`, `plaza.js`, `trails.js`.

## `src/world/levelManager.js`
```js
createLevelManager(ctx) -> {
  levels, current, currentId,
  async load(id),   // dispose old group/collision, build new, rebuild ctx.world.collision,
                    // re-seat gaps/letters/collectibles/smashables, respawn player
  update(dt, ctx), dispose()
}
```
Owns `ctx.world.park`, `ctx.world.collision` and `ctx.world.level` lifetime. Loading must
be safe to call mid-session and must fully dispose GPU resources.

## `src/gameplay/goals.js` — per-level goals + career progression
Nine goals per level, THPS-shaped:
High Score / Pro Score / Sick Score, collect B-M-X-E-R, collect the 5 hidden items,
clear a named gap, land a specified trick on a specified feature, smash 5 objects,
and a level-specific stunt goal. Tracks live progress from scoring/physics/trick events,
persists completion per level in localStorage, and unlocks the next level at 5 goals.
```js
createGoals(ctx) -> {
  forLevel(id), active: [ {id, text, done, progress, target} ],
  onSessionStart(levelId), fixedUpdate(fdt, ctx), completedCount(levelId),
  isUnlocked(levelId), careerTotal(), reset()
}
```
`scoring.js` keeps score/combo/special/timer and emits the events goals listens to.

## `src/ui/levelSelect.js`
Career screen: level cards with a rendered thumbnail (a still framed by the level's
`meta.camera`), goal checklist per level, lock state, career completion %, and the
per-level high score. Feeds `levelManager.load(id)` and starts a session.

---

# DEMO SCOPE (supersedes the four-level career plan)

The deliverable is a **single-map demo**, complete and polished, not a multi-level career:

- **One level**: City Lot (`src/world/park.js`), art-directed to the reference frame below.
- **Full trick vocabulary** — every air, grind, manual, lip and flatland trick in the trick table,
  with a trick-list counter showing how many of the total the player has landed.
- **2:00 timed runs**, restartable, with a results screen.
- **Persistent high scores** (top 5, localStorage), plus a competition leaderboard the player
  climbs during a run.
- **Achievements, challenges and collectibles**: nine per-run goals, a persistent achievement
  set, B-M-X-E-R letters and 5 hidden items.

The other three levels stay designed in the section above but are NOT built for this demo.

# ART DIRECTION TARGET

`reference/target-look.png` (local, git-ignored) is the exact visual target. Read it before making
any look decision. What it establishes:

- **Sky**: heavy overcast/dusk cloud deck with warm break-through light near the horizon, not a
  clear blue sky. High dynamic range between cloud tops and shadowed ground.
- **Ground**: weathered concrete with large **wet patches and standing puddles that mirror the sky
  and skyline** — the single strongest element of the frame. Puddles need real reflection
  (a reflector pass or planar/SSR-flavoured trick), darkened wet-edge borders and rippled roughness.
- **Surfaces**: graffiti on nearly every vertical face — tags, throw-ups, pieces — plus event
  banners and painted logos on the flat bank faces. Nothing is clean.
- **Park**: interconnected concrete bowls, banks, quarterpipes, flat rails and pyramids in an open
  plaza, with spectator areas and a scaffold/stage structure at the edge.
- **Backdrop**: a real city — mid-rise blocks, an elevated freeway, palm trees, floodlight masts,
  distant cranes — sitting in atmospheric haze behind the park.
- **Rider**: reads large in frame from a close, slightly low chase camera; casual clothing
  (tee, jeans, cap), dark anodised bike, strong silhouette against the bright sky.
- **Grade**: cool shadows, warm highlights, gentle bloom on the sky, film-grade contrast.

All branding in our version must be invented — no real trademarks, logos, event names or real
rider names anywhere.

# HUD LAYOUT (match the reference)

- **Top-left**: `SCORE:` label with a large gold numeral; directly beneath, a horizontal
  **SPECIAL** meter with an orange gradient fill and a segmented outline.
- **Below that**: a five-row **competition leaderboard** — rank, invented rival name, score,
  with the player's row highlighted and re-sorting live as the score climbs.
- **Top-centre**: the run timer in a large clean numeral (`1:24`).
- **Top-right**: `TRICK LIST` with a button hint, and beneath it `12 / 46` plus a difficulty tag.
- **Bottom-centre**: the trick callout — gold `2,350 X 2` on the first line, the trick chain in
  white italics beneath (`No Footed Can Can + Barspin`), animating in on each trick and slamming
  out when the combo banks or is lost.
- **Bottom-right**: an optional controller/keys hint.

---

# SECOND REFERENCE (written description — image not on disk)

A second target frame was supplied. It is a STREET spot, and it raises the bar on three things:
wet-ground reflection, character fidelity, and controller-first UI. Details to match:

- **Ground**: wet polished granite/stone plaza after rain, mirroring the buildings, sky, traffic
  lights and car above it — near-mirror reflection in the puddled areas, blurring out with distance.
  Scattered autumn leaves, kerb joints, tactile paving, drain grates, painted crossing stripes.
- **Feature**: a long curved stone ledge with a steel edge strip being grind-ridden; the metal
  catches a bright specular line along its whole length.
- **Rider**: a fully realised character — visible face with real skin shading and hair, a raglan
  jersey (navy body, red sleeves, printed chest graphic), loose blue jeans with fold and seam
  detail, padded gloves, skate shoes, and a natural riding pose with weight over the bars.
  Our rider must reach this class of readability: a face, hair, layered clothing, correct fabric
  response. **All logos and graphics must be invented — no real brands.**
- **Bike**: polished chrome frame with real reflections, chrome pegs, laced spoked wheels, gum-free
  black tyres, correct 20" proportions.
- **Environment**: overcast diffuse daylight, an office block with a mullioned glass facade, an
  autumn tree in full golden leaf, traffic lights, street signage, parked cars, city traffic beyond.
- **Camera**: close third-person, rider occupying roughly a third of frame height, camera near
  ledge height looking slightly up.
- **HUD**: identical layout to reference 1, with an **Xbox controller glyph bottom-right**, an `LB`
  button chip beside `TRICK LIST`, and a `>>> HARD` difficulty tag.

# CONTROLLER SUPPORT (first-class requirement)

The game is designed controller-first, with keyboard as an equal alternative:

- Full **Xbox pad support**: left stick steer/lean, right stick camera, A hop, X/Y/B trick modifiers,
  RB grind, LB trick list, RT pedal, LT brake, LS manual, Start pause, Back restart. Standard
  Gamepad API mapping, with correct handling of triggers as axes vs buttons across browsers.
- **On-screen button glyphs** drawn procedurally (no image assets): Xbox A/B/X/Y with correct
  colours, LB/RB/LT/RT, stick and d-pad glyphs, plus a keyboard-key glyph style. Every prompt in the
  UI shows the glyph for the **currently active device**, switching automatically the moment the
  player touches the other one.
- **Deadzone, sensitivity, invert-Y, and vibration** (Gamepad haptics where supported: a light rumble
  on landing, a sharper one on bail, a continuous low rumble while grinding).
- **Full remapping for both devices** in the settings screen, with conflict detection, per-device
  profiles, restore-defaults, and persistence in localStorage.

# SETTINGS SCREEN

A proper settings screen reachable from the title and pause menus, with tabbed sections:

- **Controls**: device tabs (Gamepad / Keyboard), the full action list with current binding and
  glyph, click/press-to-rebind with a listening state and conflict warnings, deadzone and
  sensitivity sliders, invert-Y, vibration toggle and strength.
- **Video**: quality tier (ultra/high/medium/low), resolution scale, FOV, motion blur / speed blur
  amount, bloom, film grain, chromatic aberration, vignette, shadow quality, and an FPS counter.
- **Audio**: master, music, SFX and crowd sliders with live preview tones.
- **Gameplay**: run length (2:00 default), HUD scale, HUD element toggles, difficulty, camera
  distance/height, auto-restart on bail.
- **Data**: reset high scores, reset achievements, reset all progress (each with a confirm step).

All settings persist in localStorage and apply live without a reload.
