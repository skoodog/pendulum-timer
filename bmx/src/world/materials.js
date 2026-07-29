// Procedural PBR material library. Everything here is generated on the CPU at load
// time from deterministic value-noise / Worley fields (mathx.rng) — zero external
// assets, zero fetches.
//
// ---------------------------------------------------------------------------
// TEXEL DENSITY CONVENTION  (read this before texturing anything in park.js)
// ---------------------------------------------------------------------------
// *Geometry UVs are authored in METRES*: 1 UV unit == 1 world metre.
// Each material declares how many metres one texture tile covers
// (`material.userData.tileMeters`) and its textures are pre-set to
// `repeat = 1 / tileMeters`. So a 12 m x 6 m slab just needs uv = (x, z) in
// metres and the texel density comes out constant (~256 px/m) everywhere,
// on every surface, with no per-mesh tuning.
//
// Helpers exported on the library for that:
//   uvFromPlane(geometry, 'x', 'z', ou, ov)  — planar metre-UVs from positions
//   uvBox(geometry)                          — per-triangle dominant-axis projection
//                                              (triplanar-ish, for extruded/lathed shapes)
//   uvScaleGeometry(geometry, su, sv)        — multiply existing UVs
//   setUvScale(material, metresPerTile)      — change the physical tile size of a
//                                              material (clones its textures first)
//   variant(name, opts)                      — cached clone (tile / colour / rough)
//   tint(name, colour, opts)                 — cached colourway clone
//
// Large surfaces additionally get `applyMacroVariation()`: a world-space
// three-octave noise injected into the shader that breaks up tile repetition
// far beyond the texture period, on albedo AND roughness.
//
// Anything that stands on the plaza also gets `applyGroundBounce()`: a
// contact-occlusion + warm-bounce term keyed off world height and how much the
// face is turned away from up. Horizontal surfaces are untouched; a 3 m ramp
// transition runs dark at the flat bottom and lifts toward the coping, which is
// the value gradient that makes a curved surface read as curved.

import * as THREE from 'three';
import {
  rng, rand, clamp, lerp, smoothstep, seed as reseed, hash2, fbm2,
} from '../core/mathx.js';

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// deterministic seamless noise bank
// ---------------------------------------------------------------------------

/** Periodic lattice of random values; row/col f duplicates 0 so the field wraps. */
function makeLattice(f) {
  const s = f + 1;
  const L = new Float32Array(s * s);
  for (let y = 0; y < f; y++) {
    for (let x = 0; x < f; x++) L[y * s + x] = rng();
  }
  for (let y = 0; y < f; y++) L[y * s + f] = L[y * s];
  for (let x = 0; x <= f; x++) L[f * s + x] = L[x];
  return L;
}

/** Seamless fBm value-noise field, res² floats in 0..1. */
function noiseField(res, baseFreq, octaves = 4, gain = 0.5) {
  const out = new Float32Array(res * res);
  const cell = new Int32Array(res);      // lattice cell per texel (same for rows/cols)
  const weight = new Float32Array(res);  // smoothstepped interpolant per texel
  let amp = 1, norm = 0, f = baseFreq;
  for (let o = 0; o < octaves; o++) {
    if (f >= res) break;
    const L = makeLattice(f);
    const stride = f + 1;
    const scale = f / res;
    for (let i = 0; i < res; i++) {
      const p = i * scale;
      const p0 = p | 0;
      const t = p - p0;
      cell[i] = p0;
      weight[i] = t * t * (3 - 2 * t);
    }
    for (let y = 0; y < res; y++) {
      const r0 = cell[y] * stride, r1 = r0 + stride;
      const ty = weight[y];
      const row = y * res;
      for (let x = 0; x < res; x++) {
        const x0 = cell[x], tx = weight[x];
        const a = L[r0 + x0], b = L[r0 + x0 + 1];
        const c = L[r1 + x0], d = L[r1 + x0 + 1];
        const top = a + (b - a) * tx;
        out[row + x] += amp * (top + ((c + (d - c) * tx) - top) * ty);
      }
    }
    norm += amp;
    amp *= gain;
    f *= 2;
  }
  const inv = 1 / norm;
  for (let i = 0; i < out.length; i++) out[i] *= inv;
  return out;
}

/**
 * Seamless Worley/cellular field.
 * d1      = distance to nearest feature point (aggregate, pebbles, pores)
 * d2 - d1 = polygon edge distance (crack networks, patch seams)
 * id      = per-cell random 0..1 (per-stone / per-patch variation)
 */
function worleyField(res, cells) {
  const n = cells * cells;
  const px = new Float32Array(n), py = new Float32Array(n), pid = new Float32Array(n);
  for (let i = 0; i < n; i++) { px[i] = rng(); py[i] = rng(); pid[i] = rng(); }

  const d1 = new Float32Array(res * res);
  const d2 = new Float32Array(res * res);
  const id = new Float32Array(res * res);
  const cs = res / cells;               // integer: both are powers of two
  const invCs = 1 / cs;

  // absolute feature-point positions, in texels
  const fxs = new Float32Array(n), fys = new Float32Array(n);
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      const k = cy * cells + cx;
      fxs[k] = (cx + px[k]) * cs;
      fys[k] = (cy + py[k]) * cs;
    }
  }

  // walk cell by cell so the 9 candidate points are hoisted out of the pixel loop
  const nx = new Float64Array(9), ny = new Float64Array(9), nid = new Float64Array(9);
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      let c = 0;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          let gx = cx + ox, gy = cy + oy, sx = 0, sy = 0;
          if (gx < 0) { gx += cells; sx = -res; } else if (gx >= cells) { gx -= cells; sx = res; }
          if (gy < 0) { gy += cells; sy = -res; } else if (gy >= cells) { gy -= cells; sy = res; }
          const k = gy * cells + gx;
          nx[c] = fxs[k] + sx; ny[c] = fys[k] + sy; nid[c] = pid[k];
          c++;
        }
      }
      const x0 = cx * cs, y0 = cy * cs;
      for (let y = y0; y < y0 + cs; y++) {
        const row = y * res;
        for (let x = x0; x < x0 + cs; x++) {
          let b1 = 1e18, b2 = 1e18, bid = 0;
          for (let j = 0; j < 9; j++) {
            const dx = x - nx[j], dy = y - ny[j];
            const d = dx * dx + dy * dy;
            if (d < b1) { b2 = b1; b1 = d; bid = nid[j]; }
            else if (d < b2) { b2 = d; }
          }
          const i = row + x;
          d1[i] = Math.sqrt(b1) * invCs;
          d2[i] = Math.sqrt(b2) * invCs;
          id[i] = bid;
        }
      }
    }
  }
  return { d1, d2, id, cells };
}

/** Per-resolution cache so 20 materials share ~10 noise fields. */
function createBank(res) {
  const cache = new Map();
  return {
    res,
    field(freq, oct = 4, gain = 0.5) {
      const k = `f${freq}_${oct}_${gain}`;
      let v = cache.get(k);
      if (!v) { v = noiseField(res, freq, oct, gain); cache.set(k, v); }
      return v;
    },
    worley(cells) {
      // snap to a power of two so the cell size divides the texture exactly
      const c = 1 << Math.max(1, Math.round(Math.log2(cells)));
      const k = `w${c}`;
      let v = cache.get(k);
      if (!v) { v = worleyField(res, c); cache.set(k, v); }
      return v;
    },
    clear() { cache.clear(); },
  };
}

// ---------------------------------------------------------------------------
// scratch buffers (reused between materials of the same resolution)
// ---------------------------------------------------------------------------

const scratchPool = new Map();

function getScratch(res) {
  let s = scratchPool.get(res);
  if (!s) {
    const n = res * res;
    s = {
      res,
      H: new Float32Array(n),   // height field, 0..1
      R: new Float32Array(n),   // albedo (sRGB display values)
      G: new Float32Array(n),
      B: new Float32Array(n),
      Q: new Float32Array(n),   // roughness
      M: new Float32Array(n),   // metalness
      O: new Float32Array(n),   // extra AO multiplier (baked crevices)
      A: new Float32Array(n),   // alpha
      T0: new Float32Array(n), T1: new Float32Array(n), T2: new Float32Array(n),
    };
    scratchPool.set(res, s);
  }
  s.H.fill(0.5); s.R.fill(0.5); s.G.fill(0.5); s.B.fill(0.5);
  s.Q.fill(0.8); s.M.fill(0); s.O.fill(1); s.A.fill(1);
  return s;
}

/** Separable box blur with wrap-around, O(px) regardless of radius. */
function boxBlurWrap(src, dst, res, r, tmp) {
  const m = res - 1;
  const inv = 1 / (r * 2 + 1);
  for (let y = 0; y < res; y++) {
    const row = y * res;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[row + (k & m)];
    for (let x = 0; x < res; x++) {
      tmp[row + x] = sum * inv;
      sum += src[row + ((x + r + 1) & m)] - src[row + ((x - r) & m)];
    }
  }
  // vertical pass with a per-column accumulator, so memory stays row-major
  const acc = new Float32Array(res);
  for (let k = -r; k <= r; k++) {
    const row = (k & m) * res;
    for (let x = 0; x < res; x++) acc[x] += tmp[row + x];
  }
  for (let y = 0; y < res; y++) {
    const out = y * res;
    for (let x = 0; x < res; x++) dst[out + x] = acc[x] * inv;
    const addRow = ((y + r + 1) & m) * res, subRow = ((y - r) & m) * res;
    for (let x = 0; x < res; x++) acc[x] += tmp[addRow + x] - tmp[subRow + x];
  }
}

// ---------------------------------------------------------------------------
// height -> normal (sobel) + cavity AO + byte packing
// ---------------------------------------------------------------------------

const toByte = (v) => (v <= 0 ? 0 : v >= 1 ? 255 : (v * 255 + 0.5) | 0);

/**
 * Packs the scratch buffers into three textures:
 *   map     RGBA sRGB  (albedo + alpha)
 *   normal  RGBA lin   (sobel of the height field, physical slope units)
 *   orm     RGBA lin   (R = AO, G = roughness, B = metalness)
 */
function packMaps(res, S, opt, aniso) {
  const n = res * res;
  const m = res - 1;
  const color = new Uint8Array(n * 4);
  const nrm = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const H = S.H;

  // cavity AO from two blur scales of the height field
  boxBlurWrap(H, S.T0, res, Math.max(2, res >> 6), S.T2);
  boxBlurWrap(H, S.T1, res, 2, S.T2);
  const aoK = opt.aoStrength ?? 5.5;

  // sobel slope: dH * heightMetres / (tileMetres / res)  => dimensionless gradient
  const k = (opt.heightMetres ?? 0.005) * res / opt.tileU * (opt.normalBoost ?? 1);

  for (let y = 0; y < res; y++) {
    const ym = ((y - 1) & m) * res, yp = ((y + 1) & m) * res, y0 = y * res;
    for (let x = 0; x < res; x++) {
      const i = y0 + x;
      const xm = (x - 1) & m, xp = (x + 1) & m;

      const h00 = H[ym + xm], h10 = H[ym + x], h20 = H[ym + xp];
      const h01 = H[y0 + xm], h21 = H[y0 + xp];
      const h02 = H[yp + xm], h12 = H[yp + x], h22 = H[yp + xp];

      const gx = ((h20 + 2 * h21 + h22) - (h00 + 2 * h01 + h02)) * 0.125;
      const gy = ((h02 + 2 * h12 + h22) - (h00 + 2 * h10 + h20)) * 0.125;

      const nx = -gx * k, ny = -gy * k;
      const invLen = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      const o = i * 4;
      nrm[o] = toByte(nx * invLen * 0.5 + 0.5);
      nrm[o + 1] = toByte(ny * invLen * 0.5 + 0.5);
      nrm[o + 2] = toByte(invLen * 0.5 + 0.5);
      nrm[o + 3] = 255;

      const cav = (S.T0[i] * 0.62 + S.T1[i] * 0.38) - H[i];
      let ao = 1 - clamp(cav * aoK, 0, 1) * 0.92;
      ao *= S.O[i];

      color[o] = toByte(S.R[i]);
      color[o + 1] = toByte(S.G[i]);
      color[o + 2] = toByte(S.B[i]);
      color[o + 3] = toByte(S.A[i]);

      orm[o] = toByte(ao);
      orm[o + 1] = toByte(S.Q[i]);
      orm[o + 2] = toByte(S.M[i]);
      orm[o + 3] = 255;
    }
  }

  return {
    map: makeTexture(color, res, true, aniso, opt.tileU, opt.tileV),
    normal: makeTexture(nrm, res, false, aniso, opt.tileU, opt.tileV),
    orm: makeTexture(orm, res, false, aniso, opt.tileU, opt.tileV),
  };
}

function makeTexture(data, res, srgb, aniso, tileU, tileV) {
  const t = new THREE.DataTexture(data, res, res, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = aniso;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.channel = 0;                       // aoMap samples uv0 as well
  t.repeat.set(1 / tileU, 1 / tileV);
  t.needsUpdate = true;
  return t;
}

/** Countersunk screw / bolt head stamped into the scratch buffers. */
function stampScrew(S, res, cx, cy, r, opt = {}) {
  const m = res - 1;
  const tone = opt.tone ?? 0.40;
  const rough = opt.rough ?? 0.38;
  const metal = opt.metal ?? 1;
  const cross = opt.cross !== false;
  const outer = r + 3;
  for (let dy = -outer; dy <= outer; dy++) {
    const yy = ((cy + dy) & m) * res;
    for (let dx = -outer; dx <= outer; dx++) {
      const d2 = dx * dx + dy * dy;
      if (d2 > outer * outer) continue;
      const i = yy + ((cx + dx) & m);
      const d = Math.sqrt(d2);
      if (d <= r) {
        const t = d / r;
        let h = 0.5 - 0.34 * (1 - t * t);
        const w = Math.max(1, r * 0.16);
        if (cross && d < r * 0.74 && (Math.abs(dx) < w || Math.abs(dy) < w)) h -= 0.26;
        S.H[i] = h;
        const sh = 0.82 + 0.34 * (1 - t) + (S.R[i] - 0.5) * 0.1;
        S.R[i] = tone * sh;
        S.G[i] = tone * sh * 1.02;
        S.B[i] = tone * sh * 1.07;
        S.Q[i] = rough + t * 0.14;
        S.M[i] = metal;
        S.O[i] = 0.72 + 0.28 * t;
      } else {
        const t = clamp((d - r) / 3, 0, 1);
        S.O[i] *= lerp(0.58, 1, t);
        S.H[i] -= (1 - t) * 0.05;
        S.Q[i] = clamp(S.Q[i] + (1 - t) * 0.12, 0, 1);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// generators — each fills the scratch buffers for one material
// ---------------------------------------------------------------------------
// `at(field, x, y)` wraps, and *integer* coordinate scaling / offsetting keeps a
// field seamless, so generators can stretch, warp and decorrelate the shared
// fields for free.

function makeSampler(res) {
  const m = res - 1;
  return (f, x, y) => f[((y & m) * res) + (x & m)];
}

/** Deterministic integer offsets, used to decorrelate the shared fields. */
function offs(res) {
  return [(rng() * res) | 0, (rng() * res) | 0];
}

// --- concrete: power-troweled plaza slab, sawn control joints ---------------
// This is the single largest surface in the game and the one the ground-detail
// camera sits 30 cm above, so it is authored at 2048² over a 3.0 m tile
// (≈680 px/m). The layers, in the order a real slab acquires them:
//
//   pour       graded aggregate under a cream layer, air voids, trowel arcs
//   cut        the sawn control-joint grid at 1.5 m centres (= half the tile),
//              with a kerf, a rounded/chipped arris and patchy sealant
//   age        a crack network on a *different* period to the joint grid, plus
//              hairlines spalling off the joint shoulders
//   use        oil, tyre rubber, grit banked into the joints, damp low spots
//
// Nothing except the joint grid is on a frequency that divides the tile, and the
// aggregate is packed (one stone per ~23 mm cell, radius driven by the cell id)
// rather than a sparse dot per cell — sparse lattice dots are what produced the
// marching speckle grid in the first ground-detail pass.
function genConcrete(res, S, bank) {
  const at = makeSampler(res);
  const m = res - 1;
  const macro = bank.field(2, 3);
  const blotch = bank.field(5, 4);
  const swirl = bank.field(11, 3);
  const mid = bank.field(23, 4);
  const fine = bank.field(89, 3);
  const agg = bank.worley(128);          // ≈23 mm cells -> coarse aggregate + voids
  const net = bank.worley(16);           // ≈19 cm cells -> crack polygons
  const [ox1, oy1] = offs(res), [ox2, oy2] = offs(res);
  const [ox3, oy3] = offs(res), [ox4, oy4] = offs(res);

  const half = res >> 1;                            // joint pitch = tile / 2
  const kerfW = Math.max(1.5, res * 0.0016);        // sawn kerf half-width (~5 mm)
  const arrisW = Math.max(5, res * 0.0090);         // rounded shoulder (~27 mm)
  const amp = res * 0.055;

  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const i = y * res + x;

      const mc = at(macro, x, y);
      const mc2 = at(macro, (x + ox4) * 2, (y + oy4) * 2);
      const bl = at(blotch, x + ox1, y + oy1);
      const bl2 = at(blotch, (x + ox2) * 2, y + oy3);
      const grain = at(fine, x + ox3, y);
      const grit = at(fine, (x + oy2) * 3, (y + ox1) * 3);

      // --- power-trowel arcs: domain-warped, laterally stretched ----------
      const wx = ((at(swirl, x + ox1, y + oy1) - 0.5) * amp) | 0;
      const wy = ((at(swirl, x + ox2, y + oy2) - 0.5) * amp) | 0;
      const sheen = at(mid, (x + wx) * 3, y + wy) * 0.6
        + at(mid, x + wy, (y + wx) * 3 + oy3) * 0.4;

      // --- graded aggregate: packed stones, per-stone size/colour/gloss ----
      const sid = agg.id[i];
      const sRad = 0.24 + sid * 0.32;
      const sd = agg.d1[i];
      // flat-topped stone body (each cell keeps its own colour across its whole
      // face) plus a separately rounded dome for the height field
      const stone = smoothstep(clamp((sRad - sd) * 7.0, 0, 1));
      const tS = sd < sRad ? sd / sRad : 1;
      const dome = 1 - tS * tS;
      // the noise fields sit tight around 0.5, so the wear threshold is set on
      // their real distribution: ~20% of the slab is worn to open aggregate and
      // the rest still ghosts the stones through the cream
      const worn = smoothstep(clamp((mc * 0.6 + mc2 * 0.4 - 0.470) * 9.0, 0, 1));
      const exposed = stone * (0.36 + worn * 0.64);

      // --- air voids: irregular blobs off a high-frequency field -----------
      const pv = at(fine, (x + ox4) * 4, (y + oy1) * 4);
      const pin = smoothstep(clamp((pv - 0.78) * 7.0, 0, 1));

      // --- sawn control joints --------------------------------------------
      const jitU = (at(mid, x + ox3, (y + oy1) * 2) - 0.5) * res * 0.0030;
      const jitV = (at(mid, (x + ox1) * 2, y + oy3) - 0.5) * res * 0.0030;
      const ux = x % half, vy = y % half;
      const du = Math.abs(Math.min(ux, half - ux) + jitU);
      const dv = Math.abs(Math.min(vy, half - vy) + jitV);
      const jd = Math.min(du, dv);
      const kerf = clamp(1 - jd / kerfW, 0, 1);
      const shoulder = clamp(1 - jd / arrisW, 0, 1);
      const shoulder2 = shoulder * shoulder;
      // chipped arris: the aggregate cells scallop the edge of the cut
      const chip = shoulder * (1 - kerf) * smoothstep(clamp((sid - 0.56) * 3.2, 0, 1));
      // elastomeric sealant, present along some runs of joint and not others
      const seal = kerf * smoothstep(clamp((at(blotch, (x + oy1) * 3, (y + ox2) * 3) - 0.44) * 3.6, 0, 1));

      // --- crack network, decoupled from the joint pitch --------------------
      const cwx = (x + (((at(swirl, x + ox2, y) - 0.5) * res * 0.020) | 0)) & m;
      const cwy = (y + (((at(swirl, x, y + oy2) - 0.5) * res * 0.020) | 0)) & m;
      const ci = cwy * res + cwx;
      let crack = clamp(1 - (net.d2[ci] - net.d1[ci]) * 26, 0, 1);
      crack *= smoothstep(clamp((bl2 - 0.56) * 5.0, 0, 1))
        * smoothstep(clamp((at(swirl, (x + oy3) * 2, y + ox4) - 0.30) * 3.0, 0, 1));
      crack *= crack;
      crack = Math.max(crack, shoulder2 * smoothstep(clamp((grit - 0.70) * 6.0, 0, 1)) * 0.75);

      // --- height ----------------------------------------------------------
      let h = 0.62 + (sheen - 0.5) * 0.15 + (grain - 0.5) * 0.09
        + dome * (0.09 + worn * 0.17) - pin * 0.40 - crack * 0.42
        - kerf * 0.66 - shoulder2 * 0.045 - chip * 0.12;
      h += seal * 0.44;                       // sealant fills the kerf near flush

      // --- albedo -----------------------------------------------------------
      // cement colour is never uniform: laitance, pour-to-pour tone and dust
      // give it a broad warm/cool swing on top of the fine grain
      const tone = (mc - 0.5) * 0.135 + (mc2 - 0.5) * 0.080 + (bl - 0.5) * 0.075;
      const warmth = (bl2 - 0.5) * 0.055;
      let r = 0.532 + tone + warmth + (grain - 0.5) * 0.075 + (sheen - 0.5) * 0.065;
      let g = 0.522 + tone + warmth * 0.55 + (grain - 0.5) * 0.071 + (sheen - 0.5) * 0.065;
      let b = 0.495 + tone * 0.86 - warmth * 0.35 + (grain - 0.5) * 0.067 + (sheen - 0.5) * 0.065;
      let q = clamp(0.68 - smoothstep(clamp((sheen - 0.44) * 2.6, 0, 1)) * 0.16
        + (grain - 0.5) * 0.10, 0.20, 1);

      // exposed stone: granite grey through to warm limestone, and it polishes
      const stoneR = lerp(0.300, 0.680, sid), stoneG = lerp(0.296, 0.632, sid);
      const stoneB = lerp(0.290, 0.548, sid);
      const em = clamp(exposed, 0, 1);
      r = lerp(r, stoneR, em * 0.80); g = lerp(g, stoneG, em * 0.80); b = lerp(b, stoneB, em * 0.80);
      q = lerp(q, 0.40 + sid * 0.36, em * 0.7);

      // air voids read as dark pits with a matte, dusty interior
      r -= pin * 0.135; g -= pin * 0.133; b -= pin * 0.126;
      q = clamp(q + pin * 0.20, 0, 1);

      // grit and blown leaf litter bank up against the joint shoulders
      const bank2 = shoulder2 * (1 - kerf) * smoothstep(clamp((bl2 - 0.34) * 2.2, 0, 1));
      r = lerp(r, 0.305, bank2 * 0.55); g = lerp(g, 0.268, bank2 * 0.55); b = lerp(b, 0.212, bank2 * 0.55);
      q = clamp(q + bank2 * 0.16, 0, 1);

      // the open kerf is a dark slot; sealed runs are near-black rubber
      const open = kerf * (1 - seal);
      r = lerp(r, 0.128, open * 0.86); g = lerp(g, 0.124, open * 0.86); b = lerp(b, 0.118, open * 0.86);
      r = lerp(r, 0.098, seal * 0.92); g = lerp(g, 0.095, seal * 0.92); b = lerp(b, 0.097, seal * 0.92);
      q = lerp(q, 0.94, open * 0.7);
      q = lerp(q, 0.46, seal * 0.85);

      // cracks: dark, with a little rust-brown bleed where water has sat
      const rust = crack * smoothstep(clamp((bl - 0.58) * 4.0, 0, 1));
      const cd = crack * 0.72;
      r = r * (1 - cd) + 0.36 * rust * 0.35;
      g = g * (1 - cd) + 0.22 * rust * 0.35;
      b = b * (1 - cd) + 0.13 * rust * 0.35;
      q = clamp(q + crack * 0.14, 0, 1);

      // oil / gearbox drips: dark, glossy, decoupled blotches
      const oil = smoothstep(clamp((at(blotch, (x + ox4) * 2 + oy2, y + ox3) - 0.70) * 5.5, 0, 1))
        * smoothstep(clamp((mc2 - 0.30) * 2.2, 0, 1));
      r = lerp(r, 0.108, oil * 0.85); g = lerp(g, 0.098, oil * 0.85); b = lerp(b, 0.096, oil * 0.85);
      q = lerp(q, 0.24, oil * 0.8);

      // tyre rubber: stretched, near-black, burnished smooth
      const scuff = smoothstep(clamp((at(swirl, x + ox3, (y + oy4) * 5) - 0.62) * 5.0, 0, 1))
        * smoothstep(clamp((mc - 0.34) * 2.6, 0, 1)) * (1 - open);
      r = lerp(r, 0.086, scuff * 0.62); g = lerp(g, 0.084, scuff * 0.62); b = lerp(b, 0.086, scuff * 0.62);
      q = lerp(q, 0.34, scuff * 0.55);

      // damp low spots: the slab dishes between joints and water sits there.
      // Roughness collapses so those patches mirror the sky, as the reference
      // frame demands, and the albedo darkens the way wet cement does.
      const lowF = at(blotch, (x + wx + ox2) * 2, (y + wy + oy1) * 2) * 0.60
        + at(macro, x + ox4, y) * 0.40;
      const dampMask = smoothstep(clamp((0.472 - lowF) * 13.0, 0, 1));
      const wet = clamp(dampMask * 1.2 - clamp((h - 0.58) * 2.4, 0, 1), 0, 1) * (1 - open * 0.5);
      const wet2 = wet * wet;
      const wetA = wet2 * 0.85 + wet * 0.15;
      r = lerp(r, r * 0.68, wetA); g = lerp(g, g * 0.68, wetA); b = lerp(b, b * 0.71, wetA);
      q = lerp(q, 0.085, wet2);

      S.H[i] = h;
      S.R[i] = r; S.G[i] = g; S.B[i] = b;
      S.Q[i] = clamp(q, 0.055, 1);
      S.O[i] = (1 - open * 0.80) * (1 - crack * 0.55) * (1 - pin * 0.55)
        * (1 - shoulder2 * 0.14) * (1 - em * 0.10);
    }
  }
}

// --- concreteWorn: cracked, patched, stained, tyre-marked -------------------
// Used for the poured transitions and every park ledge, so it carries the same
// aggregate/void/wear layering as the slab but no sawn joint grid (a transition
// is screeded in one pour), plus repair patches and a heavier tyre history.
function genConcreteWorn(res, S, bank) {
  const at = makeSampler(res);
  const m = res - 1;
  const macro = bank.field(2, 3);
  const blotch = bank.field(6, 4);
  const streak = bank.field(12, 4);
  const mid = bank.field(24, 4);
  const fine = bank.field(96, 3);
  const agg = bank.worley(128);
  const netF = bank.worley(32);
  const patch = bank.worley(8);
  const [ox1, oy1] = offs(res), [ox2, oy2] = offs(res), [ox3, oy3] = offs(res);
  const amp = res * 0.05;

  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const i = y * res + x;
      const wx = ((at(streak, x + ox1, y + oy1) - 0.5) * amp) | 0;
      const wy = ((at(streak, x + ox2, y + oy2) - 0.5) * amp) | 0;
      const sheen = at(mid, (x + wx) * 2, y + wy);
      const grain = at(fine, x + ox3, y + oy3);
      const mc = at(macro, x, y);
      const mc2 = at(macro, (x + oy1) * 2, (y + ox2) * 2);
      const st = at(blotch, x + ox3, y + oy1);

      // repair patches: a handful of cells are a different mix, outlined by the
      // saw-cut seam. Untouched cells get no seam at all, so no honeycomb.
      const pid = patch.id[i];
      const isPatch = smoothstep(clamp((pid - 0.62) * 5.5, 0, 1));
      const seam = clamp(1 - (patch.d2[i] - patch.d1[i]) * 11, 0, 1) * isPatch;
      const patchTone = (pid - 0.72) * 0.16 * isPatch;
      const patchRough = (pid - 0.72) * 0.34 * isPatch;

      // crack network: warped Worley edges, thin and deep
      const cwx = (x + (((at(streak, x + ox2, y) - 0.5) * res * 0.02) | 0)) & m;
      const cwy = (y + (((at(streak, x, y + oy2) - 0.5) * res * 0.02) | 0)) & m;
      const ci = cwy * res + cwx;
      let crack = clamp(1 - (netF.d2[ci] - netF.d1[ci]) * 20, 0, 1);
      // only a few joints have actually opened up, and they fade along their length
      crack *= smoothstep(clamp((at(blotch, x + ox1, y + ox2) - 0.66) * 7.0, 0, 1))
        * smoothstep(clamp((at(streak, (x + oy2) * 2, y + ox1) - 0.30) * 3.0, 0, 1));
      crack = crack * crack;

      // graded aggregate: packed stones sized by their own cell id, exposed
      // where the cream has worn or spalled through
      const sid = agg.id[i];
      const sRad = 0.26 + sid * 0.30;
      const sd = agg.d1[i];
      const stone = smoothstep(clamp((sRad - sd) * 7.0, 0, 1));
      const tS = sd < sRad ? sd / sRad : 1;
      const dome = 1 - tS * tS;
      const spallMask = smoothstep(clamp((mc * 0.65 + mc2 * 0.35 - 0.485) * 8.0, 0, 1));
      const spall = stone * (0.34 + spallMask * 0.66);

      // air voids: irregular blobs, never a lattice
      const pin = smoothstep(clamp((at(fine, (x + oy2) * 4, (y + ox1) * 4) - 0.78) * 7.0, 0, 1));

      S.H[i] = 0.58 + (sheen - 0.5) * 0.20 + (grain - 0.5) * 0.15
        + patchTone * 0.6 + dome * (0.10 + spallMask * 0.16)
        - pin * 0.38 - crack * 0.55 - seam * 0.14;

      const damp = smoothstep(clamp((st - 0.5) * 3.0, 0, 1));
      let r = 0.455 + patchTone + (mc - 0.5) * 0.105 + (grain - 0.5) * 0.055 - damp * 0.095;
      let g = 0.447 + patchTone + (mc - 0.5) * 0.100 + (grain - 0.5) * 0.053 - damp * 0.092;
      let b = 0.427 + patchTone + (mc - 0.5) * 0.088 + (grain - 0.5) * 0.050 - damp * 0.076;
      let q = clamp(0.76 + patchRough + (grain - 0.5) * 0.14
        - smoothstep(clamp((sheen - 0.45) * 2.4, 0, 1)) * 0.16 + damp * 0.05, 0.10, 1);

      // exposed aggregate reads warmer, speckled and a touch glossier
      r = lerp(r, lerp(0.285, 0.640, sid), spall * 0.78);
      g = lerp(g, lerp(0.278, 0.592, sid), spall * 0.78);
      b = lerp(b, lerp(0.272, 0.512, sid), spall * 0.78);
      q = lerp(q, 0.42 + sid * 0.34, spall * 0.65);

      // air voids: dark, dusty pits
      r -= pin * 0.125; g -= pin * 0.122; b -= pin * 0.116;
      q = clamp(q + pin * 0.18, 0, 1);

      // oil / grease blotches — dark, glossy
      const oil = smoothstep(clamp((at(blotch, x + ox2, y + oy3) - 0.66) * 5.0, 0, 1))
        * smoothstep(clamp((mc - 0.30) * 2.0, 0, 1));
      r = lerp(r, 0.115, oil * 0.85); g = lerp(g, 0.104, oil * 0.85); b = lerp(b, 0.100, oil * 0.85);

      // rust bleed out of the cracks
      const rust = crack * smoothstep(clamp((at(blotch, x + oy1, y + ox3) - 0.55) * 4, 0, 1));
      r = lerp(r, 0.40, rust * 0.55); g = lerp(g, 0.24, rust * 0.55); b = lerp(b, 0.14, rust * 0.55);

      // black tyre scuffs — stretched streaks, very smooth
      const scuff = smoothstep(clamp((at(streak, x + ox1, (y + oy3) * 4) - 0.60) * 5.0, 0, 1))
        * smoothstep(clamp((mc - 0.35) * 3.0, 0, 1));
      r = lerp(r, 0.085, scuff * 0.7); g = lerp(g, 0.082, scuff * 0.7); b = lerp(b, 0.084, scuff * 0.7);

      // damp film in the hollows: dark, and glossy enough to catch the sky
      const lowF = at(macro, x + ox2, y + oy2) * 0.6 + st * 0.4;
      const wet = clamp(smoothstep(clamp((0.475 - lowF) * 12.0, 0, 1)) * 1.15
        - clamp((S.H[i] - 0.58) * 2.4, 0, 1), 0, 1);
      const wetA = wet * wet * 0.85 + wet * 0.15;
      r = lerp(r, r * 0.54, wetA); g = lerp(g, g * 0.54, wetA); b = lerp(b, b * 0.57, wetA);

      const cd = crack * 0.75;
      S.R[i] = r * (1 - cd); S.G[i] = g * (1 - cd); S.B[i] = b * (1 - cd);

      S.Q[i] = clamp(lerp(q - oil * 0.42 - scuff * 0.30 + crack * 0.12, 0.10, wet * wet),
        0.055, 1);
      S.O[i] = (1 - crack * 0.55) * (1 - seam * 0.20) * (1 - pin * 0.5) * (1 - spall * 0.10);
    }
  }
}

// --- asphalt: aggregate, tar seams, optional faded lane line ----------------
function genAsphalt(res, S, bank, opts = {}) {
  const at = makeSampler(res);
  const m = res - 1;
  const macro = bank.field(2, 3);
  const blotch = bank.field(6, 4);
  const mid = bank.field(24, 4);
  const fine = bank.field(96, 3);
  const grit = bank.field(128, 2);
  const agg = bank.worley(128);
  const seams = bank.worley(8);
  const [ox1, oy1] = offs(res), [ox2, oy2] = offs(res), [ox3, oy3] = offs(res);
  const paint = opts.paintLine === true;

  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const i = y * res + x;
      const mc = at(macro, x, y);
      const bl = at(blotch, x + ox1, y + oy1);
      const md = at(mid, x + ox2, y + oy2);
      const fn = at(fine, x + ox3, y + oy3);
      const gr = at(grit, x + oy2, y + ox1);

      // aggregate stones half-embedded in bitumen
      const sd = agg.d1[i];
      const stoneMask = clamp(1 - sd / 0.55, 0, 1);
      const stone = stoneMask * stoneMask * (0.55 + agg.id[i] * 0.45);
      const proud = clamp((mc - 0.35) * 1.8, 0, 1);      // more exposed where worn

      // tar crack-filler seams: raised, near-black, glossy
      const wIdx = (y * res) + ((x + ((((at(mid, x + ox1, y * 3) - 0.5) * res * 0.012) | 0))) & m);
      const edgeA = seams.d2[i] - seams.d1[i];
      const edgeB = seams.d2[wIdx] - seams.d1[wIdx];
      const tar = clamp(1 - Math.min(edgeA, edgeB) * 11, 0, 1);
      // only ~1 joint in 4 was ever crack-sealed
      const tarS = tar * tar * smoothstep(clamp((bl - 0.60) * 5.0, 0, 1));

      let h = 0.42 + stone * proud * 0.34 + (fn - 0.5) * 0.22 + (gr - 0.5) * 0.14
        + (md - 0.5) * 0.10 + tarS * 0.30;
      let r = 0.145 + (md - 0.5) * 0.03, g = 0.148 + (md - 0.5) * 0.03, b = 0.158 + (md - 0.5) * 0.03;

      // stone chips: granite / limestone speckle
      const chip = agg.id[i];
      const chipMix = clamp(stone * (0.35 + proud * 0.85) * (0.55 + fn * 0.6), 0, 1);
      r = lerp(r, lerp(0.235, 0.60, chip), chipMix);
      g = lerp(g, lerp(0.235, 0.59, chip), chipMix);
      b = lerp(b, lerp(0.245, 0.57, chip), chipMix);

      // sun-bleached patches
      const bleach = smoothstep(clamp((mc - 0.5) * 2.6, 0, 1));
      r = lerp(r, r * 1.55 + 0.060, bleach * 0.6);
      g = lerp(g, g * 1.52 + 0.058, bleach * 0.6);
      b = lerp(b, b * 1.45 + 0.055, bleach * 0.6);

      // fresh tar stays black and shiny
      r = lerp(r, 0.055, tarS * 0.9); g = lerp(g, 0.053, tarS * 0.9); b = lerp(b, 0.058, tarS * 0.9);

      let q = clamp(0.90 - bleach * 0.06 + (fn - 0.5) * 0.14 - tarS * 0.42
        - smoothstep(clamp((md - 0.55) * 3, 0, 1)) * 0.12, 0.16, 1);
      const ao = 1 - clamp(1 - sd / 0.35, 0, 1) * 0.12;

      if (paint) {
        // straight, badly worn lane line running along V
        const edge = Math.abs(x / res - 0.5);
        const jitter = (at(fine, x, y * 2) - 0.5) * 0.006;
        let p = clamp((0.055 + jitter - edge) / 0.008, 0, 1);
        p *= smoothstep(clamp((at(blotch, x + ox3, y * 2) - 0.30) * 2.2, 0, 1));
        p *= 0.35 + 0.65 * smoothstep(clamp((at(fine, x * 2, y * 2) - 0.28) * 2.0, 0, 1));
        p *= 1 - tarS * 0.8;
        r = lerp(r, 0.700 * (0.8 + fn * 0.35), p);
        g = lerp(g, 0.685 * (0.8 + fn * 0.35), p);
        b = lerp(b, 0.630 * (0.8 + fn * 0.35), p);
        q = lerp(q, 0.58 + (fn - 0.5) * 0.2, p);
        h += p * 0.05;
      }

      S.H[i] = h; S.R[i] = r; S.G[i] = g; S.B[i] = b; S.Q[i] = q; S.O[i] = ao;
    }
  }
}

// --- plywood / skatelite ramp sheet -----------------------------------------
function genSheet(res, S, bank, opts = {}) {
  const at = makeSampler(res);
  const macro = bank.field(2, 3);
  const grainF = bank.field(2, 3);
  const ringF = bank.field(6, 4);
  const fine = bank.field(96, 3);
  const scuffF = bank.field(12, 4);
  const dust = bank.worley(32);
  const [ox1, oy1] = offs(res), [ox2, oy2] = offs(res), [ox3, oy3] = offs(res);

  const dark = opts.skatelite === true;
  const c0 = dark ? [0.115, 0.098, 0.090] : [0.575, 0.492, 0.372];
  const c1 = dark ? [0.052, 0.045, 0.043] : [0.372, 0.288, 0.208];
  const seamPx = res * 0.006;
  const half = res >> 1;

  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const i = y * res + x;
      // grain runs along V; stretch the field across U for long fibres
      const wob = ((at(scuffF, x + ox1, y + oy1) - 0.5) * res * 0.03) | 0;
      const gv = at(grainF, (x + wob) * 12 + ox2, y + oy2);
      const rv = at(ringF, (x + wob) * 4 + ox3, y);
      const fn = at(fine, x * 3, y + oy3);
      const mc = at(macro, x, y);

      // cathedral rings: banded, high contrast in light wood
      const t = gv * 0.65 + rv * 0.35;
      let ring = Math.abs((t * (dark ? 4 : 9)) % 1 - 0.5) * 2;
      ring = smoothstep(clamp(ring * 1.15 - 0.08, 0, 1));
      const grainMix = clamp(ring * 0.75 + (fn - 0.5) * (dark ? 0.25 : 0.55) + 0.15, 0, 1);

      let r = lerp(c0[0], c1[0], grainMix);
      let g = lerp(c0[1], c1[1], grainMix);
      let b = lerp(c0[2], c1[2], grainMix);
      const tone = (mc - 0.5) * (dark ? 0.04 : 0.11);
      r += tone; g += tone * 0.94; b += tone * 0.84;

      let h = 0.55 - grainMix * 0.12 + (fn - 0.5) * 0.10;
      let q = (dark ? 0.44 : 0.72) + (grainMix - 0.5) * (dark ? 0.06 : 0.16) + (fn - 0.5) * 0.10;

      // sheet seams: vertical at 0 and half, horizontal at 0
      const du = Math.min(Math.min(x, res - x), Math.abs(x - half));
      const dv = Math.min(y, res - y);
      const sd = Math.min(du, dv) - (at(fine, x, y) - 0.5) * 1.5;
      const seam = clamp(1 - sd / seamPx, 0, 1);
      const seamS = seam * seam;
      h -= seamS * 0.40;
      r = lerp(r, r * 0.35, seamS); g = lerp(g, g * 0.34, seamS); b = lerp(b, b * 0.36, seamS);
      q = lerp(q, 0.85, seamS);
      const ao = 1 - seamS * 0.45;

      // wheel-polished scuff bands: abraded, lighter, glossier
      const band = at(scuffF, x + ox3, (y + oy1) * 2);
      const scuff = smoothstep(clamp((band - 0.48) * 3.0, 0, 1))
        * smoothstep(clamp((at(scuffF, x * 2 + oy2, y) - 0.35) * 2.2, 0, 1));
      const wax = scuff * (0.55 + fn * 0.6);
      r = lerp(r, r * 1.22 + 0.045, wax * 0.7);
      g = lerp(g, g * 1.20 + 0.045, wax * 0.7);
      b = lerp(b, b * 1.16 + 0.045, wax * 0.7);
      q = lerp(q, dark ? 0.26 : 0.40, wax * 0.8);
      h += wax * 0.03;

      // grime settling in the low grain
      const dirt = smoothstep(clamp((dust.d1[i] - 0.55) * 2.0, 0, 1)) * (1 - wax);
      r *= 1 - dirt * 0.14; g *= 1 - dirt * 0.15; b *= 1 - dirt * 0.15;

      S.H[i] = h; S.R[i] = r; S.G[i] = g; S.B[i] = b;
      S.Q[i] = clamp(q, 0.12, 1); S.O[i] = ao;
    }
  }

  // deck screws along every seam
  const r0 = Math.max(2, (res * 0.0075) | 0);
  const step = res >> 3;
  for (let k = 0; k < 8; k++) {
    const jy = (k * step + step / 2 + (rng() - 0.5) * 4) | 0;
    stampScrew(S, res, 0, jy, r0, { tone: dark ? 0.30 : 0.38, rough: 0.42 });
    stampScrew(S, res, half, jy, r0, { tone: dark ? 0.30 : 0.38, rough: 0.44 });
    const jx = (k * step + step / 2 + (rng() - 0.5) * 4) | 0;
    stampScrew(S, res, jx, 0, r0, { tone: dark ? 0.30 : 0.38, rough: 0.40 });
  }
}

// --- ramp riding surface: phenolic skate-lite panels ------------------------
// Authored over a 2.44 m tile carrying one 8 ft sheet across U and two 4 ft
// courses up V, i.e. real 1.22 m x 2.44 m panels. The riding face of a ramp is
// the biggest single value in the frame after the sky, so it is deliberately a
// mid-dark grey (sRGB ≈ 0.40, linear ≈ 0.13) rather than the near-black phenolic
// it would be straight out of the wrapper — at that value the panel seams, screw
// rows and tyre history all survive the tonemapper instead of clipping to one
// silhouette.
function genRampPanel(res, S, bank) {
  const at = makeSampler(res);
  const macro = bank.field(2, 3);
  const stainF = bank.field(6, 4);
  const bandF = bank.field(12, 4);
  const midF = bank.field(24, 4);
  const fine = bank.field(96, 3);
  const grit = bank.worley(128);
  const [ox1, oy1] = offs(res), [ox2, oy2] = offs(res), [ox3, oy3] = offs(res);

  const half = res >> 1;                          // 1.22 m course pitch
  const seamW = Math.max(1.2, res * 0.0014);      // ~3 mm butt joint
  const wearW = Math.max(4, res * 0.0078);        // ~19 mm abraded arris

  for (let y = 0; y < res; y++) {
    const vy = y % half;
    const sheet = y < half ? 0.0 : 1.0;           // per-course tone break
    // grime and water always bank at the low edge of a course
    const courseLow = clamp(1 - vy / (half * 0.22), 0, 1);
    for (let x = 0; x < res; x++) {
      const i = y * res + x;
      const mc = at(macro, x, y);
      const fn = at(fine, x + ox3, y) - 0.5;
      const mid = at(midF, x + ox1, y + oy1);
      const stain = at(stainF, x + ox2, y + oy2);

      // --- phenolic face: fine granular grip over a faint fibre undertone --
      const grip = at(fine, (x + ox1) * 3, (y + oy3) * 3) - 0.5;
      const fibre = at(midF, (x + oy2) * 6, y + ox3) - 0.5;
      let h = 0.56 + grip * 0.34 + fn * 0.16 + fibre * 0.06;

      let tone = 0.415 + (mc - 0.5) * 0.075 + (mid - 0.5) * 0.055 + fn * 0.055
        + grip * 0.045 + (sheet - 0.5) * 0.040;
      let r = tone * 1.010, g = tone * 0.982, b = tone * 0.948;
      let q = clamp(0.58 + (mid - 0.5) * 0.16 + fn * 0.12 - grip * 0.10, 0.18, 1);
      let ao = 1;

      // --- butt joints between sheets --------------------------------------
      const du = Math.min(x, res - x) + (at(fine, x, y * 2) - 0.5) * 1.6;
      const dv = Math.min(vy, half - vy) + (at(fine, x * 2, y) - 0.5) * 1.6;
      const d = Math.min(Math.abs(du), Math.abs(dv));
      const core = clamp(1 - d / seamW, 0, 1);
      const arris = clamp(1 - d / wearW, 0, 1);
      // the exposed edge of a panel abrades pale — that is the line that catches
      // the sun and makes the sheet layout readable across a whole ramp
      const edgeWear = arris * (1 - core) * (0.45 + smoothstep(clamp((mc - 0.35) * 2.2, 0, 1)) * 0.55);
      h += arris * (1 - core) * 0.05 - core * 0.52;
      r = lerp(r, 0.545, edgeWear * 0.55); g = lerp(g, 0.520, edgeWear * 0.55); b = lerp(b, 0.487, edgeWear * 0.55);
      q = lerp(q, 0.50, edgeWear * 0.5);
      r = lerp(r, 0.070, core * 0.92); g = lerp(g, 0.068, core * 0.92); b = lerp(b, 0.070, core * 0.92);
      q = lerp(q, 0.88, core * 0.8);
      ao *= 1 - core * 0.62;

      // --- tyre history ------------------------------------------------------
      // broad wheel-polished ride lines running up the transition (V)
      const band = at(bandF, x + ox3, (y + oy1) * 3);
      const polish = smoothstep(clamp((band - 0.46) * 3.2, 0, 1))
        * smoothstep(clamp((at(bandF, (x + oy2) * 2, y) - 0.34) * 2.4, 0, 1));
      r = lerp(r, r * 1.30 + 0.030, polish * 0.75);
      g = lerp(g, g * 1.28 + 0.030, polish * 0.75);
      b = lerp(b, b * 1.24 + 0.028, polish * 0.75);
      q = lerp(q, 0.30, polish * 0.8);
      h += polish * 0.03;

      // hard black rubber laid down where tyres actually bite
      const skid = smoothstep(clamp((at(bandF, x + ox1, (y + oy3) * 6) - 0.62) * 5.2, 0, 1))
        * smoothstep(clamp((mc - 0.32) * 2.6, 0, 1));
      r = lerp(r, 0.088, skid * 0.72); g = lerp(g, 0.086, skid * 0.72); b = lerp(b, 0.090, skid * 0.72);
      q = lerp(q, 0.36, skid * 0.6);

      // --- weather ------------------------------------------------------------
      // water stains streak down V, dust and grit collect at the course joints
      const drip = smoothstep(clamp((at(stainF, (x + oy1) * 3, y + ox2) - 0.55) * 3.6, 0, 1));
      r = lerp(r, r * 0.74, drip * 0.5); g = lerp(g, g * 0.74, drip * 0.5); b = lerp(b, b * 0.78, drip * 0.5);
      q = clamp(q + drip * 0.10, 0, 1);

      const dust = clamp(1 - grit.d1[i] / 0.55, 0, 1) * smoothstep(clamp((stain - 0.42) * 2.4, 0, 1));
      const banked = (courseLow * 0.7 + arris * 0.3) * (1 - core) * (0.35 + dust * 0.65);
      r = lerp(r, 0.318, banked * 0.42); g = lerp(g, 0.292, banked * 0.42); b = lerp(b, 0.248, banked * 0.42);
      q = clamp(q + banked * 0.16, 0, 1);
      ao *= 1 - banked * 0.18;

      S.H[i] = h;
      S.R[i] = r; S.G[i] = g; S.B[i] = b;
      S.Q[i] = clamp(q, 0.16, 1);
      S.O[i] = ao;
    }
  }

  // --- deck screws: 200 mm along every joist line, 400 mm between rows ------
  const r0 = Math.max(2, (res * 0.0034) | 0);
  const cols = 12, rows = 6;
  for (let ry = 0; ry < rows; ry++) {
    const jy = ((ry / rows) * res + (rng() - 0.5) * 3) | 0;
    const onSeam = (ry % (rows >> 1)) === 0;
    for (let cx = 0; cx < cols; cx++) {
      const jx = ((cx / cols) * res + (rng() - 0.5) * 3) | 0;
      stampScrew(S, res, jx, jy, r0, { tone: onSeam ? 0.30 : 0.34, rough: 0.46, metal: 0.9 });
    }
  }
  // the vertical butt joint gets its own screw line
  for (let k = 0; k < rows; k++) {
    const jy = ((k / rows) * res + res / (rows * 2) + (rng() - 0.5) * 3) | 0;
    stampScrew(S, res, 0, jy, r0, { tone: 0.30, rough: 0.48, metal: 0.9 });
  }
}

// --- rough sawn lumber (kicker frames, bleachers, hoardings) ----------------
function genLumber(res, S, bank) {
  const at = makeSampler(res);
  const grainF = bank.field(2, 3);      // stretched hard -> long fibres
  const ringF = bank.field(6, 4);
  const fibre = bank.field(24, 4);
  const fine = bank.field(96, 3);
  const macro = bank.field(2, 3);
  const knots = bank.worley(8);
  const [ox1, oy1] = offs(res), [ox2, oy2] = offs(res);

  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const i = y * res + x;
      const wob = ((at(ringF, x + ox1, y + oy1) - 0.5) * res * 0.05) | 0;
      const gv = at(grainF, (x + wob) * 14, y + ox2);
      const rv = at(ringF, (x + wob) * 4, y + oy2);
      const fn = at(fibre, (x + wob) * 3, y) * 0.6 + at(fine, x, y) * 0.4;
      const mc = at(macro, x, y);

      let ring = Math.abs(((gv * 0.62 + rv * 0.38) * 7) % 1 - 0.5) * 2;
      ring = smoothstep(clamp(ring * 1.25 - 0.16, 0, 1));

      // knots where a branch was
      const knot = knots.id[i] > 0.72 ? clamp(1 - knots.d1[i] / 0.30, 0, 1) : 0;
      const knotS = knot * knot;

      const mix = clamp(ring * 0.62 + (fn - 0.5) * 0.34 + 0.20 + knotS * 0.9, 0, 1);
      let r = lerp(0.470, 0.205, mix);
      let g = lerp(0.395, 0.148, mix);
      let b = lerp(0.300, 0.108, mix);

      // weathered silver-grey on the exposed faces
      const grey = smoothstep(clamp((mc - 0.30) * 1.8, 0, 1));
      r = lerp(r, lerp(0.440, 0.300, mix), grey * 0.7);
      g = lerp(g, lerp(0.425, 0.290, mix), grey * 0.7);
      b = lerp(b, lerp(0.400, 0.280, mix), grey * 0.7);

      // saw marks: shallow regular ridges across the board
      const saw = Math.abs(((y / res) * 46 + (fn - 0.5) * 0.7) % 1 - 0.5) * 2;
      const sawH = (1 - saw) * 0.22 * (0.4 + grey * 0.8);

      S.H[i] = 0.5 + (mix - 0.5) * 0.22 + (fn - 0.5) * 0.28 + sawH - knotS * 0.18;
      S.R[i] = r; S.G[i] = g; S.B[i] = b;
      S.Q[i] = clamp(0.86 + (fn - 0.5) * 0.14 - knotS * 0.18 + grey * 0.05, 0.3, 1);
      S.O[i] = 1 - knotS * 0.2;
    }
  }
}

// --- coping: polished-worn steel tube ---------------------------------------
// The lip of every ramp is the readability cue the whole park hangs on, so this
// is authored as bright galvanised/steel tube: F0 tint ≈ 0.58 (real steel), a
// low base roughness, and micro-grooves stretched hard along the tube AXIS (U)
// so the specular smears into one continuous line down the lip rather than
// breaking into isotropic sparkle. Rust is kept to a few patches well off the
// ride band — a rusty coping reads as a dark edge, which is the failure case.
function genCoping(res, S, bank) {
  const at = makeSampler(res);
  const scratchF = bank.field(24, 4);
  const microF = bank.field(24, 4);
  const fineF = bank.field(96, 3);
  const macro = bank.field(2, 3);
  const pits = bank.worley(64);
  const [ox1, oy1] = offs(res), [ox2, oy2] = offs(res);

  for (let y = 0; y < res; y++) {
    // V wraps around the pipe: the middle band is where pegs and tyres ride
    const wear = 1 - smoothstep(clamp(Math.abs(y / res - 0.5) * 3.1, 0, 1));
    for (let x = 0; x < res; x++) {
      const i = y * res + x;
      // axial grinding lines: stretched hard along U so they never break the
      // highlight up across the tube
      const s1 = at(scratchF, x + ox1, (y + oy1) * 12);
      const s2 = at(fineF, x + ox2, (y + oy2) * 9);
      const micro = at(microF, x * 2 + ox2, (y + oy2) * 5) - 0.5;
      const line = clamp(1 - Math.abs(s1 - 0.5) * 2 * 5.5, 0, 1);
      const hair = clamp(1 - Math.abs(s2 - 0.5) * 2 * 8.0, 0, 1);
      const mc = at(macro, x, y);

      // pitting / rust away from the wear band, and only in a few patches
      const pit = clamp(1 - pits.d1[i] / 0.20, 0, 1);
      const rust = pit * smoothstep(clamp((mc - 0.68) * 4.2, 0, 1)) * (1 - wear * 0.92);

      const base = 0.578 + micro * 0.055 - line * 0.045 + wear * 0.070 - hair * 0.020;
      let r = base * 0.995, g = base, b = base * 1.035;
      r = lerp(r, 0.34, rust * 0.75); g = lerp(g, 0.185, rust * 0.75); b = lerp(b, 0.105, rust * 0.75);

      S.H[i] = 0.5 + micro * 0.30 - line * 0.28 - hair * 0.12 - pit * 0.34 * (0.3 + rust);
      S.R[i] = r; S.G[i] = g; S.B[i] = b;
      // 0.10 on the ride band up to ~0.30 on the untouched underside
      S.Q[i] = clamp(0.255 - wear * 0.135 + line * 0.075 + hair * 0.05
        + micro * 0.10 + rust * 0.55, 0.055, 1);
      S.M[i] = 1 - rust * 0.72;
      S.O[i] = 1 - pit * 0.22;
    }
  }
}

// --- rail steel: galvanised, spangled, ground-in polish band -----------------
function genRailSteel(res, S, bank) {
  const at = makeSampler(res);
  const spangle = bank.worley(16);
  const micro = bank.worley(64);
  const scratchF = bank.field(24, 4);
  const fineF = bank.field(96, 3);
  const macro = bank.field(2, 3);
  const [ox1, oy1] = offs(res), [ox2, oy2] = offs(res);

  for (let y = 0; y < res; y++) {
    const wear = 1 - smoothstep(clamp(Math.abs(y / res - 0.5) * 2.6, 0, 1));
    for (let x = 0; x < res; x++) {
      const i = y * res + x;
      // spangle: the crystalline flower pattern of hot-dip galvanising
      const cell = spangle.id[i];
      const facet = clamp(1 - (spangle.d2[i] - spangle.d1[i]) * 3.2, 0, 1);
      const sh = 0.500 + (cell - 0.5) * 0.028 + facet * 0.018;

      const s1 = at(scratchF, x + ox1, (y + oy1) * 8);
      const line = clamp(1 - Math.abs(s1 - 0.5) * 2 * 6.0, 0, 1);
      const fn = at(fineF, x * 2, y + oy2) - 0.5;
      const mc = at(macro, x + ox2, y);
      const pit = clamp(1 - micro.d1[i] / 0.18, 0, 1);
      const rust = pit * smoothstep(clamp((mc - 0.66) * 4.0, 0, 1)) * (1 - wear * 0.9);

      const base = sh + fn * 0.045 - line * 0.045 + wear * 0.055;
      let r = base * 0.99, g = base, b = base * 1.045;
      r = lerp(r, 0.33, rust * 0.8); g = lerp(g, 0.18, rust * 0.8); b = lerp(b, 0.11, rust * 0.8);

      S.H[i] = 0.5 + fn * 0.30 - line * 0.30 + facet * 0.12 - pit * 0.35;
      S.R[i] = r; S.G[i] = g; S.B[i] = b;
      S.Q[i] = clamp(0.44 - wear * 0.30 + facet * 0.08 + line * 0.18 + fn * 0.14 + rust * 0.5, 0.07, 1);
      S.M[i] = 1 - rust * 0.7;
      S.O[i] = 1 - pit * 0.2;
    }
  }
}

// --- painted metal: chipped enamel over red-oxide primer --------------------
function genPaintedMetal(res, S, bank) {
  const at = makeSampler(res);
  const peel = bank.field(128, 2);
  const macro = bank.field(2, 3);
  const wearF = bank.field(12, 4);
  const fineF = bank.field(96, 3);
  const chips = bank.worley(32);
  const dots = bank.worley(128);
  const [ox1, oy1] = offs(res), [ox2, oy2] = offs(res);

  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const i = y * res + x;
      const orange = at(peel, x + ox1, y + oy1) - 0.5;      // orange peel
      const mc = at(macro, x, y);
      const wf = at(wearF, x + ox2, y + oy2);
      const fn = at(fineF, x * 2, y) - 0.5;

      // chip mask: cells of paint lifted where edge wear is high
      const edgeWear = smoothstep(clamp((wf - 0.52) * 3.4, 0, 1))
        * smoothstep(clamp((mc - 0.34) * 2.4, 0, 1));
      const cellIn = clamp((0.44 - chips.d1[i]) * 6, 0, 1) * (chips.id[i] > 0.42 ? 1 : 0);
      const chip = clamp(cellIn * edgeWear * 1.6, 0, 1);
      const chipCore = smoothstep(clamp((chip - 0.45) * 3.2, 0, 1));
      const speck = clamp(1 - dots.d1[i] / 0.30, 0, 1) * edgeWear;

      // scratches revealing primer
      const scr = clamp(1 - Math.abs(at(wearF, x * 3 + oy1, (y + ox2) * 3) - 0.5) * 2 * 7, 0, 1)
        * smoothstep(clamp((mc - 0.40) * 2.6, 0, 1));

      // enamel is authored near-white so material.color tints it cleanly
      let r = 0.760 + orange * 0.05, g = 0.755 + orange * 0.05, b = 0.745 + orange * 0.05;
      let q = 0.34 + orange * 0.16 + fn * 0.07;
      let met = 0;
      let h = 0.62 + orange * 0.18 + fn * 0.10;

      const primer = clamp(Math.max(chip * 1.1, scr * 0.8, speck * 0.9), 0, 1);
      r = lerp(r, 0.352, primer); g = lerp(g, 0.168, primer); b = lerp(b, 0.118, primer);
      q = lerp(q, 0.82 + fn * 0.1, primer);
      h = lerp(h, 0.45, primer);

      r = lerp(r, 0.480 + fn * 0.1, chipCore);
      g = lerp(g, 0.485 + fn * 0.1, chipCore);
      b = lerp(b, 0.500 + fn * 0.1, chipCore);
      q = lerp(q, 0.32 + fn * 0.12, chipCore);
      met = lerp(met, 1, chipCore);
      h = lerp(h, 0.34, chipCore);

      // rust weep below the chips
      const weep = chip * smoothstep(clamp((at(wearF, x + oy2, (y + ox1) * 4) - 0.5) * 3.4, 0, 1));
      r = lerp(r, 0.36, weep * 0.45); g = lerp(g, 0.20, weep * 0.45); b = lerp(b, 0.12, weep * 0.45);
      q = lerp(q, 0.90, weep * 0.4);
      met = lerp(met, 0.05, weep * 0.5);

      S.H[i] = h; S.R[i] = r; S.G[i] = g; S.B[i] = b;
      S.Q[i] = clamp(q, 0.08, 1); S.M[i] = clamp(met, 0, 1);
      S.O[i] = 1 - chip * 0.18;
    }
  }
}

// --- chainlink: analytic woven diamond mesh with alpha ----------------------
function genChainlink(res, S, bank) {
  const at = makeSampler(res);
  const fineF = bank.field(96, 3);
  const macro = bank.field(2, 3);
  const [ox1, oy1] = offs(res);
  const T = 5;                    // diamonds across the tile
  const halfW = 0.155;            // wire half-width in cell units
  const texPerCell = res / T;

  for (let y = 0; y < res; y++) {
    const v = (y / res) * T;
    for (let x = 0; x < res; x++) {
      const i = y * res + x;
      const u = (x / res) * T;
      const a = u + v, b = u - v;
      const fa = a - Math.floor(a) - 0.5;
      const fb = b - Math.floor(b) - 0.5;
      const sa = Math.abs(fa) / halfW;
      const sb = Math.abs(fb) / halfW;
      const inA = sa < 1, inB = sb < 1;

      if (!inA && !inB) {
        S.A[i] = 0; S.H[i] = 0; S.R[i] = 0; S.G[i] = 0; S.B[i] = 0; S.Q[i] = 0.5; S.M[i] = 0;
        continue;
      }

      const aTop = ((Math.floor(a) + Math.floor(b)) & 1) === 0;
      const ha = inA ? Math.sqrt(1 - sa * sa) : 0;
      const hb = inB ? Math.sqrt(1 - sb * sb) : 0;
      const hA = ha + (aTop && inA ? 0.85 : 0);
      const hB = hb + (!aTop && inB ? 0.85 : 0);
      const top = hA >= hB;
      const cross = top ? ha : hb;             // 1 at the wire crown, 0 at its edge
      const height = (top ? hA : hB) / 1.85;

      const fn = at(fineF, x + ox1, y + oy1) - 0.5;
      const mc = at(macro, x, y);
      const rust = smoothstep(clamp((mc - 0.68) * 4.2, 0, 1)) * (0.4 + at(fineF, x * 3, y * 3));

      const base = 0.30 + cross * 0.42 + fn * 0.07;
      let r = base, g = base * 1.01, b2 = base * 1.05;
      r = lerp(r, 0.33, rust * 0.6); g = lerp(g, 0.19, rust * 0.6); b2 = lerp(b2, 0.12, rust * 0.6);

      const edgeTex = (1 - Math.min(sa, sb)) * halfW * texPerCell;
      S.A[i] = clamp(edgeTex / 1.1, 0, 1);
      S.H[i] = height;
      S.R[i] = r; S.G[i] = g; S.B[i] = b2;
      S.Q[i] = clamp(0.36 + (1 - cross) * 0.20 + fn * 0.12 + rust * 0.42, 0.10, 1);
      S.M[i] = 1 - rust * 0.6;
      S.O[i] = 0.55 + cross * 0.45;
    }
  }
}

// --- brick: running bond, recessed mortar, soot and efflorescence -----------
function genBrick(res, S, bank) {
  const at = makeSampler(res);
  const faceF = bank.field(24, 4);
  const fineF = bank.field(96, 3);
  const macro = bank.field(2, 3);
  const streak = bank.field(12, 4);
  const sand = bank.worley(128);
  const [ox1, oy1] = offs(res), [ox2, oy2] = offs(res);

  const courses = 8, perCourse = 4;
  const bh = res / courses, bw = res / perCourse;
  const mortar = res * 0.016;

  for (let y = 0; y < res; y++) {
    const cy = (y / bh) | 0;
    const rowOff = (cy & 1) ? bw * 0.5 : 0;
    for (let x = 0; x < res; x++) {
      const i = y * res + x;
      const fx = x - rowOff;
      const cxf = Math.floor(fx / bw);
      const cx = ((cxf % perCourse) + perCourse) % perCourse;
      const lu = fx - cxf * bw;
      const lv = y - cy * bh;

      const bid = hash2(cx + 7, cy + 13);
      const grime = hash2(cx + 41, cy + 97);
      const jx = (bid * 977) | 0, jy = (bid * 613) | 0;
      const face = at(faceF, x + jx, y + jy);
      const fn = at(fineF, x + jx, y + jy) - 0.5;
      const mc = at(macro, x + ox1, y + oy1);

      // distance to the mortar joint, jittered so brick edges chip
      const dEdge = Math.min(Math.min(lu, bw - lu), Math.min(lv, bh - lv))
        + (face - 0.5) * mortar * 0.9;
      const mortarS = smoothstep(clamp((mortar - dEdge) / (mortar * 0.55), 0, 1));
      const chip = clamp(1 - Math.abs(dEdge - mortar) / (mortar * 0.8), 0, 1)
        * smoothstep(clamp((face - 0.55) * 3.5, 0, 1));

      // brick colour family from the per-brick id
      let br, bg, bb;
      if (bid < 0.16) { br = 0.215; bg = 0.168; bb = 0.158; }                              // clinker
      else if (bid < 0.55) { br = 0.360 + bid * 0.12; bg = 0.218 + bid * 0.07; bb = 0.188 + bid * 0.06; }
      else if (bid < 0.85) { br = 0.428; bg = 0.288; bb = 0.248; }
      else { br = 0.492; bg = 0.378; bb = 0.322; }                                          // sand-struck
      const shade = 0.72 + face * 0.50 + fn * 0.14 + (bid - 0.5) * 0.22
        - clamp(1 - lv / bh, 0, 1) * 0.10;
      br *= shade; bg *= shade; bb *= shade;

      // mortar: pale, sandy, matte
      const sandy = clamp(1 - sand.d1[i] / 0.5, 0, 1);
      const mr = 0.475 + fn * 0.11 - sandy * 0.065;
      const mg = 0.462 + fn * 0.11 - sandy * 0.065;
      const mb = 0.432 + fn * 0.11 - sandy * 0.060;

      let r = lerp(br, mr, mortarS), g = lerp(bg, mg, mortarS), b = lerp(bb, mb, mortarS);
      const grimeK = 1 - grime * 0.30 * (1 - mortarS * 0.5);
      r *= grimeK; g *= grimeK * 0.995; b *= grimeK * 0.99;
      let q = lerp(0.78 + fn * 0.12, 0.94 + fn * 0.08, mortarS);
      const h = lerp(0.66 + (face - 0.5) * 0.14 + fn * 0.10, 0.28 + fn * 0.16, mortarS) - chip * 0.22;

      // soot settling on the upper edge of every course
      const soot = clamp(1 - lv / (bh * 0.45), 0, 1) * smoothstep(clamp((mc - 0.22) * 1.8, 0, 1));
      r *= 1 - soot * 0.34; g *= 1 - soot * 0.35; b *= 1 - soot * 0.33;

      // efflorescence: pale salt bloom running down the wall
      const eff = smoothstep(clamp((at(streak, (x + ox2) * 2, y + oy2) - 0.62) * 4.0, 0, 1))
        * smoothstep(clamp((mc - 0.45) * 2.6, 0, 1));
      r = lerp(r, r * 0.55 + 0.36, eff * 0.7);
      g = lerp(g, g * 0.55 + 0.36, eff * 0.7);
      b = lerp(b, b * 0.55 + 0.35, eff * 0.7);
      q = lerp(q, 0.96, eff * 0.6);

      S.H[i] = h; S.R[i] = r; S.G[i] = g; S.B[i] = b;
      S.Q[i] = clamp(q, 0.30, 1);
      S.O[i] = 1 - mortarS * 0.30 - chip * 0.15;
    }
  }
}

// --- corrugated metal: painted, rust-streaked, bolted -----------------------
function genCorrugated(res, S, bank) {
  const at = makeSampler(res);
  const macro = bank.field(2, 3);
  const streak = bank.field(12, 4);
  const fineF = bank.field(96, 3);
  const dent = bank.field(12, 4);
  const pits = bank.worley(128);
  const [ox1, oy1] = offs(res), [ox2, oy2] = offs(res);
  const ribs = 6;

  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const i = y * res + x;
      const p = Math.sin((x / res) * TAU * ribs);
      const fn = at(fineF, x + ox1, y + oy1) - 0.5;
      const dn = at(dent, x + ox2, y + oy2) - 0.5;
      const mc = at(macro, x, y);

      // rust bleeds downward from pit clusters (streaks stretched along V)
      const pit = clamp(1 - pits.d1[i] / 0.28, 0, 1);
      const streakV = at(streak, (x + ox2) * 3, y + oy1);
      const rust = clamp(smoothstep(clamp((mc - 0.42) * 2.6, 0, 1))
        * (0.30 + smoothstep(clamp((streakV - 0.52) * 3.6, 0, 1)) * 0.85) + pit * 0.14, 0, 1);

      // faded industrial blue-grey paint, chalked by the sun
      let r = 0.300 + fn * 0.05 + p * 0.012;
      let g = 0.335 + fn * 0.05 + p * 0.012;
      let b = 0.360 + fn * 0.05 + p * 0.012;
      const chalk = smoothstep(clamp((mc - 0.55) * 3, 0, 1));
      r = lerp(r, 0.44, chalk * 0.45); g = lerp(g, 0.47, chalk * 0.45); b = lerp(b, 0.49, chalk * 0.45);
      r = lerp(r, 0.345 + fn * 0.12, rust); g = lerp(g, 0.170 + fn * 0.08, rust); b = lerp(b, 0.098 + fn * 0.05, rust);

      S.H[i] = 0.5 + p * 0.45 + dn * 0.05 + fn * 0.03 - pit * 0.10;
      S.R[i] = r; S.G[i] = g; S.B[i] = b;
      S.Q[i] = clamp(0.48 + chalk * 0.16 + fn * 0.12 + rust * 0.38, 0.16, 1);
      S.M[i] = clamp(0.85 - rust * 0.8, 0, 1);
      S.O[i] = 1 - pit * 0.12;
    }
  }

  // bolt rows on the crests
  const r0 = Math.max(2, (res * 0.009) | 0);
  for (let c = 0; c < ribs; c++) {
    const bx = (((c + 0.25) / ribs) * res) | 0;
    for (let k = 0; k < 3; k++) {
      const by = ((k / 3 + 0.16) * res) | 0;
      stampScrew(S, res, bx, by, r0, { tone: 0.34, rough: 0.62, cross: false });
    }
  }
}

// --- glass: float ripple, dust film, smears ---------------------------------
function genGlass(res, S, bank) {
  const at = makeSampler(res);
  const ripple = bank.field(2, 3);
  const smear = bank.field(12, 4);
  const fineF = bank.field(96, 3);
  const dots = bank.worley(128);
  const [ox1, oy1] = offs(res);

  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const i = y * res + x;
      const rp = at(ripple, x, y * 2) - 0.5;
      const sm = at(smear, (x + ox1) * 2, y + oy1);
      const fn = at(fineF, x, y) - 0.5;
      const dust = clamp(1 - dots.d1[i] / 0.22, 0, 1);

      const grime = smoothstep(clamp((sm - 0.52) * 3.0, 0, 1));
      const tint = 0.88 - grime * 0.10 - dust * 0.06;
      S.H[i] = 0.5 + rp * 0.5 + fn * 0.04;
      S.R[i] = tint * 0.98; S.G[i] = tint; S.B[i] = tint * 0.985;
      S.Q[i] = clamp(0.035 + grime * 0.24 + dust * 0.30 + fn * 0.02, 0.02, 0.7);
      S.O[i] = 1;
    }
  }
}

// --- dry city-lot grass -----------------------------------------------------
function genGrass(res, S, bank) {
  const at = makeSampler(res);
  const clump = bank.field(6, 4);
  const macro = bank.field(2, 3);
  const bladeF = bank.field(24, 4);
  const fineF = bank.field(96, 3);
  const bald = bank.worley(16);
  const [ox1, oy1] = offs(res), [ox2, oy2] = offs(res);

  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const i = y * res + x;
      // blades lean per clump: shear the sample coordinates
      const shear = ((at(clump, x + ox1, y + oy1) - 0.5) * res * 0.06) | 0;
      const bl = at(bladeF, (x + shear) * 5 + ox2, y + oy2);
      const bl2 = at(bladeF, (x - shear) * 3, (y + ox1) * 2);
      const blade = Math.max(bl, bl2 * 0.9);
      const fn = at(fineF, x, y) - 0.5;
      const mc = at(macro, x, y);

      const bare = smoothstep(clamp((bald.d1[i] - 0.62) * 2.6, 0, 1))
        * smoothstep(clamp((mc - 0.38) * 2.4, 0, 1));
      const dry = smoothstep(clamp((at(clump, x + ox2, y) - 0.35) * 1.8, 0, 1));

      const gT = clamp(blade * 0.8 + fn * 0.5 + 0.1, 0, 1);
      let r = lerp(0.152, 0.315, gT), g = lerp(0.212, 0.360, gT), b = lerp(0.086, 0.140, gT);
      r = lerp(r, lerp(0.360, 0.520, gT), dry * 0.8);
      g = lerp(g, lerp(0.320, 0.455, gT), dry * 0.8);
      b = lerp(b, lerp(0.140, 0.210, gT), dry * 0.8);
      r = lerp(r, 0.300 + fn * 0.08, bare);
      g = lerp(g, 0.238 + fn * 0.07, bare);
      b = lerp(b, 0.175 + fn * 0.06, bare);

      S.H[i] = 0.42 + blade * 0.45 + fn * 0.20 - bare * 0.35;
      S.R[i] = r; S.G[i] = g; S.B[i] = b;
      S.Q[i] = clamp(0.86 + fn * 0.14 - dry * 0.06 + bare * 0.05, 0.40, 1);
      S.O[i] = 1 - clamp(1 - blade, 0, 1) * 0.25;
    }
  }
}

// --- dry packed jump dirt ---------------------------------------------------
function genDirt(res, S, bank) {
  const at = makeSampler(res);
  const macro = bank.field(2, 3);
  const lane = bank.field(6, 4);
  const midF = bank.field(24, 4);
  const fineF = bank.field(96, 3);
  const clods = bank.worley(128);
  const cracks = bank.worley(32);
  const stones = bank.worley(8);
  const [ox1, oy1] = offs(res), [ox2, oy2] = offs(res), [ox3, oy3] = offs(res);

  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const i = y * res + x;
      const mc = at(macro, x, y);
      const ln = at(lane, x + ox1, (y + oy1) * 2);
      const md = at(midF, x + ox2, y + oy2);
      const fn = at(fineF, x + ox3, y + oy3) - 0.5;

      // packed tyre lane: compacted, darker, smoother
      const packed = smoothstep(clamp((ln - 0.46) * 3.4, 0, 1))
        * smoothstep(clamp((mc - 0.28) * 2.2, 0, 1));

      // loose crumbs on the untravelled dirt
      const clod = clamp(1 - clods.d1[i] / 0.5, 0, 1) * (0.5 + clods.id[i] * 0.5);
      const loose = clod * (1 - packed * 0.85);

      // shrinkage cracks in the packed surface
      const crack = clamp(1 - (cracks.d2[i] - cracks.d1[i]) * 7, 0, 1) * packed;
      const crackS = crack * crack;

      // embedded stones
      const st = stones.id[i] > 0.80 ? clamp(1 - stones.d1[i] / 0.22, 0, 1) : 0;
      const stone = st * st;

      S.H[i] = 0.52 + (md - 0.5) * 0.18 + fn * 0.22 + loose * 0.30
        - packed * 0.10 - crackS * 0.45 + stone * 0.30;

      let r = 0.325 + (md - 0.5) * 0.105 + (mc - 0.5) * 0.075 + fn * 0.050;
      let g = 0.238 + (md - 0.5) * 0.090 + (mc - 0.5) * 0.062 + fn * 0.045;
      let b = 0.158 + (md - 0.5) * 0.072 + (mc - 0.5) * 0.048 + fn * 0.040;

      const dustAmt = (1 - packed) * smoothstep(clamp((mc - 0.30) * 2.0, 0, 1));
      r = lerp(r, 0.470, dustAmt * 0.55); g = lerp(g, 0.380, dustAmt * 0.55); b = lerp(b, 0.275, dustAmt * 0.55);
      r = lerp(r, 0.230, packed * 0.55); g = lerp(g, 0.168, packed * 0.55); b = lerp(b, 0.118, packed * 0.55);
      r = lerp(r, 0.300 + stones.id[i] * 0.10, stone * 0.65);
      g = lerp(g, 0.286 + stones.id[i] * 0.09, stone * 0.65);
      b = lerp(b, 0.264 + stones.id[i] * 0.08, stone * 0.65);
      r *= 1 - crackS * 0.45; g *= 1 - crackS * 0.45; b *= 1 - crackS * 0.42;

      S.R[i] = r; S.G[i] = g; S.B[i] = b;
      S.Q[i] = clamp(0.92 + fn * 0.10 - packed * 0.22 - stone * 0.10 + dustAmt * 0.04, 0.35, 1);
      S.O[i] = (1 - crackS * 0.5) * (1 - loose * 0.12);
    }
  }
}

// --- tyre / grip rubber -----------------------------------------------------
function genRubber(res, S, bank) {
  const at = makeSampler(res);
  const fineF = bank.field(96, 3);
  const midF = bank.field(24, 4);
  const macro = bank.field(2, 3);
  const pores = bank.worley(128);
  const [ox1, oy1] = offs(res);

  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const i = y * res + x;
      const fn = at(fineF, x + ox1, y + oy1) - 0.5;
      const md = at(midF, x, y) - 0.5;
      const mc = at(macro, x, y);
      const pore = clamp(1 - pores.d1[i] / 0.35, 0, 1);

      const scuff = smoothstep(clamp((mc - 0.55) * 3.0, 0, 1));
      const base = 0.052 + fn * 0.018 + md * 0.012 + scuff * 0.030;
      S.H[i] = 0.5 + fn * 0.5 + md * 0.2 - pore * 0.35;
      S.R[i] = base; S.G[i] = base * 1.01; S.B[i] = base * 1.05;
      S.Q[i] = clamp(0.86 + fn * 0.18 + pore * 0.08 - scuff * 0.22, 0.30, 1);
      S.O[i] = 1 - pore * 0.2;
    }
  }
}

// --- woven cloth (jersey, banners, seat) ------------------------------------
function genCloth(res, S, bank) {
  const at = makeSampler(res);
  const fuzz = bank.field(96, 3);
  const macro = bank.field(6, 4);
  const [ox1, oy1] = offs(res);
  const threads = 42;

  for (let y = 0; y < res; y++) {
    const tv = (y / res) * threads;
    for (let x = 0; x < res; x++) {
      const i = y * res + x;
      const tu = (x / res) * threads;
      const fu = tu - Math.floor(tu) - 0.5;
      const fv = tv - Math.floor(tv) - 0.5;
      const over = ((Math.floor(tu) + Math.floor(tv)) & 1) === 0;
      const cu = Math.sqrt(Math.max(0, 1 - (fu * 2) * (fu * 2)));
      const cv = Math.sqrt(Math.max(0, 1 - (fv * 2) * (fv * 2)));
      const h = over ? cv * 0.75 + cu * 0.25 : cu * 0.75 + cv * 0.25;

      const fz = at(fuzz, x + ox1, y + oy1) - 0.5;
      const mc = at(macro, x, y) - 0.5;
      const shade = 0.72 + h * 0.22 + fz * 0.09 + mc * 0.05;

      S.H[i] = h * 0.9 + fz * 0.1;
      S.R[i] = shade; S.G[i] = shade * 0.995; S.B[i] = shade * 0.985;
      S.Q[i] = clamp(0.88 - h * 0.08 + fz * 0.12, 0.40, 1);
      S.O[i] = 0.78 + h * 0.22;
    }
  }
}

// --- glossy injection-moulded plastic (helmet, pads, litter) ----------------
function genPlastic(res, S, bank) {
  const at = makeSampler(res);
  const peel = bank.field(24, 4);
  const fineF = bank.field(96, 3);
  const macro = bank.field(2, 3);
  const [ox1, oy1] = offs(res);

  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const i = y * res + x;
      const op = at(peel, x + ox1, y + oy1) - 0.5;
      const fn = at(fineF, x, y) - 0.5;
      const mc = at(macro, x, y) - 0.5;
      const scr = clamp(1 - Math.abs(at(fineF, x * 2, (y + ox1) * 2) - 0.5) * 2 * 9, 0, 1);

      const base = 0.80 + op * 0.05 + mc * 0.03;
      S.H[i] = 0.5 + op * 0.6 + fn * 0.1 - scr * 0.3;
      S.R[i] = base; S.G[i] = base; S.B[i] = base;
      S.Q[i] = clamp(0.18 + op * 0.10 + fn * 0.05 + scr * 0.35, 0.05, 1);
      S.O[i] = 1;
    }
  }
}

// --- anodised / brushed bike-part metal -------------------------------------
function genAnodised(res, S, bank) {
  const at = makeSampler(res);
  const brush = bank.field(24, 4);
  const fineF = bank.field(96, 3);
  const macro = bank.field(6, 4);
  const dings = bank.worley(32);
  const [ox1, oy1] = offs(res);

  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const i = y * res + x;
      // fine brushed streaks along U, plus stray deeper scratches
      const br = at(brush, x + ox1, (y + oy1) * 12) - 0.5;
      const fn = at(fineF, x, y * 3) - 0.5;
      const mc = at(macro, x, y) - 0.5;
      const scratch = clamp(1 - Math.abs(at(fineF, x * 2 + oy1, (y + ox1) * 5) - 0.5) * 2 * 8, 0, 1);
      const ding = clamp(1 - dings.d1[i] / 0.10, 0, 1) * (dings.id[i] > 0.86 ? 1 : 0);

      const base = 0.700 + br * 0.15 + fn * 0.075 + mc * 0.04 + scratch * 0.14;
      S.H[i] = 0.5 + br * 0.35 + fn * 0.25 - scratch * 0.25 - ding * 0.5;
      S.R[i] = base; S.G[i] = base; S.B[i] = base;
      S.Q[i] = clamp(0.24 + br * 0.10 + fn * 0.07 + scratch * 0.22 + ding * 0.30, 0.04, 1);
      S.M[i] = 1;
      S.O[i] = 1 - ding * 0.25;
    }
  }
}

// ---------------------------------------------------------------------------
// decal / graffiti atlas (canvas 2D, alpha)
// ---------------------------------------------------------------------------

const DECAL_GRID = 4;
export const DECALS = [
  'tagMirra', 'throwBmx', 'arrow', 'stencilStar',
  'crack', 'oilStain', 'skid', 'waterStain',
  'laneLine', 'dashYellow', 'noSkating', 'sponsor',
  'number540', 'stencilDiy', 'splatter', 'sprayX',
];

function make2D(size) {
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(size, size);
    return { canvas: c, g: c.getContext('2d', { willReadFrequently: true }) };
  }
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return { canvas: c, g: c.getContext('2d', { willReadFrequently: true }) };
}

/** Spray-can text: soft overspray passes, hard core, gravity drips. */
function sprayText(g, text, cx, cy, size, colour, opts = {}) {
  g.save();
  g.translate(cx, cy);
  g.rotate(opts.rot ?? 0);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = colour;
  g.strokeStyle = colour;
  g.font = `900 ${size}px "Arial Black", Impact, sans-serif`;
  for (let p = 0; p < 12; p++) {              // overspray halo
    g.globalAlpha = 0.05;
    g.fillText(text, rand(-4, 4), rand(-4, 4));
  }
  g.globalAlpha = 0.94;
  g.fillText(text, 0, 0);

  const w = g.measureText(text).width;
  for (let p = 0; p < 260; p++) {             // speckle
    g.globalAlpha = rand(0.05, 0.30);
    g.beginPath();
    g.arc(rand(-w * 0.62, w * 0.62), rand(-size * 0.62, size * 0.62), rand(0.5, 2.1), 0, TAU);
    g.fill();
  }
  if (opts.drips !== false) {
    for (let d = 0; d < 5; d++) {
      const px = rand(-w * 0.45, w * 0.45);
      const len = rand(size * 0.25, size * 0.8);
      g.globalAlpha = 0.75;
      g.lineWidth = rand(2.5, 5.5);
      g.beginPath();
      g.moveTo(px, size * 0.28);
      g.lineTo(px + rand(-3, 3), size * 0.28 + len);
      g.stroke();
      g.beginPath();
      g.arc(px, size * 0.28 + len, g.lineWidth * 0.75, 0, TAU);
      g.fill();
    }
  }
  g.globalAlpha = 1;
  g.restore();
}

function drawDecalCell(g, index, x0, y0, cw) {
  const cx = x0 + cw / 2, cy = y0 + cw / 2;
  g.save();
  g.beginPath();
  g.rect(x0, y0, cw, cw);
  g.clip();

  switch (DECALS[index]) {
    case 'tagMirra':
      sprayText(g, 'MIRRA', cx, cy - cw * 0.06, cw * 0.24, '#e8462f', { rot: -0.12 });
      sprayText(g, 'CITY', cx + cw * 0.14, cy + cw * 0.22, cw * 0.15, '#1c1c22', { rot: -0.10, drips: false });
      break;

    case 'throwBmx':
      g.save();
      g.translate(cx, cy);
      g.rotate(-0.06);
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.font = `900 ${cw * 0.34}px "Arial Black", Impact, sans-serif`;
      g.lineJoin = 'round';
      g.lineWidth = cw * 0.06;
      g.strokeStyle = '#141418';
      g.strokeText('BMX', 0, 0);
      g.fillStyle = '#3fa9f5';
      g.fillText('BMX', 0, 0);
      g.globalAlpha = 0.45;
      g.fillStyle = '#d8f0ff';
      g.fillText('BMX', -cw * 0.012, -cw * 0.022);
      g.globalAlpha = 1;
      g.restore();
      break;

    case 'arrow':
      g.save();
      g.translate(cx, cy);
      g.rotate(-0.35);
      g.fillStyle = '#f2f0e6';
      g.globalAlpha = 0.9;
      g.beginPath();
      g.moveTo(-cw * 0.30, -cw * 0.08);
      g.lineTo(cw * 0.05, -cw * 0.08);
      g.lineTo(cw * 0.05, -cw * 0.20);
      g.lineTo(cw * 0.34, 0);
      g.lineTo(cw * 0.05, cw * 0.20);
      g.lineTo(cw * 0.05, cw * 0.08);
      g.lineTo(-cw * 0.30, cw * 0.08);
      g.closePath();
      g.fill();
      g.globalCompositeOperation = 'destination-out';
      for (let k = 0; k < 70; k++) {
        g.beginPath();
        g.arc(rand(-cw * 0.34, cw * 0.36), rand(-cw * 0.22, cw * 0.22), rand(0.8, 3.6), 0, TAU);
        g.fill();
      }
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = 1;
      g.restore();
      break;

    case 'stencilStar':
      g.save();
      g.translate(cx, cy);
      g.fillStyle = '#f5d33a';
      g.globalAlpha = 0.85;
      g.beginPath();
      for (let k = 0; k < 10; k++) {
        const a = (k / 10) * TAU - Math.PI / 2;
        const rr = (k & 1) ? cw * 0.15 : cw * 0.34;
        const px = Math.cos(a) * rr, py = Math.sin(a) * rr;
        if (k === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.closePath();
      g.fill();
      g.globalCompositeOperation = 'destination-out';
      for (let k = 0; k < 120; k++) {
        g.beginPath();
        g.arc(rand(-cw * 0.35, cw * 0.35), rand(-cw * 0.35, cw * 0.35), rand(0.8, 3.2), 0, TAU);
        g.fill();
      }
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = 1;
      g.restore();
      break;

    case 'crack': {
      g.save();
      g.translate(cx, cy);
      g.strokeStyle = 'rgba(24,22,20,0.92)';
      g.lineCap = 'round';
      const branch = (bx, by, ang, len, w, depth) => {
        if (depth > 4 || len < 4) return;
        const nx = bx + Math.cos(ang) * len, ny = by + Math.sin(ang) * len;
        g.lineWidth = w;
        g.beginPath(); g.moveTo(bx, by); g.lineTo(nx, ny); g.stroke();
        branch(nx, ny, ang + rand(-0.5, 0.5), len * rand(0.55, 0.85), w * 0.72, depth + 1);
        if (rng() > 0.45) branch(nx, ny, ang + rand(-1.2, 1.2), len * rand(0.35, 0.6), w * 0.5, depth + 1);
      };
      for (let k = 0; k < 5; k++) {
        branch(rand(-cw * 0.30, cw * 0.30), rand(-cw * 0.30, cw * 0.30), rand(0, TAU), cw * 0.16, 4.5, 0);
      }
      g.restore();
      break;
    }

    case 'oilStain': {
      const grd = g.createRadialGradient(cx, cy, cw * 0.02, cx, cy, cw * 0.44);
      grd.addColorStop(0, 'rgba(10,9,10,0.88)');
      grd.addColorStop(0.55, 'rgba(20,17,16,0.55)');
      grd.addColorStop(0.85, 'rgba(40,30,24,0.22)');
      grd.addColorStop(1, 'rgba(40,30,24,0)');
      g.fillStyle = grd;
      g.beginPath();
      for (let k = 0; k <= 40; k++) {
        const a = (k / 40) * TAU;
        const rr = cw * (0.28 + fbm2(Math.cos(a) * 2 + index * 5, Math.sin(a) * 2, 4) * 0.18);
        const px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr;
        if (k === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.closePath();
      g.fill();
      break;
    }

    case 'skid':
      g.save();
      g.translate(cx, cy);
      g.rotate(0.18);
      g.fillStyle = '#101013';
      for (let k = 0; k < 90; k++) {
        const t = k / 90;
        g.globalAlpha = 0.5 * Math.sin(t * Math.PI) * rand(0.6, 1);
        const w = cw * (0.06 + 0.03 * Math.sin(t * 8));
        g.fillRect(-cw * 0.42 + t * cw * 0.84, -w / 2 + Math.sin(t * 5) * cw * 0.03, cw * 0.02, w);
      }
      g.globalAlpha = 1;
      g.restore();
      break;

    case 'waterStain': {
      const grd = g.createRadialGradient(cx, cy, cw * 0.10, cx, cy, cw * 0.45);
      grd.addColorStop(0, 'rgba(150,140,120,0.05)');
      grd.addColorStop(0.80, 'rgba(120,110,92,0.28)');
      grd.addColorStop(0.95, 'rgba(96,88,72,0.34)');
      grd.addColorStop(1, 'rgba(96,88,72,0)');
      g.fillStyle = grd;
      g.beginPath(); g.arc(cx, cy, cw * 0.45, 0, TAU); g.fill();
      break;
    }

    case 'laneLine':
      g.fillStyle = 'rgba(236,232,214,0.92)';
      g.fillRect(x0 + cw * 0.36, y0, cw * 0.28, cw);
      g.globalCompositeOperation = 'destination-out';
      for (let k = 0; k < 520; k++) {
        g.globalAlpha = rand(0.2, 0.9);
        g.beginPath();
        g.arc(rand(x0 + cw * 0.34, x0 + cw * 0.66), rand(y0, y0 + cw), rand(0.8, 3.4), 0, TAU);
        g.fill();
      }
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
      break;

    case 'dashYellow':
      g.fillStyle = 'rgba(226,178,42,0.90)';
      g.fillRect(x0 + cw * 0.30, y0 + cw * 0.06, cw * 0.16, cw * 0.36);
      g.fillRect(x0 + cw * 0.30, y0 + cw * 0.58, cw * 0.16, cw * 0.36);
      g.fillRect(x0 + cw * 0.56, y0 + cw * 0.06, cw * 0.16, cw * 0.36);
      g.fillRect(x0 + cw * 0.56, y0 + cw * 0.58, cw * 0.16, cw * 0.36);
      g.globalCompositeOperation = 'destination-out';
      for (let k = 0; k < 420; k++) {
        g.globalAlpha = rand(0.15, 0.8);
        g.beginPath();
        g.arc(rand(x0 + cw * 0.28, x0 + cw * 0.74), rand(y0, y0 + cw), rand(0.8, 3.0), 0, TAU);
        g.fill();
      }
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
      break;

    case 'noSkating':
      g.save();
      g.translate(cx, cy);
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = '#e9e6dc';
      g.font = `900 ${cw * 0.15}px Arial, sans-serif`;
      g.fillText('NO SKATING', 0, -cw * 0.10);
      g.font = `700 ${cw * 0.10}px Arial, sans-serif`;
      g.fillText('OR BICYCLES', 0, cw * 0.05);
      g.globalAlpha = 0.8;
      g.font = `700 ${cw * 0.062}px Arial, sans-serif`;
      g.fillText('VIOLATORS WILL BE CITED', 0, cw * 0.20);
      g.globalAlpha = 1;
      g.restore();
      break;

    case 'sponsor':
      g.save();
      g.translate(cx, cy);
      g.fillStyle = '#f24a2a';
      g.fillRect(-cw * 0.44, -cw * 0.17, cw * 0.88, cw * 0.34);
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = '#faf7ee';
      g.font = `900 ${cw * 0.17}px "Arial Black", Impact, sans-serif`;
      g.fillText('MIRRA', -cw * 0.02, -cw * 0.005);
      g.fillStyle = '#141418';
      g.font = `700 ${cw * 0.065}px Arial, sans-serif`;
      g.fillText('FREESTYLE  SERIES', 0, cw * 0.115);
      g.restore();
      break;

    case 'number540':
      g.save();
      g.translate(cx, cy);
      g.rotate(0.04);
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.lineJoin = 'round';
      g.font = `900 ${cw * 0.42}px "Arial Black", Impact, sans-serif`;
      g.lineWidth = cw * 0.05;
      g.strokeStyle = '#16161a';
      g.strokeText('540', 0, 0);
      g.fillStyle = '#f0eee4';
      g.fillText('540', 0, 0);
      g.restore();
      break;

    case 'stencilDiy':
      g.save();
      g.translate(cx, cy);
      g.rotate(-0.05);
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = '#2fbf6a';
      g.font = `900 ${cw * 0.30}px "Arial Black", Impact, sans-serif`;
      g.fillText('D.I.Y.', 0, 0);
      g.globalCompositeOperation = 'destination-out';
      for (let k = 0; k < 150; k++) {
        g.beginPath();
        g.arc(rand(-cw * 0.40, cw * 0.40), rand(-cw * 0.20, cw * 0.20), rand(0.7, 2.8), 0, TAU);
        g.fill();
      }
      g.globalCompositeOperation = 'source-over';
      g.restore();
      break;

    case 'splatter':
      for (let k = 0; k < 160; k++) {
        g.globalAlpha = rand(0.15, 0.7);
        g.fillStyle = rng() > 0.5 ? '#1b1a1d' : '#3a3128';
        g.beginPath();
        g.arc(rand(x0, x0 + cw), rand(y0, y0 + cw), rand(1, 10) * (rng() > 0.9 ? 2.2 : 1), 0, TAU);
        g.fill();
      }
      g.globalAlpha = 1;
      break;

    case 'sprayX':
      g.save();
      g.translate(cx, cy);
      g.strokeStyle = '#8f3fd6';
      g.fillStyle = '#8f3fd6';
      g.lineCap = 'round';
      g.lineWidth = cw * 0.055;
      g.globalAlpha = 0.9;
      g.beginPath(); g.moveTo(-cw * 0.30, -cw * 0.30); g.lineTo(cw * 0.30, cw * 0.30); g.stroke();
      g.beginPath(); g.moveTo(cw * 0.30, -cw * 0.30); g.lineTo(-cw * 0.30, cw * 0.30); g.stroke();
      for (let k = 0; k < 220; k++) {
        g.globalAlpha = rand(0.04, 0.25);
        g.beginPath();
        g.arc(rand(-cw * 0.42, cw * 0.42), rand(-cw * 0.42, cw * 0.42), rand(0.8, 2.6), 0, TAU);
        g.fill();
      }
      g.globalAlpha = 1;
      g.restore();
      break;

    default:
      break;
  }
  g.restore();
}

function buildDecalAtlas(size, aniso) {
  const { g } = make2D(size);
  g.clearRect(0, 0, size, size);
  const cw = size / DECAL_GRID;
  for (let i = 0; i < DECALS.length; i++) {
    drawDecalCell(g, i, (i % DECAL_GRID) * cw, ((i / DECAL_GRID) | 0) * cw, cw);
  }
  // canvas rows run top-down, DataTexture is bottom-up: flip while copying
  const img = g.getImageData(0, 0, size, size).data;
  const data = new Uint8Array(size * size * 4);
  const rowBytes = size * 4;
  for (let y = 0; y < size; y++) {
    data.set(img.subarray((size - 1 - y) * rowBytes, (size - y) * rowBytes), y * rowBytes);
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = aniso;
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------------------
// world-space macro variation (kills tiling repetition at distance)
// ---------------------------------------------------------------------------

const MACRO_GLSL = /* glsl */`
float mvHash( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}
float mvNoise( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  float a = mvHash( i ), b = mvHash( i + vec2( 1.0, 0.0 ) );
  float c = mvHash( i + vec2( 0.0, 1.0 ) ), d = mvHash( i + vec2( 1.0, 1.0 ) );
  return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );
}
// three octaves: the base period plus a 3x and a 9x detail band, so the mask
// carries structure from ~20 m down to ~2 m and never reads as one soft blob.
float macroNoise( vec3 p ) {
  vec2 q = p.xz + p.y * 0.37;
  return mvNoise( q ) * 0.54 + mvNoise( q * 3.17 + 7.3 ) * 0.31 + mvNoise( q * 8.93 + 19.1 ) * 0.15;
}
`;

/** Compiled shader uniforms per material — kept off userData (see ownTextures). */
const macroUniforms = new WeakMap();

/** Shared no-op so feature-free clones keep sharing one program cache key. */
function noMacro() {}

/** Program cache key: one compiled program per *feature set*, not per material. */
function surfaceCacheKey() {
  const ud = this.userData || {};
  return 'bmxSurf|' + (ud.macro ? 'm' : '-') + (ud.bounce ? 'b' : '-');
}

/** One shared function object => one program cache key => one compiled program. */
function surfaceOnBeforeCompile(shader) {
  // props.js chains onBeforeCompile with a bare call, which drops `this`.
  const self = this && this.userData ? this : null;
  if (!self) return;
  const cfg = self.userData.macro || null;
  const bnc = self.userData.bounce || null;
  if (!cfg && !bnc) return;

  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vMacroPos;')
    .replace('#include <project_vertex>', /* glsl */`
      #include <project_vertex>
      vec4 macroWorld = vec4( transformed, 1.0 );
      #ifdef USE_INSTANCING
        macroWorld = instanceMatrix * macroWorld;
      #endif
      vMacroPos = ( modelMatrix * macroWorld ).xyz;
    `);

  let head = '#include <common>\nvarying vec3 vMacroPos;\n';
  if (cfg) head += 'uniform vec4 uMacro;\n' + MACRO_GLSL;
  if (bnc) head += 'uniform vec3 uBounceCol;\nuniform vec3 uBounceP;\n';
  shader.fragmentShader = shader.fragmentShader.replace('#include <common>', head);

  if (cfg) {
    shader.uniforms.uMacro = { value: new THREE.Vector4(cfg.scale, cfg.colour, cfg.rough, cfg.warm) };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <map_fragment>', /* glsl */`
        float macroV = macroNoise( vMacroPos * uMacro.x ) - 0.5;
        #include <map_fragment>
        diffuseColor.rgb *= 1.0 + macroV * uMacro.y;
        diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * vec3( 1.08, 1.0, 0.90 ), macroV * uMacro.w + 0.5 );
      `)
      .replace('#include <roughnessmap_fragment>', /* glsl */`
        #include <roughnessmap_fragment>
        roughnessFactor = clamp( roughnessFactor * ( 1.0 + macroV * uMacro.z ), 0.035, 1.0 );
      `);
  }

  if (bnc) {
    shader.uniforms.uBounceCol = {
      value: new THREE.Color().setHex(bnc.colour, THREE.SRGBColorSpace).multiplyScalar(bnc.intensity),
    };
    shader.uniforms.uBounceP = {
      value: new THREE.Vector3(bnc.occlusion, Math.max(0.05, bnc.contactHeight), bnc.falloff),
    };
    // Indirect light on a *non-horizontal* face near the ground: darkened where
    // the geometry closes in on the slab (contact AO the shadow map cannot give
    // us), then lifted by a warm bounce term proportional to how much of the lit
    // plaza that face can see. A 3 m transition therefore runs from a dark
    // flat-bottom to a sunlit lip instead of reading as one flat value.
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <lights_fragment_end>', /* glsl */`
        #if defined( RE_IndirectDiffuse )
        {
          vec3 nWS = normalize( ( vec4( geometryNormal, 0.0 ) * viewMatrix ).xyz );
          float faceUp = clamp( 1.0 - abs( nWS.y ), 0.0, 1.0 );
          float hN = clamp( vMacroPos.y / uBounceP.y, 0.0, 1.0 );
          float contact = mix( uBounceP.x, 1.0, hN * hN * ( 3.0 - 2.0 * hN ) );
          float occ = mix( 1.0, contact, faceUp );
          irradiance *= occ;
          iblIrradiance *= occ;
          irradiance += ( irradiance + iblIrradiance ) * uBounceCol
            * ( faceUp * exp( -max( vMacroPos.y, 0.0 ) * uBounceP.z ) );
        }
        #endif
        #include <lights_fragment_end>
      `);
  }

  macroUniforms.set(self, shader.uniforms);
}

/** (Re)binds the shared hook according to whatever features userData declares. */
function installSurfaceShader(material) {
  const ud = material.userData;
  material.onBeforeCompile = (ud.macro || ud.bounce) ? surfaceOnBeforeCompile : noMacro;
  material.customProgramCacheKey = surfaceCacheKey;
  material.needsUpdate = true;
  return material;
}

/**
 * Low-frequency world-space colour/roughness variation on top of the tiled maps.
 * `scale` is in cycles per metre (0.03 ≈ one blotch every ~33 m).
 */
export function applyMacroVariation(material, { scale = 0.03, colour = 0.16, rough = 0.22, warm = 0.10 } = {}) {
  material.userData.macro = { scale, colour, rough, warm };
  return installSurfaceShader(material);
}

/**
 * Ground-bounce + contact-occlusion term for anything standing on the plaza.
 * Horizontal surfaces are untouched (faceUp == 0), so this never dims the slab
 * itself; vertical and transition faces get darker into the ground contact and
 * pick up warm irradiance reflected off the lit lot.
 *   occlusion    — indirect multiplier at ground level (1 = off)
 *   contactHeight— metres over which that darkening releases
 *   falloff      — 1/m decay of the bounce with height
 */
export function applyGroundBounce(material, {
  colour = 0xffd2a6, intensity = 0.34, occlusion = 0.46, contactHeight = 1.5, falloff = 0.40,
} = {}) {
  material.userData.bounce = { colour, intensity, occlusion, contactHeight, falloff };
  return installSurfaceShader(material);
}

// ---------------------------------------------------------------------------
// UV helpers (metre-space UVs — see the header note)
// ---------------------------------------------------------------------------

const AXIS_INDEX = { x: 0, y: 1, z: 2 };

/** Planar metre-UVs straight off the vertex positions. */
export function uvFromPlane(geometry, axisU = 'x', axisV = 'z', offsetU = 0, offsetV = 0) {
  const pos = geometry.attributes.position;
  const iu = AXIS_INDEX[axisU], iv = AXIS_INDEX[axisV];
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = pos.getComponent(i, iu) + offsetU;
    uv[i * 2 + 1] = pos.getComponent(i, iv) + offsetV;
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geometry;
}

/**
 * Triplanar-ish box projection: every triangle is projected down its dominant
 * normal axis, in metres. Returns a *non-indexed* geometry (per-face UVs need
 * split vertices) — always use the returned value.
 */
export function uvBox(geometry) {
  const geo = geometry.index ? geometry.toNonIndexed() : geometry;
  const pos = geo.attributes.position;
  const count = pos.count;
  const uv = new Float32Array(count * 2);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), nrm = new THREE.Vector3();
  for (let t = 0; t + 2 < count; t += 3) {
    a.fromBufferAttribute(pos, t);
    b.fromBufferAttribute(pos, t + 1);
    c.fromBufferAttribute(pos, t + 2);
    e1.subVectors(b, a); e2.subVectors(c, a);
    nrm.crossVectors(e1, e2);
    const nx = Math.abs(nrm.x), ny = Math.abs(nrm.y), nz = Math.abs(nrm.z);
    for (let k = 0; k < 3; k++) {
      const p = k === 0 ? a : k === 1 ? b : c;
      let u, v;
      if (ny >= nx && ny >= nz) { u = p.x; v = p.z; }
      else if (nx >= nz) { u = p.z; v = p.y; }
      else { u = p.x; v = p.y; }
      uv[(t + k) * 2] = u;
      uv[(t + k) * 2 + 1] = v;
    }
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

/** Multiply existing UVs (e.g. turning a 0..1 box UV set into metres). */
export function uvScaleGeometry(geometry, su, sv = su, ou = 0, ov = 0) {
  const uv = geometry.attributes.uv;
  if (!uv) return geometry;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * su + ou, uv.getY(i) * sv + ov);
  }
  uv.needsUpdate = true;
  return geometry;
}

const ownedTextures = new WeakMap();

const MAP_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'alphaMap', 'emissiveMap'];

/**
 * Give a material its own Texture objects so its repeat/offset can differ from
 * the library original. Clones share `.source`, so there is no extra VRAM and
 * no second upload — only the uv transform differs.
 * `sink` collects the clones for dispose(). Bookkeeping must stay off userData:
 * three's Material.copy() deep-clones userData through JSON.
 */
function ownTextures(material, sink) {
  if (ownedTextures.has(material)) return material;
  const seen = new Map();
  for (const slot of MAP_SLOTS) {
    const t = material[slot];
    if (!t) continue;
    let c = seen.get(t.uuid);
    if (!c) {
      c = t.clone();
      c.needsUpdate = false;
      seen.set(t.uuid, c);
      if (sink) sink.add(c);
    }
    material[slot] = c;
  }
  ownedTextures.set(material, [...seen.values()]);
  return material;
}

// ---------------------------------------------------------------------------
// recipes
// ---------------------------------------------------------------------------
// tile   = metres covered by one texture tile (texel density = res / tile)
// height = physical peak-to-peak amplitude of the height field, in metres;
//          it scales the sobel so every normal map has a real-world slope.

const RECIPES = [
  // The plaza slab: 2048² over a 3.0 m tile is ≈680 px/m, so the ground-detail
  // camera at 30 cm still has real texels under it, and the sawn joint grid
  // lands on 1.5 m centres. Macro period is ~16 m, three octaves, on albedo and
  // roughness both, which is what actually kills the visible tile march.
  { key: 'concrete', res: 2048, tile: 3.0, height: 0.008, gen: genConcrete,
    base: { roughness: 1, metalness: 0, envMapIntensity: 1.05 }, normalScale: 1.0,
    aoStrength: 6.5,
    macro: { scale: 0.062, colour: 0.20, rough: 0.26, warm: 0.12 },
    bounce: { intensity: 0.28, occlusion: 0.62, contactHeight: 1.1, falloff: 0.50 } },

  { key: 'concreteWorn', res: 1024, tile: 4.0, height: 0.014, gen: genConcreteWorn,
    base: { roughness: 1, metalness: 0, envMapIntensity: 1.05 }, normalScale: 1.0,
    aoStrength: 6.0,
    macro: { scale: 0.058, colour: 0.20, rough: 0.26, warm: 0.12 },
    bounce: { intensity: 0.34, occlusion: 0.52, contactHeight: 1.5, falloff: 0.40 } },

  { key: 'asphalt', res: 1024, tile: 5.0, height: 0.010, gen: genAsphalt,
    base: { roughness: 1, metalness: 0 }, normalScale: 1.0,
    macro: { scale: 0.020, colour: 0.20, rough: 0.18, warm: 0.08 } },

  { key: 'asphaltLine', res: 512, tile: 4.0, height: 0.010,
    gen: (r, S, b) => genAsphalt(r, S, b, { paintLine: true }),
    base: { roughness: 1, metalness: 0 }, normalScale: 1.0,
    macro: { scale: 0.020, colour: 0.14, rough: 0.14, warm: 0.08 } },

  { key: 'plywood', res: 1024, tile: 2.44, height: 0.006, gen: genSheet,
    base: { roughness: 1, metalness: 0 }, normalScale: 0.85,
    macro: { scale: 0.035, colour: 0.13, rough: 0.16, warm: 0.14 },
    bounce: { intensity: 0.30, occlusion: 0.60, contactHeight: 1.1, falloff: 0.48 } },

  // The ramp riding face. Full 1024² over one 8 ft sheet (≈420 px/m), lifted out
  // of the black clip point, with the panel seams and screw rows that make a
  // transition legible in silhouette. `rampSheet` is the same material.
  { key: 'skatelite', res: 1024, tile: 2.44, height: 0.0075, gen: genRampPanel,
    base: { roughness: 1, metalness: 0, envMapIntensity: 1.1 }, normalScale: 1.0,
    aoStrength: 6.0,
    macro: { scale: 0.048, colour: 0.14, rough: 0.20, warm: 0.10 },
    bounce: { intensity: 0.42, occlusion: 0.40, contactHeight: 1.8, falloff: 0.32 } },

  { key: 'wood', res: 512, tile: 1.6, height: 0.009, gen: genLumber,
    base: { roughness: 1, metalness: 0 }, normalScale: 1.0,
    macro: { scale: 0.060, colour: 0.12, rough: 0.12, warm: 0.12 } },

  { key: 'metalCoping', res: 512, tile: 0.55, height: 0.0011, gen: genCoping,
    base: { roughness: 1, metalness: 1, envMapIntensity: 1.45 }, metalMap: true, normalScale: 0.45 },

  { key: 'railSteel', res: 512, tile: 0.8, height: 0.0010, gen: genRailSteel,
    base: { roughness: 1, metalness: 1, envMapIntensity: 1.1 }, metalMap: true, normalScale: 0.6 },

  { key: 'paintedMetal', res: 512, tile: 1.0, height: 0.0016, gen: genPaintedMetal,
    // the enamel layer is authored near-white so `tint()` gives clean colourways;
    // the default is a municipal grey-blue so it never renders as bare paper
    base: { color: 0x8d949c, roughness: 1, metalness: 1, envMapIntensity: 1.0 },
    metalMap: true, normalScale: 0.8 },

  { key: 'chainlink', res: 512, tile: 1.15, height: 0.0042, gen: genChainlink,
    base: {
      roughness: 1, metalness: 1, envMapIntensity: 1.0,
      side: THREE.DoubleSide, shadowSide: THREE.DoubleSide, alphaTest: 0.5, transparent: false,
    },
    metalMap: true, normalScale: 1.0 },

  { key: 'brick', res: 512, tile: 2.0, height: 0.014, gen: genBrick,
    base: { roughness: 1, metalness: 0 }, normalScale: 1.0,
    macro: { scale: 0.030, colour: 0.16, rough: 0.14, warm: 0.10 },
    bounce: { intensity: 0.30, occlusion: 0.62, contactHeight: 1.0, falloff: 0.52 } },

  { key: 'corrugatedMetal', res: 512, tile: 1.0, height: 0.022, gen: genCorrugated,
    base: { roughness: 1, metalness: 1, envMapIntensity: 1.0 }, metalMap: true, normalScale: 1.0,
    macro: { scale: 0.050, colour: 0.14, rough: 0.16, warm: 0.10 } },

  { key: 'glass', res: 512, tile: 2.0, height: 0.0006, gen: genGlass, physical: true,
    base: {
      roughness: 1, metalness: 0, transparent: true, opacity: 0.30, depthWrite: false,
      side: THREE.DoubleSide, clearcoat: 1, clearcoatRoughness: 0.06, ior: 1.5,
      envMapIntensity: 1.6, dithering: true,
    }, normalScale: 0.35 },

  { key: 'grass', res: 512, tile: 1.6, height: 0.022, gen: genGrass,
    base: { roughness: 1, metalness: 0 }, normalScale: 1.0,
    macro: { scale: 0.050, colour: 0.20, rough: 0.10, warm: 0.16 } },

  { key: 'dirt', res: 1024, tile: 4.0, height: 0.022, gen: genDirt,
    base: { roughness: 1, metalness: 0 }, normalScale: 1.0,
    macro: { scale: 0.030, colour: 0.18, rough: 0.16, warm: 0.14 } },

  { key: 'rubber', res: 512, tile: 0.30, height: 0.0009, gen: genRubber,
    base: { roughness: 1, metalness: 0, envMapIntensity: 0.55 }, normalScale: 0.7 },

  { key: 'cloth', res: 512, tile: 0.34, height: 0.0011, gen: genCloth,
    base: { color: 0x6f7480, roughness: 1, metalness: 0, envMapIntensity: 0.7 }, normalScale: 0.8 },

  { key: 'plasticGloss', res: 256, tile: 0.5, height: 0.0005, gen: genPlastic,
    base: { color: 0x9aa0a8, roughness: 1, metalness: 0, envMapIntensity: 1.2 }, normalScale: 0.5 },

  { key: 'anodised', res: 512, tile: 0.40, height: 0.0004, gen: genAnodised,
    base: { roughness: 1, metalness: 1, envMapIntensity: 1.25 }, metalMap: true, normalScale: 0.55 },
];

/** Anodised / painted colourways for bike parts (cheap clones of `anodised`). */
const COLOURWAYS = {
  chrome: { colour: 0xf2f4f8, rough: 0.55, env: 1.50 },
  raw:    { colour: 0xc8ccd2, rough: 0.95, env: 1.15 },
  black:  { colour: 0x2b2d33, rough: 1.05, env: 1.00 },
  red:    { colour: 0x9e1f22, rough: 0.85, env: 1.15 },
  blue:   { colour: 0x1d4f9c, rough: 0.85, env: 1.15 },
  purple: { colour: 0x5a2b8c, rough: 0.85, env: 1.15 },
  gold:   { colour: 0xb98a25, rough: 0.75, env: 1.25 },
  teal:   { colour: 0x1a8c86, rough: 0.85, env: 1.15 },
};

// ---------------------------------------------------------------------------
// library
// ---------------------------------------------------------------------------

const nextTick = () => new Promise((r) => setTimeout(r, 0));

/**
 * Builds the whole procedural material library.
 * Accepts the shared `ctx` (main.js) or a bare WebGLRenderer.
 */
export async function createMaterials(ctx) {
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const t0 = now();

  const renderer = ctx?.isWebGLRenderer ? ctx : (ctx?.renderer || ctx?.engine?.renderer || null);
  const tier = ctx?.engine?.tier || null;
  const maxAniso = renderer?.capabilities?.getMaxAnisotropy?.() ?? 8;
  const aniso = Math.max(1, Math.min(maxAniso, tier?.anisotropy ?? 8));
  const resScale = tier?.name === 'low' ? 0.5 : 1;
  // The 2048² detail tier (the plaza slab) is ~3 s of generation and ~50 MB of
  // VRAM; the two lower tiers take it at 1024² (still 341 px/m over its 3 m tile).
  const detailCap = (tier?.name === 'low' || tier?.name === 'medium') ? 1024 : 4096;

  // deterministic regardless of what ran before; main.js' seed is restored after
  reseed(0x4d41544c);

  const banks = new Map();
  const getBank = (res) => {
    let b = banks.get(res);
    if (!b) { b = createBank(res); banks.set(res, b); }
    return b;
  };

  const lib = {};
  const materials = new Map();
  const textures = new Set();
  const variants = new Map();
  const clonedTextures = new Set();
  let texCount = 0;
  let lastYield = t0;

  let prevRes = 0;
  for (const rec of RECIPES) {
    const res = Math.max(128, Math.min((rec.res * resScale) | 0, detailCap));
    const tileU = Array.isArray(rec.tile) ? rec.tile[0] : rec.tile;
    const tileV = Array.isArray(rec.tile) ? rec.tile[1] : rec.tile;

    // The 2048² tier costs ~180 MB of scratch and ~100 MB of noise fields, so
    // release the previous resolution's working set as soon as the recipe list
    // moves off it instead of holding every tier until dispose().
    if (prevRes && prevRes !== res) {
      banks.get(prevRes)?.clear();
      banks.delete(prevRes);
      if (prevRes > 1024) scratchPool.delete(prevRes);
    }
    prevRes = res;

    const S = getScratch(res);
    rec.gen(res, S, getBank(res));

    const maps = packMaps(res, S, {
      heightMetres: rec.height,
      tileU, tileV,
      aoStrength: rec.aoStrength ?? 5.5,
      normalBoost: rec.normalBoost ?? 1,
    }, aniso);

    const params = {
      map: maps.map,
      normalMap: maps.normal,
      roughnessMap: maps.orm,
      aoMap: maps.orm,
      aoMapIntensity: rec.aoIntensity ?? 0.9,
      ...rec.base,
    };
    if (rec.metalMap) params.metalnessMap = maps.orm;

    const mat = rec.physical
      ? new THREE.MeshPhysicalMaterial(params)
      : new THREE.MeshStandardMaterial(params);
    mat.name = rec.key;
    mat.normalScale.set(rec.normalScale ?? 1, rec.normalScale ?? 1);
    mat.userData.tileMeters = { x: tileU, y: tileV };
    mat.userData.libName = rec.key;
    if (rec.macro) applyMacroVariation(mat, rec.macro);
    if (rec.bounce) applyGroundBounce(mat, rec.bounce);

    lib[rec.key] = mat;
    materials.set(rec.key, mat);
    textures.add(maps.map); textures.add(maps.normal); textures.add(maps.orm);
    texCount += 3;

    // keep the main thread responsive without paying a timer per material
    if (now() - lastYield > 60) { await nextTick(); lastYield = now(); }
  }

  // The ramp riding face under the name park.js actually asks for.
  lib.rampSheet = lib.skatelite;
  materials.set('rampSheet', lib.skatelite);

  // --- decal / graffiti atlas ----------------------------------------------
  const decalAtlas = buildDecalAtlas(resScale < 1 ? 512 : 1024, aniso);
  textures.add(decalAtlas);
  texCount++;

  const decalBase = new THREE.MeshStandardMaterial({
    map: decalAtlas,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
    roughness: 0.82,
    metalness: 0,
    alphaTest: 0.02,
  });
  decalBase.name = 'decal';
  decalBase.userData.libName = 'decal';
  decalBase.userData.tileMeters = { x: 1, y: 1 };
  lib.decal = decalBase;
  lib.decalAtlas = decalAtlas;
  materials.set('decal', decalBase);

  // --- bike colourways ------------------------------------------------------
  const anod = lib.anodised;
  const bikePaint = {};
  for (const [name, cw] of Object.entries(COLOURWAYS)) {
    const m = anod.clone();                   // shares the anodised textures
    m.name = `bike_${name}`;
    m.color = new THREE.Color(cw.colour);
    m.roughness = cw.rough;
    m.envMapIntensity = cw.env;
    m.metalness = 1;
    m.normalScale = anod.normalScale.clone();
    m.userData = { ...anod.userData, libName: `bike_${name}` };
    bikePaint[name] = m;
    materials.set(`bike_${name}`, m);
  }
  lib.bikePaint = bikePaint;
  lib.chrome = bikePaint.chrome;

  banks.forEach((b) => b.clear());
  banks.clear();
  reseed(0x5eed1e);       // hand the rng stream back exactly as main.js left it

  const genMs = now() - t0;

  // -------------------------------------------------------------------------
  // public API
  // -------------------------------------------------------------------------

  /** Change how many metres one texture tile covers (clones the textures first). */
  function setUvScale(material, metresPerTile) {
    const mx = Array.isArray(metresPerTile) ? metresPerTile[0] : metresPerTile;
    const my = Array.isArray(metresPerTile) ? metresPerTile[1] : metresPerTile;
    ownTextures(material, clonedTextures);
    const done = new Set();
    for (const slot of MAP_SLOTS) {
      const t = material[slot];
      if (!t || done.has(t.uuid)) continue;
      done.add(t.uuid);
      t.repeat.set(1 / mx, 1 / my);
      t.updateMatrix();
    }
    material.userData.tileMeters = { x: mx, y: my };
    material.needsUpdate = true;
    return material;
  }

  /**
   * Cached clone of a library material.
   * opts: { tile, color, roughness, metalness, envMapIntensity, normalScale,
   *         aoMapIntensity, side, transparent, opacity, emissive,
   *         emissiveIntensity, macro:{...}|false, name }
   */
  function variant(name, opts = {}) {
    const base = materials.get(name);
    if (!base) return lib.concrete;
    const key = name + '|' + JSON.stringify(opts);
    const cached = variants.get(key);
    if (cached) return cached;

    const m = base.clone();
    m.userData = { ...base.userData };
    m.normalScale = base.normalScale.clone();
    if (opts.tile !== undefined) setUvScale(m, opts.tile);
    if (opts.color !== undefined) m.color = new THREE.Color(opts.color);
    if (opts.roughness !== undefined) m.roughness = opts.roughness;
    if (opts.metalness !== undefined) m.metalness = opts.metalness;
    if (opts.envMapIntensity !== undefined) m.envMapIntensity = opts.envMapIntensity;
    if (opts.normalScale !== undefined) m.normalScale.setScalar(opts.normalScale);
    if (opts.aoMapIntensity !== undefined) m.aoMapIntensity = opts.aoMapIntensity;
    if (opts.side !== undefined) m.side = opts.side;
    if (opts.transparent !== undefined) m.transparent = opts.transparent;
    if (opts.opacity !== undefined) m.opacity = opts.opacity;
    if (opts.emissive !== undefined) m.emissive = new THREE.Color(opts.emissive);
    if (opts.emissiveIntensity !== undefined) m.emissiveIntensity = opts.emissiveIntensity;
    // Material.copy() does not carry onBeforeCompile across, so every clone has
    // to have the shared hook re-bound or it silently loses its macro/bounce.
    if (opts.macro === false) m.userData.macro = null;
    else if (opts.macro) m.userData.macro = { scale: 0.03, colour: 0.16, rough: 0.22, warm: 0.10, ...opts.macro };
    if (opts.bounce === false) m.userData.bounce = null;
    else if (opts.bounce) {
      m.userData.bounce = {
        colour: 0xffd2a6, intensity: 0.34, occlusion: 0.46, contactHeight: 1.5, falloff: 0.40,
        ...opts.bounce,
      };
    }
    installSurfaceShader(m);
    m.name = opts.name || `${name}_v${variants.size}`;

    variants.set(key, m);
    materials.set(m.name, m);
    return m;
  }

  /** Colourway helper: tinted clone (paint, banners, plastics, bike parts). */
  function tint(name, colour, opts = {}) {
    return variant(name, { color: colour, ...opts });
  }

  /** Atlas cell -> { offset, repeat } for a decal quad. */
  function decalUV(index) {
    const i = ((index % DECALS.length) + DECALS.length) % DECALS.length;
    const gx = i % DECAL_GRID, gy = (i / DECAL_GRID) | 0;
    const s = 1 / DECAL_GRID;
    // the atlas rows were flipped for GL, so cell rows count from the bottom
    return { offset: new THREE.Vector2(gx * s, 1 - (gy + 1) * s), repeat: new THREE.Vector2(s, s) };
  }

  /** Ready-to-use decal material for one atlas cell, by index or name (cached). */
  function decalMaterial(index, opts = {}) {
    let i = typeof index === 'string' ? DECALS.indexOf(index) : index;
    if (i < 0 || i === undefined || i === null) i = 0;
    const key = 'decal|' + i + '|' + JSON.stringify(opts);
    const cached = variants.get(key);
    if (cached) return cached;

    const m = decalBase.clone();
    m.userData = { ...decalBase.userData };
    ownTextures(m, clonedTextures);
    const { offset, repeat } = decalUV(i);
    m.map.offset.copy(offset);
    m.map.repeat.copy(repeat);
    m.map.wrapS = m.map.wrapT = THREE.ClampToEdgeWrapping;
    m.map.updateMatrix();
    if (opts.color !== undefined) m.color = new THREE.Color(opts.color);
    if (opts.roughness !== undefined) m.roughness = opts.roughness;
    if (opts.opacity !== undefined) m.opacity = opts.opacity;
    if (opts.depthWrite !== undefined) m.depthWrite = opts.depthWrite;
    if (opts.side !== undefined) m.side = opts.side;
    m.name = 'decal_' + (DECALS[i] || i);

    variants.set(key, m);
    materials.set(m.name, m);
    return m;
  }

  const api = {
    ...lib,

    /** Material by name; falls back to concrete so a typo never crashes the park. */
    get(name) { return materials.get(name) || lib.concrete; },
    has(name) { return materials.has(name); },
    names() { return [...materials.keys()]; },

    /** Metres covered by one texture tile of `name`. */
    tileMeters(name) { return (materials.get(name) || lib.concrete).userData.tileMeters; },

    variant,
    tint,
    setUvScale,
    /** Live uniforms of a macro-variation material (null until first render). */
    macroUniformsOf(material) { return macroUniforms.get(material) || null; },
    applyMacroVariation,
    uvFromPlane,
    uvBox,
    uvScaleGeometry,

    decals: DECALS,
    decalUV,
    decalMaterial,

    bikePaint,
    bikeColorways: Object.keys(COLOURWAYS),

    anisotropy: aniso,
    stats: { textures: texCount, materials: materials.size, ms: Math.round(genMs) },

    dispose() {
      for (const m of materials.values()) m.dispose();
      for (const t of clonedTextures) t.dispose();
      for (const t of textures) t.dispose();
      materials.clear();
      variants.clear();
      textures.clear();
      clonedTextures.clear();
      scratchPool.clear();
    },
  };

  console.info(`[materials] ${materials.size} materials, ${texCount} textures, ${Math.round(genMs)} ms, aniso ${aniso}`);
  return api;
}

export default createMaterials;
