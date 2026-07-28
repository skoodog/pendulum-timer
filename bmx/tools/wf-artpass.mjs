export const meta = {
  name: 'bmx-art-pass',
  description: 'Directed art pass to close the known gap to the reference frames: wet reflective ground, cloud deck, graffiti, skyline and character fidelity',
  phases: [{ title: 'Art pass', detail: 'five file-disjoint art agents' }],
}

const PRE = `You are closing the gap between a Three.js BMX game and two supplied reference frames from a
released commercial game. Project: /home/user/pendulum-timer/bmx (cwd).

MANDATORY FIRST STEPS
1. Read reference/target-look.png with the Read tool. It renders as an image. This is REFERENCE 1
   and it is the exact target.
2. Read ARCHITECTURE.md in full, especially "ART DIRECTION TARGET", "SECOND REFERENCE",
   "DEMO SCOPE" and "HUD LAYOUT" at the end.
3. Look at the current output: shots/round2/*.png (hero, park-wide, gameplay, bowl, ground-detail,
   rider-closeup, bike-detail, skyline, dusk). Read the ones relevant to your task. This is what we
   currently ship and it is visibly short of the reference.
4. Read the file you own and the modules it depends on.

THE HONEST GAP (from comparing shots/round2 to the reference):
- Our ground is dry, flat and uniformly lit. The reference's defining feature is WET CONCRETE with
  standing puddles mirroring the sky and skyline.
- Our sky is a smooth gradient with thin cloud. The reference has a dramatic overcast dusk cloud
  deck with warm break-through light.
- Our vertical surfaces are bare. The reference has graffiti on nearly every one.
- Our skyline is flat dark boxes with window grids. The reference has a real city: mid-rise blocks,
  an elevated freeway, palms, floodlight masts, cranes, all sitting in atmospheric haze.
- Our rider is a dark silhouette with a featureless face. Reference 2 has a full character with a
  face, hair and layered clothing.

RULES
- You own ONLY the file(s) in YOUR TASK. Other agents edit siblings concurrently.
- Zero external assets. Everything procedural. Deterministic rng from src/core/mathx.js.
- Performance is part of the bar: the whole scene must stay under ~400 draw calls and 1.6M triangles,
  and must not tank frame time. Say what your change costs in your notes.
- Real, finished work. No TODOs.
- Verify: npx esbuild YOUR_FILE --bundle --external:three --outfile=/dev/null --format=esm
- Then LOOK AT YOUR WORK: run
      node tools/shoot.mjs --out shots/check-<yourname> --only <relevant shot ids> --w 1280 --h 720
  and READ the resulting PNGs. Iterate until the frame genuinely moves toward the reference. Do not
  finish on the first attempt - compare your render against reference/target-look.png side by side
  and keep going until the difference is defensible.
- All branding invented. No real trademarks.
`

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['file', 'summary', 'implemented', 'cost', 'iterations', 'notes'],
  properties: {
    file: { type: 'string' },
    summary: { type: 'string' },
    implemented: { type: 'array', items: { type: 'string' } },
    cost: { type: 'string', description: 'draw calls / triangles / ms added' },
    iterations: { type: 'string', description: 'how many render-and-look cycles you ran and what changed each time' },
    notes: { type: 'string' },
  },
}

const TASKS = [
  {
    label: 'art:wet-ground',
    prompt: `YOUR TASK: create src/world/puddles.js - the wet-ground and puddle reflection system.
You own this file only. main.js will call createPuddles(ctx) after the park is built and add the
returned group to the scene; export exactly that.

This is the single highest-impact change in the whole art pass. In the reference the plaza is soaked:
large irregular standing puddles mirror the buildings, sky and floodlights, wet borders darken the
concrete around them, and the reflection blurs out with distance and with surface ripple.

Implement:
- A wetness/puddle mask generated procedurally over the park's flat areas, driven by a low-frequency
  noise field biased toward the natural low points (sample ctx.world.collision.raycastDown on a grid
  to find genuinely flat, low ground - puddles must not appear on ramp transitions or decks).
- Reflective puddle surfaces. Use three/addons/objects/Reflector.js for the two or three largest
  puddle areas (a shared reflection render target at a modest resolution, e.g. 512-1024, updated at a
  reduced rate is fine), and for the rest use a cheaper approach: a wet material with very low
  roughness, high envMapIntensity against the scene environment map, plus a screen-space-ish
  distortion. Blend between mirror and rough with the mask so puddle centres read as mirrors and the
  edges feather into damp concrete.
- Correct wet-surface physics: wet areas are darker (albedo multiplied down ~0.55), much smoother
  (roughness ~0.06 in standing water rising to ~0.5 at the damp edge), and reflect at grazing angles
  strongest. Add subtle animated ripple normals so reflections shimmer rather than sitting frozen.
- Puddle edges must have a defined dark rim, and small drying patches so the shapes read as organic.
- Optional interaction: a light ripple burst when the bike rides through a puddle (expose
  splash(position, speed) that the FX system or main can call), and tyre spray is welcome if cheap.
- A wetness level control setWetness(0..1) so the environment's time-of-day/weather can dial it, and
  a dispose() that releases the render targets.
Reflection cost is the risk: cap the reflector count, share render targets, cull by distance, and
skip the reflection update entirely when the camera has barely moved. Report the true cost.
Check your result in the ground-detail, gameplay, bowl and ref1-match shots.`,
  },
  {
    label: 'art:sky',
    prompt: `YOUR TASK: src/world/environment.js - rebuild the sky, cloud deck and atmosphere to match
the reference. You own this file only.

Current output (see shots/round2/skyline.png, gameplay.png, hero.png): a smooth blue-to-warm gradient
with a thin band of cloud, a hard horizon, and no atmospheric depth. The reference has a dramatic
overcast dusk: a full cloud deck with structure and volume, warm sunlight breaking through low near
the horizon, cool blue-grey above, and heavy haze that the city sits inside.

Implement:
- A proper procedural cloud deck: multi-octave domain-warped noise on the sky dome (or a layered
  cloud plane) with believable cumulus/stratus structure, silver-lined edges where the sun is behind
  them, warm underlighting near the horizon and cool tops, drifting slowly. It must read as volume,
  not as a noise texture - use at least two layers at different heights and parallax them.
- A convincing horizon: haze band, the ground plane fading into it, no hard line, distant objects
  desaturating and lifting in value with distance (aerial perspective) rather than just fogging grey.
- Sun break-through: a warm glow disc behind the cloud with a soft bloom-friendly falloff, and light
  shafts if you can do them cheaply.
- Re-tune the whole lighting rig against the reference: key light warm and low, sky fill cool, a
  bounce term off the concrete, exposure set so the concrete sits mid-grey and the sky is bright but
  not blown. Our current frames blow out the sky and crush the ramps to black - fix both.
- Regenerate the PMREM environment from the new sky so IBL matches, and keep setTimeOfDay(t) working
  across dawn/noon/golden/dusk with the cloud deck and haze responding.
- Keep the shadow frustum tight and re-centred on the player.
Check your result in skyline, gameplay, hero, park-wide and dusk shots.`,
  },
  {
    label: 'art:graffiti',
    prompt: `YOUR TASK: src/world/park.js - surface the park like the reference. You own this file only.

In the reference nearly every vertical face carries graffiti - tags, throw-ups, full pieces - plus
painted logos and event banners on the bank faces, and the concrete is stained, patched and worn.
Our park (shots/round2/park-wide.png, bowl.png, gameplay.png) is bare: clean untagged surfaces, ramps
that read as flat dark panels, and no painted graphics anywhere.

The materials library already exposes a 16-cell graffiti/decal atlas (see src/world/materials.js:
library.decals, decalUV(index), decalMaterial(indexOrName, opts)) - use it, and if you need more
variety, compose several decals per surface rather than editing materials.js (another agent owns it).

Implement:
- Graffiti applied to the bowl walls, quarterpipe faces and flat banks, the container, the perimeter
  wall, the ledges and the deck fascias. Place it with deterministic rng at believable positions and
  scales: big pieces low on flat walls, tags clustered near corners and access points, overlapping
  layers where they would build up. Project the decals onto the surface with a slight normal offset
  and correct UV orientation - no floating quads, no stretched decals on curved transitions.
- Painted graphics on the ramp faces and the flat: big invented sponsor wordmarks and event marks,
  worn and partly scuffed off where wheels run.
- Surface storytelling: tyre scuffs and black wheel marks on transitions and coping approaches, wax
  build-up and polish on ledges, patched concrete around the bowl lip, stains under the fence line,
  cracks with weeds, and grind marks on every rail and coping.
- Make sure ramp surfaces actually read as their material: our plywood/skatelite decks currently look
  like flat dark navy panels. Check the UV scale and the material assignment on every ramp face.
Keep the draw-call budget: batch decals into merged geometry or instanced meshes per material.
Check your result in park-wide, bowl, gameplay and ground-detail shots.`,
  },
  {
    label: 'art:skyline',
    prompt: `YOUR TASK: src/world/props.js - rebuild the city backdrop and crowd. You own this file only.

Current output (shots/round2/park-wide.png, gameplay.png, skyline.png): the skyline is a ring of flat
dark boxes with regular window grids and a hard silhouette, and the crowd is white and pink blocks.
The reference has a believable city: mid-rise blocks of varied depth and roofline, an elevated
freeway crossing the middle distance, palm trees, floodlight masts, billboards, cranes, water towers,
all layered into haze so depth reads.

Implement:
- A layered skyline: at least three depth bands with different scales, values and haze contributions,
  buildings with varied footprints, setbacks, rooftop clutter (AC units, stair boxes, aerials, water
  tanks), parapets, and facades whose window grids vary per building (spacing, mullions, some floors
  lit, some dark, reflections of the sky in the glass) rather than one repeated texture.
- An elevated freeway or rail viaduct in the middle distance with piers, barriers and a few vehicles.
- Palm trees and street trees along the far fence line, floodlight masts around the venue, a couple
  of construction cranes, and large invented billboards.
- Depth cueing: the far bands must desaturate and lift in value toward the haze so the city sits
  behind atmosphere instead of being pasted on. Nothing in the backdrop should cast shadows.
- Rebuild the spectator crowd: readable human silhouettes with heads, shoulders, arms and legs, in
  varied clothing colours and poses (standing, leaning on the fence, sitting on the bleachers, a few
  with bikes), instanced, with subtle idle motion. They must not read as boxes - check them in the
  park-wide and gameplay shots at their real on-screen size.
Keep the whole props set under ~120 draw calls using instancing and merged geometry.
Check your result in park-wide, skyline, gameplay and hero shots.`,
  },
  {
    label: 'art:character',
    prompt: `YOUR TASK: src/rider/bike.js - bring the rider up to the reference's character standard.
You own this file only.

Reference 2 shows a fully realised rider: a visible face with real skin shading and hair, a raglan
jersey with a printed chest graphic, loose jeans with fold and seam detail, padded gloves, skate
shoes, and a natural riding pose. Our rider (shots/round2/rider-closeup.png, hero.png) reads as a
dark silhouette with a featureless tan face and thin, stiff limbs.

The file is already profile-driven (see src/rider/customization.js). Keep that architecture and the
createRider(ctx, profile) / rider.applyProfile(profile) API intact. Improve the actual result:
- The head and face: a real skull shape with brow, cheekbones, nose, jaw, chin and ears, and a face
  texture with eyes (iris, pupil, catchlight), brows, lips and skin tone variation with subsurface
  warmth. It must read as a person at the rider-closeup framing.
- Hair as a fitted mesh with volume and a hairline, in the profile's style and colour, and correct
  interaction with headwear (a cap must sit on the hair, not through it).
- Clothing that reads as cloth: correct garment silhouettes with sleeves, hems, collars and a bit of
  looseness, fold and seam detail in the normal map, cuffs and waistbands, and fabric roughness with
  a slight sheen variation. The printed chest graphic must sit on the fabric, following its folds.
- Limb and body proportion: our rider is too thin and too stiff. Give the body believable muscle
  volume and taper, real shoulder and hip mass, hands with a thumb wrapping the grip, and shoes with
  a sole, toe box and laces.
- Lighting response: the rider currently goes almost black in shadow. Check the material albedo and
  roughness so the character holds shape and detail in shadow and reads clearly in silhouette against
  a bright sky. This is a materials problem, not a light problem - do not ask the lighting to change.
Keep the triangle and draw-call budget (~40k tris, ~25 calls) and keep applyProfile() fast.
Check your result in rider-closeup, bike-detail, hero and ref2-match shots.`,
  },
]

phase('Art pass')
log('Dispatching ' + TASKS.length + ' directed art agents')

const results = (await parallel(TASKS.map((t) => () =>
  agent(PRE + '\n' + t.prompt, { label: t.label, phase: 'Art pass', effort: 'high', schema: SCHEMA })
))).filter(Boolean)

return results
