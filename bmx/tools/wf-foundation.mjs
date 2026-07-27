export const meta = {
  name: 'bmx-foundation',
  description: 'Build the BMX game world foundation: materials, environment, park, props, collision, physics, rider/bike, FX',
  phases: [{ title: 'Foundation', detail: 'eight file-disjoint subsystem agents' }],
}

const PRE = `You are building ONE subsystem of a AAA-quality third-person BMX freestyle game in Three.js
(reference: Dave Mirra Freestyle BMX 2 gameplay, Tony Hawk Pro Skater 3 flow, rendered at a modern
AAA visual bar). The project lives at /home/user/pendulum-timer/bmx (cwd).

FIRST: read /home/user/pendulum-timer/bmx/ARCHITECTURE.md in full. It defines the shared ctx object,
the lifecycle, and the exact export signature your module must honour. Also read
src/core/engine.js, src/core/mathx.js and src/main.js so you know what already exists.

NON-NEGOTIABLE RULES
- You own ONLY the file(s) listed in YOUR TASK. Do not create, edit or delete any other file.
  Other agents are editing the sibling modules concurrently.
- Three.js r185 via 'three' and 'three/addons/...'. ES modules only.
- ZERO external assets. No fetch, no CDN, no image/audio/model files. Every texture is generated
  procedurally (canvas2d / DataTexture / shader), every mesh from Three geometry or hand-built
  BufferGeometry. The game must run offline.
- Use rng()/rand()/fbm2() from src/core/mathx.js, never Math.random() - generation must be deterministic.
- Keep your export signature EXACTLY as ARCHITECTURE.md specifies; main.js already calls it.
- Performance is part of the quality bar: share materials, use InstancedMesh for repeats, merge static
  geometry (BufferGeometryUtils.mergeGeometries), dispose properly, no per-frame allocation in update loops.
- Write real, finished, production-quality code. No TODOs, no placeholder comments standing in for work,
  no "simplified for now". Every feature you claim must actually be implemented.
- Verify your file compiles and resolves before finishing:
    npx esbuild YOUR_FILE --bundle --external:three --outfile=/dev/null --format=esm
  Fix every error it reports in YOUR file. (Errors originating in other agents' files are not yours.)
- Match the code style of src/core/engine.js: clear names, tight comments only where non-obvious.

VISUAL TARGET: late-afternoon golden-hour sun over an outdoor concrete/wood skatepark in a US city lot.
Warm key light, cool sky bounce, long soft shadows, dusty air. Everything must read as photographed,
not as flat-shaded programmer art. A harsh art-director agent will screenshot the result and reject
anything that looks like untextured grey boxes, uniform flat colour, tiling repetition, or plastic PBR.
`

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['file', 'summary', 'implemented', 'exports', 'notes'],
  properties: {
    file: { type: 'string' },
    summary: { type: 'string', description: 'What you built, 2-4 sentences' },
    implemented: { type: 'array', items: { type: 'string' }, description: 'Concrete features actually implemented' },
    exports: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string', description: 'Integration notes / assumptions other modules must know' },
  },
}

const TASKS = [
  {
    label: 'materials',
    prompt: `YOUR TASK: src/world/materials.js - the procedural PBR material library. You own this file only.

Implement createMaterials(ctx) (async, returns the library object described in ARCHITECTURE.md).

Generate, at 1024x1024 (512 for minor ones), full material sets - colour + normal + roughness (+ AO where
it helps) - for at least: concrete (smooth troweled), concreteWorn (cracked, stained, patched),
asphalt (aggregate, tar seams, faded paint lines), plywood/skatelite ramp surface (seams, screw heads,
scuffed grain), metalCoping (polished-worn steel with scratches), railSteel, paintedMetal (chipped
enamel over primer), chainlink (alpha-cut wire mesh), brick, corrugatedMetal, glass, grass, dirt
(dry packed jump dirt), rubber (tyre), and a graffiti/decal atlas with alpha.

Requirements that separate this from amateur work:
- Build noise from fbm2/valueNoise2 in mathx.js layered at multiple octaves; add feature-level detail
  (cracks via ridged noise, stains via low-frequency blotches, aggregate speckle, directional trowel
  swirl, edge wear) - NOT just uniform grain.
- Derive normal maps from the height field you generate (sobel), not from the colour map, and pick
  physically sensible normalScale per material.
- Roughness must vary spatially (polished lines where wheels roll, wet-look patches, worn coping).
- Set wrapping RepeatWrapping, anisotropy = renderer.capabilities.getMaxAnisotropy(), generateMipmaps,
  colorSpace SRGBColorSpace on colour maps ONLY (linear for normal/roughness/ao).
- Provide a helper the park can call to keep texel density constant: setUvScale(material, metersPerTile)
  or a documented convention, plus a clone-with-repeat helper so one base material serves many surfaces
  without re-generating textures.
- Provide 4-8 anodised/painted colourways for bike parts (frame, rims) as cheap material variants.
- Avoid visible tiling: use at least two detail frequencies and/or a large-scale macro variation layer.
- Keep total generation under ~1.5s: generate on an OffscreenCanvas where available, reuse buffers.
Export createMaterials plus any helpers the park/rider need (document them in your return notes).`,
  },
  {
    label: 'environment',
    prompt: `YOUR TASK: src/world/environment.js - sky, lighting rig, image-based lighting, fog, time of day.
You own this file only.

Implement createEnvironment(ctx) per ARCHITECTURE.md.

Must include:
- A physically-flavoured sky: gradient/Rayleigh-ish sky shader on a large dome or Three's Sky addon
  (three/addons/objects/Sky.js) driven by a sun elevation/azimuth, with sun disc, horizon haze and
  believable colour ramp. Add drifting procedural clouds (a shader-noise layer on the dome or a
  cloud plane) - the sky must not be a flat blue gradient.
- PMREMGenerator: render the sky into an environment map and set scene.environment so every PBR
  material gets real IBL. Regenerate when time of day changes (cheaply, not per frame).
- Sun: DirectionalLight, warm (~4800-5600K at golden hour), intensity tuned for ACES exposure 1.05,
  shadows at 4096 with a TIGHT ortho frustum around the play area (not 400 units wide - shadow texel
  density matters), sensible bias/normalBias so there is no peter-panning or acne, and a
  shadow.camera that can be re-centred on the player each frame (expose recenterShadows(target)).
- Sky/bounce fill: HemisphereLight or two rim/fill directional lights, cool sky above warm ground bounce.
- Exponential height fog (FogExp2 or a custom fog with height falloff) tuned so the distant skyline
  reads atmospheric but the park stays crisp.
- setTimeOfDay(t) with t in 0..1 mapping dawn -> noon -> golden hour -> dusk, driving sun angle+colour,
  sky tint, fog colour, exposure, and (at dusk) enabling warm practical lights the park provides.
- Optional god-ray-ish sun haze via a cheap billboard glow near the sun direction.
- update(dt, ctx): drift clouds, recentre the shadow frustum on ctx.player.physics.state.position.
Set ctx.engine.sunLight and expose { sun, hemi, sky, setTimeOfDay, recenterShadows, update, dispose }.
Default state at boot: golden hour, sun ~22 degrees elevation, warm.`,
  },
  {
    label: 'park',
    prompt: `YOUR TASK: src/world/park.js - the skatepark level geometry and its collision proxies.
You own this file only. (A sibling agent owns src/world/props.js for set dressing; import createProps
from it and call it inside a try/catch so a missing or incomplete props module never breaks the park.)

Implement createPark(ctx) per ARCHITECTURE.md, returning { group, colliders, rails, spawnPoints, bounds, update }.

Build a real, rideable DMFBMX2-scale park in metres, all geometry hand-built (LatheGeometry/ExtrudeGeometry/
custom BufferGeometry for transitions - a quarterpipe is a swept circular arc, NOT a rotated box):
- Roll-in platform (3.0 m) feeding a main run.
- Two quarterpipes: 2.4 m and 3.6 m radius transitions with correct arc profile, 6-8 m wide decks,
  steel coping tube at the lip, plywood/skatelite riding surface with visible seam lines, steel frame
  understructure visible from the back, safety rail on the deck.
- A spine (two transitions back to back) and a hip (two QPs meeting at an angle for transfers).
- A halfpipe/mini ramp section, and a vert wall extension.
- A concrete bowl with pool coping, tiled band under the coping, a drain, varied depth (1.8-3.2 m),
  rounded corners built as a proper swept surface.
- A funbox with a flat top, banked sides, a flat ledge and a round rail over it.
- A kinked handrail down a set of stairs, plus a hubba ledge.
- A wallride wall and a bank-to-wall.
- A dirt jump line: 3 doubles with lips and landings, sculpted from smooth curved geometry with dirt
  material, plus a berm turn.
- Flat ground with painted lines, patched asphalt, and enough open flat to build speed.
Requirements:
- Everything must sit on the SAME ground plane with no z-fighting and no floating/intersecting seams.
- UV the surfaces so texel density is ~256 px/m using the materials library helpers; never leave a
  surface with default UVs stretched across 10 m.
- castShadow/receiveShadow set correctly (big flat ground receives only).
- colliders: return simplified but accurate proxy meshes (or the visual meshes where already simple),
  each tagged { mesh, type, friction } with type one of ground/ramp/wall. Transitions MUST be
  represented accurately enough to ride smoothly - no stair-stepped approximations.
- rails: THREE.Curve instances (CatmullRomCurve3 / LineCurve3) along every coping edge, handrail,
  ledge and pool coping, each { curve, radius, type }. Give the coping curves the exact lip position.
- spawnPoints: at least 4 sensible start positions with yaw, first one facing the main line.
- Merge static geometry aggressively and reuse materials: target under ~250 draw calls for the park.
- Return an update(dt, ctx) (a no-op is fine if nothing animates).
Place features so a rider can flow QP -> rail -> bowl -> dirt line without dead ends. Layout
readability from above matters.`,
  },
  {
    label: 'props',
    prompt: `YOUR TASK: src/world/props.js - set dressing, backdrop and atmosphere props. You own this file only.

Export createProps(ctx) returning { group, colliders, update, dispose }. The park agent will add your
group to the park and merge your colliders. Keep it fully self-contained: if ctx.materials lacks a
material you want, fall back to a sensible MeshStandardMaterial you build yourself.

Build, all procedurally:
- Chainlink perimeter fence with posts, top rail, tension wire and alpha-cut mesh material, with a
  gate and some bent/damaged sections. Fence must have collider walls.
- Concrete bleachers / spectator steps, a few benches, a picnic table, trash cans (one knocked over),
  scattered litter, a pallet stack, traffic cones, a portable toilet, a shipping container with graffiti.
- Sponsor banners and vinyl signage on the fence (procedural canvas text/logos, invented brand names -
  do NOT reproduce real trademarks), slightly wrinkled, with a gentle wind wobble in update().
- Light posts / stadium lights (with emissive lamp heads that switch on at dusk - expose
  setNightLights(on) and, if you add real lights, keep them to at most 4 cheap PointLights).
- Trees and shrubs beyond the fence: instanced, with billboard-cluster or cross-quad foliage that reads
  well at distance and animates subtly in wind. Avoid the classic cone-on-a-cylinder look.
- Parked pickup truck / box van in the lot (blocky but correctly proportioned, with wheels, glass,
  lights, a bed), plus a spectator crowd: a few dozen instanced low-poly figures with varied colours
  and idle bob animation, positioned along the fence and bleachers.
- A city backdrop: a ring of distant buildings at varying heights/depths with window grids (emissive
  at dusk), water towers, billboards and a couple of cranes - cheap boxes with good silhouettes and
  facade textures, placed to sit behind the fog and read as a skyline. Plus a low haze/hill band.
- Ground scatter near the park: dust patches, tyre marks decals, weeds in cracks (instanced).
Performance: everything repeated must be InstancedMesh; the entire props set should cost under
~120 draw calls. Nothing should cast shadows except objects near the play area.`,
  },
  {
    label: 'collision',
    prompt: `YOUR TASK: src/physics/collision.js - the collision query system. You own this file only.

Implement createCollision(colliders, rails) per ARCHITECTURE.md. This is the load-bearing part of
game feel: the bike physics agent depends entirely on your query accuracy and stability.

Requirements:
- Extract world-space triangles from every collider mesh (handle indexed/non-indexed BufferGeometry,
  applied matrixWorld, InstancedMesh if present) at build time, tagged with the owning collider's
  friction/type. Store in flat Float32Arrays; never allocate per query.
- Build a uniform spatial hash grid (cell ~2 m) over triangle AABBs, plus a coarse top-level AABB
  reject. Must handle 60k+ triangles and answer any query in well under 0.2 ms.
- raycastDown(origin, maxDist) returning { hit, point, normal, distance, friction, surface } or null.
  Use a DDA walk through grid cells (not a brute-force scan), Moller-Trumbore triangle intersection,
  and return the SMOOTHED normal where the collider provides vertex normals so ramp transitions feel
  continuous rather than faceted. Reuse preallocated vectors and return a reused result object with a
  documented copy-before-you-keep-it note.
- raycast(origin, dir, maxDist) generic version, used for wallrides and camera collision.
- sweepSphere(from, to, radius) returning { hit, point, normal, depth } or null for wall response.
- nearestRail(point, maxDist, velocity) returning { rail, t, point, tangent, distance } or null.
  Precompute each rail curve into a polyline (sample by arc length ~0.25 m), store segments in the same
  grid, and pick the closest segment whose tangent is within ~50 degrees of the velocity direction
  (either sign, since grinds can be ridden switch). Return the exact projection parameter t.
- railPointAt(rail, t) and railTangentAt(rail, t) helpers for the grind system.
- A debugMesh() helper returning an optional wireframe/points visualisation of the grid or triangles.
- Guard against degenerate triangles and empty collider lists.
Also export verifyCollision(collision) running a few sanity assertions the integrator can call - but
do NOT run it at import time.`,
  },
  {
    label: 'bike-physics',
    prompt: `YOUR TASK: src/physics/bikePhysics.js - the ride/air/land model. You own this file only.
This is the single most important file for whether the game feels like Dave Mirra Freestyle BMX 2.

Implement createBikePhysics(ctx) and export TUNING per ARCHITECTURE.md.

Model (arcade-sim, 120 Hz fixed step):
- Two ground probes (front and rear contact, ~1.05 m apart) via ctx.world.collision.raycastDown, plus a
  centre probe. Bike orients to the surface by fitting pitch from the two contacts and roll from the
  surface normal, damped so the rider does not snap.
- Ride mode: pedal acceleration curve that falls off toward top speed (~14 m/s), coasting drag,
  rolling resistance scaled by surface friction, brake with rear-wheel lockup and skid state,
  steering radius that tightens at low speed and widens at speed (no ice-skating), lean into turns
  (visual roll up to ~28 deg) and a slight countersteer on initiation.
- Gravity-along-surface: on transitions, gravity projects into the surface tangent so you lose speed up
  a quarterpipe and gain it coming down. Pumping: crouch and release timed in a transition adds energy,
  capped so it cannot be spammed infinitely.
- Hop: charge by holding hop (crouch compresses ~0.18 m) and release for a bunnyhop up to ~0.9 m, with
  the launch direction blended between world-up and the surface normal, plus extra pop when leaving a
  lip with speed (natural air off a QP: ~3 m above coping at full speed).
- Air mode: ballistic with light air drag, air control that lets the player nudge yaw/pitch, and
  applyTrickRotation(axis, rate) so the trick system drives spins/flips. Track total rotation about
  each axis so the trick/scoring systems can name 360/540/720 and flips.
- Landing: compare bike forward/up against the landing surface. Within tolerance (35 deg yaw,
  25 deg pitch/roll) means a clean land: preserve speed, squash suspension, emit a land event with a
  quality 0..1. Outside tolerance, or landing on the coping edge, or too slow on a transition, bails.
- Bail mode: kill control for ~1.6 s, let the bike and rider tumble (simple rigid tumble with gravity
  and ground bounce), then respawn at the last safe grounded position facing down the line.
- Manual/nose-manual: pitch the bike onto one wheel with a balance value that drifts by an inverted-
  pendulum-ish rule and is corrected by input.lean; falling past a threshold bails.
- Wallride support: detect near-vertical surfaces with a forward sweepSphere; if approached with enough
  speed at a shallow angle, stick to the wall with a gravity component along it for a limited time.
- Grind hand-off: expose enterGrind(railHit) and exitGrind(dir) so src/gameplay/grind.js can drive
  rail riding while you keep owning the state object.
- Events via ctx.emit(...): land {quality, speed, surface}, bail {reason}, hop, pump, skid {amount},
  wheelContact {wheel, surface, speed}, wallride - FX/audio/scoring subscribe to these.
- state must expose everything ARCHITECTURE.md lists plus rotation totals, crouch, compression,
  balance, wall info, and lastSafe.
Every magic number lives in TUNING with a one-line comment explaining its feel effect. Nothing may
allocate inside fixedUpdate. Stability first: no NaNs, no tunnelling at 14 m/s (substep the integration
if the step distance exceeds ~0.25 m), no jitter when resting on a flat surface.`,
  },
  {
    label: 'rider-bike-model',
    prompt: `YOUR TASK: src/rider/bike.js - the BMX bike and rider models. You own this file only.
These two objects are on screen 100% of the time and in every close-up the art director will judge.

Implement createRider(ctx) per ARCHITECTURE.md, returning { group, bike, rig, materials }.

BIKE - a real 20 inch BMX, built to actual proportions (wheelbase ~1.06 m, 20.5 inch top tube,
26 inch bars, wheel diameter 0.52 m including tyre):
- Frame from swept tube geometry (TubeGeometry along CatmullRomCurve3 or lathed cylinders with proper
  mitred joins): down tube, top tube, seat tube, head tube, chainstays, seatstays, plus gussets and
  visible weld beads at the joints (small torus/bulge rings - welds are what sell a metal frame).
- Fork with tapered legs, dropouts, and a headset stack; stem with 4 visible bolts; bars with crossbar
  and rubber grips with bar-end plugs.
- Wheels: rim with a real cross-section profile (lathed), 36 spokes per wheel built as instanced thin
  cylinders in a correct 3-cross lacing pattern, hub with flanges, nipples, and a tyre with a lathed
  casing plus a knobbly tread built from instanced blocks (or a normal-mapped tread if cheaper) and
  a sidewall with procedural branding text (invented brand names only).
- Drivetrain: crank arms, spider sprocket with real teeth, chain as an instanced link loop following
  the sprocket/cog path, pedals with grip pins, rear cog and cassette hub.
- Four pegs, seat + post with a clamp, brake lever + cable routed along the frame (or brakeless with a
  gyro if you prefer - choose one and be consistent), chain tensioners, valve stems.
- Materials: anodised/powder-coated frame with clearcoat (MeshPhysicalMaterial clearcoat), chrome parts
  with high metalness and low roughness, rubber tyres/grips at roughness ~0.9, subtle scratches and
  scuffs so nothing is showroom-perfect. Add slight edge wear on pegs and cranks.
RIDER - a proportioned human on the bike, ~1.78 m:
- An articulated body built from segments (upper/lower arm, thigh/shin, torso in two parts, neck) with
  real joint pivots exposed in the rig object for the animation agent: hips, spine, chest, neck, head,
  shoulderL/R, elbowL/R, wristL/R, hipL/R, kneeL/R, ankleL/R. Use nested Object3D pivots so rotating a
  joint moves the whole chain correctly.
- Rounded, believable silhouette: use CapsuleGeometry/lathed forms with smooth shoulder and knee
  transitions, not disconnected floating boxes. Add a helmet with vents and a visor strap, gloves,
  a t-shirt/jersey with a procedural sponsor print and sleeve seams, shorts/pants with folds baked into
  the normal map, shin pads, and shoes with soles and laces.
- Face-level detail is not needed (helmet + goggles is fine) but the head must not be a bare sphere.
- Everything must cast shadows; the rider must read clearly in silhouette against the sky.
Set a sensible default pose: hands on grips, feet on pedals, weight forward, elbows out. The group
origin must be at the tyre contact patch (y=0 at tyre bottom), forward = +Z, so the physics can place
it directly. Budget: rider + bike under ~40k triangles and ~25 draw calls, using merged geometry and
shared materials.`,
  },
  {
    label: 'fx',
    prompt: `YOUR TASK: src/fx/particles.js - the particle and screen-effect system. You own this file only.

Implement createFX(ctx) per ARCHITECTURE.md.

Build a real GPU particle system, not sprites-in-a-loop:
- One or two pooled Points/InstancedMesh systems with custom ShaderMaterial: per-particle position,
  velocity, life, size, rotation, colour packed into instanced attributes; simulate in the vertex
  shader from spawn time (position = p0 + v*t + 0.5*g*t*t) so the CPU only writes on spawn. Pool
  4000+ particles with a free-list; zero allocation per emit.
- Soft particles: fade near geometry using the depth buffer if practical, otherwise a soft radial
  alpha and correct depthWrite false / depthTest true sorting.
- Emitters required: tyre dust (dirt), concrete/asphalt roll dust at speed, grind sparks (additive,
  hot white-yellow core into orange, gravity-affected, with short streak stretching along velocity),
  skid smoke (soft dark grey puffs that expand and fade), landing puff, bail debris, gravel chips,
  wind speed-lines at high velocity, and dusk flashbulbs from the crowd.
- Grind sparks must also drive a small pooled PointLight (max 2) that flickers at the contact point.
- Decals: persistent tyre marks and skid streaks stamped onto the ground as a pooled decal ring buffer
  (128 quads, slightly offset along the surface normal, fading out over time).
- Screen effects: shake(amount) forwarded to ctx.cameraRig.addShake, plus impact flash and a brief
  desaturation on bail, driven through ctx.engine.passes.gradePass uniforms.
- Subscribe to the physics events (land, bail, hop, skid, wheelContact, wallride) through ctx.on(...)
  so effects fire automatically, and expose the direct spark/dust/smoke/impact API too.
- update(dt, ctx) advances a single uTime uniform and recycles dead particles; must cost < 0.3 ms CPU.
Everything additive must be tuned for ACES tonemapping + bloom threshold ~0.92 - sparks should bloom,
dust must not.`,
  },
]

phase('Foundation')
log('Fanning out ' + TASKS.length + ' subsystem agents (file-disjoint)')

const results = await parallel(TASKS.map((t) => () =>
  agent(PRE + '\n' + t.prompt, { label: t.label, phase: 'Foundation', effort: 'high', schema: SCHEMA })
))

return results.filter(Boolean)
