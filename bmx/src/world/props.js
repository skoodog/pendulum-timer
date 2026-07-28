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
const FENCE_H = 2.2;
const BAY = 3.0;                     // fence bay width (metres)
const GATE = { centre: 14, width: 5.4 };   // opening in the +Z run
const SHADOW_RADIUS = 46;            // beyond this nothing casts shadows

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

const KEEP = ['position', 'normal', 'uv', 'color', 'aRegion', 'aFlex', 'aWind'];
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

/** Tileable facade: 16 m × 16 m of window grid. Returns { color, emissive }. */
function makeFacadeTextures() {
  const S = 512;
  const a = canvas2d(S, S), b = canvas2d(S, S);
  const g = a.g, e = b.g;

  g.fillStyle = '#8f8b80';
  g.fillRect(0, 0, S, S);
  // concrete panel joints + noise
  for (let y = 0; y < S; y += 4) {
    for (let x = 0; x < S; x += 4) {
      const n = noise01(x * 0.05, y * 0.05, 4);
      g.fillStyle = `rgba(${(n * 96) | 0},${(n * 88) | 0},${(n * 78) | 0},0.22)`;
      g.fillRect(x, y, 4, 4);
    }
  }
  e.fillStyle = '#000000';
  e.fillRect(0, 0, S, S);

  const COLS = 4, ROWS = 4;                 // 4 m window pitch over 16 m
  const cw = S / COLS, ch = S / ROWS;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const x = c * cw, y = r * ch;
      // spandrel band under each window row
      g.fillStyle = 'rgba(60,56,50,0.20)';
      g.fillRect(x, y + ch * 0.78, cw, ch * 0.22);

      const wx = x + cw * 0.16, wy = y + ch * 0.14, ww = cw * 0.68, wh = ch * 0.56;
      // recess shadow
      g.fillStyle = 'rgba(20,18,16,0.55)';
      g.fillRect(wx - 3, wy - 3, ww + 6, wh + 6);
      // glass
      const gr = g.createLinearGradient(wx, wy, wx, wy + wh);
      gr.addColorStop(0, '#2c3a49');
      gr.addColorStop(0.55, '#1b2530');
      gr.addColorStop(1, '#39434d');
      g.fillStyle = gr;
      g.fillRect(wx, wy, ww, wh);
      // mullion
      g.fillStyle = 'rgba(190,188,180,0.55)';
      g.fillRect(wx + ww * 0.5 - 1.5, wy, 3, wh);
      g.fillRect(wx, wy + wh * 0.5 - 1.5, ww, 3);
      // sill highlight
      g.fillStyle = 'rgba(230,226,214,0.5)';
      g.fillRect(wx - 4, wy + wh + 3, ww + 8, 3);

      // lit windows in the emissive map — about half on, warm and uneven
      if (rng() < 0.55) {
        const warm = rng() < 0.78;
        const i = rand(0.35, 1);
        const cr = warm ? 255 * i : 190 * i;
        const cg = warm ? 214 * i : 214 * i;
        const cb = warm ? 150 * i : 245 * i;
        e.fillStyle = `rgb(${cr | 0},${cg | 0},${cb | 0})`;
        e.fillRect(wx, wy, ww, wh);
        // blinds / occupied silhouettes
        e.fillStyle = 'rgba(0,0,0,0.45)';
        const blinds = randInt(0, 2);
        if (blinds === 1) e.fillRect(wx, wy, ww, wh * rand(0.2, 0.5));
        if (blinds === 2) e.fillRect(wx + ww * rand(0.1, 0.5), wy + wh * 0.4, ww * 0.22, wh * 0.6);
      }
    }
  }
  weather(g, 0, 0, S, S, 0.6);
  // vertical streaking below sills
  for (let i = 0; i < 60; i++) {
    const x = rand(0, S), y = rand(0, S);
    const gr = g.createLinearGradient(0, y, 0, y + rand(20, 90));
    gr.addColorStop(0, 'rgba(40,36,30,0.22)');
    gr.addColorStop(1, 'rgba(40,36,30,0)');
    g.fillStyle = gr;
    g.fillRect(x, y, rand(2, 7), 90);
  }
  return { color: a.canvas, emissive: b.canvas };
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
 * Tileable galvanised chainlink with a real alpha cut-out. Only used when the
 * material library is unavailable — the library's version carries normal/rough
 * maps too — but it must still read as woven wire, never as a grey wall.
 */
function makeChainlinkTexture() {
  const S = 256, T = 8;            // 8 diamonds per tile ~ 110 mm mesh
  const { canvas, g } = canvas2d(S, S);
  g.clearRect(0, 0, S, S);
  const cell = S / T;
  g.lineCap = 'square';
  for (let pass = 0; pass < 2; pass++) {
    // shadow pass first, then the lit wire, so the weave has depth
    g.lineWidth = pass === 0 ? cell * 0.20 : cell * 0.13;
    g.strokeStyle = pass === 0 ? 'rgba(28,30,32,0.85)' : 'rgba(196,201,205,1)';
    const off = pass === 0 ? 1.5 : 0;
    for (let i = -T; i <= T * 2; i++) {
      g.beginPath();
      g.moveTo(i * cell + off, -cell + off);
      g.lineTo(i * cell + S + cell + off, S + off);
      g.stroke();
      g.beginPath();
      g.moveTo(i * cell + off, S + cell + off);
      g.lineTo(i * cell + S + cell + off, -off);
      g.stroke();
    }
  }
  // rust speckle along the wires
  g.globalCompositeOperation = 'source-atop';
  for (let i = 0; i < 700; i++) {
    g.fillStyle = `rgba(${randInt(90, 150)},${randInt(60, 95)},${randInt(35, 60)},${rand(0.05, 0.5)})`;
    g.beginPath(); g.arc(rand(0, S), rand(0, S), rand(0.6, 2.6), 0, TAU); g.fill();
  }
  g.globalCompositeOperation = 'source-over';
  return canvas;
}

/** Horizon haze + hill silhouette band (alpha, top-fading). */
function makeHazeTexture(hills) {
  const W = 1024, H = 256;
  const { canvas, g } = canvas2d(W, H);
  g.clearRect(0, 0, W, H);
  if (hills) {
    // two ridgelines, back one lighter
    for (let layer = 0; layer < 2; layer++) {
      const base = H * (layer === 0 ? 0.62 : 0.74);
      const amp = layer === 0 ? 42 : 30;
      g.beginPath();
      g.moveTo(0, H);
      for (let x = 0; x <= W; x += 4) {
        const n = noise01(x * 0.006 + layer * 31.7, layer * 8.3, 4);
        const n2 = noise01(x * 0.021 + layer * 5.1, 3.3, 3);
        g.lineTo(x, base - n * amp - n2 * 14);
      }
      g.lineTo(W, H); g.closePath();
      g.fillStyle = layer === 0 ? 'rgba(96,104,124,0.62)' : 'rgba(72,80,101,0.82)';
      g.fill();
    }
  }
  // warm dust gradient rising off the ground
  const gr = g.createLinearGradient(0, H, 0, 0);
  gr.addColorStop(0, 'rgba(226,196,150,0.62)');
  gr.addColorStop(0.35, 'rgba(214,186,152,0.30)');
  gr.addColorStop(1, 'rgba(200,180,160,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, W, H);
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

  /** Library chainlink if it exists, otherwise a self-built alpha-cut weave. */
  function chainlinkMaterial() {
    if (lib && typeof lib.has === 'function' && lib.has('chainlink')) return lib.get('chainlink');
    const t = ownTex(makeTex(makeChainlinkTexture(), {
      aniso, wrap: THREE.RepeatWrapping, repeat: [1 / 0.9, 1 / 0.9],
    }));
    const m = new THREE.MeshStandardMaterial({
      name: 'props_chainlink',
      map: t,
      alphaTest: 0.42,
      transparent: false,
      side: THREE.DoubleSide,
      shadowSide: THREE.DoubleSide,
      roughness: 0.58,
      metalness: 0.55,
      envMapIntensity: 1.1,
    });
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
  const leafTex = ownTex(makeTex(makeLeafTexture(), { aniso }));
  const weedTex = ownTex(makeTex(makeWeedTexture(), { aniso }));
  const facade = makeFacadeTextures();
  const facadeTex = ownTex(makeTex(facade.color, { aniso, wrap: THREE.RepeatWrapping, repeat: [1 / 16, 1 / 16] }));
  const facadeEmi = ownTex(makeTex(facade.emissive, { aniso, wrap: THREE.RepeatWrapping, repeat: [1 / 16, 1 / 16] }));
  const graffitiTex = ownTex(makeTex(makeGraffitiTexture(), { aniso }));
  const coneTex = ownTex(makeTex(makeConeTexture(), { aniso, wrap: THREE.RepeatWrapping }));
  const dustTex = ownTex(makeTex(makeDustTexture(), { aniso }));
  const skidTex = ownTex(makeTex(makeSkidTexture(), { aniso }));
  const litterTex = ownTex(makeTex(makeLitterTexture(), { aniso }));
  const hazeTex = ownTex(makeTex(makeHazeTexture(true), { aniso }));
  const dustBandTex = ownTex(makeTex(makeHazeTexture(false), { aniso }));

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
  const billboardMat = own(new THREE.MeshStandardMaterial({
    name: 'props_billboard',
    map: bannerTex,
    side: THREE.FrontSide,
    roughness: 0.8,
    metalness: 0,
  }));

  const foliageMat = own(new THREE.MeshStandardMaterial({
    name: 'props_foliage',
    map: leafTex,
    alphaTest: 0.42,
    side: THREE.DoubleSide,
    roughness: 0.88,
    metalness: 0,
    envMapIntensity: 0.9,
  }));
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
    alphaTest: 0.4,
    side: THREE.DoubleSide,
    roughness: 0.95,
    metalness: 0,
  }));
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

  const facadeMat = own(new THREE.MeshStandardMaterial({
    name: 'props_facade',
    map: facadeTex,
    emissiveMap: facadeEmi,
    emissive: new THREE.Color(0xffffff),
    emissiveIntensity: 0,
    vertexColors: true,
    roughness: 0.86,
    metalness: 0.03,
    fog: true,
  }));

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
    name: 'props_litter', map: litterTex, alphaTest: 0.35, side: THREE.DoubleSide, roughness: 0.92, metalness: 0,
  }));
  // per-instance atlas cell for the litter quads (2×2 atlas)
  litterMat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aCell;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n\tvMapUv = vMapUv * 0.5 + aCell;');
  };
  litterMat.customProgramCacheKey = () => 'props_litter_cell';

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

  const hazeMat = own(new THREE.MeshBasicMaterial({
    name: 'props_haze', map: hazeTex, transparent: true, depthWrite: false,
    side: THREE.BackSide, fog: false, opacity: 0.95,
  }));
  const dustBandMat = own(new THREE.MeshBasicMaterial({
    name: 'props_dustband', map: dustBandTex, transparent: true, depthWrite: false,
    side: THREE.BackSide, fog: false, opacity: 0.5,
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

  {
    const b = BLEACH;
    for (let i = 0; i < b.tiers; i++) {
      const h = (i + 1) * b.rise;
      const x = b.x - i * b.run;
      lot.add(MAT.concrete, place(box(b.run, h, b.len), x, h * 0.5, b.z));
      // worn nosing on every step edge
      lot.add(MAT.concretePale, place(box(0.10, 0.05, b.len), x + b.run * 0.5 - 0.05, h - 0.02, b.z));
      deckCollide.push(place(box(b.run, 0.12, b.len), x, h - 0.06, b.z));
      seatRows.push({ x: x - 0.08, y: h, z: b.z, len: b.len });
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
      const g = box(1.86, 0.055, 0.115);
      place(g, x + Math.sin(ry) * off, 0.455, z + Math.cos(ry) * off, ry);
      lot.add(MAT.wood, g);
    }
    // backrest
    for (let i = 0; i < 3; i++) {
      const g = box(1.86, 0.055, 0.12);
      place(g, x + Math.sin(ry) * -0.28, 0.62 + i * 0.145, z + Math.cos(ry) * -0.28, ry, -0.22);
      lot.add(MAT.wood, g);
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
      lot.add(MAT.wood, place(box(1.9, 0.045, 0.17), x + Math.sin(ry) * off, topY, z + Math.cos(ry) * off, ry));
    }
    for (const side of [-1, 1]) {
      for (let i = 0; i < 2; i++) {
        const off = side * (0.72 + i * 0.19);
        lot.add(MAT.wood, place(box(1.9, 0.045, 0.17), x + Math.sin(ry) * off, seatY, z + Math.cos(ry) * off, ry));
      }
    }
    // A-frame legs
    for (const end of [-1, 1]) {
      const ex = x + Math.cos(ry) * end * 0.72, ez = z - Math.sin(ry) * end * 0.72;
      for (const side of [-1, 1]) {
        lot.add(MAT.wood, place(box(0.08, 0.86, 0.09),
          ex + Math.sin(ry) * side * 0.42, 0.42, ez + Math.cos(ry) * side * 0.42, ry, 0, side * 0.42));
      }
      lot.add(MAT.wood, place(box(0.07, 0.07, 1.86), ex, seatY - 0.06, ez, ry));
      lot.add(MAT.wood, place(box(0.07, 0.5, 0.07), ex, 0.5, ez, ry));
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
  // 7. spectator crowd — two instanced meshes, idle motion in the vertex shader
  // =========================================================================
  const crowdMat = own(new THREE.MeshStandardMaterial({
    name: 'props_crowd',
    vertexColors: true,
    roughness: 0.86,
    metalness: 0,
    envMapIntensity: 0.8,
  }));
  patchVertex(crowdMat, windU, /* glsl */`
    uniform float uTime;
    attribute float aRegion;
    attribute float aPhase;
    attribute vec3 aShirt;
    attribute vec3 aPants;
    attribute vec3 aSkin;
  `, /* glsl */`
    {
      float t = uTime * 1.7 + aPhase;
      float bob = sin(t) * 0.022 + sin(t * 0.53 + 1.7) * 0.012;
      float sway = sin(uTime * 0.9 + aPhase * 1.7) * 0.016;
      float up = clamp(position.y * 0.8, 0.0, 1.4);
      transformed.y += bob;
      transformed.x += sway * up;
      transformed.z += cos(uTime * 0.7 + aPhase) * 0.008 * up;
    }
  `, 'props_crowd_idle');
  crowdMat.onBeforeCompile = ((base) => (shader) => {
    base(shader);
    shader.vertexShader = shader.vertexShader.replace('#include <color_vertex>', /* glsl */`
      #include <color_vertex>
      {
        vec3 tint = aSkin;
        if (aRegion > 2.5) tint = vec3(0.045, 0.042, 0.05);
        else if (aRegion > 1.5) tint = aPants;
        else if (aRegion > 0.5) tint = aShirt;
        vColor.rgb *= tint;
      }
    `);
  })(crowdMat.onBeforeCompile);

  function figurePart(geo, region, shade) {
    tintGeo(geo, 0xffffff);
    const c = geo.attributes.color;
    for (let i = 0; i < c.count; i++) c.setXYZ(i, shade, shade, shade);
    floatAttr(geo, 'aRegion', region);
    return strip(geo);
  }

  function standingFigure() {
    const parts = [];
    parts.push(figurePart(place(box(0.14, 0.09, 0.29), 0.11, 0.045, 0.03), 3, 0.9));
    parts.push(figurePart(place(box(0.14, 0.09, 0.29), -0.11, 0.045, -0.02), 3, 0.9));
    parts.push(figurePart(place(box(0.155, 0.80, 0.175), 0.11, 0.48, 0), 2, 0.92));
    parts.push(figurePart(place(box(0.155, 0.80, 0.175), -0.11, 0.48, 0), 2, 0.88));
    parts.push(figurePart(place(box(0.40, 0.17, 0.25), 0, 0.92, 0), 2, 0.95));
    parts.push(figurePart(place(taperY(box(0.43, 0.58, 0.25), -0.29, 0.29, 0.84, 1.0), 0, 1.28, 0), 1, 1.0));
    parts.push(figurePart(place(box(0.13, 0.54, 0.15), 0.28, 1.28, 0.01, 0, 0, -0.10), 1, 0.9));
    parts.push(figurePart(place(box(0.13, 0.54, 0.15), -0.28, 1.28, -0.01, 0, 0, 0.10), 1, 0.87));
    parts.push(figurePart(place(box(0.10, 0.12, 0.11), 0.32, 0.98, 0.02), 0, 0.95));
    parts.push(figurePart(place(box(0.10, 0.12, 0.11), -0.32, 0.98, -0.02), 0, 0.95));
    parts.push(figurePart(place(box(0.105, 0.10, 0.105), 0, 1.60, 0), 0, 0.92));
    parts.push(figurePart(place(new THREE.IcosahedronGeometry(0.128, 1), 0, 1.72, 0), 0, 1.0));
    parts.push(figurePart(place(box(0.235, 0.06, 0.245), 0, 1.80, 0.006), 3, 1.0));
    const g = mergeGeometries(parts, false);
    for (const p of parts) p.dispose();
    return g;
  }

  function seatedFigure() {
    const parts = [];
    parts.push(figurePart(place(box(0.16, 0.15, 0.44), 0.11, 0.07, 0.22), 2, 0.92));
    parts.push(figurePart(place(box(0.16, 0.15, 0.44), -0.11, 0.07, 0.22), 2, 0.88));
    parts.push(figurePart(place(box(0.145, 0.46, 0.16), 0.11, -0.24, 0.40), 2, 0.9));
    parts.push(figurePart(place(box(0.145, 0.46, 0.16), -0.11, -0.24, 0.40), 2, 0.86));
    parts.push(figurePart(place(box(0.15, 0.09, 0.28), 0.11, -0.44, 0.50), 3, 0.9));
    parts.push(figurePart(place(box(0.15, 0.09, 0.28), -0.11, -0.44, 0.50), 3, 0.9));
    parts.push(figurePart(place(taperY(box(0.43, 0.56, 0.25), -0.28, 0.28, 0.84, 1.0), 0, 0.40, 0.02, 0, -0.10), 1, 1.0));
    parts.push(figurePart(place(box(0.13, 0.46, 0.16), 0.28, 0.38, 0.08, 0, -0.35), 1, 0.9));
    parts.push(figurePart(place(box(0.13, 0.46, 0.16), -0.28, 0.38, 0.08, 0, -0.35), 1, 0.87));
    parts.push(figurePart(place(box(0.10, 0.11, 0.11), 0.30, 0.20, 0.26), 0, 0.95));
    parts.push(figurePart(place(box(0.10, 0.11, 0.11), -0.30, 0.20, 0.26), 0, 0.95));
    parts.push(figurePart(place(box(0.105, 0.10, 0.105), 0, 0.71, 0.01), 0, 0.92));
    parts.push(figurePart(place(new THREE.IcosahedronGeometry(0.126, 1), 0, 0.83, 0.01), 0, 1.0));
    parts.push(figurePart(place(box(0.23, 0.06, 0.24), 0, 0.91, 0.012), 3, 1.0));
    const g = mergeGeometries(parts, false);
    for (const p of parts) p.dispose();
    return g;
  }

  const SHIRTS = [0xd8452f, 0x2f6fb8, 0xe8e2d4, 0x2a2d33, 0xe0a52b, 0x4a8f5c, 0x8f4ba0, 0xd97ea0, 0x3c3f8f, 0xb8b2a4];
  const PANTS = [0x2b3242, 0x4a4438, 0x22242a, 0x5a5f66, 0x38424f, 0x6a5a44];
  const SKINS = [0x9c6b4a, 0x81563a, 0x5f3c26, 0xb08059, 0x4a2f1e, 0x8c6242];

  function crowdMesh(geo, spots, name, cast) {
    const n = spots.length;
    const shirt = new Float32Array(n * 3);
    const pants = new Float32Array(n * 3);
    const skin = new Float32Array(n * 3);
    const phase = new Float32Array(n);
    const mesh = new THREE.InstancedMesh(geo, crowdMat, n);
    mesh.name = name;
    mesh.castShadow = cast;
    mesh.receiveShadow = false;
    for (let i = 0; i < n; i++) {
      const s = spots[i];
      _euler.set(0, s.ry, 0, 'YXZ');
      _quat.setFromEuler(_euler);
      _pos.set(s.x, s.y, s.z);
      _scl.set(s.s, s.s * rand(0.97, 1.05), s.s);
      _m4.compose(_pos, _quat, _scl);
      mesh.setMatrixAt(i, _m4);
      _col.setHex(pick(SHIRTS), THREE.SRGBColorSpace);
      shirt[i * 3] = _col.r; shirt[i * 3 + 1] = _col.g; shirt[i * 3 + 2] = _col.b;
      _col.setHex(pick(PANTS), THREE.SRGBColorSpace);
      pants[i * 3] = _col.r; pants[i * 3 + 1] = _col.g; pants[i * 3 + 2] = _col.b;
      _col.setHex(pick(SKINS), THREE.SRGBColorSpace);
      skin[i * 3] = _col.r; skin[i * 3 + 1] = _col.g; skin[i * 3 + 2] = _col.b;
      phase[i] = rand(0, TAU);
    }
    geo.setAttribute('aShirt', new THREE.InstancedBufferAttribute(shirt, 3));
    geo.setAttribute('aPants', new THREE.InstancedBufferAttribute(pants, 3));
    geo.setAttribute('aSkin', new THREE.InstancedBufferAttribute(skin, 3));
    geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);
    owned.geo.push(geo);
    return mesh;
  }

  {
    const standSpots = [];
    // leaning on the fence along the +Z run, either side of the gate
    for (let i = 0; i < 16; i++) {
      const x = lerp(-24, 30, i / 15) + rand(-0.8, 0.8);
      if (Math.abs(x - GATE.centre) < GATE.width * 0.5 + 0.6) continue;
      const z = LOT.hz - rand(0.85, 1.5);
      standSpots.push({ x, y: 0, z, ry: Math.atan2(-x, -z) + rand(-0.35, 0.35), s: rand(0.93, 1.06) });
    }
    // along the -Z run and the east fence
    for (let i = 0; i < 9; i++) {
      const x = lerp(-18, 24, i / 8) + rand(-1, 1);
      standSpots.push({ x, y: 0, z: -LOT.hz + rand(0.9, 1.7), ry: Math.atan2(-x, LOT.hz) + rand(-0.3, 0.3), s: rand(0.93, 1.06) });
    }
    for (let i = 0; i < 6; i++) {
      const z = lerp(-14, 8, i / 5) + rand(-1, 1);
      standSpots.push({ x: LOT.hx - rand(1.0, 2.2), y: 0, z, ry: Math.atan2(-LOT.hx, -z) + rand(-0.3, 0.3), s: rand(0.93, 1.06) });
    }
    // knots of people by the gate and the bleachers
    for (let i = 0; i < 5; i++) {
      standSpots.push({
        x: GATE.centre - 6 + rand(-2.2, 2.2), y: 0, z: LOT.hz - 6 + rand(-2, 2),
        ry: rand(0, TAU), s: rand(0.93, 1.06),
      });
    }
    for (let i = 0; i < 4; i++) {
      standSpots.push({
        x: BLEACH.x + rand(1.2, 3.4), y: 0, z: rand(-9, 9),
        ry: Math.PI * 0.5 + rand(-0.4, 0.4), s: rand(0.93, 1.06),
      });
    }
    crowdMesh(standingFigure(), standSpots, 'props_crowd_standing', true);

    const sitSpots = [];
    for (let r = 1; r < seatRows.length; r++) {
      const row = seatRows[r];
      const count = randInt(3, 6);
      for (let i = 0; i < count; i++) {
        const z = rand(-row.len * 0.45, row.len * 0.45);
        sitSpots.push({ x: row.x, y: row.y, z, ry: Math.PI * 0.5 + rand(-0.28, 0.28), s: rand(0.94, 1.05) });
      }
    }
    crowdMesh(seatedFigure(), sitSpots, 'props_crowd_seated', true);
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
  // 10. city backdrop: skyline ring, water towers, cranes, billboards, haze
  // =========================================================================
  const skyline = new THREE.Group();
  skyline.name = 'props_skyline';
  group.add(skyline);

  const TINTS = [0x8d8a82, 0x7f8288, 0x9b9184, 0x6f757e, 0xa39584, 0x87837c, 0x5f6670, 0x94867a];

  {
    const buildingGeos = [];
    const roofBucket = createBucket();
    const towers = [];

    const COUNT = 78;
    for (let i = 0; i < COUNT; i++) {
      const a = (i / COUNT) * TAU + rand(-0.035, 0.035);
      const ring = rng();
      const r = lerp(165, 430, Math.pow(ring, 0.75)) + rand(-22, 22);
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const w = rand(16, 42), d = rand(16, 42);
      // nearer buildings stay lower so the far towers still read as a skyline
      const tall = Math.pow(rng(), 2.2);
      const h = lerp(14, 46, ring) + tall * lerp(20, 90, ring);
      const tint = pick(TINTS);

      const base = tintGeo(place(box(w, h, d), x, h * 0.5, z, a), tint, 0.03);
      buildingGeos.push(strip(base));

      // setbacks
      let sh = h, sw = w, sd = d;
      const setbacks = randInt(0, 2);
      for (let k = 0; k < setbacks; k++) {
        sw *= rand(0.55, 0.8); sd *= rand(0.55, 0.8);
        const add = rand(6, 26) * (0.4 + ring);
        buildingGeos.push(strip(tintGeo(place(box(sw, add, sd), x, sh + add * 0.5, z, a), tint, 0.03)));
        sh += add;
      }

      // parapet + rooftop clutter, dark and unlit so the roofline stays crisp
      roofBucket.add(MAT.concretePale, place(box(sw + 0.8, 0.9, sd + 0.8), x, sh + 0.45, z, a));
      const clutter = randInt(1, 4);
      for (let k = 0; k < clutter; k++) {
        const cw = rand(2, 7), cd = rand(2, 7), chh = rand(1.6, 5);
        roofBucket.add(MAT.steelDark, place(box(cw, chh, cd),
          x + rand(-sw * 0.3, sw * 0.3), sh + chh * 0.5, z + rand(-sd * 0.3, sd * 0.3), a));
      }
      if (rng() < 0.30) {
        const mh = rand(8, 26);
        roofBucket.add(MAT.steelDark, place(cyl(0.25, 0.5, mh, 5), x + rand(-4, 4), sh + mh * 0.5, z + rand(-4, 4)));
      }
      if (rng() < 0.18) towers.push({ x, z, y: sh, a });
    }

    const merged = mergeGeometries(buildingGeos, false);
    for (const g of buildingGeos) g.dispose();
    if (merged) {
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, facadeMat);
      mesh.name = 'props_buildings';
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      skyline.add(mesh);
      owned.geo.push(merged);
    }
    emissiveNight.push({ material: facadeMat, intensity: 1.55 });

    // rooftop water tanks
    for (const t of towers.slice(0, 7)) {
      const legH = rand(3.5, 6.5), tankR = rand(2.2, 3.4), tankH = rand(4, 6.5);
      for (let k = 0; k < 4; k++) {
        const la = k * Math.PI * 0.5 + 0.78;
        roofBucket.add(MAT.steelRust, place(box(0.34, legH, 0.34),
          t.x + Math.cos(la) * tankR * 0.72, t.y + legH * 0.5, t.z + Math.sin(la) * tankR * 0.72));
      }
      roofBucket.add(MAT.woodGrey, place(cyl(tankR, tankR * 1.04, tankH, 12), t.x, t.y + legH + tankH * 0.5, t.z));
      roofBucket.add(MAT.steelRust, place(new THREE.ConeGeometry(tankR * 1.12, tankR * 0.75, 12), t.x, t.y + legH + tankH + tankR * 0.36, t.z));
      roofBucket.add(MAT.steelRust, place(cyl(0.06, 0.06, legH, 4), t.x + tankR * 0.9, t.y + legH * 0.5, t.z));
    }

    // tower cranes: mast, jib, counter-jib, hook line
    const craneMat = libMat('paintedMetal', { color: 0xd8a520, roughness: 0.62 }, { color: 0xd8a520, roughness: 0.62, metalness: 0.7 });
    const cranes = [
      { x: -210, z: -260, h: 78, a: 0.7 },
      { x: 250, z: -180, h: 64, a: -1.9 },
    ];
    for (const c of cranes) {
      const post = 1.4;
      for (let k = 0; k < 4; k++) {
        const ca = k * Math.PI * 0.5 + 0.78;
        roofBucket.add(craneMat, place(box(0.55, c.h, 0.55),
          c.x + Math.cos(ca) * post, c.h * 0.5, c.z + Math.sin(ca) * post));
      }
      for (let k = 0; k < 12; k++) {
        roofBucket.add(craneMat, place(box(post * 2.4, 0.30, post * 2.4), c.x, (k + 1) * (c.h / 13), c.z));
      }
      // slewing platform + jib
      roofBucket.add(craneMat, place(box(4.2, 1.6, 3.2), c.x, c.h + 0.8, c.z, c.a));
      roofBucket.add(craneMat, place(box(46, 1.6, 1.6), c.x + Math.cos(c.a) * 20, c.h + 2.6, c.z - Math.sin(c.a) * 20, c.a));
      roofBucket.add(craneMat, place(box(16, 1.5, 1.8), c.x - Math.cos(c.a) * 8, c.h + 2.6, c.z + Math.sin(c.a) * 8, c.a));
      roofBucket.add(MAT.concretePale, place(box(4, 2.2, 2.6), c.x - Math.cos(c.a) * 15, c.h + 2.4, c.z + Math.sin(c.a) * 15, c.a));
      // A-frame + hoist cable
      roofBucket.add(craneMat, place(box(0.5, 7, 0.5), c.x, c.h + 6, c.z));
      roofBucket.add(MAT.steelDark, place(cyl(0.10, 0.10, 26, 4), c.x + Math.cos(c.a) * 30, c.h - 10, c.z - Math.sin(c.a) * 30));
      roofBucket.add(MAT.steelDark, place(box(1.4, 1.2, 1.0), c.x + Math.cos(c.a) * 30, c.h - 23.4, c.z - Math.sin(c.a) * 30, c.a));
    }

    roofBucket.flush(skyline, owned, { cast: false, receive: false, name: 'skyline' });

    // rooftop billboards, using the same atlas as the fence banners
    const boards = [];
    for (let i = 0; i < 5; i++) {
      const t = towers[(i * 3 + 1) % Math.max(1, towers.length)];
      if (!t) break;
      const bw = rand(20, 32), bh = bw * 0.5;
      const face = Math.atan2(-t.x, -t.z);
      const g = planeCell(bw, bh, 1, 1, [0, 4, 7, 12, 15][i % 5], ATLAS_COLS, ATLAS_ROWS);
      place(g, t.x, t.y + bh * 0.5 + 4, t.z, face);
      boards.push(strip(g));
      // frame legs
      far.add(MAT.steelDark, place(box(bw + 1.2, 0.6, 0.6), t.x, t.y + 4, t.z, face));
      far.add(MAT.steelDark, place(box(0.6, bh + 8, 0.6), t.x + Math.cos(face) * bw * 0.35, t.y + bh * 0.5, t.z - Math.sin(face) * bw * 0.35, face));
      far.add(MAT.steelDark, place(box(0.6, bh + 8, 0.6), t.x - Math.cos(face) * bw * 0.35, t.y + bh * 0.5, t.z + Math.sin(face) * bw * 0.35, face));
    }
    if (boards.length) {
      const bmerged = mergeGeometries(boards, false);
      for (const g of boards) g.dispose();
      if (bmerged) {
        const mesh = new THREE.Mesh(bmerged, billboardMat);
        mesh.name = 'props_billboards';
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        skyline.add(mesh);
        owned.geo.push(bmerged);
      }
    }
  }

  // far ground so the lot never ends in empty sky, plus two haze bands
  {
    const farGroundMat = own(new THREE.MeshStandardMaterial({
      name: 'props_far_ground', color: 0x6d6a62, roughness: 1, metalness: 0,
    }));
    // starts just outside the fence and slightly below grade, so it hides under
    // whatever ground the park lays down and only shows past its edge
    const ring = new THREE.RingGeometry(44, 620, 56, 1);
    ring.rotateX(-Math.PI * 0.5);
    ring.translate(0, -0.30, 0);
    const rm = new THREE.Mesh(ring, farGroundMat);
    rm.name = 'props_far_ground';
    rm.castShadow = false;
    rm.receiveShadow = false;
    rm.matrixAutoUpdate = false;
    rm.updateMatrix();
    skyline.add(rm);
    owned.geo.push(ring);

    const hills = new THREE.CylinderGeometry(560, 560, 96, 64, 1, true);
    hills.translate(0, 22, 0);
    const hm = new THREE.Mesh(hills, hazeMat);
    hm.name = 'props_hill_band';
    hm.matrixAutoUpdate = false;
    hm.updateMatrix();
    hm.renderOrder = -2;
    skyline.add(hm);
    owned.geo.push(hills);

    const band = new THREE.CylinderGeometry(345, 345, 46, 48, 1, true);
    band.translate(0, 10, 0);
    const bm = new THREE.Mesh(band, dustBandMat);
    bm.name = 'props_dust_band';
    bm.matrixAutoUpdate = false;
    bm.updateMatrix();
    bm.renderOrder = -1;
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

  function update(dt, c) {
    const step = Math.min(dt || 0, 0.1);
    clock += step;
    time.value = clock;

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
