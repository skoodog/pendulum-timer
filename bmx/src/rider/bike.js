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
 * from the sun and takes the fold and seam detail with it. Real black cotton
 * sits nearer 5 %, so anything darker is lifted to that floor, keeping its hue.
 * This is why the rider still reads as a rider in shadow.
 */
function fabricAlbedo(c, floor = 0.215) {
  const l = lumOf(c);
  if (l >= floor) return c;
  const k = clamp((floor - l) / Math.max(1 - l, 1e-3), 0, 1);
  return mixc(c, 0xf4f2ef, k * 0.94);
}

/** Ink that stays readable on `c` — used for every printed graphic. */
function inkOn(c) { return lumOf(c) > 0.52 ? 0x191b20 : 0xf2efe6; }

/** Push a colour away from `c` so trim never disappears into the garment. */
function separate(c, from, minDelta = 0.22) {
  if (Math.abs(lumOf(c) - lumOf(from)) >= minDelta) return c;
  return lumOf(from) > 0.5 ? shade(c, -0.42) : shade(c, 0.46);
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
  const roughOf = (X) => (c, w, h) => {
    fill(c, w, h, X.frame.finish === 'chrome' ? '#c8c8c8' : '#e6e6e6');
    overlay(c, w, h, 0.22, 2);
    scratches(c, w, h, 90, '#ffffff', 8, 90, 0.9);
    chips(c, w, h, 24, '#9a9a9a', 1, 3);
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
  const hwSig = (X) => `${X.hw.colour}|${X.hw.finish}`;
  const metal = (c, w, h, F, style) => {
    if (F.finish === 'chrome') {
      const grd = c.createLinearGradient(0, 0, 0, h);
      grd.addColorStop(0, HEX(shade(F.colour, 0.18)));
      grd.addColorStop(0.5, HEX(shade(F.colour, -0.42)));
      grd.addColorStop(1, HEX(shade(F.colour, 0.10)));
      c.fillStyle = grd; c.fillRect(0, 0, w, h);
      scratches(c, w, h, 160, '#ffffff', 10, 120, 0.6);
      scratches(c, w, h, 60, '#7e888e', 6, 40, 0.6);
      chips(c, w, h, 14, '#8a7a64', 0.8, 2.2);
    } else {
      fill(c, w, h, HEX(F.colour));
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
        fill(c, w, h, X.hw.finish === 'chrome' ? '#2a2a2a' : '#9c9c9c');
        scratches(c, w, h, 150, X.hw.finish === 'chrome' ? '#6e6e6e' : '#4a4a4a', 10, 120, 0.7);
      },
      hsig: () => 'k',
      height: (c, w, h) => { fill(c, w, h, '#808080'); scratches(c, w, h, 120, '#6c6c6c', 6, 80, 0.8); },
    },
    {
      key: 'ANOD', u: 1, sig: hwSig,
      colour: (c, w, h, X) => metal(c, w, h, { colour: mixc(X.hw2.colour, 0x141519, 0.45), finish: 'anod' }, 'satin'),
      rough: (c, w, h) => { fill(c, w, h, '#8a8a8a'); scratches(c, w, h, 130, '#3c3c3c', 6, 70, 0.8); },
      hsig: () => 'k',
      height: (c, w, h) => { fill(c, w, h, '#808080'); overlay(c, w, h, 0.20, 2); },
    },
    {
      key: 'ALLOY', u: 1, sig: hwSig,
      colour: (c, w, h, X) => {
        fill(c, w, h, HEX(mixc(0x8d949a, X.hw.colour, 0.35)));
        for (let i = 0; i < 60; i++) {                    // lathe rings
          c.strokeStyle = `rgba(${rand(200, 255) | 0},${rand(200, 255) | 0},255,${rand(0.04, 0.14).toFixed(2)})`;
          c.lineWidth = rand(0.5, 2);
          c.beginPath(); c.moveTo(0, rand(0, h)); c.lineTo(w, rand(0, h)); c.stroke();
        }
        overlay(c, w, h, 0.2, 2);
      },
      rough: (c, w, h) => { fill(c, w, h, '#7a7a7a'); overlay(c, w, h, 0.4, 3); },
      hsig: () => 'k',
      height: (c, w, h) => { fill(c, w, h, '#808080'); scratches(c, w, h, 90, '#6c6c6c', 6, 60, 0.8); },
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
      key: 'OILY', u: 1, sig: () => 'k',
      colour: (c, w, h) => { fill(c, w, h, '#2b2a28'); overlay(c, w, h, 0.3, 2); scratches(c, w, h, 80, '#b9b2a4', 4, 30, 0.7); },
      rough: (c, w, h) => { fill(c, w, h, '#8a8a8a'); overlay(c, w, h, 0.5, 4, _speck); },
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
      key: 'ACCENT', u: 1, sig: (X) => `${X.accent}`,
      colour: (c, w, h, X) => {
        fill(c, w, h, HEX(X.accent));
        overlay(c, w, h, 0.20, 2);
        scratches(c, w, h, 70, HEX(shade(X.accent, 0.5)), 5, 40, 0.7);
      },
      rough: (c, w, h) => fill(c, w, h, '#7a7a7a'),
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
        // tread pattern
        c.fillStyle = HEX(shade(X.tyre.colour, -0.45));
        if (tread === 'slick') {
          for (let i = 0; i < 3; i++) {
            const v = 0.42 + i * 0.08;
            c.fillRect(0, yv(v), w, h * 0.006);
          }
        } else if (tread === 'street') {
          for (let i = 0; i < 34; i++) {
            const x = (i / 34) * w;
            c.fillRect(x + w * 0.004, yv(0.60), w * 0.010, yv(0.40) - yv(0.60));
          }
          c.fillRect(0, yv(0.50), w, h * 0.010);
        } else {
          for (let i = 0; i < 24; i++) {
            const x = (i / 24) * w;
            c.fillRect(x + w * 0.006, yv(0.66), w * 0.022, h * 0.05);
            c.fillRect(x + w * 0.020, yv(0.54), w * 0.020, h * 0.04);
            c.fillRect(x + w * 0.006, yv(0.44), w * 0.022, h * 0.05);
          }
        }
        overlay(c, w, h, 0.16, 3);
        chips(c, w, h, 40, 'rgba(58,55,51,0.6)', 1, 3.5);
      },
      rough: (c, w, h) => {
        const yv = (v) => (1 - v) * h;
        fill(c, w, h, '#e2e2e2');
        overlay(c, w, h, 0.3, 4);
        c.fillStyle = 'rgba(140,140,140,0.6)';
        c.fillRect(0, yv(0.62), w, yv(0.38) - yv(0.62));      // polished centre strip
      },
      hsig: (X) => `${X.tyre.tread}`,
      height: (c, w, h, X) => {
        const yv = (v) => (1 - v) * h;
        fill(c, w, h, '#808080');
        overlay(c, w, h, 0.4, 4);
        c.fillStyle = '#ffffff';
        if (X.tyre.tread === 'knobby') {
          for (let i = 0; i < 24; i++) {
            const x = (i / 24) * w;
            c.fillRect(x + w * 0.006, yv(0.66), w * 0.022, h * 0.05);
            c.fillRect(x + w * 0.020, yv(0.54), w * 0.020, h * 0.04);
            c.fillRect(x + w * 0.006, yv(0.44), w * 0.022, h * 0.05);
          }
        } else if (X.tyre.tread === 'street') {
          for (let i = 0; i < 34; i++) c.fillRect((i / 34) * w + w * 0.004, yv(0.60), w * 0.010, yv(0.40) - yv(0.60));
        }
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
        fill(c, w, h, HEX(X.grip));
        overlay(c, w, h, 0.22, 3);
        for (let i = 0; i < 40; i++) {
          c.strokeStyle = rgba(shade(X.grip, 0.35), 0.22); c.lineWidth = 2;
          const x = (i / 40) * w;
          c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke();
        }
        text(c, 'GRIT', w * 0.5, h * 0.5, h * 0.26, rgba(inkOn(X.grip), 0.45), { spacing: 2 });
      },
      rough: (c, w, h) => { fill(c, w, h, '#e8e8e8'); overlay(c, w, h, 0.3, 4); },
      hsig: () => 'k',
      height: (c, w, h) => {
        for (let i = 0; i < 40; i++) { c.fillStyle = '#d0d0d0'; c.fillRect((i / 40) * w, 0, w / 80, h); }
        overlay(c, w, h, 0.5, 6, _speck);
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

  // lash line: thin at the inner corner, heavy over the outer half
  c.save();
  c.lineCap = 'round';
  c.strokeStyle = 'rgba(20,15,13,0.92)';
  c.lineWidth = Math.max(1.6, 1.05 * sy);
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
      key: 'FACE', u: 4,
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
          const x0 = mx(sgn * 5), x1 = mx(sgn * 22), x2 = mx(sgn * 36);
          const y0 = fy(FL.brow - 0.008), y1 = fy(FL.brow + 0.016), y2 = fy(FL.brow + 0.002);
          c.save();
          c.globalAlpha = 0.55;
          c.strokeStyle = HEX(shade(browC, -0.15));
          c.lineWidth = 4.6 * sy; c.lineCap = 'round';
          c.beginPath(); c.moveTo(x0, y0); c.quadraticCurveTo(x1, y1, x2, y2); c.stroke();
          c.restore();
          // individual hairs, sweeping up from the inner end and down at the tail
          c.lineCap = 'round';
          for (let i = 0; i < 120; i++) {
            const t = i / 119;
            const bx = x0 + (x2 - x0) * t;
            const by = y0 + (y1 - y0) * 4 * t * (1 - t) + (y2 - y0) * t * t;
            const jx = rand(-1.4, 1.4) * sx, jy = rand(-2.2, 2.2) * sy;
            const len = lerp(4.2, 6.5, 1 - t) * sy;
            const ang = lerp(-1.15, -0.15, t) * (sgn > 0 ? 1 : -1);
            c.strokeStyle = rgba(rng() < 0.5 ? shade(browC, 0.22) : shade(browC, -0.30), rand(0.45, 0.9));
            c.lineWidth = rand(0.7, 1.5) * sy;
            c.beginPath();
            c.moveTo(bx + jx, by + jy);
            c.lineTo(bx + jx + Math.cos(ang) * len * sgn * 0.9, by + jy - Math.abs(Math.sin(ang)) * len * 0.55);
            c.stroke();
          }
        }

        // --- eyes -------------------------------------------------------------
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
          c.fillStyle = rgba(0x1a1210, 0.82);
          c.beginPath();
          c.ellipse(mx(sgn * 8.4), fy(FL.noseBase - 0.004), 3.0 * sx, 2.1 * sy, sgn * 0.55, 0, TAU);
          c.fill();
          c.fillStyle = rgba(shade(skin, 0.30), 0.30);
          c.beginPath();
          c.ellipse(mx(sgn * 12.4), fy(FL.noseBase + 0.004), 3.6 * sx, 2.6 * sy, sgn * 0.4, 0, TAU);
          c.fill();
        }
        blob(c, fx(0.5), fy(FL.noseTip + 0.004), 6.0 * sx, 5.0 * sy, rgba(shade(skin, 0.34), 0.32), 0.9);
        blob(c, fx(0.5), fy(FL.noseTip + 0.028), 3.0 * sx, 8.0 * sy, rgba(shade(skin, 0.24), 0.20), 0.9);

        // --- mouth ------------------------------------------------------------
        const lip = mixc(skin, 0xa8514a, 0.34);
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
        lg.addColorStop(0.00, rgba(shade(lip, -0.22), 0.72));
        lg.addColorStop(0.48, rgba(shade(lip, -0.30), 0.78));
        lg.addColorStop(0.62, rgba(lip, 0.80));
        lg.addColorStop(1.00, rgba(shade(lip, 0.10), 0.72));
        c.fillStyle = lg; c.fill();
        c.clip();
        for (let i = 0; i < 60; i++) {                        // lip creases
          const lx = fx(0.5) + rand(-mw, mw);
          c.strokeStyle = rgba(shade(lip, -0.45), rand(0.10, 0.28));
          c.lineWidth = rand(0.6, 1.4) * sx;
          c.beginPath(); c.moveTo(lx, lipTopY); c.lineTo(lx + rand(-1, 1) * sx, lipLowY); c.stroke();
        }
        c.restore();
        c.strokeStyle = rgba(shade(lip, -0.68), 0.70);        // the mouth line itself
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
        overlay(c, w, h, 0.10, 3, _weaveTile);
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
        printed(() => drawMark(c, w * 0.75, yv(0.615), h * 0.185, T.graphic, ink, T.body), 0.75);
        if (T.graphic.mark !== 'none') {
          printed(() => {
            drawMark(c, w * 0.25, yv(0.66), h * 0.180, T.graphic, ink, T.body);
            text(c, 'MIRRA CITY', w * 0.25, yv(0.50), h * 0.030, rgba(ink, 0.8),
              { spacing: h * 0.006, maxWidth: w * 0.22 });
          }, 0.25);
        }
        overlay(c, w, yv(hem), 0.14, 3, _weaveTile);
        folds(c, w, yv(hem), 16, rgba(shade(T.body, -0.65), 0.38), 0.55);
        folds(c, w, yv(hem), 8, rgba(shade(T.body, 0.5), 0.16), 0.5);
        // the garment pulls into the armpits and drapes off the shoulders
        for (const u0 of [0.02, 0.48]) {
          const g3 = c.createLinearGradient(w * u0, 0, w * (u0 + 0.10), 0);
          g3.addColorStop(0, rgba(shade(T.body, -0.55), 0.30));
          g3.addColorStop(1, rgba(shade(T.body, -0.55), 0));
          c.fillStyle = g3; c.fillRect(w * u0, 0, w * 0.10, yv(hem + 0.25));
        }
        overlay(c, w, h, 0.10, 4);
      },
      rough: (c, w, h, X) => {
        fill(c, w, h, X.top.style === 'jersey' ? '#d2d2d2' : '#f0f0f0');
        overlay(c, w, h, 0.25, 4);
        // cloth is not uniformly matte: fold crests and the printed panel take a
        // slightly tighter sheen than the flat weave around them
        folds(c, w, h, 14, 'rgba(176,176,176,0.45)', 0.5);
        blob(c, w * 0.75, h * 0.40, w * 0.10, h * 0.10, 'rgba(150,150,150,0.55)', 0.9);
        blob(c, w * 0.25, h * 0.36, w * 0.10, h * 0.10, 'rgba(150,150,150,0.55)', 0.9);
      },
      hsig: (X) => `${X.top.style}|${X.top.graphic.mark}`,
      height: (c, w, h, X) => {
        const yv = (v) => (1 - v) * h;
        fill(c, w, h, '#808080');
        overlay(c, w, h, 0.55, 12, _weaveTile);
        folds(c, w, h, 18, '#4e4e4e', 0.6);
        folds(c, w, h, 10, '#b6b6b6', 0.5);
        c.fillStyle = '#c0c0c0'; c.fillRect(0, 0, w, h * 0.030);
        drawMarkHeight(c, w * 0.75, yv(0.615), h * 0.185, X.top.graphic);
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
        fill(c, w, h, HEX(T.sleeve));
        overlay(c, w, h, 0.10, 2, _weaveTile);
        // cuff at the far end of the sleeve (v = 1 → canvas top)
        c.fillStyle = HEX(T.trim);
        c.fillRect(0, 0, w, h * 0.075);
        c.fillStyle = rgba(shade(T.sleeve, -0.5), 0.5);
        c.fillRect(0, h * 0.075, w, h * 0.022);
        if (T.style === 'jersey' || T.style === 'raglan') {
          c.fillStyle = rgba(T.trim, 0.75);
          c.fillRect(0, h * 0.15, w, h * 0.030);
          c.fillRect(0, h * 0.20, w, h * 0.014);
        }
        folds(c, w, h, 10, rgba(shade(T.sleeve, -0.6), 0.32), 0.55);
        overlay(c, w, h, 0.10, 3);
      },
      rough: (c, w, h) => {
        fill(c, w, h, '#f0f0f0');
        overlay(c, w, h, 0.25, 3);
        folds(c, w, h, 10, 'rgba(180,180,180,0.45)', 0.5);
      },
      hsig: () => 'k',
      height: (c, w, h) => {
        fill(c, w, h, '#808080');
        overlay(c, w, h, 0.5, 6, _weaveTile);
        folds(c, w, h, 12, '#4e4e4e', 0.6);
        folds(c, w, h, 7, '#b8b8b8', 0.5);
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
        const col = X.bottom.colour;
        const denim = X.bottom.style === 'jeans';
        fill(c, w, h, HEX(col));
        overlay(c, w, h, denim ? 0.16 : 0.10, 3, _weaveTile);
        if (denim) {
          // warp/weft twill: fine diagonal lines
          c.save(); c.globalAlpha = 0.16;
          c.strokeStyle = HEX(shade(col, 0.42)); c.lineWidth = 1.2;
          for (let i = -h; i < w; i += 5) {
            c.beginPath(); c.moveTo(i, 0); c.lineTo(i + h, h); c.stroke();
          }
          c.restore();
          // whiskering + fade at the thigh front (u = 0.25)
          const fade = c.createLinearGradient(0, 0, w, 0);
          fade.addColorStop(0, 'rgba(255,255,255,0)');
          fade.addColorStop(0.25, rgba(shade(col, 0.35), 0.12));
          fade.addColorStop(0.5, 'rgba(255,255,255,0)');
          fade.addColorStop(0.75, rgba(shade(col, 0.55), 0.22));
          fade.addColorStop(1, 'rgba(255,255,255,0)');
          c.fillStyle = fade; c.fillRect(0, 0, w, h);
        }
        folds(c, w, h, 22, rgba(shade(col, -0.62), 0.40), 0.6);
        folds(c, w, h, 12, rgba(shade(col, 0.55), 0.16), 0.5);
        // seams at u = 0 (outer) and u = 0.5 (inner)
        const seam = rgba(denim ? 0xd6c6a0 : shade(col, 0.4), 0.55);
        stitchLine(c, 2, 0, 2, h, seam, 2, [5, 6]);
        stitchLine(c, w - 2, 0, w - 2, h, seam, 2, [5, 6]);
        stitchLine(c, w * 0.5 - 3, 0, w * 0.5 - 3, h, seam, 2, [5, 6]);
        stitchLine(c, w * 0.5 + 3, 0, w * 0.5 + 3, h, seam, 2, [5, 6]);
        overlay(c, w, h, 0.12, 4);
        chips(c, w, h, 30, rgba(shade(col, 0.6), 0.10), 2, 7);
      },
      rough: (c, w, h, X) => {
        fill(c, w, h, X.bottom.style === 'jeans' ? '#e6e6e6' : '#efefef');
        overlay(c, w, h, 0.3, 4);
        // denim polishes where it rubs: the crest of every fold and the knee
        folds(c, w, h, 20, 'rgba(168,168,168,0.45)', 0.5);
        blob(c, w * 0.25, h * 0.52, w * 0.16, h * 0.10, 'rgba(150,150,150,0.40)', 0.9);
      },
      hsig: (X) => `${X.bottom.style}`,
      height: (c, w, h, X) => {
        fill(c, w, h, '#808080');
        overlay(c, w, h, X.bottom.style === 'jeans' ? 0.62 : 0.45, 10, _weaveTile);
        folds(c, w, h, 24, '#4a4a4a', 0.65);
        folds(c, w, h, 14, '#bcbcbc', 0.55);
        stitchLine(c, 2, 0, 2, h, '#d0d0d0', 3, [5, 6]);
        stitchLine(c, w - 2, 0, w - 2, h, '#d0d0d0', 3, [5, 6]);
        stitchLine(c, w * 0.5, 0, w * 0.5, h, '#d0d0d0', 3, [5, 6]);
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
        // eyestay panels either side of the instep
        c.fillStyle = rgba(shade(col, -0.30), 0.85);
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
      key: 'SOLE', u: 1, sig: (X) => `${X.shoe.sole}|${X.shoe.colour}`,
      colour: (c, w, h, X) => {
        fill(c, w, h, HEX(X.shoe.sole));
        overlay(c, w, h, 0.22, 4);
        c.fillStyle = rgba(shade(X.shoe.sole, -0.55), 0.5);
        for (let i = 0; i < 28; i++) c.fillRect((i / 28) * w, h * 0.15, w * 0.016, h * 0.7);
        c.fillStyle = HEX(shade(X.shoe.sole, 0.55));
        c.fillRect(0, 0, w, h * 0.12);                        // midsole stripe
        chips(c, w, h, 40, 'rgba(60,52,40,0.4)', 1, 4);
      },
      rough: (c, w, h) => fill(c, w, h, '#b8b8b8'),
      hsig: () => 'k',
      height: (c, w, h) => {
        fill(c, w, h, '#808080');
        c.fillStyle = '#d8d8d8';
        for (let i = 0; i < 28; i++) c.fillRect((i / 28) * w, h * 0.15, w * 0.016, h * 0.7);
      },
    },
    // ---------------------------------------------------------------- gloves
    {
      key: 'GLOVE', u: 1, sig: (X) => `${X.glove.colour}|${X.glove.on}|${X.top.trim}`,
      colour: (c, w, h, X) => {
        const col = X.glove.colour;
        fill(c, w, h, HEX(col));
        overlay(c, w, h, 0.20, 3, _weaveTile);
        // knuckle panels on the back of the hand (u = 0.75 side of the palm capsule)
        c.fillStyle = rgba(shade(col, -0.35), 0.9);
        for (let i = 0; i < 4; i++) {
          c.beginPath();
          c.roundRect(w * (0.12 + i * 0.075), h * 0.30, w * 0.055, h * 0.30, w * 0.012);
          c.fill();
        }
        c.fillStyle = rgba(separate(X.top.trim, col, 0.2), 0.9);
        c.fillRect(0, h * 0.80, w, h * 0.075);                // wrist strap
        c.fillStyle = rgba(shade(col, 0.35), 0.4);
        c.fillRect(0, h * 0.06, w, h * 0.05);                 // palm grip patch
        folds(c, w, h, 10, rgba(shade(col, -0.6), 0.35), 0.55);
      },
      rough: (c, w, h) => { fill(c, w, h, '#e2e2e2'); overlay(c, w, h, 0.3, 4); },
      hsig: () => 'k',
      height: (c, w, h) => {
        fill(c, w, h, '#808080');
        overlay(c, w, h, 0.45, 6, _weaveTile);
        c.fillStyle = '#c8c8c8';
        for (let i = 0; i < 4; i++) {
          c.beginPath(); c.roundRect(w * (0.12 + i * 0.075), h * 0.30, w * 0.055, h * 0.30, w * 0.012); c.fill();
        }
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
  return [
    {
      key: 'SHELL', u: 2, sig,
      colour: (c, w, h, X) => {
        const col = X.lid.colour;
        fill(c, w, h, HEX(col));
        const grad = c.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, 'rgba(255,255,255,0.12)');
        grad.addColorStop(1, 'rgba(0,0,0,0.38)');
        c.fillStyle = grad; c.fillRect(0, 0, w, h);
        c.fillStyle = HEX(X.accent);
        c.fillRect(0, 0, w * 0.028, h); c.fillRect(w * 0.972, 0, w * 0.028, h);
        c.fillRect(w * 0.486, 0, w * 0.028, h);
        c.fillStyle = rgba(shade(X.accent, -0.4), 0.9);
        c.fillRect(w * 0.032, 0, w * 0.014, h); c.fillRect(w * 0.954, 0, w * 0.014, h);
        c.fillRect(w * 0.518, 0, w * 0.014, h);
        const ink = inkOn(col);
        text(c, 'GRIT', w * 0.25, h * 0.62, h * 0.26, HEX(ink), { skew: -0.2, spacing: 3 });
        text(c, 'GRIT', w * 0.75, h * 0.62, h * 0.26, HEX(ink), { skew: -0.2, spacing: 3 });
        scratches(c, w, h, 60, HEX(shade(col, 0.5)), 6, 50, 0.7);
        overlay(c, w, h, 0.1, 3);
      },
      rough: (c, w, h) => { fill(c, w, h, '#3a3a3a'); scratches(c, w, h, 70, '#8a8a8a', 6, 50, 0.8); },
      hsig: () => 'k',
      height: (c, w, h) => { fill(c, w, h, '#808080'); overlay(c, w, h, 0.25, 4); },
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
    // --- rider -------------------------------------------------------------
    skin: R.skin.colour,
    hair: { colour: P.hair.colour, style: P.hair.style, volume: hairOpt.volume ?? 0.4, long: hairOpt.long ?? 0 },
    beard: { colour: P.facialHair.colour, style: P.facialHair.style, coverage: beardOpt.coverage ?? 0 },
    eye: eyeColourFor(P.hair.colour),
    top: {
      style: P.top.style,
      body: fabricAlbedo(P.top.colour),
      sleeve: fabricAlbedo(twoTone ? trim : P.top.colour),
      trim: fabricAlbedo(trim, 0.19),
      sleeveLen: TOP_SLEEVE[P.top.style] ?? 0.45,
      loose: TOP_LOOSE[P.top.style] ?? 0.5,
      hood: P.top.style === 'hoodie',
      trimCuff: twoTone || P.top.style === 'hoodie',
      graphic: { mark: R.top.graphicMark, text: R.top.graphicText },
    },
    bottom: {
      style: P.bottom.style, colour: fabricAlbedo(P.bottom.colour, 0.20),
      length: BOTTOM_LEN[P.bottom.style] ?? 1,
      loose: BOTTOM_LOOSE[P.bottom.style] ?? 0.5,
      cuffed: P.bottom.style === 'joggers',
    },
    shoe: {
      style: P.shoes.style, colour: fabricAlbedo(P.shoes.colour, 0.185), laces: P.shoes.laces,
      sole: P.shoes.style === 'vulc' || P.shoes.style === 'skate' ? 0x9c6a34
        : P.shoes.style === 'boot' ? 0x2a2723 : 0xd8d6cf,
      bulk: SHOE_BULK[P.shoes.style] ?? 0.6,
      high: SHOE_HIGH[P.shoes.style] ?? 0,
    },
    glove: { on: !!P.gloves.on, colour: fabricAlbedo(P.gloves.colour, 0.19) },
    pad: { ...P.pads, colour: 0x2e3138 },
    lid: {
      style: P.headwear, colour: fabricAlbedo(P.headwearColour, 0.185),
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

  // --- 36 spokes, three-cross, plus brass nipples -----------------------------
  const rimHole = 0.1955, crossA = G.cross * 2 * (TAU / G.spokes);
  const nipples = [];
  for (let s = 0; s < 2; s++) {
    const sx = s ? 1 : -1;
    for (let i = 0; i < G.spokes / 2; i++) {
      const hubA = (i / (G.spokes / 2)) * TAU + s * (TAU / G.spokes);
      const dir = i % 2 === 0 ? 1 : -1;
      const rimA = hubA + dir * crossA;
      const a = wheelPt(sx * (G.flangeX + 0.0018), G.flangeR - 0.0035, hubA);
      const b = wheelPt(sx * 0.0062, rimHole, rimA);
      hw.push(AH.patch(rod(a, b, 0.00105, 0.00095, 5, false), 'CHROME', 0.2, 0.8));
      const nb = wheelPt(sx * 0.0062, rimHole - 0.0075, rimA);
      nipples.push(rod(b, nb, 0.0027, 0.0022, 5, true));
    }
  }
  hw.push(AH.patch(merge(nipples), 'BRASS'));

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
function buildTyre(tread, AR) {
  const rub = [];
  // the bead sits just proud of the rim's outer wall so the rim colour reads
  const tyreProfile = [
    [0.2140, -0.0110], [0.2215, -0.0225], [0.2360, -0.0288], [0.2505, -0.0268],
    [0.2578, -0.0160], [0.2600, 0.0000], [0.2578, 0.0160], [0.2505, 0.0268],
    [0.2360, 0.0288], [0.2215, 0.0225], [0.2140, 0.0110],
  ];
  rub.push(AR.uv(latheX(tyreProfile, 40), 'TYRE'));

  if (tread !== 'slick') {
    const knobs = [];
    const rows = tread === 'street' ? 26 : 20;
    for (let i = 0; i < rows; i++) {
      const a = (i / rows) * TAU;
      const set = tread === 'street'
        ? [[-0.012, 0.2585, 0.0090, 0.0060], [0.012, 0.2585, 0.0090, 0.0060]]
        : i % 2 === 0
          ? [[0, 0.2585, 0.0135, 0.0095], [-0.0195, 0.2505, 0.0105, 0.0115], [0.0195, 0.2505, 0.0105, 0.0115]]
          : [[-0.0085, 0.2570, 0.0110, 0.0090], [0.0085, 0.2570, 0.0110, 0.0090],
            [-0.0245, 0.2440, 0.0100, 0.0110], [0.0245, 0.2440, 0.0100, 0.0110]];
      for (const [x, r, len, wid] of set) {
        const kb = new THREE.BoxGeometry(wid, tread === 'street' ? 0.0032 : 0.0055, len);
        const p = wheelPt(x, r, a);
        const out = V(0, Math.cos(a), Math.sin(a));
        place(kb, p, p.clone().addScaledVector(out, 0.0055), V(1, 0, 0));
        knobs.push(kb);
      }
    }
    rub.push(AR.patch(merge(knobs), 'TYRE', 0.02, 0.03, 0.44));
  }
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
    const a = crown.clone().add(V(s * 0.040, 0.006, 0));
    const m = crown.clone().lerp(frontAxle, 0.55).add(V(s * 0.052, 0.006, 0.004));
    const b = V(s * 0.056, frontAxle.y + 0.006, frontAxle.z - 0.002);
    paint.push(AP.uv(sweep([a, m, b], {
      radius: 0.0182, radial: 8, steps: 16,
      taper: (t) => lerp(1.0, 0.62, smoothstep(t)),
      oval: (t) => [lerp(0.92, 0.78, t), lerp(1.06, 1.22, t)],
    }), 'MAIN'));

    // dropout
    const dshape = new THREE.Shape();
    dshape.moveTo(-0.026, 0.030); dshape.lineTo(0.024, 0.030);
    dshape.lineTo(0.026, -0.006); dshape.lineTo(0.000, -0.026);
    dshape.lineTo(-0.026, -0.020); dshape.closePath();
    const slot = new THREE.Path();
    slot.moveTo(-0.0085, -0.026); slot.absarc(0, 0, 0.0085, -Math.PI / 2, Math.PI / 2, true);
    slot.lineTo(0.0085, -0.026); slot.lineTo(-0.0085, -0.026);
    dshape.holes.push(slot);
    const dp = plate(dshape, 0.0085, 0.0007, 4);
    dp.rotateY(Math.PI / 2);
    dp.translate(s * 0.056, frontAxle.y, frontAxle.z);
    paint.push(AP.uv(dp, 'DARK'));
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

  // bar: one continuous sweep from grip to grip, with the crossbar added after
  const half = [
    [0.000, 0.000, 0.000], [0.052, 0.004, 0.000], [0.086, 0.062, -0.010],
    [0.104, 0.150, -0.028], [0.132, 0.208, -0.044], [0.186, 0.222, -0.056],
    [0.262, 0.226, -0.066], [0.330, 0.228, -0.074],
  ];
  const pts = [];
  for (let i = half.length - 1; i >= 1; i--) pts.push(barCentre.clone().add(V(-half[i][0], half[i][1], half[i][2])));
  pts.push(barCentre.clone());
  for (let i = 1; i < half.length; i++) pts.push(barCentre.clone().add(V(half[i][0], half[i][1], half[i][2])));
  hw.push(AH.uv(sweep(pts, { radius: 0.0143, radial: 8, steps: 40, tension: 0.42 }), 'CHROME'));

  // crossbar
  const cbY = 0.150, cbA = [], cbB = [];
  for (const s of [-1, 1]) {
    cbA.push(barCentre.clone().add(V(s * 0.104, cbY, -0.028)));
    cbB.push(barCentre.clone().add(V(s * 0.070, cbY + 0.028, -0.020)));
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

  const face = plate(roundedRectShape(0.048, 0.052, 0.008), 0.014, 0.001, 4);
  face.applyMatrix4(basis);
  face.translate(barCentre.x + fwd.x * 0.018, barCentre.y + fwd.y * 0.018, barCentre.z + fwd.z * 0.018);
  hw.push(AH.uv(face, 'ANOD'));

  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const bolt = new THREE.CylinderGeometry(0.0042, 0.0042, 0.020, 6);
      const o = barCentre.clone()
        .addScaledVector(fwd, 0.022)
        .addScaledVector(up, sy * 0.017)
        .addScaledVector(side, sx * 0.017);
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

  // brake lever on the right bar
  const gripInner = barCentre.clone().add(V(0.180, 0.222, -0.056));
  const gripOuter = barCentre.clone().add(V(0.330, 0.228, -0.074));
  const perch = latheX([[0.0143, 0], [0.0210, 0], [0.0210, 0.020], [0.0143, 0.020]], 14);
  const gdir = gripOuter.clone().sub(gripInner).normalize();
  _q.setFromUnitVectors(V(1, 0, 0), gdir);
  perch.applyQuaternion(_q);
  const perchP = gripInner.clone().addScaledVector(gdir, -0.020);
  perch.translate(perchP.x, perchP.y, perchP.z);
  hw.push(AH.patch(perch, 'ANOD'));

  const bladeShape = new THREE.Shape();
  bladeShape.moveTo(0, 0); bladeShape.lineTo(0.086, -0.012);
  bladeShape.quadraticCurveTo(0.100, -0.014, 0.098, -0.024);
  bladeShape.lineTo(0.080, -0.026); bladeShape.lineTo(0.004, -0.012); bladeShape.closePath();
  const blade = plate(bladeShape, 0.0075, 0.0008, 4);
  const bFwd = V(0, 0, 1), bUp = V(0, 1, 0);
  blade.applyMatrix4(new THREE.Matrix4().makeBasis(bFwd, bUp, new THREE.Vector3().crossVectors(bFwd, bUp)));
  blade.translate(perchP.x + 0.012, perchP.y - 0.006, perchP.z + 0.016);
  hw.push(AH.patch(blade, 'ALLOY'));

  rub.push(AR.uv(sweep([
    perchP.clone().add(V(0.004, 0.010, 0.016)),
    perchP.clone().add(V(-0.03, 0.036, 0.030)),
    barCentre.clone().add(V(0.02, 0.230, -0.010)),
    barCentre.clone().add(V(0.0, 0.120, 0.010)),
    ghp.clone().add(V(0.0, 0.014, 0.012)),
  ], { radius: 0.0026, radial: 5, steps: 24 }), 'CABLE'));

  // grips with bar-end plugs
  const gripPts = [];
  gripPts.push([0.0125, 0.000], [0.0175, 0.004], [0.0178, 0.013], [0.0150, 0.017]);
  for (let i = 0; i < 11; i++) {
    const y = 0.019 + i * 0.0106;
    gripPts.push([i % 2 ? 0.0172 : 0.0159, y]);
  }
  gripPts.push([0.0168, 0.140], [0.0180, 0.146], [0.0150, 0.150], [0.0, 0.150]);
  for (const s of [-1, 1]) {
    const gi = barCentre.clone().add(V(s * 0.180, 0.222, -0.056));
    const go = barCentre.clone().add(V(s * 0.336, 0.228, -0.075));
    const gr = new THREE.LatheGeometry(gripPts.map(([r, y]) => new THREE.Vector2(r, y)), 18);
    place(gr, gi, go);
    rub.push(AR.uv(gr, 'GRIP'));

    const plug = latheX([[0, 0], [0.0130, 0], [0.0150, 0.004], [0.0140, 0.010], [0, 0.010]], 16);
    const pdir = go.clone().sub(gi).normalize();
    _q.setFromUnitVectors(V(1, 0, 0), pdir);
    plug.applyQuaternion(_q);
    const pp = gi.clone().addScaledVector(pdir, 0.148);
    plug.translate(pp.x, pp.y, pp.z);
    hw.push(AH.patch(plug, 'ACCENT'));
  }

  const gripAnchorL = barCentre.clone().add(V(-0.255, 0.2245, -0.0655));
  const gripAnchorR = barCentre.clone().add(V(0.255, 0.2245, -0.0655));
  return { hardware: merge(hw), rubber: merge(rub), gripAnchorL, gripAnchorR, barCentre };
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

  // chainring on the drive side
  const { shape: ringShape, R: ringR } = sprocketShape(G.sprocketTeeth, G.pitch, 5, 0.0115);
  const ring = plate(ringShape, 0.0052, 0.0007, 4);
  ring.rotateY(Math.PI / 2);
  ring.rotateX(Math.PI / 2);
  ring.translate(G.chainLine, bb.y, bb.z);
  hw.push(AH.uv(ring, 'ALLOY'));
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + 0.5;
    const bolt = new THREE.CylinderGeometry(0.0045, 0.0045, 0.014, 6);
    bolt.rotateZ(Math.PI / 2);
    bolt.translate(0.048, bb.y + Math.sin(a) * ringR * 0.30, bb.z + Math.cos(a) * ringR * 0.30);
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

  const linkParts = [];
  for (const s of [-1, 1]) {
    const pl = new THREE.BoxGeometry(G.pitch * 1.12, 0.0072, 0.0013);
    pl.translate(G.pitch * 0.5, 0, s * 0.0026);
    linkParts.push(AH.patch(pl, 'OILY'));
  }
  const roller = new THREE.CylinderGeometry(0.0037, 0.0037, 0.0048, 5);
  roller.rotateX(Math.PI / 2);
  linkParts.push(AH.patch(roller, 'STEEL'));

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

  const gripMid = pts.gripL.clone().add(pts.gripR).multiplyScalar(0.5);
  const wristMid = V(0, gripMid.y + 0.012 * hs, gripMid.z - 0.020 * hs);
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

  const shoulder = (s) => chest.clone()
    .add(V(s * 0.180 * M.shoulderWidth, 0.022 * hs, 0.004));
  const wristFor = (s) => (s > 0 ? pts.gripR : pts.gripL).clone().add(V(0, 0.012 * hs, -0.020 * hs));
  const hip = (s) => hips.clone().add(V(s * 0.096 * M.hipWidth, -0.014 * hs, 0.012));
  const ankle = (s) => (s > 0 ? pts.pedalR : pts.pedalL).clone()
    .add(V(s * -0.008, 0.074 * hs + M.fit.pedalDrop, -0.030));

  const pose = { hips, spine, chest, neck, head, lean, front, leanA, L };
  for (const [side, s] of [['R', 1], ['L', -1]]) {
    const sh = shoulder(s), wr = wristFor(s);
    const el = ikJoint(sh, wr, L.upperArm, L.foreArm, V(s * 0.86, -0.34, -0.38));
    const hp = hip(s), an = ankle(s);
    const kn = ikJoint(hp, an, L.thigh, L.shin, V(s * (0.30 + M.fit.standWidth * 8), 0.16, 1.0));
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

  // --- cranium ---------------------------------------------------------------
  if (yn > 0.42) {                                          // dome narrows and flattens
    const k = (yn - 0.42) / 0.58;
    px *= 1 - 0.20 * k * k;
    pz *= 1 - 0.13 * k * k;
    py -= k * k * 0.050 * R;
  }
  // the back of the skull is a plane, not a ball
  pz += Math.max(0, -zn - 0.55) * _g(yn - 0.35, 0.55) * 0.10 * R;
  px *= 1 - 0.050 * _g(yn - 0.40, 0.20) * Math.max(0, 1 - Math.abs(zn) * 1.15);   // temples
  pz -= Math.max(0, -zn) * _g(yn - 0.14, 0.40) * 0.022 * R;                        // occiput

  // --- mandible --------------------------------------------------------------
  const jl = clamp((-0.20 - yn) / 0.72, 0, 1);
  px *= 1 - (0.40 + 0.14 * (1 - S.jaw)) * Math.pow(jl, 1.55);
  pz *= 1 - 0.14 * Math.pow(jl, 2.1);
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
  pz += chin * 0.115 * R * S.jaw;
  py -= chin * 0.014 * R;
  pz += _g(yn + 0.86, 0.10) * _g(xn, 0.17) * Math.max(0, zn) * 0.030 * R;   // chin button
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
    const fwd = lerp(0.028, 0.185, smoothstep(clamp((nh - 0.10) / 0.66, 0, 1)));
    pz += along * across * fwd * R * front;
    // alae flare either side of the tip, nostrils cut in underneath
    const ala = _g(nh - 0.95, 0.13) * _g(ax - 0.180, 0.080) * front;
    px += sgn * ala * 0.030 * R;
    pz += ala * 0.020 * R;
    const nostril = _g(nh - 1.09, 0.09) * _g(ax - 0.110, 0.060) * front;
    pz -= nostril * 0.032 * R;
    py -= nostril * 0.006 * R;
  }

  // --- brow, sockets, eyes ---------------------------------------------------
  const brow = _g(yn - 0.157, 0.105) * Math.max(0, zn - 0.22) * (0.50 + 0.50 * _g(ax - 0.30, 0.27));
  pz += brow * 0.058 * R * S.brow;
  const eyeX = ax - 0.315;
  pz -= _g(yn - 0.030, 0.100) * _g(eyeX, 0.170) * Math.max(0, zn - 0.28) * 0.040 * R;   // socket
  pz += _g(yn - 0.025, 0.065) * _g(eyeX, 0.100) * Math.max(0, zn - 0.42) * 0.032 * R;   // globe
  pz -= _g(yn - 0.090, 0.028) * _g(eyeX, 0.090) * Math.max(0, zn - 0.42) * 0.014 * R;   // lid crease

  // --- cheeks ----------------------------------------------------------------
  const zyg = _g(yn + 0.170, 0.150) * _g(ax - 0.600, 0.245) * Math.max(0, zn * 0.65 + 0.35);
  px += sgn * zyg * 0.042 * R;
  pz += zyg * 0.016 * R;
  const hollow = _g(yn + 0.400, 0.165) * _g(ax - 0.470, 0.230) * front;
  pz -= hollow * 0.040 * R;
  px -= sgn * hollow * 0.032 * R;
  // nasolabial fold, and the soft pad of the cheek beside the mouth
  pz -= _g(yn + 0.470, 0.070) * _g(ax - 0.225, 0.065) * front * 0.016 * R;
  pz += _g(yn + 0.560, 0.100) * _g(ax - 0.300, 0.100) * front * 0.008 * R;
  return V(px, py, pz);
}

function buildHead(centre, R, S) {
  const NU = 40, NV = 26;
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
    .addScaledVector(out, -0.040 * R).addScaledVector(fore, -0.020 * R);
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
    const rimAmt = smoothstep(clamp((rho - 0.52) / 0.48, 0, 1));
    const rimArc = smoothstep(clamp((th - 0.05) / 1.05, 0, 1))
      * (1 - 0.50 * smoothstep(clamp((th - 4.60) / 1.20, 0, 1)));
    // concha bowl, antihelix ridge behind it, tragus over the canal
    const bowl = (1 - smoothstep(clamp((rho - 0.04) / 0.42, 0, 1))) * clamp(0.45 + cth * 0.75, 0, 1);
    const anti = _g(rho - 0.50, 0.20) * clamp(0.30 - cth * 0.85, 0, 1) * Math.max(0, sth + 0.35);
    const tragus = _g(rho - 0.30, 0.20) * _g(Math.atan2(Math.sin(th + 0.35), Math.cos(th + 0.35)), 0.45);
    const d = 0.050 * R * rimAmt * rimArc + 0.020 * R * anti
      - 0.052 * R * bowl + 0.026 * R * tragus;
    const p = at.clone()
      .addScaledVector(fore, px)
      .addScaledVector(up, py)
      .addScaledVector(out, shellOut > 0 ? d + 0.016 * R
        : -0.014 * R - 0.020 * R * (1 - rho) * clamp(0.5 + Math.cos(th) * 0.9, 0, 1));
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
  return 0.034 * spec.t * (0.6 + 0.7 * vol) * (R / 0.098);
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
  const lineAt = (a) => lowV + (beanie ? 0.070 : backwards ? 0.098 : 0.058) * Math.max(0, Math.cos(a))
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
    const brim = slab((u, t) => {
      const s = (u - 0.5) * 2;                             // -1 … 1 across the peak
      const a = dir + s * span;
      const v = lineAt(a) + 0.030;
      const base = shell(a, v);
      const out = V(Math.sin(a) * 0.62, -0.16, Math.cos(a) * 0.98).normalize();
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
 * A closed fist on a bar. The palm lies along the bar, four fingers curl over
 * the front and tuck under, the thumb crosses the front diagonally toward the
 * fingertips, and the knuckle row stands proud. ~520 triangles.
 */
function buildFist(wrist, barDir, handR, glove) {
  const F = frameOf(barDir, V(0, 1, 0));
  const along = F.y, up = F.z, fwd = F.x;
  const parts = [];
  const g = glove ? 1.08 : 1.0;
  // palm: from just inboard of the wrist to the far side of the fist
  const a0 = wrist.clone().addScaledVector(along, -handR * 0.22);
  const a1 = wrist.clone().addScaledVector(along, handR * 1.55);
  parts.push(placeZ(capsule2(a0.distanceTo(a1), handR * 0.70 * g, handR * 0.64 * g, {
    radial: 10, capSegs: 3, bodyRings: 3,
    mid: (t) => 1 + 0.10 * Math.sin(t * Math.PI),
    shape: (t) => [lerp(0.78, 0.70, t), lerp(0.98, 1.06, t)],
  }), a0, a1, up));

  // the grip axis the fingers close around, a little forward and below the palm
  const centre = wrist.clone().addScaledVector(along, handR * 0.62)
    .addScaledVector(fwd, handR * 0.30).addScaledVector(up, -handR * 0.18);
  const at = (s, deg, r) => centre.clone()
    .addScaledVector(along, s)
    .addScaledVector(up, Math.cos(deg * DEG) * r)
    .addScaledVector(fwd, Math.sin(deg * DEG) * r);

  for (let i = 0; i < 4; i++) {
    const t = i / 3;
    const s = lerp(-handR * 0.42, handR * 0.72, t);
    const fr = handR * lerp(0.215, 0.170, t) * g;         // index thickest
    const reach = lerp(1.00, 0.90, Math.abs(t - 0.35) * 1.2);
    parts.push(sweep([
      at(s, 8, handR * 0.86 * reach),
      at(s, 62, handR * 0.94 * reach),
      at(s * 0.94, 118, handR * 0.80 * reach),
      at(s * 0.86, 168, handR * 0.52 * reach),
    ], { radius: fr, radial: 6, steps: 7, taper: (k) => lerp(1.0, 0.78, k) }));
    // knuckle
    const kn = new THREE.SphereGeometry(fr * 1.18, 7, 5);
    const kp = at(s, 6, handR * 0.90 * reach);
    kn.translate(kp.x, kp.y, kp.z);
    parts.push(kn);
  }
  // thumb: base pad at the inboard back, wrapping across the front
  parts.push(sweep([
    at(-handR * 0.52, -66, handR * 0.80),
    at(-handR * 0.20, -14, handR * 0.95),
    at(handR * 0.28, 44, handR * 0.94),
    at(handR * 0.66, 86, handR * 0.80),
  ], { radius: handR * 0.255 * g, radial: 7, steps: 7, taper: (k) => lerp(1.05, 0.72, k) }));
  return merge(parts);
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
  const torsoA = pose.hips.clone().addScaledVector(pose.lean, -0.105 * hs);
  const torsoB = pose.neck.clone();
  const torsoLen = torsoA.distanceTo(torsoB);
  const wLo = M.hipWidth * 1.16, wHi = M.shoulderWidth * 1.30;
  const dLo = M.waistDepth * 0.86, dHi = M.chestDepth * 0.90;
  const torso = limb(torsoA, torsoB, 0.150 * hs, 0.086 * hs, {
    radial: 18, capSegs: 4, bodyRings: 11,
    // hem flare → waist → ribcage → the shoulder yoke
    mid: (t) => (t < 0.15 ? lerp(1.10 + topLoose * 0.10, 0.92, smoothstep(t / 0.15))
      : t < 0.62 ? lerp(0.92, 1.26, smoothstep((t - 0.15) / 0.47))
        : lerp(1.26, 1.02, smoothstep((t - 0.62) / 0.38))) * (1 + topLoose * 0.10),
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
    const collar = placeZ(capsule2(0.030 * hs, cR * 1.24, cR * 1.16, {
      radial: 14, capSegs: 2, capA: 0.4, capB: 0.4, shape: () => [1.06, 1.0],
    }), torsoB.clone().addScaledVector(nDir, -0.012 * hs), torsoB.clone().addScaledVector(nDir, 0.018 * hs),
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
  }

  const lidCover = X.lid.style === 'beanie' ? 0.72 : X.lid.style === 'helmet' ? 0.88 : 0.0;
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
  const sleeveT = X.top.sleeveLen;
  const upperFrac = 0.535;
  for (const [side, s] of [['R', 1], ['L', -1]]) {
    const sh = pose['shoulder' + side], el = pose['elbow' + side], wr = pose['wrist' + side];
    const skinU = (g) => skinPart(g, boneIndex, 'shoulder' + side, 'elbow' + side, sh, el, 0.45, 1.0, 0.62);
    const skinF = (g) => skinPart(g, boneIndex, 'elbow' + side, 'wrist' + side, el, wr, 0.55, 1.0, 0.9);
    const rShoulder = 0.052 * hs * girth, rElbow = 0.040 * hs * girth;
    const rFore = 0.039 * hs * M.forearmGirth, rWrist = 0.029 * hs * M.forearmGirth;
    const puff = 1 + 0.07 + topLoose * 0.15;
    // Muscle, not pipe: a deltoid swell at the top of the upper arm, a biceps
    // belly at 45 %, a brachioradialis swell just past the elbow, then a real
    // taper into a flattened wrist.
    const armMid = (t) => bulge(t, 0.08, 0.22, 0.20 * girth) * bulge(t, 0.46, 0.26, 0.11 * girth);
    const armShape = (t) => [1 + 0.05 * _g(t - 0.10, 0.22), lerp(1.07, 0.99, t)];
    const foreMid = (t) => bulge(t, 0.17, 0.24, 0.17 * M.forearmGirth);
    const foreShape = (t) => [lerp(1.03, 0.80, smoothstep(t)), lerp(0.99, 1.14, smoothstep(t))];

    // deltoid cap — fills the armpit and gives the silhouette a shoulder
    const delt = new THREE.SphereGeometry(1, 12, 9);
    delt.scale(0.062 * hs * girth * M.shoulderWidth, 0.058 * hs * girth, 0.060 * hs * girth);
    delt.translate(sh.x + s * 0.006 * hs, sh.y + 0.012 * hs, sh.z);
    // Keep the sphere well inside its region: a small part sitting near a region
    // boundary samples a coarse mip and drags the neighbouring band's colour on
    // to the shoulder as a pale blotch.
    const du = delt.attributes.uv;
    for (let i = 0; i < du.count; i++) {
      du.setXY(i, 0.28 + du.getX(i) * 0.44, 0.34 + du.getY(i) * 0.32);
    }
    push(delt, X.top.style === 'tank' ? 'SKIN' : (sleeveT > 0.02 ? 'SLEEVE' : 'TOP'),
      (g) => skinPart(g, boneIndex, 'chest', 'shoulder' + side, pose.chest, sh, 0.1, 0.9, 0.75));

    // upper arm: sleeve then skin, split wherever the sleeve ends
    const tUp = clamp(sleeveT / upperFrac, 0, 1);
    const shOut = sh.clone().addScaledVector(el.clone().sub(sh).normalize(), -0.030 * hs);
    if (tUp > 0.02) {
      const end = sh.clone().lerp(el, tUp);
      const sleeve = limb(shOut, end, rShoulder * puff, lerp(rShoulder, rElbow, tUp) * puff, {
        radial: 12, capSegs: 4, bodyRings: 6, capB: 0.30,
        shape: (t) => [1, lerp(1.06, 1.0, t)],
        // a sleeve hangs off the deltoid: tight at the shoulder, loose and
        // slightly flared where it ends
        mid: (t) => 1 + topLoose * (0.05 + 0.10 * smoothstep(t)) * Math.sin(t * 2.2),
      });
      push(sleeve, X.top.style === 'tank' ? 'TOP' : 'SLEEVE', skinU);
      if (tUp < 0.98 && sleeveT > 0.02 && X.top.trimCuff) {
        const cuff = limb(sh.clone().lerp(el, Math.max(0, tUp - 0.06)), end.clone(),
          lerp(rShoulder, rElbow, tUp) * (puff + 0.02), lerp(rShoulder, rElbow, tUp) * (puff + 0.04),
          { radial: 12, capSegs: 2 });
        push(cuff, 'TRIM', skinU);
      }
    }
    if (tUp < 0.98) {
      const t0 = Math.max(tUp - 0.10, 0);
      const a0 = sh.clone().lerp(el, t0);
      push(limb(a0, el, lerp(rShoulder, rElbow, t0), rElbow, {
        radial: 10, capSegs: 3, bodyRings: 6,
        mid: (t) => armMid(lerp(t0, 1, t)), shape: (t) => armShape(lerp(t0, 1, t)),
      }), 'SKIN', skinU);
    }
    // forearm
    const tFore = clamp((sleeveT - upperFrac) / (1 - upperFrac), 0, 1);
    if (tFore > 0.02) {
      const end = el.clone().lerp(wr, tFore);
      push(limb(el, end, rFore * puff, lerp(rFore, rWrist, tFore) * puff,
        { radial: 12, capSegs: 3, bodyRings: 5, capB: 0.30 }), 'SLEEVE', skinF);
      push(limb(el.clone().lerp(wr, Math.max(0, tFore - 0.08)), end,
        lerp(rFore, rWrist, tFore) * (puff + 0.03), lerp(rFore, rWrist, tFore) * (puff + 0.05),
        { radial: 10, capSegs: 2 }), X.top.trimCuff ? 'TRIM' : 'SLEEVE', skinF);
    }
    if (tFore < 0.98) {
      const t0 = Math.max(0, tFore - 0.10);
      const a0 = el.clone().lerp(wr, t0);
      push(limb(a0, wr, lerp(rFore, rWrist, t0), rWrist, {
        radial: 10, capSegs: 3, bodyRings: 6,
        mid: (t) => foreMid(lerp(t0, 1, t)), shape: (t) => foreShape(lerp(t0, 1, t)),
      }), 'SKIN', skinF);
    }
    // elbow pad
    if (X.pad.elbow) {
      const dir = el.clone().sub(sh).normalize().add(wr.clone().sub(el).normalize()).normalize();
      const out = V(0, 0, 1).cross(dir).cross(dir).negate().normalize();
      const pA = el.clone().addScaledVector(out, 0.032 * hs).addScaledVector(dir, -0.055 * hs);
      const pB = el.clone().addScaledVector(out, 0.030 * hs).addScaledVector(dir, 0.070 * hs);
      push(limb(pA, pB, 0.050 * hs * girth, 0.044 * hs * girth,
        { radial: 10, capSegs: 3, shape: () => [1.0, 0.62] }), 'PAD', skinF);
    }

    // hand: a real fist closed on the grip, gloved or bare
    const gripDir = V(s, 0.02, -0.08).normalize();
    const handKey = X.glove.on ? 'GLOVE' : 'SKIN';
    const handR = 0.041 * hs * lerp(0.92, 1.10, M.build);
    push(buildFist(wr, gripDir, handR, X.glove.on), handKey,
      (g) => skinPart(g, boneIndex, 'wrist' + side, null));
    if (X.glove.on) {
      // gauntlet cuff over the wrist
      push(limb(wr.clone().addScaledVector(gripDir, -0.062 * hs),
        wr.clone().addScaledVector(gripDir, -0.012 * hs), handR * 0.86, handR * 0.98,
        { radial: 10, capSegs: 2, zDir: V(0, -1, 0) }),
      'GLOVE', (g) => skinPart(g, boneIndex, 'wrist' + side, null));
    }
  }

  // ------------------------------------------------------------------- legs
  const legT = X.bottom.length;
  const thighFrac = 0.505;
  for (const [side, s] of [['R', 1], ['L', -1]]) {
    const hp = pose['hip' + side], kn = pose['knee' + side];
    const an = pose['ankle' + side], toe = pose['toe' + side];
    const skinT = (g) => skinPart(g, boneIndex, 'hip' + side, 'knee' + side, hp, kn, 0.62, 1.0, 0.85);
    const skinS = (g) => skinPart(g, boneIndex, 'knee' + side, 'ankle' + side, kn, an, 0.68, 1.02, 0.8);
    const rHip = 0.085 * hs * girth, rKnee = 0.058 * hs * girth;
    const rCalf = 0.062 * hs * M.calfGirth, rAnkle = 0.042 * hs * M.calfGirth;
    const puff = 1 + 0.05 + botLoose * 0.16;
    // quad mass high on the thigh, a flattened knee, a gastrocnemius belly a
    // third of the way down the shin, then a narrow ankle
    const thighMid = (t) => bulge(t, 0.20, 0.30, 0.11 * girth) * (1 - 0.05 * smoothstep(t));
    const thighShape = (t) => [lerp(1.05, 0.93, t), lerp(1.00, 0.90, t)];
    const calfMid = (t) => bulge(t, 0.26, 0.24, 0.20 * M.calfGirth);
    const calfShape = (t) => [lerp(0.98, 0.88, t), lerp(1.00, 0.92, t)];
    // trousers hang: the cloth ignores the calf and breaks over the shoe
    const clothMid = (t) => (1 + botLoose * 0.05) * bulge(t, 0.18, 0.30, 0.06)
      * bulge(t, 0.95, 0.10, botLoose * 0.10);

    const tUp = clamp(legT / thighFrac, 0, 1);
    push(limb(hp.clone().add(V(0, 0.03 * hs, 0)), tUp >= 1 ? kn : hp.clone().lerp(kn, tUp),
      rHip * puff, lerp(rHip, rKnee, tUp) * puff,
      { radial: 12, capSegs: 3, bodyRings: 6, mid: clothMid, shape: thighShape }),
    'BOTTOM', skinT);
    if (tUp < 0.99) {
      // shorts hem, then bare leg
      const end = hp.clone().lerp(kn, tUp);
      push(limb(hp.clone().lerp(kn, Math.max(0, tUp - 0.05)), end,
        lerp(rHip, rKnee, tUp) * (puff + 0.03), lerp(rHip, rKnee, tUp) * (puff + 0.06),
        { radial: 12, capSegs: 2 }), 'BOTTOM', skinT);
      const t0 = Math.max(0, tUp - 0.08);
      push(limb(hp.clone().lerp(kn, t0), kn, lerp(rHip, rKnee, t0), rKnee, {
        radial: 10, capSegs: 3, bodyRings: 5,
        mid: (t) => thighMid(lerp(t0, 1, t)), shape: (t) => thighShape(lerp(t0, 1, t)),
      }), 'SKIN', skinT);
    }
    const tLo = clamp((legT - thighFrac) / (1 - thighFrac), 0, 1);
    if (tLo > 0.02) {
      const end = kn.clone().lerp(an, tLo);
      push(limb(kn, end, rCalf * puff, lerp(rCalf, rAnkle, tLo) * puff * (X.bottom.cuffed ? 0.92 : 1),
        { radial: 12, capSegs: 3, bodyRings: 6, mid: clothMid }), 'BOTTOM', skinS);
      if (X.bottom.cuffed || tLo < 0.98) {
        push(limb(kn.clone().lerp(an, Math.max(0, tLo - 0.06)), end,
          lerp(rCalf, rAnkle, tLo) * (puff + 0.02), lerp(rCalf, rAnkle, tLo) * (puff - 0.04),
          { radial: 10, capSegs: 2 }), 'BOTTOM', skinS);
      }
    }
    if (tLo < 0.98) {
      const t0 = Math.max(0, tLo - 0.08);
      const a0 = kn.clone().lerp(an, t0);
      push(limb(a0, an, lerp(rCalf, rAnkle, t0), rAnkle, {
        radial: 10, capSegs: 3, bodyRings: 6,
        mid: (t) => calfMid(lerp(t0, 1, t)), shape: (t) => calfShape(lerp(t0, 1, t)),
      }), 'SKIN', skinS);
    }
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

/** Hand-built quad surface with winding forced to face `ref`. */
function quadSoup() {
  const pos = [], uv = [];
  return {
    pos, uv,
    add(a, b, c, d, uvs, ref) {
      if (ref) {
        _qa.copy(b).sub(a); _qb.copy(c).sub(a);
        _qn.copy(_qa).cross(_qb);
        if (_qn.dot(ref) < 0) { const t = b; b = d; d = t; }
      }
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
      pos.push(a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z);
      const [u0, v0, u1, v1] = uvs;
      uv.push(u0, v0, u1, v0, u1, v1);
      uv.push(u0, v0, u1, v1, u0, v1);
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

function buildHelmet(headC, R0, AM) {
  const R = R0 * 1.20, T = R0 * 0.140;
  const NU = 48, NV = 14;
  const S = [0.88, 1.10, 1.06];
  const phiMax = (th) => 1.78 - 0.22 * Math.cos(th);
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

  // peak / visor
  const peak = quadSoup();
  const NP = 18, NL = 3, span = 50 * DEG, len = R0 * 0.70;
  for (let i = 0; i < NP; i++) {
    for (let j = 0; j < NL; j++) {
      const th0 = lerp(-span, span, i / NP), th1 = lerp(-span, span, (i + 1) / NP);
      const s0 = j / NL, s1 = (j + 1) / NL;
      const pk = (th, s, up) => {
        const base = surfPoint(headC, th, phiMax(th) * 0.70, R, S);
        const out = V(Math.sin(th) * 0.45, -0.10, Math.cos(th)).normalize();
        return base.addScaledVector(out, len * s)
          .add(V(0, -0.030 * s * s + (up ? 0.005 : -0.003), 0));
      };
      const pu0 = 0.42 + (i / NP) * 0.06, pu1 = 0.42 + ((i + 1) / NP) * 0.06;
      peak.add(pk(th0, s0, true), pk(th1, s0, true), pk(th1, s1, true), pk(th0, s1, true),
        [pu0, 0.2, pu1, 0.8], V(0, 1, 0));
      peak.add(pk(th0, s1, false), pk(th1, s1, false), pk(th1, s0, false), pk(th0, s0, false),
        [pu0, 0.2, pu1, 0.8], V(0, -1, 0));
    }
  }
  parts.push(AM.uv(peak.geometry(), 'SHELL'));

  // goggle strap over the shell
  const strap = quadSoup();
  for (let i = 0; i < NU; i++) {
    const th0 = (i / NU) * TAU, th1 = ((i + 1) / NU) * TAU;
    const inFront = (t) => Math.cos(t) > 0.62;
    if (inFront(th0) && inFront(th1)) continue;
    const r = R * 1.018;
    const a = surfPoint(headC, th0, phiMax(th0) * 0.80, r, S);
    const b = surfPoint(headC, th1, phiMax(th1) * 0.80, r, S);
    const c = surfPoint(headC, th1, phiMax(th1) * 0.94, r, S);
    const d = surfPoint(headC, th0, phiMax(th0) * 0.94, r, S);
    const outDir = a.clone().sub(headC);
    strap.add(a, b, c, d, [i / NU, 0.1, (i + 1) / NU, 0.9], outDir);
    strap.add(a, b, c, d, [i / NU, 0.1, (i + 1) / NU, 0.9], outDir.clone().negate());
  }
  parts.push(AM.uv(strap.geometry(), 'STRAP'));

  // chin straps + buckle
  const chin = headC.clone().add(V(0, -R0 * 1.14, R0 * 0.14));
  for (const s of [-1, 1]) {
    const a = surfPoint(headC, s * 78 * DEG, phiMax(s * 78 * DEG) * 0.98, R * 0.98, S);
    const m = a.clone().lerp(chin, 0.5).add(V(s * 0.012, 0.006, 0.006));
    const g = sweep([a, m, chin], { radius: R0 * 0.117, radial: 5, steps: 8, oval: () => [1, 0.30] });
    parts.push(AM.uv(g, 'STRAP'));
  }
  const buckle = new THREE.BoxGeometry(0.022, 0.016, 0.008);
  buckle.translate(chin.x, chin.y, chin.z);
  parts.push(AM.patch(buckle, 'LINER'));

  return merge(parts);
}

function buildGoggleLens(headC, R0) {
  const soup = quadSoup();
  const NU = 18, NV = 4;
  const S = [0.80, 1.10, 1.03];
  const th0 = -62 * DEG, th1 = 62 * DEG, p0 = 1.14, p1 = 1.56;
  for (let i = 0; i < NU; i++) {
    for (let j = 0; j < NV; j++) {
      const ta = lerp(th0, th1, i / NU), tb = lerp(th0, th1, (i + 1) / NU);
      const pa = lerp(p0, p1, j / NV), pb = lerp(p0, p1, (j + 1) / NV);
      const r = R0 * 1.10, ri = R0 * 1.045;
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
      const a = surfPoint(headC, ta, p, R0 * 1.10, S), b = surfPoint(headC, tb, p, R0 * 1.10, S);
      const c = surfPoint(headC, tb, p, R0 * 1.045, S), d = surfPoint(headC, ta, p, R0 * 1.045, S);
      const along = surfPoint(headC, (ta + tb) / 2, p + sgn * 0.05, R0 * 1.10, S)
        .sub(surfPoint(headC, (ta + tb) / 2, p, R0 * 1.10, S));
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
    normalScale: new THREE.Vector2(0.70, 0.70), envMapIntensity: 0.95,
    sheen: 0.26, sheenRoughness: 0.85, sheenColor: new THREE.Color(0x9aa0aa),
  });
  riderMat.name = 'riderSkinned';

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
    const F = X.frame;
    paint.metalness = F.finish === 'gloss' ? 0.08 : F.metalness;
    paint.roughness = clamp(F.roughness * (F.finish === 'chrome' ? 0.42 : 0.95), 0.04, 1);
    paint.clearcoat = F.finish === 'chrome' ? 0.5 : F.finish === 'raw' ? 0.10 : F.finish === 'gloss' ? 0.62 : 0.28;
    paint.clearcoatRoughness = F.finish === 'chrome' ? 0.06 : 0.34;
    paint.envMapIntensity = F.env;
    paint.needsUpdate = true;
    hardware.envMapIntensity = X.hw.env;
    hardware.roughness = clamp(X.hw.roughness * (X.hw.finish === 'chrome' ? 0.55 : 1.0), 0.05, 1);
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
      if (i % 2) _mat.scale(_v1.set(1, 1, 0.55));
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

