// MIRRA CITY — the bike and the rider, built entirely from a rider profile.
//
// Conventions (shared with bikePhysics.js / riderAnim.js):
//   * `group` origin is the CONTACT ORIGIN: y = 0 is the bottom of the tyres,
//     z = 0 is midway along the wheelbase. +Z forward, +Y up, +X the rider's right.
//   * Everything is procedural: geometry is built from Three primitives / hand-rolled
//     buffer sweeps, every texture is painted on a canvas at load. Zero assets.
//   * The rider is a SkinnedMesh and its bones ARE the rig — nested Object3Ds, all
//     with identity rotation in bind pose, so the animator can write
//     `rig.elbowR.rotation.x = -0.4` and get a correct chain deformation. Bind pose
//     is the riding pose, so zero rotation already looks right.
//
// Profile-driven design
// ---------------------
// `createRider(ctx, profile)` builds from a profile out of `customization.js`, and
// `rider.applyProfile(next)` updates in place. Two mechanisms make that cheap:
//
//   1. TEXTURE REGIONS. Every material is one atlas whose regions each declare a
//      `sig(X)` — a string of exactly the profile fields that region's pixels depend
//      on. `applyProfile` repaints only the regions whose signature moved, and only
//      re-Sobels the normal-map rows those regions own. A colour change is a couple
//      of milliseconds of canvas work plus one texture upload.
//   2. GEOMETRY SIGNATURES + CACHE. Meshes are rebuilt only when a field that
//      actually changes their vertices moves (height/build/gender/garment style/
//      hair/headwear/pegs/tread), and every build is cached by signature, so
//      flicking back and forth in the creator is instant.
//
// Colour lives in the TEXTURE, not in `material.color`: that way one region can hold
// a garment colour, its accent trim and a printed graphic without extra draw calls.
// The materials library still decides what each choice *means* — every bike colour
// is resolved through `materials.tint()` / the `bike_*` colourways, so an anodised
// frame and a chrome frame get the library's own roughness/metalness/env response.
//
// Every brand mark drawn here is invented for this game.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { seed as reseed, rng, rand, clamp, lerp, smoothstep, fbm2, hash2, TAU } from '../core/mathx.js';
import {
  DEFAULT_PROFILE, normalizeProfile, riderMetrics, materialPlan, optionFor,
} from './customization.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const DEG = Math.PI / 180;

// The rng stream is shared with the world generator. Painting borrows it and hands
// it straight back, exactly as materials.js does, so a live profile change in the
// creator can never shift the park's noise.
const PAINT_SEED = 0x81ce7a11;
const STREAM_SEED = 0x5eed1e;

// ---------------------------------------------------------------------------
// bike geometry table — real 20" BMX numbers, stretched to the 1.05 m wheelbase
// the physics uses for its ground probes. The bike does NOT scale with the rider.
// ---------------------------------------------------------------------------
const G = {
  wheelBase: 1.05,
  tyreR: 0.26,           // rolling radius, 20 x 2.25
  tyreHalfW: 0.030,
  rimOuter: 0.2125,
  rimInner: 0.190,
  hubR: 0.017,
  flangeR: 0.0315,
  flangeX: 0.0265,
  spokes: 36,
  cross: 3,
  headAngle: 74 * DEG,   // from horizontal
  seatAngle: 71 * DEG,
  forkLen: 0.360,        // axle to crown along the steering axis
  forkRake: 0.035,
  htLen: 0.130,
  stLen: 0.300,
  crankLen: 0.175,
  chainLine: 0.042,
  sprocketTeeth: 25,
  cogTeeth: 9,
  pitch: 0.0127,
  barWidth: 0.660,       // 26"
  barRise: 0.228,        // 9"
  pegLen: 0.105,
  pegR: 0.0215,
};

// derived frame points (bike local space)
const PT = (() => {
  const rearAxle = V(0, G.tyreR, -G.wheelBase / 2);
  const frontAxle = V(0, G.tyreR, G.wheelBase / 2);
  const bb = V(0, 0.295, -0.125);
  const axisUp = V(0, Math.sin(G.headAngle), -Math.cos(G.headAngle));      // up the steerer
  const axisFwd = V(0, Math.cos(G.headAngle), Math.sin(G.headAngle));      // perpendicular, forward
  const htBottom = frontAxle.clone()
    .addScaledVector(axisUp, G.forkLen)
    .addScaledVector(axisFwd, -G.forkRake);
  const htTop = htBottom.clone().addScaledVector(axisUp, G.htLen);
  const stDir = V(0, Math.sin(G.seatAngle), -Math.cos(G.seatAngle));
  const stTop = bb.clone().addScaledVector(stDir, G.stLen);
  return { rearAxle, frontAxle, bb, axisUp, axisFwd, htBottom, htTop, stDir, stTop };
})();

// ---------------------------------------------------------------------------
// geometry utilities
// ---------------------------------------------------------------------------

/** Every merged geometry must expose the same attribute set and an index. */
function normalise(geo) {
  for (const key of Object.keys(geo.attributes)) {
    if (key !== 'position' && key !== 'normal' && key !== 'uv' &&
        key !== 'skinIndex' && key !== 'skinWeight') geo.deleteAttribute(key);
  }
  if (!geo.attributes.normal) geo.computeVertexNormals();
  if (!geo.attributes.uv) {
    const n = geo.attributes.position.count;
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  }
  if (!geo.index) {
    const n = geo.attributes.position.count;
    const arr = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
    for (let i = 0; i < n; i++) arr[i] = i;
    geo.setIndex(new THREE.BufferAttribute(arr, 1));
  }
  return geo;
}

/** Squash existing UVs into [0,1] (ExtrudeGeometry emits object-space UVs). */
function normaliseUV(geo) {
  const uv = geo.attributes.uv;
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i), v = uv.getY(i);
    if (u < u0) u0 = u; if (u > u1) u1 = u;
    if (v < v0) v0 = v; if (v > v1) v1 = v;
  }
  const du = u1 - u0 || 1, dv = v1 - v0 || 1;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, (uv.getX(i) - u0) / du, (uv.getY(i) - v0) / dv);
  }
  uv.needsUpdate = true;
  return geo;
}

/** Remap [0,1] UVs into an atlas cell. */
function atlasUV(geo, u0, u1, v0, v1) {
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
  }
  uv.needsUpdate = true;
  return geo;
}

function merge(list) {
  const clean = list.filter(Boolean).map(normalise);
  if (!clean.length) return null;
  if (clean.length === 1) return clean[0];
  const out = mergeGeometries(clean, false);
  for (const g of clean) g.dispose();
  return out;
}

/**
 * Swept tube along a Catmull-Rom path. Radius and cross-section ovality may vary
 * along the path, which is what makes frame tubes read as frame tubes (butted,
 * ovalised at the bottom bracket) rather than uniform pipes.
 * UV: u = 0..1 along the path, v = 0..1 around.
 */
function sweep(pts, opts = {}) {
  const {
    radius = 0.018, radial = 8, steps = 20, closed = false,
    taper = null, oval = null, tension = 0.5, caps = true,
  } = opts;
  const curve = new THREE.CatmullRomCurve3(pts.map((p) => p.clone()), closed, 'catmullrom', tension);
  const frames = curve.computeFrenetFrames(steps, closed);
  const pos = [], nor = [], uvs = [], idx = [];
  const P = new THREE.Vector3(), n = new THREE.Vector3(), vtx = new THREE.Vector3();
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    curve.getPointAt(closed ? (i % steps) / steps : t, P);
    const N = frames.normals[Math.min(i, frames.normals.length - 1)];
    const B = frames.binormals[Math.min(i, frames.binormals.length - 1)];
    const r = radius * (taper ? taper(t) : 1);
    const sc = oval ? oval(t) : null;
    const sx = sc ? sc[0] : 1, sy = sc ? sc[1] : 1;
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * TAU;
      const cx = Math.cos(a), cy = Math.sin(a);
      n.set(0, 0, 0).addScaledVector(N, cx / sx).addScaledVector(B, cy / sy).normalize();
      vtx.copy(P).addScaledVector(N, cx * r * sx).addScaledVector(B, cy * r * sy);
      pos.push(vtx.x, vtx.y, vtx.z);
      nor.push(n.x, n.y, n.z);
      uvs.push(t, j / radial);
    }
  }
  const w = radial + 1;
  for (let i = 0; i < steps; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * w + j, b = a + w;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  if (caps && !closed) {
    for (const end of [0, 1]) {
      const ri = end ? steps : 0;
      const c = pos.length / 3;
      curve.getPointAt(end, P);
      const T = frames.tangents[end ? frames.tangents.length - 1 : 0];
      pos.push(P.x, P.y, P.z);
      nor.push(end ? T.x : -T.x, end ? T.y : -T.y, end ? T.z : -T.z);
      uvs.push(end, 0.5);
      for (let j = 0; j < radial; j++) {
        const a = ri * w + j, b = ri * w + j + 1;
        if (end) idx.push(c, a, b); else idx.push(c, b, a);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  return geo;
}

/** Straight tapered tube between two points (fork legs, spokes, cables). */
function rod(a, b, r0, r1 = r0, radial = 8, caps = true, steps = 2) {
  const mid = a.clone().lerp(b, 0.5);
  return sweep([a, mid, b], { radius: 1, radial, steps, caps, taper: (t) => lerp(r0, r1, t) });
}

/**
 * Capsule with independent end radii and a cross-section scale profile.
 * `shape(t) -> [sx, sz]` scales the local X (the `front` axis) and local Z axes,
 * which is how limb girth, torso depth and shoulder width are driven.
 */
function capsule2(len, ra, rb, opts = {}) {
  const { radial = 12, capSegs = 4, shape = null, mid = null, bodyRings = 3,
    capA = 1, capB = 1 } = opts;
  const rings = [];
  for (let i = 0; i <= capSegs; i++) {                       // bottom cap
    const a = (i / capSegs) * (Math.PI / 2);
    rings.push([Math.sin(a) * ra, -Math.cos(a) * ra * capA]);
  }
  for (let i = 1; i <= bodyRings; i++) {
    const t = i / (bodyRings + 1);
    rings.push([lerp(ra, rb, t) * (mid ? mid(t) : 1), len * t]);
  }
  for (let i = 0; i <= capSegs; i++) {                       // top cap
    const a = (i / capSegs) * (Math.PI / 2);
    rings.push([Math.cos(a) * rb, len + Math.sin(a) * rb * capB]);
  }
  // v runs along the PROFILE ARC LENGTH, not the axis: parameterising by height
  // squeezes the hemispherical caps into a sliver of the atlas region, which makes
  // them sample a blurred mip and show up as grey blobs on the joints.
  const arc = [0];
  for (let i = 1; i < rings.length; i++) {
    arc[i] = arc[i - 1] + Math.hypot(rings[i][0] - rings[i - 1][0], rings[i][1] - rings[i - 1][1]);
  }
  const arcTotal = arc[arc.length - 1] || 1;

  const pos = [], nor = [], uvs = [], idx = [];
  const nv = new THREE.Vector3();
  for (let i = 0; i < rings.length; i++) {
    const [r, y] = rings[i];
    const t = clamp(y / len, 0, 1);
    const sc = shape ? shape(t) : [1, 1];
    const prev = rings[Math.max(0, i - 1)], next = rings[Math.min(rings.length - 1, i + 1)];
    const dr = next[0] - prev[0], dy = next[1] - prev[1];
    // Pinch u toward the middle of the band as a cap ring closes in on its pole.
    // Without this the u derivative explodes at the pole, the sampler drops to a
    // tiny mip and the joint shows the average of the whole atlas as a grey blob.
    const capR = y < 0 ? ra : y > len ? rb : 0;
    const k = capR > 1e-6 ? clamp(r / capR, 0, 1) : 1;
    for (let j = 0; j <= radial; j++) {
      // NEGATIVE sweep: u then increases toward the rider's left, so anything
      // painted left-to-right in the atlas reads left-to-right on the body.
      // With zDir = left that puts u = 0 at the left flank, 0.25 at the back,
      // 0.5 at the right flank and 0.75 dead centre front.
      const a = -(j / radial) * TAU;
      const sx = Math.sin(a), cz = Math.cos(a);
      pos.push(sx * r * sc[0], y, cz * r * sc[1]);
      nv.set(sx * dy / sc[0], -dr, cz * dy / sc[1]).normalize();
      nor.push(nv.x, nv.y, nv.z);
      uvs.push(0.5 + (j / radial - 0.5) * k, arc[i] / arcTotal);
    }
  }
  const w = radial + 1;
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * w + j, b = a + w;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  return geo;
}

/** A muscle belly: a gaussian swell centred at `at` along a limb's 0..1 axis. */
const bulge = (t, at, width, amt) => 1 + amt * Math.exp(-(((t - at) / width) ** 2));

/**
 * ONE CONTINUOUS LIMB.
 *
 * The rider used to be a stack of separate closed capsules — deltoid, upper arm,
 * forearm, hand — butted end to end. Every junction was two hemispherical caps
 * meeting, which left either a dark void or a hard 2–3 px lit rim where the
 * garment caught light on a tube edge: a segmented, crash-test-dummy silhouette
 * you could count the parts of.
 *
 * This lofts the WHOLE chain as a single tube: one surface, one normal field, no
 * internal caps, so there is nothing at the elbow or the knee to catch a rim.
 * Garments are not separate shells either — the radius STEPS UP by the cloth
 * thickness wherever a garment covers, so the hem is a real edge loop with real
 * fabric thickness, and the atlas region switches at the same station, giving a
 * crisp cuff line with no geometric seam behind it.
 *
 * `sections` (in chain-fraction space) declare which atlas region owns which run
 * of the limb; each section is indexed separately and its v is normalised over
 * its own arc, so a short cuff band gets the whole cuff row of the atlas.
 *
 * u follows the same convention as `capsule2`: with zDir = the rider's left,
 * u = 0 is the outer flank, 0.25 the front, 0.5 the inner flank, 0.75 the back.
 */
function limbTube(atlas, chain, opts) {
  const {
    radial = 14, zDir = LEFT, tension = 0.5, radius, shape = null,
    sections, capStart = 0.85, capEnd = 0.85, capSegs = 4, stepsPer = 10,
  } = opts;
  const curve = new THREE.CatmullRomCurve3(chain.map((p) => p.clone()), false, 'catmullrom', tension);
  const total = curve.getLength() || 1e-4;

  const P = new THREE.Vector3(), T = new THREE.Vector3();
  const zAx = new THREE.Vector3(), xAx = new THREE.Vector3(), nv = new THREE.Vector3();

  const frameAt = (t) => {
    const tc = clamp(t, 0, 1);
    curve.getPointAt(tc, P);
    curve.getTangentAt(tc, T).normalize();
    zAx.copy(zDir).addScaledVector(T, -zDir.dot(T));
    if (zAx.lengthSq() < 1e-9) {
      zAx.set(0, 0, 1).addScaledVector(T, -T.z);
      if (zAx.lengthSq() < 1e-9) zAx.set(1, 0, 0).addScaledVector(T, -T.x);
    }
    zAx.normalize();
    xAx.crossVectors(T, zAx).normalize();
  };
  const rAt = (t) => radius(clamp(t, 0, 1));
  const scAt = (t) => (shape ? shape(clamp(t, 0, 1)) : [1, 1]);

  // --- ring plan: start cap, then one run per section, then end cap -----------
  const live = sections.filter((s) => s.t1 - s.t0 > 1e-4);
  const rings = [];        // { t, rs, ax, na, pinch, sec }
  const r0 = rAt(0), r1 = rAt(1);
  for (let k = 0; k < capSegs; k++) {                 // start cap (excludes t=0)
    const ph = (k / capSegs) * (Math.PI / 2);
    rings.push({ t: 0, rs: Math.sin(ph), ax: -Math.cos(ph) * r0 * capStart,
      na: -Math.cos(ph), pinch: Math.sin(ph), sec: 0 });
  }
  for (let si = 0; si < live.length; si++) {
    const s = live[si];
    const steps = Math.max(2, Math.round(stepsPer * (s.t1 - s.t0) * 4) + 2);
    for (let i = 0; i <= steps; i++) {
      rings.push({ t: lerp(s.t0, s.t1, i / steps), rs: 1, ax: 0, na: 0, pinch: 1, sec: si });
    }
  }
  for (let k = capSegs - 1; k >= 0; k--) {            // end cap
    const ph = (k / capSegs) * (Math.PI / 2);
    rings.push({ t: 1, rs: Math.sin(ph), ax: Math.cos(ph) * r1 * capEnd,
      na: Math.cos(ph), pinch: Math.sin(ph), sec: live.length - 1 });
  }

  // --- emit ------------------------------------------------------------------
  const pos = [], nor = [], uvs = [], idx = [];
  const w = radial + 1;
  const centres = [];
  const eps = 1.5 / total;
  for (const R of rings) {
    frameAt(R.t);
    const r = rAt(R.t) * R.rs;
    const sc = scAt(R.t);
    const cx = P.x + T.x * R.ax, cy = P.y + T.y * R.ax, cz = P.z + T.z * R.ax;
    centres.push(cx, cy, cz);
    // radius slope along arc length, so a taper tilts its own normal correctly
    const dr = R.rs >= 1
      ? (rAt(R.t + eps) - rAt(R.t - eps)) / (2 * eps * total)
      : 0;
    for (let j = 0; j <= radial; j++) {
      const a = -(j / radial) * TAU;
      const sa = Math.sin(a), ca = Math.cos(a);
      pos.push(
        cx + xAx.x * sa * r * sc[0] + zAx.x * ca * r * sc[1],
        cy + xAx.y * sa * r * sc[0] + zAx.y * ca * r * sc[1],
        cz + xAx.z * sa * r * sc[0] + zAx.z * ca * r * sc[1],
      );
      const rad = R.rs >= 1 ? 1 : R.rs;
      nv.set(0, 0, 0)
        .addScaledVector(xAx, (sa / sc[0]) * rad)
        .addScaledVector(zAx, (ca / sc[1]) * rad)
        .addScaledVector(T, R.na - dr * (R.rs >= 1 ? 1 : 0));
      if (nv.lengthSq() < 1e-12) nv.copy(T).multiplyScalar(R.na >= 0 ? 1 : -1);
      nv.normalize();
      nor.push(nv.x, nv.y, nv.z);
      uvs.push(0.5 + (j / radial - 0.5) * R.pinch, 0);       // v filled in below
    }
  }
  // v: arc length along the ring centres, normalised INSIDE each section band
  const nRings = rings.length;
  const arc = new Float64Array(nRings);
  for (let i = 1; i < nRings; i++) {
    const a = (i - 1) * 3, b = i * 3;
    arc[i] = arc[i - 1] + Math.hypot(centres[b] - centres[a],
      centres[b + 1] - centres[a + 1], centres[b + 2] - centres[a + 2]);
  }
  for (let si = 0; si < live.length; si++) {
    let lo = -1, hi = -1;
    for (let i = 0; i < nRings; i++) {
      if (rings[i].sec !== si) continue;
      if (lo < 0) lo = i;
      hi = i;
    }
    if (lo < 0) continue;
    const span = Math.max(arc[hi] - arc[lo], 1e-6);
    const [v0, v1] = atlas.band(live[si].key);
    const a0 = live[si].v0 ?? 0, a1 = live[si].v1 ?? 1;
    for (let i = lo; i <= hi; i++) {
      const k = lerp(a0, a1, (arc[i] - arc[lo]) / span);
      const vv = lerp(v0, v1, clamp(k, 0, 1));
      for (let j = 0; j <= radial; j++) uvs[((i * w) + j) * 2 + 1] = vv;
    }
    // u into the region's own sub-range if the section asks for one
    if (live[si].u0 !== undefined) {
      for (let i = lo; i <= hi; i++) {
        for (let j = 0; j <= radial; j++) {
          const o = ((i * w) + j) * 2;
          uvs[o] = lerp(live[si].u0, live[si].u1, uvs[o]);
        }
      }
    }
    for (let i = lo; i < hi; i++) {
      for (let j = 0; j < radial; j++) {
        const A = i * w + j, B = A + w;
        idx.push(A, B, A + 1, B, B + 1, A + 1);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  return geo;
}

/**
 * An orthonormal frame from a primary direction and a hint, used by every part
 * that has to be built in the space of something else (a hand on a bar, a shoe
 * on an ankle).
 */
function frameOf(dir, upHint) {
  const y = dir.clone().normalize();
  const z = upHint.clone().addScaledVector(y, -upHint.dot(y));
  if (z.lengthSq() < 1e-9) z.set(0, 0, 1).addScaledVector(y, -y.z);
  z.normalize();
  const x = new THREE.Vector3().crossVectors(y, z).normalize();
  return { x, y, z };
}

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();

/** Orient a +Y-aligned geometry so +Y runs a→b and +Z faces `front`. */
function place(geo, a, b, front = V(0, 0, 1)) {
  const y = _v1.copy(b).sub(a).normalize();
  const x = _v2.copy(front).cross(y);
  if (x.lengthSq() < 1e-8) x.set(1, 0, 0).cross(y);
  x.normalize();
  const z = _v3.copy(x).cross(y).normalize();
  _m4.makeBasis(x, y, z).setPosition(a);
  geo.applyMatrix4(_m4);
  return geo;
}

/**
 * Orient a +Y-aligned geometry so +Y runs a→b and local +Z lands on `zDir`,
 * orthogonalised against the axis. Unlike `place` this is numerically stable when
 * the hint is nearly parallel to the axis, which matters because the whole
 * garment layout depends on knowing exactly where u = 0.25 (the front) is:
 * with zDir = the rider's left, u = 0 is the left side, 0.25 the front,
 * 0.5 the right side and 0.75 the back. Seams land at u = 0 and u = 0.5.
 */
function placeZ(geo, a, b, zDir) {
  const y = _v1.copy(b).sub(a).normalize();
  const z = _v3.copy(zDir);
  z.addScaledVector(y, -z.dot(y));
  if (z.lengthSq() < 1e-9) {
    z.set(0, 0, 1).addScaledVector(y, -y.z);
    if (z.lengthSq() < 1e-9) z.set(1, 0, 0).addScaledVector(y, -y.x);
  }
  z.normalize();
  const x = _v2.crossVectors(y, z).normalize();
  _m4.makeBasis(x, y, z).setPosition(a);
  geo.applyMatrix4(_m4);
  return geo;
}

/** Weld bead: a rippled ring — the detail that makes a metal frame read as welded. */
function weld(pos, axis, r, thick = 0.0042) {
  const geo = new THREE.TorusGeometry(r, thick, 5, 14);
  const p = geo.attributes.position, n = geo.attributes.normal, uv = geo.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const rip = 0.0009 * Math.sin(uv.getX(i) * TAU * 9) + 0.00045 * Math.sin(uv.getX(i) * TAU * 23 + 1.1);
    p.setXYZ(i, p.getX(i) + n.getX(i) * rip, p.getY(i) + n.getY(i) * rip, p.getZ(i) + n.getZ(i) * rip);
  }
  geo.computeVertexNormals();
  _q.setFromUnitVectors(V(0, 0, 1), _v1.copy(axis).normalize());
  _m4.makeRotationFromQuaternion(_q).setPosition(pos);
  geo.applyMatrix4(_m4);
  return geo;
}

/** Extruded 2D shape with a small bevel — gussets, dropouts, plates, sprockets. */
function plate(shape, depth, bevel = 0.0009, curveSegments = 6) {
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel,
    bevelSegments: 1, steps: 1, curveSegments,
  });
  geo.translate(0, 0, -depth / 2);
  return normaliseUV(normalise(geo));
}

function roundedRectShape(w, h, r) {
  const s = new THREE.Shape();
  const x = w / 2, y = h / 2;
  s.moveTo(-x + r, -y);
  s.lineTo(x - r, -y); s.absarc(x - r, -y + r, r, -Math.PI / 2, 0, false);
  s.lineTo(x, y - r); s.absarc(x - r, y - r, r, 0, Math.PI / 2, false);
  s.lineTo(-x + r, y); s.absarc(-x + r, y - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(-x, -y + r); s.absarc(-x + r, -y + r, r, Math.PI, Math.PI * 1.5, false);
  return s;
}

/** Chainring / cog outline: sampled radius function with real trapezoid teeth. */
function sprocketShape(teeth, pitch, holes = 0, holeR = 0) {
  const R = pitch / (2 * Math.sin(Math.PI / teeth));
  const root = R - pitch * 0.30;
  const tip = R + pitch * 0.34;
  const per = 6, s = new THREE.Shape();
  for (let i = 0; i < teeth * per; i++) {
    const f = (i % per) / per;
    const a = (i / (teeth * per)) * TAU;
    let k;
    if (f < 0.30) k = 0;
    else if (f < 0.44) k = smoothstep((f - 0.30) / 0.14);
    else if (f < 0.62) k = 1;
    else if (f < 0.76) k = 1 - smoothstep((f - 0.62) / 0.14);
    else k = 0;
    const r = lerp(root, tip, k);
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (i === 0) s.moveTo(x, y); else s.lineTo(x, y);
  }
  s.closePath();
  const bore = new THREE.Path();
  bore.absarc(0, 0, R * 0.28, 0, TAU, true);
  s.holes.push(bore);
  for (let i = 0; i < holes; i++) {
    const a = (i / holes) * TAU + 0.3;
    const h = new THREE.Path();
    h.absarc(Math.cos(a) * R * 0.62, Math.sin(a) * R * 0.62, holeR, 0, TAU, true);
    s.holes.push(h);
  }
  return { shape: s, R, tip };
}

/** Two-bone IK — used at build time to place elbows and knees. */
function ikJoint(root, end, lenA, lenB, pole) {
  const d = new THREE.Vector3().subVectors(end, root);
  const c = Math.min(d.length(), lenA + lenB - 1e-4);
  const dir = d.clone().normalize();
  const px = (lenA * lenA + c * c - lenB * lenB) / (2 * c);
  const h = Math.sqrt(Math.max(0, lenA * lenA - px * px));
  const p = pole.clone().addScaledVector(dir, -pole.dot(dir)).normalize();
  return root.clone().addScaledVector(dir, px).addScaledVector(p, h);
}

/**
 * Intersect two circles in the sagittal (y,z) plane. Used once per build to find
 * where the hips have to sit for a rider of THIS height to have their hands on the
 * grips and their feet on the pedals at once. Returns the upper root, plus how far
 * the radii had to be stretched to make a solution exist at all.
 */
function circleFit(cy1, cz1, r1, cy2, cz2, r2) {
  let dy = cy2 - cy1, dz = cz2 - cz1;
  const d = Math.hypot(dy, dz) || 1e-6;
  let err = 0;
  let R1 = r1, R2 = r2;
  if (d > R1 + R2) { err = d - (R1 + R2); const k = d / (R1 + R2); R1 *= k; R2 *= k; }
  else if (d < Math.abs(R1 - R2)) { err = Math.abs(R1 - R2) - d; const k = (d * 0.999) / Math.abs(R1 - R2); R1 *= k; R2 *= k; }
  const a = (R1 * R1 - R2 * R2 + d * d) / (2 * d);
  const hh = Math.sqrt(Math.max(0, R1 * R1 - a * a));
  const uy = dy / d, uz = dz / d;
  const my = cy1 + a * uy, mz = cz1 + a * uz;
  // two roots, ±perpendicular; take the one with the higher hip (standing, not folded)
  const p1y = my - uz * hh, p1z = mz + uy * hh;
  const p2y = my + uz * hh, p2z = mz - uy * hh;
  return p1y >= p2y ? { y: p1y, z: p1z, err } : { y: p2y, z: p2z, err };
}

// ---------------------------------------------------------------------------
// colour helpers — every profile colour is a plain 0xRRGGBB number
// ---------------------------------------------------------------------------

const RGB = (c) => [(c >> 16) & 255, (c >> 8) & 255, c & 255];
const HEX = (c) => '#' + ((c >>> 0) & 0xffffff).toString(16).padStart(6, '0');

function rgba(c, a) {
  const [r, g, b] = RGB(c);
  return `rgba(${r},${g},${b},${a})`;
}

/** k > 0 lightens toward white, k < 0 darkens toward black. */
function shade(c, k) {
  const [r, g, b] = RGB(c);
  const f = (v) => clamp(Math.round(k >= 0 ? lerp(v, 255, k) : v * (1 + k)), 0, 255);
  return (f(r) << 16) | (f(g) << 8) | f(b);
}

function mixc(a, b, t) {
  const A = RGB(a), B = RGB(b);
  return (Math.round(lerp(A[0], B[0], t)) << 16) |
         (Math.round(lerp(A[1], B[1], t)) << 8) |
          Math.round(lerp(A[2], B[2], t));
}

function lumOf(c) {
  const [r, g, b] = RGB(c);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * Cloth albedo floor. A "black" tee picked in the creator is 0x24262b — under
 * 2 % reflectance, which crushes to pure black the moment the rider turns away
 * from the sun and takes the fold, seam and print detail with it, and the whole
 * character collapses into one silhouette-shaped mass.
 *
 * The lift is MULTIPLICATIVE over a small achromatic pedestal, not a mix toward
 * white: mixing toward white desaturates, which is what turned a black skate
 * shoe into a pale grey lump and a navy tee into pale slate. Scaling the channels
 * keeps the hue and the chroma ratio, so a lifted black denim still reads blue.
 */
function toLuminance(c, target) {
  const l = lumOf(c);
  const [r, g, b] = RGB(c);
  if (target <= l) {                              // darkening is a pure scale
    const k = clamp(target / Math.max(l, 1e-4), 0, 1);
    const f = (v) => clamp(Math.round(v * k), 0, 255);
    return (f(r) << 16) | (f(g) << 8) | f(b);
  }
  const ped = target * 0.30;                      // ambient pedestal, achromatic
  const s = clamp((target - ped) / Math.max(l, 0.012), 0, 7);
  const base = Math.round(255 * ped);
  const f = (v) => clamp(Math.round(v * s + base), 0, 255);
  return (f(r) << 16) | (f(g) << 8) | f(b);
}

// 0.235 sRGB ≈ 0.045 linear, which is what a real black cotton tee measures.
// The old 0.34 floor was a mid grey: it stopped the crush, but it also meant
// nothing on the rider could BE dark, and every garment came out chalky.
function fabricAlbedo(c, floor = 0.235) {
  return lumOf(c) >= floor ? c : toLuminance(c, floor);
}

/**
 * Real anodised aluminium is a SATURATED but DARK finish: a red ano top cap under
 * an overcast dusk sits near 0.20 luminance and gets its punch from the specular
 * lobe, not the albedo. Painting it at full swatch brightness is what made the
 * bar-end caps read as glowing LEDs.
 */
function anodise(c, maxLum = 0.21) {
  const l = lumOf(c);
  if (l <= maxLum) return c;
  const k = maxLum / Math.max(l, 1e-3);
  const [r, g, b] = RGB(c);
  const f = (v) => clamp(Math.round(v * k), 0, 255);
  return (f(r) << 16) | (f(g) << 8) | f(b);
}

/** Ink that stays readable on `c` — used for every printed graphic. */
function inkOn(c) { return lumOf(c) > 0.52 ? 0x191b20 : 0xf2efe6; }

/** Push a colour away from `c` so trim never disappears into the garment. */
function separate(c, from, minDelta = 0.22) {
  if (Math.abs(lumOf(c) - lumOf(from)) >= minDelta) return c;
  return lumOf(from) > 0.5 ? shade(c, -0.42) : shade(c, 0.46);
}

/**
 * How differently two colours are TINTED, with luminance divided out. Indigo
 * denim and a charcoal tee sit two points apart in luminance but nowhere near
 * each other in hue, and they read as two obviously different garments — a
 * tonal split between them is not only unnecessary, it is destructive.
 */
function chromaGap(a, b) {
  const A = RGB(a), B = RGB(b);
  const la = lumOf(a) * 255 + 1.0, lb = lumOf(b) * 255 + 1.0;
  let d = 0;
  for (let i = 0; i < 3; i++) d += Math.abs(A[i] / la - B[i] / lb);
  return d / 3;
}

/**
 * Keep two garments readable as two garments. `separate` only nudges; this used
 * to GUARANTEE a 0.30 luminance delta, landing exactly on the target — and that
 * is what painted indigo jeans (0.22 luminance) at 0.64 and shipped a rider in
 * white leggings. Two rules fix it:
 *   - if the two colours already differ in HUE, leave both alone;
 *   - otherwise move by a modest delta, and never past the range real clothing
 *     occupies, so a dark garment stays a dark garment.
 */
function splitTone(c, from, minDelta = 0.13) {
  const lf = lumOf(from), lc = lumOf(c);
  if (Math.abs(lc - lf) >= minDelta) return c;
  // Two different HUES already read as two garments; they need a nudge, not a
  // split, or indigo denim under a charcoal tee gets bleached to slate.
  const d = chromaGap(c, from) >= 0.12 ? 0.065 : minDelta;
  if (Math.abs(lc - lf) >= d) return c;
  const roomDown = lf - 0.10, roomUp = 0.80 - lf;
  const dir = ((lc <= lf && roomDown >= d) || roomUp < d) ? -1 : 1;
  return toLuminance(c, clamp(lf + dir * d, 0.075, 0.80));
}

/** Plausible eye colour for a head of hair — no extra profile field needed. */
function eyeColourFor(hair) {
  const l = lumOf(hair);
  if (l > 0.62) return 0x6f93a8;
  if (l > 0.40) return 0x6d7f5e;
  if (l > 0.22) return 0x6a4a2c;
  return 0x3a2617;
}

// ---------------------------------------------------------------------------
// procedural texture painting
// ---------------------------------------------------------------------------

function c2d(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingEnabled = true;
  return g;
}

function pixels(w, h, fn) {
  const g = c2d(w, h);
  const img = g.createImageData(w, h);
  const d = img.data;
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i += 4) fn(x / w, y / h, d, i, x, y);
  }
  g.putImageData(img, 0, 0);
  return g;
}

/** Low-res fbm tile reused as an overlay everywhere — keeps generation cheap. */
const _grain = (() => {
  const g = pixels(256, 256, (u, v, d, i) => {
    const n = fbm2(u * 9, v * 9, 4);
    const k = 128 + (n - 0.5) * 190;
    d[i] = d[i + 1] = d[i + 2] = k; d[i + 3] = 255;
  });
  return g.canvas;
})();

const _speck = (() => {
  const g = pixels(256, 256, (u, v, d, i, x, y) => {
    const n = hash2(x * 7 + 1, y * 13 + 3);
    const k = n > 0.86 ? 255 : n < 0.06 ? 0 : 128;
    d[i] = d[i + 1] = d[i + 2] = k; d[i + 3] = 255;
  });
  return g.canvas;
})();

const _weaveTile = (() => {
  const g = c2d(64, 64);
  g.fillStyle = '#808080'; g.fillRect(0, 0, 64, 64);
  for (let x = 0; x < 64; x += 4) {
    g.fillStyle = 'rgba(255,255,255,0.30)'; g.fillRect(x, 0, 2, 64);
    g.fillStyle = 'rgba(0,0,0,0.26)'; g.fillRect(x + 2, 0, 2, 64);
  }
  for (let y = 0; y < 64; y += 4) {
    g.fillStyle = 'rgba(255,255,255,0.22)'; g.fillRect(0, y, 64, 2);
    g.fillStyle = 'rgba(0,0,0,0.20)'; g.fillRect(0, y + 2, 64, 2);
  }
  return g.canvas;
})();

/**
 * 3/1 denim twill: the diagonal float that makes jeans read as jeans instead of
 * flat blue. Warp threads run vertically, the weft steps one thread per pick,
 * which is what produces the wale running up-right.
 */
const _twillTile = (() => {
  const g = c2d(64, 64);
  g.fillStyle = '#808080'; g.fillRect(0, 0, 64, 64);
  const cell = 4;
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      // 3 warp floats then 1 weft float, stepping one cell per row → wale
      const phase = (x - y + 32) % 4;
      const warp = phase !== 0;
      g.fillStyle = warp ? 'rgba(255,255,255,0.34)' : 'rgba(0,0,0,0.36)';
      g.fillRect(x * cell, y * cell, cell, cell);
      g.fillStyle = warp ? 'rgba(0,0,0,0.18)' : 'rgba(255,255,255,0.14)';
      g.fillRect(x * cell, y * cell + cell - 1, cell, 1);
    }
  }
  return g.canvas;
})();

/** Diamond knurl — grip flanges, peg ends, machined thumbwheels. */
const _knurlTile = (() => {
  const g = c2d(32, 32);
  g.fillStyle = '#808080'; g.fillRect(0, 0, 32, 32);
  g.lineWidth = 1.6;
  for (let i = -32; i < 64; i += 6) {
    g.strokeStyle = 'rgba(255,255,255,0.55)';
    g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 32, 32); g.stroke();
    g.strokeStyle = 'rgba(0,0,0,0.5)';
    g.beginPath(); g.moveTo(i + 2, 0); g.lineTo(i + 34, 32); g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.55)';
    g.beginPath(); g.moveTo(i, 32); g.lineTo(i + 32, 0); g.stroke();
    g.strokeStyle = 'rgba(0,0,0,0.5)';
    g.beginPath(); g.moveTo(i + 2, 32); g.lineTo(i + 34, 0); g.stroke();
  }
  return g.canvas;
})();

function overlay(g, w, h, alpha, scale = 1, src = _grain, op = 'overlay') {
  g.save();
  g.globalCompositeOperation = op;
  g.globalAlpha = alpha;
  const tw = w / scale, th = h / scale;
  for (let y = 0; y < h; y += th) {
    for (let x = 0; x < w; x += tw) g.drawImage(src, x, y, tw, th);
  }
  g.restore();
}

/** Sobel a greyscale height canvas into a tangent-space normal map. */
function sobelRegion(hg, out, w, h, y0, y1, strength) {
  const yA = Math.max(0, (y0 | 0) - 1), yB = Math.min(h, (y1 | 0) + 1);
  const rows = yB - yA;
  if (rows <= 0) return;
  const src = hg.getImageData(0, yA, w, rows).data;
  const img = out.createImageData(w, rows);
  const d = img.data;
  const at = (x, y) => src[(clamp(y, 0, rows - 1) | 0) * w * 4 + (clamp(x, 0, w - 1) | 0) * 4] / 255;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      let nx = -dx, ny = -dy, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      const i = (y * w + x) * 4;
      d[i] = (nx * 0.5 + 0.5) * 255;
      d[i + 1] = (ny * 0.5 + 0.5) * 255;
      d[i + 2] = (nz * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  out.putImageData(img, 0, yA);
}

function fill(g, w, h, css) { g.fillStyle = css; g.fillRect(0, 0, w, h); }

/** Random hairline scratches — the single best cure for showroom-perfect metal. */
function scratches(g, w, h, n, css, minLen, maxLen, width = 1) {
  g.save();
  g.strokeStyle = css; g.lineCap = 'round';
  for (let i = 0; i < n; i++) {
    const x = rand(0, w), y = rand(0, h);
    const a = rand(-0.22, 0.22) + (rng() < 0.25 ? Math.PI / 2 : 0);
    const l = rand(minLen, maxLen);
    g.lineWidth = width * rand(0.5, 1.6);
    g.globalAlpha = rand(0.12, 0.6);
    g.beginPath();
    g.moveTo(x, y);
    g.quadraticCurveTo(x + Math.cos(a) * l * 0.5 + rand(-3, 3), y + Math.sin(a) * l * 0.5 + rand(-3, 3),
      x + Math.cos(a) * l, y + Math.sin(a) * l);
    g.stroke();
  }
  g.restore();
}

function chips(g, w, h, n, css, r0, r1) {
  g.save();
  g.fillStyle = css;
  for (let i = 0; i < n; i++) {
    g.globalAlpha = rand(0.25, 0.8);
    g.beginPath();
    g.ellipse(rand(0, w), rand(0, h), rand(r0, r1), rand(r0, r1), rand(0, 3), 0, TAU);
    g.fill();
  }
  g.restore();
}

/**
 * Handling smudges for a roughness mask. Polished metal is NEVER uniformly
 * polished: it is a mirror interrupted by fingerprints, dust films and the
 * dull haze where a hand or a shoe has been. Without this a chrome frame reads
 * as one flat value with a single soft highlight — exactly the note we got.
 */
function smudges(g, w, h, n, lo = 'rgba(255,255,255,0.55)', hi = 'rgba(0,0,0,0.25)') {
  g.save();
  for (let i = 0; i < n; i++) {
    const x = rand(0, w), y = rand(0, h);
    const rx = rand(w * 0.02, w * 0.14), ry = rand(h * 0.06, h * 0.34);
    const grd = g.createRadialGradient(x, y, 0, x, y, 1);
    // radial gradients need a real radius; scale instead so the blob can be oval
    g.save();
    g.translate(x, y); g.scale(rx, ry);
    const gg = g.createRadialGradient(0, 0, 0, 0, 0, 1);
    gg.addColorStop(0, rng() < 0.7 ? lo : hi);
    gg.addColorStop(1, 'rgba(128,128,128,0)');
    g.globalAlpha = rand(0.18, 0.62);
    g.fillStyle = gg;
    g.beginPath(); g.arc(0, 0, 1, 0, TAU); g.fill();
    g.restore();
    void grd;
  }
  // a few real fingerprint whorls
  for (let i = 0; i < Math.max(2, n >> 2); i++) {
    const x = rand(0, w), y = rand(0, h);
    const rr = rand(h * 0.05, h * 0.12);
    g.save();
    g.globalAlpha = rand(0.20, 0.5);
    g.strokeStyle = lo;
    g.lineWidth = 1.2;
    g.translate(x, y); g.rotate(rand(0, TAU)); g.scale(1, 0.72);
    for (let k = 1; k <= 6; k++) {
      g.beginPath();
      g.arc(0, 0, rr * (k / 6), rand(0, 1.2), rand(3.4, 5.6));
      g.stroke();
    }
    g.restore();
  }
  g.restore();
}

/** Machining passes: the concentric / linear tool marks on a milled face. */
function machined(g, w, h, spacing = 5, css = 'rgba(255,255,255,0.20)', dark = 'rgba(0,0,0,0.22)') {
  g.save();
  for (let y = 0; y < h; y += spacing) {
    g.strokeStyle = css; g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
    g.strokeStyle = dark; g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, y + spacing * 0.5); g.lineTo(w, y + spacing * 0.5); g.stroke();
  }
  g.restore();
}

function text(g, str, x, y, size, css, opts = {}) {
  const { font = '900', family = 'Impact, "Arial Black", sans-serif', align = 'center',
    skew = 0, alpha = 1, outline = null, spacing = 0, rot = 0, maxWidth = 0 } = opts;
  g.save();
  g.globalAlpha = alpha;
  g.translate(x, y);
  if (rot) g.rotate(rot);
  if (skew) g.transform(1, 0, skew, 1, 0, 0);
  g.font = `${font} ${size}px ${family}`;
  if (maxWidth) {
    let wmeas = 0;
    for (const ch of str) wmeas += g.measureText(ch).width + spacing;
    if (wmeas > maxWidth) g.scale(maxWidth / wmeas, 1);
  }
  g.textAlign = spacing ? 'left' : align;
  g.textBaseline = 'middle';
  g.fillStyle = css;
  if (spacing) {
    let total = 0;
    for (const ch of str) total += g.measureText(ch).width + spacing;
    let cx = align === 'center' ? -total / 2 : 0;
    for (const ch of str) {
      if (outline) { g.lineWidth = size * 0.06; g.strokeStyle = outline; g.strokeText(ch, cx, 0); }
      g.fillText(ch, cx, 0);
      cx += g.measureText(ch).width + spacing;
    }
  } else {
    if (outline) { g.lineWidth = size * 0.07; g.strokeStyle = outline; g.strokeText(str, 0, 0); }
    g.fillText(str, 0, 0);
  }
  g.restore();
}

/** Cloth folds running ALONG the limb (u across, v along). */
function folds(c, bw, bh, n, css, alpha) {
  c.save(); c.globalAlpha = alpha; c.strokeStyle = css; c.lineCap = 'round';
  for (let i = 0; i < n; i++) {
    const x = rand(0, bw);
    const y0 = rand(-bh * 0.4, bh * 0.5), y1 = y0 + rand(bh * 0.45, bh * 1.3);
    c.lineWidth = rand(2, 8);
    c.beginPath();
    c.moveTo(x, y0);
    c.bezierCurveTo(x + rand(-26, 26), lerp(y0, y1, 0.33), x + rand(-26, 26), lerp(y0, y1, 0.66),
      x + rand(-18, 18), y1);
    c.stroke();
  }
  for (let i = 0; i < n >> 1; i++) {                 // short cross creases where it bunches
    const x = rand(0, bw), y = rand(0, bh);
    c.lineWidth = rand(1.5, 4);
    c.beginPath();
    c.moveTo(x, y);
    c.quadraticCurveTo(x + rand(-40, 40), y + rand(-10, 10), x + rand(-70, 70), y + rand(-16, 16));
    c.stroke();
  }
  c.restore();
}

function stitchLine(c, x0, y0, x1, y1, css, w = 2, dash = [6, 7]) {
  c.save();
  c.strokeStyle = css; c.lineWidth = w; c.setLineDash(dash);
  c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
  c.restore();
}

// ---------------------------------------------------------------------------
// atlas: a stack of regions, each repainted only when its signature moves
// ---------------------------------------------------------------------------

const _allTextures = new Set();

function makeTexture(canvas, srgb, aniso) {
  const t = new THREE.CanvasTexture(canvas);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  _allTextures.add(t);
  return t;
}

/**
 * regions: [{ key, u, sig(X), colour(c,w,h,X), rough(c,w,h,X), height(c,w,h,X), hsig(X) }]
 *   `u` is the region's height in atlas units (default 1).
 *   Region-local canvas y = 0 is the region's HIGH v edge, so painters use
 *   `yv(v) = (1 - v) * h` and think purely in UV space.
 *   `sig` covers the colour + roughness maps, `hsig` (default: a constant) the
 *   height/normal map — colour changes therefore never pay for a Sobel pass.
 */
function createAtlas(name, opts) {
  const { w, unit, regions, aniso = 8, normalStrength = 1.0, X } = opts;
  let units = 0;
  const index = {};
  for (const r of regions) {
    const u = r.u || 1;
    index[r.key] = { key: r.key, a: units, b: units + u, def: r };
    units += u;
  }
  const h = unit * units;
  const hw = w >> 1, hh = h >> 1;
  for (const k of Object.keys(index)) {
    const R = index[k];
    R.v0 = R.a / units;
    R.v1 = R.b / units;
    // canvas rows, in the full-res colour canvas
    R.y0 = (units - R.b) * unit;
    R.y1 = (units - R.a) * unit;
    R.sig = null;
    R.hsig = null;
  }

  const cg = c2d(w, h);            // colour
  const hg = c2d(hw, hh);          // height (half res)
  const rg = c2d(hw, hh);          // roughness (half res)
  const ng = c2d(hw, hh);          // normal (half res, Sobel of hg)

  /** Run `fn` inside a region's rect, in region-local coordinates. */
  const inRegion = (g, R, scale, fn) => {
    const y = R.y0 * scale, hh2 = (R.y1 - R.y0) * scale, ww = w * scale;
    g.save();
    g.beginPath(); g.rect(0, y, ww, hh2); g.clip();
    g.translate(0, y);
    fn(g, ww, hh2);
    g.restore();
  };

  function paintRegion(R, x, doHeight) {
    const d = R.def;
    reseed(PAINT_SEED ^ (R.a * 2654435761));
    if (d.colour) inRegion(cg, R, 1, (g, ww, hh2) => d.colour(g, ww, hh2, x));
    reseed(PAINT_SEED ^ (R.a * 40503));
    if (d.rough) inRegion(rg, R, 0.5, (g, ww, hh2) => d.rough(g, ww, hh2, x));
    else inRegion(rg, R, 0.5, (g, ww, hh2) => fill(g, ww, hh2, '#e0e0e0'));
    if (doHeight) {
      reseed(PAINT_SEED ^ (R.a * 2246822519));
      if (d.height) inRegion(hg, R, 0.5, (g, ww, hh2) => d.height(g, ww, hh2, x));
      else inRegion(hg, R, 0.5, (g, ww, hh2) => fill(g, ww, hh2, '#808080'));
    }
  }

  /** Repaint every region whose signature moved. Returns ms spent. */
  function repaint(x, force = false) {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    let dirtyC = false, dirtyH = false;
    const hRows = [];
    for (const k of Object.keys(index)) {
      const R = index[k];
      const s = R.def.sig ? R.def.sig(x) : '';
      const hs = R.def.hsig ? R.def.hsig(x) : '';
      const wantC = force || s !== R.sig;
      const wantH = force || hs !== R.hsig;
      if (!wantC && !wantH) continue;
      paintRegion(R, x, wantH);
      R.sig = s; R.hsig = hs;
      dirtyC = true;
      if (wantH) { dirtyH = true; hRows.push([R.y0 * 0.5, R.y1 * 0.5]); }
    }
    if (dirtyH) {
      for (const [a, b] of hRows) sobelRegion(hg, ng, hw, hh, a, b, normalStrength);
    }
    if (dirtyC) {
      maps.map.needsUpdate = true;
      maps.roughnessMap.needsUpdate = true;
    }
    if (dirtyH) maps.normalMap.needsUpdate = true;
    reseed(STREAM_SEED);          // hand the shared stream back untouched
    return (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  }

  const maps = {
    map: null, normalMap: null, roughnessMap: null,
  };
  // first paint, then wrap in textures
  fill(cg, w, h, '#808080');
  fill(hg, hw, hh, '#808080');
  fill(rg, hw, hh, '#d0d0d0');
  for (const k of Object.keys(index)) paintRegion(index[k], X, true);
  for (const k of Object.keys(index)) {
    const R = index[k];
    R.sig = R.def.sig ? R.def.sig(X) : '';
    R.hsig = R.def.hsig ? R.def.hsig(X) : '';
  }
  sobelRegion(hg, ng, hw, hh, 0, hh, normalStrength);
  reseed(STREAM_SEED);

  maps.map = makeTexture(cg.canvas, true, aniso);
  maps.normalMap = makeTexture(ng.canvas, false, aniso);
  maps.roughnessMap = makeTexture(rg.canvas, false, aniso);
  maps.map.name = name + 'Colour';

  return {
    name, maps, index, width: w, height: h,
    /** Remap a geometry's [0,1] UVs into a region, with an optional inset. */
    uv(geo, key, u0 = 0, u1 = 1, inset = 0.012) {
      const R = index[key] || index[Object.keys(index)[0]];
      const pad = (R.v1 - R.v0) * inset;
      return atlasUV(normalise(geo), u0, u1, R.v0 + pad, R.v1 - pad);
    },
    /** Centre of a region — for parts with no meaningful UVs of their own. */
    patch(geo, key, u0 = 0.15, u1 = 0.85, inset = 0.16) {
      return this.uv(geo, key, u0, u1, inset);
    },
    /** The [v0, v1] band a region occupies, for meshes that map themselves. */
    band(key, inset = 0.012) {
      const R = index[key] || index[Object.keys(index)[0]];
      const pad = (R.v1 - R.v0) * inset;
      return [R.v0 + pad, R.v1 - pad];
    },
    repaint,
    dispose() {
      for (const t of Object.values(maps)) { if (t) { _allTextures.delete(t); t.dispose(); } }
    },
  };
}

// ---------------------------------------------------------------------------
// printed graphics — every mark below is invented for this game
// ---------------------------------------------------------------------------

/**
 * Draw an invented brand mark centred at (cx, cy) inside a box `size` tall.
 * `spec` = { mark, text } straight off the customization catalogue.
 */
function drawMark(c, cx, cy, size, spec, ink, accent) {
  const mark = spec?.mark || 'none';
  const str = spec?.text || '';
  if (mark === 'none') return;
  c.save();
  c.translate(cx, cy);
  const S = size;
  const inkC = HEX(ink), acC = HEX(accent);

  if (mark === 'emblem') {
    // shield with a lightning bolt and a rocker of type under it
    c.beginPath();
    c.moveTo(-S * 0.40, -S * 0.46); c.lineTo(S * 0.40, -S * 0.46);
    c.lineTo(S * 0.40, S * 0.04);
    c.quadraticCurveTo(S * 0.40, S * 0.44, 0, S * 0.56);
    c.quadraticCurveTo(-S * 0.40, S * 0.44, -S * 0.40, S * 0.04);
    c.closePath();
    c.fillStyle = inkC; c.fill();
    c.lineWidth = S * 0.05; c.strokeStyle = acC; c.stroke();
    c.beginPath();
    c.moveTo(S * 0.10, -S * 0.34); c.lineTo(-S * 0.16, S * 0.02);
    c.lineTo(S * 0.01, S * 0.02); c.lineTo(-S * 0.10, S * 0.38);
    c.lineTo(S * 0.20, -S * 0.06); c.lineTo(S * 0.03, -S * 0.06);
    c.closePath();
    c.fillStyle = acC; c.fill();
    if (str) text(c, str, 0, S * 0.76, S * 0.15, inkC, { spacing: S * 0.02, maxWidth: S * 1.5 });
  } else if (mark === 'wordmark') {
    c.fillStyle = inkC;
    c.beginPath(); c.roundRect(-S * 0.72, -S * 0.30, S * 1.44, S * 0.60, S * 0.06); c.fill();
    text(c, str || 'IRON LOT', 0, 0, S * 0.34, acC, { skew: -0.14, spacing: S * 0.02, maxWidth: S * 1.28 });
    c.fillStyle = acC;
    c.fillRect(-S * 0.72, S * 0.34, S * 1.44, S * 0.05);
  } else if (mark === 'script') {
    text(c, str || 'Flatside', 0, 0, S * 0.52, inkC,
      { font: 'italic 700', family: 'Georgia, "Times New Roman", serif', skew: -0.16, maxWidth: S * 1.7 });
    c.strokeStyle = acC; c.lineWidth = S * 0.045; c.lineCap = 'round';
    c.beginPath();
    c.moveTo(-S * 0.62, S * 0.30);
    c.quadraticCurveTo(0, S * 0.46, S * 0.66, S * 0.22);
    c.stroke();
  } else if (mark === 'geo') {
    c.strokeStyle = inkC; c.lineWidth = S * 0.07;
    for (let i = 0; i < 3; i++) {
      const r = S * (0.22 + i * 0.14);
      c.beginPath(); c.ellipse(0, 0, r, r * 0.62, 0, 0, TAU); c.stroke();
    }
    c.fillStyle = acC;
    for (let i = 0; i < 3; i++) {
      c.beginPath();
      c.moveTo(-S * 0.5 + i * S * 0.34, -S * 0.52);
      c.lineTo(-S * 0.30 + i * S * 0.34, -S * 0.52);
      c.lineTo(-S * 0.42 + i * S * 0.34, -S * 0.30);
      c.closePath(); c.fill();
    }
    if (str) text(c, str, 0, S * 0.62, S * 0.16, inkC, { spacing: S * 0.03, maxWidth: S * 1.4 });
  } else if (mark === 'stripe') {
    for (let i = -2; i <= 2; i++) {
      c.fillStyle = i % 2 ? acC : inkC;
      c.save(); c.transform(1, 0, -0.30, 1, 0, 0);
      c.fillRect(i * S * 0.24 - S * 0.07, -S * 0.62, S * 0.13, S * 1.24);
      c.restore();
    }
  } else if (mark === 'number') {
    c.fillStyle = inkC;
    c.beginPath(); c.roundRect(-S * 0.46, -S * 0.52, S * 0.92, S * 1.04, S * 0.10); c.fill();
    c.strokeStyle = acC; c.lineWidth = S * 0.06;
    c.beginPath(); c.roundRect(-S * 0.40, -S * 0.46, S * 0.80, S * 0.92, S * 0.08); c.stroke();
    text(c, str || '13', 0, S * 0.02, S * 0.78, acC, { spacing: S * 0.01, maxWidth: S * 0.7 });
  } else if (mark === 'fade') {
    const grd = c.createLinearGradient(-S, 0, S, 0);
    grd.addColorStop(0, rgba(ink, 0.0));
    grd.addColorStop(0.55, rgba(ink, 0.85));
    grd.addColorStop(1, rgba(accent, 0.9));
    c.fillStyle = grd;
    c.fillRect(-S, -S * 0.6, S * 2, S * 1.2);
  } else if (mark === 'panel') {
    c.fillStyle = inkC;
    c.beginPath(); c.roundRect(-S * 0.8, -S * 0.42, S * 1.6, S * 0.84, S * 0.08); c.fill();
    c.fillStyle = acC;
    for (let i = 0; i < 5; i++) {
      const a = -Math.PI / 2 + i * 0.34 - 0.68;
      const x = Math.cos(a) * S * 0.52, y = Math.sin(a) * S * 0.20;
      star(c, x, y, S * 0.13, acC);
    }
    if (str) text(c, str, 0, S * 0.60, S * 0.16, inkC, { spacing: S * 0.02, maxWidth: S * 1.4 });
  }
  c.restore();
}

function star(c, x, y, r, css) {
  c.save(); c.translate(x, y); c.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i / 10) * TAU;
    const rr = i % 2 ? r * 0.44 : r;
    const px = Math.cos(a) * rr, py = Math.sin(a) * rr;
    if (i === 0) c.moveTo(px, py); else c.lineTo(px, py);
  }
  c.closePath(); c.fillStyle = css; c.fill(); c.restore();
}

/** Height-map stand-in for a printed mark: prints are near-flat vinyl / plastisol. */
function drawMarkHeight(c, cx, cy, size, spec) {
  const mark = spec?.mark || 'none';
  if (mark === 'none' || mark === 'fade') return;
  c.save();
  c.globalAlpha = 0.55;
  drawMark(c, cx, cy, size, spec, 0xb4b4b4, 0xc8c8c8);
  c.restore();
}

// ---------------------------------------------------------------------------
// bike atlases
// ---------------------------------------------------------------------------

/** Base coat for a frame tube: the finish decides everything about the response. */
function paintFinish(c, w, h, F, wear = 1) {
  const col = F.colour;
  if (F.finish === 'chrome') {
    const grd = c.createLinearGradient(0, 0, 0, h);
    grd.addColorStop(0.00, HEX(shade(col, 0.30)));
    grd.addColorStop(0.22, HEX(shade(col, -0.10)));
    grd.addColorStop(0.44, HEX(shade(col, -0.62)));
    grd.addColorStop(0.58, HEX(shade(col, -0.20)));
    grd.addColorStop(0.80, HEX(shade(col, 0.22)));
    grd.addColorStop(1.00, HEX(shade(col, -0.34)));
    c.fillStyle = grd; c.fillRect(0, 0, w, h);
    scratches(c, w, h, 150 * wear, '#ffffff', 10, 120, 0.6);
    scratches(c, w, h, 60 * wear, '#6c757c', 6, 40, 0.6);
    chips(c, w, h, 12 * wear, 'rgba(138,122,100,0.55)', 0.8, 2.2);
  } else if (F.finish === 'raw') {
    fill(c, w, h, HEX(col));
    for (let i = 0; i < 70; i++) {
      c.strokeStyle = `rgba(255,255,255,${rand(0.03, 0.13).toFixed(3)})`;
      c.lineWidth = rand(0.5, 2.4);
      const y = rand(0, h);
      c.beginPath(); c.moveTo(0, y); c.lineTo(w, y + rand(-3, 3)); c.stroke();
    }
    overlay(c, w, h, 0.20, 2);
    scratches(c, w, h, 110 * wear, '#e8eef2', 8, 90, 0.8);
  } else {
    fill(c, w, h, HEX(col));
    const grd = c.createLinearGradient(0, 0, 0, h);
    grd.addColorStop(0, 'rgba(255,255,255,0.13)');
    grd.addColorStop(0.42, 'rgba(255,255,255,0.02)');
    grd.addColorStop(1, rgba(shade(col, -0.75), 0.55));
    c.fillStyle = grd; c.fillRect(0, 0, w, h);
    overlay(c, w, h, 0.13, 2);
    scratches(c, w, h, 80 * wear, HEX(shade(col, 0.55)), 8, 90, 0.7);
    chips(c, w, h, 24 * wear, 'rgba(106,111,114,0.8)', 0.8, 2.6);
  }
}

function bikePaintRegions() {
  const sig = (X) => `${X.frame.colour}|${X.frame.finish}`;
  const dsig = (X) => `${sig(X)}|${X.decals.id}|${X.decals.colour}|${X.accent}`;
  // The roughness MASK carries the variation; the material scalar carries the
  // level (see applyMaterialParams). Chrome is a mirror broken by handling, a
  // powdercoat is a satin broken by polish where the rider's shins rub it.
  const roughOf = (X) => (c, w, h) => {
    const chrome = X.frame.finish === 'chrome';
    fill(c, w, h, chrome ? '#4a4a4a' : '#a6a6a6');
    overlay(c, w, h, chrome ? 0.30 : 0.22, 2);
    smudges(c, w, h, chrome ? 16 : 10,
      chrome ? 'rgba(210,210,210,0.85)' : 'rgba(190,190,190,0.5)', 'rgba(30,30,30,0.35)');
    // a scratch cuts THROUGH a finish: bare metal in the groove is smoother
    scratches(c, w, h, 90, chrome ? '#1e1e1e' : '#5a5a5a', 8, 90, 0.9);
    chips(c, w, h, 24, chrome ? '#c8c8c8' : '#dadada', 1, 3);
  };
  return [
    {
      key: 'MAIN', u: 1, sig,
      colour: (c, w, h, X) => paintFinish(c, w, h, X.frame),
      rough: (c, w, h, X) => roughOf(X)(c, w, h),
      hsig: () => 'k',
      height: (c, w, h) => {
        fill(c, w, h, '#808080');
        overlay(c, w, h, 0.16, 2);                 // orange peel, very shallow
        scratches(c, w, h, 60, '#6a6a6a', 6, 50, 0.8);
      },
    },
    {
      key: 'DARK', u: 1, sig,
      colour: (c, w, h, X) => {
        paintFinish(c, w, h, { colour: shade(X.frame.colour, -0.34), finish: X.frame.finish }, 1.4);
      },
      rough: (c, w, h, X) => { roughOf(X)(c, w, h); fill(c, w, h, 'rgba(255,255,255,0.14)'); },
      hsig: () => 'k',
      height: (c, w, h) => { fill(c, w, h, '#808080'); overlay(c, w, h, 0.22, 2); },
    },
    {
      key: 'DECAL', u: 1, sig: dsig,
      colour: (c, w, h, X) => {
        paintFinish(c, w, h, X.frame);
        const D = X.decals;
        if (D.mark === 'none') return;
        if (D.mark === 'fade' || D.mark === 'panel') {
          c.save(); c.globalAlpha = 0.92;
          drawMark(c, w * 0.5, h * 0.5, h * 0.9, D, D.colour, X.accent);
          c.restore();
        } else {
          // decals sit along the tube: repeat the mark twice, mirrored ends
          drawMark(c, w * 0.30, h * 0.5, h * 0.62, D, D.colour, X.accent);
          drawMark(c, w * 0.78, h * 0.5, h * 0.40, D, X.accent, D.colour);
        }
        c.globalAlpha = 1;
        text(c, 'HEAT TREATED CHROMOLY', w * 0.5, h * 0.90, h * 0.075,
          rgba(inkOn(X.frame.colour), 0.6), { font: '700', family: 'sans-serif', spacing: h * 0.014 });
      },
      rough: (c, w, h, X) => {
        roughOf(X)(c, w, h);
        c.save(); c.globalAlpha = 0.5;
        drawMark(c, w * 0.30, h * 0.5, h * 0.62, X.decals, 0x707070, 0x8a8a8a);
        c.restore();
      },
      hsig: () => 'k',
      height: (c, w, h) => { fill(c, w, h, '#808080'); overlay(c, w, h, 0.16, 2); },
    },
    {
      key: 'SCRIPT', u: 1, sig: dsig,
      colour: (c, w, h, X) => {
        paintFinish(c, w, h, X.frame);
        const ink = X.decals.mark === 'none' ? inkOn(X.frame.colour) : X.decals.colour;
        c.fillStyle = rgba(X.accent, 0.85);
        c.fillRect(0, h * 0.06, w, h * 0.05);
        c.fillRect(0, h * 0.89, w, h * 0.05);
        text(c, 'MIRRA CITY', w * 0.5, h * 0.47, h * 0.40, HEX(ink),
          { skew: -0.18, spacing: h * 0.05, maxWidth: w * 0.9 });
      },
      rough: (c, w, h, X) => roughOf(X)(c, w, h),
      hsig: () => 'k',
      height: (c, w, h) => {
        fill(c, w, h, '#808080');
        text(c, 'MIRRA CITY', w * 0.5, h * 0.47, h * 0.40, '#969696', { skew: -0.18, spacing: h * 0.05 });
      },
    },
  ];
}

function bikeHardwareRegions() {
  const hwSig = (X) => `${X.hw.colour}|${X.hw.finish}|${X.accent}`;
  const metal = (c, w, h, F, style) => {
    if (F.finish === 'chrome') {
      // A chrome tube does not have a single soft highlight: it has a hard
      // horizon line where the sky reflection stops and the ground reflection
      // starts, a bright sky band above it and a dark earth band below. That
      // horizon IS what makes a viewer read chrome; the PMREM then moves it.
      const grd = c.createLinearGradient(0, 0, 0, h);
      grd.addColorStop(0.00, HEX(shade(F.colour, -0.30)));
      grd.addColorStop(0.14, HEX(shade(F.colour, 0.34)));
      grd.addColorStop(0.30, HEX(shade(F.colour, 0.55)));   // sky
      grd.addColorStop(0.455, HEX(shade(F.colour, 0.10)));
      grd.addColorStop(0.475, HEX(shade(F.colour, -0.74))); // horizon
      grd.addColorStop(0.62, HEX(shade(F.colour, -0.50)));  // ground
      grd.addColorStop(0.84, HEX(shade(F.colour, 0.16)));
      grd.addColorStop(1.00, HEX(shade(F.colour, -0.34)));
      c.fillStyle = grd; c.fillRect(0, 0, w, h);
      scratches(c, w, h, 160, '#ffffff', 10, 120, 0.6);
      scratches(c, w, h, 60, '#7e888e', 6, 40, 0.6);
      chips(c, w, h, 14, '#8a7a64', 0.8, 2.2);
    } else {
      fill(c, w, h, HEX(F.colour));
      // anodised aluminium has a fine axial brush under the dye
      c.save(); c.globalAlpha = 0.5;
      for (let i = 0; i < 150; i++) {
        c.strokeStyle = rgba(shade(F.colour, rng() < 0.5 ? 0.45 : -0.45), rand(0.05, 0.22));
        c.lineWidth = rand(0.5, 1.8);
        const y = rand(0, h);
        c.beginPath(); c.moveTo(0, y); c.lineTo(w, y + rand(-2, 2)); c.stroke();
      }
      c.restore();
      overlay(c, w, h, style === 'satin' ? 0.26 : 0.18, 2);
      scratches(c, w, h, 130, HEX(shade(F.colour, 0.52)), 6, 70, 0.7);
      chips(c, w, h, 20, HEX(shade(F.colour, 0.30)), 0.7, 2.0);
    }
  };
  return [
    {
      key: 'CHROME', u: 1, sig: hwSig,
      colour: (c, w, h, X) => metal(c, w, h, X.hw),
      rough: (c, w, h, X) => {
        const chrome = X.hw.finish === 'chrome';
        fill(c, w, h, chrome ? '#3a3a3a' : '#9c9c9c');
        smudges(c, w, h, chrome ? 18 : 8,
          chrome ? 'rgba(224,224,224,0.9)' : 'rgba(190,190,190,0.5)', 'rgba(24,24,24,0.4)');
        scratches(c, w, h, 150, chrome ? '#1c1c1c' : '#4a4a4a', 10, 120, 0.7);
      },
      hsig: () => 'k',
      height: (c, w, h) => { fill(c, w, h, '#808080'); scratches(c, w, h, 120, '#6c6c6c', 6, 80, 0.8); },
    },
    {
      key: 'ANOD', u: 1, sig: hwSig,
      // Every anodised part on the bike is driven from ONE accent hue, dyed dark
      // to a real anodised albedo. Teal spacers against candy-red caps was the
      // note; there is now a single ano colour on the whole machine.
      colour: (c, w, h, X) => metal(c, w, h, { colour: X.anod, finish: 'anod' }, 'satin'),
      rough: (c, w, h) => {
        fill(c, w, h, '#6e6e6e');
        smudges(c, w, h, 8, 'rgba(170,170,170,0.45)', 'rgba(40,40,40,0.4)');
        scratches(c, w, h, 130, '#3c3c3c', 6, 70, 0.8);
      },
      hsig: () => 'k',
      height: (c, w, h) => { fill(c, w, h, '#808080'); overlay(c, w, h, 0.20, 2); },
    },
    {
      key: 'ALLOY', u: 1, sig: hwSig,
      colour: (c, w, h, X) => {
        fill(c, w, h, HEX(mixc(0x9aa2a8, X.hw.colour, 0.30)));
        for (let i = 0; i < 60; i++) {                    // lathe rings
          c.strokeStyle = `rgba(${rand(200, 255) | 0},${rand(200, 255) | 0},255,${rand(0.04, 0.14).toFixed(2)})`;
          c.lineWidth = rand(0.5, 2);
          c.beginPath(); c.moveTo(0, rand(0, h)); c.lineTo(w, rand(0, h)); c.stroke();
        }
        overlay(c, w, h, 0.2, 2);
      },
      rough: (c, w, h) => {
        fill(c, w, h, '#828282');
        overlay(c, w, h, 0.4, 3);
        smudges(c, w, h, 6, 'rgba(190,190,190,0.4)', 'rgba(50,50,50,0.35)');
      },
      hsig: () => 'k',
      height: (c, w, h) => { fill(c, w, h, '#808080'); scratches(c, w, h, 90, '#6c6c6c', 6, 60, 0.8); },
    },
    {
      // A milled face: the stem faceplate, the top cap, the crank spider. Cut
      // marks in the NORMAL map at a real pitch, not a flat plate.
      key: 'MACHINED', u: 1, sig: hwSig,
      colour: (c, w, h, X) => {
        fill(c, w, h, HEX(mixc(0x9aa2a8, X.hw.colour, 0.30)));
        machined(c, w, h, 6, 'rgba(255,255,255,0.16)', 'rgba(0,0,0,0.20)');
        overlay(c, w, h, 0.18, 2);
        scratches(c, w, h, 60, '#e6ecef', 5, 45, 0.6);
      },
      rough: (c, w, h) => {
        fill(c, w, h, '#7a7a7a');
        machined(c, w, h, 6, 'rgba(60,60,60,0.45)', 'rgba(200,200,200,0.35)');
      },
      hsig: () => 'k',
      height: (c, w, h) => {
        fill(c, w, h, '#808080');
        machined(c, w, h, 6, 'rgba(216,216,216,0.95)', 'rgba(48,48,48,0.95)');
      },
    },
    {
      // Spokes get their OWN region. Mapped into CHROME they were 1 mm mirrors:
      // sub-pixel specular highlights that MSAA cannot resolve, which is exactly
      // the "white speckle noise" in the wheel. Stainless spokes are satin.
      key: 'SPOKE', u: 1, sig: () => 'k',
      colour: (c, w, h) => {
        const grd = c.createLinearGradient(0, 0, 0, h);
        grd.addColorStop(0.0, '#7f858a');
        grd.addColorStop(0.5, '#c2c9ce');
        grd.addColorStop(1.0, '#6d7377');
        c.fillStyle = grd; c.fillRect(0, 0, w, h);
        overlay(c, w, h, 0.16, 3);
      },
      rough: (c, w, h) => { fill(c, w, h, '#9e9e9e'); overlay(c, w, h, 0.25, 3); },
    },
    {
      key: 'PEG', u: 1, sig: (X) => `${X.peg ? X.peg.colour : 0}|${X.peg ? X.peg.finish : '-'}`,
      colour: (c, w, h, X) => {
        const F = X.peg || X.hw;
        fill(c, w, h, HEX(F.colour));
        for (let i = 0; i < 90; i++) {                    // knurling + grind wear
          c.strokeStyle = `rgba(255,255,255,${rand(0.05, 0.25).toFixed(2)})`;
          c.lineWidth = rand(0.6, 2.4);
          const y = rand(0, h);
          c.beginPath(); c.moveTo(0, y); c.lineTo(w, y + rand(-4, 4)); c.stroke();
        }
        const wear = c.createLinearGradient(0, 0, w, 0);
        wear.addColorStop(0, 'rgba(232,238,242,0.88)');
        wear.addColorStop(0.35, 'rgba(120,126,130,0.0)');
        wear.addColorStop(0.65, 'rgba(120,126,130,0.0)');
        wear.addColorStop(1, 'rgba(232,238,242,0.88)');
        c.fillStyle = wear; c.fillRect(0, 0, w, h);
        scratches(c, w, h, 200, '#ffffff', 20, 160, 0.8);
      },
      rough: (c, w, h) => {
        fill(c, w, h, '#5c5c5c');
        const wear = c.createLinearGradient(0, 0, w, 0);
        wear.addColorStop(0, 'rgba(0,0,0,0.75)');
        wear.addColorStop(0.5, 'rgba(255,255,255,0.25)');
        wear.addColorStop(1, 'rgba(0,0,0,0.75)');
        c.fillStyle = wear; c.fillRect(0, 0, w, h);
      },
      hsig: () => 'k',
      height: (c, w, h) => {
        fill(c, w, h, '#808080');
        for (let i = 0; i < h; i += 3) {
          c.strokeStyle = i % 6 === 0 ? '#c8c8c8' : '#585858';
          c.lineWidth = 1.4;
          c.beginPath(); c.moveTo(0, i); c.lineTo(w, i); c.stroke();
        }
      },
    },
    {
      // The chain. A used BMX chain is NOT black: the plate faces are polished
      // bright by the sprocket and the rollers are oil-wet steel. Painting it
      // near-black is why the chain died to a dotted line at gameplay distance.
      key: 'OILY', u: 1, sig: () => 'k',
      colour: (c, w, h) => {
        // Oiled steel, not bare aluminium: the punch comes from the low roughness
        // below, so the albedo stays a dark grey-brown or the chain reads as a
        // bright rope draped along the chainstay.
        const grd = c.createLinearGradient(0, 0, 0, h);
        grd.addColorStop(0.00, '#25231f');
        grd.addColorStop(0.32, '#5e5b53');            // polished plate face
        grd.addColorStop(0.50, '#807c72');            // specular run along the top
        grd.addColorStop(0.68, '#54514a');
        grd.addColorStop(1.00, '#211f1c');
        c.fillStyle = grd; c.fillRect(0, 0, w, h);
        overlay(c, w, h, 0.22, 2);
        chips(c, w, h, 40, 'rgba(38,33,26,0.55)', 0.8, 2.6);   // oil and grit
        scratches(c, w, h, 80, '#e6e6df', 4, 30, 0.7);
      },
      rough: (c, w, h) => {
        fill(c, w, h, '#4c4c4c');                     // oil-wet: tight specular
        overlay(c, w, h, 0.5, 4, _speck);
        c.fillStyle = 'rgba(30,30,30,0.55)'; c.fillRect(0, h * 0.36, w, h * 0.28);
      },
      hsig: () => 'k',
      height: (c, w, h) => { fill(c, w, h, '#808080'); overlay(c, w, h, 0.8, 6, _speck); },
    },
    {
      key: 'BRASS', u: 1, sig: () => 'k',
      colour: (c, w, h) => { fill(c, w, h, '#b8933f'); overlay(c, w, h, 0.25, 2); scratches(c, w, h, 60, '#e8d79a', 5, 40, 0.7); },
      rough: (c, w, h) => fill(c, w, h, '#5e5e5e'),
    },
    {
      key: 'STEEL', u: 1, sig: () => 'k',
      colour: (c, w, h) => { fill(c, w, h, '#4e5358'); overlay(c, w, h, 0.28, 2); scratches(c, w, h, 90, '#aab1b6', 6, 50, 0.7); },
      rough: (c, w, h) => { fill(c, w, h, '#8a8a8a'); overlay(c, w, h, 0.35, 3); },
    },
    {
      // Anodised accent parts — top cap, bar-end plugs, headset cups, hub nuts.
      // Same single hue as ANOD, dyed to a real anodised albedo (~0.20 luma) so
      // it stops reading as a lit LED at dusk.
      key: 'ACCENT', u: 1, sig: (X) => `${X.anod}`,
      colour: (c, w, h, X) => {
        fill(c, w, h, HEX(X.anod));
        c.save(); c.globalAlpha = 0.45;
        for (let i = 0; i < 120; i++) {
          c.strokeStyle = rgba(shade(X.anod, rng() < 0.5 ? 0.55 : -0.5), rand(0.06, 0.24));
          c.lineWidth = rand(0.5, 1.6);
          const y = rand(0, h);
          c.beginPath(); c.moveTo(0, y); c.lineTo(w, y + rand(-2, 2)); c.stroke();
        }
        c.restore();
        overlay(c, w, h, 0.20, 2);
        scratches(c, w, h, 70, HEX(shade(X.anod, 0.5)), 5, 40, 0.7);
      },
      rough: (c, w, h) => {
        fill(c, w, h, '#5e5e5e');
        smudges(c, w, h, 6, 'rgba(180,180,180,0.4)', 'rgba(40,40,40,0.4)');
      },
      hsig: () => 'k',
      height: (c, w, h) => { fill(c, w, h, '#808080'); overlay(c, w, h, 0.18, 2); },
    },
    {
      key: 'RIM', u: 2, sig: (X) => `${X.rim.colour}|${X.rim.finish}|${X.accent}`,
      colour: (c, w, h, X) => {
        metal(c, w, h, X.rim, 'satin');
        // brake track: a polished belt across the middle of the profile
        const grd = c.createLinearGradient(0, h * 0.30, 0, h * 0.70);
        grd.addColorStop(0, 'rgba(255,255,255,0.0)');
        grd.addColorStop(0.5, 'rgba(238,244,248,0.42)');
        grd.addColorStop(1, 'rgba(255,255,255,0.0)');
        c.fillStyle = grd; c.fillRect(0, h * 0.30, w, h * 0.40);
        // three rim decals around the wheel
        for (let i = 0; i < 3; i++) {
          const x = w * (i + 0.5) / 3;
          text(c, 'VOLTA', x, h * 0.50, h * 0.16, HEX(inkOn(X.rim.colour)),
            { skew: -0.2, spacing: h * 0.02, alpha: 0.85 });
          c.fillStyle = rgba(X.accent, 0.8);
          c.fillRect(x - w * 0.10, h * 0.60, w * 0.20, h * 0.022);
        }
        scratches(c, w, h, 120, '#ffffff', 12, 90, 0.7);
      },
      rough: (c, w, h, X) => {
        fill(c, w, h, X.rim.finish === 'chrome' ? '#3a3a3a' : '#8e8e8e');
        c.fillStyle = 'rgba(40,40,40,0.5)'; c.fillRect(0, h * 0.30, w, h * 0.40);
        scratches(c, w, h, 100, '#c0c0c0', 8, 70, 0.8);
      },
      hsig: () => 'k',
      height: (c, w, h) => { fill(c, w, h, '#808080'); scratches(c, w, h, 90, '#6c6c6c', 8, 70, 0.8); },
    },
  ];
}

// ---------------------------------------------------------------------------
// tyre tread — ONE pattern definition, read by both the painter and the mesh
// ---------------------------------------------------------------------------

/** Repeats around the circumference. 48 blocks on a 1.63 m rolling circumference
 *  is a 34 mm pitch: dense enough to read as a tread at 3 m, coarse enough to
 *  break the silhouette against the sky at the top of the wheel. */
const TREAD_N = 48;

/**
 * One block list in (u = around the wheel, v = across the casing) space.
 * `uo`/`du` are fractions of ONE repeat, so a block can straddle a repeat
 * boundary and the shoulder lugs can stagger against the centre file.
 * `rise` is the real displacement in metres — the same number the geometry uses.
 */
function treadPattern(tread) {
  const out = [];
  const put = (i, uo, du, v0, v1, rise) => out.push({ i, uo, du, v0, v1, rise });
  for (let i = 0; i < TREAD_N; i++) {
    const odd = i % 2 === 1;
    if (tread === 'slick') {
      put(i, 0.04, 0.92, 0.468, 0.532, 0.0014);                       // moulded centre rib
      if (odd) {
        put(i, 0.10, 0.80, 0.636, 0.692, 0.0012);                     // shoulder sipe
        put(i, 0.10, 0.80, 0.308, 0.364, 0.0012);
      }
    } else if (tread === 'street') {
      put(i, 0.06, 0.64, 0.438, 0.562, 0.0034);                       // centre file
      put(i, odd ? 0.34 : -0.16, 0.46, 0.574, 0.658, 0.0032);
      put(i, odd ? -0.16 : 0.34, 0.46, 0.342, 0.426, 0.0032);
      if (odd) {
        put(i, 0.08, 0.58, 0.688, 0.754, 0.0028);                     // shoulder lugs
        put(i, 0.08, 0.58, 0.246, 0.312, 0.0028);
      }
    } else {                                                          // knobby park tread
      put(i, 0.08, 0.58, 0.430, 0.570, 0.0046);
      put(i, odd ? 0.36 : -0.14, 0.44, 0.580, 0.670, 0.0044);
      put(i, odd ? -0.14 : 0.36, 0.44, 0.330, 0.420, 0.0044);
      put(i, odd ? 0.00 : 0.50, 0.48, 0.684, 0.762, 0.0040);
      put(i, odd ? 0.50 : 0.00, 0.48, 0.238, 0.316, 0.0040);
    }
  }
  return out;
}

/** Paint the tread blocks into the TYRE region, matched 1:1 to the geometry. */
function drawTread(c, w, h, tread, css, edge) {
  const yv = (v) => (1 - v) * h;
  for (const b of treadPattern(tread)) {
    const x = ((b.i + b.uo) / TREAD_N) * w;
    const bw = (b.du / TREAD_N) * w;
    const y0 = yv(b.v1), y1 = yv(b.v0);
    const bh = y1 - y0;
    for (const dx of [-w, 0, w]) {
      const px = x + dx;
      if (px > w || px + bw < 0) continue;
      c.fillStyle = css;
      c.beginPath();
      c.roundRect(px, y0, bw, bh, Math.min(bw, bh) * 0.24);
      c.fill();
      c.fillStyle = edge;                                   // lit crown of the block
      c.fillRect(px + bw * 0.10, y0 + bh * 0.06, bw * 0.80, Math.max(1, bh * 0.16));
    }
  }
}

function bikeRubberRegions() {
  return [
    {
      key: 'TYRE', u: 2,
      sig: (X) => `${X.tyre.colour}|${X.tyre.wall}|${X.tyre.tread}`,
      colour: (c, w, h, X) => {
        const yv = (v) => (1 - v) * h;
        const tread = X.tyre.tread;
        fill(c, w, h, HEX(X.tyre.colour));
        // sidewalls live at the two v extremes of the lathe profile
        if (X.tyre.wall !== X.tyre.colour) {
          c.fillStyle = HEX(X.tyre.wall);
          c.fillRect(0, yv(0.245), w, yv(0.055) - yv(0.245));
          c.fillRect(0, yv(0.945), w, yv(0.755) - yv(0.945));
        }
        const wallInk = inkOn(X.tyre.wall);
        for (let i = 0; i < 4; i++) {
          const x = w * (i + 0.5) / 4;
          text(c, 'RUCKUS', x, yv(0.150), h * 0.052, rgba(wallInk, 0.75), { spacing: h * 0.004 });
          text(c, '20 x 2.25', x, yv(0.100), h * 0.024, rgba(wallInk, 0.6),
            { font: '700', family: 'sans-serif', spacing: h * 0.003 });
          text(c, 'RUCKUS', x, yv(0.850), h * 0.052, rgba(wallInk, 0.75), { spacing: h * 0.004, rot: Math.PI });
          text(c, 'GRIT CO', x, yv(0.900), h * 0.024, rgba(wallInk, 0.6),
            { font: '700', family: 'sans-serif', spacing: h * 0.003, rot: Math.PI });
        }
        // casing weave: the cords show through the sidewall rubber on a real tyre
        c.save();
        c.globalAlpha = 0.22;
        c.strokeStyle = HEX(shade(X.tyre.wall, -0.35));
        c.lineWidth = 1.1;
        for (let i = -h; i < w; i += 6) {
          c.beginPath(); c.moveTo(i, yv(0.30)); c.lineTo(i + h * 0.30, yv(0.02)); c.stroke();
          c.beginPath(); c.moveTo(i, yv(0.70)); c.lineTo(i + h * 0.30, yv(0.98)); c.stroke();
        }
        c.restore();
        // tread pattern — matched 1:1 to the tread GEOMETRY built in buildTyre so
        // the painted block and the displaced block are the same block
        drawTread(c, w, h, tread, HEX(shade(X.tyre.colour, -0.42)), HEX(shade(X.tyre.colour, 0.16)));
        overlay(c, w, h, 0.16, 3);
        chips(c, w, h, 40, 'rgba(58,55,51,0.6)', 1, 3.5);
      },
      rough: (c, w, h, X) => {
        const yv = (v) => (1 - v) * h;
        fill(c, w, h, '#e2e2e2');
        overlay(c, w, h, 0.3, 4);
        // the block crowns polish where they touch the ground; the sipes stay matt
        c.fillStyle = 'rgba(128,128,128,0.55)';
        c.fillRect(0, yv(0.62), w, yv(0.38) - yv(0.62));
        drawTread(c, w, h, X.tyre.tread, 'rgba(96,96,96,0.55)', 'rgba(230,230,230,0.45)');
        c.fillStyle = 'rgba(210,210,210,0.5)';                 // sidewall is dull
        c.fillRect(0, 0, w, yv(0.76)); c.fillRect(0, yv(0.24), w, h - yv(0.24));
      },
      hsig: (X) => `${X.tyre.tread}`,
      height: (c, w, h, X) => {
        const yv = (v) => (1 - v) * h;
        fill(c, w, h, '#808080');
        overlay(c, w, h, 0.4, 4);
        drawTread(c, w, h, X.tyre.tread, '#ffffff', '#3c3c3c');
        c.fillStyle = '#c8c8c8';
        for (let i = 0; i < 4; i++) {
          text(c, 'RUCKUS', w * (i + 0.5) / 4, yv(0.150), h * 0.052, '#c8c8c8', { spacing: h * 0.004 });
          text(c, 'RUCKUS', w * (i + 0.5) / 4, yv(0.850), h * 0.052, '#c8c8c8', { spacing: h * 0.004, rot: Math.PI });
        }
      },
    },
    {
      key: 'GRIP', u: 1, sig: (X) => `${X.grip}`,
      colour: (c, w, h, X) => {
        // The grip lathe runs v = 0 (inboard flange) → 1 (bar end). The flange is
        // a knurled collar; the barrel is ribbed; the last band is the bar plug seat.
        const yv = (v) => (1 - v) * h;
        fill(c, w, h, HEX(X.grip));
        overlay(c, w, h, 0.22, 3);
        for (let i = 0; i < 40; i++) {
          c.strokeStyle = rgba(shade(X.grip, 0.35), 0.22); c.lineWidth = 2;
          const x = (i / 40) * w;
          c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke();
        }
        // knurled flange band
        c.save();
        c.beginPath(); c.rect(0, yv(0.135), w, yv(0.0) - yv(0.135)); c.clip();
        fill(c, w, h, HEX(shade(X.grip, -0.30)));
        overlay(c, w, h, 0.7, 10, _knurlTile, 'overlay');
        c.restore();
        c.fillStyle = rgba(shade(X.grip, 0.4), 0.5);
        c.fillRect(0, yv(0.145), w, h * 0.008);
        text(c, 'GRIT', w * 0.5, yv(0.55), h * 0.20, rgba(inkOn(X.grip), 0.45), { spacing: 2 });
      },
      rough: (c, w, h) => {
        const yv = (v) => (1 - v) * h;
        fill(c, w, h, '#e8e8e8');
        overlay(c, w, h, 0.3, 4);
        c.fillStyle = 'rgba(190,190,190,0.5)';               // palm-polished barrel
        c.fillRect(0, yv(0.72), w, yv(0.20) - yv(0.72));
      },
      hsig: () => 'k',
      height: (c, w, h) => {
        const yv = (v) => (1 - v) * h;
        fill(c, w, h, '#808080');
        for (let i = 0; i < 40; i++) { c.fillStyle = '#d0d0d0'; c.fillRect((i / 40) * w, 0, w / 80, h); }
        overlay(c, w, h, 0.5, 6, _speck);
        c.save();
        c.beginPath(); c.rect(0, yv(0.135), w, yv(0.0) - yv(0.135)); c.clip();
        fill(c, w, h, '#808080');
        overlay(c, w, h, 1.0, 10, _knurlTile, 'source-over');
        c.restore();
      },
    },
    {
      key: 'SEAT', u: 1, sig: (X) => `${X.seat.colour}|${X.seat.print}|${X.accent}`,
      colour: (c, w, h, X) => {
        fill(c, w, h, HEX(X.seat.colour));
        overlay(c, w, h, 0.18, 4);
        if (X.seat.print === 'camo') {
          for (let i = 0; i < 26; i++) {
            const k = i % 3;
            c.fillStyle = rgba(k === 0 ? shade(X.seat.colour, -0.4)
              : k === 1 ? shade(X.seat.colour, 0.22) : mixc(X.seat.colour, 0x2a2f22, 0.6), 0.8);
            c.beginPath();
            c.ellipse(rand(0, w), rand(0, h), rand(w * 0.03, w * 0.10), rand(h * 0.08, h * 0.24), rand(0, 3), 0, TAU);
            c.fill();
          }
        }
        stitchLine(c, w * 0.16, h * 0.5, w * 0.84, h * 0.5, rgba(X.accent, 0.7), 2.4, [6, 9]);
        text(c, 'VOLTA', w * 0.5, h * 0.26, h * 0.16, rgba(inkOn(X.seat.colour), 0.75), { skew: -0.2, spacing: 3 });
      },
      rough: (c, w, h) => { fill(c, w, h, '#9c9c9c'); overlay(c, w, h, 0.4, 5); },
      hsig: () => 'k',
      height: (c, w, h) => {
        fill(c, w, h, '#808080');
        overlay(c, w, h, 0.7, 8, _speck);
        c.strokeStyle = '#3a3a3a'; c.lineWidth = 3;
        c.beginPath(); c.moveTo(w * 0.16, h * 0.5); c.lineTo(w * 0.84, h * 0.5); c.stroke();
      },
    },
    {
      key: 'CABLE', u: 1, sig: () => 'k',
      colour: (c, w, h) => { fill(c, w, h, '#101114'); overlay(c, w, h, 0.2, 3); },
      rough: (c, w, h) => fill(c, w, h, '#b0b0b0'),
      hsig: () => 'k',
      height: (c, w, h) => {
        for (let i = 0; i < h; i += 4) { c.fillStyle = i % 8 ? '#606060' : '#c0c0c0'; c.fillRect(0, i, w, 2); }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// rider atlas — regions the body, face, hair and every garment are painted into
// ---------------------------------------------------------------------------

/** Soft radial blob, used for beards, blush and hair mass. */
function blob(c, x, y, rx, ry, css, alpha = 1, rot = 0) {
  c.save();
  c.globalAlpha = alpha;
  c.translate(x, y); c.rotate(rot);
  const grd = c.createRadialGradient(0, 0, 0, 0, 0, 1);
  grd.addColorStop(0, css);
  grd.addColorStop(0.62, css);
  grd.addColorStop(1, css.replace(/[\d.]+\)$/, '0)'));
  c.scale(rx, ry);
  c.fillStyle = grd;
  c.beginPath(); c.arc(0, 0, 1, 0, TAU); c.fill();
  c.restore();
}

/** Speckled hair mass — stubble, beards, brows. */
function hairSpeckle(c, x, y, rx, ry, colour, density, alpha) {
  c.save();
  c.globalAlpha = alpha;
  c.fillStyle = HEX(colour);
  for (let i = 0; i < density; i++) {
    const a = rand(0, TAU), r = Math.sqrt(rng());
    const px = x + Math.cos(a) * rx * r, py = y + Math.sin(a) * ry * r;
    c.fillRect(px, py, rand(1, 2.4), rand(1, 3.2));
  }
  c.restore();
}

/**
 * One eye, drawn at real scale: `sx`/`sy` are pixels per millimetre so the almond,
 * the iris and the lids all keep their proportions whatever the atlas aspect is.
 * `out` is +1 toward the outer canthus.
 */
function drawEye(c, x, y, sx, sy, out, iris, skin) {
  const W = 15.5 * sx, H = 5.4 * sy;             // half opening: 31 mm × 11 mm
  const inner = x - out * W, outer = x + out * W;
  const irisR = 5.9;                             // 11.8 mm iris
  const cxi = x + out * 0.6 * sx, cyi = y - 0.4 * sy;

  // the lid opening as a path, reused for the fill, the clip and the lash line
  const openPath = () => {
    c.beginPath();
    c.moveTo(inner, y + 0.9 * sy);
    c.bezierCurveTo(x - out * W * 0.55, y - H * 1.30, x + out * W * 0.35, y - H * 1.24,
      outer, y - 0.9 * sy);
    c.bezierCurveTo(x + out * W * 0.42, y + H * 1.02, x - out * W * 0.45, y + H * 1.10,
      inner, y + 0.9 * sy);
    c.closePath();
  };

  c.save();
  openPath();
  // sclera: never white — it is a wet grey that darkens into both corners
  const scl = c.createLinearGradient(inner, y, outer, y);
  scl.addColorStop(0.00, '#9a938c');
  scl.addColorStop(0.22, '#d9d2c9');
  scl.addColorStop(0.55, '#e6dfd5');
  scl.addColorStop(1.00, '#a9a29a');
  c.fillStyle = scl; c.fill();
  c.clip();

  // iris
  const irx = irisR * sx, iry = irisR * sy;
  const ig = c.createRadialGradient(cxi - irx * 0.25, cyi - iry * 0.3, irx * 0.1, cxi, cyi, irx);
  ig.addColorStop(0, HEX(shade(iris, 0.42)));
  ig.addColorStop(0.55, HEX(iris));
  ig.addColorStop(1, HEX(shade(iris, -0.45)));
  c.fillStyle = ig;
  c.beginPath(); c.ellipse(cxi, cyi, irx, iry, 0, 0, TAU); c.fill();
  // fibres
  c.save();
  c.beginPath(); c.ellipse(cxi, cyi, irx, iry, 0, 0, TAU); c.clip();
  c.lineWidth = Math.max(1, irx * 0.10);
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * TAU + 0.13;
    c.strokeStyle = rgba(i % 2 ? shade(iris, 0.5) : shade(iris, -0.5), 0.35);
    c.beginPath();
    c.moveTo(cxi + Math.cos(a) * irx * 0.30, cyi + Math.sin(a) * iry * 0.30);
    c.lineTo(cxi + Math.cos(a) * irx * 1.0, cyi + Math.sin(a) * iry * 1.0);
    c.stroke();
  }
  c.restore();
  // limbal ring, pupil, the light that bounces up into the bottom of the iris
  c.strokeStyle = 'rgba(24,20,18,0.72)';
  c.lineWidth = Math.max(1.2, irx * 0.16);
  c.beginPath(); c.ellipse(cxi, cyi, irx * 0.94, iry * 0.94, 0, 0, TAU); c.stroke();
  c.fillStyle = '#0a0b0e';
  c.beginPath(); c.ellipse(cxi, cyi, irx * 0.42, iry * 0.42, 0, 0, TAU); c.fill();
  c.fillStyle = rgba(shade(iris, 0.75), 0.30);
  c.beginPath(); c.ellipse(cxi, cyi + iry * 0.42, irx * 0.52, iry * 0.36, 0, 0, TAU); c.fill();
  // upper lid shadow across the top third of the eye
  const ls = c.createLinearGradient(0, y - H * 1.5, 0, y + H * 0.35);
  ls.addColorStop(0, 'rgba(28,20,16,0.62)');
  ls.addColorStop(1, 'rgba(28,20,16,0)');
  c.fillStyle = ls; c.fillRect(inner - W, y - H * 1.6, W * 3, H * 2.2);
  // catchlight last, so nothing dulls it
  c.fillStyle = 'rgba(255,253,247,0.92)';
  c.beginPath();
  c.ellipse(cxi - out * irx * 0.34, cyi - iry * 0.40, irx * 0.20, iry * 0.16, -0.4, 0, TAU);
  c.fill();
  c.fillStyle = 'rgba(255,253,247,0.34)';
  c.beginPath();
  c.ellipse(cxi + out * irx * 0.40, cyi + iry * 0.30, irx * 0.11, iry * 0.09, 0, 0, TAU);
  c.fill();
  c.restore();

  // Lash line: thin at the inner corner, heavy over the outer half. Weight is
  // 2.1 px/mm of eye height rather than 1.05 — at the old width the lash was a
  // single texel that the mip chain ate before the eye was ever 40 px on screen,
  // and the eye stopped reading as an eye at exactly the distance it matters.
  c.save();
  c.lineCap = 'round';
  c.strokeStyle = 'rgba(12,9,8,0.98)';
  c.lineWidth = Math.max(2.4, 2.1 * sy);
  c.beginPath();
  c.moveTo(inner + out * 0.6 * sx, y + 0.6 * sy);
  c.bezierCurveTo(x - out * W * 0.55, y - H * 1.34, x + out * W * 0.35, y - H * 1.28,
    outer, y - 0.9 * sy);
  c.stroke();
  c.strokeStyle = 'rgba(20,15,13,0.55)';
  c.lineWidth = Math.max(1, 0.55 * sy);
  c.beginPath();
  c.moveTo(outer - out * 1.5 * sx, y - 0.6 * sy);
  c.quadraticCurveTo(x + out * W * 0.35, y + H * 0.95, x - out * W * 0.35, y + H * 0.95);
  c.stroke();
  c.restore();
  // wet rim under the eye, then the shadow the lid casts on the cheek
  c.strokeStyle = rgba(shade(skin, 0.40), 0.55);
  c.lineWidth = Math.max(1, 0.5 * sy);
  c.beginPath();
  c.moveTo(inner + out * 1.2 * sx, y + 1.4 * sy);
  c.quadraticCurveTo(x, y + H * 1.35, outer - out * 1.2 * sx, y + 0.8 * sy);
  c.stroke();
  blob(c, x, y + H * 1.9, W * 0.95, 2.4 * sy, rgba(shade(skin, -0.42), 0.20), 0.9);
  // tear duct
  blob(c, inner + out * 1.0 * sx, y + 0.8 * sy, 1.7 * sx, 1.5 * sy,
    rgba(mixc(skin, 0xa04a44, 0.55), 0.75), 0.95);
  // upper lid crease and the lid skin above it
  c.strokeStyle = rgba(shade(skin, -0.34), 0.45);
  c.lineWidth = Math.max(1, 0.55 * sy);
  c.beginPath();
  c.moveTo(inner + out * 1.5 * sx, y - H * 1.05);
  c.bezierCurveTo(x - out * W * 0.3, y - H * 2.55, x + out * W * 0.45, y - H * 2.35,
    outer + out * 1.5 * sx, y - H * 0.65);
  c.stroke();
}

/** Facial hair coverage masks, in face UV space. */
function drawFacialHair(c, w, h, X) {
  const B = X.beard;
  if (!B || B.style === 'none') return;
  const fx = (u) => u * w, fy = (v) => (1 - v) * h;
  const col = B.colour;
  const dark = rgba(col, 0.92);
  const s = B.style;
  const put = (u, v, ru, rv, a = 0.9, d = 260) => {
    blob(c, fx(u), fy(v), w * ru, h * rv, dark, a);
    hairSpeckle(c, fx(u), fy(v), w * ru, h * rv, shade(col, 0.22), d, 0.5);
  };
  if (s === 'stubble') {
    c.save(); c.globalAlpha = 0.55;
    hairSpeckle(c, fx(0.5), fy(0.150), w * 0.135, h * 0.105, col, 1800, 0.65);
    hairSpeckle(c, fx(0.5), fy(0.272), w * 0.075, h * 0.030, col, 400, 0.6);
    c.restore();
  }
  if (s === 'moustache' || s === 'goatee' || s === 'shortBeard' || s === 'fullBeard' || s === 'horseshoe') {
    put(0.5, 0.276, 0.055, 0.024, 0.95, 240);
  }
  if (s === 'soulPatch' || s === 'goatee' || s === 'shortBeard' || s === 'fullBeard') {
    put(0.5, 0.132, 0.028, 0.026, 0.95, 160);
  }
  if (s === 'goatee' || s === 'shortBeard' || s === 'fullBeard') {
    put(0.5, 0.090, 0.050, 0.050, 0.9, 340);
  }
  if (s === 'chinstrap' || s === 'shortBeard' || s === 'fullBeard' || s === 'muttonChops') {
    // along the jaw, both sides
    for (const sgn of [-1, 1]) {
      for (let i = 0; i <= 8; i++) {
        const t = i / 8;
        const u = 0.5 + sgn * lerp(0.055, 0.245, t);
        const v = lerp(0.075, 0.520, t * t);
        const rv = s === 'fullBeard' ? 0.060 : s === 'muttonChops' ? 0.052 : 0.032;
        put(u, v, 0.030, rv, 0.88, 90);
      }
    }
  }
  if (s === 'fullBeard') {
    put(0.5, 0.075, 0.090, 0.070, 0.92, 520);
    put(0.5, 0.150, 0.070, 0.050, 0.85, 320);
  }
  if (s === 'horseshoe') {
    for (const sgn of [-1, 1]) {
      for (let i = 0; i <= 4; i++) {
        const t = i / 4;
        put(0.5 + sgn * 0.055, lerp(0.262, 0.105, t), 0.021, 0.030, 0.9, 80);
      }
    }
  }
}

function riderRegions() {
  const skinSig = (X) => `${X.skin}`;
  return [
    // ---------------------------------------------------------------- skin
    {
      key: 'SKIN', u: 2, sig: skinSig,
      colour: (c, w, h, X) => {
        const skin = X.skin;
        fill(c, w, h, HEX(skin));
        // blood under the surface: limbs are warm on their outer face and cooler
        // where the light never reaches
        const warm = mixc(skin, 0xc05a44, 0.22);
        const cool = mixc(skin, 0x8b93ad, 0.18);
        for (let i = 0; i < 70; i++) {
          const up = rng() < 0.5;
          blob(c, rand(0, w), rand(0, h), w * rand(0.05, 0.16), h * rand(0.03, 0.10),
            rgba(up ? warm : cool, rand(0.05, 0.14)), 0.9);
        }
        overlay(c, w, h, 0.09, 4);
        chips(c, w, h, 70, rgba(shade(skin, -0.20), 0.35), 0.5, 1.8);
        chips(c, w, h, 40, rgba(shade(skin, 0.22), 0.35), 0.6, 2.2);
        // a few body hairs and freckles so bare skin is not a plastic surface
        c.lineCap = 'round';
        for (let i = 0; i < 130; i++) {
          const x = rand(0, w), y = rand(0, h), a = rand(-0.6, 0.6);
          c.strokeStyle = rgba(mixc(skin, 0x3a2418, 0.75), rand(0.05, 0.16));
          c.lineWidth = rand(0.8, 1.6);
          c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.sin(a) * 7, y + Math.cos(a) * 9); c.stroke();
        }
        const sh = c.createLinearGradient(0, 0, 0, h);
        sh.addColorStop(0, rgba(shade(skin, -0.45), 0.26));       // into the sleeve
        sh.addColorStop(0.35, 'rgba(0,0,0,0)');
        sh.addColorStop(0.82, rgba(warm, 0.16));                  // warm at the extremity
        sh.addColorStop(1, rgba(shade(skin, -0.40), 0.22));
        c.fillStyle = sh; c.fillRect(0, 0, w, h);
        // the sides of a limb catch less light than its front
        const side = c.createLinearGradient(0, 0, w, 0);
        side.addColorStop(0, rgba(shade(skin, -0.55), 0.34));
        side.addColorStop(0.25, 'rgba(0,0,0,0)');
        side.addColorStop(0.5, rgba(shade(skin, -0.55), 0.34));
        side.addColorStop(0.75, 'rgba(0,0,0,0)');
        side.addColorStop(0.999, rgba(shade(skin, -0.55), 0.34));
        side.addColorStop(1, rgba(shade(skin, -0.55), 0.34));
        c.fillStyle = side; c.fillRect(0, 0, w, h);
      },
      rough: (c, w, h) => { fill(c, w, h, '#b4b4b4'); overlay(c, w, h, 0.3, 5); },
      hsig: () => 'k',
      height: (c, w, h) => { fill(c, w, h, '#808080'); overlay(c, w, h, 0.30, 8, _speck); },
    },
    // ---------------------------------------------------------------- face
    {
      // 6 units, not 4: the head is read at ~900 px in the closeup and the face
      // occupies barely a third of the atlas width, so the vertical resolution is
      // what limits the eyes. At 6 x 160 = 960 rows this is 4.3 px/mm.
      key: 'FACE', u: 6,
      sig: (X) => `${X.skin}|${X.beard.style}|${X.beard.colour}|${X.hair.colour}|${X.hair.style}|${X.eye}`,
      colour: (c, w, h, X) => {
        const fx = (u) => u * w, fy = (v) => (1 - v) * h;
        const skin = X.skin;
        const sx = w / 492.6, sy = h / 221;                 // pixels per millimetre
        const mx = (mm) => w * 0.5 + mm * sx;
        // Three tones drive the whole face: a cool forehead, a warm mid-face
        // (blood is close to the surface across the nose and cheeks) and a
        // desaturated jaw. Painting those first is what stops the head reading
        // as a single flat swatch.
        const warm = mixc(skin, 0xc85a48, 0.20);
        const cool = mixc(skin, 0x8d94b0, 0.16);
        const deep = shade(skin, -0.30);
        fill(c, w, h, HEX(skin));
        blob(c, fx(0.5), fy(0.66), w * 0.150, h * 0.115, rgba(cool, 0.42), 0.95);
        blob(c, fx(0.5), fy(0.40), w * 0.135, h * 0.115, rgba(warm, 0.40), 0.95);
        blob(c, fx(0.5), fy(0.150), w * 0.115, h * 0.090, rgba(cool, 0.30), 0.95);
        for (const sgn of [-1, 1]) {
          blob(c, fx(0.5 + sgn * 0.105), fy(0.395), w * 0.075, h * 0.070, rgba(warm, 0.34), 0.95);
          blob(c, fx(0.5 + sgn * FL.earU), fy(FL.earMid), w * 0.040, h * 0.070, rgba(warm, 0.45), 0.95);
        }
        // large-scale mottling — real skin is never one value
        for (let i = 0; i < 46; i++) {
          const u = rand(0.16, 0.84), v = rand(0.05, 0.95);
          const up = rng() < 0.45;
          blob(c, fx(u), fy(v), w * rand(0.02, 0.055), h * rand(0.02, 0.05),
            rgba(up ? shade(skin, 0.16) : mixc(skin, 0x9a5a44, 0.30), rand(0.05, 0.13)), 0.9);
        }
        // the sides of the head turn away from every light
        const back = c.createLinearGradient(0, 0, w, 0);
        back.addColorStop(0.00, rgba(shade(skin, -0.40), 0.62));
        back.addColorStop(0.20, rgba(shade(skin, -0.20), 0.30));
        back.addColorStop(0.50, 'rgba(0,0,0,0)');
        back.addColorStop(0.80, rgba(shade(skin, -0.20), 0.30));
        back.addColorStop(1.00, rgba(shade(skin, -0.40), 0.62));
        c.fillStyle = back; c.fillRect(0, 0, w, h);

        // --- baked occlusion: every crease and overhang the sun cannot reach ---
        const ao = (u, v, ru, rv, a, rot = 0) =>
          blob(c, fx(u), fy(v), w * ru, h * rv, rgba(deep, a), 0.92, rot);
        ao(0.5, 0.02, 0.30, 0.070, 0.55);                    // under the jaw
        ao(0.5, FL.chinCrease, 0.055, 0.016, 0.34);          // mentolabial crease
        ao(0.5, FL.lipLow - 0.020, 0.055, 0.013, 0.40);      // under the lower lip
        ao(0.5, FL.noseBase - 0.012, 0.030, 0.011, 0.45);    // under the nose
        for (const sgn of [-1, 1]) {
          ao(0.5 + sgn * 0.030, 0.412, 0.016, 0.055, 0.30, sgn * 0.10);   // side of the nose
          ao(0.5 + sgn * 0.078, 0.265, 0.018, 0.045, 0.24, sgn * 0.35);   // nasolabial
          ao(0.5 + sgn * 0.065, 0.548, 0.055, 0.017, 0.20);               // under the brow
          ao(0.5 + sgn * 0.222, 0.632, 0.038, 0.045, 0.16);               // temple
          ao(0.5 + sgn * (FL.earU - 0.035), FL.earMid, 0.022, 0.070, 0.34);  // in front of the ear
          ao(0.5 + sgn * 0.150, 0.180, 0.045, 0.055, 0.30);               // jaw shadow
        }
        // the hair casts onto the forehead
        const hairAO = c.createLinearGradient(0, fy(FL.hairline + 0.03), 0, fy(FL.hairline - 0.075));
        hairAO.addColorStop(0, rgba(deep, 0.55));
        hairAO.addColorStop(1, rgba(deep, 0));
        c.fillStyle = hairAO;
        c.fillRect(w * 0.18, fy(FL.hairline + 0.05), w * 0.64, h * 0.13);

        overlay(c, w, h, 0.06, 7);
        chips(c, w, h, 140, rgba(shade(skin, -0.20), 0.22), 0.5, 1.5);
        chips(c, w, h, 60, rgba(mixc(skin, 0x8a4a30, 0.5), 0.22), 0.6, 2.0);

        // --- scalp + sideburns ------------------------------------------------
        const scalpC = mixc(X.hair.colour, skin, 0.34);
        const scalp = c.createLinearGradient(0, fy(0.86), 0, fy(FL.hairline - 0.012));
        scalp.addColorStop(0, rgba(scalpC, X.hair.style === 'bald' ? 0.0 : 0.95));
        scalp.addColorStop(1, rgba(scalpC, 0.0));
        c.fillStyle = scalp; c.fillRect(0, 0, w, fy(FL.hairline - 0.02));
        if (X.hair.style !== 'bald') {
          for (const sgn of [-1, 1]) {
            // sideburn: tight in front of the ear, fading out level with the tragus
            blob(c, fx(0.5 + sgn * 0.252), fy(0.672), w * 0.042, h * 0.055, rgba(X.hair.colour, 0.80), 0.9);
            blob(c, fx(0.5 + sgn * 0.266), fy(0.600), w * 0.020, h * 0.045, rgba(X.hair.colour, 0.50), 0.85);
            hairSpeckle(c, fx(0.5 + sgn * 0.268), fy(0.578), w * 0.015, h * 0.030, X.hair.colour, 200, 0.40);
          }
          hairSpeckle(c, fx(0.5), fy(FL.hairline - 0.004), w * 0.185, h * 0.013, X.hair.colour, 700, 0.34);
        }

        // --- brows ------------------------------------------------------------
        const browC = mixc(X.beard.colour, X.hair.colour, 0.5);
        for (const sgn of [-1, 1]) {
          // inner ends 9 mm off centre, not 5: at 5 the two brows nearly met and
          // read as a unibrow at any distance where the face was legible at all
          // A real brow is ~48 mm long and 6 mm deep. The old one ran 9 → 38 mm
          // with 4.4 mm of solid stroke and 120 near-VERTICAL 6 mm hairs on top,
          // which is 29 mm of black comb sitting on the brow ridge — the single
          // crudest mark on the face at closeup framing.
          const x0 = mx(sgn * 9), x1 = mx(sgn * 33), x2 = mx(sgn * 52);
          const y0 = fy(FL.brow - 0.004), y1 = fy(FL.brow + 0.015), y2 = fy(FL.brow - 0.014);
          const bAt = (t) => {
            const it = 1 - t;
            return [it * it * x0 + 2 * it * t * x1 + t * t * x2,
              it * it * y0 + 2 * it * t * y1 + t * t * y2];
          };
          c.save();
          // The brow is the strongest value in a face read at distance, but it is
          // a MASS of hair, not a drawn line: a soft body under fine strokes.
          c.globalAlpha = 0.46;
          c.strokeStyle = HEX(shade(browC, -0.30));
          c.lineCap = 'round'; c.lineJoin = 'round';
          for (const [wid, al] of [[5.6, 0.45], [3.4, 0.75]]) {
            c.globalAlpha = al * 0.62;
            c.lineWidth = wid * sy;
            c.beginPath(); c.moveTo(x0, y0); c.quadraticCurveTo(x1, y1, x2, y2); c.stroke();
          }
          c.restore();
          // hairs lie ALONG the brow, sweeping up at the head and down at the tail
          c.lineCap = 'round';
          for (let i = 0; i < 150; i++) {
            const t = Math.pow(i / 149, 0.92);
            const [bx, by] = bAt(t);
            const jx = rand(-1.6, 1.6) * sx, jy = rand(-2.4, 2.4) * sy * lerp(1.15, 0.7, t);
            const len = lerp(6.0, 3.4, t) * sx;
            const rise = lerp(-0.62, 0.30, t) + rand(-0.16, 0.16);
            c.strokeStyle = rgba(rng() < 0.45 ? shade(browC, 0.26) : shade(browC, -0.32), rand(0.30, 0.72));
            c.lineWidth = rand(0.5, 1.05) * sy;
            c.beginPath();
            c.moveTo(bx + jx, by + jy);
            c.lineTo(bx + jx + len * sgn, by + jy + rise * len * (sy / sx));
            c.stroke();
          }
        }

        // --- eyes -------------------------------------------------------------
        // The socket shadow goes down FIRST: an eye without a dark orbit around
        // it is a decal on a ball. This alone is worth more at 900 px than any
        // amount of detail inside the iris.
        for (const sgn of [-1, 1]) {
          blob(c, fx(0.5 + sgn * FL.eyeDX), fy(FL.eye + 0.004), 26 * sx, 13 * sy,
            rgba(shade(skin, -0.55), 0.42), 0.95);
          blob(c, fx(0.5 + sgn * FL.eyeDX), fy(FL.eye + 0.020), 22 * sx, 7 * sy,
            rgba(shade(skin, -0.62), 0.34), 0.95);
        }
        drawEye(c, fx(0.5 - FL.eyeDX), fy(FL.eye), sx, sy, -1, X.eye, skin);
        drawEye(c, fx(0.5 + FL.eyeDX), fy(FL.eye), sx, sy, +1, X.eye, skin);

        // --- nose -------------------------------------------------------------
        // The ridge is geometry; paint only adds the wing shadow, the tip
        // highlight and the nostrils.
        for (const sgn of [-1, 1]) {
          c.save();
          c.globalAlpha = 0.26;
          c.strokeStyle = HEX(shade(skin, -0.40));
          c.lineWidth = 2.2 * sx; c.lineCap = 'round';
          c.beginPath();
          c.moveTo(mx(sgn * 4), fy(FL.noseRoot - 0.01));
          c.quadraticCurveTo(mx(sgn * 5.5), fy(0.45), mx(sgn * 10), fy(FL.noseTip + 0.006));
          c.stroke();
          c.restore();
          blob(c, mx(sgn * 15), fy(FL.noseTip - 0.008), 5.0 * sx, 4.4 * sy,
            rgba(shade(skin, -0.34), 0.36), 0.92);          // ala shadow
          c.fillStyle = rgba(0x1a1210, 0.58);
          c.beginPath();
          c.ellipse(mx(sgn * 8.4), fy(FL.noseBase - 0.006), 2.5 * sx, 1.7 * sy, sgn * 0.55, 0, TAU);
          c.fill();
          c.fillStyle = rgba(shade(skin, 0.30), 0.30);
          c.beginPath();
          c.ellipse(mx(sgn * 12.4), fy(FL.noseBase + 0.004), 3.6 * sx, 2.6 * sy, sgn * 0.4, 0, TAU);
          c.fill();
        }
        blob(c, fx(0.5), fy(FL.noseTip + 0.004), 6.0 * sx, 5.0 * sy, rgba(shade(skin, 0.34), 0.32), 0.9);
        blob(c, fx(0.5), fy(FL.noseTip + 0.028), 3.0 * sx, 8.0 * sy, rgba(shade(skin, 0.24), 0.20), 0.9);

        // --- mouth ------------------------------------------------------------
        // Lips are SKIN with a little more blood in it, not a colour of their
        // own: at a 0.34 mix over a 0.8 alpha fill the mouth read as a painted-on
        // brown patch — the one mark that made the whole head look like a mask.
        const lip = mixc(skin, 0xa8514a, X.M && X.M.gender === 'female' ? 0.26 : 0.17);
        const mw = FL.mouthW * w, my = fy(FL.mouth);
        const lipTopY = fy(FL.lipTop), lipLowY = fy(FL.lipLow);
        c.save();
        c.beginPath();                                        // vermillion outline
        c.moveTo(fx(0.5) - mw, my);
        c.quadraticCurveTo(fx(0.5) - mw * 0.52, lipTopY - 1.0 * sy, fx(0.5) - mw * 0.17, lipTopY);
        c.quadraticCurveTo(fx(0.5), lipTopY + 2.0 * sy, fx(0.5) + mw * 0.17, lipTopY);
        c.quadraticCurveTo(fx(0.5) + mw * 0.52, lipTopY - 1.0 * sy, fx(0.5) + mw, my);
        c.quadraticCurveTo(fx(0.5) + mw * 0.55, lipLowY, fx(0.5), lipLowY);
        c.quadraticCurveTo(fx(0.5) - mw * 0.55, lipLowY, fx(0.5) - mw, my);
        c.closePath();
        const lg = c.createLinearGradient(0, lipTopY, 0, lipLowY);
        lg.addColorStop(0.00, rgba(shade(lip, -0.20), 0.40));
        lg.addColorStop(0.48, rgba(shade(lip, -0.26), 0.46));
        lg.addColorStop(0.62, rgba(lip, 0.48));
        lg.addColorStop(1.00, rgba(shade(lip, 0.12), 0.36));
        c.fillStyle = lg; c.fill();
        c.clip();
        for (let i = 0; i < 34; i++) {                        // lip creases
          const lx = fx(0.5) + rand(-mw, mw);
          c.strokeStyle = rgba(shade(lip, -0.40), rand(0.05, 0.13));
          c.lineWidth = rand(0.5, 1.0) * sx;
          c.beginPath(); c.moveTo(lx, lipTopY); c.lineTo(lx + rand(-1, 1) * sx, lipLowY); c.stroke();
        }
        c.restore();
        c.strokeStyle = rgba(shade(lip, -0.62), 0.58);        // the mouth line itself
        c.lineWidth = 1.1 * sy; c.lineCap = 'round';
        c.beginPath();
        c.moveTo(fx(0.5) - mw * 0.96, my + 0.7 * sy);
        c.quadraticCurveTo(fx(0.5) - mw * 0.45, my - 1.4 * sy, fx(0.5), my);
        c.quadraticCurveTo(fx(0.5) + mw * 0.45, my - 1.4 * sy, fx(0.5) + mw * 0.96, my + 0.7 * sy);
        c.stroke();
        blob(c, fx(0.5), fy(FL.lipLow + 0.012), mw * 0.42, 2.0 * sy,
          rgba(shade(lip, 0.65), 0.30), 0.9);                 // lower-lip highlight
        for (const sgn of [-1, 1]) {                          // mouth corners
          blob(c, fx(0.5) + sgn * mw * 0.98, my + 0.4 * sy, 2.2 * sx, 1.6 * sy,
            rgba(shade(skin, -0.45), 0.26), 0.92);
        }
        c.save(); c.globalAlpha = 0.18;                       // philtrum
        c.strokeStyle = HEX(shade(skin, -0.35)); c.lineWidth = 1.6 * sx;
        c.beginPath();
        c.moveTo(mx(-3.2), fy(FL.noseBase - 0.006)); c.lineTo(mx(-2.4), fy(FL.lipTop + 0.004));
        c.moveTo(mx(3.2), fy(FL.noseBase - 0.006)); c.lineTo(mx(2.4), fy(FL.lipTop + 0.004));
        c.stroke();
        c.restore();

        // --- chin, cheekbones, ears ------------------------------------------
        blob(c, fx(0.5), fy(FL.chin + 0.016), w * 0.042, h * 0.026, rgba(shade(skin, 0.20), 0.22), 0.85);
        for (const sgn of [-1, 1]) {
          blob(c, fx(0.5 + sgn * 0.120), fy(0.455), w * 0.055, h * 0.035,
            rgba(shade(skin, 0.16), 0.20), 0.85);             // cheekbone catch
          blob(c, fx(0.5 + sgn * FL.earU), fy(FL.earMid - 0.05), w * 0.022, h * 0.030,
            rgba(shade(skin, -0.34), 0.30), 0.9);             // behind the lobe
        }
        drawFacialHair(c, w, h, X);
        overlay(c, w, h, 0.05, 3, _speck);
      },
      rough: (c, w, h, X) => {
        const fx = (u) => u * w, fy = (v) => (1 - v) * h;
        const sx = w / 492.6, sy = h / 221;
        fill(c, w, h, '#b8b8b8');
        overlay(c, w, h, 0.28, 6);
        // sheen sits on the forehead, the nose ridge and the cheekbones — soft
        // falloffs only: any hard-edged rectangle here shows up as a visible
        // glossy patch on the face under a moving light.
        blob(c, fx(0.5), fy(0.660), w * 0.120, h * 0.055, 'rgba(126,126,126,0.55)', 0.9);
        blob(c, fx(0.5), fy(0.430), w * 0.022, h * 0.090, 'rgba(104,104,104,0.60)', 0.9);
        blob(c, fx(0.5), fy(FL.noseTip), w * 0.016, h * 0.020, 'rgba(84,84,84,0.75)', 0.9);
        for (const sgn of [-1, 1]) {
          blob(c, fx(0.5 + sgn * 0.115), fy(0.455), w * 0.050, h * 0.040, 'rgba(136,136,136,0.45)', 0.9);
          blob(c, fx(0.5 + sgn * FL.eyeDX), fy(FL.eye), 12 * sx, 8 * sy, 'rgba(30,30,30,0.85)', 0.95);
        }
        blob(c, fx(0.5), fy(FL.mouth), w * 0.048, h * 0.024, 'rgba(58,58,58,0.70)', 0.9);
        blob(c, fx(0.5), fy(FL.chin + 0.02), w * 0.040, h * 0.024, 'rgba(150,150,150,0.35)', 0.9);
        if (X.hair.style !== 'bald') {
          const g = c.createLinearGradient(0, fy(0.88), 0, fy(FL.hairline - 0.01));
          g.addColorStop(0, 'rgba(216,216,216,0.70)');
          g.addColorStop(1, 'rgba(216,216,216,0)');
          c.fillStyle = g; c.fillRect(0, 0, w, fy(FL.hairline - 0.01));
        }
        if (X.beard.coverage > 0.2) {
          c.save(); c.globalAlpha = 0.6;
          drawFacialHair(c, w, h, { ...X, beard: { ...X.beard, colour: 0xdcdcdc } });
          c.restore();
        }
      },
      hsig: (X) => `${X.beard.style}|${X.hair.style}`,
      height: (c, w, h, X) => {
        const fx = (u) => u * w, fy = (v) => (1 - v) * h;
        const sx = w / 492.6, sy = h / 221;
        fill(c, w, h, '#808080');
        overlay(c, w, h, 0.22, 12, _speck);
        // The skull already carries the big forms; the height map only adds what
        // is too fine to tessellate — lash lines, lip edges, nostril rims, pores.
        blob(c, fx(0.5), fy(FL.lipTop - 0.010), w * 0.044, h * 0.014, 'rgba(178,178,178,0.85)', 0.9);
        blob(c, fx(0.5), fy(FL.lipLow + 0.012), w * 0.042, h * 0.013, 'rgba(184,184,184,0.85)', 0.9);
        c.strokeStyle = 'rgba(66,66,66,0.9)'; c.lineWidth = 2.0 * sy; c.lineCap = 'round';
        c.beginPath();
        c.moveTo(fx(0.5) - FL.mouthW * w, fy(FL.mouth));
        c.quadraticCurveTo(fx(0.5), fy(FL.mouth + 0.006), fx(0.5) + FL.mouthW * w, fy(FL.mouth));
        c.stroke();
        for (const sgn of [-1, 1]) {
          blob(c, fx(0.5 + sgn * 0.055), fy(FL.brow + 0.004), w * 0.038, h * 0.011, 'rgba(172,172,172,0.9)', 0.9);
          blob(c, fx(0.5 + sgn * FL.eyeDX), fy(FL.eye + 0.012), 14 * sx, 4 * sy, 'rgba(96,96,96,0.8)', 0.9);
          blob(c, fx(0.5 + sgn * FL.eyeDX), fy(FL.eye - 0.014), 14 * sx, 3 * sy, 'rgba(168,168,168,0.7)', 0.9);
          c.fillStyle = 'rgba(52,52,52,0.9)';
          c.beginPath();
          c.ellipse(fx(0.5) + sgn * 8.4 * sx, fy(FL.noseBase - 0.004), 3.0 * sx, 2.1 * sy, sgn * 0.55, 0, TAU);
          c.fill();
        }
        if (X.beard.coverage > 0.15) {
          c.save(); c.globalAlpha = clamp(X.beard.coverage, 0, 1);
          drawFacialHair(c, w, h, { ...X, beard: { ...X.beard, colour: 0xb0b0b0 } });
          c.restore();
        }
      },
    },
    // ---------------------------------------------------------------- hair
    {
      key: 'HAIR', u: 1, sig: (X) => `${X.hair.colour}|${X.hair.style}`,
      colour: (c, w, h, X) => {
        const col = X.hair.colour;
        fill(c, w, h, HEX(shade(col, -0.12)));
        // strands run along v (root → tip)
        for (let i = 0; i < 420; i++) {
          const x = rand(0, w), y = rand(-h * 0.2, h);
          const len = rand(h * 0.15, h * 0.75);
          c.strokeStyle = rgba(rng() < 0.5 ? shade(col, rand(0.06, 0.30)) : shade(col, -rand(0.10, 0.35)),
            rand(0.14, 0.5));
          c.lineWidth = rand(1, 3.6);
          c.beginPath();
          c.moveTo(x, y);
          c.quadraticCurveTo(x + rand(-14, 14), y + len * 0.5, x + rand(-22, 22), y + len);
          c.stroke();
        }
        overlay(c, w, h, 0.22, 4);
        const grd = c.createLinearGradient(0, 0, 0, h);
        grd.addColorStop(0, rgba(shade(col, 0.18), 0.30));     // tips catch light
        grd.addColorStop(0.6, 'rgba(0,0,0,0)');
        grd.addColorStop(1, rgba(shade(col, -0.5), 0.45));     // roots sit in shadow
        c.fillStyle = grd; c.fillRect(0, 0, w, h);
      },
      rough: (c, w, h) => { fill(c, w, h, '#c8c8c8'); overlay(c, w, h, 0.4, 4); },
      hsig: () => 'k',
      height: (c, w, h) => {
        fill(c, w, h, '#808080');
        for (let i = 0; i < 300; i++) {
          const x = rand(0, w), y = rand(-h * 0.2, h);
          c.strokeStyle = rng() < 0.5 ? 'rgba(210,210,210,0.5)' : 'rgba(40,40,40,0.5)';
          c.lineWidth = rand(1, 4);
          c.beginPath();
          c.moveTo(x, y);
          c.quadraticCurveTo(x + rand(-14, 14), y + h * 0.3, x + rand(-22, 22), y + h * 0.7);
          c.stroke();
        }
      },
    },
    // ---------------------------------------------------------------- torso
    {
      key: 'TOP', u: 3,
      sig: (X) => `${X.top.body}|${X.top.trim}|${X.top.style}|${X.top.graphic.mark}|${X.top.graphic.text}|${X.bottom.colour}|${X.skin}`,
      colour: (c, w, h, X) => {
        const yv = (v) => (1 - v) * h;
        const T = X.top;
        const hem = T.style === 'jersey' ? 0.135 : T.style === 'hoodie' ? 0.115 : 0.175;
        // below the hem the torso is the bottoms
        fill(c, w, h, HEX(X.bottom.colour));
        c.fillStyle = rgba(shade(X.bottom.colour, -0.35), 0.6);
        c.fillRect(0, yv(hem * 0.62), w, h * 0.030);                 // waistband
        // seat pockets, on the back of the trousers (u ≈ 0.25)
        c.save();
        c.strokeStyle = rgba(X.bottom.style === 'jeans' ? 0xd6c6a0 : shade(X.bottom.colour, 0.4), 0.6);
        c.lineWidth = 2; c.setLineDash([5, 6]);
        for (const cx of [0.19, 0.31]) {
          c.beginPath();
          c.moveTo(w * (cx - 0.045), yv(hem * 0.52)); c.lineTo(w * (cx + 0.045), yv(hem * 0.52));
          c.lineTo(w * (cx + 0.045), yv(hem * 0.18)); c.lineTo(w * cx, yv(hem * 0.06));
          c.lineTo(w * (cx - 0.045), yv(hem * 0.18)); c.closePath();
          c.stroke();
        }
        c.restore();
        folds(c, w, yv(0) - yv(hem), 6, rgba(shade(X.bottom.colour, -0.7), 0.5), 0.5);
        // garment body
        c.fillStyle = HEX(T.body);
        c.fillRect(0, 0, w, yv(hem));
        // Weave at a real texel density. The old overlay drew the 64 px tile at
        // a third of the atlas width — a 20 mm thread pitch, which is not a weave,
        // it is a wallpaper. At scale 16 the pitch is ~3.5 mm on the garment and
        // the mip chain resolves it into a soft cloth grain at distance.
        overlay(c, w, yv(hem), 0.20, 16, _weaveTile);
        // hem: a turned-and-stitched band in the garment's own colour, and only a
        // contrast band on the styles that actually have one
        if (T.trimCuff) {
          c.fillStyle = HEX(T.trim);
          c.fillRect(0, yv(hem), w, h * 0.016);
        } else {
          c.fillStyle = rgba(shade(T.body, 0.10), 0.9);
          c.fillRect(0, yv(hem) - h * 0.014, w, h * 0.014);
          stitchLine(c, 0, yv(hem) - h * 0.016, w, yv(hem) - h * 0.016,
            rgba(shade(T.body, 0.35), 0.5), 2, [6, 7]);
        }
        c.fillStyle = rgba(shade(T.body, -0.5), 0.55);
        c.fillRect(0, yv(hem) + (T.trimCuff ? h * 0.016 : 0), w, h * 0.010);
        if (T.style === 'jersey') {
          c.fillStyle = rgba(T.trim, 0.85);
          c.fillRect(0, yv(hem + 0.030), w, h * 0.012);
        }
        // Collar. v = 1 is also where the torso's own shoulder cap lands, so a
        // contrast band up here shows as a pale patch behind the neck on a tee —
        // only the styles with a real contrast collar get one.
        c.fillStyle = T.trimCuff ? HEX(T.trim) : HEX(shade(T.body, 0.13));
        c.fillRect(0, 0, w, h * 0.026);
        for (let i = 0; i < 120; i++) {                      // rib knit
          c.fillStyle = rgba(shade(T.body, i % 2 ? 0.24 : -0.16), 0.45);
          c.fillRect((i / 120) * w, 0, w / 240, h * 0.026);
        }
        c.fillStyle = rgba(shade(T.body, -0.45), 0.5);
        c.fillRect(0, h * 0.026, w, h * 0.012);
        if (T.style === 'tank') {
          // bare shoulders: fade the garment out toward the armholes and the top
          const g2 = c.createLinearGradient(0, 0, 0, yv(0.74));
          g2.addColorStop(0, rgba(X.skin, 1));
          g2.addColorStop(1, rgba(X.skin, 0));
          for (const u0 of [0, 0.5]) {
            c.save();
            c.beginPath(); c.rect(u0 * w - w * 0.09, 0, w * 0.18, yv(0.74)); c.clip();
            c.fillStyle = g2; c.fillRect(u0 * w - w * 0.09, 0, w * 0.18, yv(0.74));
            c.restore();
          }
          c.fillStyle = HEX(X.skin); c.fillRect(0, 0, w, h * 0.030);
        }
        if (T.style === 'hoodie') {
          // kangaroo pocket across the chest-front band
          c.fillStyle = rgba(shade(T.body, -0.22), 0.85);
          c.beginPath();
          c.roundRect(w * 0.60, yv(0.42), w * 0.30, yv(hem + 0.02) - yv(0.42), w * 0.012);
          c.fill();
          stitchLine(c, w * 0.60, yv(0.42), w * 0.90, yv(0.42), rgba(shade(T.body, -0.6), 0.8), 2, [5, 5]);
          // drawcords at the collar
          c.strokeStyle = HEX(T.trim); c.lineWidth = h * 0.008; c.lineCap = 'round';
          for (const dx of [-0.02, 0.02]) {
            c.beginPath();
            c.moveTo(w * (0.75 + dx), h * 0.045);
            c.lineTo(w * (0.75 + dx * 2.4), h * 0.16);
            c.stroke();
          }
        }
        // Print first, cloth shading second: a screen print sits IN the weave, so
        // every fold and every shadow has to run across it, not under it.
        const ink = separate(T.trim, T.body, 0.20);
        // Prints are flipped in the atlas. Measured, not assumed: type painted
        // left-to-right here comes out right-to-left on the garment at BOTH the
        // chest and the back, so every printed mark is drawn through a mirror
        // about its own centre.
        const printed = (fn, ux) => {
          c.save();
          c.translate(w * ux, 0); c.scale(-1, 1); c.translate(-w * ux, 0);
          fn();
          c.restore();
        };
        // On the TORSO capsule u = 0.75 is dead centre front and u = 0.25 is the
        // back (see capsule2 — the leg tubes are the other way round because their
        // axis points down). The chest print therefore lives at 0.75, and it gets
        // a real panel size: a print reads at a third of the chest width, or it is
        // not a print, it is a badge.
        printed(() => {
          drawMark(c, w * 0.75, yv(0.640), h * 0.225, T.graphic, ink, T.body);
          if (T.graphic.mark !== 'none') {
            text(c, 'MIRRA CITY', w * 0.75, yv(0.500), h * 0.038, rgba(ink, 0.85),
              { spacing: h * 0.008, maxWidth: w * 0.26 });
          }
        }, 0.75);
        if (T.graphic.mark !== 'none') {
          printed(() => {
            drawMark(c, w * 0.25, yv(0.640), h * 0.165, T.graphic, T.body, ink);
            text(c, 'RIDE THE LOT', w * 0.25, yv(0.505), h * 0.030, rgba(ink, 0.7),
              { spacing: h * 0.006, maxWidth: w * 0.22 });
          }, 0.25);
        }
        overlay(c, w, yv(hem), 0.16, 16, _weaveTile);
        folds(c, w, yv(hem), 16, rgba(shade(T.body, -0.65), 0.38), 0.55);
        folds(c, w, yv(hem), 8, rgba(shade(T.body, 0.5), 0.16), 0.5);
        // Baked crease occlusion where a top ACTUALLY creases on a rider bent over
        // the bars: a horizontal bunch above the waist, a pull from each armpit,
        // and the drape off the shoulder yoke.
        const bunch = c.createLinearGradient(0, yv(hem + 0.16), 0, yv(hem + 0.02));
        bunch.addColorStop(0, rgba(shade(T.body, -0.72), 0));
        bunch.addColorStop(0.55, rgba(shade(T.body, -0.72), 0.34));
        bunch.addColorStop(1, rgba(shade(T.body, -0.72), 0.10));
        c.fillStyle = bunch; c.fillRect(0, yv(hem + 0.16), w, yv(hem + 0.02) - yv(hem + 0.16));
        for (const u0 of [0.02, 0.48]) {
          const g3 = c.createLinearGradient(w * u0, 0, w * (u0 + 0.10), 0);
          g3.addColorStop(0, rgba(shade(T.body, -0.55), 0.34));
          g3.addColorStop(1, rgba(shade(T.body, -0.55), 0));
          c.fillStyle = g3; c.fillRect(w * u0, 0, w * 0.10, yv(hem + 0.25));
        }
        const yoke = c.createLinearGradient(0, 0, 0, h * 0.20);
        yoke.addColorStop(0, rgba(shade(T.body, 0.35), 0.16));
        yoke.addColorStop(1, rgba(shade(T.body, 0.35), 0));
        c.fillStyle = yoke; c.fillRect(0, 0, w, h * 0.20);
        overlay(c, w, h, 0.10, 4);
      },
      rough: (c, w, h, X) => {
        const yv = (v) => (1 - v) * h;
        const hem = X.top.style === 'jersey' ? 0.135 : X.top.style === 'hoodie' ? 0.115 : 0.175;
        // Cloth sits at 0.85–0.95 and it VARIES: fold crests polish, the printed
        // panel is plastisol (much tighter), the weave between them stays matt.
        fill(c, w, h, X.top.style === 'jersey' ? '#d8d8d8' : '#f2f2f2');
        overlay(c, w, h, 0.32, 16, _weaveTile);
        overlay(c, w, h, 0.25, 4);
        folds(c, w, h, 14, 'rgba(168,168,168,0.5)', 0.5);
        if (X.top.graphic.mark !== 'none') {
          const printed = (fn, ux) => {
            c.save(); c.translate(w * ux, 0); c.scale(-1, 1); c.translate(-w * ux, 0);
            fn(); c.restore();
          };
          printed(() => drawMark(c, w * 0.75, yv(0.640), h * 0.225, X.top.graphic, 0x585858, 0x6a6a6a), 0.75);
          printed(() => drawMark(c, w * 0.25, yv(0.640), h * 0.165, X.top.graphic, 0x585858, 0x6a6a6a), 0.25);
        }
        // below the hem is trousers, which are a different cloth again
        c.fillStyle = 'rgba(216,216,216,0.55)';
        c.fillRect(0, yv(hem), w, h - yv(hem));
      },
      hsig: (X) => `${X.top.style}|${X.top.graphic.mark}`,
      height: (c, w, h, X) => {
        const yv = (v) => (1 - v) * h;
        const hem = X.top.style === 'jersey' ? 0.135 : X.top.style === 'hoodie' ? 0.115 : 0.175;
        fill(c, w, h, '#808080');
        overlay(c, w, h, 0.75, 16, _weaveTile);
        folds(c, w, h, 18, '#4e4e4e', 0.6);
        folds(c, w, h, 10, '#b6b6b6', 0.5);
        c.fillStyle = '#c0c0c0'; c.fillRect(0, 0, w, h * 0.030);     // collar rib
        // the hem's turned edge and the waist bunch, in real relief
        c.fillStyle = '#c8c8c8'; c.fillRect(0, yv(hem) - h * 0.016, w, h * 0.016);
        c.fillStyle = '#5c5c5c'; c.fillRect(0, yv(hem + 0.045), w, h * 0.020);
        drawMarkHeight(c, w * 0.75, yv(0.640), h * 0.225, X.top.graphic);
      },
    },
    // ---------------------------------------------------------------- sleeve
    {
      // 2 units, not 1: a 160 px band bleeds its neighbours into the lower mips
      // and small parts mapped into it pick up the white trim next door.
      key: 'SLEEVE', u: 2,
      sig: (X) => `${X.top.sleeve}|${X.top.trim}|${X.top.style}`,
      colour: (c, w, h, X) => {
        const T = X.top;
        // v = 0 (canvas bottom) is the shoulder, v = 1 (canvas top) the cuff.
        fill(c, w, h, HEX(T.sleeve));
        overlay(c, w, h, 0.20, 16, _weaveTile);
        // raglan seam: a real stitched line running down from the neck, which is
        // the thing that makes a raglan read as a raglan
        if (T.style === 'raglan' || T.style === 'jersey') {
          c.save();
          c.strokeStyle = rgba(shade(T.sleeve, -0.55), 0.55);
          c.lineWidth = 3; c.setLineDash([7, 8]);
          c.beginPath(); c.moveTo(0, h * 0.955); c.lineTo(w, h * 0.955); c.stroke();
          c.restore();
        }
        // Cuff at the far end of the sleeve (v = 1 → canvas top). Only a garment
        // that actually HAS contrast ribbing gets it: a plain tee has a turned
        // and stitched hem in its own cloth, and painting a white rib band on one
        // made every tee look like a baseball raglan.
        const cuffCol = T.trimCuff ? T.trim : shade(T.sleeve, 0.10);
        c.fillStyle = HEX(cuffCol);
        c.fillRect(0, 0, w, T.trimCuff ? h * 0.075 : h * 0.030);
        if (T.trimCuff) {
          for (let i = 0; i < 150; i++) {                   // rib knit on the cuff
            c.fillStyle = rgba(shade(T.trim, i % 2 ? 0.26 : -0.24), 0.4);
            c.fillRect((i / 150) * w, 0, w / 300, h * 0.075);
          }
        } else {
          stitchLine(c, 0, h * 0.032, w, h * 0.032, rgba(shade(T.sleeve, 0.35), 0.55), 2, [6, 7]);
        }
        c.fillStyle = rgba(shade(T.sleeve, -0.5), 0.5);
        c.fillRect(0, T.trimCuff ? h * 0.075 : h * 0.038, w, h * 0.020);
        if (T.style === 'jersey' || T.style === 'raglan') {
          c.fillStyle = rgba(T.trim, 0.75);
          c.fillRect(0, h * 0.15, w, h * 0.030);
          c.fillRect(0, h * 0.20, w, h * 0.014);
        }
        folds(c, w, h, 14, rgba(shade(T.sleeve, -0.62), 0.36), 0.55);
        folds(c, w, h, 7, rgba(shade(T.sleeve, 0.5), 0.14), 0.5);
        // the sleeve bunches at the elbow end of its run
        const bunch = c.createLinearGradient(0, h * 0.06, 0, h * 0.30);
        bunch.addColorStop(0, rgba(shade(T.sleeve, -0.7), 0.30));
        bunch.addColorStop(1, rgba(shade(T.sleeve, -0.7), 0));
        c.fillStyle = bunch; c.fillRect(0, h * 0.06, w, h * 0.24);
        overlay(c, w, h, 0.10, 3);
      },
      rough: (c, w, h) => {
        fill(c, w, h, '#f0f0f0');
        overlay(c, w, h, 0.32, 16, _weaveTile);
        overlay(c, w, h, 0.25, 3);
        folds(c, w, h, 10, 'rgba(172,172,172,0.5)', 0.5);
        c.fillStyle = 'rgba(206,206,206,0.6)'; c.fillRect(0, 0, w, h * 0.060);
      },
      hsig: () => 'k',
      height: (c, w, h) => {
        fill(c, w, h, '#808080');
        overlay(c, w, h, 0.75, 16, _weaveTile);
        folds(c, w, h, 12, '#4e4e4e', 0.6);
        folds(c, w, h, 7, '#b8b8b8', 0.5);
        for (let i = 0; i < 150; i++) {
          c.fillStyle = i % 2 ? '#c6c6c6' : '#5a5a5a';
          c.fillRect((i / 150) * w, 0, w / 300, h * 0.075);
        }
      },
    },
    // ---------------------------------------------------------------- trim
    {
      key: 'TRIM', u: 1, sig: (X) => `${X.top.trim}|${X.bottom.colour}`,
      colour: (c, w, h, X) => {
        fill(c, w, h, HEX(X.top.trim));
        for (let i = 0; i < 90; i++) {
          c.strokeStyle = rgba(shade(X.top.trim, -0.35), 0.35);
          c.lineWidth = 2;
          const x = (i / 90) * w;
          c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke();
        }
        overlay(c, w, h, 0.16, 3);
      },
      rough: (c, w, h) => { fill(c, w, h, '#f2f2f2'); overlay(c, w, h, 0.2, 3); },
      hsig: () => 'k',
      height: (c, w, h) => {
        fill(c, w, h, '#808080');
        for (let i = 0; i < 90; i++) {
          c.fillStyle = i % 2 ? '#c4c4c4' : '#585858';
          c.fillRect((i / 90) * w, 0, w / 180, h);
        }
      },
    },
    // ---------------------------------------------------------------- bottoms
    {
      key: 'BOTTOM', u: 2, sig: (X) => `${X.bottom.colour}|${X.bottom.style}`,
      colour: (c, w, h, X) => {
        // v = 0 (canvas BOTTOM) is the hip, v = 1 (canvas TOP) the cuff, u = 0.25
        // is the front of the leg, u = 0 the outseam and u = 0.5 the inseam.
        const col = X.bottom.colour;
        const denim = X.bottom.style === 'jeans';
        const yv = (v) => (1 - v) * h;
        fill(c, w, h, HEX(col));
        // The twill IS the material. A real 3/1 wale, tiled at ~2 mm on the
        // garment, not a handful of hairlines drawn across the whole panel.
        overlay(c, w, h, denim ? 0.34 : 0.18, denim ? 18 : 14, denim ? _twillTile : _weaveTile);
        if (denim) {
          // whiskering + fade at the thigh front (u = 0.25) and the seat (u=0.75)
          const fade = c.createLinearGradient(0, 0, w, 0);
          fade.addColorStop(0, 'rgba(255,255,255,0)');
          fade.addColorStop(0.25, rgba(shade(col, 0.45), 0.16));
          fade.addColorStop(0.5, 'rgba(255,255,255,0)');
          fade.addColorStop(0.75, rgba(shade(col, 0.60), 0.24));
          fade.addColorStop(1, 'rgba(255,255,255,0)');
          c.fillStyle = fade; c.fillRect(0, 0, w, h);
          // ABRADED KNEE: a real lighter patch on the front of the leg at the
          // knee station, with whisker creases fanning out of it
          const kneeY = yv(0.48);
          blob(c, w * 0.25, kneeY, w * 0.13, h * 0.075, rgba(shade(col, 0.62), 0.34), 0.95);
          blob(c, w * 0.25, kneeY, w * 0.08, h * 0.045, rgba(shade(col, 0.75), 0.24), 0.95);
          c.save();
          c.strokeStyle = rgba(shade(col, 0.70), 0.30); c.lineCap = 'round';
          for (let i = 0; i < 16; i++) {
            const t = i / 15;
            const y = kneeY + lerp(-h * 0.075, h * 0.075, t);
            c.lineWidth = rand(1.4, 3.4);
            c.beginPath();
            c.moveTo(w * (0.25 - 0.115), y + rand(-4, 4));
            c.quadraticCurveTo(w * 0.25, y + rand(-10, 10), w * (0.25 + 0.115), y + rand(-4, 4));
            c.stroke();
          }
          c.restore();
          // seat wear, high on the back of the leg
          blob(c, w * 0.75, yv(0.90), w * 0.15, h * 0.055, rgba(shade(col, 0.50), 0.22), 0.95);
        }
        folds(c, w, h, 22, rgba(shade(col, -0.62), 0.40), 0.6);
        folds(c, w, h, 12, rgba(shade(col, 0.55), 0.16), 0.5);
        // the trouser stacks on the shoe: hard bunched creases at the cuff
        for (let i = 0; i < 5; i++) {
          const y = h * (0.012 + i * 0.026);
          c.strokeStyle = rgba(shade(col, i % 2 ? -0.6 : 0.35), 0.30);
          c.lineWidth = rand(2.5, 6);
          c.beginPath();
          c.moveTo(0, y);
          c.bezierCurveTo(w * 0.33, y + rand(-6, 6), w * 0.66, y + rand(-6, 6), w, y);
          c.stroke();
        }
        // seams at u = 0 (outseam) and u = 0.5 (inseam), with real topstitch
        const seam = rgba(denim ? 0xe0cfa2 : shade(col, 0.45), 0.7);
        for (const x of [2, w - 2, w * 0.5 - 4, w * 0.5 + 4]) {
          c.fillStyle = rgba(shade(col, -0.45), 0.5);
          c.fillRect(x - 3, 0, 6, h);
          stitchLine(c, x, 0, x, h, seam, 2.2, [6, 7]);
        }
        // felled outseam: a second row of topstitch beside the first
        stitchLine(c, 9, 0, 9, h, seam, 1.8, [6, 8]);
        stitchLine(c, w - 9, 0, w - 9, h, seam, 1.8, [6, 8]);
        overlay(c, w, h, 0.12, 4);
        chips(c, w, h, 30, rgba(shade(col, 0.6), 0.10), 2, 7);
      },
      rough: (c, w, h, X) => {
        const yv = (v) => (1 - v) * h;
        const denim = X.bottom.style === 'jeans';
        fill(c, w, h, denim ? '#e8e8e8' : '#f0f0f0');
        overlay(c, w, h, denim ? 0.35 : 0.25, denim ? 18 : 14, denim ? _twillTile : _weaveTile);
        overlay(c, w, h, 0.3, 4);
        // denim polishes where it rubs: fold crests, the knee and the seat
        folds(c, w, h, 20, 'rgba(160,160,160,0.5)', 0.5);
        if (denim) {
          blob(c, w * 0.25, yv(0.48), w * 0.13, h * 0.075, 'rgba(120,120,120,0.55)', 0.95);
          blob(c, w * 0.75, yv(0.90), w * 0.15, h * 0.055, 'rgba(132,132,132,0.45)', 0.95);
        }
      },
      hsig: (X) => `${X.bottom.style}`,
      height: (c, w, h, X) => {
        const denim = X.bottom.style === 'jeans';
        fill(c, w, h, '#808080');
        overlay(c, w, h, denim ? 0.85 : 0.55, denim ? 18 : 14, denim ? _twillTile : _weaveTile);
        folds(c, w, h, 24, '#4a4a4a', 0.65);
        folds(c, w, h, 14, '#bcbcbc', 0.55);
        for (const x of [2, w - 2, w * 0.5 - 4, w * 0.5 + 4]) {
          c.fillStyle = '#9c9c9c'; c.fillRect(x - 3, 0, 6, h);        // felled seam ridge
          stitchLine(c, x, 0, x, h, '#dcdcdc', 3, [6, 7]);
        }
        for (let i = 0; i < 5; i++) {                                 // cuff stack
          const y = h * (0.012 + i * 0.026);
          c.strokeStyle = i % 2 ? '#4c4c4c' : '#c4c4c4';
          c.lineWidth = 5;
          c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke();
        }
      },
    },
    // ---------------------------------------------------------------- shoes
    {
      key: 'SHOE', u: 1, sig: (X) => `${X.shoe.colour}|${X.shoe.laces}|${X.shoe.style}|${X.top.trim}`,
      colour: (c, w, h, X) => {
        const col = X.shoe.colour;
        fill(c, w, h, HEX(col));
        overlay(c, w, h, 0.18, 4);
        // Suede breaks up: the shoe is never one flat value, and the wear runs
        // along the toe and the outside edge where a rider drags it.
        for (let i = 0; i < 60; i++) {
          blob(c, rand(0, w), rand(0, h), w * rand(0.03, 0.10), h * rand(0.02, 0.07),
            rgba(rng() < 0.5 ? shade(col, 0.16) : shade(col, -0.20), rand(0.06, 0.16)), 0.9);
        }
        // the shoe capsule runs heel(v=0) → toe(v=1); u = 0.5 is the top of the foot
        c.fillStyle = HEX(shade(col, -0.28));
        c.fillRect(0, 0, w, h * 0.14);                       // toe cap
        c.fillStyle = rgba(shade(col, 0.30), 0.28);
        c.fillRect(0, h * 0.03, w, h * 0.04);                // scuffed toe
        stitchLine(c, 0, h * 0.16, w, h * 0.16, rgba(shade(col, 0.45), 0.7), 2, [5, 5]);
        stitchLine(c, 0, h * 0.60, w, h * 0.60, rgba(shade(col, 0.35), 0.5), 2, [6, 7]);
        // eyestay panels either side of the instep. At 0.85 alpha over a −0.30
        // shade these were two black slots on the top of the shoe.
        c.fillStyle = rgba(shade(col, -0.20), 0.50);
        c.fillRect(w * 0.355, h * 0.22, w * 0.055, h * 0.62);
        c.fillRect(w * 0.590, h * 0.22, w * 0.055, h * 0.62);
        // tongue, under the laces
        c.fillStyle = rgba(shade(col, 0.20), 0.55);
        c.fillRect(w * 0.42, h * 0.22, w * 0.16, h * 0.62);
        // laces down the instep. The strip at u ∈ [0.465, 0.535] is also what the
        // lace GEOMETRY samples, so it stays pure lace colour.
        const lace = X.shoe.laces;
        c.fillStyle = HEX(lace);
        c.fillRect(w * 0.462, h * 0.14, w * 0.078, h * 0.76);
        c.save();
        c.beginPath(); c.rect(w * 0.462, 0, w * 0.078, h); c.clip();
        c.strokeStyle = rgba(shade(lace, -0.45), 0.5); c.lineWidth = 2;
        for (let i = 0; i < 40; i++) {
          const y = h * (0.14 + i * 0.019);
          c.beginPath(); c.moveTo(w * 0.462, y); c.lineTo(w * 0.540, y + h * 0.010); c.stroke();
        }
        c.restore();
        c.strokeStyle = HEX(lace); c.lineWidth = h * 0.028; c.lineCap = 'round';
        for (let i = 0; i < 5; i++) {
          const y = h * (0.28 + i * 0.115);
          c.beginPath(); c.moveTo(w * 0.385, y); c.lineTo(w * 0.615, y + h * 0.045); c.stroke();
          c.beginPath(); c.moveTo(w * 0.385, y + h * 0.045); c.lineTo(w * 0.615, y); c.stroke();
        }
        c.fillStyle = HEX(shade(col, -0.62));
        for (let i = 0; i < 5; i++) {
          const y = h * (0.28 + i * 0.115);
          c.beginPath(); c.ellipse(w * 0.383, y, w * 0.010, h * 0.016, 0, 0, TAU); c.fill();
          c.beginPath(); c.ellipse(w * 0.617, y, w * 0.010, h * 0.016, 0, 0, TAU); c.fill();
        }
        // collar padding at the heel end
        c.fillStyle = rgba(shade(col, 0.16), 0.45);
        c.fillRect(0, h * 0.90, w, h * 0.10);
        // invented side stripe on both flanks
        for (const u0 of [0.18, 0.82]) {
          c.save();
          c.translate(w * u0, h * 0.5);
          c.fillStyle = rgba(separate(X.top.trim, col, 0.22), 0.9);
          c.beginPath();
          c.moveTo(-w * 0.055, h * 0.10); c.lineTo(w * 0.055, -h * 0.14);
          c.lineTo(w * 0.075, -h * 0.06); c.lineTo(-w * 0.035, h * 0.18);
          c.closePath(); c.fill();
          c.restore();
        }
        stitchLine(c, 0, h * 0.86, w, h * 0.86, rgba(shade(col, 0.4), 0.55), 2, [5, 5]);
        chips(c, w, h, 60, 'rgba(90,78,58,0.30)', 1, 5);      // park dirt
      },
      rough: (c, w, h) => { fill(c, w, h, '#dcdcdc'); overlay(c, w, h, 0.3, 4); },
      hsig: () => 'k',
      height: (c, w, h) => {
        fill(c, w, h, '#808080');
        overlay(c, w, h, 0.4, 8, _weaveTile);
        c.strokeStyle = '#e0e0e0'; c.lineWidth = h * 0.030;
        for (let i = 0; i < 5; i++) {
          const y = h * (0.28 + i * 0.115);
          c.beginPath(); c.moveTo(w * 0.40, y); c.lineTo(w * 0.60, y + h * 0.045); c.stroke();
          c.beginPath(); c.moveTo(w * 0.40, y + h * 0.045); c.lineTo(w * 0.60, y); c.stroke();
        }
        c.fillStyle = '#6a6a6a'; c.fillRect(0, 0, w, h * 0.14);
      },
    },
    {
      // The sole capsule is laid out with u = 0 on the OUTSOLE (the ground face),
      // u = 0.25 / 0.75 on the two sidewalls and u = 0.5 on top; v = 0 at the heel
      // and 1 at the toe. Painting a "midsole stripe" across v put it on the toe;
      // it belongs on the sidewalls, running heel to toe.
      key: 'SOLE', u: 1, sig: (X) => `${X.shoe.sole}|${X.shoe.colour}`,
      colour: (c, w, h, X) => {
        const S = X.shoe.sole;
        fill(c, w, h, HEX(shade(S, -0.20)));
        // outsole: herringbone tread, wrapping the u seam
        c.save();
        for (const x0 of [-w, 0]) {
          c.save();
          c.beginPath(); c.rect(x0 + w * 0.85, 0, w * 0.30, h); c.clip();
          fill(c, w, h, HEX(shade(S, -0.32)));
          c.strokeStyle = rgba(shade(S, -0.70), 0.75); c.lineWidth = 3.2;
          for (let i = 0; i < 40; i++) {
            const y = (i / 40) * h;
            const dir = i % 2 ? 1 : -1;
            c.beginPath();
            c.moveTo(x0 + w * 0.85, y);
            c.lineTo(x0 + w * 1.00, y + dir * h * 0.012);
            c.lineTo(x0 + w * 1.15, y);
            c.stroke();
          }
          c.restore();
        }
        c.restore();
        // midsole foxing band on both sidewalls, in a lighter compound
        for (const u0 of [0.19, 0.69]) {
          c.fillStyle = HEX(shade(S, 0.42));
          c.fillRect(w * u0, 0, w * 0.12, h);
          c.fillStyle = rgba(shade(S, -0.35), 0.55);
          c.fillRect(w * u0, 0, w * 0.012, h);
          c.fillRect(w * (u0 + 0.108), 0, w * 0.012, h);
          stitchLine(c, w * (u0 + 0.06), 0, w * (u0 + 0.06), h, rgba(shade(S, 0.7), 0.4), 2, [5, 6]);
        }
        overlay(c, w, h, 0.22, 4);
        chips(c, w, h, 60, 'rgba(52,44,34,0.45)', 1, 4);      // ground-in grit
      },
      rough: (c, w, h) => {
        fill(c, w, h, '#c4c4c4');
        for (const x0 of [-w, 0]) { c.fillStyle = 'rgba(90,90,90,0.6)'; c.fillRect(x0 + w * 0.85, 0, w * 0.30, h); }
        overlay(c, w, h, 0.3, 5);
      },
      hsig: () => 'k',
      height: (c, w, h) => {
        fill(c, w, h, '#808080');
        for (const x0 of [-w, 0]) {
          c.save();
          c.beginPath(); c.rect(x0 + w * 0.85, 0, w * 0.30, h); c.clip();
          c.strokeStyle = '#e2e2e2'; c.lineWidth = 5;
          for (let i = 0; i < 40; i++) {
            const y = (i / 40) * h, dir = i % 2 ? 1 : -1;
            c.beginPath();
            c.moveTo(x0 + w * 0.85, y);
            c.lineTo(x0 + w * 1.00, y + dir * h * 0.012);
            c.lineTo(x0 + w * 1.15, y);
            c.stroke();
          }
          c.restore();
        }
        for (const u0 of [0.19, 0.69]) {
          c.fillStyle = '#b0b0b0'; c.fillRect(w * u0, 0, w * 0.12, h);
          c.fillStyle = '#585858'; c.fillRect(w * u0, 0, w * 0.010, h);
          c.fillRect(w * (u0 + 0.110), 0, w * 0.010, h);
        }
      },
    },
    // ---------------------------------------------------------------- gloves
    {
      // The fist is a merge of a dozen sweeps and capsules with their own UVs, so
      // a glove graphic pinned to one (u, v) would land somewhere arbitrary. This
      // is authored as a REPEATING padded-leather panel instead: quilted cells,
      // a seam grid and perforation, so wherever a finger or a knuckle samples it
      // it reads as a padded glove rather than a flat mitten.
      key: 'GLOVE', u: 1, sig: (X) => `${X.glove.colour}|${X.glove.on}|${X.top.trim}`,
      colour: (c, w, h, X) => {
        const col = X.glove.colour;
        fill(c, w, h, HEX(col));
        overlay(c, w, h, 0.24, 14, _weaveTile);
        // quilted padding cells with a stitched border
        const cols = 10, rows = 5;
        for (let i = 0; i < cols; i++) {
          for (let j = 0; j < rows; j++) {
            const x = (i / cols) * w, y = (j / rows) * h;
            const cw = w / cols, ch = h / rows;
            const g2 = c.createLinearGradient(x, y, x, y + ch);
            g2.addColorStop(0, rgba(shade(col, 0.26), 0.55));
            g2.addColorStop(0.55, rgba(shade(col, 0.05), 0.2));
            g2.addColorStop(1, rgba(shade(col, -0.45), 0.6));
            c.fillStyle = g2;
            c.beginPath();
            c.roundRect(x + cw * 0.07, y + ch * 0.10, cw * 0.86, ch * 0.80, Math.min(cw, ch) * 0.22);
            c.fill();
            c.strokeStyle = rgba(shade(col, -0.55), 0.55);
            c.lineWidth = 2;
            c.stroke();
          }
        }
        // seam runs and the wrist-strap band along the low-v edge
        c.save();
        c.strokeStyle = rgba(shade(col, 0.45), 0.45); c.lineWidth = 2; c.setLineDash([6, 7]);
        for (let i = 0; i <= cols; i++) {
          c.beginPath(); c.moveTo((i / cols) * w, 0); c.lineTo((i / cols) * w, h); c.stroke();
        }
        c.restore();
        c.fillStyle = rgba(separate(X.top.trim, col, 0.24), 0.92);
        c.fillRect(0, h * 0.86, w, h * 0.10);                 // closure strap
        c.fillStyle = rgba(shade(col, -0.55), 0.6);
        c.fillRect(0, h * 0.96, w, h * 0.020);
        // perforation on the palm side
        c.fillStyle = rgba(shade(col, -0.65), 0.5);
        for (let i = 0; i < 260; i++) {
          c.beginPath(); c.arc(rand(0, w), rand(h * 0.10, h * 0.80), rand(1.2, 2.4), 0, TAU); c.fill();
        }
        folds(c, w, h, 10, rgba(shade(col, -0.6), 0.35), 0.55);
      },
      rough: (c, w, h) => {
        fill(c, w, h, '#c8c8c8');                              // padded leather
        overlay(c, w, h, 0.35, 14, _weaveTile);
        smudges(c, w, h, 6, 'rgba(180,180,180,0.35)', 'rgba(80,80,80,0.35)');
      },
      hsig: () => 'k',
      height: (c, w, h) => {
        fill(c, w, h, '#808080');
        overlay(c, w, h, 0.55, 14, _weaveTile);
        const cols = 10, rows = 5;
        for (let i = 0; i < cols; i++) {
          for (let j = 0; j < rows; j++) {
            const x = (i / cols) * w, y = (j / rows) * h;
            const cw = w / cols, ch = h / rows;
            c.fillStyle = '#cccccc';
            c.beginPath();
            c.roundRect(x + cw * 0.07, y + ch * 0.10, cw * 0.86, ch * 0.80, Math.min(cw, ch) * 0.22);
            c.fill();
          }
        }
        c.fillStyle = '#c0c0c0'; c.fillRect(0, h * 0.86, w, h * 0.10);
      },
    },
    // ---------------------------------------------------------------- pads
    {
      key: 'PAD', u: 1, sig: (X) => `${X.pad.colour}|${X.top.trim}`,
      colour: (c, w, h, X) => {
        const col = X.pad.colour;
        fill(c, w, h, HEX(col));
        overlay(c, w, h, 0.30, 4);
        c.fillStyle = rgba(shade(col, 0.22), 0.6);
        for (let i = 0; i < 12; i++) {
          for (let j = 0; j < 4; j++) {
            c.beginPath();
            c.roundRect(w * (i / 12) + 4, h * (j / 4) + 4, w / 12 - 8, h / 4 - 8, 6);
            c.fill();
          }
        }
        c.fillStyle = rgba(X.top.trim, 0.85);
        c.fillRect(0, h * 0.86, w, h * 0.05);
        text(c, 'GRIT', w * 0.5, h * 0.5, h * 0.20, rgba(inkOn(col), 0.8), { spacing: 2 });
      },
      rough: (c, w, h) => { fill(c, w, h, '#c0c0c0'); overlay(c, w, h, 0.35, 5); },
      hsig: () => 'k',
      height: (c, w, h) => {
        fill(c, w, h, '#808080');
        c.fillStyle = '#d0d0d0';
        for (let i = 0; i < 12; i++) {
          for (let j = 0; j < 4; j++) {
            c.beginPath(); c.roundRect(w * (i / 12) + 4, h * (j / 4) + 4, w / 12 - 8, h / 4 - 8, 6); c.fill();
          }
        }
        overlay(c, w, h, 0.5, 6, _speck);
      },
    },
    // ---------------------------------------------------------------- cap / beanie
    {
      key: 'LID', u: 1, sig: (X) => `${X.lid.colour}|${X.lid.style}|${X.top.trim}`,
      colour: (c, w, h, X) => {
        const col = X.lid.colour;
        fill(c, w, h, HEX(col));
        overlay(c, w, h, 0.14, 3, _weaveTile);
        if (X.lid.style === 'beanie') {
          for (let i = 0; i < 60; i++) {                       // rib knit
            const x = (i / 60) * w;
            c.strokeStyle = rgba(shade(col, -0.35), 0.4); c.lineWidth = 3;
            c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke();
            c.strokeStyle = rgba(shade(col, 0.30), 0.25); c.lineWidth = 2;
            c.beginPath(); c.moveTo(x + w / 120, 0); c.lineTo(x + w / 120, h); c.stroke();
          }
          c.fillStyle = rgba(shade(col, -0.30), 0.6);
          c.fillRect(0, h * 0.72, w, h * 0.28);                // turn-up band
        } else {
          // six-panel cap: seams at every sixth of u, button at the crown (v = 1)
          for (let i = 0; i < 6; i++) {
            stitchLine(c, (i / 6) * w, 0, (i / 6) * w, h, rgba(shade(col, 0.4), 0.4), 2, [6, 6]);
          }
          c.fillStyle = rgba(shade(col, -0.40), 0.75);
          c.fillRect(0, h * 0.80, w, h * 0.20);                // brim underside
          const ink = separate(X.top.trim, col, 0.22);
          drawMark(c, w * 0.5, h * 0.42, h * 0.30,
            { mark: 'wordmark', text: 'VOLTA' }, ink, col);
        }
        folds(c, w, h, 6, rgba(shade(col, -0.55), 0.3), 0.5);
      },
      rough: (c, w, h) => { fill(c, w, h, '#f0f0f0'); overlay(c, w, h, 0.25, 4); },
      hsig: (X) => `${X.lid.style}`,
      height: (c, w, h, X) => {
        fill(c, w, h, '#808080');
        if (X.lid.style === 'beanie') {
          for (let i = 0; i < 60; i++) {
            c.fillStyle = i % 2 ? '#c8c8c8' : '#585858';
            c.fillRect((i / 60) * w, 0, w / 120, h);
          }
        } else {
          overlay(c, w, h, 0.5, 8, _weaveTile);
          for (let i = 0; i < 6; i++) stitchLine(c, (i / 6) * w, 0, (i / 6) * w, h, '#c8c8c8', 4, [6, 6]);
        }
      },
    },
  ];
}

function helmetRegions() {
  const sig = (X) => `${X.lid.colour}|${X.accent}`;
  // The shell is a 0.25 m object read at 900 px in the closeup. At u:2 the decal
  // band was 6–8 px per stripe and stair-stepped; u:4 gives 512 rows and, with
  // the shell UV running u = azimuth, ~2.8 px/mm across the graphics.
  return [
    {
      key: 'SHELL', u: 4, sig,
      colour: (c, w, h, X) => {
        const col = X.lid.colour;
        // The shell's own UV: u = azimuth (0 = dead ahead, 0.25 = the rider's
        // right flank, 0.5 = the back, 0.75 = the left flank) and g = 0 at the
        // crown → 1 at the lower edge. Region rows run the other way, so
        // `cy(g)` is the one place that conversion lives.
        const cy = (g) => (1 - g) * h;
        fill(c, w, h, HEX(col));
        const grad = c.createLinearGradient(0, h, 0, 0);
        grad.addColorStop(0, 'rgba(255,255,255,0.16)');        // crown catches light
        grad.addColorStop(0.55, 'rgba(255,255,255,0.02)');
        grad.addColorStop(1, 'rgba(0,0,0,0.34)');              // edge falls away
        c.fillStyle = grad; c.fillRect(0, 0, w, h);

        // ONE decal band, running continuously fore-and-aft over the crown, i.e.
        // a horizontal stripe in g. The old version painted vertical bars in u,
        // which cut the shell into 6–8 px blocks and mirrored on both flanks.
        const band = (g0, g1, css) => {
          c.fillStyle = css; c.fillRect(0, cy(g1), w, cy(g0) - cy(g1));
        };
        band(0.280, 0.400, HEX(X.accent));
        band(0.402, 0.424, HEX(shade(X.accent, -0.45)));
        band(0.432, 0.462, rgba(shade(col, 0.55), 0.85));
        band(0.845, 0.868, rgba(X.accent, 0.75));
        // a soft swoosh so the band is not a plain ring
        c.save();
        c.globalAlpha = 0.75;
        c.fillStyle = HEX(shade(X.accent, -0.25));
        c.beginPath();
        c.moveTo(0, cy(0.400));
        for (let i = 0; i <= 64; i++) {
          const u = i / 64;
          c.lineTo(u * w, cy(0.400 + 0.075 * (0.5 + 0.5 * Math.cos(u * TAU * 2))));
        }
        c.lineTo(w, cy(0.400)); c.closePath(); c.fill();
        c.restore();

        // Type. MEASURED off a render, not derived: the shell's swept UV runs u
        // toward the viewer's LEFT on both flanks, so anything laid out
        // left-to-right here comes out reversed on the helmet. Every mark is
        // therefore drawn through a mirror about its OWN centre — which keeps it
        // in place on the band while making it read forwards from either side.
        // (The band and the swoosh are symmetric in u and need no such thing.)
        const ink = inkOn(col);
        const printed = (fn, ux) => {
          c.save();
          c.translate(w * ux, 0); c.scale(-1, 1); c.translate(-w * ux, 0);
          fn(); c.restore();
        };
        for (const ux of [0.25, 0.75]) {
          printed(() => {
            text(c, 'GRIT', w * ux, cy(0.560), h * 0.130, HEX(ink),
              { skew: -0.2, spacing: h * 0.012, outline: rgba(X.accent, 0.9) });
            text(c, 'SHELL SERIES', w * ux, cy(0.470), h * 0.042, rgba(ink, 0.7),
              { font: '700', family: 'sans-serif', spacing: h * 0.010 });
          }, ux);
        }
        printed(() => text(c, 'VOLTA', w * 0.5, cy(0.560), h * 0.078, rgba(ink, 0.8),
          { skew: -0.16, spacing: h * 0.010 }), 0.5);

        scratches(c, w, h, 90, HEX(shade(col, 0.5)), 6, 50, 0.7);
        chips(c, w, h, 26, rgba(shade(col, 0.35), 0.5), 0.8, 2.4);
        overlay(c, w, h, 0.1, 3);
      },
      rough: (c, w, h) => {
        const cy = (g) => (1 - g) * h;
        fill(c, w, h, '#2e2e2e');                              // moulded gloss shell
        smudges(c, w, h, 8, 'rgba(150,150,150,0.45)', 'rgba(20,20,20,0.4)');
        c.fillStyle = 'rgba(120,120,120,0.55)';                // the decal band is matte vinyl
        c.fillRect(0, cy(0.462), w, cy(0.280) - cy(0.462));
        scratches(c, w, h, 70, '#8a8a8a', 6, 50, 0.8);
      },
      hsig: () => 'k',
      height: (c, w, h) => {
        const cy = (g) => (1 - g) * h;
        fill(c, w, h, '#808080');
        overlay(c, w, h, 0.25, 4);
        // the decal is a vinyl wrap: a real, if shallow, step at its edges
        c.fillStyle = '#8e8e8e'; c.fillRect(0, cy(0.462), w, cy(0.280) - cy(0.462));
      },
    },
    {
      key: 'VENT', u: 1, sig: () => 'k',
      colour: (c, w, h) => { fill(c, w, h, '#0a0b0d'); overlay(c, w, h, 0.2, 3); },
      rough: (c, w, h) => fill(c, w, h, '#a0a0a0'),
    },
    {
      key: 'STRAP', u: 1, sig: (X) => `${X.accent}`,
      colour: (c, w, h, X) => {
        fill(c, w, h, '#141519');
        for (let i = 0; i < w; i += 6) { c.fillStyle = rgba(X.accent, 0.35); c.fillRect(i, 0, 3, h); }
      },
      rough: (c, w, h) => fill(c, w, h, '#c8c8c8'),
      hsig: () => 'k',
      height: (c, w, h) => {
        fill(c, w, h, '#808080');
        for (let i = 0; i < w; i += 6) { c.fillStyle = '#c0c0c0'; c.fillRect(i, 0, 3, h); }
      },
    },
    {
      key: 'LINER', u: 1, sig: () => 'k',
      colour: (c, w, h) => { fill(c, w, h, '#26282d'); overlay(c, w, h, 0.4, 6, _speck); },
      rough: (c, w, h) => fill(c, w, h, '#dcdcdc'),
      hsig: () => 'k',
      height: (c, w, h) => { fill(c, w, h, '#808080'); overlay(c, w, h, 0.9, 8, _speck); },
    },
  ];
}

// ---------------------------------------------------------------------------
// profile → paint context
// ---------------------------------------------------------------------------

/**
 * Resolve one material spec from `materialPlan()` against the materials library.
 * Colours go through `materials.tint()` so an anodised frame, a chrome frame and a
 * gum tyre all inherit the library colourway's own roughness / metalness / env
 * response instead of a number invented here.
 */
// Mirrors materials.js COLOURWAYS so a rider built without the library (the creator
// preview, a unit test) still gets the right colour, roughness and env response.
const COLOURWAY_FALLBACK = {
  bike_chrome: { colour: 0xf2f4f8, roughness: 0.55, env: 1.50 },
  bike_raw: { colour: 0xc8ccd2, roughness: 0.95, env: 1.15 },
  bike_black: { colour: 0x2b2d33, roughness: 1.00, env: 1.00 },
  bike_red: { colour: 0x9e1f22, roughness: 0.85, env: 1.15 },
  bike_blue: { colour: 0x1d4f9c, roughness: 0.85, env: 1.15 },
  bike_purple: { colour: 0x5a2b8c, roughness: 0.85, env: 1.15 },
  bike_gold: { colour: 0xb98a25, roughness: 0.75, env: 1.25 },
  bike_teal: { colour: 0x1a8c86, roughness: 0.85, env: 1.15 },
  anodised: { colour: 0x9aa0a6, roughness: 0.85, env: 1.15 },
  rubber: { colour: 0x1a1b1e, roughness: 0.92, env: 0.8 },
  cloth: { colour: 0x141518, roughness: 0.95, env: 0.5 },
  plasticGloss: { colour: 0xd8d6cf, roughness: 0.45, env: 1.0 },
};

function resolveSpec(materials, spec, fallbackColour = 0x9aa0a6) {
  const name = spec && spec.name;
  const fb = COLOURWAY_FALLBACK[name] || null;
  const out = {
    colour: spec && spec.colour !== undefined ? spec.colour : (fb ? fb.colour : fallbackColour),
    roughness: spec && spec.roughness !== undefined ? spec.roughness : (fb ? fb.roughness : 0.6),
    metalness: 1,
    env: spec && spec.envMapIntensity !== undefined ? spec.envMapIntensity : (fb ? fb.env : 1),
    finish: 'anod',
  };
  if (name === 'bike_chrome') out.finish = 'chrome';
  else if (name === 'bike_raw') out.finish = 'raw';
  else if (name === 'cloth' || name === 'rubber') out.finish = 'matte';
  else if (name === 'plasticGloss') out.finish = 'gloss';
  if (!materials || !name || typeof materials.has !== 'function' || !materials.has(name)) return out;
  let m = null;
  try {
    m = spec.colour !== undefined
      ? materials.tint(name, spec.colour, {
        roughness: spec.roughness, envMapIntensity: spec.envMapIntensity,
        name: `rider_${name}_${(spec.colour >>> 0).toString(16)}`,
      })
      : materials.get(name);
  } catch (err) { m = null; }
  if (!m) return out;
  out.colour = m.color.getHex();
  out.roughness = clamp(m.roughness, 0.03, 1);
  out.metalness = m.metalness;
  out.env = m.envMapIntensity ?? 1;
  return out;
}

const TOP_SLEEVE = { tee: 0.45, raglan: 0.72, jersey: 0.95, hoodie: 1.0, tank: 0.0 };
const TOP_LOOSE = { tee: 0.50, raglan: 0.45, jersey: 0.30, hoodie: 0.78, tank: 0.40 };
const BOTTOM_LEN = { jeans: 1, shorts: 0.45, pants: 1, joggers: 0.95 };
const BOTTOM_LOOSE = { jeans: 0.60, shorts: 0.55, pants: 0.45, joggers: 0.35 };
const SHOE_BULK = { skate: 0.70, vulc: 0.45, hightop: 0.75, runner: 0.50, boot: 0.90 };
const SHOE_HIGH = { skate: 0, vulc: 0, hightop: 1, runner: 0, boot: 0.6 };

/** Everything the painters and the geometry builders read, in one flat object. */
function buildContext(profile, materials) {
  const P = normalizeProfile(profile);
  const M = riderMetrics(P);
  const plan = materialPlan(P);
  const B = plan.bike, R = plan.rider;

  const frame = resolveSpec(materials, B.frame, 0x2b2d33);
  const rim = resolveSpec(materials, B.rims, 0x2b2d33);
  const hw = resolveSpec(materials, B.hardware, 0xf2f4f8);
  const hw2 = B.hardwareSecondary ? resolveSpec(materials, B.hardwareSecondary, 0xf2f4f8) : hw;
  const peg = B.pegs ? resolveSpec(materials, B.pegs, 0xf2f4f8) : null;
  const tyre = resolveSpec(materials, B.tyres, 0x1a1b1e);
  const seat = resolveSpec(materials, B.seat, 0x141518);
  const grip = resolveSpec(materials, B.grips, 0x141518);

  const topOpt = optionFor('topStyle', P.top.style) || {};
  const botOpt = optionFor('bottomStyle', P.bottom.style) || {};
  const shoeOpt = optionFor('shoeStyle', P.shoes.style) || {};
  const hairOpt = optionFor('hairStyle', P.hair.style) || {};
  const beardOpt = optionFor('facialHairStyle', P.facialHair.style) || {};
  const lidOpt = optionFor('headwear', P.headwear) || {};

  const twoTone = P.top.style === 'raglan' || P.top.style === 'jersey';
  const trim = separate(P.top.accent, P.top.colour, 0.16);
  // Top and bottom must be readably DIFFERENT garments. At the shipped floor a
  // near-black tee over near-black jeans collapsed into one silhouette-shaped
  // mass with no waist, no hem and no readable top at all.
  const topBody = fabricAlbedo(P.top.colour, 0.235);
  const botCol = splitTone(fabricAlbedo(P.bottom.colour, 0.205), topBody, 0.13);
  // Even a one-colour tee gets a tonal split at the sleeve, the way a real
  // garment does where the sleeve panel catches light differently to the body.
  const sleeveCol = twoTone ? fabricAlbedo(trim, 0.235)
    : shade(topBody, lumOf(topBody) > 0.5 ? -0.13 : 0.15);

  return {
    P, M, plan,
    // --- bike --------------------------------------------------------------
    frame, rim, hw, hw2,
    peg: peg ? { ...peg } : null,
    pegCount: B.pegCount | 0,
    tyre: { colour: tyre.colour, wall: B.tyreWall, tread: B.tread, roughness: tyre.roughness, env: tyre.env },
    seat: { colour: seat.colour, print: B.seatPrint, roughness: seat.roughness },
    grip: grip.colour,
    decals: { id: B.decals.id, mark: B.decals.mark, text: B.decals.text, colour: separate(B.decals.colour, frame.colour, 0.18) },
    accent: separate(P.top.accent, frame.colour, 0.14),
    // ONE anodised hue for the whole machine (spacers, caps, plugs, tensioners),
    // dyed to a real anodised albedo so it reads as metal and not as an emitter.
    anod: anodise(mixc(separate(P.top.accent, frame.colour, 0.14),
      hw2.colour !== hw.colour ? hw2.colour : separate(P.top.accent, frame.colour, 0.14), 0.35), 0.21),
    // --- rider -------------------------------------------------------------
    skin: R.skin.colour,
    hair: { colour: P.hair.colour, style: P.hair.style, volume: hairOpt.volume ?? 0.4, long: hairOpt.long ?? 0 },
    beard: { colour: P.facialHair.colour, style: P.facialHair.style, coverage: beardOpt.coverage ?? 0 },
    eye: eyeColourFor(P.hair.colour),
    top: {
      style: P.top.style,
      body: topBody,
      sleeve: sleeveCol,
      trim: separate(fabricAlbedo(trim, 0.26), topBody, 0.20),
      sleeveLen: TOP_SLEEVE[P.top.style] ?? 0.45,
      loose: TOP_LOOSE[P.top.style] ?? 0.5,
      hood: P.top.style === 'hoodie',
      trimCuff: twoTone || P.top.style === 'hoodie',
      graphic: { mark: R.top.graphicMark, text: R.top.graphicText },
    },
    bottom: {
      style: P.bottom.style, colour: botCol,
      length: BOTTOM_LEN[P.bottom.style] ?? 1,
      loose: BOTTOM_LOOSE[P.bottom.style] ?? 0.5,
      cuffed: P.bottom.style === 'joggers',
    },
    shoe: {
      style: P.shoes.style, colour: fabricAlbedo(P.shoes.colour, 0.185), laces: P.shoes.laces,
      // the sole is ALWAYS a separate material from the upper — rubber against
      // canvas or suede is half of what makes a shoe read as a shoe
      sole: P.shoes.style === 'vulc' || P.shoes.style === 'skate' ? 0xb98a52
        : P.shoes.style === 'boot' ? 0x4a423a : 0xdedbd2,
      bulk: SHOE_BULK[P.shoes.style] ?? 0.6,
      high: SHOE_HIGH[P.shoes.style] ?? 0,
    },
    glove: { on: !!P.gloves.on, colour: fabricAlbedo(P.gloves.colour, 0.195) },
    pad: { ...P.pads, colour: 0x3a3e46 },
    lid: {
      style: P.headwear, colour: fabricAlbedo(P.headwearColour, 0.26),
      covers: lidOpt.covers ?? 0, helmet: P.headwear === 'helmet',
    },
  };
}

// ---------------------------------------------------------------------------
// bike: wheels
// ---------------------------------------------------------------------------

/** Circle point in wheel space: spin axis is +X. */
function wheelPt(x, r, a) { return V(x, r * Math.cos(a), r * Math.sin(a)); }

function latheX(profile, segments) {
  const geo = new THREE.LatheGeometry(profile.map(([r, x]) => new THREE.Vector2(r, x)), segments);
  geo.rotateZ(-Math.PI / 2);
  return geo;
}

function buildWheelCore(isRear, AH) {
  const hw = [];

  // --- rim: double-wall box section with bead seats and a brake track ---------
  const rimProfile = [
    [G.rimInner, -0.0128], [G.rimInner + 0.006, -0.0132], [0.2085, -0.0132],
    [G.rimOuter, -0.0112], [G.rimOuter, -0.0062], [0.2072, -0.0034],
    [0.2072, 0.0034], [G.rimOuter, 0.0062], [G.rimOuter, 0.0112],
    [0.2085, 0.0132], [G.rimInner + 0.006, 0.0132], [G.rimInner, 0.0128],
  ];
  hw.push(AH.uv(latheX(rimProfile, 36), 'RIM'));

  // --- hub: shell, flanges, cones, axle --------------------------------------
  hw.push(AH.patch(latheX([
    [0.0000, -0.052], [0.0090, -0.052], [0.0125, -0.046], [0.0150, -0.032],
    [0.0170, -0.030], [0.0170, 0.030], [0.0150, 0.032], [0.0125, 0.046],
    [0.0090, 0.052], [0.0000, 0.052],
  ], 20), 'ALLOY', 0.05, 0.45));
  for (const s of [-1, 1]) {
    const fl = latheX([
      [G.hubR, s * 0.0235], [G.flangeR - 0.003, s * 0.0245], [G.flangeR, s * 0.0262],
      [G.flangeR, s * (0.0262 + 0.0042)], [G.flangeR - 0.004, s * 0.0308], [G.hubR, s * 0.0300],
    ], 20);
    hw.push(AH.patch(fl, 'ALLOY', 0.05, 0.45));
  }
  hw.push(AH.patch(rod(V(-0.085, 0, 0), V(0.085, 0, 0), 0.0072), 'CHROME'));
  for (const s of [-1, 1]) {
    const nut = new THREE.CylinderGeometry(0.0125, 0.0125, 0.009, 6);
    nut.rotateZ(Math.PI / 2); nut.translate(s * 0.0665, 0, 0);
    hw.push(AH.patch(nut, 'ACCENT'));
  }

  // --- 36 spokes, three-cross, plus brass nipples and rim eyelets --------------
  // Spokes are the noisiest thing in the frame if they are thin mirrors: a 1.0 mm
  // chrome cylinder is sub-pixel at gameplay distance and every frame it lands on
  // a different set of specular samples, which is what read as white speckle.
  // They are now 1.35 mm, satin stainless (their OWN atlas region), and laced
  // 3-cross with alternating flange sides so the pattern is legible.
  const rimHole = 0.1955, crossA = G.cross * 2 * (TAU / G.spokes);
  const nipples = [], eyelets = [], flangeHoles = [];
  for (let s = 0; s < 2; s++) {
    const sx = s ? 1 : -1;
    for (let i = 0; i < G.spokes / 2; i++) {
      const hubA = (i / (G.spokes / 2)) * TAU + s * (TAU / G.spokes);
      const dir = i % 2 === 0 ? 1 : -1;
      const rimA = hubA + dir * crossA;
      const a = wheelPt(sx * (G.flangeX + 0.0018), G.flangeR - 0.0035, hubA);
      const b = wheelPt(sx * 0.0062, rimHole, rimA);
      hw.push(AH.patch(rod(a, b, 0.00135, 0.00125, 6, false), 'SPOKE', 0.2, 0.8));
      const nb = wheelPt(sx * 0.0062, rimHole - 0.0075, rimA);
      nipples.push(rod(b, nb, 0.0030, 0.0024, 6, true));
      // eyelet: a ferrule sitting in the rim bed, so the spoke enters something
      const eA = wheelPt(sx * 0.0062, rimHole + 0.0016, rimA);
      const eB = wheelPt(sx * 0.0062, rimHole - 0.0016, rimA);
      eyelets.push(rod(eA, eB, 0.0040, 0.0040, 6, true));
      // drilled flange hole
      const hA = wheelPt(sx * (G.flangeX - 0.0020), G.flangeR - 0.0035, hubA);
      const hB = wheelPt(sx * (G.flangeX + 0.0026), G.flangeR - 0.0035, hubA);
      flangeHoles.push(rod(hA, hB, 0.0022, 0.0022, 6, true));
    }
  }
  hw.push(AH.patch(merge(nipples), 'BRASS'));
  hw.push(AH.patch(merge(eyelets), 'BRASS'));
  hw.push(AH.patch(merge(flangeHoles), 'STEEL'));

  // --- valve stem -------------------------------------------------------------
  const va = 0.6;
  hw.push(AH.patch(rod(wheelPt(0.0, 0.196, va), wheelPt(0.0, 0.223, va), 0.0035, 0.0032, 6), 'BRASS'));
  const cap = new THREE.CylinderGeometry(0.0042, 0.0042, 0.010, 8);
  place(cap, wheelPt(0, 0.221, va), wheelPt(0, 0.234, va));
  hw.push(AH.patch(cap, 'ANOD'));

  // --- driver + cog (rear only) ----------------------------------------------
  if (isRear) {
    const driver = latheX([[0.014, 0.030], [0.026, 0.032], [0.028, 0.036], [0.028, 0.052], [0.014, 0.054]], 18);
    hw.push(AH.patch(driver, 'STEEL'));
    const { shape } = sprocketShape(G.cogTeeth, G.pitch, 0, 0);
    const cog = plate(shape, 0.0042, 0.0006, 3);
    cog.rotateY(Math.PI / 2);
    cog.translate(G.chainLine, 0, 0);
    hw.push(AH.patch(cog, 'OILY', 0.05, 0.95));
  }

  return merge(hw);
}

/** The tyre alone: casing plus tread blocks, rebuilt when the tread style changes. */
// the bead sits just proud of the rim's outer wall so the rim colour reads
const TYRE_PROFILE = [
  [0.2140, -0.0110], [0.2215, -0.0225], [0.2360, -0.0288], [0.2505, -0.0268],
  [0.2578, -0.0160], [0.2600, 0.0000], [0.2578, 0.0160], [0.2505, 0.0268],
  [0.2360, 0.0288], [0.2215, 0.0225], [0.2140, 0.0110],
];

/**
 * Sample the casing at profile coordinate v (0..1, index-parameterised exactly as
 * LatheGeometry writes its own v) and azimuth `a`, returning the point and the
 * true outward surface normal. Real block placement needs the normal, not a
 * radial approximation: a shoulder lug leans outward AND sideways.
 */
function tyreSurface(v, a) {
  const n = TYRE_PROFILE.length - 1;
  const f = clamp(v, 0, 1) * n;
  const i = Math.min(n - 1, Math.floor(f));
  const t = f - i;
  const r = lerp(TYRE_PROFILE[i][0], TYRE_PROFILE[i + 1][0], t);
  const x = lerp(TYRE_PROFILE[i][1], TYRE_PROFILE[i + 1][1], t);
  // profile tangent (dx along the axle, dr radial) → normal = (-dr, dx), outward
  let dx = TYRE_PROFILE[i + 1][1] - TYRE_PROFILE[i][1];
  let dr = TYRE_PROFILE[i + 1][0] - TYRE_PROFILE[i][0];
  const L = Math.hypot(dx, dr) || 1;
  dx /= L; dr /= L;
  let nAx = -dr, nRad = dx;
  if (nRad < 0) { nAx = -nAx; nRad = -nRad; }
  const ca = Math.cos(a), sa = Math.sin(a);
  return {
    p: V(x, r * ca, r * sa),
    n: V(nAx, nRad * ca, nRad * sa).normalize(),
  };
}

/**
 * Real tread geometry. Each block is a drafted prism lofted off the casing, so it
 * holds a silhouette against the sky at the top of the wheel — a normal map alone
 * leaves the tyre a perfectly smooth torus, which is exactly the note we got.
 */
function buildTreadGeometry(tread) {
  const pos = [], uvs = [];
  const draft = 0.16;                                    // top face inset (mould draft)
  // LatheGeometry writes u = phi/TAU with vertex (r sinφ, axial, r cosφ); latheX
  // then rotates it onto the +X spin axis, which puts wheel azimuth a = phi + π/2.
  // Blocks are placed through the SAME relation, so a block lands exactly on the
  // block that was painted for it.
  const corner = (u, v, lift) => {
    const s = tyreSurface(v, u * TAU + Math.PI / 2);
    return s.p.addScaledVector(s.n, lift);
  };
  // flat-shaded: every face gets its own vertices, so a block keeps crisp edges
  // instead of averaging into a soft bump
  const tri = (a, b, c, ua, ub, uc) => {
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    uvs.push(ua[0], ua[1], ub[0], ub[1], uc[0], uc[1]);
  };
  const quad = (p, uv) => {
    tri(p[0], p[1], p[2], uv[0], uv[1], uv[2]);
    tri(p[0], p[2], p[3], uv[0], uv[2], uv[3]);
  };
  for (const b of treadPattern(tread)) {
    const u0 = (b.i + b.uo) / TREAD_N, u1 = (b.i + b.uo + b.du) / TREAD_N;
    const du = (u1 - u0) * draft, dv = (b.v1 - b.v0) * draft;
    const baseUV = [[u0, b.v0], [u1, b.v0], [u1, b.v1], [u0, b.v1]];
    const topUV = [[u0 + du, b.v0 + dv], [u1 - du, b.v0 + dv],
      [u1 - du, b.v1 - dv], [u0 + du, b.v1 - dv]];
    // the block sinks slightly INTO the casing so no crack shows at its foot
    const B = baseUV.map(([u, v]) => corner(u, v, -0.0006));
    const T = topUV.map(([u, v]) => corner(u, v, b.rise));
    quad(T, topUV);
    for (let k = 0; k < 4; k++) {
      const j = (k + 1) % 4;
      quad([B[k], B[j], T[j], T[k]], [baseUV[k], baseUV[j], topUV[j], topUV[k]]);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  return normalise(geo);
}

function buildTyre(tread, AR) {
  const rub = [];
  rub.push(AR.uv(latheX(TYRE_PROFILE, 48), 'TYRE'));
  // The blocks carry the SAME uv as the casing beneath them, so a block is painted
  // with the block that was painted for it — no separate patch, no mip drift.
  rub.push(AR.uv(buildTreadGeometry(tread), 'TYRE'));
  return merge(rub);
}

// ---------------------------------------------------------------------------
// bike: frame, fork, bars, seat, drivetrain, pegs
// ---------------------------------------------------------------------------

function pegGeometry(sideSign, at) {
  const peg = latheX([
    [0.0, 0], [G.pegR - 0.004, 0], [G.pegR, 0.006], [G.pegR, G.pegLen - 0.008],
    [G.pegR - 0.003, G.pegLen], [0.0, G.pegLen],
  ], 18);
  peg.rotateZ(sideSign > 0 ? 0 : Math.PI);
  peg.translate(at.x, at.y, at.z);
  return peg;
}

/** Rear + front peg sets. `count`: 0 none, 2 rear only, 4 both ends. */
function buildPegs(count, AH) {
  const out = { rear: null, front: null };
  if (!count) return out;
  const rear = [], front = [];
  for (const s of [-1, 1]) {
    rear.push(pegGeometry(s, V(s * 0.062, G.tyreR, PT.rearAxle.z)));
    if (count >= 4) {
      front.push(pegGeometry(s, V(s * 0.062, PT.frontAxle.y, PT.frontAxle.z)));
      const nut = new THREE.CylinderGeometry(0.0125, 0.0125, 0.009, 6);
      nut.rotateZ(Math.PI / 2);
      nut.translate(s * (0.062 + G.pegLen + 0.005), PT.frontAxle.y, PT.frontAxle.z);
      front.push(AH.patch(nut, 'ACCENT'));
    }
  }
  out.rear = merge(rear.map((g) => AH.uv(g, 'PEG')));
  if (front.length) out.front = merge(front.map((g, i) => (i % 2 === 0 ? AH.uv(g, 'PEG') : g)));
  return out;
}

function buildFrame(AP, AH, AR) {
  const paint = [], hw = [], rub = [];
  const { bb, stTop, htBottom, htTop, axisUp, axisFwd, rearAxle } = PT;
  const dropZ = rearAxle.z + 0.006;

  // down tube — ovalised at the bottom bracket, round at the head tube
  const dtA = bb.clone().add(V(0, 0.016, 0.026));
  const dtC = htBottom.clone().addScaledVector(axisUp, 0.028).addScaledVector(axisFwd, -0.004);
  const dtM = dtA.clone().lerp(dtC, 0.5).add(V(0, -0.012, 0));
  paint.push(AP.uv(sweep([dtA, dtM, dtC], {
    radius: 0.0215, radial: 10, steps: 18,
    taper: (t) => lerp(1.0, 0.88, smoothstep(t)),
    oval: (t) => [lerp(1.24, 1.0, smoothstep(clamp(t * 2.2, 0, 1))), lerp(0.82, 1.0, smoothstep(clamp(t * 2.2, 0, 1)))],
  }), 'DECAL'));

  // top tube
  const ttA = stTop.clone().add(V(0, -0.020, 0.004));
  const ttB = htTop.clone().addScaledVector(axisUp, -0.026).addScaledVector(axisFwd, -0.006);
  paint.push(AP.uv(sweep([ttA, ttA.clone().lerp(ttB, 0.5).add(V(0, 0.004, 0)), ttB], {
    radius: 0.0158, radial: 10, steps: 16,
  }), 'SCRIPT'));

  // seat tube + head tube
  paint.push(AP.uv(sweep([bb.clone().add(V(0, 0.014, -0.006)), bb.clone().lerp(stTop, 0.55), stTop], {
    radius: 0.0168, radial: 10, steps: 12, taper: (t) => lerp(1.06, 0.96, t),
  }), 'MAIN'));
  paint.push(AP.uv(sweep([
    htBottom.clone().addScaledVector(axisUp, -0.004),
    htBottom.clone().lerp(htTop, 0.5),
    htTop.clone().addScaledVector(axisUp, 0.004),
  ], { radius: 0.0248, radial: 12, steps: 6, taper: (t) => 1 + 0.06 * (Math.abs(t - 0.5) > 0.35 ? 1 : 0) }), 'MAIN'));

  // chainstays and seatstays — bowed out for tyre clearance
  for (const s of [-1, 1]) {
    const csA = bb.clone().add(V(s * 0.030, -0.004, -0.014));
    const csM = V(s * 0.079, 0.288, -0.330);
    const csB = V(s * 0.056, 0.264, dropZ + 0.010);
    paint.push(AP.uv(sweep([csA, csM, csB], {
      radius: 0.0145, radial: 8, steps: 16, taper: (t) => lerp(1.05, 0.72, smoothstep(t)),
      oval: (t) => [lerp(1.0, 0.75, smoothstep(t)), lerp(1.0, 1.25, smoothstep(t))],
    }), 'MAIN'));

    const ssA = stTop.clone().add(V(s * 0.019, -0.030, -0.004));
    const ssM = V(s * 0.052, 0.412, -0.352);
    const ssB = V(s * 0.056, 0.268, dropZ + 0.012);
    paint.push(AP.uv(sweep([ssA, ssM, ssB], {
      radius: 0.0118, radial: 8, steps: 16, taper: (t) => lerp(1.0, 0.68, smoothstep(t)),
    }), 'MAIN'));

    // dropout plates with a real slot
    const dshape = new THREE.Shape();
    dshape.moveTo(-0.030, -0.020); dshape.lineTo(0.040, -0.020);
    dshape.lineTo(0.046, 0.006); dshape.lineTo(0.014, 0.028);
    dshape.lineTo(-0.030, 0.028); dshape.closePath();
    const slot = new THREE.Path();
    slot.moveTo(0.040, -0.0085); slot.absarc(0.012, 0, 0.0085, -Math.PI / 2, Math.PI / 2, false);
    slot.lineTo(0.040, 0.0085); slot.lineTo(0.040, -0.0085);
    dshape.holes.push(slot);
    const dp = plate(dshape, 0.0085, 0.0007, 4);
    dp.rotateY(Math.PI / 2);
    dp.translate(s * 0.056, G.tyreR, rearAxle.z);
    paint.push(AP.uv(dp, 'DARK'));

    // chain tensioner
    const ten = new THREE.BoxGeometry(0.012, 0.016, 0.030);
    ten.translate(s * 0.066, G.tyreR + 0.001, rearAxle.z - 0.030);
    hw.push(AH.patch(ten, 'ANOD'));
    const tb = new THREE.CylinderGeometry(0.0035, 0.0035, 0.030, 6);
    tb.rotateX(Math.PI / 2);
    tb.translate(s * 0.066, G.tyreR + 0.001, rearAxle.z - 0.048);
    hw.push(AH.patch(tb, 'CHROME'));
  }

  // bottom bracket shell
  const bbShell = latheX([[0.0, -0.038], [0.020, -0.038], [0.0235, -0.034], [0.0235, 0.034], [0.020, 0.038], [0.0, 0.038]], 18);
  bbShell.translate(bb.x, bb.y, bb.z);
  paint.push(AP.uv(bbShell, 'MAIN'));

  // gussets: head tube / down tube and down tube / bottom bracket
  const gShape = new THREE.Shape();
  gShape.moveTo(0, 0); gShape.lineTo(0.085, 0); gShape.quadraticCurveTo(0.052, 0.020, 0.020, 0.062);
  gShape.lineTo(0, 0.062); gShape.closePath();
  const gus = plate(gShape, 0.0055, 0.0008, 5);
  gus.rotateY(Math.PI / 2);
  const gDir = dtC.clone().sub(dtA).normalize();
  _q.setFromUnitVectors(V(0, 1, 0), axisUp);
  gus.applyQuaternion(_q);
  gus.translate(0, htBottom.y + 0.010, htBottom.z - 0.026);
  paint.push(AP.uv(gus, 'DARK'));

  const gShape2 = new THREE.Shape();
  gShape2.moveTo(0, 0); gShape2.lineTo(0.060, 0); gShape2.quadraticCurveTo(0.030, 0.014, 0.006, 0.042);
  gShape2.lineTo(0, 0.042); gShape2.closePath();
  const gus2 = plate(gShape2, 0.005, 0.0008, 5);
  gus2.rotateY(Math.PI / 2);
  gus2.rotateX(-0.42);
  gus2.translate(0, bb.y + 0.020, bb.z + 0.020);
  paint.push(AP.uv(gus2, 'DARK'));

  // weld beads — the detail that sells a welded frame
  const beads = [
    [dtA.clone().add(V(0, 0.004, 0.006)), gDir, 0.0235],
    [dtC.clone().addScaledVector(gDir, -0.010), gDir, 0.0200],
    [ttA.clone().add(V(0, 0, 0.008)), ttB.clone().sub(ttA).normalize(), 0.0172],
    [ttB.clone().addScaledVector(ttB.clone().sub(ttA).normalize(), -0.012), ttB.clone().sub(ttA).normalize(), 0.0172],
    [bb.clone().addScaledVector(PT.stDir, 0.020), PT.stDir, 0.0184],
    [stTop.clone().addScaledVector(PT.stDir, -0.030), PT.stDir, 0.0176],
    [htBottom.clone().addScaledVector(axisUp, 0.006), axisUp, 0.0262],
    [htTop.clone().addScaledVector(axisUp, -0.006), axisUp, 0.0262],
  ];
  for (const [p, ax, r] of beads) paint.push(AP.uv(weld(p, ax, r), 'MAIN'));
  for (const s of [-1, 1]) {
    const csDir = V(s * 0.5, -0.12, -0.86).normalize();
    paint.push(AP.uv(weld(bb.clone().add(V(s * 0.032, -0.004, -0.016)), csDir, 0.0158), 'MAIN'));
    const ssDir = V(s * 0.16, -0.62, -0.77).normalize();
    paint.push(AP.uv(weld(stTop.clone().add(V(s * 0.019, -0.032, -0.006)), ssDir, 0.0130), 'MAIN'));
  }

  // rear u-brake: arms, pads, straddle cable
  for (const s of [-1, 1]) {
    const armShape = new THREE.Shape();
    armShape.moveTo(0, 0); armShape.lineTo(0.012, 0.004); armShape.lineTo(0.030, 0.062);
    armShape.lineTo(0.018, 0.068); armShape.lineTo(0.001, 0.014); armShape.closePath();
    const arm = plate(armShape, 0.006, 0.0006, 3);
    arm.rotateY(Math.PI / 2);
    arm.rotateX(s > 0 ? 0.10 : -0.10);
    arm.translate(s * 0.050, 0.404, -0.352);
    hw.push(AH.patch(arm, 'ANOD'));
    const pad = new THREE.CylinderGeometry(0.0075, 0.0075, 0.014, 10);
    pad.rotateZ(Math.PI / 2);
    pad.translate(s * 0.038, 0.398, -0.348);
    rub.push(AR.patch(pad, 'CABLE'));
  }
  rub.push(AR.patch(rod(V(-0.062, 0.466, -0.298), V(0, 0.446, -0.292), 0.0016), 'CABLE'));
  rub.push(AR.patch(rod(V(0.062, 0.466, -0.298), V(0, 0.446, -0.292), 0.0016), 'CABLE'));

  // gyro lower cables: head tube down the top tube to the brake
  const gyroBase = htTop.clone().addScaledVector(axisUp, 0.030);
  for (const s of [-1, 1]) {
    rub.push(AR.uv(sweep([
      gyroBase.clone().add(V(s * 0.016, 0.006, -0.004)),
      ttA.clone().lerp(ttB, 0.62).add(V(s * 0.012, 0.020, 0)),
      ttA.clone().lerp(ttB, 0.18).add(V(s * 0.010, 0.020, 0)),
      V(s * 0.030, 0.500, -0.300),
      V(s * 0.055, 0.462, -0.300),
    ], { radius: 0.0026, radial: 5, steps: 22 }), 'CABLE'));
  }

  return { paint: merge(paint), hardware: merge(hw), rubber: merge(rub) };
}

function buildFork(AP, AH) {
  const paint = [], hw = [];
  const { htBottom, htTop, axisUp, frontAxle } = PT;
  const crown = htBottom.clone().addScaledVector(axisUp, -0.030);

  // steerer tube through the head tube
  hw.push(AH.patch(rod(crown.clone().addScaledVector(axisUp, 0.010),
    htTop.clone().addScaledVector(axisUp, 0.086), 0.0143), 'CHROME'));

  // crown
  const crownGeo = latheX([
    [0.0, -0.052], [0.026, -0.052], [0.030, -0.044], [0.030, 0.044], [0.026, 0.052], [0.0, 0.052],
  ], 16);
  crownGeo.translate(crown.x, crown.y, crown.z);
  paint.push(AP.uv(crownGeo, 'MAIN'));
  paint.push(AP.uv(weld(crown, axisUp, 0.031), 'MAIN'));

  for (const s of [-1, 1]) {
    // 32 mm offset, and the leg BOWS to get it: a fork whose legs run dead
    // straight from crown to axle reads as two pieces of tube, which is the note.
    const a = crown.clone().add(V(s * 0.040, 0.006, 0));
    const m = crown.clone().lerp(frontAxle, 0.52).add(V(s * 0.053, 0.004, 0.019));
    const b = V(s * 0.056, frontAxle.y + 0.006, frontAxle.z + 0.004);
    paint.push(AP.uv(sweep([a, m, b], {
      radius: 0.0188, radial: 10, steps: 20, tension: 0.42,
      taper: (t) => lerp(1.0, 0.60, smoothstep(t)),
      oval: (t) => [lerp(0.92, 0.74, t), lerp(1.06, 1.26, t)],
    }), 'MAIN'));
    // weld bead where the leg meets the crown
    paint.push(AP.uv(weld(a.clone().addScaledVector(m.clone().sub(a).normalize(), 0.008),
      m.clone().sub(a).normalize(), 0.0192), 'MAIN'));

    // dropout: a forged slotted plate with a real chamfer around its edge
    const dshape = new THREE.Shape();
    dshape.moveTo(-0.034, 0.040); dshape.lineTo(0.030, 0.040);
    dshape.quadraticCurveTo(0.036, 0.012, 0.032, -0.008);
    dshape.lineTo(0.002, -0.032);
    dshape.quadraticCurveTo(-0.018, -0.036, -0.034, -0.026);
    dshape.closePath();
    const slot = new THREE.Path();
    slot.moveTo(-0.0088, -0.032); slot.absarc(0, 0, 0.0088, -Math.PI / 2, Math.PI / 2, true);
    slot.lineTo(0.0088, -0.032); slot.lineTo(-0.0088, -0.032);
    dshape.holes.push(slot);
    const dp = plate(dshape, 0.0100, 0.0020, 6);
    dp.rotateY(Math.PI / 2);
    dp.translate(s * 0.056, frontAxle.y, frontAxle.z);
    paint.push(AP.uv(dp, 'DARK'));
    // axle nut so the dropout terminates in something
    const nut = new THREE.CylinderGeometry(0.0135, 0.0135, 0.010, 6);
    nut.rotateZ(Math.PI / 2);
    nut.translate(s * 0.0645, frontAxle.y, frontAxle.z);
    hw.push(AH.patch(nut, 'ACCENT'));
  }

  // headset cups, spacers, gyro lower plate
  const cupLo = latheX([[0.0148, -0.012], [0.0290, -0.012], [0.0300, -0.004], [0.0250, 0.006], [0.0148, 0.006]], 18);
  _q.setFromUnitVectors(V(1, 0, 0), axisUp);
  cupLo.applyQuaternion(_q); cupLo.translate(htBottom.x, htBottom.y, htBottom.z);
  hw.push(AH.patch(cupLo, 'ACCENT'));

  const cupHi = latheX([[0.0148, -0.006], [0.0250, -0.006], [0.0300, 0.004], [0.0290, 0.014], [0.0148, 0.014]], 18);
  cupHi.applyQuaternion(_q); cupHi.translate(htTop.x, htTop.y, htTop.z);
  hw.push(AH.patch(cupHi, 'ACCENT'));

  const gyroLo = latheX([[0.0150, 0], [0.0300, 0], [0.0300, 0.007], [0.0150, 0.007]], 20);
  gyroLo.applyQuaternion(_q);
  const gp = htTop.clone().addScaledVector(axisUp, 0.020);
  gyroLo.translate(gp.x, gp.y, gp.z);
  hw.push(AH.patch(gyroLo, 'ANOD'));

  return { paint: merge(paint), hardware: merge(hw) };
}

function buildBars(AH, AR) {
  const hw = [], rub = [];
  const { htTop, axisUp, axisFwd } = PT;
  const stemBase = htTop.clone().addScaledVector(axisUp, 0.046);
  const barCentre = stemBase.clone().addScaledVector(axisFwd, 0.050).addScaledVector(axisUp, 0.004);

  // bar: one continuous sweep from grip to grip, with the crossbar added after.
  // 750 mm grip-to-grip x 240 mm rise — a modern park bar. The old 660 x 228 read
  // as barely wider than the rider's shoulders and made the cockpit look toy-like.
  const half = [
    [0.000, 0.000, 0.000], [0.056, 0.005, 0.000], [0.094, 0.068, -0.011],
    [0.115, 0.162, -0.030], [0.148, 0.222, -0.047], [0.208, 0.236, -0.060],
    [0.296, 0.240, -0.071], [0.375, 0.242, -0.079],
  ];
  // one place that owns where a grip starts and ends along the bar
  const GRIP_A = V(0.222, 0.2366, -0.0618), GRIP_B = V(0.378, 0.2420, -0.0793);
  const pts = [];
  for (let i = half.length - 1; i >= 1; i--) pts.push(barCentre.clone().add(V(-half[i][0], half[i][1], half[i][2])));
  pts.push(barCentre.clone());
  for (let i = 1; i < half.length; i++) pts.push(barCentre.clone().add(V(half[i][0], half[i][1], half[i][2])));
  hw.push(AH.uv(sweep(pts, { radius: 0.0143, radial: 8, steps: 40, tension: 0.42 }), 'CHROME'));

  // crossbar
  const cbY = 0.162, cbA = [], cbB = [];
  for (const s of [-1, 1]) {
    cbA.push(barCentre.clone().add(V(s * 0.115, cbY, -0.030)));
    cbB.push(barCentre.clone().add(V(s * 0.078, cbY + 0.030, -0.022)));
  }
  hw.push(AH.uv(sweep([cbA[0], cbB[0], cbB[1], cbA[1]], { radius: 0.0105, radial: 8, steps: 14, tension: 0.3 }), 'CHROME'));

  // stem: body, faceplate, six bolts
  const fwd = axisFwd.clone(), up = axisUp.clone();
  const side = new THREE.Vector3().crossVectors(fwd, up).normalize();
  const basis = new THREE.Matrix4().makeBasis(fwd, up, side);
  const body = plate(roundedRectShape(0.088, 0.046, 0.010), 0.044, 0.0012, 4);
  body.applyMatrix4(basis);
  body.translate((stemBase.x + barCentre.x) / 2, (stemBase.y + barCentre.y) / 2, (stemBase.z + barCentre.z) / 2);
  hw.push(AH.uv(body, 'ANOD'));

  const clampRing = latheX([[0.0148, -0.024], [0.0230, -0.024], [0.0230, 0.024], [0.0148, 0.024]], 14);
  _q.setFromUnitVectors(V(1, 0, 0), axisUp);
  clampRing.applyQuaternion(_q);
  clampRing.translate(stemBase.x, stemBase.y, stemBase.z);
  hw.push(AH.patch(clampRing, 'ANOD'));

  // Faceplate: a milled block whose face actually points FORWARD (the old one was
  // a slab 50 mm deep and 14 mm across, so its face pointed sideways and the four
  // clamp bolts sat outside it), with real relief cuts across the face.
  const faceBasis = new THREE.Matrix4().makeBasis(side, up, fwd);
  const face = plate(roundedRectShape(0.052, 0.056, 0.009), 0.013, 0.001, 4);
  face.applyMatrix4(faceBasis);
  face.translate(barCentre.x + fwd.x * 0.019, barCentre.y + fwd.y * 0.019, barCentre.z + fwd.z * 0.019);
  hw.push(AH.uv(face, 'MACHINED'));
  for (let i = -1; i <= 1; i++) {
    const groove = plate(roundedRectShape(0.0060, 0.030, 0.0025), 0.0045, 0.0004, 3);
    groove.applyMatrix4(faceBasis);
    const o = barCentre.clone()
      .addScaledVector(fwd, 0.0250)
      .addScaledVector(side, i * 0.0100);
    groove.translate(o.x, o.y, o.z);
    hw.push(AH.patch(groove, 'MACHINED'));
  }

  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const bolt = new THREE.CylinderGeometry(0.0042, 0.0042, 0.020, 6);
      const o = barCentre.clone()
        .addScaledVector(fwd, 0.028)
        .addScaledVector(up, sy * 0.018)
        .addScaledVector(side, sx * 0.018);
      place(bolt, o, o.clone().addScaledVector(fwd, -0.02));
      hw.push(AH.patch(bolt, 'CHROME'));
    }
    const sbolt = new THREE.CylinderGeometry(0.0038, 0.0038, 0.028, 6);
    const o = stemBase.clone().addScaledVector(fwd, -0.026).addScaledVector(up, sx * 0.013);
    place(sbolt, o, o.clone().addScaledVector(side, 0.028));
    hw.push(AH.patch(sbolt, 'CHROME'));
  }

  // top cap
  const cap = latheX([[0, 0], [0.017, 0], [0.017, 0.006], [0.010, 0.010], [0, 0.010]], 16);
  cap.applyQuaternion(_q);
  const capP = stemBase.clone().addScaledVector(axisUp, 0.026);
  cap.translate(capP.x, capP.y, capP.z);
  hw.push(AH.patch(cap, 'ACCENT'));

  // gyro upper plate + upper cable
  const gyroHi = latheX([[0.0150, 0], [0.0285, 0], [0.0285, 0.006], [0.0150, 0.006]], 20);
  gyroHi.applyQuaternion(_q);
  const ghp = htTop.clone().addScaledVector(axisUp, 0.029);
  gyroHi.translate(ghp.x, ghp.y, ghp.z);
  hw.push(AH.patch(gyroHi, 'ANOD'));

  // brake lever on the right bar — a real perch, a curved blade with a hooked
  // tip, a reach-adjust barrel and a cable stop the gyro cable actually lands on
  const gripInner = barCentre.clone().add(GRIP_A);
  const gripOuter = barCentre.clone().add(GRIP_B);
  const gdir = gripOuter.clone().sub(gripInner).normalize();
  const gPerp = new THREE.Vector3().crossVectors(gdir, V(0, 1, 0)).normalize();   // ~forward
  const gUp = new THREE.Vector3().crossVectors(gPerp, gdir).normalize();
  const perch = latheX([
    [0.0143, 0], [0.0225, 0.002], [0.0235, 0.008], [0.0225, 0.024], [0.0143, 0.026],
  ], 16);
  _q.setFromUnitVectors(V(1, 0, 0), gdir);
  perch.applyQuaternion(_q);
  const perchP = gripInner.clone().addScaledVector(gdir, -0.028);
  perch.translate(perchP.x, perchP.y, perchP.z);
  hw.push(AH.patch(perch, 'ANOD'));

  const bladeShape = new THREE.Shape();
  bladeShape.moveTo(0, 0.004);
  bladeShape.quadraticCurveTo(0.052, -0.004, 0.092, -0.020);
  bladeShape.quadraticCurveTo(0.110, -0.028, 0.108, -0.042);
  bladeShape.lineTo(0.094, -0.044);
  bladeShape.quadraticCurveTo(0.092, -0.034, 0.080, -0.030);
  bladeShape.quadraticCurveTo(0.044, -0.016, 0.000, -0.010);
  bladeShape.closePath();
  const blade = plate(bladeShape, 0.0090, 0.0012, 6);
  // the blade lies in the plane spanned by (forward, up) at the bar, so it sweeps
  // forward off the perch instead of sitting in an arbitrary world plane
  blade.applyMatrix4(new THREE.Matrix4().makeBasis(gPerp, gUp, gdir));
  const bladeAt = perchP.clone().addScaledVector(gPerp, 0.020).addScaledVector(gUp, -0.004)
    .addScaledVector(gdir, 0.006);
  blade.translate(bladeAt.x, bladeAt.y, bladeAt.z);
  hw.push(AH.patch(blade, 'MACHINED'));
  const barrel = new THREE.CylinderGeometry(0.0048, 0.0048, 0.016, 8);
  const barrelAt = perchP.clone().addScaledVector(gPerp, 0.004).addScaledVector(gUp, 0.020);
  place(barrel, barrelAt, barrelAt.clone().addScaledVector(gUp, 0.016));
  hw.push(AH.patch(barrel, 'ANOD'));

  rub.push(AR.uv(sweep([
    barrelAt.clone().addScaledVector(gUp, 0.014),
    perchP.clone().add(V(-0.03, 0.046, 0.028)),
    barCentre.clone().add(V(0.02, 0.238, -0.010)),
    barCentre.clone().add(V(0.0, 0.126, 0.010)),
    ghp.clone().add(V(0.0, 0.014, 0.012)),
  ], { radius: 0.0028, radial: 6, steps: 24 }), 'CABLE'));

  // grips: knurled inboard flange, ribbed barrel, bar-end plug seat.
  // v = 0 is the flange, v = 1 the bar end — the GRIP region is painted to match.
  const gripPts = [];
  gripPts.push([0.0125, 0.000], [0.0205, 0.003], [0.0212, 0.014], [0.0206, 0.019], [0.0160, 0.022]);
  for (let i = 0; i < 11; i++) {
    const y = 0.026 + i * 0.0104;
    gripPts.push([i % 2 ? 0.0176 : 0.0162, y]);
  }
  gripPts.push([0.0172, 0.142], [0.0184, 0.147], [0.0150, 0.151], [0.0, 0.151]);
  const gripLen = 0.151;
  for (const s of [-1, 1]) {
    const gi = barCentre.clone().add(V(s * GRIP_A.x, GRIP_A.y, GRIP_A.z));
    const go = barCentre.clone().add(V(s * GRIP_B.x, GRIP_B.y, GRIP_B.z));
    const gr = new THREE.LatheGeometry(gripPts.map(([r, y]) => new THREE.Vector2(r, y)), 20);
    place(gr, gi, go);
    rub.push(AR.uv(gr, 'GRIP'));

    // Bar-end plug: seated FLUSH in the grip's own end recess. Its face sits at
    // gripLen, not proud of it, so it can never punch out through a palm.
    const plug = latheX([[0, 0], [0.0136, 0], [0.0152, 0.003], [0.0146, 0.0075], [0, 0.0075]], 18);
    const pdir = go.clone().sub(gi).normalize();
    _q.setFromUnitVectors(V(1, 0, 0), pdir);
    plug.applyQuaternion(_q);
    const pp = gi.clone().addScaledVector(pdir, gripLen - 0.0072);
    plug.translate(pp.x, pp.y, pp.z);
    hw.push(AH.patch(plug, 'ACCENT'));
  }

  const gMidL = V(-(GRIP_A.x + GRIP_B.x) / 2, (GRIP_A.y + GRIP_B.y) / 2, (GRIP_A.z + GRIP_B.z) / 2);
  const gMidR = V((GRIP_A.x + GRIP_B.x) / 2, (GRIP_A.y + GRIP_B.y) / 2, (GRIP_A.z + GRIP_B.z) / 2);
  const gripAnchorL = barCentre.clone().add(gMidL);
  const gripAnchorR = barCentre.clone().add(gMidR);
  // Axis + radius the HAND is placed from. Publishing these is what lets the fist
  // be driven by IK off the grip instead of guessed off the arm chain.
  const gripAxisR = V(GRIP_B.x - GRIP_A.x, GRIP_B.y - GRIP_A.y, GRIP_B.z - GRIP_A.z).normalize();
  const gripAxisL = V(-gripAxisR.x, gripAxisR.y, gripAxisR.z);
  return {
    hardware: merge(hw), rubber: merge(rub), gripAnchorL, gripAnchorR, barCentre,
    gripAxisL, gripAxisR, gripRadius: 0.0176, gripLen,
    gripStartL: barCentre.clone().add(V(-GRIP_A.x, GRIP_A.y, GRIP_A.z)),
    gripStartR: barCentre.clone().add(V(GRIP_A.x, GRIP_A.y, GRIP_A.z)),
  };
}

function buildSeat(AR, AH) {
  const rub = [], hw = [];
  const { stTop, stDir } = PT;
  const base = stTop.clone().addScaledVector(stDir, 0.080);

  const s = new THREE.SphereGeometry(1, 18, 12);
  const p = s.attributes.position;
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i) * 0.070, y = p.getY(i) * 0.052, z = p.getZ(i) * 0.135;
    if (y > 0.010) y = 0.010 + (y - 0.010) * 0.25;
    const tz = clamp(z / 0.135, -1, 1);
    if (tz > 0) x *= 1 - 0.62 * Math.pow(tz, 1.5);
    else x *= 1 + 0.16 * Math.pow(-tz, 2);
    if (tz > 0.5) y += (tz - 0.5) * 0.030;
    p.setXYZ(i, x, y - 0.006, z);
  }
  s.computeVertexNormals();
  s.translate(base.x, base.y + 0.020, base.z + 0.010);
  rub.push(AR.uv(s, 'SEAT'));

  const mount = plate(roundedRectShape(0.052, 0.030, 0.006), 0.026, 0.0008, 4);
  mount.rotateY(Math.PI / 2);
  mount.rotateX(-0.22);
  mount.translate(base.x, base.y - 0.004, base.z + 0.006);
  hw.push(AH.patch(mount, 'ANOD'));

  // seat post + clamp travel with the saddle
  const spTop = stTop.clone().addScaledVector(stDir, 0.075);
  hw.push(AH.patch(rod(stTop.clone().addScaledVector(stDir, -0.10), spTop, 0.0135), 'CHROME'));
  const clampGeo = latheX([[0.0168, -0.010], [0.0205, -0.010], [0.0205, 0.010], [0.0168, 0.010]], 16);
  _q.setFromUnitVectors(V(1, 0, 0), stDir);
  clampGeo.applyQuaternion(_q);
  clampGeo.translate(stTop.x, stTop.y + 0.004, stTop.z);
  hw.push(AH.patch(clampGeo, 'ACCENT'));
  const clampBolt = new THREE.CylinderGeometry(0.0035, 0.0035, 0.030, 6);
  clampBolt.rotateZ(Math.PI / 2);
  clampBolt.translate(stTop.x, stTop.y + 0.004, stTop.z - 0.020);
  hw.push(AH.patch(clampBolt, 'CHROME'));

  return { rubber: merge(rub), hardware: merge(hw), seatTop: base.clone().add(V(0, 0.045, 0.010)) };
}

function buildDrivetrain(AH) {
  const { bb } = PT;
  const hw = [];

  // crank arms — right arm forward, left arm back (level cranks, the ready stance)
  const armShape = new THREE.Shape();
  armShape.moveTo(0, 0.023);
  armShape.lineTo(G.crankLen, 0.017);
  armShape.absarc(G.crankLen, 0, 0.017, Math.PI / 2, -Math.PI / 2, true);
  armShape.lineTo(0, -0.023);
  armShape.absarc(0, 0, 0.023, -Math.PI / 2, -Math.PI * 1.5, true);
  armShape.closePath();

  const pedalPos = [];
  for (const s of [1, -1]) {                       // s = +1 → right arm (+X, forward)
    const arm = plate(armShape, 0.0155, 0.0012, 5);
    const fwd = V(0, 0, s), up = V(0, 1, 0);
    arm.applyMatrix4(new THREE.Matrix4().makeBasis(fwd, up, new THREE.Vector3().crossVectors(fwd, up)));
    arm.translate(s * 0.055, bb.y, bb.z);
    hw.push(AH.uv(arm, 'ALLOY'));
    const sp = V(s * 0.066, bb.y, bb.z + s * G.crankLen);
    const so = V(s * 0.150, bb.y, bb.z + s * G.crankLen);
    hw.push(AH.patch(rod(sp, so, 0.0075, 0.0065, 8), 'CHROME'));
    pedalPos.push(V(s * 0.112, bb.y, bb.z + s * G.crankLen));
  }
  hw.push(AH.patch(rod(V(-0.062, bb.y, bb.z), V(0.062, bb.y, bb.z), 0.0115), 'STEEL'));

  // chainring on the drive side — 25T, milled face, real 5-bolt circle
  const { shape: ringShape, R: ringR } = sprocketShape(G.sprocketTeeth, G.pitch, 5, 0.0115);
  const ring = plate(ringShape, 0.0062, 0.0009, 4);
  ring.rotateY(Math.PI / 2);
  ring.rotateX(Math.PI / 2);
  ring.translate(G.chainLine, bb.y, bb.z);
  hw.push(AH.uv(ring, 'MACHINED'));
  for (let i = 0; i < 5; i++) {                    // 5-bolt circle, both faces
    const a = (i / 5) * TAU + 0.3;
    const y = bb.y + Math.sin(a) * ringR * 0.42, z = bb.z + Math.cos(a) * ringR * 0.42;
    const boss = new THREE.CylinderGeometry(0.0082, 0.0082, 0.0090, 10);
    boss.rotateZ(Math.PI / 2);
    boss.translate(G.chainLine, y, z);
    hw.push(AH.patch(boss, 'MACHINED'));
    const bolt = new THREE.CylinderGeometry(0.0050, 0.0050, 0.0160, 6);
    bolt.rotateZ(Math.PI / 2);
    bolt.translate(G.chainLine + 0.0035, y, z);
    hw.push(AH.patch(bolt, 'CHROME'));
  }

  // pedals: alloy platform, cage plates, eight grip pins per side
  const pedals = pedalPos.map((pp) => {
    const parts = [];
    const bodyGeo = plate(roundedRectShape(0.098, 0.076, 0.008), 0.021, 0.0012, 4);
    bodyGeo.rotateY(Math.PI / 2);
    bodyGeo.rotateZ(Math.PI / 2);
    bodyGeo.translate(pp.x, pp.y, pp.z);
    parts.push(AH.uv(bodyGeo, 'ALLOY'));
    for (let k = 0; k < 4; k++) {
      for (const sy of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const pin = new THREE.CylinderGeometry(0.0021, 0.0018, 0.0075, 5);
          pin.translate(pp.x + (k - 1.5) * 0.024, pp.y + sy * 0.0135, pp.z + sz * 0.030);
          parts.push(AH.patch(pin, 'CHROME'));
        }
      }
    }
    return { geo: merge(parts), pos: pp };
  });

  // --- chain: tangent lines + wrap arcs around ring and cog -------------------
  const cogR = G.pitch / (2 * Math.sin(Math.PI / G.cogTeeth));
  const c1 = { y: bb.y, z: bb.z, r: ringR };
  const c2 = { y: PT.rearAxle.y, z: PT.rearAxle.z, r: cogR };
  const dz = c2.z - c1.z, dy = c2.y - c1.y;
  const D = Math.hypot(dz, dy);
  const phi = Math.atan2(dy, dz);
  const beta = Math.acos(clamp((c1.r - c2.r) / D, -1, 1));
  const a1 = phi + beta, a2 = phi - beta;
  const pointAt = (c, a) => V(G.chainLine, c.y + c.r * Math.sin(a), c.z + c.r * Math.cos(a));

  const path = [];
  const runLowFirst = Math.sin(a1) < Math.sin(a2);
  const line = (from, to, n, sag) => {
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const p = from.clone().lerp(to, t);
      if (sag) p.y -= sag * 4 * t * (1 - t);
      path.push(p);
    }
  };
  line(pointAt(c1, a1), pointAt(c2, a1), 12, runLowFirst ? 0.007 : 0);
  for (let i = 0; i < 14; i++) path.push(pointAt(c2, lerp(a1, a2, i / 14)));
  line(pointAt(c2, a2), pointAt(c1, a2), 12, runLowFirst ? 0 : 0.007);
  for (let i = 0; i < 26; i++) path.push(pointAt(c1, lerp(a2, a1 - TAU, i / 26)));

  const n = path.length;
  const cum = new Float32Array(n + 1);
  for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + path[i].distanceTo(path[(i + 1) % n]);
  const total = cum[n];
  const links = Math.max(8, Math.round(total / G.pitch));

  // A link is outer plate + inner plate + roller + pin head, not a single strip:
  // at 3 m a 1.3 mm plate is under a pixel and the chain dissolves into specks.
  // 9.2 mm tall plates and a 4.4 mm roller give the run a continuous highlight
  // along its top tangent instead of a dotted line.
  const linkParts = [];
  for (const s of [-1, 1]) {
    const outerPl = new THREE.BoxGeometry(G.pitch * 1.16, 0.0092, 0.0019);
    outerPl.translate(G.pitch * 0.5, 0, s * 0.0040);
    linkParts.push(AH.patch(outerPl, 'OILY', 0.10, 0.90));
    const innerPl = new THREE.BoxGeometry(G.pitch * 0.96, 0.0078, 0.0016);
    innerPl.translate(G.pitch * 0.5, 0, s * 0.0021);
    linkParts.push(AH.patch(innerPl, 'OILY', 0.20, 0.80));
  }
  // 7.6 mm roller against 9.2 mm plates: it has to sit INSIDE the plate height or
  // consecutive rollers merge into a continuous knurled rod that reads as cable.
  const roller = new THREE.CylinderGeometry(0.0038, 0.0038, 0.0044, 8);
  roller.rotateX(Math.PI / 2);
  linkParts.push(AH.patch(roller, 'STEEL'));
  for (const s of [-1, 1]) {                        // pin heads, peened proud
    const pin = new THREE.CylinderGeometry(0.0021, 0.0018, 0.0014, 6);
    pin.rotateX(Math.PI / 2);
    pin.translate(0, 0, s * 0.0052);
    linkParts.push(AH.patch(pin, 'CHROME'));
  }

  return {
    hardware: merge(hw), pedals,
    chain: { path, cum, total, links, geo: merge(linkParts) },
    ringR,
  };
}

// ---------------------------------------------------------------------------
// rider: proportions, fit on the bike, skeleton
// ---------------------------------------------------------------------------

/** Bind-pose limb lengths for THIS rider, in metres. */
function limbLengths(M) {
  const legRel = M.legScale / Math.max(M.heightScale, 1e-4);
  return {
    upperArm: 0.300 * M.armScale,
    foreArm: 0.260 * M.armScale,
    thigh: 0.440 * M.legScale,
    shin: 0.430 * M.legScale,
    torso: 0.460 * M.torsoScale * (1 + (1 - legRel) * 0.6),
    neck: 0.105 * M.neckScale,
    head: 0.098 * M.headScale,
    hand: 0.098 * M.armScale,
    foot: 0.150 * M.legScale,
  };
}

/**
 * Where does a rider of this size have to sit to have both hands on the grips and
 * both feet on the pedals? Solved, not authored: for a fixed torso lean the hips
 * must lie on one circle around the grips (arm reach) and one around the pedals
 * (leg reach), so the hip position is a circle-circle intersection in the sagittal
 * plane. Sweeping the lean and scoring against a target saddle clearance picks the
 * stance. A 1.60 m rider therefore ends up crouched and forward, a 1.95 m rider
 * tall and stretched, and both have their hands and feet exactly on the bike.
 */
function riderPose(pts, X) {
  const M = X.M;
  const L = limbLengths(M);
  const hs = M.heightScale;

  // The hands are IK'd off the GRIPS: `fistWrist` says exactly where a wrist has
  // to be for a fist of this size to be closed on a grip of this radius, and the
  // whole stance is then solved to put the wrists there. Previously the wrist was
  // a fixed offset guess and the fist was hung off it, which is why one palm
  // floated clear of its grip and the other swallowed the bar-end cap.
  const handR = 0.041 * hs * lerp(0.92, 1.10, M.build);
  const barR = pts.gripRadius ?? 0.0176;
  const curlR = barR + handR * (X.glove.on ? 0.10 : 0.045);
  const axisFor = (s) => (s > 0 ? pts.gripAxisR : pts.gripAxisL) || V(s, 0.02, -0.08).normalize();
  const gripFor = (s) => (s > 0 ? pts.gripR : pts.gripL);
  const wristAt = (s) => fistWrist(gripFor(s), axisFor(s), handR, curlR);

  const wristMid = wristAt(1).lerp(wristAt(-1), 0.5).setX(0);
  const pedalMid = pts.pedalL.clone().add(pts.pedalR).multiplyScalar(0.5);
  const ankleMid = V(0, pedalMid.y + 0.074 * hs + M.fit.pedalDrop, pedalMid.z - 0.030);

  // A rider stands ON a BMX, they do not stretch out on it: elbows and knees stay
  // well bent so there is travel to absorb a landing. These two numbers ARE the
  // stance — at 1.78 m they reproduce the hand-authored riding pose exactly.
  const armReach = (L.upperArm + L.foreArm) * 0.700;
  const legReach = (L.thigh + L.shin) * 0.650;
  const seatY = 0.6685;
  const targetHipY = seatY + 0.272 * hs + M.fit.seatHeight * 0.55;

  let best = null;
  for (let i = 0; i <= 18; i++) {
    const leanA = lerp(29 * DEG, 53 * DEG, i / 18);
    const lean = V(0, Math.cos(leanA), Math.sin(leanA));
    const shOff = lean.clone().multiplyScalar(L.torso).add(V(0, 0.022 * hs, 0.004));
    const hipOff = V(0, -0.014 * hs, 0.012);
    const c1y = wristMid.y - shOff.y, c1z = wristMid.z - shOff.z;
    const c2y = ankleMid.y - hipOff.y, c2z = ankleMid.z - hipOff.z;
    const hit = circleFit(c1y, c1z, armReach, c2y, c2z, legReach);
    const score = Math.abs(hit.y - targetHipY) * 1.0
      + Math.abs(leanA - 40 * DEG) * 0.30
      + hit.err * 2.5
      + Math.max(0, -0.36 - hit.z) * 1.5;          // never sit off the back of the bike
    if (!best || score < best.score) best = { score, leanA, lean, y: hit.y, z: hit.z };
  }

  const leanA = best.leanA;
  const lean = V(0, Math.cos(leanA), Math.sin(leanA));
  const hips = V(0, best.y, best.z);
  const chest = hips.clone().addScaledVector(lean, L.torso);
  const spine = hips.clone().lerp(chest, 0.46);
  const neck = chest.clone().addScaledVector(lean, L.neck).add(V(0, 0.020 * hs, -0.020 * hs));
  const head = neck.clone().add(V(0, 0.070 * hs, 0.012));
  // the torso's own frame: +X is the chest front, +Z the rider's left
  const front = new THREE.Vector3().crossVectors(lean, V(-1, 0, 0)).normalize();

  // Acromion, not the outside of the deltoid. At 0.180 the joint sat where the
  // OUTER SURFACE of the arm belongs, so the deltoid's own radius pushed the
  // silhouette out to a 490 mm shoulder span — a linebacker, and the reason the
  // arms hung off the torso like a gorilla's. 0.142 + a 60 mm deltoid lands the
  // silhouette at ~2.2 head-widths, which is the male figure.
  const shoulder = (s) => chest.clone()
    .add(V(s * 0.142 * M.shoulderWidth, 0.020 * hs, 0.006));
  const wristFor = (s) => wristAt(s);
  const hip = (s) => hips.clone().add(V(s * 0.096 * M.hipWidth, -0.014 * hs, 0.012));
  const ankle = (s) => (s > 0 ? pts.pedalR : pts.pedalL).clone()
    .add(V(s * -0.008, 0.074 * hs + M.fit.pedalDrop, -0.030));

  const pose = {
    hips, spine, chest, neck, head, lean, front, leanA, L,
    // published so the body builder places the fists from exactly the same grip
    // transform the stance was solved against
    handR, curlR, gripRadius: barR,
    gripAxisR: axisFor(1), gripAxisL: axisFor(-1),
    gripPointR: gripFor(1).clone(), gripPointL: gripFor(-1).clone(),
  };
  for (const [side, s] of [['R', 1], ['L', -1]]) {
    const sh = shoulder(s), wr = wristFor(s);
    const el = ikJoint(sh, wr, L.upperArm, L.foreArm, V(s * 0.86, -0.34, -0.38));
    const hp = hip(s), an = ankle(s);
    const kn = ikJoint(hp, an, L.thigh, L.shin, V(s * (0.17 + M.fit.standWidth * 6), 0.16, 1.0));
    pose['shoulder' + side] = sh;
    pose['elbow' + side] = el;
    pose['wrist' + side] = wr;
    pose['hip' + side] = hp;
    pose['knee' + side] = kn;
    pose['ankle' + side] = an;
    pose['toe' + side] = an.clone().add(V(s * 0.004, -0.052 * hs, L.foot));
  }
  return pose;
}

function buildSkeleton(pose) {
  const bones = [], index = new Map(), world = new Map();
  const add = (name, pos, parentName) => {
    const b = new THREE.Bone();
    b.name = name;
    world.set(name, pos.clone());
    if (parentName) {
      b.position.copy(pos).sub(world.get(parentName));
      index.get(parentName).b.add(b);
    } else {
      b.position.copy(pos);
    }
    index.set(name, { b, i: bones.length });
    bones.push(b);
    return b;
  };
  add('hips', pose.hips, null);
  add('spine', pose.spine, 'hips');
  add('chest', pose.chest, 'spine');
  add('neck', pose.neck, 'chest');
  add('head', pose.head, 'neck');
  for (const side of ['R', 'L']) {
    add('shoulder' + side, pose['shoulder' + side], 'chest');
    add('elbow' + side, pose['elbow' + side], 'shoulder' + side);
    add('wrist' + side, pose['wrist' + side], 'elbow' + side);
    add('hip' + side, pose['hip' + side], 'hips');
    add('knee' + side, pose['knee' + side], 'hip' + side);
    add('ankle' + side, pose['ankle' + side], 'knee' + side);
    add('toe' + side, pose['toe' + side], 'ankle' + side);
  }
  const bi = {};
  for (const [name, v] of index) bi[name] = v.i;
  return { bones, boneIndex: bi, byName: Object.fromEntries([...index].map(([k, v]) => [k, v.b])) };
}

/** Move an existing skeleton onto a new pose without rebuilding the bones. */
function reposeSkeleton(byName, pose) {
  const parent = {
    hips: null, spine: 'hips', chest: 'spine', neck: 'chest', head: 'neck',
  };
  for (const side of ['R', 'L']) {
    parent['shoulder' + side] = 'chest';
    parent['elbow' + side] = 'shoulder' + side;
    parent['wrist' + side] = 'elbow' + side;
    parent['hip' + side] = 'hips';
    parent['knee' + side] = 'hip' + side;
    parent['ankle' + side] = 'knee' + side;
    parent['toe' + side] = 'ankle' + side;
  }
  for (const name of Object.keys(parent)) {
    const b = byName[name];
    if (!b || !pose[name]) continue;
    const p = parent[name];
    if (p && pose[p]) b.position.copy(pose[name]).sub(pose[p]);
    else b.position.copy(pose[name]);
  }
}

/** Weight a part to one bone, ramping toward a second along the limb axis. */
function skinPart(geo, boneIndex, aName, bName, a, b, from = 0.62, to = 1.0, max = 0.85) {
  const p = geo.attributes.position;
  const n = p.count;
  const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  const ia = boneIndex[aName];
  const ib = bName != null ? boneIndex[bName] : ia;
  const dir = b ? b.clone().sub(a) : null;
  const len2 = dir ? Math.max(dir.lengthSq(), 1e-8) : 1;
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    let w = 0;
    if (dir) {
      v.fromBufferAttribute(p, i).sub(a);
      const t = v.dot(dir) / len2;
      w = clamp((t - from) / (to - from), 0, 1) * max;
    }
    si[i * 4] = ia; si[i * 4 + 1] = ib;
    sw[i * 4] = 1 - w; sw[i * 4 + 1] = w;
  }
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  return geo;
}

/** Weight a part across a chain of bones by projecting onto the chain axis. */
function skinAlong(geo, boneIndex, names, points) {
  const p = geo.attributes.position;
  const n = p.count;
  const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  const a = points[0], b = points[points.length - 1];
  const dir = b.clone().sub(a);
  const len2 = Math.max(dir.lengthSq(), 1e-8);
  const ts = points.map((q) => q.clone().sub(a).dot(dir) / len2);
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(p, i).sub(a);
    const t = clamp(v.dot(dir) / len2, 0, 1);
    let k = 0;
    while (k < ts.length - 2 && t > ts[k + 1]) k++;
    const span = Math.max(ts[k + 1] - ts[k], 1e-5);
    const w = smoothstep(clamp((t - ts[k]) / span, 0, 1));
    si[i * 4] = boneIndex[names[k]];
    si[i * 4 + 1] = boneIndex[names[k + 1]];
    sw[i * 4] = 1 - w;
    sw[i * 4 + 1] = w;
  }
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  return geo;
}

/** Push front-facing vertices of a torso out in a window along its axis. */
function bustPass(geo, origin, axis, front, amount, centreT, width) {
  if (amount <= 0.0005) return geo;
  const p = geo.attributes.position;
  const len2 = Math.max(axis.lengthSq(), 1e-8);
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).sub(origin);
    const t = v.dot(axis) / len2;
    const f = v.dot(front);
    if (f <= 0) continue;
    const k = Math.exp(-(((t - centreT) / width) ** 2)) * clamp(f / 0.10, 0, 1);
    if (k < 0.002) continue;
    p.setXYZ(i,
      p.getX(i) + front.x * amount * k,
      p.getY(i) + front.y * amount * k,
      p.getZ(i) + front.z * amount * k);
  }
  geo.computeVertexNormals();
  return geo;
}

// ---------------------------------------------------------------------------
// rider: head, hair, headwear
// ---------------------------------------------------------------------------

/**
 * FACE LAYOUT — the single table both the skull sculpt and the face painter read.
 * `t` is normalised head height: 0 = the underside of the jaw, 1 = the crown, and
 * it is EXACTLY the v coordinate the head mesh carries, so a feature painted at
 * FL.eye lands on the geometry that was sculpted at FL.eye. `u` is measured from
 * the face centre (u = 0.5) as a fraction of the atlas width — one unit of u is
 * one full turn around the head, so the offsets below are real millimetres
 * divided by the circumference the head presents at the face.
 */
// Heights come straight off a 221 mm head: hairline 47 mm above the eye line,
// brow +14, nose base −46, mouth −68, chin point −100.
const FL = {
  crown: 1.000,
  hairline: 0.728,
  brow: 0.578,
  eye: 0.515,
  earTop: 0.615, earMid: 0.484, earLow: 0.352,
  noseRoot: 0.596, noseTip: 0.334, noseBase: 0.307,
  lipTop: 0.244, mouth: 0.2075, lipLow: 0.162,
  chinCrease: 0.130, chin: 0.0625, jaw: 0.020,
  eyeDX: 0.0650,          // pupil offset from centre  (≈ 63 mm interpupillary)
  eyeW: 0.0310,           // half eye opening          (≈ 30 mm wide)
  mouthW: 0.0516,         // half mouth width          (≈ 50 mm)
  noseW: 0.0351,          // half width at the alae    (≈ 34 mm)
  nostrilDX: 0.0186,
  earU: 0.2980,           // ear centre offset from the face centre
  yn: (t) => t * 2 - 1,
};

const _g = (x, s) => Math.exp(-((x / s) * (x / s)));

/**
 * Head surface in local space (origin = head centre, +Z forward, +Y up).
 * `a` = azimuth, 0 at the face; `t` = normalised height (see FL above).
 * Brow, sockets, cheekbones, nose, lips, chin, mandible and occiput are all real
 * displacement — the paint only shades what the skull already does.
 */
function headSurface(a, t, R, S) {
  const yn = clamp(t * 2 - 1, -1, 1);
  const ring = Math.sqrt(Math.max(0, 1 - yn * yn));
  const sa = Math.sin(a), ca = Math.cos(a);
  const xn = sa * ring, zn = ca * ring;
  const sgn = xn < 0 ? -1 : 1;
  const ax = Math.abs(xn);
  const front = clamp((zn - 0.02) / 0.45, 0, 1);           // how face-on this point is
  let px = xn * 0.822 * R * S.wide;
  let py = yn * 1.128 * R;
  let pz = zn * 1.005 * R;

  // A SKULL IS AN EGG IN PLAN, NOT A CIRCLE. Widest just behind the ear, then
  // tapering hard into the face so there is a real plane change from the side of
  // the head to the cheek. Without this the cheek was one unbroken dome running
  // from the nose all the way back to the ear, and no amount of paint could stop
  // the head reading as a potato with a picture on the front of it.
  px *= 1 - 0.255 * Math.pow(Math.max(0, zn), 1.7) - 0.120 * Math.pow(Math.max(0, -zn), 2.6);

  // --- cranium ---------------------------------------------------------------
  if (yn > 0.42) {                                          // dome narrows and flattens
    const k = (yn - 0.42) / 0.58;
    px *= 1 - 0.20 * k * k;
    pz *= 1 - 0.13 * k * k;
    py -= k * k * 0.050 * R;
  }
  // the back of the skull is a plane, not a ball
  pz += Math.max(0, -zn - 0.55) * _g(yn - 0.35, 0.55) * 0.10 * R;
  pz -= Math.max(0, -zn) * _g(yn - 0.14, 0.40) * 0.022 * R;                        // occiput
  // temple hollow, above and behind the outer end of the brow. This is the
  // landmark that tells the eye where the skull stops and the face starts.
  const temple = _g(yn - 0.285, 0.185) * _g(ax - 0.700, 0.255) * clamp(0.30 + zn * 1.05, 0, 1);
  px -= sgn * temple * 0.078 * R;
  pz -= temple * 0.016 * R;
  // zygomatic arch: a bony bridge running back from the cheekbone to the ear
  const arch = _g(yn + 0.075, 0.100) * _g(ax - 0.795, 0.225) * clamp(0.50 + zn * 0.9, 0, 1);
  px += sgn * arch * 0.046 * R;

  // --- mandible --------------------------------------------------------------
  const jl = clamp((-0.20 - yn) / 0.72, 0, 1);
  px *= 1 - (0.40 + 0.14 * (1 - S.jaw)) * Math.pow(jl, 1.55);
  // 0.14 pulled the whole lower face 14 % back toward the neck, which is what
  // buried the chin behind the lips and gave the rider no profile at all.
  pz *= 1 - 0.055 * Math.pow(jl, 2.1);
  // masseter: the side of the jaw is a flat plane, and the hollow above it under
  // the arch is the whole difference between a jaw and a cheek
  const mass = _g(yn + 0.400, 0.230) * _g(ax - 0.700, 0.290) * clamp(0.35 + zn * 0.8, 0, 1);
  px -= sgn * mass * 0.032 * R;
  if (yn < -0.70) {                                         // flat-ish under-jaw plane
    const k = smoothstep(clamp((-0.70 - yn) / 0.30, 0, 1));
    py = lerp(py, -0.90 * 1.128 * R, k * 0.62);
    pz -= Math.max(0, -zn) * k * 0.12 * R;                  // clear the neck at the back
  }
  const gon = _g(yn + 0.60, 0.18) * _g(ax - 0.62, 0.30) * _g(zn + 0.05, 0.55);
  px += sgn * gon * 0.045 * R * S.jaw;                      // gonial angle
  // the mandible edge itself — a defined line from the chin back to the jaw angle
  const jawEdge = _g(yn + 0.78, 0.115) * Math.max(0, zn + 0.35) * (0.4 + 0.6 * front);
  px += sgn * jawEdge * 0.034 * R * S.jaw;
  pz += jawEdge * 0.012 * R * S.jaw;

  // --- chin ------------------------------------------------------------------
  const chin = _g(yn + 0.875, 0.17) * Math.max(0, zn) * _g(xn, 0.34);
  pz += chin * 0.185 * R * S.jaw;
  py -= chin * 0.018 * R;
  pz += _g(yn + 0.86, 0.10) * _g(xn, 0.17) * Math.max(0, zn) * 0.046 * R;   // chin button
  pz -= _g(yn + 0.739, 0.075) * _g(xn, 0.26) * front * 0.042 * R;           // mentolabial crease

  // --- mouth -----------------------------------------------------------------
  const lipC = _g(xn, 0.40) * front;
  pz += _g(yn + 0.55, 0.150) * lipC * 0.030 * R;            // the whole muzzle sits proud
  pz += _g(yn + 0.549, 0.048) * lipC * 0.044 * R;           // upper lip
  pz += _g(yn + 0.630, 0.052) * lipC * 0.052 * R;           // lower lip
  pz -= _g(yn + 0.585, 0.019) * lipC * 0.040 * R;           // mouth line
  pz -= _g(yn + 0.450, 0.042) * _g(xn, 0.060) * front * 0.022 * R;          // philtrum

  // --- nose ------------------------------------------------------------------
  // A swept ridge: half-width and forward reach both vary from root to base, and
  // the cross-section is a rounded triangle, which is what gives a real nose its
  // shadow line down each side instead of a painted stripe.
  const nh = clamp((0.193 - yn) / 0.579, -0.4, 1.6);        // 0 at the root, 1 at the base
  if (nh > -0.30 && nh < 1.45 && zn > -0.1) {
    const halfW = lerp(0.075, 0.230, smoothstep(clamp(nh, 0, 1)));
    const p = ax / halfW;
    const across = Math.exp(-Math.pow(p, 2.5) * 1.35);
    const along = smoothstep(clamp((nh + 0.06) / 0.26, 0, 1))
      * (1 - smoothstep(clamp((nh - 0.96) / 0.26, 0, 1)));
    const fwd = lerp(0.046, 0.298, smoothstep(clamp((nh - 0.10) / 0.66, 0, 1)));
    pz += along * across * fwd * R * front;
    // the tip is a ball of cartilage, not the end of a wedge
    pz += _g(nh - 0.90, 0.115) * _g(ax, 0.110) * front * 0.046 * R;
    // alae flare either side of the tip, nostrils cut in underneath
    const ala = _g(nh - 0.95, 0.13) * _g(ax - 0.180, 0.085) * front;
    px += sgn * ala * 0.052 * R;
    pz += ala * 0.038 * R;
    const nostril = _g(nh - 1.10, 0.085) * _g(ax - 0.105, 0.055) * front;
    pz -= nostril * 0.048 * R;
    py -= nostril * 0.010 * R;
  }

  // --- brow, sockets, eyes ---------------------------------------------------
  // The brow ridge and the orbital rim are GEOMETRY, not paint: at a 900 px
  // close-up a painted brow has no self-shadow and the head reads as an egg.
  // A brow that OVERHANGS. At 0.086 R the ridge was a swelling the light slid
  // over; the eye needs to sit in shadow under a real shelf.
  const brow = _g(yn - 0.157, 0.098) * Math.max(0, zn - 0.22) * (0.45 + 0.55 * _g(ax - 0.30, 0.26));
  pz += brow * 0.128 * R * S.brow;
  py += brow * 0.013 * R * S.brow;                                                       // rim lip
  const eyeX = ax - 0.315;
  // orbital cavity, then the GLOBE as a spherical cap seated inside it — the
  // socket has to be deeper than the eye is proud or the eye is a sticker.
  pz -= _g(yn - 0.020, 0.115) * _g(eyeX, 0.180) * Math.max(0, zn - 0.24) * 0.094 * R;   // socket
  pz += _g(yn - 0.020, 0.062) * _g(eyeX, 0.092) * Math.max(0, zn - 0.40) * 0.084 * R;   // globe
  pz -= _g(yn - 0.090, 0.026) * _g(eyeX, 0.086) * Math.max(0, zn - 0.42) * 0.028 * R;   // lid crease
  // glabella: the bridge between the brows, which is what gives the nose a root
  pz += _g(yn - 0.150, 0.070) * _g(xn, 0.090) * Math.max(0, zn - 0.40) * 0.026 * R;

  // --- cheeks ----------------------------------------------------------------
  const zyg = _g(yn + 0.170, 0.135) * _g(ax - 0.560, 0.210) * Math.max(0, zn * 0.65 + 0.35);
  px += sgn * zyg * 0.058 * R;
  pz += zyg * 0.026 * R;
  const hollow = _g(yn + 0.400, 0.150) * _g(ax - 0.450, 0.200) * front;
  pz -= hollow * 0.056 * R;
  px -= sgn * hollow * 0.042 * R;
  // nasolabial fold, and the soft pad of the cheek beside the mouth
  pz -= _g(yn + 0.470, 0.070) * _g(ax - 0.225, 0.065) * front * 0.016 * R;
  pz += _g(yn + 0.560, 0.100) * _g(ax - 0.300, 0.100) * front * 0.008 * R;
  return V(px, py, pz);
}

function buildHead(centre, R, S) {
  // 52 x 34 rather than 40 x 26: the brow ridge, the orbital rim and the nose are
  // all real displacement now, and at the old tessellation the nose was four
  // quads wide and the socket rim was faceted at a 900 px close-up.
  // 64 x 44: the orbital cavity, the globe cap and the nose alae are all
  // gaussians two to three rows wide, and at 34 rows the socket resolved as one
  // facet — the sculpt existed in the maths and not on screen.
  const NU = 64, NV = 44;
  const pos = [], uvs = [], idx = [];
  for (let j = 0; j <= NV; j++) {
    const s = j / NV;
    // Blend a polar distribution (rows bunch at the poles, so the crown and the
    // under-jaw stay smooth) with a uniform-height one (rows bunch at the face,
    // where every feature is), then hand the resulting height straight to the UV.
    const t = clamp(lerp(0.5 - 0.5 * Math.cos(Math.PI * s), s, 0.55), 0, 1);
    for (let i = 0; i <= NU; i++) {
      const a = Math.PI - (i / NU) * TAU;
      const p = headSurface(a, t, R, S).add(centre);
      pos.push(p.x, p.y, p.z);
      uvs.push(i / NU, t);
    }
  }
  const w = NU + 1;
  for (let j = 0; j < NV; j++) {
    for (let i = 0; i < NU; i++) {
      const A = j * w + i, B = A + w;
      idx.push(A, B, A + 1, B, B + 1, A + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/**
 * A real ear: an oval lens against the skull with a curled helix rim, a sunken
 * concha, a tragus and a free lobe. Two shells (outer + inner) joined at the rim,
 * ~260 triangles, and it changes the head's silhouette from every angle.
 */
function buildEar(centre, R, S, side) {
  const NA = 18, NR = 5;
  // local frame: `out` away from the skull, `up` along the ear's own long axis
  // (tilted back at the top, as a real ear is), `fore` toward the face
  const out = V(side * 0.972, 0.02, -0.235).normalize();
  const up = V(-side * 0.055, 0.972, 0.228).normalize();
  const fore = new THREE.Vector3().crossVectors(up, out).normalize().multiplyScalar(side);
  // seated INTO the skull, so the front third of the shell is buried and the ear
  // reads as part of the head rather than a card stuck to it
  const at = headSurface(side * (Math.PI * 0.5 + 0.34), FL.earMid, R, S).add(centre)
    .addScaledVector(out, -0.022 * R).addScaledVector(fore, -0.020 * R);
  const rx = 0.190 * R, ry = 0.320 * R;

  const pos = [], uvs = [], idx = [];
  // θ = 0 toward the face, π/2 up, π back
  const outline = (th) => {
    const cth = Math.cos(th), sth = Math.sin(th);
    // fuller and rounder at the back and top; the lobe is narrow and forward
    const rr = 1 - 0.13 * Math.max(0, -sth) + 0.05 * Math.max(0, -cth);
    return [cth * rx * rr * (1 - 0.10 * Math.max(0, -sth)), sth * ry * rr];
  };
  const point = (rho, th, shellOut) => {
    const [bx, by] = outline(th);
    const px = bx * rho, py = by * rho;
    const cth = Math.cos(th), sth = Math.sin(th);
    // helix rim rolls over from the front-top, round the back, into the lobe
    // The helix is a ROLLED rim, not a swelling: it has to be narrow in rho and
    // tall in relief, or the ear renders as a flat tan card stuck to the skull.
    const rimAmt = _g(rho - 0.86, 0.19);
    const rimArc = smoothstep(clamp((th - 0.05) / 0.90, 0, 1))
      * (1 - 0.45 * smoothstep(clamp((th - 4.60) / 1.20, 0, 1)));
    // concha bowl, antihelix ridge behind it, tragus over the canal
    const bowl = (1 - smoothstep(clamp((rho - 0.04) / 0.44, 0, 1))) * clamp(0.45 + cth * 0.75, 0, 1);
    const anti = _g(rho - 0.52, 0.17) * clamp(0.30 - cth * 0.85, 0, 1) * Math.max(0, sth + 0.35);
    const tragus = _g(rho - 0.30, 0.20) * _g(Math.atan2(Math.sin(th + 0.35), Math.cos(th + 0.35)), 0.45);
    // the whole shell flares away from the skull toward the top and the back
    const flare = clamp(0.28 + 0.72 * rho, 0, 1) * (0.45 + 0.55 * clamp(0.5 - cth * 0.7, 0, 1));
    const d = 0.086 * R * rimAmt * rimArc + 0.026 * R * anti
      - 0.062 * R * bowl + 0.026 * R * tragus + 0.034 * R * flare;
    const p = at.clone()
      .addScaledVector(fore, px)
      .addScaledVector(up, py)
      .addScaledVector(out, shellOut > 0 ? d + 0.016 * R
        : d * 0.34 - 0.016 * R - 0.022 * R * (1 - rho) * clamp(0.5 + Math.cos(th) * 0.9, 0, 1));
    return p;
  };
  for (const shellOut of [1, -1]) {
    const base = pos.length / 3;
    for (let j = 0; j <= NR; j++) {
      const rho = j / NR;
      for (let i = 0; i <= NA; i++) {
        const th = (i / NA) * TAU;
        const p = point(rho, th, shellOut);
        pos.push(p.x, p.y, p.z);
        uvs.push(0.5 + Math.cos(th) * rho * 0.42, 0.5 + Math.sin(th) * rho * 0.46);
      }
    }
    const w = NA + 1;
    for (let j = 0; j < NR; j++) {
      for (let i = 0; i < NA; i++) {
        const A = base + j * w + i, B = A + w;
        if (shellOut > 0) idx.push(A, B, A + 1, B, B + 1, A + 1);
        else idx.push(A, A + 1, B, B, A + 1, B + 1);
      }
    }
  }
  // close the helix: stitch the outer boundary ring to the inner one, otherwise
  // the open edge shows as a bright sliver from behind
  const wr = NA + 1;
  const outerRim = NR * wr, innerRim = wr * (NR + 1) + NR * wr;
  for (let i = 0; i < NA; i++) {
    const A = outerRim + i, B = A + 1, C = innerRim + i, D = C + 1;
    idx.push(A, C, B, C, D, B);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

// `line` is the FRONT hairline in head-height units (see FL) — the shell drops
// from there at the temples and again at the nape.
const HAIR_SPEC = {
  bald: { t: 0, line: 0.760 },
  buzz: { t: 0.14, line: 0.722, noise: 0.10 },
  short: { t: 0.28, line: 0.730, noise: 0.18 },
  fade: { t: 0.36, line: 0.730, taper: 1.0, noise: 0.14 },
  messy: { t: 0.50, line: 0.738, noise: 0.55, freq: 7 },
  spikes: { t: 0.54, line: 0.742, noise: 0.90, freq: 11, spike: 1 },
  curly: { t: 0.70, line: 0.740, noise: 0.62, freq: 9 },
  afro: { t: 1.05, line: 0.734, noise: 0.40, freq: 8 },
  mohawk: { t: 0.26, line: 0.722, crest: 1.5, noise: 0.30, freq: 6 },
  longStraight: { t: 0.40, line: 0.734, curtain: 1.0, noise: 0.14 },
  shag: { t: 0.52, line: 0.744, curtain: 0.55, noise: 0.45, freq: 8 },
  ponytail: { t: 0.36, line: 0.744, tail: 1, noise: 0.12 },
  bun: { t: 0.34, line: 0.744, bun: 1, noise: 0.12 },
  braids: { t: 0.36, line: 0.734, strands: 8, curtain: 0.30, noise: 0.20 },
  dreads: { t: 0.46, line: 0.734, strands: 12, curtain: 0.45, noise: 0.30 },
  bowl: { t: 0.40, line: 0.706, noise: 0.10 },
};

/** How far the hair shell stands off the skull — headwear has to clear this. */
function hairThickness(X, R) {
  const spec = HAIR_SPEC[X.hair.style] || HAIR_SPEC.short;
  if (!spec.t) return 0;
  const vol = clamp(X.hair.volume, 0.05, 1);
  // A helmet crushes hair. Without this an afro under a lid pushes straight
  // through the EPS liner, which is why the shell used to cull the hair entirely.
  const crush = X.lid && X.lid.helmet ? 0.42 : 1;
  return 0.034 * spec.t * (0.6 + 0.7 * vol) * crush * (R / 0.098);
}

/**
 * A fitted hair shell: a closed cap that follows the skull, thick where the style
 * has volume, with a rim strip sealing it to the head and optional curtain, tail,
 * bun or strand geometry hanging off the boundary.
 */
function buildHair(centre, R, S, X, coverV) {
  const spec = HAIR_SPEC[X.hair.style] || HAIR_SPEC.short;
  if (!spec.t) return null;
  const NU = 26, NV = 9, NC = spec.curtain ? 6 : 0;
  const thickBase = hairThickness(X, R);
  const noiseAmp = (spec.noise ?? 0.2) * thickBase * 1.1;
  const freq = spec.freq ?? 5;
  const parts = [];

  const lineAt = (a) => {
    // lower at the temples, lower again at the nape
    const f = Math.cos(a);                        // 1 front, -1 back
    // the temple drop stays ABOVE FL.earTop: hair goes around an ear, not over it
    let v = spec.line - 0.070 * (1 - Math.abs(f)) - (f < 0 ? 0.185 : 0);
    // A helmet crushes hair DOWN and OUT: the fringe that shows below the shell
    // at the temples and the nape is what stops the lid meeting bare scalp on a
    // hard geometric seam. Barely touched at the front, so nothing hangs in the
    // eyes (the shell's front edge sits at v ≈ 0.645, this line at ≈ 0.70).
    if (X.lid && X.lid.helmet) v -= 0.110 * (1 - Math.max(0, f) * 0.75);
    // a widow's peak: the front line dips a touch dead centre
    if (f > 0.6) v += 0.010 * _g(Math.sin(a), 0.22);
    if (spec.crest) {
      // a mohawk is a strip: away from the sagittal line the shell pinches shut
      // at the crown, leaving the shaved sides to the scalp paint underneath
      const sideness = Math.abs(Math.sin(a));
      v = lerp(v, 0.985, smoothstep(clamp((sideness - 0.12) / 0.30, 0, 1)));
    }
    return clamp(Math.max(v, coverV), 0.02, 0.99);
  };
  const thickAt = (a, v) => {
    let t = thickBase;
    if (spec.taper) t *= lerp(0.25, 1.0, smoothstep(clamp((v - 0.72) / 0.22, 0, 1)));
    if (spec.crest) {
      const yn = v * 2 - 1;
      const xn = Math.abs(Math.sin(a) * Math.sqrt(Math.max(0, 1 - yn * yn)));
      t = thickBase * (0.18 + spec.crest * Math.exp(-((xn / 0.20) ** 2)) * 2.2);
    }
    const n = fbm2(Math.cos(a) * freq + 3.1, Math.sin(a) * freq + v * freq * 1.4, 3) - 0.5;
    t += n * noiseAmp * (spec.spike ? 2.2 : 1) * smoothstep(clamp((v - lineAt(a)) / 0.18, 0, 1));
    return Math.max(0.0025 * R / 0.098, t);
  };
  const shellPt = (a, v) => {
    const base = headSurface(a, v, R, S);
    const nrm = base.clone().normalize();
    return base.addScaledVector(nrm, thickAt(a, v)).add(centre);
  };

  // --- cap ------------------------------------------------------------------
  const pos = [], uvs = [], idx = [];
  const rows = NV + 1;
  for (let j = 0; j <= NV; j++) {
    for (let i = 0; i <= NU; i++) {
      const a = Math.PI - (i / NU) * TAU;
      const v = lerp(lineAt(a), 1, j / NV);
      const p = shellPt(a, v);
      pos.push(p.x, p.y, p.z);
      uvs.push(i / NU * 3, 1 - j / NV);
    }
  }
  const w = NU + 1;
  for (let j = 0; j < NV; j++) {
    for (let i = 0; i < NU; i++) {
      const A = j * w + i, B = A + w;
      idx.push(A, B, A + 1, B, B + 1, A + 1);
    }
  }
  // rim: seal the boundary back onto the skull
  const rimStart = pos.length / 3;
  for (let i = 0; i <= NU; i++) {
    const a = Math.PI - (i / NU) * TAU;
    const v = lineAt(a);
    const inner = headSurface(a, v, R, S).add(centre);
    pos.push(inner.x, inner.y, inner.z);
    uvs.push(i / NU * 3, 1.04);
  }
  for (let i = 0; i < NU; i++) {
    const A = i, B = A + 1, C = rimStart + i, D = C + 1;
    idx.push(A, C, B, C, D, B);
  }
  const cap = new THREE.BufferGeometry();
  cap.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  cap.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  cap.setIndex(idx);
  cap.computeVertexNormals();
  parts.push(cap);

  // --- curtain: hair hanging below the hairline at the sides and back --------
  if (NC) {
    const cpos = [], cuv = [], cidx = [];
    const drop = spec.curtain * 0.26 * (R / 0.098);
    const lenAt = (a) => Math.max(0, -Math.cos(a) * 0.55 + 0.55) * drop;
    for (let j = 0; j <= NC; j++) {
      for (let i = 0; i <= NU; i++) {
        const a = Math.PI - (i / NU) * TAU;
        const v = lineAt(a);
        const base = shellPt(a, v);
        const t = j / NC;
        const l = lenAt(a) * t;
        const out = base.clone().sub(centre).setY(0).normalize().multiplyScalar(0.004 * (1 - t));
        cpos.push(base.x + out.x, base.y - l, base.z + out.z);
        cuv.push(i / NU * 3, 1 - t * 0.9);
      }
    }
    for (let j = 0; j < NC; j++) {
      for (let i = 0; i < NU; i++) {
        const A = j * w + i, B = A + w;
        cidx.push(A, B, A + 1, B, B + 1, A + 1);
        cidx.push(A + 1, B, A, B + 1, B, A + 1);      // two-sided: a curtain has a back
      }
    }
    const curt = new THREE.BufferGeometry();
    curt.setAttribute('position', new THREE.Float32BufferAttribute(cpos, 3));
    curt.setAttribute('uv', new THREE.Float32BufferAttribute(cuv, 2));
    curt.setIndex(cidx);
    curt.computeVertexNormals();
    parts.push(curt);
  }

  // --- tail / bun / strands --------------------------------------------------
  const napeV = lineAt(Math.PI);
  const nape = shellPt(Math.PI, napeV + 0.10);
  if (spec.tail) {
    const tip = nape.clone().add(V(0, -0.16 * R / 0.098, -0.10 * R / 0.098));
    parts.push(sweep([nape, nape.clone().lerp(tip, 0.5).add(V(0, 0.01, -0.03)), tip],
      { radius: 0.026 * R / 0.098, radial: 8, steps: 8, taper: (t) => lerp(1, 0.35, t) }));
  }
  if (spec.bun) {
    const knot = new THREE.SphereGeometry(0.052 * R / 0.098, 10, 8);
    knot.scale(1, 0.85, 0.9);
    const at = shellPt(Math.PI, 0.92);
    knot.translate(at.x, at.y + 0.01, at.z - 0.01);
    parts.push(knot);
  }
  if (spec.strands) {
    for (let k = 0; k < spec.strands; k++) {
      const a = Math.PI - ((k + 0.5) / spec.strands) * TAU;
      if (Math.cos(a) > 0.45) continue;                    // never over the face
      const root = shellPt(a, lineAt(a) + 0.06);
      const out = root.clone().sub(centre).setY(0).normalize();
      const len = (0.16 + (spec.curtain || 0.3) * 0.22) * (R / 0.098);
      const tip = root.clone().add(V(out.x * 0.02, -len, out.z * 0.02));
      parts.push(sweep([root, root.clone().lerp(tip, 0.5).addScaledVector(out, 0.012), tip],
        { radius: 0.011 * R / 0.098, radial: 5, steps: 6, taper: (t) => lerp(1, 0.6, t) }));
    }
  }
  return merge(parts);
}

/**
 * A beard is volume, not just paint. The shell is a smooth patch over the jaw whose
 * thickness fades to nothing at its own boundary, so the silhouette blends into the
 * face and the painted moustache and stubble carry the edges. Its top line dips
 * below the mouth at the front and climbs to the sideburns at the sides.
 */
function buildBeardShell(centre, R, S, X) {
  const cov = X.beard.coverage;
  if (cov < 0.45) return null;
  const NU = 22, NV = 8;
  const aMax = Math.acos(0.40);
  const vTop = (f) => 0.150 + 0.667 * (1 - f);              // f = cos(a)
  const vBot = (f) => 0.030 + 0.080 * (1 - f);
  const pos = [], uvs = [], idx = [];
  for (let j = 0; j <= NV; j++) {
    const tv = j / NV;
    for (let i = 0; i <= NU; i++) {
      const tu = i / NU;
      const a = lerp(aMax, -aMax, tu);
      const f = Math.cos(a);
      const v = lerp(vBot(f), vTop(f), tv);
      const base = headSurface(a, v, R, S);
      const nrm = base.clone().normalize();
      // fade to zero thickness on every edge of the patch
      const fadeU = smoothstep(clamp(Math.min(tu, 1 - tu) / 0.16, 0, 1));
      const fadeV = smoothstep(clamp(Math.min(tv, 1 - tv) / 0.22, 0, 1));
      const bulk = lerp(0.55, 1, smoothstep(clamp((0.55 - tv) / 0.55, 0, 1)));
      const t = 0.0008 + cov * 0.019 * (R / 0.098) * fadeU * fadeV * bulk;
      const p = base.addScaledVector(nrm, t).add(centre);
      pos.push(p.x, p.y, p.z);
      uvs.push(tu * 2, tv);
    }
  }
  const w = NU + 1;
  for (let j = 0; j < NV; j++) {
    for (let i = 0; i < NU; i++) {
      const A = j * w + i, B = A + w;
      idx.push(A, B, A + 1, B, B + 1, A + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** Parametric two-sided sheet — brims and peaks. */
function sheet(fn, NU, NV, uvFn) {
  const pos = [], uvs = [], idx = [];
  for (let j = 0; j <= NV; j++) {
    for (let i = 0; i <= NU; i++) {
      const p = fn(i / NU, j / NV);
      pos.push(p.x, p.y, p.z);
      const t = uvFn ? uvFn(i / NU, j / NV) : [i / NU, j / NV];
      uvs.push(t[0], t[1]);
    }
  }
  const w = NU + 1;
  const back = [];
  for (let j = 0; j < NV; j++) {
    for (let i = 0; i < NU; i++) {
      const A = j * w + i, B = A + w;
      idx.push(A, B, A + 1, B, B + 1, A + 1);
      back.push(A + 1, B, A, B + 1, B, A + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  // Normals FIRST, from the front winding only. Indexing both windings before
  // computeVertexNormals makes every face normal cancel its twin, leaves the
  // sheet with zero-length normals and renders it dead black.
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.setIndex(idx.concat(back));
  return geo;
}

/**
 * A closed thin slab swept off a parametric surface: a front face, a back face
 * offset along the surface normal, and a sealed rim. Unlike `sheet` it has real
 * thickness, so a cap peak catches a highlight on top and goes dark underneath.
 */
function slab(fn, NU, NV, thick, uvFn) {
  const eps = 0.004;
  const P = (u, v) => fn(clamp(u, 0, 1), clamp(v, 0, 1));
  const nAt = (u, v) => {
    const du = P(u + eps, v).sub(P(u - eps, v));
    const dv = P(u, v + eps).sub(P(u, v - eps));
    const n = du.cross(dv);
    return n.lengthSq() < 1e-14 ? V(0, 1, 0) : n.normalize();
  };
  const pos = [], uvs = [], idx = [];
  const w = NU + 1, N = w * (NV + 1);
  for (const layer of [0, 1]) {
    for (let j = 0; j <= NV; j++) {
      for (let i = 0; i <= NU; i++) {
        const u = i / NU, v = j / NV;
        const p = P(u, v).addScaledVector(nAt(u, v), layer ? -thick : 0);
        pos.push(p.x, p.y, p.z);
        const t = uvFn ? uvFn(u, v) : [u, v];
        uvs.push(t[0], t[1] * (layer ? 0.92 : 1));
      }
    }
  }
  for (let j = 0; j < NV; j++) {
    for (let i = 0; i < NU; i++) {
      const A = j * w + i, B = A + w;
      idx.push(A, B, A + 1, B, B + 1, A + 1);
      const C = A + N, D = B + N;
      idx.push(C, C + 1, D, D, C + 1, D + 1);
    }
  }
  const edge = [];
  for (let i = 0; i <= NU; i++) edge.push(NV * w + i);
  for (let j = NV; j >= 0; j--) edge.push(j * w + NU);
  for (let i = NU; i >= 0; i--) edge.push(i);
  for (let j = 0; j <= NV; j++) edge.push(j * w);
  for (let k = 0; k < edge.length - 1; k++) {
    const a = edge[k], b = edge[k + 1];
    if (a === b) continue;
    idx.push(a, b, a + N, b, b + N, a + N);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/**
 * ONE EYELID, as real geometry with real thickness.
 *
 * A face texture alone reads dead at any close framing: the painted eye has no
 * self-shadow, so the lids have no edge and the globe has no depth. This builds
 * the lid as a slab lying over the orbit — its lash edge stands ~3 mm proud of
 * the eye and rolls back into the crease, so the upper lid casts a real shadow
 * across the top of the globe and the lower lid catches a real light on its rim.
 * The aperture between the two is left open onto the painted eye underneath.
 */
function buildEyelid(centre, R, S, side, lower) {
  // FL.eye ± 0.024 is the painted opening (a 5.4 mm half-height on a 221 mm
  // head), so the lash edges are authored to land exactly on it.
  const dE = FL.eyeDX, wA = FL.eyeW * 1.20;
  // The painted aperture is 5.4 mm half-height on a 221 mm head = 0.0236 in `t`.
  // The lash edge is authored just clear of it: a lid that overlaps the opening
  // reads as a half-closed eye, not as a lid.
  const tLash = lower ? -0.0272 : 0.0288;
  const tBack = lower ? -0.0470 : 0.0510;
  const geom = (u, v) => {
    const uu = clamp(u, 0, 1), vv = clamp(v, 0, 1);
    const a = side * (dE + (uu - 0.5) * 2 * wA) * TAU;
    const arc = Math.pow(Math.sin(Math.PI * clamp(uu * 0.92 + 0.04, 0, 1)), 0.55);
    const t = FL.eye + lerp(tLash * arc, lerp(tBack * 0.55, tBack, arc), vv);
    const p = headSurface(a, t, R, S);
    const n = p.clone().normalize();
    // Proud at the lash line, flush at the crease AND flush at both canthi — a
    // lid that keeps its thickness into the corners leaves a 2 mm step there,
    // and the whole thing reads as a plate laid on the face instead of a lid.
    const out = lerp(lower ? 0.014 : 0.021, -0.003, smoothstep(vv) ** 0.7) * R
      * smoothstep(clamp(arc * 1.35, 0, 1));
    return p.addScaledVector(n, out).add(centre);
  };
  // Painted from the plain SKIN band, not FACE: FACE at the lid's own station is
  // sclera, and one crease higher is eyebrow — either one lands a stripe on the
  // eyelid. The form here is entirely geometric, which is the point.
  return slab(geom, 14, 3, (lower ? 0.010 : 0.013) * R, (u, v) => [u, 0.42 + v * 0.16]);
}

/** Cap (forwards or backwards) and beanie. Returns null for helmet / none. */
function buildLid(centre, R, S, X) {
  const style = X.lid.style;
  if (style !== 'cap' && style !== 'capBackwards' && style !== 'beanie') return null;
  const beanie = style === 'beanie';
  const backwards = style === 'capBackwards';
  const NU = 26, NV = beanie ? 8 : 6;
  const lowV = beanie ? 0.600 : backwards ? 0.640 : 0.632;
  // Headwear rides ON the hair: the shell stands off the skull by its own
  // thickness PLUS whatever the chosen cut puts under it, so a cap on an afro
  // sits high and a cap on a buzz sits tight, and neither one clips through.
  const thick = (beanie ? 0.017 : 0.010) * (R / 0.098) + hairThickness(X, R) * 1.05;
  const parts = [];
  // a cap band rides across the forehead just above the brow and drops at the
  // sides and the nape
  // worn backwards the band rides up off the brow and drops at the nape
  // A cap worn backwards sits BACK: its front edge clears the hairline by a good
  // 25 mm so a whole band of hair shows above the brow. At 0.098 it landed on the
  // hairline itself and the rider read as shaved under the lid.
  const lineAt = (a) => lowV + (beanie ? 0.070 : backwards ? 0.172 : 0.058) * Math.max(0, Math.cos(a))
    - (beanie ? 0.028 : backwards ? 0.048 : 0.030) * Math.max(0, -Math.cos(a));
  const shell = (a, v) => {
    const base = headSurface(a, v, R, S);
    const nrm = base.clone().normalize();
    const puff = beanie ? 1 + 0.10 * smoothstep(clamp((v - 0.72) / 0.28, 0, 1)) : 1.0;
    // six panels joined by raised seams, and a crown that sits a touch flatter
    // than the skull under it — a cap is stitched, not shrink-wrapped
    const seam = beanie ? 0 : 0.0026 * R / 0.098 * Math.pow(Math.abs(Math.cos(3 * a)), 14);
    const crown = beanie ? 0 : -0.010 * R / 0.098 * smoothstep(clamp((v - 0.88) / 0.12, 0, 1));
    return base.multiplyScalar(puff).addScaledVector(nrm, thick + seam + crown).add(centre);
  };
  const pos = [], uvs = [], idx = [];
  for (let j = 0; j <= NV; j++) {
    for (let i = 0; i <= NU; i++) {
      const a = Math.PI - (i / NU) * TAU;
      const v = lerp(lineAt(a), 1, j / NV);
      const p = shell(a, v);
      pos.push(p.x, p.y, p.z);
      uvs.push(i / NU, j / NV);
    }
  }
  const w = NU + 1;
  for (let j = 0; j < NV; j++) {
    for (let i = 0; i < NU; i++) {
      const A = j * w + i, B = A + w;
      idx.push(A, B, A + 1, B, B + 1, A + 1);
    }
  }
  const rimStart = pos.length / 3;
  const inset = hairThickness(X, R) * 0.92;
  for (let i = 0; i <= NU; i++) {
    const a = Math.PI - (i / NU) * TAU;
    const base = headSurface(a, lineAt(a), R, S);
    // the rolled edge closes onto the HAIR, not the scalp, so a cap never skirts
    // down through a thick cut
    const inner = base.addScaledVector(base.clone().normalize(), inset).add(centre);
    pos.push(inner.x, inner.y, inner.z);
    uvs.push(i / NU, -0.06);
  }
  for (let i = 0; i < NU; i++) {
    const A = i, B = A + 1, C = rimStart + i, D = C + 1;
    idx.push(A, C, B, C, D, B);
  }
  const crown = new THREE.BufferGeometry();
  crown.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  crown.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  crown.setIndex(idx);
  crown.computeVertexNormals();
  parts.push(crown);

  if (beanie) {
    // turn-up band around the bottom edge
    const band = sheet((u, t) => {
      const a = -Math.PI + u * TAU;
      const v = lerp(lineAt(a) - 0.055, lineAt(a) + 0.075, t);
      const base = headSurface(a, clamp(v, 0.02, 0.99), R, S);
      const nrm = base.clone().normalize();
      return base.addScaledVector(nrm, thick * 1.7).add(centre);
    }, NU, 3, (u, t) => [u * 2, t * 0.35]);
    parts.push(band);
  } else {
    // brim: a curved visor with real thickness, swept out of the band
    const back = style === 'capBackwards';
    const dir = back ? Math.PI : 0;
    const span = 62 * DEG;
    const len = (back ? 0.100 : 0.125) * (R / 0.098);
    // The peak projects along ONE direction and fans, it does not follow the band
    // round the skull: deriving `out` from each column's own azimuth sent the two
    // corners of the peak shooting sideways past the ears as a pair of black wings.
    const outC = V(Math.sin(dir), -0.16, Math.cos(dir)).normalize();
    const outS = V(Math.cos(dir), 0, -Math.sin(dir));
    const brim = slab((u, t) => {
      const s = (u - 0.5) * 2;                             // -1 … 1 across the peak
      const a = dir + s * span;
      const v = lineAt(a) + 0.030;
      const base = shell(a, v);
      const out = outC.clone().addScaledVector(outS, s * 0.30).normalize();
      // the peak is shorter at its corners and curls down along its length
      const reach = len * t * (1 - 0.30 * s * s);
      const droop = (back ? 0.20 : 0.42) * t * t;
      const curl = 0.055 * (R / 0.098) * s * s * t;        // side-to-side curve
      return base.addScaledVector(out, reach)
        .add(V(0, -len * droop - curl, 0));
    }, 18, 4, 0.0075 * (R / 0.098), (u, t) => [0.10 + u * 0.80, 0.80 + t * 0.18]);
    parts.push(brim);
    // crown button
    const btn = new THREE.SphereGeometry(0.012 * (R / 0.098), 8, 6);
    const top = shell(0, 0.999);
    btn.scale(1, 0.7, 1);
    btn.translate(top.x, top.y + 0.004, top.z);
    parts.push(btn);
  }
  return merge(parts);
}

// ---------------------------------------------------------------------------
// rider: hands and shoes — the two parts a close camera always lands on
// ---------------------------------------------------------------------------

/**
 * A frame for a hand on a bar. Deliberately NOT `frameOf`: that derives its third
 * axis with a cross product, which flips sign between the left and the right bar,
 * so one hand came out built inside-out — the reason one palm floated above its
 * grip and the other let the bar-end cap punch through it. `up` and `fwd` here are
 * always world-up-ish and world-forward-ish for BOTH hands.
 */
function fistFrame(barDir) {
  const along = barDir.clone().normalize();
  const up = new THREE.Vector3(0, 1, 0).addScaledVector(along, -along.y);
  if (up.lengthSq() < 1e-8) up.set(0, 0, 1).addScaledVector(along, -along.z);
  up.normalize();
  const fwd = new THREE.Vector3(0, 0, 1)
    .addScaledVector(along, -along.z).addScaledVector(up, -up.z);
  if (fwd.lengthSq() < 1e-8) fwd.set(1, 0, 0).addScaledVector(along, -along.x).addScaledVector(up, -up.x);
  fwd.normalize();
  return { along, up, fwd };
}

/** The angle the wrist leaves the grip at, measured from +up toward +fwd. */
const FIST_WRIST_DEG = -74;

/**
 * Where the WRIST BONE has to sit for a fist of this size to be closed on a grip
 * of this radius at this point along it. This is the IK: the hand is placed from
 * the GRIP transform and the arm is then solved to reach it, instead of the hand
 * being hung off the end of the arm chain and hoping it lands on the bar.
 * `riderPose` and `buildFist` both call it, so they cannot disagree.
 */
function fistWrist(gripPoint, barDir, handR, curlR) {
  const F = fistFrame(barDir);
  const r = curlR + handR * 0.40;
  const a = FIST_WRIST_DEG * DEG;
  return gripPoint.clone()
    .addScaledVector(F.along, -handR * 0.62)
    .addScaledVector(F.up, Math.cos(a) * r)
    .addScaledVector(F.fwd, Math.sin(a) * r);
}

/**
 * A closed fist on a bar, built as ONE continuous shell wrapped around the grip.
 *
 * The previous version stacked four separate finger tubes, four knuckle spheres
 * and a flattened "back of the hand" capsule on top of each other. At macro
 * framing that read as a rack of dark blades with pale nubs floating over the
 * forearm — the fingers had no palm behind them, so every gap between them was a
 * hole straight through to shadow, and nothing connected the digits to the hand.
 *
 * Instead this lofts a surface over the grip cylinder in (s, a): `s` runs index →
 * pinky ACROSS the hand, `a` runs from the heel of the palm, over the back, round
 * the knuckle row, down the front and under to the fingertips. The radius is the
 * grip radius plus a flesh thickness that carries the dorsum, the knuckle heads,
 * the phalanx creases and the inter-finger grooves. Because the grooves are a
 * modulation of one surface rather than a gap between four, the fist is solid:
 * the fingers separate where a real hand's do and merge into the palm where a
 * real hand's do, and the grip cannot show through anywhere.
 *
 * The thumb is a separate sweep coming round the inboard side and lying across
 * the front of the index finger, so the hand visibly CLOSES on the bar.
 * Returns the shell and, separately, the glove's wrist cuff.
 */
function buildFist(wrist, barDir, handR, glove, barR, gripPoint, side) {
  const F = fistFrame(barDir);
  const { along, up, fwd } = F;
  const parts = [];
  const gT = glove ? handR * 0.095 : handR * 0.040;
  const curlR = barR + gT;
  // work in the GRIP's frame; the wrist is wherever fistWrist put it
  const G = gripPoint ? gripPoint.clone() : fistWrist(wrist, barDir, handR, curlR);
  const at = (sa, degA, r) => G.clone()
    .addScaledVector(along, sa)
    .addScaledVector(up, Math.cos(degA * DEG) * r)
    .addScaledVector(fwd, Math.sin(degA * DEG) * r);

  const gs = (x, w) => Math.exp(-((x / w) * (x / w)));
  // hand breadth across the knuckles ≈ 73 mm on a 1.78 m rider
  const sIn = -handR * 0.42, sOut = handR * 1.36;
  const A0 = -118, AK = 4, A1 = 210;      // palm heel → knuckle row → tips, tucked

  /** flesh over the grip, in handR units, at lane `s` and wrap angle `a`. */
  const thick = (s, a) => {
    let t;
    if (a < AK) {
      // dorsum: thin over the metacarpal heads, thickening into the palm heel
      const k = clamp((AK - a) / (AK - A0), 0, 1);
      t = lerp(0.40, 0.70, smoothstep(k));
    } else {
      // proximal → middle → distal phalanx, with a real crease at each joint
      const k = clamp((a - AK) / (A1 - AK), 0, 1);
      t = lerp(0.47, 0.225, smoothstep(k) ** 0.72);
      t -= 0.060 * gs(a - 84, 15);                      // PIP crease
      t -= 0.048 * gs(a - 158, 15);                     // DIP crease
    }
    // knuckle heads: one bony dome per lane, standing proud of the dorsum
    let kn = 0;
    for (let k = 0; k < 4; k++) kn = Math.max(kn, gs(s - (k + 0.5) / 4, 0.082));
    t += (glove ? 0.150 : 0.115) * gs(a - 12, 24) * (0.42 + 0.58 * kn);
    // index side carries the mass, the pinky lane is visibly slimmer and shorter
    t *= lerp(1.06, 0.82, clamp((s - 0.26) / 0.74, 0, 1));
    // the outer two fingers do not reach as far round the bar
    t *= 1 - 0.30 * smoothstep(clamp((a - 150) / 60, 0, 1)) * smoothstep(clamp((s - 0.55) / 0.45, 0, 1));
    return t;
  };
  /** the valleys between the digits — zero across the palm, deep past the knuckles */
  const groove = (s, a) => {
    const open = smoothstep(clamp((a - AK) / 50, 0, 1));
    let g = 0;
    for (let k = 1; k <= 3; k++) g = Math.max(g, gs(s - k / 4, 0.055));
    return g * open * 0.150;
  };

  const NS = 20, NA = 30;
  const pos = [], uvs = [], idx = [];
  // One extra ring outside each border drops the surface onto the grip, so the
  // shell is closed at the index edge, the pinky edge, the heel and the tips.
  for (let j = -1; j <= NA + 1; j++) {
    const qa = clamp(j / NA, 0, 1);
    const a = lerp(A0, A1, qa);
    const sealA = (j < 0 || j > NA) ? 0 : 1;
    for (let i = -1; i <= NS + 1; i++) {
      const s = clamp(i / NS, 0, 1);
      const sealS = (i < 0 || i > NS) ? 0 : 1;
      const seal = sealA * sealS;
      const r = curlR + handR * Math.max(0, thick(s, a) - groove(s, a)) * seal;
      const p = at(lerp(sIn, sOut, s), a, r);
      pos.push(p.x, p.y, p.z);
      // v walks the wrap so the SKIN band's warm extremity lands on the
      // fingertips; a glove wants its closure strap at the wrist instead.
      uvs.push(0.06 + s * 0.88, glove ? 1 - qa * 0.94 : 0.03 + qa * 0.94);
    }
  }
  const w = NS + 3;
  for (let j = 0; j < NA + 2; j++) {
    for (let i = 0; i < NS + 2; i++) {
      const a = j * w + i, b = a + w;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const shell = new THREE.BufferGeometry();
  shell.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  shell.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  shell.setIndex(idx);
  shell.computeVertexNormals();
  parts.push(shell);

  // --- thenar: the ball of muscle at the base of the thumb -------------------
  const tA = at(sIn - handR * 0.10, -84, curlR + handR * 0.34);
  const tB = at(sIn + handR * 0.06, -20, curlR + handR * 0.40);
  parts.push(placeZ(capsule2(tA.distanceTo(tB), handR * 0.30, handR * 0.34, {
    radial: 10, capSegs: 3, shape: () => [0.70, 1.10],
  }), tA, tB, up));

  // --- thumb: round the inboard side, pad across the front of the index ------
  const th = handR * 0.245;
  parts.push(sweep([
    at(sIn - handR * 0.18, -60, curlR + handR * 0.50),
    at(sIn - handR * 0.10, -4, curlR + handR * 0.46),
    at(sIn + handR * 0.16, 52, curlR + handR * 0.40),
    at(sIn + handR * 0.60, 104, curlR + handR * 0.33),
  ], { radius: th, radial: 8, steps: 10, taper: (k) => lerp(1.16, 0.72, k),
    oval: (k) => [lerp(0.92, 0.86, k), 1] }));

  // --- wrist cuff: a real closure band, not a bare tube end ------------------
  const cuffDir = G.clone().sub(wrist);
  if (cuffDir.lengthSq() < 1e-9) cuffDir.copy(along);
  cuffDir.normalize();
  const cuff = placeZ(capsule2(handR * 0.60, handR * 0.46, handR * 0.52, {
    radial: 12, capSegs: 2, capA: 0.35, capB: 0.35, shape: () => [1.14, 0.86],
  }), wrist.clone().addScaledVector(cuffDir, -handR * 0.46),
  wrist.clone().addScaledVector(cuffDir, handR * 0.14), up);
  void side;

  return { shell: merge(parts), cuff };
}

/**
 * A skate shoe: moulded sole with a raised heel and a toe bumper, an upper with
 * a real toe box, a padded collar, a tongue and four crossed laces.
 * Returns the parts split by atlas region.
 */
function buildShoe(ankle, toe, hs, X, side) {
  const bulk = lerp(0.92, 1.14, X.shoe.bulk);
  const high = X.shoe.high;
  const F = frameOf(toe.clone().sub(ankle).setY(toe.y - ankle.y), V(0, 1, 0));
  const fwd = F.y;                                        // heel → toe
  const up = F.z;
  const side3 = F.x;
  const foot = ankle.distanceTo(toe);
  const heel = ankle.clone().addScaledVector(fwd, -foot * 0.42).addScaledVector(up, -0.052 * hs);
  const tip = toe.clone().addScaledVector(fwd, foot * 0.16).addScaledVector(up, -0.030 * hs);
  const len = heel.distanceTo(tip);
  // the atlas expects u = 0.5 on the instep, which means the capsules are laid
  // out with their local +Z pointing DOWN
  const down = up.clone().negate();
  const upper = [], sole = [], lace = [];

  // --- upper: heel counter → instep → toe box -------------------------------
  upper.push(placeZ(capsule2(len, 0.050 * hs * bulk, 0.036 * hs * bulk, {
    radial: 12, capSegs: 3, bodyRings: 6, capA: 0.75, capB: 0.55,
    // low over the instep, swelling again into the toe box
    mid: (t) => (1 - 0.16 * Math.exp(-(((t - 0.45) / 0.20) ** 2))) * bulge(t, 0.82, 0.16, 0.10),
    shape: (t) => [lerp(1.00, 0.86, t), lerp(0.92, 1.12, smoothstep(t))],
  }), heel.clone().addScaledVector(up, 0.030 * hs), tip.clone().addScaledVector(up, 0.020 * hs), down));
  // padded collar around the ankle
  const cH = lerp(0.030, 0.070, high) * hs;
  upper.push(placeZ(capsule2(cH, 0.055 * hs * bulk, 0.050 * hs * bulk, {
    radial: 10, capSegs: 2, shape: () => [0.86, 1.0],
  }), ankle.clone().addScaledVector(up, -0.030 * hs).addScaledVector(fwd, -0.010 * hs),
  ankle.clone().addScaledVector(up, cH).addScaledVector(fwd, -0.004 * hs), fwd));
  // tongue, tucked under the laces
  upper.push(placeZ(capsule2(0.062 * hs, 0.030 * hs, 0.026 * hs, {
    radial: 8, capSegs: 2, shape: () => [0.42, 1.0],
  }), ankle.clone().addScaledVector(fwd, 0.010 * hs).addScaledVector(up, 0.012 * hs),
  ankle.clone().addScaledVector(fwd, 0.070 * hs).addScaledVector(up, 0.030 * hs), down));

  // --- sole: midsole slab + outsole lip + toe bumper -------------------------
  const sA = heel.clone().addScaledVector(up, -0.004 * hs);
  const sB = tip.clone().addScaledVector(up, -0.002 * hs).addScaledVector(fwd, -0.004 * hs);
  sole.push(placeZ(capsule2(sA.distanceTo(sB), 0.042 * hs * bulk, 0.034 * hs * bulk, {
    radial: 10, capSegs: 2, bodyRings: 4, capA: 0.5, capB: 0.5,
    shape: (t) => [lerp(1.14, 1.02, t), lerp(0.44, 0.40, t)],
  }), sA, sB, down));
  // heel wedge
  sole.push(placeZ(capsule2(0.052 * hs, 0.040 * hs * bulk, 0.038 * hs * bulk, {
    radial: 8, capSegs: 2, shape: () => [1.10, 0.34],
  }), heel.clone().addScaledVector(up, -0.012 * hs).addScaledVector(fwd, -0.006 * hs),
  heel.clone().addScaledVector(up, -0.012 * hs).addScaledVector(fwd, 0.046 * hs), down));
  // Midsole band: a real proud ring around the whole shoe between the outsole and
  // the upper. It is what gives a skate shoe its horizontal read — without it the
  // shoe is one continuous blob with a dark bottom.
  const mA = heel.clone().addScaledVector(up, 0.012 * hs).addScaledVector(fwd, -0.002 * hs);
  const mB = tip.clone().addScaledVector(up, 0.014 * hs).addScaledVector(fwd, -0.002 * hs);
  sole.push(placeZ(capsule2(mA.distanceTo(mB), 0.046 * hs * bulk, 0.038 * hs * bulk, {
    radial: 12, capSegs: 2, bodyRings: 4, capA: 0.5, capB: 0.5,
    mid: (t) => 1 + 0.05 * Math.sin(t * Math.PI),
    shape: (t) => [lerp(1.10, 1.00, t), lerp(0.30, 0.28, t)],
  }), mA, mB, down));
  // toe bumper: the vulcanised cap that takes the pedal
  const tA = tip.clone().addScaledVector(fwd, -0.030 * hs).addScaledVector(up, 0.004 * hs);
  const tB = tip.clone().addScaledVector(fwd, 0.004 * hs).addScaledVector(up, 0.006 * hs);
  sole.push(placeZ(capsule2(tA.distanceTo(tB), 0.042 * hs * bulk, 0.034 * hs * bulk, {
    radial: 12, capSegs: 3, capA: 0.4, capB: 0.8, shape: () => [1.02, 0.66],
  }), tA, tB, down));

  // --- laces -----------------------------------------------------------------
  for (let i = 0; i < 4; i++) {
    const t = i / 3;
    const s = lerp(0.020, 0.072, t) * hs;
    const rr = lerp(0.030, 0.024, t) * hs;
    const base = ankle.clone().addScaledVector(fwd, s).addScaledVector(up, lerp(0.016, 0.030, t) * hs);
    for (const dir of [-1, 1]) {
      lace.push(sweep([
        base.clone().addScaledVector(side3, dir * rr).addScaledVector(up, -0.008 * hs),
        base.clone().addScaledVector(side3, dir * rr * 0.35).addScaledVector(up, 0.008 * hs),
        base.clone().addScaledVector(side3, -dir * rr * 0.30).addScaledVector(fwd, 0.014 * hs)
          .addScaledVector(up, 0.006 * hs),
      ], { radius: 0.0042 * hs, radial: 5, steps: 4 }));
    }
  }
  return { upper: merge(upper), sole: merge(sole), lace: merge(lace) };
}

// ---------------------------------------------------------------------------
// rider: the one skinned body mesh
// ---------------------------------------------------------------------------

const LEFT = V(-1, 0, 0);

function buildRiderBody(pose, boneIndex, X, A) {
  const M = X.M, L = pose.L;
  const hs = M.heightScale;
  const parts = [];
  const push = (geo, key, skin, u0 = 0, u1 = 1) => {
    if (!geo) return;
    A.uv(geo, key, u0, u1);
    if (skin) skin(geo);
    parts.push(geo);
  };
  const limb = (a, b, ra, rb, opts = {}) =>
    placeZ(capsule2(a.distanceTo(b), ra, rb, opts), a, b, opts.zDir || LEFT);

  const girth = M.limbGirth;
  const topLoose = X.top.loose, botLoose = X.bottom.loose;

  // ------------------------------------------------------------------ torso
  const torsoA = pose.hips.clone().addScaledVector(pose.lean, -0.052 * hs);
  const torsoB = pose.neck.clone();
  const torsoLen = torsoA.distanceTo(torsoB);
  const wLo = M.hipWidth * 1.12, wHi = M.shoulderWidth * 1.30;
  const dLo = M.waistDepth * 0.84, dHi = M.chestDepth * 0.80;
  // The hem is a REAL edge loop, not a painted line: the garment steps out by its
  // own thickness above the hip, and the turned-and-stitched edge thickens again
  // right at the hem station, so the top has a visible bottom edge in silhouette.
  const hemT = X.top.style === 'jersey' ? 0.135 : X.top.style === 'hoodie' ? 0.115 : 0.175;
  const clothStep = (0.008 + topLoose * 0.010) * hs;
  const torso = limb(torsoA, torsoB, 0.140 * hs, 0.090 * hs, {
    radial: 20, capSegs: 4, bodyRings: 18,
    // The seat is a FLATTENED cap. At capA = 1 the torso's bottom pole hung a
    // full hip-radius (150 mm) below and behind the hips, so the tee ended in a
    // giant blunt dome instead of a hem — the biggest single silhouette error on
    // the character. capB likewise stops the shoulder yoke ballooning over the neck.
    capA: 0.30, capB: 0.55,
    // hem flare → WAIST → ribcage → the shoulder yoke.
    // The base radius already tapers 140 → 90 mm, so the old profile (0.92 at the
    // waist, 1.16 at the chest) cancelled the taper exactly and left a constant
    // 128 mm barrel from hip to collarbone — no waist at all, which is the single
    // reason the rider read as a potato from every angle. These numbers pinch the
    // section to ~107 mm at the navel and let it open back to ~127 mm at the chest.
    mid: (t) => {
      const base = (t < 0.12 ? lerp(1.02 + topLoose * 0.05, 0.95, smoothstep(t / 0.12))
        : t < 0.38 ? lerp(0.95, 0.875, smoothstep((t - 0.12) / 0.26))
          : t < 0.72 ? lerp(0.875, 1.225, smoothstep((t - 0.38) / 0.34))
            : lerp(1.225, 0.98, smoothstep((t - 0.72) / 0.28))) * (1 + topLoose * 0.05);
      if (X.top.style === 'tank') return base;
      const r = 0.140 * hs;                        // reference radius for the step
      const cov = smoothstep(clamp((t - (hemT - 0.012)) / 0.024, 0, 1));
      const edge = Math.exp(-(((t - hemT - 0.008) / 0.014) ** 2));
      return base * (1 + (clothStep * cov + clothStep * 0.65 * edge) / r);
    },
    shape: (t) => [
      lerp(dLo, dHi, smoothstep(clamp(t * 1.4, 0, 1))),
      lerp(wLo, wHi, smoothstep(clamp((t - 0.10) / 0.75, 0, 1))),
    ],
  });
  if (M.gender === 'female' || M.gender === 'neutral') {
    bustPass(torso, torsoA, torsoB.clone().sub(torsoA), pose.front,
      (M.gender === 'female' ? 0.036 : 0.012) * hs, 0.615, 0.16);
  }
  push(torso, 'TOP', (g) => skinAlong(g, boneIndex, ['hips', 'spine', 'chest', 'neck'],
    [torsoA, pose.spine, pose.chest, torsoB]));

  // collar: a real rolled band around the neck opening, not a painted stripe
  if (X.top.style !== 'tank') {
    const nDir = pose.head.clone().sub(pose.neck).normalize();
    const cR = 0.058 * hs * lerp(0.94, 1.10, M.build) * (X.top.style === 'hoodie' ? 1.18 : 1.0);
    // A tee collar is a rib band, not a cowl: 1.10x the neck and 22 mm tall, or
    // it stands off the throat and reads as a roll-neck under the chin.
    const collar = placeZ(capsule2(0.022 * hs, cR * 1.10, cR * 1.06, {
      radial: 16, capSegs: 2, capA: 0.30, capB: 0.30, shape: () => [1.04, 1.0],
    }), torsoB.clone().addScaledVector(nDir, -0.010 * hs), torsoB.clone().addScaledVector(nDir, 0.012 * hs),
    LEFT);
    // sample only the collar band at the very top of the garment region
    const cu = collar.attributes.uv;
    for (let i = 0; i < cu.count; i++) cu.setXY(i, cu.getX(i), 0.978 + cu.getY(i) * 0.020);
    push(collar, X.top.trimCuff ? 'TRIM' : 'TOP',
      (g) => skinPart(g, boneIndex, 'chest', 'neck', pose.chest, torsoB, 0.2, 1.0, 0.8));
  }

  // ------------------------------------------------------------ neck + head
  const neckR = 0.055 * hs * lerp(0.92, 1.10, M.build) * (M.gender === 'female' ? 0.93 : 1);
  // The neck's root has to run DOWN THE TORSO AXIS, not down the world Y: with the
  // rider pitched forward over the bars a vertical root pushes its cap out through
  // the back of the shirt as a bare patch on the shoulder.
  push(limb(pose.neck.clone().addScaledVector(pose.lean, -0.055 * hs), pose.head.clone().add(V(0, 0.030 * hs, 0)),
    neckR * 1.14, neckR * 0.90, {
      radial: 12, capSegs: 3,
      // trapezius flare at the base, a slight hollow at the throat
      mid: (t) => lerp(1.05, 0.97, smoothstep(clamp(t * 1.35, 0, 1))),
      shape: (t) => [lerp(1.10, 1.00, t), lerp(0.88, 0.98, t)],
    }),
  'SKIN', (g) => skinPart(g, boneIndex, 'neck', 'head', pose.neck, pose.head, 0.2, 1.0, 0.85));

  const headR = L.head;
  const headC = pose.head.clone().add(V(0, headR * 0.86, headR * 0.12));
  const S = { jaw: M.jaw, brow: M.brow, wide: lerp(0.96, 1.06, M.build) };
  push(buildHead(headC, headR, S), 'FACE', (g) => skinPart(g, boneIndex, 'head', null));
  for (const s of [-1, 1]) {
    push(buildEar(headC, headR, S, s), 'SKIN', (g) => skinPart(g, boneIndex, 'head', null), 0.62, 0.86);
    for (const lower of [false, true]) {
      push(buildEyelid(headC, headR, S, s, lower), 'SKIN',
        (g) => skinPart(g, boneIndex, 'head', null), 0.365, 0.425);
    }
  }

  // Under a helmet the hair used to be culled to v > 0.88 — nothing showed, so
  // the lid met bare scalp on a hard geometric seam. The new shell edge sits at
  // v ≈ 0.66 at the front, so hair from 0.62 up peeks out under it and breaks
  // that seam, the way it does on every rider in the reference.
  const lidCover = X.lid.style === 'beanie' ? 0.66 : X.lid.style === 'helmet' ? 0.56 : 0.0;
  push(buildHair(headC, headR, S, X, lidCover), 'HAIR', (g) => skinPart(g, boneIndex, 'head', null));
  push(buildBeardShell(headC, headR, S, X), 'HAIR', (g) => skinPart(g, boneIndex, 'head', null), 0, 0.5);
  push(buildLid(headC, headR, S, X), 'LID', (g) => skinPart(g, boneIndex, 'head', null));

  // hood: a shell sitting on the upper back behind the neck
  if (X.top.hood) {
    const hood = sheet((u, t) => {
      const a = -Math.PI * 0.5 + u * Math.PI;             // wraps the back of the neck
      const r = lerp(0.085, 0.135, t) * hs;
      const along = lerp(-0.02, -0.16, t) * hs;
      const p = pose.neck.clone()
        .addScaledVector(pose.lean, along + 0.02 * hs)
        .add(V(Math.cos(a) * r * 1.15, 0, 0))
        .addScaledVector(pose.front, -Math.abs(Math.sin(a)) * r - 0.03 * hs * t)
        .add(V(0, 0.02 * hs * (1 - t), 0));
      return p;
    }, 12, 4, (u, t) => [u, 0.35 + t * 0.5]);
    push(hood, 'TOP', (g) => skinPart(g, boneIndex, 'chest', 'neck', pose.chest, pose.neck, 0.3, 1.0, 0.55));
  }

  // ------------------------------------------------------------------- arms
  // ONE lofted tube per arm: shoulder root (buried in the torso) → shoulder →
  // elbow → wrist. No internal caps, so no joint rims and no dark voids, and the
  // sleeve is a radius STEP on the same surface rather than a second closed tube
  // sitting on top of the first.
  const sleeveT = X.top.sleeveLen;
  const tank = X.top.style === 'tank';
  for (const [side, s] of [['R', 1], ['L', -1]]) {
    const sh = pose['shoulder' + side], el = pose['elbow' + side], wr = pose['wrist' + side];
    // Real arm cross-sections at 1.78 m: deltoid ø108, elbow ø72, forearm belly
    // ø82, wrist ø52 across the styloids. The wrist is the number that matters —
    // a forearm that stays 80 mm all the way to the hand is the classic sausage.
    const rShoulder = 0.054 * hs * girth, rElbow = 0.0360 * hs * girth;
    const rFore = 0.0385 * hs * M.forearmGirth, rWrist = 0.0250 * hs * M.forearmGirth;

    const dSE = el.clone().sub(sh).normalize(), dEW = wr.clone().sub(el).normalize();
    // Overlap the torso by well over one local radius so the two shells can never
    // separate into a visible junction, whatever the animator does to the arm.
    const rootExt = rShoulder * 1.45;
    const tipExt = rWrist * 0.55;
    const armRoot = sh.clone().addScaledVector(dSE, -rootExt);
    const armTip = wr.clone().addScaledVector(dEW, tipExt);
    const lSE = sh.distanceTo(el), lEW = el.distanceTo(wr);
    const Ltot = rootExt + lSE + lEW + tipExt;
    const tSh = rootExt / Ltot, tEl = (rootExt + lSE) / Ltot, tWr = (Ltot - tipExt) / Ltot;
    // arm fraction f: 0 at the shoulder, 1 at the wrist (what garments measure in)
    const fOf = (t) => clamp((t - tSh) / Math.max(tWr - tSh, 1e-4), -0.4, 1.4);
    const eF = (tEl - tSh) / Math.max(tWr - tSh, 1e-4);          // elbow in arm space

    // Muscle, not pipe: deltoid cap, biceps belly, a narrow elbow, the
    // brachioradialis swell just past it, then a real taper into a flat wrist.
    const flesh = (f) => {
      if (f < eF) {
        const k = clamp(f / eF, -1, 1);
        // deltoid cap high and outboard, biceps/triceps belly at mid-humerus,
        // then a hard narrowing into the epicondyles
        return lerp(rShoulder, rElbow, smoothstep(clamp(k, 0, 1)) ** 0.85)
          * bulge(k, 0.02, 0.26, 0.22 * girth)
          * bulge(k, 0.46, 0.28, 0.11 * girth);
      }
      // just past the elbow the forearm picks up its OWN girth scale
      const k = clamp((f - eF) / (1 - eF), 0, 1.4);
      // The taper is the whole point: cubic-ish so the last third of the forearm
      // really thins, instead of holding girth and butting a fist onto a pipe.
      const belly = lerp(rFore, rWrist, smoothstep(clamp(k, 0, 1)) ** 0.72);
      return lerp(rElbow, belly, smoothstep(clamp(k / 0.20, 0, 1)))
        * bulge(k, 0.17, 0.26, 0.17 * M.forearmGirth);
    };
    // The garment: a 7–13 mm shell, thickening toward its hem where cloth drapes.
    const clothT = (0.0062 + topLoose * 0.0072) * hs;
    const armRadius = (t) => {
      const f = fOf(t);
      let r = flesh(f);
      if (tank || sleeveT <= 0.02) return r;
      // 1 → covered, 0 → bare, with the transition one hem-width wide
      const cov = 1 - smoothstep(clamp((f - (sleeveT - 0.014)) / 0.026, 0, 1));
      r += clothT * cov * lerp(0.72, 1.10, smoothstep(clamp(f / Math.max(sleeveT, 1e-3), 0, 1)));
      // the hem itself is turned and stitched: a visible thickened edge loop
      r += clothT * 0.55 * cov * Math.exp(-(((f - sleeveT + 0.012) / 0.013) ** 2));
      return r;
    };
    const armShape = (t) => {
      const f = fOf(t);
      const el2 = _g(f - eF, 0.10);                       // elbow flattens
      return [1 + 0.06 * _g(f - 0.06, 0.24) - 0.10 * el2, lerp(1.08, 0.94, clamp(f, 0, 1)) + 0.10 * el2];
    };

    // sections: sleeve → cuff trim → skin, in curve-parameter space
    const tOfF = (f) => tSh + f * (tWr - tSh);
    const sleeveKey = tank ? 'TOP' : 'SLEEVE';
    const cuffW = X.top.trimCuff ? 0.055 : 0.0;
    const secs = [];
    if (sleeveT > 0.02) {
      secs.push({ key: sleeveKey, t0: 0, t1: tOfF(Math.max(0, sleeveT - cuffW)), v0: 0.06, v1: 0.98 });
      if (cuffW > 0) {
        secs.push({ key: 'TRIM', t0: tOfF(sleeveT - cuffW), t1: tOfF(sleeveT) });
      }
    }
    if (sleeveT < 0.98) {
      // SKIN is painted with the shaded "into the sleeve" end at high v, so the
      // band is walked backwards: v = 0.96 at the cuff, 0.06 at the wrist.
      secs.push({ key: 'SKIN', t0: sleeveT > 0.02 ? tOfF(sleeveT) : 0, t1: 1,
        v0: 0.96, v1: 0.06 });
    }
    if (!secs.length) secs.push({ key: sleeveKey, t0: 0, t1: 1 });

    const arm = limbTube(A, [armRoot, sh, el, armTip], {
      radial: 16, stepsPer: 12, zDir: LEFT,
      radius: armRadius, shape: armShape, sections: secs,
      capStart: 0.55, capEnd: 0.30, capSegs: 4,
    });
    parts.push(skinAlong(normalise(arm), boneIndex,
      ['chest', 'shoulder' + side, 'elbow' + side, 'wrist' + side],
      [armRoot, sh, el, armTip]));

    // elbow pad
    if (X.pad.elbow) {
      const dir = dSE.clone().add(dEW).normalize();
      const out = V(0, 0, 1).cross(dir).cross(dir).negate().normalize();
      const pA = el.clone().addScaledVector(out, 0.032 * hs).addScaledVector(dir, -0.055 * hs);
      const pB = el.clone().addScaledVector(out, 0.030 * hs).addScaledVector(dir, 0.070 * hs);
      push(limb(pA, pB, 0.050 * hs * girth, 0.044 * hs * girth,
        { radial: 10, capSegs: 3, shape: () => [1.0, 0.62] }), 'PAD',
      (g) => skinPart(g, boneIndex, 'elbow' + side, 'wrist' + side, el, wr, 0.55, 1.0, 0.9));
    }

    // hand: a real fist closed on the grip, gloved or bare — placed by IK off the
    // GRIP transform, not off the arm chain (see buildFist).
    const handKey = X.glove.on ? 'GLOVE' : 'SKIN';
    const handR = pose.handR ?? (0.041 * hs * lerp(0.92, 1.10, M.build));
    const gripAxis = (s > 0 ? pose.gripAxisR : pose.gripAxisL) || V(s, 0.02, -0.08).normalize();
    const gripPoint = (s > 0 ? pose.gripPointR : pose.gripPointL) || wr;
    const hand = buildFist(wr, gripAxis, handR, X.glove.on, pose.gripRadius ?? 0.0176,
      gripPoint, s);
    push(hand.shell, handKey, (g) => skinPart(g, boneIndex, 'wrist' + side, null));
    if (X.glove.on) {
      push(hand.cuff, 'GLOVE', (g) => skinPart(g, boneIndex, 'wrist' + side, null), 0.0, 0.30);
    }
  }

  // ------------------------------------------------------------------- legs
  // Same treatment as the arms: hip root (buried in the pelvis) → hip → knee →
  // ankle as ONE tube, with the trouser as a radius step and the cuff as a
  // thickened edge loop that stacks over the shoe.
  const legT = X.bottom.length;
  for (const [side, s] of [['R', 1], ['L', -1]]) {
    const hp = pose['hip' + side], kn = pose['knee' + side];
    const an = pose['ankle' + side], toe = pose['toe' + side];
    const skinS = (g) => skinPart(g, boneIndex, 'knee' + side, 'ankle' + side, kn, an, 0.68, 1.02, 0.8);
    // Real leg cross-sections at 1.78 m: thigh ø150 at the crotch, knee ø108,
    // calf belly ø112, ankle ø72. The old thigh was ø186 BEFORE the denim shell
    // went on it, which is why both legs read as two white bolsters.
    const rHip = 0.0740 * hs * girth, rKnee = 0.0505 * hs * girth;
    const rCalf = 0.0555 * hs * M.calfGirth, rAnkle = 0.0355 * hs * M.calfGirth;

    const dHK = kn.clone().sub(hp).normalize(), dKA = an.clone().sub(kn).normalize();
    const rootExt = rHip * 0.85;
    const tipExt = rAnkle * 0.60;
    const legRoot = hp.clone().addScaledVector(dHK, -rootExt);
    const legTip = an.clone().addScaledVector(dKA, tipExt);
    const lHK = hp.distanceTo(kn), lKA = kn.distanceTo(an);
    const Ltot = rootExt + lHK + lKA + tipExt;
    const tHp = rootExt / Ltot, tKn = (rootExt + lHK) / Ltot, tAn = (Ltot - tipExt) / Ltot;
    const fOf = (t) => clamp((t - tHp) / Math.max(tAn - tHp, 1e-4), -0.4, 1.4);
    const kF = (tKn - tHp) / Math.max(tAn - tHp, 1e-4);

    // quad mass high on the thigh, a flattened knee, a gastrocnemius belly a
    // third of the way down the shin, then a narrow ankle
    const flesh = (f) => {
      if (f < kF) {
        const k = clamp(f / kF, -1, 1);
        // quadriceps mass sits HIGH and dies away above the knee; the last
        // quarter of the thigh is nearly all bone and tendon
        return lerp(rHip, rKnee, smoothstep(clamp(k, 0, 1)) ** 0.80)
          * bulge(k, 0.16, 0.30, 0.13 * girth);
      }
      // the gastrocnemius belly carries the calf's own girth scale
      const k = clamp((f - kF) / (1 - kF), 0, 1.4);
      const belly = lerp(rCalf, rAnkle, smoothstep(clamp(k, 0, 1)) ** 0.70);
      return lerp(rKnee, belly, smoothstep(clamp(k / 0.18, 0, 1)))
        * bulge(k, 0.22, 0.24, 0.19 * M.calfGirth);
    };
    // Trousers hang: the cloth ignores the calf, breaks over the shoe and gets a
    // real turned cuff. 9–20 mm of shell depending on how loose the cut is.
    const clothT = (0.0055 + botLoose * 0.0090) * hs;
    const legRadius = (t) => {
      const f = fOf(t);
      let r = flesh(f);
      if (legT <= 0.02) return r;
      const cov = 1 - smoothstep(clamp((f - (legT - 0.012)) / 0.022, 0, 1));
      // denim does not follow the leg: it hangs off the quad and off the calf,
      // and it stacks where it lands on the shoe
      const drape = lerp(0.80, 1.15, smoothstep(clamp(f / Math.max(legT, 1e-3), 0, 1)))
        * bulge(f, 0.20, 0.26, 0.10) * bulge(f, kF, 0.07, -0.14);
      r += clothT * cov * drape;
      r += clothT * (X.bottom.cuffed ? 0.35 : 0.60) * cov
        * Math.exp(-(((f - legT + 0.010) / 0.012) ** 2));
      if (X.bottom.cuffed) r -= clothT * 0.45 * cov * smoothstep(clamp((f - legT + 0.06) / 0.05, 0, 1));
      return r;
    };
    const legShape = (t) => {
      const f = fOf(t);
      const kn2 = _g(f - kF, 0.09);
      return [lerp(1.06, 0.94, clamp(f, 0, 1)) + 0.08 * kn2, lerp(1.00, 0.92, clamp(f, 0, 1)) - 0.08 * kn2];
    };

    const tOfF = (f) => tHp + f * (tAn - tHp);
    const secs = [];
    if (legT > 0.02) secs.push({ key: 'BOTTOM', t0: 0, t1: tOfF(legT), v0: 0.03, v1: 0.99 });
    if (legT < 0.98) {
      secs.push({ key: 'SKIN', t0: legT > 0.02 ? tOfF(legT) : 0, t1: 1, v0: 0.96, v1: 0.06 });
    }
    if (!secs.length) secs.push({ key: 'BOTTOM', t0: 0, t1: 1 });

    const leg = limbTube(A, [legRoot, hp, kn, legTip], {
      radial: 16, stepsPer: 12, zDir: LEFT,
      radius: legRadius, shape: legShape, sections: secs,
      capStart: 0.45, capEnd: 0.35, capSegs: 4,
    });
    parts.push(skinAlong(normalise(leg), boneIndex,
      ['hips', 'hip' + side, 'knee' + side, 'ankle' + side], [legRoot, hp, kn, legTip]));

    // knee pad and shin guard
    if (X.pad.knee) {
      const dir = kn.clone().sub(hp).normalize().add(an.clone().sub(kn).normalize()).normalize();
      const out = V(0, 0, 1).cross(dir).cross(dir).negate().normalize();
      const pA = kn.clone().addScaledVector(out, 0.048 * hs).addScaledVector(dir, -0.030 * hs);
      const pB = kn.clone().addScaledVector(out, 0.040 * hs).addScaledVector(dir, 0.150 * hs);
      push(limb(pA, pB, 0.058 * hs * girth, 0.046 * hs * girth,
        { radial: 10, capSegs: 3, shape: () => [1.0, 0.52] }), 'PAD', skinS);
    }
    if (X.pad.shin) {
      const dir = an.clone().sub(kn).normalize();
      const out = V(0, 0, 1).cross(dir).cross(dir).negate().normalize();
      const pA = kn.clone().lerp(an, 0.42).addScaledVector(out, 0.040 * hs);
      const pB = an.clone().addScaledVector(out, 0.030 * hs).addScaledVector(dir, 0.010 * hs);
      push(limb(pA, pB, 0.050 * hs * girth, 0.042 * hs * girth,
        { radial: 10, capSegs: 3, shape: () => [1.0, 0.48] }), 'PAD', skinS);
    }

    // shoe: moulded sole, upper with a toe box, collar, tongue and laces
    const shoe = buildShoe(an.clone().add(V(0, -0.026 * hs, 0)), toe, hs, X, s);
    const skinFoot = (g) => skinPart(g, boneIndex, 'ankle' + side, 'toe' + side, an, toe, 0.55, 1.0, 0.6);
    push(shoe.upper, 'SHOE', skinFoot);
    push(shoe.sole, 'SOLE', skinFoot);
    push(shoe.lace, 'SHOE', skinFoot, 0.465, 0.535);
  }

  return merge(parts);
}

// ---------------------------------------------------------------------------
// rider: helmet with real vents, peak, goggles
// ---------------------------------------------------------------------------

function surfPoint(centre, th, ph, r, s) {
  return V(
    centre.x + Math.sin(ph) * Math.sin(th) * s[0] * r,
    centre.y + Math.cos(ph) * s[1] * r,
    centre.z + Math.sin(ph) * Math.cos(th) * s[2] * r,
  );
}

const _qa = new THREE.Vector3(), _qb = new THREE.Vector3(), _qn = new THREE.Vector3();

/**
 * Hand-built quad surface with winding forced to face `ref`.
 *
 * The winding fix swaps corners b and d — and their UVs HAVE TO travel with
 * them. They did not, so every quad whose winding needed flipping got its
 * texture transposed about the diagonal. On the helmet shell that is every
 * single quad: it is why the decal type came out mirrored, why it landed on the
 * wrong faces, and why a stray block of the atlas showed up as a "grey patch"
 * on the left of the shell.
 */
function quadSoup() {
  const pos = [], uv = [];
  return {
    pos, uv,
    add(a, b, c, d, uvs, ref) {
      const [u0, v0, u1, v1] = uvs;
      let ub = [u1, v0], ud = [u0, v1];
      const ua = [u0, v0], uc = [u1, v1];
      if (ref) {
        _qa.copy(b).sub(a); _qb.copy(c).sub(a);
        _qn.copy(_qa).cross(_qb);
        if (_qn.dot(ref) < 0) {
          const t = b; b = d; d = t;
          const tu = ub; ub = ud; ud = tu;
        }
      }
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
      pos.push(a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z);
      uv.push(ua[0], ua[1], ub[0], ub[1], uc[0], uc[1]);
      uv.push(ua[0], ua[1], uc[0], uc[1], ud[0], ud[1]);
    },
    geometry() {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.computeVertexNormals();
      return normalise(g);
    },
  };
}

/**
 * A BMX park lid, not a salad bowl. Measured against the skull `headSurface`
 * builds: outer half-width 1.085 x 0.90 = 0.977 R0 against a head half-width of
 * ~0.83 R0, i.e. 1.18x head width — inside the real 1.10–1.20 range and less
 * than half the 2.1x we shipped. `phiMax` is solved so the lower edge sits just
 * ABOVE the brow at the front (head height v ≈ 0.66), just above the ear at the
 * sides (v ≈ 0.63) and down over the occiput at the back (v ≈ 0.44) — the old
 * edge came down to eye level at the front and buried the face.
 */
function buildHelmet(headC, R0, AM) {
  const R = R0 * 1.085, T = R0 * 0.075;
  const NU = 48, NV = 14;
  const S = [0.915, 1.13, 1.06];
  // Solved, not guessed: y = cos(ph) * S[1] * R against the skull's own
  // y = (2v - 1) * 1.128 * R0 puts the lower edge at head height v = 0.645 at the
  // front (15 mm of forehead below it, above the brow at 0.578), v = 0.605 at the
  // sides (just clear of the ear top at 0.615) and v = 0.44 over the occiput.
  const phiMax = (th) => 1.4425 - 0.210 * Math.cos(th) + 0.0675 * Math.cos(2 * th);
  const slots = [[0, 3.4, 0.10, 0.40], [20, 3.2, 0.26, 0.62], [42, 3.0, 0.30, 0.66],
    [66, 2.8, 0.36, 0.60], [150, 3.4, 0.24, 0.52], [180, 3.6, 0.18, 0.42]];
  const angDiff = (a, b) => {
    const d = Math.abs(a - b) % TAU;
    return d > Math.PI ? TAU - d : d;
  };
  const isVent = (th, v) => {
    for (const [deg, hw, v0, v1] of slots) {
      if (v < v0 || v > v1) continue;
      const w = hw * DEG;
      if (angDiff(th, deg * DEG) < w || angDiff(th, -deg * DEG) < w) return true;
    }
    return false;
  };
  const solid = [];
  for (let i = 0; i < NU; i++) {
    solid[i] = [];
    for (let j = 0; j < NV; j++) {
      const th = ((i + 0.5) / NU) * TAU;
      solid[i][j] = !isVent(th, (j + 0.5) / NV);
    }
  }
  const P = (i, j, r) => {
    const th = (i / NU) * TAU;
    return surfPoint(headC, th, (j / NV) * phiMax(th), r, S);
  };

  const outer = quadSoup(), inner = quadSoup(), walls = quadSoup();
  for (let i = 0; i < NU; i++) {
    for (let j = 0; j < NV; j++) {
      if (!solid[i][j]) continue;
      const u0 = i / NU, u1 = (i + 1) / NU, v0 = j / NV, v1 = (j + 1) / NV;
      const outDir = P(i, j, R).sub(headC);
      outer.add(P(i, j, R), P(i + 1, j, R), P(i + 1, j + 1, R), P(i, j + 1, R), [u0, v0, u1, v1], outDir);
      inner.add(P(i, j + 1, R - T), P(i + 1, j + 1, R - T), P(i + 1, j, R - T), P(i, j, R - T),
        [u0, v0, u1, v1], outDir.clone().negate());
      const nb = [
        [(i + 1) % NU, j, [P(i + 1, j, R), P(i + 1, j + 1, R), P(i + 1, j + 1, R - T), P(i + 1, j, R - T)]],
        [(i - 1 + NU) % NU, j, [P(i, j + 1, R), P(i, j, R), P(i, j, R - T), P(i, j + 1, R - T)]],
        [i, j + 1, [P(i + 1, j + 1, R), P(i, j + 1, R), P(i, j + 1, R - T), P(i + 1, j + 1, R - T)]],
        [i, j - 1, [P(i, j, R), P(i + 1, j, R), P(i + 1, j, R - T), P(i, j, R - T)]],
      ];
      for (const [ni, nj, quad] of nb) {
        const open = nj < 0 || nj >= NV || !solid[ni][nj];
        if (!open) continue;
        const mid = quad[0].clone().add(quad[1]).add(quad[2]).add(quad[3]).multiplyScalar(0.25);
        const cell = P(i + 0.5, j + 0.5, R - T * 0.5);
        walls.add(quad[0], quad[1], quad[2], quad[3], [0.2, 0.2, 0.8, 0.8], mid.sub(cell));
      }
    }
  }

  const parts = [
    AM.uv(outer.geometry(), 'SHELL'),
    AM.uv(inner.geometry(), 'LINER'),
    AM.uv(walls.geometry(), 'VENT'),
  ];

  // Peak / visor: a closed slab with a ROUNDED leading edge, swept as one smooth
  // surface. The old peak was a fan of 18 flat two-sided quads with a per-facet
  // vertical offset, which is what read as a fluted, radially-ribbed picnic
  // plate from below. 45 mm projection at R0 = 98 mm.
  const peakLen = R0 * 0.46, peakSpan = 54 * DEG, peakThick = R0 * 0.052;
  const peakSurf = (u, t) => {
    const s = (u - 0.5) * 2;                               // -1 … 1 across the peak
    const th = s * peakSpan;
    const base = surfPoint(headC, th, phiMax(th) * 0.985, R * 0.995, S);
    const out = V(Math.sin(th) * 0.50, -0.14, Math.cos(th)).normalize();
    // shorter at the corners, curling down along its length, with the leading
    // edge rolled so the last 15 % of the reach turns under
    const roll = smoothstep(clamp((t - 0.85) / 0.15, 0, 1));
    const reach = peakLen * (t - 0.10 * roll) * (1 - 0.26 * s * s);
    return base.addScaledVector(out, reach)
      .add(V(0, -peakLen * (0.30 * t * t + 0.22 * roll) - R0 * 0.05 * s * s * t, 0));
  };
  parts.push(AM.uv(
    slab(peakSurf, 26, 6, peakThick, (u, t) => [0.10 + u * 0.80, 0.72 + t * 0.22]),
    'SHELL'));

  // Chin straps: welded to real shell anchor points just under the ear line,
  // routed UNDER the jaw, with a slider on each side and a buckle at the throat.
  // Nothing crosses the face — the old goggle strap ran a black band straight
  // across the eyes.
  const chin = headC.clone().add(V(0, -R0 * 1.10, R0 * 0.20));
  for (const s of [-1, 1]) {
    for (const [thDeg, lead] of [[62, 0.30], [116, 0.62]]) {
      const th = s * thDeg * DEG;
      const anchor = surfPoint(headC, th, phiMax(th) * 0.995, R - T * 0.4, S);
      const mid = anchor.clone().lerp(chin, lead)
        .add(V(s * R0 * 0.16, -R0 * 0.10, 0));
      const g = sweep([anchor, mid, chin], {
        radius: R0 * 0.115, radial: 6, steps: 10, oval: () => [1, 0.30],
      });
      parts.push(AM.uv(g, 'STRAP'));
    }
    // strap slider
    const sl = new THREE.BoxGeometry(R0 * 0.10, R0 * 0.075, R0 * 0.030);
    const at = surfPoint(headC, s * 88 * DEG, phiMax(s * 88 * DEG) * 1.14, R * 0.92, S);
    sl.translate(at.x, at.y, at.z);
    parts.push(AM.patch(sl, 'LINER'));
  }
  const buckle = new THREE.BoxGeometry(R0 * 0.22, R0 * 0.15, R0 * 0.075);
  buckle.translate(chin.x, chin.y, chin.z);
  parts.push(AM.patch(buckle, 'LINER'));

  return merge(parts);
}

/**
 * Goggles, PARKED on the brow of the lid the way a rider actually carries them
 * between runs. They used to span phi 1.14–1.56 at eye level, which put an opaque
 * dark-brown band straight across the eyes: the single reason the rider "had no
 * face" at the closest framing. They now sit on the shell above the peak line and
 * the whole face is clear.
 */
function buildGoggleLens(headC, R0) {
  const soup = quadSoup();
  const NU = 18, NV = 4;
  const S = [0.90, 1.13, 1.06];
  const th0 = -50 * DEG, th1 = 50 * DEG, p0 = 0.58, p1 = 0.95;
  for (let i = 0; i < NU; i++) {
    for (let j = 0; j < NV; j++) {
      const ta = lerp(th0, th1, i / NU), tb = lerp(th0, th1, (i + 1) / NU);
      const pa = lerp(p0, p1, j / NV), pb = lerp(p0, p1, (j + 1) / NV);
      const r = R0 * 1.135, ri = R0 * 1.095;
      const outDir = surfPoint(headC, (ta + tb) / 2, (pa + pb) / 2, r, S).sub(headC);
      soup.add(
        surfPoint(headC, ta, pa, r, S), surfPoint(headC, tb, pa, r, S),
        surfPoint(headC, tb, pb, r, S), surfPoint(headC, ta, pb, r, S),
        [i / NU, j / NV, (i + 1) / NU, (j + 1) / NV], outDir,
      );
      soup.add(
        surfPoint(headC, ta, pb, ri, S), surfPoint(headC, tb, pb, ri, S),
        surfPoint(headC, tb, pa, ri, S), surfPoint(headC, ta, pa, ri, S),
        [i / NU, j / NV, (i + 1) / NU, (j + 1) / NV], outDir.clone().negate(),
      );
    }
  }
  for (let i = 0; i < NU; i++) {
    const ta = lerp(th0, th1, i / NU), tb = lerp(th0, th1, (i + 1) / NU);
    for (const [p, sgn] of [[p0, -1], [p1, 1]]) {
      const a = surfPoint(headC, ta, p, R0 * 1.135, S), b = surfPoint(headC, tb, p, R0 * 1.135, S);
      const c = surfPoint(headC, tb, p, R0 * 1.095, S), d = surfPoint(headC, ta, p, R0 * 1.095, S);
      const along = surfPoint(headC, (ta + tb) / 2, p + sgn * 0.05, R0 * 1.135, S)
        .sub(surfPoint(headC, (ta + tb) / 2, p, R0 * 1.135, S));
      soup.add(a, b, c, d, [0, 0, 1, 1], along);
    }
  }
  return soup.geometry();
}

// ---------------------------------------------------------------------------
// geometry cache — flicking between options in the creator must not rebuild
// ---------------------------------------------------------------------------

function createGeoCache(limit = 20) {
  const map = new Map();          // key -> geometry
  const live = new Set();         // keys currently attached to a mesh
  return {
    get(key, build) {
      let g = map.get(key);
      if (g) { map.delete(key); map.set(key, g); return g; }
      g = build();
      map.set(key, g);
      while (map.size > limit) {
        const oldest = map.keys().next().value;
        if (live.has(oldest)) { const v = map.get(oldest); map.delete(oldest); map.set(oldest, v); break; }
        const v = map.get(oldest);
        map.delete(oldest);
        if (v && v.dispose) v.dispose();
      }
      return g;
    },
    hold(key) { live.add(key); },
    drop(key) { live.delete(key); },
    dispose() {
      for (const g of map.values()) if (g && g.dispose) g.dispose();
      map.clear(); live.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/**
 * Build the rider and their bike from a profile.
 * `rider.applyProfile(next)` updates everything in place.
 */
export async function createRider(ctx, profile = DEFAULT_PROFILE) {
  const renderer = ctx?.renderer || ctx?.engine?.renderer || null;
  const materials = ctx?.materials || null;
  const aniso = Math.min(8, renderer?.capabilities?.getMaxAnisotropy?.() ?? 8);

  let X = buildContext(profile, materials);
  const cache = createGeoCache(24);

  // --- atlases --------------------------------------------------------------
  const AP = createAtlas('bikePaint', { w: 1024, unit: 256, regions: bikePaintRegions(), aniso, normalStrength: 0.45, X });
  const AH = createAtlas('bikeHardware', { w: 1024, unit: 128, regions: bikeHardwareRegions(), aniso, normalStrength: 0.7, X });
  const AR = createAtlas('bikeRubber', { w: 1024, unit: 256, regions: bikeRubberRegions(), aniso, normalStrength: 1.5, X });
  const AD = createAtlas('rider', { w: 1024, unit: 160, regions: riderRegions(), aniso, normalStrength: 1.1, X });
  const AM = createAtlas('helmet', { w: 1024, unit: 128, regions: helmetRegions(), aniso, normalStrength: 0.8, X });

  // --- materials ------------------------------------------------------------
  const paint = new THREE.MeshPhysicalMaterial({
    ...AP.maps, color: 0xffffff, metalness: 1, roughness: 1,
    clearcoat: 0.28, clearcoatRoughness: 0.38,
    normalScale: new THREE.Vector2(0.30, 0.30), envMapIntensity: 1,
  });
  paint.name = 'bikePaint';

  const hardware = new THREE.MeshStandardMaterial({
    ...AH.maps, color: 0xffffff, metalness: 1, roughness: 1,
    normalScale: new THREE.Vector2(0.40, 0.40), envMapIntensity: 1,
  });
  hardware.name = 'bikeHardware';

  const rubber = new THREE.MeshStandardMaterial({
    ...AR.maps, color: 0xffffff, metalness: 0, roughness: 1,
    normalScale: new THREE.Vector2(0.75, 0.75), envMapIntensity: 0.8,
  });
  rubber.name = 'bikeRubber';

  // Fabric, not plastic: fully rough, low env response, a sheen lobe for the
  // grazing-angle lift real cloth has, and a strong normal for weave and folds.
  // envMapIntensity is deliberately near 1: the sky IS the fill light on an
  // overcast dusk, and a character that only answers to the sun turns into a
  // black cut-out the moment it faces away from it.
  const riderMat = new THREE.MeshPhysicalMaterial({
    ...AD.maps, color: 0xffffff, metalness: 0, roughness: 1,
    // The weave and the fold relief only exist in the normal map, so it has to be
    // read at close to full strength or the garment is a flat colour again.
    normalScale: new THREE.Vector2(1.05, 1.05), envMapIntensity: 0.95,
    // Cloth sheen: a retroreflective-ish lobe that lifts grazing angles, which is
    // what separates a woven garment from painted plastic at a silhouette edge.
    // 0.55 with a light sheen colour washed every garment pale at grazing angles
    // — indigo denim came back as stone-washed and the tee lost its value.
    sheen: 0.30, sheenRoughness: 0.80, sheenColor: new THREE.Color(0x8b8f97),
  });
  riderMat.name = 'riderSkinned';

  // SKIN IS NOT CLOTH. One material carries the whole character, so skin used to
  // get the fabric's sheen lobe and a plain lambert falloff: the face went waxy
  // in the light and dead grey in the shadow, and at the closeup framing that is
  // most of why it read as a mannequin. The atlas puts SKIN and FACE in the two
  // lowest bands, so `v` alone says whether a fragment is skin — no extra vertex
  // attribute, no second draw call. Skin then gets:
  //   - a wrap-diffuse term tinted toward blood, which is the cheap subsurface
  //     approximation: light bleeds ~35° past the terminator and goes red doing it
  //   - the cloth sheen taken back off it
  const skinVMax = (AD.index.FACE ? AD.index.FACE.v1 : 0.36);
  riderMat.onBeforeCompile = (shader) => {
    shader.uniforms.uSkinVMax = { value: skinVMax };
    shader.uniforms.uSkinWarm = { value: new THREE.Color(0.85, 0.36, 0.26) };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uSkinVMax;
        uniform vec3 uSkinWarm;
        float rSkinMask = 0.0;`)
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
        rSkinMask = 1.0 - smoothstep( uSkinVMax - 0.012, uSkinVMax, vMapUv.y );
        #ifdef USE_SHEEN
          material.sheenColor *= ( 1.0 - 0.88 * rSkinMask );
        #endif`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        #if ( NUM_DIR_LIGHTS > 0 )
        if ( rSkinMask > 0.002 ) {
          vec3 rSss = vec3( 0.0 );
          IncidentLight rDL;
          for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
            getDirectionalLightInfo( directionalLights[ i ], rDL );
            float nl = dot( geometryNormal, rDL.direction );
            // wrapped diffuse minus the lambert already accounted for: what is
            // left is exactly the band around the terminator
            rSss += rDL.color * max( clamp( ( nl + 0.55 ) / 1.55, 0.0, 1.0 ) - clamp( nl, 0.0, 1.0 ), 0.0 );
          }
          reflectedLight.directDiffuse += rSss * uSkinWarm * diffuseColor.rgb * ( rSkinMask * 0.17 );
        }
        #endif`);
  };
  riderMat.customProgramCacheKey = () => 'riderSkinWrap';

  const helmetMat = new THREE.MeshPhysicalMaterial({
    ...AM.maps, color: 0xffffff, metalness: 0.15, roughness: 1,
    clearcoat: 0.7, clearcoatRoughness: 0.18, envMapIntensity: 1,
  });
  helmetMat.name = 'riderHelmet';

  const lensMat = new THREE.MeshPhysicalMaterial({
    color: 0x8a5c2e, metalness: 1, roughness: 0.05,
    clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 1.8,
  });
  lensMat.name = 'riderLens';

  function applyMaterialParams() {
    // METAL HAS TO READ AS METAL. The library hands us a "roughness" that is the
    // colourway's diffuse character (black frame = 1.00); using it raw on a
    // metalness-1 surface gives a perfectly Lambertian metal, which renders as
    // flat black plastic with one soft highlight — precisely the note. The scalar
    // here is the LEVEL; the atlas roughness map carries the variation.
    //   chrome    0.06 – 0.15 (mirror, smudged by handling)
    //   raw alloy 0.30 – 0.45 (brushed)
    //   ano/paint 0.42 – 0.62 under a clearcoat
    const F = X.frame;
    const level = F.finish === 'chrome' ? 0.30
      : F.finish === 'raw' ? 0.72
        : F.finish === 'gloss' ? 0.46
          : lerp(0.52, 0.78, clamp(F.roughness, 0, 1));
    paint.metalness = F.finish === 'gloss' ? 0.08 : F.metalness;
    paint.roughness = clamp(level, 0.04, 1);
    paint.clearcoat = F.finish === 'chrome' ? 0.85 : F.finish === 'raw' ? 0.10 : F.finish === 'gloss' ? 0.72 : 0.55;
    paint.clearcoatRoughness = F.finish === 'chrome' ? 0.045 : 0.14;
    // The sky gradient and the ramp have to land ON the frame. A metal that does
    // not answer to the environment is a silhouette, not a material.
    paint.envMapIntensity = F.env * (F.finish === 'chrome' ? 1.7 : 1.25);
    paint.needsUpdate = true;
    hardware.envMapIntensity = X.hw.env * (X.hw.finish === 'chrome' ? 1.7 : 1.25);
    hardware.roughness = clamp(X.hw.finish === 'chrome' ? 0.34 : lerp(0.50, 0.80, clamp(X.hw.roughness, 0, 1)), 0.05, 1);
    rubber.envMapIntensity = X.tyre.env * 0.8;
    rubber.roughness = clamp(X.tyre.roughness * 1.05, 0.2, 1);
    helmetMat.envMapIntensity = 1;
    lensMat.color.setHex(mixc(0x8a5c2e, X.accent, 0.35));
  }
  applyMaterialParams();

  // --- static bike geometry (colour lives in the textures, so build once) ----
  const frameGeo = cache.get('frame', () => buildFrame(AP, AH, AR));
  const forkGeo = cache.get('fork', () => buildFork(AP, AH));
  const barsGeo = cache.get('bars', () => buildBars(AH, AR));
  const seatGeo = cache.get('seat', () => buildSeat(AR, AH));
  const driveGeo = cache.get('drive', () => buildDrivetrain(AH));

  const group = new THREE.Group();
  group.name = 'rider';

  const mesh = (geo, mat, name) => {
    const m = new THREE.Mesh(geo, mat);
    m.name = name;
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  };

  const bikeGroup = new THREE.Group();
  bikeGroup.name = 'bike';
  group.add(bikeGroup);

  // frame + seat
  const frameGroup = new THREE.Group();
  frameGroup.name = 'frameGroup';
  const framePaint = mesh(frameGeo.paint, paint, 'frame');
  const frameHw = mesh(frameGeo.hardware, hardware, 'frameHardware');
  const frameRub = mesh(frameGeo.rubber, rubber, 'frameRubber');
  const seatGroup = new THREE.Group();
  seatGroup.name = 'seatGroup';
  seatGroup.add(mesh(seatGeo.rubber, rubber, 'seat'), mesh(seatGeo.hardware, hardware, 'seatHardware'));
  frameGroup.add(framePaint, frameHw, frameRub, seatGroup);
  bikeGroup.add(frameGroup);

  // steering assembly
  const steer = new THREE.Object3D();
  steer.name = 'steer';
  steer.position.copy(PT.htBottom);
  steer.rotation.x = -(Math.PI / 2 - G.headAngle);
  steer.updateMatrix();
  const steerInv = new THREE.Matrix4().copy(steer.matrix).invert();

  const forkGroup = new THREE.Group();
  forkGroup.name = 'fork';
  if (!forkGeo.placed) {
    forkGeo.paint.applyMatrix4(steerInv);
    forkGeo.hardware.applyMatrix4(steerInv);
    forkGeo.placed = true;
  }
  forkGroup.add(mesh(forkGeo.paint, paint, 'forkPaint'), mesh(forkGeo.hardware, hardware, 'forkHardware'));
  steer.add(forkGroup);

  const rearWheel = new THREE.Group();
  rearWheel.name = 'wheelRear';
  rearWheel.position.copy(PT.rearAxle);
  const frontWheel = new THREE.Group();
  frontWheel.name = 'wheelFront';
  frontWheel.position.copy(PT.frontAxle).applyMatrix4(steerInv);

  const rearCore = mesh(cache.get('wheelRear', () => buildWheelCore(true, AH)), hardware, 'rearRim');
  const frontCore = mesh(cache.get('wheelFront', () => buildWheelCore(false, AH)), hardware, 'frontRim');
  const rearTyre = mesh(new THREE.BufferGeometry(), rubber, 'rearTyre');
  const frontTyre = mesh(new THREE.BufferGeometry(), rubber, 'frontTyre');
  rearWheel.add(rearCore, rearTyre);
  frontWheel.add(frontCore, frontTyre);
  let treadKey = null;
  function buildTyres() {
    const key = 'tyre|' + X.tyre.tread;
    if (key === treadKey) return;
    if (treadKey) cache.drop(treadKey);
    const geo = cache.get(key, () => buildTyre(X.tyre.tread, AR));
    cache.hold(key);
    treadKey = key;
    rearTyre.geometry = geo;
    frontTyre.geometry = geo;      // both tyres are the same casting
  }
  buildTyres();
  bikeGroup.add(rearWheel);
  steer.add(frontWheel);

  const barPivot = new THREE.Object3D();
  barPivot.name = 'barPivot';
  const barGroup = new THREE.Group();
  barGroup.name = 'bars';
  if (!barsGeo.placed) {
    barsGeo.hardware.applyMatrix4(steerInv);
    barsGeo.rubber.applyMatrix4(steerInv);
    barsGeo.placed = true;
  }
  const gripsMesh = mesh(barsGeo.rubber, rubber, 'grips');
  barGroup.add(mesh(barsGeo.hardware, hardware, 'barsHardware'), gripsMesh);
  barPivot.add(barGroup);
  steer.add(barPivot);
  bikeGroup.add(steer);

  // pegs
  let pegRearMesh = null, pegFrontMesh = null, pegKey = null;
  function buildPegSet() {
    const key = 'pegs|' + X.pegCount;
    if (key === pegKey) return;
    if (pegKey) cache.drop(pegKey);
    const built = cache.get(key, () => {
      const p = buildPegs(X.pegCount, AH);
      if (p.front) p.front.applyMatrix4(steerInv);
      p.dispose = () => { p.rear?.dispose(); p.front?.dispose(); };
      return p;
    });
    cache.hold(key);
    pegKey = key;
    if (built.rear) {
      if (!pegRearMesh) { pegRearMesh = mesh(built.rear, hardware, 'pegsRear'); frameGroup.add(pegRearMesh); }
      else pegRearMesh.geometry = built.rear;
      pegRearMesh.visible = true;
    } else if (pegRearMesh) pegRearMesh.visible = false;
    if (built.front) {
      if (!pegFrontMesh) { pegFrontMesh = mesh(built.front, hardware, 'pegsFront'); steer.add(pegFrontMesh); }
      else pegFrontMesh.geometry = built.front;
      pegFrontMesh.visible = true;
    } else if (pegFrontMesh) pegFrontMesh.visible = false;
  }
  buildPegSet();

  // cranks + pedals
  const crankPivot = new THREE.Object3D();
  crankPivot.name = 'cranks';
  crankPivot.position.copy(PT.bb);
  if (!driveGeo.placed) {
    driveGeo.hardware.translate(-PT.bb.x, -PT.bb.y, -PT.bb.z);
    for (const p of driveGeo.pedals) p.geo.translate(-p.pos.x, -p.pos.y, -p.pos.z);
    driveGeo.placed = true;
  }
  crankPivot.add(mesh(driveGeo.hardware, hardware, 'crankArms'));
  const pedalPivots = driveGeo.pedals.map((p, i) => {
    const pivot = new THREE.Object3D();
    pivot.name = i === 0 ? 'pedalR' : 'pedalL';
    pivot.position.copy(p.pos).sub(PT.bb);
    pivot.add(mesh(p.geo, hardware, pivot.name + 'Mesh'));
    crankPivot.add(pivot);
    return pivot;
  });
  bikeGroup.add(crankPivot);

  // chain
  const cp = driveGeo.chain;
  const chainMesh = new THREE.InstancedMesh(cp.geo, hardware, cp.links);
  chainMesh.name = 'chain';
  chainMesh.castShadow = true;
  chainMesh.receiveShadow = true;
  chainMesh.frustumCulled = false;
  chainMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  bikeGroup.add(chainMesh);

  const _pA = new THREE.Vector3(), _tan = new THREE.Vector3();
  const _nrm = new THREE.Vector3(), _lat = new THREE.Vector3(), _mat = new THREE.Matrix4();
  const sampleAt = (dist, out, tan) => {
    let d = dist % cp.total;
    if (d < 0) d += cp.total;
    let lo = 0, hi = cp.path.length;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (cp.cum[mid] <= d) lo = mid; else hi = mid;
    }
    const a = cp.path[lo], b = cp.path[(lo + 1) % cp.path.length];
    const seg = cp.cum[lo + 1] - cp.cum[lo] || 1e-6;
    const t = (d - cp.cum[lo]) / seg;
    out.copy(a).lerp(b, t);
    tan.copy(b).sub(a).normalize();
  };
  function placeChain(phase) {
    const step = cp.total / cp.links;
    for (let i = 0; i < cp.links; i++) {
      sampleAt(phase + i * step, _pA, _tan);
      _nrm.set(0, _tan.z, -_tan.y).normalize();
      _lat.crossVectors(_tan, _nrm).normalize();
      _mat.makeBasis(_tan, _nrm, _lat).setPosition(_pA);
      // Every link carries both an outer and an inner plate now, so the old
      // "squash every other instance" alternation would just bury the outer
      // plates inside the inner ones and thin the chain back out.
      chainMesh.setMatrixAt(i, _mat);
    }
    chainMesh.instanceMatrix.needsUpdate = true;
  }
  placeChain(0);

  const bike = {
    group: bikeGroup,
    frame: frameGroup,
    framePaint,
    steer,
    fork: forkGroup,
    barPivot,
    bars: barGroup,
    grips: gripsMesh,
    wheels: [rearWheel, frontWheel],
    wheelRear: rearWheel,
    wheelFront: frontWheel,
    get tyres() { return [rearTyre, frontTyre]; },
    cranks: crankPivot,
    pedals: pedalPivots,
    pedalR: pedalPivots[0],
    pedalL: pedalPivots[1],
    chain: chainMesh,
    seat: seatGroup,
    points: {
      gripL: barsGeo.gripAnchorL.clone(),
      gripR: barsGeo.gripAnchorR.clone(),
      // the grip TRANSFORM, not just a point: the hands are IK'd off this
      gripAxisL: barsGeo.gripAxisL.clone(),
      gripAxisR: barsGeo.gripAxisR.clone(),
      gripRadius: barsGeo.gripRadius,
      pedalR: driveGeo.pedals[0].pos.clone(),
      pedalL: driveGeo.pedals[1].pos.clone(),
      bb: PT.bb.clone(),
      seat: seatGeo.seatTop.clone(),
      headTop: PT.htTop.clone(),
      rearAxle: PT.rearAxle.clone(),
      frontAxle: PT.frontAxle.clone(),
    },
    setSteer(rad) { steer.rotation.y = rad; },
    setBarspin(rad) { barPivot.rotation.y = rad; },
    setDrive(crankAngle) {
      crankPivot.rotation.x = crankAngle;
      pedalPivots[0].rotation.x = -crankAngle;
      pedalPivots[1].rotation.x = -crankAngle;
      placeChain(-crankAngle * driveGeo.ringR);
    },
    setWheelSpin(rad) {
      rearWheel.rotation.x = rad;
      frontWheel.rotation.x = rad;
    },
  };

  // --- rider ----------------------------------------------------------------
  let pose = riderPose(bike.points, X);
  const { bones, boneIndex, byName } = buildSkeleton(pose);
  group.add(bones[0]);
  bones[0].updateMatrixWorld(true);

  const bodySig = () => [
    X.P.height, X.P.build, X.P.gender, X.top.style, X.bottom.style, X.shoe.style,
    X.glove.on, X.pad.knee, X.pad.elbow, X.pad.shin,
    X.hair.style, X.beard.style, X.lid.style,
  ].join('|');

  let currentBodyKey = null;
  const skinned = new THREE.SkinnedMesh(new THREE.BufferGeometry(), riderMat);
  skinned.name = 'riderBody';
  skinned.castShadow = true;
  skinned.receiveShadow = true;
  skinned.frustumCulled = false;
  group.add(skinned);
  const skeleton = new THREE.Skeleton(bones);

  const headBone = byName.head;
  const helmetGeo = cache.get('helmet', () => buildHelmet(V(0, 0, 0), 0.098, AM));
  const helmet = new THREE.Mesh(helmetGeo, helmetMat);
  helmet.name = 'helmet';
  helmet.castShadow = true;
  helmet.receiveShadow = true;
  headBone.add(helmet);
  const lensGeo = cache.get('goggles', () => buildGoggleLens(V(0, 0, 0), 0.098));
  const lens = new THREE.Mesh(lensGeo, lensMat);
  lens.name = 'goggles';
  lens.castShadow = true;
  headBone.add(lens);

  /**
   * Rebind in the rider's OWN space. `SkinnedMesh.bind(skeleton)` would capture
   * `matrixWorld`, and by the time the creator changes a profile the physics has
   * long since moved the whole rider across the park — binding to that transform
   * would fold the world position into the skinning. The geometry is authored in
   * group space, so the bind matrix is the identity and the bone inverses have to
   * be taken with the group treated as identity too.
   */
  const _bindSave = new THREE.Matrix4();
  function rebind() {
    const saved = _bindSave.copy(group.matrixWorld);
    group.matrixWorld.identity();
    bones[0].updateMatrixWorld(true);
    skeleton.calculateInverses();
    group.matrixWorld.copy(saved);
    bones[0].updateMatrixWorld(true);
    skinned.skeleton = skeleton;
    skinned.bindMatrix.identity();
    skinned.bindMatrixInverse.identity();
  }

  /** Rebuild the skinned body for the current profile and rebind the skeleton. */
  function rebuildBody() {
    const key = 'body|' + bodySig();
    if (key === currentBodyKey) return;
    if (currentBodyKey) cache.drop(currentBodyKey);
    const geo = cache.get(key, () => buildRiderBody(pose, boneIndex, X, AD));
    cache.hold(key);
    currentBodyKey = key;
    skinned.geometry = geo;
    rebind();
  }

  /** Move the rig itself: new limb lengths, new fit, new bind pose. */
  function rebuildRig() {
    pose = riderPose(bike.points, X);
    reposeSkeleton(byName, pose);
    bones[0].updateMatrixWorld(true);
    // saddle follows the inseam
    const drop = clamp(X.M.fit.seatHeight, -0.055, 0.075);
    seatGroup.position.copy(PT.stDir).multiplyScalar(drop);
    bike.points.seat.copy(seatGeo.seatTop).addScaledVector(PT.stDir, drop);
    // head-mounted kit rides the head bone; bones are identity-rotated in bind pose
    const headR = pose.L.head;
    const headC = pose.head.clone().add(V(0, headR * 0.86, headR * 0.12)).sub(pose.head);
    helmet.position.copy(headC);
    helmet.scale.setScalar(headR / 0.098);
    lens.position.copy(headC);
    lens.scale.setScalar(headR / 0.098);
    currentBodyKey = null;         // the bind pose moved: the mesh must follow
    rebuildBody();
  }

  function updateHeadwear() {
    const on = X.lid.helmet;
    helmet.visible = on;
    lens.visible = on;
  }

  rebuildRig();
  updateHeadwear();

  const listeners = new Set();
  const stats = { version: 0, lastApplyMs: 0, drawCalls: 0 };

  function countDrawCalls() {
    let n = 0;
    group.traverse((o) => { if ((o.isMesh || o.isInstancedMesh) && o.visible) n++; });
    stats.drawCalls = n;
  }
  countDrawCalls();

  /**
   * Push a new profile at the rider. Repaints only the atlas regions whose inputs
   * moved and rebuilds only the meshes whose vertices actually depend on what
   * changed, so a swatch click costs a couple of milliseconds.
   */
  function applyProfile(next) {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const prev = X;
    X = buildContext(next, materials);

    applyMaterialParams();

    AP.repaint(X); AH.repaint(X); AR.repaint(X); AD.repaint(X); AM.repaint(X);

    if (X.tyre.tread !== prev.tyre.tread) buildTyres();
    if (X.pegCount !== prev.pegCount) buildPegSet();

    const rigMoved = X.P.height !== prev.P.height || X.P.build !== prev.P.build
      || X.P.gender !== prev.P.gender;
    if (rigMoved) rebuildRig();
    else rebuildBody();
    updateHeadwear();

    stats.version = ++api.version;
    stats.lastApplyMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    countDrawCalls();
    for (const fn of listeners) {
      try { fn(api); } catch (err) { /* a listener must never break the rider */ }
    }
    return api;
  }

  const rig = {
    root: bones[0],
    hips: byName.hips, spine: byName.spine, chest: byName.chest,
    neck: byName.neck, head: byName.head,
    shoulderL: byName.shoulderL, elbowL: byName.elbowL, wristL: byName.wristL,
    shoulderR: byName.shoulderR, elbowR: byName.elbowR, wristR: byName.wristR,
    hipL: byName.hipL, kneeL: byName.kneeL, ankleL: byName.ankleL, toeL: byName.toeL,
    hipR: byName.hipR, kneeR: byName.kneeR, ankleR: byName.ankleR, toeR: byName.toeR,
    armL: [byName.shoulderL, byName.elbowL, byName.wristL],
    armR: [byName.shoulderR, byName.elbowR, byName.wristR],
    legL: [byName.hipL, byName.kneeL, byName.ankleL, byName.toeL],
    legR: [byName.hipR, byName.kneeR, byName.ankleR, byName.toeR],
    spineChain: [byName.hips, byName.spine, byName.chest, byName.neck, byName.head],
    bones, skeleton, byName,
    mesh: skinned,
    /** Bind-pose joint positions in bike space — handy for IK targets. */
    get bindPose() { return pose; },
  };

  const materialsOut = { paint, hardware, rubber, rider: riderMat, helmet: helmetMat, lens: lensMat };
  const atlases = [AP, AH, AR, AD, AM];

  const api = {
    group,
    bike,
    rig,
    materials: materialsOut,
    helmet,
    goggles: lens,
    version: 0,
    stats,
    get profile() { return X.P; },
    get metrics() { return X.M; },
    /** Live paint/geometry context — the creator screen reads colours off this. */
    get context() { return X; },
    applyProfile,
    /** Notified after every rebuild, so a preview screen can re-seat its camera. */
    onRebuild(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    setDrive: bike.setDrive,
    setSteer: bike.setSteer,
    setBarspin: bike.setBarspin,
    update() {},
    dispose() {
      group.traverse((o) => {
        if (o.isInstancedMesh) o.dispose?.();
      });
      cache.dispose();
      for (const a of atlases) a.dispose();
      for (const m of Object.values(materialsOut)) m.dispose();
      skeleton.dispose?.();
      listeners.clear();
      group.removeFromParent();
    },
  };
  return api;
}

export default createRider;

