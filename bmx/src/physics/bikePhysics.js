// MIRRA CITY — bike physics. Arcade-sim ride / air / land model at a 120 Hz fixed step.
//
// Conventions (shared with camera.js and riderAnim.js):
//   * `state.position` is the bike's CONTACT ORIGIN — the point where the wheels meet
//     the ground, midway along the wheelbase. The rider group is parented straight to
//     it, so on flat ground the tyres sit exactly on the surface.
//   * Local axes: +Z forward, +Y up, +X right. `yaw = atan2(fwd.x, fwd.z)`; increasing
//     yaw steers right.
//   * The ground model is two probes (front/rear wheel) plus a centre probe, all cast
//     straight down through `ctx.world.collision.raycastDown`. Pitch is fitted from the
//     two wheel contacts, roll from the blended surface normal, and the whole thing is
//     slerped so the bike never snaps to a new plane.
//   * Nothing in the update path allocates: every vector/quaternion/matrix used per
//     step is a module-level scratch. The only objects built at runtime are the small
//     detail payloads for discrete events (land/bail/hop/...), which fire a handful of
//     times per second at most.
//
// Energy model: on the ground, gravity is projected into the surface tangent, so you
// bleed speed climbing a transition and get it back coming down — that single rule is
// what makes quarterpipes feel like quarterpipes. Pumping tops the bank account up,
// with a refilling budget so it cannot be mashed.

import * as THREE from 'three';
import { clamp, damp, lerp, moveTowards, wrapAngle, rng } from '../core/mathx.js';

export const TUNING = {
  // --- chassis geometry ----------------------------------------------------
  wheelBase: 1.05,          // m between the front/rear ground probes — longer reads calmer over bumps
  contactLift: 0.02,        // m the contact origin floats above the surface — kills z-fighting/jitter at rest
  probeUp: 0.55,            // m the ground ray starts above the wheel — keeps decks above the lip out of the ray
  probeDown: 1.45,          // m the ray reaches below the wheel — how far a wheel "hunts" for ground before letting go
  groundAttach: 0.16,       // m gap that still counts as contact — bigger keeps you glued over crests
  contactBand: 0.30,        // m either side of a wheel for its probe to count — beyond this the wheel is over an edge
  minGroundNormalY: 0.16,   // steeper than ~81° is wall, not floor — you hold a transition almost to vertical
  wheelRadius: 0.26,        // m rolling radius (20" tyre) — drives wheel spin for the animator
  crankRatio: 2.6,          // gearing: wheel revs per crank rev — sets the pedal cadence you see

  // --- drive ---------------------------------------------------------------
  gravity: 17.5,            // m/s² — lower than real life so airs float like DMFBMX2 (0.9 m hop, ~2 m natural QP air)
  maxSpeed: 14.0,           // m/s target top speed on flat concrete
  speedHardCap: 24.0,       // m/s absolute clamp — a long drop-in cannot run away with the sim
  pedalAccel: 10.0,         // m/s² pedal thrust — held nearly flat through the midrange by pedalFalloff
  pedalFalloff: 4.0,        // exponent of the accel roll-off: high keeps thrust flat, then it dies near the top
  pedalTopFactor: 1.04,     // the pedal curve dies at maxSpeed×this — the curve, not drag, sets the ceiling
  coastDrag: 0.006,         // quadratic drag while rolling — deliberately low so transitions keep their energy
  rollResist: 0.35,         // m/s² constant rolling drag, scaled by surface friction — dirt drags, concrete rolls
  brakeDecel: 13.5,         // m/s² rear brake authority
  lockupBrake: 0.55,        // brake input above this locks the rear wheel into a skid
  skidMinSpeed: 2.6,        // m/s below which a locked wheel just stops instead of skidding
  skidGrip: 0.34,           // lateral grip multiplier while the rear is locked — this is the drift
  skidDecay: 5.0,           // 1/s how fast the skid readout falls once you release the brake

  // --- steering ------------------------------------------------------------
  maxYawRate: 2.45,         // rad/s steering cap at walking pace — the tightest turn the bike can carve
  maxLatAccel: 9.6,         // m/s² cornering grip; divided by speed it widens the radius so 14 m/s turns are broad
  steerLambda: 11.0,        // 1/s smoothing on the raw steer axis — removes keyboard on/off snap
  selfAlign: 2.2,           // 1/s the heading is pulled toward the actual travel direction — kills ice-skating
  pivotSpeed: 2.2,          // m/s below which steering authority fades — no pivoting on the spot
  maxLean: 0.489,           // rad (28°) visual roll into a turn
  leanLambda: 8.5,          // 1/s lean smoothing
  counterSteer: 0.085,      // s of reverse lean fed from the steer rate — the flick on turn initiation

  // --- hop / pump ----------------------------------------------------------
  hopChargeTime: 0.34,      // s to fully load the bunnyhop
  crouchMax: 0.18,          // m the rider compresses while charging
  hopMin: 2.9,              // m/s tap-hop launch speed (~0.24 m)
  hopMax: 5.62,             // m/s full-charge launch (0.9 m at g=17.5)
  hopNormalBlend: 0.62,     // 0=straight up, 1=straight off the surface normal — how much a ramp aims your hop
  hopSteepScale: 0.35,      // hop authority left at a vertical lip — you cannot load your legs against a wall
  lipPop: 0.9,              // m/s free pop when the wheels leave a steep lip at speed — the last metre of QP air
  lipTiltMin: 0.35,         // sin(tilt) needed to count as "a lip" rather than a rolling crest
  pumpTapTime: 0.30,        // s — a crouch shorter than this on a transition pumps instead of hopping
  pumpGain: 3.4,            // m/s of speed a perfect pump adds at full compression on a steep wall
  pumpBudget: 3.0,          // max stored pump charges — the anti-spam cap
  pumpRefill: 0.85,         // charges/s the budget refills — roughly one good pump per transition
  pumpMinTilt: 0.16,        // sin(surface tilt) below which there is nothing to pump against

  // --- air -----------------------------------------------------------------
  airDrag: 0.0075,          // quadratic drag in the air — keeps huge airs from feeling frictionless
  airYawRate: 1.55,         // rad/s of yaw the player can nudge mid-air
  airPitchRate: 1.15,       // rad/s of pitch nudge (back = nose up) — used to set up landings, not to flip
  airVelSteer: 0.55,        // rad/s the velocity vector itself can be steered in the air (landing adjust)
  airControlFade: 0.18,     // s of air before full control authority — stops takeoff twitch
  maxTrickRate: 9.42,       // rad/s (540°/s) hard cap on trick-driven rotation
  spinAssistLambda: 3.0,    // 1/s residual spin bleed once the trick system stops driving
  airLevelLambda: 4.2,      // 1/s the rider levels the bike toward the surface below when not tricking
  airLevelDelay: 0.08,      // s before levelling starts — leaving a lip nose-high still looks like a launch
  airLevelReach: 6.0,       // m below the bike that the levelling aims at the real landing surface

  // --- landing -------------------------------------------------------------
  landYawTol: 0.611,        // rad (35°) heading vs travel direction tolerance on touchdown
  landPitchTol: 0.436,      // rad (25°) nose-up/down tolerance vs the landing surface
  landRollTol: 0.436,       // rad (25°) sideways tolerance vs the landing surface
  landSnap: 0.14,           // m gap at which a descending bike is considered to have touched down
  landGrace: 0.12,          // s of coyote time after takeoff — a transition curls in behind you as you leave it
  landGraceClosing: 4.5,    // m/s of impact that lands you anyway during that grace window
  landNormalToTangent: 0.42,// how much slam speed converts into roll-out speed (scaled by surface steepness)
  landSpeedKeep: 0.80,      // fraction of speed kept on the sketchiest legal landing (1.0 on a perfect one)
  maxImpactSpeed: 17.0,     // m/s of closing speed into a surface that snaps the rider — flat-drop bail
  copingStep: 0.55,         // m of front-to-rear contact mismatch that reads as "landed across the coping"
  stallSpeed: 1.5,          // m/s below which a steep transition stalls you out
  stallTilt: 0.80,          // sin(tilt) above which the stall rule applies (~53°) — rolling back down a bank is fine
  stallTime: 0.30,          // s of stalling before it becomes a bail
  landCompression: 11.0,    // m/s of impact that fully compresses the suspension readout
  compressionLambda: 9.0,   // 1/s suspension rebound

  // --- manual --------------------------------------------------------------
  manualMinSpeed: 1.6,      // m/s needed to pull into a manual
  manualPitch: 0.42,        // rad (24°) nose-up angle of a centred manual
  manualPitchRange: 0.20,   // rad extra pitch swing as the balance meter travels
  balanceGravity: 4.2,      // 1/s² inverted-pendulum divergence — untouched, a manual falls in ~1.5 s
  balanceInput: 4.2,        // 1/s² authority of input.lean — can save the meter up to about |0.9|
  balanceDamp: 1.6,         // 1/s damping on the balance rate — makes the correction land instead of oscillating
  balanceSpeedAid: 0.45,    // fraction of the divergence removed at top speed — fast manuals are easier
  balanceDrift: 0.8,        // 1/s² amplitude of the deterministic wobble that keeps the meter alive
  balanceSeed: 0.14,        // the meter never starts perfectly balanced, or it would never fall at all
  balanceBailAt: 1.0,       // |balance| that ends the manual in a bail

  // --- wallride ------------------------------------------------------------
  wallMinSpeed: 6.2,        // m/s needed to stick to a wall
  wallMaxNormalY: 0.42,     // |normal.y| below this is a genuine wall
  wallHeadOn: 0.80,         // approach dot above this is a head-on smash, not a wallride
  wallBailSpeed: 8.5,       // m/s of head-on impact that bails instead of just stopping you
  wallProbeUp: 0.55,        // m up the frame the wall sweep runs from
  wallProbeRadius: 0.34,    // m sweep radius — roughly the tyre/bar envelope
  wallProbeDist: 0.62,      // m the sweep reaches ahead of the contact point
  wallGravityScale: 0.42,   // fraction of gravity felt along the wall — the "stick" of a wallride
  wallStick: 3.2,           // m/s² pressed into the wall so you track it round corners
  wallMaxTime: 1.6,         // s a wallride can last before you drop off
  wallExitPop: 2.4,         // m/s pushed off the wall when the wallride ends
  wallCooldown: 0.45,       // s before another wall can grab you — stops sticky ping-pong

  // --- bail ----------------------------------------------------------------
  bailControlTime: 1.6,     // s of dead control while the rider tumbles
  bailMaxTime: 4.0,         // s hard cap before the respawn fires regardless
  bailRestSpeed: 2.2,       // m/s below which the tumble is considered finished
  bailSpin: 7.5,            // rad/s of tumble seeded from the crash energy
  bailBounce: 0.34,         // restitution of the tumbling bike against the ground
  bailFriction: 3.4,        // m/s² of ground drag on the tumbling bike
  safeInterval: 0.22,       // s between "last safe spot" samples
  safeMaxTilt: 0.45,        // sin(tilt) above which a spot is too steep to respawn on

  // --- grind hand-off ------------------------------------------------------
  grindOutPop: 3.4,         // m/s pop when grind.js hops you off a rail
  crestRelease: 1.6,        // m/s away from the contact plane that launches you — how a lip throws you instead of gluing
  slideRestore: 1.06,       // max speed rescale when re-seating velocity on a surface — curvature yes, impacts no
  orientLambda: 24.0,       // 1/s chassis alignment to the ground plane — lower is floatier, higher snaps
  orientLambdaAir: 9.0,     // 1/s alignment used for wallride / grind framing
};

const RAD2DEG = 180 / Math.PI;
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);

// ---- scratch (module scope: the update path allocates nothing) -------------
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _n = new THREE.Vector3();
const _tmpA = new THREE.Vector3();
const _tmpB = new THREE.Vector3();
const _tmpC = new THREE.Vector3();
const _probeOrigin = new THREE.Vector3();
const _sweepFrom = new THREE.Vector3();
const _sweepTo = new THREE.Vector3();
const _basis = new THREE.Matrix4();
const _qTarget = new THREE.Quaternion();
const _qStep = new THREE.Quaternion();

function makeProbe() {
  return {
    hit: false,
    usable: false,                       // hit AND shallow enough to stand on
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(0, 1, 0),
    friction: 1,
    surface: 'ground',
    gap: Infinity,                       // vertical: + above the surface, - penetrating
    perp: Infinity,                      // the same gap measured along the surface normal
  };
}

export function createBikePhysics(ctx) {
  const T = TUNING;

  const state = {
    // --- required by ARCHITECTURE.md ---------------------------------------
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    grounded: true,
    airTime: 0,
    speed: 0,
    lean: 0,                             // rad, visual roll into turns (+ = leaning right)
    pitch: 0,                            // rad, nose-up angle of the chassis
    mode: 'ride',                        // 'ride'|'air'|'grind'|'manual'|'bail'|'wallride'
    crank: 0,                            // rad, pedal crank angle for the animation system
    steer: 0,                            // -1..1 smoothed steering

    // --- orientation / motion readouts -------------------------------------
    yaw: 0,                              // rad heading around world up
    roll: 0,                             // rad actual chassis roll vs the surface
    forward: new THREE.Vector3(0, 0, 1),
    up: new THREE.Vector3(0, 1, 0),
    right: new THREE.Vector3(1, 0, 0),
    forwardSpeed: 0,                     // m/s along the bike's forward axis
    lateralSpeed: 0,                     // m/s of sideways slip
    verticalSpeed: 0,                    // m/s world Y
    wheelSpin: 0,                        // rad/s of the wheels, for the animator

    // --- surface -----------------------------------------------------------
    surfaceNormal: new THREE.Vector3(0, 1, 0),
    surfaceType: 'ground',
    surfaceFriction: 1,
    surfaceTilt: 0,                      // sin(angle from flat) of the contact plane
    contactFront: false,
    contactRear: false,

    // --- rider / suspension ------------------------------------------------
    crouch: 0,                           // m of hop charge compression
    compression: 0,                      // 0..1 landing squash
    hopCharge: 0,                        // 0..1 charge readout for the HUD
    skid: 0,                             // 0..1 rear-lockup readout
    braking: false,

    // --- pump --------------------------------------------------------------
    pumpBudget: TUNING.pumpBudget,
    pumpCharge: 0,                       // 0..1 how loaded the current crouch is

    // --- air / tricks ------------------------------------------------------
    rotation: { yaw: 0, pitch: 0, roll: 0 },  // signed degrees since takeoff
    spinDeg: 0,                          // |rotation.yaw|
    flipDeg: 0,                          // |rotation.pitch|
    airLaunchSpeed: 0,
    airPeak: 0,                          // m above the launch height, for scoring/FX
    launchHeight: 0,
    trickRotating: false,

    // --- manual ------------------------------------------------------------
    balance: 0,                          // -1 (nose down) .. +1 (looping out)
    manualType: null,                    // 'manual'|'nose'|null

    // --- wallride ----------------------------------------------------------
    wall: { active: false, normal: new THREE.Vector3(), time: 0, point: new THREE.Vector3() },

    // --- grind hand-off ----------------------------------------------------
    rail: null,                          // the railHit grind.js handed us

    // --- bail / respawn ----------------------------------------------------
    bailReason: null,
    bailTimer: 0,
    lastSafe: { position: new THREE.Vector3(), yaw: 0, time: 0 },
    lastLand: { quality: 0, speed: 0, surface: 'ground' },
  };

  const collision = () => ctx.world?.collision;

  const probeF = makeProbe();
  const probeR = makeProbe();
  const probeC = makeProbe();
  const probes = [probeF, probeR, probeC];      // fixed array: iterating it allocates nothing

  // Persistent per-step scratch that must survive between helper calls.
  const angVel = new THREE.Vector3();        // local-space trick/air rotation, rad/s
  const trickInput = new THREE.Vector3();    // set by applyTrickRotation, consumed each step
  const bailSpin = new THREE.Vector3();
  const lastGroundNormal = new THREE.Vector3(0, 1, 0);

  let prevHop = false;
  let prevManual = false;
  let prevReset = false;
  let prevSteer = 0;
  let hopHoldTime = 0;
  let safeTimer = 0;
  let stallTimer = 0;
  let wallCooldown = 0;
  let takeoffTilt = 0;
  let balanceVel = 0;
  const noisePhase = rng() * 100;            // deterministic per-session wobble offset
  let noiseTime = 0;
  let trickRateThisStep = 0;
  let disposed = false;

  // ---------------------------------------------------------------- helpers

  function bodyAxes() {
    _right.set(1, 0, 0).applyQuaternion(state.quaternion);
    _up.set(0, 1, 0).applyQuaternion(state.quaternion);
    _fwd.set(0, 0, 1).applyQuaternion(state.quaternion);
  }

  /** Cast one wheel probe. `offset` is a world-space offset from the contact origin. */
  function probeAt(offset, out) {
    const col = collision();
    out.hit = false;
    out.usable = false;
    out.gap = Infinity;
    out.perp = Infinity;
    if (!col) return out;
    _probeOrigin.copy(state.position).add(offset);
    const baseY = _probeOrigin.y;
    _probeOrigin.y += T.probeUp;
    const h = col.raycastDown(_probeOrigin, T.probeUp + T.probeDown);
    if (!h || h.hit === false || !h.point) return out;
    out.hit = true;
    out.point.copy(h.point);
    if (h.normal) {
      out.normal.copy(h.normal);
      if (out.normal.lengthSq() < 1e-8) out.normal.set(0, 1, 0);
      else out.normal.normalize();
      if (out.normal.y < 0) out.normal.negate();
    } else {
      out.normal.set(0, 1, 0);
    }
    out.friction = typeof h.friction === 'number' ? h.friction : 1;
    out.surface = h.surface || 'ground';
    out.gap = baseY - out.point.y;
    // A vertical gap exaggerates badly on a steep transition; the perpendicular one is
    // what "how far off the surface is this wheel" actually means.
    out.perp = out.gap * out.normal.y;
    out.usable = out.normal.y > T.minGroundNormalY;
    return out;
  }

  /** Fire all three probes around the current position/orientation. */
  function sampleGround() {
    bodyAxes();
    _tmpA.copy(_fwd).multiplyScalar(T.wheelBase * 0.5);
    probeAt(_tmpA, probeF);
    _tmpA.negate();
    probeAt(_tmpA, probeR);
    _tmpA.set(0, 0, 0);
    probeAt(_tmpA, probeC);
  }

  /** Blend the probe normals that are actually near the ground into `state.surfaceNormal`. */
  function blendSurface(nearGap) {
    _n.set(0, 0, 0);
    let fr = 0;
    let count = 0;
    let type = null;
    for (let i = 0; i < probes.length; i++) {
      const p = probes[i];
      // Negative perp means the surface is ABOVE this wheel: a deck behind a coping,
      // a ledge overhead. Those are not the surface we are riding.
      if (!p.usable || p.perp > nearGap || p.perp < -T.contactBand) continue;
      _n.add(p.normal);
      fr += p.friction;
      if (!type) type = p.surface;
      count++;
    }
    if (count === 0) {
      _n.copy(lastGroundNormal);
      state.surfaceFriction = 1;
    } else {
      _n.divideScalar(count);
      if (_n.lengthSq() < 1e-8) _n.copy(WORLD_UP); else _n.normalize();
      state.surfaceFriction = fr / count;
      state.surfaceType = type || 'ground';
    }
    state.surfaceNormal.copy(_n);
    lastGroundNormal.copy(_n);
    state.surfaceTilt = Math.sqrt(Math.max(0, 1 - _n.y * _n.y));
  }

  /**
   * Build the chassis orientation that matches the current contacts and slerp to it.
   * Pitch comes from the two wheel contacts, roll from the surface normal, then the
   * cosmetic lean and manual pitch are layered on in local space.
   */
  function alignToSurface(fdt, lambda) {
    _up.copy(state.surfaceNormal);
    _fwd.set(Math.sin(state.yaw), 0, Math.cos(state.yaw));

    // Contact-fitted pitch: the flat heading has unit length in XZ, so the rise over
    // the wheelbase is exactly the tangent of the pitch angle.
    if (state.manualType === null && probeF.usable && probeR.usable &&
        Math.abs(probeF.perp) < T.contactBand && Math.abs(probeR.perp) < T.contactBand) {
      _fwd.y = clamp((probeF.point.y - probeR.point.y) / T.wheelBase, -1.7, 1.7);
      _fwd.normalize();
    }

    _right.crossVectors(_up, _fwd);
    if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0).applyQuaternion(state.quaternion);
    _right.normalize();
    _fwd.crossVectors(_right, _up).normalize();
    _basis.makeBasis(_right, _up, _fwd);
    _qTarget.setFromRotationMatrix(_basis);

    // Lean is a roll about the local forward axis; +lean means leaning right, and a
    // positive rotation about +Z tips the top of the bike left, hence the negation.
    if (Math.abs(state.lean) > 1e-4) {
      _qStep.setFromAxisAngle(AXIS_Z, -state.lean);
      _qTarget.multiply(_qStep);
    }
    // Manual pitch about the local right axis; +manualPitch is nose-up.
    const mp = manualPitchAngle();
    if (Math.abs(mp) > 1e-4) {
      _qStep.setFromAxisAngle(AXIS_X, -mp);
      _qTarget.multiply(_qStep);
    }
    state.quaternion.slerp(_qTarget, 1 - Math.exp(-lambda * fdt));
    state.quaternion.normalize();
  }

  /**
   * Launch direction for hops and lip pop: world-up blended toward the surface normal,
   * with the blend itself scaled by how flat the surface is. On a bank you launch out
   * of the transition; at a near-vertical lip you launch straight up, which is where
   * the rider's weight actually goes.
   */
  function hopDirection(out) {
    const n = state.surfaceNormal;
    out.copy(WORLD_UP).lerp(n, T.hopNormalBlend * clamp(n.y, 0, 1));
    if (out.lengthSq() < 1e-6) out.copy(WORLD_UP);
    else out.normalize();
    return out;
  }

  function manualPitchAngle() {
    if (state.manualType === 'manual') {
      return T.manualPitch + state.balance * T.manualPitchRange;
    }
    if (state.manualType === 'nose') {
      return -(T.manualPitch + state.balance * T.manualPitchRange) * 0.85;
    }
    return 0;
  }

  /**
   * Flatten the velocity into a surface plane. A rolling wheel following a curved
   * transition has its velocity ROTATED by the surface, not shortened — projecting
   * without this rescale bleeds ~5%/s of speed on a 3.6 m radius, which is the
   * difference between a pipe you can carve forever and one that stops you dead.
   * Large corrections (a real impact) are left un-rescaled.
   */
  function slideOnPlane(v, n) {
    const before = v.length();
    const into = v.dot(n);
    if (into >= 0) return;
    v.addScaledVector(n, -into);
    const after = v.length();
    if (after > 1e-4 && before / after < T.slideRestore) v.multiplyScalar(before / after);
  }

  /** Deterministic, allocation-free wobble used by the manual balance meter. */
  function wobble() {
    const t = noiseTime + noisePhase;
    return Math.sin(t * 1.73) * 0.62 + Math.sin(t * 0.51 + 1.7) * 0.38;
  }

  // ------------------------------------------------------------------ events

  function emit(type, detail) { ctx.emit?.(type, detail); }

  function reportWheelContacts(speed) {
    const f = probeF.usable && probeF.perp < T.groundAttach;
    const r = probeR.usable && probeR.perp < T.groundAttach;
    if (f && !state.contactFront) emit('wheelContact', { wheel: 'front', surface: probeF.surface, speed });
    if (r && !state.contactRear) emit('wheelContact', { wheel: 'rear', surface: probeR.surface, speed });
    state.contactFront = f;
    state.contactRear = r;
  }

  // ------------------------------------------------------------ mode changes

  function enterAir(popFromLip) {
    if (state.mode === 'air') return;
    state.mode = 'air';
    state.grounded = false;
    state.airTime = 0;
    state.manualType = null;
    state.balance = 0;
    state.launchHeight = state.position.y;
    state.airPeak = 0;
    state.airLaunchSpeed = state.speed;
    state.rotation.yaw = 0;
    state.rotation.pitch = 0;
    state.rotation.roll = 0;
    state.spinDeg = 0;
    state.flipDeg = 0;
    angVel.set(0, 0, 0);
    takeoffTilt = state.surfaceTilt;

    // Free pop off a lip: leaving a steep transition with speed throws you skyward,
    // which is what turns ~2 m of pure momentum air into the ~3 m the game wants.
    if (popFromLip && takeoffTilt > T.lipTiltMin) {
      const s01 = clamp(state.speed / T.maxSpeed, 0, 1);
      const pop = T.lipPop * s01 * clamp((takeoffTilt - T.lipTiltMin) / (1 - T.lipTiltMin), 0, 1);
      state.velocity.addScaledVector(hopDirection(_tmpA), pop);
    }
  }

  function doHop(power) {
    hopDirection(_tmpA);
    // On a near-vertical lip the rider has nothing to push against, so the hop only
    // keeps a fraction of its authority — this is what stops lip-hops going to orbit.
    power *= lerp(T.hopSteepScale, 1, clamp(state.surfaceNormal.y, 0, 1));
    // Remove any into-surface velocity first so a hop off a landing always leaves.
    const into = state.velocity.dot(state.surfaceNormal);
    if (into < 0) state.velocity.addScaledVector(state.surfaceNormal, -into);
    state.velocity.addScaledVector(_tmpA, power);
    enterAir(true);
    emit('hop', { power, charge: state.hopCharge, surface: state.surfaceType });
    state.hopCharge = 0;
    state.crouch = 0;
    state.pumpCharge = 0;
  }

  function doPump(charge) {
    if (state.pumpBudget < 0.35) return;
    const tilt = state.surfaceTilt;
    if (tilt < T.pumpMinTilt) return;
    const cost = 0.6 + charge * 0.6;
    const use = Math.min(cost, state.pumpBudget);
    state.pumpBudget -= use;
    const gain = T.pumpGain * charge * clamp((tilt - T.pumpMinTilt) / (1 - T.pumpMinTilt), 0, 1) * (use / cost);
    if (gain < 0.05) return;
    bodyAxes();
    _tmpA.copy(_fwd).addScaledVector(state.surfaceNormal, -_fwd.dot(state.surfaceNormal));
    if (_tmpA.lengthSq() < 1e-6) return;
    _tmpA.normalize();
    const dir = state.forwardSpeed < -0.2 ? -1 : 1;   // pumping backwards down a wall still works
    state.velocity.addScaledVector(_tmpA, gain * dir);
    emit('pump', { gain, tilt, budget: state.pumpBudget });
  }

  function bail(reason) {
    if (state.mode === 'bail') return;
    state.mode = 'bail';
    state.bailReason = reason;
    state.bailTimer = 0;
    state.grounded = false;
    state.manualType = null;
    state.balance = 0;
    state.rail = null;
    state.wall.active = false;
    state.hopCharge = 0;
    state.crouch = 0;
    stallTimer = 0;
    // Seed the tumble from the crash itself so it is deterministic and reads as a
    // consequence of the impact rather than a random flail.
    const s = clamp(state.speed / T.maxSpeed, 0.25, 1.4);
    bailSpin.set(
      -T.bailSpin * s * (0.55 + 0.45 * Math.sin(noiseTime * 3.1 + noisePhase)),
      T.bailSpin * 0.45 * s * Math.sin(noiseTime * 1.7 + noisePhase * 0.5),
      T.bailSpin * 0.35 * s * Math.cos(noiseTime * 2.3 + noisePhase),
    );
    state.velocity.y = Math.max(state.velocity.y, 1.4);
    emit('bail', { reason, speed: state.speed });
  }

  function land(hitSurface, quality, impact) {
    const airTime = state.airTime;
    const speed = state.velocity.length();
    state.mode = 'ride';
    state.grounded = true;
    state.airTime = 0;
    state.speed = speed;
    state.wall.active = false;
    state.compression = clamp(impact / T.landCompression, 0, 1);
    state.lastLand.quality = quality;
    state.lastLand.speed = speed;
    state.lastLand.surface = hitSurface;
    angVel.set(0, 0, 0);
    trickInput.set(0, 0, 0);
    stallTimer = 0;
    emit('land', { quality, speed, surface: hitSurface, airTime, impact, peak: state.airPeak });
  }

  // ------------------------------------------------------------- ground step

  function groundForces(fdt, input) {
    const inp = input.state;
    bodyAxes();
    _n.copy(state.surfaceNormal);

    // Surface-plane basis: forward along the ground, right across it.
    _tmpA.copy(_fwd).addScaledVector(_n, -_fwd.dot(_n));
    if (_tmpA.lengthSq() < 1e-6) {
      _tmpA.set(Math.sin(state.yaw), 0, Math.cos(state.yaw));
      _tmpA.addScaledVector(_n, -_tmpA.dot(_n));
    }
    _tmpA.normalize();
    _tmpB.crossVectors(_n, _tmpA);           // right, in the surface plane

    let vFwd = state.velocity.dot(_tmpA);
    let vLat = state.velocity.dot(_tmpB);
    // Same curvature-vs-impact rule as slideOnPlane: re-basing onto a surface that has
    // rotated under us must not shorten the velocity.
    const vLen = state.velocity.length();
    const tanLen = Math.hypot(vFwd, vLat);
    if (tanLen > 1e-4 && vLen / tanLen < T.slideRestore) {
      const k = vLen / tanLen;
      vFwd *= k; vLat *= k;
    }
    const frict = clamp(state.surfaceFriction, 0.25, 1.4);
    const speedAbs = Math.abs(vFwd);

    // --- brake / lockup ---
    const braking = inp.brake > 0.02 && state.manualType === null;
    state.braking = braking;
    if (braking) {
      const dec = T.brakeDecel * inp.brake * clamp(frict, 0.35, 1.2);
      vFwd = moveTowards(vFwd, 0, dec * fdt);
      if (inp.brake > T.lockupBrake && speedAbs > T.skidMinSpeed) {
        const amount = clamp(speedAbs / 9, 0, 1) * inp.brake;
        if (state.skid < 0.05 && amount > 0.2) emit('skid', { amount, surface: state.surfaceType });
        state.skid = Math.max(state.skid, amount);
      }
    }

    // --- pedal ---
    let a = 0;
    if (inp.throttle > 0.02 && !braking) {
      const t = clamp(vFwd / (T.maxSpeed * T.pedalTopFactor), 0, 1);
      a += inp.throttle * T.pedalAccel * (1 - Math.pow(t, T.pedalFalloff)) * clamp(frict * 1.15, 0.45, 1.1);
    }

    // --- drag: quadratic coast + constant rolling resistance ---
    a -= T.coastDrag * vFwd * Math.abs(vFwd);
    vFwd = moveTowards(vFwd, 0, T.rollResist * frict * fdt);

    // --- gravity projected into the surface tangent (the whole transition game) ---
    _tmpC.set(0, -T.gravity, 0);
    _tmpC.addScaledVector(_n, -_tmpC.dot(_n));
    const gFwd = _tmpC.dot(_tmpA);
    const gLat = _tmpC.dot(_tmpB);

    vFwd += (a + gFwd) * fdt;
    vLat += gLat * fdt;

    // --- lateral grip: how hard the tyres refuse to slide sideways ---
    const grip = T.maxLatAccel * frict * (state.skid > 0.05 ? T.skidGrip : 1);
    vLat = moveTowards(vLat, 0, grip * fdt);

    // Hard clamp so a long drop-in cannot run away with the integrator.
    const total = Math.hypot(vFwd, vLat);
    if (total > T.speedHardCap) {
      const k = T.speedHardCap / total;
      vFwd *= k; vLat *= k;
    }

    state.velocity.copy(_tmpA).multiplyScalar(vFwd).addScaledVector(_tmpB, vLat);
    state.forwardSpeed = vFwd;
    state.lateralSpeed = vLat;

    // Self-aligning torque: the heading is pulled toward the real travel direction, so
    // a slide scrubs off instead of the bike ice-skating sideways forever.
    if (Math.abs(vLat) > 0.05 && speedAbs > 0.5) {
      const slip = Math.atan2(vLat, Math.max(speedAbs, 0.6)) * (vFwd < 0 ? -1 : 1);
      state.yaw = wrapAngle(state.yaw + slip * T.selfAlign * fdt);
    }
  }

  function groundSteer(fdt, input) {
    const inp = input.state;
    state.steer = damp(state.steer, clamp(inp.steer, -1, 1), T.steerLambda, fdt);
    const steerRate = (state.steer - prevSteer) / Math.max(fdt, 1e-5);
    prevSteer = state.steer;

    const spd = Math.abs(state.forwardSpeed);
    const gripCap = (T.maxLatAccel * clamp(state.surfaceFriction, 0.3, 1.3)) / Math.max(spd, 0.75);
    let yawRate = state.steer * Math.min(T.maxYawRate, gripCap);
    yawRate *= lerp(0.28, 1, clamp(spd / T.pivotSpeed, 0, 1));
    if (state.skid > 0.05) yawRate *= 1 + state.skid * 0.55;     // locked rear steps out
    if (state.forwardSpeed < -0.1) yawRate = -yawRate;           // rolling backwards reverses the geometry
    state.yaw = wrapAngle(state.yaw + yawRate * fdt);

    // Lean into the corner from the actual lateral acceleration, with a short burst of
    // counter-lean fed from the steering rate — the flick you see on turn initiation.
    let leanTarget = Math.atan2(state.forwardSpeed * yawRate, T.gravity);
    leanTarget -= steerRate * T.counterSteer * clamp(spd / 6, 0, 1);
    leanTarget = clamp(leanTarget, -T.maxLean, T.maxLean);
    if (state.manualType) leanTarget *= 0.45;
    state.lean = damp(state.lean, leanTarget, T.leanLambda, fdt);
  }

  function groundHopAndPump(fdt, input) {
    const hopHeld = input.held('hop') && state.mode !== 'bail';
    const pressed = hopHeld && !prevHop;
    const released = !hopHeld && prevHop;

    if (pressed) hopHoldTime = 0;
    if (hopHeld) {
      hopHoldTime += fdt;
      state.hopCharge = clamp(hopHoldTime / T.hopChargeTime, 0, 1);
      state.pumpCharge = state.hopCharge;
      state.crouch = damp(state.crouch, T.crouchMax * state.hopCharge, 14, fdt);
    } else {
      state.crouch = damp(state.crouch, 0, 12, fdt);
    }

    if (released) {
      const charge = state.hopCharge;
      const onTransition = state.surfaceTilt > T.pumpMinTilt;
      if (onTransition) doPump(clamp(charge + 0.25, 0, 1));
      // A quick tap on a transition is a pump only; anything longer also launches you.
      const tapOnly = onTransition && hopHoldTime < T.pumpTapTime;
      if (!tapOnly) {
        const p = lerp(T.hopMin, T.hopMax, charge * charge * (3 - 2 * charge));
        doHop(p);
      } else {
        state.hopCharge = 0;
        state.pumpCharge = 0;
      }
      hopHoldTime = 0;
    }
    prevHop = hopHeld;
    state.pumpBudget = Math.min(T.pumpBudget, state.pumpBudget + T.pumpRefill * fdt);
  }

  function groundManual(fdt, input) {
    const inp = input.state;
    const held = input.held('manual');
    const pressed = held && !prevManual;
    prevManual = held;

    if (state.manualType === null) {
      if (pressed && state.grounded && state.speed > T.manualMinSpeed) {
        state.manualType = inp.lean < -0.3 ? 'nose' : 'manual';
        // Seed off-centre (which way depends on the wobble at that instant) so the
        // pendulum actually has something to diverge from.
        state.balance = T.balanceSeed * (wobble() >= 0 ? 1 : -1);
        balanceVel = 0;
        state.mode = 'manual';
      }
      return;
    }

    if (!held || state.speed < T.manualMinSpeed * 0.6) {
      state.manualType = null;
      state.balance = 0;
      balanceVel = 0;
      if (state.mode === 'manual') state.mode = 'ride';
      return;
    }

    state.mode = 'manual';
    // Inverted pendulum: divergence grows with the current lean, speed helps you hold
    // it, and input.lean is the only thing pushing back.
    const aid = 1 - T.balanceSpeedAid * clamp(state.speed / T.maxSpeed, 0, 1);
    const sign = state.manualType === 'nose' ? -1 : 1;
    const drive = clamp(inp.lean, -1, 1) * sign;
    let acc = T.balanceGravity * aid * state.balance;
    acc += drive * T.balanceInput;
    acc += wobble() * T.balanceDrift * (0.4 + 0.6 * clamp(1 - state.speed / T.maxSpeed, 0, 1));
    balanceVel += acc * fdt;
    balanceVel -= balanceVel * clamp(T.balanceDamp * fdt, 0, 1);
    state.balance = clamp(state.balance + balanceVel * fdt, -1.4, 1.4);
    if (Math.abs(state.balance) >= T.balanceBailAt) {
      bail(state.manualType === 'nose' ? 'nosedive' : 'looped');
    }
  }

  /**
   * Height the contact origin should sit at for the current probe set, or NaN when no
   * wheel is anywhere near the ground. Both wheels down gives the chord between the
   * contacts (so a concave transition is followed, not skimmed); the centre probe
   * lifts that back up over convex crests; a manual pivots about the single contact.
   */
  function contactTargetY() {
    const band = T.contactBand;
    const fUse = probeF.usable && Math.abs(probeF.perp) < band;
    const rUse = probeR.usable && Math.abs(probeR.perp) < band;
    const cUse = probeC.usable && Math.abs(probeC.perp) < band;
    const half = T.wheelBase * 0.5;

    let y = NaN;
    if (state.manualType === 'manual' && rUse) {
      y = probeR.point.y + Math.sin(Math.abs(manualPitchAngle())) * half;
    } else if (state.manualType === 'nose' && fUse) {
      y = probeF.point.y + Math.sin(Math.abs(manualPitchAngle())) * half;
    } else if (fUse && rUse) {
      // Both wheels down: the frame rides the chord between the contacts, lifted back
      // up by the centre probe over a convex crest.
      y = (probeF.point.y + probeR.point.y) * 0.5;
      if (cUse) y = Math.max(y, probeC.point.y);
    } else if (rUse || fUse) {
      // One wheel down (front over a lip, rear off the back of a ledge): the frame
      // stays on that contact's tangent plane instead of nose-diving at the edge.
      const p = rUse ? probeR : probeF;
      const s = -(p.normal.x * Math.sin(state.yaw) + p.normal.z * Math.cos(state.yaw)) /
        Math.max(p.normal.y, 0.15);
      y = p.point.y + (rUse ? half : -half) * clamp(s, -3, 3);
      if (cUse) y = Math.max(y, probeC.point.y);
    } else if (cUse) {
      y = probeC.point.y;
    }
    return Number.isNaN(y) ? NaN : y + T.contactLift;
  }

  /** Snap the contact origin onto the contact plane and kill the into-surface velocity. */
  function resolveContact(fdt) {
    const targetY = contactTargetY();
    if (Number.isNaN(targetY)) return false;

    // The attach distance is perpendicular to the surface, so convert it to the
    // vertical measure this comparison works in.
    const gap = state.position.y - targetY;
    if (gap > T.groundAttach / Math.max(state.surfaceNormal.y, 0.2)) return false;
    if (gap < 0) state.position.y = targetY;                              // never penetrate
    else state.position.y = damp(state.position.y, targetY, 34, fdt);     // settle without popping

    // Crest release: the wheels can push, never pull. If the contact plane has turned
    // away from where we are already travelling — the deck behind a coping, the lip of
    // a funbox — nothing can hold the bike down and it launches with the speed it had.
    if (state.velocity.dot(state.surfaceNormal) > T.crestRelease) return false;

    slideOnPlane(state.velocity, state.surfaceNormal);
    return true;
  }

  function stepGround(fdt, input) {
    groundHopAndPump(fdt, input);
    if (state.mode === 'air' || state.mode === 'bail') return;   // the hop took us off the ground
    groundManual(fdt, input);
    if (state.mode === 'bail') return;
    groundSteer(fdt, input);
    groundForces(fdt, input);

    // Substep the integration so 14 m/s never steps further than a wheel radius.
    const dist = state.velocity.length() * fdt;
    const steps = dist > 0.25 ? Math.min(6, Math.ceil(dist / 0.25)) : 1;
    const sdt = fdt / steps;
    let stillGrounded = true;
    for (let i = 0; i < steps; i++) {
      state.position.addScaledVector(state.velocity, sdt);
      sampleGround();
      blendSurface(T.groundAttach + 0.6);
      stillGrounded = resolveContact(sdt);
      if (!stillGrounded) break;
    }

    if (!stillGrounded) {
      state.grounded = false;
      enterAir(true);
      return;
    }

    state.grounded = true;
    alignToSurface(fdt, T.orientLambda);
    reportWheelContacts(state.speed);

    // Stalling out on a steep transition is a bail, not a slow slide back down.
    if (state.surfaceTilt > T.stallTilt && state.speed < T.stallSpeed) {
      stallTimer += fdt;
      if (stallTimer > T.stallTime) { bail('stall'); return; }
    } else {
      stallTimer = 0;
    }

    // Remember somewhere sane to put the rider back after a crash.
    safeTimer += fdt;
    if (safeTimer > T.safeInterval && state.surfaceTilt < T.safeMaxTilt && state.speed > 0.8 &&
        state.manualType === null) {
      safeTimer = 0;
      state.lastSafe.position.copy(state.position);
      state.lastSafe.yaw = state.speed > 1.5
        ? Math.atan2(state.velocity.x, state.velocity.z)
        : state.yaw;
      state.lastSafe.time = ctx.time?.elapsed ?? 0;
    }
  }

  // ---------------------------------------------------------------- air step

  /**
   * Settle pitch and roll toward the surface the bike is falling onto (world level if
   * there is nothing under it), leaving the heading alone — the player still owns yaw.
   */
  function levelInAir(fdt, strength) {
    const col = collision();
    bodyAxes();                       // fills _fwd/_up/_right — take the target up separately
    _tmpA.set(0, 1, 0);
    if (col) {
      _probeOrigin.copy(state.position);
      _probeOrigin.y += 0.2;
      const h = col.raycastDown(_probeOrigin, T.airLevelReach);
      if (h && h.hit !== false && h.normal && h.normal.y > T.minGroundNormalY) {
        _tmpA.copy(h.normal).normalize();
      }
    }
    _tmpB.copy(_fwd).addScaledVector(_tmpA, -_fwd.dot(_tmpA));
    if (_tmpB.lengthSq() < 1e-3) {
      // Pointing straight up or down: fall back to the direction of travel.
      _tmpB.set(state.velocity.x, 0, state.velocity.z);
      if (_tmpB.lengthSq() < 1e-3) _tmpB.set(Math.sin(state.yaw), 0, Math.cos(state.yaw));
      _tmpB.addScaledVector(_tmpA, -_tmpB.dot(_tmpA));
      if (_tmpB.lengthSq() < 1e-3) return;
    }
    _tmpB.normalize();
    _right.crossVectors(_tmpA, _tmpB);
    if (_right.lengthSq() < 1e-6) return;
    _right.normalize();
    _tmpC.crossVectors(_right, _tmpA).normalize();
    _basis.makeBasis(_right, _tmpA, _tmpC);
    _qTarget.setFromRotationMatrix(_basis);
    state.quaternion.slerp(_qTarget, 1 - Math.exp(-T.airLevelLambda * strength * fdt));
    state.quaternion.normalize();
  }

  function stepAir(fdt, input) {
    const inp = input.state;
    state.airTime += fdt;
    state.crouch = damp(state.crouch, input.held('hop') ? T.crouchMax * 0.6 : 0, 10, fdt);

    // --- rotation: player nudge + whatever the trick system is driving --------
    const auth = clamp(state.airTime / T.airControlFade, 0, 1);
    const trickMag = trickInput.length();
    trickRateThisStep = trickMag;
    state.trickRotating = trickMag > 0.05;
    const nudgeYaw = clamp(inp.steer, -1, 1) * T.airYawRate * auth * (state.trickRotating ? 0.25 : 1);
    // Local +X rotation pitches the nose down, so leaning back (+) has to negate.
    const nudgePitch = -clamp(inp.lean, -1, 1) * T.airPitchRate * auth * (state.trickRotating ? 0.25 : 1);

    angVel.x = damp(angVel.x, trickInput.x + nudgePitch, T.spinAssistLambda * 4, fdt);
    angVel.y = damp(angVel.y, trickInput.y + nudgeYaw, T.spinAssistLambda * 4, fdt);
    angVel.z = damp(angVel.z, trickInput.z, T.spinAssistLambda, fdt);
    const mag = angVel.length();
    if (mag > T.maxTrickRate) angVel.multiplyScalar(T.maxTrickRate / mag);
    trickInput.set(0, 0, 0);

    if (Math.abs(angVel.x) > 1e-5) {
      _qStep.setFromAxisAngle(AXIS_X, angVel.x * fdt); state.quaternion.multiply(_qStep);
    }
    if (Math.abs(angVel.y) > 1e-5) {
      _qStep.setFromAxisAngle(AXIS_Y, angVel.y * fdt); state.quaternion.multiply(_qStep);
    }
    if (Math.abs(angVel.z) > 1e-5) {
      _qStep.setFromAxisAngle(AXIS_Z, angVel.z * fdt); state.quaternion.multiply(_qStep);
    }
    state.quaternion.normalize();

    state.rotation.pitch += angVel.x * fdt * RAD2DEG;
    state.rotation.yaw += angVel.y * fdt * RAD2DEG;
    state.rotation.roll += angVel.z * fdt * RAD2DEG;
    state.spinDeg = Math.abs(state.rotation.yaw);
    state.flipDeg = Math.abs(state.rotation.pitch);

    // A rider does not fly off a lip nose-high and stay that way — once nothing is
    // driving a trick, the bike settles level with whatever is coming up underneath.
    if (!state.trickRotating && state.airTime > T.airLevelDelay) {
      const strength = clamp((state.airTime - T.airLevelDelay) / 0.35, 0, 1) *
        (1 - 0.7 * clamp(Math.abs(inp.lean), 0, 1));
      if (strength > 0.01) levelInAir(fdt, strength);
    }

    // --- ballistics ----------------------------------------------------------
    state.velocity.y -= T.gravity * fdt;
    const sp = state.velocity.length();
    if (sp > 0.01) state.velocity.addScaledVector(state.velocity, -T.airDrag * sp * fdt);

    // Steer the velocity itself a little so the player can pull a landing in.
    if (Math.abs(inp.steer) > 0.05) {
      const a = clamp(inp.steer, -1, 1) * T.airVelSteer * auth * fdt;
      const cs = Math.cos(a), sn = Math.sin(a);
      const vx = state.velocity.x, vz = state.velocity.z;
      state.velocity.x = vx * cs + vz * sn;
      state.velocity.z = -vx * sn + vz * cs;
    }

    // --- integrate, substepped, checking for touchdown each substep ----------
    const dist = state.velocity.length() * fdt;
    const steps = dist > 0.25 ? Math.min(6, Math.ceil(dist / 0.25)) : 1;
    const sdt = fdt / steps;
    for (let i = 0; i < steps; i++) {
      state.position.addScaledVector(state.velocity, sdt);
      state.airPeak = Math.max(state.airPeak, state.position.y - state.launchHeight);
      sampleGround();
      if (tryLand(sdt)) return;
      if (handleWalls(sdt, true)) return;
    }
  }

  /**
   * Touchdown test + clean/bail decision. Returns true once the mode has changed.
   * Only standable probes count: near-vertical faces are wall business (handleWalls),
   * not landings, which is what lets you leave a transition lip without "landing" on
   * the last few degrees of it.
   */
  function tryLand(fdt) {
    let p = null;
    let best = Infinity;
    for (let i = 0; i < probes.length; i++) {
      const q = probes[i];
      if (!q.usable || q.perp > T.landSnap || q.perp < -0.35) continue;
      if (q.perp < best) { p = q; best = q.perp; }
    }
    if (!p) return false;

    const closing = -state.velocity.dot(p.normal);
    _n.copy(p.normal);
    if (state.airTime < T.landGrace && closing < T.landGraceClosing) return false;
    if (closing < 0.25) {
      // Skimming along the surface — leaving a lip looks exactly like this. Only push
      // out if we are genuinely inside the geometry (the chord of a tight transition
      // naturally sits a few cm under the arc, so the threshold is generous).
      if (best < -0.14) state.position.addScaledVector(_n, -best - 0.14);
      return false;
    }

    bodyAxes();

    // Dropping onto the coping edge is a bail, not a landing.
    if (p.surface === 'coping') { bail('coping'); return true; }
    if (probeF.usable && probeR.usable &&
        (probeF.point.y - probeR.point.y) > T.copingStep && closing > 3.5) {
      bail('coping');
      return true;
    }
    if (closing > T.maxImpactSpeed) { bail('slam'); return true; }

    // Alignment: a perfectly landed bike has forward and right both perpendicular to
    // the surface normal, and travels where it points.
    const pitchErr = Math.asin(clamp(_fwd.dot(_n), -1, 1));
    const rollErr = Math.asin(clamp(_right.dot(_n), -1, 1));
    const upDot = _up.dot(_n);

    _tmpA.copy(state.velocity).addScaledVector(_n, -state.velocity.dot(_n));
    _tmpB.copy(_fwd).addScaledVector(_n, -_fwd.dot(_n));
    let yawErr = 0;
    if (_tmpA.lengthSq() > 1.0 && _tmpB.lengthSq() > 1e-4) {
      _tmpA.normalize(); _tmpB.normalize();
      yawErr = Math.acos(clamp(_tmpA.dot(_tmpB), -1, 1));
      if (yawErr > Math.PI * 0.5) yawErr = Math.PI - yawErr;    // landing fakie is legal
    }

    if (upDot < 0.35 ||
        Math.abs(pitchErr) > T.landPitchTol ||
        Math.abs(rollErr) > T.landRollTol ||
        yawErr > T.landYawTol) {
      bail('angle');
      return true;
    }

    const q = clamp(1 - Math.max(
      Math.abs(pitchErr) / T.landPitchTol,
      Math.abs(rollErr) / T.landRollTol,
      yawErr / T.landYawTol,
    ), 0, 1);

    // Put the wheels on the ground and convert the landing.
    state.surfaceNormal.copy(_n);
    lastGroundNormal.copy(_n);
    state.surfaceFriction = p.friction;
    state.surfaceType = p.surface;
    state.surfaceTilt = Math.sqrt(Math.max(0, 1 - _n.y * _n.y));
    const ty = contactTargetY();
    state.position.y = Number.isNaN(ty) ? p.point.y + T.contactLift : ty;

    _tmpA.copy(state.velocity).addScaledVector(_n, -state.velocity.dot(_n));   // tangential
    const tanSpeed = _tmpA.length();
    // Steep transitions give the slam back as roll-out speed; flat ground eats it.
    const convert = closing * T.landNormalToTangent * state.surfaceTilt * q;
    let newSpeed = (tanSpeed + convert) * lerp(T.landSpeedKeep, 1, q);
    newSpeed = Math.min(newSpeed, T.speedHardCap);

    if (tanSpeed > 0.05) _tmpA.multiplyScalar(newSpeed / tanSpeed);
    else _tmpA.set(0, 0, 0);
    state.velocity.copy(_tmpA);

    // Heading snaps toward the direction of travel in proportion to how clean it was.
    bodyAxes();
    let yawFromBody = Math.atan2(_fwd.x, _fwd.z);
    if (state.velocity.lengthSq() > 1.5) {
      const yawFromVel = Math.atan2(state.velocity.x, state.velocity.z);
      yawFromBody = yawFromBody + wrapAngle(yawFromVel - yawFromBody) * (0.35 + 0.4 * q);
    }
    state.yaw = wrapAngle(yawFromBody);
    state.lean = clamp(state.lean, -T.maxLean, T.maxLean);

    land(p.surface, q, closing);
    return true;
  }

  // ------------------------------------------------------------------- walls

  /**
   * Forward sweep for near-vertical geometry. Either starts a wallride, bails a
   * head-on smash, or just stops the bike passing through the surface.
   * Returns true if the mode changed.
   */
  function handleWalls(fdt, inAir) {
    const col = collision();
    if (!col?.sweepSphere) return false;
    if (wallCooldown > 0) wallCooldown -= fdt;
    const speed = state.velocity.length();
    if (speed < 1.0) return false;
    // Riding a steep transition already puts near-vertical geometry in front of the
    // sweep; the ground probes own that case, so stay out of it.
    if (!inAir && state.surfaceTilt > 0.45) return false;

    _tmpA.copy(state.velocity).divideScalar(speed);
    _sweepFrom.copy(state.position).addScaledVector(WORLD_UP, T.wallProbeUp);
    _sweepTo.copy(_sweepFrom).addScaledVector(_tmpA, T.wallProbeDist + speed * fdt);
    const h = col.sweepSphere(_sweepFrom, _sweepTo, T.wallProbeRadius);
    if (!h || h.hit === false || !h.normal) return false;

    _n.copy(h.normal);
    if (_n.lengthSq() < 1e-8) return false;
    _n.normalize();
    if (Math.abs(_n.y) > T.wallMaxNormalY) return false;      // floor or ceiling, not a wall
    const approach = -_tmpA.dot(_n);
    if (approach <= 0.02) return false;

    if (approach > T.wallHeadOn && speed > T.wallBailSpeed) { bail('wall'); return true; }

    if (wallCooldown <= 0 && speed > T.wallMinSpeed && approach < T.wallHeadOn) {
      enterWall(h);
      return true;
    }

    // Otherwise just resolve the contact: push out and remove the inward velocity.
    const depth = typeof h.depth === 'number' ? Math.max(h.depth, 0) : 0;
    state.position.addScaledVector(_n, depth + 0.01);
    const into = state.velocity.dot(_n);
    if (into < 0) state.velocity.addScaledVector(_n, -into * (inAir ? 1.0 : 1.15));
    return false;
  }

  function enterWall(hit) {
    state.mode = 'wallride';
    state.wall.active = true;
    state.wall.time = 0;
    state.wall.normal.copy(_n);
    if (hit.point) state.wall.point.copy(hit.point);
    state.grounded = false;
    state.manualType = null;
    // Kill the into-wall component; everything else is preserved so you keep flying.
    const into = state.velocity.dot(_n);
    if (into < 0) state.velocity.addScaledVector(_n, -into);
    emit('wallride', {
      speed: state.velocity.length(),
      nx: state.wall.normal.x, ny: state.wall.normal.y, nz: state.wall.normal.z,
    });
  }

  function exitWall(pop) {
    state.wall.active = false;
    wallCooldown = T.wallCooldown;
    if (pop) state.velocity.addScaledVector(state.wall.normal, T.wallExitPop);
    state.mode = 'air';
    state.grounded = false;
    state.airTime = 0;
    state.launchHeight = state.position.y;
    state.airPeak = 0;
    state.rotation.yaw = 0; state.rotation.pitch = 0; state.rotation.roll = 0;
    state.spinDeg = 0; state.flipDeg = 0;
    angVel.set(0, 0, 0);
  }

  function stepWall(fdt, input) {
    const col = collision();
    state.wall.time += fdt;
    _n.copy(state.wall.normal);

    // Stay glued: sweep sideways into the wall to re-find it every step.
    let contact = false;
    if (col?.sweepSphere) {
      _sweepFrom.copy(state.position).addScaledVector(WORLD_UP, T.wallProbeUp).addScaledVector(_n, 0.35);
      _sweepTo.copy(_sweepFrom).addScaledVector(_n, -(0.35 + T.wallProbeDist));
      const h = col.sweepSphere(_sweepFrom, _sweepTo, T.wallProbeRadius * 0.7);
      if (h && h.hit !== false && h.normal) {
        _tmpC.copy(h.normal);
        if (_tmpC.lengthSq() > 1e-8) {
          _tmpC.normalize();
          if (Math.abs(_tmpC.y) < T.wallMaxNormalY) {
            state.wall.normal.copy(_tmpC);
            _n.copy(_tmpC);
            if (h.point) {
              state.wall.point.copy(h.point);
              const off = _tmpB.copy(state.position).sub(h.point).dot(_n);
              state.position.addScaledVector(_n, (0.03 - off) * clamp(12 * fdt, 0, 1));
            }
            contact = true;
          }
        }
      }
    }

    const speed = state.velocity.length();
    const hopHeld = input.held('hop');
    const hopTapped = hopHeld && !prevHop;
    prevHop = hopHeld;
    if (!contact || state.wall.time > T.wallMaxTime || speed < 4.0 || hopTapped) {
      exitWall(true);
      return;
    }

    // Gravity along the wall, damped — that reduction is what a wallride buys you.
    _tmpA.set(0, -T.gravity * T.wallGravityScale, 0);
    _tmpA.addScaledVector(_n, -_tmpA.dot(_n));
    state.velocity.addScaledVector(_tmpA, fdt);
    state.velocity.addScaledVector(_n, -T.wallStick * fdt);
    const into = state.velocity.dot(_n);
    if (into > 0) state.velocity.addScaledVector(_n, -into);      // never drift off the face
    if (speed > 0.01) state.velocity.addScaledVector(state.velocity, -T.airDrag * speed * fdt);

    state.position.addScaledVector(state.velocity, fdt);

    // Orientation: up is the wall normal, forward follows travel across the face.
    _up.copy(_n);
    _tmpB.copy(state.velocity).addScaledVector(_up, -state.velocity.dot(_up));
    if (_tmpB.lengthSq() < 1e-4) { bodyAxes(); _tmpB.copy(_fwd); }
    _tmpB.normalize();
    _right.crossVectors(_up, _tmpB);
    if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0);
    _right.normalize();
    _fwd.crossVectors(_right, _up).normalize();
    _basis.makeBasis(_right, _up, _fwd);
    _qTarget.setFromRotationMatrix(_basis);
    state.quaternion.slerp(_qTarget, 1 - Math.exp(-T.orientLambdaAir * fdt));
    state.quaternion.normalize();
    state.yaw = Math.atan2(_fwd.x, _fwd.z);

    // Ground under the wall wins — running out of wall drops you back onto the park.
    sampleGround();
    if ((probeC.usable && probeC.perp < T.landSnap) || (probeR.usable && probeR.perp < T.landSnap)) {
      exitWall(false);
      tryLand(fdt);
    }
  }

  // ------------------------------------------------------------------- bail

  function stepBail(fdt, input) {
    state.bailTimer += fdt;
    state.crouch = damp(state.crouch, 0, 8, fdt);
    state.velocity.y -= T.gravity * fdt;

    const dist = state.velocity.length() * fdt;
    const steps = dist > 0.25 ? Math.min(6, Math.ceil(dist / 0.25)) : 1;
    const sdt = fdt / steps;
    for (let i = 0; i < steps; i++) {
      state.position.addScaledVector(state.velocity, sdt);
      sampleGround();
      const p = probeC.hit ? probeC : (probeR.hit ? probeR : probeF);
      if (p.hit && state.position.y - p.point.y < 0.08) {
        state.position.y = p.point.y + 0.08;
        const n = p.normal;
        const into = state.velocity.dot(n);
        if (into < 0) {
          state.velocity.addScaledVector(n, -into * (1 + T.bailBounce));
          bailSpin.multiplyScalar(0.55);
        }
        // Scrub the tumble along the ground.
        _tmpA.copy(state.velocity).addScaledVector(n, -state.velocity.dot(n));
        const tan = _tmpA.length();
        if (tan > 0.001) {
          const drop = Math.min(tan, T.bailFriction * sdt);
          state.velocity.addScaledVector(_tmpA, -drop / tan);
        }
      }
    }

    _qStep.setFromAxisAngle(AXIS_X, bailSpin.x * fdt); state.quaternion.multiply(_qStep);
    _qStep.setFromAxisAngle(AXIS_Y, bailSpin.y * fdt); state.quaternion.multiply(_qStep);
    _qStep.setFromAxisAngle(AXIS_Z, bailSpin.z * fdt); state.quaternion.multiply(_qStep);
    state.quaternion.normalize();
    bailSpin.multiplyScalar(1 - clamp(1.1 * fdt, 0, 1));

    const done = state.bailTimer > T.bailControlTime &&
      (state.velocity.lengthSq() < T.bailRestSpeed * T.bailRestSpeed || state.bailTimer > T.bailMaxTime);
    if (done) respawnToSafe();
    prevHop = input.held('hop');
  }

  function respawnToSafe() {
    const reason = state.bailReason;
    api.respawn(state.lastSafe);
    state.bailReason = null;
    emit('respawn', { reason });
  }

  // -------------------------------------------------------------- derived

  function updateDerived(fdt) {
    bodyAxes();
    state.forward.copy(_fwd);
    state.up.copy(_up);
    state.right.copy(_right);
    state.speed = state.velocity.length();
    state.forwardSpeed = state.velocity.dot(_fwd);
    state.lateralSpeed = state.velocity.dot(_right);
    state.verticalSpeed = state.velocity.y;
    state.pitch = Math.asin(clamp(_fwd.y, -1, 1));
    state.roll = Math.atan2(_right.y, _up.y);
    state.compression = damp(state.compression, 0, T.compressionLambda, fdt);
    state.skid = Math.max(0, state.skid - T.skidDecay * fdt);
    if (state.mode !== 'air' && state.mode !== 'bail') {
      state.rotation.yaw = 0; state.rotation.pitch = 0; state.rotation.roll = 0;
      state.spinDeg = 0; state.flipDeg = 0;
      state.trickRotating = false;
    }
    // Wheel/crank motion for the animator; the wheels keep spinning down in the air.
    state.wheelSpin = state.grounded
      ? state.forwardSpeed / T.wheelRadius
      : state.wheelSpin * (1 - 0.35 * fdt);
    state.crank = (state.crank + (state.wheelSpin / T.crankRatio) * fdt) % (Math.PI * 2);
  }

  function sanityCheck() {
    const p = state.position, v = state.velocity;
    if (Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z) &&
        Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z) &&
        Number.isFinite(state.quaternion.x) && Number.isFinite(state.quaternion.w)) {
      // Fell out of the world: treat it as a bail-respawn rather than losing the player.
      const bounds = ctx.world?.park?.bounds;
      const floor = bounds?.min?.y ?? -40;
      if (p.y > floor - 30) return;
    }
    state.velocity.set(0, 0, 0);
    state.quaternion.identity();
    respawnToSafe();
  }

  // ------------------------------------------------------------------- api

  const api = {
    state,
    TUNING: T,

    fixedUpdate(fdt, c) {
      const input = c?.input;
      if (!input || disposed) return;
      noiseTime += fdt;

      if (input.held('reset') && !prevReset && state.mode !== 'bail') bail('reset');
      prevReset = input.held('reset');

      switch (state.mode) {
        case 'bail':
          stepBail(fdt, input);
          break;
        case 'grind':
          // grind.js drives position/quaternion; we only keep the readouts alive.
          state.crouch = damp(state.crouch, input.held('hop') ? T.crouchMax * 0.5 : 0, 10, fdt);
          state.airTime = 0;
          state.grounded = true;
          prevHop = input.held('hop');
          state.pumpBudget = Math.min(T.pumpBudget, state.pumpBudget + T.pumpRefill * fdt);
          break;
        case 'wallride':
          stepWall(fdt, input);
          break;
        case 'air':
          stepAir(fdt, input);
          prevHop = input.held('hop');
          break;
        default:
          stepGround(fdt, input);
          if (state.mode !== 'bail' && state.mode !== 'air') handleWalls(fdt, false);
          break;
      }

      updateDerived(fdt);
      sanityCheck();
    },

    /** Place the bike at a spawn point ({ position, yaw }) and clear every transient. */
    respawn(spawn) {
      const pos = spawn?.position || state.lastSafe.position;
      state.position.copy(pos);
      state.velocity.set(0, 0, 0);
      state.yaw = spawn?.yaw ?? 0;
      state.quaternion.setFromAxisAngle(AXIS_Y, state.yaw);
      state.mode = 'ride';
      state.grounded = true;
      state.airTime = 0;
      state.speed = 0;
      state.lean = 0;
      state.pitch = 0;
      state.steer = 0;
      state.skid = 0;
      state.crouch = 0;
      state.compression = 0;
      state.hopCharge = 0;
      state.pumpCharge = 0;
      state.pumpBudget = T.pumpBudget;
      state.balance = 0;
      state.manualType = null;
      state.rail = null;
      state.wall.active = false;
      state.bailTimer = 0;
      state.rotation.yaw = 0; state.rotation.pitch = 0; state.rotation.roll = 0;
      state.spinDeg = 0; state.flipDeg = 0;
      state.surfaceNormal.set(0, 1, 0);
      lastGroundNormal.set(0, 1, 0);
      state.surfaceTilt = 0;
      state.contactFront = false;
      state.contactRear = false;
      angVel.set(0, 0, 0);
      trickInput.set(0, 0, 0);
      bailSpin.set(0, 0, 0);
      balanceVel = 0;
      hopHoldTime = 0;
      stallTimer = 0;
      wallCooldown = 0;
      safeTimer = 0;

      // Settle onto whatever is under the spawn so we never start mid-air or buried.
      sampleGround();
      blendSurface(T.probeDown);
      if (probeC.usable) state.position.y = probeC.point.y + T.contactLift;
      else if (probeR.usable) state.position.y = probeR.point.y + T.contactLift;
      alignToSurface(1, 1e6);
      state.lastSafe.position.copy(state.position);
      state.lastSafe.yaw = state.yaw;
      updateDerived(1 / 120);
    },

    /**
     * Drive rotation from the trick system.
     * `axis` is 'yaw'|'spin' (about the bike's up), 'pitch'|'flip' (about right),
     * 'roll'|'barspin' (about forward), or a THREE.Vector3 in bike-local space.
     * `rate` is rad/s and is re-applied every step the trick wants to keep turning.
     */
    applyTrickRotation(axis, rate) {
      if (!Number.isFinite(rate) || rate === 0) return;
      if (state.mode !== 'air') return;
      if (typeof axis === 'string') {
        switch (axis) {
          case 'yaw': case 'spin': trickInput.y += rate; break;
          case 'pitch': case 'flip': trickInput.x += rate; break;
          case 'roll': case 'barspin': case 'corkscrew': trickInput.z += rate; break;
          default: trickInput.y += rate; break;
        }
      } else if (axis && typeof axis.x === 'number') {
        _tmpA.set(axis.x, axis.y, axis.z);
        if (_tmpA.lengthSq() > 1e-8) trickInput.addScaledVector(_tmpA.normalize(), rate);
      }
      const m = trickInput.length();
      if (m > T.maxTrickRate) trickInput.multiplyScalar(T.maxTrickRate / m);
      trickRateThisStep = m;
    },

    /** grind.js takes over the chassis; we keep owning the state object. */
    enterGrind(railHit) {
      if (state.mode === 'bail') return false;
      state.mode = 'grind';
      state.rail = railHit || null;
      state.grounded = true;
      state.airTime = 0;
      state.manualType = null;
      state.balance = 0;
      state.wall.active = false;
      angVel.set(0, 0, 0);
      trickInput.set(0, 0, 0);
      state.rotation.yaw = 0; state.rotation.pitch = 0; state.rotation.roll = 0;
      state.spinDeg = 0; state.flipDeg = 0;
      state.compression = Math.max(state.compression, 0.35);
      return true;
    },

    /** Leave a rail. `dir` (optional) is the world-space pop-out direction. */
    exitGrind(dir) {
      if (state.mode !== 'grind') return;
      state.rail = null;
      if (dir && typeof dir.x === 'number') {
        _tmpA.set(dir.x, dir.y, dir.z);
        if (_tmpA.lengthSq() > 1e-8) state.velocity.addScaledVector(_tmpA.normalize(), T.grindOutPop);
      }
      bodyAxes();
      state.yaw = Math.atan2(_fwd.x, _fwd.z);
      state.mode = 'air';
      state.grounded = false;
      state.airTime = 0;
      state.launchHeight = state.position.y;
      state.airPeak = 0;
      state.airLaunchSpeed = state.velocity.length();
      state.rotation.yaw = 0; state.rotation.pitch = 0; state.rotation.roll = 0;
      state.spinDeg = 0; state.flipDeg = 0;
      angVel.set(0, 0, 0);
    },

    /** Let other systems (grind balance, goals, debug) force a crash. */
    forceBail(reason) { bail(reason || 'bail'); },

    /** Current trick rotation magnitude, rad/s — handy for FX and the animator. */
    get trickRate() { return trickRateThisStep; },

    dispose() {
      disposed = true;
      state.rail = null;
    },
  };

  return api;
}
