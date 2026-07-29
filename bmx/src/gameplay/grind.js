// MIRRA CITY — rail / coping / ledge grinding.
//
// This module owns the chassis while the bike is on a grind line. The hand-off is:
//
//   physics.fixedUpdate()   the air/ride step runs first and moves the bike
//   grind.fixedUpdate()     we look for a rail, and while grinding we WRITE
//                           state.position / state.quaternion / state.velocity
//                           directly (bikePhysics' 'grind' branch deliberately
//                           leaves them alone and only keeps its readouts alive)
//
// Conventions inherited from bikePhysics.js:
//   * state.position is the CONTACT ORIGIN (ground level, mid-wheelbase).
//   * Local axes +X right, +Y up, +Z forward; basis order makeBasis(right, up, fwd).
//   * A roll of +lean leans the rider RIGHT and is applied as axisAngle(Z, -lean);
//     a +pitch is nose-UP and is applied as axisAngle(X, -pitch).
//
// The rule that keeps the bike welded to the rail: every grind type declares a
// bike-local offset from the contact origin to the peg that is touching the line.
// Each step we take the exact railPointAt(t), add the rail's own lift (tube radius
// for round rail/coping, ~0 for a ledge whose curve already runs along the top
// edge), rotate the local offset by the FINAL orientation and subtract it. The
// contact never floats and never sinks, whatever the bank or trick pose is.
//
// Nothing in fixedUpdate allocates. The only objects built at runtime are the small
// event payloads for discrete transitions (start / trick / transfer / end), which
// fire a few times per second at most.

import * as THREE from 'three';
import { clamp, damp, rng, TAU } from '../core/mathx.js';

// ---------------------------------------------------------------------------
// tuning
// ---------------------------------------------------------------------------

export const GRIND_TUNING = {
  // --- acquisition ---------------------------------------------------------
  snapDist: 0.45,           // m from the peg line to the rail that still snaps you on (airborne)
  snapDistGround: 0.30,     // tighter window when rolling — you should not vacuum onto ledges
  bufferMs: 200,            // ms of grind-button buffer, so an early press still catches the rail
  minEnterSpeed: 2.4,       // m/s below which there is nothing to grind with
  slamToSpeed: 0.18,        // fraction of the downward slam converted into grind speed
  sideProbe: 0.40,          // m either side of the line we look for the drop-off
  sideProbeDrop: 0.25,      // m of height difference that decides which side the bike hangs on

  // --- motion along the line ----------------------------------------------
  gravity: 17.5,            // must match bikePhysics TUNING.gravity so downhill rails read right
  maxSpeed: 17.0,           // m/s hard cap on a rail — a long downhill coping cannot run away
  stallSpeed: 0.9,          // m/s below which you simply fall off the back of the grind
  pumpAccel: 2.6,           // m/s² the pedal input buys you — enough to hold speed, not to gain it
  pumpCap: 13.0,            // m/s ceiling the pump can hold you at

  // --- contact geometry ----------------------------------------------------
  pegDrop: 0.2385,          // m from the contact origin up to the underside of a peg (tyreR - pegR)
  pegSide: 0.115,           // m from the centreline out to the middle of a peg
  pegSpan: 0.52,            // m fore/aft from mid-wheelbase to a peg (= half wheelbase)
  ledgeLift: 0.005,         // m of lift on a ledge — its curve already runs along the ride edge
  minRailLift: 0.02,        // m minimum lift so a hairline rail radius still reads as "on top"
  wheelRadius: 0.26,        // m — matches bikePhysics TUNING.wheelRadius, drives the wheel spin readout

  // --- orientation ---------------------------------------------------------
  orientLambda: 17.0,       // 1/s steady-state chassis alignment to the rail frame
  orientSnap: 46.0,         // 1/s alignment during the first `snapTime` — the bike locks on fast
  snapTime: 0.14,           // s of the fast lock-on window
  bankBlend: 0.45,          // how much of the surface normal under the rail tilts the bike
  bankLambda: 6.0,          // 1/s smoothing on that tilt
  maxCurveBank: 0.42,       // rad of lean the rail's own curvature adds (carving a bowl coping)
  surfaceEvery: 6,          // fixed steps between surface-normal samples under the rail

  // --- balance -------------------------------------------------------------
  balanceGravity: 2.9,      // 1/s² inverted-pendulum divergence, before type/rail difficulty
  balanceInput: 5.2,        // 1/s² correction authority of steer (or lean on nose/tail grinds)
  balanceDamp: 1.9,         // 1/s damping so a correction settles instead of oscillating
  balanceSeed: 0.10,        // the meter never starts centred, or it would never fall
  driftAmp: 0.80,           // 1/s² amplitude of the seeded per-rail wobble
  driftGrowth: 0.34,        // 1/s the drift multiplier grows — long grinds get genuinely hard
  driftMax: 2.60,           // cap on that multiplier — past it no amount of input saves you
  speedAid: 0.34,           // fraction of the divergence a fast grind removes
  speedAidAt: 12.0,         // m/s at which that aid is full
  criticalAt: 0.60,         // |balance| that lights the HUD meter red
  balanceBail: 1.0,         // |balance| that throws you off
  balanceRoll: 0.26,        // rad of visible chassis roll at |balance| = 1
  balanceKeepOnSwitch: 0.55,// fraction of the meter carried across a mid-grind trick change

  // --- exits ---------------------------------------------------------------
  minHoldTime: 0.35,        // s before releasing the button can drop you off
  exitCooldown: 0.20,       // s before a rail can grab you again
  endLift: 0.55,            // m/s of lift riding off the end, so the pegs clear the rail
  hopBonus: 1.5,            // m/s of pop on top of bikePhysics' grindOutPop when you hop off
  revertSteer: 0.55,        // |steer| at the exit that turns it into a 180 revert
  revertSpeed: 3.0,         // m/s needed for that revert to count

  // --- transfers -----------------------------------------------------------
  transferReach: 0.45,      // m past the end of the rail we look for the next one
  transferDist: 1.15,       // m search radius for that next rail
  transferWindow: 0.70,     // s after an exit in which a new grind still counts as a transfer

  // --- scoring -------------------------------------------------------------
  holdRate: 0.90,           // fraction of the trick's base points earned per second of grinding
  distanceRate: 24.0,       // points per metre of rail ridden
  transferPoints: 250,      // base for a rail-to-rail transfer
  revertPoints: 150,        // base for a 180 revert out

  // --- rider weighting -----------------------------------------------------
  // A grind is ridden with the rider's mass stacked over the line: the chassis
  // rolls TOWARD the rail so the loaded peg stays under the centre of gravity.
  // Without this every grind sits bolt upright and reads as a bike parked in the
  // air next to a tube. It is a pose term only — the contact solve rotates the
  // peg offset by the final orientation, so the metal still touches exactly.
  railLean: 0.155,          // rad of weight-over-the-rail roll at riding speed
  railLeanSpeed: 6.0,       // m/s at which that weighting is fully developed
  railLeanFloor: 0.35,      // fraction of it that survives down at walking pace

  // --- presentation --------------------------------------------------------
  sparkInterval: 0.085,     // s between the supplementary spark bursts we fire ourselves
  audioInterval: 1 / 30,    // s between audio parameter pushes

  // Contact rig (sparks / flare / contact shadow). This module owns the contact
  // presentation because it is the only one that knows where the peg actually
  // meets the line — particles.js runs a second, gameplay-only stream that stops
  // dead whenever the simulation is paused or frozen.
  // Swarf off a peg travels tens of centimetres, not metres. Shed speed × life ×
  // the shader's drag has to keep the whole fan inside ~0.9 m of the contact, or
  // the shower spreads so thin that the one place it must read — the metal — has
  // nothing on it at all.
  showerBase: 34,           // sparks alive at the contact at walking pace
  showerPerSpeed: 6.0,      // extra alive sparks per m/s
  showerMax: 120,           // hard cap on the live shower
  sparkLifeMin: 0.10,       // s
  sparkLifeMax: 0.30,       // s
  sparkSizeMin: 0.007,      // m half-width of a fresh spark quad (a streak is thin)
  sparkSizeMax: 0.018,      // m
  sparkSpeed: 1.6,          // m/s of shed velocity at the low end
  sparkSpeedPerSpeed: 0.30, // extra shed velocity per m/s of grind speed
  sparkSmear: 0.020,        // metres of streak per m/s of view-space velocity
  flareSize: 0.055,         // m half-width of the additive contact bloom sprite
  contactLight: 1.4,        // point-light intensity at the contact on a hot grind
  shadowStrength: 0.80,     // darkness of the tight contact blob on the ground
  shadowSpread: 1.35,       // how much the blob grows per metre of drop
  shadowFade: 2.6,          // m of drop at which the blob has faded out entirely
};

/**
 * Per-material behaviour. `friction`/`drag` are the deceleration model, `balance`
 * scales how twitchy the meter is, `spark`/`dust` set the FX mix. Coping is a
 * polished steel tube on a lip: fast and loud. A concrete ledge is slow, dusty and
 * forgiving, because it is 30 cm wide.
 */
export const GRIND_MATERIALS = {
  rail: { friction: 0.55, drag: 0.0060, balance: 1.00, spark: 1.00, dust: 0.10, points: 1.00, label: 'Rail' },
  coping: { friction: 0.30, drag: 0.0040, balance: 1.10, spark: 0.85, dust: 0.20, points: 1.05, label: 'Coping' },
  ledge: { friction: 1.45, drag: 0.0110, balance: 0.85, spark: 0.25, dust: 1.00, points: 0.95, label: 'Ledge' },
};

/**
 * The grind vocabulary. `z` is the fore/aft position on the bike of the peg that
 * meets the rail (negative = rear peg), `roll`/`pitch`/`yaw` are pose offsets in
 * radians, mirrored by which side of the bike the rail sits on. `axis` says which
 * stick corrects the balance meter: peg grinds correct side-to-side, nose/tail
 * grinds correct fore/aft like a manual.
 */
export const GRIND_TYPES = {
  doublePeg: {
    id: 'doublePeg', label: 'Double Peg', pose: 'grind_doublepeg',
    z: 0.00, roll: 0.00, pitch: 0.00, yaw: 0.00,
    // Both pegs are loaded, so the contact origin sits mid-wheelbase but the
    // metal-on-metal contact — and everything that sheds off it — happens at the
    // two pegs, ±pegSpan along the line. `dual` says so.
    dual: true,
    axis: 'steer', leanSign: 1, diff: 0.78, base: 100,
  },
  feeble: {
    id: 'feeble', label: 'Feeble Grind', pose: 'grind_feeble',
    z: -0.40, roll: 0.30, pitch: -0.06, yaw: 0.00,
    axis: 'steer', leanSign: 1, diff: 1.05, base: 200,
  },
  smith: {
    id: 'smith', label: 'Smith Grind', pose: 'grind_smith',
    z: 0.40, roll: -0.24, pitch: 0.12, yaw: 0.00,
    axis: 'steer', leanSign: 1, diff: 1.12, base: 220,
  },
  lucE: {
    id: 'lucE', label: 'Luc-E Grind', pose: 'grind_luce',
    z: 0.38, roll: 0.30, pitch: 0.06, yaw: 0.10,
    axis: 'steer', leanSign: 1, diff: 1.22, base: 260,
  },
  crooked: {
    id: 'crooked', label: 'Crooked Grind', pose: 'grind_crooked',
    z: 0.40, roll: 0.12, pitch: 0.05, yaw: 0.38,
    axis: 'steer', leanSign: 1, diff: 1.32, base: 280,
  },
  icePick: {
    id: 'icePick', label: 'Ice Pick', pose: 'grind_icepick',
    z: -0.46, roll: 0.05, pitch: 0.40, yaw: 0.00,
    axis: 'lean', leanSign: 1, diff: 1.45, base: 300,
  },
  toothpick: {
    id: 'toothpick', label: 'Toothpick', pose: 'grind_toothpick',
    z: 0.46, roll: 0.05, pitch: -0.38, yaw: 0.00,
    axis: 'lean', leanSign: -1, diff: 1.52, base: 320,
  },
};

const GT = GRIND_TUNING;

// Sibling-module method names we use when the module that owns them exposes one.
// Everything here is optional — the event bus is the guaranteed integration path.
const TRICK_NAME_FNS = ['nameGrind', 'grindName', 'nameTrick'];
const TRICK_ADD_FNS = ['onGrindTrick', 'addGrindTrick', 'addTrick', 'pushTrick', 'landTrick'];
const SCORE_ADD_FNS = ['addTrick', 'addGrindTrick', 'addScore', 'award'];
const TRICK_START_FNS = ['onGrindStart', 'startGrind', 'beginGrind'];
const TRICK_END_FNS = ['onGrindEnd', 'endGrind', 'finishGrind'];
const AUDIO_SET_FNS = ['setGrind', 'grind', 'updateGrind'];

// ---------------------------------------------------------------------------
// module scratch — the fixed step allocates nothing
// ---------------------------------------------------------------------------

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);

const _pegPoint = new THREE.Vector3();
const _contact = new THREE.Vector3();
const _tan = new THREE.Vector3();
const _tanAhead = new THREE.Vector3();
const _travel = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _localOff = new THREE.Vector3();
const _probe = new THREE.Vector3();
const _surfN = new THREE.Vector3(0, 1, 0);
const _bank = new THREE.Vector3();
const _tmpA = new THREE.Vector3();
const _tmpB = new THREE.Vector3();
const _exitDir = new THREE.Vector3();
const _basis = new THREE.Matrix4();
const _qTarget = new THREE.Quaternion();
const _qStep = new THREE.Quaternion();

const _fxA = new THREE.Vector3();
const _fxB = new THREE.Vector3();
const _fxC = new THREE.Vector3();
const _fxT = new THREE.Vector3();
const _fxN = new THREE.Vector3(0, 1, 0);
const _fxR = new THREE.Vector3();
const _fxG = new THREE.Vector3(0, 1, 0);

// ---------------------------------------------------------------------------
// contact presentation rig
//
// Sparks, the additive contact bloom and the contact shadow all hang off ONE
// piece of information — where the loaded peg meets the line — so they live
// here rather than in particles.js. Two draw calls, two fixed pools, nothing
// allocated after construction.
//
// The rig is driven from `onBeforeRender`, not from the fixed step, for one
// concrete reason: the fixed step does not run when the game is paused or
// frozen (menus, the results screen, the screenshot harness), and a grind that
// loses its sparks and its contact shadow the instant the clock stops reads as
// a bike pasted over the level. The tick is idempotent per frame — whichever of
// the two meshes the renderer reaches first runs it, the other is a no-op.
// ---------------------------------------------------------------------------

const SPARK_SLOTS = 160;      // slots 0..1 are the persistent contact flares
const FLARES = 2;             // one per loaded peg (a double peg loads two)
const BLOB_SLOTS = 4;         // 0 ground shadow, 1 ground core, 2..3 rail smudges

const SPARK_VERT = `
attribute vec3 aOrigin;
attribute vec3 aVel;
attribute vec4 aParam;      // x birth, y life, z half-size, w smear
attribute vec3 aTint;
uniform float uTime;
uniform float uGravity;
varying vec2 vUv;
varying vec3 vTint;
varying float vFade;
varying float vStretch;
void main() {
  vUv = uv;
  vTint = aTint;
  float life = max(aParam.y, 1e-4);
  float age = uTime - aParam.x;
  float k = age / life;
  if (k < 0.0 || k > 1.0 || aParam.z <= 0.0) {
    vFade = 0.0;
    vStretch = 1.0;
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);   // behind the far plane: never shaded
    return;
  }
  vFade = 1.0 - k * k;
  // Ballistic path with linear drag, integrated in closed form so a spark can be
  // born mid-flight (the shower is seeded with staggered birth times, which is
  // what makes it look established on the very first frame it is rendered).
  const float drag = 3.1;
  float d = exp(-drag * age);
  vec3 p = aOrigin + aVel * ((1.0 - d) / drag);
  p.y -= 0.5 * uGravity * age * age;
  vec3 v = aVel * d;
  v.y -= uGravity * age;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vec3 vv = (modelViewMatrix * vec4(v, 0.0)).xyz;
  float size = aParam.z * (0.30 + 0.70 * vFade);
  float dl = length(vv.xy);
  vec2 u = dl > 1e-4 ? vv.xy / dl : vec2(0.0, 1.0);
  vec2 w = vec2(-u.y, u.x);
  // Sub-frame velocity smear: the quad stretches along its own screen-space
  // motion, so a fast spark is a streak and a dying one is a dot.
  float len = size + aParam.w * dl;
  vStretch = len / max(size, 1e-5);
  mv.xy += w * (position.x * size * 2.0) + u * (position.y * len * 2.0);
  gl_Position = projectionMatrix * mv;
}`;

// The profile is computed, not sampled. A stretched sprite would put its bright
// core in one small spot in the middle of a 60 px streak and leave the rest as
// dim halo — which is exactly why a texture-mapped spark vanishes the moment the
// smear is long enough to be worth having.
const SPARK_FRAG = `
varying vec2 vUv;
varying vec3 vTint;
varying float vFade;
varying float vStretch;
void main() {
  vec2 q = vUv * 2.0 - 1.0;
  float across = q.x;
  float along = q.y;
  // round hot core with a warm halo — used for the contact flare and for a
  // spark that has slowed to a dot
  float r2 = across * across + along * along;
  float radial = exp(-r2 * 4.5) + 0.85 * exp(-r2 * 22.0);
  // a thin bright line, full brightness down its whole length, tapered at the
  // trailing end and softened at the tip
  float streak = exp(-across * across * 7.0)
    * smoothstep(-1.0, -0.15, along) * (1.0 - smoothstep(0.65, 1.0, along));
  float a = mix(radial, streak, clamp((vStretch - 1.0) / 3.0, 0.0, 1.0));
  a *= vFade;
  if (a < 0.003) discard;
  gl_FragColor = vec4(vTint * a, a);
}`;

const BLOB_VERT = `
attribute vec3 aCenter;
attribute vec3 aAxisU;
attribute vec3 aAxisV;
attribute vec2 aShape;      // x strength, y softness
varying vec2 vUv;
varying vec2 vShape;
void main() {
  vUv = uv;
  vShape = aShape;
  vec3 p = aCenter + aAxisU * (position.x * 2.0) + aAxisV * (position.y * 2.0);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const BLOB_FRAG = `
varying vec2 vUv;
varying vec2 vShape;
void main() {
  vec2 q = vUv * 2.0 - 1.0;
  float r = length(q);
  if (r > 1.0 || vShape.x <= 0.0) discard;
  float m = 1.0 - smoothstep(1.0 - vShape.y, 1.0, r);
  m *= m;
  float k = 1.0 - clamp(vShape.x, 0.0, 0.95) * m;
  gl_FragColor = vec4(k, k, k, 1.0);
}`;

function instQuad(slots) {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(
    [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  g.instanceCount = 0;
  g.userData.slots = slots;
  return g;
}

function instAttr(slots, size) {
  return new THREE.InstancedBufferAttribute(new Float32Array(slots * size), size);
}

/**
 * `onFrame` is invoked exactly once per rendered frame, before either mesh is
 * drawn. The mesh callbacks double as the override-pass guard: GTAO and the
 * depth prepass swap in their own material, and neither pool has anything
 * meaningful to say about depth or normals, so they draw nothing there.
 */
function createContactRig(ctx, onFrame) {
  const group = new THREE.Group();
  group.name = 'GrindContact';
  group.matrixAutoUpdate = false;
  group.frustumCulled = false;

  // --- hot pool: sparks + the persistent contact flare ----------------------
  const hotGeo = instQuad(SPARK_SLOTS);
  const aOrigin = instAttr(SPARK_SLOTS, 3);
  const aVel = instAttr(SPARK_SLOTS, 3);
  const aParam = instAttr(SPARK_SLOTS, 4);
  const aTint = instAttr(SPARK_SLOTS, 3);
  hotGeo.setAttribute('aOrigin', aOrigin);
  hotGeo.setAttribute('aVel', aVel);
  hotGeo.setAttribute('aParam', aParam);
  hotGeo.setAttribute('aTint', aTint);
  const org = aOrigin.array, vel = aVel.array, par = aParam.array, tnt = aTint.array;
  for (let i = 0; i < SPARK_SLOTS; i++) { par[i * 4 + 1] = 1e-4; par[i * 4 + 2] = 0; }

  const hotUniforms = { uTime: { value: 0 }, uGravity: { value: 9.0 } };
  const hotMat = new THREE.ShaderMaterial({
    uniforms: hotUniforms,
    vertexShader: SPARK_VERT,
    fragmentShader: SPARK_FRAG,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    // A transparent DoubleSide material is otherwise drawn twice per frame with
    // `needsUpdate` flipped between the two passes — every spark blended twice
    // and the program marked dirty every frame.
    forceSinglePass: true,
    toneMapped: false,
  });
  const hotMesh = new THREE.Mesh(hotGeo, hotMat);
  hotMesh.name = 'GrindSparks';
  hotMesh.frustumCulled = false;
  hotMesh.matrixAutoUpdate = false;
  hotMesh.castShadow = false;
  hotMesh.receiveShadow = false;
  hotMesh.renderOrder = 6;

  // --- dark pool: contact shadow + the smudge where metal meets metal -------
  const blobGeo = instQuad(BLOB_SLOTS);
  const aCenter = instAttr(BLOB_SLOTS, 3);
  const aAxisU = instAttr(BLOB_SLOTS, 3);
  const aAxisV = instAttr(BLOB_SLOTS, 3);
  const aShape = instAttr(BLOB_SLOTS, 2);
  blobGeo.setAttribute('aCenter', aCenter);
  blobGeo.setAttribute('aAxisU', aAxisU);
  blobGeo.setAttribute('aAxisV', aAxisV);
  blobGeo.setAttribute('aShape', aShape);
  const cen = aCenter.array, axU = aAxisU.array, axV = aAxisV.array, shp = aShape.array;

  const blobMat = new THREE.ShaderMaterial({
    uniforms: {},
    vertexShader: BLOB_VERT,
    fragmentShader: BLOB_FRAG,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    forceSinglePass: true,
    // multiply against what is already there: a real darkening, not a grey card
    blending: THREE.CustomBlending,
    blendSrc: THREE.DstColorFactor,
    blendDst: THREE.ZeroFactor,
    blendEquation: THREE.AddEquation,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -6,
    toneMapped: false,
  });
  const blobMesh = new THREE.Mesh(blobGeo, blobMat);
  blobMesh.name = 'GrindContactShadow';
  blobMesh.frustumCulled = false;
  blobMesh.matrixAutoUpdate = false;
  blobMesh.castShadow = false;
  blobMesh.receiveShadow = false;
  blobMesh.renderOrder = 4;

  const light = new THREE.PointLight(0xffb166, 0, 3.6, 2);
  light.castShadow = false;
  light.visible = false;

  group.add(hotMesh);
  group.add(blobMesh);
  group.add(light);
  ctx?.scene?.add?.(group);

  // The rig is pumped on a wall-clock timer, NOT once per rendered frame. On a
  // software renderer a frame can take more than a second, and a grind staged
  // between two frames would then be captured with the chassis still on its
  // free-body transform and an empty spark pool — the presentation would be
  // hostage to the frame rate. The timer keeps the contact solved and the shower
  // populated so that whenever a frame IS produced, it is already correct. The
  // render callbacks pump it once more for freshness and carry the
  // override-pass guard (GTAO and the puddle mirror swap the material out, and
  // neither pool has anything to say about depth or normals).
  const timer = setInterval(onFrame, 40);

  let savedHot = 0;
  hotMesh.onBeforeRender = (r, s, cam, geo, mat) => {
    if (mat !== hotMat) { savedHot = hotGeo.instanceCount; hotGeo.instanceCount = 0; return; }
    onFrame();
  };
  hotMesh.onAfterRender = (r, s, cam, geo, mat) => {
    if (mat !== hotMat) hotGeo.instanceCount = savedHot;
  };
  let savedBlob = 0;
  blobMesh.onBeforeRender = (r, s, cam, geo, mat) => {
    if (mat !== blobMat) { savedBlob = blobGeo.instanceCount; blobGeo.instanceCount = 0; return; }
    onFrame();
  };
  blobMesh.onAfterRender = (r, s, cam, geo, mat) => {
    if (mat !== blobMat) blobGeo.instanceCount = savedBlob;
  };

  let cursor = FLARES;          // the flare slots are never recycled
  let time = 0;

  const rig = {
    group,

    setTime(t) { time = t; hotUniforms.uTime.value = t; },

    /** How many more live sparks the shower wants this frame. */
    deficit(target) {
      let alive = 0;
      for (let i = FLARES; i < SPARK_SLOTS; i++) {
        if (par[i * 4 + 2] > 0 && time - par[i * 4] < par[i * 4 + 1]) alive++;
      }
      const want = Math.min(target, SPARK_SLOTS - FLARES);
      return want > alive ? want - alive : 0;
    },

    /** `back` (0..1) ages the spark at birth so a fresh shower is never a burst. */
    spark(p, v, life, size, smear, r, g, b, back) {
      const i = cursor;
      cursor = cursor + 1 >= SPARK_SLOTS ? FLARES : cursor + 1;
      let o = i * 3;
      org[o] = p.x; org[o + 1] = p.y; org[o + 2] = p.z;
      vel[o] = v.x; vel[o + 1] = v.y; vel[o + 2] = v.z;
      tnt[o] = r; tnt[o + 1] = g; tnt[o + 2] = b;
      o = i * 4;
      par[o] = time - life * back;
      par[o + 1] = life;
      par[o + 2] = size;
      par[o + 3] = smear;
      hotGeo.instanceCount = SPARK_SLOTS;
      aOrigin.needsUpdate = true; aVel.needsUpdate = true;
      aParam.needsUpdate = true; aTint.needsUpdate = true;
    },

    /** The always-on additive bloom sprite sitting on a loaded peg. */
    flare(i, p, size, r, g, b) {
      let o = i * 3;
      org[o] = p.x; org[o + 1] = p.y; org[o + 2] = p.z;
      vel[o] = 0; vel[o + 1] = 0; vel[o + 2] = 0;
      tnt[o] = r; tnt[o + 1] = g; tnt[o + 2] = b;
      o = i * 4;
      par[o] = time; par[o + 1] = 1e6; par[o + 2] = size; par[o + 3] = 0;
      if (size > 0) hotGeo.instanceCount = SPARK_SLOTS;
      aOrigin.needsUpdate = true; aVel.needsUpdate = true;
      aParam.needsUpdate = true; aTint.needsUpdate = true;
    },

    /** Any live spark keeps the pool drawing; an empty pool costs nothing. */
    idleHot() {
      let any = false;
      for (let i = 0; !any && i < SPARK_SLOTS; i++) {
        if (par[i * 4 + 2] > 0 && time - par[i * 4] < par[i * 4 + 1]) any = true;
      }
      hotGeo.instanceCount = any ? SPARK_SLOTS : 0;
    },

    /**
     * @param {number} i     blob slot
     * @param {THREE.Vector3} c   centre, already lifted off the surface
     * @param {THREE.Vector3} n   surface normal (unit)
     * @param {THREE.Vector3} along  long axis hint (unit-ish)
     */
    blob(i, c, n, along, halfLen, halfWide, strength, soft) {
      _fxB.copy(along).addScaledVector(n, -along.dot(n));
      if (_fxB.lengthSq() < 1e-8) {
        _fxB.set(1, 0, 0).addScaledVector(n, -n.x);
        if (_fxB.lengthSq() < 1e-8) _fxB.set(0, 0, 1);
      }
      _fxB.normalize();
      _fxC.crossVectors(_fxB, n).normalize();
      let o = i * 3;
      cen[o] = c.x; cen[o + 1] = c.y; cen[o + 2] = c.z;
      axU[o] = _fxC.x * halfWide; axU[o + 1] = _fxC.y * halfWide; axU[o + 2] = _fxC.z * halfWide;
      axV[o] = _fxB.x * halfLen; axV[o + 1] = _fxB.y * halfLen; axV[o + 2] = _fxB.z * halfLen;
      o = i * 2;
      shp[o] = strength; shp[o + 1] = soft;
      blobGeo.instanceCount = BLOB_SLOTS;
      aCenter.needsUpdate = true; aAxisU.needsUpdate = true;
      aAxisV.needsUpdate = true; aShape.needsUpdate = true;
    },

    hideBlobs() {
      if (blobGeo.instanceCount === 0) return;
      for (let i = 0; i < BLOB_SLOTS; i++) shp[i * 2] = 0;
      aShape.needsUpdate = true;
      blobGeo.instanceCount = 0;
    },

    /** Manual pump. Safe to call any number of times: it is time-based. */
    tick() { onFrame(); },

    setLight(p, intensity) {
      if (intensity <= 0.001) { light.visible = false; light.intensity = 0; return; }
      light.position.copy(p);
      light.intensity = intensity;
      light.visible = true;
    },

    dispose() {
      clearInterval(timer);
      const noop = () => {};
      hotMesh.onBeforeRender = noop; hotMesh.onAfterRender = noop;
      blobMesh.onBeforeRender = noop; blobMesh.onAfterRender = noop;
      group.parent?.remove(group);
      hotGeo.dispose(); hotMat.dispose();
      blobGeo.dispose(); blobMat.dispose();
    },
  };
  return rig;
}

/** Per-rail personality, assigned the first time a rail is ever grinded. */
const railCharacter = new WeakMap();

function characterFor(rail) {
  let c = railCharacter.get(rail);
  if (!c) {
    c = {
      phaseA: rng() * TAU,
      phaseB: rng() * TAU,
      freqA: 1.05 + rng() * 1.05,
      freqB: 0.42 + rng() * 0.55,
      bias: (rng() * 2 - 1) * 0.34,
    };
    railCharacter.set(rail, c);
  }
  return c;
}

// ---------------------------------------------------------------------------
// createGrind
// ---------------------------------------------------------------------------

export function createGrind(ctx) {
  // --- live grind state ----------------------------------------------------
  let active = false;
  let disposed = false;

  let type = GRIND_TYPES.doublePeg;
  let material = GRIND_MATERIALS.rail;
  let railType = 'rail';
  let railLength = 1;
  let railClosed = false;
  let railLift = 0.03;

  let t = 0;                 // normalised arc length along the rail
  let dir = 1;               // +1 travelling with increasing t, -1 against it
  let side = 1;              // +1 the rail sits on the bike's right, -1 on its left
  let speed = 0;             // m/s along the travel direction (always positive)
  let entrySpeed = 0;
  let grindTime = 0;
  let distance = 0;
  let switchStance = false;  // entered riding backwards

  let balance = 0;
  let balanceVel = 0;
  let critical = false;
  let character = null;

  let segPoints = 0;         // points accrued by the CURRENT trick in this grind
  let runPoints = 0;         // points banked across the whole run (incl. transfers)

  let cooldown = 0;
  let sinceExit = 999;
  let transferChain = 0;
  let reverts = 0;
  let pendingType = null;
  let pendingTypeTime = 0;
  let lastTypeChange = 0;
  let sparkTimer = 0;
  let audioTimer = 0;
  let surfaceTimer = 0;
  let bankAmount = 0;
  let surfaceBlend = 0;
  let poseZ = 0;             // eased fore/aft contact offset — a trick change slides, never snaps
  let entrySteer = 0;        // stick snapshot taken when the grind was committed
  let entryLean = 0;
  let audioLive = false;
  let hopLatched = false;    // a hop already held on entry must not instantly pop you off

  // The hand-off payload bikePhysics stores on state.rail. particles.js reads
  // `.point` from it every frame for the spark contact, so it must stay live.
  const info = {
    rail: null,
    t: 0,
    point: new THREE.Vector3(),
    tangent: new THREE.Vector3(0, 0, 1),
    normal: new THREE.Vector3(0, 1, 0),
    type: 'rail',
    radius: 0.03,
    grindType: 'doublePeg',
    side: 1,
  };

  // Reused audio parameter bag — no allocation on the 30 Hz push.
  const audioParams = {
    active: false, speed: 0, material: 'rail', balance: 0,
    critical: false, type: 'doublePeg', pitch: 1, gain: 0,
  };

  const phys = () => ctx.player?.physics;
  const col = () => ctx.world?.collision;

  // ----------------------------------------------------------- sibling bridge

  function callFirst(obj, names, a, b) {
    if (!obj) return false;
    for (let i = 0; i < names.length; i++) {
      const fn = obj[names[i]];
      if (typeof fn === 'function') { lastCallValue = fn.call(obj, a, b); return true; }
    }
    lastCallValue = undefined;
    return false;
  }
  let lastCallValue;

  /** Let the trick module name the trick; fall back to our own vocabulary table. */
  function nameFor(td, sw) {
    if (callFirst(ctx.player?.tricks, TRICK_NAME_FNS, td.id,
      { type: td.id, rail: railType, switch: sw, side })) {
      if (typeof lastCallValue === 'string' && lastCallValue.length) return lastCallValue;
    }
    return (sw ? 'Switch ' : '') + td.label;
  }

  /**
   * Hand a completed trick to whoever owns scoring. The trick module gets first
   * refusal so the grind lands inside the combo string; scoring is the fallback.
   * The event always fires, so goals/HUD can listen with neither method present.
   */
  function handOff(payload) {
    if (!callFirst(ctx.player?.tricks, TRICK_ADD_FNS, payload)) {
      callFirst(ctx.player?.scoring, SCORE_ADD_FNS, payload);
    }
    ctx.emit?.('grindTrick', payload);
  }

  function setPose(td, weight) {
    ctx.player?.anim?.setPose?.(td.pose, weight);
  }

  // ----------------------------------------------------------------- helpers

  function lengthOf(rail) {
    const c = col();
    let L = 0;
    if (c?.railLength) L = c.railLength(rail) || 0;
    if (!(L > 1e-3) && rail?.curve?.getLength) {
      try { L = rail.curve.getLength(); } catch { L = 0; }
    }
    return L > 1e-3 ? L : 0;
  }

  /**
   * Which grind the modifier buttons + stick ask for.
   *   grind alone ....... Double Peg (stick back/forward -> Ice Pick / Toothpick)
   *   grind + trickA .... Feeble, or Smith with steer held toward the rail
   *   grind + trickB .... Ice Pick, or Toothpick with the stick forward
   *   grind + trickC .... Luc-E, or Crooked with steer held
   *
   * The stick only chooses at the moment you commit: once you are on the rail the
   * stick is the balance corrector, so `entrySteer`/`entryLean` are frozen and
   * only the modifier BUTTONS can switch you to another grind mid-rail. Without
   * that, saving the balance meter would constantly flip the trick underneath you.
   */
  function pickType(input, steerSel, leanSel) {
    const lean = clamp(leanSel, -1, 1);
    const steer = clamp(steerSel, -1, 1);
    if (input.held('trickB')) return lean < -0.35 ? GRIND_TYPES.toothpick : GRIND_TYPES.icePick;
    if (input.held('trickC')) return Math.abs(steer) > 0.35 ? GRIND_TYPES.crooked : GRIND_TYPES.lucE;
    if (input.held('trickA')) return steer * side > 0.35 ? GRIND_TYPES.smith : GRIND_TYPES.feeble;
    if (lean > 0.55) return GRIND_TYPES.icePick;
    if (lean < -0.55) return GRIND_TYPES.toothpick;
    return GRIND_TYPES.doublePeg;
  }

  /** Deterministic, allocation-free wobble with this rail's personality baked in. */
  function wobble() {
    const c = character;
    if (!c) return 0;
    return Math.sin(grindTime * c.freqA + c.phaseA) * 0.62
      + Math.sin(grindTime * c.freqB + c.phaseB) * 0.38
      + c.bias;
  }

  /**
   * Rail frame at `at`: unit travel direction into _travel, rail up into _up.
   * The rail normal is world up with the along-rail component removed — on a level
   * rail that is world up, on a downhill handrail it tips with the line, which is
   * what keeps the bike parallel to the rail instead of pitched off it. The surface
   * under the rail is then blended in so a coping on a banked lip tilts the bike.
   */
  function railFrame(at) {
    const c = col();
    c.railTangentAt(info.rail, at, _tan);
    _travel.copy(_tan).multiplyScalar(dir);
    if (_travel.lengthSq() < 1e-8) _travel.set(0, 0, 1); else _travel.normalize();

    _up.copy(WORLD_UP).addScaledVector(_travel, -_travel.y);
    if (_up.lengthSq() < 1e-6) _up.set(0, 1, 0); else _up.normalize();

    if (surfaceBlend > 1e-3) {
      _tmpA.copy(_surfN).addScaledVector(_travel, -_surfN.dot(_travel));
      if (_tmpA.lengthSq() > 1e-6) {
        _tmpA.normalize();
        _up.lerp(_tmpA, GT.bankBlend * surfaceBlend);
        if (_up.lengthSq() < 1e-6) _up.set(0, 1, 0); else _up.normalize();
      }
    }
  }

  /** Signed curvature bank: how hard the line turns under us, as a lean angle. */
  function curveBank() {
    const c = col();
    const ds = 0.45;                                   // metres of look-ahead
    let at = t + (ds / Math.max(railLength, 0.5)) * dir;
    if (railClosed) at -= Math.floor(at); else at = clamp(at, 0, 1);
    c.railTangentAt(info.rail, at, _tanAhead);
    if (dir < 0) _tanAhead.negate();
    _bank.copy(_tanAhead).sub(_travel).multiplyScalar(1 / ds);   // dT/ds — the curvature vector
    _tmpB.crossVectors(_up, _travel);
    if (_tmpB.lengthSq() < 1e-8) return 0;
    _tmpB.normalize();
    const lat = speed * speed * _bank.dot(_tmpB);
    return clamp(Math.atan2(lat, GT.gravity), -GT.maxCurveBank, GT.maxCurveBank);
  }

  /**
   * Resample the surface normal beneath the rail (20 Hz) for the bank blend.
   * `hard` snaps the blend instead of easing it — used once on entry so the bike
   * is already correctly banked on the very first frame of the grind.
   */
  function sampleSurface(fdt, hard) {
    if (!hard) {
      surfaceTimer++;
      if (surfaceTimer < GT.surfaceEvery) return;
    }
    surfaceTimer = 0;
    const c = col();
    if (!c?.raycastDown) return;
    const dt = fdt * GT.surfaceEvery;
    _probe.copy(info.point).addScaledVector(WORLD_UP, 0.25);
    const h = c.raycastDown(_probe, 1.6);
    const good = !!(h && h.hit !== false && h.normal && h.normal.y > 0.30);
    if (good) _surfN.copy(h.normal).normalize();
    if (hard) surfaceBlend = good ? 1 : 0;
    else surfaceBlend = damp(surfaceBlend, good ? 1 : 0, GT.bankLambda, dt);
  }

  /**
   * Which side of the line the bike hangs on. A ledge or hubba has a drop on one
   * side and solid deck on the other — the wheels belong over the drop, or they
   * would be buried in the concrete. When both sides look the same (a freestanding
   * handrail) we keep the side the rider approached from, so nothing teleports.
   */
  function chooseSide(st) {
    _tmpA.copy(st.position).sub(info.point);
    _right.crossVectors(_up, _travel);
    if (_right.lengthSq() < 1e-8) _right.set(1, 0, 0); else _right.normalize();
    const approach = _tmpA.dot(_right) >= 0 ? -1 : 1;

    const c = col();
    if (!c?.raycastDown) return approach;

    _probe.copy(info.point).addScaledVector(_right, GT.sideProbe).addScaledVector(WORLD_UP, 0.30);
    const hp = c.raycastDown(_probe, 3.2);
    const yPlus = hp && hp.hit !== false ? hp.point.y : -1e6;

    _probe.copy(info.point).addScaledVector(_right, -GT.sideProbe).addScaledVector(WORLD_UP, 0.30);
    const hm = c.raycastDown(_probe, 3.2);
    const yMinus = hm && hm.hit !== false ? hm.point.y : -1e6;

    if (Math.abs(yPlus - yMinus) < GT.sideProbeDrop) return approach;
    // The drop is on +right -> the bike goes to +right -> the rail is on its left.
    return yPlus < yMinus ? -1 : 1;
  }

  // ---------------------------------------------------------------- entering

  /**
   * Look for a rail under the pegs. Returns the pooled nearestRail hit (valid for
   * three further rail queries) or null — the caller must consume it immediately.
   */
  function findRail(st, input) {
    const c = col();
    if (!c?.nearestRail) return null;
    const mode = st.mode;
    if (mode !== 'air' && mode !== 'ride' && mode !== 'manual') return null;
    if (cooldown > 0) return null;
    if (!(input.held('grind') || input.bufferedIn('grind', GT.bufferMs))) return null;
    if (st.velocity.lengthSq() < GT.minEnterSpeed * GT.minEnterSpeed) return null;

    // The peg line, not the contact origin: that is what actually meets the rail.
    _up.set(0, 1, 0).applyQuaternion(st.quaternion);
    if (!(_up.y > 0.15)) _up.set(0, 1, 0);
    _pegPoint.copy(st.position).addScaledVector(_up, GT.pegDrop);

    const reach = mode === 'air' ? GT.snapDist : GT.snapDistGround;
    const hit = c.nearestRail(_pegPoint, reach, st.velocity);
    return hit && hit.rail ? hit : null;
  }

  /** Commit to a rail. `hit` is a nearestRail result and is copied immediately. */
  function enter(hit, opts) {
    const p = phys();
    const c = col();
    const st = p?.state;
    if (!st || !c) return false;

    // Copy everything off the pooled result before any further query is made.
    info.rail = hit.rail;
    info.t = clamp(hit.t, 0, 1);
    info.point.copy(hit.point);
    info.tangent.copy(hit.tangent);
    info.type = hit.type || hit.rail.type || 'rail';
    info.radius = Number.isFinite(hit.radius) ? hit.radius : 0.03;

    const L = lengthOf(info.rail);
    if (L <= 0) { info.rail = null; return false; }

    railType = info.type;
    material = GRIND_MATERIALS[railType] || GRIND_MATERIALS.rail;
    railLength = L;
    railClosed = !!info.rail.curve?.closed;
    railLift = railType === 'ledge' ? GT.ledgeLift : Math.max(GT.minRailLift, info.radius);
    t = info.t;

    // Travel direction along the parameterisation.
    c.railTangentAt(info.rail, t, _tan);
    dir = _tan.dot(st.velocity) >= 0 ? 1 : -1;

    // Speed: the momentum we had along the line, plus a slice of the slam. A
    // transfer hands its own speed straight through.
    railFrame(t);
    if (opts && Number.isFinite(opts.speed)) {
      speed = clamp(opts.speed, GT.minEnterSpeed, GT.maxSpeed);
    } else {
      const along = st.velocity.dot(_travel);
      const slam = clamp(-st.velocity.y, 0, 9) * GT.slamToSpeed;
      speed = clamp(along + slam, GT.minEnterSpeed, GT.maxSpeed);
    }
    entrySpeed = speed;

    side = chooseSide(st);
    info.side = side;

    // Riding backwards relative to where the bike is pointing?
    _fwd.set(0, 0, 1).applyQuaternion(st.quaternion);
    switchStance = _fwd.dot(_travel) < 0;

    character = characterFor(info.rail);
    entrySteer = clamp(ctx.input?.state?.steer ?? 0, -1, 1);
    entryLean = clamp(ctx.input?.state?.lean ?? 0, -1, 1);
    type = (opts && opts.type) || pickType(ctx.input, entrySteer, entryLean);
    info.grindType = type.id;

    const seeded = opts && Number.isFinite(opts.balance) ? opts.balance : 0;
    balance = seeded || GT.balanceSeed * (wobble() >= 0 ? 1 : -1);
    balanceVel = 0;
    critical = false;

    grindTime = 0;
    distance = 0;
    segPoints = 0;
    if (!(opts && opts.keepRun)) { runPoints = 0; transferChain = 0; reverts = 0; }
    lastTypeChange = 0;
    pendingType = null;
    pendingTypeTime = 0;
    surfaceTimer = GT.surfaceEvery;
    surfaceBlend = 0;
    bankAmount = 0;
    sparkTimer = 0;
    audioTimer = 0;

    if (p.enterGrind(info) === false) { info.rail = null; return false; }

    // Seat the bike on the line on the very frame it is acquired — otherwise the
    // rider visibly pops up to 45 cm onto the rail on the first step.
    sampleSurface(1 / 120, true);
    railFrame(t);
    info.tangent.copy(_travel);
    info.normal.copy(_up);
    publishState(st, applyTransform(st, 0, true));

    active = true;
    api.active = true;
    api.rail = info.rail;
    api.railType = railType;
    api.type = type.id;
    api.typeName = type.label;
    api.trickName = nameFor(type, switchStance);
    api.balance = balance;
    api.critical = false;
    api.entrySpeed = entrySpeed;

    setPose(type, 1);

    const transferred = !!(opts && opts.transfer) || sinceExit < GT.transferWindow;
    if (transferred) transferChain++;

    const detail = {
      type: type.id,
      name: api.trickName,
      rail: railType,
      railObject: info.rail,
      t,
      speed,
      side,
      switch: switchStance,
      difficulty: type.diff * material.balance,
      base: Math.round(type.base * material.points),
      transfer: transferred,
      transferChain,
    };
    ctx.emit?.('grindStart', detail);
    callFirst(ctx.player?.tricks, TRICK_START_FNS, detail);
    ctx.audio?.play?.('grindStart', detail);

    if (transferred) {
      const payload = {
        source: 'grind',
        type: 'transfer',
        name: 'Rail Transfer',
        points: Math.round(GT.transferPoints * (1 + 0.35 * (transferChain - 1))),
        rail: railType,
        chain: transferChain,
      };
      ctx.emit?.('grindTransfer', payload);
      handOff(payload);
      ctx.fx?.shake?.(0.14);
    }

    // A decisive burst on contact reads as the pegs biting the rail.
    _tmpB.copy(_travel).multiplyScalar(-1);
    _tmpB.y += 0.35;
    if (material.spark > 0.4) {
      ctx.fx?.spark?.(info.point, _tmpB, Math.round(10 + 10 * material.spark), 0.7 + material.spark * 0.6);
    }
    if (material.dust > 0.4) {
      ctx.fx?.dust?.(info.point, 8, 'concrete', _tmpB, 1.1);
    }

    sinceExit = 0;
    ctx.input?.consumeBuffer?.('grind');
    return true;
  }

  // ----------------------------------------------------------------- exiting

  /**
   * Leave the rail.
   *   'hop'     — popped off deliberately: rail speed plus a real pop off the line
   *   'end'     — rode off the end: projected forward along the tangent
   *   'release' — let go of the button: gentle drop off
   *   'stall'   — ran out of speed going uphill
   *   'abort'   — something else (a bail, a respawn) took the chassis away
   */
  function exit(reason, allowTransfer) {
    if (!active) return;
    const p = phys();
    const st = p?.state;

    flushTrick(reason);

    const wasRail = info.rail;
    active = false;
    api.active = false;

    if (reason !== 'abort' && st && p && wasRail) {
      railFrame(t);

      // Rail-to-rail transfer: is there another line within reach off the end?
      if (allowTransfer && tryTransfer()) return;

      st.velocity.copy(_travel).multiplyScalar(speed);

      // 180 revert out: flick the stick as you leave and the bike swaps ends while
      // the velocity keeps going, so you drop into the next feature fakie.
      let reverted = false;
      if (speed > GT.revertSpeed && Math.abs(ctx.input?.state?.steer ?? 0) > GT.revertSteer &&
        (reason === 'hop' || reason === 'end' || reason === 'release')) {
        _qStep.setFromAxisAngle(WORLD_UP, Math.PI);
        st.quaternion.premultiply(_qStep);
        st.quaternion.normalize();
        reverted = true;
        reverts++;
      }

      if (reason === 'hop') {
        _exitDir.copy(_up).lerp(WORLD_UP, 0.35);
        if (_exitDir.lengthSq() < 1e-6) _exitDir.copy(WORLD_UP); else _exitDir.normalize();
        st.velocity.addScaledVector(_exitDir, GT.hopBonus);
        p.exitGrind(_exitDir);           // physics adds its own grindOutPop along this
      } else {
        st.velocity.y += GT.endLift;
        p.exitGrind(null);
      }

      if (reverted) {
        const payload = {
          source: 'grind', type: 'revert', name: '180 Revert',
          points: GT.revertPoints, rail: railType,
        };
        ctx.emit?.('revert', payload);
        handOff(payload);
      }
    } else if (st) {
      st.rail = null;
    }

    setPose(type, 0);

    const detail = {
      reason,
      type: type.id,
      name: api.trickName,
      rail: railType,
      railObject: wasRail,
      points: Math.round(runPoints),
      duration: grindTime,
      distance,
      transfers: transferChain,
      reverts,
      speed,
    };
    ctx.emit?.('grindEnd', detail);
    callFirst(ctx.player?.tricks, TRICK_END_FNS, detail);
    ctx.audio?.play?.('grindEnd', detail);

    info.rail = null;
    api.rail = null;
    api.balance = 0;
    api.critical = false;
    balance = 0;
    balanceVel = 0;
    critical = false;
    speed = 0;
    grindTime = 0;
    cooldown = GT.exitCooldown;
    // Only a deliberate exit leaves the transfer window open: stalling out or
    // being kicked off the rail must never credit the next grind as a transfer.
    sinceExit = (reason === 'hop' || reason === 'end' || reason === 'release') ? 0 : 999;
    pushAudio(true);
    ctx.input?.consumeBuffer?.('grind');
  }

  /** Try to step straight onto another line at the end of this one. */
  function tryTransfer() {
    const c = col();
    if (!c?.nearestRail) return false;
    const prevRail = info.rail;
    const prevBalance = balance;
    // enter() mutates the rail bookkeeping as it goes, so snapshot enough to put
    // the old grind back if the new rail turns out to be unusable. This runs only
    // at the end of a rail, so the one small object it costs is not in a hot path.
    const snap = { t, dir, speed, railType, railLength, railClosed, railLift, material };

    _pegPoint.copy(info.point).addScaledVector(_travel, GT.transferReach);
    const hit = c.nearestRail(_pegPoint, GT.transferDist, _travel);
    if (!hit || !hit.rail || hit.rail === prevRail) return false;

    // Re-entering reseeds the drift but keeps the run's score and chain count.
    if (enter(hit, {
      speed: snap.speed,
      keepRun: true,
      transfer: true,
      balance: prevBalance * 0.5,
      type,
    })) return true;

    info.rail = prevRail;
    t = snap.t; dir = snap.dir; speed = snap.speed;
    railType = snap.railType; railLength = snap.railLength;
    railClosed = snap.railClosed; railLift = snap.railLift; material = snap.material;
    c.railPointAt(prevRail, t, info.point);
    railFrame(t);
    return false;
  }

  /** Bank the current trick's points into the combo and reset the segment. */
  function flushTrick(reason) {
    if (!(segPoints >= 1)) { segPoints = 0; return; }
    const payload = {
      source: 'grind',
      type: type.id,
      name: api.trickName,
      points: Math.round(segPoints),
      rail: railType,
      duration: grindTime - lastTypeChange,
      distance,
      switch: switchStance,
      reason: reason || 'grind',
    };
    runPoints += segPoints;
    segPoints = 0;
    handOff(payload);
  }

  function bail(reason) {
    const p = phys();
    flushTrick(reason);
    active = false;
    api.active = false;
    api.rail = null;
    setPose(type, 0);
    const detail = {
      reason, type: type.id, name: api.trickName, rail: railType,
      railObject: info.rail, points: Math.round(runPoints),
      duration: grindTime, distance, bailed: true,
    };
    info.rail = null;
    ctx.emit?.('grindEnd', detail);
    callFirst(ctx.player?.tricks, TRICK_END_FNS, detail);
    balance = 0;
    balanceVel = 0;
    critical = false;
    api.balance = 0;
    api.critical = false;
    cooldown = GT.exitCooldown * 3;
    sinceExit = 999;                     // a crash never chains into a transfer
    pushAudio(true);
    // physics.bail() emits the canonical 'bail' event that scoring/tricks listen to.
    p?.forceBail?.(reason);
  }

  // ------------------------------------------------------------- audio and fx

  function pushAudio(force) {
    const a = ctx.audio;
    if (!a) return;
    if (!active) {
      if (!audioLive && !force) return;
      audioLive = false;
      audioParams.active = false;
      audioParams.gain = 0;
      audioParams.speed = 0;
      callFirst(a, AUDIO_SET_FNS, audioParams);
      return;
    }
    audioLive = true;
    audioParams.active = true;
    audioParams.speed = speed;
    audioParams.material = railType;
    audioParams.balance = balance;
    audioParams.critical = critical;
    audioParams.type = type.id;
    // Sawtooth pitch rises with speed; concrete grinds lower and rougher than steel.
    audioParams.pitch = (railType === 'ledge' ? 0.55 : 1.0) * (0.55 + clamp(speed / 14, 0, 1) * 0.85);
    audioParams.gain = clamp(speed / 9, 0, 1) * (railType === 'ledge' ? 0.75 : 1.0);
    callFirst(a, AUDIO_SET_FNS, audioParams);
  }

  /**
   * Supplementary contact FX. particles.js already runs a speed-scaled spark
   * emitter off `state.mode === 'grind'`, so this is a light top-up keyed to the
   * rail material rather than a second full stream.
   */
  function emitFX(fdt) {
    const fx = ctx.fx;
    if (!fx) return;
    sparkTimer -= fdt;
    if (sparkTimer > 0 || speed < 2.2) return;
    sparkTimer = GT.sparkInterval;
    _tmpB.copy(_travel).multiplyScalar(-(0.4 + speed * 0.05));
    _tmpB.y += 0.5;
    const heat = material.spark * clamp(speed / 9, 0.25, 1.4);
    if (heat > 0.28) fx.spark?.(info.point, _tmpB, 2, 0.5 + heat * 0.7);
    if (material.dust > 0.4 && speed > 4) fx.dust?.(info.point, 1, 'concrete', _tmpB, 0.6);
  }

  // ---------------------------------------------------------------- the step

  /**
   * Build the rail-frame orientation with the trick pose layered on, then place the
   * contact origin so the peg lands EXACTLY on the ride edge. `railFrame(t)` and
   * `info.point` must already be current. `hard` snaps (entry) instead of easing.
   * Returns the applied lean, which the animator reads off state.lean.
   */
  function applyTransform(st, fdt, hard) {
    const bankTarget = curveBank();
    bankAmount = hard ? bankTarget : damp(bankAmount, bankTarget, GT.bankLambda, fdt);
    poseZ = hard ? type.z : damp(poseZ, type.z, 7.0, fdt);

    _right.crossVectors(_up, _travel);
    if (_right.lengthSq() < 1e-8) _right.set(1, 0, 0); else _right.normalize();
    _fwd.crossVectors(_right, _up);
    if (_fwd.lengthSq() < 1e-8) _fwd.copy(_travel); else _fwd.normalize();
    _basis.makeBasis(_right, _up, _fwd);
    _qTarget.setFromRotationMatrix(_basis);

    // Trick pose: yaw across the rail, then nose up/down, then the roll (type
    // offset + balance meter + carve bank). Sign conventions match bikePhysics.
    const yawOff = type.yaw * side;
    if (Math.abs(yawOff) > 1e-4) {
      _qStep.setFromAxisAngle(AXIS_Y, yawOff);
      _qTarget.multiply(_qStep);
    }
    const noseUp = type.pitch + (type.axis === 'lean' ? balance * 0.16 * type.leanSign : 0);
    if (Math.abs(noseUp) > 1e-4) {
      _qStep.setFromAxisAngle(AXIS_X, -noseUp);
      _qTarget.multiply(_qStep);
    }
    // Weight over the line: the chassis rolls toward the rail so the loaded peg
    // carries the rider's mass. Rolling the chassis rotates the peg offset below,
    // so the contact stays exact — this only changes how the pose reads.
    const weightLean = side * GT.railLean
      * clamp(speed / GT.railLeanSpeed, GT.railLeanFloor, 1);
    const leanRight = type.roll * side
      + weightLean
      + (type.axis === 'lean' ? 0 : balance * GT.balanceRoll * side)
      + bankAmount;
    if (Math.abs(leanRight) > 1e-4) {
      _qStep.setFromAxisAngle(AXIS_Z, -leanRight);
      _qTarget.multiply(_qStep);
    }

    if (hard) {
      st.quaternion.copy(_qTarget);
    } else {
      const lambda = grindTime < GT.snapTime ? GT.orientSnap : GT.orientLambda;
      st.quaternion.slerp(_qTarget, 1 - Math.exp(-lambda * fdt));
    }
    st.quaternion.normalize();

    _contact.copy(info.point).addScaledVector(_up, railLift);
    _localOff.set(side * GT.pegSide, GT.pegDrop, poseZ).applyQuaternion(st.quaternion);
    st.position.copy(_contact).sub(_localOff);
    return leanRight;
  }

  /** Everything camera.js / riderAnim.js / particles.js / audio.js read off state. */
  function publishState(st, leanRight) {
    st.velocity.copy(_travel).multiplyScalar(speed);
    st.speed = speed;
    st.forward.set(0, 0, 1).applyQuaternion(st.quaternion);
    st.up.set(0, 1, 0).applyQuaternion(st.quaternion);
    st.right.set(1, 0, 0).applyQuaternion(st.quaternion);
    st.yaw = Math.atan2(st.forward.x, st.forward.z);
    st.pitch = Math.asin(clamp(st.forward.y, -1, 1));
    st.roll = Math.atan2(st.right.y, st.up.y);
    st.forwardSpeed = st.velocity.dot(st.forward);
    st.lateralSpeed = st.velocity.dot(st.right);
    st.verticalSpeed = st.velocity.y;
    st.wheelSpin = speed / GT.wheelRadius;
    st.lean = leanRight;
    st.balance = balance;
    st.grounded = true;
    st.airTime = 0;
    st.surfaceNormal.copy(_up);
    st.surfaceType = railType;
    st.surfaceTilt = Math.sqrt(Math.max(0, 1 - _up.y * _up.y));
    st.rail = info;
  }

  function changeType(next) {
    flushTrick('switch');
    type = next;
    info.grindType = next.id;
    api.type = next.id;
    api.typeName = next.label;
    api.trickName = nameFor(next, switchStance);
    lastTypeChange = grindTime;
    pendingType = null;
    pendingTypeTime = 0;
    balance *= GT.balanceKeepOnSwitch;
    balanceVel *= 0.35;
    setPose(next, 1);
    ctx.emit?.('grindSwitch', { type: next.id, name: api.trickName, rail: railType });
  }

  function step(fdt, input) {
    const p = phys();
    const c = col();
    const st = p?.state;
    if (!st || !c || !info.rail) { exit('abort', false); return; }

    grindTime += fdt;

    // --- speed along the line ----------------------------------------------
    railFrame(t);
    speed += -GT.gravity * _travel.y * fdt;

    const push = clamp(input.state.throttle, 0, 1);
    if (push > 0.02 && speed < GT.pumpCap) {
      speed += GT.pumpAccel * push * fdt * clamp(1 - speed / GT.pumpCap, 0, 1);
    }
    speed -= (material.friction + material.drag * speed * speed) * fdt;
    if (speed > GT.maxSpeed) speed = GT.maxSpeed;
    if (speed < GT.stallSpeed) { exit('stall', false); return; }

    // --- advance the arc ----------------------------------------------------
    const ds = speed * fdt;
    distance += ds;
    t += (ds / railLength) * dir;

    let ranOut = false;
    if (railClosed) t -= Math.floor(t);
    else if (t >= 1) { t = 1; ranOut = true; }
    else if (t <= 0) { t = 0; ranOut = true; }

    info.t = t;
    c.railPointAt(info.rail, t, info.point);
    sampleSurface(fdt);
    railFrame(t);
    info.tangent.copy(_travel);
    info.normal.copy(_up);

    // --- balance ------------------------------------------------------------
    const diff = type.diff * material.balance;
    const growth = Math.min(GT.driftMax, 1 + grindTime * GT.driftGrowth);
    const aid = 1 - GT.speedAid * clamp(speed / GT.speedAidAt, 0, 1);
    const drive = type.axis === 'lean'
      ? clamp(input.state.lean, -1, 1) * type.leanSign
      : clamp(input.state.steer, -1, 1) * side;

    let acc = GT.balanceGravity * diff * aid * growth * balance;
    acc += drive * GT.balanceInput;
    // The wobble grows with the SQUARE of the ramp: a short grind is a formality,
    // a long one genuinely gets away from you, which is what forces you to hop out.
    acc += wobble() * GT.driftAmp * diff * growth * growth;
    balanceVel += acc * fdt;
    balanceVel -= balanceVel * clamp(GT.balanceDamp * fdt, 0, 1);
    balance = clamp(balance + balanceVel * fdt, -1.35, 1.35);
    critical = Math.abs(balance) > GT.criticalAt;

    if (Math.abs(balance) >= GT.balanceBail) {
      bail(balance > 0 ? 'grind-out' : 'grind-in');
      return;
    }

    // --- mid-grind trick change ---------------------------------------------
    const want = pickType(input, entrySteer, entryLean);
    if (want !== type && grindTime - lastTypeChange > 0.28) {
      if (want === pendingType) {
        pendingTypeTime += fdt;
        if (pendingTypeTime > 0.07) changeType(want);
      } else {
        pendingType = want;
        pendingTypeTime = 0;
      }
    } else if (want === type) {
      pendingType = null;
      pendingTypeTime = 0;
    }

    // --- points -------------------------------------------------------------
    segPoints += type.base * material.points * GT.holdRate * clamp(speed / 7, 0.35, 1.35) * fdt;
    segPoints += GT.distanceRate * material.points * ds * 0.5;

    // --- orientation + placement + shared readouts ---------------------------
    publishState(st, applyTransform(st, fdt, false));

    emitFX(fdt);
    audioTimer -= fdt;
    if (audioTimer <= 0) { audioTimer = GT.audioInterval; pushAudio(false); }

    // --- exits ---------------------------------------------------------------
    const hopHeld = input.held('hop');
    if (!hopHeld) hopLatched = false;
    else if (!hopLatched) { exit('hop', false); return; }

    // Only running off the end chains straight onto the next line; letting go of
    // the button is a deliberate drop-off and must not vacuum you onto a neighbour.
    if (ranOut) { exit('end', true); return; }
    if (!input.held('grind') && grindTime > GT.minHoldTime) exit('release', false);
  }

  // ------------------------------------------------- adopting a foreign grind

  /**
   * Reusable nearestRail-shaped payload for a grind that arrived from outside
   * this module (a scripted sequence, a replay, the screenshot harness) — those
   * callers set `physics.state.mode = 'grind'` and hand physics a rail, but
   * nothing solves the chassis onto the line, so the bike keeps whatever
   * free-body transform it happened to have: hanging above and behind the rail
   * with daylight under both wheels. Adopting the rail routes it through the
   * exact same contact solve a player-initiated grind uses.
   */
  const _adopt = {
    rail: null,
    t: 0.5,
    point: new THREE.Vector3(),
    tangent: new THREE.Vector3(0, 0, 1),
    type: 'rail',
    radius: 0.03,
  };
  let adoptFailed = null;      // rail we already refused: never retry it every frame

  function adoptExternalGrind(st) {
    const c = col();
    if (disposed || active || !c?.railPointAt || !c?.railTangentAt) return false;
    const hint = st.rail;
    if (!hint || hint === info) return false;
    // The hand-off is either a rail record ({ curve, radius, type }) or a hit
    // payload wrapping one.
    const rail = hint.curve ? hint : (hint.rail && hint.rail.curve ? hint.rail : null);
    if (!rail || rail === adoptFailed) return false;

    let at = Number.isFinite(hint.t) ? clamp(hint.t, 0, 1) : NaN;
    if (!Number.isFinite(at)) {
      const near = c.nearestRail?.(st.position, 4.0, null);
      at = near && near.rail === rail ? clamp(near.t, 0, 1) : 0.5;
    }
    _adopt.rail = rail;
    _adopt.t = at;
    c.railPointAt(rail, at, _adopt.point);
    c.railTangentAt(rail, at, _adopt.tangent);
    _adopt.type = typeof hint.type === 'string' ? hint.type : (rail.type || 'rail');
    _adopt.radius = Number.isFinite(rail.radius) ? rail.radius
      : (Number.isFinite(hint.radius) ? hint.radius : 0.03);

    // A staged grind can arrive stationary; give it a rideable speed rather than
    // stalling out on the first step.
    const along = Math.abs(st.velocity.dot(_adopt.tangent));
    const held = cooldown;
    cooldown = 0;
    const ok = enter(_adopt, {
      speed: Math.max(along, st.speed || 0, GT.minEnterSpeed + 3.4),
      type: GRIND_TYPES[hint.grindType] || undefined,
    });
    if (!ok) { cooldown = held; adoptFailed = rail; return false; }
    adoptFailed = null;
    return true;
  }

  // ------------------------------------------------- contact presentation

  const contactPoint = new THREE.Vector3();
  const groundPoint = new THREE.Vector3();
  const groundNormal = new THREE.Vector3(0, 1, 0);
  const groundFrom = new THREE.Vector3();
  let groundValid = false;
  let groundProbe = 0;
  let fxLevel = 0;             // 0..1 eased presence so the rig never pops off
  // The rig owns its clock. `ctx.time.elapsed` is a shared accumulator that other
  // systems write to and that can run backwards or stall; a particle whose age
  // goes negative is simply never drawn, so the shower must not depend on it.
  let fxClock = 0;
  let fxStamp = 0;             // last wall-clock sample, ms

  /** Peg `i` (0 rear, 1 front) as a world point on the rail. */
  function pegContact(i, out) {
    out.copy(contactPoint);
    if (type.dual) out.addScaledVector(info.tangent, (i ? 1 : -1) * GT.pegSpan);
    return out;
  }

  /** One spark: shed backwards along the line, fanned off the tube, then up. */
  function spawnSpark() {
    _fxT.copy(info.tangent);
    _fxN.copy(info.normal);
    _fxR.crossVectors(_fxN, _fxT);
    if (_fxR.lengthSq() < 1e-8) _fxR.set(1, 0, 0); else _fxR.normalize();

    const shed = (GT.sparkSpeed + speed * GT.sparkSpeedPerSpeed) * (0.35 + rng() * 1.45);
    pegContact(rng() < 0.5 ? 0 : 1, _fxA)
      .addScaledVector(_fxT, (rng() * 2 - 1) * 0.05)
      .addScaledVector(_fxR, side * (0.15 + rng() * 0.7) * 0.10);
    // Friction throws the swarf back down the line first, fans it off the tube,
    // and only then does buoyancy carry it up — a cone, not a ball.
    _fxB.copy(_fxT).multiplyScalar(-shed)
      .addScaledVector(_fxR, ((rng() * 2 - 1) * 0.62 + side * 0.30) * shed * 0.55)
      .addScaledVector(_fxN, (0.05 + rng() * 0.48) * shed);

    const life = GT.sparkLifeMin + rng() * (GT.sparkLifeMax - GT.sparkLifeMin);
    const hot = 0.45 + rng() * 0.55;
    const size = GT.sparkSizeMin + rng() * (GT.sparkSizeMax - GT.sparkSizeMin);
    // Born with a random amount of flight already behind it, so the shower reads
    // as established on the very first frame it is rendered.
    // Emitted in linear HDR well above 1.0: the shot is golden-hour daylight, so
    // anything at scene brightness simply disappears into it, and the bloom pass
    // only picks up what is over threshold.
    rig.spark(_fxA, _fxB, life, size, GT.sparkSmear,
      1.9 + 5.4 * hot, 0.55 + 2.1 * hot, 0.10 + 0.30 * hot * hot, rng());
  }

  /** No contact this frame: fade the rig out and let live sparks finish. */
  function retireFX(dt) {
    fxLevel = fxLevel > 0.001 ? damp(fxLevel, 0, 9, dt) : 0;
    _fxA.set(0, -1e5, 0);
    for (let i = 0; i < FLARES; i++) rig.flare(i, _fxA, 0, 0, 0, 0);
    rig.setLight(_fxA, 0);
    rig.hideBlobs();
    rig.idleHot();
    groundValid = false;
  }

  /**
   * Runs once per rendered frame, from the rig's meshes. Deliberately NOT in the
   * fixed step: the fixed step stops when the game is paused or frozen, and a
   * grind that loses its sparks and its contact shadow the moment the clock
   * stops is exactly what makes a rider read as pasted over the level.
   */
  function frameTick() {
    if (disposed) return;
    const st = phys()?.state;
    const c = col();
    // Wall clock, not `ctx.time.dt`: that only advances once per rendered frame,
    // and the rig has to keep time between frames as well as across them.
    const stamp = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (fxStamp === 0) fxStamp = stamp - 16;
    let dt = (stamp - fxStamp) / 1000;
    fxStamp = stamp;
    if (!(dt > 0)) dt = 1 / 60;
    else if (dt > 0.05) dt = 0.05;
    fxClock += dt;
    const now = fxClock;
    rig.setTime(now);

    if (!st) { retireFX(dt); return; }
    if (!active && st.mode === 'grind' && st.rail) adoptExternalGrind(st);
    if (active && st.mode !== 'grind') exit('abort', false);
    if (!active || !info.rail) { retireFX(dt); return; }

    // Re-solve the contact from the spline when the fixed step is not advancing,
    // so a paused or staged grind is welded to the rail rather than frozen
    // wherever the last free-body transform left it.
    const stalled = ctx.flags?.paused === true || ctx.flags?.freeze === true;
    if (stalled && c?.railTangentAt) {
      railFrame(t);
      info.tangent.copy(_travel);
      info.normal.copy(_up);
      publishState(st, applyTransform(st, 0, true));
    }

    contactPoint.copy(info.point).addScaledVector(info.normal, railLift);
    // Contact is binary: the peg is either loading the rail or it is not, so the
    // rig comes up on the frame the grind starts and only ever eases OUT (see
    // retireFX). Fading it IN would mean the first frames of every grind — and
    // every staged frame, which is all a paused capture ever gets — show a bike
    // on a rail with no sparks and no contact shadow.
    fxLevel = 1;

    // --- shower ------------------------------------------------------------
    const heat = material.spark * clamp(speed / 9, 0.35, 1.5);
    if (heat > 0.22) {
      const want = Math.min(GT.showerMax,
        Math.round((GT.showerBase + speed * GT.showerPerSpeed) * clamp(heat, 0, 1.4) * fxLevel));
      const n = rig.deficit(want);
      for (let i = 0; i < n; i++) spawnSpark();
    }

    // --- contact bloom + its light ------------------------------------------
    // One small sprite per loaded peg, plus a single shared light: the point of
    // the sprite is a bloom seed on the metal, not a lamp.
    const phase = character ? character.phaseA : 0;
    const lit = heat > 0.18;
    const loaded = type.dual ? 2 : 1;
    for (let i = 0; i < FLARES; i++) {
      if (!lit || i >= loaded) { rig.flare(i, contactPoint, 0, 0, 0, 0); continue; }
      const flick = 0.62 + 0.38 * Math.sin(now * (43.0 + i * 11.0) + phase + i * 2.1);
      const s = GT.flareSize * (0.62 + 0.58 * clamp(heat, 0, 1.3)) * fxLevel;
      pegContact(i, _fxA);
      rig.flare(i, _fxA, s, 5.2 * flick, 2.1 * flick, 0.55 * flick);
    }
    if (lit) {
      const flick = 0.72 + 0.28 * Math.sin(now * 47.0 + phase);
      rig.setLight(contactPoint, GT.contactLight * clamp(heat, 0, 1.2) * flick * fxLevel);
    } else {
      rig.setLight(contactPoint, 0);
    }
    rig.idleHot();

    // --- contact shadow ------------------------------------------------------
    // Metal-on-metal darkening exactly where each loaded peg sits on the tube.
    const smudge = 0.16 + clamp(speed, 0, 14) * 0.022;
    for (let i = 0; i < 2; i++) {
      if (i >= loaded) { rig.blob(2 + i, contactPoint, info.normal, info.tangent, 0.1, 0.1, 0, 0.9); continue; }
      pegContact(i, _fxA);
      rig.blob(2 + i, _fxA, info.normal, info.tangent,
        smudge, Math.max(0.030, railLift * 1.15), 0.52 * fxLevel, 0.92);
    }

    groundProbe -= dt;
    if (!groundValid || groundProbe <= 0) {
      groundProbe = 0.08;
      groundValid = false;
      if (c?.raycastDown) {
        groundFrom.copy(st.position).addScaledVector(WORLD_UP, 0.35);
        const h = c.raycastDown(groundFrom, 9.0);
        if (h && h.hit !== false && h.point) {
          groundPoint.copy(h.point);
          if (h.normal && h.normal.y > 0.2) groundNormal.copy(h.normal).normalize();
          else groundNormal.set(0, 1, 0);
          groundValid = true;
        }
      }
    }
    if (groundValid) {
      const drop = clamp(st.position.y - groundPoint.y, 0, GT.shadowFade);
      const fade = 1 - drop / GT.shadowFade;
      const grow = 1 + drop * GT.shadowSpread;
      _fxG.copy(groundPoint).addScaledVector(groundNormal, 0.018);
      _fxA.set(0, 0, 1).applyQuaternion(st.quaternion);
      // Wide soft occlusion of the whole rig, then a tight dark core under the
      // bike — the core is what actually anchors it to the ground plane.
      rig.blob(0, _fxG, groundNormal, _fxA,
        0.72 * grow, 0.36 * grow, GT.shadowStrength * 0.5 * fade * fxLevel, 0.95);
      rig.blob(1, _fxG, groundNormal, _fxA,
        0.34 * (1 + drop * 0.35), 0.16 * (1 + drop * 0.35),
        GT.shadowStrength * fade * fxLevel, 0.72);
    } else {
      _fxA.set(0, 0, 1);
      rig.blob(0, contactPoint, WORLD_UP, _fxA, 0.1, 0.1, 0, 0.9);
      rig.blob(1, contactPoint, WORLD_UP, _fxA, 0.1, 0.1, 0, 0.9);
    }
  }

  const rig = createContactRig(ctx, frameTick);

  // ------------------------------------------------------------------- api

  const api = {
    // --- contract ----------------------------------------------------------
    active: false,
    balance: 0,
    rail: null,
    t: 0,
    type: null,

    // --- HUD / animation readouts ------------------------------------------
    critical: false,
    typeName: '',
    trickName: '',
    railType: 'rail',
    speed: 0,
    entrySpeed: 0,
    grindTime: 0,
    distance: 0,
    points: 0,
    progress: 0,
    side: 1,
    switch: false,
    transfers: 0,
    reverts: 0,
    contactPoint: info.point,
    balanceAxis: 'steer',
    types: GRIND_TYPES,
    materials: GRIND_MATERIALS,
    tuning: GT,

    /** 0..1 how close the meter is to throwing you off — drives the HUD bar. */
    get danger() { return clamp(Math.abs(api.balance) / GT.balanceBail, 0, 1); },

    /** What the HUD prints under the balance meter while grinding. */
    get label() { return api.active ? api.trickName : ''; },

    fixedUpdate(fdt, c) {
      if (disposed) return;
      const context = c || ctx;
      const input = context?.input;
      const st = phys()?.state;
      if (!input || !st) return;

      if (cooldown > 0) cooldown -= fdt;
      sinceExit += fdt;

      // Someone else parked the chassis on a rail without coming through here
      // (a scripted sequence, a replay, the shot harness). Take ownership so the
      // transform is solved from the spline instead of left as a free-body pose.
      if (!active && st.mode === 'grind' && st.rail) adoptExternalGrind(st);

      if (active) {
        // Anything else (a bail, a respawn, the reset key) taking the chassis away
        // ends the grind cleanly rather than leaving us fighting for the transform.
        if (st.mode !== 'grind') exit('abort', false);
        else step(fdt, input);
      }

      if (!active) {
        const hit = findRail(st, input);
        if (hit) {
          hopLatched = input.held('hop');
          enter(hit, null);
        } else if (audioLive) {
          pushAudio(true);
        }
      }

      // Publish everything the HUD, animator and camera read.
      api.active = active;
      api.balance = balance;
      api.critical = critical;
      api.rail = active ? info.rail : null;
      api.t = t;
      api.type = active ? type.id : null;
      api.typeName = active ? type.label : '';
      api.railType = railType;
      api.speed = active ? speed : 0;
      api.entrySpeed = entrySpeed;
      api.grindTime = active ? grindTime : 0;
      api.distance = active ? distance : 0;
      api.points = Math.round(runPoints + segPoints);
      api.progress = active ? t : 0;
      api.side = side;
      api.switch = switchStance;
      api.transfers = transferChain;
      api.reverts = reverts;
      api.balanceAxis = type.axis;
    },

    /**
     * Frame hook. main.js does not call it — the contact rig drives itself off
     * the render — but calling it is safe and idempotent within a frame.
     */
    update() { if (!disposed) rig.tick(); },

    /** The world-space point where the loaded peg meets the line. */
    get contact() { return contactPoint; },

    /** Force the rider off the rail (session end, pause, results screen). */
    release(reason = 'abort') { if (active) exit(reason, false); },

    dispose() {
      if (disposed) return;
      disposed = true;
      if (active) {
        active = false;
        const st = phys()?.state;
        if (st) st.rail = null;
      }
      api.active = false;
      api.rail = null;
      info.rail = null;
      pushAudio(true);
      rig.dispose();
    },
  };

  return api;
}
