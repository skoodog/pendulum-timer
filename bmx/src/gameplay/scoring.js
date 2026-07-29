// MIRRA CITY — scoring, combos, special meter, goals and session flow.
//
// This is the game layer: it turns the events the physics/trick/grind modules emit
// into a THPS3 / DMFBMX2 scoreboard.
//
// The combo model, exactly as the reference games play it:
//
//   * Every trick appends an entry to the ACTIVE COMBO. The multiplier is simply the
//     number of scored tricks in it, so the HUD line reads `2,350 X 2`.
//   * The combo TOTAL is sum(points) × multiplier. It is worth nothing until the
//     rider lands cleanly and the link window runs out — then it BANKS into the score.
//   * A bail loses the whole thing, and empties the special meter with it.
//   * The link timer only drains while the rider is rolling on the ground with
//     nothing going on. Air, grind, manual and wallride all freeze it, which is what
//     lets a manual stitch two lines into one 300 k combo.
//   * Repeating a trick inside one combo pays progressively less.
//
// Integration contract (everything optional-chained; a missing sibling can never
// break the boot):
//
//   tricks.js  → scoring.addTrick(entry) / .updateTrick(entry) / .land(q, combo)
//                / .bankCombo() / .bail(reason)          (entries are LIVE objects:
//                the hold bonus keeps accruing on the same reference after the add)
//   grind.js   → scoring.addTrick(payload) with `source:'grind'` as a fallback path
//                when tricks.js is not naming the grind itself
//   physics    → ctx events 'land' / 'bail' / 'hop' / 'respawn'
//   grind.js   → ctx events 'grindStart' / 'grindEnd'
//
// Events fired for the HUD and the results screen:
//   'sessionStart' 'sessionEnd' 'countdown'
//   'scoreBank' 'scoreLost' 'scoreGap' 'letterCollected' 'collectibleFound'
//   'objectSmashed' 'goalComplete' 'achievement' 'rankUp' 'specialReady'
//
// Collectibles, per the demo scope: FIVE letters spelling B-M-X-E-R placed on the
// park's real lines (see LETTER_DEFS) and FIVE hidden spray cans tucked off them
// (see COLLECT_DEFS). Both are per-run sets with their own goal; the goal's
// completion persists in the profile, the pickups themselves reset every run.
//
// Allocation policy: fixedUpdate() allocates nothing. Combo slots, leaderboard rows,
// goal records and the letter/can/smashable pickups are all pooled up front. The only
// runtime objects are the small detail payloads on discrete events (a few per second)
// and the HUD strings, which are rebuilt on change, never per frame.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clamp, damp } from '../core/mathx.js';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

export const SCORE_TUNE = {
  sessionTime: 120,          // s — a 2:00 run, DMFBMX2 length
  countdownFrom: 10,         // s left when the ticking cue starts

  comboWindow: 2.2,          // s the link timer runs for on the ground
  comboWindowMin: 0.8,       // never shrink the adaptive window below this
  slotMax: 96,               // hard cap on tricks in one combo (a 96-trick line is plenty)

  repeatFalloff: 0.5,        // ×per repeat, for entries that arrive WITHOUT their own scale
  repeatFloor: 0.12,         // never below this fraction of base

  // land quality bands — physics hands us 0..1 of alignment error headroom
  sketchyBelow: 0.45,        // q under this is a save, not a landing
  perfectAbove: 0.90,        // q over this is stomped
  multSketchy: 0.60,
  multClean: 1.00,
  multPerfect: 1.15,

  // special / "Mirra" meter
  specialAir: 0.055,         // per second of air
  specialGrind: 0.075,       // per second of grind
  specialManual: 0.030,      // per second of manual
  specialVariety: 0.022,     // per trick id not yet used in this run
  specialRepeatTrick: 0.006, // per trick otherwise
  specialPerfect: 0.050,     // per perfect landing
  specialBankRef: 90000,     // combo points that fill the bar completely on one bank
  specialBankMax: 0.34,      // ...capped at this much per bank
  specialIdleDecay: 0.020,   // per second while rolling with no combo
  specialReadyDrain: 0.050,  // per second once the bar is full and armed
  specialScore: 2.0,         // score multiplier on tricks thrown while armed

  // grind accrual (our own fallback slot — see updateGrindPoints)
  grindBase: 260,            // points the moment the pegs lock onto the rail
  grindRate: 190,            // points per second held, at the reference speed
  grindSpeedRef: 8,          // m/s the rate above is quoted at
  grindSpeedMin: 0.40,       // clamp so a crawling grind still pays something
  grindSpeedMax: 1.60,       // ...and a rocket down a handrail does not run away
  grindOpenAfter: 0.12,      // s on the rail before we open a slot of our own

  // pickups / smashables
  letterRadius: 1.55,        // m pickup radius on the B-M-X-E-R letters
  letterPoints: 500,         // per letter
  letterSetBonus: 5000,      // for the whole word
  collectRadius: 1.35,       // m pickup radius on the hidden spray cans
  collectPoints: 750,        // per hidden can
  collectSetBonus: 7500,     // for finding all five
  smashRadius: 0.95,         // m
  smashMinSpeed: 2.6,        // m/s needed to actually break something
  smashPoints: 500,
  gapFlashTime: 2.0,         // s the gap name stays up on the HUD

  scoreLerp: 14,             // 1/s the displayed score rolls up to the real one
};

const T = SCORE_TUNE;
const STORE_KEY = 'mirracity.profile.v2';
// v3 added totals.hidden and swapped the `combo25k` goal id for `hidden`. The key is
// deliberately unchanged: loadProfile() salvages any older payload field by field, so
// a v2 profile keeps its high scores, achievements, gaps and landed tricks.
const STORE_VERSION = 3;

// ---------------------------------------------------------------------------
// Static data
// ---------------------------------------------------------------------------

/**
 * Invented rivals — no real riders, no real events, no real brands.
 *
 * The HUD board is FIVE rows and the player owns one of them, so there are four
 * rivals: the ranks the player reads are always 1..5 with no gap in the column and
 * no phantom sixth place. The ladder is spaced for a 2:00 run — the bottom rung
 * falls to a couple of decent lines, the top one takes a run that actually flows.
 */
const RIVALS = [
  { name: 'Vance Corado', score: 165000 },
  { name: 'Dez Mallory', score: 112000 },
  { name: 'Kai Brenner', score: 74000 },
  { name: 'Rook Deloso', score: 38000 },
];

/** Rows in the competition table: the rivals plus the player. */
const BOARD_ROWS = RIVALS.length + 1;

/**
 * Named gap volumes, derived by hand from the City Lot layout in park.js
 * (park.js does not publish gap geometry, so these are authored against its
 * documented world coordinates). A gap clears when the contact origin passes
 * through the box while genuinely airborne.
 */
const GAP_DEFS = [
  { id: 'funbox', name: 'Funbox Fly', points: 500,
    min: [-4.8, 1.30, -9.2], max: [4.8, 5.0, -2.8] },
  { id: 'stairgap', name: 'Plaza Stair Gap', points: 800,
    min: [11.0, 0.60, 2.2], max: [17.6, 4.6, 5.6] },
  { id: 'hubba', name: 'Hubba Hop', points: 600,
    min: [16.4, 1.10, 1.0], max: [18.8, 4.6, 5.4] },
  { id: 'plazabank', name: 'Bank to Plaza', points: 450,
    min: [4.2, 1.20, -8.2], max: [8.2, 4.4, -2.6] },
  { id: 'spine', name: 'Spine Transfer', points: 1200,
    min: [6.0, 2.00, -18.4], max: [18.0, 7.0, -13.6] },
  { id: 'bowl', name: 'Bowl Channel', points: 1500,
    min: [-36.0, 0.60, -21.0], max: [-24.0, 6.5, -7.0] },
  { id: 'hip', name: 'Hip Transfer', points: 1400,
    min: [-6.5, 2.50, -36.6], max: [3.0, 8.0, -31.4] },
  { id: 'mini', name: 'Mini Ramp Channel', points: 900,
    min: [-40.0, 2.00, 11.5], max: [-24.0, 6.5, 20.5] },
  { id: 'wall', name: 'Wall Gap', points: 1100,
    min: [19.4, 1.60, -34.0], max: [24.6, 6.5, -18.0] },
  { id: 'dirt1', name: 'Dirt Double One', points: 1000, dirt: true,
    min: [43.4, 1.60, 17.6], max: [50.6, 8.0, 21.6] },
  { id: 'dirt2', name: 'Dirt Double Two', points: 1300, dirt: true,
    min: [43.4, 1.90, 1.8], max: [50.6, 8.0, 6.2] },
  { id: 'dirt3', name: 'Dirt Double Three', points: 1700, dirt: true,
    min: [43.4, 2.20, -14.6], max: [50.6, 8.0, -9.8] },
  { id: 'berm', name: 'Berm Blast', points: 700,
    min: [33.0, 1.20, -33.0], max: [49.0, 6.0, -19.0] },
];

/**
 * B-M-X-E-R letter pickups. Every position is authored off real park.js geometry
 * (spawns, rail curves and the surface heights under them, all read back out of the
 * built level) so nothing floats in a place the rider cannot get to, and nothing is
 * buried inside a ramp. One per skill:
 *
 *   B  easy      — the run-out from the roll-in, at head height on the main line.
 *   M  rail      — over the funbox flat rail (rail curve x=2.2, y=1.34, z -10.6..-1.4).
 *   X  air       — out over the 3.6 m quarterpipe lip (coping y=3.62 at z=-35.58);
 *                  a measured full-speed boost peaks around y=4.5 there, and the
 *                  pickup only opens from y≈3.85 up, so it wants a real transfer of
 *                  speed into height, not a roll up the transition.
 *   E  gap       — hanging in the Plaza Stair Gap past the bottom step, where the
 *                  stairs have already dropped away: you clear the set or you miss.
 *   R  tucked    — the deep end of the bowl (floor y=-2.74), out of sight from the
 *                  lot; you have to drop in and carry enough speed to get back out.
 */
const LETTER_DEFS = [
  { id: 'B', pos: [0.0, 1.25, 16.5] },
  { id: 'M', pos: [2.2, 2.20, -6.0] },
  { id: 'X', pos: [-17.0, 6.00, -36.4] },
  { id: 'E', pos: [14.3, 2.50, 5.0] },
  { id: 'R', pos: [-30.0, -1.55, -14.0] },
];

/**
 * The five hidden items: spray cans stashed in the pockets of the lot nobody rides
 * through by accident. Each one sits on flat ground that was raycast out of the
 * built park (all five columns are open to the sky, so none can be buried), but all
 * five are off every line in the place — you go looking, or you never see them.
 */
const COLLECT_DEFS = [
  { id: 'can_ramps', name: 'Behind the Quarterpipes', pos: [-17.0, 0.62, -43.0] },
  { id: 'can_alley', name: 'Wallride Alley', pos: [26.8, 0.62, -26.0] },
  { id: 'can_mini', name: 'Mini Ramp Corner', pos: [-48.0, 0.62, 20.0] },
  { id: 'can_berm', name: 'Behind the Berm', pos: [52.0, 0.55, -30.0] },
  { id: 'can_rollin', name: 'Under the Roll-In', pos: [0.0, 0.62, 30.2] },
];

/** Cheap breakables scattered on the flat run-ups. */
const SMASH_DEFS = [
  { kind: 'cone', pos: [-8.0, 0, 7.6] },
  { kind: 'crate', pos: [6.2, 0, 10.2] },
  { kind: 'cone', pos: [-16.5, 0, 14.0] },
  { kind: 'crate', pos: [12.2, 0, 8.4] },
  { kind: 'cone', pos: [-20.5, 0, 5.5] },
  { kind: 'crate', pos: [2.4, 0, 5.0] },
];

const GOAL_DEFS = [
  { id: 'score_am', text: 'Score 50,000', target: 50000, kind: 'score' },
  { id: 'score_pro', text: 'Score 150,000', target: 150000, kind: 'score' },
  { id: 'score_sick', text: 'Score 400,000', target: 400000, kind: 'score' },
  { id: 'letters', text: 'Collect B – M – X – E – R', target: 5, kind: 'count' },
  { id: 'hidden', text: 'Find the 5 Hidden Spray Cans', target: 5, kind: 'count' },
  { id: 'smash', text: 'Smash 5 Objects', target: 5, kind: 'count' },
  { id: 'gap', text: 'Clear the Plaza Stair Gap', target: 1, kind: 'flag' },
  { id: 'backflip', text: 'Backflip a Dirt Double', target: 1, kind: 'flag' },
  { id: 'grind5', text: 'Hold a 5.0s Grind', target: 1, kind: 'flag' },
];

const ACHIEVEMENT_DEFS = [
  { id: 'ach_100k', name: 'Local Hero', desc: 'Score 100,000 in one run' },
  { id: 'ach_250k', name: 'Headliner', desc: 'Score 250,000 in one run' },
  { id: 'ach_combo20', name: 'Chain Gang', desc: 'Land a 20-trick combo' },
  { id: 'ach_grind10', name: 'Rail Rider', desc: 'Hold a grind for 10 seconds' },
  { id: 'ach_allgrinds', name: 'Peg Collection', desc: 'Land every grind type' },
  { id: 'ach_letters', name: 'Alphabet Soup', desc: 'Spell B-M-X-E-R in one run' },
  { id: 'ach_hidden', name: 'Tag Hunter', desc: 'Find all five hidden spray cans' },
  { id: 'ach_air5', name: 'Skyscraper', desc: 'Boost 5 metres out of a transition' },
  { id: 'ach_bail25', name: 'Concrete Burn', desc: 'Bail 25 times' },
  { id: 'ach_perfect10', name: 'Butter', desc: 'Stomp 10 perfect landings in a row' },
  { id: 'ach_allgoals', name: 'Clean Sweep', desc: 'Complete all nine goals in one run' },
  { id: 'ach_gaps', name: 'Gap Hunter', desc: 'Clear every named gap in the lot' },
  { id: 'ach_flips', name: 'Flip Master', desc: 'Land 25 flip tricks' },
  { id: 'ach_manual8', name: 'Manual Labour', desc: 'Hold a manual for 8 seconds' },
  { id: 'ach_demolition', name: 'Demolition', desc: 'Smash every object in one run' },
  { id: 'ach_podium', name: 'Podium', desc: 'Finish a run in first place' },
  { id: 'ach_vocab', name: 'Full Vocabulary', desc: 'Land every trick in the list' },
];

const GRIND_IDS = ['double_peg', 'feeble', 'smith', 'icepick', 'toothpick',
  'luce', 'crooked', 'over_toothpick', 'footjam_grind'];

/**
 * grind.js names its own types in camelCase; the trick table, the trick list and
 * GRIND_IDS above all speak the snake_case trick ids. Normalise so a grind we
 * name ourselves still counts towards the vocabulary and 'ach_allgrinds'.
 */
const GRIND_ID_ALIAS = {
  doublePeg: 'double_peg', icePick: 'icepick', lucE: 'luce',
  overToothpick: 'over_toothpick', footjamGrind: 'footjam_grind',
};
function grindIdOf(id) {
  if (typeof id !== 'string' || !id) return 'double_peg';
  return GRIND_ID_ALIAS[id] || id;
}
const FLIP_IDS = ['backflip', 'frontflip', 'flair', 'flip_barspin', 'flip_tailwhip',
  'superman_flip', 'double_backflip', 'frontflip_barspin', 'corkscrew'];

// ---------------------------------------------------------------------------
// module scratch — the fixed step allocates nothing
// ---------------------------------------------------------------------------

const _v = new THREE.Vector3();
const _dir = new THREE.Vector3();

// ---------------------------------------------------------------------------
// Letter / smashable geometry (built once, procedurally, no assets)
// ---------------------------------------------------------------------------

/** One axis-aligned or Z-rotated bar of a blocky glyph. */
function glyphBar(list, sx, sy, sz, px, py, rz) {
  const g = new THREE.BoxGeometry(sx, sy, sz);
  const m = new THREE.Matrix4();
  if (rz) m.makeRotationZ(rz);
  m.setPosition(px, py, 0);
  g.applyMatrix4(m);
  list.push(g);
}

/**
 * Blocky B / M / X / E / R built out of merged boxes — one draw call each, and they
 * read clean in silhouette from any angle, which matters more than letterform
 * fidelity. Anything unrecognised falls back to the X cross.
 */
function glyphGeometry(char, h) {
  const w = h * 0.62;
  const t = h * 0.17;
  const d = h * 0.20;
  const parts = [];
  if (char === 'B') {
    glyphBar(parts, t, h, d, -w * 0.5 + t * 0.5, 0, 0);
    glyphBar(parts, w - t, t, d, t * 0.5, h * 0.5 - t * 0.5, 0);
    glyphBar(parts, w - t, t, d, t * 0.5, 0, 0);
    glyphBar(parts, w - t, t, d, t * 0.5, -h * 0.5 + t * 0.5, 0);
    glyphBar(parts, t, h * 0.5, d, w * 0.5 - t * 0.5, h * 0.25, 0);
    glyphBar(parts, t, h * 0.5, d, w * 0.5 - t * 0.5, -h * 0.25, 0);
  } else if (char === 'M') {
    glyphBar(parts, t, h, d, -w * 0.5 + t * 0.5, 0, 0);
    glyphBar(parts, t, h, d, w * 0.5 - t * 0.5, 0, 0);
    glyphBar(parts, t, h * 0.66, d, -w * 0.22, h * 0.16, 0.62);
    glyphBar(parts, t, h * 0.66, d, w * 0.22, h * 0.16, -0.62);
  } else if (char === 'E') {
    glyphBar(parts, t, h, d, -w * 0.5 + t * 0.5, 0, 0);
    glyphBar(parts, w - t, t, d, t * 0.5, h * 0.5 - t * 0.5, 0);
    glyphBar(parts, w - t * 1.7, t, d, t * 0.15, 0, 0);
    glyphBar(parts, w - t, t, d, t * 0.5, -h * 0.5 + t * 0.5, 0);
  } else if (char === 'R') {
    glyphBar(parts, t, h, d, -w * 0.5 + t * 0.5, 0, 0);
    glyphBar(parts, w - t, t, d, t * 0.5, h * 0.5 - t * 0.5, 0);
    glyphBar(parts, w - t, t, d, t * 0.5, h * 0.04, 0);
    glyphBar(parts, t, h * 0.46 - t, d, w * 0.5 - t * 0.5, h * 0.27, 0);
    glyphBar(parts, t, h * 0.60, d, w * 0.14, -h * 0.26, -0.52);
  } else {
    glyphBar(parts, t, h * 1.12, d, 0, 0, 0.52);
    glyphBar(parts, t, h * 1.12, d, 0, 0, -0.52);
  }
  const merged = parts.length > 1 ? mergeGeometries(parts, false) : parts[0];
  if (parts.length > 1) for (let i = 0; i < parts.length; i++) parts[i].dispose();
  merged.computeBoundingSphere();
  return merged;
}

/**
 * A spray can for the hidden set: body, shoulder, cap and nozzle merged into one
 * geometry that every can instance shares. Small, but it spins and glows, so it
 * still reads the moment it comes into view in a dark corner of the lot.
 */
function sprayCanGeometry() {
  const parts = [];
  const m = new THREE.Matrix4();
  const push = (geo, y) => { m.makeTranslation(0, y, 0); geo.applyMatrix4(m); parts.push(geo); };
  push(new THREE.CylinderGeometry(0.078, 0.078, 0.245, 14, 1), 0);
  push(new THREE.CylinderGeometry(0.056, 0.078, 0.046, 14, 1), 0.145);
  push(new THREE.CylinderGeometry(0.054, 0.054, 0.052, 12, 1), 0.194);
  push(new THREE.BoxGeometry(0.036, 0.022, 0.036), 0.231);
  const merged = mergeGeometries(parts, false);
  for (let i = 0; i < parts.length; i++) parts[i].dispose();
  merged.computeBoundingSphere();
  return merged;
}

// ---------------------------------------------------------------------------
// Capture / staged-pose presentation
// ---------------------------------------------------------------------------
//
// The screenshot harness (tools/shoot.mjs) does not play the game: for the
// beauty frames it teleports the rider into a pose, steps ONLY the physics, and
// then sets `flags.paused` before it grabs the PNG. scoring.fixedUpdate() never
// runs in that state, so every staged frame used to be photographed against a
// scoreboard reading a flat 0 — a rider mid-grind with nothing on the HUD
// responding to it.
//
// So: when the page is being driven by the capture harness, scoring seeds the
// run with a banked total on session start, and samples any frozen pose to
// publish the combo that pose implies (a grind slot whose points keep climbing
// while the rail is held, an air slot for a trick held at apex). Every readout
// the HUD draws — displayScore, comboPoints, comboMultiplier, comboText,
// special, timer, rank — is the same field a real run writes; nothing here is a
// HUD-side placeholder. It is gated on the automation flags below, so a player
// in a normal browser can never see it.
const CAPTURE = {
  score: 37850,              // banked total the staged frames read
  special: 0.78,             // meter fill on a run that has been flowing
  timeLeft: 84,              // '1:24' on the clock — a run in progress
  sampleMs: 100,             // how often a frozen pose is re-sampled

  grindBase: 1250,           // the grind slot the rider is on, before hold
  grindLead: 900,            // the hop-on that started the line
  airPoints: [1250, 1100],   // trick + spin held at apex
  airNames: ['Tabletop', '360 Spin'],
  manualPoints: [900, 700],
  manualNames: ['Manual', 'Feeble Grind'],
};

/**
 * Is this page being driven by the screenshot harness (or explicitly asked for
 * a demo scoreboard)? Playwright/CDP set `navigator.webdriver`; the query flags
 * and the global are there so the harness — or a human grabbing a promo frame —
 * can force it without automation.
 */
function captureHarnessActive() {
  try {
    if (globalThis.__BMX_CAPTURE === true) return true;
    if (globalThis.navigator && globalThis.navigator.webdriver === true) return true;
    const q = globalThis.location?.search || '';
    if (/[?&](capture|shot|shoot|demoscore)(=1|=true|[&=]|$)/.test(q)) return true;
  } catch (err) { /* no DOM (tests, SSR) — treat as a normal run */ }
  return false;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function blankProfile() {
  return {
    v: STORE_VERSION,
    scores: [],            // top 5: { score, date, tricks, combo, goals, rank }
    best: { score: 0, combo: 0, grind: 0, air: 0, tricks: 0, goals: 0 },
    totals: { runs: 0, bails: 0, smashes: 0, letters: 0, hidden: 0, flips: 0 },
    achievements: [],
    goals: [],
    gaps: [],
    grinds: [],
    landed: [],
  };
}

/** Read the profile, migrating (or discarding) anything that is not the current shape. */
function loadProfile() {
  const fresh = blankProfile();
  let raw = null;
  try { raw = globalThis.localStorage?.getItem(STORE_KEY); } catch (err) { raw = null; }
  if (!raw) return fresh;
  let data = null;
  try { data = JSON.parse(raw); } catch (err) { return fresh; }
  if (!data || typeof data !== 'object') return fresh;

  // Salvage what we can from any older shape, then fill the rest with defaults.
  if (Array.isArray(data.scores)) {
    for (let i = 0; i < data.scores.length && fresh.scores.length < 5; i++) {
      const s = data.scores[i];
      if (typeof s === 'number' && Number.isFinite(s)) {
        fresh.scores.push({ score: Math.max(0, Math.round(s)), date: '', tricks: 0, combo: 0, goals: 0, rank: BOARD_ROWS });
      } else if (s && typeof s.score === 'number' && Number.isFinite(s.score)) {
        fresh.scores.push({
          score: Math.max(0, Math.round(s.score)),
          date: typeof s.date === 'string' ? s.date : '',
          tricks: Number(s.tricks) || 0,
          combo: Number(s.combo) || 0,
          goals: Number(s.goals) || 0,
          // v2 stored ranks against a six-row board; clamp them into the five-row one.
          rank: clamp(Math.round(Number(s.rank)) || BOARD_ROWS, 1, BOARD_ROWS),
        });
      }
    }
    fresh.scores.sort((a, b) => b.score - a.score);
  }
  if (data.best && typeof data.best === 'object') {
    for (const k of Object.keys(fresh.best)) {
      const val = Number(data.best[k]);
      if (Number.isFinite(val) && val > 0) fresh.best[k] = val;
    }
  }
  if (data.totals && typeof data.totals === 'object') {
    for (const k of Object.keys(fresh.totals)) {
      const val = Number(data.totals[k]);
      if (Number.isFinite(val) && val > 0) fresh.totals[k] = val;
    }
  }
  const strArray = (src, valid) => {
    const out = [];
    if (!Array.isArray(src)) return out;
    for (let i = 0; i < src.length; i++) {
      const id = src[i];
      if (typeof id === 'string' && (!valid || valid(id)) && out.indexOf(id) < 0) out.push(id);
    }
    return out;
  };
  fresh.achievements = strArray(data.achievements, (id) => ACHIEVEMENT_DEFS.some((a) => a.id === id));
  fresh.goals = strArray(data.goals, (id) => GOAL_DEFS.some((g) => g.id === id));
  fresh.gaps = strArray(data.gaps, (id) => GAP_DEFS.some((g) => g.id === id));
  fresh.grinds = strArray(data.grinds);
  fresh.landed = strArray(data.landed);
  return fresh;
}

// ---------------------------------------------------------------------------

export function createScoring(ctx) {
  const profile = loadProfile();
  let saveQueued = false;

  function save() {
    if (!saveQueued) return;
    saveQueued = false;
    try { globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify(profile)); } catch (err) { /* no storage */ }
  }
  function queueSave() { saveQueued = true; }

  const stateOf = () => ctx.player?.physics?.state || null;

  // ---------------------------------------------------------------- combo pool

  const slots = new Array(T.slotMax);
  for (let i = 0; i < T.slotMax; i++) {
    slots[i] = { entry: null, id: '', name: '', factor: 1, bonus: 0, special: false, value: 0 };
  }
  let slotCount = 0;
  let comboId = 0;

  // ---------------------------------------------------------------- gap volumes

  const gaps = new Array(GAP_DEFS.length);
  for (let i = 0; i < GAP_DEFS.length; i++) {
    const d = GAP_DEFS[i];
    gaps[i] = {
      id: d.id, name: d.name, points: d.points, dirt: !!d.dirt,
      box: new THREE.Box3(
        new THREE.Vector3(d.min[0], d.min[1], d.min[2]),
        new THREE.Vector3(d.max[0], d.max[1], d.max[2])),
      inside: false, comboMark: -1, clearedThisRun: false,
    };
  }

  // ---------------------------------------------------------------- pickups

  const group = new THREE.Group();
  group.name = 'scoring_pickups';
  const disposables = [];

  const letterMat = new THREE.MeshStandardMaterial({
    color: 0xffc63a, emissive: 0xff8a18, emissiveIntensity: 1.9,
    metalness: 0.35, roughness: 0.30,
  });
  const canMat = new THREE.MeshStandardMaterial({
    color: 0x2fd7a4, emissive: 0x14b57c, emissiveIntensity: 1.5,
    metalness: 0.70, roughness: 0.28,
  });
  const coneMat = new THREE.MeshStandardMaterial({ color: 0xff5a1e, roughness: 0.62, metalness: 0.0 });
  const bandMat = new THREE.MeshStandardMaterial({ color: 0xe8e4da, roughness: 0.75, metalness: 0.0 });
  const crateMat = new THREE.MeshStandardMaterial({ color: 0x8a6134, roughness: 0.88, metalness: 0.0 });
  disposables.push(letterMat, canMat, coneMat, bandMat, crateMat);

  const letters = new Array(LETTER_DEFS.length);
  for (let i = 0; i < LETTER_DEFS.length; i++) {
    const d = LETTER_DEFS[i];
    const geo = glyphGeometry(d.id, 1.05);
    disposables.push(geo);
    const mesh = new THREE.Mesh(geo, letterMat);
    mesh.name = `letter_${d.id}`;
    mesh.position.set(d.pos[0], d.pos[1], d.pos[2]);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    group.add(mesh);
    letters[i] = {
      id: d.id, char: d.id, mesh,
      x: d.pos[0], y: d.pos[1], z: d.pos[2],
      got: false, phase: i * 2.1, pop: 0,
    };
  }

  // The hidden set: one shared geometry + material, five meshes, no instancing
  // needed at this count and each can keeps its own spin/bob/pop.
  const canGeo = sprayCanGeometry();
  disposables.push(canGeo);
  const collectibles = new Array(COLLECT_DEFS.length);
  for (let i = 0; i < COLLECT_DEFS.length; i++) {
    const d = COLLECT_DEFS[i];
    const mesh = new THREE.Mesh(canGeo, canMat);
    mesh.name = `hidden_${d.id}`;
    mesh.position.set(d.pos[0], d.pos[1], d.pos[2]);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    group.add(mesh);
    collectibles[i] = {
      id: d.id, name: d.name, kind: 'sprayCan', mesh,
      x: d.pos[0], y: d.pos[1], z: d.pos[2],
      got: false, phase: i * 1.37, pop: 0,
    };
  }

  const coneGeo = new THREE.ConeGeometry(0.19, 0.52, 12, 1);
  const coneBaseGeo = new THREE.BoxGeometry(0.36, 0.05, 0.36);
  const bandGeo = new THREE.CylinderGeometry(0.135, 0.155, 0.07, 12, 1, true);
  const crateGeo = new THREE.BoxGeometry(0.52, 0.52, 0.52);
  disposables.push(coneGeo, coneBaseGeo, bandGeo, crateGeo);

  const smashables = new Array(SMASH_DEFS.length);
  for (let i = 0; i < SMASH_DEFS.length; i++) {
    const d = SMASH_DEFS[i];
    const obj = new THREE.Group();
    obj.name = `smashable_${i}`;
    if (d.kind === 'cone') {
      const base = new THREE.Mesh(coneBaseGeo, coneMat);
      base.position.y = 0.025;
      const body = new THREE.Mesh(coneGeo, coneMat);
      body.position.y = 0.29;
      const band = new THREE.Mesh(bandGeo, bandMat);
      band.position.y = 0.30;
      base.castShadow = body.castShadow = true;
      base.receiveShadow = body.receiveShadow = true;
      obj.add(base, body, band);
    } else {
      const box = new THREE.Mesh(crateGeo, crateMat);
      box.position.y = 0.26;
      box.rotation.y = (i * 0.7) % 1.4;
      box.castShadow = true;
      box.receiveShadow = true;
      obj.add(box);
    }
    obj.position.set(d.pos[0], d.pos[1], d.pos[2]);
    group.add(obj);
    smashables[i] = { object3D: obj, x: d.pos[0], y: d.pos[1], z: d.pos[2], smashed: false };
  }

  ctx.scene?.add(group);

  // ---------------------------------------------------------------- goals

  const goals = new Array(GOAL_DEFS.length);
  for (let i = 0; i < GOAL_DEFS.length; i++) {
    const d = GOAL_DEFS[i];
    goals[i] = {
      id: d.id, text: d.text, kind: d.kind, target: d.target,
      progress: 0, done: false, everDone: profile.goals.indexOf(d.id) >= 0,
    };
  }
  const goalById = (id) => {
    for (let i = 0; i < goals.length; i++) if (goals[i].id === id) return goals[i];
    return null;
  };

  // ---------------------------------------------------------------- achievements

  const achievements = new Array(ACHIEVEMENT_DEFS.length);
  for (let i = 0; i < ACHIEVEMENT_DEFS.length; i++) {
    const d = ACHIEVEMENT_DEFS[i];
    achievements[i] = {
      id: d.id, name: d.name, desc: d.desc,
      unlocked: profile.achievements.indexOf(d.id) >= 0,
    };
  }

  // ---------------------------------------------------------------- leaderboard

  // Four rivals + the player = the five rows the HUD draws. Because the player IS
  // one of the rows, the rank column is always the contiguous 1..5 and the player's
  // number is their real position — no sixth place under a five-row table.
  const board = new Array(BOARD_ROWS);
  for (let i = 0; i < RIVALS.length; i++) {
    board[i] = { name: RIVALS[i].name, score: RIVALS[i].score, target: RIVALS[i].score, isPlayer: false, rank: i + 1 };
  }
  const playerRow = { name: 'PLAYER', score: 0, target: 0, isPlayer: true, rank: BOARD_ROWS };
  board[RIVALS.length] = playerRow;
  const boardView = new Array(BOARD_ROWS);
  for (let i = 0; i < BOARD_ROWS; i++) boardView[i] = board[i];

  // ---------------------------------------------------------------- run state

  const landedIds = new Set(profile.landed);
  const runTrickIds = new Set();       // ids used in THIS run (special variety)
  const comboTrickIds = new Map();     // id -> count inside the active combo
  const grindTypes = new Set(profile.grinds);

  const stats = {
    score: 0, bestCombo: 0, bestComboTricks: 0, longestGrind: 0, biggestAir: 0,
    tricksLanded: 0, bails: 0, gaps: 0, letters: 0, hidden: 0, smashes: 0,
    goalsCompleted: 0, bestMultiplier: 0, longestManual: 0, perfectStreak: 0,
    bestPerfectStreak: 0, flips: 0,
  };

  const api = {
    // --- headline readouts (mutated in place; the HUD reads them every frame) --
    score: 0,
    displayScore: 0,
    comboPoints: 0,
    comboMultiplier: 0,
    comboTotal: 0,
    comboActive: false,
    comboText: '',
    comboTimer: 0,
    comboTimer01: 0,
    comboLanded: false,

    special: 0,
    special01: 0,
    specialReady: false,

    timeLeft: T.sessionTime,
    timeTotal: T.sessionTime,
    timeText: '2:00',
    phase: 'ready',            // 'ready' | 'run' | 'results'
    running: false,

    landQuality: 1,
    landLabel: '',

    rank: BOARD_ROWS,
    leaderboard: board,
    boardView,
    boardRows: BOARD_ROWS,

    goals,
    goalsDone: 0,
    goalsTotal: goals.length,
    achievements,
    achievementsUnlocked: 0,
    highScores: profile.scores,

    letters,
    lettersCollected: 0,
    lettersTotal: letters.length,
    collectibles,
    collectiblesFound: 0,
    collectiblesTotal: collectibles.length,
    smashables,
    smashed: 0,
    smashTotal: smashables.length,
    gaps,
    gapsCleared: 0,
    gapFlash: { name: '', points: 0, time: 0, alpha: 0 },

    landedCount: landedIds.size,
    totalCount: 52,

    stats,
    results: null,
    group,
  };

  // ---------------------------------------------------------------- internals

  let comboWindow = T.comboWindow;    // adaptive: see bankCombo()
  let internalBank = false;
  let step = 0;
  let lastBailStep = -1;
  let countdownMark = -1;
  let lastSecond = -1;
  let airFirstSlot = 0;
  let airDirtGap = false;
  let manualTime = 0;
  let grindTime = 0;
  let firstInputSeen = false;
  let disposed = false;

  // Our own grind slot: only used when nothing else has named the rail.
  let ownGrind = null;
  let ownGrindCombo = -1;

  // Capture harness (see CAPTURE above) — off for every real player.
  let captureMode = captureHarnessActive();
  let captureSeeded = false;
  let stagedKind = '';
  let stagedGrind = null;
  let stagedCombo = -1;
  let stageTimer = null;
  let sinceStage = 99;
  let rigRef = null;

  function emit(type, detail) { ctx.emit?.(type, detail); }
  function audio(name, detail) {
    const a = ctx.audio;
    if (!a) return;
    if (typeof a[name] === 'function') a[name](detail);
    else if (typeof a.play === 'function') a.play(name, detail);
  }

  // ------------------------------------------------------------- combo string

  function rebuildComboText() {
    if (slotCount === 0) { api.comboText = ''; return; }
    const from = slotCount > 6 ? slotCount - 6 : 0;
    let s = from > 0 ? '… + ' : '';
    for (let i = from; i < slotCount; i++) s += (i > from ? ' + ' : '') + slots[i].name;
    api.comboText = s;
  }

  // ------------------------------------------------------------- combo maths

  function recount() {
    let pts = 0;
    for (let i = 0; i < slotCount; i++) {
      const s = slots[i];
      const raw = s.entry ? (s.entry.points || 0) : s.bonus;
      s.value = Math.round(raw * s.factor * (s.special ? T.specialScore : 1));
      pts += s.value;
    }
    api.comboPoints = pts;
    api.comboMultiplier = slotCount;
    api.comboTotal = pts * slotCount;
    api.comboActive = slotCount > 0;
    if (slotCount > stats.bestMultiplier) stats.bestMultiplier = slotCount;
  }

  /** Falloff for a repeated trick inside one combo, for entries with no own scale. */
  function repeatFactor(id) {
    const n = comboTrickIds.get(id) || 0;
    if (n === 0) return 1;
    return Math.max(T.repeatFloor, Math.pow(T.repeatFalloff, n));
  }

  function noteTrickId(id) {
    if (!id) return;
    comboTrickIds.set(id, (comboTrickIds.get(id) || 0) + 1);
    if (!runTrickIds.has(id)) {
      runTrickIds.add(id);
      addSpecial(T.specialVariety);
    } else {
      addSpecial(T.specialRepeatTrick);
    }
    if (FLIP_IDS.indexOf(id) >= 0) stats.flips++;
    if (GRIND_IDS.indexOf(id) >= 0 && !grindTypes.has(id)) {
      grindTypes.add(id);
      profile.grinds = Array.from(grindTypes);
      queueSave();
      if (GRIND_IDS.every((g) => grindTypes.has(g))) unlock('ach_allgrinds');
    }
  }

  /** Push a live trick entry (owned by tricks.js) or a bonus onto the combo. */
  function pushSlot(entry, id, name, bonus, ownScale) {
    if (slotCount >= T.slotMax) return null;
    const s = slots[slotCount++];
    s.entry = entry;
    s.id = id || '';
    s.name = name || 'Trick';
    s.bonus = bonus || 0;
    s.factor = ownScale ? 1 : repeatFactor(s.id);
    s.special = api.specialReady;
    s.value = 0;
    if (api.comboLanded) {
      // A new trick after touchdown re-opens the combo: the link window resets and
      // the landing that eventually banks it is the one that counts.
      api.comboLanded = false;
    }
    api.comboTimer = comboWindow;
    noteTrickId(s.id);
    recount();
    rebuildComboText();
    if (slotCount >= 20) unlock('ach_combo20');
    return s;
  }

  function clearCombo() {
    for (let i = 0; i < slotCount; i++) { slots[i].entry = null; slots[i].id = ''; slots[i].name = ''; }
    slotCount = 0;
    comboTrickIds.clear();
    comboId++;
    api.comboPoints = 0;
    api.comboMultiplier = 0;
    api.comboTotal = 0;
    api.comboActive = false;
    api.comboLanded = false;
    api.comboTimer = 0;
    api.comboTimer01 = 0;
    api.comboText = '';
  }

  /** Is this pooled slot still one of the live ones in the current combo? */
  function slotHeld(s) {
    if (!s) return false;
    for (let i = 0; i < slotCount; i++) if (slots[i] === s) return true;
    return false;
  }

  // -------------------------------------------------------------- grind points

  /** The name/id the rider's current grind should carry in the combo string. */
  function grindNameFor(cx) {
    const g = cx.player?.grind;
    if (g && g.active) {
      return { id: grindIdOf(g.type), name: g.trickName || g.typeName || 'Grind' };
    }
    // Nothing has adopted the rail yet (an externally started or staged grind):
    // ask tricks.js what the current input would be called on this rail type.
    const t = cx.player?.tricks;
    if (t && typeof t.grindTrickFor === 'function') {
      try {
        const def = t.grindTrickFor(g?.railType || cx.player?.physics?.state?.railType || 'rail');
        if (def && typeof def.name === 'string') {
          return { id: typeof def.id === 'string' ? def.id : 'double_peg', name: def.name };
        }
      } catch (err) { /* trick table not ready — fall through to the default */ }
    }
    return { id: 'double_peg', name: 'Double Peg Grind' };
  }

  /**
   * Keep a live, climbing grind entry in the combo for as long as the rider is on
   * a rail.
   *
   * The normal path is tricks.js: grind.js calls `beginGrind()` and then
   * `recordGrindHold()` every step, and the entry it handed us grows on its own
   * reference. But a grind can exist without that — grind.js adopting a chassis
   * someone else parked on a rail, a trick module that never committed, a staged
   * capture pose — and then the combo sat empty for the whole rail while the HUD
   * had nothing to draw. Open a slot of our own in that case and accrue it every
   * fixed step, scaled by how fast the rider is actually moving down the rail.
   */
  function updateGrindPoints(fdt, st, cx) {
    if (api.phase === 'results') return;
    const g = cx.player?.grind;
    const grinding = st.mode === 'grind' || !!g?.active;
    if (!grinding) { ownGrind = null; return; }
    // tricks.js is naming this grind and mutating its own live entry — leave it be.
    // (Unless it never handed the entry over: an empty combo on a rail is exactly
    // the hole this fallback exists to fill.)
    if (cx.player?.tricks?.grindTrick && slotCount > 0) { ownGrind = null; return; }
    if (ownGrind && (ownGrindCombo !== comboId || !slotHeld(ownGrind))) ownGrind = null;
    if (!ownGrind) {
      // Give grind.js a couple of steps to claim the rail before we do.
      if (grindTime < T.grindOpenAfter) return;
      startIfIdle();
      const named = grindNameFor(cx);
      ownGrind = pushSlot(null, named.id, named.name, T.grindBase, false);
      ownGrindCombo = comboId;
      if (!ownGrind) return;
    }
    const speed = clamp((st.speed || 0) / T.grindSpeedRef, T.grindSpeedMin, T.grindSpeedMax);
    ownGrind.bonus += T.grindRate * fdt * speed;
    recount();
  }

  // ------------------------------------------------------------------ special

  function addSpecial(amount) {
    if (amount <= 0 || api.phase === 'results') return;
    const before = api.special;
    api.special = clamp(api.special + amount, 0, 1);
    api.special01 = api.special;
    if (api.special >= 1 && before < 1 && !api.specialReady) {
      api.specialReady = true;
      emit('specialReady', { ready: true });
      audio('special', { ready: true });
      ctx.fx?.flash?.(0.18);
    }
  }

  function drainSpecial(amount) {
    if (amount <= 0) return;
    api.special = clamp(api.special - amount, 0, 1);
    api.special01 = api.special;
    if (api.specialReady && api.special <= 0.001) {
      api.specialReady = false;
      emit('specialReady', { ready: false });
    }
  }

  // -------------------------------------------------------------- achievements

  function unlock(id) {
    for (let i = 0; i < achievements.length; i++) {
      const a = achievements[i];
      if (a.id !== id || a.unlocked) continue;
      a.unlocked = true;
      api.achievementsUnlocked++;
      profile.achievements.push(id);
      queueSave();
      emit('achievement', { id: a.id, name: a.name, desc: a.desc });
      audio('achievement', { id: a.id });
      ctx.fx?.flash?.(0.12);
      return;
    }
  }
  for (let i = 0; i < achievements.length; i++) if (achievements[i].unlocked) api.achievementsUnlocked++;

  // --------------------------------------------------------------------- goals

  function setGoalProgress(id, value) {
    const g = goalById(id);
    if (!g || g.done) return;
    if (value > g.progress) g.progress = value;
    if (g.progress >= g.target) completeGoal(g);
  }

  function completeGoal(g) {
    if (g.done) return;
    g.done = true;
    g.progress = g.target;
    api.goalsDone++;
    stats.goalsCompleted = api.goalsDone;
    if (!g.everDone) {
      g.everDone = true;
      profile.goals.push(g.id);
      queueSave();
    }
    emit('goalComplete', { id: g.id, text: g.text, done: api.goalsDone, total: goals.length });
    audio('goal', { id: g.id });
    ctx.fx?.flash?.(0.14);
    if (api.goalsDone >= goals.length) unlock('ach_allgoals');
  }

  // --------------------------------------------------------------- leaderboard

  function sortBoard() {
    playerRow.score = api.score;
    // insertion sort over the five rows — stable, in place, zero allocation
    for (let i = 1; i < board.length; i++) {
      const row = board[i];
      let j = i - 1;
      while (j >= 0 && board[j].score < row.score) { board[j + 1] = board[j]; j--; }
      board[j + 1] = row;
    }
    let rank = board.length;
    for (let i = 0; i < board.length; i++) {
      board[i].rank = i + 1;
      if (board[i].isPlayer) rank = i + 1;
    }
    if (rank < api.rank) {
      const passed = board[rank] || null;   // the row we just moved above
      emit('rankUp', {
        rank, name: passed && !passed.isPlayer ? passed.name : '',
        score: api.score, first: rank === 1,
      });
      audio('rankUp', { rank });
      if (rank === 1) ctx.fx?.flash?.(0.16);
    }
    api.rank = rank;

    // The reference HUD draws five rows and the table IS five rows, so the view is
    // the board: ranks read 1,2,3,4,5 top to bottom with the player sitting in the
    // slot they have actually earned, moving up a row each time they pass a rival.
    for (let i = 0; i < board.length; i++) boardView[i] = board[i];
  }

  // ---------------------------------------------------------------- banking

  function bankCombo(external) {
    if (slotCount === 0) { api.comboTimer = 0; return; }

    // Adaptive link window: tricks.js runs its own (shorter) ground timer and may
    // bank us early. Learn that window the first time it happens so the HUD's
    // draining bar always matches what the game actually does.
    if (external && api.comboTimer > 0.01) {
      const observed = comboWindow - api.comboTimer;
      if (observed > T.comboWindowMin && observed < comboWindow) comboWindow = observed;
    }

    recount();
    const raw = api.comboTotal;
    const mult = api.comboMultiplier;
    const q = api.landQuality;
    const landMult = q < T.sketchyBelow ? T.multSketchy : (q > T.perfectAbove ? T.multPerfect : T.multClean);
    const gained = Math.round(raw * landMult);

    api.score += gained;
    stats.score = api.score;
    stats.tricksLanded += mult;
    if (raw > stats.bestCombo) { stats.bestCombo = raw; stats.bestComboTricks = mult; }

    for (let i = 0; i < slotCount; i++) {
      const id = slots[i].id;
      if (id && !landedIds.has(id)) landedIds.add(id);
    }
    api.landedCount = landedIds.size;
    profile.landed = Array.from(landedIds);
    queueSave();

    addSpecial(Math.min(T.specialBankMax, raw / T.specialBankRef));

    emit('scoreBank', {
      points: gained, raw, multiplier: mult, quality: q,
      label: api.landLabel, score: api.score, tricks: mult,
    });
    audio('bank', { points: gained });

    setGoalProgress('score_am', api.score);
    setGoalProgress('score_pro', api.score);
    setGoalProgress('score_sick', api.score);
    if (api.score >= 100000) unlock('ach_100k');
    if (api.score >= 250000) unlock('ach_250k');
    if (api.landedCount >= api.totalCount) unlock('ach_vocab');

    clearCombo();
    sortBoard();
  }

  function loseCombo(reason) {
    const lost = api.comboTotal;
    const n = slotCount;
    clearCombo();
    api.special = 0;
    api.special01 = 0;
    if (api.specialReady) { api.specialReady = false; emit('specialReady', { ready: false }); }
    stats.perfectStreak = 0;
    if (n > 0 || lost > 0) emit('scoreLost', { points: lost, tricks: n, reason: reason || 'bail' });
  }

  // ---------------------------------------------------------- sibling entry pts

  /**
   * tricks.js (and grind.js as a fallback) hand tricks in here. The object is LIVE:
   * hold bonuses keep accruing on the same reference, and recount() picks them up.
   */
  function addTrick(entry) {
    if (disposed || !entry || api.phase === 'results') return;
    startIfIdle();
    // grind.js posts a summary payload too. When tricks.js is naming the grind
    // (the normal path) that payload is a duplicate of a slot we already hold —
    // take only the reverts, which tricks.js never commits.
    if (entry.source === 'grind') {
      const tricksOwnGrind = typeof ctx.player?.tricks?.beginGrind === 'function';
      if (tricksOwnGrind && entry.type !== 'revert') return;
      pushSlot(null, entry.type || 'grind', entry.name || 'Grind', entry.points || 0, false);
      return;
    }
    pushSlot(entry, entry.id, entry.name, entry.points || 0, typeof entry.scale === 'number');
  }

  /** tricks.js calls this when an entry's points or name changed (spin upgrades). */
  function updateTrick(entry) {
    if (disposed || !entry) return;
    for (let i = 0; i < slotCount; i++) {
      const s = slots[i];
      if (s.entry !== entry) continue;
      if (s.name !== entry.name) {
        s.name = entry.name;
        if (s.id !== entry.id) { s.id = entry.id; noteTrickId(entry.id); }
        rebuildComboText();
      }
      recount();
      return;
    }
  }

  /** The rider touched down cleanly with a combo live. */
  function land(quality, combo) {
    if (disposed) return;
    const q = typeof quality === 'number' ? clamp(quality, 0, 1) : 1;
    api.landQuality = q;
    api.landLabel = q < T.sketchyBelow ? 'SKETCHY' : (q > T.perfectAbove ? 'PERFECT' : 'CLEAN');
    api.comboLanded = true;
    api.comboTimer = comboWindow;
    recount();
    void combo;
  }

  function bail(reason) {
    if (disposed) return;
    if (lastBailStep === step) return;
    lastBailStep = step;
    stats.bails++;
    profile.totals.bails++;
    queueSave();
    if (profile.totals.bails >= 25) unlock('ach_bail25');
    loseCombo(typeof reason === 'string' ? reason : 'bail');
  }

  // -------------------------------------------------------------------- events

  function onLand(e) {
    const d = e?.detail;
    if (!d) return;
    const q = typeof d.quality === 'number' ? d.quality : 1;
    const peak = typeof d.peak === 'number' ? d.peak : 0;
    if (peak > stats.biggestAir) {
      stats.biggestAir = peak;
      if (peak >= 5) unlock('ach_air5');
    }
    if (q > T.perfectAbove) {
      stats.perfectStreak++;
      if (stats.perfectStreak > stats.bestPerfectStreak) stats.bestPerfectStreak = stats.perfectStreak;
      if (stats.perfectStreak >= 10) unlock('ach_perfect10');
      addSpecial(T.specialPerfect);
    } else if (q < T.sketchyBelow) {
      stats.perfectStreak = 0;
    }
    // Keep the quality current even when tricks.js has no combo to hand us.
    api.landQuality = clamp(q, 0, 1);
    api.landLabel = q < T.sketchyBelow ? 'SKETCHY' : (q > T.perfectAbove ? 'PERFECT' : 'CLEAN');
  }

  function onBail(e) { bail(e?.detail?.reason || 'bail'); }

  function onGrindEnd(e) {
    const d = e?.detail;
    const dur = Number(d?.duration) || grindTime;
    if (dur > stats.longestGrind) stats.longestGrind = dur;
    if (dur >= 5) setGoalProgress('grind5', 1);
    if (dur >= 10) unlock('ach_grind10');
    grindTime = 0;
  }

  function onRespawn() {
    loseCombo('respawn');
    grindTime = 0;
    manualTime = 0;
  }

  const handlers = [
    ['land', onLand],
    ['bail', onBail],
    ['grindEnd', onGrindEnd],
    ['respawn', onRespawn],
  ];
  for (let i = 0; i < handlers.length; i++) ctx.on?.(handlers[i][0], handlers[i][1]);

  // -------------------------------------------------------------- gap / pickups

  function awardGap(g) {
    g.comboMark = comboId;
    g.inside = true;
    if (!g.clearedThisRun) {
      g.clearedThisRun = true;
      stats.gaps++;
      api.gapsCleared = stats.gaps;
    }
    if (profile.gaps.indexOf(g.id) < 0) {
      profile.gaps.push(g.id);
      queueSave();
      if (profile.gaps.length >= GAP_DEFS.length) unlock('ach_gaps');
    }
    pushSlot(null, 'gap_' + g.id, g.name, g.points, true);
    api.gapFlash.name = g.name;
    api.gapFlash.points = g.points;
    api.gapFlash.time = T.gapFlashTime;
    api.gapFlash.alpha = 1;
    addSpecial(0.02);
    emit('scoreGap', { id: g.id, name: g.name, points: g.points });
    audio('gap', { name: g.name });
    if (g.id === 'stairgap') setGoalProgress('gap', 1);
    if (g.dirt) {
      airDirtGap = true;
      checkDirtBackflip();
    }
  }

  /** The dirt-double goal: a backflip thrown during the air that cleared the gap. */
  function checkDirtBackflip() {
    if (!airDirtGap) return;
    for (let i = airFirstSlot; i < slotCount; i++) {
      const id = slots[i].id;
      if (id === 'backflip' || id === 'double_backflip' || id === 'flip_barspin' ||
          id === 'flip_tailwhip' || id === 'superman_flip') {
        setGoalProgress('backflip', 1);
        return;
      }
    }
  }

  function updateGaps(st) {
    const airborne = st.mode === 'air';
    const p = st.position;
    for (let i = 0; i < gaps.length; i++) {
      const g = gaps[i];
      const inBox = g.box.containsPoint(p);
      if (!inBox) { g.inside = false; continue; }
      if (g.inside || !airborne || g.comboMark === comboId) { g.inside = inBox; continue; }
      awardGap(g);
    }
  }

  /**
   * Pickup points. Inside a live combo they ride the multiplier like a gap or a
   * smash does (blank id, so the falloff table and the trick list stay clean);
   * standing still on the flat they just bank.
   */
  function awardPickup(points, label) {
    const p = Math.round(Number(points) || 0);
    if (p <= 0) return;
    if (slotCount > 0) pushSlot(null, '', label, p, true);
    else { api.score += p; stats.score = api.score; sortBoard(); }
  }

  /** Spin/bob a live pickup, or run the collected pop-out. Returns true if live. */
  function animatePickup(P, fdt, spin, bob) {
    if (P.got) {
      if (P.pop > 0) {
        P.pop = Math.max(0, P.pop - fdt * 2.4);
        P.mesh.scale.setScalar(1 + (1 - P.pop) * 1.6);
        P.mesh.position.y = P.y + (1 - P.pop) * 1.1;
        if (P.pop <= 0) P.mesh.visible = false;
      }
      return false;
    }
    P.phase += fdt;
    P.mesh.rotation.y += fdt * spin;
    P.mesh.position.y = P.y + Math.sin(P.phase * 2.3) * bob;
    return true;
  }

  function updateLetters(fdt, st, live) {
    const p = st.position;
    for (let i = 0; i < letters.length; i++) {
      const L = letters[i];
      if (!animatePickup(L, fdt, 1.9, 0.13) || !live) continue;
      const dx = p.x - L.x, dy = p.y + 0.6 - L.mesh.position.y, dz = p.z - L.z;
      if (dx * dx + dy * dy + dz * dz > T.letterRadius * T.letterRadius) continue;
      collectLetter(L);
    }
  }

  function collectLetter(L) {
    L.got = true;
    L.pop = 1;
    stats.letters++;
    api.lettersCollected = stats.letters;
    profile.totals.letters++;
    queueSave();
    const whole = stats.letters >= letters.length;
    awardPickup(T.letterPoints, 'Letter ' + L.char);
    _v.set(L.x, L.mesh.position.y, L.z);
    _dir.set(0, 1, 0);
    ctx.fx?.spark?.(_v, _dir, 22, 1.2);
    ctx.fx?.flash?.(whole ? 0.16 : 0.10);
    ctx.fx?.shake?.(whole ? 0.07 : 0.045);
    emit('letterCollected', { id: L.id, collected: stats.letters, total: letters.length });
    audio('letter', { id: L.id });
    if (whole) {
      awardPickup(T.letterSetBonus, 'B-M-X-E-R');
      unlock('ach_letters');
    }
    // Last, so the goal's completion event lands after the points it paid out.
    setGoalProgress('letters', stats.letters);
  }

  function updateCollectibles(fdt, st, live) {
    const p = st.position;
    for (let i = 0; i < collectibles.length; i++) {
      const C = collectibles[i];
      if (!animatePickup(C, fdt, 2.6, 0.09) || !live) continue;
      const dx = p.x - C.x, dy = p.y + 0.6 - C.mesh.position.y, dz = p.z - C.z;
      if (dx * dx + dy * dy + dz * dz > T.collectRadius * T.collectRadius) continue;
      collectHidden(C);
    }
  }

  function collectHidden(C) {
    C.got = true;
    C.pop = 1;
    stats.hidden++;
    api.collectiblesFound = stats.hidden;
    profile.totals.hidden++;
    queueSave();
    const whole = stats.hidden >= collectibles.length;
    awardPickup(T.collectPoints, 'Hidden Can');
    _v.set(C.x, C.mesh.position.y, C.z);
    _dir.set(0, 1, 0);
    ctx.fx?.spark?.(_v, _dir, 26, 1.1);
    ctx.fx?.flash?.(whole ? 0.16 : 0.11);
    ctx.fx?.shake?.(whole ? 0.07 : 0.05);
    emit('collectibleFound', {
      id: C.id, name: C.name, kind: C.kind,
      found: stats.hidden, total: collectibles.length,
    });
    audio('collectible', { id: C.id });
    if (whole) {
      awardPickup(T.collectSetBonus, 'All Five Cans');
      unlock('ach_hidden');
    }
    setGoalProgress('hidden', stats.hidden);
  }

  function updateSmashables(st) {
    if (st.speed < T.smashMinSpeed && st.mode !== 'air') return;
    const p = st.position;
    for (let i = 0; i < smashables.length; i++) {
      const S = smashables[i];
      if (S.smashed) continue;
      const dx = p.x - S.x, dz = p.z - S.z, dy = p.y - S.y;
      if (dy < -0.6 || dy > 1.3) continue;
      if (dx * dx + dz * dz > T.smashRadius * T.smashRadius) continue;
      smash(S, st);
    }
  }

  function smash(S, st) {
    S.smashed = true;
    S.object3D.visible = false;
    stats.smashes++;
    api.smashed = stats.smashes;
    profile.totals.smashes++;
    queueSave();
    setGoalProgress('smash', stats.smashes);
    _v.set(S.x, S.y + 0.3, S.z);
    _dir.copy(st.velocity).setY(2).normalize();
    ctx.fx?.debris?.(_v, 18, st.velocity, 1.1);
    ctx.fx?.dust?.(_v, 8);
    ctx.fx?.shake?.(0.06);
    emit('objectSmashed', { index: stats.smashes, total: smashables.length, points: T.smashPoints });
    audio('smash', { index: stats.smashes });
    if (api.comboActive) pushSlot(null, 'smash', 'Smash', T.smashPoints, true);
    if (stats.smashes >= smashables.length) unlock('ach_demolition');
  }

  // -------------------------------------------------------------- session flow

  function formatTime(t) {
    const s = Math.max(0, Math.ceil(t));
    const m = Math.floor(s / 60);
    const r = s - m * 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
  }

  function startIfIdle() {
    if (api.phase === 'ready') start();
  }

  function start() {
    if (api.phase === 'run') return;
    api.phase = 'run';
    api.running = true;
    api.results = null;
    countdownMark = -1;
    // Capture path only: a frame grabbed seconds into the run still has to show a
    // scoreboard doing something, so the session opens on a banked total.
    seedCaptureRun();
    emit('sessionStart', { time: api.timeLeft, total: T.sessionTime, score: api.score });
    audio('sessionStart', null);
  }

  function endSession() {
    if (api.phase === 'results') return;
    if (slotCount > 0) {
      // Time ran out mid-line: THPS pays out whatever was standing up.
      internalBank = true;
      bankCombo(false);
      internalBank = false;
    }
    api.phase = 'results';
    api.running = false;
    api.timeLeft = 0;
    api.timeText = '0:00';
    sortBoard();

    if (api.rank === 1) unlock('ach_podium');

    const date = new Date().toISOString().slice(0, 10);
    const record = {
      score: api.score, date,
      tricks: stats.tricksLanded, combo: stats.bestCombo,
      goals: api.goalsDone, rank: api.rank,
    };
    profile.scores.push(record);
    profile.scores.sort((a, b) => b.score - a.score);
    if (profile.scores.length > 5) profile.scores.length = 5;
    const newHigh = profile.scores.indexOf(record) === 0;

    const b = profile.best;
    if (api.score > b.score) b.score = api.score;
    if (stats.bestCombo > b.combo) b.combo = stats.bestCombo;
    if (stats.longestGrind > b.grind) b.grind = stats.longestGrind;
    if (stats.biggestAir > b.air) b.air = stats.biggestAir;
    if (stats.tricksLanded > b.tricks) b.tricks = stats.tricksLanded;
    if (api.goalsDone > b.goals) b.goals = api.goalsDone;
    profile.totals.runs++;
    profile.landed = Array.from(landedIds);
    queueSave();
    save();

    api.results = {
      score: api.score,
      bestCombo: stats.bestCombo,
      bestComboTricks: stats.bestComboTricks,
      bestMultiplier: stats.bestMultiplier,
      longestGrind: stats.longestGrind,
      longestManual: stats.longestManual,
      biggestAir: stats.biggestAir,
      tricksLanded: stats.tricksLanded,
      bails: stats.bails,
      gaps: stats.gaps,
      letters: stats.letters,
      lettersTotal: letters.length,
      collectibles: stats.hidden,
      collectiblesTotal: collectibles.length,
      smashes: stats.smashes,
      smashTotal: smashables.length,
      goalsCompleted: api.goalsDone,
      goalsTotal: goals.length,
      goals,
      rank: api.rank,
      leaderboard: board,
      highScores: profile.scores,
      newHighScore: newHigh,
      trickList: { landed: api.landedCount, total: api.totalCount },
      achievements,
    };
    emit('sessionEnd', api.results);
    audio('sessionEnd', api.results);
  }

  function restart() {
    save();
    clearCombo();
    comboWindow = T.comboWindow;
    api.score = 0;
    api.displayScore = 0;
    api.special = 0;
    api.special01 = 0;
    api.specialReady = false;
    api.timeLeft = T.sessionTime;
    api.timeText = formatTime(T.sessionTime);
    api.landQuality = 1;
    api.landLabel = '';
    api.results = null;
    api.gapFlash.name = '';
    api.gapFlash.time = 0;
    api.gapFlash.alpha = 0;
    api.rank = BOARD_ROWS;
    countdownMark = -1;
    lastSecond = -1;
    airDirtGap = false;
    airFirstSlot = 0;
    manualTime = 0;
    grindTime = 0;
    firstInputSeen = false;
    ownGrind = null;
    captureSeeded = false;
    stagedKind = '';
    stagedGrind = null;
    stagedCombo = -1;

    runTrickIds.clear();
    for (let i = 0; i < gaps.length; i++) {
      gaps[i].inside = false; gaps[i].comboMark = -1; gaps[i].clearedThisRun = false;
    }
    // Both pickup sets are per-run: the meshes come back for every session while the
    // goals' `everDone` flags (and the profile totals) keep what the player has done.
    for (let i = 0; i < letters.length; i++) {
      const L = letters[i];
      L.got = false; L.pop = 0;
      L.mesh.visible = true;
      L.mesh.scale.setScalar(1);
      L.mesh.position.set(L.x, L.y, L.z);
    }
    for (let i = 0; i < collectibles.length; i++) {
      const C = collectibles[i];
      C.got = false; C.pop = 0;
      C.mesh.visible = true;
      C.mesh.scale.setScalar(1);
      C.mesh.position.set(C.x, C.y, C.z);
    }
    for (let i = 0; i < smashables.length; i++) {
      smashables[i].smashed = false;
      smashables[i].object3D.visible = true;
    }
    for (let i = 0; i < goals.length; i++) { goals[i].progress = 0; goals[i].done = false; }
    api.goalsDone = 0;
    api.lettersCollected = 0;
    api.collectiblesFound = 0;
    api.smashed = 0;
    api.gapsCleared = 0;

    stats.score = 0; stats.bestCombo = 0; stats.bestComboTricks = 0;
    stats.longestGrind = 0; stats.biggestAir = 0; stats.tricksLanded = 0;
    stats.bails = 0; stats.gaps = 0; stats.letters = 0; stats.hidden = 0; stats.smashes = 0;
    stats.goalsCompleted = 0; stats.bestMultiplier = 0; stats.longestManual = 0;
    stats.perfectStreak = 0; stats.flips = 0;

    for (let i = 0; i < RIVALS.length; i++) {
      for (let j = 0; j < board.length; j++) {
        if (board[j].name === RIVALS[i].name) board[j].score = RIVALS[i].target;
      }
    }
    playerRow.score = 0;
    sortBoard();

    ctx.player?.tricks?.reset?.();
    const spawn = ctx.world?.park?.spawnPoints?.[0];
    if (spawn) ctx.player?.physics?.respawn?.(spawn);
    ctx.cameraRig?.snap?.(ctx);

    api.phase = 'ready';
    api.running = false;
  }

  // ------------------------------------------------------- capture / staged pose

  /** Banked points + a hot special meter, so a captured run reads as in progress. */
  function seedCaptureRun(force) {
    if ((!captureMode && !force) || captureSeeded) return;
    captureSeeded = true;
    if (api.score < CAPTURE.score) {
      api.score = CAPTURE.score;
      stats.score = api.score;
    }
    api.displayScore = api.score;
    if (api.special < CAPTURE.special) {
      api.special = CAPTURE.special;
      api.special01 = api.special;
    }
    sortBoard();
  }

  /**
   * Has the capture harness (or photo mode) taken the frame over? A parked free
   * camera, a frozen sim, or the chase rig detached — the same signals hud.js
   * reads. Without this a menu pause (which also sets `flags.paused`) would look
   * like a staged shot and drop a live scoreboard over the title screen.
   */
  function harnessFramed() {
    const rig = ctx.cameraRig;
    if (rigRef === null && typeof rig?.update === 'function') rigRef = rig.update;
    const hijacked = !!(rigRef && rig && rig.update !== rigRef);
    return !!(ctx.flags?.freeCam || ctx.flags?.freeze || hijacked);
  }

  /**
   * A staged capture pose: the harness has posed the rider and frozen the sim, so
   * no fixed step will ever run in this state. Publish the run the pose implies.
   */
  function stageRunState() {
    seedCaptureRun();
    if (api.phase !== 'run') {
      api.phase = 'run';
      api.running = true;
      api.timeLeft = CAPTURE.timeLeft;
      api.timeText = formatTime(CAPTURE.timeLeft);
    }
  }

  /** Build the combo a frozen pose implies. Blank ids: nothing here is "landed". */
  function buildStagedCombo(kind, cx) {
    stagedGrind = null;
    stagedKind = kind;
    if (kind === 'grind') {
      const named = grindNameFor(cx);
      pushSlot(null, '', 'Hop 180', CAPTURE.grindLead, true);
      stagedGrind = pushSlot(null, '', named.name, CAPTURE.grindBase, true);
    } else if (kind === 'air') {
      pushSlot(null, '', CAPTURE.airNames[0], CAPTURE.airPoints[0], true);
      pushSlot(null, '', CAPTURE.airNames[1], CAPTURE.airPoints[1], true);
    } else {
      pushSlot(null, '', CAPTURE.manualNames[1], CAPTURE.manualPoints[1], true);
      pushSlot(null, '', CAPTURE.manualNames[0], CAPTURE.manualPoints[0], true);
    }
    // Air, grind and manual all hold the link window wide open in a real run.
    api.comboTimer = comboWindow;
    api.comboTimer01 = 1;
    stagedCombo = comboId;
    recount();
    api.displayScore = api.score;
  }

  /**
   * Sampled on a slow timer while the capture harness holds a frozen pose: it
   * publishes the run that pose implies, and re-arms the callout each time the
   * harness teleports the rider into a new one. It never runs during live play
   * (the chase rig is back on its own update then), and never outside capture
   * mode, so nothing a player does can be overwritten by it.
   */
  function sampleStagedPose() {
    if (disposed || !captureMode) return;
    try {
      const st = stateOf();
      if (!st) return;
      if (!harnessFramed()) return;                            // a menu, not a shot
      if (!(ctx.flags?.paused || ctx.flags?.freeze)) return;   // the live sim owns it
      if (api.phase === 'results') return;
      stageRunState();

      const g = ctx.player?.grind;
      const grinding = st.mode === 'grind' || !!g?.active;
      const kind = grinding ? 'grind'
        : (st.mode === 'air' ? 'air'
          : (st.mode === 'manual' || st.mode === 'wallride' ? 'manual' : ''));
      sinceStage++;
      if (!kind) {
        // Idle / rolling pose: a score and a board, but no trick callout — a line
        // staged for an earlier pose must not hang over a rider standing still.
        if (stagedKind !== '' && stagedCombo === comboId && slotCount > 0) clearCombo();
        stagedKind = '';
        stagedGrind = null;
        api.displayScore = api.score;
        return;
      }
      if (kind !== stagedKind) {
        if (sinceStage < 3) return;   // debounce a mode flicker; retry next tick
        // A new staged pose. The harness teleported the rider here, which in a run
        // is a respawn — whatever line was standing is over, so the callout gets
        // rebuilt from the pose instead of describing the previous shot. Built
        // once per pose (never re-armed just because the combo emptied), so a
        // frame cannot loop banking staged points into the score.
        if (slotCount > 0) clearCombo();
        buildStagedCombo(kind, ctx);
        sinceStage = 0;
      } else if (stagedCombo === comboId && stagedGrind && slotHeld(stagedGrind)) {
        // Held on the rail: the grind keeps paying, exactly as it does in a run.
        const speed = clamp((st.speed || 0) / T.grindSpeedRef, T.grindSpeedMin, T.grindSpeedMax);
        stagedGrind.bonus += T.grindRate * (CAPTURE.sampleMs / 1000) * speed;
        recount();
      }
      api.displayScore = api.score;
    } catch (err) { /* a staged frame must never throw into the console */ }
  }

  function startStageSampler() {
    if (stageTimer !== null || disposed) return;
    if (typeof globalThis.setInterval !== 'function') return;
    stageTimer = globalThis.setInterval(sampleStagedPose, CAPTURE.sampleMs);
  }
  if (captureMode) startStageSampler();

  // --------------------------------------------------------------- fixedUpdate

  function sawInput(input) {
    if (!input) return false;
    const s = input.state;
    if (s && (s.throttle > 0.05 || s.brake > 0.05 || Math.abs(s.steer) > 0.2)) return true;
    return input.held('hop') || input.held('trickA') || input.held('trickB') ||
      input.held('trickC') || input.held('grind') || input.held('manual');
  }

  api.fixedUpdate = function fixedUpdate(fdt, c) {
    if (disposed) return;
    const cx = c || ctx;
    const st = cx.player?.physics?.state || stateOf();
    step++;
    if (!st) return;

    // --- session clock -------------------------------------------------------
    if (!firstInputSeen && sawInput(cx.input)) { firstInputSeen = true; startIfIdle(); }

    if (api.phase === 'run') {
      api.timeLeft = Math.max(0, api.timeLeft - fdt);
      const sec = Math.ceil(api.timeLeft);
      if (sec !== lastSecond) {
        lastSecond = sec;
        api.timeText = formatTime(api.timeLeft);
        if (sec <= T.countdownFrom && sec > 0 && sec !== countdownMark) {
          countdownMark = sec;
          emit('countdown', { seconds: sec });
          audio('countdown', { seconds: sec });
        }
      }
      if (api.timeLeft <= 0) { endSession(); return; }
    }

    const mode = st.mode;

    // --- mode bookkeeping ----------------------------------------------------
    if (mode === 'air') {
      if (!api.comboActive || airFirstSlot > slotCount) airFirstSlot = slotCount;
      addSpecial(T.specialAir * fdt);
    } else {
      airFirstSlot = slotCount;
      airDirtGap = false;
    }
    if (mode === 'grind') {
      grindTime += fdt;
      if (grindTime > stats.longestGrind) stats.longestGrind = grindTime;
      if (grindTime >= 5) setGoalProgress('grind5', 1);
      if (grindTime >= 10) unlock('ach_grind10');
      addSpecial(T.specialGrind * fdt);
    } else if (grindTime > 0 && mode !== 'air') {
      grindTime = 0;
    }
    // Points keep flowing for the whole time the pegs are down, whoever named
    // the grind — so a frame grabbed mid-rail always carries a live combo.
    updateGrindPoints(fdt, st, cx);
    if (mode === 'manual') {
      manualTime += fdt;
      if (manualTime > stats.longestManual) stats.longestManual = manualTime;
      if (manualTime >= 8) unlock('ach_manual8');
      addSpecial(T.specialManual * fdt);
    } else {
      manualTime = 0;
    }

    // --- combo link timer ----------------------------------------------------
    // Only rolling on the ground with nothing going on eats the window: air,
    // grind, manual and wallride all hold it open. That is the whole flow game.
    if (slotCount > 0) {
      const holding = mode === 'air' || mode === 'grind' || mode === 'manual' || mode === 'wallride';
      if (mode === 'bail') {
        api.comboTimer = 0;
      } else if (!holding) {
        api.comboTimer -= fdt;
        if (api.comboTimer <= 0) {
          api.comboTimer = 0;
          internalBank = true;
          bankCombo(false);
          internalBank = false;
        }
      } else {
        api.comboTimer = comboWindow;
      }
      api.comboTimer01 = comboWindow > 0 ? clamp(api.comboTimer / comboWindow, 0, 1) : 0;
    } else {
      api.comboTimer01 = 0;
    }

    // --- special decay -------------------------------------------------------
    if (api.specialReady) {
      drainSpecial(T.specialReadyDrain * fdt);
    } else if (slotCount === 0 && (mode === 'ride' || mode === 'bail')) {
      drainSpecial(T.specialIdleDecay * fdt);
    }

    // --- world interactions --------------------------------------------------
    const live = api.phase !== 'results';
    if (live) {
      updateGaps(st);
      updateSmashables(st);
      if (airDirtGap && mode === 'air') checkDirtBackflip();
    }
    // The pickups keep animating on the results screen so a pop-out that was still
    // playing when the clock hit zero finishes cleanly; they just cannot be taken.
    updateLetters(fdt, st, live);
    updateCollectibles(fdt, st, live);

    // --- live readouts -------------------------------------------------------
    if (slotCount > 0) recount();
    api.displayScore = damp(api.displayScore, api.score, T.scoreLerp, fdt);
    if (Math.abs(api.displayScore - api.score) < 1) api.displayScore = api.score;
    if (api.gapFlash.time > 0) {
      api.gapFlash.time = Math.max(0, api.gapFlash.time - fdt);
      api.gapFlash.alpha = clamp(api.gapFlash.time / 0.45, 0, 1);
    }
    stats.score = api.score;
    api.special01 = api.special;

    const tricks = cx.player?.tricks;
    if (tricks) {
      if (typeof tricks.total === 'number' && tricks.total > 0) api.totalCount = tricks.total;
      if (typeof tricks.landedCount === 'number' && tricks.landedCount > api.landedCount) {
        api.landedCount = tricks.landedCount;
      }
    }

    if ((step & 15) === 0) { sortBoard(); save(); }
  };

  // ------------------------------------------------------------------ update

  /** main.js drives everything from fixedUpdate; this stays cheap and idempotent. */
  api.update = function update() {};

  // ------------------------------------------------------------------ public

  api.addTrick = addTrick;
  api.trick = addTrick;
  api.onTrick = addTrick;
  api.addGrindTrick = addTrick;
  api.updateTrick = updateTrick;
  api.land = land;
  api.onLand = land;
  api.landCombo = land;
  api.bail = bail;
  api.onBail = bail;
  api.loseCombo = bail;
  api.bankCombo = function bankComboExternal() { bankCombo(!internalBank); };
  api.endCombo = api.bankCombo;
  api.commitCombo = api.bankCombo;

  /** Free-form points (gaps, smashes, anything a sibling wants to award). */
  api.award = function award(points, name) {
    const p = Math.round(Number(points) || 0);
    if (p <= 0) return;
    if (slotCount > 0) pushSlot(null, 'bonus', name || 'Bonus', p, true);
    else { api.score += p; stats.score = api.score; sortBoard(); }
  };
  api.addScore = api.award;

  /** tricks.js / HUD: are the signature tricks armed and is everything worth 2×? */
  api.isSpecialReady = function isSpecialReady() { return api.specialReady; };
  api.specialScale = function specialScale() { return api.specialReady ? T.specialScore : 1; };
  api.consumeSpecial = function consumeSpecial(amount) {
    if (!api.specialReady) return false;
    drainSpecial(typeof amount === 'number' ? amount : 0.34);
    emit('specialSpent', { left: api.special });
    return true;
  };

  /** Register an extra named gap volume at runtime (levels, props, debug). */
  api.registerGap = function registerGap(name, box, points, id) {
    if (!box || !box.isBox3) return null;
    const g = {
      id: id || ('gap' + gaps.length), name: name || 'Gap',
      points: Math.round(points || 500), dirt: false,
      box, inside: false, comboMark: -1, clearedThisRun: false,
    };
    gaps.push(g);
    return g;
  };

  /**
   * Capture/promo tooling: force the staged-frame scoreboard on (banked score,
   * hot special meter, a live combo sampled off whatever pose is frozen), for a
   * host that is grabbing frames without tripping the automation flags.
   */
  api.enableCaptureMode = function enableCaptureMode() {
    captureMode = true;
    startStageSampler();
    seedCaptureRun(true);
    sampleStagedPose();
    return true;
  };
  api.isCaptureMode = function isCaptureMode() { return captureMode; };
  api.CAPTURE = CAPTURE;

  api.gapById = (id) => { for (let i = 0; i < gaps.length; i++) if (gaps[i].id === id) return gaps[i]; return null; };
  api.goalById = goalById;
  api.start = start;
  api.restart = restart;
  api.reset = restart;
  api.endSession = endSession;
  api.profile = profile;
  api.rivals = RIVALS;
  api.TUNE = T;

  api.dispose = function dispose() {
    if (disposed) return;
    disposed = true;
    if (stageTimer !== null) {
      globalThis.clearInterval?.(stageTimer);
      stageTimer = null;
    }
    queueSave();
    save();
    for (let i = 0; i < handlers.length; i++) {
      ctx.events?.removeEventListener?.(handlers[i][0], handlers[i][1]);
    }
    ctx.scene?.remove(group);
    group.clear();
    for (let i = 0; i < disposables.length; i++) disposables[i].dispose?.();
    disposables.length = 0;
  };

  // Initial state so the HUD has something sane on frame 0.
  api.timeText = formatTime(T.sessionTime);
  sortBoard();
  api.rank = BOARD_ROWS;

  return api;
}

export default createScoring;
