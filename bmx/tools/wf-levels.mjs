export const meta = {
  name: 'bmx-levels',
  description: 'Build the THPS-style career: shared construction kit, three new levels, level manager, goals/progression and the career screen',
  phases: [
    { title: 'Kit', detail: 'extract the shared park construction kit from the city lot' },
    { title: 'Career', detail: 'three level agents plus manager, goals and career UI' },
  ],
}

const PRE = `You are building part of the career mode for a AAA-quality third-person BMX freestyle game
in Three.js. Structure is Tony Hawk's Pro Skater: timed 2:00 runs, several levels, a goal list per
level, collectible letters and hidden items, gaps, and unlocks. Trick vocabulary and feel are Dave
Mirra Freestyle BMX 2. Project root: /home/user/pendulum-timer/bmx (cwd).

FIRST: read ARCHITECTURE.md IN FULL, including the "Career structure" section at the end which defines
exactly what you are building. Then read the existing code you depend on - it is already implemented,
do not guess its API:
  src/world/park.js       (the finished level 1 - your quality benchmark and the source of the kit)
  src/world/props.js      (set dressing you can reuse)
  src/world/materials.js  (the material library and its uv-scale helpers)
  src/world/environment.js
  src/physics/collision.js, src/physics/bikePhysics.js
  src/gameplay/scoring.js (score/combo/special/timer and the events it emits)
  src/ui/hud.js, src/ui/screens.js, src/ui/hud.css
  src/core/engine.js, src/core/mathx.js, src/main.js

NON-NEGOTIABLE RULES
- You own ONLY the file(s) named in YOUR TASK. Other agents are editing siblings concurrently.
- Three.js r185, ES modules, ZERO external assets - all geometry hand-built, all textures procedural,
  all audio synthesized. Deterministic rng from src/core/mathx.js, never Math.random().
- No per-frame allocation. Merge static geometry, use InstancedMesh for repeats, share materials,
  dispose everything you create in dispose().
- Real, finished, production-quality code. No TODOs, no placeholders, no "simplified for now".
- Verify before finishing:
    npx esbuild YOUR_FILE --bundle --external:three --outfile=/dev/null --format=esm
  Fix every error in YOUR file.
- Levels must be RIDEABLE, not dioramas: every feature reachable with ~14 m/s top speed and a 0.9 m
  bunnyhop, lines that flow from one feature into the next, no dead ends, no unclimbable islands.

VISUAL BAR: a hostile art director screenshots the result and compares it blind against a shipped
commercial game. Untextured grey boxes, flat uniform colour, visible tiling, wrong scale, or sterile
empty space are automatic rejections.
`

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['file', 'summary', 'implemented', 'exports', 'notes'],
  properties: {
    file: { type: 'string' },
    summary: { type: 'string' },
    implemented: { type: 'array', items: { type: 'string' } },
    exports: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
}

phase('Kit')
log('Extracting the shared construction kit from the finished city lot')

const kit = await agent(PRE + `
YOUR TASK: create src/world/kit.js, and refactor src/world/park.js to use it. You own BOTH files.

src/world/park.js already contains a finished, art-directed skatepark. Extract its geometry builders
into a reusable, well-documented construction kit exactly as the "Career structure" section of
ARCHITECTURE.md specifies, then rewrite park.js to compose the same park from the kit so that level 1
looks identical or better after the refactor.

Requirements for kit.js:
- Every builder returns { group, colliders, rails } with colliders tagged { mesh, type, friction }
  and rails as { curve, radius, type } - the same shapes park.js already returns.
- Correct geometry, not approximations: quarterpipe/halfpipe transitions are true circular arcs swept
  along a width, coping is a torus/tube sitting exactly at the lip radius, banks are angled planes with
  properly mitred edges, bowls are swept surfaces with rounded corners, stair sets have real risers
  and treads with a nosing, handrails follow a curve with posts that meet the ground at every post.
- Every builder takes an options object with sensible defaults and documents its units (metres) and
  its anchor point, so a level author can place features by their contact edge.
- UVs must give ~256 px/m using the materials library helpers; every builder sets castShadow and
  receiveShadow correctly and supports a material override option.
- Builders must accept a material set so a wooden warehouse ramp, a concrete park ramp and a dirt
  lip can share one builder with different surfacing.
- Include everything listed in ARCHITECTURE.md plus: foamPit, mezzanine/dropIn platform, fountain,
  planterLedge, kickerRamp, jerseyBarrier, picnicTableGap, and a wooden wallride.
- Export a helper to merge a list of built pieces into a single group/collider/rail set, and a
  placement helper (position + yaw) so levels stay readable.
Also add a short doc comment at the top of kit.js listing every builder and its options - level agents
will read only that comment plus signatures.
park.js must keep its exact export signature (createPark(ctx)) and its returned shape, and must now
also return the gaps/letters/collectibles/smashables arrays that the career section specifies for a
level (place 5 letters spelling B-M-X-E-R, 5 hidden items, at least 8 named gaps, and 6 smashable
props) so that level 1 is a full career level.
`, { label: 'kit+park-refactor', phase: 'Kit', effort: 'high', schema: SCHEMA })

phase('Career')

const LEVEL_PRE = PRE + `
Read src/world/kit.js FIRST (its header comment lists every builder and its options) and compose your
level from it. Follow the level module contract in ARCHITECTURE.md exactly:
  export const meta = { id, name, subtitle, order, unlockAt, timeOfDay, ambience }
  export async function build(ctx) -> { group, colliders, rails, spawnPoints, bounds, gaps, letters,
                                        collectibles, smashables, update, dispose }
Your level must contain, without exception:
- A clear main line a rider can flow for the full 2:00 without stopping, plus 2-3 secondary lines.
- 5 letter pickup positions spelling B-M-X-E-R, placed to demand real skill (one high in the air, one
  on a rail line, one down a gap, one tucked away, one easy).
- 5 hidden collectibles themed to the level, in genuinely hidden but reachable spots.
- At least 8 named gaps as THREE.Box3 volumes with names in the style of THPS
  (invent names that fit the level, e.g. "Loading Dock Launch"), with points 100-1000.
- 6 smashable props with sensible point values.
- Full set dressing and a believable environment: this must look like a real place, not a park with
  boxes around it.
- Correct scale: a rider is 1.78 m; check every feature against that.
`

const LEVELS = [
  {
    label: 'level:warehouse',
    file: 'src/world/levels/warehouse.js',
    brief: `YOUR TASK: src/world/levels/warehouse.js - "The Warehouse", an indoor wooden skatepark inside a
disused industrial building. You own this file only.

Character: dim cavernous interior lit by dusty shafts of light from clerestory windows and hanging
industrial lamps, warm pools of light on plywood ramps against deep shadow. Concrete floor with paint
lines, forklift scuffs and drainage channels.
Content: a mezzanine drop-in feeding the main run; a 4 m vert wall with a channel and a deck; a big
plywood spine; a bowl corner in the far end; a box jump line with a foam pit beside it; roof-truss
steelwork with hanging chains and a dangling banner; stacked pallets, crates, oil drums, a forklift,
a service door with a loading dock, offices with windows overlooking the park, ducting and conduit
runs, a graffitied end wall, mesh guard rails on the mezzanine, and a small vending/tool corner.
Lighting note: your build must place its own emissive lamp geometry and expose at most 6 PointLights;
set meta.timeOfDay so the environment system dims the exterior sun contribution, and make sure the
interior reads as interior (the sky must not be visible except through the clerestory windows).
Include a roof so the level is enclosed, with a couple of skylight openings that throw light shafts.`,
  },
  {
    label: 'level:plaza',
    file: 'src/world/levels/plaza.js',
    brief: `YOUR TASK: src/world/levels/plaza.js - "Downtown Plaza", a street level. You own this file only.

Character: a midday civic plaza between office towers - granite ledges, marble hubbas, a big 12-stair
with a kinked handrail, a fountain with a rideable rim, planter ledges, bus stop, newspaper boxes,
bollards, jersey barriers, a parking garage entrance with a bank, a subway entrance, a loading dock,
and a car park with a couple of parked cars and a bus.
This is a STREET level: the features are the architecture. Ledges and rails must be integrated into
real-looking buildings, kerbs and steps, not dropped on a flat field. Include kerb cuts, drainage
grates, manhole covers, pavement joints, street lamps, traffic lights, signage (invented brands),
pigeons (instanced, with a scatter animation when the rider passes), and a few pedestrians.
Verticality matters: give the level a raised terrace reachable by a bank, a lower sunken court, and a
rooftop-adjacent gap that rewards a big line. Keep the ground plane readable and rideable throughout.
Set meta.timeOfDay to hard midday so shadows are short and the marble reads bright.`,
  },
  {
    label: 'level:trails',
    file: 'src/world/levels/trails.js',
    brief: `YOUR TASK: src/world/levels/trails.js - "Backwoods Trails", a dirt jump compound. You own this
file only.

Character: a wooded clearing at dusk with a hand-dug trails line - this is the BMX-specific level and
must feel completely different from a skatepark. Sculpted earth, packed clay lips, loamy landings,
roots and ruts, a tarp-covered dig pit, shovels and buckets, a wooden shed, a fire pit, string lights
between the trees, and a hand-painted sign.
Content: a main trails line of 5 doubles with progressively bigger gaps, a rhythm section of rollers,
two banked berms linking the lines back around, a step-up and a step-down, a hip jump, a wooden
wallride nailed between two trees, a log rail and a rock ledge, a quarterpipe built from scrap wood at
the end of the run, and a hill you climb to the roll-in.
The dirt must look like dirt: sculpted smooth curved geometry with a packed, polished riding line
(lower roughness where tyres run), loose berms at the edges, scattered rocks and leaf litter, and
tyre ruts. Trees must form a dense readable treeline with dappled shade - use instancing and make the
canopy move in the wind.
Set meta.timeOfDay to dusk/golden so long shadows rake across the jumps and the string lights read.`,
  },
]

const careerTasks = [
  ...LEVELS.map((l) => () => agent(LEVEL_PRE + '\n' + l.brief, { label: l.label, phase: 'Career', effort: 'high', schema: SCHEMA })),

  () => agent(PRE + `
YOUR TASK: src/world/levelManager.js. You own this file only.

Implement createLevelManager(ctx) per the "Career structure" section of ARCHITECTURE.md.
- Register all four levels: cityLot (from src/world/park.js, order 0), warehouse, plaza, trails
  (from src/world/levels/*.js). Import them lazily with dynamic import() so a broken level cannot
  break the boot, and log a clear error and fall back to level 0 if a level fails to build.
- load(id): dispose the previous level completely (geometry, materials it owns, textures, lights,
  remove from scene), build the new one, add it to the scene, rebuild ctx.world.collision via
  createCollision(colliders, rails), point ctx.world.park at the new level, apply the level's
  meta.timeOfDay through ctx.world.environment.setTimeOfDay, hand the gaps/letters/collectibles/
  smashables to ctx.player.scoring and ctx.goals if those APIs exist, respawn the player at
  spawnPoints[0] and snap the camera. Must be safe to call repeatedly with no leak - verify with
  renderer.info.memory before and after.
- Own the letter and collectible pickup meshes for the current level if the level did not build them:
  cheap, readable, spinning/bobbing, with a pickup burst through ctx.fx.
- update(dt, ctx): forward to the level's update, animate pickups, and test player proximity for
  pickups and smashables, emitting the events goals/scoring listen for.
- Expose levels metadata (id, name, subtitle, order, unlockAt) for the career UI, plus currentId.
`, { label: 'level-manager', phase: 'Career', effort: 'high', schema: SCHEMA }),

  () => agent(PRE + `
YOUR TASK: src/gameplay/goals.js. You own this file only. Do NOT edit scoring.js - read it and build
on the events and API it already provides; if something you need is missing, degrade gracefully and
note it.

Implement createGoals(ctx) per the "Career structure" section of ARCHITECTURE.md: nine goals per level
for all four levels (cityLot, warehouse, plaza, trails), tracked live from gameplay events, persisted
per level in localStorage under a namespaced key, with the next level unlocking at 5 completed goals.

Goal types to implement generically so any level can declare them:
- score threshold (High / Pro / Sick, per level, scaled to that level's difficulty)
- collect all 5 letters (B-M-X-E-R)
- collect all 5 hidden items
- clear a named gap
- land a named trick (or trick category) on a named feature
- smash N objects
- hold a grind of N seconds / a manual of N metres
- a level-specific stunt (e.g. transfer the spine, wallride the foam pit wall, 360 the 12-stair)
Each goal exposes id, text, hint, progress, target, done, and a points reward. Emit events on
progress and completion so the HUD can flash them, and expose a session summary of what was completed.
Career progression: careerTotal(), isUnlocked(levelId), completedCount(levelId), reset(), plus a
medal/rank per level derived from goals completed. Wire onSessionStart(levelId) to reset per-run
progress while keeping persisted completion.
`, { label: 'goals', phase: 'Career', effort: 'high', schema: SCHEMA }),

  () => agent(PRE + `
YOUR TASK: src/ui/levelSelect.js. You own this file only. Match the visual language of src/ui/hud.css
and src/ui/screens.js (read both) but inject your own scoped <style> block - do not edit their files.

Implement createLevelSelect(ctx) exporting a career screen:
- A card per level (City Lot, Warehouse, Downtown Plaza, Backwoods Trails) showing name, subtitle,
  lock state, goals completed (n/9) with a checklist that expands on selection, the level high score,
  and a rank/medal. Locked levels show the unlock requirement and are visually distinct.
- A live 3D preview instead of a static image: when a card is focused, ask the level manager for that
  level's preview camera and render the actual level behind the panel if it is loaded, otherwise show
  a procedurally drawn canvas map of the level layout (top-down schematic from the level bounds and
  feature positions) - it must never look like a missing-image placeholder.
- Career header: total goals, total career points, completion percentage with an animated bar.
- Full keyboard and gamepad navigation with clear focus states, enter/exit transitions, and a
  "START RUN" action that calls ctx.levelManager.load(id) then starts a session.
- Show a per-level goal briefing on start.
Expose { show, hide, update, dispose, isOpen }.
`, { label: 'career-ui', phase: 'Career', effort: 'high', schema: SCHEMA }),
]

log('Building 3 levels + manager + goals + career UI')
const career = (await parallel(careerTasks)).filter(Boolean)

return { kit, career }
