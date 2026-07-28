// MIRRA CITY — procedural rider + bike animation.
//
// There are no animation clips anywhere in this game. Every frame the rider is
// posed from scratch out of four ingredients:
//
//   1. A POSE TABLE. A pose is a sparse list of channel values: euler offsets on the
//      five spine bones, a root offset, one direction pair per limb (upper/lower bone
//      pointing directions), and the bike's attitude relative to the rider (position,
//      euler, rotation pivot, bar/steer angle). Bind pose == the riding pose, so an
//      all-zero pose is already a correct BMX stance and every pose is a delta.
//
//   2. A PER-CHANNEL CRITICALLY-DAMPED SPRING. Poses never snap: each channel chases
//      its target with its own stiffness, so the bike attitude leads and the limbs
//      trail, which is what makes a tabletop read as a throw rather than a cut.
//
//   3. IK. Limbs are authored as *directions*, but by default an arm targets its grip
//      and a leg targets its pedal, solved two-bone in the limb parent's frame. That
//      single rule does most of the work: rotate the bike away from the rider for a
//      tabletop and the arms extend and the feet follow the pedals for free; turn the
//      bars 170° and the arms cross into an X-up on their own; drive the crank from the
//      rear wheel and the ankles walk the real pedal circle.
//
//   4. DIRECT ACTIONS. Barspins, tailwhips and decades are fast, exact rotations, so
//      they are written after the spring, not through it, with their own hand-release
//      and leg-lift windows. A tailwhip rotates the whole bike about the head-tube axis
//      and counter-rotates the steerer, so the frame whips while the bars stay in the
//      rider's hands — exactly the real mechanic.
//
// On top of all four, continuous drivers run regardless of pose: wheel spin from real
// ground speed, crank locked to the rear wheel through the gear ratio, chain walk, tyre
// squash and fork rake on landing compression, bar steer, head look-ahead, jersey
// secondary motion and idle breathing.
//
// Bails hand the rig to a small verlet ragdoll (13 particles, distance + shape
// constraints, gravity in rider space) which is converted back to bone rotations with
// the same swing-only math the IK uses — so a joint can never invert or explode.
//
// Zero allocation after construction. Every vector/quaternion/euler used per frame is
// a preallocated scratch. Cost is ~0.08 ms at 1600x900 on the reference machine.

import * as THREE from 'three';
import { clamp, lerp, damp, smoothstep, rng, TAU } from '../core/mathx.js';

// ---------------------------------------------------------------------------
// tuning
// ---------------------------------------------------------------------------

export const ANIM_TUNE = {
  // --- pose blending -------------------------------------------------------
  wSpine: 15.0,          // rad/s spring frequency of the torso chain
  wRoot: 13.0,           // ...of the pelvis offset — heaviest thing on the bike
  wLimbDir: 16.0,        // ...of the limb pointing directions
  wLimbIK: 20.0,         // ...of the "hand is on the bar" weight — releases fast
  wBike: 17.0,           // ...of the bike attitude — the bike leads, the rider trails
  wSteer: 22.0,          // ...of the bar angle
  substep: 1 / 90,       // s max integration step for the springs

  // --- continuous drivers --------------------------------------------------
  wheelRadius: 0.26,     // m rolling radius — must match TUNING.wheelRadius
  crankRatio: 2.6,       // wheel revs per crank rev — must match TUNING.crankRatio
  steerVisual: 0.46,     // rad of bar angle at full steering input
  steerAirVisual: 0.30,  // ...in the air, where the bars are just being aimed
  steerLambda: 13.0,     // 1/s bar smoothing
  tyreSquash: 0.075,     // fraction of tyre radius lost at full landing compression
  forkRake: 0.075,       // rad the fork rakes back at full compression
  barFlex: 0.055,        // rad the bars flex down at full compression
  frameSquat: 0.030,     // m the bike drops into the compression
  headLook: 0.42,        // rad of head yaw at full steer — the rider looks into the turn
  headSpinLead: 0.36,    // rad of extra head yaw leading a spin
  breathRate: 0.62,      // Hz idle breathing
  jerseyGain: 0.030,     // max jersey billow scale
  lagGain: 0.55,         // how much of the chassis rotation the torso lags behind
  lagW: 11.0,            // rad/s frequency of that secondary motion

  // --- bail ----------------------------------------------------------------
  bailTime: 1.6,         // s of full ragdoll authority
  bailBlendIn: 0.09,     // s to hand the rig over
  bailBlendOut: 0.34,    // s to take it back on respawn
  bailGravity: 15.0,     // m/s² felt by the ragdoll
  bailDamp: 0.985,       // verlet velocity retention per step
  bailShape: 0.28,       // 1/s pull back toward the bind shape — only enough to stop noodling
  bailTether: 0.55,      // m the pelvis may be thrown from the chassis before it is reined in
  bailIters: 3,          // distance-constraint relaxation iterations
  bailFloor: 0.055,      // m the particles are kept above the ground plane
};

const T = ANIM_TUNE;

// ---------------------------------------------------------------------------
// channel layout — one flat Float32Array is the whole animation state
// ---------------------------------------------------------------------------

const SPINE = ['hips', 'spine', 'chest', 'neck', 'head'];
const LIMBS = ['armL', 'armR', 'legL', 'legR'];

const CH_SPINE = 0;                 // 5 bones x 3 euler
const CH_ROOT = 15;                 // pelvis offset xyz
const CH_LIMB = 18;                 // 4 limbs x 10: ik, upper xyz, lower xyz, tip euler xyz
const LIMB_STRIDE = 10;
const CH_BIKE_POS = 58;
const CH_BIKE_ROT = 61;
const CH_BIKE_PIV = 64;
const CH_STEER = 67;
const NCH = 68;

const limbBase = (i) => CH_LIMB + i * LIMB_STRIDE;

/** Default rotation pivot for the bike: between the bars and the rider's hips. */
const PIVOT_DEFAULT = [0, 0.82, 0.18];
const PIVOT_REAR = [0, 0.30, -0.50];
const PIVOT_FRONT = [0, 0.30, 0.50];
const PIVOT_BARS = [0, 0.94, 0.28];

// ---------------------------------------------------------------------------
// the pose table
//
// Every id here is either a base state or a `pose:` value from tricks.js. Euler
// triples are radians relative to the riding bind pose; limb entries are
//   { ik, u:[x,y,z], l:[x,y,z], t:[rx,ry,rz] }
// where u/l are the pointing directions of the upper/lower bone in the limb
// parent's frame (chest for arms, pelvis for legs) and ik is how much the limb
// instead solves to its grip/pedal. Bike entries are
//   { pos:[x,y,z], rot:[rx,ry,rz], piv:[x,y,z] }
// with rot applied about piv, in bike space, relative to the rider.
// ---------------------------------------------------------------------------

const POSES = {
  // ----------------------------------------------------------------- riding
  ride: {},
  pedal: { hips: [0.03, 0, 0], chest: [0.02, 0, 0], neck: [-0.04, 0, 0] },
  roll: { hips: [0.02, 0, 0] },

  crouch: {
    root: [0, -0.115, 0.020],
    hips: [0.20, 0, 0], spine: [0.06, 0, 0], chest: [0.11, 0, 0],
    neck: [-0.27, 0, 0], head: [-0.07, 0, 0],
  },
  hop: {
    root: [0, 0.055, -0.020],
    hips: [-0.13, 0, 0], spine: [-0.03, 0, 0], chest: [-0.07, 0, 0], neck: [0.06, 0, 0],
    bike: { pos: [0, 0.070, 0], rot: [-0.07, 0, 0], piv: PIVOT_DEFAULT },
  },
  bunnyhop: {
    root: [0, 0.060, -0.025],
    hips: [-0.15, 0, 0], chest: [-0.08, 0, 0], neck: [0.07, 0, 0],
    bike: { pos: [0, 0.085, 0.01], rot: [-0.10, 0, 0], piv: PIVOT_DEFAULT },
  },
  air: {
    root: [0, -0.020, 0.010],
    hips: [0.11, 0, 0], chest: [0.06, 0, 0], neck: [-0.11, 0, 0],
    bike: { pos: [0, 0.050, 0], rot: [-0.03, 0, 0], piv: PIVOT_DEFAULT },
  },
  land: {
    root: [0, -0.075, 0.015],
    hips: [0.16, 0, 0], chest: [0.09, 0, 0], neck: [-0.20, 0, 0],
  },

  // -------------------------------------------------------------- air grabs
  // The bike rolls flat under the rider and the arms follow it through IK. The roll
  // is pivoted at the BARS and the rider drops a shoulder into the low side, which is
  // what keeps the low hand inside arm's reach — the difference between a tabletop and
  // a rider whose hand has visibly let go of the grip.
  tabletop: {
    root: [0.020, -0.050, 0],
    hips: [0.04, 0, 0.20], spine: [0, 0, 0.08], chest: [0.02, 0, 0.12],
    neck: [-0.06, 0.10, -0.06], head: [0, 0.18, -0.10],
    bike: { pos: [0, 0.010, 0], rot: [0, 0, 1.00], piv: PIVOT_BARS },
  },
  turndown: {
    root: [0.030, -0.030, -0.020],
    hips: [0.06, -0.32, -0.12], spine: [0, -0.10, 0], chest: [0.02, -0.26, -0.06],
    neck: [-0.05, 0.22, 0], head: [0, 0.42, 0.06],
    steer: -1.78,
    bike: { pos: [0, 0.010, 0], rot: [0.10, 0.12, 0.46], piv: PIVOT_BARS },
  },
  toboggan: {
    root: [0.035, -0.040, -0.060],
    hips: [0.10, -0.46, -0.06], spine: [0, -0.12, 0], chest: [0.04, -0.34, 0],
    neck: [-0.05, 0.30, 0], head: [0, 0.46, 0],
    steer: -1.55,
    armR: { ik: 0, u: [0.56, -0.16, -0.72], l: [0.12, -0.56, -0.82], t: [0, 0.45, 0] },
    bike: { pos: [0, 0.010, 0], rot: [0.04, 0.16, 0.30], piv: PIVOT_BARS },
  },
  superman: {
    root: [0, -0.055, -0.300],
    hips: [0.56, 0, 0], spine: [0.10, 0, 0], chest: [0.11, 0, 0],
    neck: [-0.76, 0, 0], head: [-0.26, 0, 0],
    legL: { ik: 0, u: [-0.14, -0.42, -0.89], l: [-0.09, -0.46, -0.88], t: [-0.30, 0, 0] },
    legR: { ik: 0, u: [0.14, -0.42, -0.89], l: [0.09, -0.46, -0.88], t: [-0.30, 0, 0] },
    bike: { pos: [0, -0.020, 0.010], rot: [0.03, 0, 0], piv: PIVOT_DEFAULT },
  },
  superman_seatgrab: {
    root: [0.020, -0.050, -0.270],
    hips: [0.52, -0.10, 0], spine: [0.10, 0, 0], chest: [0.11, -0.12, 0],
    neck: [-0.72, 0.10, 0], head: [-0.24, 0.16, 0],
    armR: { ik: 0, u: [0.40, -0.52, -0.76], l: [-0.06, -0.48, -0.87], t: [0, 0.2, 0] },
    legL: { ik: 0, u: [-0.14, -0.42, -0.89], l: [-0.09, -0.46, -0.88], t: [-0.30, 0, 0] },
    legR: { ik: 0, u: [0.14, -0.42, -0.89], l: [0.09, -0.46, -0.88], t: [-0.30, 0, 0] },
  },
  nohander: {
    root: [0, 0.020, -0.030],
    hips: [-0.06, 0, 0], chest: [-0.15, 0, 0], neck: [-0.06, 0, 0], head: [-0.04, 0, 0],
    armL: { ik: 0, u: [-0.93, 0.06, -0.36], l: [-0.86, 0.30, -0.41], t: [0, 0, -0.45] },
    armR: { ik: 0, u: [0.93, 0.06, -0.36], l: [0.86, 0.30, -0.41], t: [0, 0, 0.45] },
    bike: { pos: [0, 0.030, 0], rot: [-0.04, 0, 0], piv: PIVOT_DEFAULT },
  },
  onehander: {
    root: [0.020, 0.010, -0.020],
    hips: [-0.04, -0.06, 0], chest: [-0.11, -0.12, 0], head: [0, 0.20, 0],
    armR: { ik: 0, u: [0.87, 0.20, -0.45], l: [0.72, 0.48, -0.50], t: [0, 0, 0.50] },
  },
  nothing: {
    root: [0, 0.030, -0.040],
    hips: [-0.02, 0, 0], chest: [-0.16, 0, 0], neck: [-0.05, 0, 0],
    armL: { ik: 0, u: [-0.92, 0.14, -0.36], l: [-0.82, 0.40, -0.41], t: [0, 0, -0.5] },
    armR: { ik: 0, u: [0.92, 0.14, -0.36], l: [0.82, 0.40, -0.41], t: [0, 0, 0.5] },
    legL: { ik: 0, u: [-0.50, -0.46, 0.73], l: [-0.30, -0.90, 0.31], t: [0.25, 0, 0] },
    legR: { ik: 0, u: [0.50, -0.46, 0.73], l: [0.30, -0.90, 0.31], t: [0.25, 0, 0] },
    bike: { pos: [0, -0.055, 0.010], rot: [0.02, 0, 0], piv: PIVOT_DEFAULT },
  },
  cancan: {
    root: [-0.030, 0.005, 0],
    hips: [0.02, -0.14, 0.04], chest: [0, 0.12, 0], head: [0, 0.16, 0],
    legL: { ik: 0, u: [0.78, -0.30, 0.55], l: [0.93, -0.34, 0.14], t: [0, -0.45, 0] },
  },
  tuck_nohander: {
    root: [0, 0.010, -0.010],
    hips: [0.22, 0, 0], spine: [0.04, 0, 0], chest: [-0.10, 0, 0], neck: [-0.16, 0, 0],
    armL: { ik: 0, u: [-0.90, 0.20, -0.39], l: [-0.80, 0.42, -0.43], t: [0, 0, -0.45] },
    armR: { ik: 0, u: [0.90, 0.20, -0.39], l: [0.80, 0.42, -0.43], t: [0, 0, 0.45] },
    bike: { pos: [0, 0.115, 0.020], rot: [-0.12, 0, 0], piv: PIVOT_DEFAULT },
  },
  xup: {
    root: [0, -0.020, 0.020],
    hips: [0.06, 0, 0], chest: [0.04, 0, 0], neck: [-0.08, 0, 0], head: [-0.05, 0, 0],
    steer: 2.55,
  },
  crossup: {
    root: [0, -0.015, 0.015],
    hips: [0.05, 0.08, 0], chest: [0.03, 0.10, 0], head: [0, -0.18, 0],
    steer: 1.72,
    bike: { pos: [0, 0.010, 0], rot: [0, -0.20, 0.06], piv: PIVOT_BARS },
  },
  invert: {
    root: [0, -0.045, 0.050],
    hips: [-0.44, 0, 0.08], spine: [-0.10, 0, 0], chest: [-0.26, 0, 0.06],
    neck: [0.46, 0, 0], head: [0.18, 0, 0],
    bike: { pos: [0, 0.030, 0], rot: [-1.34, 0, 0.24], piv: PIVOT_BARS },
  },

  // ---------------------------------------------------------- rotation sets
  barspin: {
    hips: [0.09, 0, 0], chest: [0.05, 0, 0], neck: [-0.09, 0, 0],
    action: { kind: 'bars', turns: 1, dur: 0.40 },
  },
  double_barspin: {
    hips: [0.09, 0, 0], chest: [0.05, 0, 0], neck: [-0.09, 0, 0],
    action: { kind: 'bars', turns: 2, dur: 0.68 },
  },
  tailwhip: {
    root: [0, 0.020, 0],
    hips: [0.12, 0, 0], chest: [0.04, 0, 0], neck: [-0.12, 0, 0],
    action: { kind: 'whip', turns: 1, dur: 0.50 },
  },
  double_tailwhip: {
    root: [0, 0.020, 0],
    hips: [0.12, 0, 0], chest: [0.04, 0, 0], neck: [-0.12, 0, 0],
    action: { kind: 'whip', turns: 2, dur: 0.84 },
  },
  flat_tailwhip: {
    root: [0, 0.020, 0],
    hips: [0.14, 0, 0], chest: [0.05, 0, 0], neck: [-0.13, 0, 0],
    action: { kind: 'whip', turns: 1, dur: 0.58 },
  },
  decade: {
    hips: [0.10, 0, 0], chest: [0.04, 0, 0],
    action: { kind: 'decade', turns: 1, dur: 0.72 },
  },

  // ------------------------------------------------------------------ flips
  backflip: {
    root: [0, -0.020, -0.020],
    hips: [0.22, 0, 0], spine: [0.06, 0, 0], chest: [0.10, 0, 0],
    neck: [-0.30, 0, 0], head: [-0.16, 0, 0],
    bike: { pos: [0, 0.055, 0.020], rot: [-0.06, 0, 0], piv: PIVOT_DEFAULT },
  },
  double_backflip: {
    root: [0, -0.045, 0.030],
    hips: [0.40, 0, 0], spine: [0.10, 0, 0], chest: [0.18, 0, 0],
    neck: [-0.42, 0, 0], head: [-0.20, 0, 0],
    bike: { pos: [0, 0.090, 0], rot: [-0.08, 0, 0], piv: PIVOT_DEFAULT },
  },
  frontflip: {
    root: [0, -0.035, 0.030],
    hips: [0.36, 0, 0], spine: [0.10, 0, 0], chest: [0.22, 0, 0],
    neck: [-0.10, 0, 0], head: [0.24, 0, 0],
    bike: { pos: [0, 0.080, 0.010], rot: [0.05, 0, 0], piv: PIVOT_DEFAULT },
  },
  flair: {
    root: [0, -0.020, -0.020],
    hips: [0.22, -0.18, 0], spine: [0.06, -0.06, 0], chest: [0.10, -0.14, 0],
    neck: [-0.34, 0.18, 0], head: [-0.14, 0.32, 0],
    bike: { pos: [0, 0.070, 0], rot: [-0.06, 0.10, 0], piv: PIVOT_DEFAULT },
  },
  corkscrew: {
    root: [0.030, -0.030, 0.020],
    hips: [0.26, -0.10, 0.26], spine: [0.06, 0, 0.10], chest: [0.12, -0.10, 0.16],
    neck: [-0.30, 0.14, -0.10], head: [-0.12, 0.28, -0.14],
    bike: { pos: [0, 0.060, 0], rot: [-0.05, 0, 0.22], piv: PIVOT_DEFAULT },
  },
  flip_barspin: {
    root: [0, -0.020, -0.020],
    hips: [0.22, 0, 0], spine: [0.06, 0, 0], chest: [0.10, 0, 0],
    neck: [-0.30, 0, 0], head: [-0.16, 0, 0],
    bike: { pos: [0, 0.055, 0.020], rot: [-0.06, 0, 0], piv: PIVOT_DEFAULT },
    action: { kind: 'bars', turns: 1, dur: 0.52 },
  },
  frontflip_barspin: {
    root: [0, -0.035, 0.030],
    hips: [0.36, 0, 0], spine: [0.10, 0, 0], chest: [0.22, 0, 0],
    neck: [-0.10, 0, 0], head: [0.24, 0, 0],
    bike: { pos: [0, 0.080, 0.010], rot: [0.05, 0, 0], piv: PIVOT_DEFAULT },
    action: { kind: 'bars', turns: 1, dur: 0.52 },
  },
  flip_tailwhip: {
    root: [0, -0.010, -0.020],
    hips: [0.22, 0, 0], spine: [0.06, 0, 0], chest: [0.10, 0, 0],
    neck: [-0.30, 0, 0], head: [-0.16, 0, 0],
    bike: { pos: [0, 0.060, 0], rot: [-0.06, 0, 0], piv: PIVOT_DEFAULT },
    action: { kind: 'whip', turns: 1, dur: 0.60 },
  },
  superman_flip: {
    root: [0, -0.050, -0.270],
    hips: [0.52, 0, 0], spine: [0.10, 0, 0], chest: [0.11, 0, 0],
    neck: [-0.72, 0, 0], head: [-0.24, 0, 0],
    legL: { ik: 0, u: [-0.14, -0.42, -0.89], l: [-0.09, -0.46, -0.88], t: [-0.30, 0, 0] },
    legR: { ik: 0, u: [0.14, -0.42, -0.89], l: [0.09, -0.46, -0.88], t: [-0.30, 0, 0] },
  },
  spin: {
    root: [0, -0.020, 0],
    hips: [0.08, -0.20, 0], spine: [0, -0.06, 0], chest: [0.04, -0.16, 0],
    neck: [-0.10, 0.22, 0], head: [0, 0.42, 0],
    bike: { pos: [0, 0.030, 0], rot: [-0.02, 0.06, 0], piv: PIVOT_DEFAULT },
  },

  // ---------------------------------------------------------------- manuals
  manual: {
    root: [0, -0.030, -0.145],
    hips: [-0.12, 0, 0], spine: [-0.04, 0, 0], chest: [-0.17, 0, 0],
    neck: [0.12, 0, 0], head: [0.06, 0, 0],
  },
  nose_manual: {
    root: [0, -0.035, 0.125],
    hips: [0.24, 0, 0], spine: [0.06, 0, 0], chest: [0.19, 0, 0],
    neck: [-0.31, 0, 0], head: [-0.11, 0, 0],
  },

  // ----------------------------------------------------------------- grinds
  // grind.js already puts the per-type chassis attitude (yaw/pitch/roll) into
  // state.quaternion, and the rider group rides that. So these poses only carry the
  // RIDER's answer to it — the stance — plus a small residual bike tweak relative to
  // the body. The chassis attitude itself is countered procedurally below, which is
  // why an ice pick reads as the rider standing up over a nose-high bike rather than
  // the whole player leaning back 23 degrees.
  grind: {
    root: [0, -0.050, 0],
    hips: [0.13, 0, 0], chest: [0.07, 0, 0], neck: [-0.14, 0, 0], head: [0, 0.18, 0],
  },
  grind_doublepeg: {
    root: [0, -0.058, 0],
    hips: [0.15, 0, 0], chest: [0.08, 0, 0], neck: [-0.16, 0, 0], head: [0, 0.20, 0],
  },
  grind_feeble: {
    root: [0.030, -0.050, -0.020],
    hips: [0.12, 0, 0.10], chest: [0.06, 0, 0.06], neck: [-0.14, 0.08, -0.05], head: [0, 0.22, -0.07],
    bike: { pos: [-0.015, 0, 0], rot: [0.04, 0, -0.10], piv: PIVOT_REAR },
  },
  grind_smith: {
    root: [0.030, -0.050, 0.020],
    hips: [0.14, 0, 0.10], chest: [0.08, 0, 0.06], neck: [-0.15, 0.08, -0.05], head: [0, 0.22, -0.07],
    bike: { pos: [-0.015, 0, 0], rot: [-0.05, 0, -0.10], piv: PIVOT_FRONT },
  },
  grind_icepick: {
    root: [0, -0.040, -0.085],
    hips: [-0.05, 0, 0], chest: [-0.03, 0, 0], neck: [0.06, 0, 0], head: [0, 0.20, 0],
    bike: { pos: [0, 0.010, 0], rot: [-0.14, 0, 0], piv: PIVOT_REAR },
  },
  grind_toothpick: {
    root: [0, -0.035, 0.080],
    hips: [0.10, 0, 0], chest: [0.06, 0, 0], neck: [-0.12, 0, 0], head: [0, 0.20, 0],
    bike: { pos: [0, 0.010, 0], rot: [0.13, 0, 0], piv: PIVOT_FRONT },
  },
  grind_overtoothpick: {
    root: [0, -0.035, 0.080],
    hips: [0.11, 0, 0], chest: [0.07, 0, 0], neck: [-0.13, 0, 0], head: [0, 0.20, 0],
    steer: 2.86,
    bike: { pos: [0, 0.010, 0], rot: [0.13, 0, 0], piv: PIVOT_FRONT },
  },
  grind_luce: {
    root: [0.050, -0.045, 0],
    hips: [0.10, 0, -0.14], chest: [0.06, 0, -0.09], neck: [-0.12, 0.10, 0.05], head: [0, 0.22, 0.07],
    bike: { pos: [-0.025, 0.010, 0], rot: [0.03, 0, 0.18], piv: [0, 0.34, -0.18] },
  },
  grind_crooked: {
    root: [0.020, -0.050, 0],
    hips: [0.12, 0.16, -0.05], chest: [0.06, 0.11, -0.03], neck: [-0.13, 0.06, 0], head: [0, 0.28, 0],
    bike: { pos: [0, 0, 0], rot: [0.04, 0.14, -0.06], piv: [0, 0.30, 0] },
  },
  grind_footjam: {
    root: [0, -0.045, 0.020],
    hips: [0.16, 0, 0], chest: [0.09, 0, 0], neck: [-0.17, 0, 0], head: [0, 0.18, 0],
    legR: { ik: 0, u: [0.28, -0.10, 0.95], l: [0.04, -0.76, 0.65], t: [0.32, 0, 0] },
    bike: { pos: [0, 0, 0], rot: [0.10, 0, 0], piv: PIVOT_FRONT },
  },

  // -------------------------------------------------------------- lip tricks
  lip_nosepick: {
    root: [0, -0.030, 0.100],
    hips: [0.20, 0, 0], spine: [0.05, 0, 0], chest: [0.12, 0, 0], neck: [-0.24, 0, 0],
    bike: { pos: [0, 0.020, 0], rot: [0.54, 0, 0.10], piv: PIVOT_FRONT },
  },
  lip_abubaca: {
    root: [0, 0.020, -0.140],
    hips: [-0.30, 0, 0], spine: [-0.06, 0, 0], chest: [-0.16, 0, 0],
    neck: [0.36, 0, 0], head: [0.10, 0, 0],
    bike: { pos: [0, 0.030, 0], rot: [-0.86, 0, 0], piv: PIVOT_REAR },
  },
  lip_tyretap: {
    root: [0, 0, -0.090],
    hips: [-0.18, 0, 0], chest: [-0.10, 0, 0], neck: [0.22, 0, 0],
    bike: { pos: [0, 0.020, 0], rot: [-0.56, 0, 0.05], piv: PIVOT_REAR },
  },
  lip_disaster: {
    root: [0.020, -0.030, -0.040],
    hips: [-0.10, 0, -0.14], chest: [-0.06, 0, -0.08], neck: [0.14, 0.08, 0.06], head: [0, 0.20, 0.08],
    bike: { pos: [0, 0.010, 0], rot: [-0.26, 0, 0.30], piv: [0, 0.30, 0] },
  },
  lip_footjamwhip: {
    root: [0, -0.030, 0.070],
    hips: [0.18, 0, 0], chest: [0.10, 0, 0], neck: [-0.20, 0, 0],
    legR: { ik: 0, u: [0.28, -0.10, 0.95], l: [0.04, -0.76, 0.65], t: [0.32, 0, 0] },
    bike: { pos: [0, 0.010, 0], rot: [0.26, 0, 0], piv: PIVOT_FRONT },
    action: { kind: 'whip', turns: 1, dur: 0.62 },
  },

  // -------------------------------------------------------------- flatland
  flat_hangfive: {
    root: [0, -0.030, 0.150],
    hips: [0.26, 0, 0], spine: [0.06, 0, 0], chest: [0.16, 0, 0], neck: [-0.30, 0, 0],
    legR: { ik: 0, u: [0.24, -0.28, 0.93], l: [-0.06, -0.86, 0.50], t: [0.22, 0, 0] },
  },
  flat_surfer: {
    root: [0, 0.105, -0.025],
    hips: [-0.06, 0, 0], chest: [-0.10, 0, 0], neck: [0.10, 0, 0],
    armL: { ik: 0, u: [-0.78, 0.24, -0.58], l: [-0.56, 0.44, -0.70], t: [0, 0, -0.4] },
    armR: { ik: 0, u: [0.78, 0.24, -0.58], l: [0.56, 0.44, -0.70], t: [0, 0, 0.4] },
    legL: { ik: 0, u: [-0.30, -0.62, 0.72], l: [0.10, -0.97, -0.20], t: [0.1, 0, 0] },
    legR: { ik: 0, u: [0.30, -0.62, 0.72], l: [-0.10, -0.97, -0.20], t: [0.1, 0, 0] },
  },

  // ------------------------------------------------------------------- bail
  bail: {},
};

// ---------------------------------------------------------------------------
// module scratch — nothing below allocates once construction is done
// ---------------------------------------------------------------------------

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3();
const _dirU = new THREE.Vector3();
const _dirL = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _e0 = new THREE.Euler();
const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);

/**
 * Two-bone IK. Solves for the mid joint between `root` and `target` with bone
 * lengths a/b, pushed toward `pole`. Writes the two unit pointing directions into
 * `outU` / `outL`. Never produces a NaN: the reach is clamped inside the legal
 * annulus and the pole is replaced when it is parallel to the chord.
 */
function solveIK(root, target, a, b, pole, outU, outL) {
  _v0.subVectors(target, root);
  let L = _v0.length();
  const minL = Math.abs(a - b) + 1e-3;
  const maxL = a + b - 1e-3;
  if (L < 1e-5) { _v0.copy(pole).multiplyScalar(-1); L = _v0.length() || 1; }
  _v1.copy(_v0).divideScalar(L);                       // chord direction
  L = clamp(L, minL, maxL);
  const px = (a * a + L * L - b * b) / (2 * L);
  const h = Math.sqrt(Math.max(0, a * a - px * px));
  _v2.copy(pole).addScaledVector(_v1, -pole.dot(_v1));
  if (_v2.lengthSq() < 1e-8) {
    _v2.set(_v1.y, -_v1.x, 0);
    if (_v2.lengthSq() < 1e-8) _v2.set(0, _v1.z, -_v1.y);
  }
  _v2.normalize();
  // mid = root + chord*px + perp*h  →  the two directions fall straight out
  _v3.copy(_v1).multiplyScalar(px).addScaledVector(_v2, h);   // root → mid
  outU.copy(_v3).normalize();
  _v4.copy(_v0).sub(_v3);                                     // mid → target (unclamped end)
  if (_v4.lengthSq() < 1e-8) outL.copy(outU);
  else outL.copy(_v4).normalize();
}

// ---------------------------------------------------------------------------

export function createRiderAnim(rider, ctx) {
  const rig = rider?.rig;
  const bike = rider?.bike;
  const group = rider?.group;
  if (!rig || !group) {
    // Nothing to drive — stay alive so a missing sibling cannot break the boot.
    return {
      poses: POSES, poseIds: Object.keys(POSES),
      update() {}, fixedUpdate() {}, setPose() {}, playBail() {}, dispose() {},
    };
  }

  // ---------------------------------------------------------------- rig facts
  const spineBones = SPINE.map((n) => rig[n]).filter(Boolean);
  const bind = rig.bindPose || {};
  const bindRoot = new THREE.Vector3().copy(rig.hips.position);

  /** Bone bind offsets (constant: we only ever write rotations to these). */
  const off = new Map();
  for (const b of rig.bones || []) off.set(b, b.position.clone());
  const offOf = (b) => off.get(b) || b.position;

  const P = (name) => (bind[name] ? bind[name] : new THREE.Vector3());

  const LIMB_DEF = LIMBS.map((key, i) => {
    const arm = key[0] === 'a';
    const side = key.endsWith('L') ? 'L' : 'R';
    const rootB = arm ? rig['shoulder' + side] : rig['hip' + side];
    const midB = arm ? rig['elbow' + side] : rig['knee' + side];
    const tipB = arm ? rig['wrist' + side] : rig['ankle' + side];
    const pRoot = P(arm ? 'shoulder' + side : 'hip' + side);
    const pMid = P(arm ? 'elbow' + side : 'knee' + side);
    const pTip = P(arm ? 'wrist' + side : 'ankle' + side);
    const bindU = new THREE.Vector3().subVectors(pMid, pRoot);
    const bindL = new THREE.Vector3().subVectors(pTip, pMid);
    const lenA = bindU.length() || 0.3;
    const lenB = bindL.length() || 0.3;
    bindU.normalize(); bindL.normalize();
    // The bind pole is whatever sideways offset the bind pose already gives the
    // mid joint, so IK reproduces the hand-authored elbow/knee placement exactly.
    const chord = new THREE.Vector3().subVectors(pTip, pRoot);
    const cl = chord.length() || 1;
    chord.divideScalar(cl);
    const pole = new THREE.Vector3().subVectors(pMid, pRoot);
    pole.addScaledVector(chord, -pole.dot(chord));
    if (pole.lengthSq() < 1e-8) pole.set(arm ? (side === 'R' ? 1 : -1) : 0, arm ? -0.4 : 0.2, arm ? -0.4 : 1);
    pole.normalize();
    // Where the mid joint goes once the limb FOLDS. The bind pole points the elbow
    // out sideways, which is right at riding reach but turns into a chicken-wing the
    // moment the rider tucks and the shoulder ends up on top of the grip. Humans drop
    // the elbow to the ribs instead, so short chords blend to this second pole.
    const sgn = side === 'R' ? 1 : -1;
    const poleTight = arm
      ? new THREE.Vector3(sgn * 0.42, -0.86, -0.30).normalize()
      : new THREE.Vector3(sgn * 0.18, 0.32, 0.93).normalize();
    return { key, i, arm, side, rootB, midB, tipB, bindU, bindL, lenA, lenB, pole, poleTight };
  });

  // ------------------------------------------------------- bike anchor facts
  const bikeGroup = bike?.group || null;
  const steerObj = bike?.steer || null;
  const steerTilt = steerObj ? steerObj.rotation.x : 0;
  const steerPos = new THREE.Vector3();
  const whipAxis = new THREE.Vector3(0, 1, 0);
  if (steerObj) {
    steerPos.copy(steerObj.position);
    // The steerer's local +Y is the head-tube axis: the axis a tailwhip turns about.
    _q0.setFromAxisAngle(AXIS_X, steerTilt);
    whipAxis.set(0, 1, 0).applyQuaternion(_q0).normalize();
  }
  const qSteerTilt = new THREE.Quaternion().setFromAxisAngle(AXIS_X, steerTilt);
  const qSteerTiltInv = qSteerTilt.clone().invert();

  /** Grip anchors expressed in the steerer's local frame, so a turned bar moves them. */
  const gripSteerL = new THREE.Vector3();
  const gripSteerR = new THREE.Vector3();
  if (bike?.points) {
    gripSteerL.copy(bike.points.gripL).sub(steerPos).applyQuaternion(qSteerTiltInv);
    gripSteerR.copy(bike.points.gripR).sub(steerPos).applyQuaternion(qSteerTiltInv);
  }
  const bbPos = bike?.points?.bb ? bike.points.bb.clone() : new THREE.Vector3(0, 0.295, -0.125);
  const pedalRel = [new THREE.Vector3(), new THREE.Vector3()];   // [L, R] relative to the BB
  const ankleOff = [new THREE.Vector3(), new THREE.Vector3()];
  if (bike?.points) {
    pedalRel[0].copy(bike.points.pedalL).sub(bbPos);
    pedalRel[1].copy(bike.points.pedalR).sub(bbPos);
  } else {
    pedalRel[0].set(-0.112, 0, -0.175);
    pedalRel[1].set(0.112, 0, 0.175);
  }
  ankleOff[0].set(0.008, 0.074, -0.030);
  ankleOff[1].set(-0.008, 0.074, -0.030);

  const tyres = bike?.tyres || [];
  const forkBaseTilt = steerTilt;

  // --------------------------------------------------------- channel storage
  const defaults = new Float32Array(NCH);
  for (let i = 0; i < 4; i++) {
    const b = limbBase(i);
    const d = LIMB_DEF[i];
    defaults[b] = 1;
    defaults[b + 1] = d.bindU.x; defaults[b + 2] = d.bindU.y; defaults[b + 3] = d.bindU.z;
    defaults[b + 4] = d.bindL.x; defaults[b + 5] = d.bindL.y; defaults[b + 6] = d.bindL.z;
  }
  defaults[CH_BIKE_PIV] = PIVOT_DEFAULT[0];
  defaults[CH_BIKE_PIV + 1] = PIVOT_DEFAULT[1];
  defaults[CH_BIKE_PIV + 2] = PIVOT_DEFAULT[2];

  const cur = new Float32Array(defaults);
  const vel = new Float32Array(NCH);
  const tgt = new Float32Array(NCH);

  /** Per-channel spring frequency. Stiff channels lead, soft ones trail. */
  const omega = new Float32Array(NCH);
  for (let i = 0; i < NCH; i++) omega[i] = T.wSpine;
  for (let i = CH_ROOT; i < CH_ROOT + 3; i++) omega[i] = T.wRoot;
  for (let i = 0; i < 4; i++) {
    const b = limbBase(i);
    omega[b] = T.wLimbIK;
    for (let k = 1; k <= 9; k++) omega[b + k] = T.wLimbDir;
  }
  for (let i = CH_BIKE_POS; i < CH_STEER; i++) omega[i] = T.wBike;
  omega[CH_STEER] = T.wSteer;

  // ------------------------------------------------------------ pose compile
  function compile(def) {
    const idx = [], val = [];
    const put = (i, v) => { idx.push(i); val.push(v); };
    const triple = (base, a) => { for (let k = 0; k < 3; k++) put(base + k, a[k] || 0); };
    for (let i = 0; i < SPINE.length; i++) if (def[SPINE[i]]) triple(CH_SPINE + i * 3, def[SPINE[i]]);
    if (def.root) triple(CH_ROOT, def.root);
    for (let i = 0; i < LIMBS.length; i++) {
      const L = def[LIMBS[i]];
      if (!L) continue;
      const b = limbBase(i);
      if (L.ik !== undefined) put(b, L.ik);
      if (L.u) { const n = norm3(L.u); put(b + 1, n[0]); put(b + 2, n[1]); put(b + 3, n[2]); }
      if (L.l) { const n = norm3(L.l); put(b + 4, n[0]); put(b + 5, n[1]); put(b + 6, n[2]); }
      if (L.t) triple(b + 7, L.t);
    }
    if (def.bike) {
      if (def.bike.pos) triple(CH_BIKE_POS, def.bike.pos);
      if (def.bike.rot) triple(CH_BIKE_ROT, def.bike.rot);
      if (def.bike.piv) triple(CH_BIKE_PIV, def.bike.piv);
    }
    if (def.steer !== undefined) put(CH_STEER, def.steer);
    return { idx: Int16Array.from(idx), val: Float32Array.from(val), action: def.action || null };
  }
  function norm3(a) {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  }

  const compiled = new Map();
  for (const id of Object.keys(POSES)) compiled.set(id, compile(POSES[id]));

  /**
   * Poses that are legal with the wheels down. Anything else is released once the
   * rider has been back on the ground for a moment: if a caller ever forgets its
   * `setPose(id, 0)` we roll away in a tabletop forever, and that is exactly the
   * kind of bug nobody notices until it is in a screenshot.
   */
  const GROUND_OK = new Set(['ride', 'pedal', 'roll', 'crouch', 'hop', 'bunnyhop', 'land',
    'manual', 'nose_manual', 'grind', 'flat_hangfive', 'flat_surfer', 'flat_tailwhip', 'bail']);
  for (const id of Object.keys(POSES)) {
    if (id.startsWith('grind_') || id.startsWith('lip_')) GROUND_OK.add(id);
  }

  function applyLayer(pose, w) {
    if (!pose || w <= 0) return;
    const { idx, val } = pose;
    if (w >= 1) { for (let k = 0; k < idx.length; k++) tgt[idx[k]] = val[k]; return; }
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k];
      tgt[i] += (val[k] - tgt[i]) * w;
    }
  }

  // ----------------------------------------------------------------- runtime
  let trickPose = null;         // id set by tricks.js
  let trickWeight = 0;          // 0..1 blend of that pose over the base
  let poseFade = 0;             // eased trickWeight
  let wheelAngle = 0;
  let steerAngle = 0;
  let barAngle = 0;
  let whipAngle = 0;
  let compressionVis = 0;
  let speedVis = 0;
  let jerseyPhase = rng() * TAU;
  let breathPhase = rng() * TAU;
  let lagYaw = 0, lagYawV = 0, lagPitch = 0, lagPitchV = 0;
  let prevYaw = 0, prevPitch = 0, havePrev = false;
  let disposed = false;

  /** The one live "action" (barspin / tailwhip / decade), driven outside the springs. */
  const act = { kind: null, turns: 0, dur: 0.4, t: 0, live: false };

  function startAction(a) {
    if (!a) return;
    act.kind = a.kind; act.turns = a.turns; act.dur = Math.max(0.08, a.dur);
    act.t = 0; act.live = true;
  }

  function setPose(id, weight = 1) {
    if (disposed) return;
    if (weight <= 0) {
      if (id == null || id === trickPose) { trickPose = null; trickWeight = 0; }
      return;
    }
    const pose = compiled.get(id);
    if (!pose) { trickPose = null; trickWeight = 0; return; }
    if (trickPose !== id) startAction(pose.action);
    trickPose = id;
    trickWeight = clamp(weight, 0, 1);
  }

  // -------------------------------------------------------------- bail rag doll
  // 13 particles: 0 hips 1 spine 2 chest 3 neck 4 head
  //               5 elbowL 6 wristL 7 elbowR 8 wristR
  //               9 kneeL 10 ankleL 11 kneeR 12 ankleR
  const RD_N = 13;
  const RD_PARENT = [-1, 0, 1, 2, 3, -2, 5, -3, 7, -4, 9, -5, 11];   // negatives = derived anchor
  const RD_NAMES = ['hips', 'spine', 'chest', 'neck', 'head',
    'elbowL', 'wristL', 'elbowR', 'wristR', 'kneeL', 'ankleL', 'kneeR', 'ankleR'];
  const rdBind = [];
  for (const n of RD_NAMES) rdBind.push(new THREE.Vector3().copy(P(n)));
  const rdPos = rdBind.map((v) => v.clone());
  const rdPrev = rdBind.map((v) => v.clone());
  const rdLen = new Float32Array(RD_N);
  const rdAnchor = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const rdAnchorBind = [P('shoulderL').clone(), P('shoulderR').clone(), P('hipL').clone(), P('hipR').clone()];
  for (let i = 0; i < RD_N; i++) {
    const p = RD_PARENT[i];
    const from = p >= 0 ? rdBind[p] : p < -1 ? rdAnchorBind[-p - 2] : rdBind[0];
    rdLen[i] = i === 0 ? 0 : rdBind[i].distanceTo(from);
  }
  const rdQuat = [];
  for (let i = 0; i < 20; i++) rdQuat.push(new THREE.Quaternion());
  const bailNormal = new THREE.Vector3(0, 1, 0);
  const rdChain = [rig.hips, rig.spine, rig.chest, rig.neck];   // bones driven by particles 0..4
  const RD_MID = [5, 7, 9, 11];                                 // armL, armR, legL, legR mid joints
  let bailW = 0, bailT = 0, bailActive = false, bailGroundY = 0;

  function playBail(detail) {
    bailActive = true;
    bailT = 0;
    const s = ctx?.player?.physics?.state;
    bailGroundY = s ? s.position.y : 0;
    // Seed the tumble from the impact: the body keeps going the way the bike was.
    _v0.set(0, 0, 0);
    if (s) {
      _q0.copy(s.quaternion).invert();
      _v0.copy(s.velocity).applyQuaternion(_q0);       // velocity in rider space
      const sp = _v0.length();
      if (sp > 1e-4) _v0.multiplyScalar(Math.min(sp, 12) / sp);
    }
    const kick = detail?.speed ? clamp(detail.speed / 12, 0.3, 1.4) : 0.8;
    for (let i = 0; i < RD_N; i++) {
      rdPos[i].copy(rdBind[i]);
      // Upper body carries more of the throw than the pelvis — that is what sells it.
      const share = 0.004 + 0.010 * (rdBind[i].y - 0.3);
      rdPrev[i].copy(rdBind[i]).addScaledVector(_v0, -share * kick);
      rdPrev[i].y -= 0.004 * kick;
    }
    for (let i = 0; i < 4; i++) rdAnchor[i].copy(rdAnchorBind[i]);
  }

  function stepRagdoll(dt) {
    const s = ctx?.player?.physics?.state;
    const h = Math.min(dt, 1 / 60);
    // gravity in rider space
    _v0.set(0, -T.bailGravity, 0);
    if (s) { _q0.copy(s.quaternion).invert(); _v0.applyQuaternion(_q0); }
    const g = _v0;
    // Shape memory is deliberately feeble: enough that the body stays a body, far too
    // weak to reassemble the riding pose. A ragdoll that springs back into a clean
    // stance mid-crash is the classic tell of a fake one.
    const shape = clamp(T.bailShape * h, 0, 0.25);

    for (let i = 0; i < RD_N; i++) {
      const p = rdPos[i], q = rdPrev[i];
      const vx = (p.x - q.x) * T.bailDamp, vy = (p.y - q.y) * T.bailDamp, vz = (p.z - q.z) * T.bailDamp;
      q.copy(p);
      p.x += vx + g.x * h * h;
      p.y += vy + g.y * h * h;
      p.z += vz + g.z * h * h;
    }
    // The pelvis is thrown too, but tethered: the rider is allowed to come off the
    // bike, never to fly away from it (the chassis is what the camera is watching).
    _v1.subVectors(rdPos[0], rdBind[0]);
    const away = _v1.length();
    if (away > T.bailTether) rdPos[0].addScaledVector(_v1, -(away - T.bailTether) / away);
    rdPos[0].lerp(rdBind[0], clamp(1.5 * h, 0, 0.4));

    for (let i = 1; i < RD_N; i++) rdPos[i].lerp(rdBind[i], shape);

    // ground plane in rider space
    if (s) {
      bailGroundY = Math.min(bailGroundY, s.position.y);
      _q0.copy(s.quaternion).invert();
      bailNormal.set(0, 1, 0).applyQuaternion(_q0);
      const hh = bailGroundY + T.bailFloor - s.position.y;
      for (let it = 0; it < T.bailIters; it++) {
        for (let i = 0; i < RD_N; i++) {
          const pi = RD_PARENT[i];
          if (i > 0) {
            const from = pi >= 0 ? rdPos[pi] : rdAnchor[-pi - 2];
            _v1.subVectors(rdPos[i], from);
            const d = _v1.length();
            if (d > 1e-5) {
              const k = (d - rdLen[i]) / d;
              // The parent side of a chain link is held by its own parent, so the
              // child takes the whole correction — this is what keeps it stable.
              rdPos[i].addScaledVector(_v1, -k * (pi >= 0 ? 0.9 : 1.0));
            }
          }
          const pen = rdPos[i].dot(bailNormal) - hh;
          if (pen < 0) rdPos[i].addScaledVector(bailNormal, -pen);
        }
      }
    }
  }

  /** Convert the particle cloud back into bone rotations (swing only — cannot invert). */
  function ragdollToBones() {
    // torso chain
    let idx = 0;
    _q1.identity();                                   // accumulated parent rotation
    for (let i = 0; i < 4; i++) {
      const b = rdChain[i];
      if (!b) { rdQuat[idx++].identity(); continue; }
      _v1.subVectors(rdBind[i + 1], rdBind[i]);
      if (_v1.lengthSq() < 1e-10) { rdQuat[idx].identity(); _q1.multiply(rdQuat[idx]); idx++; continue; }
      _v1.normalize();
      _v2.subVectors(rdPos[i + 1], rdPos[i]);
      if (_v2.lengthSq() < 1e-10) _v2.copy(_v1); else _v2.normalize();
      _q2.copy(_q1).invert();
      _v2.applyQuaternion(_q2);
      rdQuat[idx].setFromUnitVectors(_v1, _v2);
      _q1.multiply(rdQuat[idx]);
      idx++;
    }
    rdQuat[idx++].identity();                          // head

    // chest / hips frames drive the limb anchors for the next step
    _q1.identity();
    for (let i = 0; i < 3; i++) _q1.multiply(rdQuat[i]);   // hips*spine*chest
    _q2.copy(rdQuat[0]);                                   // hips
    rdAnchor[0].copy(rdAnchorBind[0]).sub(rdBind[2]).applyQuaternion(_q1).add(rdPos[2]);
    rdAnchor[1].copy(rdAnchorBind[1]).sub(rdBind[2]).applyQuaternion(_q1).add(rdPos[2]);
    rdAnchor[2].copy(rdAnchorBind[2]).sub(rdBind[0]).applyQuaternion(_q2).add(rdPos[0]);
    rdAnchor[3].copy(rdAnchorBind[3]).sub(rdBind[0]).applyQuaternion(_q2).add(rdPos[0]);

    // limbs: armL, armR, legL, legR  →  particles (5,6) (7,8) (9,10) (11,12)
    for (let L = 0; L < 4; L++) {
      const d = LIMB_DEF[L];
      const parent = d.arm ? _q1 : _q2;
      const anchor = rdAnchor[d.arm ? (d.side === 'L' ? 0 : 1) : (d.side === 'L' ? 2 : 3)];
      const mi = RD_MID[L], ti = mi + 1;
      _v1.subVectors(rdPos[mi], anchor);
      if (_v1.lengthSq() < 1e-10) _v1.copy(d.bindU); else _v1.normalize();
      _q3.copy(parent).invert();
      _v1.applyQuaternion(_q3);
      const qu = rdQuat[6 + L * 2];
      qu.setFromUnitVectors(d.bindU, _v1);
      _v2.subVectors(rdPos[ti], rdPos[mi]);
      if (_v2.lengthSq() < 1e-10) _v2.copy(d.bindL); else _v2.normalize();
      _v2.applyQuaternion(_q3);
      _q0.copy(qu).invert();
      _v2.applyQuaternion(_q0);
      rdQuat[7 + L * 2].setFromUnitVectors(d.bindL, _v2);
    }
  }

  // ------------------------------------------------------------------ events
  const onBail = (e) => playBail(e?.detail);
  const onRespawn = () => { bailActive = false; };
  const onLand = () => { if (bailActive) bailActive = false; };
  ctx?.events?.addEventListener?.('bail', onBail);
  ctx?.events?.addEventListener?.('respawn', onRespawn);
  ctx?.events?.addEventListener?.('land', onLand);

  // --------------------------------------------------------------- base pose
  function baseId(s, grindApi) {
    if (!s) return 'ride';
    switch (s.mode) {
      case 'bail': return 'bail';
      case 'grind': return grindApi?.types?.[grindApi.type]?.pose || 'grind';
      case 'manual': return s.manualType === 'nose' ? 'nose_manual' : 'manual';
      case 'air': return 'air';
      case 'wallride': return 'air';
      default:
        if (s.crouch > 0.012 || s.hopCharge > 0.05) return 'crouch';
        if (s.compression > 0.22) return 'land';
        return (ctx?.input?.state?.throttle || 0) > 0.05 ? 'pedal' : 'ride';
    }
  }

  // --------------------------------------------------------- per-frame apply
  const qHips = new THREE.Quaternion();
  const qSpineW = new THREE.Quaternion();
  const qChestW = new THREE.Quaternion();
  const pHips = new THREE.Vector3();
  const pSpine = new THREE.Vector3();
  const pChest = new THREE.Vector3();
  const bikeQ = new THREE.Quaternion();
  const bikeP = new THREE.Vector3();
  const qWhip = new THREE.Quaternion();
  const qPose = new THREE.Quaternion();
  const qSteer = new THREE.Quaternion();
  const qVisual = new THREE.Quaternion();
  const tmpTarget = new THREE.Vector3();
  const tmpDirU = new THREE.Vector3();
  const tmpDirL = new THREE.Vector3();

  function update(dt, context) {
    if (disposed) return;
    const c = context || ctx;
    const s = c?.player?.physics?.state;
    const input = c?.input?.state;
    const grindApi = c?.player?.grind;
    const d = clamp(dt, 0, 0.1);

    // ---------------------------------------------------------- 1. actions
    let handOff = 0, legLift = 0, decadeA = 0;
    if (act.live) {
      act.t += d;
      const ph = clamp(act.t / act.dur, 0, 1);
      const e = smoothstep(clamp((ph - 0.04) / 0.92, 0, 1));
      const win = clamp((ph - 0.05) / 0.10, 0, 1) * clamp((0.94 - ph) / 0.12, 0, 1);
      if (act.kind === 'bars') { barAngle = act.turns * TAU * e; handOff = win; }
      else if (act.kind === 'whip') { whipAngle = act.turns * TAU * e; legLift = win; }
      else if (act.kind === 'decade') { decadeA = act.turns * TAU * e; handOff = win * 0.6; legLift = 1; }
      if (ph >= 1) { act.live = false; act.kind = null; barAngle = 0; whipAngle = 0; }
    } else {
      barAngle = 0; whipAngle = 0;
    }

    // ------------------------------------------------------ 2. target build
    // stale air pose safety net (see GROUND_OK)
    if (trickPose && s && s.mode !== 'air' && s.mode !== 'bail' && !act.live
        && !GROUND_OK.has(trickPose)) {
      trickPose = null; trickWeight = 0;
    }

    const id = baseId(s, grindApi);
    tgt.set(defaults);
    applyLayer(compiled.get(id) || compiled.get('ride'), 1);
    poseFade = damp(poseFade, trickPose ? trickWeight : 0, 18, d);
    if (trickPose && poseFade > 0.002) applyLayer(compiled.get(trickPose), poseFade);

    // --- additive procedural layer -----------------------------------------
    const speed = s ? s.speed : 0;
    speedVis = damp(speedVis, speed, 6, d);
    const spd01 = clamp(speedVis / 14, 0, 1);
    const comp = s ? s.compression : 0;
    compressionVis = damp(compressionVis, comp, 14, d);
    const steerIn = s ? s.steer : (input?.steer || 0);
    const air = s ? (s.mode === 'air') : false;

    // breathing + jersey secondary motion
    breathPhase += d * T.breathRate * TAU;
    jerseyPhase += d * (2.4 + spd01 * 7.0);
    const breath = Math.sin(breathPhase);
    tgt[CH_SPINE + 6] += breath * 0.012 * (1 - spd01 * 0.6);          // chest rx
    tgt[CH_SPINE + 3] += Math.sin(jerseyPhase * 0.63) * 0.006 * spd01; // spine rx

    // torso lag behind the chassis — the cheap jiggle bone
    if (s) {
      _v0.set(0, 0, 1).applyQuaternion(s.quaternion);
      const yaw = Math.atan2(_v0.x, _v0.z);
      const pitch = Math.asin(clamp(_v0.y, -1, 1));
      if (havePrev) {
        let dy = yaw - prevYaw;
        if (dy > Math.PI) dy -= TAU; else if (dy < -Math.PI) dy += TAU;
        lagYawV -= dy * T.lagGain * 60;
        lagPitchV -= (pitch - prevPitch) * T.lagGain * 60;
      }
      prevYaw = yaw; prevPitch = pitch; havePrev = true;
      const w = T.lagW;
      lagYawV += (-w * w * lagYaw - 2 * w * lagYawV) * d;
      lagPitchV += (-w * w * lagPitch - 2 * w * lagPitchV) * d;
      lagYaw = clamp(lagYaw + lagYawV * d, -0.28, 0.28);
      lagPitch = clamp(lagPitch + lagPitchV * d, -0.24, 0.24);
      tgt[CH_SPINE + 3 + 1] += lagYaw * 0.30;    // spine ry
      tgt[CH_SPINE + 6 + 1] += lagYaw * 0.45;    // chest ry
      tgt[CH_SPINE + 9 + 1] += lagYaw * 0.35;    // neck ry
      tgt[CH_SPINE + 6] += lagPitch * 0.35;
      tgt[CH_SPINE + 9] += lagPitch * 0.30;
    }

    // head look-ahead: into the turn on the ground, into the spin in the air
    let look = steerIn * T.headLook;
    if (s && air) {
      const spinSign = Math.sign(s.rotation?.yaw || 0);
      look += spinSign * T.headSpinLead * clamp(Math.abs(s.rotation?.yaw || 0) / 90, 0, 1);
      tgt[CH_SPINE + 12] += clamp(s.velocity ? -s.velocity.y * 0.02 : 0, -0.16, 0.16);
    }
    tgt[CH_SPINE + 9 + 1] += look * 0.35;
    tgt[CH_SPINE + 12 + 1] += look * 0.65;

    // landing squat on top of whatever pose is playing
    if (compressionVis > 0.002) {
      tgt[CH_ROOT + 1] -= 0.085 * compressionVis;
      tgt[CH_SPINE] += 0.13 * compressionVis;
      tgt[CH_SPINE + 6] += 0.07 * compressionVis;
      tgt[CH_SPINE + 9] -= 0.14 * compressionVis;
    }

    // Grinds: balance corrections plus the counter to the chassis attitude. grind.js
    // rolls and pitches the whole bike onto the rail and the rider group rides it, so
    // the torso rotates BACK by about half of it — the rider stays upright over a bike
    // that is hanging off the rail, which is what an ice pick or a feeble looks like.
    if (s && s.mode === 'grind' && grindApi) {
      const bal = clamp(grindApi.balance || 0, -1, 1);
      tgt[CH_SPINE + 2] += bal * 0.20;
      tgt[CH_SPINE + 8] += bal * 0.14;
      tgt[CH_ROOT] += bal * 0.045;
      const gt = grindApi.types?.[grindApi.type];
      const cRoll = clamp((s.lean || 0) * 0.45, -0.35, 0.35);
      const cPitch = clamp((gt?.pitch || 0) * 0.5, -0.30, 0.30);
      tgt[CH_SPINE + 2] += cRoll;
      tgt[CH_SPINE + 8] += cRoll * 0.45;
      tgt[CH_SPINE] += cPitch;
      tgt[CH_SPINE + 6] += cPitch * 0.4;
      tgt[CH_SPINE + 9] -= cPitch * 0.7;
    }
    // manual balance rocks the rider fore/aft
    if (s && s.mode === 'manual') {
      const bal = clamp(s.balance || 0, -1, 1);
      tgt[CH_ROOT + 2] -= bal * 0.055;
      tgt[CH_SPINE] -= bal * 0.10;
    }

    // ------------------------------------------------------- 3. spring blend
    let steps = d > T.substep ? Math.ceil(d / T.substep) : 1;
    if (steps > 4) steps = 4;
    const hstep = d / steps;
    for (let n = 0; n < steps; n++) {
      for (let i = 0; i < NCH; i++) {
        const w = omega[i];
        const a = (tgt[i] - cur[i]) * w * w - vel[i] * 2 * w;
        vel[i] += a * hstep;
        cur[i] += vel[i] * hstep;
      }
    }

    // --------------------------------------------- 4. direct action overrides
    if (handOff > 0) {
      for (let li = 0; li < 2; li++) {
        const b = limbBase(li);
        cur[b] = Math.min(cur[b], 1 - handOff);
        const s2 = li === 0 ? -1 : 1;
        // hands come up off the bars and hover, ready to re-catch
        cur[b + 1] = lerp(cur[b + 1], s2 * 0.62, handOff);
        cur[b + 2] = lerp(cur[b + 2], -0.36, handOff);
        cur[b + 3] = lerp(cur[b + 3], 0.70, handOff);
        cur[b + 4] = lerp(cur[b + 4], -s2 * 0.28, handOff);
        cur[b + 5] = lerp(cur[b + 5], -0.18, handOff);
        cur[b + 6] = lerp(cur[b + 6], 0.94, handOff);
      }
    }
    if (legLift > 0) {
      for (let li = 2; li < 4; li++) {
        const b = limbBase(li);
        cur[b] = Math.min(cur[b], 1 - legLift);
        const s2 = li === 2 ? -1 : 1;
        // knees up and tucked so the frame can swing under the rider
        cur[b + 1] = lerp(cur[b + 1], s2 * 0.30, legLift);
        cur[b + 2] = lerp(cur[b + 2], -0.16, legLift);
        cur[b + 3] = lerp(cur[b + 3], 0.94, legLift);
        cur[b + 4] = lerp(cur[b + 4], -s2 * 0.20, legLift);
        cur[b + 5] = lerp(cur[b + 5], -0.94, legLift);
        cur[b + 6] = lerp(cur[b + 6], 0.28, legLift);
      }
      cur[CH_ROOT + 1] += 0.055 * legLift;
    }
    if (decadeA !== 0) {
      // The rider swings a full turn around the bike's long axis, pivoting at the bars.
      const ca = Math.cos(decadeA), sa = Math.sin(decadeA);
      const px = PIVOT_BARS[0], py = PIVOT_BARS[1];
      const rx = bindRoot.x - px, ry = bindRoot.y - py;
      cur[CH_ROOT] += (px + rx * ca - ry * sa) - bindRoot.x;
      cur[CH_ROOT + 1] += (py + rx * sa + ry * ca) - bindRoot.y;
      cur[CH_SPINE + 2] += decadeA;
    }

    // ---------------------------------------------------------- 5. bike rig
    if (bikeGroup) {
      _e0.set(cur[CH_BIKE_ROT], cur[CH_BIKE_ROT + 1], cur[CH_BIKE_ROT + 2]);
      qPose.setFromEuler(_e0);
      qWhip.setFromAxisAngle(whipAxis, whipAngle);
      bikeQ.copy(qWhip).multiply(qPose);
      // position = Qw*(Ppiv - Qp*Ppiv - Pw) + Pw + offset
      _v0.set(cur[CH_BIKE_PIV], cur[CH_BIKE_PIV + 1], cur[CH_BIKE_PIV + 2]);
      _v1.copy(_v0).applyQuaternion(qPose);
      _v2.copy(_v0).sub(_v1).sub(steerPos).applyQuaternion(qWhip).add(steerPos);
      bikeP.copy(_v2);
      bikeP.x += cur[CH_BIKE_POS];
      bikeP.y += cur[CH_BIKE_POS + 1] - T.frameSquat * compressionVis;
      bikeP.z += cur[CH_BIKE_POS + 2];
      bikeGroup.position.copy(bikeP);
      bikeGroup.quaternion.copy(bikeQ);
    } else {
      bikeQ.identity();
      bikeP.set(0, 0, 0);
    }

    // steering: input steer + pose steer, minus the whip (the bars hold still)
    const steerAuth = air ? T.steerAirVisual : T.steerVisual;
    const steerTarget = clamp(steerIn, -1, 1) * steerAuth + cur[CH_STEER];
    steerAngle = damp(steerAngle, steerTarget, T.steerLambda, d);
    if (bike?.setSteer) bike.setSteer(steerAngle - whipAngle);
    if (bike?.setBarspin) bike.setBarspin(barAngle);
    // The steerer's own transform is Rx(headTilt) * Ry(angle) — matching bike.js,
    // where `steer.rotation.y` is literally the rotation about the head-tube axis.
    qSteer.setFromAxisAngle(AXIS_Y, steerAngle - whipAngle).premultiply(qSteerTilt);

    // wheels / crank / chain
    const spinRate = s && Number.isFinite(s.wheelSpin)
      ? s.wheelSpin
      : (s ? s.speed / T.wheelRadius : 0);
    wheelAngle += spinRate * d;
    if (wheelAngle > 1e6 || wheelAngle < -1e6) wheelAngle %= TAU;
    if (bike?.setWheelSpin) bike.setWheelSpin(wheelAngle);
    const crank = s && Number.isFinite(s.crank) ? s.crank : wheelAngle / T.crankRatio;
    if (bike?.setDrive) bike.setDrive(crank);

    // tyre squash + fork rake + bar flex: the whole bike takes the hit
    const squash = 1 - T.tyreSquash * compressionVis;
    for (let i = 0; i < tyres.length; i++) tyres[i].scale.set(1, squash, squash);
    if (steerObj) steerObj.rotation.x = forkBaseTilt - T.forkRake * compressionVis;
    if (bike?.barPivot) bike.barPivot.rotation.x = -T.barFlex * compressionVis;
    if (bike?.frame) bike.frame.position.y = -0.012 * compressionVis;

    // ----------------------------------------------------------- 6. skeleton
    // pelvis
    pHips.copy(bindRoot);
    pHips.x += cur[CH_ROOT]; pHips.y += cur[CH_ROOT + 1]; pHips.z += cur[CH_ROOT + 2];
    rig.hips.position.copy(pHips);
    for (let i = 0; i < spineBones.length; i++) {
      const b = spineBones[i];
      b.rotation.set(cur[CH_SPINE + i * 3], cur[CH_SPINE + i * 3 + 1], cur[CH_SPINE + i * 3 + 2]);
    }
    qHips.copy(rig.hips.quaternion);
    qSpineW.copy(qHips).multiply(rig.spine.quaternion);
    pSpine.copy(offOf(rig.spine)).applyQuaternion(qHips).add(pHips);
    qChestW.copy(qSpineW).multiply(rig.chest.quaternion);
    pChest.copy(offOf(rig.chest)).applyQuaternion(qSpineW).add(pSpine);

    // Jersey billow: a breath of bone scale on the ribcage is the cheapest cloth
    // there is. Scale inherits down the chain, so the neck and both shoulders are
    // counter-scaled — otherwise the head would swell and the arms would grow,
    // which would quietly break the IK reach to the grips.
    const billow = 1 + T.jerseyGain * (0.35 + 0.65 * spd01) * (0.5 + 0.5 * Math.sin(jerseyPhase));
    const billowY = 1 + (billow - 1) * 0.30;
    rig.chest.scale.set(billow, billowY, billow);
    const ib = 1 / billow, iby = 1 / billowY;
    if (rig.neck) rig.neck.scale.set(ib, iby, ib);
    if (rig.shoulderL) rig.shoulderL.scale.set(ib, iby, ib);
    if (rig.shoulderR) rig.shoulderR.scale.set(ib, iby, ib);

    // limbs
    for (let L = 0; L < 4; L++) {
      const def = LIMB_DEF[L];
      if (!def.rootB || !def.midB) continue;
      const b = limbBase(L);
      const ik = clamp(cur[b], 0, 1);
      const parentQ = def.arm ? qChestW : qHips;
      const parentP = def.arm ? pChest : pHips;

      tmpDirU.set(cur[b + 1], cur[b + 2], cur[b + 3]);
      if (tmpDirU.lengthSq() < 1e-8) tmpDirU.copy(def.bindU); else tmpDirU.normalize();
      tmpDirL.set(cur[b + 4], cur[b + 5], cur[b + 6]);
      if (tmpDirL.lengthSq() < 1e-8) tmpDirL.copy(def.bindL); else tmpDirL.normalize();

      if (ik > 0.001) {
        // grip / pedal target in bike space → rider space → limb-parent space
        if (def.arm) {
          tmpTarget.copy(def.side === 'L' ? gripSteerL : gripSteerR)
            .applyQuaternion(qSteer).add(steerPos);
        } else {
          const pi = def.side === 'L' ? 0 : 1;
          _v5.copy(pedalRel[pi]);
          const ca = Math.cos(crank), sa = Math.sin(crank);
          tmpTarget.set(_v5.x, _v5.y * ca - _v5.z * sa, _v5.y * sa + _v5.z * ca)
            .add(bbPos).add(ankleOff[pi]);
        }
        tmpTarget.applyQuaternion(bikeQ).add(bikeP).sub(parentP);
        _q0.copy(parentQ).invert();
        tmpTarget.applyQuaternion(_q0);
        const chord = tmpTarget.distanceTo(offOf(def.rootB));
        const tight = 1 - smoothstep(clamp((chord / (def.lenA + def.lenB) - 0.40) / 0.38, 0, 1));
        _pole.copy(def.pole).lerp(def.poleTight, tight);
        if (_pole.lengthSq() < 1e-8) _pole.copy(def.pole);
        solveIK(offOf(def.rootB), tmpTarget, def.lenA, def.lenB, _pole.normalize(), _dirU, _dirL);
        if (ik >= 0.999) { tmpDirU.copy(_dirU); tmpDirL.copy(_dirL); }
        else {
          tmpDirU.lerp(_dirU, ik).normalize();
          tmpDirL.lerp(_dirL, ik).normalize();
        }
      }

      def.rootB.quaternion.setFromUnitVectors(def.bindU, tmpDirU);
      _q1.copy(def.rootB.quaternion).invert();
      _v0.copy(tmpDirL).applyQuaternion(_q1);
      def.midB.quaternion.setFromUnitVectors(def.bindL, _v0);

      // hand / foot: follow the bars or the pedal when gripping, pose euler when free
      if (def.tipB) {
        _e0.set(cur[b + 7], cur[b + 8], cur[b + 9]);
        _q2.setFromEuler(_e0);
        if (ik > 0.001) {
          _q3.copy(parentQ).multiply(def.rootB.quaternion).multiply(def.midB.quaternion).invert();
          _q0.copy(bikeQ);
          if (def.arm) _q0.multiply(qSteer);
          _q3.multiply(_q0);
          if (ik >= 0.999) _q2.copy(_q3); else _q2.slerp(_q3, ik);
        }
        def.tipB.quaternion.copy(_q2);
      }
    }

    // ------------------------------------------------------------- 7. bail
    if (bailActive) {
      bailT += d;
      bailW = Math.min(1, bailW + d / T.bailBlendIn);
      stepRagdoll(d);
      ragdollToBones();
      if (bailT > T.bailTime + 2.6) bailActive = false;
    } else if (bailW > 0) {
      bailW = Math.max(0, bailW - d / T.bailBlendOut);
    }
    if (bailW > 0.001) {
      const w = smoothstep(bailW);
      for (let i = 0; i < spineBones.length; i++) spineBones[i].quaternion.slerp(rdQuat[i], w);
      for (let L = 0; L < 4; L++) {
        const def = LIMB_DEF[L];
        if (def.rootB) def.rootB.quaternion.slerp(rdQuat[6 + L * 2], w);
        if (def.midB) def.midB.quaternion.slerp(rdQuat[7 + L * 2], w);
      }
      _v0.copy(rdPos[0]);
      rig.hips.position.lerp(_v0, w);
    }

    // ------------------------------------------------ 8. place the whole rig
    if (s) {
      group.position.copy(s.position);
      group.quaternion.copy(s.quaternion);
      // Visual-only body english: the chassis is where the collision says it is,
      // these two angles just sell the ride. Never fed back to the physics.
      const roll = clamp(-steerIn * spd01 * 0.10 - (s.lateralSpeed || 0) * 0.012, -0.13, 0.13);
      const pitchV = clamp(compressionVis * 0.10 - (input?.throttle || 0) * spd01 * 0.035, -0.10, 0.14);
      if (Math.abs(roll) > 1e-4 || Math.abs(pitchV) > 1e-4) {
        _e0.set(pitchV, 0, roll);
        qVisual.setFromEuler(_e0);
        group.quaternion.multiply(qVisual);
      }
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    ctx?.events?.removeEventListener?.('bail', onBail);
    ctx?.events?.removeEventListener?.('respawn', onRespawn);
    ctx?.events?.removeEventListener?.('land', onLand);
    // Hand the rig back exactly as it was handed to us: bike.js may outlive us.
    for (const b of rig.bones || []) { b.quaternion.identity(); b.scale.set(1, 1, 1); }
    rig.hips.position.copy(bindRoot);
    for (let i = 0; i < tyres.length; i++) tyres[i].scale.set(1, 1, 1);
    if (steerObj) steerObj.rotation.x = forkBaseTilt;
    if (bikeGroup) { bikeGroup.position.set(0, 0, 0); bikeGroup.quaternion.identity(); }
    if (bike?.barPivot) bike.barPivot.rotation.set(0, 0, 0);
    if (bike?.frame) bike.frame.position.set(0, 0, 0);
    bike?.setSteer?.(0);
    bike?.setBarspin?.(0);
  }

  return {
    /** The pose table, so tricks.js (or a debug UI) can enumerate valid ids. */
    poses: POSES,
    poseIds: Object.keys(POSES),
    tuning: ANIM_TUNE,
    get pose() { return trickPose; },
    get bailing() { return bailActive; },
    update,
    fixedUpdate() {},
    setPose,
    playBail,
    dispose,
  };
}
