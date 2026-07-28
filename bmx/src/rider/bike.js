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
function rod(a, b, r0, r1 = r0, radial = 8, caps = true) {
  const mid = a.clone().lerp(b, 0.5);
  return sweep([a, mid, b], { radius: 1, radial, steps: 4, caps, taper: (t) => lerp(r0, r1, t) });
}

/** Capsule with independent end radii and a cross-section scale profile. */
function capsule2(len, ra, rb, opts = {}) {
  const { radial = 12, capSegs = 4, shape = null, mid = null } = opts;
  const rings = [];
  for (let i = 0; i <= capSegs; i++) {                       // bottom cap
    const a = (i / capSegs) * (Math.PI / 2);
    rings.push([Math.sin(a) * ra, -Math.cos(a) * ra]);
  }
  for (let i = 1; i <= 3; i++) {
    const t = i / 4;
    rings.push([lerp(ra, rb, t) * (mid ? mid(t) : 1), len * t]);
  }
  for (let i = 0; i <= capSegs; i++) {                       // top cap
    const a = (i / capSegs) * (Math.PI / 2);
    rings.push([Math.cos(a) * rb, len + Math.sin(a) * rb]);
  }
  const pos = [], nor = [], uvs = [], idx = [];
  const nv = new THREE.Vector3();
  const total = len + ra + rb;
  for (let i = 0; i < rings.length; i++) {
    const [r, y] = rings[i];
    const t = clamp(y / len, 0, 1);
    const sc = shape ? shape(t) : [1, 1];
    const prev = rings[Math.max(0, i - 1)], next = rings[Math.min(rings.length - 1, i + 1)];
    const dr = next[0] - prev[0], dy = next[1] - prev[1];
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * TAU;
      const sx = Math.sin(a), cz = Math.cos(a);
      pos.push(sx * r * sc[0], y, cz * r * sc[1]);
      nv.set(sx * dy / sc[0], -dr, cz * dy / sc[1]).normalize();
      nor.push(nv.x, nv.y, nv.z);
      uvs.push(j / radial, clamp((y + ra) / total, 0, 1));
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
  const geo = new THREE.TorusGeometry(r, thick, 6, 18);
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
  const per = 10, s = new THREE.Shape();
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

/** Run `fn` in the local coordinate frame of atlas band `i` of `n`. */
function inBand(g, w, h, i, n, fn) {
  const bh = h / n;
  g.save();
  g.beginPath(); g.rect(0, i * bh, w, bh); g.clip();
  g.translate(0, i * bh);
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
      inBand(g, w, h, PAINT.PLAIN, PAINT.N, (c, bw, bh) => paintBase(c, bw, bh, '#15616c', 'rgba(2,20,24,0.55)'));
      inBand(g, w, h, PAINT.DARK, PAINT.N, (c, bw, bh) => {
        paintBase(c, bw, bh, '#0e454e', 'rgba(0,12,15,0.6)');
        scratches(c, bw, bh, 120, '#9fb6b9', 10, 60, 0.9);
      });
      inBand(g, w, h, PAINT.DECAL, PAINT.N, (c, bw, bh) => {
        paintBase(c, bw, bh, '#15616c', 'rgba(2,20,24,0.55)');
        text(c, 'VOLTA', bw * 0.5, bh * 0.5, bh * 0.62, '#f4ecdb', { skew: -0.22, spacing: bh * 0.03 });
        text(c, 'HEAT TREATED CHROMOLY', bw * 0.5, bh * 0.82, bh * 0.11, 'rgba(244,236,219,0.75)', { font: '700', family: 'sans-serif', spacing: bh * 0.02 });
      });
      inBand(g, w, h, PAINT.SCRIPT, PAINT.N, (c, bw, bh) => {
        paintBase(c, bw, bh, '#15616c', 'rgba(2,20,24,0.55)');
        c.fillStyle = '#e8552f'; c.globalAlpha = 0.9;
        c.fillRect(0, bh * 0.06, bw, bh * 0.055);
        c.fillRect(0, bh * 0.885, bw, bh * 0.055);
        c.globalAlpha = 1;
        text(c, 'MIRRA CITY', bw * 0.5, bh * 0.47, bh * 0.42, '#f4ecdb', { skew: -0.18, spacing: bh * 0.05 });
      });
    },
    height(g, w, h) {
      fill(g, w, h, '#808080');
      overlayGrain(g, w, h, 0.5, 4);      // orange peel
      scratches(g, w, h, 70, '#4a4a4a', 6, 50, 0.8);
      inBand(g, w, h, PAINT.DECAL, PAINT.N, (c, bw, bh) => {
        text(c, 'VOLTA', bw * 0.5, bh * 0.5, bh * 0.62, '#9a9a9a', { skew: -0.22, spacing: bh * 0.03 });
      });
      inBand(g, w, h, PAINT.SCRIPT, PAINT.N, (c, bw, bh) => {
        text(c, 'MIRRA CITY', bw * 0.5, bh * 0.47, bh * 0.42, '#9a9a9a', { skew: -0.18, spacing: bh * 0.05 });
      });
    },
    rough(g, w, h) {
      fill(g, w, h, '#3c3c3c');
      overlayGrain(g, w, h, 0.35, 3);
      scratches(g, w, h, 110, '#8e8e8e', 8, 90, 0.9);
      chips(g, w, h, 30, '#b0b0b0', 1, 3);
      inBand(g, w, h, PAINT.DARK, PAINT.N, (c, bw, bh) => {
        c.fillStyle = 'rgba(255,255,255,0.16)'; c.fillRect(0, 0, bw, bh);
      });
    },
  }, { normalStrength: 1.1 });

  const paint = new THREE.MeshPhysicalMaterial({
    ...paintMaps,
    color: 0xffffff,
    metalness: 0.42,
    roughness: 1.0,
    clearcoat: 0.8,
    clearcoatRoughness: 0.14,
    normalScale: new THREE.Vector2(0.5, 0.5),
    envMapIntensity: 1.0,
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
      overlayGrain(g, w, h, 0.35, 4);
      scratches(g, w, h, 220, '#5a5a5a', 6, 80, 0.8);
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
  }, { normalStrength: 1.4 });

  const hardware = new THREE.MeshStandardMaterial({
    ...hwMaps,
    color: 0xffffff,
    metalness: 1.0,
    roughness: 1.0,
    normalScale: new THREE.Vector2(0.65, 0.65),
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
  }, { normalStrength: 2.6 });

  const rubber = new THREE.MeshStandardMaterial({
    ...rubberMaps,
    color: 0xffffff,
    metalness: 0.0,
    roughness: 1.0,
    normalScale: new THREE.Vector2(1.0, 1.0),
    envMapIntensity: 0.85,
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
  const folds = (c, bw, bh, n, css, alpha) => {
    c.save(); c.globalAlpha = alpha; c.strokeStyle = css; c.lineCap = 'round';
    for (let i = 0; i < n; i++) {
      const y = rand(0, bh);
      c.lineWidth = rand(2, 9);
      c.beginPath();
      c.moveTo(-10, y);
      c.bezierCurveTo(bw * 0.3, y + rand(-14, 14), bw * 0.7, y + rand(-14, 14), bw + 10, y + rand(-10, 10));
      c.stroke();
    }
    c.restore();
  };

  const maps = mapSet(aniso, 1024, 2048, {
    color(g, w, h) {
      inBand(g, w, h, RD.SKIN, RD.N, (c, bw, bh) => {
        fill(c, bw, bh, '#b3805a');
        overlayGrain(c, bw, bh, 0.16, 4);
        chips(c, bw, bh, 60, '#8f5f42', 0.6, 2.2);
        chips(c, bw, bh, 30, '#c9a081', 0.8, 3.0);
        const sh = c.createLinearGradient(0, 0, 0, bh);
        sh.addColorStop(0, 'rgba(120,60,40,0.22)');
        sh.addColorStop(0.5, 'rgba(0,0,0,0)');
        sh.addColorStop(1, 'rgba(120,60,40,0.22)');
        c.fillStyle = sh; c.fillRect(0, 0, bw, bh);
      });
      inBand(g, w, h, RD.JERSEY, RD.N, (c, bw, bh) => {
        fill(c, bw, bh, '#b93f2a');
        weave(c, bw, bh, 0.05);
        overlayGrain(c, bw, bh, 0.12, 3);
        c.fillStyle = '#f0e6d2';
        c.fillRect(0, bh * 0.06, bw, bh * 0.035);
        c.fillRect(0, bh * 0.93, bw, bh * 0.045);
        c.fillStyle = '#1d1f24';
        c.fillRect(0, bh * 0.10, bw, bh * 0.02);
        folds(c, bw, bh, 14, 'rgba(60,12,6,0.30)', 0.5);
      });
      inBand(g, w, h, RD.PRINT, RD.N, (c, bw, bh) => {
        fill(c, bw, bh, '#b93f2a');
        weave(c, bw, bh, 0.05);
        // back print sits at u = 0.5, which faces -Z (the chase camera)
        text(c, 'VOLTA', bw * 0.5, bh * 0.42, bh * 0.34, '#f2e8d4', { skew: -0.16, spacing: bh * 0.02 });
        text(c, 'SKATEPARK CO', bw * 0.5, bh * 0.63, bh * 0.10, '#f2e8d4', { font: '700', family: 'sans-serif', spacing: bh * 0.02, alpha: 0.9 });
        text(c, '13', bw * 0.5, bh * 0.82, bh * 0.16, '#1d1f24', { spacing: bh * 0.01 });
        c.fillStyle = '#1d1f24'; c.fillRect(bw * 0.5 - bw * 0.16, bh * 0.71, bw * 0.32, bh * 0.012);
        folds(c, bw, bh, 10, 'rgba(60,12,6,0.28)', 0.45);
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
        text(c, 'VOLTA', bw * 0.5, bh * 0.42, bh * 0.34, '#a8a8a8', { skew: -0.16, spacing: bh * 0.02 });
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
      inBand(g, w, h, RD.SKIN, RD.N, (c, bw, bh) => { fill(c, bw, bh, '#8e8e8e'); overlayGrain(c, bw, bh, 0.3, 5); });
      inBand(g, w, h, RD.JERSEY, RD.N, (c, bw, bh) => { fill(c, bw, bh, '#d6d6d6'); overlayGrain(c, bw, bh, 0.25, 4); });
      inBand(g, w, h, RD.PRINT, RD.N, (c, bw, bh) => {
        fill(c, bw, bh, '#d6d6d6');
        text(c, 'VOLTA', bw * 0.5, bh * 0.42, bh * 0.34, '#8a8a8a', { skew: -0.16, spacing: bh * 0.02 });
      });
      inBand(g, w, h, RD.PANTS, RD.N, (c, bw, bh) => { fill(c, bw, bh, '#cfcfcf'); overlayGrain(c, bw, bh, 0.3, 4); });
      inBand(g, w, h, RD.KNEE, RD.N, (c, bw, bh) => fill(c, bw, bh, '#c8c8c8'));
      inBand(g, w, h, RD.SHOE, RD.N, (c, bw, bh) => { fill(c, bw, bh, '#bcbcbc'); overlayGrain(c, bw, bh, 0.3, 4); });
      inBand(g, w, h, RD.SOLE, RD.N, (c, bw, bh) => fill(c, bw, bh, '#a2a2a2'));
      inBand(g, w, h, RD.GEAR, RD.N, (c, bw, bh) => { fill(c, bw, bh, '#7e7e7e'); overlayGrain(c, bw, bh, 0.35, 5); });
    },
  }, { normalStrength: 2.2 });

  const rider = new THREE.MeshStandardMaterial({
    ...maps,
    color: 0xffffff,
    metalness: 0.0,
    roughness: 1.0,
    normalScale: new THREE.Vector2(0.9, 0.9),
    envMapIntensity: 0.9,
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
        c.fillRect(bw * 0.06, 0, bw * 0.035, bh);
        c.fillRect(bw * 0.56, 0, bw * 0.035, bh);
        c.fillStyle = '#e8552f';
        c.fillRect(bw * 0.10, 0, bw * 0.016, bh);
        c.fillRect(bw * 0.60, 0, bw * 0.016, bh);
        text(c, 'GRIT', bw * 0.30, bh * 0.52, bh * 0.42, '#f2ecdc', { skew: -0.2, spacing: 4 });
        text(c, 'GRIT', bw * 0.80, bh * 0.52, bh * 0.42, '#f2ecdc', { skew: -0.2, spacing: 4 });
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
  }, { normalStrength: 1.8 });

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
    color: 0x4a3524,
    metalness: 1.0,
    roughness: 0.06,
    clearcoat: 1.0,
    clearcoatRoughness: 0.04,
    envMapIntensity: 1.4,
  });
  lens.name = 'riderLens';

  return { rider, helmet, lens };
}

// __APPEND__
