// Set dressing, backdrop and atmosphere for the city-lot park: perimeter chainlink
// fence, spectator furniture, litter, parked vehicles, a crowd, lighting rigs,
// planting beyond the fence and the distant skyline.
//
// Everything here is procedural and deterministic (mathx rng), every repeat is an
// InstancedMesh and every static cluster is merged per material, so the whole set
// costs a few dozen draw calls. Wind/idle motion happens in vertex shaders; the
// per-frame update only pushes a clock and the dusk lighting blend.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { rng, rand, randInt, pick, clamp, lerp, smoothstep, fbm2, seed, TAU } from '../core/mathx.js';

// --- layout ----------------------------------------------------------------
// The lot is a rectangle; the park itself lives inside ~±26 m so all dressing is
// kept out at the perimeter.
const LOT = { hx: 42, hz: 36 };

/**
 * A point `gap` metres beyond the lot boundary along heading `a`. Walking out
 * along a ray and leaving the rectangle is the only placement that is correct at
 * the corners as well as the flats — scaling an ellipse by (hx+gap, hz+gap) puts
 * points at 45° back *inside* the fence.
 */
function outsideLot(a, gap, padX = 0, padZ = 0) {
  const dx = Math.cos(a), dz = Math.sin(a);
  const tx = Math.abs(dx) > 1e-5 ? (LOT.hx + padX) / Math.abs(dx) : Infinity;
  const tz = Math.abs(dz) > 1e-5 ? (LOT.hz + padZ) / Math.abs(dz) : Infinity;
  const r = Math.min(tx, tz) + gap;
  return { x: dx * r, z: dz * r, r };
}
const FENCE_H = 2.2;
const BAY = 3.0;                     // fence bay width (metres)
const GATE = { centre: 14, width: 5.4 };   // opening in the +Z run
const SHADOW_RADIUS = 46;            // beyond this nothing casts shadows
const GROUND_Y = -0.32;              // the plane the whole backdrop stands on

// Cut-out thresholds. Every one of these is fed to both the material and the
// mip builder, so the coverage the artist authored survives every mip level.
const LEAF_CUT = 0.42;
const PALM_CUT = 0.36;
const WEED_CUT = 0.40;
const LITTER_CUT = 0.35;
const FENCE_CUT = 0.50;

// scratch — no allocation in any loop that runs more than once per build
const _m4 = new THREE.Matrix4();
const _m4b = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _pos = new THREE.Vector3();
const _scl = new THREE.Vector3(1, 1, 1);
const _col = new THREE.Color();

// ---------------------------------------------------------------------------
// small geometry helpers — all produce position/normal/uv only, so anything can
// be merged with anything sharing a material.
// ---------------------------------------------------------------------------

/**
 * fbm2 from mathx returns roughly [0, 0.43] with a 0.23 mean, so rescale it
 * whenever a full-range 0..1 field is wanted.
 */
function noise01(x, y, octaves = 4) {
  return clamp(fbm2(x, y, octaves) * 2.32, 0, 1);
}

/** Box with UVs in metres on every face (keeps texel density honest). */
function box(w, h, d) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  const size = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    const su = size[f][0], sv = size[f][1];
    for (let i = 0; i < 4; i++) {
      const k = f * 4 + i;
      uv.setXY(k, uv.getX(k) * su, uv.getY(k) * sv);
    }
  }
  return g;
}

/** Cylinder with UVs in metres around the barrel. */
function cyl(rTop, rBot, h, seg = 10, openEnded = false) {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, openEnded);
  const uv = g.attributes.uv;
  const circ = Math.PI * (rTop + rBot);
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * circ, uv.getY(i) * h);
  return g;
}

/** XY plane with UVs in metres. */
function planeM(w, h, ws = 1, hs = 1) {
  const g = new THREE.PlaneGeometry(w, h, ws, hs);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w, uv.getY(i) * h);
  return g;
}

/** XY plane whose UVs land inside cell `i` of a cols×rows atlas. */
function planeCell(w, h, ws, hs, i, cols, rows) {
  const g = new THREE.PlaneGeometry(w, h, ws, hs);
  const uv = g.attributes.uv;
  const cx = i % cols, cy = (i / cols) | 0;
  const su = 1 / cols, sv = 1 / rows;
  const u0 = cx * su, v0 = 1 - (cy + 1) * sv;
  for (let k = 0; k < uv.count; k++) uv.setXY(k, u0 + uv.getX(k) * su, v0 + uv.getY(k) * sv);
  return g;
}

/** Position/rotate a geometry in place (YXZ order, matching how props are placed). */
function place(g, x = 0, y = 0, z = 0, ry = 0, rx = 0, rz = 0) {
  _euler.set(rx, ry, rz, 'YXZ');
  _quat.setFromEuler(_euler);
  _scl.set(1, 1, 1);
  _m4.compose(_pos.set(x, y, z), _quat, _scl);
  g.applyMatrix4(_m4);
  return g;
}

/** Uniform vertex colour on a geometry, so merged clusters keep per-piece tint. */
function tintGeo(g, hex, jitter = 0) {
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  _col.setHex(hex, THREE.SRGBColorSpace);
  for (let i = 0; i < n; i++) {
    const j = jitter ? 1 + rand(-jitter, jitter) : 1;
    arr[i * 3] = _col.r * j; arr[i * 3 + 1] = _col.g * j; arr[i * 3 + 2] = _col.b * j;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

/** Scale x/z across a height range — gives boxy limbs and torsos a silhouette. */
function taperY(g, y0, y1, s0, s1) {
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    const t = clamp((y - y0) / (y1 - y0), 0, 1);
    const s = lerp(s0, s1, t);
    p.setXYZ(i, p.getX(i) * s, y, p.getZ(i) * s);
  }
  g.computeVertexNormals();
  return g;
}

/** Constant float attribute (used for shader region masks). */
function floatAttr(g, name, value) {
  const n = g.attributes.position.count;
  const arr = new Float32Array(n);
  arr.fill(value);
  g.setAttribute(name, new THREE.BufferAttribute(arr, 1));
  return g;
}

const KEEP = ['position', 'normal', 'uv', 'color', 'aRegion', 'aFlex', 'aWind', 'aHaze'];
/**
 * Drop attributes nothing reads and guarantee an index — mergeGeometries refuses
 * to mix indexed and non-indexed inputs, and the polyhedra come in non-indexed.
 */
function strip(g) {
  for (const k of Object.keys(g.attributes)) if (!KEEP.includes(k)) g.deleteAttribute(k);
  if (!g.index) {
    const n = g.attributes.position.count;
    const idx = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  return g;
}

/**
 * Per-material geometry accumulator. Everything dropped in gets merged into one
 * mesh per material on flush — one draw call per material, not per prop.
 */
function createBucket() {
  const map = new Map();
  return {
    add(material, geo) {
      if (!geo) return;
      strip(geo);
      let list = map.get(material);
      if (!list) map.set(material, (list = []));
      list.push(geo);
    },
    get size() { return map.size; },
    flush(parent, owned, { cast = false, receive = false, name = 'merged' } = {}) {
      const meshes = [];
      for (const [material, list] of map) {
        // every geometry in a bucket must agree on attributes for the merge
        const wantColor = list.some((g) => !!g.attributes.color);
        if (wantColor) for (const g of list) if (!g.attributes.color) tintGeo(g, 0xffffff);
        const merged = list.length === 1 ? list[0] : mergeGeometries(list, false);
        if (!merged) continue;
        if (list.length > 1) for (const g of list) g.dispose();
        merged.computeBoundingSphere();
        const mesh = new THREE.Mesh(merged, material);
        mesh.name = `${name}_${material.name || 'mat'}`;
        mesh.castShadow = cast;
        mesh.receiveShadow = receive;
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        parent.add(mesh);
        owned.geo.push(merged);
        meshes.push(mesh);
      }
      map.clear();
      return meshes;
    },
  };
}

// ---------------------------------------------------------------------------
// canvas texture helpers
// ---------------------------------------------------------------------------

function canvas2d(w, h) {
  const c = (typeof OffscreenCanvas !== 'undefined')
    ? new OffscreenCanvas(w, h)
    : document.createElement('canvas');
  c.width = w; c.height = h;
  return { canvas: c, g: c.getContext('2d') };
}

function makeTex(canvas, { srgb = true, wrap = THREE.ClampToEdgeWrapping, aniso = 8, repeat = null } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = wrap;
  t.anisotropy = aniso;
  if (repeat) t.repeat.set(repeat[0], repeat[1]);
  t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------------------
// alpha cut-out plumbing
//
// Canvas 2D leaves fully transparent texels at RGB 0. Mipmapping and bilinear
// filtering then average that black into every leaf, frond and wire edge, and
// once the sRGB decode plus the tonemapper get hold of the result it shows up
// as the coloured sparkle the art director called out. Two passes fix it for
// good:
//
//   1. dilate the albedo outward under the alpha, so a transparent texel
//      carries its neighbour's colour instead of the key colour;
//   2. build the mip chain by hand and rescale the alpha of every level so the
//      fraction of texels passing `alphaTest` matches level 0 — otherwise a
//      chainlink weave that covers 30 % of its tile simply dissolves (or, with
//      a low threshold, floods solid) as soon as the first mip kicks in.
// ---------------------------------------------------------------------------

function pixelsOf(canvas) {
  return canvas.getContext('2d', { willReadFrequently: true })
    .getImageData(0, 0, canvas.width, canvas.height);
}

/** Push opaque RGB outward into the transparent texels, in place. */
function dilateAlpha(canvas, passes = 6) {
  const w = canvas.width, h = canvas.height;
  if (w < 2 || h < 2) return canvas;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  const img = g.getImageData(0, 0, w, h);
  const d = img.data;
  const n = w * h;
  const filled = new Uint8Array(n);
  let opaque = 0;
  for (let i = 0; i < n; i++) { if (d[i * 4 + 3] > 6) { filled[i] = 1; opaque++; } }
  if (!opaque || opaque === n) return canvas;
  const next = new Uint8Array(n);
  for (let p = 0; p < passes; p++) {
    next.set(filled);
    let grew = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (filled[i]) continue;
        let r = 0, gg = 0, b = 0, c = 0;
        for (let oy = -1; oy <= 1; oy++) {
          const sy = y + oy;
          if (sy < 0 || sy >= h) continue;
          for (let ox = -1; ox <= 1; ox++) {
            const sx = x + ox;
            if (sx < 0 || sx >= w) continue;
            const j = sy * w + sx;
            if (!filled[j]) continue;
            r += d[j * 4]; gg += d[j * 4 + 1]; b += d[j * 4 + 2]; c++;
          }
        }
        if (!c) continue;
        d[i * 4] = (r / c) | 0; d[i * 4 + 1] = (gg / c) | 0; d[i * 4 + 2] = (b / c) | 0;
        next[i] = 1; grew = 1;
      }
    }
    filled.set(next);
    if (!grew) break;
  }
  g.putImageData(img, 0, 0);
  return canvas;
}

function alphaCoverage(data, cut) {
  let n = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] >= cut) n++;
  return n / (data.length >> 2);
}

/** Scale a level's alpha so `target` of its texels still pass the cut. */
function rescaleAlphaToCoverage(data, cut, target) {
  const px = data.length >> 2;
  let lo = 0.05, hi = 12, s = 1;
  for (let it = 0; it < 18; it++) {
    s = (lo + hi) * 0.5;
    let n = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] * s >= cut) n++;
    if (n / px > target) hi = s; else lo = s;
  }
  if (Math.abs(s - 1) < 0.01) return;
  for (let i = 3; i < data.length; i += 4) data[i] = Math.min(255, Math.round(data[i] * s));
}

/** Full mip chain down to 1x1, alpha-rescaled to hold level 0's coverage. */
function coverageMipChain(base, alphaTest) {
  const cut = alphaTest * 255;
  const target = alphaCoverage(pixelsOf(base).data, cut);
  const chain = [base];
  let src = base, w = base.width, h = base.height;
  while (w > 1 || h > 1) {
    w = Math.max(1, w >> 1); h = Math.max(1, h >> 1);
    const { canvas, g } = canvas2d(w, h);
    g.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in g) g.imageSmoothingQuality = 'high';
    g.clearRect(0, 0, w, h);
    g.drawImage(src, 0, 0, w, h);
    if (w > 1 && h > 1 && target > 0 && target < 1) {
      const img = g.getImageData(0, 0, w, h);
      rescaleAlphaToCoverage(img.data, cut, target);
      g.putImageData(img, 0, 0);
      dilateAlpha(canvas, 2);
    }
    chain.push(canvas);
    src = canvas;
  }
  return chain;
}

/**
 * Texture for an alpha-tested cut-out: dilated albedo, hand-built
 * coverage-preserving mips, anisotropy forced to at least 8 whatever the
 * quality tier says (these are the maps that alias the hardest).
 */
function makeCutoutTex(canvas, {
  alphaTest = 0.5, aniso = 8, wrap = THREE.ClampToEdgeWrapping,
  repeat = null, srgb = true, dilate = 6,
} = {}) {
  dilateAlpha(canvas, dilate);
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = wrap;
  t.anisotropy = Math.max(8, aniso);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = false;
  t.mipmaps = coverageMipChain(canvas, alphaTest);
  if (repeat) t.repeat.set(repeat[0], repeat[1]);
  t.needsUpdate = true;
  return t;
}

/** Grey height field -> tangent-space normal map canvas. */
function normalFromHeight(src, strength = 2.0) {
  const w = src.width, h = src.height;
  const s = pixelsOf(src).data;
  const { canvas, g } = canvas2d(w, h);
  const out = g.createImageData(w, h);
  const o = out.data;
  const at = (x, y) => {
    const xx = (x + w) % w, yy = (y + h) % h;
    const i = (yy * w + xx) * 4;
    return (s[i] * 0.299 + s[i + 1] * 0.587 + s[i + 2] * 0.114) / 255;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      let nx = -dx, ny = dy, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      const i = (y * w + x) * 4;
      o[i] = (nx * 0.5 + 0.5) * 255;
      o[i + 1] = (ny * 0.5 + 0.5) * 255;
      o[i + 2] = (nz * 0.5 + 0.5) * 255;
      o[i + 3] = 255;
    }
  }
  g.putImageData(out, 0, 0);
  return canvas;
}

const FONT = '"Arial Narrow", "Helvetica Neue", Impact, sans-serif';

/** Draw text scaled to fit a width, returns the used font size. */
function fitText(g, text, cx, cy, maxW, size, weight = '900', align = 'center') {
  let s = size;
  g.font = `${weight} ${s}px ${FONT}`;
  let w = g.measureText(text).width;
  if (w > maxW) { s = Math.max(8, s * (maxW / w)); g.font = `${weight} ${s}px ${FONT}`; }
  g.textAlign = align;
  g.textBaseline = 'middle';
  g.fillText(text, cx, cy);
  return s;
}

/** Grime pass: dust, scratches, faded blotches. Deterministic. */
function weather(g, x, y, w, h, amount = 1) {
  g.save();
  g.beginPath(); g.rect(x, y, w, h); g.clip();
  for (let i = 0; i < 90 * amount; i++) {
    const bx = x + rand(0, w), by = y + rand(0, h);
    const r = rand(3, 30);
    g.fillStyle = `rgba(${randInt(120, 190)},${randInt(110, 175)},${randInt(95, 160)},${rand(0.02, 0.10)})`;
    g.beginPath(); g.ellipse(bx, by, r * rand(0.6, 2.2), r, rand(0, Math.PI), 0, TAU); g.fill();
  }
  g.lineWidth = 1;
  for (let i = 0; i < 40 * amount; i++) {
    g.strokeStyle = `rgba(255,255,255,${rand(0.02, 0.08)})`;
    g.beginPath();
    const sx = x + rand(0, w), sy = y + rand(0, h);
    g.moveTo(sx, sy);
    g.lineTo(sx + rand(-60, 60), sy + rand(-10, 10));
    g.stroke();
  }
  // soiled bottom edge
  const grad = g.createLinearGradient(0, y + h * 0.55, 0, y + h);
  grad.addColorStop(0, 'rgba(60,50,38,0)');
  grad.addColorStop(1, 'rgba(60,50,38,0.34)');
  g.fillStyle = grad;
  g.fillRect(x, y + h * 0.55, w, h * 0.45);
  g.restore();
}

// ---------------------------------------------------------------------------
// procedural textures
// ---------------------------------------------------------------------------

// Invented brands only — nothing here references a real trademark.
const BANNERS = [
  { name: 'VOLTCOLA', tag: 'DRINK IT SIDEWAYS', bg: '#c1272d', fg: '#fff3e0', ac: '#f4b41a', style: 'chevron' },
  { name: 'GRIT', tag: 'ENERGY / 24 PACK', bg: '#15202b', fg: '#e9f24a', ac: '#e9f24a', style: 'block' },
  { name: 'HALFCUT', tag: 'WHEELS + HUBS', bg: '#f0eee6', fg: '#1c1c22', ac: '#e0562a', style: 'stripe' },
  { name: 'IRONHIDE', tag: 'PEGS / CRANKS', bg: '#2f3a44', fg: '#ffffff', ac: '#7fd1e0', style: 'gradient' },
  { name: 'NEON DECAY', tag: 'RECORDS', bg: '#3c1f5e', fg: '#ffd6f2', ac: '#ff4fa3', style: 'block' },
  { name: 'LOT 14 JAM', tag: 'AM / PRO / OPEN', bg: '#e8d9b0', fg: '#22201c', ac: '#b4451f', style: 'stripe' },
  { name: 'RUSTBELT', tag: 'FRAMES SINCE 91', bg: '#7a3b18', fg: '#ffe6c4', ac: '#f0a13c', style: 'chevron' },
  { name: 'APEX 32', tag: 'TYRES', bg: '#101418', fg: '#ffffff', ac: '#37c26c', style: 'gradient' },
  { name: 'NO SKATING', tag: 'AFTER 10 PM', bg: '#f4f2ea', fg: '#b4241f', ac: '#1a1a1a', style: 'sign' },
  { name: 'PARK RULES', tag: 'HELMET / OWN RISK', bg: '#1f5fa8', fg: '#ffffff', ac: '#ffd23f', style: 'sign' },
  { name: 'STAFF ONLY', tag: 'GATE 3', bg: '#f2c00d', fg: '#1a1a1a', ac: '#1a1a1a', style: 'sign' },
  { name: 'CITY PARKS', tag: 'DIST. 14', bg: '#2b6b4f', fg: '#f2f6ee', ac: '#ffffff', style: 'sign' },
  { name: 'DUSTLINE', tag: 'MOTOR OIL', bg: '#0d1b2a', fg: '#ffce4a', ac: '#ffce4a', style: 'gradient' },
  { name: 'KILOWATT', tag: 'POWER CO.', bg: '#d7d2c4', fg: '#1b2430', ac: '#e2483c', style: 'stripe' },
  { name: 'SUNVAULT', tag: 'STORAGE UNITS', bg: '#e26a2c', fg: '#fff6e8', ac: '#2b2b33', style: 'block' },
  { name: 'THE BEND', tag: 'DINER / OPEN 24H', bg: '#122a2a', fg: '#ffe9c9', ac: '#f25f4c', style: 'chevron' },
];

const ATLAS_COLS = 4, ATLAS_ROWS = 4;

/** 4×4 atlas of sponsor banners, vinyl signage and rooftop billboards. */
function makeBannerAtlas() {
  const CW = 512, CH = 256;
  const { canvas, g } = canvas2d(CW * ATLAS_COLS, CH * ATLAS_ROWS);
  for (let i = 0; i < BANNERS.length; i++) {
    const s = BANNERS[i];
    const x = (i % ATLAS_COLS) * CW, y = ((i / ATLAS_COLS) | 0) * CH;
    g.save();
    g.translate(x, y);

    g.fillStyle = s.bg;
    g.fillRect(0, 0, CW, CH);

    if (s.style === 'chevron') {
      g.fillStyle = s.ac;
      for (let k = -2; k < 10; k++) {
        g.beginPath();
        const bx = k * 64;
        g.moveTo(bx, CH); g.lineTo(bx + 34, 0); g.lineTo(bx + 60, 0); g.lineTo(bx + 26, CH);
        g.closePath(); g.globalAlpha = 0.22; g.fill();
      }
      g.globalAlpha = 1;
    } else if (s.style === 'stripe') {
      g.fillStyle = s.ac;
      g.fillRect(0, CH - 42, CW, 16);
      g.fillRect(0, 26, CW, 6);
    } else if (s.style === 'gradient') {
      const gr = g.createLinearGradient(0, 0, CW, CH);
      gr.addColorStop(0, s.ac); gr.addColorStop(0.42, s.bg); gr.addColorStop(1, s.bg);
      g.globalAlpha = 0.55; g.fillStyle = gr; g.fillRect(0, 0, CW, CH); g.globalAlpha = 1;
    } else if (s.style === 'block') {
      g.fillStyle = s.ac;
      g.globalAlpha = 0.85;
      g.fillRect(CW - 150, 0, 150, CH);
      g.globalAlpha = 1;
    }

    if (s.style === 'sign') {
      g.strokeStyle = s.fg; g.lineWidth = 8;
      g.strokeRect(14, 14, CW - 28, CH - 28);
      g.fillStyle = s.fg;
      fitText(g, s.name, CW / 2, CH * 0.42, CW - 70, 92);
      g.fillStyle = s.ac;
      fitText(g, s.tag, CW / 2, CH * 0.72, CW - 90, 42, '700');
    } else {
      // logo mark
      g.fillStyle = s.ac;
      g.beginPath(); g.arc(74, CH * 0.5, 40, 0, TAU); g.fill();
      g.fillStyle = s.bg;
      g.beginPath(); g.arc(74, CH * 0.5, 26, 0, TAU); g.fill();
      g.fillStyle = s.ac;
      g.beginPath(); g.moveTo(60, CH * 0.5 - 16); g.lineTo(96, CH * 0.5); g.lineTo(60, CH * 0.5 + 16); g.closePath(); g.fill();

      g.fillStyle = s.fg;
      g.textAlign = 'left';
      fitText(g, s.name, 132, CH * 0.42, CW - 168, 104, '900', 'left');
      g.fillStyle = s.ac;
      fitText(g, s.tag, 134, CH * 0.70, CW - 180, 40, '700', 'left');
      g.textAlign = 'center';
    }

    // grommets down the top and bottom edges
    g.fillStyle = 'rgba(30,30,34,0.85)';
    for (let k = 0; k < 6; k++) {
      const gx = 40 + k * ((CW - 80) / 5);
      g.beginPath(); g.arc(gx, 16, 7, 0, TAU); g.fill();
      g.beginPath(); g.arc(gx, CH - 16, 7, 0, TAU); g.fill();
    }
    g.fillStyle = 'rgba(210,210,215,0.7)';
    for (let k = 0; k < 6; k++) {
      const gx = 40 + k * ((CW - 80) / 5);
      g.beginPath(); g.arc(gx, 16, 4, 0, TAU); g.fill();
      g.beginPath(); g.arc(gx, CH - 16, 4, 0, TAU); g.fill();
    }

    // vinyl sheen: soft vertical bands so the flat fill never reads as paper
    for (let k = 0; k < 14; k++) {
      const bx = rand(0, CW);
      const gr = g.createLinearGradient(bx - 40, 0, bx + 40, 0);
      gr.addColorStop(0, 'rgba(255,255,255,0)');
      gr.addColorStop(0.5, `rgba(255,255,255,${rand(0.03, 0.09)})`);
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.fillRect(bx - 40, 0, 80, CH);
    }
    weather(g, 0, 0, CW, CH, 0.7);
    g.restore();
  }
  return canvas;
}

/** Leaf clusters: canopy in the top half, shrub mass in the bottom half. */
function makeLeafTexture() {
  const S = 512;
  const { canvas, g } = canvas2d(S, S);
  g.clearRect(0, 0, S, S);

  const blob = (cx, cy, rx, ry, n, hues, dark) => {
    for (let i = 0; i < n; i++) {
      const a = rand(0, TAU), r = Math.pow(rng(), 0.55);
      const px = cx + Math.cos(a) * rx * r;
      const py = cy + Math.sin(a) * ry * r * 0.92 + ry * 0.08 * r;
      const size = rand(7, 20) * (1 - r * 0.35);
      const shade = clamp(0.45 + (1 - (py - (cy - ry)) / (2 * ry)) * 0.75 + rand(-0.14, 0.14), 0.2, 1.25);
      const h = pick(hues);
      _col.setHex(h, THREE.SRGBColorSpace);
      const rr = Math.round(clamp(_col.r * 255 * shade * (dark ? 0.82 : 1), 0, 255));
      const gg = Math.round(clamp(_col.g * 255 * shade * (dark ? 0.82 : 1), 0, 255));
      const bb = Math.round(clamp(_col.b * 255 * shade * (dark ? 0.82 : 1), 0, 255));
      g.fillStyle = `rgba(${rr},${gg},${bb},${rand(0.72, 1)})`;
      g.save();
      g.translate(px, py); g.rotate(rand(0, TAU));
      g.beginPath(); g.ellipse(0, 0, size, size * rand(0.42, 0.75), 0, 0, TAU); g.fill();
      g.restore();
    }
  };

  // canopy cell (top half): dense, warm-lit crown, thinner silhouette edge
  blob(S * 0.5, S * 0.25, S * 0.44, S * 0.21, 900, [0x4a6b28, 0x5f7f31, 0x6f8f38, 0x3d5a22, 0x86a04a], false);
  // a couple of gaps so it does not read as one solid mass
  g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 22; i++) {
    g.beginPath();
    g.ellipse(rand(S * 0.1, S * 0.9), rand(S * 0.04, S * 0.46), rand(6, 26), rand(5, 18), rand(0, TAU), 0, TAU);
    g.fillStyle = 'rgba(0,0,0,1)'; g.fill();
  }
  g.globalCompositeOperation = 'source-over';

  // shrub cell (bottom half): rounder, darker, sits on the ground
  blob(S * 0.5, S * 0.76, S * 0.42, S * 0.20, 760, [0x53702c, 0x627f34, 0x445c22, 0x74904a], false);

  // clear a margin around both cells so quad edges and the cell seam are empty
  g.globalCompositeOperation = 'destination-out';
  g.fillStyle = 'rgba(0,0,0,1)';
  const m = 7;
  g.fillRect(0, 0, S, m); g.fillRect(0, S - m, S, m);
  g.fillRect(0, 0, m, S); g.fillRect(S - m, 0, m, S);
  g.fillRect(0, S * 0.5 - m, S, m * 2);
  g.globalCompositeOperation = 'source-over';
  return canvas;
}

/** Weed / grass tuft, alpha-cut. */
function makeWeedTexture() {
  const S = 256;
  const { canvas, g } = canvas2d(S, S);
  g.clearRect(0, 0, S, S);
  for (let i = 0; i < 90; i++) {
    const x0 = S * 0.5 + rand(-S * 0.36, S * 0.36);
    const h = rand(S * 0.35, S * 0.92);
    const bend = rand(-S * 0.22, S * 0.22);
    const w = rand(2.5, 6.5);
    const green = pick([0x6f7a34, 0x8a913f, 0x55632a, 0x9aa04c, 0x7d6f2e]);
    _col.setHex(green, THREE.SRGBColorSpace);
    g.strokeStyle = `rgba(${(_col.r * 255) | 0},${(_col.g * 255) | 0},${(_col.b * 255) | 0},${rand(0.7, 1)})`;
    g.lineWidth = w;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(x0, S);
    g.quadraticCurveTo(x0 + bend * 0.4, S - h * 0.55, x0 + bend, S - h);
    g.stroke();
  }
  // a few dry seed heads
  for (let i = 0; i < 12; i++) {
    g.fillStyle = `rgba(${randInt(160, 200)},${randInt(150, 180)},${randInt(90, 120)},0.9)`;
    g.beginPath();
    g.ellipse(S * 0.5 + rand(-S * 0.3, S * 0.3), rand(S * 0.08, S * 0.4), rand(2, 4), rand(6, 12), rand(-0.4, 0.4), 0, TAU);
    g.fill();
  }
  return canvas;
}

// --- facades ---------------------------------------------------------------
// Three tileable facade treatments, each 12.8 m square (four 3.2 m floors by
// eight 1.6 m bays). Buildings pick a treatment, then scale and offset their UVs
// per building, so window pitch, floor alignment and the pattern of lit windows
// all differ from neighbour to neighbour without an atlas or a second texture.
//
// Each treatment returns three canvases:
//   color     — albedo (sRGB)
//   orm       — G = roughness, B = metalness (the channels three reads)
//   emissive  — lit windows, black elsewhere
const FACADE_M = 12.8;
const FACADE_PX = 512;

function makeFacade(kind) {
  const S = FACADE_PX;
  const FL = 4, BAYS = 8;
  const fh = S / FL, bw = S / BAYS;
  const cc = canvas2d(S, S), oo = canvas2d(S, S), ee = canvas2d(S, S);
  const g = cc.g, og = oo.g, eg = ee.g;

  /** Roughness/metalness patch. */
  const orm = (x, y, w, h, r, m) => {
    og.fillStyle = `rgb(0,${(clamp(r, 0, 1) * 255) | 0},${(clamp(m, 0, 1) * 255) | 0})`;
    og.fillRect(x, y, w, h);
  };
  /** Lit window in the emissive map, with blinds/occupancy breaking it up. */
  const litWindow = (x, y, w, h, chance) => {
    if (rng() > chance) return;
    const warm = rng() < 0.80;
    const i = rand(0.30, 1.0);
    eg.fillStyle = warm
      ? `rgb(${(255 * i) | 0},${(203 * i) | 0},${(138 * i) | 0})`
      : `rgb(${(172 * i) | 0},${(210 * i) | 0},${(246 * i) | 0})`;
    eg.fillRect(x, y, w, h);
    eg.fillStyle = 'rgba(0,0,0,0.5)';
    const k = randInt(0, 3);
    if (k === 1) eg.fillRect(x, y, w, h * rand(0.2, 0.55));            // blinds down
    if (k === 2) eg.fillRect(x + w * rand(0.1, 0.55), y + h * 0.35, w * 0.2, h * 0.65);
    if (k === 3) eg.fillRect(x, y + h * rand(0.5, 0.75), w, h * 0.5);  // desk line
  };
  /**
   * Glass, with the sky mirrored in the upper part of the pane and the room
   * behind it going dark below the reflected horizon — the thing that makes a
   * distant facade read as glazing and not as a grey rectangle.
   */
  const glass = (x, y, w, h, warm) => {
    const gr = g.createLinearGradient(0, y, 0, y + h);
    if (warm) {
      gr.addColorStop(0.00, '#cbb79b');
      gr.addColorStop(0.26, '#8e8177');
      gr.addColorStop(0.36, '#2c313b');
      gr.addColorStop(1.00, '#151920');
    } else {
      gr.addColorStop(0.00, '#a8b1bd');
      gr.addColorStop(0.28, '#727e8e');
      gr.addColorStop(0.38, '#262d38');
      gr.addColorStop(1.00, '#12161d');
    }
    g.fillStyle = gr;
    g.fillRect(x, y, w, h);
    g.save();
    g.beginPath(); g.rect(x, y, w, h); g.clip();
    const st = g.createLinearGradient(x, y + h, x + w, y);
    st.addColorStop(0, 'rgba(255,255,255,0)');
    st.addColorStop(0.5, `rgba(255,238,214,${rand(0.05, 0.17)})`);
    st.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = st;
    g.fillRect(x, y, w, h);
    g.restore();
    orm(x, y, w, h, rand(0.08, 0.19), 0.88);
  };
  /** Streaks and soiling; wraps in x so the tile stays seamless. */
  const grime = (n, alpha) => {
    for (let i = 0; i < n; i++) {
      const x = rand(-20, S), y = rand(0, S), len = rand(24, 140), wdt = rand(2, 9);
      const gr = g.createLinearGradient(0, y, 0, y + len);
      gr.addColorStop(0, `rgba(46,41,34,${alpha})`);
      gr.addColorStop(1, 'rgba(46,41,34,0)');
      g.fillStyle = gr;
      for (const dx of [-S, 0, S]) g.fillRect(x + dx, y, wdt, len);
    }
  };

  eg.fillStyle = '#000'; eg.fillRect(0, 0, S, S);
  orm(0, 0, S, S, 0.92, 0.0);

  if (kind === 'curtain') {
    // ---- glass curtain wall: ribbon glazing, spandrel bands, fine mullions --
    g.fillStyle = '#666d78'; g.fillRect(0, 0, S, S);
    for (let f = 0; f < FL; f++) {
      const y = f * fh;
      const spandrelH = fh * 0.26;
      // spandrel: an opaque metal panel under each glazing band
      const sg = g.createLinearGradient(0, y, 0, y + spandrelH);
      sg.addColorStop(0, '#84868a'); sg.addColorStop(1, '#54575d');
      g.fillStyle = sg; g.fillRect(0, y, S, spandrelH);
      orm(0, y, S, spandrelH, 0.44, 0.85);
      const gy = y + spandrelH, gh = fh - spandrelH - 3;
      const warmFloor = rng() < 0.4;
      for (let b = 0; b < BAYS; b++) {
        const x = b * bw;
        glass(x + 1.5, gy, bw - 3, gh, warmFloor !== (rng() < 0.25));
        litWindow(x + 1.5, gy, bw - 3, gh, 0.30);
      }
      // transom across the glazing, then vertical mullions
      g.fillStyle = 'rgba(206,208,210,0.55)';
      g.fillRect(0, gy + gh * 0.52, S, 2);
      g.fillStyle = 'rgba(220,222,224,0.7)';
      for (let b = 0; b <= BAYS; b++) g.fillRect(b * bw - 1.5, gy, 3, gh);
      // slab edge shadow at the head of the glazing
      g.fillStyle = 'rgba(12,14,18,0.42)';
      g.fillRect(0, gy, S, 3);
      g.fillStyle = 'rgba(236,232,222,0.35)';
      g.fillRect(0, y + spandrelH - 2, S, 2);
    }
    grime(26, 0.10);
  } else if (kind === 'brick') {
    // ---- older masonry loft: brick courses, arched heads, stone bands -------
    g.fillStyle = '#7d5342'; g.fillRect(0, 0, S, S);
    const course = 6.4, brick = 15;
    for (let y = 0, r = 0; y < S; y += course, r++) {
      const off = (r % 2) * brick * 0.5;
      for (let x = -brick; x < S; x += brick) {
        const v = rand(-16, 16);
        g.fillStyle = `rgb(${clamp(126 + v, 60, 190) | 0},${clamp(80 + v * 0.7, 40, 150) | 0},${clamp(64 + v * 0.6, 32, 130) | 0})`;
        g.fillRect(x + off + 0.7, y + 0.7, brick - 1.4, course - 1.4);
      }
    }
    for (let f = 0; f < FL; f++) {
      const y = f * fh;
      // stone string course at each floor line
      g.fillStyle = '#a89880'; g.fillRect(0, y, S, 7);
      g.fillStyle = 'rgba(255,250,238,0.35)'; g.fillRect(0, y, S, 2);
      g.fillStyle = 'rgba(24,16,12,0.35)'; g.fillRect(0, y + 7, S, 2.5);
      orm(0, y, S, 9, 0.82, 0.0);
      for (let b = 0; b < BAYS; b += 2) {
        const wx = b * bw + bw * 0.42, ww = bw * 1.16;
        const wy = y + fh * 0.26, wh = fh * 0.54;
        // reveal, segmental arch head, stone sill
        g.fillStyle = 'rgba(16,10,8,0.78)';
        g.fillRect(wx - 5, wy - 6, ww + 10, wh + 10);
        g.fillStyle = '#8e7b64';
        g.beginPath();
        g.ellipse(wx + ww * 0.5, wy - 1, ww * 0.62, 9, 0, Math.PI, 0);
        g.fill();
        glass(wx, wy, ww, wh, rng() < 0.3);
        g.fillStyle = 'rgba(190,186,176,0.75)';
        g.fillRect(wx + ww * 0.5 - 1.5, wy, 3, wh);
        g.fillRect(wx, wy + wh * 0.42, ww, 2);
        g.fillStyle = '#b0a48e';
        g.fillRect(wx - 6, wy + wh, ww + 12, 5);
        orm(wx - 6, wy + wh, ww + 12, 5, 0.8, 0.0);
        litWindow(wx, wy, ww, wh, 0.34);
      }
    }
    grime(44, 0.14);
  } else {
    // ---- precast concrete with punched windows, sills, AC units ------------
    g.fillStyle = '#948d81'; g.fillRect(0, 0, S, S);
    for (let y = 0; y < S; y += 4) {
      for (let x = 0; x < S; x += 4) {
        const n = noise01(x * 0.055 + 3.1, y * 0.055 + 7.7, 4);
        g.fillStyle = `rgba(${(n * 130) | 0},${(n * 122) | 0},${(n * 106) | 0},0.20)`;
        g.fillRect(x, y, 4, 4);
      }
    }
    // precast panel joints on the floor line and every two bays
    for (let f = 0; f <= FL; f++) {
      g.fillStyle = 'rgba(46,42,36,0.42)'; g.fillRect(0, f * fh - 1.5, S, 3);
      g.fillStyle = 'rgba(232,228,216,0.28)'; g.fillRect(0, f * fh + 1.5, S, 1.5);
    }
    for (let b = 0; b <= BAYS; b += 2) {
      g.fillStyle = 'rgba(46,42,36,0.30)'; g.fillRect(b * bw - 1, 0, 2, S);
    }
    for (let f = 0; f < FL; f++) {
      const y = f * fh;
      for (let b = 0; b < BAYS; b++) {
        const wx = b * bw + bw * 0.19, ww = bw * 0.62;
        const wy = y + fh * 0.22, wh = fh * 0.50;
        g.fillStyle = 'rgba(14,12,11,0.80)';           // deep reveal
        g.fillRect(wx - 5, wy - 5, ww + 9, wh + 8);
        glass(wx, wy, ww, wh, rng() < 0.28);
        g.fillStyle = 'rgba(198,196,188,0.6)';
        g.fillRect(wx + ww * 0.5 - 1.2, wy, 2.4, wh);
        g.fillStyle = '#c2bcae';                        // sill
        g.fillRect(wx - 5, wy + wh, ww + 10, 4);
        orm(wx - 5, wy + wh, ww + 10, 4, 0.85, 0.0);
        // the odd through-wall AC unit hanging under a sill
        if (rng() < 0.14) {
          g.fillStyle = '#8f9295';
          g.fillRect(wx + ww * 0.2, wy + wh + 4, ww * 0.6, fh * 0.11);
          orm(wx + ww * 0.2, wy + wh + 4, ww * 0.6, fh * 0.11, 0.5, 0.7);
        }
        litWindow(wx, wy, ww, wh, 0.38);
      }
    }
    grime(52, 0.16);
  }

  weather(g, 0, 0, S, S, 0.5);
  return { color: cc.canvas, orm: oo.canvas, emissive: ee.canvas };
}

/** Tileable pale precast concrete for parapets, piers and viaduct decking. */
function makeTrimTexture() {
  const S = 256;
  const { canvas, g } = canvas2d(S, S);
  g.fillStyle = '#b3ada1'; g.fillRect(0, 0, S, S);
  for (let y = 0; y < S; y += 4) {
    for (let x = 0; x < S; x += 4) {
      const n = noise01(x * 0.06 + 12.3, y * 0.06 + 2.9, 4);
      g.fillStyle = `rgba(${(n * 150) | 0},${(n * 144) | 0},${(n * 128) | 0},0.24)`;
      g.fillRect(x, y, 4, 4);
    }
  }
  g.fillStyle = 'rgba(60,55,48,0.30)';
  g.fillRect(0, S * 0.5 - 1, S, 2);
  g.fillRect(S * 0.5 - 1, 0, 2, S);
  for (let i = 0; i < 40; i++) {
    const x = rand(-10, S), y = rand(0, S), len = rand(20, 90);
    const gr = g.createLinearGradient(0, y, 0, y + len);
    gr.addColorStop(0, 'rgba(48,44,38,0.16)');
    gr.addColorStop(1, 'rgba(48,44,38,0)');
    g.fillStyle = gr;
    for (const dx of [-S, 0, S]) g.fillRect(x + dx, y, rand(2, 6), len);
  }
  return canvas;
}

/**
 * One palm frond, rooted at the left edge with the rachis on the horizontal
 * centre line so the geometry can fold the two halves up into a shallow V.
 */
function makePalmTexture() {
  const W = 256, H = 128, MID = H * 0.5;
  const { canvas, g } = canvas2d(W, H);
  g.clearRect(0, 0, W, H);
  g.lineCap = 'round';
  for (let side = -1; side <= 1; side += 2) {
    for (let i = 0; i < 52; i++) {
      const t = 0.05 + (i / 52) * 0.95;
      const rx = 6 + t * (W - 16);
      const len = clamp(1 - Math.pow(Math.abs(t - 0.40) * 1.62, 1.7), 0, 1) * MID * 0.94;
      if (len <= 2) continue;
      const sweep = 0.30 + t * 0.55;
      const sh = 0.60 + 0.40 * (1 - t * 0.7) + rand(-0.13, 0.13);
      g.strokeStyle = `rgba(${(92 * sh) | 0},${(124 * sh) | 0},${(56 * sh) | 0},${rand(0.8, 1)})`;
      g.lineWidth = rand(2.2, 3.6);
      g.beginPath();
      g.moveTo(rx, MID);
      g.quadraticCurveTo(rx + len * 0.28, MID + side * len * 0.62,
        rx + len * sweep, MID + side * len);
      g.stroke();
    }
  }
  g.strokeStyle = 'rgba(126,128,66,0.95)';
  g.lineWidth = 4.5;
  g.beginPath(); g.moveTo(4, MID); g.lineTo(W - 8, MID); g.stroke();
  return canvas;
}

/**
 * The outermost city: a low-contrast silhouette strip of far towers that
 * dissolves upward into the sky. Sits behind everything and never reads as a
 * wall because its alpha is gone well before the top of the band.
 */
function makeDistantCityTexture() {
  const W = 2048, H = 256;
  const { canvas, g } = canvas2d(W, H);
  g.clearRect(0, 0, W, H);
  for (let layer = 0; layer < 2; layer++) {
    const base = H * 0.97;
    const alpha = layer === 0 ? 0.30 : 0.44;
    const tint = layer === 0 ? '150,158,172' : '128,136,152';
    let x = 0;
    while (x < W + 40) {
      const w = rand(14, 74);
      const hh = (rand(0.10, 0.42) + Math.pow(rng(), 3) * 0.42) * H * (layer === 0 ? 1.0 : 0.78);
      const top = base - hh;
      const gr = g.createLinearGradient(0, top, 0, base);
      gr.addColorStop(0, `rgba(${tint},${alpha * 0.30})`);
      gr.addColorStop(0.55, `rgba(${tint},${alpha * 0.82})`);
      gr.addColorStop(1, `rgba(${tint},${alpha})`);
      g.fillStyle = gr;
      g.fillRect(x, top, w - rand(1, 5), hh);
      // the occasional mast
      if (rng() < 0.10) {
        g.fillStyle = `rgba(${tint},${alpha * 0.5})`;
        g.fillRect(x + w * 0.45, top - rand(8, 26), 2, 26);
      }
      x += w;
    }
  }
  // dissolve the whole strip upward so the tops feather into the sky
  g.globalCompositeOperation = 'destination-in';
  const fade = g.createLinearGradient(0, 0, 0, H);
  fade.addColorStop(0.00, 'rgba(0,0,0,0)');
  fade.addColorStop(0.45, 'rgba(0,0,0,0.55)');
  fade.addColorStop(0.86, 'rgba(0,0,0,1)');
  fade.addColorStop(1.00, 'rgba(0,0,0,1)');
  g.fillStyle = fade;
  g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = 'source-over';
  return canvas;
}

/** Spray-can pieces for the shipping container, transparent background. */
function makeGraffitiTexture() {
  const W = 1024, H = 512;
  const { canvas, g } = canvas2d(W, H);
  g.clearRect(0, 0, W, H);

  const spray = (text, cx, cy, size, fill, outline, skew) => {
    g.save();
    g.translate(cx, cy);
    g.rotate(rand(-0.06, 0.06));
    g.transform(1, 0, skew, 1, 0, 0);
    g.font = `900 ${size}px ${FONT}`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    // overspray halo
    g.globalAlpha = 0.16;
    g.fillStyle = fill;
    for (let i = 0; i < 26; i++) {
      g.save();
      g.translate(rand(-9, 9), rand(-9, 9));
      g.fillText(text, 0, 0);
      g.restore();
    }
    g.globalAlpha = 1;
    g.lineWidth = size * 0.16;
    g.strokeStyle = outline;
    g.strokeText(text, 0, 0);
    g.fillStyle = fill;
    g.fillText(text, 0, 0);
    // highlight
    g.strokeStyle = 'rgba(255,255,255,0.55)';
    g.lineWidth = size * 0.03;
    g.strokeText(text, -size * 0.02, -size * 0.03);
    g.restore();
    // drips
    for (let i = 0; i < 10; i++) {
      const dx = cx + rand(-size * 1.6, size * 1.6);
      const dy = cy + size * rand(0.25, 0.45);
      const len = rand(10, 70);
      g.fillStyle = fill;
      g.globalAlpha = 0.85;
      g.fillRect(dx, dy, rand(2, 5), len);
      g.beginPath(); g.arc(dx + 1.5, dy + len, rand(2, 4), 0, TAU); g.fill();
      g.globalAlpha = 1;
    }
  };

  spray('SKRT', 250, 190, 150, '#f2c33a', '#241a05', -0.22);
  spray('LOT 14', 700, 160, 120, '#e0483c', '#1a0a08', 0.16);
  spray('DUSTY', 470, 360, 110, '#48b7e0', '#06202a', -0.12);

  // throwie bubbles and tags
  g.globalAlpha = 0.9;
  g.font = `700 46px ${FONT}`;
  g.fillStyle = '#f2f2f2';
  g.textAlign = 'left';
  g.fillText('~ ONE MORE LAP ~', 60, 440);
  g.fillText('86 CREW', 780, 420);
  g.globalAlpha = 1;

  // scattered paint spatter
  for (let i = 0; i < 260; i++) {
    g.fillStyle = pick(['rgba(242,195,58,0.5)', 'rgba(224,72,60,0.5)', 'rgba(72,183,224,0.5)', 'rgba(240,240,240,0.4)']);
    g.beginPath(); g.arc(rand(0, W), rand(0, H), rand(0.6, 3.4), 0, TAU); g.fill();
  }
  return canvas;
}

/** Traffic-cone strip: orange body with two reflective bands. */
function makeConeTexture() {
  const W = 64, H = 256;
  const { canvas, g } = canvas2d(W, H);
  g.fillStyle = '#e2561d';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#eceae2';
  g.fillRect(0, H * 0.30, W, H * 0.13);
  g.fillRect(0, H * 0.56, W, H * 0.10);
  // scuffs and road grime
  for (let i = 0; i < 180; i++) {
    g.fillStyle = `rgba(${randInt(40, 90)},${randInt(36, 80)},${randInt(30, 70)},${rand(0.05, 0.28)})`;
    g.beginPath(); g.ellipse(rand(0, W), rand(0, H), rand(1, 8), rand(1, 4), 0, 0, TAU); g.fill();
  }
  const gr = g.createLinearGradient(0, H * 0.75, 0, H);
  gr.addColorStop(0, 'rgba(40,34,28,0)');
  gr.addColorStop(1, 'rgba(40,34,28,0.5)');
  g.fillStyle = gr; g.fillRect(0, H * 0.75, W, H * 0.25);
  return canvas;
}

/** Soft dust patch decal. */
function makeDustTexture() {
  const S = 256;
  const { canvas, g } = canvas2d(S, S);
  g.clearRect(0, 0, S, S);
  const img = g.createImageData(S, S);
  const d = img.data;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const dx = (x / S - 0.5) * 2, dy = (y / S - 0.5) * 2;
      const r = Math.sqrt(dx * dx + dy * dy);
      const n = noise01(x * 0.045, y * 0.045, 5);
      const a = clamp((1 - r) * 1.9, 0, 1) * clamp(n * 2.4 - 0.55, 0, 1);
      const tone = 0.74 + n * 0.34;
      d[i] = clamp(tone * 226, 0, 255);
      d[i + 1] = clamp(tone * 204, 0, 255);
      d[i + 2] = clamp(tone * 168, 0, 255);
      d[i + 3] = clamp(a * 255, 0, 255);
    }
  }
  g.putImageData(img, 0, 0);
  return canvas;
}

/** Tyre skid mark decal (dark, alpha, with tread ribs). */
function makeSkidTexture() {
  const W = 128, H = 512;
  const { canvas, g } = canvas2d(W, H);
  g.clearRect(0, 0, W, H);
  const img = g.createImageData(W, H);
  const d = img.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const u = x / W, v = y / H;
      const edge = clamp(1 - Math.abs(u - 0.5) * 2.35, 0, 1);
      const ends = smoothstep(clamp(v * 4, 0, 1)) * smoothstep(clamp((1 - v) * 3.2, 0, 1));
      const rib = 0.72 + 0.28 * Math.sin(u * Math.PI * 9);
      const n = noise01(x * 0.09, y * 0.05, 4);
      const a = clamp(edge * ends * rib * (0.72 + n * 0.75) - 0.06, 0, 1);
      d[i] = 24; d[i + 1] = 22; d[i + 2] = 22;
      d[i + 3] = clamp(a * 255, 0, 255);
    }
  }
  g.putImageData(img, 0, 0);
  return canvas;
}

/** 2×2 litter atlas: flyer, cup, bag, crushed carton. */
function makeLitterTexture() {
  const S = 256, C = S / 2;
  const { canvas, g } = canvas2d(S, S);
  g.clearRect(0, 0, S, S);

  // flyer
  g.save(); g.translate(4, 4);
  g.fillStyle = '#e8e3d4'; g.fillRect(14, 20, C - 34, C - 46);
  g.fillStyle = '#b8342c'; g.fillRect(14, 20, C - 34, 12);
  g.fillStyle = 'rgba(60,58,52,0.75)';
  for (let i = 0; i < 7; i++) g.fillRect(20, 42 + i * 9, rand(30, C - 52), 3);
  g.restore();

  // paper cup
  g.save(); g.translate(C + 10, 12);
  g.fillStyle = '#f0ece0';
  g.beginPath(); g.moveTo(22, 12); g.lineTo(84, 12); g.lineTo(74, 100); g.lineTo(32, 100); g.closePath(); g.fill();
  g.fillStyle = '#d34a2e'; g.fillRect(26, 34, 54, 18);
  g.fillStyle = '#cfc9ba'; g.fillRect(16, 4, 76, 12);
  g.restore();

  // plastic bag
  g.save(); g.translate(10, C + 14);
  g.fillStyle = 'rgba(232,236,238,0.85)';
  g.beginPath();
  g.moveTo(16, 60); g.quadraticCurveTo(6, 20, 40, 12); g.quadraticCurveTo(84, 4, 92, 44);
  g.quadraticCurveTo(100, 84, 54, 92); g.quadraticCurveTo(20, 96, 16, 60);
  g.fill();
  g.strokeStyle = 'rgba(180,190,196,0.9)'; g.lineWidth = 2;
  for (let i = 0; i < 8; i++) {
    g.beginPath(); g.moveTo(rand(20, 80), rand(16, 80)); g.lineTo(rand(20, 90), rand(16, 88)); g.stroke();
  }
  g.restore();

  // crushed carton
  g.save(); g.translate(C + 12, C + 16);
  g.fillStyle = '#c9b68c';
  g.beginPath(); g.moveTo(10, 70); g.lineTo(30, 24); g.lineTo(88, 16); g.lineTo(96, 66); g.lineTo(52, 88); g.closePath(); g.fill();
  g.strokeStyle = 'rgba(90,74,50,0.8)'; g.lineWidth = 3;
  g.beginPath(); g.moveTo(30, 24); g.lineTo(56, 60); g.lineTo(96, 66); g.stroke();
  g.restore();

  return canvas;
}

/**
 * Tileable galvanised chainlink with a real alpha cut-out, plus the matching
 * height field for a normal map. Authored at 512 so the wire is several texels
 * wide at level 0 — a two-texel wire is what turned the fence into a band of
 * sparkle in the first place — and the galvanising is a mid grey, not white,
 * so the fabric averages down to a haze at distance instead of a bright wall.
 *
 * Returns `{ color, height }` canvases.
 */
function makeChainlinkTexture() {
  const S = 512, T = 8;            // 8 diamonds per tile ~ 110 mm mesh
  const c = canvas2d(S, S), hgt = canvas2d(S, S);
  const g = c.g, hg = hgt.g;
  g.clearRect(0, 0, S, S);
  hg.fillStyle = '#000'; hg.fillRect(0, 0, S, S);
  const cell = S / T;

  /** One diagonal family of wires. */
  const weave = (ctxG, width, style, off, down) => {
    ctxG.lineCap = 'round';
    ctxG.lineWidth = width;
    ctxG.strokeStyle = style;
    for (let i = -T; i <= T * 2; i++) {
      ctxG.beginPath();
      if (down) {
        ctxG.moveTo(i * cell + off, -cell + off);
        ctxG.lineTo(i * cell + S + cell + off, S + off);
      } else {
        ctxG.moveTo(i * cell + off, S + cell + off);
        ctxG.lineTo(i * cell + S + cell + off, -off);
      }
      ctxG.stroke();
    }
  };

  // contact shadow under the weave, then the wire core, then the specular
  // highlight down the middle of each wire: a round wire, not a flat ribbon.
  for (const down of [true, false]) {
    weave(g, cell * 0.185, 'rgba(24,26,28,0.9)', 2.4, down);
  }
  for (const down of [true, false]) {
    weave(g, cell * 0.145, 'rgb(118,124,128)', 0, down);
    weave(g, cell * 0.075, 'rgb(158,164,168)', -0.6, down);
    weave(g, cell * 0.030, 'rgb(186,192,196)', -1.4, down);
    weave(hg, cell * 0.150, 'rgb(90,90,90)', 0, down);
    weave(hg, cell * 0.070, 'rgb(215,215,215)', -0.6, down);
  }
  // rust speckle and grime along the wires only
  g.globalCompositeOperation = 'source-atop';
  for (let i = 0; i < 2200; i++) {
    g.fillStyle = `rgba(${randInt(84, 140)},${randInt(56, 92)},${randInt(32, 58)},${rand(0.05, 0.5)})`;
    g.beginPath(); g.arc(rand(0, S), rand(0, S), rand(0.8, 3.2), 0, TAU); g.fill();
  }
  for (let i = 0; i < 900; i++) {
    g.fillStyle = `rgba(40,42,44,${rand(0.04, 0.22)})`;
    g.beginPath(); g.arc(rand(0, S), rand(0, S), rand(1.0, 4.5), 0, TAU); g.fill();
  }
  g.globalCompositeOperation = 'source-over';
  return { color: c.canvas, height: hgt.canvas };
}

// ---------------------------------------------------------------------------
// crowd wardrobe
//
// The spectators used to be flat vertex-colour boxes. They now sample a 4x4
// atlas of garment swatches at ~730 px/m, with a normal map baked from the same
// weave, so a tee reads as knit, jeans read as denim and a face reads as a
// face. Instances pick their own atlas column for the top and the bottom, so
// one geometry still covers a whole crowd of different outfits.
//
// Cell grid (column, row), row 0 at the TOP of the canvas:
//   (0..3, 0)  tops:    plain jersey / printed tee / stripe tee / hoodie
//   (0..3, 1)  bottoms: denim / canvas / track pant / (3) sleeve knit
//   (0..3, 2)  head:    skin / face / hair / cap
//   (0..3, 3)  misc:    shoe / dark fabric / beanie / bag canvas
// ---------------------------------------------------------------------------

const CROWD_CELL = 256;
const CROWD_ATLAS = 4;

function makeCrowdAtlas() {
  const S = CROWD_CELL * CROWD_ATLAS;
  const col = canvas2d(S, S), hei = canvas2d(S, S);
  const g = col.g, hg = hei.g;
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, S, S);
  hg.fillStyle = '#808080'; hg.fillRect(0, 0, S, S);

  /** Run `fn(g, hg, x, y, C)` clipped to cell (cx, cy). */
  const cell = (cx, cy, fn) => {
    const C = CROWD_CELL, x = cx * C, y = cy * C;
    g.save(); hg.save();
    g.beginPath(); g.rect(x, y, C, C); g.clip();
    hg.beginPath(); hg.rect(x, y, C, C); hg.clip();
    g.translate(x, y); hg.translate(x, y);
    fn(g, hg, C);
    g.restore(); hg.restore();
  };

  /** Knit weave: fine crossing threads plus a slack fold gradient. */
  const knit = (gg, hh, C, base, pitch, contrast) => {
    gg.fillStyle = base; gg.fillRect(0, 0, C, C);
    hh.fillStyle = '#7a7a7a'; hh.fillRect(0, 0, C, C);
    gg.lineWidth = pitch * 0.42;
    hh.lineWidth = pitch * 0.42;
    for (let i = -1; i * pitch < C + pitch; i++) {
      const yy = i * pitch;
      gg.strokeStyle = `rgba(255,255,255,${contrast})`;
      gg.beginPath(); gg.moveTo(0, yy); gg.lineTo(C, yy + pitch * 0.5); gg.stroke();
      gg.strokeStyle = `rgba(0,0,0,${contrast * 1.15})`;
      gg.beginPath(); gg.moveTo(0, yy + pitch * 0.5); gg.lineTo(C, yy + pitch); gg.stroke();
      hh.strokeStyle = 'rgba(255,255,255,0.5)';
      hh.beginPath(); hh.moveTo(0, yy); hh.lineTo(C, yy + pitch * 0.5); hh.stroke();
      hh.strokeStyle = 'rgba(0,0,0,0.5)';
      hh.beginPath(); hh.moveTo(0, yy + pitch * 0.5); hh.lineTo(C, yy + pitch); hh.stroke();
    }
    // soft folds — the value break that stops a torso reading as one fill
    for (let i = 0; i < 9; i++) {
      const fx = rand(-C * 0.1, C * 1.1), fw = rand(C * 0.10, C * 0.34);
      const grad = gg.createLinearGradient(fx, 0, fx + fw, 0);
      grad.addColorStop(0, 'rgba(0,0,0,0)');
      grad.addColorStop(0.5, `rgba(0,0,0,${rand(0.08, 0.20)})`);
      grad.addColorStop(1, 'rgba(255,255,255,0.05)');
      gg.fillStyle = grad; gg.fillRect(fx, 0, fw, C);
      const hgrad = hh.createLinearGradient(fx, 0, fx + fw, 0);
      hgrad.addColorStop(0, 'rgba(128,128,128,0)');
      hgrad.addColorStop(0.5, 'rgba(0,0,0,0.30)');
      hgrad.addColorStop(1, 'rgba(255,255,255,0.22)');
      hh.fillStyle = hgrad; hh.fillRect(fx, 0, fw, C);
    }
    // grubby hem
    const hem = gg.createLinearGradient(0, C * 0.72, 0, C);
    hem.addColorStop(0, 'rgba(50,44,36,0)');
    hem.addColorStop(1, 'rgba(50,44,36,0.20)');
    gg.fillStyle = hem; gg.fillRect(0, C * 0.72, C, C * 0.28);
  };

  // --- row 0: tops ---------------------------------------------------------
  cell(0, 0, (gg, hh, C) => knit(gg, hh, C, '#e6e6e6', 7, 0.055));
  cell(1, 0, (gg, hh, C) => {
    knit(gg, hh, C, '#e6e6e6', 7, 0.055);
    // invented screen print — a wheel mark and a wordmark, never a real brand
    gg.save(); gg.translate(C * 0.5, C * 0.46);
    gg.strokeStyle = 'rgba(28,26,30,0.82)'; gg.lineWidth = C * 0.030;
    gg.beginPath(); gg.arc(0, 0, C * 0.20, 0, TAU); gg.stroke();
    gg.lineWidth = C * 0.016;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU;
      gg.beginPath();
      gg.moveTo(Math.cos(a) * C * 0.05, Math.sin(a) * C * 0.05);
      gg.lineTo(Math.cos(a) * C * 0.185, Math.sin(a) * C * 0.185);
      gg.stroke();
    }
    gg.fillStyle = 'rgba(28,26,30,0.86)';
    fitText(gg, 'LOT 14', 0, C * 0.30, C * 0.66, C * 0.13);
    gg.restore();
    hh.fillStyle = 'rgba(255,255,255,0.12)';
    hh.beginPath(); hh.arc(C * 0.5, C * 0.46, C * 0.21, 0, TAU); hh.fill();
  });
  cell(2, 0, (gg, hh, C) => {
    knit(gg, hh, C, '#e6e6e6', 7, 0.055);
    for (let i = 0; i < 7; i++) {
      gg.fillStyle = `rgba(24,22,26,${0.20 + (i % 2) * 0.06})`;
      gg.fillRect(0, i * C * 0.145 + C * 0.02, C, C * 0.058);
    }
  });
  cell(3, 0, (gg, hh, C) => {
    knit(gg, hh, C, '#dcdcdc', 11, 0.075);
    // hoodie: kangaroo pocket seam and a drawcord
    gg.strokeStyle = 'rgba(20,18,22,0.30)'; gg.lineWidth = C * 0.012;
    gg.beginPath(); gg.moveTo(C * 0.16, C * 0.62); gg.lineTo(C * 0.84, C * 0.62); gg.stroke();
    hh.strokeStyle = 'rgba(0,0,0,0.55)'; hh.lineWidth = C * 0.014;
    hh.beginPath(); hh.moveTo(C * 0.16, C * 0.62); hh.lineTo(C * 0.84, C * 0.62); hh.stroke();
    gg.strokeStyle = 'rgba(245,242,235,0.85)'; gg.lineWidth = C * 0.020;
    gg.beginPath(); gg.moveTo(C * 0.42, C * 0.05); gg.lineTo(C * 0.44, C * 0.30); gg.stroke();
    gg.beginPath(); gg.moveTo(C * 0.58, C * 0.05); gg.lineTo(C * 0.56, C * 0.26); gg.stroke();
  });

  // --- row 1: bottoms + sleeve --------------------------------------------
  cell(0, 1, (gg, hh, C) => {
    // denim: twill diagonal, a leg seam, knee fade
    gg.fillStyle = '#dedede'; gg.fillRect(0, 0, C, C);
    hh.fillStyle = '#787878'; hh.fillRect(0, 0, C, C);
    gg.lineWidth = 2.2; hh.lineWidth = 2.2;
    for (let i = -C; i < C * 2; i += 5) {
      gg.strokeStyle = `rgba(255,255,255,${rand(0.05, 0.12)})`;
      gg.beginPath(); gg.moveTo(i, 0); gg.lineTo(i + C, C); gg.stroke();
      gg.strokeStyle = `rgba(0,0,0,${rand(0.05, 0.12)})`;
      gg.beginPath(); gg.moveTo(i + 2.5, 0); gg.lineTo(i + 2.5 + C, C); gg.stroke();
      hh.strokeStyle = `rgba(255,255,255,${rand(0.10, 0.26)})`;
      hh.beginPath(); hh.moveTo(i, 0); hh.lineTo(i + C, C); hh.stroke();
    }
    // outseam with topstitching
    for (const sx of [C * 0.10, C * 0.90]) {
      gg.strokeStyle = 'rgba(20,20,24,0.34)'; gg.lineWidth = C * 0.020;
      gg.beginPath(); gg.moveTo(sx, 0); gg.lineTo(sx, C); gg.stroke();
      gg.strokeStyle = 'rgba(226,206,150,0.55)'; gg.lineWidth = C * 0.007;
      gg.setLineDash([5, 4]);
      gg.beginPath(); gg.moveTo(sx + C * 0.016, 0); gg.lineTo(sx + C * 0.016, C); gg.stroke();
      gg.setLineDash([]);
      hh.strokeStyle = 'rgba(0,0,0,0.6)'; hh.lineWidth = C * 0.022;
      hh.beginPath(); hh.moveTo(sx, 0); hh.lineTo(sx, C); hh.stroke();
    }
    // knee/seat fade
    const fade = gg.createRadialGradient(C * 0.5, C * 0.42, 0, C * 0.5, C * 0.42, C * 0.42);
    fade.addColorStop(0, 'rgba(255,255,255,0.20)');
    fade.addColorStop(1, 'rgba(255,255,255,0)');
    gg.fillStyle = fade; gg.fillRect(0, 0, C, C);
  });
  cell(1, 1, (gg, hh, C) => {
    knit(gg, hh, C, '#d8d8d8', 5, 0.045);
    // cargo pocket
    gg.strokeStyle = 'rgba(30,28,26,0.30)'; gg.lineWidth = C * 0.012;
    gg.strokeRect(C * 0.24, C * 0.36, C * 0.34, C * 0.28);
    hh.strokeStyle = 'rgba(0,0,0,0.5)'; hh.lineWidth = C * 0.014;
    hh.strokeRect(C * 0.24, C * 0.36, C * 0.34, C * 0.28);
  });
  cell(2, 1, (gg, hh, C) => {
    knit(gg, hh, C, '#d0d0d0', 4, 0.04);
    gg.fillStyle = 'rgba(248,246,240,0.75)';
    gg.fillRect(C * 0.08, 0, C * 0.035, C);
    gg.fillStyle = 'rgba(24,22,26,0.30)';
    gg.fillRect(C * 0.125, 0, C * 0.018, C);
  });
  cell(3, 1, (gg, hh, C) => {
    // sleeve: same knit, ribbed cuff at the bottom
    knit(gg, hh, C, '#dadada', 6, 0.06);
    for (let i = 0; i < 14; i++) {
      gg.fillStyle = `rgba(0,0,0,${0.05 + (i % 2) * 0.05})`;
      gg.fillRect(i * C / 14, C * 0.82, C / 28, C * 0.18);
      hh.fillStyle = `rgba(${i % 2 ? 220 : 40},${i % 2 ? 220 : 40},${i % 2 ? 220 : 40},0.6)`;
      hh.fillRect(i * C / 14, C * 0.82, C / 28, C * 0.18);
    }
  });

  // --- row 2: head ---------------------------------------------------------
  const skinBase = (gg, hh, C) => {
    gg.fillStyle = '#e8ded6'; gg.fillRect(0, 0, C, C);
    hh.fillStyle = '#808080'; hh.fillRect(0, 0, C, C);
    for (let i = 0; i < 500; i++) {
      gg.fillStyle = `rgba(${randInt(150, 210)},${randInt(120, 170)},${randInt(110, 150)},${rand(0.03, 0.12)})`;
      gg.beginPath(); gg.arc(rand(0, C), rand(0, C), rand(1, 5), 0, TAU); gg.fill();
    }
  };
  cell(0, 2, skinBase);
  cell(1, 2, (gg, hh, C) => {
    skinBase(gg, hh, C);
    // The head is a lat-long sphere: u = 0.25 faces +Z, so the features go a
    // quarter of the way across the cell and just above the middle.
    const fx = C * 0.25;
    const brow = C * 0.42, eye = C * 0.46, mouth = C * 0.62;
    gg.fillStyle = 'rgba(60,44,34,0.72)';
    for (const s of [-1, 1]) {
      gg.beginPath();
      gg.ellipse(fx + s * C * 0.058, eye, C * 0.030, C * 0.016, 0, 0, TAU);
      gg.fill();
    }
    gg.fillStyle = 'rgba(18,16,18,0.85)';
    for (const s of [-1, 1]) {
      gg.beginPath();
      gg.ellipse(fx + s * C * 0.058, eye, C * 0.013, C * 0.012, 0, 0, TAU);
      gg.fill();
    }
    gg.strokeStyle = 'rgba(52,38,30,0.65)'; gg.lineWidth = C * 0.016; gg.lineCap = 'round';
    for (const s of [-1, 1]) {
      gg.beginPath();
      gg.moveTo(fx + s * C * 0.030, brow);
      gg.lineTo(fx + s * C * 0.088, brow - C * 0.008);
      gg.stroke();
    }
    // nose shadow + mouth
    gg.strokeStyle = 'rgba(120,88,70,0.45)'; gg.lineWidth = C * 0.012;
    gg.beginPath(); gg.moveTo(fx, eye + C * 0.02); gg.lineTo(fx - C * 0.012, mouth - C * 0.045); gg.stroke();
    gg.strokeStyle = 'rgba(110,64,58,0.60)'; gg.lineWidth = C * 0.014;
    gg.beginPath();
    gg.moveTo(fx - C * 0.038, mouth);
    gg.quadraticCurveTo(fx, mouth + C * 0.018, fx + C * 0.038, mouth);
    gg.stroke();
    hh.strokeStyle = 'rgba(40,40,40,0.6)'; hh.lineWidth = C * 0.02;
    hh.beginPath();
    hh.moveTo(fx - C * 0.038, mouth);
    hh.quadraticCurveTo(fx, mouth + C * 0.018, fx + C * 0.038, mouth);
    hh.stroke();
  });
  cell(2, 2, (gg, hh, C) => {
    gg.fillStyle = '#dcdcdc'; gg.fillRect(0, 0, C, C);
    hh.fillStyle = '#6e6e6e'; hh.fillRect(0, 0, C, C);
    gg.lineCap = 'round'; hh.lineCap = 'round';
    for (let i = 0; i < 260; i++) {
      const x0 = rand(0, C), y0 = rand(-C * 0.1, C);
      const l = rand(C * 0.10, C * 0.45), a = rand(1.1, 2.1);
      gg.strokeStyle = rng() < 0.5 ? `rgba(255,255,255,${rand(0.05, 0.16)})` : `rgba(0,0,0,${rand(0.08, 0.24)})`;
      gg.lineWidth = rand(1.5, 4);
      gg.beginPath();
      gg.moveTo(x0, y0);
      gg.quadraticCurveTo(x0 + Math.cos(a) * l * 0.4, y0 + Math.sin(a) * l * 0.4,
        x0 + Math.cos(a) * l, y0 + Math.sin(a) * l);
      gg.stroke();
      hh.strokeStyle = `rgba(${rng() < 0.5 ? 230 : 30},${rng() < 0.5 ? 230 : 30},${128},0.45)`;
      hh.lineWidth = gg.lineWidth;
      hh.beginPath();
      hh.moveTo(x0, y0);
      hh.quadraticCurveTo(x0 + Math.cos(a) * l * 0.4, y0 + Math.sin(a) * l * 0.4,
        x0 + Math.cos(a) * l, y0 + Math.sin(a) * l);
      hh.stroke();
    }
  });
  cell(3, 2, (gg, hh, C) => {
    // six-panel cap: crown seams, a top button, a stitched brim edge
    gg.fillStyle = '#dedede'; gg.fillRect(0, 0, C, C);
    hh.fillStyle = '#8a8a8a'; hh.fillRect(0, 0, C, C);
    gg.strokeStyle = 'rgba(20,18,22,0.34)'; gg.lineWidth = C * 0.014;
    hh.strokeStyle = 'rgba(0,0,0,0.55)'; hh.lineWidth = C * 0.016;
    for (let i = 0; i < 6; i++) {
      const x = (i + 0.5) * C / 6;
      gg.beginPath(); gg.moveTo(x, 0); gg.lineTo(x, C); gg.stroke();
      hh.beginPath(); hh.moveTo(x, 0); hh.lineTo(x, C); hh.stroke();
    }
    gg.fillStyle = 'rgba(250,248,242,0.55)';
    gg.fillRect(0, C * 0.06, C, C * 0.02);
    // sweat/dust at the band
    const band = gg.createLinearGradient(0, C * 0.70, 0, C);
    band.addColorStop(0, 'rgba(60,52,42,0)');
    band.addColorStop(1, 'rgba(60,52,42,0.30)');
    gg.fillStyle = band; gg.fillRect(0, C * 0.70, C, C * 0.30);
  });

  // --- row 3: misc ---------------------------------------------------------
  cell(0, 3, (gg, hh, C) => {
    gg.fillStyle = '#cfcfcf'; gg.fillRect(0, 0, C, C);
    hh.fillStyle = '#808080'; hh.fillRect(0, 0, C, C);
    // sole band + laces
    gg.fillStyle = 'rgba(238,236,228,0.95)'; gg.fillRect(0, C * 0.74, C, C * 0.26);
    gg.fillStyle = 'rgba(30,28,30,0.45)'; gg.fillRect(0, C * 0.90, C, C * 0.10);
    hh.fillStyle = 'rgba(220,220,220,0.7)'; hh.fillRect(0, C * 0.74, C, C * 0.26);
    gg.strokeStyle = 'rgba(240,238,230,0.8)'; gg.lineWidth = C * 0.020;
    for (let i = 0; i < 4; i++) {
      gg.beginPath();
      gg.moveTo(C * 0.28, C * (0.16 + i * 0.13));
      gg.lineTo(C * 0.72, C * (0.22 + i * 0.13));
      gg.stroke();
    }
  });
  cell(1, 3, (gg, hh, C) => knit(gg, hh, C, '#bcbcbc', 6, 0.05));
  cell(2, 3, (gg, hh, C) => {
    // ribbed beanie
    gg.fillStyle = '#d6d6d6'; gg.fillRect(0, 0, C, C);
    hh.fillStyle = '#808080'; hh.fillRect(0, 0, C, C);
    for (let i = 0; i < 20; i++) {
      const x = i * C / 20;
      gg.fillStyle = `rgba(0,0,0,${i % 2 ? 0.10 : 0.03})`;
      gg.fillRect(x, 0, C / 40, C);
      hh.fillStyle = `rgba(${i % 2 ? 40 : 220},${i % 2 ? 40 : 220},128,0.55)`;
      hh.fillRect(x, 0, C / 40, C);
    }
    gg.fillStyle = 'rgba(0,0,0,0.10)'; gg.fillRect(0, C * 0.74, C, C * 0.26);
  });
  cell(3, 3, (gg, hh, C) => knit(gg, hh, C, '#c6c6c6', 9, 0.06));

  return { color: col.canvas, height: hei.canvas };
}

// ---------------------------------------------------------------------------
// other surface textures added for the art pass
// ---------------------------------------------------------------------------

/** Sawn softwood: grain lines, knots, weathering. Tileable, ~1 m per tile. */
function makeWoodTexture() {
  const S = 512;
  const c = canvas2d(S, S), hei = canvas2d(S, S);
  const g = c.g, hg = hei.g;
  g.fillStyle = '#8a6a44'; g.fillRect(0, 0, S, S);
  hg.fillStyle = '#8c8c8c'; hg.fillRect(0, 0, S, S);
  // broad colour banding across the board
  for (let i = 0; i < 26; i++) {
    const y = rand(0, S), h = rand(4, 26);
    g.fillStyle = `rgba(${randInt(88, 150)},${randInt(62, 108)},${randInt(36, 72)},${rand(0.10, 0.30)})`;
    g.fillRect(0, y, S, h);
  }
  // grain lines — long, slightly wandering, running along the board
  g.lineCap = 'round'; hg.lineCap = 'round';
  for (let i = 0; i < 300; i++) {
    const y = rand(-8, S + 8);
    const amp = rand(1.5, 7), ph = rand(0, TAU), freq = rand(0.008, 0.03);
    const dark = rng() < 0.55;
    g.strokeStyle = dark
      ? `rgba(${randInt(52, 92)},${randInt(34, 62)},${randInt(20, 40)},${rand(0.10, 0.45)})`
      : `rgba(${randInt(170, 215)},${randInt(140, 180)},${randInt(100, 140)},${rand(0.06, 0.22)})`;
    g.lineWidth = rand(0.8, 2.8);
    hg.strokeStyle = dark ? `rgba(40,40,40,${rand(0.25, 0.6)})` : `rgba(220,220,220,${rand(0.15, 0.4)})`;
    hg.lineWidth = g.lineWidth;
    g.beginPath(); hg.beginPath();
    for (let x = 0; x <= S; x += 8) {
      const yy = y + Math.sin(x * freq + ph) * amp;
      if (x === 0) { g.moveTo(x, yy); hg.moveTo(x, yy); } else { g.lineTo(x, yy); hg.lineTo(x, yy); }
    }
    g.stroke(); hg.stroke();
  }
  // knots
  for (let i = 0; i < 5; i++) {
    const kx = rand(0, S), ky = rand(0, S), kr = rand(6, 17);
    for (let r = kr; r > 0; r -= 1.6) {
      g.strokeStyle = `rgba(${randInt(60, 96)},${randInt(40, 64)},${randInt(24, 44)},0.5)`;
      g.lineWidth = 1.4;
      g.beginPath(); g.ellipse(kx, ky, r, r * 0.62, 0.4, 0, TAU); g.stroke();
      hg.strokeStyle = 'rgba(60,60,60,0.4)'; hg.lineWidth = 1.4;
      hg.beginPath(); hg.ellipse(kx, ky, r, r * 0.62, 0.4, 0, TAU); hg.stroke();
    }
  }
  // splits and weathering
  for (let i = 0; i < 40; i++) {
    g.strokeStyle = `rgba(38,28,20,${rand(0.15, 0.4)})`;
    g.lineWidth = rand(0.6, 1.8);
    const sx = rand(0, S), sy = rand(0, S), l = rand(20, 110);
    g.beginPath(); g.moveTo(sx, sy); g.lineTo(sx + l, sy + rand(-3, 3)); g.stroke();
  }
  weather(g, 0, 0, S, S, 0.5);
  return { color: c.canvas, height: hei.canvas };
}

/** One-sided grime gradient used along tread/riser junctions and kerb lines. */
function makeGrimeTexture() {
  const W = 256, H = 128;
  const { canvas, g } = canvas2d(W, H);
  g.clearRect(0, 0, W, H);
  const grad = g.createLinearGradient(0, H, 0, 0);
  grad.addColorStop(0.00, 'rgba(34,30,24,0.85)');
  grad.addColorStop(0.35, 'rgba(44,39,31,0.42)');
  grad.addColorStop(0.75, 'rgba(52,46,37,0.12)');
  grad.addColorStop(1.00, 'rgba(52,46,37,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  // break the straight edge up so it never reads as a painted line
  g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 220; i++) {
    g.fillStyle = `rgba(0,0,0,${rand(0.10, 0.55)})`;
    g.beginPath();
    g.ellipse(rand(0, W), rand(0, H * 0.95), rand(3, 22), rand(2, 12), rand(0, Math.PI), 0, TAU);
    g.fill();
  }
  g.globalCompositeOperation = 'source-over';
  for (let i = 0; i < 90; i++) {
    g.fillStyle = `rgba(${randInt(20, 60)},${randInt(18, 52)},${randInt(14, 40)},${rand(0.08, 0.3)})`;
    g.beginPath();
    g.ellipse(rand(0, W), rand(H * 0.55, H), rand(2, 10), rand(1.5, 6), 0, 0, TAU);
    g.fill();
  }
  return canvas;
}

/**
 * A city seen from the air: blocks, roof plant, streets and lot markings. Used
 * on the far ground so the sprawl the skyline stands on reads as ground rather
 * than as a second patch of sky.
 */
function makeCityFloorTexture() {
  const S = 512;
  const { canvas, g } = canvas2d(S, S);
  g.fillStyle = '#4c4a45'; g.fillRect(0, 0, S, S);
  // asphalt mottle
  for (let i = 0; i < 900; i++) {
    g.fillStyle = `rgba(${randInt(52, 96)},${randInt(50, 92)},${randInt(46, 86)},${rand(0.05, 0.22)})`;
    g.beginPath(); g.ellipse(rand(0, S), rand(0, S), rand(4, 34), rand(3, 22), rand(0, Math.PI), 0, TAU); g.fill();
  }
  // street grid — two pitches so it never reads as graph paper
  const street = (x, y, w, h) => {
    g.fillStyle = 'rgba(36,35,33,0.85)';
    g.fillRect(x, y, w, h);
    g.fillStyle = 'rgba(178,172,150,0.30)';
    if (w > h) g.fillRect(x, y + h * 0.5 - 0.7, w, 1.4);
    else g.fillRect(x + w * 0.5 - 0.7, y, 1.4, h);
  };
  for (let i = 0; i < 4; i++) street(0, i * S / 4 + 6, S, 11);
  for (let i = 0; i < 4; i++) street(i * S / 4 + 22, 0, 9, S);
  // roof blocks in each city block
  for (let by = 0; by < 4; by++) {
    for (let bx = 0; bx < 4; bx++) {
      const x0 = bx * S / 4 + 33, y0 = by * S / 4 + 19;
      const w0 = S / 4 - 42, h0 = S / 4 - 42;
      let x = x0;
      while (x < x0 + w0 - 8) {
        const w = Math.min(rand(14, 40), x0 + w0 - x);
        let y = y0;
        while (y < y0 + h0 - 8) {
          const h = Math.min(rand(14, 38), y0 + h0 - y);
          const v = randInt(64, 126);
          g.fillStyle = `rgb(${v},${(v * 0.97) | 0},${(v * 0.90) | 0})`;
          g.fillRect(x + 1, y + 1, w - 2.5, h - 2.5);
          g.fillStyle = 'rgba(0,0,0,0.28)';
          g.fillRect(x + w - 3.5, y + 1, 2.5, h - 2.5);
          g.fillRect(x + 1, y + h - 3.5, w - 2.5, 2.5);
          // roof plant / a parked-car row on the flat lots
          if (rng() < 0.5) {
            g.fillStyle = `rgba(${randInt(40, 80)},${randInt(40, 80)},${randInt(40, 80)},0.7)`;
            g.fillRect(x + rand(3, w * 0.5), y + rand(3, h * 0.5), rand(3, 9), rand(3, 9));
          }
          y += h;
        }
        x += w;
      }
      // a green lot now and then
      if (rng() < 0.22) {
        g.fillStyle = `rgba(${randInt(58, 88)},${randInt(74, 104)},${randInt(46, 66)},0.85)`;
        g.fillRect(x0 + rand(0, w0 * 0.4), y0 + rand(0, h0 * 0.4), rand(20, 44), rand(20, 44));
      }
    }
  }
  return canvas;
}

// ---------------------------------------------------------------------------
// shader patches — wind and idle motion happen on the GPU so update() stays free
// ---------------------------------------------------------------------------

function patchVertex(material, uniforms, decl, body, key) {
  material.onBeforeCompile = (shader) => {
    for (const k in uniforms) shader.uniforms[k] = uniforms[k];
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${decl}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${body}`);
  };
  material.customProgramCacheKey = () => key;
  return material;
}

const WIND_NOISE = /* glsl */`
  float propWave(vec3 wp, float t, float f) {
    return sin(wp.x * f + t) * 0.6 + sin(wp.z * f * 1.37 - t * 1.21) * 0.4;
  }
`;

// ---------------------------------------------------------------------------
// main entry
// ---------------------------------------------------------------------------

/**
 * Build every piece of set dressing.
 * @returns {{group:THREE.Group, colliders:Array, update:Function, dispose:Function,
 *            setNightLights:Function, nightAmount:Function, stats:Object}}
 */
export function createProps(ctx) {
  seed(0x9a17c0de);                     // deterministic, independent of build order

  const group = new THREE.Group();
  group.name = 'Props';
  const colliders = [];
  const owned = { geo: [], mat: [], tex: [] };
  const lib = ctx?.materials || null;
  const aniso = Math.max(1, Math.min(
    ctx?.renderer?.capabilities?.getMaxAnisotropy?.() ?? 8,
    ctx?.engine?.tier?.anisotropy ?? 8,
  ));

  const time = { value: 0 };
  const windU = { uTime: time, uWind: { value: new THREE.Vector2(0.42, 0.18) } };

  // --- material helpers ----------------------------------------------------
  function own(m) { owned.mat.push(m); return m; }
  function ownTex(t) { owned.tex.push(t); return t; }

  /** Library material (optionally a tinted variant) with a self-built fallback. */
  function libMat(name, opts, fallback) {
    if (lib && typeof lib.has === 'function' && lib.has(name)) {
      if (opts && typeof lib.variant === 'function') return lib.variant(name, opts);
      if (typeof lib.get === 'function') return lib.get(name);
    }
    const params = Object.assign({ roughness: 0.9, metalness: 0 }, fallback);
    if (opts?.color !== undefined) params.color = opts.color;
    if (opts?.roughness !== undefined) params.roughness = opts.roughness;
    if (opts?.metalness !== undefined) params.metalness = opts.metalness;
    if (opts?.side !== undefined) params.side = opts.side;
    const m = new THREE.MeshStandardMaterial(params);
    m.name = `props_${name}`;
    return own(m);
  }

  /**
   * The perimeter fence fabric.
   *
   * This deliberately does NOT take the material library's `chainlink`: that
   * map is built with automatic mipmaps, which is exactly what made the fence
   * shimmer with coloured speckles along its whole run in three separate
   * frames. The weave here goes through `makeCutoutTex` so the transparent
   * texels carry wire colour and every mip level keeps the same open area, and
   * anisotropy is forced up regardless of the quality tier.
   */
  function chainlinkMaterial() {
    const src = makeChainlinkTexture();
    const rep = [1 / 0.9, 1 / 0.9];
    const t = ownTex(makeCutoutTex(src.color, {
      alphaTest: FENCE_CUT, aniso, wrap: THREE.RepeatWrapping, repeat: rep,
    }));
    // the normal map has to be cut by the same alpha or the wire lights up
    // where there is no wire, so it is built from the weave's own height field
    const nrm = ownTex(makeCutoutTex(normalFromHeight(src.height, 2.6), {
      alphaTest: 0.0, aniso, wrap: THREE.RepeatWrapping, repeat: rep, srgb: false, dilate: 0,
    }));
    const m = new THREE.MeshStandardMaterial({
      name: 'props_chainlink',
      map: t,
      normalMap: nrm,
      normalScale: new THREE.Vector2(0.7, 0.7),
      alphaTest: FENCE_CUT,
      transparent: false,
      side: THREE.DoubleSide,
      shadowSide: THREE.DoubleSide,
      roughness: 0.62,
      metalness: 0.85,
      envMapIntensity: 0.95,
    });
    // Free anti-aliasing on the cut-out wherever the target is multisampled;
    // a no-op (not an error) when it is not.
    m.alphaToCoverage = true;
    return own(m);
  }

  const MAT = {
    chainlink: chainlinkMaterial(),
    galv: libMat('railSteel', { color: 0xa8adb2, roughness: 0.52 }, { color: 0xa8adb2, roughness: 0.5, metalness: 1 }),
    steelDark: libMat('paintedMetal', { color: 0x4a4f57, roughness: 0.74 }, { color: 0x4a4f57, roughness: 0.72, metalness: 0.85 }),
    steelGreen: libMat('paintedMetal', { color: 0x35543f, roughness: 0.78 }, { color: 0x35543f, roughness: 0.76, metalness: 0.8 }),
    steelBlue: libMat('paintedMetal', { color: 0x2f4d78, roughness: 0.7 }, { color: 0x2f4d78, roughness: 0.7, metalness: 0.85 }),
    steelRust: libMat('corrugatedMetal', { color: 0x8d5a3a, roughness: 0.9 }, { color: 0x8d5a3a, roughness: 0.9, metalness: 0.7 }),
    containerSkin: libMat('corrugatedMetal', { color: 0x9c4a34, roughness: 0.82 }, { color: 0x9c4a34, roughness: 0.8, metalness: 0.75 }),
    concrete: libMat('concreteWorn', null, { color: 0x9d998f, roughness: 0.96 }),
    concretePale: libMat('concrete', { color: 0xb2ada1 }, { color: 0xb2ada1, roughness: 0.95 }),
    asphaltDark: libMat('asphalt', { color: 0x6a6a6c }, { color: 0x6a6a6c, roughness: 1 }),
    wood: libMat('wood', null, { color: 0x9a7a52, roughness: 0.94 }),
    woodGrey: libMat('wood', { color: 0x8e8a80 }, { color: 0x8e8a80, roughness: 0.96 }),
    plywood: libMat('plywood', null, { color: 0xb08a55, roughness: 0.92 }),
    plastic: libMat('plasticGloss', { color: 0x2f7f6a, roughness: 0.42 }, { color: 0x2f7f6a, roughness: 0.42, metalness: 0 }),
    plasticGrey: libMat('plasticGloss', { color: 0xb9bcbd, roughness: 0.5 }, { color: 0xb9bcbd, roughness: 0.5, metalness: 0 }),
    rubber: libMat('rubber', null, { color: 0x181a1c, roughness: 0.92 }),
    glass: libMat('glass', null, {
      color: 0x203038, roughness: 0.12, metalness: 0.2,
      transparent: true, opacity: 0.55,
    }),
  };

  // --- procedural textures + the materials that need them ------------------
  const bannerTex = ownTex(makeTex(makeBannerAtlas(), { aniso }));
  // Every alpha-tested map goes through makeCutoutTex: dilated albedo plus a
  // coverage-preserving mip chain, which is what kills the coloured sparkle
  // along leaf and wire edges.
  const leafTex = ownTex(makeCutoutTex(makeLeafTexture(), { alphaTest: LEAF_CUT, aniso }));
  const palmTex = ownTex(makeCutoutTex(makePalmTexture(), { alphaTest: PALM_CUT, aniso }));
  const weedTex = ownTex(makeCutoutTex(makeWeedTexture(), { alphaTest: WEED_CUT, aniso }));
  const graffitiTex = ownTex(makeTex(makeGraffitiTexture(), { aniso }));
  const coneTex = ownTex(makeTex(makeConeTexture(), { aniso, wrap: THREE.RepeatWrapping }));
  const dustTex = ownTex(makeTex(makeDustTexture(), { aniso }));
  const skidTex = ownTex(makeTex(makeSkidTexture(), { aniso }));
  const litterTex = ownTex(makeCutoutTex(makeLitterTexture(), { alphaTest: LITTER_CUT, aniso }));
  const distantTex = ownTex(makeTex(makeDistantCityTexture(), { aniso, wrap: THREE.RepeatWrapping, repeat: [3, 1] }));
  const grimeTex = ownTex(makeTex(makeGrimeTexture(), { aniso }));

  // ---------------------------------------------------------------------
  // Aerial perspective for the backdrop.
  //
  // The scene's height fog thins out ~9 m above grade, which is correct for the
  // lot but leaves a 150 m tower crisp and black against the sky. Everything in
  // the city backdrop therefore carries its own per-vertex `aHaze` and is
  // blended toward the horizon colour in linear space, before tonemapping. The
  // colour is pulled off scene.fog every frame, so it tracks time of day and
  // the environment's sun/anti-sun fog blend for free.
  // ---------------------------------------------------------------------
  //
  // The colour comes from this module's own time-of-day ramp rather than from
  // scene.fog: the environment biases its fog hard toward the sun and can hand
  // back values well outside [0,1], which is fine for a height-fog term that
  // dies 9 m above grade but would blow a 150 m tower to white. The scene fog is
  // still used to nudge the ramp, but only when it comes back sane.
  const HAZE_STOPS = [
    [0.00, 0x7d8698], [0.14, 0xa3adba], [0.33, 0xb1bbc7], [0.52, 0xacb3bd],
    [0.68, 0xbcb3a6], [0.84, 0x9a9fa8], [0.92, 0x4e566a], [1.00, 0x7d8698],
  ];
  const _hzA = new THREE.Color(), _hzB = new THREE.Color();
  function hazeForTod(t) {
    const tt = ((t % 1) + 1) % 1;
    let i = 0;
    while (i < HAZE_STOPS.length - 2 && HAZE_STOPS[i + 1][0] < tt) i++;
    const [t0, c0] = HAZE_STOPS[i];
    const [t1, c1] = HAZE_STOPS[i + 1];
    const f = clamp((tt - t0) / Math.max(1e-4, t1 - t0), 0, 1);
    _hzA.setHex(c0, THREE.SRGBColorSpace);
    _hzB.setHex(c1, THREE.SRGBColorSpace);
    return _hzA.lerp(_hzB, f);
  }
  const hazeU = { value: hazeForTod(0.68).clone() };

  function patchCityHaze(material) {
    const prev = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
      if (prev) prev(shader, renderer);
      shader.uniforms.uCityHaze = hazeU;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aHaze;\nvarying float vHaze;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvHaze = aHaze;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uCityHaze;\nvarying float vHaze;')
        .replace('#include <opaque_fragment>',
          '#include <opaque_fragment>\n\tgl_FragColor.rgb = mix( gl_FragColor.rgb, uCityHaze, vHaze );');
    };
    material.customProgramCacheKey = () => 'props_city_haze';
    return material;
  }

  /** Facade material for one treatment: albedo + packed rough/metal + lit windows. */
  function facadeMaterial(kind) {
    const f = makeFacade(kind);
    const rep = [1 / FACADE_M, 1 / FACADE_M];
    const m = new THREE.MeshStandardMaterial({
      name: `props_facade_${kind}`,
      map: ownTex(makeTex(f.color, { aniso, wrap: THREE.RepeatWrapping, repeat: rep })),
      roughnessMap: ownTex(makeTex(f.orm, { srgb: false, aniso, wrap: THREE.RepeatWrapping, repeat: rep })),
      emissiveMap: ownTex(makeTex(f.emissive, { aniso, wrap: THREE.RepeatWrapping, repeat: rep })),
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity: 0.03,
      vertexColors: true,
      roughness: 1,
      metalness: 1,
      envMapIntensity: 1.15,
      fog: false,
    });
    m.metalnessMap = m.roughnessMap;      // G = roughness, B = metalness
    return own(patchCityHaze(m));
  }

  const trimTex = ownTex(makeTex(makeTrimTexture(), { aniso, wrap: THREE.RepeatWrapping, repeat: [0.25, 0.25] }));
  /** Rough pale concrete/painted surfaces in the backdrop. */
  const cityTrimMat = own(patchCityHaze(new THREE.MeshStandardMaterial({
    name: 'props_city_trim', map: trimTex, vertexColors: true, fog: false,
    roughness: 0.9, metalness: 0.0, envMapIntensity: 0.9,
  })));
  /** Steel, plant rooms, aerials, viaduct furniture. */
  const cityDarkMat = own(patchCityHaze(new THREE.MeshStandardMaterial({
    name: 'props_city_dark', vertexColors: true, fog: false,
    roughness: 0.62, metalness: 0.72, envMapIntensity: 1.0,
  })));

  // Banners: one atlas, one merged mesh, wind wobble driven by aFlex.
  const bannerMat = own(new THREE.MeshStandardMaterial({
    name: 'props_banner',
    map: bannerTex,
    side: THREE.DoubleSide,
    roughness: 0.72,
    metalness: 0,
    envMapIntensity: 0.65,
  }));
  patchVertex(bannerMat, windU, /* glsl */`
    uniform float uTime;
    uniform vec2 uWind;
    attribute float aFlex;
    ${WIND_NOISE}
  `, /* glsl */`
    {
      vec3 wp = (modelMatrix * vec4(transformed, 1.0)).xyz;
      float t = uTime * 2.1;
      float w = propWave(wp, t, 1.9);
      float gust = 0.55 + 0.45 * sin(uTime * 0.37 + wp.x * 0.05);
      transformed += normal * (w * 0.085 * aFlex * gust);
      transformed.y -= abs(w) * 0.02 * aFlex;
      transformed.x += uWind.x * 0.012 * aFlex * gust;
    }
  `, 'props_banner_wind');

  // Rooftop billboards use the same atlas but must not flap.
  const billboardMat = own(patchCityHaze(new THREE.MeshStandardMaterial({
    name: 'props_billboard',
    map: bannerTex,
    side: THREE.DoubleSide,
    roughness: 0.8,
    metalness: 0,
    fog: false,
  })));

  const foliageMat = own(new THREE.MeshStandardMaterial({
    name: 'props_foliage',
    map: leafTex,
    alphaTest: LEAF_CUT,
    side: THREE.DoubleSide,
    roughness: 0.88,
    metalness: 0,
    envMapIntensity: 0.9,
  }));
  foliageMat.alphaToCoverage = true;
  patchVertex(foliageMat, windU, /* glsl */`
    uniform float uTime;
    uniform vec2 uWind;
    attribute float aWind;
    ${WIND_NOISE}
  `, /* glsl */`
    {
      vec3 ip = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
      float t = uTime * 1.15;
      float w = propWave(ip, t, 0.35);
      float gust = 0.6 + 0.4 * sin(uTime * 0.23 + ip.z * 0.03);
      transformed.x += w * 0.30 * aWind * gust * uWind.x;
      transformed.z += propWave(ip.zxy, t * 0.83, 0.41) * 0.22 * aWind * gust * uWind.y * 2.0;
      transformed.y -= abs(w) * 0.05 * aWind;
    }
  `, 'props_foliage_wind');

  const weedMat = own(new THREE.MeshStandardMaterial({
    name: 'props_weeds',
    map: weedTex,
    alphaTest: WEED_CUT,
    side: THREE.DoubleSide,
    roughness: 0.95,
    metalness: 0,
  }));
  weedMat.alphaToCoverage = true;
  patchVertex(weedMat, windU, /* glsl */`
    uniform float uTime;
    attribute float aWind;
    ${WIND_NOISE}
  `, /* glsl */`
    {
      vec3 ip = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
      float w = propWave(ip, uTime * 2.4, 0.9);
      transformed.x += w * 0.10 * aWind;
      transformed.z += propWave(ip.zxy, uTime * 2.1, 1.1) * 0.07 * aWind;
    }
  `, 'props_weed_wind');

  const FACADE_MATS = {
    curtain: facadeMaterial('curtain'),
    punched: facadeMaterial('punched'),
    brick: facadeMaterial('brick'),
  };

  const palmMat = own(new THREE.MeshStandardMaterial({
    name: 'props_palm',
    map: palmTex,
    alphaTest: PALM_CUT,
    side: THREE.DoubleSide,
    roughness: 0.84,
    metalness: 0,
    envMapIntensity: 0.9,
  }));
  palmMat.alphaToCoverage = true;
  patchVertex(palmMat, windU, /* glsl */`
    uniform float uTime;
    uniform vec2 uWind;
    attribute float aWind;
    ${WIND_NOISE}
  `, /* glsl */`
    {
      vec3 ip = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
      float t = uTime * 1.05;
      float w = propWave(ip, t, 0.31);
      float gust = 0.55 + 0.45 * sin(uTime * 0.19 + ip.x * 0.02);
      transformed.x += w * 0.42 * aWind * gust * uWind.x;
      transformed.z += propWave(ip.zxy, t * 0.79, 0.37) * 0.30 * aWind * gust;
      transformed.y -= abs(w) * 0.10 * aWind;
    }
  `, 'props_palm_wind');

  const graffitiMat = own(new THREE.MeshStandardMaterial({
    name: 'props_graffiti',
    map: graffitiTex,
    transparent: true,
    alphaTest: 0.06,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
    roughness: 0.78,
    metalness: 0.1,
  }));

  const coneMat = own(new THREE.MeshStandardMaterial({
    name: 'props_cone', map: coneTex, roughness: 0.7, metalness: 0,
  }));

  const decalBase = {
    transparent: true, depthWrite: false, roughness: 1, metalness: 0,
    polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6,
  };
  const dustMat = own(new THREE.MeshStandardMaterial({ name: 'props_dust', map: dustTex, opacity: 0.95, ...decalBase }));
  const skidMat = own(new THREE.MeshStandardMaterial({ name: 'props_skid', map: skidTex, opacity: 0.95, ...decalBase }));
  const litterMat = own(new THREE.MeshStandardMaterial({
    name: 'props_litter', map: litterTex, alphaTest: LITTER_CUT, side: THREE.DoubleSide, roughness: 0.92, metalness: 0,
  }));
  litterMat.alphaToCoverage = true;
  // per-instance atlas cell for the litter quads (2×2 atlas)
  litterMat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aCell;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n\tvMapUv = vMapUv * 0.5 + aCell;');
  };
  litterMat.customProgramCacheKey = () => 'props_litter_cell';

  /** Dirt that collects where two surfaces meet — tread/riser, kerb, plinth. */
  const grimeMat = own(new THREE.MeshStandardMaterial({
    name: 'props_grime',
    map: grimeTex,
    transparent: true,
    depthWrite: false,
    opacity: 0.95,
    roughness: 1,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: -5,
    polygonOffsetUnits: -5,
  }));

  // --- sawn timber: benches, picnic tables, pallet slats -------------------
  // The library's `wood` had no grain at this texel density, which is why the
  // benches read as a single grey value. This one is authored at 512 over a
  // 1 m tile (box UVs are already in metres) and carries its own normal map.
  const woodSrc = makeWoodTexture();
  const woodRep = [1, 1];
  const benchWoodMat = own(new THREE.MeshStandardMaterial({
    name: 'props_bench_wood',
    map: ownTex(makeTex(woodSrc.color, { aniso, wrap: THREE.RepeatWrapping, repeat: woodRep })),
    normalMap: ownTex(makeTex(normalFromHeight(woodSrc.height, 1.6), {
      srgb: false, aniso, wrap: THREE.RepeatWrapping, repeat: woodRep,
    })),
    normalScale: new THREE.Vector2(0.85, 0.85),
    vertexColors: true,
    color: 0xffffff,
    roughness: 0.86,
    metalness: 0,
    envMapIntensity: 0.7,
  }));

  const lampMat = own(new THREE.MeshStandardMaterial({
    name: 'props_lamp',
    color: 0x2a2a26,
    emissive: new THREE.Color(0xffdba4),
    emissiveIntensity: 0,
    roughness: 0.35,
    metalness: 0.1,
  }));
  const vehicleLampMat = own(new THREE.MeshStandardMaterial({
    name: 'props_vehicle_lamp',
    color: 0xc8c4bc,
    emissive: new THREE.Color(0xfff0d0),
    emissiveIntensity: 0,
    roughness: 0.3,
    metalness: 0.2,
  }));
  const tailLampMat = own(new THREE.MeshStandardMaterial({
    name: 'props_tail_lamp',
    color: 0x9e2020,
    emissive: new THREE.Color(0xff2a12),
    emissiveIntensity: 0.15,
    roughness: 0.35,
    metalness: 0.1,
  }));

  const distantMat = own(new THREE.MeshBasicMaterial({
    name: 'props_distant_city', map: distantTex, transparent: true, depthWrite: false,
    side: THREE.BackSide, fog: false, opacity: 0.9,
  }));

  // --- buckets -------------------------------------------------------------
  const lot = createBucket();      // props inside the play area: cast + receive
  const far = createBucket();      // beyond the shadow frustum: no shadow work
  const wallCollide = [];          // merged into a 'wall' collider
  const deckCollide = [];          // flat rideable tops -> 'ground' collider

  const lampHeads = [];            // Object3D markers for environment practicals
  const emissiveNight = [];        // { material, intensity }

  // =========================================================================
  // 1. perimeter chainlink fence
  // =========================================================================
  const RUNS = [
    { ax: -LOT.hx, az: -LOT.hz, bx: LOT.hx, bz: -LOT.hz, barbs: true },
    { ax: LOT.hx, az: -LOT.hz, bx: LOT.hx, bz: LOT.hz, barbs: false },
    { ax: LOT.hx, az: LOT.hz, bx: -LOT.hx, bz: LOT.hz, barbs: false, gate: true },
    { ax: -LOT.hx, az: LOT.hz, bx: -LOT.hx, bz: -LOT.hz, barbs: true },
  ];

  const fenceBays = [];            // { cx, cz, len, angle, run } for banner placement

  function fencePanel(len, h, kind) {
    const g = planeM(len, h, 8, 4);
    const p = g.attributes.position;
    const nrm = g.attributes.normal;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i);
      const u = x / len + 0.5, v = y / h + 0.5;
      // slack: the mesh always bows a little between posts
      let z = Math.sin(u * Math.PI) * 0.035 * (0.35 + v * 0.65);
      z += (noise01(x * 1.4 + 11.3, y * 1.4 + 4.7, 3) - 0.5) * 0.025;
      if (kind === 'bulge') {
        const d = Math.exp(-(Math.pow((u - 0.55) * 2.6, 2) + Math.pow((v - 0.45) * 2.2, 2)));
        z -= d * 0.62;
      } else if (kind === 'peel') {
        const d = clamp(1 - u * 1.9, 0, 1) * clamp(1 - v * 2.4, 0, 1);
        z -= d * d * 0.75;
        p.setY(i, y + d * d * 0.42);
      } else if (kind === 'lean') {
        z -= v * v * 0.30;
        p.setY(i, y - v * v * 0.08);
      }
      p.setZ(i, z);
      nrm.setXYZ(i, 0, 0, 1);
    }
    g.computeVertexNormals();
    return g;
  }

  const damaged = new Map();       // "run:bay" -> kind
  for (let i = 0; i < 9; i++) {
    const r = randInt(0, 3);
    const b = randInt(0, 20);
    damaged.set(`${r}:${b}`, pick(['bulge', 'bulge', 'peel', 'lean', 'missing']));
  }

  for (let r = 0; r < RUNS.length; r++) {
    const run = RUNS[r];
    const dx = run.bx - run.ax, dz = run.bz - run.az;
    const len = Math.hypot(dx, dz);
    const ux = dx / len, uz = dz / len;
    const angle = Math.atan2(-uz, ux);
    const bays = Math.max(1, Math.round(len / BAY));
    const bayLen = len / bays;
    // the gate run travels +X -> -X, so world x maps to distance s = hx - x
    const gateS = LOT.hx - GATE.centre;
    const gateStart = run.gate ? (gateS - GATE.width * 0.5) : 0;
    const gateEnd = run.gate ? (gateS + GATE.width * 0.5) : 0;

    for (let b = 0; b <= bays; b++) {
      const s = b * bayLen;
      const px = run.ax + ux * s, pz = run.az + uz * s;
      // gate posts are heavier; corner posts too
      const atGateEdge = run.gate && (Math.abs(s - gateStart) < bayLen * 0.55 || Math.abs(s - gateEnd) < bayLen * 0.55);
      const corner = (b === 0 || b === bays);
      const rad = corner || atGateEdge ? 0.055 : 0.032;
      const h = FENCE_H + (corner ? 0.14 : 0.08);
      const lean = damaged.get(`${r}:${b}`) === 'lean' ? rand(-0.06, 0.06) : 0;
      lot.add(MAT.galv, place(cyl(rad, rad * 1.06, h, corner ? 10 : 8), px, h * 0.5, pz, 0, lean, lean * 0.6));
      lot.add(MAT.galv, place(cyl(rad * 1.25, rad * 1.25, 0.05, 8), px, h + 0.02, pz));
      if (corner || atGateEdge) {
        // ground-fixing collar
        lot.add(MAT.concretePale, place(cyl(rad * 3.2, rad * 3.6, 0.14, 10), px, 0.06, pz));
      }
    }

    for (let b = 0; b < bays; b++) {
      const s0 = b * bayLen, sc = s0 + bayLen * 0.5;
      const cx = run.ax + ux * sc, cz = run.az + uz * sc;
      if (run.gate && sc > gateStart && sc < gateEnd) continue;      // gate opening

      const kind = damaged.get(`${r}:${b}`);
      fenceBays.push({ cx, cz, len: bayLen, angle, run: r, damaged: !!kind });

      if (kind !== 'missing') {
        const panelH = FENCE_H - 0.16;
        lot.add(MAT.chainlink, place(fencePanel(bayLen, panelH, kind), cx, 0.10 + panelH * 0.5, cz, angle));
      }
      // top rail + bottom tension wire
      lot.add(MAT.galv, place(cyl(0.023, 0.023, bayLen, 7), cx, FENCE_H + 0.02, cz, angle, 0, Math.PI * 0.5));
      lot.add(MAT.galv, place(cyl(0.007, 0.007, bayLen, 5), cx, 0.11, cz, angle, 0, Math.PI * 0.5));

      if (run.barbs && b % 2 === 0) {
        // three-strand barb arm leaning outward
        const armLen = 0.42;
        lot.add(MAT.galv, place(cyl(0.018, 0.018, armLen, 6), cx, FENCE_H + 0.18, cz, angle, 0.9, Math.PI * 0.0));
      }
    }

    if (run.barbs) {
      // barbed strands running the length of the run, above the arms
      for (let k = 0; k < 3; k++) {
        const hOff = 0.14 + k * 0.10;
        const outward = -0.10 - k * 0.06;
        const mx = (run.ax + run.bx) * 0.5 - uz * outward;
        const mz = (run.az + run.bz) * 0.5 + ux * outward;
        far.add(MAT.galv, place(cyl(0.006, 0.006, len - 0.2, 4), mx, FENCE_H + hOff, mz, angle, 0, Math.PI * 0.5));
      }
    }

    // collider wall (world space, split around the gate opening)
    const wallH = FENCE_H + 0.1;
    if (run.gate) {
      const segs = [[0, gateStart], [gateEnd, len]];
      for (const [s0, s1] of segs) {
        const l = s1 - s0;
        if (l < 0.2) continue;
        const mid = (s0 + s1) * 0.5;
        wallCollide.push(place(box(l, wallH, 0.14),
          run.ax + ux * mid, wallH * 0.5, run.az + uz * mid, angle));
      }
    } else {
      wallCollide.push(place(box(len, wallH, 0.14),
        (run.ax + run.bx) * 0.5, wallH * 0.5, (run.az + run.bz) * 0.5, angle));
    }
  }

  // --- gate: two leaves, one swung open -----------------------------------
  {
    const leafW = GATE.width * 0.5 - 0.06;
    const leafH = FENCE_H - 0.06;
    const hingeZ = LOT.hz;
    const hinges = [
      { x: GATE.centre - GATE.width * 0.5, dir: 1, open: -0.95 },
      { x: GATE.centre + GATE.width * 0.5, dir: -1, open: -0.18 },
    ];
    for (const hg of hinges) {
      const gateGroup = [];
      // frame: 2 uprights, top + bottom rail, one diagonal brace
      gateGroup.push(place(cyl(0.028, 0.028, leafH, 8), 0, leafH * 0.5, 0));
      gateGroup.push(place(cyl(0.028, 0.028, leafH, 8), leafW * hg.dir, leafH * 0.5, 0));
      gateGroup.push(place(cyl(0.024, 0.024, leafW, 6), leafW * 0.5 * hg.dir, leafH - 0.03, 0, 0, 0, Math.PI * 0.5));
      gateGroup.push(place(cyl(0.024, 0.024, leafW, 6), leafW * 0.5 * hg.dir, 0.05, 0, 0, 0, Math.PI * 0.5));
      const diag = Math.hypot(leafW, leafH);
      gateGroup.push(place(cyl(0.014, 0.014, diag, 5), leafW * 0.5 * hg.dir, leafH * 0.5, 0.01,
        0, 0, Math.atan2(leafW * hg.dir, leafH)));
      const frame = mergeGeometries(gateGroup.map(strip), false);
      for (const g of gateGroup) g.dispose();
      const panel = place(fencePanel(leafW - 0.06, leafH - 0.12, null), leafW * 0.5 * hg.dir, leafH * 0.5, 0);

      // swing about the hinge, then move the hinge into place
      _m4b.makeRotationY(hg.open * hg.dir);
      frame.applyMatrix4(_m4b); frame.translate(hg.x, 0, hingeZ);
      panel.applyMatrix4(_m4b); panel.translate(hg.x, 0, hingeZ);
      lot.add(MAT.galv, frame);
      lot.add(MAT.chainlink, panel);
    }
    // a dropped padlock chain coiled by the open leaf
    for (let i = 0; i < 7; i++) {
      const a = i * 0.9;
      lot.add(MAT.galv, place(new THREE.TorusGeometry(0.045, 0.012, 5, 8),
        GATE.centre - 1.6 + Math.cos(a) * 0.10, 0.02, LOT.hz - 0.35 + Math.sin(a) * 0.10,
        rand(0, TAU), Math.PI * 0.5, 0));
    }
  }

  // =========================================================================
  // 2. sponsor banners + vinyl signage on the fence
  // =========================================================================
  const bannerGeos = [];

  function bannerGeo(w, h, cell, segX = 10, segY = 4) {
    const g = planeCell(w, h, segX, segY, cell, ATLAS_COLS, ATLAS_ROWS);
    const p = g.attributes.position;
    const flex = new Float32Array(p.count);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i);
      const u = x / w + 0.5, v = y / h + 0.5;
      // baked wrinkles so the vinyl never reads as a flat card
      const wr = (noise01(u * 5.2 + 3.1, v * 3.4 + 8.7, 3) - 0.5) * 0.055
        + Math.sin(u * Math.PI * 3.0) * 0.012 * (1 - v);
      p.setZ(i, wr);
      // tied along the top edge and at the corners
      const corner = clamp(1 - Math.abs(u - 0.5) * 2, 0, 1);
      flex[i] = (1 - v) * (0.30 + 0.70 * corner);
    }
    g.computeVertexNormals();
    g.setAttribute('aFlex', new THREE.BufferAttribute(flex, 1));
    return g;
  }

  {
    // vinyl signage sits on posts at fixed spots; banners keep clear of them
    const signSpots = [
      { x: GATE.centre - GATE.width * 0.5 - 0.1, z: LOT.hz - 0.06, a: Math.PI, cell: 8 },
      { x: -LOT.hx + 0.08, z: -6, a: Math.PI * 0.5, cell: 9 },
      { x: LOT.hx - 0.08, z: 11, a: -Math.PI * 0.5, cell: 10 },
      { x: -8, z: -LOT.hz + 0.08, a: 0, cell: 11 },
    ];
    const candidates = fenceBays.filter((b) => !b.damaged
      && signSpots.every((s) => Math.hypot(s.x - b.cx, s.z - b.cz) > 3.2));
    const used = new Set();
    const bannerCells = [0, 1, 2, 3, 4, 5, 6, 7, 12, 13, 14, 15];
    for (let i = 0; i < 14 && candidates.length; i++) {
      let idx = randInt(0, candidates.length - 1);
      for (let k = 0; k < 8 && used.has(idx); k++) idx = randInt(0, candidates.length - 1);
      if (used.has(idx)) continue;
      used.add(idx);
      const bay = candidates[idx];
      const w = Math.min(bay.len - 0.35, 2.7), h = w * 0.5;
      const cell = bannerCells[i % bannerCells.length];
      const y = rand(1.02, 1.24);
      // inward normal is the panel's +Z after `angle`
      const g = bannerGeo(w, h, cell);
      place(g, bay.cx, y, bay.cz, bay.angle);
      // nudge off the mesh so it never z-fights the chainlink
      const nx = Math.sin(bay.angle), nz = Math.cos(bay.angle);
      g.translate(nx * 0.045, 0, nz * 0.045);
      bannerGeos.push(g);

      // zip ties at the grommets
      for (let k = 0; k < 4; k++) {
        const sx = (k % 2 ? 0.5 : -0.5) * (w - 0.2);
        const sy = (k < 2 ? 0.5 : -0.5) * (h - 0.06);
        lot.add(MAT.galv, place(cyl(0.012, 0.012, 0.10, 5),
          bay.cx + Math.cos(bay.angle) * sx + nx * 0.02, y + sy, bay.cz - Math.sin(bay.angle) * sx + nz * 0.02,
          bay.angle, Math.PI * 0.5, 0));
      }
    }

    for (const s of signSpots) {
      const g = bannerGeo(1.15, 0.575, s.cell, 4, 2);
      place(g, s.x, 1.62, s.z, s.a);
      bannerGeos.push(g);
      lot.add(MAT.galv, place(box(0.05, 0.62, 0.05), s.x + Math.sin(s.a) * 0.03, 1.3, s.z + Math.cos(s.a) * 0.03));
    }

    if (bannerGeos.length) {
      const merged = mergeGeometries(bannerGeos.map(strip), false);
      for (const g of bannerGeos) g.dispose();
      if (merged) {
        merged.computeBoundingSphere();
        const mesh = new THREE.Mesh(merged, bannerMat);
        mesh.name = 'props_banners';
        mesh.castShadow = false;
        mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        group.add(mesh);
        owned.geo.push(merged);
      }
    }
  }

  // =========================================================================
  // 3. light posts / stadium masts
  // =========================================================================
  function stadiumMast(x, z, height, heads, aim) {
    // tapered pole + base plate + ladder rungs
    lot.add(MAT.concretePale, place(cyl(0.42, 0.5, 0.5, 12), x, 0.25, z));
    lot.add(MAT.steelDark, place(cyl(0.10, 0.20, height, 10), x, height * 0.5 + 0.45, z));
    lot.add(MAT.steelDark, place(box(0.62, 0.05, 0.62), x, 0.52, z));
    for (let i = 0; i < 8; i++) {
      lot.add(MAT.steelDark, place(cyl(0.014, 0.014, 0.34, 4), x + 0.14, 1.4 + i * 0.9, z, 0, 0, Math.PI * 0.5));
    }
    // head frame
    const topY = height + 0.45;
    lot.add(MAT.steelDark, place(box(2.2, 0.10, 0.30), x, topY, z, aim));
    for (let i = 0; i < heads; i++) {
      const t = heads === 1 ? 0 : (i / (heads - 1) - 0.5);
      const hx = x + Math.cos(aim) * t * 1.9;
      const hz = z - Math.sin(aim) * t * 1.9;
      const tilt = 0.55;
      lot.add(MAT.steelDark, place(box(0.62, 0.20, 0.46), hx, topY + 0.22, hz, aim, -tilt));
      lot.add(MAT.steelDark, place(box(0.70, 0.06, 0.10), hx, topY + 0.36, hz, aim, -tilt));
      // emissive lens, angled down at the park
      const lens = place(box(0.54, 0.03, 0.38), hx, topY + 0.13, hz, aim, -tilt);
      lot.add(lampMat, lens);

      // Only the centre head of each mast is tagged: environment.js caps the
      // practicals it hangs off these markers, so one per mast spreads them out.
      if (i === (heads >> 1)) {
        const marker = new THREE.Object3D();
        marker.name = `lampHead_${lampHeads.length}`;
        marker.position.set(hx, topY + 0.05, hz);
        marker.userData.practicalLight = -0.25;    // environment.js hangs a PointLight here
        group.add(marker);
        lampHeads.push(marker);
      }
    }
    wallCollide.push(place(box(0.7, 2.2, 0.7), x, 1.1, z));
  }

  function streetLamp(x, z, aim) {
    const h = 6.4;
    lot.add(MAT.concretePale, place(cyl(0.24, 0.30, 0.36, 10), x, 0.18, z));
    lot.add(MAT.steelDark, place(cyl(0.075, 0.13, h, 10), x, h * 0.5 + 0.3, z));
    // curved arm, approximated with three short segments
    const segs = 3;
    for (let i = 0; i < segs; i++) {
      const t = (i + 0.5) / segs;
      const ang = lerp(-0.15, -1.25, t);
      const r = 0.55 + t * 1.05;
      lot.add(MAT.steelDark, place(cyl(0.06, 0.065, 0.75, 8),
        x + Math.cos(aim) * r, h + 0.42 + Math.sin(-ang) * 0.30 * (1 - t), z - Math.sin(aim) * r,
        aim, 0, ang));
    }
    const hx = x + Math.cos(aim) * 1.75, hz = z - Math.sin(aim) * 1.75;
    lot.add(MAT.steelDark, place(box(0.72, 0.14, 0.34), hx, h + 0.30, hz, aim));
    lot.add(lampMat, place(box(0.62, 0.05, 0.28), hx, h + 0.21, hz, aim));
    const marker = new THREE.Object3D();
    marker.name = `lampHead_street_${lampHeads.length}`;
    marker.position.set(hx, h + 0.15, hz);
    marker.userData.practicalLight = -0.2;
    group.add(marker);
    lampHeads.push(marker);
  }

  stadiumMast(-LOT.hx + 3.5, -LOT.hz + 4.0, 9.5, 3, -Math.PI * 0.25);
  stadiumMast(LOT.hx - 3.5, -LOT.hz + 4.0, 9.5, 3, Math.PI * 0.25);
  stadiumMast(LOT.hx - 3.5, LOT.hz - 4.0, 9.5, 3, Math.PI * 0.75);
  stadiumMast(-LOT.hx + 3.5, LOT.hz - 4.0, 9.5, 3, -Math.PI * 0.75);
  streetLamp(LOT.hx + 3.2, -12, Math.PI);
  streetLamp(-LOT.hx - 3.2, 18, 0);
  emissiveNight.push({ material: lampMat, intensity: 7.5 });

  // =========================================================================
  // 4. spectator concrete: bleachers, benches, picnic table
  // =========================================================================
  const BLEACH = { x: -LOT.hx + 6.0, z: 0, len: 18, tiers: 5, rise: 0.42, run: 0.80 };
  const seatRows = [];             // world-space seat lines for the crowd

  /** Vertex-darken a slat toward its sawn ends — end grain drinks the stain. */
  function endGrain(g, amount = 0.42, half = null) {
    const p = g.attributes.position;
    if (!g.attributes.color) tintGeo(g, 0xffffff);
    const c = g.attributes.color;
    let hx = half;
    if (hx == null) {
      hx = 0;
      for (let i = 0; i < p.count; i++) hx = Math.max(hx, Math.abs(p.getX(i)));
    }
    for (let i = 0; i < p.count; i++) {
      const t = clamp((Math.abs(p.getX(i)) - hx * 0.90) / (hx * 0.10 + 1e-4), 0, 1);
      const s = 1 - t * amount;
      c.setXYZ(i, c.getX(i) * s, c.getY(i) * s, c.getZ(i) * s);
    }
    return g;
  }

  /** A slat of sawn timber: metre UVs, per-piece tone, darkened end grain. */
  function slat(w, h, d, tone = 1) {
    const g = box(w, h, d);
    tintGeo(g, 0xffffff);
    const c = g.attributes.color;
    const t = tone * rand(0.86, 1.10);
    for (let i = 0; i < c.count; i++) c.setXYZ(i, c.getX(i) * t, c.getY(i) * t, c.getZ(i) * t);
    return endGrain(g, 0.40, w * 0.5);
  }

  /**
   * Grime strips. The gradient texture is opaque along v = 0, so the helpers
   * flip v to choose which edge the dirt collects against, and tile u along
   * the run so the blotches never repeat visibly.
   */
  function grimeUV(g, lenU, flip) {
    const uv = g.attributes.uv;
    const rep = Math.max(1, Math.round(lenU / 2.2));
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, uv.getX(i) * rep, flip ? 1 - uv.getY(i) : uv.getY(i));
    }
    return g;
  }
  /** Flat strip running along Z; dirt collects against the -X edge. */
  function grimeTread(cx, y, cz, lenZ, depthX) {
    const g = grimeUV(new THREE.PlaneGeometry(lenZ, depthX), lenZ, true);
    lot.add(grimeMat, place(g, cx, y, cz, Math.PI * 0.5, -Math.PI * 0.5));
  }
  /** Vertical strip on a face looking down +X; dirt collects at its foot. */
  function grimeRiser(cx, cy, cz, lenZ, height) {
    const g = grimeUV(new THREE.PlaneGeometry(lenZ, height), lenZ, false);
    lot.add(grimeMat, place(g, cx, cy, cz, Math.PI * 0.5));
  }

  /** Hex bolt head + washer, for slat-to-frame fixings. */
  function bolt(x, y, z, ry = 0, rx = 0, r = 0.011) {
    lot.add(MAT.galv, place(cyl(r * 1.9, r * 1.9, 0.004, 8), x, y, z, ry, rx));
    lot.add(MAT.galv, place(cyl(r, r, 0.009, 6), x, y, z, ry, rx));
  }

  {
    const b = BLEACH;
    for (let i = 0; i < b.tiers; i++) {
      const h = (i + 1) * b.rise;
      const x = b.x - i * b.run;
      lot.add(MAT.concrete, place(box(b.run, h, b.len), x, h * 0.5, b.z));

      // --- precast nosing, chipped ----------------------------------------
      // One continuous pale strip is what made these read as untouched grey
      // castings. The nosing is now a run of short precast lengths with a
      // handful of knocked-off corners and an exposed-aggregate scar behind
      // each one, which is what a five-year-old concrete stand actually is.
      const nx = x + b.run * 0.5 - 0.05;
      const segs = Math.round(b.len / 1.5);
      const segLen = b.len / segs;
      for (let s = 0; s < segs; s++) {
        const z0 = b.z - b.len * 0.5 + (s + 0.5) * segLen;
        const chipped = rng() < 0.26;
        const gap = 0.012;
        if (!chipped) {
          lot.add(MAT.concretePale,
            place(box(0.10, 0.05, segLen - gap), nx, h - 0.02, z0));
        } else {
          // the corner is gone: the strip steps back and drops, and the break
          // face is the darker aggregate underneath
          const bite = rand(0.16, 0.42) * segLen;
          const front = (segLen - gap - bite) * 0.5;
          lot.add(MAT.concretePale,
            place(box(0.10, 0.05, front), nx, h - 0.02, z0 - (segLen - gap) * 0.5 + front * 0.5));
          lot.add(MAT.concretePale,
            place(box(0.10, 0.05, front), nx, h - 0.02, z0 + (segLen - gap) * 0.5 - front * 0.5));
          lot.add(MAT.concrete,
            place(box(0.075, 0.036, bite), nx - 0.013, h - 0.030, z0, 0, 0, rand(-0.12, 0.12)));
        }
      }
      // precast panel joints across the tread
      for (let s = 1; s < segs; s++) {
        const z0 = b.z - b.len * 0.5 + s * segLen;
        lot.add(MAT.concrete, place(box(b.run * 0.92, 0.012, 0.018), x, h - 0.004, z0));
      }
      // dirt where the tread meets the riser behind it, and a wash down the
      // riser face itself
      grimeTread(x - b.run * 0.5 + 0.15, h + 0.004, b.z, b.len - 0.05, 0.30);
      if (i < b.tiers - 1) {
        grimeRiser(x - b.run * 0.5 + 0.006, h + 0.10, b.z, b.len - 0.05, 0.20);
      }

      deckCollide.push(place(box(b.run, 0.12, b.len), x, h - 0.06, b.z));
      // Seat line: 0.28 m back from the nosing, so a seated figure's thighs
      // clear the edge and the feet land on the tread below instead of
      // floating over the step they are sitting on.
      seatRows.push({ x: x + 0.12, y: h, z: b.z, len: b.len, run: b.run, tier: i });
    }
    // side cheeks + a back wall so the stand reads as a solid casting
    const backX = b.x - b.tiers * b.run;
    const totalH = b.tiers * b.rise;
    lot.add(MAT.concrete, place(box(b.tiers * b.run + 0.3, 0.34, 0.30), backX + b.run * 0.4, totalH + 0.17, b.z + b.len * 0.5 + 0.15));
    lot.add(MAT.concrete, place(box(b.tiers * b.run + 0.3, 0.34, 0.30), backX + b.run * 0.4, totalH + 0.17, b.z - b.len * 0.5 - 0.15));
    lot.add(MAT.concrete, place(box(0.32, totalH + 0.5, b.len + 0.6), backX - 0.1, (totalH + 0.5) * 0.5, b.z));
    wallCollide.push(place(box(0.4, totalH + 0.5, b.len + 0.6), backX - 0.1, (totalH + 0.5) * 0.5, b.z));
    // handrails up the middle aisle
    for (let i = 0; i <= b.tiers; i++) {
      const h = i * b.rise;
      lot.add(MAT.galv, place(cyl(0.03, 0.03, 0.95, 7), b.x - i * b.run + 0.3, h + 0.48, b.z));
    }
    lot.add(MAT.galv, place(cyl(0.032, 0.032, b.tiers * b.run * 1.25, 7),
      b.x - b.tiers * b.run * 0.5 + 0.3, totalH * 0.5 + 0.95, b.z, 0, 0, Math.PI * 0.5 - Math.atan2(b.rise, b.run)));
  }

  function bench(x, z, ry) {
    // cast concrete end frames
    lot.add(MAT.concretePale, place(box(0.14, 0.44, 0.62), x + Math.cos(ry) * 0.86, 0.22, z - Math.sin(ry) * 0.86, ry));
    lot.add(MAT.concretePale, place(box(0.14, 0.44, 0.62), x - Math.cos(ry) * 0.86, 0.22, z + Math.sin(ry) * 0.86, ry));
    lot.add(MAT.steelDark, place(box(1.7, 0.05, 0.08), x, 0.40, z, ry));
    for (let i = 0; i < 4; i++) {
      const off = -0.20 + i * 0.135;
      const g = slat(1.86, 0.055, 0.115);
      place(g, x + Math.sin(ry) * off, 0.455, z + Math.cos(ry) * off, ry);
      lot.add(benchWoodMat, g);
      // coach bolts through the slat into each end frame
      for (const s of [-1, 1]) {
        bolt(x + Math.cos(ry) * s * 0.80 + Math.sin(ry) * off, 0.485,
          z - Math.sin(ry) * s * 0.80 + Math.cos(ry) * off, ry);
      }
    }
    // backrest
    for (let i = 0; i < 3; i++) {
      const g = slat(1.86, 0.055, 0.12);
      place(g, x + Math.sin(ry) * -0.28, 0.62 + i * 0.145, z + Math.cos(ry) * -0.28, ry, -0.22);
      lot.add(benchWoodMat, g);
      for (const s of [-1, 1]) {
        bolt(x + Math.cos(ry) * s * 0.80 + Math.sin(ry) * -0.315, 0.62 + i * 0.145,
          z - Math.sin(ry) * s * 0.80 + Math.cos(ry) * -0.315, ry, Math.PI * 0.5);
      }
    }
    lot.add(MAT.steelDark, place(box(0.06, 0.52, 0.06), x + Math.cos(ry) * 0.8 + Math.sin(ry) * -0.28, 0.66, z - Math.sin(ry) * 0.8 + Math.cos(ry) * -0.28, ry, -0.22));
    lot.add(MAT.steelDark, place(box(0.06, 0.52, 0.06), x - Math.cos(ry) * 0.8 + Math.sin(ry) * -0.28, 0.66, z + Math.sin(ry) * 0.8 + Math.cos(ry) * -0.28, ry, -0.22));
    deckCollide.push(place(box(1.9, 0.10, 0.62), x, 0.44, z, ry));
  }

  bench(BLEACH.x + 4.2, -7.5, -Math.PI * 0.5);
  bench(BLEACH.x + 4.2, 7.5, -Math.PI * 0.5);
  bench(LOT.hx - 5.5, 4.0, Math.PI * 0.5);

  function picnicTable(x, z, ry) {
    const topY = 0.74, seatY = 0.45;
    for (let i = 0; i < 5; i++) {
      const off = -0.36 + i * 0.18;
      lot.add(benchWoodMat, place(slat(1.9, 0.045, 0.17, 0.96),
        x + Math.sin(ry) * off, topY, z + Math.cos(ry) * off, ry));
      for (const s of [-1, 1]) {
        bolt(x + Math.cos(ry) * s * 0.70 + Math.sin(ry) * off, topY + 0.024,
          z - Math.sin(ry) * s * 0.70 + Math.cos(ry) * off, ry);
      }
    }
    for (const side of [-1, 1]) {
      for (let i = 0; i < 2; i++) {
        const off = side * (0.72 + i * 0.19);
        lot.add(benchWoodMat, place(slat(1.9, 0.045, 0.17, 0.92),
          x + Math.sin(ry) * off, seatY, z + Math.cos(ry) * off, ry));
        for (const s of [-1, 1]) {
          bolt(x + Math.cos(ry) * s * 0.70 + Math.sin(ry) * off, seatY + 0.024,
            z - Math.sin(ry) * s * 0.70 + Math.cos(ry) * off, ry);
        }
      }
    }
    // A-frame legs
    for (const end of [-1, 1]) {
      const ex = x + Math.cos(ry) * end * 0.72, ez = z - Math.sin(ry) * end * 0.72;
      for (const side of [-1, 1]) {
        lot.add(benchWoodMat, place(slat(0.08, 0.86, 0.09, 0.88),
          ex + Math.sin(ry) * side * 0.42, 0.42, ez + Math.cos(ry) * side * 0.42, ry, 0, side * 0.42));
      }
      lot.add(benchWoodMat, place(slat(0.07, 0.07, 1.86, 0.90), ex, seatY - 0.06, ez, ry));
      lot.add(benchWoodMat, place(slat(0.07, 0.5, 0.07, 0.90), ex, 0.5, ez, ry));
    }
    deckCollide.push(place(box(1.9, 0.10, 0.95), x, topY, z, ry));
    wallCollide.push(place(box(1.9, 0.5, 1.9), x, 0.25, z, ry));
  }
  picnicTable(LOT.hx - 8.0, -16.0, 0.35);
  picnicTable(LOT.hx - 11.5, -18.5, -0.22);

  // =========================================================================
  // 5. loose lot furniture: bins, pallets, cones, toilets, container
  // =========================================================================
  function trashCan(x, z, ry, knocked) {
    const geos = [];
    const H = 0.92, R = 0.31;
    // ribbed body approximated with three stacked bands
    geos.push(place(cyl(R, R * 0.92, H * 0.34, 14, true), 0, H * 0.17, 0));
    geos.push(place(cyl(R * 1.02, R, H * 0.34, 14, true), 0, H * 0.51, 0));
    geos.push(place(cyl(R * 0.99, R * 1.02, H * 0.34, 14, true), 0, H * 0.85, 0));
    geos.push(place(new THREE.TorusGeometry(R * 1.03, 0.022, 5, 16), 0, H - 0.02, 0, 0, Math.PI * 0.5));
    geos.push(place(new THREE.TorusGeometry(R * 1.0, 0.02, 5, 16), 0, H * 0.5, 0, 0, Math.PI * 0.5));
    // dented lid, pushed to one side
    geos.push(place(cyl(R * 0.86, R * 1.05, 0.09, 14), 0.03, H + 0.04, 0.02, 0, 0.06));
    const merged = mergeGeometries(geos.map(strip), false);
    for (const g of geos) g.dispose();
    if (!merged) return;
    if (knocked) {
      place(merged, x, R + 0.01, z, ry, Math.PI * 0.5, 0.06);
    } else {
      place(merged, x, 0, z, ry);
      wallCollide.push(place(box(0.66, H, 0.66), x, H * 0.5, z, ry));
    }
    lot.add(MAT.steelGreen, merged);
  }
  trashCan(LOT.hx - 6.0, 7.4, 0.4, false);
  trashCan(-LOT.hx + 9.5, -14.0, 1.1, false);
  trashCan(LOT.hx - 9.2, 10.6, 2.2, true);
  trashCan(GATE.centre - 3.4, LOT.hz - 1.6, 0.2, false);

  function palletStack(x, z, ry, count) {
    let y = 0;
    for (let p = 0; p < count; p++) {
      const jx = rand(-0.06, 0.06), jz = rand(-0.06, 0.06), jr = rand(-0.05, 0.05);
      const px = x + jx, pz = z + jz, pr = ry + jr;
      // bottom boards
      for (let i = 0; i < 3; i++) {
        const off = -0.5 + i * 0.5;
        lot.add(MAT.woodGrey, place(box(1.2, 0.022, 0.14), px + Math.sin(pr) * off, y + 0.011, pz + Math.cos(pr) * off, pr));
      }
      // stringers
      for (let i = 0; i < 3; i++) {
        const off = -0.5 + i * 0.5;
        lot.add(MAT.woodGrey, place(box(1.2, 0.09, 0.10), px + Math.sin(pr) * off, y + 0.067, pz + Math.cos(pr) * off, pr));
      }
      // deck boards
      for (let i = 0; i < 7; i++) {
        const off = -0.5 + i * 0.1667;
        lot.add(MAT.woodGrey, place(box(1.2, 0.022, 0.115), px + Math.sin(pr) * off, y + 0.123, pz + Math.cos(pr) * off, pr));
      }
      y += 0.145;
    }
    deckCollide.push(place(box(1.3, 0.12, 1.2), x, y - 0.02, z, ry));
    wallCollide.push(place(box(1.3, y, 1.2), x, y * 0.5, z, ry));
  }
  palletStack(-LOT.hx + 5.0, 22.0, 0.28, 6);
  palletStack(-LOT.hx + 6.6, 23.6, -0.5, 3);
  // one pallet leaning on the fence
  lot.add(MAT.woodGrey, place(box(1.2, 0.14, 1.2), -LOT.hx + 1.3, 0.62, 19.0, 0.1, 0, 1.32));

  // traffic cones — one instanced draw for the lot
  {
    const parts = [
      place(cyl(0.035, 0.16, 0.56, 12, true), 0, 0.30, 0),
      place(box(0.30, 0.035, 0.30), 0, 0.017, 0),
      place(cyl(0.17, 0.19, 0.05, 12), 0, 0.05, 0),
    ];
    const geo = mergeGeometries(parts.map(strip), false);
    for (const g of parts) g.dispose();
    const spots = [
      [GATE.centre - 2.2, LOT.hz - 2.4, 0], [GATE.centre + 2.4, LOT.hz - 2.8, 0],
      [GATE.centre - 0.2, LOT.hz - 4.6, 0], [LOT.hx - 7.5, -9.5, 0], [LOT.hx - 8.4, -11.2, 1],
      [-LOT.hx + 11.0, 15.0, 0], [-LOT.hx + 12.4, 16.4, 1], [LOT.hx - 12.0, 18.5, 0],
      [-6.0, LOT.hz - 3.2, 0], [-3.6, LOT.hz - 3.6, 1],
    ];
    const cones = new THREE.InstancedMesh(geo, coneMat, spots.length);
    cones.name = 'props_cones';
    cones.castShadow = true;
    cones.receiveShadow = true;
    for (let i = 0; i < spots.length; i++) {
      const [x, z, tipped] = spots[i];
      _euler.set(tipped ? Math.PI * 0.5 : 0, rand(0, TAU), tipped ? rand(-0.3, 0.3) : 0, 'YXZ');
      _quat.setFromEuler(_euler);
      _pos.set(x, tipped ? 0.17 : 0, z);
      _scl.setScalar(rand(0.92, 1.08));
      _m4.compose(_pos, _quat, _scl);
      cones.setMatrixAt(i, _m4);
    }
    cones.instanceMatrix.needsUpdate = true;
    group.add(cones);
    owned.geo.push(geo);
  }

  function portaloo(x, z, ry, tint) {
    const W = 1.16, D = 1.16, H = 2.28;
    const body = tint ? MAT.plasticGrey : MAT.plastic;
    // shell built from four walls so the door face can be recessed
    lot.add(body, place(box(W, H, 0.07), x + Math.sin(ry) * -D * 0.5, H * 0.5, z + Math.cos(ry) * -D * 0.5, ry));
    lot.add(body, place(box(0.07, H, D), x + Math.cos(ry) * W * 0.5, H * 0.5, z - Math.sin(ry) * W * 0.5, ry));
    lot.add(body, place(box(0.07, H, D), x - Math.cos(ry) * W * 0.5, H * 0.5, z + Math.sin(ry) * W * 0.5, ry));
    // door face
    lot.add(body, place(box(W, H, 0.06), x + Math.sin(ry) * D * 0.5, H * 0.5, z + Math.cos(ry) * D * 0.5, ry));
    lot.add(MAT.plasticGrey, place(box(W * 0.72, H * 0.82, 0.03), x + Math.sin(ry) * (D * 0.5 + 0.04), H * 0.5 - 0.02, z + Math.cos(ry) * (D * 0.5 + 0.04), ry));
    lot.add(MAT.steelDark, place(box(0.10, 0.16, 0.05), x + Math.sin(ry) * (D * 0.5 + 0.06) + Math.cos(ry) * 0.42, 1.18, z + Math.cos(ry) * (D * 0.5 + 0.06) - Math.sin(ry) * 0.42, ry));
    // roof + translucent skylight + vent stack
    lot.add(body, place(box(W + 0.10, 0.09, D + 0.10), x, H + 0.045, z, ry));
    lot.add(MAT.plasticGrey, place(box(W * 0.6, 0.03, D * 0.6), x, H + 0.10, z, ry));
    lot.add(body, place(cyl(0.07, 0.07, 0.55, 8), x + Math.cos(ry) * 0.42, H + 0.32, z - Math.sin(ry) * 0.42, ry));
    lot.add(body, place(box(0.05, H * 0.9, 0.05), x + Math.cos(ry) * (W * 0.5 - 0.02), H * 0.5, z - Math.sin(ry) * (W * 0.5 - 0.02), ry));
    wallCollide.push(place(box(W + 0.12, H, D + 0.12), x, H * 0.5, z, ry));
    deckCollide.push(place(box(W + 0.12, 0.12, D + 0.12), x, H + 0.05, z, ry));
  }
  portaloo(LOT.hx - 3.4, 20.4, -Math.PI * 0.5 + 0.1, false);
  portaloo(LOT.hx - 3.4, 22.0, -Math.PI * 0.5 - 0.05, true);

  // --- shipping container ---------------------------------------------------
  {
    const CX = -LOT.hx + 8.5, CZ = -LOT.hz + 9.0, CR = 0.22;
    const L = 6.06, W = 2.44, H = 2.59;
    const skin = MAT.containerSkin;
    // corrugated side/end walls, slightly inset from the corner posts
    lot.add(skin, place(box(L - 0.16, H - 0.30, 0.10), CX + Math.sin(CR) * W * 0.5, H * 0.5, CZ + Math.cos(CR) * W * 0.5, CR));
    lot.add(skin, place(box(L - 0.16, H - 0.30, 0.10), CX - Math.sin(CR) * W * 0.5, H * 0.5, CZ - Math.cos(CR) * W * 0.5, CR));
    lot.add(skin, place(box(0.10, H - 0.30, W - 0.10), CX - Math.cos(CR) * L * 0.5, H * 0.5, CZ + Math.sin(CR) * L * 0.5, CR));
    lot.add(skin, place(box(L, 0.10, W), CX, H - 0.05, CZ, CR));
    lot.add(skin, place(box(L, 0.16, W), CX, 0.08, CZ, CR));
    // corner posts + top/bottom rails give the silhouette its weight
    for (const ex of [-1, 1]) {
      for (const ez of [-1, 1]) {
        const px = CX + Math.cos(CR) * ex * L * 0.5 + Math.sin(CR) * ez * W * 0.5;
        const pz = CZ - Math.sin(CR) * ex * L * 0.5 + Math.cos(CR) * ez * W * 0.5;
        lot.add(MAT.steelRust, place(box(0.16, H, 0.16), px, H * 0.5, pz, CR));
      }
      lot.add(MAT.steelRust, place(box(L, 0.16, 0.14), CX + Math.sin(CR) * ex * W * 0.5, H - 0.08, CZ + Math.cos(CR) * ex * W * 0.5, CR));
      lot.add(MAT.steelRust, place(box(L, 0.18, 0.16), CX + Math.sin(CR) * ex * W * 0.5, 0.09, CZ + Math.cos(CR) * ex * W * 0.5, CR));
    }
    // cargo doors on the +X end: two leaves with four locking bars
    const dx = CX + Math.cos(CR) * L * 0.5, dz = CZ - Math.sin(CR) * L * 0.5;
    lot.add(MAT.steelRust, place(box(0.08, H - 0.32, W - 0.16), dx, H * 0.5, dz, CR));
    for (let i = 0; i < 4; i++) {
      const off = -0.78 + i * 0.52;
      lot.add(MAT.steelDark, place(cyl(0.035, 0.035, H - 0.5, 6), dx + Math.cos(CR) * 0.06 + Math.sin(CR) * off, H * 0.5, dz - Math.sin(CR) * 0.06 + Math.cos(CR) * off, CR));
      lot.add(MAT.steelDark, place(box(0.10, 0.16, 0.06), dx + Math.cos(CR) * 0.10 + Math.sin(CR) * off, 1.30, dz - Math.sin(CR) * 0.10 + Math.cos(CR) * off, CR));
    }
    // graffiti on the face that looks at the park
    const gg = new THREE.PlaneGeometry(L - 0.5, (H - 0.5) * 0.72);
    place(gg, CX + Math.sin(CR) * (W * 0.5 + 0.08), 1.30, CZ + Math.cos(CR) * (W * 0.5 + 0.08), CR);
    lot.add(graffitiMat, gg);

    wallCollide.push(place(box(L, H, W), CX, H * 0.5, CZ, CR));
    deckCollide.push(place(box(L, 0.14, W), CX, H, CZ, CR));

    // crate and drum clutter against the container
    lot.add(MAT.plywood, place(box(1.1, 0.9, 0.9), CX + 3.9, 0.45, CZ + 0.6, 0.5));
    lot.add(MAT.plywood, place(box(0.9, 0.75, 0.85), CX + 4.3, 1.15, CZ + 0.2, -0.3));
    for (let i = 0; i < 3; i++) {
      lot.add(MAT.steelBlue, place(cyl(0.29, 0.29, 0.88, 14), CX - 3.6 - i * 0.66, 0.44, CZ + 1.5 + (i % 2) * 0.6, 0));
      lot.add(MAT.steelBlue, place(new THREE.TorusGeometry(0.295, 0.03, 5, 14), CX - 3.6 - i * 0.66, 0.62, CZ + 1.5 + (i % 2) * 0.6, 0, Math.PI * 0.5));
      lot.add(MAT.steelBlue, place(new THREE.TorusGeometry(0.295, 0.03, 5, 14), CX - 3.6 - i * 0.66, 0.26, CZ + 1.5 + (i % 2) * 0.6, 0, Math.PI * 0.5));
    }
  }

  // =========================================================================
  // 6. parked vehicles
  // =========================================================================
  function wheelSet(bucket, spots, r, width, ry) {
    for (const [wx, wy, wz] of spots) {
      bucket.add(MAT.rubber, place(cyl(r, r, width, 14, false), wx, wy, wz, ry, 0, Math.PI * 0.5));
      bucket.add(MAT.galv, place(cyl(r * 0.58, r * 0.58, width + 0.012, 10), wx, wy, wz, ry, 0, Math.PI * 0.5));
      bucket.add(MAT.steelDark, place(cyl(r * 0.30, r * 0.30, width + 0.03, 8), wx, wy, wz, ry, 0, Math.PI * 0.5));
    }
  }

  function pickup(x, z, ry, bodyMat) {
    const co = Math.cos(ry), si = Math.sin(ry);
    const at = (fwd, side, y) => [x + co * fwd + si * side, y, z - si * fwd + co * side];
    const W = 1.94, wheelR = 0.38;

    // chassis
    lot.add(bodyMat, place(box(5.42, 0.30, W), x, 0.62, z, ry));
    // bed: floor, walls, tailgate
    lot.add(bodyMat, place(box(2.10, 0.06, W - 0.10), ...at(-1.55, 0, 0.79), ry));
    lot.add(bodyMat, place(box(2.10, 0.52, 0.09), ...at(-1.55, W * 0.5 - 0.05, 1.02), ry));
    lot.add(bodyMat, place(box(2.10, 0.52, 0.09), ...at(-1.55, -W * 0.5 + 0.05, 1.02), ry));
    lot.add(bodyMat, place(box(0.09, 0.50, W - 0.06), ...at(-2.58, 0, 1.00), ry));
    // cab
    lot.add(bodyMat, place(box(1.72, 0.78, W - 0.04), ...at(0.12, 0, 1.15), ry));
    lot.add(bodyMat, place(box(1.66, 0.06, W - 0.10), ...at(0.10, 0, 1.56), ry));
    // A/B pillars
    for (const s of [-1, 1]) {
      lot.add(bodyMat, place(box(0.09, 0.44, 0.09), ...at(0.86, s * (W * 0.5 - 0.08), 1.35), ry, 0, 0.28));
      lot.add(bodyMat, place(box(0.09, 0.44, 0.09), ...at(-0.68, s * (W * 0.5 - 0.08), 1.35), ry, 0, -0.10));
    }
    // hood, grille, bumpers, fenders
    lot.add(bodyMat, place(box(1.42, 0.24, W - 0.06), ...at(1.72, 0, 1.06), ry, 0, -0.04));
    lot.add(MAT.steelDark, place(box(0.14, 0.36, W - 0.22), ...at(2.44, 0, 0.92), ry));
    lot.add(MAT.galv, place(box(0.20, 0.20, W + 0.06), ...at(2.52, 0, 0.66), ry));
    lot.add(MAT.galv, place(box(0.18, 0.18, W + 0.06), ...at(-2.66, 0, 0.66), ry));
    for (const s of [-1, 1]) {
      lot.add(bodyMat, place(box(1.20, 0.30, 0.10), ...at(1.70, s * (W * 0.5 + 0.02), 0.86), ry));
      lot.add(bodyMat, place(box(1.20, 0.30, 0.10), ...at(-1.55, s * (W * 0.5 + 0.02), 0.86), ry));
      // mirrors
      lot.add(MAT.steelDark, place(box(0.10, 0.18, 0.06), ...at(0.94, s * (W * 0.5 + 0.14), 1.44), ry));
    }
    // glass
    lot.add(MAT.glass, place(box(0.06, 0.44, W - 0.20), ...at(0.90, 0, 1.36), ry, 0, 0.30));
    lot.add(MAT.glass, place(box(0.05, 0.42, W - 0.20), ...at(-0.66, 0, 1.36), ry, 0, -0.12));
    for (const s of [-1, 1]) {
      lot.add(MAT.glass, place(box(1.32, 0.40, 0.05), ...at(0.12, s * (W * 0.5 - 0.03), 1.37), ry));
    }
    // lamps
    for (const s of [-1, 1]) {
      lot.add(vehicleLampMat, place(box(0.06, 0.20, 0.42), ...at(2.50, s * 0.66, 0.98), ry));
      lot.add(tailLampMat, place(box(0.06, 0.26, 0.20), ...at(-2.64, s * 0.78, 1.02), ry));
    }
    wheelSet(lot, [at(1.68, W * 0.5 - 0.02, wheelR), at(1.68, -W * 0.5 + 0.02, wheelR),
      at(-1.58, W * 0.5 - 0.02, wheelR), at(-1.58, -W * 0.5 + 0.02, wheelR)], wheelR, 0.26, ry);

    wallCollide.push(place(box(5.5, 1.35, W + 0.2), x, 0.68, z, ry));
    deckCollide.push(place(box(2.1, 0.12, W - 0.1), ...at(-1.55, 0, 0.82), ry));
    deckCollide.push(place(box(1.7, 0.12, W), ...at(0.10, 0, 1.60), ry));
  }

  function boxVan(x, z, ry, cabMat, boxMat) {
    const co = Math.cos(ry), si = Math.sin(ry);
    const at = (fwd, side, y) => [x + co * fwd + si * side, y, z - si * fwd + co * side];
    const W = 2.16, wheelR = 0.44;

    lot.add(MAT.steelDark, place(box(6.4, 0.24, W - 0.2), x, 0.66, z, ry));
    // cab
    lot.add(cabMat, place(box(1.94, 1.52, W), ...at(2.06, 0, 1.58), ry));
    lot.add(cabMat, place(box(1.30, 0.34, W - 0.04), ...at(2.80, 0, 1.04), ry, 0, -0.05));
    lot.add(MAT.glass, place(box(0.07, 0.86, W - 0.22), ...at(2.96, 0, 1.92), ry, 0, 0.30));
    for (const s of [-1, 1]) {
      lot.add(MAT.glass, place(box(0.92, 0.62, 0.06), ...at(2.20, s * (W * 0.5 - 0.02), 1.84), ry));
      lot.add(vehicleLampMat, place(box(0.07, 0.24, 0.40), ...at(3.36, s * 0.72, 1.02), ry));
      lot.add(MAT.steelDark, place(box(0.12, 0.30, 0.07), ...at(2.86, s * (W * 0.5 + 0.16), 2.02), ry));
    }
    lot.add(MAT.galv, place(box(0.22, 0.26, W + 0.06), ...at(3.44, 0, 0.62), ry));
    // box body, sitting on the chassis rails above the wheels
    const BL = 4.3, BH = 2.10, BBOT = 0.95;
    lot.add(boxMat, place(box(BL, BH, W + 0.12), ...at(-1.05, 0, BBOT + BH * 0.5), ry));
    lot.add(MAT.steelDark, place(box(BL + 0.06, 0.10, W + 0.18), ...at(-1.05, 0, BBOT - 0.02), ry));
    // roll-up door ribs at the back
    for (let i = 0; i < 6; i++) {
      lot.add(MAT.steelDark, place(box(0.05, 0.05, W - 0.1), ...at(-3.22, 0, BBOT + 0.20 + i * 0.32), ry));
    }
    lot.add(MAT.steelDark, place(box(0.08, 0.24, 0.16), ...at(-3.26, 0, BBOT + 0.12), ry));
    // roof vents + ladder
    lot.add(MAT.plasticGrey, place(box(0.5, 0.12, 0.5), ...at(-0.4, 0, BBOT + BH + 0.06), ry));
    for (let i = 0; i < 5; i++) {
      lot.add(MAT.galv, place(cyl(0.018, 0.018, 0.44, 5), ...at(-3.20, 0.55, BBOT + 0.25 + i * 0.34), ry, 0, Math.PI * 0.5));
    }
    for (const s of [-1, 1]) {
      lot.add(tailLampMat, place(box(0.06, 0.22, 0.18), ...at(-3.26, s * 0.82, BBOT + 0.10), ry));
    }
    // wheel arches so the tyres do not clip a flat wall
    for (const s of [-1, 1]) {
      lot.add(boxMat, place(box(1.20, 0.34, 0.09), ...at(-1.70, s * (W * 0.5 + 0.06), BBOT - 0.06), ry));
    }
    wheelSet(lot, [at(2.30, W * 0.5 - 0.06, wheelR), at(2.30, -W * 0.5 + 0.06, wheelR),
      at(-1.70, W * 0.5 - 0.06, wheelR), at(-1.70, -W * 0.5 + 0.06, wheelR)], wheelR, 0.28, ry);

    wallCollide.push(place(box(6.6, BBOT + BH, W + 0.3), x, (BBOT + BH) * 0.5, z, ry));
    deckCollide.push(place(box(BL, 0.14, W + 0.12), ...at(-1.05, 0, BBOT + BH), ry));
  }

  const truckPaint = libMat('paintedMetal', { color: 0x7d2b26, roughness: 0.52 }, { color: 0x7d2b26, roughness: 0.5, metalness: 0.7 });
  const vanCab = libMat('paintedMetal', { color: 0x3f5f80, roughness: 0.55 }, { color: 0x3f5f80, roughness: 0.54, metalness: 0.65 });
  const vanBox = libMat('corrugatedMetal', { color: 0xd6d2c6, roughness: 0.74 }, { color: 0xd6d2c6, roughness: 0.72, metalness: 0.5 });
  pickup(LOT.hx - 7.4, 14.6, Math.PI * 0.5 + 0.06, truckPaint);
  boxVan(GATE.centre - 9.5, LOT.hz - 5.2, -0.12, vanCab, vanBox);
  emissiveNight.push({ material: vehicleLampMat, intensity: 2.2 });
  emissiveNight.push({ material: tailLampMat, intensity: 1.4, base: 0.15 });

  // =========================================================================
  // 7. spectator crowd — five poses x three builds, all instanced
  // =========================================================================
  // The crowd used to be flat vertex-colour boxes in a lattice. It now:
  //   * samples a garment atlas (weave, denim twill, printed tee, face, hair,
  //     cap) with a normal map baked from the same height field, at ~730 px/m;
  //   * picks its atlas column per instance, so one geometry dresses a whole
  //     row differently;
  //   * runs a desaturated, value-capped palette with per-instance hue jitter
  //     instead of pure saturated fills;
  //   * comes in three builds and five poses, scattered with real position and
  //     facing jitter and real gaps.
  const crowdAtlas = makeCrowdAtlas();
  const crowdMat = own(new THREE.MeshStandardMaterial({
    name: 'props_crowd',
    map: ownTex(makeTex(crowdAtlas.color, { aniso })),
    normalMap: ownTex(makeTex(normalFromHeight(crowdAtlas.height, 1.4), { srgb: false, aniso })),
    normalScale: new THREE.Vector2(0.55, 0.55),
    vertexColors: true,
    roughness: 0.88,
    metalness: 0,
    envMapIntensity: 0.75,
  }));
  crowdMat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        uniform float uTime;
        attribute float aRegion;
        attribute float aPhase;
        attribute float aTop;
        attribute float aBot;
        attribute vec3 aShirt;
        attribute vec3 aPants;
        attribute vec3 aSkin;
        attribute vec3 aHair;
      `)
      .replace('#include <uv_vertex>', /* glsl */`
        #include <uv_vertex>
        {
          // garment variety without a second mesh: slide the atlas column
          vec2 cellShift = vec2( 0.0 );
          if ( aRegion > 0.5 && aRegion < 1.5 ) cellShift.x = aTop * 0.25;
          else if ( aRegion > 1.5 && aRegion < 2.5 ) cellShift.x = aBot * 0.25;
          vMapUv += cellShift;
          vNormalMapUv += cellShift;
        }
      `)
      .replace('#include <color_vertex>', /* glsl */`
        #include <color_vertex>
        {
          vec3 tint = aSkin;
          if ( aRegion > 6.5 ) tint = aHair;                        // cap / beanie
          else if ( aRegion > 5.5 ) tint = aSkin;                   // face
          else if ( aRegion > 4.5 ) tint = aShirt * 0.86;           // sleeve
          else if ( aRegion > 3.5 ) tint = aHair;                   // hair
          else if ( aRegion > 2.5 ) tint = vec3( 0.055, 0.05, 0.058 ); // shoes
          else if ( aRegion > 1.5 ) tint = aPants;
          else if ( aRegion > 0.5 ) tint = aShirt;
          vColor.rgb *= tint;
        }
      `)
      .replace('#include <begin_vertex>', /* glsl */`
        #include <begin_vertex>
        {
          // Idle motion: weight shifts from foot to foot, the chest breathes
          // and the arms trail it. Everything is scaled by height off the
          // ground so the feet stay planted.
          float t = uTime * 1.55 + aPhase;
          float up = clamp( position.y * 0.62, 0.0, 1.25 );
          float arm = clamp( ( position.y - 0.9 ) * 1.4, 0.0, 1.0 );
          float bob = sin( t * 0.85 ) * 0.013 + sin( t * 0.41 + 1.7 ) * 0.009;
          float sway = sin( t * 0.47 ) * 0.021 + sin( t * 1.31 + 2.2 ) * 0.006;
          transformed.y += bob * up;
          transformed.x += sway * up;
          transformed.z += cos( t * 0.39 + 1.1 ) * 0.012 * up;
          transformed.x += sin( t * 1.9 + 0.7 ) * 0.016 * arm * sign( position.x + 0.001 );
          transformed.z += sin( t * 1.6 ) * 0.014 * arm;
        }
      `);
  };
  crowdMat.customProgramCacheKey = () => 'props_crowd_atlas';

  // aRegion drives both the tint and the atlas cell the part was authored into
  const REG = { skin: 0, top: 1, bottom: 2, dark: 3, hair: 4, sleeve: 5, face: 6, cap: 7 };
  const CELL = {
    top: [0, 0], bottom: [0, 1], sleeve: [3, 1], skin: [0, 2], face: [1, 2],
    hair: [2, 2], cap: [3, 2], shoe: [0, 3], dark: [1, 3], beanie: [2, 3],
  };
  const UV_SPAN = 0.55;        // metres of garment mapped across one atlas cell
  const ATLAS_PAD = 0.012;     // cell inset, so mip bleed stays inside the cell

  /** Rewrite a part's metre UVs into one cell of the crowd atlas. */
  function atlasUV(geo, cx, cy, span) {
    const uv = geo.attributes.uv;
    const c = 1 / CROWD_ATLAS;
    const u0 = cx * c, v0 = 1 - (cy + 1) * c;
    let sx = 1 / (span || 1), sy = sx, ox = 0, oy = 0;
    if (!span) {
      let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
      for (let i = 0; i < uv.count; i++) {
        const u = uv.getX(i), v = uv.getY(i);
        if (u < minU) minU = u; if (u > maxU) maxU = u;
        if (v < minV) minV = v; if (v > maxV) maxV = v;
      }
      sx = 1 / Math.max(1e-4, maxU - minU); sy = 1 / Math.max(1e-4, maxV - minV);
      ox = -minU * sx; oy = -minV * sy;
    }
    const inner = c * (1 - 2 * ATLAS_PAD), pad = c * ATLAS_PAD;
    for (let i = 0; i < uv.count; i++) {
      const u = clamp(uv.getX(i) * sx + ox, 0, 1);
      const v = clamp(uv.getY(i) * sy + oy, 0, 1);
      uv.setXY(i, u0 + pad + u * inner, v0 + pad + v * inner);
    }
    return geo;
  }

  function figurePart(geo, region, shade, cell, span) {
    atlasUV(geo, cell[0], cell[1], span);
    tintGeo(geo, 0xffffff);
    const c = geo.attributes.color;
    for (let i = 0; i < c.count; i++) c.setXYZ(i, shade, shade, shade);
    floatAttr(geo, 'aRegion', region);
    return strip(geo);
  }

  /**
   * One bone of a spectator. `len` is signed: negative hangs down from the joint
   * at (x,y,z), positive rises from it. Returns the far end so the next bone in
   * the chain can start there — that is what gives the crowd real elbows, knees
   * and a head that follows a leaning torso.
   */
  function bone(out, region, shade, cell, x, y, z, len, w, d, pitch, roll, taper = 0.86) {
    const g = box(w, Math.abs(len), d);
    if (taper !== 1) {
      const h = Math.abs(len) * 0.5;
      taperY(g, -h, h, len < 0 ? taper : 1, len < 0 ? 1 : taper);
    }
    g.translate(0, len * 0.5, 0);
    _euler.set(pitch, 0, roll, 'YXZ');
    _quat.setFromEuler(_euler);
    _scl.set(1, 1, 1);
    _m4.compose(_pos.set(x, y, z), _quat, _scl);
    g.applyMatrix4(_m4);
    out.push(figurePart(g, region, shade, cell, UV_SPAN));
    const cr = Math.cos(roll), sr = Math.sin(roll);
    return [x - len * sr, y + len * cr * Math.cos(pitch), z + len * cr * Math.sin(pitch)];
  }

  /**
   * A spectator in a given pose and build. +Z is the direction the figure
   * faces, and because `bone` rotates about the joint, a hanging bone (arms,
   * legs) swings forward on NEGATIVE pitch while a rising one (torso, neck)
   * leans forward on POSITIVE pitch.
   */
  function figureGeo(o, v) {
    const p = [];
    const hipY = o.hipY;
    const G = v.girth, TW = v.torso, SW = v.shoulder;

    // --- legs, hips ---------------------------------------------------------
    for (let s = 0; s < 2; s++) {
      const sx = (s ? 0.098 : -0.098) * TW;
      const sh = s ? 0.88 : 0.95;
      const knee = bone(p, REG.bottom, sh, CELL.bottom, sx, hipY, 0, -0.44,
        0.138 * G, 0.162 * G, o.thigh[s], (s ? 0.035 : -0.035), 0.82);
      const ank = bone(p, REG.bottom, sh * 0.97, CELL.bottom, knee[0], knee[1], knee[2], -0.43,
        0.108 * G, 0.122 * G, o.shin[s], 0, 0.84);
      const fy = o.footYaw ? (s ? o.footYaw : -o.footYaw) : 0;
      p.push(figurePart(place(box(0.102 * G, 0.078, 0.265),
        ank[0], ank[1] + 0.012, ank[2] + 0.062, fy), REG.dark, 0.98, CELL.shoe, UV_SPAN));
      // ankle/sock so the shoe is not a floating slab
      p.push(figurePart(place(box(0.088 * G, 0.075, 0.10),
        ank[0], ank[1] + 0.062, ank[2] + 0.005), REG.skin, 0.9, CELL.skin, UV_SPAN));
    }
    p.push(figurePart(place(box(0.305 * TW, 0.215, 0.198 * TW), 0, hipY + 0.05, 0),
      REG.bottom, 0.97, CELL.bottom, UV_SPAN));

    // --- torso --------------------------------------------------------------
    const waistY = hipY + 0.145;
    const CHEST = 0.455;
    const shoulder = bone(p, REG.top, 1.0, CELL.top, 0, waistY, 0, CHEST,
      0.335 * TW, 0.212 * TW, o.torso, 0, 1.10);
    const sinT = Math.sin(o.torso), cosT = Math.cos(o.torso);
    // shoulder yoke: gives the silhouette its width right where it matters
    p.push(figurePart(place(taperY(box(0.42 * SW, 0.135, 0.235 * TW), -0.07, 0.07, 1.0, 0.86),
      shoulder[0], shoulder[1] - 0.045 * cosT, shoulder[2] - 0.045 * sinT, 0, o.torso),
      REG.top, 1.0, CELL.top, UV_SPAN));

    // --- arms ---------------------------------------------------------------
    // Held clear of the torso and shaded a stop darker than the body of the
    // top, so an arm actually reads as an arm at fence distance.
    let wx = 0, wy = 0, wz = 0;
    for (let s = 0; s < 2; s++) {
      const side = s ? 1 : -1;
      const sx = side * (0.196 * SW + 0.024);
      const sh = s ? 0.9 : 0.97;
      const ay = shoulder[1] - 0.055 * cosT;
      const az = shoulder[2] - 0.055 * sinT;
      const elbow = bone(p, REG.sleeve, sh, CELL.sleeve, sx, ay, az, -0.285,
        0.104 * G, 0.112 * G, o.upperArm[s], o.armRoll[s] + side * 0.11, 0.88);
      const wrist = bone(p, REG.skin, sh, CELL.skin, elbow[0], elbow[1], elbow[2], -0.27,
        0.088 * G, 0.096 * G, o.upperArm[s] + o.elbow[s],
        (o.foreRoll ? o.foreRoll[s] : o.armRoll[s] * 0.4) + side * 0.05, 0.9);
      // hand
      p.push(figurePart(place(box(0.078 * G, 0.115, 0.072 * G),
        wrist[0], wrist[1] - 0.05, wrist[2]), REG.skin, 0.95, CELL.skin, UV_SPAN));
      wx += wrist[0] * 0.5; wy += (wrist[1] - 0.05) * 0.5; wz += wrist[2] * 0.5;
    }
    // a phone held between the hands, for the filming pose
    if (o.prop === 'phone') {
      p.push(figurePart(place(box(0.076, 0.142, 0.011), wx, wy + 0.03, wz + 0.035, 0, -0.35),
        REG.dark, 1.0, CELL.dark, UV_SPAN));
    }

    // --- neck, head, hair/headwear ------------------------------------------
    const neck = bone(p, REG.skin, 0.88, CELL.skin,
      shoulder[0], shoulder[1] - 0.03 * cosT, shoulder[2] - 0.03 * sinT,
      0.085, 0.088 * G, 0.09 * G, o.torso * 0.35, 0, 1);
    const hp = o.torso * 0.35 + (o.head || 0);
    const hx = neck[0], hy = neck[1] + 0.098 * Math.cos(hp), hz = neck[2] + 0.098 * Math.sin(hp);
    // A lat-long sphere, not an icosahedron: u = 0.25 lands on +Z, which is
    // what lets the atlas put eyes, brows and a mouth on the front of the face.
    const headGeo = new THREE.SphereGeometry(0.103, 14, 10);
    headGeo.scale(0.98, 1.16, 1.04);
    p.push(figurePart(place(headGeo, hx, hy, hz, 0, hp), REG.face, 1.0, CELL.face, null));

    if (v.hat === 'cap') {
      const crown = new THREE.SphereGeometry(0.107, 14, 8, 0, TAU, 0, Math.PI * 0.62);
      crown.scale(1.02, 1.12, 1.04);
      p.push(figurePart(place(crown, hx, hy + 0.012, hz, 0, hp), REG.cap, 1.0, CELL.cap, null));
      p.push(figurePart(place(taperY(box(0.185, 0.016, 0.125), -0.008, 0.008, 1, 1),
        hx, hy + 0.038 - 0.012 * Math.cos(hp), hz + 0.112 * Math.cos(hp), 0, hp - 0.22),
        REG.cap, 0.92, CELL.cap, UV_SPAN));
      // hair still shows at the nape
      p.push(figurePart(place(box(0.17, 0.075, 0.055),
        hx, hy - 0.028, hz - 0.086, 0, hp), REG.hair, 0.9, CELL.hair, UV_SPAN));
    } else if (v.hat === 'beanie') {
      const crown = new THREE.SphereGeometry(0.111, 14, 9, 0, TAU, 0, Math.PI * 0.66);
      crown.scale(1.02, 1.14, 1.03);
      p.push(figurePart(place(crown, hx, hy + 0.016, hz, 0, hp), REG.cap, 1.0, CELL.beanie, null));
      p.push(figurePart(place(new THREE.TorusGeometry(0.104, 0.019, 5, 14),
        hx, hy + 0.030, hz, 0, Math.PI * 0.5), REG.cap, 0.88, CELL.beanie, null));
    } else {
      const hair = new THREE.SphereGeometry(0.108, 14, 9, 0, TAU, 0, Math.PI * 0.60);
      hair.scale(1.04, 1.08, 1.06);
      p.push(figurePart(place(hair, hx, hy + 0.010, hz - 0.006, 0, hp), REG.hair, 1.0, CELL.hair, null));
      p.push(figurePart(place(box(0.175, 0.135, 0.070),
        hx, hy - 0.004, hz - 0.080, 0, hp), REG.hair, 0.9, CELL.hair, UV_SPAN));
    }

    const g = mergeGeometries(p, false);
    for (const q of p) q.dispose();
    return g;
  }

  const POSE = {
    // relaxed stand: weight on one leg, one forearm brought up across the chest
    stand: {
      hipY: 0.900, torso: 0.055, footYaw: 0.22,
      thigh: [0.05, -0.06], shin: [-0.06, 0.04],
      upperArm: [0.08, 0.16], armRoll: [-0.12, 0.13], elbow: [-0.34, -1.15],
      head: -0.04,
    },
    // arms folded, hunched forward watching the run — the strongest silhouette
    // of the set at fence distance
    lean: {
      hipY: 0.885, torso: 0.26, footYaw: 0.14,
      thigh: [0.06, -0.05], shin: [-0.08, 0.06],
      upperArm: [-0.12, -0.10], armRoll: [-0.20, 0.22], elbow: [-1.72, -1.66],
      foreRoll: [1.28, -1.24], head: 0.14,
    },
    // arms up: someone calling a trick
    cheer: {
      hipY: 0.902, torso: -0.06, footYaw: 0.34,
      thigh: [-0.03, 0.03], shin: [0.02, -0.02],
      upperArm: [2.55, 2.68], armRoll: [-0.34, 0.36], elbow: [0.42, 0.36],
      head: -0.18,
    },
    // filming the run on a phone held out in front
    film: {
      hipY: 0.898, torso: 0.10, footYaw: 0.26,
      thigh: [0.03, -0.04], shin: [-0.05, 0.03],
      upperArm: [-0.86, -0.83], armRoll: [-0.30, 0.32], elbow: [-0.80, -0.76],
      foreRoll: [0.34, -0.34], head: 0.06, prop: 'phone',
    },
    // seated on the tread with the forearms on the knees
    sit: {
      hipY: 0.080, torso: 0.20, footYaw: 0.18,
      thigh: [-1.42, -1.38], shin: [-0.06, -0.11],
      upperArm: [-0.72, -0.68], armRoll: [-0.10, 0.11], elbow: [-0.95, -0.90],
      head: 0.10,
    },
  };

  /** Three silhouettes, each with its own headwear. */
  const BUILDS = [
    { girth: 0.90, torso: 0.93, shoulder: 0.97, hat: 'hair' },
    { girth: 1.00, torso: 1.00, shoulder: 1.00, hat: 'cap' },
    { girth: 1.15, torso: 1.14, shoulder: 1.06, hat: 'beanie' },
  ];

  // Raw wardrobe, before the calming pass. Nothing here reaches the frame at
  // this saturation — `calmSwatch` pulls it back and caps the value.
  const SHIRTS = [0xd8452f, 0x2f6fb8, 0xe8e2d4, 0x2a2d33, 0xe0a52b, 0x4a8f5c, 0x8f4ba0,
    0xd97ea0, 0x3c3f8f, 0xb8b2a4, 0xf0f0ea, 0x1f6f68, 0xc25a1e, 0x6f7480];
  const PANTS = [0x2b3242, 0x4a4438, 0x22242a, 0x5a5f66, 0x38424f, 0x6a5a44, 0x8a8578, 0x2f3b4c];
  const SKINS = [0x9c6b4a, 0x81563a, 0x5f3c26, 0xb08059, 0x4a2f1e, 0x8c6242, 0xc09472];
  const HAIRS = [0x1c1614, 0x2e2018, 0x4a3423, 0x6a4a2c, 0x8a7050, 0x161616];
  const CAPS = [0x2a2f3a, 0x7a2f28, 0x1b3f6a, 0x3f4a3a, 0x2a2a2c, 0x6a5c3e, 0x8a8478];

  const _hsl = { h: 0, s: 0, l: 0 };
  /**
   * Pull a swatch toward neutral, cap its value and jitter it per instance.
   * Flat saturated fills are exactly what made the old crowd read as debug
   * capsules, and a 1.0-albedo white tee blows out under the golden-hour key.
   */
  function calmSwatch(hex, satMul, maxL) {
    _col.setHex(hex, THREE.SRGBColorSpace);
    _col.getHSL(_hsl, THREE.SRGBColorSpace);
    const h = (_hsl.h + rand(-0.022, 0.022) + 1) % 1;
    const s = clamp(_hsl.s * satMul * rand(0.80, 1.16), 0, 1);
    const l = clamp(Math.min(_hsl.l, maxL) * rand(0.86, 1.08), 0.05, maxL);
    _col.setHSL(h, s, l, THREE.SRGBColorSpace);
    return _col;
  }

  function crowdMesh(geo, spots, name, cast) {
    const n = spots.length;
    if (!n) { geo.dispose(); return null; }
    const shirt = new Float32Array(n * 3);
    const pants = new Float32Array(n * 3);
    const skin = new Float32Array(n * 3);
    const hair = new Float32Array(n * 3);
    const phase = new Float32Array(n);
    const topCell = new Float32Array(n);
    const botCell = new Float32Array(n);
    const mesh = new THREE.InstancedMesh(geo, crowdMat, n);
    mesh.name = name;
    mesh.castShadow = cast;
    mesh.receiveShadow = false;
    const put = (arr, i, col) => {
      arr[i * 3] = col.r; arr[i * 3 + 1] = col.g; arr[i * 3 + 2] = col.b;
    };
    for (let i = 0; i < n; i++) {
      const s = spots[i];
      _euler.set(0, s.ry, 0, 'YXZ');
      _quat.setFromEuler(_euler);
      _pos.set(s.x, s.y, s.z);
      const h = s.s;
      _scl.set(h * rand(0.94, 1.06), h, h * rand(0.94, 1.06));
      _m4.compose(_pos, _quat, _scl);
      mesh.setMatrixAt(i, _m4);
      put(shirt, i, calmSwatch(pick(SHIRTS), 0.60, 0.70));
      put(pants, i, calmSwatch(pick(PANTS), 0.62, 0.44));
      put(skin, i, calmSwatch(pick(SKINS), 0.88, 0.74));
      put(hair, i, calmSwatch(pick(s.hat === 'hair' ? HAIRS : CAPS), 0.78, 0.46));
      phase[i] = rand(0, TAU);
      topCell[i] = randInt(0, 3);
      botCell[i] = randInt(0, 3) === 3 ? 2 : randInt(0, 2);
    }
    geo.setAttribute('aShirt', new THREE.InstancedBufferAttribute(shirt, 3));
    geo.setAttribute('aPants', new THREE.InstancedBufferAttribute(pants, 3));
    geo.setAttribute('aSkin', new THREE.InstancedBufferAttribute(skin, 3));
    geo.setAttribute('aHair', new THREE.InstancedBufferAttribute(hair, 3));
    geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
    geo.setAttribute('aTop', new THREE.InstancedBufferAttribute(topCell, 1));
    geo.setAttribute('aBot', new THREE.InstancedBufferAttribute(botCell, 1));
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);
    owned.geo.push(geo);
    return mesh;
  }

  const bikeSpots = [];       // spectators' bikes, parked or held beside them

  {
    // The figure is authored 1.77 m tall, so the instance scale is the
    // spectator's height over that. 0.905..1.06 puts the crowd between 1.60 m
    // and 1.88 m, which is the same range the rider is built to.
    const height = () => rand(0.905, 1.060);
    const lists = { stand: [], lean: [], cheer: [], film: [], sit: [] };

    /** Push a spectator into whichever pose list suits the spot. */
    const spec = (x, z, ry, opts = {}) => {
      const r = rng();
      const key = opts.atFence
        ? (r < 0.44 ? 'lean' : r < 0.68 ? 'stand' : r < 0.84 ? 'film' : 'cheer')
        : (r < 0.58 ? 'stand' : r < 0.76 ? 'lean' : r < 0.90 ? 'cheer' : 'film');
      const build = randInt(0, BUILDS.length - 1);
      lists[key].push({
        x, y: opts.y || 0, z, ry, s: height(), build, hat: BUILDS[build].hat,
      });
      if (opts.bikes && rng() < 0.32) {
        bikeSpots.push({
          x: x + Math.cos(ry) * rand(0.55, 0.9),
          z: z - Math.sin(ry) * rand(0.55, 0.9),
          ry: ry + rand(-0.5, 0.5),
        });
      }
    };

    // The fence lines: a scatter with real gaps in it, not an even spacing.
    // Yaw jitter is +/-40 deg so no two neighbours face exactly the same way.
    const YAW = 0.70;
    for (let i = 0; i < 26; i++) {
      const x = lerp(-27, 33, i / 25) + rand(-1.1, 1.1);
      if (Math.abs(x - GATE.centre) < GATE.width * 0.5 + 0.7) continue;
      if (rng() < 0.20) continue;                       // gaps along the rail
      const z = LOT.hz - rand(0.75, 1.35);
      spec(x, z, Math.atan2(-x, -z) + rand(-YAW, YAW), { atFence: true, bikes: true });
    }
    for (let i = 0; i < 13; i++) {
      const x = lerp(-22, 30, i / 12) + rand(-1.6, 1.6);
      if (Math.abs(x - GATE.centre) < GATE.width * 0.5 + 1.2) continue;
      if (rng() < 0.26) continue;
      spec(x, LOT.hz - rand(1.9, 3.1), Math.atan2(-x, -LOT.hz) + rand(-YAW, YAW), { bikes: true });
    }
    for (let i = 0; i < 14; i++) {
      const x = lerp(-20, 26, i / 13) + rand(-1.3, 1.3);
      if (rng() < 0.22) continue;
      spec(x, -LOT.hz + rand(0.8, 1.6), Math.atan2(-x, LOT.hz) + rand(-YAW, YAW), { atFence: true });
    }
    for (let i = 0; i < 9; i++) {
      const z = lerp(-16, 10, i / 8) + rand(-1.3, 1.3);
      if (rng() < 0.20) continue;
      spec(LOT.hx - rand(0.9, 2.0), z, Math.atan2(-LOT.hx, -z) + rand(-YAW, YAW),
        { atFence: true, bikes: true });
    }
    // knots hanging around the gate and the bleacher aisle
    for (let i = 0; i < 7; i++) {
      spec(GATE.centre - 6 + rand(-2.6, 2.6), LOT.hz - 6 + rand(-2.4, 2.4), rand(0, TAU), { bikes: true });
    }
    for (let i = 0; i < 6; i++) {
      spec(BLEACH.x + rand(1.0, 3.6), rand(-10, 10), Math.PI * 0.5 + rand(-YAW, YAW), { bikes: true });
    }

    // Bleachers: clusters with real gaps between them, seated on the tread and
    // scattered along it rather than stamped out on a grid. Roughly a quarter
    // of the stand is standing rather than sitting, which breaks the row line.
    for (let r = 0; r < seatRows.length; r++) {
      const row = seatRows[r];
      const clusters = randInt(2, 3);
      let guard = 0;
      for (let c = 0; c < clusters; c++) {
        const z0 = rand(-row.len * 0.40, row.len * 0.34);
        const n = randInt(1, 4);
        for (let i = 0; i < n; i++) {
          if (guard++ > 12) break;
          const z = z0 + i * rand(0.68, 0.95) + rand(-0.22, 0.22);
          if (Math.abs(z) > row.len * 0.47) continue;
          const build = randInt(0, BUILDS.length - 1);
          const standing = rng() < 0.24;
          lists[standing ? (rng() < 0.5 ? 'stand' : 'film') : 'sit'].push({
            // seated figures sit back on the tread; standing ones stand on it
            x: row.x + (standing ? rand(-0.16, -0.02) : rand(-0.06, 0.06)),
            y: row.y,
            z,
            ry: Math.PI * 0.5 + rand(-YAW, YAW),
            s: height(),
            build,
            hat: BUILDS[build].hat,
          });
        }
      }
    }

    for (const key of Object.keys(lists)) {
      const byBuild = BUILDS.map(() => []);
      for (const s of lists[key]) byBuild[s.build].push(s);
      for (let b = 0; b < BUILDS.length; b++) {
        if (!byBuild[b].length) continue;
        crowdMesh(figureGeo(POSE[key], BUILDS[b]), byBuild[b], `props_crowd_${key}_${b}`, true);
      }
    }
  }

  // spectators' bikes: one instanced mesh, per-instance frame colour
  if (bikeSpots.length) {
    const parts = [];
    const wheelR = 0.255;
    for (const wz of [-0.525, 0.525]) {
      parts.push(strip(place(new THREE.TorusGeometry(wheelR, 0.032, 5, 14), 0, wheelR, wz, 0, 0, Math.PI * 0.5)));
      parts.push(strip(place(cyl(0.030, 0.030, 0.075, 6), 0, wheelR, wz, 0, 0, Math.PI * 0.5)));
      for (let k = 0; k < 3; k++) {
        parts.push(strip(place(cyl(0.006, 0.006, wheelR * 1.9, 4), 0, wheelR, wz, 0, k * 1.05, 0)));
      }
    }
    // frame: down tube, top tube, seat tube, chainstay, fork, bars, seat
    parts.push(strip(place(cyl(0.021, 0.021, 0.62, 5), 0, 0.44, 0.10, 0, 0, 1.30)));
    parts.push(strip(place(cyl(0.021, 0.021, 0.56, 5), 0, 0.68, 0.06, 0, 0, 1.44)));
    parts.push(strip(place(cyl(0.020, 0.020, 0.32, 5), 0, 0.60, -0.20, 0, 0, 0.24)));
    parts.push(strip(place(cyl(0.016, 0.016, 0.56, 5), 0, 0.32, -0.28, 0, 0, 1.50)));
    parts.push(strip(place(cyl(0.018, 0.018, 0.60, 5), 0, 0.56, 0.44, 0, 0, -0.22)));
    parts.push(strip(place(cyl(0.018, 0.018, 0.52, 5), 0, 0.98, 0.40, 0, 0, Math.PI * 0.5)));
    parts.push(strip(place(box(0.06, 0.05, 0.24), 0, 0.80, -0.30)));
    const geo = mergeGeometries(parts, false);
    for (const g of parts) g.dispose();
    const bikeMat = own(new THREE.MeshStandardMaterial({
      name: 'props_crowd_bike', color: 0xffffff, roughness: 0.42, metalness: 0.8, envMapIntensity: 1.1,
    }));
    const bikes = new THREE.InstancedMesh(geo, bikeMat, bikeSpots.length);
    bikes.name = 'props_crowd_bikes';
    bikes.castShadow = true;
    bikes.receiveShadow = false;
    const FRAMES = [0x1a1c20, 0x8c2f2a, 0x2a5b8c, 0xc8a02a, 0x2f6f4a, 0xb0b4b8, 0x6a3a7a];
    for (let i = 0; i < bikeSpots.length; i++) {
      const s = bikeSpots[i];
      // parked bikes lean over on their pedal
      _euler.set(0, s.ry, rand(0.18, 0.34) * (rng() < 0.5 ? -1 : 1), 'YXZ');
      _quat.setFromEuler(_euler);
      _pos.set(s.x, 0.03, s.z);
      _scl.setScalar(rand(0.96, 1.04));
      _m4.compose(_pos, _quat, _scl);
      bikes.setMatrixAt(i, _m4);
      bikes.setColorAt(i, _col.setHex(pick(FRAMES), THREE.SRGBColorSpace));
    }
    bikes.instanceMatrix.needsUpdate = true;
    if (bikes.instanceColor) bikes.instanceColor.needsUpdate = true;
    group.add(bikes);
    owned.geo.push(geo);
  }

  // =========================================================================
  // 8. planting beyond the fence — instanced trunks + cross-quad foliage
  // =========================================================================
  const barkMat = libMat('wood', { color: 0x6b5b46, roughness: 0.98 }, { color: 0x6b5b46, roughness: 0.98 });

  function trunkGeo(height, baseR) {
    const parts = [];
    const segs = 5;
    for (let i = 0; i < segs; i++) {
      const t0 = i / segs, t1 = (i + 1) / segs;
      const r0 = baseR * (1 - t0 * 0.72), r1 = baseR * (1 - t1 * 0.72);
      const h = height / segs;
      const bend = Math.sin(t0 * 2.2) * 0.10 * height * 0.1;
      parts.push(place(cyl(r1, r0, h, 7), bend, height * (t0 + t1) * 0.5, bend * 0.6, 0, 0, -0.03 + t0 * 0.05));
    }
    // three branch stubs so the silhouette is not a bare pole
    for (let i = 0; i < 3; i++) {
      const a = i * 2.1 + 0.6;
      const y = height * (0.55 + i * 0.13);
      parts.push(place(cyl(baseR * 0.16, baseR * 0.3, height * 0.30, 5),
        Math.cos(a) * height * 0.09, y, Math.sin(a) * height * 0.09, a, 0, -0.75));
    }
    // root flare
    parts.push(place(cyl(baseR * 1.05, baseR * 1.5, 0.22, 8), 0, 0.11, 0));
    const g = mergeGeometries(parts.map(strip), false);
    for (const p of parts) p.dispose();
    return g;
  }

  /** Cross-quad leaf cluster; `row` 0 = canopy (top half of the atlas), 1 = shrub. */
  function leafCluster(count, radius, height, row, quadSize) {
    const parts = [];
    for (let i = 0; i < count; i++) {
      const a = rand(0, TAU);
      const r = Math.pow(rng(), 0.6) * radius;
      const y = height * (0.35 + Math.pow(rng(), 0.8) * 0.65);
      const s = quadSize * rand(0.78, 1.25);
      const q = new THREE.PlaneGeometry(s, s * rand(0.62, 0.85));
      const uv = q.attributes.uv;
      const v0 = row === 0 ? 0.5 : 0.0;
      for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k), v0 + uv.getY(k) * 0.5);
      place(q, Math.cos(a) * r, y, Math.sin(a) * r, rand(0, TAU), rand(-0.5, 0.5), rand(-0.4, 0.4));
      parts.push(strip(q));
    }
    const g = mergeGeometries(parts, false);
    for (const p of parts) p.dispose();
    // wind weight rises with height so the crown moves and the base does not
    const p = g.attributes.position;
    const wind = new Float32Array(p.count);
    for (let i = 0; i < p.count; i++) wind[i] = clamp(p.getY(i) / Math.max(0.5, height), 0, 1.4);
    g.setAttribute('aWind', new THREE.BufferAttribute(wind, 1));
    return g;
  }

  function scatterOutside(n, minGap, maxGap, out) {
    let guard = 0;
    while (out.length < n && guard++ < n * 40) {
      const a = rand(0, TAU);
      const rr = rand(minGap, maxGap);
      const x = Math.cos(a) * (LOT.hx + rr);
      const z = Math.sin(a) * (LOT.hz + rr);
      if (Math.abs(x) < LOT.hx + 1.6 && Math.abs(z) < LOT.hz + 1.6) continue;
      // leave the street corner by the gate clear for the parked vehicles
      if (z > LOT.hz && x > GATE.centre - 8 && x < GATE.centre + 8) continue;
      out.push({ x, z });
    }
    return out;
  }

  {
    const spots = scatterOutside(44, 2.5, 38, []);
    const trunk = trunkGeo(5.2, 0.20);
    const trunks = new THREE.InstancedMesh(trunk, barkMat, spots.length);
    trunks.name = 'props_tree_trunks';
    trunks.castShadow = false;
    trunks.receiveShadow = false;

    const canopyA = leafCluster(9, 1.9, 3.1, 0, 3.1);
    const canopyB = leafCluster(7, 1.4, 2.2, 0, 2.4);
    const listA = [], listB = [];
    for (let i = 0; i < spots.length; i++) (i % 3 === 2 ? listB : listA).push(spots[i]);

    for (let i = 0; i < spots.length; i++) {
      const s = spots[i];
      const scale = rand(0.75, 1.35);
      _euler.set(0, rand(0, TAU), 0, 'YXZ');
      _quat.setFromEuler(_euler);
      _pos.set(s.x, 0, s.z);
      _scl.set(scale, scale * rand(0.9, 1.2), scale);
      _m4.compose(_pos, _quat, _scl);
      trunks.setMatrixAt(i, _m4);
      s.scale = scale * rand(0.9, 1.15);
      s.trunkTop = 3.4 * scale;
    }
    trunks.instanceMatrix.needsUpdate = true;
    group.add(trunks);
    owned.geo.push(trunk);

    const mkCanopy = (geo, list, name) => {
      const mesh = new THREE.InstancedMesh(geo, foliageMat, list.length);
      mesh.name = name;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        _euler.set(0, rand(0, TAU), 0, 'YXZ');
        _quat.setFromEuler(_euler);
        _pos.set(s.x, s.trunkTop * 0.62, s.z);
        _scl.setScalar(s.scale);
        _m4.compose(_pos, _quat, _scl);
        mesh.setMatrixAt(i, _m4);
      }
      mesh.instanceMatrix.needsUpdate = true;
      group.add(mesh);
      owned.geo.push(geo);
      return mesh;
    };
    mkCanopy(canopyA, listA, 'props_canopy_a');
    mkCanopy(canopyB, listB, 'props_canopy_b');

    // shrubs hugging the fence line, plus a few inside by the bleachers
    const shrubSpots = scatterOutside(46, 0.9, 11, []);
    for (let i = 0; i < 6; i++) {
      shrubSpots.push({ x: BLEACH.x - 5.4 + rand(-0.6, 0.6), z: rand(-11, 11) });
    }
    const shrubGeo = leafCluster(6, 0.85, 1.15, 1, 1.5);
    const shrubs = new THREE.InstancedMesh(shrubGeo, foliageMat, shrubSpots.length);
    shrubs.name = 'props_shrubs';
    shrubs.castShadow = false;
    shrubs.receiveShadow = false;
    for (let i = 0; i < shrubSpots.length; i++) {
      const s = shrubSpots[i];
      _euler.set(0, rand(0, TAU), 0, 'YXZ');
      _quat.setFromEuler(_euler);
      _pos.set(s.x, 0, s.z);
      const sc = rand(0.7, 1.4);
      _scl.set(sc, sc * rand(0.8, 1.15), sc);
      _m4.compose(_pos, _quat, _scl);
      shrubs.setMatrixAt(i, _m4);
    }
    shrubs.instanceMatrix.needsUpdate = true;
    group.add(shrubs);
    owned.geo.push(shrubGeo);
  }

  // --- palms along the street beyond the fence -------------------------------
  // Two instanced meshes (trunks + crowns) for the whole avenue. They read as
  // the reference's palm line: tall bare stems with the crown well clear of the
  // fence, so the skyline behind them still shows through.
  {
    const palmBark = libMat('wood', { color: 0xc0b19a, roughness: 0.96 }, { color: 0xc0b19a, roughness: 0.96 });

    /** Curved, ringed palm stem, 1 m tall at unit scale. */
    function palmTrunk() {
      const parts = [];
      const segs = 8;
      for (let i = 0; i < segs; i++) {
        const t0 = i / segs, t1 = (i + 1) / segs;
        const r0 = lerp(0.042, 0.024, t0), r1 = lerp(0.042, 0.024, t1);
        const bend = 0.11;
        parts.push(place(cyl(r1, r0, 1 / segs + 0.006, 7),
          Math.pow(t0, 2) * bend, (t0 + t1) * 0.5, 0, 0, 0, -0.10 * t0));
        // leaf-scar ring
        if (i % 2 === 0) {
          parts.push(place(cyl(r0 * 1.16, r0 * 1.16, 0.012, 7), Math.pow(t0, 2) * bend, t0 + 0.03, 0));
        }
      }
      parts.push(place(cyl(0.055, 0.078, 0.10, 8), 0, 0.05, 0));       // root swell
      const merged = mergeGeometries(parts.map(strip), false);
      for (const p of parts) p.dispose();
      return merged;
    }

    /**
     * Crown of fronds. Each frond is two half-quads folded up along the rachis
     * into a shallow V, so the crown keeps a silhouette from every angle rather
     * than vanishing edge-on like a flat card would.
     */
    function palmCrown() {
      const parts = [];
      const N = 12;
      for (let i = 0; i < N; i++) {
        const a = (i / N) * TAU + rand(-0.15, 0.15);
        const dead = i >= N - 2;
        const droop = dead ? rand(1.25, 1.55)
          : lerp(0.10, 1.05, Math.pow((i + rand(0, 0.6)) / N, 0.75));
        const len = rand(2.5, 3.4) * (dead ? 0.82 : 1);
        for (const sign of [-1, 1]) {
          const q = new THREE.PlaneGeometry(len, len * 0.25);
          q.translate(len * 0.5, sign * len * 0.125, 0);
          const uv = q.attributes.uv;
          for (let k = 0; k < uv.count; k++) {
            uv.setXY(k, uv.getX(k), sign > 0 ? 0.5 + uv.getY(k) * 0.5 : uv.getY(k) * 0.5);
          }
          q.rotateX(-Math.PI * 0.5);          // lie flat, face up
          q.rotateX(sign * 0.40);             // fold the half up along the rachis
          place(q, 0, 0, 0, a, 0, -droop);
          const p2 = q.attributes.position;
          const wind = new Float32Array(p2.count);
          for (let k = 0; k < p2.count; k++) {
            wind[k] = clamp(Math.hypot(p2.getX(k), p2.getZ(k)) / len, 0, 1) * 1.35;
          }
          q.setAttribute('aWind', new THREE.BufferAttribute(wind, 1));
          parts.push(strip(q));
        }
      }
      const merged = mergeGeometries(parts, false);
      for (const p of parts) p.dispose();
      return merged;
    }

    // an avenue just outside the fence, plus a scattered back row
    const palms = [];
    for (let i = 0; i < 26; i++) {
      const a = ((i + rand(-0.28, 0.28)) / 26) * TAU;
      const p = outsideLot(a, rand(2.6, 7.5));
      // keep the gate approach and the parked vehicles clear
      if (p.z > LOT.hz && p.x > GATE.centre - 10 && p.x < GATE.centre + 10) continue;
      palms.push({ x: p.x, z: p.z, h: rand(7.5, 13.0), ry: rand(0, TAU) });
    }
    for (let i = 0; i < 18; i++) {
      const p = outsideLot(rand(0, TAU), rand(12, 46));
      palms.push({ x: p.x, z: p.z, h: rand(8, 15.5), ry: rand(0, TAU) });
    }

    const tGeo = palmTrunk(), cGeo = palmCrown();
    const tMesh = new THREE.InstancedMesh(tGeo, palmBark, palms.length);
    const cMesh = new THREE.InstancedMesh(cGeo, palmMat, palms.length);
    tMesh.name = 'props_palm_trunks';
    cMesh.name = 'props_palm_crowns';
    tMesh.castShadow = cMesh.castShadow = false;
    tMesh.receiveShadow = cMesh.receiveShadow = false;
    for (let i = 0; i < palms.length; i++) {
      const p = palms[i];
      _euler.set(0, p.ry, 0, 'YXZ');
      _quat.setFromEuler(_euler);
      _pos.set(p.x, 0, p.z);
      _scl.set(p.h * 0.92, p.h, p.h * 0.92);
      _m4.compose(_pos, _quat, _scl);
      tMesh.setMatrixAt(i, _m4);
      // the crown sits on top of the stem and does not inherit its stretch
      const cs = lerp(0.80, 1.28, clamp((p.h - 7) / 8, 0, 1));
      const bend = p.h * 0.092;
      _euler.set(0, p.ry + rand(0, TAU), 0, 'YXZ');
      _quat.setFromEuler(_euler);
      _pos.set(p.x + Math.cos(p.ry) * bend, p.h * 0.985, p.z - Math.sin(p.ry) * bend);
      _scl.set(cs, cs, cs);
      _m4.compose(_pos, _quat, _scl);
      cMesh.setMatrixAt(i, _m4);
    }
    tMesh.instanceMatrix.needsUpdate = true;
    cMesh.instanceMatrix.needsUpdate = true;
    group.add(tMesh);
    group.add(cMesh);
    owned.geo.push(tGeo, cGeo);
  }

  // =========================================================================
  // 9. ground scatter: dust, tyre marks, litter, weeds in the cracks
  // =========================================================================
  function instancedDecal(geo, material, spots, name, yaw = true) {
    const mesh = new THREE.InstancedMesh(geo, material, spots.length);
    mesh.name = name;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    for (let i = 0; i < spots.length; i++) {
      const s = spots[i];
      _euler.set(-Math.PI * 0.5, 0, yaw ? s.r : 0, 'YXZ');
      _quat.setFromEuler(_euler);
      _pos.set(s.x, s.y ?? 0.014, s.z);
      _scl.set(s.sx ?? 1, s.sz ?? s.sx ?? 1, 1);
      _m4.compose(_pos, _quat, _scl);
      mesh.setMatrixAt(i, _m4);
    }
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);
    owned.geo.push(geo);
    return mesh;
  }

  /** Random spot in the ring between the park core and the fence. */
  function ringSpot(inner, outer) {
    const a = rand(0, TAU);
    const t = rand(inner, outer);
    return {
      x: clamp(Math.cos(a) * t, -LOT.hx + 1.5, LOT.hx - 1.5),
      z: clamp(Math.sin(a) * t, -LOT.hz + 1.5, LOT.hz - 1.5),
    };
  }

  {
    const dustSpots = [];
    for (let i = 0; i < 30; i++) {
      const p = ringSpot(20, 38);
      dustSpots.push({ x: p.x, z: p.z, r: rand(0, TAU), sx: rand(2.2, 6.5), sz: rand(2.0, 5.5), y: 0.012 });
    }
    instancedDecal(new THREE.PlaneGeometry(1, 1), dustMat, dustSpots, 'props_dust');

    const skidSpots = [];
    for (let i = 0; i < 16; i++) {
      const p = ringSpot(16, 34);
      skidSpots.push({ x: p.x, z: p.z, r: rand(0, TAU), sx: rand(0.28, 0.5), sz: rand(1.8, 5.0), y: 0.016 });
    }
    // a pair of long marks by the gate where vans pull in
    for (let i = 0; i < 4; i++) {
      skidSpots.push({
        x: GATE.centre - 4 + i * 0.9, z: LOT.hz - 9 + rand(-1, 1),
        r: rand(-0.15, 0.15), sx: 0.34, sz: rand(5, 9), y: 0.017,
      });
    }
    instancedDecal(new THREE.PlaneGeometry(1, 1), skidMat, skidSpots, 'props_skids');

    // litter quads with a per-instance atlas cell
    const litterSpots = [];
    for (let i = 0; i < 44; i++) {
      const p = ringSpot(18, 40);
      litterSpots.push({ x: p.x, z: p.z, r: rand(0, TAU), s: rand(0.55, 1.15) });
    }
    // spill from the knocked-over bin
    for (let i = 0; i < 10; i++) {
      litterSpots.push({
        x: LOT.hx - 9.2 + rand(-1.6, 1.8), z: 10.6 + rand(-1.4, 1.6),
        r: rand(0, TAU), s: rand(0.6, 1.1),
      });
    }
    const litterGeo = new THREE.PlaneGeometry(0.36, 0.36);
    const litter = new THREE.InstancedMesh(litterGeo, litterMat, litterSpots.length);
    litter.name = 'props_litter';
    litter.castShadow = false;
    litter.receiveShadow = true;
    const cells = new Float32Array(litterSpots.length * 2);
    for (let i = 0; i < litterSpots.length; i++) {
      const s = litterSpots[i];
      const flat = rng() < 0.75;
      _euler.set(flat ? -Math.PI * 0.5 + rand(-0.25, 0.25) : rand(-0.6, 0.6), s.r, rand(-0.4, 0.4), 'YXZ');
      _quat.setFromEuler(_euler);
      _pos.set(s.x, flat ? 0.018 : rand(0.05, 0.14), s.z);
      _scl.setScalar(s.s);
      _m4.compose(_pos, _quat, _scl);
      litter.setMatrixAt(i, _m4);
      cells[i * 2] = randInt(0, 1) * 0.5;
      cells[i * 2 + 1] = randInt(0, 1) * 0.5;
    }
    litterGeo.setAttribute('aCell', new THREE.InstancedBufferAttribute(cells, 2));
    litter.instanceMatrix.needsUpdate = true;
    group.add(litter);
    owned.geo.push(litterGeo);

    // weeds: two crossed quads, wind-animated, clustered along the fence cracks
    const q1 = new THREE.PlaneGeometry(0.55, 0.55);
    q1.translate(0, 0.275, 0);
    const q2 = q1.clone();
    q2.rotateY(Math.PI * 0.5);
    const weedGeo = mergeGeometries([strip(q1), strip(q2)], false);
    q1.dispose(); q2.dispose();
    const wp = weedGeo.attributes.position;
    const wWind = new Float32Array(wp.count);
    for (let i = 0; i < wp.count; i++) wWind[i] = clamp(wp.getY(i) / 0.55, 0, 1);
    weedGeo.setAttribute('aWind', new THREE.BufferAttribute(wWind, 1));

    const weedSpots = [];
    for (const run of RUNS) {
      const dx = run.bx - run.ax, dz = run.bz - run.az;
      const len = Math.hypot(dx, dz);
      const ux = dx / len, uz = dz / len;
      const n = Math.round(len * 0.9);
      for (let i = 0; i < n; i++) {
        const s = rand(0, len);
        const inward = rand(0.05, 0.7) * (rng() < 0.5 ? 1 : -1);
        weedSpots.push({
          x: run.ax + ux * s - uz * inward,
          z: run.az + uz * s + ux * inward,
          s: rand(0.55, 1.5),
        });
      }
    }
    for (let i = 0; i < 40; i++) {
      const p = ringSpot(22, 40);
      weedSpots.push({ x: p.x, z: p.z, s: rand(0.4, 1.0) });
    }
    const weeds = new THREE.InstancedMesh(weedGeo, weedMat, weedSpots.length);
    weeds.name = 'props_weeds';
    weeds.castShadow = false;
    weeds.receiveShadow = false;
    for (let i = 0; i < weedSpots.length; i++) {
      const s = weedSpots[i];
      _euler.set(0, rand(0, TAU), 0, 'YXZ');
      _quat.setFromEuler(_euler);
      _pos.set(s.x, 0.005, s.z);
      _scl.set(s.s, s.s * rand(0.7, 1.5), s.s);
      _m4.compose(_pos, _quat, _scl);
      weeds.setMatrixAt(i, _m4);
    }
    weeds.instanceMatrix.needsUpdate = true;
    group.add(weeds);
    owned.geo.push(weedGeo);
  }

  // =========================================================================
  // 10. city backdrop: four depth bands, an elevated freeway, cranes, masts
  // =========================================================================
  // Nothing here casts a shadow and nothing here is closer than the fence line.
  // Depth is carried by `aHaze`: each piece is blended toward the live horizon
  // colour in linear space, so the far band lifts and desaturates into the air
  // instead of sitting on the sky as a cut-out.
  const skyline = new THREE.Group();
  skyline.name = 'props_skyline';
  group.add(skyline);

  const VIA = { z: -118, x0: -340, x1: 340, deckY: 14.0, w: 17 };

  {
    const facadeGeos = { curtain: [], punched: [], brick: [] };
    const trimGeos = [], darkGeos = [], boardGeos = [];
    const roofSlots = [];              // { x, z, y, a, w, d, band } for tanks/boards

    /** Tag a backdrop geometry with its colour and its aerial-perspective weight. */
    function hazed(g, tint, haze, jitter = 0.03) {
      tintGeo(g, tint, jitter);
      const p = g.attributes.position;
      const arr = new Float32Array(p.count);
      for (let i = 0; i < p.count; i++) {
        // the bases of the city sit deeper in the haze than the tops
        arr[i] = clamp(haze + (1 - clamp(p.getY(i) / 55, 0, 1)) * 0.045, 0, 0.86);
      }
      g.setAttribute('aHaze', new THREE.BufferAttribute(arr, 1));
      return strip(g);
    }
    const trim = (g, tint, haze, j) => { trimGeos.push(hazed(g, tint, haze, j)); };
    const dark = (g, tint, haze, j) => { darkGeos.push(hazed(g, tint, haze, j)); };

    /**
     * A facade mass. UVs arrive in metres from `box`; per building we rescale
     * them (window pitch), lift them so v = 0 lands on the pavement, and slide
     * them along, so no two neighbours show the same pattern of lit windows.
     */
    function facadeBox(kind, w, h, d, x, y, z, ry, tint, haze, uvS, uvO) {
      const g = box(w, h, d);
      const uv = g.attributes.uv;
      for (let i = 0; i < uv.count; i++) {
        uv.setXY(i, uv.getX(i) * uvS + uvO[0], (uv.getY(i) + h * 0.5) * uvS + uvO[1]);
      }
      place(g, x, y, z, ry);
      facadeGeos[kind].push(hazed(g, tint, haze));
    }

    const BASE_TINTS = [0xa89e8e, 0xb5aa97, 0x968f85, 0xbcae92, 0x8d929a, 0xa19786,
      0xbcb29e, 0x7d828a, 0xa5977f, 0x8d939d, 0xc0b299, 0x757b85];
    const NEUTRAL = new THREE.Color().setHex(0xa4a6a6, THREE.SRGBColorSpace);
    const _t = new THREE.Color();
    /** Desaturate toward the horizon and lift the value with distance. */
    function bandTint(B) {
      _t.setHex(pick(BASE_TINTS), THREE.SRGBColorSpace);
      _t.lerp(NEUTRAL, 1 - B.sat).multiplyScalar(B.val);
      return _t.getHex(THREE.SRGBColorSpace);
    }
    const trimTint = (B) => {
      _t.setHex(0xbab3a4, THREE.SRGBColorSpace);
      _t.lerp(NEUTRAL, 1 - B.sat).multiplyScalar(B.val);
      return _t.getHex(THREE.SRGBColorSpace);
    };

    const BANDS = [
      { // 0 — sprawl right outside the fence: lock-ups, workshops, a depot
        count: 48, ell: true, gap: [9, 62], h: [3.2, 9.5], foot: [8, 30],
        haze: [0.05, 0.12], sat: 1.00, val: 0.96,
        kinds: ['brick', 'punched', 'brick'], setbacks: 0, roof: 2, tall: 0.0,
      },
      { // 1 — near mid-rise: the first real street wall
        count: 42, r: [110, 178], h: [11, 36], foot: [15, 40],
        haze: [0.11, 0.22], sat: 0.90, val: 1.10,
        kinds: ['punched', 'brick', 'curtain'], setbacks: 1, roof: 3, tall: 0.30,
      },
      { // 2 — downtown blocks
        count: 48, r: [188, 308], h: [26, 90], foot: [18, 48],
        haze: [0.26, 0.42], sat: 0.72, val: 1.14,
        kinds: ['punched', 'curtain', 'curtain'], setbacks: 2, roof: 3, tall: 0.55,
      },
      { // 3 — towers beyond downtown, almost pure air
        count: 42, r: [325, 565], h: [45, 175], foot: [22, 58],
        haze: [0.44, 0.66], sat: 0.46, val: 0.99,
        kinds: ['curtain', 'curtain', 'punched'], setbacks: 2, roof: 2, tall: 0.85,
      },
    ];

    for (let bi = 0; bi < BANDS.length; bi++) {
      const B = BANDS[bi];
      for (let i = 0; i < B.count; i++) {
        const a = ((i + rand(-0.36, 0.36)) / B.count) * TAU;
        let x, z, t;
        if (B.ell) {
          const gap = rand(B.gap[0], B.gap[1]);
          t = (gap - B.gap[0]) / (B.gap[1] - B.gap[0]);
          const p = outsideLot(a, gap, 4, 4);
          x = p.x; z = p.z;
        } else {
          t = Math.pow(rng(), 0.85);
          const r = lerp(B.r[0], B.r[1], t);
          x = Math.cos(a) * r;
          z = Math.sin(a) * r;
        }
        // keep the freeway deck itself clear — but only the deck. The old
        // 48 m-wide exclusion emptied the entire mid-distance in the primary
        // view direction, which is what left the downtown blocks reading as
        // slabs hanging over nothing.
        if (Math.abs(z - VIA.z) < 14 && x > VIA.x0 - 14 && x < VIA.x1 + 14) continue;
        if (z > LOT.hz && Math.abs(x - GATE.centre) < 13 && bi === 0) continue;

        // buildings follow a street grid, and the grid turns between districts
        const sector = (((a % TAU) + TAU) % TAU) / (TAU / 4) | 0;
        const ry = [0.10, 0.63, -0.40, 1.19][sector]
          + (rng() < 0.5 ? 0 : Math.PI * 0.5) + rand(-0.05, 0.05);

        const w = rand(B.foot[0], B.foot[1]);
        const d = rand(B.foot[0], B.foot[1]) * rand(0.55, 1.0);
        const h = lerp(B.h[0], B.h[1], Math.pow(rng(), lerp(2.3, 1.05, B.tall)));
        const haze = lerp(B.haze[0], B.haze[1], t);
        const kind = pick(B.kinds);
        const tint = bandTint(B);
        const tt = trimTint(B);
        const uvS = rand(0.80, 1.30);
        const uvO = [rand(0, FACADE_M), randInt(0, 3) * (FACADE_M * 0.25)];
        const co = Math.cos(ry), si = Math.sin(ry);

        facadeBox(kind, w, h, d, x, h * 0.5, z, ry, tint, haze, uvS, uvO);

        // a lower wing or podium pushed off to one side — varied footprints
        if (rng() < 0.48) {
          const pw = w * rand(0.40, 0.95), pd = d * rand(0.55, 1.10);
          const ph = Math.max(3.2, h * rand(0.20, 0.55));
          const ox = w * 0.5 + pw * 0.5 - rand(0.5, w * 0.22);
          const px = x + co * ox, pz = z - si * ox;
          facadeBox(kind, pw, ph, pd, px, ph * 0.5, pz, ry, tint, haze, uvS, uvO);
          trim(place(box(pw + 0.7, 0.6, pd + 0.7), px, ph + 0.30, pz, ry), tt, haze, 0.02);
        }

        // setbacks
        let sh = h, sw = w, sd = d;
        for (let k = 0; k < B.setbacks; k++) {
          if (rng() > 0.55) break;
          sw *= rand(0.58, 0.84); sd *= rand(0.58, 0.84);
          const add = rand(0.14, 0.45) * h;
          facadeBox(kind, sw, add, sd, x, sh + add * 0.5, z, ry, tint, haze, uvS, uvO);
          trim(place(box(sw + 1.3, 0.7, sd + 1.3), x, sh + 0.35, z, ry), tt, haze, 0.02);
          sh += add;
        }

        // parapet — a hard, lit edge is what separates one roofline from the next
        const pt = Math.max(0.7, Math.min(1.5, h * 0.035));
        trim(place(box(sw + 0.9, pt, sd + 0.9), x, sh + pt * 0.5, z, ry), tt, haze, 0.02);
        trim(place(box(sw + 1.5, 0.28, sd + 1.5), x, sh + pt, z, ry), tt, haze * 0.9, 0.02);

        // rooftop clutter: a stair/lift bulkhead, plant, aerials
        const bwd = clamp(Math.min(sw, sd) * rand(0.24, 0.42), 2.2, 9);
        const bh = rand(2.4, 5.2);
        const bx = x + co * rand(-sw * 0.22, sw * 0.22) + si * rand(-sd * 0.22, sd * 0.22);
        const bz = z - si * rand(-sw * 0.22, sw * 0.22) + co * rand(-sd * 0.22, sd * 0.22);
        trim(place(box(bwd, bh, bwd * rand(0.75, 1.4)), bx, sh + bh * 0.5, bz, ry), tt, haze, 0.02);
        dark(place(box(bwd + 0.5, 0.22, bwd * 1.1), bx, sh + bh + 0.11, bz, ry), 0x6c7076, haze, 0.05);
        const plant = randInt(1, B.roof);
        for (let k = 0; k < plant; k++) {
          const cw = rand(1.5, 4.4), ch = rand(0.9, 2.6);
          dark(place(box(cw, ch, cw * rand(0.7, 1.35)),
            x + rand(-sw * 0.38, sw * 0.38), sh + ch * 0.5, z + rand(-sd * 0.38, sd * 0.38), ry),
            pick([0x6a6f75, 0x7b7f83, 0x5c6167]), haze, 0.05);
        }
        if (rng() < 0.4) {
          const mh = rand(5, 20) * (0.55 + B.tall);
          const mx = x + rand(-sw * 0.3, sw * 0.3), mz = z + rand(-sd * 0.3, sd * 0.3);
          dark(place(cyl(0.13, 0.30, mh, 4), mx, sh + mh * 0.5, mz), 0x565b62, haze, 0.05);
          for (let k = 0; k < 3; k++) {
            dark(place(box(rand(0.8, 2.0), 0.12, 0.12), mx, sh + mh * (0.55 + k * 0.14), mz, rand(0, TAU)),
              0x565b62, haze, 0.05);
          }
        }
        if (rng() < 0.26) roofSlots.push({ x, z, y: sh + pt, a: ry, w: sw, d: sd, band: bi, haze });
      }
    }

    // --- mid-distance street wall ---------------------------------------------
    // Four concentric rows of low blocks between the fence line and downtown.
    // Without them the eye jumps straight from the treeline to a 60 m tower
    // base with nothing but flat horizon colour in between, and the whole
    // skyline detaches. Each row is a near-continuous wall with occasional
    // street gaps, and the heights climb from just over the treetops to a bit
    // over half a downtown tower so the silhouette steps down to the horizon.
    {
      const MIDROWS = [
        { gap: [17, 33], h: [6.5, 12], foot: [12, 26], step: 21, haze: [0.05, 0.09], kinds: ['brick', 'punched'] },
        { gap: [46, 70], h: [10, 18], foot: [15, 32], step: 24, haze: [0.09, 0.14], kinds: ['punched', 'brick'] },
        { gap: [88, 122], h: [15, 27], foot: [17, 38], step: 27, haze: [0.14, 0.20], kinds: ['punched', 'curtain', 'brick'] },
        { gap: [132, 176], h: [21, 42], foot: [19, 42], step: 30, haze: [0.19, 0.27], kinds: ['curtain', 'punched'] },
      ];
      const MID = { sat: 0.94, val: 1.04 };
      for (let ri = 0; ri < MIDROWS.length; ri++) {
        const R = MIDROWS[ri];
        const mid = (R.gap[0] + R.gap[1]) * 0.5 + 40;
        const count = Math.max(16, Math.round(TAU * mid / R.step));
        for (let i = 0; i < count; i++) {
          if (rng() < 0.17) continue;                       // a street or a lot
          const a = ((i + rand(-0.34, 0.34)) / count) * TAU;
          const gap = rand(R.gap[0], R.gap[1]);
          const p = outsideLot(a, gap, 4, 4);
          const x = p.x, z = p.z;
          if (Math.abs(z - VIA.z) < 13 && x > VIA.x0 - 13 && x < VIA.x1 + 13) continue;
          if (z > LOT.hz && Math.abs(x - GATE.centre) < 13 && ri === 0) continue;

          const sector = (((a % TAU) + TAU) % TAU) / (TAU / 4) | 0;
          const ry = [0.10, 0.63, -0.40, 1.19][sector]
            + (rng() < 0.5 ? 0 : Math.PI * 0.5) + rand(-0.06, 0.06);
          const w = rand(R.foot[0], R.foot[1]);
          const d = rand(R.foot[0], R.foot[1]) * rand(0.6, 1.05);
          const h = lerp(R.h[0], R.h[1], Math.pow(rng(), 1.5));
          const haze = lerp(R.haze[0], R.haze[1], rng());
          const tint = bandTint(MID);
          const tt = trimTint(MID);
          const co = Math.cos(ry), si = Math.sin(ry);
          facadeBox(pick(R.kinds), w, h, d, x, h * 0.5, z, ry, tint, haze,
            rand(0.85, 1.25), [rand(0, FACADE_M), randInt(0, 3) * (FACADE_M * 0.25)]);
          // parapet, so each roofline reads as an edge and not a soft blur
          trim(place(box(w + 0.8, Math.max(0.5, h * 0.045), d + 0.8),
            x, h + Math.max(0.5, h * 0.045) * 0.5, z, ry), tt, haze, 0.02);
          // a lower wing off to one side keeps the wall from being a fence of
          // identical extrusions
          if (rng() < 0.55) {
            const pw = w * rand(0.45, 0.95), pd = d * rand(0.6, 1.05);
            const ph = Math.max(3.0, h * rand(0.30, 0.62));
            const ox = w * 0.5 + pw * 0.5 - rand(0.5, w * 0.25);
            const px = x + co * ox, pz = z - si * ox;
            facadeBox(pick(R.kinds), pw, ph, pd, px, ph * 0.5, pz, ry, tint, haze,
              rand(0.85, 1.25), [rand(0, FACADE_M), randInt(0, 3) * (FACADE_M * 0.25)]);
            trim(place(box(pw + 0.7, 0.55, pd + 0.7), px, ph + 0.28, pz, ry), tt, haze, 0.02);
          }
          // rooftop plant
          if (rng() < 0.55) {
            const cw = rand(1.6, 4.2), ch = rand(1.0, 2.6);
            dark(place(box(cw, ch, cw * rand(0.7, 1.35)),
              x + rand(-w * 0.32, w * 0.32), h + ch * 0.5, z + rand(-d * 0.32, d * 0.32), ry),
              pick([0x6a6f75, 0x7b7f83, 0x5c6167]), haze, 0.05);
          }
          if (ri >= 2 && rng() < 0.22) {
            roofSlots.push({ x, z, y: h + 0.6, a: ry, w, d, band: 1, haze });
          }
        }
      }
    }

    // --- rooftop water tanks --------------------------------------------------
    {
      let made = 0;
      for (const t of roofSlots) {
        if (made >= 9) break;
        if (t.band > 2 || Math.min(t.w, t.d) < 12) continue;
        made++;
        const legH = rand(3.0, 6.0), tr = rand(1.9, 3.2), th = rand(3.6, 6.0);
        for (let k = 0; k < 4; k++) {
          const la = k * Math.PI * 0.5 + 0.78;
          dark(place(box(0.30, legH, 0.30),
            t.x + Math.cos(la) * tr * 0.74, t.y + legH * 0.5, t.z + Math.sin(la) * tr * 0.74),
            0x6e5c46, t.haze, 0.05);
        }
        trim(place(cyl(tr, tr * 1.05, th, 12), t.x, t.y + legH + th * 0.5, t.z), 0x93755a, t.haze, 0.04);
        dark(place(new THREE.ConeGeometry(tr * 1.14, tr * 0.8, 12), t.x, t.y + legH + th + tr * 0.38, t.z),
          0x5f5347, t.haze, 0.05);
        dark(place(cyl(0.06, 0.06, legH, 4), t.x + tr * 0.92, t.y + legH * 0.5, t.z), 0x5f5347, t.haze);
      }
    }

    // --- tower cranes ---------------------------------------------------------
    for (const c of [
      { x: -232, z: -286, h: 82, a: 0.72, hz: 0.70 },
      { x: 268, z: -196, h: 66, a: -1.85, hz: 0.60 },
      { x: 118, z: 262, h: 54, a: 2.35, hz: 0.42 },
    ]) {
      const post = 1.35, YEL = 0xd8a520;
      for (let k = 0; k < 4; k++) {
        const ca = k * Math.PI * 0.5 + 0.78;
        trim(place(box(0.45, c.h, 0.45),
          c.x + Math.cos(ca) * post, c.h * 0.5, c.z + Math.sin(ca) * post), YEL, c.hz, 0.05);
      }
      for (let k = 0; k < 14; k++) {
        trim(place(box(post * 2.3, 0.24, post * 2.3), c.x, (k + 1) * (c.h / 15), c.z), YEL, c.hz, 0.05);
      }
      trim(place(box(4.0, 1.5, 3.0), c.x, c.h + 0.75, c.z, c.a), YEL, c.hz, 0.04);
      // jib and counter-jib as open lattice: chord pairs plus verticals
      for (const dy of [0, 1.5]) {
        trim(place(box(50, 0.28, 0.28), c.x + Math.cos(c.a) * 22, c.h + 2.4 + dy, c.z - Math.sin(c.a) * 22, c.a), YEL, c.hz, 0.05);
        trim(place(box(17, 0.28, 0.28), c.x - Math.cos(c.a) * 9, c.h + 2.4 + dy, c.z + Math.sin(c.a) * 9, c.a), YEL, c.hz, 0.05);
      }
      for (let k = 0; k < 11; k++) {
        const s = 2 + k * 4.4;
        trim(place(box(0.2, 1.6, 0.2), c.x + Math.cos(c.a) * s, c.h + 3.2, c.z - Math.sin(c.a) * s), YEL, c.hz, 0.05);
      }
      trim(place(box(4.2, 2.0, 2.4), c.x - Math.cos(c.a) * 16, c.h + 2.2, c.z + Math.sin(c.a) * 16, c.a), 0x9c9890, c.hz, 0.04);
      trim(place(box(0.45, 8, 0.45), c.x, c.h + 6.5, c.z), YEL, c.hz, 0.05);
      const hookX = c.x + Math.cos(c.a) * 32, hookZ = c.z - Math.sin(c.a) * 32;
      dark(place(cyl(0.08, 0.08, 24, 4), hookX, c.h - 9, hookZ), 0x3f444a, c.hz);
      dark(place(box(1.3, 1.1, 0.9), hookX, c.h - 21.6, hookZ, c.a), 0x3f444a, c.hz);
    }

    // --- elevated freeway -----------------------------------------------------
    {
      const dY = VIA.deckY, W = VIA.w, len = VIA.x1 - VIA.x0;
      const cx = (VIA.x0 + VIA.x1) * 0.5, vz = VIA.z;
      const hz = 0.22;
      trim(place(box(len, 1.15, W), cx, dY, vz), 0xada89c, hz, 0.02);
      trim(place(box(len, 1.0, W - 5.0), cx, dY - 0.95, vz), 0x6e6a63, hz, 0.02);
      dark(place(box(len, 0.34, W + 0.25), cx, dY - 0.62, vz), 0x3c3a36, hz, 0.02);
      for (const s of [-1, 1]) {
        trim(place(box(len, 0.92, 0.5), cx, dY + 1.04, vz + s * (W * 0.5 - 0.28)), 0xbfbaae, hz, 0.02);
        dark(place(box(len, 0.10, 0.14), cx, dY + 1.54, vz + s * (W * 0.5 - 0.28)), 0x6e737a, hz);
      }
      trim(place(box(len, 0.72, 0.45), cx, dY + 0.94, vz), 0xb6b1a6, hz, 0.02);
      for (let px = VIA.x0 + 14; px < VIA.x1; px += 27) {
        trim(place(box(2.8, dY - 0.9, 2.3), px, (dY - 0.9) * 0.5, vz), 0x9e9a90, hz, 0.02);
        trim(place(box(4.6, 1.0, W - 2.6), px, dY - 1.1, vz), 0xa8a49a, hz, 0.02);
        trim(place(box(4.8, 0.55, 4.4), px, 0.28, vz), 0x8d8981, hz, 0.02);
      }
      for (let px = VIA.x0 + 28; px < VIA.x1; px += 54) {
        dark(place(cyl(0.13, 0.22, 9.5, 6), px, dY + 6.6, vz + W * 0.5 - 0.4), 0x5e636a, hz);
        dark(place(box(2.1, 0.16, 0.28), px - 0.95, dY + 11.2, vz + W * 0.5 - 0.4), 0x5e636a, hz);
      }
      // a sign gantry spanning the carriageway
      for (const gx of [-96, 118]) {
        dark(place(box(0.4, 7.2, 0.4), gx, dY + 5.4, vz - W * 0.5 + 0.5), 0x5a5f66, hz);
        dark(place(box(0.4, 7.2, 0.4), gx, dY + 5.4, vz + W * 0.5 - 0.5), 0x5a5f66, hz);
        dark(place(box(0.45, 0.45, W), gx, dY + 8.8, vz), 0x5a5f66, hz);
        trim(place(box(0.25, 2.2, 7.0), gx + 0.3, dY + 7.4, vz - 3), 0x2f6b3c, hz, 0.03);
        trim(place(box(0.25, 2.2, 5.4), gx + 0.3, dY + 7.4, vz + 4), 0x2f6b3c, hz, 0.03);
      }
      // traffic, both directions
      const CARS = [0xd8d5cc, 0x2c3138, 0x8f2a24, 0x27486f, 0xb0b4b8, 0x3f5f45, 0xc9a52c];
      for (let k = 0; k < 26; k++) {
        const px = VIA.x0 + 14 + rand(0, len - 28);
        const lane = (k % 2 ? 1 : -1) * rand(2.1, 5.6);
        const truck = rng() < 0.26;
        const cl = pick(CARS);
        const cw = truck ? rand(9, 13.5) : rand(4.1, 5.3);
        const ch = truck ? 3.3 : 1.42;
        const cd = truck ? 2.6 : 1.95;
        dark(place(box(cw, ch, cd), px, dY + 0.58 + ch * 0.5, vz + lane), cl, hz, 0.02);
        if (truck) {
          dark(place(box(2.5, 1.1, cd), px + cw * 0.5 - 1.25, dY + 0.58 + ch + 0.55, vz + lane), cl, hz, 0.02);
        } else {
          dark(place(box(cw * 0.52, 0.86, cd * 0.94), px + rand(-0.4, 0.4), dY + 0.58 + ch + 0.43, vz + lane),
            0x2a3038, hz, 0.02);
        }
      }
      // an off-ramp peeling away and dropping to grade
      {
        const seg = 9;
        for (let k = 0; k < seg; k++) {
          const t0 = k / seg, t1 = (k + 1) / seg;
          const rx = VIA.x1 - 30 + t0 * 96;
          const rz = vz + Math.pow(t0, 1.7) * 74;
          const ry0 = dY - Math.pow(t0, 1.5) * (dY - 0.6);
          const nx = VIA.x1 - 30 + t1 * 96, nz = vz + Math.pow(t1, 1.7) * 74;
          const ang = Math.atan2(-(nz - rz), nx - rx);
          const l = Math.hypot(nx - rx, nz - rz) + 1.5;
          trim(place(box(l, 0.9, 8.5), (rx + nx) * 0.5, ry0, (rz + nz) * 0.5, ang), 0xa8a49a, hz, 0.02);
          trim(place(box(l, 0.9, 0.4), (rx + nx) * 0.5, ry0 + 0.85, (rz + nz) * 0.5 - 4.1, ang), 0xbfbaae, hz, 0.02);
          trim(place(box(l, 0.9, 0.4), (rx + nx) * 0.5, ry0 + 0.85, (rz + nz) * 0.5 + 4.1, ang), 0xbfbaae, hz, 0.02);
          if (k % 2 === 0 && ry0 > 2) {
            trim(place(box(2.2, ry0, 2.0), rx, ry0 * 0.5, rz, ang), 0x9e9a90, hz, 0.02);
          }
        }
      }
    }

    // --- billboards -----------------------------------------------------------
    {
      const cells = [0, 4, 7, 12, 15, 5, 2];
      let n = 0;
      /** One board panel plus its frame. */
      const board = (bw, bh, bx, by, bz, face, haze, cell, legs) => {
        const g = planeCell(bw, bh, 1, 1, cell, ATLAS_COLS, ATLAS_ROWS);
        place(g, bx, by, bz, face);
        boardGeos.push(hazed(g, 0xffffff, haze, 0));
        dark(place(box(bw + 1.4, 0.55, 0.55), bx, by + bh * 0.5 + 0.3, bz, face), 0x4e5359, haze);
        dark(place(box(bw + 1.4, 0.5, 0.5), bx, by - bh * 0.5 - 0.3, bz, face), 0x4e5359, haze);
        for (const s of [-1, 1]) {
          dark(place(box(0.5, bh + 1.4, 0.5),
            bx + Math.cos(face) * s * bw * 0.42, by, bz - Math.sin(face) * s * bw * 0.42, face), 0x4e5359, haze);
        }
        if (legs) {
          for (const s of [-1, 1]) {
            dark(place(cyl(0.42, 0.55, legs, 6),
              bx + Math.cos(face) * s * bw * 0.28, by - bh * 0.5 - legs * 0.5, bz - Math.sin(face) * s * bw * 0.28),
              0x4e5359, haze);
          }
        }
      };

      for (const t of roofSlots) {
        if (n >= 4) break;
        if (t.band < 1 || t.band > 2 || t.w < 18) continue;
        const bw = clamp(t.w * rand(0.8, 1.15), 18, 34), bh = bw * 0.5;
        const face = Math.atan2(-t.x, -t.z) + rand(-0.25, 0.25);
        board(bw, bh, t.x, t.y + bh * 0.5 + 5.5, t.z, face, t.haze, cells[n], 0);
        n++;
      }
      // roadside boards on lattice poles beside the freeway
      board(26, 13, -58, 22, VIA.z + 26, 0.18, 0.36, cells[4], 15);
      board(22, 11, 142, 20, VIA.z + 34, -0.42, 0.34, cells[5], 14);
      board(20, 10, -LOT.hx - 74, 15, 46, Math.PI * 0.62, 0.22, cells[6], 10);
    }

    // --- venue floodlight masts ----------------------------------------------
    // Tall enough to read as event lighting against the sky; outside the fence,
    // so they live in the no-shadow bucket with the rest of the perimeter.
    function venueMast(x, z, aim) {
      const H = 17.5;
      far.add(MAT.concretePale, place(cyl(0.62, 0.80, 0.95, 10), x, 0.47, z));
      far.add(MAT.steelDark, place(cyl(0.15, 0.34, H, 8), x, H * 0.5 + 0.9, z));
      for (let i = 0; i < 7; i++) {
        far.add(MAT.steelDark, place(box(0.44, 0.07, 0.07), x, 2.4 + i * 2.1, z, aim + 0.4));
        far.add(MAT.steelDark, place(box(0.07, 0.07, 0.44), x, 3.4 + i * 2.1, z, aim + 0.4));
      }
      const topY = H + 0.9;
      for (let row = 0; row < 2; row++) {
        far.add(MAT.steelDark, place(box(4.8, 0.16, 0.5), x, topY + row * 1.35, z, aim));
      }
      far.add(MAT.steelDark, place(box(0.16, 1.5, 0.16), x - 2.3 * Math.cos(aim), topY + 0.7, z + 2.3 * Math.sin(aim), aim));
      far.add(MAT.steelDark, place(box(0.16, 1.5, 0.16), x + 2.3 * Math.cos(aim), topY + 0.7, z - 2.3 * Math.sin(aim), aim));
      for (let i = 0; i < 8; i++) {
        const t = ((i >> 1) / 3 - 0.5) * 4.2;
        const row = i & 1;
        const hx = x + Math.cos(aim) * t, hz = z - Math.sin(aim) * t;
        far.add(MAT.steelDark, place(box(0.62, 0.22, 0.48), hx, topY + row * 1.35 + 0.30, hz, aim, -0.62));
        far.add(lampMat, place(box(0.54, 0.04, 0.40), hx, topY + row * 1.35 + 0.17, hz, aim, -0.62));
      }
    }
    venueMast(-LOT.hx - 6.5, -LOT.hz - 6.5, -Math.PI * 0.25);
    venueMast(LOT.hx + 6.5, -LOT.hz - 6.5, Math.PI * 0.25);
    venueMast(LOT.hx + 6.5, LOT.hz + 6.5, Math.PI * 0.75);
    venueMast(-LOT.hx - 6.5, LOT.hz + 6.5, -Math.PI * 0.75);

    // --- flush the backdrop ---------------------------------------------------
    const mkCity = (geos, material, name) => {
      if (!geos.length) return;
      const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
      if (geos.length > 1) for (const g of geos) g.dispose();
      if (!merged) return;
      // Every backdrop mass is authored with its base at y = 0; the plane it
      // stands on is at GROUND_Y. Sinking the whole backdrop onto that plane
      // is what guarantees a tower footprint is occluded by ground rather
      // than ending in a hard edge with sky under it.
      merged.translate(0, GROUND_Y, 0);
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, material);
      mesh.name = name;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      skyline.add(mesh);
      owned.geo.push(merged);
    };
    for (const kind of ['curtain', 'punched', 'brick']) {
      mkCity(facadeGeos[kind], FACADE_MATS[kind], `props_city_${kind}`);
      emissiveNight.push({ material: FACADE_MATS[kind], intensity: 1.55, base: 0.02 });
    }
    mkCity(trimGeos, cityTrimMat, 'props_city_trim');
    mkCity(darkGeos, cityDarkMat, 'props_city_dark');
    mkCity(boardGeos, billboardMat, 'props_billboards');
  }

  // --- the ground the city stands on, and the outermost city -----------------
  {
    // The floor the whole backdrop stands on. It used to be an untextured ring
    // hazed to 0.88 within 300 m, which made it read as a second patch of sky:
    // the towers appeared to hang in air because there was no ground signal
    // under them at all. It now carries an aerial city plan — blocks, roofs,
    // streets, lots — at a 96 m tile, is tessellated finely enough for the
    // mottle to survive, runs all the way out to the far clip so no tower
    // footprint can ever be silhouetted against sky, and its haze ramp tops out
    // well short of full so the ground/sky boundary stays a readable horizon.
    const floorTex = ownTex(makeTex(makeCityFloorTexture(), {
      aniso: Math.max(8, aniso), wrap: THREE.RepeatWrapping,
    }));
    const FLOOR_TILE = 96;
    const farGroundMat = own(patchCityHaze(new THREE.MeshStandardMaterial({
      name: 'props_far_ground', map: floorTex, vertexColors: true,
      roughness: 1, metalness: 0, fog: false, envMapIntensity: 0.55,
    })));
    const FAR_EDGE = 880;                 // inside the 900 m far clip
    const ring = new THREE.RingGeometry(44, FAR_EDGE, 128, 26);
    ring.rotateX(-Math.PI * 0.5);
    ring.translate(0, GROUND_Y, 0);
    {
      const p = ring.attributes.position;
      const uv = ring.attributes.uv;
      const col = new Float32Array(p.count * 3);
      const hz = new Float32Array(p.count);
      const c0 = new THREE.Color();
      for (let i = 0; i < p.count; i++) {
        const px = p.getX(i), pz = p.getZ(i);
        const r = Math.hypot(px, pz);
        const n = noise01(px * 0.012 + 5.5, pz * 0.012 + 1.7, 4);
        const n2 = noise01(px * 0.06, pz * 0.06, 3);
        // roof/asphalt/lot mottle so the sprawl floor is never one flat value
        c0.setHex(n > 0.55 ? 0x8b867b : n > 0.34 ? 0x76726b : 0x9a9384, THREE.SRGBColorSpace);
        c0.multiplyScalar(0.86 + n2 * 0.30);
        col[i * 3] = c0.r; col[i * 3 + 1] = c0.g; col[i * 3 + 2] = c0.b;
        // planar UVs in metres, so the plan reads at a constant scale and does
        // not smear out along the ring's radial quads
        uv.setXY(i, px / FLOOR_TILE, pz / FLOOR_TILE);
        // Gentle enough that the ground still reads as ground at 400 m, and
        // capped short of 1 so it never matches the sky exactly — that gap is
        // the horizon line.
        hz[i] = smoothstep(clamp((r - 55) / 620, 0, 1)) * 0.74;
      }
      ring.setAttribute('color', new THREE.BufferAttribute(col, 3));
      ring.setAttribute('aHaze', new THREE.BufferAttribute(hz, 1));
    }
    const rm = new THREE.Mesh(ring, farGroundMat);
    rm.name = 'props_far_ground';
    rm.castShadow = false;
    rm.receiveShadow = false;
    rm.matrixAutoUpdate = false;
    rm.updateMatrix();
    skyline.add(rm);
    owned.geo.push(ring);

    // The city too far to model: a low-contrast silhouette strip. Its base is
    // pinned below the ground plane at the same radius the floor reaches, so
    // it plants itself on the horizon instead of floating over it.
    const BAND_R = 770, BAND_H = 240;
    const band = new THREE.CylinderGeometry(BAND_R, BAND_R, BAND_H, 96, 1, true);
    // the texture's skyline sits at 97 % of the strip height, so line that up
    // with grade and let the rest rise above it
    band.translate(0, GROUND_Y - BAND_H * 0.03 + BAND_H * 0.5, 0);
    const bm = new THREE.Mesh(band, distantMat);
    bm.name = 'props_distant_city';
    bm.matrixAutoUpdate = false;
    bm.updateMatrix();
    bm.renderOrder = -2;
    skyline.add(bm);
    owned.geo.push(band);
  }

  // =========================================================================
  // assembly
  // =========================================================================
  const lotMeshes = lot.flush(group, owned, { cast: true, receive: true, name: 'lot' });
  far.flush(group, owned, { cast: false, receive: false, name: 'far' });

  // props well outside the shadow frustum never pay for a shadow pass
  for (const m of lotMeshes) {
    m.geometry.computeBoundingSphere();
    const bs = m.geometry.boundingSphere;
    if (bs && bs.center.length() - bs.radius > SHADOW_RADIUS) m.castShadow = false;
    // glass and decals must not punch opaque holes into the shadow map
    if (m.material.transparent) m.castShadow = false;
  }

  // --- colliders ------------------------------------------------------------
  const colliderMat = own(new THREE.MeshBasicMaterial({ name: 'props_collider', visible: false }));
  function collider(geos, type, friction) {
    if (!geos.length) return;
    const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos.map(strip), false);
    if (geos.length > 1) for (const g of geos) g.dispose();
    if (!merged) return;
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, colliderMat);
    mesh.name = `props_collider_${type}`;
    mesh.visible = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.updateMatrixWorld(true);        // geometry is already in world space
    colliders.push({ mesh, type, friction });
    owned.geo.push(merged);
  }
  collider(wallCollide, 'wall', 0.55);
  collider(deckCollide, 'ground', 0.95);

  // --- dusk lighting --------------------------------------------------------
  let clock = 0;
  let night = 0;
  let nightTarget = 0;
  let manualNight = false;

  function applyNight() {
    for (const e of emissiveNight) {
      e.material.emissiveIntensity = (e.base || 0) + e.intensity * night;
    }
    for (const m of lampHeads) m.userData.practicalOn = night > 0.05;
  }
  applyNight();

  function setNightLights(on) {
    manualNight = true;
    nightTarget = on ? 1 : 0;
  }

  const _fogRead = new THREE.Color();
  const _neutralHaze = new THREE.Color();
  const _sane = new THREE.Color();
  function update(dt, c) {
    const step = Math.min(dt || 0, 0.1);
    clock += step;
    time.value = clock;

    // The backdrop's aerial perspective rides on whatever the environment is
    // doing with the fog this frame, so the city always sits in the same air as
    // the horizon behind it. Half the fog's saturation is taken out and the
    // remainder pulled a little cool: the environment biases fog hard toward the
    // sun, and a fully saturated haze turns the whole skyline into one gold
    // silhouette instead of receding grey-blue distance.
    const cc = c || ctx;
    const tod = cc?.world?.environment?.timeOfDay;
    _fogRead.copy(hazeForTod(typeof tod === 'number' ? tod : 0.68));
    const fc = cc?.scene?.fog?.color;
    // Track the environment's own fog when it hands back something usable, but
    // never let an out-of-range colour reach the shader.
    if (fc && Number.isFinite(fc.r) && Number.isFinite(fc.g) && Number.isFinite(fc.b)
      && Math.min(fc.r, fc.g, fc.b) >= 0 && Math.max(fc.r, fc.g, fc.b) <= 2.5) {
      const l = fc.r * 0.2126 + fc.g * 0.7152 + fc.b * 0.0722;
      _neutralHaze.copy(fc).lerp(_sane.setRGB(l * 0.95, l, l * 1.10), 0.5);
      _fogRead.lerp(_neutralHaze, 0.45);
    }
    hazeU.value.lerp(_fogRead, 1 - Math.exp(-4 * step));

    if (!manualNight) {
      const tod = (c || ctx)?.world?.environment?.timeOfDay;
      if (typeof tod === 'number') {
        // lights come up through dusk and stay on until first light
        const evening = smoothstep(clamp((tod - 0.70) / 0.10, 0, 1));
        const morning = smoothstep(clamp((0.10 - tod) / 0.08, 0, 1));
        nightTarget = clamp(Math.max(evening, morning), 0, 1);
      }
    }
    if (Math.abs(night - nightTarget) > 0.0015) {
      night += (nightTarget - night) * (1 - Math.exp(-2.4 * step));
      applyNight();
    }
  }

  function dispose() {
    group.removeFromParent();
    for (const g of owned.geo) g.dispose();
    for (const m of owned.mat) m.dispose();
    for (const t of owned.tex) t.dispose();
    group.traverse((o) => {
      if (o.isInstancedMesh) o.dispose();
    });
    owned.geo.length = 0;
    owned.mat.length = 0;
    owned.tex.length = 0;
    colliders.length = 0;
    group.clear();
  }

  group.updateMatrixWorld(true);
  // seed the backdrop haze from whatever the environment already set, so the
  // very first frame is not rendered against a placeholder colour
  {
    const tod0 = ctx?.world?.environment?.timeOfDay;
    hazeU.value.copy(hazeForTod(typeof tod0 === 'number' ? tod0 : 0.68));
  }

  seed(0x5eed1e);                       // hand the rng stream back as main.js left it

  return {
    group,
    colliders,
    update,
    dispose,
    setNightLights,
    /** 0 = day, 1 = full dusk practicals. */
    nightAmount() { return night; },
    lampHeads,
    setWind(x, z) { windU.uWind.value.set(x, z); },
  };
}

export default createProps;
