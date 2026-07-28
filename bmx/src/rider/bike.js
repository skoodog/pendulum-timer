// MIRRA CITY — the bike and the rider.
//
// Conventions (shared with bikePhysics.js / riderAnim.js):
//   * `group` origin is the CONTACT ORIGIN: y = 0 is the bottom of the tyres,
//     z = 0 is midway along the wheelbase. +Z forward, +Y up, +X the rider's right.
//   * Everything is procedural: geometry is built from Three primitives / hand-rolled
//     buffer sweeps, every texture is painted on a canvas at load. Zero assets.
//   * Draw calls: 3 shared materials on the bike (paint / hardware / rubber) and a
//     single skinned material on the rider, so the whole player is ~18 draw calls.
//     Each independently moving part is one merged mesh.
//   * The rider is a SkinnedMesh and its bones ARE the rig — nested Object3Ds, all
//     with identity rotation in bind pose, so the animator can write
//     `rig.elbowR.rotation.x = -0.4` and get a correct chain deformation. Bind pose
//     is the default riding pose, so zero rotation already looks right.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { rng, rand, clamp, lerp, smoothstep, fbm2, hash2, TAU } from '../core/mathx.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// bike geometry table — real 20" BMX numbers, stretched to the 1.05 m wheelbase
// the physics uses for its ground probes.
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

/** One of `n` horizontal atlas bands, with a bleed inset. */
function band(geo, i, n, u0 = 0, u1 = 1) {
  const h = 1 / n, e = h * 0.03;
  return atlasUV(normalise(geo), u0, u1, i * h + e, (i + 1) * h - e);
}

function merge(list) {
  const clean = list.filter(Boolean).map(normalise);
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

/** Capsule with independent end radii and a cross-section scale profile. */
function capsule2(len, ra, rb, opts = {}) {
  const { radial = 12, capSegs = 4, shape = null, mid = null, bodyRings = 3 } = opts;
  const rings = [];
  for (let i = 0; i <= capSegs; i++) {                       // bottom cap
    const a = (i / capSegs) * (Math.PI / 2);
    rings.push([Math.sin(a) * ra, -Math.cos(a) * ra]);
  }
  for (let i = 1; i <= bodyRings; i++) {
    const t = i / (bodyRings + 1);
    rings.push([lerp(ra, rb, t) * (mid ? mid(t) : 1), len * t]);
  }
  for (let i = 0; i <= capSegs; i++) {                       // top cap
    const a = (i / capSegs) * (Math.PI / 2);
    rings.push([Math.cos(a) * rb, len + Math.sin(a) * rb]);
  }
  // v runs along the PROFILE ARC LENGTH, not the axis: parameterising by height
  // squeezes the hemispherical caps into a sliver of the atlas band, which makes
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
      const a = (j / radial) * TAU;
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

/** Two-bone IK — used once at build time to place elbows and knees. */
function ikJoint(root, end, lenA, lenB, pole) {
  const d = new THREE.Vector3().subVectors(end, root);
  const c = Math.min(d.length(), lenA + lenB - 1e-4);
  const dir = d.clone().normalize();
  const px = (lenA * lenA + c * c - lenB * lenB) / (2 * c);
  const h = Math.sqrt(Math.max(0, lenA * lenA - px * px));
  const p = pole.clone().addScaledVector(dir, -pole.dot(dir)).normalize();
  return root.clone().addScaledVector(dir, px).addScaledVector(p, h);
}

// ---------------------------------------------------------------------------
// procedural texture painting
// ---------------------------------------------------------------------------

const _textures = [];

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

function overlayGrain(g, w, h, alpha, scale = 1, src = _grain) {
  g.save();
  g.globalCompositeOperation = 'overlay';
  g.globalAlpha = alpha;
  for (let y = 0; y < h; y += h / scale) {
    for (let x = 0; x < w; x += w / scale) g.drawImage(src, x, y, w / scale, h / scale);
  }
  g.restore();
}

/** Sobel a greyscale height canvas into a tangent-space normal map. */
function heightToNormal(hg, w, h, strength = 2.0) {
  const src = hg.getImageData(0, 0, w, h).data;
  const out = c2d(w, h);
  const img = out.createImageData(w, h);
  const d = img.data;
  const at = (x, y) => src[((clamp(y, 0, h - 1) | 0) * w + (clamp(x, 0, w - 1) | 0)) * 4] / 255;
  for (let y = 0; y < h; y++) {
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
  out.putImageData(img, 0, 0);
  return out;
}

function makeTexture(canvas, srgb, aniso) {
  const t = new THREE.CanvasTexture(canvas);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  _textures.push(t);
  return t;
}

/**
 * Paint a colour / height / roughness triplet. Height and roughness are painted at
 * half resolution — normals and gloss tolerate it and it halves generation cost.
 */
function mapSet(aniso, w, h, paint, { normalStrength = 2.0 } = {}) {
  const hw = w >> 1, hh = h >> 1;
  const cg = c2d(w, h); paint.color(cg, w, h);
  const hg = c2d(hw, hh); paint.height(hg, hw, hh);
  const rg = c2d(hw, hh); paint.rough(rg, hw, hh);
  return {
    map: makeTexture(cg.canvas, true, aniso),
    normalMap: makeTexture(heightToNormal(hg, hw, hh, normalStrength).canvas, false, aniso),
    roughnessMap: makeTexture(rg.canvas, false, aniso),
  };
}

/**
 * Run `fn` in the local coordinate frame of atlas band `i` of `n`.
 * Bands are painted bottom-up because CanvasTexture uploads with flipY: this way
 * band `i` in UV space is band `i` here, and content painted upright stays upright
 * with increasing v (up the limb, along the tube).
 */
function inBand(g, w, h, i, n, fn) {
  const bh = h / n;
  const y = (n - 1 - i) * bh;
  g.save();
  g.beginPath(); g.rect(0, y, w, bh); g.clip();
  g.translate(0, y);
  fn(g, w, bh);
  g.restore();
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
    skew = 0, alpha = 1, outline = null, spacing = 0, rot = 0 } = opts;
  g.save();
  g.globalAlpha = alpha;
  g.translate(x, y);
  if (rot) g.rotate(rot);
  if (skew) g.transform(1, 0, skew, 1, 0, 0);
  g.font = `${font} ${size}px ${family}`;
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

// ---------------------------------------------------------------------------
// atlas band indices
// ---------------------------------------------------------------------------
const PAINT = { PLAIN: 0, DARK: 1, DECAL: 2, SCRIPT: 3, N: 4 };
const HW = { CHROME: 0, ANOD: 1, ALLOY: 2, PEG: 3, OILY: 4, BRASS: 5, STEEL: 6, RED: 7, N: 8 };
const RUB = { TYRE: 0, GRIP: 1, SEAT: 2, CABLE: 3, N: 4 };
const RD = { SKIN: 0, JERSEY: 1, PRINT: 2, PANTS: 3, KNEE: 4, SHOE: 5, SOLE: 6, GEAR: 7, N: 8 };
const HM = { SHELL: 0, VENT: 1, STRAP: 2, LINER: 3, N: 4 };

function buildMaterials(renderer) {
  const aniso = Math.min(8, renderer?.capabilities?.getMaxAnisotropy?.() ?? 8);

  // --- frame paint: anodised teal powder coat under clearcoat -----------------
  const paintBase = (g, w, h, base, dark) => {
    fill(g, w, h, base);
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(255,255,255,0.10)');
    grad.addColorStop(0.45, 'rgba(0,0,0,0)');
    grad.addColorStop(1, dark);
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
    overlayGrain(g, w, h, 0.13, 2);
    scratches(g, w, h, 90, '#dff3f6', 8, 90, 0.7);
    chips(g, w, h, 26, '#6a6f72', 0.8, 2.6);
  };
  const paintMaps = mapSet(aniso, 1024, 1024, {
    color(g, w, h) {
      inBand(g, w, h, PAINT.PLAIN, PAINT.N, (c, bw, bh) => paintBase(c, bw, bh, '#0f5561', 'rgba(2,20,24,0.55)'));
      inBand(g, w, h, PAINT.DARK, PAINT.N, (c, bw, bh) => {
        paintBase(c, bw, bh, '#0e454e', 'rgba(0,12,15,0.6)');
        scratches(c, bw, bh, 120, '#9fb6b9', 10, 60, 0.9);
      });
      inBand(g, w, h, PAINT.DECAL, PAINT.N, (c, bw, bh) => {
        paintBase(c, bw, bh, '#0f5561', 'rgba(2,20,24,0.55)');
        text(c, 'VOLTA', bw * 0.5, bh * 0.5, bh * 0.62, '#f4ecdb', { skew: -0.22, spacing: bh * 0.03 });
        text(c, 'HEAT TREATED CHROMOLY', bw * 0.5, bh * 0.82, bh * 0.11, 'rgba(244,236,219,0.75)', { font: '700', family: 'sans-serif', spacing: bh * 0.02 });
      });
      inBand(g, w, h, PAINT.SCRIPT, PAINT.N, (c, bw, bh) => {
        paintBase(c, bw, bh, '#0f5561', 'rgba(2,20,24,0.55)');
        c.fillStyle = '#e8552f'; c.globalAlpha = 0.9;
        c.fillRect(0, bh * 0.06, bw, bh * 0.055);
        c.fillRect(0, bh * 0.885, bw, bh * 0.055);
        c.globalAlpha = 1;
        text(c, 'MIRRA CITY', bw * 0.5, bh * 0.47, bh * 0.42, '#f4ecdb', { skew: -0.18, spacing: bh * 0.05 });
      });
    },
    height(g, w, h) {
      fill(g, w, h, '#808080');
      overlayGrain(g, w, h, 0.16, 2);     // orange peel, very shallow
      scratches(g, w, h, 70, '#6a6a6a', 6, 50, 0.8);
      inBand(g, w, h, PAINT.DECAL, PAINT.N, (c, bw, bh) => {
        text(c, 'VOLTA', bw * 0.5, bh * 0.5, bh * 0.62, '#9a9a9a', { skew: -0.22, spacing: bh * 0.03 });
      });
      inBand(g, w, h, PAINT.SCRIPT, PAINT.N, (c, bw, bh) => {
        text(c, 'MIRRA CITY', bw * 0.5, bh * 0.47, bh * 0.42, '#9a9a9a', { skew: -0.18, spacing: bh * 0.05 });
      });
    },
    rough(g, w, h) {
      fill(g, w, h, '#949494');
      overlayGrain(g, w, h, 0.22, 2);
      scratches(g, w, h, 110, '#c4c4c4', 8, 90, 0.9);
      chips(g, w, h, 30, '#b0b0b0', 1, 3);
      inBand(g, w, h, PAINT.DARK, PAINT.N, (c, bw, bh) => {
        c.fillStyle = 'rgba(255,255,255,0.16)'; c.fillRect(0, 0, bw, bh);
      });
    },
  }, { normalStrength: 0.45 });

  const paint = new THREE.MeshPhysicalMaterial({
    ...paintMaps,
    color: 0xffffff,
    metalness: 0.08,
    roughness: 1.0,
    clearcoat: 0.28,
    clearcoatRoughness: 0.38,
    normalScale: new THREE.Vector2(0.30, 0.30),
    envMapIntensity: 0.8,
  });
  paint.name = 'bikePaint';

  // --- hardware: one metal material, eight surfaces ---------------------------
  const hwMaps = mapSet(aniso, 1024, 1024, {
    color(g, w, h) {
      inBand(g, w, h, HW.CHROME, HW.N, (c, bw, bh) => {
        const grad = c.createLinearGradient(0, 0, 0, bh);
        grad.addColorStop(0, '#f4f6f8'); grad.addColorStop(0.5, '#c9d2d8'); grad.addColorStop(1, '#eef2f4');
        c.fillStyle = grad; c.fillRect(0, 0, bw, bh);
        scratches(c, bw, bh, 160, '#ffffff', 10, 120, 0.6);
        scratches(c, bw, bh, 60, '#7e888e', 6, 40, 0.6);
        chips(c, bw, bh, 14, '#8a7a64', 0.8, 2.2);      // rust freckles
      });
      inBand(g, w, h, HW.ANOD, HW.N, (c, bw, bh) => {
        fill(c, bw, bh, '#17191d');
        overlayGrain(c, bw, bh, 0.22, 2);
        scratches(c, bw, bh, 130, '#9aa0a6', 6, 70, 0.7);
        chips(c, bw, bh, 22, '#767c82', 0.7, 2.0);
      });
      inBand(g, w, h, HW.ALLOY, HW.N, (c, bw, bh) => {
        fill(c, bw, bh, '#8d949a');
        for (let i = 0; i < 60; i++) {                    // lathe rings
          c.strokeStyle = `rgba(${rand(200, 255) | 0},${rand(200, 255) | 0},255,${rand(0.04, 0.14).toFixed(2)})`;
          c.lineWidth = rand(0.5, 2);
          c.beginPath(); c.moveTo(0, rand(0, bh)); c.lineTo(bw, rand(0, bh)); c.stroke();
        }
        overlayGrain(c, bw, bh, 0.2, 2);
      });
      inBand(g, w, h, HW.PEG, HW.N, (c, bw, bh) => {
        fill(c, bw, bh, '#9ba2a7');
        for (let i = 0; i < 90; i++) {                    // knurling + grind wear
          c.strokeStyle = `rgba(255,255,255,${rand(0.05, 0.25).toFixed(2)})`;
          c.lineWidth = rand(0.6, 2.4);
          const y = rand(0, bh);
          c.beginPath(); c.moveTo(0, y); c.lineTo(bw, y + rand(-4, 4)); c.stroke();
        }
        const wear = c.createLinearGradient(0, 0, bw, 0);
        wear.addColorStop(0, 'rgba(232,238,242,0.85)');
        wear.addColorStop(0.35, 'rgba(120,126,130,0.0)');
        wear.addColorStop(0.65, 'rgba(120,126,130,0.0)');
        wear.addColorStop(1, 'rgba(232,238,242,0.85)');
        c.fillStyle = wear; c.fillRect(0, 0, bw, bh);
        scratches(c, bw, bh, 200, '#ffffff', 20, 160, 0.8);
      });
      inBand(g, w, h, HW.OILY, HW.N, (c, bw, bh) => {
        fill(c, bw, bh, '#2b2a28');
        overlayGrain(c, bw, bh, 0.3, 2);
        scratches(c, bw, bh, 80, '#b9b2a4', 4, 30, 0.7);
      });
      inBand(g, w, h, HW.BRASS, HW.N, (c, bw, bh) => {
        fill(c, bw, bh, '#b8933f');
        overlayGrain(c, bw, bh, 0.25, 2);
        scratches(c, bw, bh, 60, '#e8d79a', 5, 40, 0.7);
      });
      inBand(g, w, h, HW.STEEL, HW.N, (c, bw, bh) => {
        fill(c, bw, bh, '#4e5358');
        overlayGrain(c, bw, bh, 0.28, 2);
        scratches(c, bw, bh, 90, '#aab1b6', 6, 50, 0.7);
      });
      inBand(g, w, h, HW.RED, HW.N, (c, bw, bh) => {
        fill(c, bw, bh, '#b03a22');
        overlayGrain(c, bw, bh, 0.2, 2);
        scratches(c, bw, bh, 70, '#f0b8a0', 5, 40, 0.7);
      });
    },
    height(g, w, h) {
      fill(g, w, h, '#808080');
      overlayGrain(g, w, h, 0.14, 2);
      scratches(g, w, h, 220, '#6c6c6c', 6, 80, 0.8);
      inBand(g, w, h, HW.PEG, HW.N, (c, bw, bh) => {      // knurl ridges
        for (let i = 0; i < bh; i += 3) {
          c.strokeStyle = i % 6 === 0 ? '#c8c8c8' : '#585858';
          c.lineWidth = 1.4;
          c.beginPath(); c.moveTo(0, i); c.lineTo(bw, i); c.stroke();
        }
      });
      inBand(g, w, h, HW.OILY, HW.N, (c, bw, bh) => overlayGrain(c, bw, bh, 0.8, 6, _speck));
    },
    rough(g, w, h) {
      fill(g, w, h, '#555555');
      inBand(g, w, h, HW.CHROME, HW.N, (c, bw, bh) => {
        fill(c, bw, bh, '#1a1a1a');
        scratches(c, bw, bh, 180, '#6e6e6e', 10, 120, 0.7);
        chips(c, bw, bh, 18, '#9a9a9a', 1, 3);
      });
      inBand(g, w, h, HW.ANOD, HW.N, (c, bw, bh) => {
        fill(c, bw, bh, '#5e5e5e');
        scratches(c, bw, bh, 140, '#2c2c2c', 6, 70, 0.8);
      });
      inBand(g, w, h, HW.ALLOY, HW.N, (c, bw, bh) => { fill(c, bw, bh, '#4a4a4a'); overlayGrain(c, bw, bh, 0.4, 3); });
      inBand(g, w, h, HW.PEG, HW.N, (c, bw, bh) => {
        fill(c, bw, bh, '#3a3a3a');
        const wear = c.createLinearGradient(0, 0, bw, 0);
        wear.addColorStop(0, 'rgba(0,0,0,0.75)');
        wear.addColorStop(0.5, 'rgba(255,255,255,0.25)');
        wear.addColorStop(1, 'rgba(0,0,0,0.75)');
        c.fillStyle = wear; c.fillRect(0, 0, bw, bh);
      });
      inBand(g, w, h, HW.OILY, HW.N, (c, bw, bh) => { fill(c, bw, bh, '#6a6a6a'); overlayGrain(c, bw, bh, 0.5, 4, _speck); });
      inBand(g, w, h, HW.BRASS, HW.N, (c, bw, bh) => fill(c, bw, bh, '#3e3e3e'));
      inBand(g, w, h, HW.STEEL, HW.N, (c, bw, bh) => { fill(c, bw, bh, '#585858'); overlayGrain(c, bw, bh, 0.35, 3); });
      inBand(g, w, h, HW.RED, HW.N, (c, bw, bh) => fill(c, bw, bh, '#4e4e4e'));
    },
  }, { normalStrength: 0.7 });

  const hardware = new THREE.MeshStandardMaterial({
    ...hwMaps,
    color: 0xffffff,
    metalness: 1.0,
    roughness: 1.0,
    normalScale: new THREE.Vector2(0.40, 0.40),
    envMapIntensity: 1.0,
  });
  hardware.name = 'bikeHardware';

  // --- rubber: tyre / grip / seat / cable ------------------------------------
  const tan = '#b08a58';
  const rubberMaps = mapSet(aniso, 1024, 1024, {
    color(g, w, h) {
      inBand(g, w, h, RUB.TYRE, RUB.N, (c, bw, bh) => {
        fill(c, bw, bh, '#1b1b1d');
        c.fillStyle = tan;
        c.fillRect(0, bh * 0.10, bw, bh * 0.21);
        c.fillRect(0, bh * 0.69, bw, bh * 0.21);
        // sidewall branding, four times around
        for (let i = 0; i < 4; i++) {
          const x = bw * (i + 0.5) / 4;
          text(c, 'RUCKUS', x, bh * 0.185, bh * 0.10, '#171717', { spacing: bh * 0.008 });
          text(c, '20 x 2.25', x, bh * 0.272, bh * 0.045, '#2b2b2b', { font: '700', family: 'sans-serif', spacing: bh * 0.006 });
          text(c, 'RUCKUS', x, bh * 0.815, bh * 0.10, '#171717', { spacing: bh * 0.008, rot: Math.PI });
          text(c, 'GRIT CO', x, bh * 0.735, bh * 0.045, '#2b2b2b', { font: '700', family: 'sans-serif', spacing: bh * 0.006, rot: Math.PI });
        }
        // tread blocks, 24 around
        c.fillStyle = '#0d0d0e';
        for (let i = 0; i < 24; i++) {
          const x = (i / 24) * bw;
          c.fillRect(x + bw * 0.006, bh * 0.34, bw * 0.022, bh * 0.10);
          c.fillRect(x + bw * 0.020, bh * 0.46, bw * 0.020, bh * 0.08);
          c.fillRect(x + bw * 0.006, bh * 0.56, bw * 0.022, bh * 0.10);
        }
        overlayGrain(c, bw, bh, 0.16, 3);
        chips(c, bw, bh, 40, '#3a3733', 1, 3.5);          // scuffed rubber
      });
      inBand(g, w, h, RUB.GRIP, RUB.N, (c, bw, bh) => {
        fill(c, bw, bh, '#1d1e21');
        overlayGrain(c, bw, bh, 0.22, 3);
        for (let i = 0; i < 40; i++) {
          c.strokeStyle = 'rgba(120,124,130,0.16)'; c.lineWidth = 2;
          const x = (i / 40) * bw;
          c.beginPath(); c.moveTo(x, 0); c.lineTo(x, bh); c.stroke();
        }
        text(c, 'GRIT', bw * 0.5, bh * 0.5, bh * 0.28, 'rgba(190,190,190,0.5)', { spacing: 2 });
      });
      inBand(g, w, h, RUB.SEAT, RUB.N, (c, bw, bh) => {
        fill(c, bw, bh, '#141519');
        overlayGrain(c, bw, bh, 0.18, 4);
        c.strokeStyle = 'rgba(215,205,180,0.55)'; c.setLineDash([6, 9]); c.lineWidth = 2.4;
        c.beginPath(); c.moveTo(bw * 0.16, bh * 0.5); c.lineTo(bw * 0.84, bh * 0.5); c.stroke();
        c.setLineDash([]);
        text(c, 'VOLTA', bw * 0.5, bh * 0.26, bh * 0.16, 'rgba(210,200,178,0.8)', { skew: -0.2, spacing: 3 });
      });
      inBand(g, w, h, RUB.CABLE, RUB.N, (c, bw, bh) => {
        fill(c, bw, bh, '#101114');
        overlayGrain(c, bw, bh, 0.2, 3);
      });
    },
    height(g, w, h) {
      fill(g, w, h, '#808080');
      inBand(g, w, h, RUB.TYRE, RUB.N, (c, bw, bh) => {
        overlayGrain(c, bw, bh, 0.4, 4);
        c.fillStyle = '#ffffff';
        for (let i = 0; i < 24; i++) {
          const x = (i / 24) * bw;
          c.fillRect(x + bw * 0.006, bh * 0.34, bw * 0.022, bh * 0.10);
          c.fillRect(x + bw * 0.020, bh * 0.46, bw * 0.020, bh * 0.08);
          c.fillRect(x + bw * 0.006, bh * 0.56, bw * 0.022, bh * 0.10);
        }
        c.fillStyle = '#a6a6a6';
        for (let i = 0; i < 4; i++) {
          text(c, 'RUCKUS', bw * (i + 0.5) / 4, bh * 0.185, bh * 0.10, '#c8c8c8', { spacing: bh * 0.008 });
          text(c, 'RUCKUS', bw * (i + 0.5) / 4, bh * 0.815, bh * 0.10, '#c8c8c8', { spacing: bh * 0.008, rot: Math.PI });
        }
      });
      inBand(g, w, h, RUB.GRIP, RUB.N, (c, bw, bh) => {
        for (let i = 0; i < 40; i++) {
          const x = (i / 40) * bw;
          c.fillStyle = '#d0d0d0'; c.fillRect(x, 0, bw / 80, bh);
        }
        overlayGrain(c, bw, bh, 0.5, 6, _speck);
      });
      inBand(g, w, h, RUB.SEAT, RUB.N, (c, bw, bh) => {
        overlayGrain(c, bw, bh, 0.7, 8, _speck);
        c.strokeStyle = '#3a3a3a'; c.lineWidth = 3;
        c.beginPath(); c.moveTo(bw * 0.16, bh * 0.5); c.lineTo(bw * 0.84, bh * 0.5); c.stroke();
      });
      inBand(g, w, h, RUB.CABLE, RUB.N, (c, bw, bh) => {
        for (let i = 0; i < bh; i += 4) { c.fillStyle = i % 8 ? '#606060' : '#c0c0c0'; c.fillRect(0, i, bw, 2); }
      });
    },
    rough(g, w, h) {
      fill(g, w, h, '#e6e6e6');
      inBand(g, w, h, RUB.TYRE, RUB.N, (c, bw, bh) => {
        fill(c, bw, bh, '#e2e2e2');
        overlayGrain(c, bw, bh, 0.3, 4);
        c.fillStyle = 'rgba(140,140,140,0.6)'; c.fillRect(0, bh * 0.38, bw, bh * 0.24); // polished centre strip
      });
      inBand(g, w, h, RUB.SEAT, RUB.N, (c, bw, bh) => { fill(c, bw, bh, '#8c8c8c'); overlayGrain(c, bw, bh, 0.4, 5); });
      inBand(g, w, h, RUB.CABLE, RUB.N, (c, bw, bh) => fill(c, bw, bh, '#9a9a9a'));
    },
  }, { normalStrength: 1.5 });

  const rubber = new THREE.MeshStandardMaterial({
    ...rubberMaps,
    color: 0xffffff,
    metalness: 0.0,
    roughness: 1.0,
    normalScale: new THREE.Vector2(0.75, 0.75),
    envMapIntensity: 0.8,
  });
  rubber.name = 'bikeRubber';

  return { paint, hardware, rubber, aniso, maps: [paintMaps, hwMaps, rubberMaps] };
}

function buildRiderMaterials(aniso) {
  const weave = (c, bw, bh, alpha) => {
    c.save(); c.globalAlpha = alpha; c.strokeStyle = '#ffffff'; c.lineWidth = 1;
    for (let x = 0; x < bw; x += 4) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, bh); c.stroke(); }
    c.strokeStyle = '#000000';
    for (let y = 0; y < bh; y += 4) { c.beginPath(); c.moveTo(0, y); c.lineTo(bw, y); c.stroke(); }
    c.restore();
  };
  // Cloth folds run ALONG the limb: u is around the body, v is along it, so the
  // creases are near-vertical in atlas space with a lazy sideways drift.
  const folds = (c, bw, bh, n, css, alpha) => {
    c.save(); c.globalAlpha = alpha; c.strokeStyle = css; c.lineCap = 'round';
    for (let i = 0; i < n; i++) {
      const x = rand(0, bw);
      const y0 = rand(-bh * 0.4, bh * 0.5), y1 = y0 + rand(bh * 0.45, bh * 1.3);
      c.lineWidth = rand(2, 8);
      c.beginPath();
      c.moveTo(x, y0);
      c.bezierCurveTo(x + rand(-26, 26), lerp(y0, y1, 0.33), x + rand(-26, 26), lerp(y0, y1, 0.66), x + rand(-18, 18), y1);
      c.stroke();
    }
    // a few short cross creases where fabric bunches
    for (let i = 0; i < n >> 1; i++) {
      const x = rand(0, bw), y = rand(0, bh);
      c.lineWidth = rand(1.5, 4);
      c.beginPath();
      c.moveTo(x, y);
      c.quadraticCurveTo(x + rand(-40, 40), y + rand(-10, 10), x + rand(-70, 70), y + rand(-16, 16));
      c.stroke();
    }
    c.restore();
  };

  const maps = mapSet(aniso, 1024, 2048, {
    color(g, w, h) {
      inBand(g, w, h, RD.SKIN, RD.N, (c, bw, bh) => {
        fill(c, bw, bh, '#b3805a');
        overlayGrain(c, bw, bh, 0.09, 4);
        chips(c, bw, bh, 40, 'rgba(150,102,72,0.5)', 0.5, 1.6);
        chips(c, bw, bh, 24, 'rgba(201,160,129,0.5)', 0.6, 2.0);
        const sh = c.createLinearGradient(0, 0, 0, bh);
        sh.addColorStop(0, 'rgba(120,60,40,0.14)');
        sh.addColorStop(0.5, 'rgba(0,0,0,0)');
        sh.addColorStop(1, 'rgba(120,60,40,0.14)');
        c.fillStyle = sh; c.fillRect(0, 0, bw, bh);
      });
      inBand(g, w, h, RD.JERSEY, RD.N, (c, bw, bh) => {
        fill(c, bw, bh, '#b93f2a');
        weave(c, bw, bh, 0.05);
        overlayGrain(c, bw, bh, 0.12, 3);
        c.fillStyle = '#9e3120';
        c.fillRect(0, bh * 0.04, bw, bh * 0.06);
        c.fillRect(0, bh * 0.90, bw, bh * 0.10);
        c.fillStyle = 'rgba(240,230,210,0.65)';
        c.fillRect(0, bh * 0.100, bw, bh * 0.007);
        c.fillRect(0, bh * 0.893, bw, bh * 0.007);
        folds(c, bw, bh, 14, 'rgba(60,12,6,0.30)', 0.5);
      });
      // the whole torso is one piece: shorts at the bottom (v small = canvas
      // bottom of the band), jersey above it, collar at the very top.
      inBand(g, w, h, RD.PRINT, RD.N, (c, bw, bh) => {
        fill(c, bw, bh, '#b93f2a');
        weave(c, bw, bh, 0.05);
        c.fillStyle = '#34373e'; c.fillRect(0, bh * 0.66, bw, bh * 0.34);    // shorts
        weave(c, bw, bh, 0.0);
        c.fillStyle = '#f0e6d2'; c.fillRect(0, bh * 0.625, bw, bh * 0.020);  // jersey hem
        c.fillStyle = '#1d1f24'; c.fillRect(0, bh * 0.645, bw, bh * 0.016);
        c.fillStyle = '#f0e6d2'; c.fillRect(0, bh * 0.020, bw, bh * 0.026);  // collar
        c.fillStyle = '#1d1f24'; c.fillRect(0, bh * 0.046, bw, bh * 0.014);
        c.fillStyle = '#22242a'; c.fillRect(0, bh * 0.70, bw, bh * 0.030);   // waistband
        // back print sits at u = 0.5, which faces -Z (the chase camera)
        text(c, 'VOLTA', bw * 0.5, bh * 0.26, bh * 0.115, '#f2e8d4', { skew: -0.16, spacing: bh * 0.010 });
        text(c, 'SKATEPARK CO', bw * 0.5, bh * 0.335, bh * 0.036, '#f2e8d4', { font: '700', family: 'sans-serif', spacing: bh * 0.006, alpha: 0.9 });
        text(c, '13', bw * 0.5, bh * 0.44, bh * 0.075, '#1d1f24', { spacing: bh * 0.005 });
        folds(c, bw, bh, 12, 'rgba(60,12,6,0.26)', 0.45);
      });
      inBand(g, w, h, RD.PANTS, RD.N, (c, bw, bh) => {
        fill(c, bw, bh, '#34373e');
        weave(c, bw, bh, 0.06);
        overlayGrain(c, bw, bh, 0.16, 3);
        folds(c, bw, bh, 18, 'rgba(8,9,12,0.42)', 0.6);
        folds(c, bw, bh, 10, 'rgba(150,158,170,0.16)', 0.5);
        c.strokeStyle = 'rgba(214,198,160,0.5)'; c.lineWidth = 1.6; c.setLineDash([5, 6]);
        c.beginPath(); c.moveTo(bw * 0.25, 0); c.lineTo(bw * 0.25, bh); c.stroke();
        c.beginPath(); c.moveTo(bw * 0.75, 0); c.lineTo(bw * 0.75, bh); c.stroke();
        c.setLineDash([]);
      });
      inBand(g, w, h, RD.KNEE, RD.N, (c, bw, bh) => {
        fill(c, bw, bh, '#2f323a');
        weave(c, bw, bh, 0.06);
        folds(c, bw, bh, 22, 'rgba(8,9,12,0.5)', 0.65);
        chips(c, bw, bh, 40, 'rgba(190,190,190,0.10)', 2, 8);
      });
      inBand(g, w, h, RD.SHOE, RD.N, (c, bw, bh) => {
        fill(c, bw, bh, '#d8d1bf');
        overlayGrain(c, bw, bh, 0.2, 4);
        c.fillStyle = '#22242a'; c.fillRect(0, 0, bw, bh * 0.16);          // toe cap band
        c.strokeStyle = 'rgba(40,40,45,0.7)'; c.lineWidth = 2; c.setLineDash([5, 5]);
        c.beginPath(); c.moveTo(0, bh * 0.20); c.lineTo(bw, bh * 0.20); c.stroke();
        c.setLineDash([]);
        c.strokeStyle = '#e8e2d2'; c.lineWidth = bh * 0.05;               // laces
        for (let i = 0; i < 5; i++) {
          const y = bh * (0.30 + i * 0.12);
          c.beginPath(); c.moveTo(bw * 0.34, y); c.lineTo(bw * 0.66, y + bh * 0.05); c.stroke();
          c.beginPath(); c.moveTo(bw * 0.34, y + bh * 0.05); c.lineTo(bw * 0.66, y); c.stroke();
        }
        c.fillStyle = '#1d1f24';
        for (let i = 0; i < 5; i++) {
          const y = bh * (0.30 + i * 0.12);
          c.beginPath(); c.ellipse(bw * 0.33, y, bw * 0.012, bh * 0.02, 0, 0, TAU); c.fill();
          c.beginPath(); c.ellipse(bw * 0.67, y, bw * 0.012, bh * 0.02, 0, 0, TAU); c.fill();
        }
        chips(c, bw, bh, 50, 'rgba(90,78,58,0.35)', 1, 5);                // dirt
      });
      inBand(g, w, h, RD.SOLE, RD.N, (c, bw, bh) => {
        fill(c, bw, bh, '#a4713d');
        overlayGrain(c, bw, bh, 0.22, 4);
        c.fillStyle = 'rgba(40,28,16,0.5)';
        for (let i = 0; i < 28; i++) c.fillRect((i / 28) * bw, bh * 0.15, bw * 0.016, bh * 0.7);
        c.fillStyle = '#e8e2d2'; c.fillRect(0, 0, bw, bh * 0.12);         // midsole stripe
      });
      inBand(g, w, h, RD.GEAR, RD.N, (c, bw, bh) => {
        fill(c, bw, bh, '#17181c');
        overlayGrain(c, bw, bh, 0.3, 4);
        c.fillStyle = 'rgba(60,64,70,0.6)';
        for (let i = 0; i < 12; i++) {
          for (let j = 0; j < 4; j++) {
            c.beginPath();
            c.roundRect(bw * (i / 12) + 4, bh * (j / 4) + 4, bw / 12 - 8, bh / 4 - 8, 6);
            c.fill();
          }
        }
        text(c, 'GRIT', bw * 0.5, bh * 0.5, bh * 0.22, 'rgba(200,205,60,0.85)', { spacing: 2 });
      });
    },
    height(g, w, h) {
      fill(g, w, h, '#808080');
      inBand(g, w, h, RD.SKIN, RD.N, (c, bw, bh) => overlayGrain(c, bw, bh, 0.35, 8, _speck));
      inBand(g, w, h, RD.JERSEY, RD.N, (c, bw, bh) => { weave(c, bw, bh, 0.5); folds(c, bw, bh, 14, '#4a4a4a', 0.5); });
      inBand(g, w, h, RD.PRINT, RD.N, (c, bw, bh) => {
        weave(c, bw, bh, 0.5);
        folds(c, bw, bh, 12, '#4e4e4e', 0.5);
        c.fillStyle = '#b8b8b8'; c.fillRect(0, bh * 0.625, bw, bh * 0.020);
        c.fillStyle = '#b8b8b8'; c.fillRect(0, bh * 0.020, bw, bh * 0.026);
        text(c, 'VOLTA', bw * 0.5, bh * 0.26, bh * 0.115, '#a0a0a0', { skew: -0.16, spacing: bh * 0.010 });
      });
      inBand(g, w, h, RD.PANTS, RD.N, (c, bw, bh) => { weave(c, bw, bh, 0.55); folds(c, bw, bh, 20, '#4c4c4c', 0.65); folds(c, bw, bh, 12, '#b4b4b4', 0.5); });
      inBand(g, w, h, RD.KNEE, RD.N, (c, bw, bh) => { weave(c, bw, bh, 0.55); folds(c, bw, bh, 26, '#464646', 0.7); });
      inBand(g, w, h, RD.SHOE, RD.N, (c, bw, bh) => {
        weave(c, bw, bh, 0.4);
        c.strokeStyle = '#e0e0e0'; c.lineWidth = bh * 0.05;
        for (let i = 0; i < 5; i++) {
          const y = bh * (0.30 + i * 0.12);
          c.beginPath(); c.moveTo(bw * 0.34, y); c.lineTo(bw * 0.66, y + bh * 0.05); c.stroke();
          c.beginPath(); c.moveTo(bw * 0.34, y + bh * 0.05); c.lineTo(bw * 0.66, y); c.stroke();
        }
      });
      inBand(g, w, h, RD.SOLE, RD.N, (c, bw, bh) => {
        c.fillStyle = '#d8d8d8';
        for (let i = 0; i < 28; i++) c.fillRect((i / 28) * bw, bh * 0.15, bw * 0.016, bh * 0.7);
      });
      inBand(g, w, h, RD.GEAR, RD.N, (c, bw, bh) => {
        c.fillStyle = '#d0d0d0';
        for (let i = 0; i < 12; i++) {
          for (let j = 0; j < 4; j++) {
            c.beginPath(); c.roundRect(bw * (i / 12) + 4, bh * (j / 4) + 4, bw / 12 - 8, bh / 4 - 8, 6); c.fill();
          }
        }
        overlayGrain(c, bw, bh, 0.5, 6, _speck);
      });
    },
    rough(g, w, h) {
      fill(g, w, h, '#c4c4c4');
      inBand(g, w, h, RD.SKIN, RD.N, (c, bw, bh) => { fill(c, bw, bh, '#a4a4a4'); overlayGrain(c, bw, bh, 0.3, 5); });
      inBand(g, w, h, RD.JERSEY, RD.N, (c, bw, bh) => { fill(c, bw, bh, '#eaeaea'); overlayGrain(c, bw, bh, 0.25, 4); });
      inBand(g, w, h, RD.PRINT, RD.N, (c, bw, bh) => {
        fill(c, bw, bh, '#eaeaea');
        c.fillStyle = '#d8d8d8'; c.fillRect(0, bh * 0.66, bw, bh * 0.34);
        text(c, 'VOLTA', bw * 0.5, bh * 0.26, bh * 0.115, '#a8a8a8', { skew: -0.16, spacing: bh * 0.010 });
      });
      inBand(g, w, h, RD.PANTS, RD.N, (c, bw, bh) => { fill(c, bw, bh, '#e6e6e6'); overlayGrain(c, bw, bh, 0.3, 4); });
      inBand(g, w, h, RD.KNEE, RD.N, (c, bw, bh) => fill(c, bw, bh, '#e2e2e2'));
      inBand(g, w, h, RD.SHOE, RD.N, (c, bw, bh) => { fill(c, bw, bh, '#d2d2d2'); overlayGrain(c, bw, bh, 0.3, 4); });
      inBand(g, w, h, RD.SOLE, RD.N, (c, bw, bh) => fill(c, bw, bh, '#a2a2a2'));
      inBand(g, w, h, RD.GEAR, RD.N, (c, bw, bh) => { fill(c, bw, bh, '#bcbcbc'); overlayGrain(c, bw, bh, 0.35, 5); });
    },
  }, { normalStrength: 1.1 });

  const rider = new THREE.MeshStandardMaterial({
    ...maps,
    color: 0xffffff,
    metalness: 0.0,
    roughness: 1.0,
    normalScale: new THREE.Vector2(0.55, 0.55),
    envMapIntensity: 0.7,
  });
  rider.name = 'riderSkinned';

  const hMaps = mapSet(aniso, 1024, 512, {
    color(g, w, h) {
      inBand(g, w, h, HM.SHELL, HM.N, (c, bw, bh) => {
        fill(c, bw, bh, '#23262c');
        const grad = c.createLinearGradient(0, 0, 0, bh);
        grad.addColorStop(0, 'rgba(255,255,255,0.10)');
        grad.addColorStop(1, 'rgba(0,0,0,0.35)');
        c.fillStyle = grad; c.fillRect(0, 0, bw, bh);
        c.fillStyle = '#c3d84a';
        c.fillRect(0, 0, bw * 0.028, bh); c.fillRect(bw * 0.972, 0, bw * 0.028, bh);
        c.fillRect(bw * 0.486, 0, bw * 0.028, bh);
        c.fillStyle = '#e8552f';
        c.fillRect(bw * 0.032, 0, bw * 0.014, bh); c.fillRect(bw * 0.954, 0, bw * 0.014, bh);
        c.fillRect(bw * 0.518, 0, bw * 0.014, bh);
        text(c, 'GRIT', bw * 0.25, bh * 0.62, bh * 0.30, '#f2ecdc', { skew: -0.2, spacing: 3 });
        text(c, 'GRIT', bw * 0.75, bh * 0.62, bh * 0.30, '#f2ecdc', { skew: -0.2, spacing: 3 });
        scratches(c, bw, bh, 60, '#9aa0a8', 6, 50, 0.7);
        overlayGrain(c, bw, bh, 0.1, 3);
      });
      inBand(g, w, h, HM.VENT, HM.N, (c, bw, bh) => { fill(c, bw, bh, '#0a0b0d'); overlayGrain(c, bw, bh, 0.2, 3); });
      inBand(g, w, h, HM.STRAP, HM.N, (c, bw, bh) => {
        fill(c, bw, bh, '#141519');
        for (let i = 0; i < bw; i += 6) { c.fillStyle = 'rgba(90,94,100,0.35)'; c.fillRect(i, 0, 3, bh); }
      });
      inBand(g, w, h, HM.LINER, HM.N, (c, bw, bh) => { fill(c, bw, bh, '#26282d'); overlayGrain(c, bw, bh, 0.4, 6, _speck); });
    },
    height(g, w, h) {
      fill(g, w, h, '#808080');
      inBand(g, w, h, HM.SHELL, HM.N, (c, bw, bh) => overlayGrain(c, bw, bh, 0.25, 4));
      inBand(g, w, h, HM.STRAP, HM.N, (c, bw, bh) => {
        for (let i = 0; i < bw; i += 6) { c.fillStyle = '#c0c0c0'; c.fillRect(i, 0, 3, bh); }
      });
      inBand(g, w, h, HM.LINER, HM.N, (c, bw, bh) => overlayGrain(c, bw, bh, 0.9, 8, _speck));
    },
    rough(g, w, h) {
      fill(g, w, h, '#4a4a4a');
      inBand(g, w, h, HM.SHELL, HM.N, (c, bw, bh) => { fill(c, bw, bh, '#3a3a3a'); scratches(c, bw, bh, 70, '#8a8a8a', 6, 50, 0.8); });
      inBand(g, w, h, HM.VENT, HM.N, (c, bw, bh) => fill(c, bw, bh, '#a0a0a0'));
      inBand(g, w, h, HM.STRAP, HM.N, (c, bw, bh) => fill(c, bw, bh, '#c8c8c8'));
      inBand(g, w, h, HM.LINER, HM.N, (c, bw, bh) => fill(c, bw, bh, '#dcdcdc'));
    },
  }, { normalStrength: 0.8 });

  const helmet = new THREE.MeshPhysicalMaterial({
    ...hMaps,
    color: 0xffffff,
    metalness: 0.15,
    roughness: 1.0,
    clearcoat: 0.7,
    clearcoatRoughness: 0.18,
    envMapIntensity: 1.0,
  });
  helmet.name = 'riderHelmet';

  const lens = new THREE.MeshPhysicalMaterial({
    color: 0x8a5c2e,
    metalness: 1.0,
    roughness: 0.05,
    clearcoat: 1.0,
    clearcoatRoughness: 0.03,
    envMapIntensity: 1.8,
  });
  lens.name = 'riderLens';

  return { rider, helmet, lens };
}

// ---------------------------------------------------------------------------
// bike: wheels
// ---------------------------------------------------------------------------

/** Small UV rect inside an atlas band — used for parts with no meaningful UVs. */
function patch(geo, u0, u1, v0, v1) { return atlasUV(normalise(geo), u0, u1, v0, v1); }

/** Circle point in wheel space: spin axis is +X. */
function wheelPt(x, r, a) { return V(x, r * Math.cos(a), r * Math.sin(a)); }

function latheX(profile, segments) {
  const geo = new THREE.LatheGeometry(profile.map(([r, x]) => new THREE.Vector2(r, x)), segments);
  geo.rotateZ(-Math.PI / 2);
  return geo;
}

function buildWheel(isRear) {
  const hw = [], rub = [];

  // --- rim: double-wall box section with bead seats and a brake track ---------
  const rimProfile = [
    [G.rimInner, -0.0128], [G.rimInner + 0.006, -0.0132], [0.2085, -0.0132],
    [G.rimOuter, -0.0112], [G.rimOuter, -0.0062], [0.2072, -0.0034],
    [0.2072, 0.0034], [G.rimOuter, 0.0062], [G.rimOuter, 0.0112],
    [0.2085, 0.0132], [G.rimInner + 0.006, 0.0132], [G.rimInner, 0.0128],
  ];
  hw.push(band(latheX(rimProfile, 36), HW.ANOD, HW.N));

  // --- hub: shell, flanges, cones, axle --------------------------------------
  hw.push(patch(latheX([
    [0.0000, -0.052], [0.0090, -0.052], [0.0125, -0.046], [0.0150, -0.032],
    [0.0170, -0.030], [0.0170, 0.030], [0.0150, 0.032], [0.0125, 0.046],
    [0.0090, 0.052], [0.0000, 0.052],
  ], 20), 0.05, 0.45, HW.ALLOY / HW.N + 0.01, (HW.ALLOY + 1) / HW.N - 0.01));
  for (const s of [-1, 1]) {
    const fl = latheX([
      [G.hubR, s * 0.0235], [G.flangeR - 0.003, s * 0.0245], [G.flangeR, s * 0.0262],
      [G.flangeR, s * (0.0262 + 0.0042)], [G.flangeR - 0.004, s * 0.0308], [G.hubR, s * 0.0300],
    ], 20);
    hw.push(patch(fl, 0.05, 0.45, (HW.ALLOY + 0.1) / HW.N, (HW.ALLOY + 0.9) / HW.N));
  }
  hw.push(patch(rod(V(-0.085, 0, 0), V(0.085, 0, 0), 0.0072), 0.1, 0.9, (HW.CHROME + 0.1) / HW.N, (HW.CHROME + 0.9) / HW.N));
  for (const s of [-1, 1]) {
    const nut = new THREE.CylinderGeometry(0.0125, 0.0125, 0.009, 6);
    nut.rotateZ(Math.PI / 2); nut.translate(s * 0.0665, 0, 0);
    hw.push(patch(nut, 0.1, 0.9, (HW.RED + 0.1) / HW.N, (HW.RED + 0.9) / HW.N));
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
      hw.push(patch(rod(a, b, 0.00105, 0.00095, 5, false), 0.1, 0.9, (HW.CHROME + 0.2) / HW.N, (HW.CHROME + 0.8) / HW.N));
      const nb = wheelPt(sx * 0.0062, rimHole - 0.0075, rimA);
      nipples.push(rod(b, nb, 0.0027, 0.0022, 5, true));
    }
  }
  hw.push(patch(merge(nipples), 0.1, 0.9, (HW.BRASS + 0.1) / HW.N, (HW.BRASS + 0.9) / HW.N));

  // --- valve stem -------------------------------------------------------------
  const va = 0.6;
  hw.push(patch(rod(wheelPt(0.0, 0.196, va), wheelPt(0.0, 0.223, va), 0.0035, 0.0032, 6),
    0.1, 0.9, (HW.BRASS + 0.1) / HW.N, (HW.BRASS + 0.9) / HW.N));
  const cap = new THREE.CylinderGeometry(0.0042, 0.0042, 0.010, 8);
  place(cap, wheelPt(0, 0.221, va), wheelPt(0, 0.234, va));
  hw.push(patch(cap, 0.1, 0.9, (HW.ANOD + 0.1) / HW.N, (HW.ANOD + 0.9) / HW.N));

  // --- driver + cog (rear only) ----------------------------------------------
  if (isRear) {
    const driver = latheX([[0.014, 0.030], [0.026, 0.032], [0.028, 0.036], [0.028, 0.052], [0.014, 0.054]], 18);
    hw.push(patch(driver, 0.1, 0.9, (HW.STEEL + 0.1) / HW.N, (HW.STEEL + 0.9) / HW.N));
    const { shape } = sprocketShape(G.cogTeeth, G.pitch, 0, 0);
    const cog = plate(shape, 0.0042, 0.0006, 3);
    cog.rotateY(Math.PI / 2);
    cog.translate(G.chainLine, 0, 0);
    hw.push(patch(cog, 0.05, 0.95, (HW.OILY + 0.1) / HW.N, (HW.OILY + 0.9) / HW.N));
  }

  // --- tyre: lathed casing plus real knobs ------------------------------------
  // the bead sits just proud of the rim's outer wall so the anodised rim reads
  const tyreProfile = [
    [0.2140, -0.0110], [0.2215, -0.0225], [0.2360, -0.0288], [0.2505, -0.0268],
    [0.2578, -0.0160], [0.2600, 0.0000], [0.2578, 0.0160], [0.2505, 0.0268],
    [0.2360, 0.0288], [0.2215, 0.0225], [0.2140, 0.0110],
  ];
  rub.push(band(latheX(tyreProfile, 40), RUB.TYRE, RUB.N));

  const knobs = [];
  const rows = 20;
  for (let i = 0; i < rows; i++) {
    const a = (i / rows) * TAU;
    const set = i % 2 === 0
      ? [[0, 0.2585, 0.0135, 0.0095], [-0.0195, 0.2505, 0.0105, 0.0115], [0.0195, 0.2505, 0.0105, 0.0115]]
      : [[-0.0085, 0.2570, 0.0110, 0.0090], [0.0085, 0.2570, 0.0110, 0.0090], [-0.0245, 0.2440, 0.0100, 0.0110], [0.0245, 0.2440, 0.0100, 0.0110]];
    for (const [x, r, len, wid] of set) {
      const kb = new THREE.BoxGeometry(wid, 0.0055, len);
      const p = wheelPt(x, r, a);
      const out = V(0, Math.cos(a), Math.sin(a));
      place(kb, p, p.clone().addScaledVector(out, 0.0055), V(1, 0, 0));
      knobs.push(kb);
    }
  }
  rub.push(patch(merge(knobs), 0.020, 0.030, 0.105, 0.145));

  return { core: merge(hw), tyre: merge(rub) };
}

// ---------------------------------------------------------------------------
// bike: frame
// ---------------------------------------------------------------------------

function buildFrame() {
  const paint = [], hw = [], rub = [];
  const { bb, stTop, htBottom, htTop, axisUp, axisFwd, rearAxle } = PT;
  const dropZ = rearAxle.z + 0.006;

  // down tube — ovalised at the bottom bracket, round at the head tube
  const dtA = bb.clone().add(V(0, 0.016, 0.026));
  const dtC = htBottom.clone().addScaledVector(axisUp, 0.028).addScaledVector(axisFwd, -0.004);
  const dtM = dtA.clone().lerp(dtC, 0.5).add(V(0, -0.012, 0));
  paint.push(band(sweep([dtA, dtM, dtC], {
    radius: 0.0215, radial: 10, steps: 18,
    taper: (t) => lerp(1.0, 0.88, smoothstep(t)),
    oval: (t) => [lerp(1.24, 1.0, smoothstep(clamp(t * 2.2, 0, 1))), lerp(0.82, 1.0, smoothstep(clamp(t * 2.2, 0, 1)))],
  }), PAINT.DECAL, PAINT.N));

  // top tube
  const ttA = stTop.clone().add(V(0, -0.020, 0.004));
  const ttB = htTop.clone().addScaledVector(axisUp, -0.026).addScaledVector(axisFwd, -0.006);
  paint.push(band(sweep([ttA, ttA.clone().lerp(ttB, 0.5).add(V(0, 0.004, 0)), ttB], {
    radius: 0.0158, radial: 10, steps: 16,
  }), PAINT.SCRIPT, PAINT.N));

  // seat tube + head tube
  paint.push(band(sweep([bb.clone().add(V(0, 0.014, -0.006)), bb.clone().lerp(stTop, 0.55), stTop], {
    radius: 0.0168, radial: 10, steps: 12, taper: (t) => lerp(1.06, 0.96, t),
  }), PAINT.PLAIN, PAINT.N));
  paint.push(band(sweep([
    htBottom.clone().addScaledVector(axisUp, -0.004),
    htBottom.clone().lerp(htTop, 0.5),
    htTop.clone().addScaledVector(axisUp, 0.004),
  ], { radius: 0.0248, radial: 12, steps: 6, taper: (t) => 1 + 0.10 * Math.cos(t * Math.PI * 2 - Math.PI) * 0 + 0.06 * (Math.abs(t - 0.5) > 0.35 ? 1 : 0) }), PAINT.PLAIN, PAINT.N));

  // chainstays and seatstays — bowed out for tyre clearance
  for (const s of [-1, 1]) {
    const csA = bb.clone().add(V(s * 0.030, -0.004, -0.014));
    const csM = V(s * 0.079, 0.288, -0.330);
    const csB = V(s * 0.056, 0.264, dropZ + 0.010);
    paint.push(band(sweep([csA, csM, csB], {
      radius: 0.0145, radial: 8, steps: 16, taper: (t) => lerp(1.05, 0.72, smoothstep(t)),
      oval: (t) => [lerp(1.0, 0.75, smoothstep(t)), lerp(1.0, 1.25, smoothstep(t))],
    }), PAINT.PLAIN, PAINT.N));

    const ssA = stTop.clone().add(V(s * 0.019, -0.030, -0.004));
    const ssM = V(s * 0.052, 0.412, -0.352);
    const ssB = V(s * 0.056, 0.268, dropZ + 0.012);
    paint.push(band(sweep([ssA, ssM, ssB], {
      radius: 0.0118, radial: 8, steps: 16, taper: (t) => lerp(1.0, 0.68, smoothstep(t)),
    }), PAINT.PLAIN, PAINT.N));

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
    paint.push(band(dp, PAINT.DARK, PAINT.N));

    // chain tensioner
    const ten = new THREE.BoxGeometry(0.012, 0.016, 0.030);
    ten.translate(s * 0.066, G.tyreR + 0.001, rearAxle.z - 0.030);
    hw.push(patch(ten, 0.1, 0.9, (HW.ANOD + 0.1) / HW.N, (HW.ANOD + 0.9) / HW.N));
    const tb = new THREE.CylinderGeometry(0.0035, 0.0035, 0.030, 6);
    tb.rotateX(Math.PI / 2);
    tb.translate(s * 0.066, G.tyreR + 0.001, rearAxle.z - 0.048);
    hw.push(patch(tb, 0.1, 0.9, (HW.CHROME + 0.1) / HW.N, (HW.CHROME + 0.9) / HW.N));
  }

  // bottom bracket shell
  const bbShell = latheX([[0.0, -0.038], [0.020, -0.038], [0.0235, -0.034], [0.0235, 0.034], [0.020, 0.038], [0.0, 0.038]], 18);
  bbShell.translate(bb.x, bb.y, bb.z);
  paint.push(band(bbShell, PAINT.PLAIN, PAINT.N));

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
  paint.push(band(gus, PAINT.DARK, PAINT.N));

  const gShape2 = new THREE.Shape();
  gShape2.moveTo(0, 0); gShape2.lineTo(0.060, 0); gShape2.quadraticCurveTo(0.030, 0.014, 0.006, 0.042);
  gShape2.lineTo(0, 0.042); gShape2.closePath();
  const gus2 = plate(gShape2, 0.005, 0.0008, 5);
  gus2.rotateY(Math.PI / 2);
  gus2.rotateX(-0.42);
  gus2.translate(0, bb.y + 0.020, bb.z + 0.020);
  paint.push(band(gus2, PAINT.DARK, PAINT.N));

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
  for (const [p, ax, r] of beads) paint.push(band(weld(p, ax, r), PAINT.PLAIN, PAINT.N));
  for (const s of [-1, 1]) {
    const csDir = V(s * 0.5, -0.12, -0.86).normalize();
    paint.push(band(weld(bb.clone().add(V(s * 0.032, -0.004, -0.016)), csDir, 0.0158), PAINT.PLAIN, PAINT.N));
    const ssDir = V(s * 0.16, -0.62, -0.77).normalize();
    paint.push(band(weld(stTop.clone().add(V(s * 0.019, -0.032, -0.006)), ssDir, 0.0130), PAINT.PLAIN, PAINT.N));
  }

  // seat post, clamp, pegs, brake
  const spTop = stTop.clone().addScaledVector(PT.stDir, 0.075);
  hw.push(patch(rod(stTop.clone().addScaledVector(PT.stDir, -0.05), spTop, 0.0135), 0.1, 0.9,
    (HW.CHROME + 0.1) / HW.N, (HW.CHROME + 0.9) / HW.N));
  const clampGeo = latheX([[0.0168, -0.010], [0.0205, -0.010], [0.0205, 0.010], [0.0168, 0.010]], 16);
  _q.setFromUnitVectors(V(1, 0, 0), PT.stDir);
  clampGeo.applyQuaternion(_q);
  clampGeo.translate(stTop.x, stTop.y + 0.004, stTop.z);
  hw.push(patch(clampGeo, 0.1, 0.9, (HW.RED + 0.1) / HW.N, (HW.RED + 0.9) / HW.N));
  const clampBolt = new THREE.CylinderGeometry(0.0035, 0.0035, 0.030, 6);
  clampBolt.rotateZ(Math.PI / 2);
  clampBolt.translate(stTop.x, stTop.y + 0.004, stTop.z - 0.020);
  hw.push(patch(clampBolt, 0.1, 0.9, (HW.CHROME + 0.1) / HW.N, (HW.CHROME + 0.9) / HW.N));

  for (const s of [-1, 1]) {
    const pegA = V(s * 0.062, G.tyreR, rearAxle.z);
    const peg = latheX([
      [0.0, 0], [G.pegR - 0.004, 0], [G.pegR, 0.006], [G.pegR, G.pegLen - 0.008],
      [G.pegR - 0.003, G.pegLen], [0.0, G.pegLen],
    ], 18);
    peg.rotateZ(s > 0 ? 0 : Math.PI);
    peg.translate(pegA.x, pegA.y, pegA.z);
    hw.push(band(peg, HW.PEG, HW.N));
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
    hw.push(patch(arm, 0.1, 0.9, (HW.ANOD + 0.1) / HW.N, (HW.ANOD + 0.9) / HW.N));
    const pad = new THREE.CylinderGeometry(0.0075, 0.0075, 0.014, 10);
    pad.rotateZ(Math.PI / 2);
    pad.translate(s * 0.038, 0.398, -0.348);
    rub.push(patch(pad, 0.1, 0.9, (RUB.CABLE + 0.1) / RUB.N, (RUB.CABLE + 0.9) / RUB.N));
  }
  rub.push(patch(rod(V(-0.062, 0.466, -0.298), V(0, 0.446, -0.292), 0.0016), 0.1, 0.9, (RUB.CABLE + 0.1) / RUB.N, (RUB.CABLE + 0.9) / RUB.N));
  rub.push(patch(rod(V(0.062, 0.466, -0.298), V(0, 0.446, -0.292), 0.0016), 0.1, 0.9, (RUB.CABLE + 0.1) / RUB.N, (RUB.CABLE + 0.9) / RUB.N));

  // gyro lower cables: head tube down the top tube to the brake
  const gyroBase = htTop.clone().addScaledVector(axisUp, 0.030);
  for (const s of [-1, 1]) {
    rub.push(band(sweep([
      gyroBase.clone().add(V(s * 0.016, 0.006, -0.004)),
      ttA.clone().lerp(ttB, 0.62).add(V(s * 0.012, 0.020, 0)),
      ttA.clone().lerp(ttB, 0.18).add(V(s * 0.010, 0.020, 0)),
      V(s * 0.030, 0.500, -0.300),
      V(s * 0.055, 0.462, -0.300),
    ], { radius: 0.0026, radial: 5, steps: 22 }), RUB.CABLE, RUB.N));
  }

  return { paint: merge(paint), hardware: merge(hw), rubber: merge(rub) };
}

// ---------------------------------------------------------------------------
// bike: fork, bars, drivetrain, seat
// ---------------------------------------------------------------------------

function buildFork() {
  const paint = [], hw = [];
  const { htBottom, htTop, axisUp, frontAxle } = PT;
  const crown = htBottom.clone().addScaledVector(axisUp, -0.030);

  // steerer tube through the head tube
  hw.push(patch(rod(crown.clone().addScaledVector(axisUp, 0.010),
    htTop.clone().addScaledVector(axisUp, 0.086), 0.0143), 0.1, 0.9,
    (HW.CHROME + 0.1) / HW.N, (HW.CHROME + 0.9) / HW.N));

  // crown
  const crownGeo = latheX([
    [0.0, -0.052], [0.026, -0.052], [0.030, -0.044], [0.030, 0.044], [0.026, 0.052], [0.0, 0.052],
  ], 16);
  crownGeo.translate(crown.x, crown.y, crown.z);
  paint.push(band(crownGeo, PAINT.PLAIN, PAINT.N));
  paint.push(band(weld(crown, axisUp, 0.031), PAINT.PLAIN, PAINT.N));

  for (const s of [-1, 1]) {
    const a = crown.clone().add(V(s * 0.040, 0.006, 0));
    const m = crown.clone().lerp(frontAxle, 0.55).add(V(s * 0.052, 0.006, 0.004));
    const b = V(s * 0.056, frontAxle.y + 0.006, frontAxle.z - 0.002);
    paint.push(band(sweep([a, m, b], {
      radius: 0.0182, radial: 8, steps: 16,
      taper: (t) => lerp(1.0, 0.62, smoothstep(t)),
      oval: (t) => [lerp(0.92, 0.78, t), lerp(1.06, 1.22, t)],
    }), PAINT.PLAIN, PAINT.N));

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
    paint.push(band(dp, PAINT.DARK, PAINT.N));

    // front pegs
    const peg = latheX([
      [0.0, 0], [G.pegR - 0.004, 0], [G.pegR, 0.006], [G.pegR, G.pegLen - 0.008],
      [G.pegR - 0.003, G.pegLen], [0.0, G.pegLen],
    ], 18);
    peg.rotateZ(s > 0 ? 0 : Math.PI);
    peg.translate(s * 0.062, frontAxle.y, frontAxle.z);
    hw.push(band(peg, HW.PEG, HW.N));

    const nut = new THREE.CylinderGeometry(0.0125, 0.0125, 0.009, 6);
    nut.rotateZ(Math.PI / 2);
    nut.translate(s * (0.062 + G.pegLen + 0.005), frontAxle.y, frontAxle.z);
    hw.push(patch(nut, 0.1, 0.9, (HW.RED + 0.1) / HW.N, (HW.RED + 0.9) / HW.N));
  }

  // headset cups, spacers, gyro lower plate
  const cupLo = latheX([[0.0148, -0.012], [0.0290, -0.012], [0.0300, -0.004], [0.0250, 0.006], [0.0148, 0.006]], 18);
  _q.setFromUnitVectors(V(1, 0, 0), axisUp);
  cupLo.applyQuaternion(_q); cupLo.translate(htBottom.x, htBottom.y, htBottom.z);
  hw.push(patch(cupLo, 0.1, 0.9, (HW.RED + 0.1) / HW.N, (HW.RED + 0.9) / HW.N));

  const cupHi = latheX([[0.0148, -0.006], [0.0250, -0.006], [0.0300, 0.004], [0.0290, 0.014], [0.0148, 0.014]], 18);
  cupHi.applyQuaternion(_q); cupHi.translate(htTop.x, htTop.y, htTop.z);
  hw.push(patch(cupHi, 0.1, 0.9, (HW.RED + 0.1) / HW.N, (HW.RED + 0.9) / HW.N));

  const gyroLo = latheX([[0.0150, 0], [0.0300, 0], [0.0300, 0.007], [0.0150, 0.007]], 20);
  gyroLo.applyQuaternion(_q);
  const gp = htTop.clone().addScaledVector(axisUp, 0.020);
  gyroLo.translate(gp.x, gp.y, gp.z);
  hw.push(patch(gyroLo, 0.1, 0.9, (HW.ANOD + 0.1) / HW.N, (HW.ANOD + 0.9) / HW.N));

  return { paint: merge(paint), hardware: merge(hw) };
}

function buildBars() {
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
  hw.push(band(sweep(pts, { radius: 0.0143, radial: 8, steps: 40, tension: 0.42 }), HW.CHROME, HW.N));

  // crossbar
  const cbY = 0.150, cbA = [], cbB = [];
  for (const s of [-1, 1]) {
    cbA.push(barCentre.clone().add(V(s * 0.104, cbY, -0.028)));
    cbB.push(barCentre.clone().add(V(s * 0.070, cbY + 0.028, -0.020)));
  }
  hw.push(band(sweep([cbA[0], cbB[0], cbB[1], cbA[1]], { radius: 0.0105, radial: 8, steps: 14, tension: 0.3 }), HW.CHROME, HW.N));

  // stem: body, faceplate, six bolts
  const fwd = axisFwd.clone(), up = axisUp.clone();
  const side = new THREE.Vector3().crossVectors(fwd, up).normalize();
  const basis = new THREE.Matrix4().makeBasis(fwd, up, side);
  const body = plate(roundedRectShape(0.088, 0.046, 0.010), 0.044, 0.0012, 4);
  body.applyMatrix4(basis);
  body.translate(
    (stemBase.x + barCentre.x) / 2, (stemBase.y + barCentre.y) / 2, (stemBase.z + barCentre.z) / 2);
  hw.push(band(body, HW.ANOD, HW.N));

  const clampRing = latheX([[0.0148, -0.024], [0.0230, -0.024], [0.0230, 0.024], [0.0148, 0.024]], 14);
  _q.setFromUnitVectors(V(1, 0, 0), axisUp);
  clampRing.applyQuaternion(_q);
  clampRing.translate(stemBase.x, stemBase.y, stemBase.z);
  hw.push(patch(clampRing, 0.1, 0.9, (HW.ANOD + 0.1) / HW.N, (HW.ANOD + 0.9) / HW.N));

  const face = plate(roundedRectShape(0.048, 0.052, 0.008), 0.014, 0.001, 4);
  face.applyMatrix4(basis);
  face.translate(
    barCentre.x + fwd.x * 0.018, barCentre.y + fwd.y * 0.018, barCentre.z + fwd.z * 0.018);
  hw.push(band(face, HW.ANOD, HW.N));

  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const bolt = new THREE.CylinderGeometry(0.0042, 0.0042, 0.020, 6);
      const o = barCentre.clone()
        .addScaledVector(fwd, 0.022)
        .addScaledVector(up, sy * 0.017)
        .addScaledVector(side, sx * 0.017);
      place(bolt, o, o.clone().addScaledVector(fwd, -0.02));
      hw.push(patch(bolt, 0.1, 0.9, (HW.CHROME + 0.1) / HW.N, (HW.CHROME + 0.9) / HW.N));
    }
    const sbolt = new THREE.CylinderGeometry(0.0038, 0.0038, 0.028, 6);
    const o = stemBase.clone().addScaledVector(fwd, -0.026).addScaledVector(up, sx * 0.013);
    place(sbolt, o, o.clone().addScaledVector(side, 0.028));
    hw.push(patch(sbolt, 0.1, 0.9, (HW.CHROME + 0.1) / HW.N, (HW.CHROME + 0.9) / HW.N));
  }

  // top cap
  const cap = latheX([[0, 0], [0.017, 0], [0.017, 0.006], [0.010, 0.010], [0, 0.010]], 16);
  cap.applyQuaternion(_q);
  const capP = stemBase.clone().addScaledVector(axisUp, 0.026);
  cap.translate(capP.x, capP.y, capP.z);
  hw.push(patch(cap, 0.1, 0.9, (HW.RED + 0.1) / HW.N, (HW.RED + 0.9) / HW.N));

  // gyro upper plate + upper cable
  const gyroHi = latheX([[0.0150, 0], [0.0285, 0], [0.0285, 0.006], [0.0150, 0.006]], 20);
  gyroHi.applyQuaternion(_q);
  const ghp = htTop.clone().addScaledVector(axisUp, 0.029);
  gyroHi.translate(ghp.x, ghp.y, ghp.z);
  hw.push(patch(gyroHi, 0.1, 0.9, (HW.ANOD + 0.1) / HW.N, (HW.ANOD + 0.9) / HW.N));

  // brake lever on the right bar
  const gripInner = barCentre.clone().add(V(0.180, 0.222, -0.056));
  const gripOuter = barCentre.clone().add(V(0.330, 0.228, -0.074));
  const perch = latheX([[0.0143, 0], [0.0210, 0], [0.0210, 0.020], [0.0143, 0.020]], 14);
  const gdir = gripOuter.clone().sub(gripInner).normalize();
  _q.setFromUnitVectors(V(1, 0, 0), gdir);
  perch.applyQuaternion(_q);
  const perchP = gripInner.clone().addScaledVector(gdir, -0.020);
  perch.translate(perchP.x, perchP.y, perchP.z);
  hw.push(patch(perch, 0.1, 0.9, (HW.ANOD + 0.1) / HW.N, (HW.ANOD + 0.9) / HW.N));

  const bladeShape = new THREE.Shape();
  bladeShape.moveTo(0, 0); bladeShape.lineTo(0.086, -0.012);
  bladeShape.quadraticCurveTo(0.100, -0.014, 0.098, -0.024);
  bladeShape.lineTo(0.080, -0.026); bladeShape.lineTo(0.004, -0.012); bladeShape.closePath();
  const blade = plate(bladeShape, 0.0075, 0.0008, 4);
  const bFwd = V(0, 0, 1), bUp = V(0, 1, 0);
  blade.applyMatrix4(new THREE.Matrix4().makeBasis(bFwd, bUp, new THREE.Vector3().crossVectors(bFwd, bUp)));
  blade.translate(perchP.x + 0.012, perchP.y - 0.006, perchP.z + 0.016);
  hw.push(patch(blade, 0.1, 0.9, (HW.ALLOY + 0.1) / HW.N, (HW.ALLOY + 0.9) / HW.N));

  rub.push(band(sweep([
    perchP.clone().add(V(0.004, 0.010, 0.016)),
    perchP.clone().add(V(-0.03, 0.036, 0.030)),
    barCentre.clone().add(V(0.02, 0.230, -0.010)),
    barCentre.clone().add(V(0.0, 0.120, 0.010)),
    ghp.clone().add(V(0.0, 0.014, 0.012)),
  ], { radius: 0.0026, radial: 5, steps: 24 }), RUB.CABLE, RUB.N));

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
    rub.push(band(gr, RUB.GRIP, RUB.N));

    const plug = latheX([[0, 0], [0.0130, 0], [0.0150, 0.004], [0.0140, 0.010], [0, 0.010]], 16);
    const pdir = go.clone().sub(gi).normalize();
    _q.setFromUnitVectors(V(1, 0, 0), pdir);
    plug.applyQuaternion(_q);
    const pp = gi.clone().addScaledVector(pdir, 0.148);
    plug.translate(pp.x, pp.y, pp.z);
    hw.push(patch(plug, 0.1, 0.9, (HW.RED + 0.1) / HW.N, (HW.RED + 0.9) / HW.N));
  }

  const gripAnchorL = barCentre.clone().add(V(-0.255, 0.2245, -0.0655));
  const gripAnchorR = barCentre.clone().add(V(0.255, 0.2245, -0.0655));
  return { hardware: merge(hw), rubber: merge(rub), gripAnchorL, gripAnchorR, barCentre };
}

function buildSeat() {
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
  rub.push(band(s, RUB.SEAT, RUB.N));

  const mount = plate(roundedRectShape(0.052, 0.030, 0.006), 0.026, 0.0008, 4);
  mount.rotateY(Math.PI / 2);
  mount.rotateX(-0.22);
  mount.translate(base.x, base.y - 0.004, base.z + 0.006);
  hw.push(patch(mount, 0.1, 0.9, (HW.ANOD + 0.1) / HW.N, (HW.ANOD + 0.9) / HW.N));

  return { rubber: merge(rub), hardware: merge(hw) };
}

function buildDrivetrain() {
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
    hw.push(band(arm, HW.ALLOY, HW.N));
    // pedal spindle
    const sp = V(s * 0.066, bb.y, bb.z + s * G.crankLen);
    const so = V(s * 0.150, bb.y, bb.z + s * G.crankLen);
    hw.push(patch(rod(sp, so, 0.0075, 0.0065, 8), 0.1, 0.9, (HW.CHROME + 0.1) / HW.N, (HW.CHROME + 0.9) / HW.N));
    pedalPos.push(V(s * 0.112, bb.y, bb.z + s * G.crankLen));
  }
  // spindle + dust caps
  hw.push(patch(rod(V(-0.062, bb.y, bb.z), V(0.062, bb.y, bb.z), 0.0115), 0.1, 0.9,
    (HW.STEEL + 0.1) / HW.N, (HW.STEEL + 0.9) / HW.N));

  // chainring on the drive side
  const { shape: ringShape, R: ringR } = sprocketShape(G.sprocketTeeth, G.pitch, 5, 0.0115);
  const ring = plate(ringShape, 0.0052, 0.0007, 4);
  ring.rotateY(Math.PI / 2);
  ring.rotateX(Math.PI / 2);
  ring.translate(G.chainLine, bb.y, bb.z);
  hw.push(band(ring, HW.ALLOY, HW.N));
  for (let i = 0; i < 4; i++) {                    // sprocket bolts
    const a = (i / 4) * TAU + 0.5;
    const bolt = new THREE.CylinderGeometry(0.0045, 0.0045, 0.014, 6);
    bolt.rotateZ(Math.PI / 2);
    bolt.translate(0.048, bb.y + Math.sin(a) * ringR * 0.30, bb.z + Math.cos(a) * ringR * 0.30);
    hw.push(patch(bolt, 0.1, 0.9, (HW.CHROME + 0.1) / HW.N, (HW.CHROME + 0.9) / HW.N));
  }

  // pedals: alloy platform, cage plates, eight grip pins per side
  const pedals = pedalPos.map((pp) => {
    const parts = [];
    const bodyShape = roundedRectShape(0.098, 0.076, 0.008);
    const bodyGeo = plate(bodyShape, 0.021, 0.0012, 4);
    bodyGeo.rotateY(Math.PI / 2);
    bodyGeo.rotateZ(Math.PI / 2);
    bodyGeo.translate(pp.x, pp.y, pp.z);
    parts.push(band(bodyGeo, HW.ALLOY, HW.N));
    for (let k = 0; k < 4; k++) {
      for (const sy of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const pin = new THREE.CylinderGeometry(0.0021, 0.0018, 0.0075, 5);
          const px = pp.x + (k - 1.5) * 0.024;
          const pz = pp.z + sz * 0.030;
          pin.translate(px, pp.y + sy * 0.0135, pz);
          parts.push(patch(pin, 0.1, 0.9, (HW.CHROME + 0.1) / HW.N, (HW.CHROME + 0.9) / HW.N));
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
  for (let i = 0; i < n; i++) {
    cum[i + 1] = cum[i] + path[i].distanceTo(path[(i + 1) % n]);
  }
  const total = cum[n];
  const links = Math.max(8, Math.round(total / G.pitch));

  // one link: two plates and a roller, tiling along +X at exactly one pitch
  const linkParts = [];
  for (const s of [-1, 1]) {
    const pl = new THREE.BoxGeometry(G.pitch * 1.12, 0.0072, 0.0013);
    pl.translate(G.pitch * 0.5, 0, s * 0.0026);
    linkParts.push(patch(pl, 0.1, 0.9, (HW.OILY + 0.1) / HW.N, (HW.OILY + 0.9) / HW.N));
  }
  const roller = new THREE.CylinderGeometry(0.0037, 0.0037, 0.0048, 5);
  roller.rotateX(Math.PI / 2);
  linkParts.push(patch(roller, 0.1, 0.9, (HW.STEEL + 0.1) / HW.N, (HW.STEEL + 0.9) / HW.N));
  const linkGeo = merge(linkParts);

  return {
    hardware: merge(hw),
    pedals,
    chain: { path, cum, total, links, geo: linkGeo },
    ringR,
  };
}

// ---------------------------------------------------------------------------
// bike assembly
// ---------------------------------------------------------------------------

function buildBike(mats) {
  const group = new THREE.Group();
  group.name = 'bike';

  const frame = buildFrame();
  const fork = buildFork();
  const bars = buildBars();
  const seat = buildSeat();
  const drive = buildDrivetrain();
  const rearW = buildWheel(true);
  const frontW = buildWheel(false);

  const mesh = (geo, mat, name) => {
    const m = new THREE.Mesh(geo, mat);
    m.name = name;
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  };

  // --- static frame group ----------------------------------------------------
  const frameGroup = new THREE.Group();
  frameGroup.name = 'frameGroup';
  const framePaint = mesh(frame.paint, mats.paint, 'frame');
  const frameHw = mesh(frame.hardware, mats.hardware, 'frameHardware');
  const frameRub = mesh(merge([frame.rubber, seat.rubber]), mats.rubber, 'frameRubber');
  const seatHw = mesh(merge([seat.hardware]), mats.hardware, 'seatHardware');
  frameGroup.add(framePaint, frameHw, frameRub, seatHw);
  group.add(frameGroup);

  // --- rear wheel ------------------------------------------------------------
  const rearWheel = new THREE.Group();
  rearWheel.name = 'wheelRear';
  rearWheel.position.copy(PT.rearAxle);
  const rearCore = mesh(rearW.core, mats.hardware, 'rearRim');
  const rearTyre = mesh(rearW.tyre, mats.rubber, 'rearTyre');
  rearWheel.add(rearCore, rearTyre);
  group.add(rearWheel);

  // --- steering assembly -----------------------------------------------------
  const steer = new THREE.Object3D();
  steer.name = 'steer';
  steer.position.copy(PT.htBottom);
  steer.rotation.x = -(Math.PI / 2 - G.headAngle);
  steer.updateMatrix();
  const steerInv = new THREE.Matrix4().copy(steer.matrix).invert();

  const forkGroup = new THREE.Group();
  forkGroup.name = 'fork';
  fork.paint.applyMatrix4(steerInv);
  fork.hardware.applyMatrix4(steerInv);
  forkGroup.add(mesh(fork.paint, mats.paint, 'forkPaint'), mesh(fork.hardware, mats.hardware, 'forkHardware'));
  steer.add(forkGroup);

  const frontWheel = new THREE.Group();
  frontWheel.name = 'wheelFront';
  frontWheel.position.copy(PT.frontAxle).applyMatrix4(steerInv);
  const frontCore = mesh(frontW.core, mats.hardware, 'frontRim');
  const frontTyre = mesh(frontW.tyre, mats.rubber, 'frontTyre');
  frontWheel.add(frontCore, frontTyre);
  steer.add(frontWheel);

  const barPivot = new THREE.Object3D();
  barPivot.name = 'barPivot';
  const barGroup = new THREE.Group();
  barGroup.name = 'bars';
  bars.hardware.applyMatrix4(steerInv);
  bars.rubber.applyMatrix4(steerInv);
  barGroup.add(mesh(bars.hardware, mats.hardware, 'barsHardware'), mesh(bars.rubber, mats.rubber, 'grips'));
  barPivot.add(barGroup);
  steer.add(barPivot);
  group.add(steer);

  // --- cranks ----------------------------------------------------------------
  const crankPivot = new THREE.Object3D();
  crankPivot.name = 'cranks';
  crankPivot.position.copy(PT.bb);
  drive.hardware.translate(-PT.bb.x, -PT.bb.y, -PT.bb.z);
  crankPivot.add(mesh(drive.hardware, mats.hardware, 'crankArms'));

  const pedalPivots = drive.pedals.map((p, i) => {
    const pivot = new THREE.Object3D();
    pivot.name = i === 0 ? 'pedalR' : 'pedalL';
    pivot.position.copy(p.pos).sub(PT.bb);
    p.geo.translate(-p.pos.x, -p.pos.y, -p.pos.z);
    pivot.add(mesh(p.geo, mats.hardware, pivot.name + 'Mesh'));
    crankPivot.add(pivot);
    return pivot;
  });
  group.add(crankPivot);

  // --- chain -----------------------------------------------------------------
  const chainMesh = new THREE.InstancedMesh(drive.chain.geo, mats.hardware, drive.chain.links);
  chainMesh.name = 'chain';
  chainMesh.castShadow = true;
  chainMesh.receiveShadow = true;
  chainMesh.frustumCulled = false;
  chainMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  group.add(chainMesh);

  // chain placement — no allocation after this closure is built
  const cp = drive.chain;
  const _pA = new THREE.Vector3(), _tan = new THREE.Vector3();
  const _nrm = new THREE.Vector3(), _lat = new THREE.Vector3(), _mat = new THREE.Matrix4();
  const sampleAt = (dist, out, tan) => {
    let d = dist % cp.total;
    if (d < 0) d += cp.total;
    let lo = 0, hi = cp.path.length;
    while (lo < hi - 1) {                                     // binary search the arc table
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
      _nrm.set(0, _tan.z, -_tan.y).normalize();               // in-plane normal
      _lat.crossVectors(_tan, _nrm).normalize();
      _mat.makeBasis(_tan, _nrm, _lat).setPosition(_pA);
      if (i % 2) _mat.scale(_v1.set(1, 1, 0.55));
      chainMesh.setMatrixAt(i, _mat);
    }
    chainMesh.instanceMatrix.needsUpdate = true;
  }
  placeChain(0);

  const bike = {
    group,
    frame: frameGroup,
    framePaint,
    steer,
    fork: forkGroup,
    barPivot,
    bars: barGroup,
    grips: barGroup.children[1],
    wheels: [rearWheel, frontWheel],
    wheelRear: rearWheel,
    wheelFront: frontWheel,
    tyres: [rearTyre, frontTyre],
    cranks: crankPivot,
    pedals: pedalPivots,
    pedalR: pedalPivots[0],
    pedalL: pedalPivots[1],
    chain: chainMesh,
    seat: frameRub,
    // anchors the animator can hang IK off (bike local space)
    points: {
      gripL: bars.gripAnchorL.clone(),
      gripR: bars.gripAnchorR.clone(),
      pedalR: drive.pedals[0].pos.clone(),
      pedalL: drive.pedals[1].pos.clone(),
      bb: PT.bb.clone(),
      seat: PT.stTop.clone().addScaledVector(PT.stDir, 0.095),
      headTop: PT.htTop.clone(),
      rearAxle: PT.rearAxle.clone(),
      frontAxle: PT.frontAxle.clone(),
    },
    /** Steering angle in radians about the head-tube axis. */
    setSteer(rad) { steer.rotation.y = rad; },
    /** Barspin angle: the bars turn inside the fork. */
    setBarspin(rad) { barPivot.rotation.y = rad; },
    /**
     * Drive the transmission from one number: crank angle in radians.
     * Rotates the cranks, keeps the pedal platforms level and walks the chain.
     */
    setDrive(crankAngle) {
      crankPivot.rotation.x = crankAngle;
      pedalPivots[0].rotation.x = -crankAngle;
      pedalPivots[1].rotation.x = -crankAngle;
      placeChain(-crankAngle * drive.ringR);
    },
    /**
     * Wheel roll angle. Wheels spin about their local +X, and rolling FORWARD is
     * an INCREASING angle (a point at the top of the tyre travels toward +Z).
     * Distance travelled d metres => rad = d / TUNING.wheelRadius.
     */
    setWheelSpin(rad) {
      rearWheel.rotation.x = rad;
      frontWheel.rotation.x = rad;
    },
  };
  return bike;
}

// ---------------------------------------------------------------------------
// rider: skeleton + skinned body
// ---------------------------------------------------------------------------

const LIMB = { upperArm: 0.300, foreArm: 0.260, thigh: 0.440, shin: 0.430 };

function riderPose(pts) {
  const hips = V(0, 0.940, -0.245);
  const lean = V(0, Math.cos(40 * DEG), Math.sin(40 * DEG));           // torso axis
  const chest = hips.clone().addScaledVector(lean, 0.460);
  const spine = hips.clone().lerp(chest, 0.46);
  const neck = chest.clone().addScaledVector(lean, 0.105).add(V(0, 0.020, -0.020));
  const head = neck.clone().add(V(0, 0.070, 0.012));

  const shoulder = (s) => chest.clone().add(V(s * 0.180, 0.022, 0.004));
  const wristFor = (s) => (s > 0 ? pts.gripR : pts.gripL).clone().add(V(0, 0.012, -0.020));
  const hip = (s) => hips.clone().add(V(s * 0.096, -0.014, 0.012));
  const ankle = (s) => (s > 0 ? pts.pedalR : pts.pedalL).clone().add(V(s * -0.008, 0.074, -0.030));

  const pose = { hips, spine, chest, neck, head, lean };
  for (const [side, s] of [['R', 1], ['L', -1]]) {
    const sh = shoulder(s), wr = wristFor(s);
    const el = ikJoint(sh, wr, LIMB.upperArm, LIMB.foreArm, V(s * 0.86, -0.34, -0.38));
    const hp = hip(s), an = ankle(s);
    const kn = ikJoint(hp, an, LIMB.thigh, LIMB.shin, V(s * 0.30, 0.16, 1.0));
    pose['shoulder' + side] = sh;
    pose['elbow' + side] = el;
    pose['wrist' + side] = wr;
    pose['hip' + side] = hp;
    pose['knee' + side] = kn;
    pose['ankle' + side] = an;
    pose['toe' + side] = an.clone().add(V(s * 0.004, -0.052, 0.150));
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

/**
 * Weight a part across a chain of bones by projecting each vertex onto the chain
 * axis — used for the one-piece torso so hips/spine/chest all deform it.
 */
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

function buildRiderBody(pose, boneIndex) {
  const parts = [];
  const fwd = V(0, 0, 1);
  const limb = (a, b, ra, rb, opts = {}) => {
    const len = a.distanceTo(b);
    const g = capsule2(len, ra, rb, opts);
    return place(g, a, b, opts.front || fwd);
  };
  const push = (geo, bandIdx, skin) => {
    band(geo, bandIdx, RD.N);
    skin(geo);
    parts.push(geo);
  };

  // --- torso: one continuous loft from the shorts to the collar so there are no
  // internal capsule caps bulging through the jersey ---------------------------
  const torsoA = pose.hips.clone().addScaledVector(pose.lean, -0.105);
  const torsoB = pose.neck.clone();
  const torso = limb(torsoA, torsoB, 0.150, 0.082, {
    radial: 16, capSegs: 4, bodyRings: 7, front: pose.lean,
    // waist in, chest out, taper to the collar
    mid: (t) => (t < 0.30 ? lerp(1.02, 0.90, t / 0.30)
      : t < 0.62 ? lerp(0.90, 1.30, smoothstep((t - 0.30) / 0.32))
        : lerp(1.30, 1.02, smoothstep((t - 0.62) / 0.38))),
    shape: (t) => [lerp(1.14, 1.28, smoothstep(clamp(t * 1.5, 0, 1))), lerp(0.88, 0.80, t)],
  });
  push(torso, RD.PRINT, (g) => skinAlong(g, boneIndex, ['hips', 'spine', 'chest', 'neck'],
    [torsoA, pose.spine, pose.chest, torsoB]));

  // neck + head
  push(limb(pose.neck.clone().add(V(0, -0.03, 0)), pose.head.clone().add(V(0, 0.03, 0)), 0.055, 0.050,
    { radial: 10, capSegs: 3 }),
  RD.SKIN, (g) => skinPart(g, boneIndex, 'neck', 'head', pose.neck, pose.head, 0.2, 1.0, 0.85));

  const headC = pose.head.clone().add(V(0, 0.072, 0.012));
  const head = new THREE.SphereGeometry(0.098, 20, 14);
  {
    const p = head.attributes.position;
    const t = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      t.fromBufferAttribute(p, i);
      const r = 0.098;
      let x = t.x * 0.93, y = t.y * 1.05, z = t.z * 1.08;
      const yn = t.y / r, zn = t.z / r;
      if (yn < 0) x *= 1 - 0.30 * yn * yn;                       // jaw taper
      if (yn < -0.25 && zn > 0.1) { y -= 0.012 * (-yn); z += 0.020 * zn * (-yn - 0.25); }  // chin
      if (yn > 0.55) z -= 0.014 * (yn - 0.55);                   // brow / crown
      const nose = Math.max(0, 1 - Math.hypot(t.x / 0.022, (t.y + 0.006) / 0.030));
      if (zn > 0.5) z += nose * 0.020;
      p.setXYZ(i, x, y, z);
    }
    head.computeVertexNormals();
    head.translate(headC.x, headC.y, headC.z);
  }
  push(head, RD.SKIN, (g) => skinPart(g, boneIndex, 'head', null));
  for (const s of [-1, 1]) {
    const ear = new THREE.SphereGeometry(0.026, 8, 6);
    ear.scale(0.42, 1.0, 0.72);
    ear.translate(headC.x + s * 0.090, headC.y - 0.004, headC.z - 0.014);
    push(ear, RD.SKIN, (g) => skinPart(g, boneIndex, 'head', null));
  }
  // hair at the nape, below the helmet
  const hair = new THREE.SphereGeometry(0.072, 10, 8);
  hair.scale(1.05, 0.55, 0.9);
  hair.translate(headC.x, headC.y - 0.052, headC.z - 0.052);
  push(hair, RD.GEAR, (g) => skinPart(g, boneIndex, 'head', null));

  // --- arms --------------------------------------------------------------------
  for (const [side, s] of [['R', 1], ['L', -1]]) {
    const sh = pose['shoulder' + side], el = pose['elbow' + side], wr = pose['wrist' + side];

    // the sleeve starts fat at the shoulder so its cap forms the deltoid — no
    // separate ball on top of the shoulder
    push(limb(sh.clone().addScaledVector(el.clone().sub(sh).normalize(), -0.022), sh.clone().lerp(el, 0.52),
      0.069, 0.051, { radial: 12, capSegs: 4, shape: (t) => [1, lerp(0.92, 1.0, t)] }),
    RD.JERSEY, (g) => skinPart(g, boneIndex, 'shoulder' + side, 'elbow' + side, sh, el, 0.45, 1.0, 0.6));
    push(limb(sh.clone().lerp(el, 0.44), el, 0.047, 0.042, { radial: 10, capSegs: 3 }),
      RD.SKIN, (g) => skinPart(g, boneIndex, 'shoulder' + side, 'elbow' + side, sh, el, 0.5, 0.98, 0.85));
    push(limb(el, wr, 0.045, 0.032, { radial: 10, capSegs: 3, mid: (t) => lerp(1.05, 0.98, t) }),
      RD.SKIN, (g) => skinPart(g, boneIndex, 'elbow' + side, 'wrist' + side, el, wr, 0.55, 1.0, 0.9));

    // glove: palm block wrapping the grip, plus a thumb
    const gripDir = V(s, 0.02, -0.08).normalize();
    const palmA = wr.clone().addScaledVector(gripDir, -0.020);
    const palmB = wr.clone().addScaledVector(gripDir, 0.088);
    push(limb(palmA, palmB, 0.042, 0.037, { radial: 10, capSegs: 3, shape: () => [1.0, 1.18] }),
      RD.GEAR, (g) => skinPart(g, boneIndex, 'wrist' + side, null));
    const thumb = limb(wr.clone().add(V(0, 0.014, 0.026)), wr.clone().add(V(s * 0.036, 0.006, 0.052)), 0.017, 0.014, { radial: 8, capSegs: 3 });
    push(thumb, RD.GEAR, (g) => skinPart(g, boneIndex, 'wrist' + side, null));
    const cuff = limb(wr.clone().addScaledVector(gripDir, -0.056), wr.clone().addScaledVector(gripDir, -0.014), 0.041, 0.045, { radial: 10, capSegs: 2 });
    push(cuff, RD.GEAR, (g) => skinPart(g, boneIndex, 'wrist' + side, null));
  }

  // --- legs --------------------------------------------------------------------
  for (const [side, s] of [['R', 1], ['L', -1]]) {
    const hp = pose['hip' + side], kn = pose['knee' + side], an = pose['ankle' + side], toe = pose['toe' + side];

    push(limb(hp.clone().add(V(0, 0.03, 0)), kn, 0.108, 0.070, { radial: 12, capSegs: 3, mid: (t) => lerp(1.04, 1.0, t) }),
      RD.PANTS, (g) => skinPart(g, boneIndex, 'hip' + side, 'knee' + side, hp, kn, 0.62, 1.0, 0.85));
    push(limb(kn, an, 0.073, 0.050, { radial: 12, capSegs: 3 }),
      RD.KNEE, (g) => skinPart(g, boneIndex, 'knee' + side, 'ankle' + side, kn, an, 0.68, 1.02, 0.8));

    // knee/shin pad
    const padDir = kn.clone().sub(hp).normalize().add(an.clone().sub(kn).normalize()).normalize();
    const out = V(0, 0, 1).cross(padDir).cross(padDir).negate().normalize();
    const padA = kn.clone().addScaledVector(out, 0.048).addScaledVector(padDir, -0.030);
    const padB = kn.clone().addScaledVector(out, 0.040).addScaledVector(padDir, 0.150);
    const pad = limb(padA, padB, 0.058, 0.046, { radial: 10, capSegs: 3, shape: () => [1.0, 0.52] });
    push(pad, RD.GEAR, (g) => skinPart(g, boneIndex, 'knee' + side, 'ankle' + side, kn, an, 0.45, 1.0, 0.7));

    // shoe: upper, then a sole slab under it
    const heel = an.clone().add(V(0, -0.036, -0.058));
    const tip = toe.clone().add(V(0, 0.006, 0.026));
    // front hint points down so u = 0.5 lands on the top of the foot (laces)
    const shoeFront = V(0, -1, 0);
    const shoe = limb(heel, tip, 0.052, 0.042, { radial: 12, capSegs: 3, front: shoeFront, shape: (t) => [lerp(1.0, 0.92, t), lerp(1.0, 0.78, t)] });
    push(shoe, RD.SHOE, (g) => skinPart(g, boneIndex, 'ankle' + side, 'toe' + side, an, toe, 0.55, 1.0, 0.6));
    const soleA = heel.clone().add(V(0, -0.030, 0));
    const soleB = tip.clone().add(V(0, -0.026, 0));
    const sole = limb(soleA, soleB, 0.040, 0.034, { radial: 10, capSegs: 2, front: shoeFront, shape: () => [1.06, 0.42] });
    push(sole, RD.SOLE, (g) => skinPart(g, boneIndex, 'ankle' + side, 'toe' + side, an, toe, 0.55, 1.0, 0.6));
    const ankleCuff = limb(an.clone().add(V(0, -0.030, -0.012)), an.clone().add(V(0, 0.030, -0.004)), 0.056, 0.052, { radial: 10, capSegs: 2 });
    push(ankleCuff, RD.SHOE, (g) => skinPart(g, boneIndex, 'ankle' + side, null));
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
 * Hand-built quad surface. `ref` is the direction the quad should face; the
 * winding is flipped to match, so these parametric shells can never end up
 * inside-out no matter which way the parameters run.
 */
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

function buildHelmet(headC) {
  const R = 0.130, T = 0.015;
  const NU = 48, NV = 14;
  const S = [1.00, 1.06, 1.10];
  const phiMax = (th) => 1.78 - 0.22 * Math.cos(th);
  // vent slots: [theta degrees from front, half width, v0, v1] — mirrored in ±theta
  const slots = [[0, 3.4, 0.10, 0.40], [20, 3.2, 0.26, 0.62], [42, 3.0, 0.30, 0.66],
    [66, 2.8, 0.36, 0.60], [150, 3.4, 0.24, 0.52], [180, 3.6, 0.18, 0.42]];
  const angDiff = (a, b) => {
    let d = Math.abs(a - b) % TAU;
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
        // wall faces away from the cell it belongs to
        const mid = quad[0].clone().add(quad[1]).add(quad[2]).add(quad[3]).multiplyScalar(0.25);
        const cell = P(i + 0.5, j + 0.5, R - T * 0.5);
        walls.add(quad[0], quad[1], quad[2], quad[3], [0.2, 0.2, 0.8, 0.8], mid.sub(cell));
      }
    }
  }

  const parts = [
    band(outer.geometry(), HM.SHELL, HM.N),
    band(inner.geometry(), HM.LINER, HM.N),
    band(walls.geometry(), HM.VENT, HM.N),
  ];

  // peak / visor
  const peak = quadSoup();
  const NP = 18, NL = 3, span = 50 * DEG, len = 0.068;
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
  parts.push(band(peak.geometry(), HM.SHELL, HM.N));

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
  parts.push(band(strap.geometry(), HM.STRAP, HM.N));

  // chin straps + buckle
  const chin = headC.clone().add(V(0, -0.112, 0.014));
  for (const s of [-1, 1]) {
    const a = surfPoint(headC, s * 78 * DEG, phiMax(s * 78 * DEG) * 0.98, R * 0.98, S);
    const m = a.clone().lerp(chin, 0.5).add(V(s * 0.012, 0.006, 0.006));
    const g = sweep([a, m, chin], { radius: 0.0115, radial: 5, steps: 8, oval: () => [1, 0.30] });
    parts.push(band(g, HM.STRAP, HM.N));
  }
  const buckle = new THREE.BoxGeometry(0.022, 0.016, 0.008);
  buckle.translate(chin.x, chin.y, chin.z);
  parts.push(band(buckle, HM.LINER, HM.N));

  return merge(parts);
}

function buildGoggleLens(headC) {
  const soup = quadSoup();
  const NU = 18, NV = 4;
  const S = [0.95, 1.05, 1.08];
  const th0 = -62 * DEG, th1 = 62 * DEG, p0 = 1.14, p1 = 1.56;
  for (let i = 0; i < NU; i++) {
    for (let j = 0; j < NV; j++) {
      const ta = lerp(th0, th1, i / NU), tb = lerp(th0, th1, (i + 1) / NU);
      const pa = lerp(p0, p1, j / NV), pb = lerp(p0, p1, (j + 1) / NV);
      const r = 0.1045, ri = 0.0995;
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
  // frame edge
  for (let i = 0; i < NU; i++) {
    const ta = lerp(th0, th1, i / NU), tb = lerp(th0, th1, (i + 1) / NU);
    for (const [p, sgn] of [[p0, -1], [p1, 1]]) {
      const a = surfPoint(headC, ta, p, 0.1045, S), b = surfPoint(headC, tb, p, 0.1045, S);
      const c = surfPoint(headC, tb, p, 0.0995, S), d = surfPoint(headC, ta, p, 0.0995, S);
      const along = surfPoint(headC, (ta + tb) / 2, p + sgn * 0.05, 0.1045, S)
        .sub(surfPoint(headC, (ta + tb) / 2, p, 0.1045, S));
      soup.add(a, b, c, d, [0, 0, 1, 1], along);
    }
  }
  return soup.geometry();
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

export async function createRider(ctx) {
  const texStart = _textures.length;
  const mats = buildMaterials(ctx?.renderer);
  const rmats = buildRiderMaterials(mats.aniso);

  const group = new THREE.Group();
  group.name = 'rider';

  const bike = buildBike(mats);
  group.add(bike.group);

  // --- skeleton ---------------------------------------------------------------
  const pose = riderPose(bike.points);
  const { bones, boneIndex, byName } = buildSkeleton(pose);
  group.add(bones[0]);
  bones[0].updateMatrixWorld(true);

  const bodyGeo = buildRiderBody(pose, boneIndex);
  const skinned = new THREE.SkinnedMesh(bodyGeo, rmats.rider);
  skinned.name = 'riderBody';
  skinned.castShadow = true;
  skinned.receiveShadow = true;
  skinned.frustumCulled = false;
  group.add(skinned);
  const skeleton = new THREE.Skeleton(bones);
  skinned.bind(skeleton);

  // --- helmet + goggles ride on the head bone ---------------------------------
  const headC = pose.head.clone().add(V(0, 0.072, 0.012));
  const headBone = byName.head;
  headBone.updateMatrixWorld(true);
  const headInv = new THREE.Matrix4().copy(headBone.matrixWorld).invert();

  const helmetGeo = buildHelmet(headC);
  helmetGeo.applyMatrix4(headInv);
  const helmet = new THREE.Mesh(helmetGeo, rmats.helmet);
  helmet.name = 'helmet';
  helmet.castShadow = true;
  helmet.receiveShadow = true;
  headBone.add(helmet);

  const lensGeo = buildGoggleLens(headC);
  lensGeo.applyMatrix4(headInv);
  const lens = new THREE.Mesh(lensGeo, rmats.lens);
  lens.name = 'goggles';
  lens.castShadow = true;
  headBone.add(lens);

  // --- rig handed to riderAnim -------------------------------------------------
  const rig = {
    root: bones[0],
    hips: byName.hips,
    spine: byName.spine,
    chest: byName.chest,
    neck: byName.neck,
    head: byName.head,
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
    bindPose: pose,
  };

  const materials = {
    paint: mats.paint,
    hardware: mats.hardware,
    rubber: mats.rubber,
    rider: rmats.rider,
    helmet: rmats.helmet,
    lens: rmats.lens,
  };

  const owned = _textures.splice(texStart);

  return {
    group,
    bike,
    rig,
    materials,
    helmet,
    goggles: lens,
    /** Optional convenience: the animator may drive these directly instead. */
    setDrive: bike.setDrive,
    setSteer: bike.setSteer,
    setBarspin: bike.setBarspin,
    update() {},
    dispose() {
      group.traverse((o) => {
        if (o.isMesh || o.isSkinnedMesh || o.isInstancedMesh) o.geometry?.dispose();
      });
      for (const m of Object.values(materials)) m.dispose();
      for (const t of owned) t.dispose();
      skeleton.dispose?.();
      group.removeFromParent();
    },
  };
}

