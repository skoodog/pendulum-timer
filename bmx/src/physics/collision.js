// Collision queries for the park: a flat triangle soup in a uniform spatial hash,
// plus an arc-length polyline cache for every grind rail.
//
// Everything the bike physics touches at 120 Hz goes through here, so the whole
// module is written against flat typed arrays: no Vector3 churn, no closures
// created per query, no garbage. Results come out of small rotating pools —
// see the note on `raycastDown`.
//
// Build cost is paid once, in createCollision(). Queries are:
//   raycastDown(origin, maxDist)         wheel contacts, camera floor clamp
//   raycast(origin, dir, maxDist)        wallrides, camera occlusion, probes
//   sweepSphere(from, to, radius)        wall / ledge push-out
//   nearestRail(point, maxDist, vel)     grind acquisition
//   railPointAt(rail, t) / railTangentAt(rail, t)

import * as THREE from 'three';
import { clamp } from '../core/mathx.js';

// ---------------------------------------------------------------------------
// tuning
// ---------------------------------------------------------------------------

const CELL_SIZE = 2.0;             // metres — one grid cell
const MAX_CELLS = 1 << 21;         // hard cap on lattice size; cell grows if exceeded
const MAX_CELLS_PER_TRI = 8192;    // beyond this a triangle joins the always-tested list
const RAIL_STEP = 0.25;            // rail polyline sample spacing, metres
const RAIL_ANGLE_COS = Math.cos(50 * Math.PI / 180);  // grind entry cone, either sign
const RAY_EPS = 1e-6;              // parallel / self-hit rejection
const DEGENERATE_AREA2 = 1e-12;    // squared area below which a triangle is dropped
const RESULT_POOL = 8;             // rotating query results (see raycastDown docs)

// ---------------------------------------------------------------------------
// small scalar geometry helpers — all write into caller-supplied {x,y,z} bags
// ---------------------------------------------------------------------------

/**
 * Closest point on triangle abc to p (Ericson, Real-Time Collision Detection).
 * Returns true when that point lies in the face interior rather than on an
 * edge or vertex — sweepSphere needs to know, because only a face contact can
 * be disambiguated by the face normal.
 */
function closestPtPointTriangle(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz, out) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;

  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) { out.x = ax; out.y = ay; out.z = az; return false; }

  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) { out.x = bx; out.y = by; out.z = bz; return false; }

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    out.x = ax + abx * v; out.y = ay + aby * v; out.z = az + abz * v; return false;
  }

  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) { out.x = cx; out.y = cy; out.z = cz; return false; }

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    out.x = ax + acx * w; out.y = ay + acy * w; out.z = az + acz * w; return false;
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    out.x = bx + (cx - bx) * w; out.y = by + (cy - by) * w; out.z = bz + (cz - bz) * w; return false;
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  out.x = ax + abx * v + acx * w;
  out.y = ay + aby * v + acy * w;
  out.z = az + abz * v + acz * w;
  return true;
}

/** Closest points between segments p1q1 and p2q2. Returns the squared distance. */
function closestPtSegSeg(
  p1x, p1y, p1z, q1x, q1y, q1z,
  p2x, p2y, p2z, q2x, q2y, q2z, outA, outB,
) {
  const d1x = q1x - p1x, d1y = q1y - p1y, d1z = q1z - p1z;
  const d2x = q2x - p2x, d2y = q2y - p2y, d2z = q2z - p2z;
  const rx = p1x - p2x, ry = p1y - p2y, rz = p1z - p2z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  let s = 0, t = 0;
  const E = 1e-12;

  if (a <= E && e <= E) { s = 0; t = 0; }
  else if (a <= E) { s = 0; t = clamp(f / e, 0, 1); }
  else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= E) { t = 0; s = clamp(-c / a, 0, 1); }
    else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const denom = a * e - b * b;
      s = denom > E ? clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); }
      else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
    }
  }
  outA.x = p1x + d1x * s; outA.y = p1y + d1y * s; outA.z = p1z + d1z * s;
  outB.x = p2x + d2x * t; outB.y = p2y + d2y * t; outB.z = p2z + d2z * t;
  const dx = outA.x - outB.x, dy = outA.y - outB.y, dz = outA.z - outB.z;
  return dx * dx + dy * dy + dz * dz;
}

/** Akenine-Moller triangle / axis-aligned-box overlap, box given by centre + half extents. */
function triBoxOverlap(cx, cy, cz, hx, hy, hz,
  ax, ay, az, bx, by, bz, gx, gy, gz) {
  // triangle vertices relative to the box centre
  const v0x = ax - cx, v0y = ay - cy, v0z = az - cz;
  const v1x = bx - cx, v1y = by - cy, v1z = bz - cz;
  const v2x = gx - cx, v2y = gy - cy, v2z = gz - cz;

  // 1) box axes
  if (Math.min(v0x, v1x, v2x) > hx || Math.max(v0x, v1x, v2x) < -hx) return false;
  if (Math.min(v0y, v1y, v2y) > hy || Math.max(v0y, v1y, v2y) < -hy) return false;
  if (Math.min(v0z, v1z, v2z) > hz || Math.max(v0z, v1z, v2z) < -hz) return false;

  const e0x = v1x - v0x, e0y = v1y - v0y, e0z = v1z - v0z;
  const e1x = v2x - v1x, e1y = v2y - v1y, e1z = v2z - v1z;
  const e2x = v0x - v2x, e2y = v0y - v2y, e2z = v0z - v2z;

  // 2) triangle plane vs box
  const nx = e0y * e1z - e0z * e1y;
  const ny = e0z * e1x - e0x * e1z;
  const nz = e0x * e1y - e0y * e1x;
  const d = nx * v0x + ny * v0y + nz * v0z;
  const r = hx * Math.abs(nx) + hy * Math.abs(ny) + hz * Math.abs(nz);
  if (Math.abs(d) > r) return false;

  // 3) nine edge cross-product axes
  return axisTest(e0x, e0y, e0z, v0x, v0y, v0z, v1x, v1y, v1z, v2x, v2y, v2z, hx, hy, hz)
    && axisTest(e1x, e1y, e1z, v0x, v0y, v0z, v1x, v1y, v1z, v2x, v2y, v2z, hx, hy, hz)
    && axisTest(e2x, e2y, e2z, v0x, v0y, v0z, v1x, v1y, v1z, v2x, v2y, v2z, hx, hy, hz);
}

/** Separating-axis test for the three axis x edge combinations of one triangle edge. */
function axisTest(ex, ey, ez, v0x, v0y, v0z, v1x, v1y, v1z, v2x, v2y, v2z, hx, hy, hz) {
  // axis = X cross e = (0, -ez, ey)
  let p0 = -ez * v0y + ey * v0z, p1 = -ez * v1y + ey * v1z, p2 = -ez * v2y + ey * v2z;
  let r = hy * Math.abs(ez) + hz * Math.abs(ey);
  if (Math.min(p0, p1, p2) > r || Math.max(p0, p1, p2) < -r) return false;
  // axis = Y cross e = (ez, 0, -ex)
  p0 = ez * v0x - ex * v0z; p1 = ez * v1x - ex * v1z; p2 = ez * v2x - ex * v2z;
  r = hx * Math.abs(ez) + hz * Math.abs(ex);
  if (Math.min(p0, p1, p2) > r || Math.max(p0, p1, p2) < -r) return false;
  // axis = Z cross e = (-ey, ex, 0)
  p0 = -ey * v0x + ex * v0y; p1 = -ey * v1x + ex * v1y; p2 = -ey * v2x + ex * v2y;
  r = hx * Math.abs(ey) + hy * Math.abs(ex);
  if (Math.min(p0, p1, p2) > r || Math.max(p0, p1, p2) < -r) return false;
  return true;
}

// ---------------------------------------------------------------------------
// createCollision
// ---------------------------------------------------------------------------

/**
 * @param {Array<{mesh:THREE.Object3D, type?:string, friction?:number}>} colliders
 * @param {Array<{curve:THREE.Curve, radius?:number, type?:string}>} rails
 */
export function createCollision(colliders = [], rails = []) {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : 0);

  // === 1. triangle extraction ============================================
  const srcColliders = Array.isArray(colliders) ? colliders.filter((c) => c && c.mesh) : [];
  const srcRails = Array.isArray(rails) ? rails.filter((r) => r && (r.curve || r.points)) : [];

  // surface table — triangles reference it by index so per-tri storage stays 2 bytes
  const surfaces = [];
  const surfaceKey = new Map();
  function surfaceId(type, friction) {
    const t = type || 'ground';
    const f = Number.isFinite(friction) ? friction : 0.9;
    const key = `${t}|${f.toFixed(4)}`;
    let id = surfaceKey.get(key);
    if (id === undefined) {
      id = surfaces.length;
      surfaces.push({ surface: t, friction: f });
      surfaceKey.set(key, id);
    }
    return id;
  }

  // Pass A: count triangles so the flat arrays can be allocated exactly once.
  const sources = [];      // { geo, matrix, sid, triCount }
  const _im = new THREE.Matrix4();

  for (const c of srcColliders) {
    const sid = surfaceId(c.type, c.friction);
    c.mesh.updateWorldMatrix(true, true);
    c.mesh.traverse((node) => {
      if (!node.isMesh || node.userData?.noCollide) return;
      const geo = node.geometry;
      const pos = geo?.attributes?.position;
      if (!pos || pos.count < 3) return;
      const triCount = (geo.index ? geo.index.count : pos.count) / 3 | 0;
      if (triCount <= 0) return;
      if (node.isInstancedMesh) {
        for (let i = 0; i < node.count; i++) {
          node.getMatrixAt(i, _im);
          const m = new THREE.Matrix4().multiplyMatrices(node.matrixWorld, _im);
          sources.push({ geo, matrix: m, sid, triCount });
        }
      } else {
        sources.push({ geo, matrix: node.matrixWorld.clone(), sid, triCount });
      }
    });
  }

  let capacity = 0;
  for (const s of sources) capacity += s.triCount;

  const triV = new Float32Array(capacity * 9);    // a, b, c
  const triN = new Float32Array(capacity * 9);    // vertex normals (face normal if absent)
  const triF = new Float32Array(capacity * 3);    // unit face normal
  const triS = new Uint16Array(capacity);         // surface index
  let triCount = 0;

  const _nm = new THREE.Matrix3();
  for (const s of sources) {
    const geo = s.geo;
    const pos = geo.attributes.position;
    const nrm = geo.attributes.normal;
    const idx = geo.index;
    const m = s.matrix.elements;
    _nm.getNormalMatrix(s.matrix);
    const n = _nm.elements;
    const count = idx ? idx.count : pos.count;

    for (let i = 0; i < count; i += 3) {
      const i0 = idx ? idx.getX(i) : i;
      const i1 = idx ? idx.getX(i + 1) : i + 1;
      const i2 = idx ? idx.getX(i + 2) : i + 2;

      // world-space positions
      let x = pos.getX(i0), y = pos.getY(i0), z = pos.getZ(i0);
      const ax = m[0] * x + m[4] * y + m[8] * z + m[12];
      const ay = m[1] * x + m[5] * y + m[9] * z + m[13];
      const az = m[2] * x + m[6] * y + m[10] * z + m[14];
      x = pos.getX(i1); y = pos.getY(i1); z = pos.getZ(i1);
      const bx = m[0] * x + m[4] * y + m[8] * z + m[12];
      const by = m[1] * x + m[5] * y + m[9] * z + m[13];
      const bz = m[2] * x + m[6] * y + m[10] * z + m[14];
      x = pos.getX(i2); y = pos.getY(i2); z = pos.getZ(i2);
      const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
      const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
      const cz = m[2] * x + m[6] * y + m[10] * z + m[14];

      // face normal — also the degeneracy filter
      const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
      const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
      let fx = e1y * e2z - e1z * e2y;
      let fy = e1z * e2x - e1x * e2z;
      let fz = e1x * e2y - e1y * e2x;
      const area2 = fx * fx + fy * fy + fz * fz;
      if (!(area2 > DEGENERATE_AREA2)) continue;       // slivers and NaN both fail this
      const inv = 1 / Math.sqrt(area2);
      fx *= inv; fy *= inv; fz *= inv;

      const t9 = triCount * 9;
      triV[t9] = ax; triV[t9 + 1] = ay; triV[t9 + 2] = az;
      triV[t9 + 3] = bx; triV[t9 + 4] = by; triV[t9 + 5] = bz;
      triV[t9 + 6] = cx; triV[t9 + 7] = cy; triV[t9 + 8] = cz;

      if (nrm) {
        for (let k = 0; k < 3; k++) {
          const vi = k === 0 ? i0 : k === 1 ? i1 : i2;
          const lx = nrm.getX(vi), ly = nrm.getY(vi), lz = nrm.getZ(vi);
          let wx = n[0] * lx + n[3] * ly + n[6] * lz;
          let wy = n[1] * lx + n[4] * ly + n[7] * lz;
          let wz = n[2] * lx + n[5] * ly + n[8] * lz;
          const l2 = wx * wx + wy * wy + wz * wz;
          if (l2 > 1e-12) { const li = 1 / Math.sqrt(l2); wx *= li; wy *= li; wz *= li; }
          else { wx = fx; wy = fy; wz = fz; }
          triN[t9 + k * 3] = wx; triN[t9 + k * 3 + 1] = wy; triN[t9 + k * 3 + 2] = wz;
        }
      } else {
        for (let k = 0; k < 3; k++) {
          triN[t9 + k * 3] = fx; triN[t9 + k * 3 + 1] = fy; triN[t9 + k * 3 + 2] = fz;
        }
      }

      const t3 = triCount * 3;
      triF[t3] = fx; triF[t3 + 1] = fy; triF[t3 + 2] = fz;
      triS[triCount] = s.sid;
      triCount++;
    }
  }
  sources.length = 0;

  // === 2. triangle grid ==================================================
  const bounds = new THREE.Box3();
  let bMinX = Infinity, bMinY = Infinity, bMinZ = Infinity;
  let bMaxX = -Infinity, bMaxY = -Infinity, bMaxZ = -Infinity;
  for (let i = 0; i < triCount * 9; i += 3) {
    const x = triV[i], y = triV[i + 1], z = triV[i + 2];
    if (x < bMinX) bMinX = x; if (x > bMaxX) bMaxX = x;
    if (y < bMinY) bMinY = y; if (y > bMaxY) bMaxY = y;
    if (z < bMinZ) bMinZ = z; if (z > bMaxZ) bMaxZ = z;
  }
  if (triCount === 0) { bMinX = bMinY = bMinZ = -1; bMaxX = bMaxY = bMaxZ = 1; }
  // pad so points exactly on a face still land inside the lattice
  const PAD = 0.05;
  bMinX -= PAD; bMinY -= PAD; bMinZ -= PAD;
  bMaxX += PAD; bMaxY += PAD; bMaxZ += PAD;
  bounds.min.set(bMinX, bMinY, bMinZ);
  bounds.max.set(bMaxX, bMaxY, bMaxZ);

  let cell = CELL_SIZE;
  let nx = 1, ny = 1, nz = 1;
  for (let guard = 0; guard < 24; guard++) {
    nx = Math.max(1, Math.ceil((bMaxX - bMinX) / cell));
    ny = Math.max(1, Math.ceil((bMaxY - bMinY) / cell));
    nz = Math.max(1, Math.ceil((bMaxZ - bMinZ) / cell));
    if (nx * ny * nz <= MAX_CELLS) break;
    cell *= 1.5;
  }
  const invCell = 1 / cell;
  const cellCount = nx * ny * nz;
  const halfCell = cell * 0.5;

  const cellStart = new Uint32Array(cellCount + 1);
  let cellItems = new Uint32Array(0);
  const oversized = [];        // triangle indices too broad to bucket usefully

  // Pass 1: count. Pass 2: scatter. Same overlap logic both times.
  const clampIx = (v) => (v < 0 ? 0 : v >= nx ? nx - 1 : v);
  const clampIy = (v) => (v < 0 ? 0 : v >= ny ? ny - 1 : v);
  const clampIz = (v) => (v < 0 ? 0 : v >= nz ? nz - 1 : v);

  function forEachTriCell(ti, visit) {
    const t9 = ti * 9;
    const ax = triV[t9], ay = triV[t9 + 1], az = triV[t9 + 2];
    const bx = triV[t9 + 3], by = triV[t9 + 4], bz = triV[t9 + 5];
    const cx = triV[t9 + 6], cy = triV[t9 + 7], cz = triV[t9 + 8];
    const x0 = clampIx(Math.floor((Math.min(ax, bx, cx) - bMinX) * invCell));
    const x1 = clampIx(Math.floor((Math.max(ax, bx, cx) - bMinX) * invCell));
    const y0 = clampIy(Math.floor((Math.min(ay, by, cy) - bMinY) * invCell));
    const y1 = clampIy(Math.floor((Math.max(ay, by, cy) - bMinY) * invCell));
    const z0 = clampIz(Math.floor((Math.min(az, bz, cz) - bMinZ) * invCell));
    const z1 = clampIz(Math.floor((Math.max(az, bz, cz) - bMinZ) * invCell));
    const span = (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1);
    if (span > MAX_CELLS_PER_TRI) return -1;
    // Exact SAT culling only pays for itself once the AABB covers several cells.
    const exact = span > 4;
    for (let iz = z0; iz <= z1; iz++) {
      const pz = bMinZ + iz * cell + halfCell;
      for (let iy = y0; iy <= y1; iy++) {
        const py = bMinY + iy * cell + halfCell;
        for (let ix = x0; ix <= x1; ix++) {
          if (exact) {
            const px = bMinX + ix * cell + halfCell;
            if (!triBoxOverlap(px, py, pz, halfCell, halfCell, halfCell,
              ax, ay, az, bx, by, bz, cx, cy, cz)) continue;
          }
          visit((iz * ny + iy) * nx + ix);
        }
      }
    }
    return 0;
  }

  {
    const counts = new Uint32Array(cellCount);
    const bump = (ci) => { counts[ci]++; };
    for (let ti = 0; ti < triCount; ti++) {
      if (forEachTriCell(ti, bump) < 0) oversized.push(ti);
    }
    let sum = 0;
    for (let i = 0; i < cellCount; i++) { cellStart[i] = sum; sum += counts[i]; }
    cellStart[cellCount] = sum;
    cellItems = new Uint32Array(sum);
    const cursor = counts;                 // reuse as write cursor
    cursor.fill(0);
    let cur = 0;
    const place = (ci) => { cellItems[cellStart[ci] + cursor[ci]++] = cur; };
    for (let ti = 0; ti < triCount; ti++) { cur = ti; forEachTriCell(ti, place); }
  }

  // mailbox so a triangle spanning several cells is only intersected once per query
  const mailbox = new Int32Array(triCount).fill(-1);
  let queryId = 0;
  function nextQuery() {
    queryId++;
    if (queryId > 2000000000) { mailbox.fill(-1); queryId = 1; }
    return queryId;
  }

  // === 3. rail polylines =================================================
  const railEntries = [];          // per rail: cached arc-length polyline
  const railOf = new Map();        // rail object -> entry
  let sampleCount = 0, segCount = 0;

  for (const r of srcRails) {
    const curve = r.curve;
    let pts = null;
    if (curve && typeof curve.getSpacedPoints === 'function') {
      let len = 0;
      try { len = curve.getLength(); } catch { len = 0; }
      if (!(len > 1e-4)) continue;
      const divisions = Math.max(2, Math.min(4096, Math.round(len / RAIL_STEP)));
      pts = curve.getSpacedPoints(divisions);
    } else if (Array.isArray(r.points) && r.points.length >= 2) {
      pts = r.points;
    }
    if (!pts || pts.length < 2) continue;

    const n = pts.length;
    const P = new Float32Array(n * 3);
    const cum = new Float32Array(n);
    let total = 0;
    P[0] = pts[0].x; P[1] = pts[0].y; P[2] = pts[0].z;
    for (let i = 1; i < n; i++) {
      const p = pts[i], q = pts[i - 1];
      total += Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
      cum[i] = total;
      P[i * 3] = p.x; P[i * 3 + 1] = p.y; P[i * 3 + 2] = p.z;
    }
    if (!(total > 1e-4)) continue;

    // per-sample tangents: average of the adjacent segment directions so the
    // grind system gets a continuous frame across polyline joints
    const T = new Float32Array(n * 3);
    const closed = !!(curve && curve.closed);
    for (let i = 0; i < n; i++) {
      let tx = 0, ty = 0, tz = 0;
      if (i > 0) {
        const d = cum[i] - cum[i - 1] || 1;
        tx += (P[i * 3] - P[(i - 1) * 3]) / d;
        ty += (P[i * 3 + 1] - P[(i - 1) * 3 + 1]) / d;
        tz += (P[i * 3 + 2] - P[(i - 1) * 3 + 2]) / d;
      }
      if (i < n - 1) {
        const d = cum[i + 1] - cum[i] || 1;
        tx += (P[(i + 1) * 3] - P[i * 3]) / d;
        ty += (P[(i + 1) * 3 + 1] - P[i * 3 + 1]) / d;
        tz += (P[(i + 1) * 3 + 2] - P[i * 3 + 2]) / d;
      }
      const l = Math.hypot(tx, ty, tz) || 1;
      T[i * 3] = tx / l; T[i * 3 + 1] = ty / l; T[i * 3 + 2] = tz / l;
    }

    const entry = {
      rail: r, index: railEntries.length, curve, closed,
      radius: Number.isFinite(r.radius) ? r.radius : 0.03,
      type: r.type || 'rail',
      n, P, T, cum, length: total,
      base: sampleCount,
    };
    railEntries.push(entry);
    railOf.set(r, entry);
    sampleCount += n;
    segCount += n - 1;
  }

  // flat segment table + its own lattice on the same cell size
  const segRail = new Uint16Array(segCount);
  const segLocal = new Uint32Array(segCount);
  {
    let s = 0;
    for (const e of railEntries) {
      for (let i = 0; i < e.n - 1; i++) { segRail[s] = e.index; segLocal[s] = i; s++; }
    }
  }

  let rMinX = Infinity, rMinY = Infinity, rMinZ = Infinity;
  let rMaxX = -Infinity, rMaxY = -Infinity, rMaxZ = -Infinity;
  for (const e of railEntries) {
    for (let i = 0; i < e.n; i++) {
      const x = e.P[i * 3], y = e.P[i * 3 + 1], z = e.P[i * 3 + 2];
      if (x < rMinX) rMinX = x; if (x > rMaxX) rMaxX = x;
      if (y < rMinY) rMinY = y; if (y > rMaxY) rMaxY = y;
      if (z < rMinZ) rMinZ = z; if (z > rMaxZ) rMaxZ = z;
    }
  }
  if (segCount === 0) { rMinX = rMinY = rMinZ = -1; rMaxX = rMaxY = rMaxZ = 1; }
  rMinX -= PAD; rMinY -= PAD; rMinZ -= PAD;
  rMaxX += PAD; rMaxY += PAD; rMaxZ += PAD;

  const rnx = Math.max(1, Math.min(512, Math.ceil((rMaxX - rMinX) * invCell)));
  const rny = Math.max(1, Math.min(512, Math.ceil((rMaxY - rMinY) * invCell)));
  const rnz = Math.max(1, Math.min(512, Math.ceil((rMaxZ - rMinZ) * invCell)));
  const railCellCount = rnx * rny * rnz;
  const railStart = new Uint32Array(railCellCount + 1);
  let railItems = new Uint32Array(0);

  function segEndpoints(si, out) {
    const e = railEntries[segRail[si]];
    const i = segLocal[si];
    out[0] = e.P[i * 3]; out[1] = e.P[i * 3 + 1]; out[2] = e.P[i * 3 + 2];
    out[3] = e.P[(i + 1) * 3]; out[4] = e.P[(i + 1) * 3 + 1]; out[5] = e.P[(i + 1) * 3 + 2];
    return e;
  }

  {
    const ep = new Float32Array(6);
    const counts = new Uint32Array(railCellCount);
    const visitSeg = (si, visit) => {
      segEndpoints(si, ep);
      const x0 = clamp(Math.floor((Math.min(ep[0], ep[3]) - rMinX) * invCell), 0, rnx - 1);
      const x1 = clamp(Math.floor((Math.max(ep[0], ep[3]) - rMinX) * invCell), 0, rnx - 1);
      const y0 = clamp(Math.floor((Math.min(ep[1], ep[4]) - rMinY) * invCell), 0, rny - 1);
      const y1 = clamp(Math.floor((Math.max(ep[1], ep[4]) - rMinY) * invCell), 0, rny - 1);
      const z0 = clamp(Math.floor((Math.min(ep[2], ep[5]) - rMinZ) * invCell), 0, rnz - 1);
      const z1 = clamp(Math.floor((Math.max(ep[2], ep[5]) - rMinZ) * invCell), 0, rnz - 1);
      for (let iz = z0; iz <= z1; iz++)
        for (let iy = y0; iy <= y1; iy++)
          for (let ix = x0; ix <= x1; ix++) visit((iz * rny + iy) * rnx + ix);
    };
    for (let si = 0; si < segCount; si++) visitSeg(si, (ci) => { counts[ci]++; });
    let sum = 0;
    for (let i = 0; i < railCellCount; i++) { railStart[i] = sum; sum += counts[i]; }
    railStart[railCellCount] = sum;
    railItems = new Uint32Array(sum);
    counts.fill(0);
    let cur = 0;
    const place = (ci) => { railItems[railStart[ci] + counts[ci]++] = cur; };
    for (let si = 0; si < segCount; si++) { cur = si; visitSeg(si, place); }
  }

  const railMailbox = new Int32Array(Math.max(1, segCount)).fill(-1);
  let railQueryId = 0;

  // === 4. ray casting ====================================================
  // Ray state lives in closure scalars so the inner loops touch no objects.
  let _ox = 0, _oy = 0, _oz = 0, _dx = 0, _dy = 0, _dz = 0;
  let _bestT = 0, _bestTri = -1, _bestU = 0, _bestV = 0, _qid = 0;

  function testTri(ti) {
    const t9 = ti * 9;
    const ax = triV[t9], ay = triV[t9 + 1], az = triV[t9 + 2];
    const e1x = triV[t9 + 3] - ax, e1y = triV[t9 + 4] - ay, e1z = triV[t9 + 5] - az;
    const e2x = triV[t9 + 6] - ax, e2y = triV[t9 + 7] - ay, e2z = triV[t9 + 8] - az;

    const px = _dy * e2z - _dz * e2y;
    const py = _dz * e2x - _dx * e2z;
    const pz = _dx * e2y - _dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (det > -RAY_EPS && det < RAY_EPS) return;        // parallel to the plane
    const invDet = 1 / det;

    const tx = _ox - ax, ty = _oy - ay, tz = _oz - az;
    const u = (tx * px + ty * py + tz * pz) * invDet;
    if (u < 0 || u > 1) return;

    const qx = ty * e1z - tz * e1y;
    const qy = tz * e1x - tx * e1z;
    const qz = tx * e1y - ty * e1x;
    const v = (_dx * qx + _dy * qy + _dz * qz) * invDet;
    if (v < 0 || u + v > 1) return;

    const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
    if (t < RAY_EPS || t >= _bestT) return;
    _bestT = t; _bestTri = ti; _bestU = u; _bestV = v;
  }

  function testCell(ci) {
    const s = cellStart[ci], e = cellStart[ci + 1];
    for (let k = s; k < e; k++) {
      const ti = cellItems[k];
      if (mailbox[ti] === _qid) continue;
      mailbox[ti] = _qid;
      testTri(ti);
    }
  }

  /** DDA through the lattice. Fills _bestTri/_bestT/_bestU/_bestV. */
  function castRay(ox, oy, oz, dx, dy, dz, maxDist) {
    _bestTri = -1;
    _bestT = maxDist;
    if (triCount === 0 || !(maxDist > 0)) return -1;

    const dl = Math.hypot(dx, dy, dz);
    if (!(dl > 1e-9)) return -1;
    const di = 1 / dl;
    _ox = ox; _oy = oy; _oz = oz;
    _dx = dx * di; _dy = dy * di; _dz = dz * di;
    dx = _dx; dy = _dy; dz = _dz;
    _qid = nextQuery();

    // triangles too broad to bucket are always live
    for (let i = 0; i < oversized.length; i++) {
      const ti = oversized[i];
      mailbox[ti] = _qid;
      testTri(ti);
    }

    // coarse slab reject against the whole park
    let t0 = 0, t1 = maxDist;
    if (Math.abs(dx) < 1e-9) { if (ox < bMinX || ox > bMaxX) return _bestTri; }
    else {
      const inv = 1 / dx;
      let ta = (bMinX - ox) * inv, tb = (bMaxX - ox) * inv;
      if (ta > tb) { const s = ta; ta = tb; tb = s; }
      if (ta > t0) t0 = ta; if (tb < t1) t1 = tb;
    }
    if (Math.abs(dy) < 1e-9) { if (oy < bMinY || oy > bMaxY) return _bestTri; }
    else {
      const inv = 1 / dy;
      let ta = (bMinY - oy) * inv, tb = (bMaxY - oy) * inv;
      if (ta > tb) { const s = ta; ta = tb; tb = s; }
      if (ta > t0) t0 = ta; if (tb < t1) t1 = tb;
    }
    if (Math.abs(dz) < 1e-9) { if (oz < bMinZ || oz > bMaxZ) return _bestTri; }
    else {
      const inv = 1 / dz;
      let ta = (bMinZ - oz) * inv, tb = (bMaxZ - oz) * inv;
      if (ta > tb) { const s = ta; ta = tb; tb = s; }
      if (ta > t0) t0 = ta; if (tb < t1) t1 = tb;
    }
    if (t0 > t1) return _bestTri;

    const enter = t0 > 0 ? t0 : 0;
    let ix = clampIx(Math.floor((ox + dx * enter - bMinX) * invCell));
    let iy = clampIy(Math.floor((oy + dy * enter - bMinY) * invCell));
    let iz = clampIz(Math.floor((oz + dz * enter - bMinZ) * invCell));

    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
    let tMaxX = Infinity, tMaxY = Infinity, tMaxZ = Infinity;
    let tDeltaX = Infinity, tDeltaY = Infinity, tDeltaZ = Infinity;
    if (stepX !== 0) {
      const b = bMinX + (ix + (stepX > 0 ? 1 : 0)) * cell;
      tMaxX = (b - ox) / dx; tDeltaX = cell / Math.abs(dx);
    }
    if (stepY !== 0) {
      const b = bMinY + (iy + (stepY > 0 ? 1 : 0)) * cell;
      tMaxY = (b - oy) / dy; tDeltaY = cell / Math.abs(dy);
    }
    if (stepZ !== 0) {
      const b = bMinZ + (iz + (stepZ > 0 ? 1 : 0)) * cell;
      tMaxZ = (b - oz) / dz; tDeltaZ = cell / Math.abs(dz);
    }

    const limit = nx + ny + nz + 8;
    for (let guard = 0; guard < limit; guard++) {
      testCell((iz * ny + iy) * nx + ix);
      const exit = tMaxX < tMaxY ? (tMaxX < tMaxZ ? tMaxX : tMaxZ) : (tMaxY < tMaxZ ? tMaxY : tMaxZ);
      // a hit inside this cell can no longer be beaten once we leave it
      if (_bestTri >= 0 && _bestT <= exit) break;
      if (exit > t1 || exit === Infinity) break;
      if (tMaxX < tMaxY) {
        if (tMaxX < tMaxZ) { ix += stepX; if (ix < 0 || ix >= nx) break; tMaxX += tDeltaX; }
        else { iz += stepZ; if (iz < 0 || iz >= nz) break; tMaxZ += tDeltaZ; }
      } else if (tMaxY < tMaxZ) { iy += stepY; if (iy < 0 || iy >= ny) break; tMaxY += tDeltaY; }
      else { iz += stepZ; if (iz < 0 || iz >= nz) break; tMaxZ += tDeltaZ; }
    }
    return _bestTri;
  }

  // --- result pools ------------------------------------------------------
  function makeRayResult() {
    return {
      hit: false,
      point: new THREE.Vector3(),
      normal: new THREE.Vector3(),      // smoothed, oriented against the ray
      faceNormal: new THREE.Vector3(),  // flat, oriented against the ray
      distance: 0,
      friction: 0.9,
      surface: 'ground',
      triangle: -1,
    };
  }
  const rayPool = [];
  for (let i = 0; i < RESULT_POOL; i++) rayPool.push(makeRayResult());
  let rayCursor = 0;

  function fillRayResult(ti, t) {
    const out = rayPool[rayCursor];
    rayCursor = (rayCursor + 1) % RESULT_POOL;

    const t9 = ti * 9, t3 = ti * 3;
    const u = _bestU, v = _bestV, w = 1 - u - v;

    out.point.set(_ox + _dx * t, _oy + _dy * t, _oz + _dz * t);

    let fx = triF[t3], fy = triF[t3 + 1], fz = triF[t3 + 2];
    if (fx * _dx + fy * _dy + fz * _dz > 0) { fx = -fx; fy = -fy; fz = -fz; }
    out.faceNormal.set(fx, fy, fz);

    // Smoothed normal: barycentric blend of the vertex normals. Ramp-to-flat
    // transitions read as a continuous surface instead of a stack of facets.
    let sx = triN[t9] * w + triN[t9 + 3] * u + triN[t9 + 6] * v;
    let sy = triN[t9 + 1] * w + triN[t9 + 4] * u + triN[t9 + 7] * v;
    let sz = triN[t9 + 2] * w + triN[t9 + 5] * u + triN[t9 + 8] * v;
    const l2 = sx * sx + sy * sy + sz * sz;
    if (l2 > 1e-10) {
      const li = 1 / Math.sqrt(l2);
      sx *= li; sy *= li; sz *= li;
      if (sx * fx + sy * fy + sz * fz < 0) { sx = -sx; sy = -sy; sz = -sz; }
      // a wildly divergent vertex normal (unwelded merge seam) is not trustworthy
      if (sx * fx + sy * fy + sz * fz < 0.2) { sx = fx; sy = fy; sz = fz; }
    } else { sx = fx; sy = fy; sz = fz; }
    out.normal.set(sx, sy, sz);

    const surf = surfaces[triS[ti]];
    out.friction = surf ? surf.friction : 0.9;
    out.surface = surf ? surf.surface : 'ground';
    out.distance = t;
    out.triangle = ti;
    out.hit = true;
    return out;
  }

  // === 5. sphere sweep ===================================================
  // Scratch bags: `_ct/_cs` are per-test, `_pt/_ps` the best pair for the
  // triangle under test, `_wt/_ws` the winning pair across the whole query.
  // Keeping those three tiers separate is what stops a losing triangle from
  // clobbering an already-committed contact.
  const _ct = { x: 0, y: 0, z: 0 };
  const _cs = { x: 0, y: 0, z: 0 };
  const _pt = { x: 0, y: 0, z: 0 };
  const _ps = { x: 0, y: 0, z: 0 };
  const _wt = { x: 0, y: 0, z: 0 };

  // Capsule state for the hoisted per-triangle test — a closure re-created per
  // query would allocate, and this runs every fixed step.
  let _swFx = 0, _swFy = 0, _swFz = 0, _swTx = 0, _swTy = 0, _swTz = 0;
  let _swDx = 0, _swDy = 0, _swDz = 0, _swLen = 0, _swR = 0, _swR2 = 0;
  let _swDepth = 0, _swTri = -1, _swNx = 0, _swNy = 1, _swNz = 0;
  let _swMinX = 0, _swMinY = 0, _swMinZ = 0, _swMaxX = 0, _swMaxY = 0, _swMaxZ = 0;

  function considerSweepTri(ti) {
    const t9 = ti * 9, t3 = ti * 3;
    const ax = triV[t9], ay = triV[t9 + 1], az = triV[t9 + 2];
    const bx = triV[t9 + 3], by = triV[t9 + 4], bz = triV[t9 + 5];
    const cx = triV[t9 + 6], cy = triV[t9 + 7], cz = triV[t9 + 8];

    // Cheap AABB reject. A 2 m cell over dense ground holds a few dozen
    // triangles and the closest-point work below is ~100 flops each, so this
    // pays for itself many times over.
    if (ax < _swMinX && bx < _swMinX && cx < _swMinX) return;
    if (ax > _swMaxX && bx > _swMaxX && cx > _swMaxX) return;
    if (ay < _swMinY && by < _swMinY && cy < _swMinY) return;
    if (ay > _swMaxY && by > _swMaxY && cy > _swMaxY) return;
    if (az < _swMinZ && bz < _swMinZ && cz < _swMinZ) return;
    if (az > _swMaxZ && bz > _swMaxZ && cz > _swMaxZ) return;

    // 1) the capsule axis pierces the triangle — push straight back out
    if (_swLen > 1e-9) {
      const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
      const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
      const px = _swDy * e2z - _swDz * e2y;
      const py = _swDz * e2x - _swDx * e2z;
      const pz = _swDx * e2y - _swDy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (det < -RAY_EPS || det > RAY_EPS) {
        const invDet = 1 / det;
        const vx = _swFx - ax, vy = _swFy - ay, vz = _swFz - az;
        const u = (vx * px + vy * py + vz * pz) * invDet;
        if (u >= 0 && u <= 1) {
          const qx = vy * e1z - vz * e1y;
          const qy = vz * e1x - vx * e1z;
          const qz = vx * e1y - vy * e1x;
          const v = (_swDx * qx + _swDy * qy + _swDz * qz) * invDet;
          if (v >= 0 && u + v <= 1) {
            const th = (e2x * qx + e2y * qy + e2z * qz) * invDet;
            if (th >= 0 && th <= _swLen) {
              let fnx = triF[t3], fny = triF[t3 + 1], fnz = triF[t3 + 2];
              if (fnx * _swDx + fny * _swDy + fnz * _swDz > 0) { fnx = -fnx; fny = -fny; fnz = -fnz; }
              // signed distance of the far endpoint behind the plane
              const sd = (_swTx - ax) * fnx + (_swTy - ay) * fny + (_swTz - az) * fnz;
              const depth = _swR - sd;
              if (depth > _swDepth) {
                _swDepth = depth; _swTri = ti;
                _swNx = fnx; _swNy = fny; _swNz = fnz;
                _wt.x = _swFx + _swDx * th;
                _wt.y = _swFy + _swDy * th;
                _wt.z = _swFz + _swDz * th;
              }
              return;
            }
          }
        }
      }
    }

    // 2) closest approach between the capsule axis and the triangle
    let best2 = Infinity, interior = false;
    let inside = closestPtPointTriangle(_swFx, _swFy, _swFz, ax, ay, az, bx, by, bz, cx, cy, cz, _ct);
    let dx = _swFx - _ct.x, dy = _swFy - _ct.y, dz = _swFz - _ct.z;
    let d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < best2) {
      best2 = d2; interior = inside;
      _pt.x = _ct.x; _pt.y = _ct.y; _pt.z = _ct.z;
      _ps.x = _swFx; _ps.y = _swFy; _ps.z = _swFz;
    }
    if (_swLen > 0) {
      inside = closestPtPointTriangle(_swTx, _swTy, _swTz, ax, ay, az, bx, by, bz, cx, cy, cz, _ct);
      dx = _swTx - _ct.x; dy = _swTy - _ct.y; dz = _swTz - _ct.z;
      d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < best2) {
        best2 = d2; interior = inside;
        _pt.x = _ct.x; _pt.y = _ct.y; _pt.z = _ct.z;
        _ps.x = _swTx; _ps.y = _swTy; _ps.z = _swTz;
      }
      for (let k = 0; k < 3; k++) {
        const o1 = t9 + k * 3;
        const o2 = t9 + ((k + 1) % 3) * 3;
        d2 = closestPtSegSeg(
          _swFx, _swFy, _swFz, _swTx, _swTy, _swTz,
          triV[o1], triV[o1 + 1], triV[o1 + 2],
          triV[o2], triV[o2 + 1], triV[o2 + 2], _cs, _ct);
        if (d2 < best2) {
          best2 = d2; interior = false;          // edge contact — no face to disambiguate with
          _pt.x = _ct.x; _pt.y = _ct.y; _pt.z = _ct.z;
          _ps.x = _cs.x; _ps.y = _cs.y; _ps.z = _cs.z;
        }
      }
    }

    // The closest point on the triangle must lie inside the sphere. Enforcing
    // that for every case is what keeps a thin wall honest: the far face is
    // simply out of range rather than a competing (and inverted) contact.
    if (best2 >= _swR2) return;

    const fnx = triF[t3], fny = triF[t3 + 1], fnz = triF[t3 + 2];
    const sd = (_ps.x - _pt.x) * fnx + (_ps.y - _pt.y) * fny + (_ps.z - _pt.z) * fnz;
    // A contact perpendicular to the face plane behaves like a face contact
    // even when Ericson classified it as an edge — which is exactly what a
    // query landing on the seam between two merged quads produces. Without
    // this, standing on a seam resolves straight downwards.
    const tangential2 = best2 - sd * sd;
    const dist = Math.sqrt(best2);
    let depth, nxv, nyv, nzv;

    if (interior || tangential2 < 1e-6) {
      // Face contact: the signed distance says which side we are on, so a body
      // that has already sunk behind the surface resolves out the front rather
      // than being shoved deeper in. depth stays within [0, 2r].
      depth = _swR - sd;
      nxv = fnx; nyv = fny; nzv = fnz;
    } else if (dist > 1e-6) {
      // Edge or vertex contact: surface -> capsule axis is the resolve direction.
      depth = _swR - dist;
      nxv = (_ps.x - _pt.x) / dist; nyv = (_ps.y - _pt.y) / dist; nzv = (_ps.z - _pt.z) / dist;
    } else {
      depth = _swR;
      nxv = fnx; nyv = fny; nzv = fnz;
      if (_swLen > 0 && nxv * _swDx + nyv * _swDy + nzv * _swDz > 0) { nxv = -nxv; nyv = -nyv; nzv = -nzv; }
    }

    if (depth <= _swDepth) return;
    _swDepth = depth; _swTri = ti;
    _swNx = nxv; _swNy = nyv; _swNz = nzv;
    _wt.x = _pt.x; _wt.y = _pt.y; _wt.z = _pt.z;
  }

  function makeSweepResult() {
    return {
      hit: false,
      point: new THREE.Vector3(),
      normal: new THREE.Vector3(),
      depth: 0,
      friction: 0.9,
      surface: 'wall',
      triangle: -1,
    };
  }
  const sweepPool = [makeSweepResult(), makeSweepResult(), makeSweepResult(), makeSweepResult()];
  let sweepCursor = 0;

  // === 6. public queries =================================================
  function railResultObj() {
    return {
      rail: null, t: 0,
      point: new THREE.Vector3(),
      tangent: new THREE.Vector3(),
      distance: 0, radius: 0.03, type: 'rail',
    };
  }
  const railPool = [railResultObj(), railResultObj(), railResultObj(), railResultObj()];
  let railCursor = 0;

  /** Locate the polyline sample interval containing arc position s. */
  function findSeg(e, s) {
    let lo = 0, hi = e.n - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (e.cum[mid] <= s) lo = mid; else hi = mid;
    }
    return lo;
  }

  function entryFor(rail) {
    return rail ? (railOf.get(rail) || null) : null;
  }

  const api = {
    // --- introspection ---------------------------------------------------
    bounds,
    stats: {
      triangles: triCount,
      cells: cellCount,
      cellSize: cell,
      dims: [nx, ny, nz],
      inserts: cellItems.length,
      oversized: oversized.length,
      rails: railEntries.length,
      railSegments: segCount,
      buildMs: 0,
    },
    surfaces,

    /**
     * Downward ray from `origin`, the workhorse for wheel contacts.
     *
     * NOTE ON LIFETIME: the returned object comes from a rotating pool of
     * RESULT_POOL entries shared with `raycast`. It stays valid for the next
     * 7 ray queries and no longer. Copy `point`/`normal` (`.clone()` or
     * `.copy(...)` into your own vectors) if you intend to keep them across a
     * frame boundary or store them on state.
     *
     * @returns {{hit:boolean, point:THREE.Vector3, normal:THREE.Vector3,
     *            faceNormal:THREE.Vector3, distance:number, friction:number,
     *            surface:string, triangle:number} | null}
     */
    raycastDown(origin, maxDist = 6) {
      if (!origin) return null;
      const ti = castRay(origin.x, origin.y, origin.z, 0, -1, 0, maxDist);
      return ti < 0 ? null : fillRayResult(ti, _bestT);
    },

    /**
     * Generic ray. `dir` need not be normalised; `distance` is returned in
     * metres along the normalised direction. Same pooled-result lifetime rule
     * as `raycastDown`.
     */
    raycast(origin, dir, maxDist = 50) {
      if (!origin || !dir) return null;
      const ti = castRay(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, maxDist);
      return ti < 0 ? null : fillRayResult(ti, _bestT);
    },

    /**
     * Capsule (swept sphere) query used for wall response. Returns the deepest
     * contact against the segment from->to inflated by `radius`.
     * `normal` is the push-out direction (surface -> capsule), `depth` the
     * overlap in metres, `point` the contact on the surface.
     * Pooled result: valid for 3 further sweeps.
     */
    sweepSphere(from, to, radius = 0.35) {
      if (triCount === 0 || !from || !to || !(radius > 0)) return null;

      _swFx = from.x; _swFy = from.y; _swFz = from.z;
      _swTx = to.x; _swTy = to.y; _swTz = to.z;
      _swR = radius; _swR2 = radius * radius;

      const minX = Math.min(_swFx, _swTx) - radius, maxX = Math.max(_swFx, _swTx) + radius;
      const minY = Math.min(_swFy, _swTy) - radius, maxY = Math.max(_swFy, _swTy) + radius;
      const minZ = Math.min(_swFz, _swTz) - radius, maxZ = Math.max(_swFz, _swTz) + radius;
      if (maxX < bMinX || minX > bMaxX || maxY < bMinY || minY > bMaxY
        || maxZ < bMinZ || minZ > bMaxZ) return null;
      _swMinX = minX; _swMinY = minY; _swMinZ = minZ;
      _swMaxX = maxX; _swMaxY = maxY; _swMaxZ = maxZ;

      _swDx = _swTx - _swFx; _swDy = _swTy - _swFy; _swDz = _swTz - _swFz;
      _swLen = Math.hypot(_swDx, _swDy, _swDz);
      if (_swLen > 1e-9) { _swDx /= _swLen; _swDy /= _swLen; _swDz /= _swLen; }
      else { _swDx = 0; _swDy = 0; _swDz = 0; _swLen = 0; }

      const qid = nextQuery();
      _swDepth = 0; _swTri = -1; _swNx = 0; _swNy = 1; _swNz = 0;

      for (let i = 0; i < oversized.length; i++) {
        const ti = oversized[i];
        mailbox[ti] = qid;
        considerSweepTri(ti);
      }

      const x0 = clampIx(Math.floor((minX - bMinX) * invCell));
      const x1 = clampIx(Math.floor((maxX - bMinX) * invCell));
      const y0 = clampIy(Math.floor((minY - bMinY) * invCell));
      const y1 = clampIy(Math.floor((maxY - bMinY) * invCell));
      const z0 = clampIz(Math.floor((minZ - bMinZ) * invCell));
      const z1 = clampIz(Math.floor((maxZ - bMinZ) * invCell));
      for (let iz = z0; iz <= z1; iz++) {
        for (let iy = y0; iy <= y1; iy++) {
          const row = (iz * ny + iy) * nx;
          for (let ix = x0; ix <= x1; ix++) {
            const ci = row + ix;
            const s = cellStart[ci], e = cellStart[ci + 1];
            for (let k = s; k < e; k++) {
              const ti = cellItems[k];
              if (mailbox[ti] === qid) continue;
              mailbox[ti] = qid;
              considerSweepTri(ti);
            }
          }
        }
      }

      if (_swTri < 0 || _swDepth <= 0) return null;
      const out = sweepPool[sweepCursor];
      sweepCursor = (sweepCursor + 1) % sweepPool.length;
      out.hit = true;
      out.point.set(_wt.x, _wt.y, _wt.z);
      out.normal.set(_swNx, _swNy, _swNz);
      const nl = out.normal.lengthSq();
      if (nl > 1e-10) out.normal.multiplyScalar(1 / Math.sqrt(nl)); else out.normal.set(0, 1, 0);
      out.depth = _swDepth;
      const surf = surfaces[triS[_swTri]];
      out.friction = surf ? surf.friction : 0.9;
      out.surface = surf ? surf.surface : 'wall';
      out.triangle = _swTri;
      return out;
    },

    /**
     * Closest grind line to `point`. When `velocity` is supplied (and above
     * 0.5 m/s) only rails whose tangent sits within 50 deg of the travel
     * direction qualify — sign-agnostic, because grinds ride switch. The
     * returned `tangent` is flipped to agree with `velocity` when given.
     *
     * `t` is the normalised ARC-LENGTH parameter; feed it straight back into
     * railPointAt / railTangentAt. Pooled result: valid for 3 further calls.
     */
    nearestRail(point, maxDist = 1.2, velocity = null) {
      if (segCount === 0 || !point || !(maxDist > 0)) return null;

      let vx = 0, vy = 0, vz = 0, useV = false;
      if (velocity) {
        const vl = Math.hypot(velocity.x, velocity.y, velocity.z);
        if (vl > 0.5) { vx = velocity.x / vl; vy = velocity.y / vl; vz = velocity.z / vl; useV = true; }
      }

      const px = point.x, py = point.y, pz = point.z;
      if (px + maxDist < rMinX || px - maxDist > rMaxX
        || py + maxDist < rMinY || py - maxDist > rMaxY
        || pz + maxDist < rMinZ || pz - maxDist > rMaxZ) return null;

      railQueryId++;
      if (railQueryId > 2000000000) { railMailbox.fill(-1); railQueryId = 1; }
      const qid = railQueryId;

      const x0 = clamp(Math.floor((px - maxDist - rMinX) * invCell), 0, rnx - 1);
      const x1 = clamp(Math.floor((px + maxDist - rMinX) * invCell), 0, rnx - 1);
      const y0 = clamp(Math.floor((py - maxDist - rMinY) * invCell), 0, rny - 1);
      const y1 = clamp(Math.floor((py + maxDist - rMinY) * invCell), 0, rny - 1);
      const z0 = clamp(Math.floor((pz - maxDist - rMinZ) * invCell), 0, rnz - 1);
      const z1 = clamp(Math.floor((pz + maxDist - rMinZ) * invCell), 0, rnz - 1);

      let best2 = maxDist * maxDist, bestSeg = -1, bestS = 0;
      for (let iz = z0; iz <= z1; iz++) {
        for (let iy = y0; iy <= y1; iy++) {
          const row = (iz * rny + iy) * rnx;
          for (let ix = x0; ix <= x1; ix++) {
            const ci = row + ix;
            const s0 = railStart[ci], s1 = railStart[ci + 1];
            for (let k = s0; k < s1; k++) {
              const si = railItems[k];
              if (railMailbox[si] === qid) continue;
              railMailbox[si] = qid;

              const e = railEntries[segRail[si]];
              const i = segLocal[si];
              const i3 = i * 3, j3 = i3 + 3;
              const axp = e.P[i3], ayp = e.P[i3 + 1], azp = e.P[i3 + 2];
              const dxs = e.P[j3] - axp, dys = e.P[j3 + 1] - ayp, dzs = e.P[j3 + 2] - azp;
              const len2 = dxs * dxs + dys * dys + dzs * dzs;
              if (len2 < 1e-12) continue;

              let s = ((px - axp) * dxs + (py - ayp) * dys + (pz - azp) * dzs) / len2;
              s = s < 0 ? 0 : s > 1 ? 1 : s;
              const cxp = axp + dxs * s, cyp = ayp + dys * s, czp = azp + dzs * s;
              const ddx = px - cxp, ddy = py - cyp, ddz = pz - czp;
              const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
              if (d2 >= best2) continue;

              if (useV) {
                const il = 1 / Math.sqrt(len2);
                const dot = (dxs * vx + dys * vy + dzs * vz) * il;
                if (Math.abs(dot) < RAIL_ANGLE_COS) continue;
              }
              best2 = d2; bestSeg = si; bestS = s;
            }
          }
        }
      }
      if (bestSeg < 0) return null;

      const e = railEntries[segRail[bestSeg]];
      const i = segLocal[bestSeg];
      const arc = e.cum[i] + (e.cum[i + 1] - e.cum[i]) * bestS;

      const out = railPool[railCursor];
      railCursor = (railCursor + 1) % railPool.length;
      out.rail = e.rail;
      out.t = clamp(arc / e.length, 0, 1);
      out.distance = Math.sqrt(best2);
      out.radius = e.radius;
      out.type = e.type;
      api.railPointAt(e.rail, out.t, out.point);
      api.railTangentAt(e.rail, out.t, out.tangent);
      if (useV && (out.tangent.x * vx + out.tangent.y * vy + out.tangent.z * vz) < 0) {
        out.tangent.negate();
      }
      return out;
    },

    /**
     * World position at normalised arc length `t` along `rail`.
     * Writes into `out` when given (zero allocation), otherwise returns a new
     * Vector3. Closed rails wrap; open rails clamp.
     */
    railPointAt(rail, t, out = null) {
      const dst = out || new THREE.Vector3();
      const e = entryFor(rail);
      if (!e) {
        if (rail?.curve?.getPointAt) return dst.copy(rail.curve.getPointAt(clamp(t, 0, 1)));
        return dst.set(0, 0, 0);
      }
      let u = e.closed ? t - Math.floor(t) : clamp(t, 0, 1);
      if (!Number.isFinite(u)) u = 0;
      const s = u * e.length;
      const i = findSeg(e, s);
      const span = e.cum[i + 1] - e.cum[i];
      const f = span > 1e-9 ? (s - e.cum[i]) / span : 0;
      const i3 = i * 3, j3 = i3 + 3;
      dst.set(
        e.P[i3] + (e.P[j3] - e.P[i3]) * f,
        e.P[i3 + 1] + (e.P[j3 + 1] - e.P[i3 + 1]) * f,
        e.P[i3 + 2] + (e.P[j3 + 2] - e.P[i3 + 2]) * f,
      );
      return dst;
    },

    /** Unit tangent at normalised arc length `t`. Same out/wrapping rules. */
    railTangentAt(rail, t, out = null) {
      const dst = out || new THREE.Vector3();
      const e = entryFor(rail);
      if (!e) {
        if (rail?.curve?.getTangentAt) return dst.copy(rail.curve.getTangentAt(clamp(t, 0, 1)));
        return dst.set(0, 0, 1);
      }
      let u = e.closed ? t - Math.floor(t) : clamp(t, 0, 1);
      if (!Number.isFinite(u)) u = 0;
      const s = u * e.length;
      const i = findSeg(e, s);
      const span = e.cum[i + 1] - e.cum[i];
      const f = span > 1e-9 ? (s - e.cum[i]) / span : 0;
      const i3 = i * 3, j3 = i3 + 3;
      dst.set(
        e.T[i3] + (e.T[j3] - e.T[i3]) * f,
        e.T[i3 + 1] + (e.T[j3 + 1] - e.T[i3 + 1]) * f,
        e.T[i3 + 2] + (e.T[j3 + 2] - e.T[i3 + 2]) * f,
      );
      const l2 = dst.lengthSq();
      if (l2 > 1e-10) dst.multiplyScalar(1 / Math.sqrt(l2)); else dst.set(0, 0, 1);
      return dst;
    },

    /** Total arc length of a rail in metres (0 if unknown). */
    railLength(rail) {
      const e = entryFor(rail);
      return e ? e.length : 0;
    },

    /** Every rail this system knows about, in park order. */
    railList() { return railEntries.map((e) => e.rail); },

    /**
     * Optional visualisation: occupied grid cells as wireframe boxes plus the
     * rail polylines. Not added to the scene — the caller owns it and must call
     * the returned group's dispose().
     */
    debugMesh({ cells = true, railLines = true, triangles = false, maxCells = 4000 } = {}) {
      const group = new THREE.Group();
      group.name = 'collisionDebug';
      const disposables = [];

      if (cells) {
        const occupied = [];
        for (let ci = 0; ci < cellCount; ci++) {
          if (cellStart[ci + 1] > cellStart[ci]) occupied.push(ci);
        }
        const stride = Math.max(1, Math.ceil(occupied.length / maxCells));
        const drawn = Math.ceil(occupied.length / stride);
        const pts = new Float32Array(drawn * 24 * 3);
        // 12 edges of a unit cube expressed as vertex-pair indices
        const E = [0, 1, 1, 3, 3, 2, 2, 0, 4, 5, 5, 7, 7, 6, 6, 4, 0, 4, 1, 5, 2, 6, 3, 7];
        let w = 0;
        for (let k = 0, o = 0; o < occupied.length; o += stride, k++) {
          const ci = occupied[o];
          const ix = ci % nx;
          const iy = ((ci / nx) | 0) % ny;
          const iz = (ci / (nx * ny)) | 0;
          const x = bMinX + ix * cell, y = bMinY + iy * cell, z = bMinZ + iz * cell;
          for (let ei = 0; ei < 24; ei++) {
            const c = E[ei];
            pts[w++] = x + (c & 1 ? cell : 0);
            pts[w++] = y + (c & 2 ? cell : 0);
            pts[w++] = z + (c & 4 ? cell : 0);
          }
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pts, 3));
        const m = new THREE.LineBasicMaterial({ color: 0x2f6fd0, transparent: true, opacity: 0.22, depthWrite: false });
        const lines = new THREE.LineSegments(g, m);
        lines.name = 'collisionGrid';
        group.add(lines);
        disposables.push(g, m);
      }

      if (triangles && triCount > 0) {
        const cap = Math.min(triCount, 40000);
        const pts = new Float32Array(cap * 18);
        const seq = [0, 3, 3, 6, 6, 0];
        let w = 0;
        for (let ti = 0; ti < cap; ti++) {
          const t9 = ti * 9;
          for (let k = 0; k < 6; k++) {
            const o = t9 + seq[k];
            pts[w++] = triV[o]; pts[w++] = triV[o + 1]; pts[w++] = triV[o + 2];
          }
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pts, 3));
        const m = new THREE.LineBasicMaterial({ color: 0x39d98a, transparent: true, opacity: 0.35, depthWrite: false });
        const lines = new THREE.LineSegments(g, m);
        lines.name = 'collisionTris';
        group.add(lines);
        disposables.push(g, m);
      }

      if (railLines && segCount > 0) {
        const pts = new Float32Array(segCount * 6);
        let w = 0;
        for (const e of railEntries) {
          for (let i = 0; i < e.n - 1; i++) {
            const i3 = i * 3, j3 = i3 + 3;
            pts[w++] = e.P[i3]; pts[w++] = e.P[i3 + 1]; pts[w++] = e.P[i3 + 2];
            pts[w++] = e.P[j3]; pts[w++] = e.P[j3 + 1]; pts[w++] = e.P[j3 + 2];
          }
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pts, 3));
        const m = new THREE.LineBasicMaterial({ color: 0xffb020, depthTest: false, transparent: true, opacity: 0.9 });
        const lines = new THREE.LineSegments(g, m);
        lines.name = 'collisionRails';
        lines.renderOrder = 999;
        group.add(lines);
        disposables.push(g, m);
      }

      group.userData.dispose = () => { for (const d of disposables) d.dispose(); };
      group.dispose = group.userData.dispose;
      return group;
    },

    dispose() {
      railOf.clear();
      surfaceKey.clear();
      railEntries.length = 0;
      oversized.length = 0;
      surfaces.length = 0;
    },
  };

  api.stats.buildMs = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
  console.info(`[collision] ${triCount} tris in ${nx}x${ny}x${nz} cells @ ${cell.toFixed(2)}m `
    + `(${cellItems.length} inserts, ${oversized.length} oversized), `
    + `${railEntries.length} rails / ${segCount} segments, ${api.stats.buildMs.toFixed(1)} ms`);

  return api;
}

// ---------------------------------------------------------------------------
// verifyCollision — sanity pass for the integrator. NOT run at import time.
// ---------------------------------------------------------------------------

/**
 * Runs a handful of cheap assertions against a built collision system and
 * returns a report. Call it once after createCollision() while bringing the
 * park up; it costs a few hundred queries.
 *
 * @returns {{ok:boolean, checks:Array<{name:string, ok:boolean, detail:string}>}}
 */
export function verifyCollision(collision) {
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail: String(detail) });

  if (!collision) {
    add('exists', false, 'collision is null');
    return { ok: false, checks };
  }

  add('api', typeof collision.raycastDown === 'function'
    && typeof collision.raycast === 'function'
    && typeof collision.sweepSphere === 'function'
    && typeof collision.nearestRail === 'function'
    && typeof collision.railPointAt === 'function'
    && typeof collision.railTangentAt === 'function',
  'required methods present');

  const st = collision.stats || {};
  add('triangles', (st.triangles | 0) > 0, `${st.triangles | 0} triangles extracted`);

  const b = collision.bounds;
  const centre = b ? b.getCenter(new THREE.Vector3()) : new THREE.Vector3();
  const top = b ? b.max.y + 2 : 30;

  // 1. a downward ray from above the park centre should find ground
  const origin = new THREE.Vector3(centre.x, top, centre.z);
  const down = collision.raycastDown(origin, (top - (b ? b.min.y : -5)) + 4);
  add('raycastDown/hit', !!down, down ? `y=${down.point.y.toFixed(3)} surface=${down.surface}` : 'no hit at park centre');

  if (down) {
    add('raycastDown/normal', Math.abs(down.normal.length() - 1) < 1e-3, `|n|=${down.normal.length().toFixed(5)}`);
    add('raycastDown/facing', down.normal.y > 0, `n.y=${down.normal.y.toFixed(3)}`);
    add('raycastDown/distance', Math.abs((origin.y - down.point.y) - down.distance) < 1e-3,
      `dist=${down.distance.toFixed(4)} vs dy=${(origin.y - down.point.y).toFixed(4)}`);
    add('raycastDown/friction', down.friction > 0 && down.friction <= 2, `mu=${down.friction}`);

    // 2. the generic ray must agree with the specialised one
    const gen = collision.raycast(origin, new THREE.Vector3(0, -1, 0), 400);
    add('raycast/agrees', !!gen && Math.abs(gen.distance - down.distance) < 1e-3,
      gen ? `generic=${gen.distance.toFixed(4)}` : 'generic ray missed');

    // 3. a ray fired away from everything must miss
    const away = collision.raycast(new THREE.Vector3(centre.x, top + 500, centre.z),
      new THREE.Vector3(0, 1, 0), 100);
    add('raycast/miss', away === null, 'upward ray from far above returns null');

    // 4. a sphere sitting well below the surface must report penetration
    const sunk = new THREE.Vector3(down.point.x, down.point.y - 0.15, down.point.z);
    const sweep = collision.sweepSphere(sunk, sunk, 0.5);
    add('sweepSphere/penetrates', !!sweep && sweep.depth > 0,
      sweep ? `depth=${sweep.depth.toFixed(3)} n.y=${sweep.normal.y.toFixed(2)}` : 'no contact under the surface');

    // 5. a sphere far out in the open must not
    const clear = new THREE.Vector3(centre.x, top + 200, centre.z);
    add('sweepSphere/clear', collision.sweepSphere(clear, clear, 0.5) === null, 'empty air returns null');
  }

  // 6. rails: nearest lookup and the parameterisation must round-trip
  const rails = typeof collision.railList === 'function' ? collision.railList() : [];
  if (rails.length) {
    const probe = collision.railPointAt(rails[0], 0.37, new THREE.Vector3());
    const near = collision.nearestRail(probe, 1.0, null);
    add('nearestRail/finds', !!near, near ? `d=${near.distance.toFixed(4)} t=${near.t.toFixed(4)}` : 'probe point found no rail');
    if (near) {
      const back = collision.railPointAt(near.rail, near.t, new THREE.Vector3());
      add('rail/roundtrip', back.distanceTo(probe) < 0.05, `err=${back.distanceTo(probe).toFixed(4)} m`);
      add('rail/tangent', Math.abs(near.tangent.length() - 1) < 1e-3, `|T|=${near.tangent.length().toFixed(5)}`);
    }
    // tangent continuity across a joint
    const t1 = collision.railTangentAt(rails[0], 0.5, new THREE.Vector3());
    const t2 = collision.railTangentAt(rails[0], 0.5005, new THREE.Vector3());
    add('rail/continuity', t1.dot(t2) > 0.99, `dot=${t1.dot(t2).toFixed(5)}`);

    // velocity cone: aligned travel is accepted; whatever a perpendicular
    // velocity finds must still honour the 50 deg gate against that velocity.
    const tan = collision.railTangentAt(rails[0], 0.37, new THREE.Vector3());
    const aligned = collision.nearestRail(probe, 1.0, tan.clone().multiplyScalar(8));
    add('nearestRail/aligned', !!aligned, aligned ? `t=${aligned.t.toFixed(4)}` : 'aligned velocity rejected');

    let perp = new THREE.Vector3(-tan.z, 0, tan.x);
    if (perp.lengthSq() < 1e-6) perp.set(1, 0, 0).cross(tan);
    perp.normalize().multiplyScalar(8);
    const off = collision.nearestRail(probe, 1.0, perp);
    const gate = Math.cos(50 * Math.PI / 180);
    add('nearestRail/cone', !off || Math.abs(off.tangent.dot(perp.clone().normalize())) >= gate - 1e-3,
      off ? `off-axis result dot=${off.tangent.dot(perp.clone().normalize()).toFixed(3)}` : 'perpendicular velocity rejected');
  } else {
    add('rails', true, 'no rails supplied — skipped');
  }

  // 7. query cost
  if (b) {
    const n = 200;
    const p = new THREE.Vector3();
    const t0 = (typeof performance !== 'undefined' ? performance.now() : 0);
    for (let i = 0; i < n; i++) {
      p.set(b.min.x + (b.max.x - b.min.x) * ((i * 0.618) % 1), top, b.min.z + (b.max.z - b.min.z) * ((i * 0.377) % 1));
      collision.raycastDown(p, 60);
    }
    const per = ((typeof performance !== 'undefined' ? performance.now() : 0) - t0) / n;
    add('perf/raycastDown', per < 0.2, `${per.toFixed(4)} ms per query`);
  }

  const ok = checks.every((c) => c.ok);
  return { ok, checks };
}

export default createCollision;
