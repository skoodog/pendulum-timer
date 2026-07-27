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
