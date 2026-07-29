# MIRRA CITY — status and how to resume

## What this is
A single-map THPS-style BMX freestyle demo in Three.js r185. Timed 2:00 runs, a
52-trick vocabulary, grinds, manuals, combos, challenges, achievements,
collectibles, persistent high scores, a custom rider creator, controller-first
input and a full settings screen. ~30k lines across `src/`, no external assets —
every texture, mesh and sound is generated in code.

Run it: `cd bmx && npm install && npx vite` then open the printed URL.

## Verified state

`node tools/playtest.mjs` — 15 headless gameplay invariants, all passing:
boot, acceleration to ~12 m/s, 0.87 m hop, trick scoring, grind acquisition,
manual hold, bail recovery, out-of-bounds respawn, park containment, the 2:00
session ending in results, letter pickups, both cheat states, draw-call budget
(174 calls / 406k tris), no console errors.

`node tools/shoot.mjs --out shots/rev-X` — renders 12 staged frames headlessly
(hero, park-wide, rider close-up, bike detail, grind, live gameplay, bowl,
ground detail, skyline, dusk, plus two framings that mirror the reference
images). Software rendering, so a full set takes 20-40 minutes.

The easter egg: a rider named "James Paterson" cannot bail and executes tricks
at 1.5x. Renaming away from it restores normal behaviour. Both directions are
covered by playtest scenarios.

## Open art findings (the loop's queue)

1. RIDER ANATOMY — limbs are still smooth constant-width tubes with no deltoid,
   biceps, forearm taper or calf mass. The head, face, hair, clothing and grip
   are now real; the underlying body is not. This is the top item.
2. GRADE — frames run cold and dark against the reference, which is warm and
   saturated. Exposure and colour balance need a pass against reference/target-look.png.
3. SURFACE DENSITY — ramp faces still read flatter than the reference's; the
   plaza needs more joint, patch and wear information at mid distance.
4. SKYLINE — the far city reads as boxes with window grids rather than layered
   buildings sitting in haze.
5. Graffiti saturation plus bloom can blow out in shade; needs verification
   against the reference rather than guesswork.

## How the loop resumes

    Workflow({ scriptPath: 'bmx/tools/wf-character.mjs', args: { rounds: 3 } })
    Workflow({ scriptPath: 'bmx/tools/wf-loop.mjs',      args: { rounds: 3 } })

`wf-character.mjs` runs sculpt -> pose -> three character critics per round and
only exits when the full panel passes and nobody still calls the rider a potato.
`wf-loop.mjs` runs capture -> six art critics -> one fix agent per owning file,
and exits when every lens passes and no critic prefers the reference frame.
Both require the full critic panel to have actually run before declaring
convergence — an empty panel is not a pass.

## Environment hazards worth knowing

* This container periodically rolls its filesystem back to an older snapshot.
  Anything not pushed to origin at that moment is lost — a full round of finished
  agent work was lost that way. Every agent runs `bash tools/save.sh "msg" <file>`
  as soon as it has a working change, and again after each further edit.
* Rendering is software (swiftshader) at roughly 1 fps, so real-time play never
  happens in captures. Use `window.__BMX.simulate(seconds)` to step physics,
  tricks and scoring independently of the render loop.
* Review captures go in `shots/rev-A`, `rev-B`, ... Never reuse a numeric
  `roundN` name: critics once judged a stale `shots/round1` capture and scored
  three-round-old work.
