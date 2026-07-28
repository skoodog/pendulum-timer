// MIRRA CITY — the trick system.
//
// A DMFBMX2 / THPS3-flavoured vocabulary driven by MODIFIER + DIRECTION.
//
//   trickA / trickB / trickC   × 9 directions (N U D L R UL UR DL DR)  = 27 airs
//   spinLeft / spinRight       → 180 / 360 / 540 / 720 / 900, named live
//   grind      + direction     → 9 grinds  (coping rails swap to the 5 lip tricks)
//   manual                     → manual / nose manual, switchable mid-combo with trickB
//   trickA/trickB on the floor → flatland set, plus the bunnyhop link
//
// Rules of the road, exactly like the reference games:
//   * Grabs and tweaks are HELD. Holding accrues a per-second bonus up to a cap, and
//     you MUST tuck it back in before touchdown — landing with a grab still out is a
//     bail. Rotational tricks (whips, barspins, flips) are IMPULSE: they run for a
//     fixed duration and landing before they finish is also a bail.
//   * Repeating a trick inside one combo scores less every time (×0.5 per repeat,
//     ×0.22 for the signature tricks that are flagged no-repeat).
//   * Nothing in the update path allocates. The only runtime objects are one small
//     combo-entry per committed trick — a handful per second — which is handed to
//     scoring.js by reference and then live-mutated as the hold bonus accrues.
//
// Contracts this file leans on (all optional-chained so a missing sibling cannot
// break the boot):
//   ctx.player.physics.state / applyTrickRotation(axis, rate) / forceBail(reason)
//   ctx.player.scoring.addTrick(entry) | .land(quality, info) | .bail(reason)
//   ctx.player.anim.setPose(poseId, weight)
//   ctx.fx.shake / .flash / .flashbulb        ctx.audio.trick | .play(name, detail)
// Everything is mirrored onto ctx.emit() as 'trick' / 'trickEnd' / 'comboLand' /
// 'comboBank' / 'comboBail' so any listener can pick the same events up.

import { clamp, deg } from '../core/mathx.js';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

export const TRICK_TUNE = {
  bufferMs: 190,          // ms a trick button stays "live" so a press just before the lip still fires
  linkWindow: 1.30,       // s on the ground before an unlinked combo banks
  spinRate: 9.0,          // rad/s (≈515°/s) top yaw rate from the spin buttons
  spinRamp: 0.20,         // s to wind the spin up to full rate — stops instant snap-spins
  spinDecay: 4.0,         // 1/s the wind-up bleeds off after release
  spinNameTol: 14,        // ° short of a threshold that still reads as that spin
  spinSnapWindow: 58,     // ° from a half-rotation inside which the landing assist engages
  spinSnapGain: 2.6,      // 1/s proportional gain of that assist
  spinSnapMax: 3.8,       // rad/s cap on the assist
  flipGain: 3.4,          // 1/s proportional gain of the closed-loop flip driver
  flipMin: 3.0,           // rad/s floor while a flip still has real angle to cover
  flipMax: 8.8,           // rad/s ceiling (physics caps at 9.42)
  flipDone: 16,           // ° of remaining rotation that counts as complete
  impulseGrace: 0.86,     // fraction of an impulse trick that still counts on touchdown
  repeatFalloff: 0.50,    // score multiplier per repeat of a repeatable trick
  repeatFalloffHard: 0.22,// ...and of a signature (repeat:false) trick
  repeatFloor: 0.12,      // never scores below this fraction of base
  flatMaxSpeed: 7.5,      // m/s ceiling for flatland tricks
  grindSwitchHold: 0.14,  // s a new grind direction must be held to switch mid-rail
  grindSwitchCool: 0.45,  // s between grind switches
  manualSwitchCool: 0.40, // s between manual ↔ nose manual switches
  comboTextMax: 6,        // trick names kept in the HUD string before it elides
  stuckHold: 2.6,         // s of unbroken hold after which a modifier is treated as jammed
                          // (longer than any possible hang time — this only ever catches a
                          //  scripted/never-released input, never a real player's grab)
  bigTrick: 1500,         // base points that earn a shake on commit
  bigCombo: 6000,         // combo points that earn crowd flashbulbs on the landing
};

const T = TRICK_TUNE;

// ---------------------------------------------------------------------------
// The vocabulary. `mod` + `dir` is the input recipe; `pose` is what riderAnim plays.
//
//   style   'hold'    held down, accrues `hold` points/s for up to `holdMax` s
//           'impulse' fires and runs for `dur` s on its own
//           'auto'    awarded by rotation, never pressed directly
//   minAir  s of air (or of hold) before the trick commits to the combo
//   flip/spin/roll  degrees of chassis rotation the trick drives, signed
//                   (+pitch = nose down / frontflip, −pitch = backflip)
//   repeat  false = signature trick, punished hard for repeating in one combo
//   diff    1..5, the trick-list difficulty tag
// ---------------------------------------------------------------------------

export const TRICKS = [
  // ---- AIR: trickA — grabs and tweaks (held) -------------------------------
  { id: 'nohander', name: 'No-Hander', category: 'air', mod: 'trickA', dir: 'N',
    base: 500, hold: 380, holdMax: 2.2, minAir: 0.20, style: 'hold', pose: 'nohander', repeat: true, diff: 1 },
  { id: 'superman', name: 'Superman', category: 'air', mod: 'trickA', dir: 'U',
    base: 900, hold: 620, holdMax: 2.2, minAir: 0.28, style: 'hold', pose: 'superman', repeat: true, diff: 4 },
  { id: 'toboggan', name: 'Toboggan', category: 'air', mod: 'trickA', dir: 'D',
    base: 800, hold: 540, holdMax: 2.2, minAir: 0.26, style: 'hold', pose: 'toboggan', repeat: true, diff: 3 },
  { id: 'tabletop', name: 'Tabletop', category: 'air', mod: 'trickA', dir: 'L',
    base: 700, hold: 500, holdMax: 2.2, minAir: 0.24, style: 'hold', pose: 'tabletop', repeat: true, diff: 2 },
  { id: 'turndown', name: 'Turndown', category: 'air', mod: 'trickA', dir: 'R',
    base: 750, hold: 520, holdMax: 2.2, minAir: 0.24, style: 'hold', pose: 'turndown', repeat: true, diff: 2 },
  { id: 'cancan', name: 'Can-Can', category: 'air', mod: 'trickA', dir: 'UL',
    base: 600, hold: 440, holdMax: 2.2, minAir: 0.22, style: 'hold', pose: 'cancan', repeat: true, diff: 2 },
  { id: 'onehander', name: 'One-Hander', category: 'air', mod: 'trickA', dir: 'UR',
    base: 450, hold: 360, holdMax: 2.2, minAir: 0.20, style: 'hold', pose: 'onehander', repeat: true, diff: 1 },
  { id: 'superman_seatgrab', name: 'Superman Seat Grab', category: 'air', mod: 'trickA', dir: 'DL',
    base: 1100, hold: 700, holdMax: 2.2, minAir: 0.32, style: 'hold', pose: 'superman_seatgrab', repeat: true, diff: 5 },
  { id: 'nothing', name: 'Nothing', category: 'air', mod: 'trickA', dir: 'DR',
    base: 1400, hold: 760, holdMax: 2.2, minAir: 0.34, style: 'hold', pose: 'nothing', repeat: false, diff: 5 },

  // ---- AIR: trickB — bike/body separation ----------------------------------
  { id: 'xup', name: 'X-Up', category: 'air', mod: 'trickB', dir: 'N',
    base: 550, hold: 400, holdMax: 2.0, minAir: 0.20, style: 'hold', pose: 'xup', repeat: true, diff: 1 },
  { id: 'tuck_nohander', name: 'Tuck No-Hander', category: 'air', mod: 'trickB', dir: 'U',
    base: 850, hold: 560, holdMax: 2.0, minAir: 0.26, style: 'hold', pose: 'tuck_nohander', repeat: true, diff: 3 },
  { id: 'crossup', name: 'Cross-Up', category: 'air', mod: 'trickB', dir: 'D',
    base: 600, hold: 430, holdMax: 2.0, minAir: 0.22, style: 'hold', pose: 'crossup', repeat: true, diff: 2 },
  { id: 'barspin', name: 'Barspin', category: 'air', mod: 'trickB', dir: 'L',
    base: 700, hold: 0, holdMax: 0, minAir: 0.18, style: 'impulse', dur: 0.38, pose: 'barspin', repeat: true, diff: 2 },
  { id: 'tailwhip', name: 'Tailwhip', category: 'air', mod: 'trickB', dir: 'R',
    base: 900, hold: 0, holdMax: 0, minAir: 0.20, style: 'impulse', dur: 0.48, pose: 'tailwhip', repeat: true, diff: 3 },
  { id: 'double_barspin', name: 'Double Barspin', category: 'air', mod: 'trickB', dir: 'UL',
    base: 1300, hold: 0, holdMax: 0, minAir: 0.26, style: 'impulse', dur: 0.66, pose: 'double_barspin', repeat: true, diff: 4 },
  { id: 'double_tailwhip', name: 'Double Tailwhip', category: 'air', mod: 'trickB', dir: 'UR',
    base: 1600, hold: 0, holdMax: 0, minAir: 0.30, style: 'impulse', dur: 0.82, pose: 'double_tailwhip', repeat: false, diff: 5 },
  { id: 'decade', name: 'Decade', category: 'air', mod: 'trickB', dir: 'DL',
    base: 1500, hold: 0, holdMax: 0, minAir: 0.28, style: 'impulse', dur: 0.70, pose: 'decade', repeat: false, diff: 5 },
  { id: 'invert', name: 'Invert', category: 'air', mod: 'trickB', dir: 'DR',
    base: 1200, hold: 660, holdMax: 2.0, minAir: 0.30, style: 'hold', pose: 'invert', repeat: true, diff: 4 },

  // ---- AIR: trickC — flips and corks (drive real chassis rotation) ---------
  { id: 'backflip', name: 'Backflip', category: 'air', mod: 'trickC', dir: 'N',
    base: 1800, hold: 0, holdMax: 0, minAir: 0.24, style: 'impulse', dur: 0.90, flip: -360,
    pose: 'backflip', repeat: false, diff: 4 },
  { id: 'frontflip', name: 'Frontflip', category: 'air', mod: 'trickC', dir: 'U',
    base: 2000, hold: 0, holdMax: 0, minAir: 0.24, style: 'impulse', dur: 0.92, flip: 360,
    pose: 'frontflip', repeat: false, diff: 5 },
  { id: 'flair', name: 'Flair', category: 'air', mod: 'trickC', dir: 'D',
    base: 2600, hold: 0, holdMax: 0, minAir: 0.28, style: 'impulse', dur: 1.02, flip: -360, spin: 180,
    pose: 'flair', repeat: false, diff: 5 },
  { id: 'flip_barspin', name: 'Backflip Barspin', category: 'air', mod: 'trickC', dir: 'L',
    base: 2400, hold: 0, holdMax: 0, minAir: 0.26, style: 'impulse', dur: 0.95, flip: -360,
    pose: 'flip_barspin', repeat: false, diff: 5 },
  { id: 'flip_tailwhip', name: 'Backflip Tailwhip', category: 'air', mod: 'trickC', dir: 'R',
    base: 2600, hold: 0, holdMax: 0, minAir: 0.28, style: 'impulse', dur: 1.00, flip: -360,
    pose: 'flip_tailwhip', repeat: false, diff: 5 },
  { id: 'superman_flip', name: 'Superman Backflip', category: 'air', mod: 'trickC', dir: 'UL',
    base: 2800, hold: 0, holdMax: 0, minAir: 0.30, style: 'impulse', dur: 1.05, flip: -360,
    pose: 'superman_flip', repeat: false, diff: 5 },
  { id: 'double_backflip', name: 'Double Backflip', category: 'air', mod: 'trickC', dir: 'UR',
    base: 3600, hold: 0, holdMax: 0, minAir: 0.36, style: 'impulse', dur: 1.62, flip: -720,
    pose: 'double_backflip', repeat: false, diff: 5 },
  { id: 'corkscrew', name: 'Corkscrew', category: 'air', mod: 'trickC', dir: 'DL',
    base: 2200, hold: 0, holdMax: 0, minAir: 0.26, style: 'impulse', dur: 0.90, roll: 360,
    pose: 'corkscrew', repeat: false, diff: 5 },
  { id: 'frontflip_barspin', name: 'Frontflip Barspin', category: 'air', mod: 'trickC', dir: 'DR',
    base: 2700, hold: 0, holdMax: 0, minAir: 0.26, style: 'impulse', dur: 0.96, flip: 360,
    pose: 'frontflip_barspin', repeat: false, diff: 5 },

  // ---- AIR: rotations, awarded automatically by the spin buttons -----------
  { id: 'spin180', name: '180', category: 'air', mod: 'spin', dir: 'N', spinDeg: 180,
    base: 200, hold: 0, holdMax: 0, minAir: 0, style: 'auto', pose: 'spin', repeat: true, diff: 1 },
  { id: 'spin360', name: '360', category: 'air', mod: 'spin', dir: 'N', spinDeg: 360,
    base: 800, hold: 0, holdMax: 0, minAir: 0, style: 'auto', pose: 'spin', repeat: true, diff: 2 },
  { id: 'spin540', name: '540', category: 'air', mod: 'spin', dir: 'N', spinDeg: 540,
    base: 1600, hold: 0, holdMax: 0, minAir: 0, style: 'auto', pose: 'spin', repeat: true, diff: 3 },
  { id: 'spin720', name: '720', category: 'air', mod: 'spin', dir: 'N', spinDeg: 720,
    base: 2600, hold: 0, holdMax: 0, minAir: 0, style: 'auto', pose: 'spin', repeat: false, diff: 4 },
  { id: 'spin900', name: '900', category: 'air', mod: 'spin', dir: 'N', spinDeg: 900,
    base: 4000, hold: 0, holdMax: 0, minAir: 0, style: 'auto', pose: 'spin', repeat: false, diff: 5 },

  // ---- GRINDS (grind.js picks these through grindTrickFor) -----------------
  { id: 'double_peg', name: 'Double Peg', category: 'grind', mod: 'grind', dir: 'N',
    base: 400, hold: 340, holdMax: 6, minAir: 0.12, style: 'hold', pose: 'grind_doublepeg', repeat: true, diff: 1 },
  { id: 'feeble', name: 'Feeble Grind', category: 'grind', mod: 'grind', dir: 'L',
    base: 520, hold: 380, holdMax: 6, minAir: 0.12, style: 'hold', pose: 'grind_feeble', repeat: true, diff: 2 },
  { id: 'smith', name: 'Smith Grind', category: 'grind', mod: 'grind', dir: 'R',
    base: 540, hold: 390, holdMax: 6, minAir: 0.12, style: 'hold', pose: 'grind_smith', repeat: true, diff: 3 },
  { id: 'icepick', name: 'Ice Pick', category: 'grind', mod: 'grind', dir: 'U',
    base: 600, hold: 420, holdMax: 6, minAir: 0.12, style: 'hold', pose: 'grind_icepick', repeat: true, diff: 3 },
  { id: 'toothpick', name: 'Toothpick', category: 'grind', mod: 'grind', dir: 'D',
    base: 650, hold: 440, holdMax: 6, minAir: 0.12, style: 'hold', pose: 'grind_toothpick', repeat: true, diff: 4 },
  { id: 'luce', name: 'Luc-E Grind', category: 'grind', mod: 'grind', dir: 'UL',
    base: 720, hold: 470, holdMax: 6, minAir: 0.12, style: 'hold', pose: 'grind_luce', repeat: true, diff: 4 },
  { id: 'crooked', name: 'Crooked Grind', category: 'grind', mod: 'grind', dir: 'UR',
    base: 620, hold: 430, holdMax: 6, minAir: 0.12, style: 'hold', pose: 'grind_crooked', repeat: true, diff: 3 },
  { id: 'over_toothpick', name: 'Over-Toothpick', category: 'grind', mod: 'grind', dir: 'DL',
    base: 780, hold: 500, holdMax: 6, minAir: 0.12, style: 'hold', pose: 'grind_overtoothpick', repeat: false, diff: 5 },
  { id: 'footjam_grind', name: 'Footjam Grind', category: 'grind', mod: 'grind', dir: 'DR',
    base: 560, hold: 400, holdMax: 6, minAir: 0.12, style: 'hold', pose: 'grind_footjam', repeat: true, diff: 3 },

  // ---- LIP TRICKS (same stick, but on coping) ------------------------------
  { id: 'nosepick', name: 'Nose Pick', category: 'lip', mod: 'lip', dir: 'N',
    base: 600, hold: 420, holdMax: 4, minAir: 0.12, style: 'hold', pose: 'lip_nosepick', repeat: true, diff: 2 },
  { id: 'abubaca', name: 'Abubaca', category: 'lip', mod: 'lip', dir: 'U',
    base: 900, hold: 560, holdMax: 4, minAir: 0.12, style: 'hold', pose: 'lip_abubaca', repeat: true, diff: 4 },
  { id: 'footjam_whip', name: 'Footjam Whip', category: 'lip', mod: 'lip', dir: 'D',
    base: 1000, hold: 600, holdMax: 4, minAir: 0.12, style: 'hold', pose: 'lip_footjamwhip', repeat: false, diff: 5 },
  { id: 'tyre_tap', name: 'Tyre Tap', category: 'lip', mod: 'lip', dir: 'L',
    base: 700, hold: 460, holdMax: 4, minAir: 0.12, style: 'hold', pose: 'lip_tyretap', repeat: true, diff: 3 },
  { id: 'disaster', name: 'Disaster', category: 'lip', mod: 'lip', dir: 'R',
    base: 850, hold: 520, holdMax: 4, minAir: 0.12, style: 'hold', pose: 'lip_disaster', repeat: true, diff: 4 },

  // ---- MANUALS -------------------------------------------------------------
  { id: 'manual', name: 'Manual', category: 'manual', mod: 'manual', dir: 'N',
    base: 150, hold: 170, holdMax: 8, minAir: 0.12, style: 'hold', pose: 'manual', repeat: true, diff: 1 },
  { id: 'nose_manual', name: 'Nose Manual', category: 'manual', mod: 'manual', dir: 'U',
    base: 220, hold: 210, holdMax: 8, minAir: 0.12, style: 'hold', pose: 'nose_manual', repeat: true, diff: 3 },

  // ---- FLATLAND ------------------------------------------------------------
  { id: 'bunnyhop', name: 'Bunnyhop', category: 'flatland', mod: 'hop', dir: 'N',
    base: 120, hold: 0, holdMax: 0, minAir: 0, style: 'auto', pose: 'bunnyhop', repeat: true, diff: 1 },
  { id: 'hang_five', name: 'Hang Five', category: 'flatland', mod: 'flatA', dir: 'U',
    base: 450, hold: 300, holdMax: 3, minAir: 0.15, style: 'hold', pose: 'flat_hangfive', repeat: true, diff: 3 },
  { id: 'surfer', name: 'Surfer', category: 'flatland', mod: 'flatA', dir: 'N',
    base: 380, hold: 260, holdMax: 3, minAir: 0.15, style: 'hold', pose: 'flat_surfer', repeat: true, diff: 2 },
  { id: 'flat_tailwhip', name: 'Flatland Tailwhip', category: 'flatland', mod: 'flatB', dir: 'N',
    base: 520, hold: 0, holdMax: 0, minAir: 0.15, style: 'impulse', dur: 0.55, pose: 'flat_tailwhip', repeat: true, diff: 4 },
];

// ---------------------------------------------------------------------------
// Derived lookups (built once, at module load)
// ---------------------------------------------------------------------------

const DIR_KEYS = ['UL', 'U', 'UR', 'L', 'N', 'R', 'DL', 'D', 'DR'];
const AIR_MODS = ['trickA', 'trickB', 'trickC'];

const BY_ID = new Map();
const RECIPE = new Map();
const SPIN_STEPS = [];

for (let i = 0; i < TRICKS.length; i++) {
  const t = TRICKS[i];
  BY_ID.set(t.id, t);
  RECIPE.set(t.mod + ':' + t.dir, t);
  if (t.mod === 'spin') SPIN_STEPS.push(t);
}
SPIN_STEPS.sort((a, b) => a.spinDeg - b.spinDeg);

/** Recipe lookup with a neutral fallback, so every direction does *something*. */
function recipe(mod, dir) {
  return RECIPE.get(mod + ':' + dir) || RECIPE.get(mod + ':N') || null;
}

const STORE_KEY = 'mirracity.tricklist.v1';

// ---------------------------------------------------------------------------

export function createTricks(ctx) {
  const phys = ctx.player?.physics || null;

  // --- persistent trick list ------------------------------------------------
  const landed = new Set();
  try {
    const raw = globalThis.localStorage?.getItem(STORE_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) for (let i = 0; i < arr.length; i++) if (BY_ID.has(arr[i])) landed.add(arr[i]);
    }
  } catch (err) { /* storage unavailable — the trick list just will not persist */ }

  let landedDirty = false;
  function saveLanded() {
    if (!landedDirty) return;
    landedDirty = false;
    try {
      globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify(Array.from(landed)));
    } catch (err) { /* ignore */ }
  }

  // --- combo ----------------------------------------------------------------
  const combo = [];
  const repeats = new Map();
  let comboPoints = 0;
  let comboText = '';
  let linkTimer = 0;

  // --- the trick currently being performed ----------------------------------
  const current = {
    id: null, name: '', points: 0, category: null, pose: null,
    spinDeg: 0, flipDeg: 0, hold: 0, style: null,
  };

  // active air trick
  let act = null;            // the TRICKS entry
  let actMod = '';           // which button holds it
  let actEntry = null;       // its combo entry (null until it commits)
  let actTime = 0;
  let actHold = 0;           // seconds of hold banked
  let actPitch0 = 0;         // rotation readouts at the moment the trick started
  let actYaw0 = 0;
  let actRoll0 = 0;
  let actDone = false;

  // grind / lip
  let grindEntry = null;
  let grindTrick = null;
  let grindTime = 0;
  let grindHold = 0;
  let grindSwitchTimer = 0;
  let grindSwitchCd = 0;
  let grindPendingDir = '';
  let grindStepMark = -1;

  // manual
  let manualEntry = null;
  let manualTrick = null;
  let manualHold = 0;
  let manualSwitchCd = 0;

  // flatland
  let flatEntry = null;
  let flatTrick = null;
  let flatTime = 0;
  let flatHold = 0;
  let flatMod = '';

  // rotation bookkeeping
  let spinWind = 0;
  let spinOffset = 0;        // ° of yaw a committed trick already accounts for (flair)
  let spinStep = -1;
  let spinEntry = null;

  // input edges
  const prevMod = [false, false, false];
  const modHold = [0, 0, 0];
  let prevSwitchBtn = false;
  let queuedMod = '';
  let poseId = null;
  let stepId = 0;
  let lastLandStep = -1;
  let lastBailStep = -1;
  let flashIdx = 0;
  let disposed = false;

  const api = {
    current: null,
    combo,
    comboActive: false,
    comboPoints: 0,
    comboText: '',
    tuckWarning: false,
    TRICKS,
    list: TRICKS,
    total: TRICKS.length,
    landed,
    landedCount: landed.size,
  };

  // ------------------------------------------------------------------ helpers

  function stateOf() { return ctx.player?.physics?.state || phys?.state || null; }

  /** 8-way + neutral direction from the current stick / keys. */
  function readDir(input) {
    const s = input?.state;
    if (!s) return 'N';
    let x = 0;
    let y = 0;
    if (s.steer > 0.4) x = 1; else if (s.steer < -0.4) x = -1;
    if (s.lean > 0.4) y = 1; else if (s.lean < -0.4) y = -1;
    return DIR_KEYS[(y + 1) * 3 + (x + 1)];
  }

  /** Held, and not jammed down. A jammed modifier releases whatever it was holding. */
  function modLive(input, name) {
    if (!input.held(name)) return false;
    for (let i = 0; i < AIR_MODS.length; i++) {
      if (AIR_MODS[i] === name) return modHold[i] < T.stuckHold;
    }
    return true;
  }

  function falloffFor(trick) {
    const n = repeats.get(trick.id) || 0;
    if (n === 0) return 1;
    const k = trick.repeat === false ? T.repeatFalloffHard : T.repeatFalloff;
    return Math.max(T.repeatFloor, Math.pow(k, n));
  }

  function setPose(id) {
    if (poseId === id) return;
    const anim = ctx.player?.anim;
    if (poseId && anim?.setPose) anim.setPose(poseId, 0);
    poseId = id;
    if (id && anim?.setPose) anim.setPose(id, 1);
  }

  function rebuildText() {
    const n = combo.length;
    if (n === 0) { comboText = ''; api.comboText = ''; return; }
    const from = n > T.comboTextMax ? n - T.comboTextMax : 0;
    let s = from > 0 ? '… + ' : '';
    for (let i = from; i < n; i++) s += (i > from ? ' + ' : '') + combo[i].name;
    comboText = s;
    api.comboText = s;
  }

  function recountPoints() {
    let p = 0;
    for (let i = 0; i < combo.length; i++) p += combo[i].points;
    comboPoints = p;
    api.comboPoints = p;
  }

  function tellScoring(entry) {
    const s = ctx.player?.scoring;
    if (s) {
      if (typeof s.addTrick === 'function') s.addTrick(entry);
      else if (typeof s.trick === 'function') s.trick(entry);
      else if (typeof s.onTrick === 'function') s.onTrick(entry);
      else if (typeof s.appendTrick === 'function') s.appendTrick(entry);
      else if (typeof s.pushTrick === 'function') s.pushTrick(entry);
    }
    ctx.emit?.('trick', entry);
  }

  function tellScoringUpdate(entry) {
    const s = ctx.player?.scoring;
    if (s && typeof s.updateTrick === 'function') s.updateTrick(entry);
  }

  function audioTrick(entry) {
    const a = ctx.audio;
    if (!a) return;
    if (typeof a.trick === 'function') a.trick(entry);
    else if (typeof a.play === 'function') a.play('trick', entry);
  }

  /**
   * Commit a trick to the combo. Returns the live entry object — scoring.js is
   * handed this same reference, so hold bonuses that accrue afterwards show up
   * without another call.
   */
  function commit(trick, extraPoints) {
    const n = repeats.get(trick.id) || 0;
    const scale = falloffFor(trick);
    const entry = {
      id: trick.id,
      name: trick.name,
      category: trick.category,
      pose: trick.pose,
      diff: trick.diff,
      base: Math.round(trick.base * scale),
      points: Math.round(trick.base * scale + (extraPoints || 0)),
      holdTime: 0,
      holdPoints: 0,
      scale,
      repeats: n,
      index: combo.length,
    };
    repeats.set(trick.id, n + 1);
    combo.push(entry);
    api.comboActive = true;
    linkTimer = T.linkWindow;
    rebuildText();
    recountPoints();
    tellScoring(entry);
    audioTrick(entry);
    if (trick.base >= T.bigTrick) ctx.fx?.shake?.(0.07);
    return entry;
  }

  function addHold(entry, trick, fdt, heldSoFar, quality) {
    if (!entry || !trick.hold) return heldSoFar;
    if (heldSoFar >= trick.holdMax) return heldSoFar;
    const step = Math.min(fdt, trick.holdMax - heldSoFar);
    const next = heldSoFar + step;
    entry.holdTime = next;
    entry.holdPoints = Math.round(trick.hold * next * entry.scale * (quality === undefined ? 1 : quality));
    entry.points = entry.base + entry.holdPoints;
    recountPoints();
    tellScoringUpdate(entry);
    return next;
  }

  function setCurrent(trick, entry) {
    if (!trick) { api.current = null; current.id = null; return; }
    const st = stateOf();
    current.id = trick.id;
    current.name = trick.name;
    current.points = entry ? entry.points : trick.base;
    current.category = trick.category;
    current.pose = trick.pose;
    current.style = trick.style;
    current.hold = entry ? entry.holdTime : 0;
    current.spinDeg = st ? st.spinDeg : 0;
    current.flipDeg = st ? st.flipDeg : 0;
    api.current = current;
  }

  // ------------------------------------------------------------------- combo

  function bankCombo() {
    if (!api.comboActive && combo.length === 0) return;
    const s = ctx.player?.scoring;
    const pts = comboPoints;
    const n = combo.length;
    if (s) {
      if (typeof s.bankCombo === 'function') s.bankCombo();
      else if (typeof s.endCombo === 'function') s.endCombo();
      else if (typeof s.commitCombo === 'function') s.commitCombo();
    }
    ctx.emit?.('comboBank', { points: pts, tricks: n });
    clearCombo();
    saveLanded();
  }

  function clearCombo() {
    combo.length = 0;
    repeats.clear();
    comboPoints = 0;
    api.comboPoints = 0;
    api.comboActive = false;
    spinEntry = null;
    spinStep = -1;
    spinOffset = 0;
    rebuildText();
  }

  function creditLanded() {
    for (let i = 0; i < combo.length; i++) {
      const id = combo[i].id;
      if (!landed.has(id)) { landed.add(id); landedDirty = true; }
    }
    api.landedCount = landed.size;
  }

  // ------------------------------------------------------------- air rotation

  function driveSpin(fdt, input, st) {
    // A trick that owns the yaw (flair) locks the spin buttons out for its duration.
    const trickOwnsYaw = act && act.spin && !actDone;
    const sl = input.held('spinLeft');
    const sr = input.held('spinRight');
    const dir = (sr ? 1 : 0) - (sl ? 1 : 0);

    if (dir !== 0 && !trickOwnsYaw) {
      spinWind = Math.min(1, spinWind + fdt / T.spinRamp);
      phys?.applyTrickRotation?.('yaw', dir * T.spinRate * spinWind);
    } else {
      spinWind = Math.max(0, spinWind - T.spinDecay * fdt);
      // Landing assist: once the buttons are out and the bike is coming down, nudge
      // the heading onto the nearest half-rotation so a 360 actually lands a 360.
      if (!trickOwnsYaw && st.airTime > 0.15 && st.velocity.y < 0.5) {
        const target = Math.round(st.rotation.yaw / 180) * 180;
        const err = target - st.rotation.yaw;
        if (Math.abs(err) > 1.5 && Math.abs(err) < T.spinSnapWindow) {
          const rate = clamp(err * deg * T.spinSnapGain, -T.spinSnapMax, T.spinSnapMax);
          phys?.applyTrickRotation?.('yaw', rate);
        }
      }
    }

    // Name the rotation as soon as it is banked.
    const credit = Math.abs(st.rotation.yaw) - spinOffset;
    let step = -1;
    for (let i = 0; i < SPIN_STEPS.length; i++) {
      if (credit >= SPIN_STEPS[i].spinDeg - T.spinNameTol) step = i; else break;
    }
    if (step > spinStep) {
      spinStep = step;
      const trick = SPIN_STEPS[step];
      if (spinEntry) {
        // Upgrade the entry already in the combo instead of stacking 180+360+540.
        spinEntry.id = trick.id;
        spinEntry.name = trick.name;
        spinEntry.diff = trick.diff;
        spinEntry.base = Math.round(trick.base * spinEntry.scale);
        spinEntry.points = spinEntry.base + spinEntry.holdPoints;
        rebuildText();
        recountPoints();
        tellScoringUpdate(spinEntry);
        audioTrick(spinEntry);
      } else {
        spinEntry = commit(trick, 0);
      }
      if (trick.spinDeg >= 540) ctx.fx?.shake?.(0.06);
    }
  }

  /** Closed-loop driver for the flip/cork tricks — lands them level, every time. */
  function driveTrickRotation(st) {
    if (!act || actDone) return true;
    let finished = true;
    if (act.flip) {
      const done = st.rotation.pitch - actPitch0;
      const remain = act.flip - done;
      if (Math.abs(remain) > T.flipDone) {
        finished = false;
        let rate = remain * deg * T.flipGain;
        const mag = Math.abs(rate);
        if (mag < T.flipMin && Math.abs(remain) > 25) rate = Math.sign(rate) * T.flipMin;
        phys?.applyTrickRotation?.('flip', clamp(rate, -T.flipMax, T.flipMax));
      }
    }
    if (act.spin) {
      const done = st.rotation.yaw - actYaw0;
      const remain = act.spin - done;
      if (Math.abs(remain) > T.flipDone) {
        finished = false;
        let rate = remain * deg * T.flipGain * 0.8;
        const mag = Math.abs(rate);
        if (mag < 2.2 && Math.abs(remain) > 25) rate = Math.sign(rate) * 2.2;
        phys?.applyTrickRotation?.('yaw', clamp(rate, -T.flipMax, T.flipMax));
      }
    }
    if (act.roll) {
      const done = st.rotation.roll - actRoll0;
      const remain = act.roll - done;
      if (Math.abs(remain) > T.flipDone) {
        finished = false;
        let rate = remain * deg * T.flipGain;
        const mag = Math.abs(rate);
        if (mag < T.flipMin && Math.abs(remain) > 25) rate = Math.sign(rate) * T.flipMin;
        phys?.applyTrickRotation?.('roll', clamp(rate, -T.flipMax, T.flipMax));
      }
    }
    return finished;
  }

  /** How far through an impulse trick we are, 0..1 — used for the landing rule. */
  function impulseProgress(st) {
    if (!act) return 1;
    if (actDone) return 1;
    let p = act.dur > 0 ? actTime / act.dur : 1;
    if (act.flip) {
      const done = Math.abs(st.rotation.pitch - actPitch0);
      p = Math.min(p, done / Math.abs(act.flip));
    }
    if (act.roll) {
      const done = Math.abs(st.rotation.roll - actRoll0);
      p = Math.min(p, done / Math.abs(act.roll));
    }
    return p;
  }

  // ---------------------------------------------------------------- air trick

  function startAirTrick(trick, mod, st) {
    if (!trick) return;
    endAirTrick('switch', st);
    act = trick;
    actMod = mod;
    actEntry = null;
    actTime = 0;
    actHold = 0;
    actDone = false;
    actPitch0 = st.rotation.pitch;
    actYaw0 = st.rotation.yaw;
    actRoll0 = st.rotation.roll;
    if (trick.spin) spinOffset += Math.abs(trick.spin);
    setPose(trick.pose);
    setCurrent(trick, null);
  }

  function endAirTrick(reason, st) {
    if (!act) return;
    const trick = act;
    const entry = actEntry;
    act = null;
    actMod = '';
    actEntry = null;
    actDone = false;
    setPose(null);
    api.current = null;
    current.id = null;
    if (entry) ctx.emit?.('trickEnd', { id: trick.id, name: trick.name, points: entry.points, reason });
  }

  function updateAir(fdt, input, st) {
    driveSpin(fdt, input, st);

    // --- run the active trick ------------------------------------------------
    if (act) {
      actTime += fdt;
      if (act.style === 'hold') {
        if (!modLive(input, actMod)) {
          endAirTrick('release', st);
        } else {
          if (!actEntry && actTime >= act.minAir) actEntry = commit(act, 0);
          if (actEntry) actHold = addHold(actEntry, act, fdt, actHold);
          setCurrent(act, actEntry);
        }
      } else {
        const rotDone = driveTrickRotation(st);
        if (!actEntry && actTime >= act.minAir) actEntry = commit(act, 0);
        setCurrent(act, actEntry);
        if (rotDone && actTime >= act.dur) {
          actDone = true;
          endAirTrick('complete', st);
        }
      }
    }

    // --- new input -----------------------------------------------------------
    let fireMod = '';
    for (let i = 0; i < AIR_MODS.length; i++) {
      const m = AIR_MODS[i];
      if (input.held(m) && !prevMod[i] && modHold[i] < T.stuckHold) { fireMod = m; break; }
    }
    if (!fireMod && queuedMod) { fireMod = queuedMod; }
    queuedMod = '';
    // A rotation that is still coming round owns the bike — you cannot abandon a
    // half-finished flip, and the landing rule would bail you for it anyway.
    const locked = !!act && !actDone && act.style === 'impulse' && !!(act.flip || act.spin || act.roll);
    if (fireMod && !locked) {
      startAirTrick(recipe(fireMod, readDir(input)), fireMod, st);
    }

    // --- tuck warning --------------------------------------------------------
    api.tuckWarning = !!(act && act.style === 'hold' && actEntry && st.velocity.y < -4.5);
  }

  function onEnterAir(input) {
    spinWind = 0;
    spinOffset = 0;
    spinStep = -1;
    spinEntry = null;
    queuedMod = '';
    // Buffered launch: a modifier tapped just before the lip fires the instant the
    // wheels leave, which is what makes inputs feel like they land inside 2 frames.
    for (let i = 0; i < AIR_MODS.length; i++) {
      const m = AIR_MODS[i];
      if (input.bufferedIn(m, T.bufferMs)) {
        queuedMod = m;
        input.consumeBuffer?.(m);
        break;
      }
    }
  }

  // -------------------------------------------------------------------- grind

  function grindSetFor(railType) { return railType === 'coping' ? 'lip' : 'grind'; }

  function currentRailType() {
    const st = stateOf();
    const g = ctx.player?.grind;
    return g?.rail?.type || g?.railType || st?.rail?.rail?.type || st?.rail?.type || 'rail';
  }

  function startGrindTrick(trick) {
    if (!trick) return null;
    grindTrick = trick;
    grindTime = 0;
    grindHold = 0;
    grindEntry = commit(trick, 0);
    setPose(trick.pose);
    setCurrent(trick, grindEntry);
    return grindEntry;
  }

  function stopGrindTrick(reason) {
    if (!grindTrick) return;
    const trick = grindTrick;
    const entry = grindEntry;
    grindTrick = null;
    grindEntry = null;
    grindTime = 0;
    grindHold = 0;
    grindPendingDir = '';
    grindSwitchTimer = 0;
    setPose(null);
    api.current = null;
    current.id = null;
    if (entry) ctx.emit?.('trickEnd', { id: trick.id, name: trick.name, points: entry.points, reason });
  }

  function updateGrind(fdt, input) {
    if (grindStepMark === stepId) return;      // grind.js already drove this step
    grindStepMark = stepId;
    if (!grindTrick) {
      startGrindTrick(recipe(grindSetFor(currentRailType()), readDir(input)));
      return;
    }
    grindTime += fdt;
    grindSwitchCd = Math.max(0, grindSwitchCd - fdt);

    // Balance quality feeds the hold bonus: a wobbling grind pays less than a locked one.
    const bal = ctx.player?.grind?.balance;
    const q = typeof bal === 'number' ? 1 - 0.4 * Math.min(1, Math.abs(bal)) : 1;
    grindHold = addHold(grindEntry, grindTrick, fdt, grindHold, q);
    setCurrent(grindTrick, grindEntry);

    // Switching grind type mid-rail: hold a new direction briefly, then it re-commits.
    const set = grindSetFor(currentRailType());
    const dir = readDir(input);
    const want = recipe(set, dir);
    if (want && want !== grindTrick && grindSwitchCd <= 0) {
      if (dir === grindPendingDir) {
        grindSwitchTimer += fdt;
        if (grindSwitchTimer >= T.grindSwitchHold) {
          stopGrindTrick('switch');
          grindSwitchCd = T.grindSwitchCool;
          startGrindTrick(want);
        }
      } else {
        grindPendingDir = dir;
        grindSwitchTimer = 0;
      }
    } else {
      grindPendingDir = '';
      grindSwitchTimer = 0;
    }
  }

  // ------------------------------------------------------------------- manual

  function startManual(type) {
    const trick = type === 'nose' ? BY_ID.get('nose_manual') : BY_ID.get('manual');
    manualTrick = trick;
    manualHold = 0;
    manualEntry = commit(trick, 0);
    setPose(trick.pose);
    setCurrent(trick, manualEntry);
  }

  function stopManual(reason) {
    if (!manualTrick) return;
    const trick = manualTrick;
    const entry = manualEntry;
    manualTrick = null;
    manualEntry = null;
    manualHold = 0;
    setPose(null);
    api.current = null;
    current.id = null;
    if (entry) ctx.emit?.('trickEnd', { id: trick.id, name: trick.name, points: entry.points, reason });
  }

  function updateManual(fdt, input, st) {
    manualSwitchCd = Math.max(0, manualSwitchCd - fdt);
    const type = st.manualType === 'nose' ? 'nose' : 'manual';
    const wantId = type === 'nose' ? 'nose_manual' : 'manual';
    if (!manualTrick || manualTrick.id !== wantId) {
      stopManual('switch');
      startManual(type);
    }
    // Balance quality again: riding the centre of the meter pays best.
    const q = 1 - 0.45 * Math.min(1, Math.abs(st.balance));
    manualHold = addHold(manualEntry, manualTrick, fdt, manualHold, q);
    setCurrent(manualTrick, manualEntry);

    // trickB flips manual ↔ nose manual without dropping the combo. The physics owns
    // `manualType`; we only ask for the swap when the meter is calm enough to survive it.
    const swap = input.held('trickB');
    if (swap && !prevSwitchBtn && manualSwitchCd <= 0 && Math.abs(st.balance) < 0.55) {
      st.manualType = st.manualType === 'nose' ? 'manual' : 'nose';
      st.balance = st.balance * 0.35 + (st.balance >= 0 ? 0.1 : -0.1);
      manualSwitchCd = T.manualSwitchCool;
    }
  }

  // ----------------------------------------------------------------- flatland

  function stopFlat(reason) {
    if (!flatTrick) return;
    const trick = flatTrick;
    const entry = flatEntry;
    flatTrick = null;
    flatEntry = null;
    flatMod = '';
    flatTime = 0;
    flatHold = 0;
    setPose(null);
    api.current = null;
    current.id = null;
    if (entry) ctx.emit?.('trickEnd', { id: trick.id, name: trick.name, points: entry.points, reason });
  }

  function updateFlat(fdt, input, st) {
    if (flatTrick) {
      flatTime += fdt;
      if (flatTrick.style === 'hold') {
        if (!modLive(input, flatMod) || st.speed > T.flatMaxSpeed * 1.35) {
          stopFlat('release');
        } else {
          if (!flatEntry && flatTime >= flatTrick.minAir) flatEntry = commit(flatTrick, 0);
          if (flatEntry) flatHold = addHold(flatEntry, flatTrick, fdt, flatHold);
          setCurrent(flatTrick, flatEntry);
        }
      } else {
        if (!flatEntry && flatTime >= flatTrick.minAir) flatEntry = commit(flatTrick, 0);
        setCurrent(flatTrick, flatEntry);
        if (flatTime >= flatTrick.dur) stopFlat('complete');
      }
      return;
    }
    if (st.speed > T.flatMaxSpeed || input.held('hop')) return;
    const dir = readDir(input);
    if (input.held('trickA') && !prevMod[0] && modHold[0] < T.stuckHold) {
      flatTrick = recipe('flatA', dir); flatMod = 'trickA';
    } else if (input.held('trickB') && !prevMod[1] && modHold[1] < T.stuckHold) {
      flatTrick = recipe('flatB', dir); flatMod = 'trickB';
    }
    if (flatTrick) {
      flatTime = 0;
      flatHold = 0;
      flatEntry = null;
      setPose(flatTrick.pose);
      setCurrent(flatTrick, null);
    }
  }

  // ------------------------------------------------------------------- events

  function endEverything(reason, st) {
    endAirTrick(reason, st);
    stopGrindTrick(reason);
    stopManual(reason);
    stopFlat(reason);
    setPose(null);
    api.current = null;
    current.id = null;
    api.tuckWarning = false;
  }

  function onLand(quality, detail) {
    if (disposed) return;
    if (lastLandStep === stepId) return;
    lastLandStep = stepId;
    const st = stateOf();
    const q = typeof quality === 'number' ? quality : (quality?.quality ?? detail?.quality ?? 1);

    // Landing with a grab still hanging out, or before a rotation has come round,
    // is a bail — tuck it back in.
    if (act && st) {
      const held = act.style === 'hold' && actEntry;
      const short = act.style === 'impulse' && !actDone && impulseProgress(st) < T.impulseGrace;
      if (held || short) {
        const reason = held ? 'notucked' : 'rotation';
        endEverything('bail', st);
        lastLandStep = -1;              // let the bail that follows do its own work
        ctx.player?.physics?.forceBail?.(reason);
        return;
      }
      endAirTrick('land', st);
    }
    stopFlat('land');

    if (combo.length) {
      creditLanded();
      const s = ctx.player?.scoring;
      if (s) {
        if (typeof s.land === 'function') s.land(q, combo);
        else if (typeof s.onLand === 'function') s.onLand(q, combo);
        else if (typeof s.landCombo === 'function') s.landCombo(q, combo);
      }
      ctx.emit?.('comboLand', { quality: q, points: comboPoints, tricks: combo.length });
      if (comboPoints > T.bigCombo) {
        ctx.fx?.shake?.(0.14);
        ctx.fx?.flashbulb?.(flashIdx++);
        ctx.fx?.flashbulb?.(flashIdx++);
      }
    }
    linkTimer = T.linkWindow;
  }

  function onBail(reason) {
    if (disposed) return;
    if (lastBailStep === stepId) return;
    lastBailStep = stepId;
    const st = stateOf();
    endEverything('bail', st);
    const lost = comboPoints;
    const n = combo.length;
    const s = ctx.player?.scoring;
    if (s) {
      if (typeof s.bail === 'function') s.bail(reason);
      else if (typeof s.onBail === 'function') s.onBail(reason);
      else if (typeof s.loseCombo === 'function') s.loseCombo(reason);
    }
    ctx.emit?.('comboBail', { reason: typeof reason === 'string' ? reason : 'bail', points: lost, tricks: n });
    clearCombo();
    linkTimer = 0;
    saveLanded();
  }

  function onHop(e) {
    // The bunnyhop only scores as a link — it keeps a live combo alive between
    // features instead of spamming the HUD every time you tap the button.
    if (!api.comboActive || combo.length === 0) return;
    const charge = e?.detail?.charge ?? 0;
    if (charge < 0.25) return;
    const trick = BY_ID.get('bunnyhop');
    commit(trick, 0);
    linkTimer = T.linkWindow;
  }

  const handlers = [
    ['land', (e) => onLand(e?.detail?.quality ?? 1, e?.detail)],
    ['bail', (e) => onBail(e?.detail?.reason || 'bail')],
    ['hop', onHop],
    ['respawn', () => { endEverything('respawn', stateOf()); clearCombo(); }],
  ];
  for (let i = 0; i < handlers.length; i++) ctx.on?.(handlers[i][0], handlers[i][1]);

  // --------------------------------------------------------------- fixedUpdate

  let prevMode = 'ride';

  api.fixedUpdate = function fixedUpdate(fdt, c) {
    if (disposed) return;
    const cx = c || ctx;
    const input = cx.input;
    const st = stateOf();
    if (!input || !st) return;

    for (let i = 0; i < AIR_MODS.length; i++) {
      modHold[i] = input.held(AIR_MODS[i]) ? modHold[i] + fdt : 0;
    }

    const mode = st.mode;
    if (mode !== prevMode) {
      if (prevMode === 'air' && mode !== 'bail') endAirTrick('mode', st);
      if (prevMode === 'grind') stopGrindTrick('mode');
      if (prevMode === 'manual') stopManual('mode');
      if (prevMode === 'ride' && mode !== 'ride') stopFlat('mode');
      if (mode === 'air') onEnterAir(input);
      prevMode = mode;
    }

    switch (mode) {
      case 'air':
        updateAir(fdt, input, st);
        linkTimer = T.linkWindow;
        break;
      case 'grind':
        updateGrind(fdt, input);
        linkTimer = T.linkWindow;
        break;
      case 'manual':
        updateManual(fdt, input, st);
        linkTimer = T.linkWindow;
        break;
      case 'wallride':
        linkTimer = T.linkWindow;
        break;
      case 'bail':
        break;
      default:
        updateFlat(fdt, input, st);
        if (api.comboActive && !flatTrick) {
          linkTimer -= fdt;
          if (linkTimer <= 0) bankCombo();
        }
        break;
    }

    if (api.current) {
      current.spinDeg = st.spinDeg;
      current.flipDeg = st.flipDeg;
    }

    for (let i = 0; i < AIR_MODS.length; i++) prevMod[i] = input.held(AIR_MODS[i]);
    prevSwitchBtn = input.held('trickB');

    // Bumped LAST: physics events and grind.js both run before us inside the same
    // fixed step, so they and this body must all see the same step id.
    stepId++;
  };

  // ---------------------------------------------------------------- public API

  /** Called by main.js order, and available to anyone holding the instance. */
  api.onLand = onLand;
  api.onBail = onBail;

  /** The trick a grind would be named right now, for the given rail type. */
  api.grindTrickFor = function grindTrickFor(railType) {
    const set = grindSetFor(railType || currentRailType());
    return recipe(set, readDir(ctx.input));
  };
  api.nameGrind = api.grindTrickFor;

  /**
   * grind.js: commit the grind trick chosen by the current input. Idempotent, so it
   * is safe to call every step; it deliberately does NOT claim the step, so the
   * automatic hold accrual keeps running for a grind system that only calls this.
   */
  api.beginGrind = function beginGrind(railType) {
    if (grindTrick) return grindEntry;
    const set = grindSetFor(railType || currentRailType());
    return startGrindTrick(recipe(set, readDir(ctx.input)));
  };

  /** grind.js: accrue hold time on the live grind trick. `quality` is 0..1. */
  api.recordGrindHold = function recordGrindHold(fdt, quality) {
    grindStepMark = stepId;
    if (!grindTrick || !grindEntry) return 0;
    grindTime += fdt;
    grindHold = addHold(grindEntry, grindTrick, fdt, grindHold, quality);
    setCurrent(grindTrick, grindEntry);
    return grindHold;
  };
  api.holdGrind = api.recordGrindHold;

  /** grind.js: the rail is done (hop-out, transfer, end of rail, bail). */
  api.endGrind = function endGrind(reason) {
    grindStepMark = stepId;
    stopGrindTrick(reason || 'exit');
  };

  /** Seconds the live grind trick has been running — grind.js uses it for its HUD. */
  Object.defineProperty(api, 'grindTime', { get: () => grindTime });
  Object.defineProperty(api, 'grindTrick', { get: () => grindTrick });

  api.byId = (id) => BY_ID.get(id) || null;
  api.hasLanded = (id) => landed.has(id);
  api.comboString = () => comboText;
  /** Difficulty tag for the trick-list panel, matching the reference HUD. */
  api.difficultyTag = function difficultyTag() {
    const r = landed.size / TRICKS.length;
    if (r >= 0.85) return 'SICK';
    if (r >= 0.6) return 'PRO';
    if (r >= 0.3) return 'HARD';
    return 'AM';
  };
  api.resetTrickList = function resetTrickList() {
    landed.clear();
    api.landedCount = 0;
    landedDirty = true;
    saveLanded();
  };
  api.reset = function reset() {
    endEverything('reset', stateOf());
    clearCombo();
    linkTimer = 0;
    prevMode = 'ride';
  };

  api.dispose = function dispose() {
    disposed = true;
    saveLanded();
    for (let i = 0; i < handlers.length; i++) {
      ctx.events?.removeEventListener?.(handlers[i][0], handlers[i][1]);
    }
    endEverything('dispose', stateOf());
    clearCombo();
  };

  return api;
}
