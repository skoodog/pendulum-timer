export const meta = {
  name: 'bmx-rider-creator',
  description: 'Custom rider creator: profile model, parameterised rider/bike build, creation screen, and the cheat hooks',
  phases: [
    { title: 'Profile', detail: 'the customization model and cheat rules' },
    { title: 'Build', detail: 'parameterised rider/bike, creator screen, cheat consumption' },
  ],
}

const PRE = `You are working on a AAA-quality third-person BMX freestyle game in Three.js at
/home/user/pendulum-timer/bmx (cwd). THPS-style structure, Dave Mirra trick feel, single-map demo.

FIRST read ARCHITECTURE.md IN FULL - especially "DEMO SCOPE", "ART DIRECTION TARGET", "HUD LAYOUT",
"SECOND REFERENCE", "CONTROLLER SUPPORT", "SETTINGS SCREEN" and "RIDER CREATOR" at the end. Read
reference/target-look.png with the Read tool (it renders as an image). Then read the code you depend on:
  src/rider/bike.js (the existing rider+bike builder), src/rider/riderAnim.js
  src/world/materials.js (colourways, tint(), variant() - use these for every colour choice)
  src/physics/bikePhysics.js (bail paths), src/gameplay/tricks.js (rotation and timing gates)
  src/ui/screens.js, src/ui/hud.css, src/ui/glyphs.js, src/core/input.js, src/main.js

NON-NEGOTIABLE RULES
- You own ONLY the file(s) in YOUR TASK. Other agents edit siblings concurrently.
- No external assets; every texture procedural, every mesh built in code. Deterministic rng from mathx.
- All printed graphics and brand marks INVENTED. Never reproduce a real trademark.
- Do not break existing call sites. Real, finished code, no TODOs.
- Verify: npx esbuild YOUR_FILE --bundle --external:three --outfile=/dev/null --format=esm
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

phase('Profile')

const profile = await agent(PRE + `
YOUR TASK: create src/rider/customization.js - the rider profile model. You own this file only.
Everything else in this workflow depends on your API, so make it complete and stable.

Implement exactly the model in the "RIDER CREATOR" section of ARCHITECTURE.md:
- DEFAULT_PROFILE plus a full OPTIONS catalogue: every selectable value for gender, height range,
  build range, skin tones (a believable spread, not 3 swatches), hair styles and colours, facial
  hair, headwear, top styles with colour + accent + invented graphic choices, bottom styles, shoes,
  gloves, pads, and the bike options (frame/rims/tyres/grips/seat/pegs/chrome/decals) mapped onto
  the colourways in materials.js.
- createCustomization(ctx) returning { profile, profiles, load, save, create, remove, randomize,
  applyTo(rider), cheatsFor(name), validate(profile) } with localStorage persistence under a
  namespaced key, a safe migration path for old stored shapes, and a deterministic randomize().
- cheatsFor(name): returns { noBail: true, trickSpeed: 1.5 } when the trimmed, case-insensitive name
  equals "james paterson", otherwise { noBail: false, trickSpeed: 1.0 }. Also expose the active
  cheats on ctx (e.g. ctx.player.cheats) when a profile is applied, so physics and tricks can read
  them without importing this module. Keep it an easter egg - no UI hint, no console log.
- Helpers the creator screen needs: a category/tab description of every option group (label, key,
  kind: 'swatch'|'slider'|'choice', values) so the UI can be generated from data rather than
  hand-written per option, plus prettyName() for display.
- applyTo(rider) must call rider.applyProfile(profile) if present and otherwise degrade gracefully.
`, { label: 'customization', phase: 'Profile', effort: 'high', schema: SCHEMA })

phase('Build')

const TASKS = [
  {
    label: 'rider-parameterised',
    prompt: `YOUR TASK: src/rider/bike.js - make the rider and bike fully profile-driven. You own this file only.

Read src/rider/customization.js (just written) for the exact profile shape and option values.

- Change the signature to createRider(ctx, profile) with profile defaulting to DEFAULT_PROFILE, and
  add rider.applyProfile(profile) that updates the existing rider in place: swap materials/colours
  instantly, and rebuild only the geometry that actually depends on the changed field.
- height and build must genuinely reshape the character: scale limb lengths and torso proportions
  from height, and drive limb girth, torso depth, shoulder width and neck thickness from build.
  The rider's fit on the bike must follow (reach to the bars, knee bend at the pedals) - a 1.60 m
  rider and a 1.95 m rider must both look correct on the same bike, not floating or crouched.
- gender drives skeleton proportions and body shape (shoulder-to-hip ratio, chest and hip volume,
  limb taper) with a neutral option in between. Keep it respectful and simple: proportion presets.
- Build the head properly per the SECOND REFERENCE: a real head shape with brow, nose, jaw and ears,
  a face texture generated procedurally (eyes, brows, mouth, subtle skin variation) with the chosen
  skin tone, and hair as a fitted mesh in the chosen style and colour. With headwear 'none' the head
  must still look finished; 'cap'/'capBackwards' need a brim; 'helmet' keeps the current helmet.
- Clothing per profile: tee/raglan/jersey/hoodie/tank tops with the correct sleeve shape and an
  invented printed graphic, jeans/shorts/pants/joggers with fold and seam normal detail, shoes with
  soles and laces, optional gloves and pads. Fabric must respond like fabric, not plastic.
- Bike colours from the profile using the materials library colourways and tint(), including
  anodised vs chrome frames, rim colour, tyre wall, grips, seat and pegs, plus optional frame decals.
- Everything must still cast shadows, keep the contact-patch origin and forward = +Z convention,
  and stay within the triangle and draw-call budget. Cache built geometry so applyProfile() during
  live preview stays smooth (target under 40 ms per change).`,
  },
  {
    label: 'rider-creator-ui',
    prompt: `YOUR TASK: create src/ui/riderCreator.js - the rider creation screen. You own this file only.
Do not edit screens.js, settings.js or hud.css; inject your own scoped <style> block matching their
visual language.

Implement createRiderCreator(ctx) -> { open(), close(), isOpen, update(dt, ctx), dispose }:
- A live 3D turntable preview: the actual rider mesh on the bike, slowly rotating, on a soft
  studio-lit backdrop (its own scene or a dedicated camera and light rig over the game scene), with
  drag-to-rotate, scroll/trigger to zoom, and a focus mode that frames the head when a face option
  is being edited and the bike when a bike option is being edited.
- Category tabs (Body / Face / Outfit / Bike) generated from the option catalogue exported by
  src/rider/customization.js - do not hand-write the option list. Swatch grids for colours, sliders
  for height/build, choice rows for styles, each applying instantly to the preview.
- A name field (keyboard entry, plus an on-screen character picker so a gamepad can type), profile
  management (save, load, delete, duplicate, randomise), and a roster of saved riders shown as cards.
- Full mouse + keyboard + gamepad navigation using src/ui/glyphs.js for prompts, with clear focus
  states and smooth transitions. B/Escape backs out, A/Enter confirms, shoulder buttons switch tabs.
- Reachable from the title screen and pause menu: expose open() and emit an event when a profile is
  confirmed so the game can rebuild the player rider.
- The name field must NOT hint at any special name or cheat.`,
  },
  {
    label: 'cheat-hooks',
    prompt: `YOUR TASK: wire the profile cheats into gameplay. You own EXACTLY these two files:
  src/physics/bikePhysics.js
  src/gameplay/tricks.js

Read src/rider/customization.js for cheatsFor(name) and where the active cheats are exposed
(ctx.player.cheats). Implement the easter egg described in the "RIDER CREATOR" section of
ARCHITECTURE.md, exactly:

1. bikePhysics.js - when cheats.noBail is true the rider CANNOT fall:
   - every code path that would set mode 'bail' is suppressed;
   - a landing outside the normal angle tolerance is auto-corrected: snap the bike to the landing
     surface and keep the speed, as if it were a clean land (still emit the land event, with a
     quality no lower than 'clean' so scoring is not punished);
   - manual and grind balance never reaches a failing threshold (clamp the balance value);
   - landing on a coping edge, landing too slow on a transition, and out-of-bounds all recover in
     place instead of bailing;
   - none of this may change behaviour when the cheat is off - guard every branch, and keep the
     normal bail logic byte-for-byte intact on the default path.
2. tricks.js - when cheats.trickSpeed is not 1.0, scale trick execution by it:
   - trick rotation rates (spins and flips) multiply by trickSpeed;
   - the minimum air time / hold time gates for a trick to count divide by trickSpeed;
   - the pose playback rate passed to the animation system multiplies by trickSpeed;
   - so at 1.5 a player fits roughly 1.5x as many tricks into the same air.
Read the cheats defensively (ctx.player?.cheats?.noBail ?? false) so the modules still work if the
customization system is absent. Do not log or otherwise reveal the easter egg. Do not change any
other behaviour in these two files.`,
  },
]

log('Building parameterised rider, creator UI and cheat hooks')
const built = (await parallel(TASKS.map((t) => () =>
  agent(PRE + '\n' + t.prompt, { label: t.label, phase: 'Build', effort: 'high', schema: SCHEMA })
))).filter(Boolean)

return { profile, built }
