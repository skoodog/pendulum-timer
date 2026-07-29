// Chase camera (spine).
//
// Responsibilities:
//   * spring-damper follow HARD-BOUND to the rider's rendered root, not to a
//     physics number the visual rig may lag behind,
//   * a framing solver that guarantees the rider is inside a safe box on screen
//     and never smaller than a floor fraction of frame height,
//   * speed FOV, air pull-back, grind framing, bail orbit, screen shake,
//   * ground clearance + line-of-sight push-in against `world.collision`,
//   * a cinematic framing solver (`frameCinematic` / `CINEMATIC_SHOTS`) that
//     solves staged and marketing shots from the rider's real measured size and
//     the real ground under them, instead of hand-typed offsets.
//
// Why the rider root and not `physics.state.position`: the two DO diverge.
// `riderAnim` writes the visual transform once per rendered frame; physics runs
// on its own fixed clock and is respawned/teleported from menus, the session
// flow and the screenshot harness. When a frame is presented between a respawn
// and the next anim update, a state-driven camera points at empty ground while
// the rider is still standing somewhere else — which is exactly how a gameplay
// frame ends up with no player character in it. Framing what is *rendered*
// makes that failure impossible, and the NDC clamp below makes "rider off
// frame" unrepresentable rather than merely unlikely.

import * as THREE from 'three';
import { clamp, damp, lerp, wrapAngle, deg } from './mathx.js';

const UP = new THREE.Vector3(0, 1, 0);

// ---------------------------------------------------------------------------
// Module scratch. Nothing in the frame path may allocate.
// ---------------------------------------------------------------------------
const _anchor = new THREE.Vector3();       // rider root, world
const _aim = new THREE.Vector3();          // what the lens is pointed at (chest)
const _chest = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _offset = new THREE.Vector3();
const _flatVel = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _lookTarget = new THREE.Vector3();
const _lookDir = new THREE.Vector3();
const _baseDir = new THREE.Vector3();
const _tangent = new THREE.Vector3();
const _probe = new THREE.Vector3();
const _ray = new THREE.Vector3();
const _view = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _boxSize = new THREE.Vector3();
const _boxCentre = new THREE.Vector3();
const _measureBox = new THREE.Box3();

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const finite3 = (v) => !!v && isNum(v.x) && isNum(v.y) && isNum(v.z);

/** Fallback rider metrics (a 1.8 m rider on a 20" bike) if measuring fails. */
const DEFAULT_METRICS = { height: 1.77, radius: 1.02, centreY: 0.88, chestY: 1.22 };

/**
 * Measure the rider+bike once so the framing solver knows how big the subject
 * actually is (a 1.6 m rider and a 1.95 m rider do not frame the same).
 * Re-measured only when the rider is rebuilt by the creator screen.
 */
function measureSubject(rider, out) {
  const group = rider?.group;
  if (!group) return false;
  try {
    _measureBox.setFromObject(group);
  } catch (err) {
    return false;
  }
  if (_measureBox.isEmpty()) return false;
  _measureBox.getSize(_boxSize);
  _measureBox.getCenter(_boxCentre);
  if (!finite3(_boxSize) || !finite3(_boxCentre)) return false;
  if (!(_boxSize.y > 0.4) || _boxSize.y > 6) return false;      // nonsense guard

  group.updateWorldMatrix(true, false);
  const rootY = group.matrixWorld.elements[13];
  out.height = _boxSize.y;
  // Half the box diagonal: the sphere that bounds the silhouette from any
  // angle, which is what an "is it fully on screen" test needs.
  out.radius = 0.5 * Math.hypot(_boxSize.x, _boxSize.y, _boxSize.z);
  out.centreY = clamp(_boxCentre.y - rootY, 0.2, 2.4);
  out.chestY = clamp(out.centreY + out.height * 0.19, 0.4, 2.4);
  return true;
}

// ---------------------------------------------------------------------------
// Staged / cinematic shot library.
//
// Solved, not authored: each entry states the INTENT (how much of the frame the
// subject fills, how far round the rider the camera sits, how high off the
// deck, where in frame the subject lands) and the solver turns that into a
// position/FOV using the measured subject and a ground raycast. Change the
// rider height or the ground under them and the framing still holds.
//
//   fovY         vertical field of view, degrees (three.js `camera.fov`)
//   fill         subject height as a fraction of FRAME HEIGHT
//   coverage     metres that must fit across the frame (overrides `fill`)
//   azimuth      degrees around the rider from directly behind (+ = rider's right)
//   camY         camera height in metres above the GROUND under the rider
//   aimY         aim height above the rider root (null = measured chest)
//   subjectNdcY  where the subject sits vertically: +1 top of frame, -1 bottom
//   minPitchUp   force the lens to tilt at least this far up (drops the horizon)
//   minRunFrac   minimum share of the boom kept on the ground plane
//   hideRider    hide the rider body so the bike alone reads
//   driveSide    place the camera on the bike's drive side, whichever side that is
// ---------------------------------------------------------------------------
export const CINEMATIC_SHOTS = {
  /**
   * Signature marketing frame. Low (0.8 m off the deck), close, ~38 mm: the
   * rider fills ~58% of frame height and sits ABOVE centre so the head clears
   * the horizon and silhouettes against sky, with the ramp he just left
   * reading below him in the lower third.
   */
  hero: {
    fovY: 34, fill: 0.58, azimuth: 34, camY: 0.8,
    subjectNdcY: 0.30, minPitchUp: 3, minRunFrac: 0.55, aimY: null,
  },
  /** Same rig under the evening preset. */
  dusk: {
    fovY: 34, fill: 0.58, azimuth: 34, camY: 0.8,
    subjectNdcY: 0.30, minPitchUp: 3, minRunFrac: 0.55, aimY: null,
  },
  /** Rider/bike beauty: three-quarter front, chest height, ~50 mm. */
  'rider-closeup': {
    fovY: 27, fill: 0.82, azimuth: 148, camY: 1.15,
    subjectNdcY: 0.05, aimY: null,
  },
  /**
   * Drive-side drivetrain macro. Framed from the required COVERAGE (bottom
   * bracket through rear hub, plus peg and chain run) rather than a fill
   * fraction, aimed between the sprocket and the hub, at hub height, with the
   * rider body hidden so nothing but bike is in shot.
   */
  'bike-detail': {
    fovY: 30, coverage: 0.72, azimuth: 90, camY: null,
    aimTarget: 'drivetrain', subjectNdcY: 0.0, hideRider: true, driveSide: true,
  },
  /** Grind: near ledge height looking slightly up, rail running through frame. */
  grind: {
    fovY: 38, fill: 0.46, azimuth: 52, camY: 0.55,
    subjectNdcY: 0.16, minPitchUp: 2, aimY: null,
  },
};

export function createCameraRig(ctx) {
  const camera = ctx.camera;

  // --- live rig state -------------------------------------------------------
  const pos = new THREE.Vector3(0, 4, 10);
  const look = new THREE.Vector3();
  let yaw = 0;
  let fov = 62;
  let shake = 0;
  let shakeSeed = 0;
  let mode = 'chase';
  let invertLook = false;
  let lookYaw = 0;              // player right-stick orbit, radians
  let lookPitch = 0;
  let bailOrbit = 0;
  let grindBlend = 0;
  let offscreenTime = 0;
  let framedOnce = false;
  let occlusion = Infinity;     // current boom length allowed by line of sight

  // Last pose that verifiably had the rider on screen — the failsafe target.
  const safeAim = new THREE.Vector3();
  let safeYaw = 0;
  let haveSafe = false;

  // Subject metrics measured off the real rider mesh.
  const metrics = { ...DEFAULT_METRICS };
  let measuredRider = null;
  let measuredVersion = -1;

  const framing = {
    ndcX: 0, ndcY: 0, heightFrac: 0, distance: 0,
    framed: false, visible: false, subjectHeight: DEFAULT_METRICS.height,
    source: 'none',
  };

  // Baselines the settings screen's sliders were authored against.
  const SETTINGS_BASE_DISTANCE = 5.4;
  const SETTINGS_BASE_HEIGHT = 1.85;
  const BOOM_DISTANCE = 4.7;
  const BOOM_HEIGHT = 1.42;

  const TUNE = {
    // Boom: ~4.7 m behind, ~1.4 m above the contact point. With the 62 deg base
    // FOV that puts a 1.77 m rider at ~1/3 of frame height — the reference
    // framing. `state.position` sits at the wheel contact, so `height` is
    // literally "metres above the contact point".
    distance: BOOM_DISTANCE,
    height: BOOM_HEIGHT,
    lookAhead: 1.15,            // metres of lead at top speed
    lookHeight: 1.22,           // aim height above the root if there is no chest bone
    posLambda: 7.5,
    lookLambda: 11.0,
    yawLambda: 5.0,
    airDistance: 6.2,
    airHeight: 2.25,
    grindDistance: -0.45,       // deltas blended in while grinding
    grindHeight: -0.34,
    grindAzimuth: 9 * deg,
    bailDistance: 6.6,
    bailHeight: 2.4,
    bailOrbitRate: 26 * deg,
    fovBase: 62,
    fovSpeedGain: 13,
    fovAir: 4,
    lookYawRange: 52 * deg,     // right-stick orbit limits
    lookPitchRange: 20 * deg,
    lookRate: 2.6,
    lookReturn: 2.2,
    groundClearance: 0.5,
    minDistance: 1.9,
    occlusionMargin: 0.28,
    occlusionSkip: 0.55,        // ignore the feature the rider is standing on
    occlusionMin: 2.4,          // never let an occluder shove the lens closer
    occlusionEase: 3.5,         // pull in instantly, ease back out
  };

  const FRAME = {
    /** Hard floor on subject height as a fraction of frame height. */
    minHeightFrac: 0.16,
    /** The aim point must stay inside this |ndc| box on both axes. */
    maxAimNdc: 0.42,
    /** The subject must stay inside this |ndc| box to count as framed. */
    safeNdc: 0.92,
    /** Seconds the subject may be out of frame before the rig hard-snaps. */
    offscreenGrace: 0.2,
  };

  // -------------------------------------------------------------------------
  // Subject resolution
  // -------------------------------------------------------------------------

  /**
   * Fill `_anchor` (rider root) and `_aim` (chest) from the RENDERED rider, with
   * a fallback ladder: rider root -> physics state -> last good aim -> active
   * spawn point. Never the world origin. Returns false only when nothing in the
   * ladder is sane, in which case the caller leaves the camera alone rather
   * than flying it somewhere arbitrary.
   */
  function resolveSubject(c) {
    const rider = c.player?.rider;
    const state = c.player?.physics?.state;
    const statePos = finite3(state?.position) ? state.position : null;
    let source = 'none';

    // 1. The transform that is actually on screen.
    const group = rider?.group;
    if (group && group.visible !== false) {
      group.updateWorldMatrix(true, false);
      const e = group.matrixWorld.elements;
      if (isNum(e[12]) && isNum(e[13]) && isNum(e[14])) {
        // Exactly (0,0,0) means the rig has never been posed (boot, before the
        // first riderAnim update). Prefer physics for that one frame so the
        // camera does not seat itself at the world origin.
        const unposed = e[12] === 0 && e[13] === 0 && e[14] === 0;
        if (!unposed || !statePos) {
          _anchor.set(e[12], e[13], e[14]);
          source = 'rider';
        }
      }
    }

    // 2. Physics state.
    if (source === 'none' && statePos) {
      _anchor.copy(statePos);
      source = 'physics';
    }

    // 3. Last pose we know had the rider in frame.
    if (source === 'none' && haveSafe) {
      _anchor.copy(safeAim);
      source = 'last';
    }

    // 4. The active spawn point — never (0,0,0) by default.
    if (source === 'none') {
      const sp = c.world?.park?.spawnPoints;
      const p = sp && sp.find((s) => finite3(s?.position))?.position;
      if (finite3(p)) {
        _anchor.copy(p);
        source = 'spawn';
      }
    }

    framing.source = source;
    if (source === 'none') return false;

    // Subject size, measured off the real mesh and cached per rider build.
    if (rider && (rider !== measuredRider || (rider.version ?? 0) !== measuredVersion)) {
      if (measureSubject(rider, metrics)) {
        measuredRider = rider;
        measuredVersion = rider.version ?? 0;
      } else {
        Object.assign(metrics, DEFAULT_METRICS);
      }
    }
    framing.subjectHeight = metrics.height;

    // Aim: the chest bone when the rig hands us one that makes sense, else a
    // measured height above the root. The sanity clamp stops a mid-trick or
    // half-initialised bone from throwing the lens off the rider.
    _aim.copy(_anchor);
    _aim.y += metrics.chestY > 0 ? metrics.chestY : TUNE.lookHeight;
    const chest = rider?.rig?.chest;
    if (chest && source === 'rider') {
      chest.updateWorldMatrix(true, false);
      const e = chest.matrixWorld.elements;
      if (isNum(e[12]) && isNum(e[13]) && isNum(e[14])) {
        _chest.set(e[12], e[13], e[14]);
        if (_chest.distanceToSquared(_anchor) < 4.0) _aim.copy(_chest);
      }
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Framing maths (exact for a perspective camera, no projection round-trip)
  // -------------------------------------------------------------------------

  function tanHalfFovY() {
    return Math.tan(clamp(camera.fov, 5, 160) * 0.5 * deg);
  }

  function aspect() {
    return camera.aspect > 0.05 ? camera.aspect : 16 / 9;
  }

  /** Longest boom that still leaves the subject readable at the current FOV. */
  function maxReadableDistance() {
    return metrics.height / (2 * FRAME.minHeightFrac * tanHalfFovY());
  }

  /**
   * Screen position of `p` for the camera's CURRENT transform, written into
   * `out` as { x: ndcX, y: ndcY, z: view distance }. Exact, allocation free.
   */
  function screenOf(p, out) {
    camera.updateMatrixWorld(true);
    _view.copy(p).applyMatrix4(camera.matrixWorldInverse);
    const d = -_view.z;
    if (!isNum(d) || !(d > camera.near)) { out.set(0, 0, d); return out; }
    const th = tanHalfFovY();
    out.set((_view.x / d) / (th * aspect()), (_view.y / d) / th, d);
    return out;
  }

  /** Recompute the live `framing` report from the camera's current transform. */
  function evaluateFraming() {
    screenOf(_aim, _tmp);
    const d = _tmp.z;
    framing.distance = d;
    if (!isNum(d) || !(d > camera.near)) {
      framing.ndcX = 0; framing.ndcY = 0; framing.heightFrac = 0;
      framing.visible = false; framing.framed = false;
      return framing;
    }
    const th = tanHalfFovY();
    framing.ndcX = _tmp.x;
    framing.ndcY = _tmp.y;
    framing.heightFrac = metrics.height / (2 * d * th);
    // The bounding sphere, not just its centre, has to be on screen.
    const rNdcY = metrics.radius / (d * th);
    const rNdcX = rNdcY / aspect();
    framing.visible = Math.abs(framing.ndcX) - rNdcX < 1
      && Math.abs(framing.ndcY) - rNdcY < 1;
    framing.framed = framing.visible
      && Math.abs(framing.ndcX) <= FRAME.safeNdc
      && Math.abs(framing.ndcY) <= FRAME.safeNdc
      && framing.heightFrac >= FRAME.minHeightFrac;
    return framing;
  }

  /**
   * Point the lens at `_lookTarget`, but never further off the subject than the
   * framing box allows. This is the hard guarantee: whatever the spring, the
   * speed lead or the player's look stick want, the aim direction is clamped
   * into a cone around the rider, so the rider cannot leave frame.
   */
  function aimAtSubject() {
    _baseDir.copy(_aim).sub(camera.position);
    const d = _baseDir.length();
    if (!(d > 1e-4) || !finite3(_baseDir)) return;
    _baseDir.multiplyScalar(1 / d);

    _lookDir.copy(_lookTarget).sub(camera.position);
    if (!(_lookDir.lengthSq() > 1e-8) || !finite3(_lookDir)) _lookDir.copy(_baseDir);
    else _lookDir.normalize();

    // Cone half-angle that keeps the aim point inside |ndc| <= maxAimNdc.
    // ndc = tan(theta) / tan(fov/2), so theta_max = atan(maxAimNdc * tan(fov/2)).
    const maxAng = Math.atan(FRAME.maxAimNdc * tanHalfFovY());
    const c = clamp(_lookDir.dot(_baseDir), -1, 1);
    if (c < Math.cos(maxAng)) {
      _tangent.copy(_lookDir).addScaledVector(_baseDir, -c);
      if (_tangent.lengthSq() > 1e-10) {
        _tangent.normalize();
        _lookDir.copy(_baseDir).multiplyScalar(Math.cos(maxAng))
          .addScaledVector(_tangent, Math.sin(maxAng));
      } else {
        _lookDir.copy(_baseDir);
      }
    }

    _tmp.copy(camera.position).addScaledVector(_lookDir, Math.max(d, 0.5));
    camera.up.copy(UP);
    camera.lookAt(_tmp);
  }

  /** Boom offset for a yaw/distance/height, written into `_offset`. */
  function boom(y, dist, hgt) {
    return _offset.set(-Math.sin(y) * dist, hgt, -Math.cos(y) * dist);
  }

  /** Put the camera on a known-good pose behind the subject, right now. */
  function hardAnchor(dist, hgt) {
    pos.copy(_anchor).add(boom(yaw, dist, hgt));
    look.copy(_aim);
    _lookTarget.copy(_aim);
    camera.position.copy(pos);
    aimAtSubject();
    offscreenTime = 0;
  }

  // -------------------------------------------------------------------------
  // Cinematic solver (staged / beauty shots)
  // -------------------------------------------------------------------------
  const _shotFwd = new THREE.Vector3();
  const _shotRight = new THREE.Vector3();
  const _shotSide = new THREE.Vector3();
  const _shotAim = new THREE.Vector3();
  const _shotDir = new THREE.Vector3();
  const _shotA = new THREE.Vector3();
  const _shotB = new THREE.Vector3();
  const _shotNdc = new THREE.Vector3();

  function worldPointOf(object, localPoint, out) {
    if (!object || !localPoint) return null;
    object.updateWorldMatrix(true, false);
    out.copy(localPoint).applyMatrix4(object.matrixWorld);
    return finite3(out) ? out : null;
  }

  /** Hide/show the rider body for bike-only shots. Returns a restore fn. */
  function setRiderBodyVisible(rider, visible) {
    const parts = [rider?.rig?.mesh, rider?.helmet, rider?.goggles];
    const prev = parts.map((o) => (o ? o.visible : null));
    for (const o of parts) if (o) o.visible = visible;
    return () => { parts.forEach((o, i) => { if (o && prev[i] !== null) o.visible = prev[i]; }); };
  }

  /**
   * World-space direction of the bike's DRIVE side (the side the sprocket,
   * chain and drive-side peg are on), derived from the bike's own geometry
   * rather than assumed, and flattened to horizontal.
   */
  function driveSideDir(rider, out) {
    const bikeGroup = rider?.bike?.group;
    const pedalR = rider?.bike?.points?.pedalR;
    if (bikeGroup && pedalR && isNum(pedalR.x) && Math.abs(pedalR.x) > 1e-4) {
      bikeGroup.updateWorldMatrix(true, false);
      const e = bikeGroup.matrixWorld.elements;
      out.set(e[0], e[1], e[2]);                  // local +X in world space
      if (out.lengthSq() > 1e-8) {
        out.multiplyScalar(Math.sign(pedalR.x));
        out.y = 0;
        if (out.lengthSq() > 1e-8) return out.normalize();
      }
    }
    return null;
  }

  function frameCinematic(c, id, overrides) {
    const spec = { ...(CINEMATIC_SHOTS[id] || {}), ...(overrides || {}) };
    if (!resolveSubject(c)) return { ok: false, id, reason: 'no subject' };

    const rider = c.player?.rider;
    const state = c.player?.physics?.state;
    const asp = aspect();
    const fovY = clamp(spec.fovY ?? 36, 8, 110);
    const th = Math.tan(fovY * 0.5 * deg);

    // Rider heading, flattened.
    _shotFwd.set(0, 0, 1);
    if (state?.quaternion) _shotFwd.applyQuaternion(state.quaternion);
    if (!finite3(_shotFwd)) _shotFwd.set(0, 0, 1);
    _shotFwd.y = 0;
    if (_shotFwd.lengthSq() < 1e-6) _shotFwd.set(0, 0, 1);
    _shotFwd.normalize();
    _shotRight.crossVectors(_shotFwd, UP).normalize();     // the rider's right

    // Ground under the rider: beauty shots are placed off the DECK, so a rider
    // at the apex of an air still gets a low, looking-up camera.
    let groundY = _anchor.y;
    const col = c.world?.collision;
    if (col?.raycastDown) {
      _probe.set(_anchor.x, _anchor.y + 0.6, _anchor.z);
      const g = col.raycastDown(_probe, 60);
      if (g?.hit && isNum(g.point.y)) groundY = g.point.y;
    }

    // --- aim point + subject span -------------------------------------------
    let span = metrics.height;
    let restore = null;
    if (spec.aimTarget === 'drivetrain' && rider?.bike?.points) {
      const pts = rider.bike.points;
      const bikeGroup = rider.bike.group || rider.group;
      const bb = worldPointOf(bikeGroup, pts.bb, _shotA);
      const axle = bb ? worldPointOf(bikeGroup, pts.rearAxle, _shotB) : null;
      if (bb && axle) {
        // Between the sprocket and the rear hub, so the chain run, crank arm,
        // pedal, hub, spoke lacing and drive-side peg all sit inside frame.
        _shotAim.copy(bb).lerp(axle, 0.45);
        span = bb.distanceTo(axle);
      } else {
        _shotAim.copy(_anchor).setY(_anchor.y + 0.35);
        span = 0.45;
      }
      if (spec.hideRider) restore = setRiderBodyVisible(rider, false);
    } else if (isNum(spec.aimY)) {
      _shotAim.copy(_anchor).setY(_anchor.y + spec.aimY);
      span = metrics.height;
    } else {
      _shotAim.copy(_aim);
    }

    // --- distance from the framing intent -----------------------------------
    let dist;
    if (isNum(spec.coverage)) {
      const need = Math.max(spec.coverage, span + 0.30);
      dist = (need * 1.12) / (2 * th * asp);          // fit `need` metres across
    } else {
      const fill = clamp(spec.fill ?? 0.5, 0.05, 0.95);
      dist = span / (2 * fill * th);                  // fill of frame HEIGHT
    }
    dist = clamp(dist, 0.28, 60);

    // --- placement -----------------------------------------------------------
    if (spec.driveSide && driveSideDir(rider, _shotSide)) {
      // Swing `azimuth` measured from directly behind, but around the axis the
      // bike itself says is the drive side.
      const az = (spec.azimuth ?? 90) * deg;
      _shotDir.copy(_shotFwd).multiplyScalar(-Math.cos(az)).addScaledVector(_shotSide, Math.sin(az));
    } else {
      const az = (spec.azimuth ?? 30) * deg;
      _shotDir.copy(_shotFwd).multiplyScalar(-Math.cos(az)).addScaledVector(_shotRight, Math.sin(az));
    }
    if (_shotDir.lengthSq() < 1e-8) _shotDir.copy(_shotFwd).negate();
    _shotDir.y = 0;
    if (_shotDir.lengthSq() < 1e-8) _shotDir.set(0, 0, 1);
    _shotDir.normalize();

    // Height + boom length are two constraints on one triangle, and for a rider
    // high off the deck they can be infeasible together (the camera would have
    // to sit directly underneath, giving a useless plan view). Horizontal run
    // wins: keep at least `minRunFrac` of the boom on the ground plane and
    // raise the camera as much as the geometry demands, so the shot stays a
    // looking-up three-quarter rather than collapsing to straight overhead.
    const minRunFrac = clamp(spec.minRunFrac ?? 0.5, 0.05, 1);
    let camY = isNum(spec.camY) ? groundY + spec.camY : _shotAim.y;
    const dy = _shotAim.y - camY;
    let run = Math.sqrt(Math.max(dist * dist - dy * dy, 0));
    const minRun = dist * minRunFrac;
    if (run < minRun) {
      run = minRun;
      const rise = Math.sqrt(Math.max(dist * dist - run * run, 0));
      camY = Math.max(_shotAim.y - rise, groundY + 0.35);
    }
    run = Math.max(run, 0.2);
    camera.position.set(
      _shotAim.x + _shotDir.x * run,
      camY,
      _shotAim.z + _shotDir.z * run,
    );

    camera.fov = fovY;
    camera.updateProjectionMatrix();
    camera.up.copy(UP);

    // Place the subject at the requested height in frame. To sit the subject
    // ABOVE centre (head clear of the horizon, against sky) the lens has to
    // look BELOW it — hence the subtraction.
    const ndcY = clamp(spec.subjectNdcY ?? 0, -0.8, 0.8);
    _shotB.copy(_shotAim).sub(camera.position);
    const flat = Math.hypot(_shotB.x, _shotB.z);
    let pitch = Math.atan2(_shotB.y, flat) - Math.atan(ndcY * th);
    if (isNum(spec.minPitchUp)) pitch = Math.max(pitch, spec.minPitchUp * deg);
    const len = Math.max(_shotB.length(), 0.5);
    const dirX = flat > 1e-6 ? _shotB.x / flat : 0;
    const dirZ = flat > 1e-6 ? _shotB.z / flat : 1;
    camera.lookAt(
      camera.position.x + dirX * Math.cos(pitch) * len,
      camera.position.y + Math.sin(pitch) * len,
      camera.position.z + dirZ * Math.cos(pitch) * len,
    );

    // Report the harness should assert on before it captures. Computed locally
    // so a staged shot never corrupts the live chase-camera framing state.
    screenOf(_shotAim, _shotNdc);
    const d = _shotNdc.z;
    const heightFrac = d > 0 ? span / (2 * d * th) : 0;
    return {
      ok: d > camera.near && Math.abs(_shotNdc.x) < 0.9 && Math.abs(_shotNdc.y) < 0.9,
      id,
      fov: fovY,
      distance: dist,
      heightFrac,
      ndcX: _shotNdc.x,
      ndcY: _shotNdc.y,
      groundY,
      restore: restore || (() => {}),
    };
  }

  // -------------------------------------------------------------------------
  // Rig
  // -------------------------------------------------------------------------
  const rig = {
    camera,
    TUNE,
    FRAME,
    get mode() { return mode; },
    set mode(m) { mode = m; },
    setMode(m) { mode = m; },
    addShake(a) { if (isNum(a)) shake = Math.min(1.4, shake + a); },

    /** Right-stick invert (screens.js / settings.js). */
    setInvert(v) { invertLook = !!v; },
    /** Settings FOV slider. */
    setFov(v) { if (isNum(v)) TUNE.fovBase = clamp(v, 40, 105); },
    /**
     * Settings camera distance/height sliders. They are authored against the
     * old 5.4 m / 1.85 m baseline, so they are applied as OFFSETS from the
     * art-directed boom: loading default settings must not silently undo the
     * framing, but moving the slider must still move the camera.
     */
    setChase(distance, height) {
      if (isNum(distance)) {
        TUNE.distance = clamp(BOOM_DISTANCE + (distance - SETTINGS_BASE_DISTANCE), 3.0, 8.0);
        TUNE.airDistance = TUNE.distance + 1.5;
      }
      if (isNum(height)) {
        TUNE.height = clamp(BOOM_HEIGHT + (height - SETTINGS_BASE_HEIGHT), 0.7, 3.2);
        TUNE.airHeight = TUNE.height + 0.83;
      }
    },
    setDistance(d) { rig.setChase(d, undefined); },
    setHeight(h) { rig.setChase(undefined, h); },

    /** Live framing report — a capture harness should assert on this. */
    getFraming() { return framing; },
    /** True when the rider is on screen and big enough to read. */
    isSubjectFramed(minHeightFrac = FRAME.minHeightFrac) {
      return framing.framed && framing.heightFrac >= minHeightFrac;
    },
    /** True once the rig has verified the rider on screen at least once. */
    get hasFramed() { return framedOnce; },

    /**
     * Solve and apply one of `CINEMATIC_SHOTS` (or an inline spec) against the
     * rider's real size and the real ground under them. Returns a report plus
     * `restore()` for anything the shot had to hide.
     */
    frameCinematic(id, c, overrides) {
      return frameCinematic(c || ctx, id, overrides);
    },

    update(dt, c) {
      const cc = c || ctx;
      if (!isNum(dt)) dt = 1 / 60;
      dt = clamp(dt, 0, 0.25);

      if (!resolveSubject(cc)) return;
      const p = cc.player?.physics?.state;

      const speed = isNum(p?.speed) ? p.speed : 0;
      const speed01 = clamp(speed / 14, 0, 1.25);
      const pmode = p?.mode;
      const airing = pmode === 'air';
      const bailing = pmode === 'bail';
      const grinding = pmode === 'grind';
      mode = bailing ? 'bail' : airing ? 'air' : grinding ? 'grind' : 'chase';

      // --- yaw: travel direction, falling back to bike heading when slow -----
      if (p && finite3(p.velocity)) _flatVel.set(p.velocity.x, 0, p.velocity.z);
      else _flatVel.set(0, 0, 0);
      let targetYaw = yaw;
      if (_flatVel.lengthSq() > 1.2) {
        targetYaw = Math.atan2(_flatVel.x, _flatVel.z);
      } else if (p?.quaternion) {
        _fwd.set(0, 0, 1).applyQuaternion(p.quaternion);
        if (finite3(_fwd) && _fwd.lengthSq() > 1e-6) targetYaw = Math.atan2(_fwd.x, _fwd.z);
      }
      if (!isNum(targetYaw)) targetYaw = yaw;

      bailOrbit = bailing ? bailOrbit + TUNE.bailOrbitRate * dt : damp(bailOrbit, 0, 3, dt);
      grindBlend = damp(grindBlend, grinding ? 1 : 0, 5.5, dt);

      const yawLambda = bailing ? 1.6 : TUNE.yawLambda * (airing ? 0.55 : 1);
      yaw += wrapAngle(targetYaw - yaw) * (1 - Math.exp(-yawLambda * dt));
      if (!isNum(yaw)) yaw = targetYaw;

      // --- player look stick -------------------------------------------------
      const lk = cc.input?.state?.look;
      const lx = isNum(lk?.x) ? lk.x : 0;
      const lyRaw = isNum(lk?.y) ? lk.y : 0;
      const ly = invertLook ? -lyRaw : lyRaw;
      if (Math.abs(lx) > 0.02 || Math.abs(ly) > 0.02) {
        lookYaw = clamp(lookYaw + lx * TUNE.lookRate * dt, -TUNE.lookYawRange, TUNE.lookYawRange);
        lookPitch = clamp(lookPitch + ly * TUNE.lookRate * 0.55 * dt,
          -TUNE.lookPitchRange, TUNE.lookPitchRange);
      } else {
        lookYaw = damp(lookYaw, 0, TUNE.lookReturn, dt);
        lookPitch = damp(lookPitch, 0, TUNE.lookReturn, dt);
      }

      // --- boom length/height -------------------------------------------------
      const airT = airing ? clamp((p?.airTime ?? 0) / 0.8, 0, 1) : 0;
      let dist = lerp(TUNE.distance, TUNE.airDistance, airT);
      let hgt = lerp(TUNE.height, TUNE.airHeight, airT);
      dist += TUNE.grindDistance * grindBlend;
      hgt += TUNE.grindHeight * grindBlend;
      if (bailing) {
        dist = lerp(dist, TUNE.bailDistance, 0.65);
        hgt = lerp(hgt, TUNE.bailHeight, 0.65);
      }
      // Never let tuning, a slider or a mode blend push the subject below the
      // readable floor.
      const maxDist = maxReadableDistance();
      dist = clamp(dist, TUNE.minDistance, maxDist);

      const rigYaw = yaw + lookYaw + bailOrbit + TUNE.grindAzimuth * grindBlend;
      _desired.copy(_anchor).add(boom(rigYaw, dist, hgt + lookPitch * 2.4));

      // --- ground clearance ----------------------------------------------------
      const col = cc.world?.collision;
      if (col?.raycastDown) {
        _probe.set(_desired.x, _desired.y + 6, _desired.z);
        const ground = col.raycastDown(_probe, 12);
        if (ground?.hit && _desired.y < ground.point.y + TUNE.groundClearance) {
          _desired.y = ground.point.y + TUNE.groundClearance;
        }
      }

      // --- spring ---------------------------------------------------------------
      const posLambda = bailing ? 3.5 : TUNE.posLambda;
      pos.x = damp(pos.x, _desired.x, posLambda, dt);
      pos.y = damp(pos.y, _desired.y, posLambda * 1.15, dt);
      pos.z = damp(pos.z, _desired.z, posLambda, dt);
      if (!finite3(pos)) pos.copy(_desired);

      // --- line of sight: never let the park stand between lens and rider -------
      if (col?.raycast) {
        _ray.copy(pos).sub(_aim);
        const rayLen = _ray.length();
        if (rayLen > TUNE.occlusionSkip + 0.3) {
          _ray.multiplyScalar(1 / rayLen);
          // Ease the boom back out when the view clears, so a rail flicking
          // past does not make the camera pump.
          occlusion = occlusion === Infinity ? rayLen : damp(occlusion, rayLen, TUNE.occlusionEase, dt);
          // Start the probe PAST the feature the rider is standing on: a rail,
          // coping or ledge under the wheels is not an occluder.
          _probe.copy(_aim).addScaledVector(_ray, TUNE.occlusionSkip);
          const reach = rayLen - TUNE.occlusionSkip;
          const hit = col.raycast(_probe, _ray, reach);
          if (hit && isNum(hit.distance) && hit.distance < reach - 0.25) {
            const clear = TUNE.occlusionSkip + hit.distance - TUNE.occlusionMargin;
            // Pull in immediately (never render through a wall), ease out later.
            occlusion = Math.min(occlusion, Math.max(clear, TUNE.occlusionMin));
          }
          if (occlusion < rayLen) pos.copy(_aim).addScaledVector(_ray, occlusion);
        } else {
          occlusion = Infinity;
        }
      }

      // --- subject size floor / near clamp ---------------------------------------
      _ray.copy(pos).sub(_aim);
      const camDist = _ray.length();
      if (camDist > 1e-4) {
        _ray.multiplyScalar(1 / camDist);
        if (camDist > maxDist) pos.copy(_aim).addScaledVector(_ray, maxDist);
        else if (camDist < TUNE.minDistance) pos.copy(_aim).addScaledVector(_ray, TUNE.minDistance);
      } else {
        pos.copy(_anchor).add(boom(rigYaw, TUNE.distance, TUNE.height));
      }

      // --- look target: chest, plus a little lead at speed -------------------------
      _lookTarget.copy(_aim);
      _lookTarget.x += Math.sin(rigYaw) * TUNE.lookAhead * speed01;
      _lookTarget.z += Math.cos(rigYaw) * TUNE.lookAhead * speed01;
      look.x = damp(look.x, _lookTarget.x, TUNE.lookLambda, dt);
      look.y = damp(look.y, _lookTarget.y, TUNE.lookLambda, dt);
      look.z = damp(look.z, _lookTarget.z, TUNE.lookLambda, dt);
      if (!finite3(look)) look.copy(_aim);
      _lookTarget.copy(look);

      // --- FOV ---------------------------------------------------------------------
      const targetFov = TUNE.fovBase + speed01 * TUNE.fovSpeedGain + (airing ? TUNE.fovAir : 0);
      fov = damp(fov, targetFov, 4.5, dt);
      if (!isNum(fov)) fov = TUNE.fovBase;
      if (Math.abs(camera.fov - fov) > 0.01) {
        camera.fov = fov;
        camera.updateProjectionMatrix();
      }

      // --- commit + shake -----------------------------------------------------------
      camera.position.copy(pos);
      if (shake > 0.001) {
        shakeSeed += dt * 47;
        const s = shake * shake * 0.32;
        camera.position.x += Math.sin(shakeSeed * 3.1) * s;
        camera.position.y += Math.sin(shakeSeed * 2.3 + 1.7) * s;
        camera.position.z += Math.sin(shakeSeed * 4.7 + 0.4) * s * 0.6;
        shake = Math.max(0, shake - dt * 2.6);
      }
      if (!finite3(camera.position)) camera.position.copy(_desired);

      // The cone clamp is what actually guarantees the rider is on screen.
      aimAtSubject();
      evaluateFraming();

      // --- failsafe --------------------------------------------------------------------
      if (framing.framed) {
        offscreenTime = 0;
        safeAim.copy(_aim);
        safeYaw = yaw;
        haveSafe = true;
        framedOnce = true;
      } else {
        offscreenTime += dt;
        if (offscreenTime > FRAME.offscreenGrace) {
          // Re-acquire: put the boom straight back on the rider from the last
          // heading we know worked. The lens never sits on a stale transform.
          if (haveSafe) yaw = safeYaw;
          lookYaw = 0; lookPitch = 0; bailOrbit = 0;
          hardAnchor(clamp(TUNE.distance, TUNE.minDistance, maxDist), TUNE.height);
          evaluateFraming();
        }
      }

      cc.engine?.setSpeedBlur?.(clamp((speed - 8.5) / 8, 0, 1) * 0.9);
    },

    /** Hard-place the rig behind the rider with no smoothing. */
    snap(c) {
      const cc = c || ctx;
      if (!resolveSubject(cc)) return;
      const p = cc.player?.physics?.state;
      if (p?.quaternion) {
        _fwd.set(0, 0, 1).applyQuaternion(p.quaternion);
        if (finite3(_fwd) && _fwd.lengthSq() > 1e-6) yaw = Math.atan2(_fwd.x, _fwd.z);
      }
      if (!isNum(yaw)) yaw = 0;
      lookYaw = 0; lookPitch = 0; bailOrbit = 0; grindBlend = 0; shake = 0;
      occlusion = Infinity;
      fov = TUNE.fovBase;
      camera.fov = fov;
      camera.updateProjectionMatrix();
      hardAnchor(clamp(TUNE.distance, TUNE.minDistance, maxReadableDistance()), TUNE.height);
      evaluateFraming();
      if (framing.framed) {
        safeAim.copy(_aim);
        safeYaw = yaw;
        haveSafe = true;
        framedOnce = true;
      }
    },

    dispose() {
      measuredRider = null;
    },
  };

  return rig;
}

export default createCameraRig;
