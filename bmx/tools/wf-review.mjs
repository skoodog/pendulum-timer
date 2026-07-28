export const meta = {
  name: 'bmx-review',
  description: 'Harsh art-direction review of rendered frames, then file-disjoint fix agents for every confirmed finding',
  phases: [
    { title: 'Critique', detail: 'independent critics, one per lens, judging the rendered frames' },
    { title: 'Fix', detail: 'one agent per owning file, applying the confirmed findings' },
  ],
}

// args: { dir: 'shots/round1', round: 1, focus?: string }
const DIR = (args && args.dir) || 'shots/round1'
const ROUND = (args && args.round) || 1
const FOCUS = (args && args.focus) || ''

const OWNED_FILES = [
  'src/world/materials.js',
  'src/world/environment.js',
  'src/world/park.js',
  'src/world/props.js',
  'src/rider/bike.js',
  'src/rider/riderAnim.js',
  'src/physics/bikePhysics.js',
  'src/physics/collision.js',
  'src/gameplay/tricks.js',
  'src/gameplay/grind.js',
  'src/gameplay/scoring.js',
  'src/fx/particles.js',
  'src/ui/hud.js',
  'src/ui/screens.js',
  'src/ui/settings.js',
  'src/ui/glyphs.js',
  'src/audio/audio.js',
  'src/core/engine.js',
  'src/core/camera.js',
  'src/core/input.js',
]

const REFERENCE = `
THE REFERENCE FRAME: /home/user/pendulum-timer/bmx/reference/target-look.png
READ IT WITH THE READ TOOL FIRST - it renders as an image. It is a frame from a released commercial
BMX game and it is the exact bar this project must meet. Study it before you look at our frames:
the overcast dusk cloud deck, the wet concrete with puddles mirroring the skyline, the graffiti on
every vertical face, the interconnected bowls and banks, the city backdrop with an elevated freeway
and palms, the close low chase camera with the rider large in frame, and the HUD layout.

THE BLIND A/B YOU MUST PERFORM: for each of our frames, ask whether a stranger shown our frame and
the reference frame side by side, with no labels, would say ours or theirs is the better-looking
game. Answer honestly and say exactly which visual property decided it. Do not grade on a curve for
"it is procedural" or "it is WebGL".

REFERENCE STANDARD - the wider bar.

(a) Dave Mirra Freestyle BMX 2 (Acclaim, 2001, PS2/GameCube/Xbox). From memory of that title:
    chunky readable park geometry at real-world scale; solid warm outdoor lighting with baked-in
    shadow gradients; clearly legible ramps with visible plywood/steel construction; a detailed,
    correctly proportioned BMX bike that is the star of every frame; a rider whose limbs visibly
    articulate through every trick; punchy HUD with a big score and a live combo string; set
    dressing (fences, banners, crowd, containers) that makes the space feel like a real venue.
    Its weaknesses (which you should BEAT, not copy): low-res muddy textures, 20-year-old polygon
    counts, hard-edged shadows, no post-processing, flat skies.

(b) A modern AAA extreme-sports title's bar for the same shot: correct PBR response, contact-hardening
    shadows, ambient occlusion in every crevice, texel density that survives a close-up, material
    variation and wear, atmospheric perspective, composed lighting with rim and bounce, believable
    silhouettes, and post-processing that reads cinematic rather than gimmicky.

YOUR STANDARD IS (b) WITH THE READABILITY AND ATTITUDE OF (a). A frame passes only if it would not
look out of place in a released commercial game. Nostalgia is not a defence; neither is "it is
procedural" or "it is WebGL" - the target is a shipped-product look.

(c) A SECOND reference frame was supplied that is not on disk. Its written description is in the
"SECOND REFERENCE" section at the end of ARCHITECTURE.md - READ THAT SECTION. It raises the bar on
wet-ground reflection (near-mirror reflections of buildings and sky in a rained-on plaza), character
fidelity (a rider with a visible face, hair, layered clothing and real fabric response) and
controller-first UI (Xbox glyphs in the HUD). Judge against it too.
`

const HARSHNESS = `
YOU ARE A HOSTILE ART DIRECTOR. You have rejected work from studios twice this size. Your default
answer is NO. Rules for your review:
- Judge ONLY what you can see in the pixels. Do not credit intent, code quality or effort.
- Be specific and physical: name the object, the region of frame, and what is wrong optically
  (e.g. "the quarterpipe deck reads as untextured flat grey - no plywood grain, no seams, no wear;
  texel density is roughly 8px/m where it needs 256").
- Every finding must come with a concrete, implementable fix a graphics engineer can act on.
- Rate the frame set 0-10 where 7 = shippable, 8+ = beats the reference on that lens, and be stingy.
- Then answer the blind A/B question honestly: if this frame and a Dave Mirra Freestyle BMX 2 frame
  of the same subject were placed side by side unlabelled, which one would a stranger call the
  better-looking game, and WHY. Answer "ours", "theirs", or "toss-up".
- If something is broken (black screen, missing geometry, z-fighting, clipping, NaN poses, invisible
  rider, blown-out exposure) that is a CRITICAL finding and outranks all aesthetic notes.
`

const FINDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lens', 'score', 'blindAB', 'blindABWhy', 'verdict', 'findings'],
  properties: {
    lens: { type: 'string' },
    score: { type: 'number', description: '0-10, 7 = shippable' },
    blindAB: { type: 'string', enum: ['ours', 'theirs', 'toss-up'], description: 'blind side-by-side against reference/target-look.png' },
    blindABWhy: { type: 'string' },
    verdict: { type: 'string', enum: ['PASS', 'FAIL'] },
    findings: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'shot', 'problem', 'fix', 'file'],
        properties: {
          severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
          shot: { type: 'string', description: 'which screenshot id shows it' },
          problem: { type: 'string' },
          fix: { type: 'string', description: 'concrete implementable change' },
          file: { type: 'string', description: 'the single owning source file that must change' },
        },
      },
    },
  },
}

const LENSES = [
  {
    id: 'lighting',
    brief: `LENS: LIGHTING, ATMOSPHERE AND POST. Judge the sun angle and colour, shadow softness/density/
resolution, ambient occlusion presence in crevices and contact points, sky believability and cloud
quality, atmospheric perspective and fog, exposure and tonemapping, bloom tastefulness, colour grade,
grain/vignette/aberration restraint, and whether the whole frame has a designed key/fill/rim structure
rather than flat uniform illumination. Also: does the scene read as a specific time of day in a
specific place, or as "default three-point lighting"?`,
  },
  {
    id: 'materials',
    brief: `LENS: MATERIALS AND SURFACE DETAIL. Judge texel density at every distance (especially the
ground-detail and bike-detail close-ups), tiling repetition, normal map strength and correctness,
roughness variation, whether metals read as metal and concrete as concrete, edge wear, dirt and
grime accumulation in the right places, decals and graffiti integration, and any surface that is a
flat untextured colour. Zoom mentally into each quadrant of each frame and name the worst surface.`,
  },
  {
    id: 'park',
    brief: `LENS: LEVEL DESIGN, COMPOSITION AND SET DRESSING. Judge the park layout readability, whether
ramp geometry is correctly shaped (transitions must be true arcs, coping must sit at the lip),
construction believability (deck framing, seams, safety rails), scale against the rider, the amount
and quality of set dressing, the skyline/backdrop, negative space, and how the frame is composed.
Would a BMX rider look at this park and know exactly what line to ride?`,
  },
  {
    id: 'character',
    brief: `LENS: RIDER AND BIKE. Judge the bike first - proportions against a real 20 inch BMX, frame
geometry, tube junctions and welds, wheel/spoke/tyre construction, drivetrain, chrome vs anodised
material response - then the rider: body proportions, silhouette, joint articulation, pose quality
and believability, clothing shape and fold detail, helmet and gloves, and whether rider and bike look
like they belong to the same production. Fake-looking hands, floating limbs, interpenetration, and
mannequin stiffness are all majors.`,
  },
  {
    id: 'ui',
    brief: `LENS: HUD, TYPOGRAPHY AND PRESENTATION. Judge the in-game frame (gameplay shot) for HUD
composition, type quality and hierarchy, legibility over bright and dark backgrounds, whether the
score/combo/meters read instantly, animation polish implied by the layout, and whether it looks like
a shipped extreme-sports game or a web demo. Flag any default browser typography, misaligned
elements, cramped margins, or low-contrast text.`,
  },
  {
    id: 'holistic',
    brief: `LENS: HOLISTIC "IS THIS A REAL GAME". Look at the whole set of frames as a stranger would.
Does this look like a commercial product? Is there a consistent art direction? Does anything betray
it as a tech demo - empty space, repeated props, missing shadows, sterile cleanliness, wrong scale,
placeholder colours? Rank the three weakest frames and say precisely what is holding each back.`,
  },
]

const FIX_PRE = `You are fixing confirmed art-direction findings in a AAA-quality Three.js BMX game at
/home/user/pendulum-timer/bmx (cwd). A hostile art director reviewed rendered frames and rejected the
work. Their findings for YOUR file are below.

RULES
- You own ONLY the one file named below. Other agents are fixing sibling files right now.
- Read the file fully first, plus ARCHITECTURE.md, and any module you depend on.
- Fix the ROOT CAUSE with real implementation, not by tweaking a constant until the symptom hides.
  If a finding says a surface is untextured, actually generate and apply the texture.
- Do not regress existing behaviour or change your module's exported signature (main.js calls it).
- Deterministic rng from src/core/mathx.js, no external assets, no per-frame allocation.
- Verify before finishing:
    npx esbuild YOUR_FILE --bundle --external:three --outfile=/dev/null --format=esm
- If a finding is genuinely wrong or belongs to another file, say so in your notes instead of making a
  harmful change - but the bar for dismissing a finding is high, and "it is fine already" is not a
  reason. Default to fixing.
`

phase('Critique')
log('Round ' + ROUND + ': ' + LENSES.length + ' critics reviewing ' + DIR)

const reviews = (await parallel(LENSES.map((l) => () =>
  agent(
    HARSHNESS + REFERENCE + '\n' + l.brief +
    '\n\nThe frames to judge are PNG files in /home/user/pendulum-timer/bmx/' + DIR +
    '. Read EVERY .png in that directory with the Read tool (they render as images for you) and also read ' +
    DIR + '/report.json for the shot descriptions, boot status, draw-call/triangle stats and any console errors. ' +
    'If a shot is missing or the boot failed, that is a critical finding.\n' +
    (FOCUS ? '\nEXTRA FOCUS THIS ROUND: ' + FOCUS + '\n' : '') +
    '\nYou may read the source under src/ to work out WHERE a visual problem originates - you must assign every ' +
    'finding to exactly one owning file from this list:\n' + OWNED_FILES.join('\n') +
    '\n\nDo NOT edit any file. Return your review via the structured output tool.',
    { label: 'critic:' + l.id, phase: 'Critique', effort: 'high', schema: FINDING_SCHEMA }
  )
))).filter(Boolean)

const all = []
for (const r of reviews) for (const f of (r.findings || [])) all.push({ ...f, lens: r.lens })

const scores = reviews.map((r) => r.lens + ' ' + r.score + '/10 ' + r.verdict + ' (blind A/B: ' + r.blindAB + ')')
log('Scores: ' + scores.join(' | '))
log('Findings: ' + all.length + ' (' + all.filter((f) => f.severity === 'critical').length + ' critical)')

const byFile = new Map()
for (const f of all) {
  const file = OWNED_FILES.includes(f.file) ? f.file : 'src/world/park.js'
  if (!byFile.has(file)) byFile.set(file, [])
  byFile.get(file).push(f)
}

const SEV = { critical: 0, major: 1, minor: 2 }
const groups = [...byFile.entries()]
  .map(([file, findings]) => ({
    file,
    findings: findings.sort((a, b) => SEV[a.severity] - SEV[b.severity]),
    worst: Math.min(...findings.map((f) => SEV[f.severity])),
  }))
  .sort((a, b) => a.worst - b.worst)

phase('Fix')
log('Dispatching ' + groups.length + ' fix agents (one per owning file)')

const FIX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['file', 'fixed', 'dismissed', 'notes'],
  properties: {
    file: { type: 'string' },
    fixed: { type: 'array', items: { type: 'string' } },
    dismissed: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
}

const fixes = (await parallel(groups.map((g) => () =>
  agent(
    FIX_PRE + '\nYOUR FILE: ' + g.file + '\n\nFINDINGS TO FIX (' + g.findings.length + '):\n' +
    g.findings.map((f, i) =>
      (i + 1) + '. [' + f.severity.toUpperCase() + '] (lens: ' + f.lens + ', shot: ' + f.shot + ')\n' +
      '   PROBLEM: ' + f.problem + '\n' +
      '   DIRECTED FIX: ' + f.fix
    ).join('\n\n') +
    '\n\nThe frames that triggered these findings are in /home/user/pendulum-timer/bmx/' + DIR +
    ' - read the relevant ones so you can see exactly what the critic saw.',
    { label: 'fix:' + g.file.split('/').pop().replace('.js', ''), phase: 'Fix', effort: 'high', schema: FIX_SCHEMA }
  )
))).filter(Boolean)

return {
  round: ROUND,
  scores: reviews.map((r) => ({ lens: r.lens, score: r.score, verdict: r.verdict, blindAB: r.blindAB, why: r.blindABWhy })),
  findingCount: all.length,
  criticalCount: all.filter((f) => f.severity === 'critical').length,
  fixes,
}
