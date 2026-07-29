export const meta = {
  name: 'bmx-critique-loop',
  description: 'Self-driving quality loop: capture frames, run hostile critics against the reference, fix every confirmed finding, repeat until the critics stop failing it',
  phases: [
    { title: 'Capture', detail: 'render a fresh frame set and run the gameplay playtest' },
    { title: 'Critique', detail: 'independent critics blind-comparing against the reference' },
    { title: 'Fix', detail: 'one agent per owning file' },
  ],
}

// args: { rounds?: number, startRound?: number, focus?: string }
const ROUNDS = (args && args.rounds) || 3
const START = (args && args.startRound) || 1
const FOCUS = (args && args.focus) || ''

const OWNED_FILES = [
  'src/world/materials.js', 'src/world/environment.js', 'src/world/park.js',
  'src/world/props.js', 'src/world/puddles.js',
  'src/rider/bike.js', 'src/rider/riderAnim.js', 'src/rider/customization.js',
  'src/physics/bikePhysics.js', 'src/physics/collision.js',
  'src/gameplay/tricks.js', 'src/gameplay/grind.js', 'src/gameplay/scoring.js',
  'src/fx/particles.js',
  'src/ui/hud.js', 'src/ui/screens.js', 'src/ui/settings.js', 'src/ui/glyphs.js',
  'src/audio/audio.js', 'src/core/engine.js', 'src/core/camera.js', 'src/core/input.js',
]

const REFERENCE = `
THE REFERENCE FRAME: /home/user/pendulum-timer/bmx/reference/target-look.png
READ IT WITH THE READ TOOL FIRST - it renders as an image. It is a frame from a released commercial
BMX game and it is the exact bar this project must meet: an overcast dusk cloud deck, wet concrete
with puddles mirroring the skyline, graffiti on every vertical face, interconnected concrete bowls
and banks, a city backdrop with an elevated freeway and palms, a close low chase camera with the
rider large in frame, and a HUD with score + special top-left, a competition leaderboard beneath it,
a centred timer, a trick-list counter top-right and a gold trick callout bottom-centre.

A SECOND reference (not on disk) is described in the "SECOND REFERENCE" section at the end of
ARCHITECTURE.md - READ THAT SECTION. It raises the bar on wet-ground reflection, character fidelity
(a rider with a visible face, hair, layered clothing and real fabric response) and controller-first
UI with Xbox glyphs.

THE BLIND A/B: for each of our frames, ask whether a stranger shown our frame and the reference side
by side, unlabelled, would call ours or theirs the better-looking game. Answer honestly and name the
single visual property that decided it. "It is procedural" and "it is WebGL" are not defences.
`

const HARSHNESS = `
YOU ARE A HOSTILE ART DIRECTOR. Your default answer is NO.
- Judge ONLY what is in the pixels. Do not credit intent, effort or code quality.
- Be specific and physical: name the object, where in frame, and what is wrong optically.
- Every finding needs a concrete, implementable fix.
- Score 0-10 where 7 = shippable and 8+ = beats the reference on that lens. Be stingy.
- Anything broken (missing rider, black frame, z-fighting, blown exposure, garbled text, geometry
  clipping, a HUD element rendering wrong) is CRITICAL and outranks all aesthetic notes.
- Do not repeat a finding that is already fixed in the frames you are looking at. Judge THIS set.
`

const FINDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lens', 'score', 'blindAB', 'blindABWhy', 'verdict', 'findings'],
  properties: {
    lens: { type: 'string' },
    score: { type: 'number' },
    blindAB: { type: 'string', enum: ['ours', 'theirs', 'toss-up'] },
    blindABWhy: { type: 'string' },
    verdict: { type: 'string', enum: ['PASS', 'FAIL'] },
    findings: {
      type: 'array', maxItems: 10,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'shot', 'problem', 'fix', 'file'],
        properties: {
          severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
          shot: { type: 'string' },
          problem: { type: 'string' },
          fix: { type: 'string' },
          file: { type: 'string' },
        },
      },
    },
  },
}

const LENSES = [
  { id: 'lighting', brief: `LENS: LIGHTING, ATMOSPHERE AND GRADE. Sun angle and colour, shadow softness/density/resolution, ambient occlusion in crevices and at contact points, sky and cloud believability, atmospheric perspective, exposure and tonemapping, bloom restraint, colour grade and saturation, grain/vignette/aberration. Does the frame read as a specific time of day in a specific place, with a designed key/fill/rim structure - or as flat uniform illumination? Is the image warm and saturated like the reference, or grey and lifeless?` },
  { id: 'materials', brief: `LENS: MATERIALS AND SURFACE DETAIL. Texel density at every distance, tiling repetition, normal map strength, roughness variation, whether metal reads as metal and concrete as concrete, edge wear, grime in the right places, decal and graffiti integration, wet-surface response and puddle reflection quality. Name the single worst surface in each frame.` },
  { id: 'park', brief: `LENS: LEVEL DESIGN, COMPOSITION AND SET DRESSING. Park layout readability, correct ramp geometry (true arcs, coping at the lip), construction believability, scale against the rider, set dressing density and quality, the skyline and backdrop, negative space and framing. Would a BMX rider know exactly what line to ride?` },
  { id: 'character', brief: `LENS: RIDER AND BIKE. Bike proportions against a real 20 inch BMX, frame geometry, tube junctions, wheels and drivetrain, chrome vs anodised response. Then the rider: proportions, silhouette, joint articulation, pose believability, hands actually gripping the bars, feet on the pedals, clothing shape and fold detail, face and hair. Check the rider at BOTH close-up and gameplay distance - a character that reads at 2 m and becomes a black blob at 8 m fails. Interpenetration, floating limbs and mannequin stiffness are majors.` },
  { id: 'ui', brief: `LENS: HUD, TYPOGRAPHY AND PRESENTATION. Compare the HUD directly against the reference layout. Score and special meter, the competition leaderboard, the centred timer, the trick-list counter, the gold trick callout. Type quality and hierarchy, numeric formatting (a score rendering as ", 00" instead of "2,000" is critical), legibility over bright and dark backgrounds, alignment, margins, and whether it looks like a shipped extreme-sports game or a web overlay.` },
  { id: 'holistic', brief: `LENS: IS THIS A REAL GAME. Look at the whole set as a stranger would. Consistent art direction? Anything that betrays it as a tech demo - empty space, repeated props, missing shadows, sterile cleanliness, wrong scale, placeholder colours, objects that read as untextured primitives? Rank the three weakest frames and say precisely what holds each back.` },
]

const FIX_PRE = `You are fixing confirmed art-direction findings in a AAA-quality Three.js BMX game at
/home/user/pendulum-timer/bmx (cwd). A hostile art director reviewed rendered frames against a
reference from a released commercial game and rejected the work.

RULES
- You own ONLY the one file named below. Other agents are fixing sibling files right now.
- Read the file fully first, plus ARCHITECTURE.md, and look at the frames that triggered the findings.
- Fix the ROOT CAUSE with real implementation. If a surface is untextured, generate and apply the
  texture. Do not tune a constant until the symptom hides.
- Do not regress behaviour or change your module's exported signature (main.js calls it).
- Deterministic rng from src/core/mathx.js, no external assets, no per-frame allocation.
- Verify: npx esbuild YOUR_FILE --bundle --external:three --outfile=/dev/null --format=esm
- Then LOOK AT YOUR WORK: node tools/shoot.mjs --out shots/check-<name> --only <ids> --w 1280 --h 720
  and READ the PNGs. Iterate until the finding is genuinely gone, not merely addressed.
- If the game has gameplay tests, do not break them: node tools/playtest.mjs --only boot,perf-budget
- Dismissing a finding requires it to be factually wrong. "It is fine already" is not a reason.
`

const FIX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['file', 'fixed', 'dismissed', 'verified', 'notes'],
  properties: {
    file: { type: 'string' },
    fixed: { type: 'array', items: { type: 'string' } },
    dismissed: { type: 'array', items: { type: 'string' } },
    verified: { type: 'string', description: 'what you rendered and what you saw after the fix' },
    notes: { type: 'string' },
  },
}

const SEV = { critical: 0, major: 1, minor: 2 }
const history = []

for (let round = START; round < START + ROUNDS; round++) {
  // Deliberately not 'shots/roundN': numeric round names collided with older
  // capture directories and critics wandered into the wrong one.
  const dir = 'shots/rev-' + String.fromCharCode(64 + round)

  phase('Capture')
  log('Round ' + round + ': capturing frames into ' + dir)
  const capture = await agent(
    `Capture a fresh frame set for art review of the BMX game at /home/user/pendulum-timer/bmx (cwd).

1. Run: node tools/shoot.mjs --out ${dir} --w 1600 --h 900
   It boots the game headlessly and writes one PNG per staged shot plus report.json.
   It can take 20-40 minutes under software rendering - be patient, do not kill it.
2. If the boot fails or any shot errors, READ the error in ${dir}/report.json and
   ${dir}/console.log, then find and FIX the root cause in the source (you own any file needed for
   this step only - integration bugs, boot failures and harness breakage). Re-run until every shot
   is captured. A broken capture blocks the whole review, so this must succeed.
3. Then run: node tools/playtest.mjs
   Report the pass count and any failing scenario verbatim. Fix outright breakage (a scenario that
   throws or a boot failure); leave genuine gameplay-quality failures for the report.
4. Read ${dir}/report.json and report the draw calls, triangle count and console error count.

Return a summary of what was captured and the state of the build.`,
    { label: 'capture:r' + round, phase: 'Capture', effort: 'medium', schema: {
      type: 'object', additionalProperties: false,
      required: ['captured', 'shots', 'playtest', 'stats', 'problems'],
      properties: {
        captured: { type: 'boolean' },
        shots: { type: 'array', items: { type: 'string' } },
        playtest: { type: 'string' },
        stats: { type: 'string' },
        problems: { type: 'string' },
      },
    } }
  )

  if (!capture || !capture.captured) {
    log('Round ' + round + ': capture failed, stopping the loop')
    history.push({ round, error: 'capture failed', capture })
    break
  }
  log('Round ' + round + ': ' + (capture.shots || []).length + ' shots, playtest ' + capture.playtest)

  phase('Critique')
  const reviews = (await parallel(LENSES.map((l) => () =>
    agent(
      HARSHNESS + REFERENCE + '\n' + l.brief +
      '\n\nThe frames to judge are PNG files in /home/user/pendulum-timer/bmx/' + dir +
      '. Read EVERY .png in THAT EXACT DIRECTORY with the Read tool. Do NOT read any other shots/* ' +
      'directory - they hold stale captures from earlier builds and judging them would be worthless. ' +
      'Before judging, read ' + dir + '/report.json and confirm its startedAt timestamp is recent and ' +
      'that its shot list matches the files you found. It also carries ' +
      'shot descriptions, boot status, draw-call and triangle stats and console errors. ' +
      'Pay particular attention to ref1-match.png and ref2-match.png: those are framed deliberately ' +
      'to mirror the two reference frames, so they are your fairest side-by-side.\n' +
      (FOCUS ? '\nEXTRA FOCUS: ' + FOCUS + '\n' : '') +
      '\nPlaytest state this round: ' + (capture.playtest || 'unknown') +
      '\n\nYou may read the source under src/ to work out WHERE a problem originates. Assign every ' +
      'finding to exactly one owning file from this list:\n' + OWNED_FILES.join('\n') +
      '\n\nDo NOT edit any file. Return your review through the structured output tool.',
      { label: 'critic:' + l.id + ':r' + round, phase: 'Critique', effort: 'high', schema: FINDING_SCHEMA }
    )
  ))).filter(Boolean)

  const all = []
  for (const r of reviews) for (const f of (r.findings || [])) all.push({ ...f, lens: r.lens })

  const scores = reviews.map((r) => r.lens + ' ' + r.score + '/10 ' + r.verdict + ' [' + r.blindAB + ']')
  const avg = reviews.length ? reviews.reduce((s, r) => s + r.score, 0) / reviews.length : 0
  const failing = reviews.filter((r) => r.verdict === 'FAIL')
  const theirs = reviews.filter((r) => r.blindAB === 'theirs')
  log('Round ' + round + ' scores: ' + scores.join(' | '))
  log('Round ' + round + ': avg ' + avg.toFixed(1) + '/10, ' + failing.length + ' lenses FAIL, ' +
      theirs.length + ' lenses still prefer the reference, ' + all.length + ' findings')

  history.push({
    round, avg: +avg.toFixed(2),
    scores: reviews.map((r) => ({ lens: r.lens, score: r.score, verdict: r.verdict, blindAB: r.blindAB, why: r.blindABWhy })),
    findings: all.length,
    critical: all.filter((f) => f.severity === 'critical').length,
    playtest: capture.playtest,
    stats: capture.stats,
  })

  // Convergence: every lens passes and none of them still prefers the reference.
  if (!failing.length && !theirs.length) {
    log('Round ' + round + ': CONVERGED - every lens passes and no critic prefers the reference.')
    break
  }

  phase('Fix')
  const byFile = new Map()
  for (const f of all) {
    const file = OWNED_FILES.includes(f.file) ? f.file : 'src/world/park.js'
    if (!byFile.has(file)) byFile.set(file, [])
    byFile.get(file).push(f)
  }
  const groups = [...byFile.entries()]
    .map(([file, findings]) => ({
      file,
      findings: findings.sort((a, b) => SEV[a.severity] - SEV[b.severity]),
      worst: Math.min(...findings.map((f) => SEV[f.severity])),
    }))
    .sort((a, b) => a.worst - b.worst)

  log('Round ' + round + ': dispatching ' + groups.length + ' fix agents')

  const fixes = (await parallel(groups.map((g) => () =>
    agent(
      FIX_PRE + '\nYOUR FILE: ' + g.file + '\n\nFINDINGS TO FIX (' + g.findings.length + '):\n' +
      g.findings.map((f, i) =>
        (i + 1) + '. [' + f.severity.toUpperCase() + '] (lens: ' + f.lens + ', shot: ' + f.shot + ')\n' +
        '   PROBLEM: ' + f.problem + '\n' +
        '   DIRECTED FIX: ' + f.fix
      ).join('\n\n') +
      '\n\nThe frames that triggered these findings are in /home/user/pendulum-timer/bmx/' + dir +
      ' - read the relevant ones so you see exactly what the critic saw, and read ' +
      'reference/target-look.png so you know what it should look like instead.',
      { label: 'fix:' + g.file.split('/').pop().replace('.js', '') + ':r' + round,
        phase: 'Fix', effort: 'high', schema: FIX_SCHEMA }
    )
  ))).filter(Boolean)

  history[history.length - 1].fixes = fixes.length
  log('Round ' + round + ': ' + fixes.length + ' fix agents finished')
}

return { rounds: history }
