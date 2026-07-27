export const meta = {
  name: 'bmx-gameplay',
  description: 'Build the BMX gameplay + presentation layer: tricks, grinds, scoring, rider animation, HUD, screens, audio',
  phases: [{ title: 'Gameplay', detail: 'seven file-disjoint gameplay/presentation agents' }],
}

const PRE = `You are building ONE subsystem of a AAA-quality third-person BMX freestyle game in Three.js.
Gameplay reference: Dave Mirra Freestyle BMX 2 (PS2/GC, 2001) and Tony Hawk's Pro Skater 3 - trick
vocabulary, combo flow, scoring pacing, HUD language. The project is at /home/user/pendulum-timer/bmx (cwd).

FIRST: read ARCHITECTURE.md in full, then read the files your module talks to. The world layer is
ALREADY BUILT - read the real code, do not guess at its API:
  src/core/engine.js, src/core/input.js, src/core/mathx.js, src/main.js
  src/physics/bikePhysics.js  (state fields, TUNING, events it emits, enterGrind/exitGrind)
  src/physics/collision.js    (nearestRail, railPointAt, railTangentAt)
  src/rider/bike.js           (the rig joint names you can animate)
  src/world/park.js           (rails and their types)
  src/fx/particles.js         (the FX API you can fire)

NON-NEGOTIABLE RULES
- You own ONLY the file(s) in YOUR TASK. Other agents are editing siblings concurrently.
- Three.js r185, ES modules, zero external assets, everything procedural, deterministic rng from mathx.
- Keep the export signature EXACTLY as ARCHITECTURE.md specifies; main.js already calls it.
- No allocation inside fixedUpdate/update loops. No console spam.
- Real, finished code. No TODOs, no stubs, no "simplified for now".
- Verify before finishing:
    npx esbuild YOUR_FILE --bundle --external:three --outfile=/dev/null --format=esm
  Fix every error in YOUR file.
- If a sibling API you need genuinely does not exist yet, code defensively (optional chaining +
  a sensible fallback) rather than breaking the boot, and say so in your returned notes.

FEEL TARGET: instantly readable arcade trick game. Inputs land within 2 frames, tricks read clearly in
silhouette, combos escalate, the HUD sells the score. A harsh critic agent will play and screenshot this.
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

const TASKS = [
  {
    label: 'tricks',
    prompt: `YOUR TASK: src/gameplay/tricks.js - the trick system. You own this file only.

Implement createTricks(ctx) per ARCHITECTURE.md.

Deliver a full DMFBMX2-flavoured trick vocabulary as DATA (an exported TRICKS table), each entry with:
id, display name, category (air/grind/manual/lip/flatland), input recipe (modifier button + direction),
base points, hold bonus per second, minimum air time, pose id for the animation system, and whether it
can be repeated in a combo (repeats must score less - a diminishing multiplier per repeat in the
same combo, exactly like the reference games).

Required tricks, at minimum:
- Airs: tabletop, turndown, toboggan, superman, superman seatgrab, no-hander, one-hander, nothing,
  can-can, x-up, cross-up, tailwhip, double tailwhip, barspin, double barspin, decade, 360 (and 540,
  720, 900 by rotation), backflip, frontflip, flair (backflip + 180), tuck no-hander, invert.
- Grinds: double peg, feeble, smith, ice pick, toothpick, luc-e, crooked, over-toothpick, footjam.
- Manuals: manual, nose manual, and switching between them mid-combo.
- Lip tricks: nose pick, abubaca, footjam whip, tyre tap, disaster.
- Flatland: bunnyhop, hang five, surfer, tailwhip flatland.
Behaviour:
- Read ctx.input with the buffering helpers (pressed/held/bufferedIn) - a trick fires when a modifier
  is combined with a direction, and holding continues the trick (accruing hold bonus) until release
  or landing. Late-release into a landing is a bail (tuck it back in before you land).
- Drive rotation through ctx.player.physics.applyTrickRotation for spins and flips, and name the
  rotation in the combo string once thresholds pass (180/360/540/720/900, flip/double flip).
- Chain into ctx.player.scoring: on each committed trick, call the scoring API to append to the combo;
  on land call scoring with land quality; on bail call scoring bail.
- Set the current pose id on ctx.player.anim (setPose) so the rider actually performs the trick.
- Trigger FX and audio through ctx.fx / ctx.audio where appropriate.
- Grind tricks are selected by the grind system - expose a helper it can call to name a grind trick
  from the current input, and to record grind hold time.
- Balance the numbers so a clean 8-trick line reads 40k-120k points.
Export createTricks and TRICKS.`,
  },
  {
    label: 'grind',
    prompt: `YOUR TASK: src/gameplay/grind.js - rail, coping and ledge grinding. You own this file only.

Implement createGrind(ctx) per ARCHITECTURE.md.

Behaviour:
- Every fixed step while airborne (or landing), query ctx.world.collision.nearestRail with the player
  position and velocity. If the player is within snap distance (~0.45 m of the rail line), is moving
  roughly along it, and the grind input is held (or was buffered within ~200 ms), enter a grind:
  call the physics enterGrind hand-off and take over motion along the rail spline.
- While grinding: advance t along the curve by speed, keep the bike on the rail with correct bank
  (align bike up to the blend of world up and rail normal), lose a little speed to friction that
  depends on the rail type (coping is fast, concrete ledge is slow), and let the player pump/press
  to hold speed.
- Balance meter: an inverted-pendulum balance value that drifts (seeded, per-grind, so different rails
  feel different), corrected by input.steer (or lean for manual-style grinds), with the drift rate
  scaling up the longer the grind lasts. Expose balance -1..1 and a critical flag for the HUD.
  Falling past the threshold bails via the physics bail path.
- Grind type selection from the trick system (double peg / feeble / smith / ice pick / toothpick /
  luc-e / crooked), each with a different bike orientation offset on the rail and different balance
  difficulty. Ask the tricks module to name the trick and to accrue score.
- Exiting: hop off (with a pop that preserves rail speed plus hop), ride off the end (project forward
  into air with the rail tangent), or transfer to another rail if one is within range at the exit.
- Grind-to-grind transfers and 180 reverts on exit should be recognised and reported to scoring.
- Emit sparks continuously through ctx.fx (contact point = wheel/peg contact on the rail) and grind
  audio through ctx.audio, both scaled by speed and rail material.
- Never allow the bike to visually sink into or float above the rail: place it exactly at
  railPointAt(t) plus the peg/wheel offset for the selected grind type.
Expose { active, balance, rail, t, type, fixedUpdate, dispose } and any helper the HUD needs.`,
  },
  {
    label: 'scoring',
    prompt: `YOUR TASK: src/gameplay/scoring.js - score, combos, special meter, goals, session flow.
You own this file only.

Implement createScoring(ctx) per ARCHITECTURE.md.

Deliver:
- Combo model exactly in the spirit of the reference games: each trick appends { name, points } to the
  active combo; the combo multiplier equals the number of scored tricks; the combo total is
  sum(points) * multiplier and is only banked into the score when the rider lands cleanly. A bail
  loses the whole combo. Repeated tricks in one combo score progressively less.
- A combo timer that runs only while the rider is on the ground and not in a manual/grind/air - so
  manuals and grinds link tricks together (this is the core of THPS/Mirra flow). Timer ~2.2 s,
  displayed as a draining bar by the HUD.
- Land quality (from the physics land event) multiplies the banked total: sketchy landing 0.6x,
  clean 1.0x, perfect 1.15x, and a perfect landing adds special meter.
- Special/Mirra meter: fills with style (variety of tricks, air time, grind time, big combos), decays
  slowly while idle, empties on bail. When full, signature tricks become available and score 2x -
  expose isSpecialReady() for the tricks module and the HUD.
- Gaps: register named gap volumes (derive a handful from ctx.world.park geometry bounds if it exposes
  them, otherwise define ~8 sensible named gaps by world coordinates) that award bonus points and
  a name flash when cleared mid-combo.
- Goals for a 2:00 session, DMFBMX2 style: score goals (e.g. 50k / 150k / 400k), collect the letters
  B-M-X (spawn 3 letter pickups in the park - you own their meshes, keep them cheap and readable,
  with a spin/bob animation and a pickup effect), a specific trick goal (e.g. backflip the dirt
  double), a gap goal, and smash 5 objects. Track completion and emit events for the HUD.
- Session flow: 120 s timer, countdown audio cue in the last 10 s via ctx.audio, then a results state
  (emit an event with best combo, longest grind, biggest air, tricks landed, goals completed, final
  score) that src/ui/screens.js renders. Expose restart().
- Persist a high score and completed goals in localStorage under a namespaced key.
Everything the HUD needs must be readable from the returned object each frame without allocating.`,
  },
  {
    label: 'rider-anim',
    prompt: `YOUR TASK: src/rider/riderAnim.js - procedural rider and bike animation. You own this file only.
This is what makes the game look alive; the art director will judge poses in every screenshot.

Implement createRiderAnim(rider, ctx) per ARCHITECTURE.md. Read src/rider/bike.js FIRST to learn the
actual rig joint names and bike part references available to you.

Deliver:
- A pose system: each pose is a table of joint euler targets (plus bike part offsets: bar rotation,
  frame yaw/pitch relative to rider, wheel offsets). Blend between poses with per-joint spring damping
  so transitions are never instant snaps, and support additive layers (e.g. a spin pose plus a lean).
- Poses required, matching the trick ids from src/gameplay/tricks.js: ride idle, pedalling (with a
  real crank-driven leg cycle - the ankles must follow the pedal circle via 2-bone IK, not a canned
  swing), crouch/charge, hop/pop, air tuck, tabletop, turndown, toboggan, superman, no-hander,
  one-hander, nothing, can-can, x-up, tailwhip (bike frame rotates around the rider while the legs
  lift), barspin (bars spin under the hands, hands release and re-catch), decade, backflip/frontflip
  (whole rider+bike rotate, rider tucks), manual (weight back, arms straight), nose manual, each grind
  type (feeble/smith/ice pick/toothpick/luc-e change the bike attitude and the rider stance), lip
  tricks, and a bail ragdoll.
- Bail: a simple verlet/spring ragdoll on the rig for ~1.6 s that reacts to the impact direction, then
  blends back to idle on respawn. It must not explode or invert joints.
- Continuous drivers regardless of pose: wheel rotation from actual ground speed (and slower in air),
  crank rotation locked to the rear wheel by the gear ratio, chain link motion, tyre squash on landing
  compression, fork/frame flex on impact, bar steering from input, rider head look-ahead into turns,
  cloth/jersey wobble (cheap vertex noise or a couple of jiggle bones), and subtle idle breathing.
- Everything must be driven from ctx.player.physics.state (mode, speed, airTime, crouch, compression,
  rotation totals, lean, balance) - read the real field names from the physics file.
- Place rider.group at the physics position/orientation each frame, applying the visual lean/pitch
  offsets so the bike leans into turns and pitches on transitions without the collision moving.
- Zero allocation per frame (preallocate quaternions/eulers), and cost under 0.4 ms.
Expose { update, setPose, playBail, dispose } plus a poses table so the tricks module can name poses.`,
  },
  {
    label: 'hud',
    prompt: `YOUR TASK: src/ui/hud.js and src/ui/hud.css - the in-game HUD. You own these two files only.
NOTE: hud.css also carries the page-level reset (html/body/#viewport/#ui-root rules) - keep those.

Implement createHUD(ctx) per ARCHITECTURE.md.

Deliver a HUD that looks like a modern extreme-sports game, not a browser demo:
- Score readout with animated count-up (odometer roll), a live combo string on the left/centre-bottom
  ("TABLETOP + 360 + FEEBLE GRIND x4  12,400") that builds as tricks land and slams/fades out when
  banked or lost, with a draining combo timer bar attached to it.
- Session timer, goal tracker panel (goal text, tick when complete, a subtle flash on completion),
  special/Mirra meter (a vertical or arced bar that pulses and changes colour when full),
  balance meter for grinds and manuals (horizontal for grinds, vertical for manuals, with a critical
  red zone and shake when near the edge) that appears/disappears smoothly.
- Big centred flashes for gaps, goal completions, special activation, and bails ("BAIL!" with a
  screen-edge red pulse).
- Speed/air-time readouts are optional but a small air-time counter while airborne is a nice touch.
- All type set in a strong condensed sans (use a CSS font stack of system condensed faces plus
  synthetic transform fallback - no webfont downloads), with tight tracking, subtle text shadows,
  slight italic slant for the score, and a consistent accent colour palette. Everything must remain
  legible over both bright sky and dark concrete: use scrims/glows, not raw white text.
- Animate with CSS transforms/opacity only (GPU friendly), driven by class toggles from JS; never
  write layout-thrashing styles per frame. Cache DOM refs, update textContent only on change.
- Respect ctx.flags.hideHud (used by the screenshot harness for beauty shots) and add a subtle
  letterbox/vignette-free clean mode.
- Must scale sensibly from 1280x720 to 2560x1440 (clamp/vw-based sizing).
Read ctx.player.scoring, ctx.player.grind, ctx.player.physics.state and ctx.player.tricks for state -
check the real field names in those files.`,
  },
  {
    label: 'screens',
    prompt: `YOUR TASK: src/ui/screens.js - all front-end and flow screens. You own this file only.
Style must match src/ui/hud.css (read it; you may inject your own <style> block scoped with a prefix
class - do NOT edit hud.css, another agent owns it).

Implement createScreens(ctx) per ARCHITECTURE.md.

Deliver:
- A title screen that appears at boot over the live rendered park (the game keeps rendering behind it):
  game logo built from styled DOM text (invent the branding - do NOT use the Dave Mirra or Tony Hawk
  trademarks), a slow cinematic camera orbit around the park behind the panel (drive ctx.engine.camera
  through a dedicated path, and hand control back to ctx.cameraRig when the session starts),
  animated menu items with hover/selection states, keyboard + gamepad navigation.
- Menu: START SESSION, PARK TOUR (a scripted camera flythrough of the park with feature captions),
  CONTROLS (a full remappable control list reading ctx.input.binds, with click-to-rebind and gamepad
  button display), OPTIONS (quality tier via ctx.engine.setQuality, time of day via
  ctx.world.environment.setTimeOfDay, master volume via ctx.audio, invert camera, HUD scale),
  and CREDITS.
- Pause screen (Escape / Start): freezes ctx.flags.paused, dims and blurs the scene behind
  (CSS backdrop-filter), resume / restart / options / quit to title.
- Session results screen driven by the scoring session-end event: animated score tally that counts up
  line by line (best combo, longest grind, biggest air, tricks landed, goals completed, final score),
  a letter grade, new-high-score celebration, and retry / title buttons.
- Goal briefing overlay shown for ~3 s when a session starts, listing the session goals.
- All screens: fully keyboard and gamepad navigable, focus-visible states, no browser default styling,
  smooth enter/exit transitions, and pointer-events managed so gameplay input is not eaten while
  hidden. Everything must be legible and centred at any aspect ratio.
Expose { show(id), hide(id), update(dt, ctx), dispose } and start the game in the title state.`,
  },
  {
    label: 'audio',
    prompt: `YOUR TASK: src/audio/audio.js - the entire synthesized soundtrack and SFX engine.
You own this file only.

Implement createAudio(ctx) per ARCHITECTURE.md. Everything is generated with the WebAudio API -
no audio files, no fetch.

Deliver:
- A master chain: input bus -> compressor (light limiting) -> master gain -> destination, plus a
  convolution reverb send whose impulse response you synthesize procedurally (exponentially decaying
  filtered noise, ~1.4 s, slightly stereo) for a big outdoor-lot feel, and a separate short slap
  delay for grind sounds.
- Browsers block audio until a gesture: create the AudioContext lazily and resume it on the first
  keydown/pointerdown, and expose setMasterVolume/mute. Never throw if audio is unavailable.
- Continuous layers driven per frame from physics state: tyre roll (filtered noise + a resonant band
  whose centre frequency and gain track speed, with the filter character switching by surface -
  concrete, wood, dirt, metal), wind (noise through a lowpass that opens with airspeed), chain/
  freewheel clicking (a click train at the rear-hub rate while coasting, silent while pedalling).
- One-shots: hop pop, tyre landing thud (with a pitch/level curve by impact speed), clean-land
  whoosh, bail crunch (a layered noise burst + metal clang + body thud), peg-on-rail chirp on grind
  entry, grind loop (a sawtooth/noise blend, pitch tracking speed, timbre by rail type: steel coping
  rings, concrete ledge grates), rail exit clank, crowd cheer swells on big combos and on landing a
  special, crowd gasp on bail, goal chime, letter pickup, countdown beeps and a session-end horn.
- A loopable backing track built from oscillators and noise: a punk/big-beat groove at ~150 BPM with
  kick, snare, hats, a driving bass line and a couple of guitar-ish detuned saw stabs, arranged as an
  8-bar loop with variation so it does not obviously repeat, ducking slightly under big SFX.
  Schedule with precise AudioContext timing (lookahead scheduler), not setInterval-per-note.
- Positional flavour: pan tyre/grind sounds slightly by the player's screen-space position relative
  to camera, or use a PannerNode following the bike.
- Subscribe to ctx events (land, bail, hop, skid, wheelContact, wallride) and to scoring/goal events.
- update(dt, ctx) must be allocation-free and cost under 0.2 ms; all node graphs are built once and
  reused, with voice pooling for one-shots.
Expose { enabled, ctxAudio, setMasterVolume, mute, play(name, opts), update, dispose }.`,
  },
]

phase('Gameplay')
log('Fanning out ' + TASKS.length + ' gameplay/presentation agents')

const results = await parallel(TASKS.map((t) => () =>
  agent(PRE + '\n' + t.prompt, { label: t.label, phase: 'Gameplay', effort: 'high', schema: SCHEMA })
))

return results.filter(Boolean)
