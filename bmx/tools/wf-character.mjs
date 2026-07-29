export const meta = {
  name: 'bmx-character-overhaul',
  description: 'Deep iterative overhaul of the rider: anatomy, head and face, hands, clothing, shading and riding pose, looped against harsh character critics',
  phases: [
    { title: 'Sculpt', detail: 'rider mesh and materials' },
    { title: 'Pose', detail: 'riding pose, grip and weight' },
    { title: 'Judge', detail: 'character critics' },
  ],
}

const ROUNDS = (args && args.rounds) || 3

const BRIEF = `
THE PROBLEM, IN THE CLIENT'S WORDS: "the guy looks like a potato".

That is an accurate description of shots/round3/rider-closeup.png. The rider is a doughy, soft-edged
mannequin: a rounded blob head with a flat painted face, sausage limbs with no anatomy, no hands to
speak of, clothing that is a coloured skin rather than a garment, and a stiff symmetrical pose. At
gameplay distance he collapses into a dark smudge. This is the single biggest thing standing between
this project and looking like a released game.

WHAT "NOT A POTATO" MEANS, CONCRETELY:

ANATOMY AND PROPORTION
- 7.5 heads tall. Shoulder width about 2.2 head-widths for a male build. Elbow at navel height,
  wrist at crotch height, fingertips mid-thigh. Knee at the midpoint of the leg.
- Limbs TAPER and have landmarks: deltoid cap over the shoulder, biceps and triceps mass, a forearm
  that is wide near the elbow and narrow at the wrist, quadriceps mass above the knee, a calf belly
  high on the shin, ankles that are narrow. A limb that is one constant-radius capsule is the single
  clearest tell of amateur work.
- Torso: ribcage mass, a narrower waist, hip/pelvis mass, shoulders that slope into the neck rather
  than meeting it at a right angle. The neck is a cylinder set FORWARD of the spine with the
  sternocleidomastoid running to the collarbone.

HEAD AND FACE (this is where "potato" comes from)
- Build a real skull: cranium mass, brow ridge, temple hollow, cheekbone, the plane change from
  cheek to jaw, jaw angle, chin, and the nose as GEOMETRY (bridge, tip, nostrils, wings) not paint.
- Eyes as actual geometry: eyeball spheres set into sockets, upper and lower lids with thickness,
  a brow that overhangs. A face texture alone reads flat and dead at any close framing.
- Ears with a helix and lobe. A hairline that follows the skull, hair with volume and a parting.
- The head must survive the rider-closeup framing (subject filling ~80% of frame height) without
  looking like a mask.

HANDS AND FEET
- Five fingers with three segments each, knuckle mass, and a THUMB WRAPPING THE GRIP from the far
  side. The hand must close around the bar, not hover near it.
- Shoes with a sole, midsole line, toe box, heel counter and laces, with the ball of the foot on
  the pedal and the ankle at a natural angle.

CLOTHING AS GARMENTS
- A tee/jersey is a shell with thickness, a collar rib, a hem that sits away from the body, sleeve
  openings with an edge, and folds that gather at the armpit, the elbow and where the fabric is
  compressed by the pose. It is not a painted layer on the skin mesh.
- Jeans with a waistband, fly seam, pocket outlines, knee break folds and a hem stack over the shoe.
- Fabric shading: higher roughness than skin, a slight sheen variation, and enough albedo that the
  garment holds its shape in shadow instead of crushing to black.

SKIN AND SHADING
- Skin needs warmth in the shadow terminator (a cheap wrap/subsurface approximation), not a flat
  lambert falloff. Ears and fingers pick up more warmth.
- The whole character must READ AT GAMEPLAY DISTANCE: check the gameplay and ref1-match framings.
  If the rider becomes a black silhouette there, the albedo and roughness are wrong - fix them on
  the character, do not ask the lighting to change.

REFERENCE: read reference/target-look.png with the Read tool, and the "SECOND REFERENCE" section at
the end of ARCHITECTURE.md, which describes the reference rider in detail (raglan jersey, jeans,
gloves, visible face and hair, natural riding posture).

CONSTRAINTS
- The rider is profile-driven (src/rider/customization.js): gender, height 1.60-1.95, build 0..1,
  skin tone, hair style/colour, headwear, tops, bottoms, shoes, gloves, pads. Every improvement must
  hold across the whole option space, and createRider(ctx, profile) / rider.applyProfile(profile)
  must keep working with the same signature and stay fast enough for live preview.
- Budget: rider + bike about 40k triangles and ~25 draw calls. Anatomy is a shape problem, not a
  polygon-count problem - spend triangles where the silhouette needs them (head, hands, shoulders,
  knees) and save them on hidden surfaces.
- No external assets. Procedural textures only. Deterministic rng from src/core/mathx.js.
PERSIST YOUR WORK OR IT WILL BE LOST. This container periodically rolls its filesystem back to an
older snapshot. Anything not pushed to origin at that moment is gone - a previous run lost a full
round of finished work this way. Therefore:
  * As soon as you have a working change, run:  bash tools/save.sh "short message" <your file>
  * Run it again after every further round of edits. Little and often.
  * It commits, rebases onto origin and pushes, and is safe to run while other agents do the same.
  * Never finish without a successful save.sh push.

`

const SCULPT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['file', 'changes', 'iterations', 'verified', 'notes'],
  properties: {
    file: { type: 'string' },
    changes: { type: 'array', items: { type: 'string' } },
    iterations: { type: 'string' },
    verified: { type: 'string' },
    notes: { type: 'string' },
  },
}

const CRITIC_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['lens', 'score', 'potato', 'verdict', 'findings'],
  properties: {
    lens: { type: 'string' },
    score: { type: 'number', description: '0-10, 7 = shippable character' },
    potato: { type: 'string', enum: ['yes', 'borderline', 'no'],
      description: 'does the rider still read as a soft featureless mannequin' },
    verdict: { type: 'string', enum: ['PASS', 'FAIL'] },
    findings: {
      type: 'array', maxItems: 10,
      items: {
        type: 'object', additionalProperties: false,
        required: ['severity', 'part', 'problem', 'fix', 'file'],
        properties: {
          severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
          part: { type: 'string', description: 'head / hands / torso / legs / clothing / pose / shading' },
          problem: { type: 'string' },
          fix: { type: 'string' },
          file: { type: 'string', enum: ['src/rider/bike.js', 'src/rider/riderAnim.js'] },
        },
      },
    },
  },
}

const SHOTS = 'rider-closeup,bike-detail,hero,gameplay,ref2-match,grind'

let notes = ''

for (let round = 1; round <= ROUNDS; round++) {
  phase('Sculpt')
  log('Character round ' + round + ': sculpting the rider mesh')

  const sculpt = await agent(
    `You are a character artist on a AAA BMX game at /home/user/pendulum-timer/bmx (cwd).
YOUR FILE: src/rider/bike.js (you own the rider and bike mesh, its geometry and its materials).
Do not edit any other file.

` + BRIEF + (notes ? '\n\nCRITIC FEEDBACK FROM THE PREVIOUS ROUND - fix all of it:\n' + notes : '') + `

METHOD (follow it, do not shortcut it):
1. Read src/rider/bike.js and src/rider/customization.js. Read reference/target-look.png.
2. Look at the CURRENT result before changing anything:
     node tools/shoot.mjs --out shots/char-r${round}-before --only rider-closeup,gameplay --w 1280 --h 720
   Read both PNGs. Write down exactly what is wrong in the pixels.
3. Rebuild the anatomy that is wrong. Work in this order: head and face, then hands, then body
   proportion and limb taper, then clothing as garments, then shading.
4. After each substantive change, render and LOOK:
     node tools/shoot.mjs --out shots/char-r${round}-N --only ${SHOTS} --w 1280 --h 720
   Read the PNGs. Compare to the reference. Keep going. You are expected to run this loop at least
   four times - a single pass will not fix a potato.
5. Verify it still builds and still runs:
     npx esbuild src/rider/bike.js --bundle --external:three --outfile=/dev/null --format=esm
     node tools/playtest.mjs --only boot,perf-budget
6. Report the triangle and draw-call cost of the rider from the playtest perf line.

Your "verified" field must describe what you actually saw in the final renders, per body part.`,
    { label: 'sculpt:r' + round, phase: 'Sculpt', effort: 'high', schema: SCULPT_SCHEMA }
  )

  phase('Pose')
  log('Character round ' + round + ': riding pose and grip')

  const pose = await agent(
    `You are an animator on a AAA BMX game at /home/user/pendulum-timer/bmx (cwd).
YOUR FILE: src/rider/riderAnim.js (you own posing and animation). Do not edit any other file -
another agent owns the mesh in src/rider/bike.js and has just rebuilt it, so READ IT FIRST for the
current rig joint names and any new joints (fingers, thumbs, facial pieces).

` + BRIEF + (notes ? '\n\nCRITIC FEEDBACK FROM THE PREVIOUS ROUND - fix all of it:\n' + notes : '') + `

YOUR SPECIFIC TARGET: the rider's POSE currently reads as a stiff, symmetrical mannequin sat on the
bike. Real BMX riding posture:
- Weight forward and low, hips off the seat or just brushing it, chest down toward the bars, back
  rounded rather than upright.
- Arms bent, elbows OUT and slightly asymmetric, wrists rolled over the grips, every finger closed
  around the bar with the thumb wrapped underneath.
- Balls of the feet on the pedals, heels dropped slightly, knees tracking outward around the frame,
  one leg naturally slightly different from the other.
- Head UP looking down the line, not staring at the bars, with the neck extended.
- Nothing perfectly symmetrical: offset the two sides by a few degrees everywhere.
- The pedalling cycle must drive the legs from the actual crank position (2-bone IK to the pedal),
  and the rider's mass must shift with lean, pitch, crouch, landing compression and speed.
- Every trick pose must be a real recognisable shape (a tabletop lays the bike flat under a rider
  whose legs are extended to the side; a superman has the legs off the back with straight arms).

METHOD: same loop as the mesh artist - render, LOOK, iterate at least four times:
     node tools/shoot.mjs --out shots/pose-r${round}-N --only ${SHOTS} --w 1280 --h 720
Verify: npx esbuild src/rider/riderAnim.js --bundle --external:three --outfile=/dev/null --format=esm
        node tools/playtest.mjs --only boot,trick-scores`,
    { label: 'pose:r' + round, phase: 'Pose', effort: 'high', schema: SCULPT_SCHEMA }
  )

  phase('Judge')
  log('Character round ' + round + ': judging')

  const CRITICS = [
    { id: 'anatomy', brief: `LENS: ANATOMY AND FORM. Judge proportion (head count, shoulder width, limb lengths), limb taper and muscle landmarks, joint construction, the head and face as a built skull rather than a painted ball, hands and whether the fingers and thumb genuinely wrap the grip, feet on the pedals. Call out anything that reads as a capsule, a sphere or a box. Be merciless about softness and symmetry.` },
    { id: 'costume', brief: `LENS: CLOTHING, MATERIALS AND SHADING. Judge whether garments read as garments (thickness, collar, hem, cuffs, sleeve openings, fold structure) or as painted-on colour, fabric roughness and sheen, skin shading and shadow warmth, hair as a built form with a hairline, and whether the character holds detail in shadow. Then check the gameplay and ref1-match frames: does the rider read as a person at that distance, or as a dark blob?` },
    { id: 'pose', brief: `LENS: POSE, MOTION AND BELIEVABILITY. Judge the riding posture against how a BMX rider actually sits on a bike, hand and foot contact, asymmetry, head direction, the trick pose in the hero/air frame, the grind stance, and whether the rider looks like they are riding the bike or has been placed on top of it. Any interpenetration, floating limb or contact that does not touch is a critical.` },
  ]

  const reviews = (await parallel(CRITICS.map((c) => () =>
    agent(
      `YOU ARE A HOSTILE CHARACTER ART DIRECTOR on a AAA game. Your default answer is NO. The client
has already rejected this character with the words "the guy looks like a potato".

` + c.brief + `

Read reference/target-look.png with the Read tool, and the "SECOND REFERENCE" section at the end of
/home/user/pendulum-timer/bmx/ARCHITECTURE.md which describes the reference rider.

Judge these frames in /home/user/pendulum-timer/bmx/shots/char-round${round}/ - read EVERY png:
they are the current state of the character. If that directory does not exist, use the most recent
shots/char-r${round}-* or shots/pose-r${round}-* directory you can find, and say which you used.

Score 0-10 (7 = a shippable character in a released game, 8+ = matches the reference rider), answer
whether it still reads as a potato, and file findings against exactly one of src/rider/bike.js
(mesh, geometry, materials) or src/rider/riderAnim.js (pose, motion). Do not edit any file.`,
      { label: 'judge:' + c.id + ':r' + round, phase: 'Judge', effort: 'high', schema: CRITIC_SCHEMA }
    )
  ))).filter(Boolean)

  const avg = reviews.length ? reviews.reduce((s, r) => s + r.score, 0) / reviews.length : 0
  const fails = reviews.filter((r) => r.verdict === 'FAIL')
  const potatoes = reviews.filter((r) => r.potato === 'yes')
  log('Character round ' + round + ': avg ' + avg.toFixed(1) + '/10, ' + fails.length + ' FAIL, ' +
      potatoes.length + ' still call it a potato')

  // Judges that failed to run are not a pass. Require the full panel.
  const judged = reviews.length === CRITICS.length
  if (judged && !fails.length && !potatoes.length) {
    log('Character round ' + round + ': PASSED - no critic fails it and nobody calls it a potato.')
    return { rounds: round, avg: +avg.toFixed(2), converged: true,
             scores: reviews.map((r) => ({ lens: r.lens, score: r.score, potato: r.potato })) }
  }

  notes = reviews.flatMap((r) => (r.findings || []).map((f) =>
    '[' + f.severity + '] (' + f.part + ', ' + f.file + ') ' + f.problem + ' -> FIX: ' + f.fix
  )).join('\n')
}

return { rounds: ROUNDS, converged: false, lastNotes: notes }
