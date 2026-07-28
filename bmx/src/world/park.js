// MIRRA CITY — the skatepark itself.
//
// Everything here is hand-built BufferGeometry in world metres: a quarterpipe is a
// swept circular arc, a bowl is a swept profile along a closed plan curve, the dirt
// line is an analytic height field. Nothing is a rotated box.
//
// Conventions
//   * The park group sits at the origin with an identity transform, so every
//     geometry is baked into world space (`geo.applyMatrix4(m)`). Rail curves and
//     collider meshes are therefore already world-space — no matrix chasing in the
//     physics code.
//   * UVs are authored in METRES to match the material library contract
//     (see the header of materials.js): 1 uv unit == 1 m, each material knows how
//     many metres one tile covers, so texel density lands at ~256 px/m everywhere.
//   * Geometry is accumulated into per-material "buckets" and merged once at the
//     end. One bucket == one draw call == (usually) one collider proxy.
//
// Layout, looking down (+X east, +Z south):
//
//        z=-42 ┌ QP 3.6 ┬ VERT ┐   ┌  HIP  ┐   ┌ QP 2.4 ┐          ← north wall
//        z=-32                                            berm ↰
//        z=-24 │  BOWL (1.8..3.2 m)      │  WALLRIDE │   double 3
//        z=-16                    SPINE              │   double 2
//        z=-06        FUNBOX + RAIL   PLAZA/STAIRS    │  double 1
//        z=+06        FLAT LEDGES      HUBBA/HANDRAIL │
//        z=+16   MINI RAMP        ROLL-IN 3.0 m       │  dirt run-up
//
// Flow: roll-in → main run north → funbox → north transitions → east to the spine
// and wallride → dirt line north → berm → back into the transitions / bowl.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  rng, rand, clamp, lerp, smoothstep, fbm2, seed as reseed,
} from '../core/mathx.js';

const TAU = Math.PI * 2;
const HALF_PI = Math.PI * 0.5;

// --- lot dimensions --------------------------------------------------------
const LOT = { minX: -64, maxX: 64, minZ: -60, maxZ: 60 };
const PAD = { minX: -46, maxX: 28, minZ: -46, maxZ: 32 };   // concrete skatepark slab
const DIRT = { minX: 28, maxX: 58, minZ: -46, maxZ: 32 };   // sculpted trails soil

// --- part radii ------------------------------------------------------------
const COPING_R = 0.0325;   // 65 mm steel coping tube
const RAIL_R = 0.028;      // 56 mm handrail / flat rail
const POOL_R = 0.056;      // pool coping bullnose
const GUARD_R = 0.022;     // deck safety rail

// Transitions are mathematically tangent to the slab, which would put two
// materials within microns of each other for the first 30 cm. Real ramps solve
// it with a steel edge plate; we lift the sheet by its thickness and close the
// gap with a riser, so the joint reads as a crisp line and never z-fights.
const RAMP_LIFT = 0.009;

// ---------------------------------------------------------------------------
// tiny non-indexed surface builder
// ---------------------------------------------------------------------------
// Vertices are flat 8-tuples [x,y,z, nx,ny,nz, u,v]. Triangle winding is derived
// from the supplied normals, so no builder can ever emit a back-facing face.

const V = (x, y, z, nx, ny, nz, u, v) => [x, y, z, nx, ny, nz, u, v];

class Surf {
  constructor() { this.p = []; this.n = []; this.t = []; }

  get empty() { return this.p.length === 0; }

  _push(v) {
    this.p.push(v[0], v[1], v[2]);
    const l = Math.hypot(v[3], v[4], v[5]) || 1;         // callers may blend normals
    this.n.push(v[3] / l, v[4] / l, v[5] / l);
    this.t.push(v[6], v[7]);
  }

  tri(a, b, c) {
    const e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2];
    const e2x = c[0] - a[0], e2y = c[1] - a[1], e2z = c[2] - a[2];
    const gx = e1y * e2z - e1z * e2y;
    const gy = e1z * e2x - e1x * e2z;
    const gz = e1x * e2y - e1y * e2x;
    if (gx * gx + gy * gy + gz * gz < 1e-14) return;            // degenerate
    const nx = a[3] + b[3] + c[3], ny = a[4] + b[4] + c[4], nz = a[5] + b[5] + c[5];
    if (gx * nx + gy * ny + gz * nz >= 0) { this._push(a); this._push(b); this._push(c); }
    else { this._push(a); this._push(c); this._push(b); }
  }

  quad(a, b, c, d) { this.tri(a, b, c); this.tri(a, c, d); }

  /** (nu+1)x(nv+1) samples, fn(i,j) -> vertex tuple. */
  grid(nu, nv, fn) {
    let prev = new Array(nu + 1), cur = new Array(nu + 1);
    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i <= nu; i++) cur[i] = fn(i, j);
      if (j > 0) for (let i = 0; i < nu; i++) this.quad(prev[i], prev[i + 1], cur[i + 1], cur[i]);
      const swap = prev; prev = cur; cur = swap;
    }
  }

  /** Triangle fan from pts[0] — the polygon must be star-shaped about it. */
  fan(pts) {
    for (let i = 1; i + 1 < pts.length; i++) this.tri(pts[0], pts[i], pts[i + 1]);
  }

  geometry(matrix) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.t, 2));
    if (matrix) g.applyMatrix4(matrix);
    return g;
  }
}

/** Reverse triangle winding in place (non-indexed, 8 floats of attributes). */
function reverseWinding(geo) {
  for (const name of ['position', 'normal', 'uv']) {
    const attr = geo.attributes[name];
    if (!attr) continue;
    const a = attr.array, s = attr.itemSize;
    for (let t = 0; t + 3 * s <= a.length; t += 3 * s) {
      for (let k = 0; k < s; k++) {
        const tmp = a[t + s + k]; a[t + s + k] = a[t + 2 * s + k]; a[t + 2 * s + k] = tmp;
      }
    }
    attr.needsUpdate = true;
  }
  return geo;
}

/** Force a horizontal, non-indexed geometry to face +Y. */
function orientUp(geo) {
  const p = geo.attributes.position.array;
  for (let i = 0; i + 9 <= p.length; i += 9) {
    const e1x = p[i + 3] - p[i], e1z = p[i + 5] - p[i + 2];
    const e2x = p[i + 6] - p[i], e2z = p[i + 8] - p[i + 2];
    const ny = e1z * e2x - e1x * e2z;
    if (Math.abs(ny) > 1e-9) { if (ny < 0) reverseWinding(geo); return geo; }
  }
  return geo;
}

/** Strip a geometry down to exactly position/normal/uv, non-indexed, mergeable. */
function mergeable(geo) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  for (const key of Object.keys(g.attributes)) {
    if (key !== 'position' && key !== 'normal' && key !== 'uv') g.deleteAttribute(key);
  }
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.uv) {
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  }
  g.morphAttributes = {};
  g.clearGroups();
  return g;
}

/**
 * Rotate a metre-space UV set about the origin. Texel density is unchanged; the
 * tile grid simply stops lining up with the park's axes, which is what makes a
 * 74 x 78 m slab stop reading as a repeated stamp.
 */
function rotateUV(geo, angle) {
  const uv = geo.attributes.uv;
  const c = Math.cos(angle), s = Math.sin(angle);
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i), v = uv.getY(i);
    uv.setXY(i, u * c - v * s, u * s + v * c);
  }
  uv.needsUpdate = true;
  return geo;
}

/** Box with metre-space, dominant-axis UVs, baked through `matrix`. */
function boxGeo(w, h, d, matrix) {
  const g = mergeable(new THREE.BoxGeometry(w, h, d));
  const pos = g.attributes.position, nrm = g.attributes.normal, uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nrm.getX(i)), ny = Math.abs(nrm.getY(i)), nz = Math.abs(nrm.getZ(i));
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (ny >= nx && ny >= nz) uv.setXY(i, x, z);
    else if (nx >= nz) uv.setXY(i, z, y);
    else uv.setXY(i, x, y);
  }
  if (matrix) g.applyMatrix4(matrix);
  return g;
}

// ---------------------------------------------------------------------------
// swept tube (coping, handrails, guard rails, pool coping)
// ---------------------------------------------------------------------------

const _t = new THREE.Vector3(), _n = new THREE.Vector3(), _b = new THREE.Vector3();

/**
 * Parallel-transported circular sweep. `refUp` fixes the roll of the first frame
 * so the texture's worn band (V = 0.5) lands where tyres and pegs actually ride.
 */
function tubeGeometry(pts, radius, radialSegs = 10, closed = false, refUp = null, caps = false) {
  const n = pts.length;
  if (n < 2) return null;
  const surf = new Surf();

  // tangents
  const tan = [];
  for (let i = 0; i < n; i++) {
    const a = closed ? pts[(i - 1 + n) % n] : pts[Math.max(0, i - 1)];
    const b = closed ? pts[(i + 1) % n] : pts[Math.min(n - 1, i + 1)];
    const t = new THREE.Vector3().subVectors(b, a);
    if (t.lengthSq() < 1e-12) t.set(0, 0, 1);
    tan.push(t.normalize());
  }

  // parallel-transported frames
  const N = [], B = [];
  const up = (refUp ? refUp.clone() : new THREE.Vector3(0, 1, 0)).normalize();
  for (let i = 0; i < n; i++) {
    const t = tan[i];
    const seedVec = i === 0 ? up : N[i - 1];
    _n.copy(seedVec).addScaledVector(t, -seedVec.dot(t));
    if (_n.lengthSq() < 1e-8) {
      _n.set(1, 0, 0).addScaledVector(t, -t.x);
      if (_n.lengthSq() < 1e-8) _n.set(0, 0, 1).addScaledVector(t, -t.z);
    }
    _n.normalize();
    N.push(_n.clone());
    B.push(_b.crossVectors(t, _n).normalize().clone());
  }

  // arc length for U
  const uArr = [0];
  for (let i = 1; i < n; i++) uArr.push(uArr[i - 1] + pts[i].distanceTo(pts[i - 1]));
  if (closed) uArr.push(uArr[n - 1] + pts[0].distanceTo(pts[n - 1]));

  const circ = TAU * radius;
  const segs = closed ? n : n - 1;
  const sample = (i, k) => {
    const idx = i % n;
    const a = (k / radialSegs) * TAU - Math.PI;      // k = radialSegs/2 -> refUp side
    const ca = Math.cos(a), sa = Math.sin(a);
    const nx = N[idx].x * ca + B[idx].x * sa;
    const ny = N[idx].y * ca + B[idx].y * sa;
    const nz = N[idx].z * ca + B[idx].z * sa;
    const p = pts[idx];
    return V(p.x + nx * radius, p.y + ny * radius, p.z + nz * radius,
      nx, ny, nz, uArr[i], (k / radialSegs) * circ);
  };
  surf.grid(segs, radialSegs, (i, k) => sample(i, k));

  if (caps && !closed) {
    for (const end of [0, n - 1]) {
      const t = tan[end];
      const sgn = end === 0 ? -1 : 1;
      const ring = [];
      for (let k = 0; k < radialSegs; k++) {
        const a = (k / radialSegs) * TAU - Math.PI;
        const ca = Math.cos(a), sa = Math.sin(a);
        const p = pts[end];
        ring.push(V(
          p.x + (N[end].x * ca + B[end].x * sa) * radius,
          p.y + (N[end].y * ca + B[end].y * sa) * radius,
          p.z + (N[end].z * ca + B[end].z * sa) * radius,
          t.x * sgn, t.y * sgn, t.z * sgn,
          ca * radius, sa * radius));
      }
      surf.fan(ring);
    }
  }
  return surf.geometry();
}

// ---------------------------------------------------------------------------
// build context — material buckets, rails, decals
// ---------------------------------------------------------------------------

function createBuild(ctx) {
  const M = ctx.materials;

  const copingMat = M.variant('metalCoping', { tile: [0.62, TAU * COPING_R], name: 'park_coping' });
  const railMat = M.variant('railSteel', { tile: [0.86, TAU * RAIL_R], name: 'park_railTube' });
  const guardMat = M.variant('paintedMetal', {
    tile: [0.9, TAU * GUARD_R], color: 0xc8a92c, roughness: 0.9, name: 'park_guard',
  });
  const poolMat = M.variant('concrete', {
    tile: [0.62, TAU * POOL_R], color: 0xd7cfbe, roughness: 0.88, name: 'park_poolCoping',
  });
  // glazed pool tile: the brick grid at 15 cm gives the coursing, a cool glaze tint
  // plus low roughness makes the band read against warm concrete in raking sun
  const tileMat = M.variant('brick', {
    tile: [0.60, 1.20], color: 0x63b4dd, roughness: 0.18, normalScale: 0.45,
    envMapIntensity: 1.6, name: 'park_poolTile',
  });

  // The slab and the lot are the two biggest surfaces in frame; they get extra
  // low-frequency world-space variation so the 4-5 m texture tile stops reading.
  const padMat = M.variant('concrete', {
    macro: { scale: 0.062, colour: 0.24, rough: 0.28, warm: 0.15 }, name: 'park_slab',
  });
  const lotMat = M.variant('asphalt', {
    macro: { scale: 0.048, colour: 0.27, rough: 0.22, warm: 0.11 }, name: 'park_lot',
  });
  const dirtMat = M.variant('dirt', {
    macro: { scale: 0.055, colour: 0.24, rough: 0.20, warm: 0.16 }, name: 'park_soil',
  });

  const defs = [
    // name             material                    cast   recv   collider          uvRotate
    ['ground_pad', padMat, false, true, { type: 'ground', friction: 0.96 }, 0.331],
    ['ground_lot', lotMat, false, true, { type: 'ground', friction: 0.90 }, -0.214],
    ['ground_dirt', dirtMat, true, true, { type: 'ground', friction: 0.78 }, 0.472],
    ['ramp_ride', M.get('skatelite'), true, true, { type: 'ramp', friction: 1.00 }],
    ['ramp_struct', M.get('plywood'), true, true, { type: 'wall', friction: 0.72 }],
    ['park_concrete', M.get('concreteWorn'), true, true, { type: 'ramp', friction: 0.97 }],
    ['pool_tile', tileMat, true, true, { type: 'ramp', friction: 0.92 }],
    ['brick_wall', M.get('brick'), true, true, { type: 'wall', friction: 0.55 }],
    ['coping', copingMat, true, true, { type: 'ramp', friction: 0.55 }],
    ['pool_coping', poolMat, true, true, { type: 'ramp', friction: 0.80 }],
    ['rail_steel', railMat, true, true, { type: 'ramp', friction: 0.45 }],
    ['frame_steel', M.get('railSteel'), true, true, { type: 'wall', friction: 0.50 }],
    ['guard_rail', guardMat, true, true, { type: 'wall', friction: 0.45 }],
  ];

  const buckets = new Map();
  for (const [name, material, cast, recv, collider, uvRotate] of defs) {
    buckets.set(name, { name, material, cast, recv, collider, uvRotate: uvRotate || 0, geos: [] });
  }

  return {
    M, buckets,
    rails: [],
    decals: [],                     // { name, matrix }
    add(bucket, geo) {
      if (!geo) return;
      const b = buckets.get(bucket);
      if (b) b.geos.push(mergeable(geo));
    },
    /** Grind line. `pts` are world-space Vector3 along the exact ride edge. */
    rail(pts, radius, type) {
      if (pts.length < 2) return;
      const curve = pts.length === 2
        ? new THREE.LineCurve3(pts[0], pts[1])
        : new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.5);
      this.rails.push({ curve, radius, type });
    },
    ring(pts, radius, type) {
      this.rails.push({ curve: new THREE.CatmullRomCurve3(pts, true, 'centripetal', 0.5), radius, type });
    },
    decal(name, matrix) { this.decals.push({ name, matrix }); },
  };
}

// ---------------------------------------------------------------------------
// ramp primitives
// ---------------------------------------------------------------------------

/**
 * Local frame of a transition given its lip segment p1 -> p2 (world XZ).
 * The ramp body and deck lie on the side reached by rotating p1->p2 by +90°.
 */
function lipFrame(p1, p2) {
  const dx = p2[0] - p1[0], dz = p2[1] - p1[1];
  const len = Math.hypot(dx, dz) || 1;
  const lx = dx / len, lz = dz / len;
  const kx = lz, kz = -lx;                                    // deck direction
  return {
    len, lx, lz, kx, kz,
    yaw: Math.atan2(kx, kz),
    midX: (p1[0] + p2[0]) * 0.5,
    midZ: (p1[1] + p2[1]) * 0.5,
  };
}

/** World matrix whose origin is the ramp base (local z = 0), +z toward the deck. */
function baseMatrix(f, radius) {
  const bx = f.midX - f.kx * radius, bz = f.midZ - f.kz * radius;
  return new THREE.Matrix4().makeRotationY(f.yaw)
    .premultiply(new THREE.Matrix4().makeTranslation(bx, 0, bz));
}

/** Circular transition profile, base (0,0) → vertical lip (R, R) → vert extension. */
function transitionRows(R, vert) {
  const seg = Math.max(12, Math.round(R * 10));
  const L = RAMP_LIFT;
  const rows = [{ z: 0, y: 0, ny: 0, nz: -1, s: -L }];        // sheet-edge riser
  for (let i = 0; i <= seg; i++) {
    const th = (i / seg) * HALF_PI;
    rows.push({
      z: R * Math.sin(th), y: R * (1 - Math.cos(th)) + L,
      ny: Math.cos(th), nz: -Math.sin(th), s: R * th,
    });
  }
  if (vert > 0) {
    const s0 = R * HALF_PI;
    const vs = Math.max(2, Math.round(vert * 6));
    for (let i = 1; i <= vs; i++) {
      const t = (i / vs) * vert;
      rows.push({ z: R, y: R + t + L, ny: 0, nz: -1, s: s0 + t });
    }
  }
  return rows;
}

/** The riding sheet of a transition, in the local frame. */
function transitionSurface(build, m, W, rows) {
  const s = new Surf();
  const cols = Math.max(2, Math.round(W / 1.8));
  s.grid(cols, rows.length - 1, (i, j) => {
    const x = -W * 0.5 + (i / cols) * W;
    const r = rows[j];
    return V(x, r.y, r.z, 0, r.ny, r.nz, x, r.s);
  });
  build.add('ramp_ride', s.geometry(m));
}

/** Arc-profile end cheek. `sign` = +1 for the local +x end. */
function sidePanel(build, m, W, rows, deckDepth, sign) {
  const R = rows[rows.length - 1].z;
  const H = rows[rows.length - 1].y;
  const x = sign * W * 0.5;
  const nx = sign;
  const pts = [];
  const push = (z, y) => pts.push(V(x, y, z, nx, 0, 0, z, y));
  for (const r of rows) push(r.z, r.y);
  if (deckDepth > 0) { push(R + deckDepth, H); push(R + deckDepth, 0); }
  else push(R, 0);
  const s = new Surf();
  // fan from the trailing bottom corner — the whole profile is visible from it
  const ordered = [pts[pts.length - 1], ...pts.slice(0, pts.length - 1)];
  s.fan(ordered);
  build.add('ramp_struct', s.geometry(m));
}

/** Steel bracing bolted to the back of a ramp, read from behind the structure. */
function backFrame(build, m, W, H, zBack) {
  const posts = Math.max(2, Math.round(W / 2.0));
  const z = zBack + 0.05;
  const postH = H - 0.01;                       // buried 0.03, stops under the deck
  for (let i = 0; i <= posts; i++) {
    const x = -W * 0.5 + (i / posts) * W;
    build.add('frame_steel', boxGeo(0.10, postH, 0.10, new THREE.Matrix4()
      .makeTranslation(x, postH * 0.5 - 0.03, z).premultiply(m)));
  }
  for (const hy of [H * 0.34, H * 0.72]) {
    build.add('frame_steel', boxGeo(W, 0.09, 0.09, new THREE.Matrix4()
      .makeTranslation(0, hy, z).premultiply(m)));
  }
  // sole plate + two diagonals
  build.add('frame_steel', boxGeo(W, 0.14, 0.16, new THREE.Matrix4()
    .makeTranslation(0, 0.05, z).premultiply(m)));
  const diagLen = Math.hypot(W * 0.5, H * 0.72);
  for (const s of [-1, 1]) {
    const mm = new THREE.Matrix4().makeRotationZ(s * Math.atan2(H * 0.72, W * 0.5));
    mm.premultiply(new THREE.Matrix4().makeTranslation(s * W * 0.25, H * 0.36, z + 0.082));
    build.add('frame_steel', boxGeo(diagLen * 0.5 + 0.1, 0.075, 0.075, mm.premultiply(m)));
  }
}

/** Steel coping tube at the lip, plus its grind curve. */
function copingAt(build, m, W, R, H, railType = 'coping') {
  const zc = R - COPING_R * 0.55;
  const yc = H + COPING_R * 0.30;
  const a = new THREE.Vector3(-W * 0.5, yc, zc).applyMatrix4(m);
  const b = new THREE.Vector3(W * 0.5, yc, zc).applyMatrix4(m);
  const up = new THREE.Vector3(0, 1, -1).normalize().transformDirection(m);
  build.add('coping', tubeGeometry([a, b], COPING_R, 12, false, up, true));
  const inset = Math.min(0.14, W * 0.05);
  const dir = new THREE.Vector3().subVectors(b, a).normalize();
  build.rail([
    a.clone().addScaledVector(dir, inset),
    b.clone().addScaledVector(dir, -inset),
  ], COPING_R, railType);
}

/** Painted tube guard rail with posts, following world-space deck-edge points. */
function guardRail(build, pts, deckY, height = 1.04) {
  const top = pts.map((p) => new THREE.Vector3(p.x, deckY + height, p.z));
  build.add('guard_rail', tubeGeometry(top, GUARD_R, 8, false, null, true));
  for (let i = 0; i + 1 < top.length; i++) {
    const segLen = top[i].distanceTo(top[i + 1]);
    const n = Math.max(1, Math.round(segLen / 1.8));
    for (let k = 0; k <= n; k++) {
      if (i > 0 && k === 0) continue;
      const t = k / n;
      const x = lerp(top[i].x, top[i + 1].x, t);
      const z = lerp(top[i].z, top[i + 1].z, t);
      build.add('guard_rail', boxGeo(0.055, height + 0.03, 0.055,
        new THREE.Matrix4().makeTranslation(x, deckY + height * 0.5 - 0.015, z)));
    }
  }
}

/**
 * A full quarterpipe: swept arc riding surface, deck, back wall, cheeks, coping,
 * steel back frame and (optionally) a deck safety rail.
 */
function quarterPipe(build, opts) {
  const {
    p1, p2, radius: R, vert = 0, deck = 6,
    coping = true, guard = false, frame = true,
    panels = { minus: true, plus: true }, railType = 'coping',
  } = opts;
  const f = lipFrame(p1, p2);
  const W = f.len, H = R + vert + RAMP_LIFT;
  const m = baseMatrix(f, R);
  const rows = transitionRows(R, vert);

  transitionSurface(build, m, W, rows);

  if (deck > 0) {
    const d = new Surf();
    d.quad(
      V(-W * 0.5, H, R, 0, 1, 0, -W * 0.5, R),
      V(W * 0.5, H, R, 0, 1, 0, W * 0.5, R),
      V(W * 0.5, H, R + deck, 0, 1, 0, W * 0.5, R + deck),
      V(-W * 0.5, H, R + deck, 0, 1, 0, -W * 0.5, R + deck));
    build.add('ramp_ride', d.geometry(m));

    const back = new Surf();
    const zb = R + deck;
    back.quad(
      V(-W * 0.5, 0, zb, 0, 0, 1, -W * 0.5, 0),
      V(W * 0.5, 0, zb, 0, 0, 1, W * 0.5, 0),
      V(W * 0.5, H, zb, 0, 0, 1, W * 0.5, H),
      V(-W * 0.5, H, zb, 0, 0, 1, -W * 0.5, H));
    build.add('ramp_struct', back.geometry(m));
    if (frame) backFrame(build, m, W, H, zb);
  }

  if (panels.minus) sidePanel(build, m, W, rows, deck, -1);
  if (panels.plus) sidePanel(build, m, W, rows, deck, 1);
  if (coping) copingAt(build, m, W, R, H, railType);

  if (guard && deck > 0) {
    const corner = (lx, lz) => new THREE.Vector3(lx, 0, lz).applyMatrix4(m);
    const inset = 0.16;
    guardRail(build, [
      corner(-W * 0.5 + inset, R + 0.5),
      corner(-W * 0.5 + inset, R + deck - inset),
      corner(W * 0.5 - inset, R + deck - inset),
      corner(W * 0.5 - inset, R + 0.5),
    ], H);
  }
  return { m, W, H, R, frame: f };
}

// ---------------------------------------------------------------------------
// slabs, banks, ledges
// ---------------------------------------------------------------------------

/** Signed plan area (shoelace) of an [x,z] ring. */
function planArea(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a * 0.5;
}

/**
 * Flat-topped slab from a plan polygon plus vertical skirts.
 * `skirt[i]` toggles the wall on edge i (pts[i] -> pts[i+1]).
 */
function polygonSlab(build, opts) {
  const { pts, yTop, yBottom = 0, topBucket = 'park_concrete', sideBucket = 'park_concrete', skirt = null } = opts;
  const top = new Surf();
  top.fan(pts.map((p) => V(p[0], yTop, p[1], 0, 1, 0, p[0], p[1])));
  build.add(topBucket, top.geometry());

  const ccw = planArea(pts) > 0;
  const side = new Surf();
  let run = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) continue;
    if (!skirt || skirt[i]) {
      const s = ccw ? 1 : -1;
      const nx = (dz / len) * s, nz = (-dx / len) * s;
      side.quad(
        V(a[0], yBottom, a[1], nx, 0, nz, run, yBottom),
        V(b[0], yBottom, b[1], nx, 0, nz, run + len, yBottom),
        V(b[0], yTop, b[1], nx, 0, nz, run + len, yTop),
        V(a[0], yTop, a[1], nx, 0, nz, run, yTop));
    }
    run += len;
  }
  if (!side.empty) build.add(sideBucket, side.geometry());
}

/**
 * A flat bank: low edge (a0→a1) to high edge (b0→b1). Adds the two triangular
 * cheeks so the wedge is closed.
 */
function bankRamp(build, opts) {
  const { a0, a1, b0, b1, bucket = 'park_concrete', cheeks = true, cheekBucket = null, lift = RAMP_LIFT } = opts;
  const lo0 = new THREE.Vector3(a0[0], a0[1] + lift, a0[2]);
  const lo1 = new THREE.Vector3(a1[0], a1[1] + lift, a1[2]);
  const hi0 = new THREE.Vector3(b0[0], b0[1], b0[2]);
  const hi1 = new THREE.Vector3(b1[0], b1[1], b1[2]);
  const nrm = new THREE.Vector3().subVectors(lo1, lo0).cross(new THREE.Vector3().subVectors(hi0, lo0)).normalize();
  if (nrm.y < 0) nrm.negate();
  const wid = lo0.distanceTo(lo1);
  const run0 = lo0.distanceTo(hi0), run1 = lo1.distanceTo(hi1);
  const s = new Surf();
  s.quad(
    V(lo0.x, lo0.y, lo0.z, nrm.x, nrm.y, nrm.z, 0, 0),
    V(lo1.x, lo1.y, lo1.z, nrm.x, nrm.y, nrm.z, wid, 0),
    V(hi1.x, hi1.y, hi1.z, nrm.x, nrm.y, nrm.z, wid, run1),
    V(hi0.x, hi0.y, hi0.z, nrm.x, nrm.y, nrm.z, 0, run0));

  // riser closing the lifted leading edge back down to the slab
  if (lift > 0) {
    const e = new THREE.Vector3().subVectors(lo0, hi0).setY(0).normalize();
    s.quad(
      V(lo0.x, lo0.y - lift, lo0.z, e.x, 0, e.z, 0, 0),
      V(lo1.x, lo1.y - lift, lo1.z, e.x, 0, e.z, wid, 0),
      V(lo1.x, lo1.y, lo1.z, e.x, 0, e.z, wid, lift),
      V(lo0.x, lo0.y, lo0.z, e.x, 0, e.z, 0, lift));
  }
  build.add(bucket, s.geometry());

  if (cheeks) {
    const cb = cheekBucket || bucket;
    const c = new Surf();
    for (const [lo, hi, sgn] of [[lo0, hi0, -1], [lo1, hi1, 1]]) {
      const e = new THREE.Vector3().subVectors(lo1, lo0).normalize().multiplyScalar(sgn);
      c.tri(
        V(lo.x, lo.y, lo.z, e.x, 0, e.z, lo.z, lo.y),
        V(hi.x, hi.y, hi.z, e.x, 0, e.z, hi.z, hi.y),
        V(hi.x, Math.min(lo.y, hi.y) - 0.0001, hi.z, e.x, 0, e.z, hi.z, lo.y));
    }
    build.add(cb, c.geometry());
  }
}

/** Rectangular grind ledge with both top edges registered as ledge rails. */
function flatLedge(build, opts) {
  const { x0, z0, x1, z1, width, height, bucket = 'park_concrete', base = 0, rails = true } = opts;
  const dx = x1 - x0, dz = z1 - z0;
  const len = Math.hypot(dx, dz) || 1;
  const ux = dx / len, uz = dz / len;
  const px = uz * width * 0.5, pz = -ux * width * 0.5;
  const pts = [
    [x0 - px, z0 - pz], [x1 - px, z1 - pz], [x1 + px, z1 + pz], [x0 + px, z0 + pz],
  ];
  polygonSlab(build, { pts, yTop: height, yBottom: base, topBucket: bucket, sideBucket: bucket });
  if (rails) {
    for (const s of [-1, 1]) {
      build.rail([
        new THREE.Vector3(x0 + s * px, height, z0 + s * pz),
        new THREE.Vector3(x1 + s * px, height, z1 + s * pz),
      ], 0.055, 'ledge');
    }
  }
}

// ---------------------------------------------------------------------------
// feature: roll-in (convex rollover → straight → concave transition)
// ---------------------------------------------------------------------------

function rollIn(build, opts) {
  const { p1, p2, height: H, deck = 6, slope = 42 * Math.PI / 180, r1 = 1.6, r2 = 2.6 } = opts;
  const f = lipFrame(p1, p2);
  const W = f.len;
  const m = new THREE.Matrix4().makeRotationY(f.yaw)
    .premultiply(new THREE.Matrix4().makeTranslation(f.midX, 0, f.midZ));

  const ca = Math.cos(slope), sa = Math.sin(slope);
  const L = Math.max(0.2, (H - RAMP_LIFT - (r1 + r2) * (1 - ca)) / sa);

  const LF = RAMP_LIFT;
  const rows = [{ z: 0, y: 0, ny: 0, nz: -1, s: -LF }];     // sheet-edge riser
  const seg1 = Math.max(8, Math.round(r2 * 9));
  for (let i = 0; i <= seg1; i++) {                        // concave bottom
    const th = (i / seg1) * slope;
    rows.push({ z: r2 * Math.sin(th), y: r2 * (1 - Math.cos(th)) + LF, ny: Math.cos(th), nz: -Math.sin(th), s: r2 * th });
  }
  const z1 = r2 * sa, y1 = r2 * (1 - ca) + LF, s1 = r2 * slope;
  const segS = Math.max(2, Math.round(L / 0.8));
  for (let i = 1; i <= segS; i++) {                        // straight
    const t = (i / segS) * L;
    rows.push({ z: z1 + t * ca, y: y1 + t * sa, ny: ca, nz: -sa, s: s1 + t });
  }
  const z2 = z1 + L * ca, y2 = y1 + L * sa, s2 = s1 + L;
  const cz = z2 + r1 * sa, cy = y2 - r1 * ca;
  const seg3 = Math.max(6, Math.round(r1 * 8));
  for (let i = 1; i <= seg3; i++) {                        // convex rollover
    const th = slope * (1 - i / seg3);
    rows.push({
      z: cz - r1 * Math.sin(th), y: cy + r1 * Math.cos(th),
      ny: Math.cos(th), nz: -Math.sin(th), s: s2 + r1 * (slope - th),
    });
  }
  const zTop = rows[rows.length - 1].z;

  transitionSurface(build, m, W, rows);

  const d = new Surf();
  d.quad(
    V(-W * 0.5, H, zTop, 0, 1, 0, -W * 0.5, zTop),
    V(W * 0.5, H, zTop, 0, 1, 0, W * 0.5, zTop),
    V(W * 0.5, H, zTop + deck, 0, 1, 0, W * 0.5, zTop + deck),
    V(-W * 0.5, H, zTop + deck, 0, 1, 0, -W * 0.5, zTop + deck));
  build.add('ramp_ride', d.geometry(m));

  const back = new Surf();
  back.quad(
    V(-W * 0.5, 0, zTop + deck, 0, 0, 1, -W * 0.5, 0),
    V(W * 0.5, 0, zTop + deck, 0, 0, 1, W * 0.5, 0),
    V(W * 0.5, H, zTop + deck, 0, 0, 1, W * 0.5, H),
    V(-W * 0.5, H, zTop + deck, 0, 0, 1, -W * 0.5, H));
  build.add('ramp_struct', back.geometry(m));
  backFrame(build, m, W, H, zTop + deck);

  sidePanel(build, m, W, rows, deck, -1);
  sidePanel(build, m, W, rows, deck, 1);

  const corner = (lx, lz) => new THREE.Vector3(lx, 0, lz).applyMatrix4(m);
  guardRail(build, [
    corner(-W * 0.5 + 0.14, zTop + 0.3),
    corner(-W * 0.5 + 0.14, zTop + deck - 0.14),
    corner(W * 0.5 - 0.14, zTop + deck - 0.14),
    corner(W * 0.5 - 0.14, zTop + 0.3),
  ], H);

  return { m, W, H, zTop };
}

// ---------------------------------------------------------------------------
// feature: spine (two transitions back to back)
// ---------------------------------------------------------------------------

function spine(build, opts) {
  const { x0, x1, z, radius: R, split = 0.09 } = opts;
  const H = R + RAMP_LIFT;
  const faces = [
    { p1: [x1, z - split], p2: [x0, z - split] },   // deck side +Z: rider from the north
    { p1: [x0, z + split], p2: [x1, z + split] },   // deck side -Z: rider from the south
  ];
  for (const fc of faces) {
    const f = lipFrame(fc.p1, fc.p2);
    const m = baseMatrix(f, R);
    const rows = transitionRows(R, 0);
    transitionSurface(build, m, f.len, rows);
    sidePanel(build, m, f.len, rows, 0, -1);
    sidePanel(build, m, f.len, rows, 0, 1);
    copingAt(build, m, f.len, R, H);
  }
  // narrow flat cap between the two copings + the two end slivers
  const cap = new Surf();
  cap.quad(
    V(x0, H, z - split, 0, 1, 0, x0, z - split),
    V(x1, H, z - split, 0, 1, 0, x1, z - split),
    V(x1, H, z + split, 0, 1, 0, x1, z + split),
    V(x0, H, z + split, 0, 1, 0, x0, z + split));
  build.add('ramp_ride', cap.geometry());

  const ends = new Surf();
  for (const [x, sgn] of [[x0, -1], [x1, 1]]) {
    ends.quad(
      V(x, 0, z - split, sgn, 0, 0, z - split, 0),
      V(x, 0, z + split, sgn, 0, 0, z + split, 0),
      V(x, H, z + split, sgn, 0, 0, z + split, H),
      V(x, H, z - split, sgn, 0, 0, z - split, H));
  }
  build.add('ramp_struct', ends.geometry());
}

// ---------------------------------------------------------------------------
// feature: hip (two transitions meeting at an outside corner, for transfers)
// ---------------------------------------------------------------------------

function hip(build, opts) {
  const { west, corner, east, radius: R, backZ } = opts;
  const H = R + RAMP_LIFT;
  const faces = [
    { p1: west, p2: corner, outer: 1 },
    { p1: corner, p2: east, outer: -1 },
  ];
  const inner = [];

  for (const fc of faces) {
    const f = lipFrame(fc.p1, fc.p2);
    const m = baseMatrix(f, R);
    const rows = transitionRows(R, 0);
    transitionSurface(build, m, f.len, rows);
    // only the outer cheek is exposed; the corner side is closed by the mitre fill
    sidePanel(build, m, f.len, rows, 0, fc.outer);
    copingAt(build, m, f.len, R, H);

    // sample the inner edge for the mitre
    const edge = [];
    const xin = -fc.outer * f.len * 0.5;
    for (const r of rows) {
      const p = new THREE.Vector3(xin, r.y, r.z).applyMatrix4(m);
      const n = new THREE.Vector3(0, r.ny, r.nz).transformDirection(m);
      edge.push({ p, n, s: r.s });
    }
    inner.push(edge);
  }

  // ruled mitre between the two inner edges (degenerates to a point at the lip)
  const A = inner[0], B = inner[1];
  const fill = new Surf();
  fill.grid(1, A.length - 1, (i, j) => {
    const e = i === 0 ? A[j] : B[j];
    const o = i === 0 ? B[j] : A[j];
    const nx = e.n.x + o.n.x * 0.35, ny = e.n.y + o.n.y * 0.35, nz = e.n.z + o.n.z * 0.35;
    return V(e.p.x, e.p.y, e.p.z, nx, ny, nz, i === 0 ? 0 : e.p.distanceTo(o.p), e.s);
  });
  build.add('ramp_ride', fill.geometry());

  // shared deck: pentagon behind both lips
  const pts = [
    [west[0], backZ], [east[0], backZ], [east[0], east[1]], [corner[0], corner[1]], [west[0], west[1]],
  ];
  polygonSlab(build, {
    pts, yTop: H, yBottom: 0,
    topBucket: 'ramp_ride', sideBucket: 'ramp_struct',
    skirt: [true, true, false, false, true],
  });
  backFrame(build, new THREE.Matrix4().makeRotationY(Math.PI)
    .premultiply(new THREE.Matrix4().makeTranslation((west[0] + east[0]) * 0.5, 0, backZ)),
  east[0] - west[0], H, 0);

  guardRail(build, [
    new THREE.Vector3(west[0] + 0.18, 0, west[1] - 0.4),
    new THREE.Vector3(west[0] + 0.18, 0, backZ + 0.18),
    new THREE.Vector3(east[0] - 0.18, 0, backZ + 0.18),
    new THREE.Vector3(east[0] - 0.18, 0, east[1] - 0.4),
  ], H);
}

// ---------------------------------------------------------------------------
// feature: concrete bowl (swept profile along a closed plan curve)
// ---------------------------------------------------------------------------

function roundedRectRing(cx, cz, hx, hz, corner) {
  const pts = [];
  const c = Math.min(corner, hx * 0.95, hz * 0.95);
  const quads = [
    [cx + hx - c, cz + hz - c, 0],
    [cx - hx + c, cz + hz - c, 1],
    [cx - hx + c, cz - hz + c, 2],
    [cx + hx - c, cz - hz + c, 3],
  ];
  const steps = 5;
  for (const [qx, qz, q] of quads) {
    for (let i = 0; i <= steps; i++) {
      const a = (q * HALF_PI) + (i / steps) * HALF_PI;
      // quadrant 0 spans +x+z, going counter-clockwise in plan
      pts.push(new THREE.Vector3(qx + Math.cos(a) * c * Math.SQRT2 * 0.7071,
        0, qz + Math.sin(a) * c * Math.SQRT2 * 0.7071));
    }
  }
  return pts;
}

function buildBowl(build, opts) {
  const {
    cx, cz, hx, hz, corner = 5.5, samples = 128,
    shallow = 1.8, deep = 3.2, deepDir = [-0.72, -0.7], tileBand = 0.36,
  } = opts;

  const ctrl = roundedRectRing(cx, cz, hx, hz, corner);
  const curve = new THREE.CatmullRomCurve3(ctrl, true, 'centripetal', 0.5);
  const dd = new THREE.Vector2(deepDir[0], deepDir[1]).normalize();

  const rim = [];
  let run = 0;
  for (let i = 0; i <= samples; i++) {
    const t = (i % samples) / samples;
    const p = curve.getPoint(t);
    const tg = curve.getTangent(t);
    const inw = new THREE.Vector2(tg.z, -tg.x);
    if (inw.lengthSq() < 1e-9) inw.set(1, 0);
    inw.normalize();
    if ((cx - p.x) * inw.x + (cz - p.z) * inw.y < 0) inw.negate();
    const rad = new THREE.Vector2(p.x - cx, p.z - cz).normalize();
    const w = smoothstep(clamp(0.5 + 0.5 * rad.dot(dd), 0, 1));
    const D = lerp(shallow, deep, w);
    const R = Math.min(D, 2.25);
    if (i > 0) run += p.distanceTo(rim[i - 1].p);
    rim.push({ p, inw, D, R, u: run });
  }

  // per-sample profile rows: rim, tile-band bottom, then the wall down to the floor
  const ROWS = 12;
  const rowsFor = (D, R) => {
    const total = (D - R) + R * HALF_PI;
    const out = [];
    for (let j = 0; j <= ROWS; j++) {
      const s = j === 0 ? 0 : j === 1 ? Math.min(tileBand, total * 0.5)
        : Math.min(tileBand, total * 0.5) + ((j - 1) / (ROWS - 1)) * (total - Math.min(tileBand, total * 0.5));
      let h, y, nh, ny;
      if (s <= D - R) { h = 0; y = -s; nh = 1; ny = 0; }
      else {
        const phi = clamp((s - (D - R)) / R, 0, HALF_PI);
        h = R * (1 - Math.cos(phi));
        y = -(D - R) - R * Math.sin(phi);
        nh = Math.cos(phi); ny = Math.sin(phi);
      }
      out.push({ s, h, y, nh, ny });
    }
    return out;
  };

  const cache = rim.map((r) => rowsFor(r.D, r.R));
  const vert = (i, j) => {
    const r = rim[i], q = cache[i][j];
    return V(
      r.p.x + r.inw.x * q.h, q.y, r.p.z + r.inw.y * q.h,
      r.inw.x * q.nh, q.ny, r.inw.y * q.nh,
      r.u, q.s);
  };

  const band = new Surf();
  band.grid(samples, 1, (i, j) => vert(i, j));
  build.add('pool_tile', band.geometry());

  const wall = new Surf();
  wall.grid(samples, ROWS - 1, (i, j) => vert(i, j + 1));
  build.add('park_concrete', wall.geometry());

  // floor: rings from the centroid out to the foot of the transition
  const foot = [];
  let deepest = { y: 0, x: cx, z: cz };
  for (let i = 0; i <= samples; i++) {
    const r = rim[i], q = cache[i][ROWS];
    const p = new THREE.Vector3(r.p.x + r.inw.x * q.h, q.y, r.p.z + r.inw.y * q.h);
    foot.push(p);
    if (p.y < deepest.y) deepest = { y: p.y, x: p.x, z: p.z };
  }
  let sy = 0;
  for (let i = 0; i < samples; i++) sy += foot[i].y;
  sy /= samples;
  const centre = new THREE.Vector3(
    lerp(cx, deepest.x, 0.55), Math.min(sy, deepest.y + 0.02) - 0.06, lerp(cz, deepest.z, 0.55));

  const RINGS = 4;
  const floor = new Surf();
  floor.grid(samples, RINGS, (i, j) => {
    const t = smoothstep(j / RINGS);
    const p = foot[i];
    const x = lerp(centre.x, p.x, t), z = lerp(centre.z, p.z, t);
    const y = lerp(centre.y, p.y, smoothstep(j / RINGS));
    return V(x, y, z, 0, 1, 0, x, z);
  });
  build.add('park_concrete', floor.geometry());

  // pool coping bullnose over the rim seam
  const copPts = [];
  for (let i = 0; i < samples; i++) {
    const r = rim[i];
    copPts.push(new THREE.Vector3(r.p.x - r.inw.x * 0.012, 0.016, r.p.z - r.inw.y * 0.012));
  }
  build.add('pool_coping', tubeGeometry(copPts, POOL_R, 12, true, new THREE.Vector3(0, 1, 0)));
  build.ring(copPts.filter((_, i) => i % 2 === 0), POOL_R, 'coping');

  // cast-iron drain grate at the low point
  const grateR = 0.34;
  const disc = new Surf();
  const ring = [];
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * TAU;
    ring.push(V(centre.x + Math.cos(a) * grateR, centre.y + 0.034, centre.z + Math.sin(a) * grateR,
      0, 1, 0, Math.cos(a) * grateR, Math.sin(a) * grateR));
  }
  disc.fan(ring);
  build.add('frame_steel', disc.geometry());
  for (let k = 0; k < 5; k++) {
    const off = (k - 2) * 0.115;
    build.add('frame_steel', boxGeo(0.05, 0.05, grateR * 1.5,
      new THREE.Matrix4().makeTranslation(centre.x + off, centre.y + 0.046, centre.z)));
  }

  return { rim: rim.slice(0, samples).map((r) => r.p), centre };
}

// ---------------------------------------------------------------------------
// feature: stairs, kinked handrail, hubba
// ---------------------------------------------------------------------------

function stairSet(build, opts) {
  const { x0, x1, zTop, yTop, steps, rise, going, landingAfter, landingLen, westCheek = true, eastCheek = true } = opts;
  const nose = [];                      // [z, y] of every step nosing, for rail/hubba
  let z = zTop, y = yTop;
  nose.push([z, y]);
  const s = new Surf();
  const cheeks = new Surf();

  const addRun = (z0, z1, yy) => {
    s.quad(
      V(x0, yy, z0, 0, 1, 0, x0, z0), V(x1, yy, z0, 0, 1, 0, x1, z0),
      V(x1, yy, z1, 0, 1, 0, x1, z1), V(x0, yy, z1, 0, 1, 0, x0, z1));
    if (westCheek) {
      cheeks.quad(
        V(x0, 0, z0, -1, 0, 0, z0, 0), V(x0, 0, z1, -1, 0, 0, z1, 0),
        V(x0, yy, z1, -1, 0, 0, z1, yy), V(x0, yy, z0, -1, 0, 0, z0, yy));
    }
    if (eastCheek) {
      cheeks.quad(
        V(x1, 0, z0, 1, 0, 0, z0, 0), V(x1, 0, z1, 1, 0, 0, z1, 0),
        V(x1, yy, z1, 1, 0, 0, z1, yy), V(x1, yy, z0, 1, 0, 0, z0, yy));
    }
  };
  const addRiser = (zz, yHi, yLo) => {
    s.quad(
      V(x0, yLo, zz, 0, 0, 1, x0, yLo), V(x1, yLo, zz, 0, 0, 1, x1, yLo),
      V(x1, yHi, zz, 0, 0, 1, x1, yHi), V(x0, yHi, zz, 0, 0, 1, x0, yHi));
  };

  for (let k = 1; k <= steps; k++) {
    addRun(z, z + going, y);
    z += going;
    addRiser(z, y, y - rise);
    y -= rise;
    nose.push([z, y]);
    if (k === landingAfter) {
      addRun(z, z + landingLen, y);
      z += landingLen;
      nose.push([z, y]);
    }
  }
  build.add('park_concrete', s.geometry());
  build.add('park_concrete', cheeks.geometry());
  return { nose, zEnd: z, yEnd: y };
}

/**
 * Sloped hubba ledge riding the flank of a stair set. `lift` must exceed the
 * stair rise so the ledge top never dips under a tread and opens a seam.
 */
function hubba(build, opts) {
  const { xIn, xOut, profile, lift = 0.30 } = opts;
  const s = new Surf();
  const nx = Math.sign(xOut - xIn) || 1;
  for (let i = 0; i + 1 < profile.length; i++) {
    const [z0, y0] = profile[i], [z1, y1] = profile[i + 1];
    const t0 = y0 + lift, t1 = y1 + lift;
    const dz = z1 - z0, dy = t1 - t0;
    const l = Math.hypot(dz, dy) || 1;
    const ny = dz / l, nz = -dy / l;
    s.quad(
      V(xIn, t0, z0, 0, ny, nz, xIn, z0), V(xOut, t0, z0, 0, ny, nz, xOut, z0),
      V(xOut, t1, z1, 0, ny, nz, xOut, z1), V(xIn, t1, z1, 0, ny, nz, xIn, z1));
    s.quad(
      V(xOut, 0, z0, nx, 0, 0, z0, 0), V(xOut, 0, z1, nx, 0, 0, z1, 0),
      V(xOut, t1, z1, nx, 0, 0, z1, t1), V(xOut, t0, z0, nx, 0, 0, z0, t0));
    // inner cheek: closes the mass against the stair treads (the stair set
    // deliberately omits its cheek on this flank so the two never overlap)
    s.quad(
      V(xIn, 0, z0, -nx, 0, 0, z0, 0), V(xIn, 0, z1, -nx, 0, 0, z1, 0),
      V(xIn, t1, z1, -nx, 0, 0, z1, t1), V(xIn, t0, z0, -nx, 0, 0, z0, t0));
  }
  const [zA, yA] = profile[0];
  const [zB, yB] = profile[profile.length - 1];
  s.quad(
    V(xIn, 0, zA, 0, 0, -1, xIn, 0), V(xOut, 0, zA, 0, 0, -1, xOut, 0),
    V(xOut, yA + lift, zA, 0, 0, -1, xOut, yA + lift), V(xIn, yA + lift, zA, 0, 0, -1, xIn, yA + lift));
  s.quad(
    V(xIn, 0, zB, 0, 0, 1, xIn, 0), V(xOut, 0, zB, 0, 0, 1, xOut, 0),
    V(xOut, yB + lift, zB, 0, 0, 1, xOut, yB + lift), V(xIn, yB + lift, zB, 0, 0, 1, xIn, yB + lift));
  build.add('park_concrete', s.geometry());
  build.rail(profile.map(([z, y]) => new THREE.Vector3(xOut, y + lift, z)), 0.055, 'ledge');
}

/** Round rail on posts through world-space points. */
function roundRail(build, pts, opts = {}) {
  const { radius = RAIL_R, postEvery = 2.0, groundAt = null, type = 'rail' } = opts;
  build.add('rail_steel', tubeGeometry(pts, radius, 10, false, new THREE.Vector3(0, 1, 0), true));
  build.rail(pts.map((p) => p.clone()), radius, type);
  for (let i = 0; i + 1 < pts.length; i++) {
    const len = pts[i].distanceTo(pts[i + 1]);
    const n = Math.max(1, Math.round(len / postEvery));
    for (let k = 0; k <= n; k++) {
      if (i > 0 && k === 0) continue;
      const t = k / n;
      const x = lerp(pts[i].x, pts[i + 1].x, t);
      const y = lerp(pts[i].y, pts[i + 1].y, t);
      const z = lerp(pts[i].z, pts[i + 1].z, t);
      const base = groundAt ? groundAt(x, z) : 0;
      const h = Math.max(0.1, y - base - radius) + 0.05;      // 5 cm into the slab
      build.add('rail_steel', boxGeo(0.05, h, 0.05,
        new THREE.Matrix4().makeTranslation(x, base + h * 0.5 - 0.05, z)));
      build.add('rail_steel', boxGeo(0.24, 0.05, 0.24,
        new THREE.Matrix4().makeTranslation(x, base + 0.016, z)));
    }
  }
}

// ---------------------------------------------------------------------------
// feature: dirt jump line (one continuous analytic height field)
// ---------------------------------------------------------------------------

function smax(a, b, k) {
  const h = clamp(0.5 + 0.5 * (a - b) / k, 0, 1);
  return lerp(b, a, h) + k * h * (1 - h);
}

function makeDirtField(jumps, berm) {
  const edgeFade = (x, z) => {
    const dx = Math.min(x - DIRT.minX, DIRT.maxX - x);
    const dz = Math.min(z - DIRT.minZ, DIRT.maxZ - z);
    return smoothstep(clamp(Math.min(dx, dz) / 2.5, 0, 1));
  };

  return function height(x, z) {
    let h = 0;

    for (const j of jumps) {
      const across = clamp(1 - Math.max(0, Math.abs(x - j.cx) - j.flat) / (j.halfW - j.flat), 0, 1);
      if (across <= 0) continue;
      const w = smoothstep(across);
      let p = 0;
      if (j.kind === 'lip') {
        // face rises against the rider (from +Z), short steep back on the far side
        if (z >= j.crest && z <= j.crest + j.face) {
          const t = (j.crest + j.face - z) / j.face;
          p = j.h * (1 - Math.cos(t * HALF_PI));
        } else if (z < j.crest && z >= j.crest - j.back) {
          const t = (j.crest - z) / j.back;
          p = j.h * (0.5 + 0.5 * Math.cos(Math.PI * t));
        }
      } else {
        // landing: steep knuckle facing the gap, long smooth down-ramp behind it
        if (z >= j.crest && z <= j.crest + j.face) {
          const t = (j.crest + j.face - z) / j.face;
          p = j.h * (1 - Math.cos(t * HALF_PI));
        } else if (z < j.crest && z >= j.crest - j.back) {
          const t = (j.crest - z) / j.back;
          p = j.h * (1 - 1.5 * t + 0.5 * t * t * t);
        }
      }
      if (p > 0) h = smax(h, p * w, 0.20);
    }

    if (berm) {
      const dx = x - berm.cx, dz = z - berm.cz;
      const rad = Math.hypot(dx, dz);
      let ang = Math.atan2(dz, dx);
      while (ang > Math.PI) ang -= TAU;
      while (ang < -Math.PI) ang += TAU;
      const inSector = smoothstep(clamp((berm.a1 - ang) / 0.34, 0, 1))
        * smoothstep(clamp((ang - berm.a0) / 0.34, 0, 1));
      if (inSector > 0) {
        let p = 0;
        if (rad >= berm.rIn && rad <= berm.rOut) {
          const t = (rad - berm.rIn) / (berm.rOut - berm.rIn);
          p = berm.h * (1 - Math.cos(t * HALF_PI));
        } else if (rad > berm.rOut && rad < berm.rOut + berm.tail) {
          const t = (rad - berm.rOut) / berm.tail;
          p = berm.h * (0.5 + 0.5 * Math.cos(Math.PI * t));
        }
        if (p > 0) h = smax(h, p * inSector, 0.28);
      }
    }

    // rolled soil: gentle swells plus a fine tilled grain, faded at the border
    const fade = edgeFade(x, z);
    const swell = (fbm2(x * 0.045 + 11.3, z * 0.045 - 4.7, 3) - 0.5) * 0.17;
    const grain = (fbm2(x * 0.42 - 2.1, z * 0.42 + 8.9, 2) - 0.5) * 0.05;
    return (h + swell + grain) * fade;
  };
}

function buildDirt(build, field) {
  const nx = Math.round((DIRT.maxX - DIRT.minX) / 0.7);
  const nz = Math.round((DIRT.maxZ - DIRT.minZ) / 0.42);
  const dx = (DIRT.maxX - DIRT.minX) / nx;
  const dz = (DIRT.maxZ - DIRT.minZ) / nz;
  const e = 0.22;
  const s = new Surf();
  s.grid(nx, nz, (i, j) => {
    const x = DIRT.minX + i * dx, z = DIRT.minZ + j * dz;
    const y = field(x, z);
    const gx = (field(x + e, z) - field(x - e, z)) / (2 * e);
    const gz = (field(x, z + e) - field(x, z - e)) / (2 * e);
    const inv = 1 / Math.sqrt(gx * gx + gz * gz + 1);
    return V(x, y, z, -gx * inv, inv, -gz * inv, x, z);
  });
  build.add('ground_dirt', s.geometry());
}

// ---------------------------------------------------------------------------
// ground slabs
// ---------------------------------------------------------------------------

function buildGround(build, bowlRim) {
  // concrete pad, with the bowl cut out of it
  const shape = new THREE.Shape();
  shape.moveTo(PAD.minX, -PAD.maxZ);
  shape.lineTo(PAD.maxX, -PAD.maxZ);
  shape.lineTo(PAD.maxX, -PAD.minZ);
  shape.lineTo(PAD.minX, -PAD.minZ);
  shape.closePath();
  if (bowlRim && bowlRim.length > 3) {
    const hole = new THREE.Path();
    hole.moveTo(bowlRim[0].x, -bowlRim[0].z);
    for (let i = 1; i < bowlRim.length; i++) hole.lineTo(bowlRim[i].x, -bowlRim[i].z);
    hole.closePath();
    shape.holes.push(hole);
  }
  const pad = mergeable(new THREE.ShapeGeometry(shape, 1));
  pad.applyMatrix4(new THREE.Matrix4().makeRotationX(-HALF_PI));
  orientUp(pad);
  build.add('ground_pad', pad);

  // asphalt lot framing the pad and the dirt zone
  const rects = [
    [LOT.minX, LOT.minZ, LOT.maxX, PAD.minZ],
    [LOT.minX, PAD.maxZ, LOT.maxX, LOT.maxZ],
    [LOT.minX, PAD.minZ, PAD.minX, PAD.maxZ],
    [DIRT.maxX, PAD.minZ, LOT.maxX, PAD.maxZ],
  ];
  const lot = new Surf();
  for (const [ax, az, bx, bz] of rects) {
    lot.quad(
      V(ax, 0, az, 0, 1, 0, ax, az), V(bx, 0, az, 0, 1, 0, bx, az),
      V(bx, 0, bz, 0, 1, 0, bx, bz), V(ax, 0, bz, 0, 1, 0, ax, bz));
  }
  build.add('ground_lot', lot.geometry());
}

// ---------------------------------------------------------------------------
// createPark
// ---------------------------------------------------------------------------

export async function createPark(ctx) {
  reseed(0x9a12c7);

  const build = createBuild(ctx);
  const group = new THREE.Group();
  group.name = 'park';

  // === north wall of transitions ==========================================
  const LIP_Z = -35.6;
  const BACK_Z = -42.6;

  quarterPipe(build, {                                   // 3.6 m quarterpipe
    p1: [-21, LIP_Z], p2: [-13, LIP_Z], radius: 3.6, deck: 7, guard: true,
  });
  quarterPipe(build, {                                   // 2.4 m + 1.2 m vert wall
    p1: [-13, LIP_Z], p2: [-7.5, LIP_Z], radius: 2.4, vert: 1.2, deck: 7, guard: true,
    panels: { minus: true, plus: false },
  });
  quarterPipe(build, {                                   // 2.4 m quarterpipe
    p1: [4, LIP_Z], p2: [12, LIP_Z], radius: 2.4, deck: 6, guard: true,
  });
  hip(build, {
    west: [-6, LIP_Z], corner: [-1.75, -32.6], east: [2.5, LIP_Z], radius: 2.4, backZ: -41.6,
  });

  // === bowl ================================================================
  const bowl = buildBowl(build, {
    cx: -30, cz: -14, hx: 12, hz: 10, corner: 5.5,
    shallow: 1.8, deep: 3.2, deepDir: [-0.75, -0.66],
  });

  // === spine ===============================================================
  spine(build, { x0: 6, x1: 18, z: -16, radius: 1.8 });

  // === mini ramp (two facing transitions, 12.4 m of flat between) ==========
  quarterPipe(build, { p1: [-40, 22], p2: [-40, 10], radius: 1.8, deck: 3.0, guard: true });
  quarterPipe(build, { p1: [-24, 10], p2: [-24, 22], radius: 1.8, deck: 3.0, guard: true });

  // === roll-in =============================================================
  const roll = rollIn(build, { p1: [3.5, 18], p2: [-3.5, 18], height: 3.0, deck: 6.2 });

  // === funbox ==============================================================
  const FB = { x0: -4.5, x1: 4.5, zLo: -11, zTopA: -9, zTopB: -3, zHi: -1, h: 0.9 };
  polygonSlab(build, {
    pts: [[FB.x0, FB.zTopA], [FB.x1, FB.zTopA], [FB.x1, FB.zTopB], [FB.x0, FB.zTopB]],
    yTop: FB.h, skirt: [false, true, false, true],
  });
  bankRamp(build, {
    a0: [FB.x0, 0, FB.zHi], a1: [FB.x1, 0, FB.zHi],
    b0: [FB.x0, FB.h, FB.zTopB], b1: [FB.x1, FB.h, FB.zTopB],
  });
  bankRamp(build, {
    a0: [FB.x1, 0, FB.zLo], a1: [FB.x0, 0, FB.zLo],
    b0: [FB.x1, FB.h, FB.zTopA], b1: [FB.x0, FB.h, FB.zTopA],
  });
  for (const sx of [-1, 1]) {
    build.rail([
      new THREE.Vector3(sx * FB.x1, FB.h, FB.zTopA),
      new THREE.Vector3(sx * FB.x1, FB.h, FB.zTopB),
    ], 0.055, 'ledge');
  }
  flatLedge(build, {
    x0: -3.9, z0: FB.zTopA, x1: -3.9, z1: FB.zTopB, width: 0.45, height: 1.26, base: FB.h,
  });
  const fbHeight = (x, z) => {
    if (x < FB.x0 || x > FB.x1) return 0;
    if (z >= FB.zTopA && z <= FB.zTopB) return FB.h;
    if (z > FB.zTopB && z <= FB.zHi) return FB.h * (FB.zHi - z) / (FB.zHi - FB.zTopB) + RAMP_LIFT;
    if (z < FB.zTopA && z >= FB.zLo) return FB.h * (z - FB.zLo) / (FB.zTopA - FB.zLo) + RAMP_LIFT;
    return 0;
  };
  roundRail(build, [
    new THREE.Vector3(2.2, 1.34, FB.zLo + 0.4),
    new THREE.Vector3(2.2, 1.34, FB.zHi - 0.4),
  ], { postEvery: 2.3, groundAt: fbHeight });

  // === plaza deck, stairs, kinked handrail, hubba ==========================
  const PLZ = { x0: 8, x1: 22, z0: -8, z1: 2, h: 1.6 };
  polygonSlab(build, {
    pts: [[PLZ.x0, PLZ.z0], [PLZ.x1, PLZ.z0], [PLZ.x1, PLZ.z1], [PLZ.x0, PLZ.z1]],
    yTop: PLZ.h, skirt: [true, true, true, true],
  });
  build.rail([new THREE.Vector3(PLZ.x0, PLZ.h, PLZ.z0), new THREE.Vector3(PLZ.x0, PLZ.h, PLZ.z1)], 0.055, 'ledge');
  build.rail([new THREE.Vector3(PLZ.x1, PLZ.h, PLZ.z0), new THREE.Vector3(PLZ.x1, PLZ.h, PLZ.z1)], 0.055, 'ledge');
  // bank on to the plaza from the west so the deck is not a dead end
  bankRamp(build, {
    a0: [4.4, 0, -7.6], a1: [4.4, 0, -3.0],
    b0: [PLZ.x0, PLZ.h, -7.6], b1: [PLZ.x0, PLZ.h, -3.0],
  });

  const stairs = stairSet(build, {
    x0: 12, x1: 16.5, zTop: PLZ.z1, yTop: PLZ.h,
    steps: 8, rise: 0.2, going: 0.32, landingAfter: 4, landingLen: 1.0,
    eastCheek: false,
  });
  // the hubba starts on the plaza deck and runs out past the bottom step, so its
  // end caps never land in the plane of the plaza skirt
  hubba(build, {
    xIn: 16.5, xOut: 17.4, lift: 0.30,
    profile: [[PLZ.z1 - 0.6, PLZ.h], ...stairs.nose, [stairs.zEnd + 0.45, stairs.yEnd]],
  });

  const railProfile = stairs.nose.map(([z, y]) => new THREE.Vector3(11.6, y + 0.56, z));
  railProfile.unshift(new THREE.Vector3(11.6, PLZ.h + 0.56, PLZ.z1 - 0.9));
  railProfile.push(new THREE.Vector3(11.6, stairs.yEnd + 0.56, stairs.zEnd + 0.7));
  const stairGround = (x, z) => {
    if (z <= PLZ.z1) return PLZ.h;
    for (let i = 0; i + 1 < stairs.nose.length; i++) {
      if (z >= stairs.nose[i][0] && z <= stairs.nose[i + 1][0]) return stairs.nose[i][1];
    }
    return 0;
  };
  roundRail(build, railProfile, { postEvery: 1.5, groundAt: stairGround });

  // === wallride wall + bank-to-wall =======================================
  const WALL = { x: 24, thick: 0.5, z0: -34, z1: -18, h: 4.2 };
  polygonSlab(build, {
    pts: [[WALL.x, WALL.z0], [WALL.x + WALL.thick, WALL.z0], [WALL.x + WALL.thick, WALL.z1], [WALL.x, WALL.z1]],
    yTop: WALL.h, topBucket: 'brick_wall', sideBucket: 'brick_wall',
  });
  bankRamp(build, {
    a0: [19.6, 0, -32], a1: [19.6, 0, -22],
    b0: [WALL.x, 1.35, -32], b1: [WALL.x, 1.35, -22],
  });
  build.rail([new THREE.Vector3(WALL.x, WALL.h, WALL.z0 + 0.3), new THREE.Vector3(WALL.x, WALL.h, WALL.z1 - 0.3)],
    0.06, 'ledge');

  // === street furniture: flat ledges and a flat rail =======================
  flatLedge(build, { x0: -16, z0: -2, x1: -16, z1: 6, width: 0.6, height: 0.42 });
  flatLedge(build, { x0: -11.5, z0: 12, x1: -5.5, z1: 12, width: 0.6, height: 0.36 });
  roundRail(build, [
    new THREE.Vector3(-9, 0.44, 2), new THREE.Vector3(-9, 0.44, 10),
  ], { postEvery: 2.6 });
  // manual pad by the roll-in run-out
  flatLedge(build, { x0: 8.5, z0: 14, x1: 14.5, z1: 14, width: 2.6, height: 0.22, rails: false });
  build.rail([new THREE.Vector3(8.5, 0.22, 15.3), new THREE.Vector3(14.5, 0.22, 15.3)], 0.05, 'ledge');

  // === dirt jump line ======================================================
  const JUMP_X = 47;
  const jumps = [
    { kind: 'lip', cx: JUMP_X, crest: 21.5, h: 1.5, face: 3.2, back: 1.7, halfW: 3.1, flat: 1.6 },
    { kind: 'land', cx: JUMP_X, crest: 17.7, h: 1.6, face: 1.9, back: 5.2, halfW: 3.2, flat: 1.8 },
    { kind: 'lip', cx: JUMP_X, crest: 6.0, h: 1.8, face: 3.3, back: 1.8, halfW: 3.2, flat: 1.7 },
    { kind: 'land', cx: JUMP_X, crest: 1.9, h: 1.9, face: 2.0, back: 5.6, halfW: 3.3, flat: 1.9 },
    { kind: 'lip', cx: JUMP_X, crest: -10.0, h: 2.1, face: 3.6, back: 1.9, halfW: 3.3, flat: 1.8 },
    { kind: 'land', cx: JUMP_X, crest: -14.4, h: 2.2, face: 2.1, back: 6.1, halfW: 3.4, flat: 2.0 },
  ];
  const berm = { cx: 41, cz: -26, rIn: 3.4, rOut: 8.4, tail: 1.7, h: 1.75, a0: -HALF_PI, a1: 0 };
  const dirtHeight = makeDirtField(jumps, berm);
  buildDirt(build, dirtHeight);

  // === ground =============================================================
  buildGround(build, bowl.rim);

  // === painted lines, stains and graffiti =================================
  const flatDecal = (name, x, z, w, h, rot = 0, y = 0.012) => {
    build.decal(name, new THREE.Matrix4().makeRotationY(rot)
      .multiply(new THREE.Matrix4().makeRotationX(-HALF_PI))
      .multiply(new THREE.Matrix4().makeScale(w, h, 1))
      .premultiply(new THREE.Matrix4().makeTranslation(x, y, z)));
  };
  const wallDecal = (name, x, y, z, w, h, yaw) => {
    build.decal(name, new THREE.Matrix4().makeRotationY(yaw)
      .multiply(new THREE.Matrix4().makeScale(w, h, 1))
      .premultiply(new THREE.Matrix4().makeTranslation(x, y, z)));
  };

  // parking bays and edge paint out on the asphalt
  for (let i = 0; i < 11; i++) flatDecal('laneLine', -52 + i * 2.7, 41, 0.20, 5.2, 0);
  for (let i = 0; i < 8; i++) flatDecal('laneLine', 6 + i * 2.7, 41, 0.20, 5.2, 0);
  for (let i = 0; i < 12; i++) flatDecal('dashYellow', -50 + i * 9, 49.5, 4.2, 0.24, 0);
  for (let i = 0; i < 7; i++) flatDecal('laneLine', -58, -32 + i * 9, 0.20, 8.0, 0);
  for (let i = 0; i < 7; i++) flatDecal('laneLine', 61, -32 + i * 9, 0.20, 8.0, 0);

  // line-of-travel paint on the pad itself
  flatDecal('arrow', 0, 13.5, 2.6, 4.2, 0);
  flatDecal('arrow', 0, -14.5, 2.6, 4.2, 0);
  flatDecal('arrow', 33, 26, 2.6, 4.2, -0.5);
  flatDecal('noSkating', -20.5, 28.5, 3.4, 3.4, 0.12);
  flatDecal('number540', 21, 20, 4.4, 4.4, 0.2);
  flatDecal('stencilDiy', -13, -25, 3.6, 3.6, -0.35);
  flatDecal('splatter', -30, -27.5, 5, 5, 0.4);

  // scattered wear: kept clear of the bowl void and the trails soil
  const openSpot = () => {
    for (let i = 0; i < 24; i++) {
      const x = rand(PAD.minX + 3, PAD.maxX - 3);
      const z = rand(PAD.minZ + 3, PAD.maxZ - 3);
      if (x > -43 && x < -17 && z > -25 && z < -3) continue;      // bowl
      return [x, z];
    }
    return [0, 20];
  };
  for (let i = 0; i < 8; i++) {
    const [x, z] = openSpot();
    flatDecal('skid', x, z, rand(1.6, 3.4), rand(0.7, 1.4), rand(-0.4, 0.4));
  }
  for (let i = 0; i < 6; i++) {
    flatDecal('oilStain', rand(-60, -50), rand(-30, 28), rand(2, 3.6), rand(2, 3.6), rand(0, 3));
  }
  for (let i = 0; i < 6; i++) {
    const [x, z] = openSpot();
    flatDecal('waterStain', x, z, rand(2.4, 4.6), rand(2.4, 4.6), rand(0, 3));
  }
  for (let i = 0; i < 8; i++) {
    const [x, z] = openSpot();
    flatDecal('crack', x, z, rand(2.4, 5), rand(2.4, 5), rand(0, 3));
  }

  // graffiti / sponsor art on the vertical faces the camera actually sees
  wallDecal('sponsor', WALL.x - 0.02, 2.7, -30, 6.2, 2.4, -HALF_PI);
  wallDecal('tagMirra', WALL.x - 0.02, 2.4, -21.5, 5.6, 2.1, -HALF_PI);
  wallDecal('sprayX', WALL.x - 0.02, 3.6, -25.6, 2.0, 2.0, -HALF_PI);
  wallDecal('throwBmx', PLZ.x0 - 0.02, 0.85, -4.0, 5.0, 1.35, -HALF_PI);
  wallDecal('sprayX', PLZ.x1 + 0.02, 0.9, -6.0, 1.3, 1.3, HALF_PI);
  wallDecal('stencilDiy', 4.48, 0.5, -6.0, 1.5, 0.75, HALF_PI);
  wallDecal('sprayX', -40.02, 1.0, 22.02, 1.7, 1.7, 0);              // mini ramp cheek
  wallDecal('throwBmx', -30, 1.0, 22.02, 4.4, 1.8, 0);
  wallDecal('sponsor', 0, 1.7, 18 + roll.zTop + 6.2 + 0.02, 6.0, 2.2, 0);
  wallDecal('tagMirra', -17, 1.9, BACK_Z - 0.02, 6.4, 2.4, Math.PI);  // ramp backs
  wallDecal('throwBmx', 8, 1.5, -41.62, 5.0, 2.0, Math.PI);

  // === assemble ===========================================================
  const colliders = [];
  const disposables = [];

  for (const b of build.buckets.values()) {
    if (!b.geos.length) continue;
    const geo = b.geos.length === 1 ? b.geos[0] : mergeGeometries(b.geos, false);
    if (!geo) continue;
    if (b.geos.length > 1) for (const g of b.geos) g.dispose();
    if (b.uvRotate) rotateUV(geo, b.uvRotate);
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    const mesh = new THREE.Mesh(geo, b.material);
    mesh.name = `park_${b.name}`;
    mesh.castShadow = b.cast;
    mesh.receiveShadow = b.recv;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    group.add(mesh);
    disposables.push(geo);
    if (b.collider) colliders.push({ mesh, type: b.collider.type, friction: b.collider.friction });
  }

  // decals: one merged mesh per atlas cell so the whole set costs a handful of calls
  const byCell = new Map();
  for (const d of build.decals) {
    if (!byCell.has(d.name)) byCell.set(d.name, []);
    const quad = mergeable(new THREE.PlaneGeometry(1, 1));
    quad.applyMatrix4(d.matrix);
    byCell.get(d.name).push(quad);
  }
  const decalGroup = new THREE.Group();
  decalGroup.name = 'park_decals';
  for (const [name, geos] of byCell) {
    const geo = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
    if (!geo) continue;
    if (geos.length > 1) for (const g of geos) g.dispose();
    const mesh = new THREE.Mesh(geo, build.M.decalMaterial(name, { roughness: 0.86 }));
    mesh.name = `decal_${name}`;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = 2;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    decalGroup.add(mesh);
    disposables.push(geo);
  }
  group.add(decalGroup);

  // === set dressing (owned by props.js — never allowed to break the park) ==
  let props = null;
  try {
    const mod = await import('./props.js');
    if (mod && typeof mod.createProps === 'function') {
      props = await mod.createProps(ctx, {
        bounds: new THREE.Box3(
          new THREE.Vector3(LOT.minX, 0, LOT.minZ),
          new THREE.Vector3(LOT.maxX, 0, LOT.maxZ)),
        pad: { ...PAD },
        dirt: { ...DIRT },
      });
      if (props?.group) group.add(props.group);
      if (Array.isArray(props?.colliders)) {
        for (const c of props.colliders) if (c?.mesh) colliders.push(c);
      }
      if (Array.isArray(props?.rails)) {
        for (const r of props.rails) if (r?.curve) build.rails.push(r);
      }
    }
  } catch (err) {
    console.warn('[park] props module unavailable:', err?.message || err);
  }

  // === spawns =============================================================
  // yaw convention matches bikePhysics/camera: forward = (sin y, 0, cos y).
  const S = Math.PI;
  const spawnPoints = [
    { name: 'roll-in', position: new THREE.Vector3(0, 3.05, 25.4), yaw: S },
    { name: 'main run', position: new THREE.Vector3(0, 0.05, 13.5), yaw: S },
    { name: 'bowl deck', position: new THREE.Vector3(-30, 0.05, 1.5), yaw: S },
    { name: 'dirt line', position: new THREE.Vector3(JUMP_X, 0.05, 28.5), yaw: S },
    { name: 'mini ramp deck', position: new THREE.Vector3(-41.8, 1.85, 16), yaw: HALF_PI },
    { name: 'north flat', position: new THREE.Vector3(-2, 0.05, -26), yaw: S },
    { name: 'plaza', position: new THREE.Vector3(15, 1.65, -5), yaw: S },
  ];

  const bounds = new THREE.Box3(
    new THREE.Vector3(LOT.minX, -4.0, LOT.minZ),
    new THREE.Vector3(LOT.maxX, 26.0, LOT.maxZ));

  group.updateMatrixWorld(true);
  reseed(0x5eed1e);        // hand the deterministic stream back to main.js

  let tris = 0, drawCalls = 0;
  group.traverse((o) => {
    if (!o.isMesh) return;
    drawCalls++;
    const pos = o.geometry.attributes.position;
    tris += (o.geometry.index ? o.geometry.index.count : pos.count) / 3;
  });
  console.info(`[park] ${drawCalls} draw calls, ${Math.round(tris / 1000)}k tris, `
    + `${colliders.length} colliders, ${build.rails.length} rails, ${spawnPoints.length} spawns`);

  return {
    group,
    colliders,
    rails: build.rails,
    spawnPoints,
    bounds,
    dirtHeight,
    update(dt, c) { props?.update?.(dt, c); },
    dispose() {
      props?.dispose?.();
      for (const g of disposables) g.dispose();
      group.clear();
    },
  };
}

export default createPark;
