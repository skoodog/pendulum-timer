export const meta = {
  name: 'bmx-gameplay-fixes',
  description: 'Fix the defects the automated playtest found: top speed, manual, park containment, trick counter, letters and cheat toggling',
  phases: [{ title: 'Fixes', detail: 'one agent per owning file' }],
}

const PRE = `You are fixing confirmed GAMEPLAY defects in a AAA-quality Three.js BMX game at
/home/user/pendulum-timer/bmx (cwd). These are not opinions - they come from an automated playtest
(tools/playtest.mjs) that drives the real game headlessly and asserts invariants.

RUN THE PLAYTEST YOURSELF to reproduce and to verify your fix:
    node tools/playtest.mjs --only <scenario-ids>
It boots the game in Chromium, steps the simulation through window.__BMX.simulate() (rendering in
this container is software and runs at ~1 fps, so never rely on real-time frames), and prints
PASS/FAIL per scenario. A full run takes several minutes; scope it with --only.
You can also probe interactively: node tools/probe.mjs "<js body with B and ctx in scope>"

FIRST read ARCHITECTURE.md, then the file you own and the modules it talks to.

RULES
- You own ONLY the file(s) named in YOUR TASK. Other agents are fixing siblings concurrently.
- Fix the ROOT CAUSE. Do not paper over a symptom, do not weaken the test, do not special-case the
  playtest. The scenario must pass because the game genuinely behaves correctly.
- Do not change your module's exported signature; main.js and siblings call it.
- No external assets, deterministic rng from mathx, no per-frame allocation.
- Verify: npx esbuild YOUR_FILE --bundle --external:three --outfile=/dev/null --format=esm
  AND the relevant playtest scenarios must pass when you are done.
`

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['file', 'rootCause', 'fix', 'verified', 'notes'],
  properties: {
    file: { type: 'string' },
    rootCause: { type: 'string' },
    fix: { type: 'string' },
    verified: { type: 'string', description: 'exact playtest/probe output proving it now passes' },
    notes: { type: 'string' },
  },
}

const TASKS = [
  {
    label: 'fix:physics',
    prompt: `YOUR FILE: src/physics/bikePhysics.js

TWO FAILING SCENARIOS:

1. [accelerate] "Pedals from rest to >= 11 m/s within 6 s of flat ground" - FAILS at 10.64 m/s.
   ARCHITECTURE.md specifies a top speed of ~14 m/s. Right now full throttle on flat ground plateaus
   just under 11. Find why the acceleration curve dies early (pedal falloff exponent, drag, rolling
   resistance scaled by surface friction, or the top-speed clamp) and retune so that: full pedal on
   flat concrete reaches ~14 m/s, gets to 11 m/s within about 4 s, still feels like it has weight
   (not instant), and coasting decays believably. Keep every constant in TUNING with its comment.

2. [manual] "Manual enters and holds without instantly failing" - FAILS, the manual holds for 0.07 s.
   Entering a manual (input 'manual' pressed, lean held back) immediately drops out. Diagnose whether
   the manual entry conditions, the balance integration, the exit condition or the mode transition is
   at fault, and make a manual hold indefinitely with correct input while still being a skill check:
   the balance meter should drift by an inverted-pendulum rule and be correctable with lean, a
   well-corrected manual should hold for many seconds, and an uncorrected one should fall within
   about 2 s. Nose manuals must work the same way.

Reproduce with: node tools/playtest.mjs --only accelerate,manual
Both must PASS when you are done, and the other scenarios must not regress (spot-check hop and
bail-recovery, which are currently passing).`,
  },
  {
    label: 'fix:containment',
    prompt: `YOUR FILE: src/world/park.js

FAILING SCENARIO: [stay-in-park] "A 25 s autopilot run never leaves the park bounds" - FAILS, the
rider rides straight out of the lot (left bounds at x=10.4, z=-60.5) and keeps going into the void.

The park has a perimeter fence in the set dressing but the play area is not actually enclosed for
the physics: a rider at speed leaves the lot. Fix it properly:
- Give the lot a complete, closed collision boundary that a rider cannot pass: solid wall colliders
  along the fence line (and behind any other open edge), tall enough that a bunnyhop or a big air
  cannot clear them, tagged type 'wall' with sensible friction.
- The boundary must not be a visible invisible-wall embarrassment: line it up with the fence, kerbs,
  banks and buildings so the player reads it as the edge of the venue. Where a wall would look odd,
  use a bank, a kerb, a jersey barrier or a hedge instead so the geometry itself contains the player.
- Make sure the returned bounds Box3 actually encloses the full playable area including decks and
  the roll-in platform, so out-of-bounds logic elsewhere agrees with the geometry.
- Do not shrink the park or block any existing line: every feature must still be reachable and the
  main flow lines must be unaffected. Verify a rider can still reach every ramp, rail and the dirt
  line after your change.

Reproduce with: node tools/playtest.mjs --only stay-in-park,boot
Both must PASS when you are done.`,
  },
  {
    label: 'fix:tricks-counter',
    prompt: `YOUR FILE: src/gameplay/tricks.js

DEFECT: the trick-list counter never increments. The playtest lands tricks and banks points
(scenario [trick-scores] scores 500) but tricks.landedCount stays 0, so the HUD's "0 / 52" counter
in the top-right - a headline element of the reference frame - never moves.

Fix the root cause: a trick that is committed and then landed cleanly must be recorded in the
persistent landed-trick set, landedCount must increase, and the difficulty tag must progress as the
player learns more of the list. Check that:
- the trick is recorded on a LAND, not on commit (a bailed trick does not count);
- every category counts (airs, spins, grinds, lip tricks, manuals, flatland), not just grabs;
- the persisted set survives a reload and de-duplicates;
- landedCount and totalCount are readable by the HUD every frame without allocating.

Also verify the score itself is sane: the playtest's 30 s autopilot run banks only 500 points, which
suggests almost every trick attempt is failing to commit or failing to bank. Investigate with
node tools/probe.mjs, and if tricks are being dropped for a fixable reason (input window too tight,
commit gate too strict, combo not banking on land) fix that too - a 30 s run of hops with grabs
should bank several thousand points.

Reproduce with: node tools/playtest.mjs --only trick-scores
It must PASS and the detail line must show tricks landed > 0.`,
  },
  {
    label: 'fix:letters',
    prompt: `YOUR FILE: src/gameplay/scoring.js

DEFECT: the collectible letters spell B-M-X (3 letters). ARCHITECTURE.md's demo scope specifies the
five letters B-M-X-E-R plus 5 hidden collectibles. The playtest reports "letters collected 1 of 3".

Fix:
- Five letter pickups spelling B-M-X-E-R, placed to demand real skill: one high in the air off a
  transition, one on a rail line, one down a gap, one tucked away somewhere hidden, one easy. Place
  them from the park's actual geometry (spawn points, rails, bounds) so none is unreachable or buried.
- Five hidden collectibles as a separate set with their own goal.
- The HUD's letter tracker must reflect five letters; keep the field names it reads stable, and
  update the goal text accordingly.
- Collecting all five must complete its goal and award points, and the set must reset per run while
  the goal completion persists.
Check the HUD reads whatever you expose (read src/ui/hud.js), and do not break the other goals,
the leaderboard, the achievements or the persistence shape - migrate stored data if you change it.

ALSO FIX: the competition leaderboard shows the player at rank 6 in a five-row table (visible in
shots/round2/gameplay.png). Ranks must be contiguous 1..5 with the player occupying their true
position as they climb past each rival.

Reproduce with: node tools/playtest.mjs --only collectibles`,
  },
  {
    label: 'fix:cheat-toggle',
    prompt: `YOUR FILE: src/rider/customization.js

FAILING SCENARIO: [cheat-off-by-default] "A normally-named rider still bails" - FAILS.

The James Paterson easter egg works (scenario [cheat-nobail] passes: noBail=true, trickSpeed=1.5).
But after renaming the rider back to an ordinary name, the cheat stays on - the rider still cannot
bail. The cheat is sticky.

Fix the root cause: the active cheats must be recomputed and republished on ctx.player.cheats
whenever the name changes by ANY path - rename(), set() on the name field, load()/select() of a
different profile, create(), randomize(), a profile edited in the creator, or a profile restored
from localStorage. Renaming away from the magic name must immediately restore normal bailing;
renaming to it must immediately enable the cheat. Make sure the published object is either mutated
in place or fully replaced consistently, so a module that captured a reference to ctx.player.cheats
at construction still sees the current values (bikePhysics and tricks read it through ctx each time,
but do not rely on that).

Keep it an easter egg: no UI hint, no logging, no exported list of magic names beyond what is needed.

Reproduce with: node tools/playtest.mjs --only cheat-nobail,cheat-off-by-default
BOTH must PASS.`,
  },
]

phase('Fixes')
log('Dispatching ' + TASKS.length + ' fix agents against playtest failures')

const results = (await parallel(TASKS.map((t) => () =>
  agent(PRE + '\n' + t.prompt, { label: t.label, phase: 'Fixes', effort: 'high', schema: SCHEMA })
))).filter(Boolean)

return results
