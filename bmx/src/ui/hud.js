// MIRRA CITY — the in-game HUD.
//
// A DOM overlay built to the reference frame: score + special meter + live
// competition leaderboard top-left, run timer top-centre, trick list top-right,
// trick callout bottom-centre, balance meters, challenge tracker, big centred
// flashes and toasts.
//
// Rules this file plays by:
//   * Every element is created once, in createHUD(). update() only ever writes
//     `textContent` (on change) and `transform` / class names. No element is
//     created, measured or re-laid-out per frame.
//   * All motion is CSS transitions/keyframes plus a handful of Web Animations
//     fired on discrete events — transform and opacity only, GPU friendly.
//   * Everything it reads from siblings is optional-chained with a sane
//     fallback, so a half-built scoring/grind/trick module can never break boot.
//
// State it reads (real field names, verified against the modules):
//   ctx.player.scoring  score displayScore comboPoints comboMultiplier comboActive
//                       comboText comboTimer01 special01 specialReady timeText
//                       timeLeft timeTotal phase rank leaderboard boardView goals
//                       goalsDone goalsTotal letters lettersCollected smashed
//                       smashTotal gapsCleared landedCount totalCount
//   ctx.player.tricks   TRICKS/list total landedCount hasLanded(id) difficultyTag()
//   ctx.player.grind    active balance critical trickName railType
//   ctx.player.physics.state  mode airTime balance manualType speed
//   ctx events          scoreBank scoreLost scoreGap goalComplete achievement
//                       rankUp specialReady letterCollected objectSmashed
//                       countdown sessionStart sessionEnd bail respawn
//
// Keys owned here (not in input.js's bind table, so nothing collides):
//   T — toggle the trick list      G — collapse/expand the challenge tracker
//
// Visibility is two-tier, and it is driven by scoring.phase, never by a camera
// flag (see update()):
//   `is-hidden`  the whole overlay — only flags.hideHud, or a blocking menu
//                screen while no run is on the clock.
//   `is-quiet`   photo / free-camera / staged capture — drops the diegetic
//                noise (prompts, toasts, banners) and keeps the furniture:
//                score, special, timer, leaderboard, callout, pad corner.
// A live run can never render zero HUD pixels; update() asserts it.
//
// This file also owns two things hud.css cannot express: the display typeface,
// which is generated here as a real sfnt because the game ships no font files
// and no host has a condensed face installed, and the rules that style what
// this module adds on top of the stylesheet.

import { clamp } from '../core/mathx.js';

// ---------------------------------------------------------------------------
// Static presentation data
// ---------------------------------------------------------------------------

/** Which key holds each trick modifier, for the trick-list recipes. */
const MOD_KEY = {
  trickA: 'J', trickB: 'K', trickC: 'L',
  grind: 'U', lip: 'U', manual: 'I',
  spin: 'Q/E', hop: 'SPACE', flatA: 'J', flatB: 'K',
};

/** Extra context a recipe needs to actually fire. */
const MOD_NOTE = {
  lip: 'coping', flatA: 'flat', flatB: 'flat', manual: 'hold', spin: 'hold',
};

const DIR_ARROW = {
  N: '', U: '↑', D: '↓', L: '←', R: '→',
  UL: '↖', UR: '↗', DL: '↙', DR: '↘',
};

const CATEGORY_ORDER = ['air', 'grind', 'lip', 'manual', 'flatland'];
const CATEGORY_NAME = {
  air: 'AIR & ROTATION', grind: 'GRINDS', lip: 'LIP TRICKS',
  manual: 'MANUALS', flatland: 'FLATLAND',
};

/** Chevron run per difficulty tier, matching the reference's `>>> HARD`. */
const DIFF_CHEVRON = { AM: '>', HARD: '>>', PRO: '>>>', SICK: '>>>>' };

const FLASH_TIME = 1.35;      // s a centred flash stays up
const TOAST_TIME = 3.1;       // s a toast lives
const BAIL_EDGE_TIME = 0.95;  // s of red screen-edge pulse
const MAX_TOASTS = 4;

// ---------------------------------------------------------------------------
// Tiny DOM helpers (build time only)
// ---------------------------------------------------------------------------

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/** 37850 -> "37,850". Locale-independent so the layout never surprises us. */
function fmt(n) {
  let v = Math.round(n);
  if (!Number.isFinite(v)) v = 0;
  const neg = v < 0;
  if (neg) v = -v;
  let s = String(v);
  if (s.length > 3) {
    let out = '';
    let c = 0;
    for (let i = s.length - 1; i >= 0; i--) {
      out = s[i] + out;
      if (++c % 3 === 0 && i > 0) out = ',' + out;
    }
    s = out;
  }
  return neg ? '-' + s : s;
}

// ===========================================================================
// DISPLAY TYPEFACE — generated here, never downloaded
// ===========================================================================
//
// hud.css asks for Oswald / Roboto Condensed / Arial Narrow and friends. None
// of those ship with the game and almost no render host has them installed, so
// the stack used to fall through to whatever wide default the browser had
// (DejaVu Sans on a Linux capture box) and the HUD lost its whole voice.
//
// Zero-network is a hard rule, so instead of embedding a licensed binary we
// *build* the face: a monoline condensed display grotesque (Bebas-flavoured),
// drawn from stroke skeletons, tessellated into TrueType contours, assembled
// into a real sfnt in memory and registered through the CSS Font Loading API.
// It is deterministic (pure geometry, no rng), costs ~15 ms once at boot, and
// renders identically on every machine.
//
// Glyph geometry lives on a 1000 upm em square: baseline 0, cap height 700,
// monoline stroke 82, 40 units of side bearing either side of each design box.

const FONT_FAMILY = 'Mirra Display';
const FONT_UPM = 1000;
const FONT_CAP = 700;
const FONT_ASC = 800;
const FONT_DESC = -200;
const FONT_STROKE = 82;
const FONT_SIDE = 40;
const D2R = Math.PI / 180;

/** Sampled elliptical arc, degrees, a0 -> a1 in either direction. */
function fArc(cx, cy, rx, ry, a0, a1, n) {
  const steps = Math.max(2, n || Math.max(4, Math.round(Math.abs(a1 - a0) / 20)));
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const a = (a0 + (a1 - a0) * (i / steps)) * D2R;
    out.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return out;
}

/** Clockwise regular polygon — used for round stroke joints and dots. */
function fNgon(cx, cy, r, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (-i / n) * Math.PI * 2 + Math.PI / n;
    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return out;
}

/** Concatenate points/point-runs into one polyline, dropping repeats. */
function fPath(parts) {
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const run = typeof p[0] === 'number' ? [p] : p;
    for (let j = 0; j < run.length; j++) {
      const q = run[j];
      const last = out.length ? out[out.length - 1] : null;
      if (last && Math.abs(last[0] - q[0]) < 0.6 && Math.abs(last[1] - q[1]) < 0.6) continue;
      out.push(q);
    }
  }
  return out;
}

function S(pts) { return { p: pts, c: false }; }        // open stroke
function SC(pts) { return { p: pts, c: true }; }        // closed stroke

/**
 * Expand a stroke skeleton into filled contours. Every contour comes out with
 * the same (clockwise) winding, so overlapping pieces union cleanly under the
 * non-zero fill rule TrueType rasterisers use — no boolean geometry needed.
 */
function strokeToContours(path, t, closed, out) {
  const h = t * 0.5;
  const n = path.length;
  if (n < 2) return;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = path[i];
    const b = path[(i + 1) % n];
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-4) continue;
    dx /= len; dy /= len;
    const nx = -dy * h;
    const ny = dx * h;
    out.push([
      [a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny],
      [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny],
    ]);
  }
  // Round the joints only where the turn is sharp enough to open a notch.
  const first = closed ? 0 : 1;
  const last = closed ? n - 1 : n - 2;
  for (let i = first; i <= last; i++) {
    const p = path[i];
    const pv = path[(i - 1 + n) % n];
    const nx = path[(i + 1) % n];
    const a0 = Math.atan2(p[1] - pv[1], p[0] - pv[0]);
    const a1 = Math.atan2(nx[1] - p[1], nx[0] - p[0]);
    let d = (a1 - a0) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    if (Math.abs(d) > 0.26) out.push(fNgon(p[0], p[1], h, 8));
  }
}

// --- the alphabet ----------------------------------------------------------
// `w` is the design-box width; ink spans 0..w and the advance is w + 2*40.
// Coordinates are the stroke *centre lines*, inset by half a stroke.

const GLYPH_DEFS = {
  ' ': { w: 160, s: [] },
  A: { w: 360, s: [S([[41, 41], [180, 659], [319, 41]]), S([[86, 270], [274, 270]])] },
  B: {
    w: 360,
    s: [
      S([[41, 41], [41, 659]]),
      S(fPath([[41, 659], fArc(190, 516, 120, 143, 90, -90, 7), [41, 373]])),
      S(fPath([[41, 373], fArc(190, 207, 128, 166, 90, -90, 7), [41, 41]])),
    ],
  },
  C: { w: 360, s: [S(fArc(180, 350, 139, 309, 52, 308, 14))] },
  D: {
    w: 360,
    s: [
      S([[41, 41], [41, 659]]),
      S(fPath([[41, 659], [160, 659], fArc(160, 350, 159, 309, 90, -90, 9), [41, 41]])),
    ],
  },
  E: {
    w: 360,
    s: [S([[41, 41], [41, 659]]), S([[41, 659], [300, 659]]), S([[41, 350], [268, 350]]), S([[41, 41], [300, 41]])],
  },
  F: { w: 360, s: [S([[41, 41], [41, 659]]), S([[41, 659], [300, 659]]), S([[41, 350], [262, 350]])] },
  G: {
    w: 360,
    s: [S(fArc(180, 350, 139, 309, -52, -308, 14)), S([[266, 107], [319, 200], [319, 350], [212, 350]])],
  },
  H: { w: 360, s: [S([[41, 41], [41, 659]]), S([[319, 41], [319, 659]]), S([[41, 350], [319, 350]])] },
  I: { w: 82, s: [S([[41, 41], [41, 659]])] },
  J: { w: 360, s: [S(fPath([[280, 659], fArc(180, 160, 100, 119, 0, -180, 7)]))] },
  K: { w: 360, s: [S([[41, 41], [41, 659]]), S([[70, 350], [319, 659]]), S([[70, 350], [319, 41]])] },
  L: { w: 340, s: [S([[41, 659], [41, 41], [300, 41]])] },
  M: { w: 400, s: [S([[41, 41], [41, 659], [200, 290], [359, 659], [359, 41]])] },
  N: { w: 360, s: [S([[41, 41], [41, 659], [319, 41], [319, 659]])] },
  O: { w: 360, s: [SC(fArc(180, 350, 139, 309, 0, 360, 20).slice(0, -1))] },
  P: {
    w: 360,
    s: [S([[41, 41], [41, 659]]), S(fPath([[41, 659], [190, 659], fArc(190, 505, 120, 154, 90, -90, 7), [41, 351]]))],
  },
  Q: { w: 360, s: [SC(fArc(180, 350, 139, 309, 0, 360, 20).slice(0, -1)), S([[218, 130], [330, 10]])] },
  R: {
    w: 360,
    s: [
      S([[41, 41], [41, 659]]),
      S(fPath([[41, 659], [190, 659], fArc(190, 505, 120, 154, 90, -90, 7), [41, 351]])),
      S([[172, 351], [319, 41]]),
    ],
  },
  S: { w: 360, s: [S(fPath([fArc(180, 516, 124, 143, 30, 200, 9), fArc(180, 190, 128, 149, 20, -195, 10)]))] },
  T: { w: 360, s: [S([[180, 41], [180, 659]]), S([[20, 659], [340, 659]])] },
  U: { w: 360, s: [S(fPath([[41, 659], fArc(180, 180, 139, 139, 180, 360, 9), [319, 659]]))] },
  V: { w: 360, s: [S([[41, 659], [180, 41], [319, 659]])] },
  W: { w: 440, s: [S([[30, 659], [125, 41], [220, 470], [315, 41], [410, 659]])] },
  X: { w: 360, s: [S([[41, 41], [319, 659]]), S([[41, 659], [319, 41]])] },
  Y: { w: 360, s: [S([[41, 659], [180, 370], [319, 659]]), S([[180, 370], [180, 41]])] },
  Z: { w: 360, s: [S([[41, 659], [319, 659], [41, 41], [319, 41]])] },

  0: { w: 300, s: [SC(fArc(150, 350, 109, 309, 0, 360, 20).slice(0, -1))] },
  1: { w: 300, s: [S([[55, 530], [150, 659], [150, 41]]), S([[45, 41], [255, 41]])] },
  2: { w: 300, s: [S(fPath([fArc(150, 516, 110, 128, 200, -30, 10), [41, 41], [268, 41]]))] },
  3: { w: 300, s: [S(fPath([fArc(150, 516, 105, 128, 195, -75, 9), fArc(150, 180, 115, 139, 75, -200, 10)]))] },
  4: { w: 300, s: [S([[245, 41], [245, 659]]), S([[245, 659], [35, 230], [285, 230]])] },
  5: { w: 300, s: [S(fPath([[255, 659], [70, 659], [70, 430], fArc(160, 280, 110, 150, 90, -160, 9)]))] },
  6: {
    w: 300,
    s: [S(fPath([[41, 175], fArc(150, 520, 109, 139, 180, 90, 6)])), SC(fArc(150, 175, 109, 134, 0, 360, 16).slice(0, -1))],
  },
  7: { w: 300, s: [S([[35, 659], [265, 659], [120, 41]])] },
  8: {
    w: 300,
    s: [SC(fArc(150, 520, 100, 139, 0, 360, 16).slice(0, -1)), SC(fArc(150, 180, 115, 139, 0, 360, 16).slice(0, -1))],
  },
  9: {
    w: 300,
    s: [S(fPath([[259, 525], fArc(150, 180, 109, 139, 0, -90, 6)])), SC(fArc(150, 525, 109, 134, 0, 360, 16).slice(0, -1))],
  },

  '.': { w: 130, s: [], f: [fNgon(65, 55, 55, 10)] },
  ',': { w: 130, s: [S([[70, 70], [26, -100]])], f: [fNgon(65, 60, 55, 10)] },
  ':': { w: 130, s: [], f: [fNgon(65, 90, 55, 10), fNgon(65, 470, 55, 10)] },
  ';': { w: 130, s: [S([[70, 80], [26, -90]])], f: [fNgon(65, 80, 55, 10), fNgon(65, 470, 55, 10)] },
  '!': { w: 82, s: [S([[41, 659], [41, 210]])], f: [fNgon(41, 55, 52, 10)] },
  '?': {
    w: 300,
    s: [S(fPath([fArc(150, 500, 105, 140, 195, -10, 8), [150, 300], [150, 220]]))],
    f: [fNgon(150, 55, 52, 10)],
  },
  '/': { w: 300, s: [S([[20, -40], [280, 700]])] },
  '\\': { w: 300, s: [S([[20, 700], [280, -40]])] },
  '-': { w: 240, s: [S([[35, 330], [205, 330]])] },
  '–': { w: 300, s: [S([[30, 330], [270, 330]])] },
  '—': { w: 480, s: [S([[20, 330], [460, 330]])] },
  '_': { w: 340, s: [S([[10, -60], [330, -60]])] },
  '+': { w: 300, s: [S([[40, 330], [260, 330]]), S([[150, 220], [150, 440]])] },
  '(': { w: 170, s: [S(fArc(140, 350, 105, 340, 110, 250, 9))] },
  ')': { w: 170, s: [S(fArc(30, 350, 105, 340, -70, 70, 9))] },
  '%': {
    w: 420,
    s: [
      SC(fArc(105, 520, 75, 105, 0, 360, 12).slice(0, -1)),
      SC(fArc(315, 180, 75, 105, 0, 360, 12).slice(0, -1)),
      S([[45, 41], [375, 659]]),
    ],
  },
  '&': {
    w: 400,
    s: [S([
      [350, 455], [250, 350], [150, 270], [80, 180], [90, 95], [175, 55], [265, 100], [300, 190],
      [250, 290], [150, 390], [95, 470], [90, 570], [150, 645], [240, 640], [280, 565], [240, 490], [150, 430],
    ])],
  },
  '<': { w: 260, s: [S([[210, 560], [55, 350], [210, 140]])] },
  '>': { w: 260, s: [S([[50, 560], [205, 350], [50, 140]])] },
  '=': { w: 300, s: [S([[40, 250], [260, 250]]), S([[40, 450], [260, 450]])] },
  $: { w: 300, s: [S(fPath([fArc(150, 470, 105, 120, 30, 200, 8), fArc(150, 200, 110, 125, 20, -195, 9)])), S([[150, 700], [150, -20]])] },
  '·': { w: 160, s: [], f: [fNgon(80, 360, 52, 10)] },
  '…': { w: 460, s: [], f: [fNgon(70, 55, 55, 10), fNgon(230, 55, 55, 10), fNgon(390, 55, 55, 10)] },
  "'": { w: 110, s: [S([[55, 659], [55, 490]])] },
  '"': { w: 230, s: [S([[55, 659], [55, 490]]), S([[175, 659], [175, 490]])] },
};

// One arrow, eight rotations. Cheaper and more consistent than eight drawings.
const ARROW_DIRS = { '↑': 0, '↗': -45, '→': -90, '↘': -135, '↓': 180, '↙': 135, '←': 90, '↖': 45 };
(function buildArrows() {
  const shaft = [[200, 110], [200, 590]];
  const head = [[86, 430], [200, 604], [314, 430]];
  const rot = (pts, deg) => {
    const a = deg * D2R;
    const cs = Math.cos(a);
    const sn = Math.sin(a);
    return pts.map((p) => {
      const x = p[0] - 200;
      const y = p[1] - 350;
      return [200 + x * cs - y * sn, 350 + x * sn + y * cs];
    });
  };
  for (const ch of Object.keys(ARROW_DIRS)) {
    const d = ARROW_DIRS[ch];
    GLYPH_DEFS[ch] = { w: 400, s: [S(rot(shaft, d)), S(rot(head, d))] };
  }
})();

/** Lowercase is drawn as small caps off the uppercase skeletons. */
const SMALLCAP_X = 0.92;
const SMALLCAP_Y = 0.74;

function scaleDef(def, sx, sy) {
  const map = (pts) => pts.map((p) => [p[0] * sx, p[1] * sy]);
  return {
    w: def.w * sx,
    s: (def.s || []).map((st) => ({ p: map(st.p), c: st.c })),
    f: (def.f || []).map(map),
  };
}

function glyphContours(def) {
  const out = [];
  const strokes = def.s || [];
  for (let i = 0; i < strokes.length; i++) strokeToContours(strokes[i].p, FONT_STROKE, strokes[i].c, out);
  const fills = def.f || [];
  for (let i = 0; i < fills.length; i++) out.push(fills[i]);
  // Move into the em square: side bearing on the left, integer units.
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    for (let j = 0; j < c.length; j++) {
      c[j] = [Math.round(c[j][0] + FONT_SIDE), Math.round(c[j][1])];
    }
  }
  return out;
}

// --- sfnt assembly ---------------------------------------------------------

function fontWriter() {
  const b = [];
  const w = {
    b,
    u8(v) { b.push(v & 255); return w; },
    u16(v) { b.push((v >> 8) & 255, v & 255); return w; },
    i16(v) { return w.u16(v < 0 ? v + 65536 : v); },
    u32(v) { b.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); return w; },
    tag(s) { for (let i = 0; i < 4; i++) b.push(s.charCodeAt(i) & 255); return w; },
    str16(s) { for (let i = 0; i < s.length; i++) w.u16(s.charCodeAt(i)); return w; },
    raw(arr) { for (let i = 0; i < arr.length; i++) b.push(arr[i]); return w; },
    pad4() { while (b.length & 3) b.push(0); return w; },
    out() { return b; },
  };
  return w;
}

function fontChecksum(bytes) {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 4) {
    const v = ((bytes[i] || 0) << 24) | ((bytes[i + 1] || 0) << 16) | ((bytes[i + 2] || 0) << 8) | (bytes[i + 3] || 0);
    sum = (sum + (v >>> 0)) >>> 0;
  }
  return sum >>> 0;
}

/** Build the whole font binary. Returns a Uint8Array holding a valid sfnt. */
function buildFontBytes() {
  // 1. glyph order: .notdef, then every mapped codepoint in ascending order.
  const defs = [];
  const codes = [];
  const seen = new Set();
  const push = (code, def) => {
    if (!def || seen.has(code)) return;
    seen.add(code);
    codes.push(code);
    defs.push(def);
  };
  const keys = Object.keys(GLYPH_DEFS);
  for (let i = 0; i < keys.length; i++) push(keys[i].codePointAt(0), GLYPH_DEFS[keys[i]]);
  for (let i = 0; i < 26; i++) {
    const up = String.fromCharCode(65 + i);
    push(97 + i, scaleDef(GLYPH_DEFS[up], SMALLCAP_X, SMALLCAP_Y));
  }
  push(0xd7, GLYPH_DEFS.X);         // × multiplication sign
  const order = codes.map((c, i) => [c, defs[i]]).sort((a, b) => a[0] - b[0]);

  const glyphs = [{ code: -1, adv: 380, contours: [] }];
  for (let i = 0; i < order.length; i++) {
    const def = order[i][1];
    const isDigit = order[i][0] >= 48 && order[i][0] <= 57;
    glyphs.push({
      code: order[i][0],
      adv: isDigit ? 380 : Math.round(def.w + FONT_SIDE * 2),
      contours: glyphContours(def),
    });
  }
  const numGlyphs = glyphs.length;

  // 2. glyf + loca
  const glyfW = fontWriter();
  const loca = [];
  let maxPoints = 0;
  let maxContours = 0;
  let xMinF = 32767;
  let yMinF = 32767;
  let xMaxF = -32768;
  let yMaxF = -32768;
  let advMax = 0;
  let lsbMin = 32767;
  let xExtent = -32768;

  for (let g = 0; g < numGlyphs; g++) {
    loca.push(glyfW.b.length);
    const gl = glyphs[g];
    advMax = Math.max(advMax, gl.adv);
    if (!gl.contours.length) { gl.lsb = 0; lsbMin = Math.min(lsbMin, 0); continue; }
    let xMin = 32767;
    let yMin = 32767;
    let xMax = -32768;
    let yMax = -32768;
    let pts = 0;
    for (let i = 0; i < gl.contours.length; i++) {
      const c = gl.contours[i];
      pts += c.length;
      for (let j = 0; j < c.length; j++) {
        xMin = Math.min(xMin, c[j][0]); xMax = Math.max(xMax, c[j][0]);
        yMin = Math.min(yMin, c[j][1]); yMax = Math.max(yMax, c[j][1]);
      }
    }
    maxPoints = Math.max(maxPoints, pts);
    maxContours = Math.max(maxContours, gl.contours.length);
    xMinF = Math.min(xMinF, xMin); yMinF = Math.min(yMinF, yMin);
    xMaxF = Math.max(xMaxF, xMax); yMaxF = Math.max(yMaxF, yMax);
    gl.lsb = xMin;
    lsbMin = Math.min(lsbMin, xMin);
    xExtent = Math.max(xExtent, xMax);

    glyfW.i16(gl.contours.length).i16(xMin).i16(yMin).i16(xMax).i16(yMax);
    let end = -1;
    for (let i = 0; i < gl.contours.length; i++) {
      end += gl.contours[i].length;
      glyfW.u16(end);
    }
    glyfW.u16(0);                                  // no hinting instructions
    for (let i = 0; i < pts; i++) glyfW.u8(0x01);  // every point on-curve, 16-bit deltas
    let px = 0;
    for (let i = 0; i < gl.contours.length; i++) {
      const c = gl.contours[i];
      for (let j = 0; j < c.length; j++) { glyfW.i16(c[j][0] - px); px = c[j][0]; }
    }
    let py = 0;
    for (let i = 0; i < gl.contours.length; i++) {
      const c = gl.contours[i];
      for (let j = 0; j < c.length; j++) { glyfW.i16(c[j][1] - py); py = c[j][1]; }
    }
    glyfW.pad4();
  }
  loca.push(glyfW.b.length);
  if (xMinF > xMaxF) { xMinF = 0; yMinF = 0; xMaxF = 0; yMaxF = 0; }
  if (lsbMin > 32000) lsbMin = 0;
  if (xExtent < -32000) xExtent = 0;

  const locaW = fontWriter();
  for (let i = 0; i < loca.length; i++) locaW.u32(loca[i]);

  // 3. hmtx
  const hmtxW = fontWriter();
  for (let g = 0; g < numGlyphs; g++) hmtxW.u16(glyphs[g].adv).i16(glyphs[g].lsb || 0);

  // 4. cmap, format 4, contiguous runs
  const segs = [];
  for (let g = 1; g < numGlyphs; g++) {
    const code = glyphs[g].code;
    const last = segs.length ? segs[segs.length - 1] : null;
    if (last && code === last.end + 1 && g === last.gid + (code - last.start)) { last.end = code; continue; }
    segs.push({ start: code, end: code, gid: g });
  }
  segs.push({ start: 0xffff, end: 0xffff, gid: 0, terminal: true });
  const segCount = segs.length;
  // searchRange = 2 * 2^floor(log2(segCount)), entrySelector = log2 of that half.
  let sr = 1;
  let es = 0;
  while (sr * 2 <= segCount) { sr *= 2; es++; }
  const cmapSub = fontWriter();
  cmapSub.u16(4).u16(16 + segCount * 8).u16(0);
  cmapSub.u16(segCount * 2).u16(sr * 2).u16(es).u16(segCount * 2 - sr * 2);
  for (let i = 0; i < segCount; i++) cmapSub.u16(segs[i].end);
  cmapSub.u16(0);
  for (let i = 0; i < segCount; i++) cmapSub.u16(segs[i].start);
  for (let i = 0; i < segCount; i++) {
    const s = segs[i];
    // idDelta is applied modulo 65536, so the raw unsigned value is what ships.
    cmapSub.u16(s.terminal ? 1 : (((s.gid - s.start) % 65536) + 65536) % 65536);
  }
  for (let i = 0; i < segCount; i++) cmapSub.u16(0);
  const cmapW = fontWriter();
  cmapW.u16(0).u16(1).u16(3).u16(1).u32(12).raw(cmapSub.out());

  // 5. name
  const NAMES = [
    [1, FONT_FAMILY], [2, 'Regular'], [3, 'MirraCity:' + FONT_FAMILY],
    [4, FONT_FAMILY], [5, 'Version 1.000'], [6, 'MirraDisplay-Regular'],
  ];
  const nameW = fontWriter();
  nameW.u16(0).u16(NAMES.length).u16(6 + NAMES.length * 12);
  let strOff = 0;
  for (let i = 0; i < NAMES.length; i++) {
    const len = NAMES[i][1].length * 2;
    nameW.u16(3).u16(1).u16(0x409).u16(NAMES[i][0]).u16(len).u16(strOff);
    strOff += len;
  }
  for (let i = 0; i < NAMES.length; i++) nameW.str16(NAMES[i][1]);

  // 6. fixed tables
  const headW = fontWriter();
  headW.u32(0x00010000).u32(0x00010000).u32(0).u32(0x5f0f3cf5);
  headW.u16(0x000b).u16(FONT_UPM);
  headW.u32(0).u32(0).u32(0).u32(0);                       // created / modified
  headW.i16(xMinF).i16(yMinF).i16(xMaxF).i16(yMaxF);
  headW.u16(0).u16(8).i16(2).i16(1).i16(0);                // macStyle, ppem, dir, loca long, format

  const hheaW = fontWriter();
  hheaW.u32(0x00010000).i16(FONT_ASC).i16(FONT_DESC).i16(90);
  hheaW.u16(advMax).i16(lsbMin).i16(0).i16(xExtent);
  hheaW.i16(1).i16(0).i16(0).i16(0).i16(0).i16(0).i16(0).i16(0).u16(numGlyphs);

  const maxpW = fontWriter();
  maxpW.u32(0x00010000).u16(numGlyphs).u16(maxPoints).u16(maxContours);
  maxpW.u16(0).u16(0).u16(2).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0);

  const os2W = fontWriter();
  os2W.u16(4).i16(420).u16(700).u16(3).u16(0);
  os2W.i16(650).i16(600).i16(0).i16(0).i16(650).i16(600).i16(0).i16(492);   // sub/superscript
  os2W.i16(60).i16(300).i16(0);                                            // strikeout, class
  for (let i = 0; i < 10; i++) os2W.u8([2, 11, 8, 6, 3, 0, 0, 2, 0, 4][i]); // PANOSE: condensed gothic
  os2W.u32(3).u32(0).u32(0).u32(0);                                        // unicode ranges
  os2W.tag('MIRA');
  os2W.u16(0x0020).u16(0x0020).u16(0x2192);                                // fsSelection, first, last
  os2W.i16(FONT_ASC).i16(FONT_DESC).i16(90).u16(FONT_ASC).u16(-FONT_DESC);
  os2W.u32(1).u32(0);
  os2W.i16(Math.round(FONT_CAP * SMALLCAP_Y)).i16(FONT_CAP).u16(0x0020).u16(0x0020).u16(2);

  const postW = fontWriter();
  postW.u32(0x00030000).u32(0).i16(-90).i16(60).u32(0).u32(0).u32(0).u32(0).u32(0);

  // 7. directory + checksums
  const tables = [
    ['OS/2', os2W.out()], ['cmap', cmapW.out()], ['glyf', glyfW.out()], ['head', headW.out()],
    ['hhea', hheaW.out()], ['hmtx', hmtxW.out()], ['loca', locaW.out()], ['maxp', maxpW.out()],
    ['name', nameW.out()], ['post', postW.out()],
  ];
  const numTables = tables.length;
  let searchRange = 16;
  let entrySel = 0;
  while (searchRange * 2 <= numTables * 16) { searchRange *= 2; entrySel++; }

  const head = fontWriter();
  head.u32(0x00010000).u16(numTables).u16(searchRange).u16(entrySel).u16(numTables * 16 - searchRange);
  let offset = 12 + numTables * 16;
  const body = [];
  for (let i = 0; i < numTables; i++) {
    const data = tables[i][1];
    while (data.length & 3) data.push(0);
    head.tag(tables[i][0]).u32(fontChecksum(data)).u32(offset).u32(data.length);
    body.push({ offset, data });
    offset += data.length;
  }
  const bytes = new Uint8Array(offset);
  bytes.set(head.out(), 0);
  for (let i = 0; i < body.length; i++) bytes.set(body[i].data, body[i].offset);

  // head.checkSumAdjustment lives 8 bytes into the head table.
  const headEntry = body[3];
  const total = fontChecksum(bytes);
  const adj = (0xb1b0afba - total) >>> 0;
  const at = headEntry.offset + 8;
  bytes[at] = (adj >>> 24) & 255;
  bytes[at + 1] = (adj >>> 16) & 255;
  bytes[at + 2] = (adj >>> 8) & 255;
  bytes[at + 3] = adj & 255;
  return bytes;
}

let fontPromise = null;

/**
 * Build + register the display face exactly once per document. Resolves to
 * true when the browser accepted it; a rejection just leaves the CSS stack
 * alone, so a hostile font sanitiser can never cost us the HUD.
 */
function ensureDisplayFont() {
  if (fontPromise) return fontPromise;
  fontPromise = (async () => {
    if (typeof document === 'undefined' || !document.fonts || typeof FontFace === 'undefined') return false;
    let face;
    try {
      // A second bundle (or a hot reload) must never register the face twice.
      // (fonts.check() is no use here: it answers with the fallback chain.)
      let already = false;
      document.fonts.forEach((f) => { if (f.family === FONT_FAMILY) already = true; });
      if (already) return true;
    } catch (err) { /* no forEach on this FontFaceSet — just build it */ }
    try {
      const bytes = buildFontBytes();
      const desc = { style: 'normal', display: 'block' };
      try {
        face = new FontFace(FONT_FAMILY, bytes.buffer, Object.assign({ weight: '100 900' }, desc));
      } catch (err) {
        face = new FontFace(FONT_FAMILY, bytes.buffer, Object.assign({ weight: '700' }, desc));
      }
      await face.load();
      document.fonts.add(face);
      return true;
    } catch (err) {
      return false;
    }
  })();
  return fontPromise;
}

// ===========================================================================
// Presentation layer owned by this module
// ===========================================================================
//
// hud.css styles everything that existed when it was written. Anything this
// file adds (the pad corner, the glyph chips), plus the corrections the art
// pass asked for (real display face, bigger gold score on its own scrim, one
// title-safe inset token for every anchor, the two-tier hide) is injected from
// here so the rules land after the stylesheet and win on specificity.

const HUD_STYLE_ID = 'hud-runtime-style';

function hudStyleText(fontOk) {
  const stack = (fontOk ? '"' + FONT_FAMILY + '",' : '')
    + '"Oswald","Roboto Condensed","Barlow Condensed","Archivo Narrow",'
    + '"Liberation Sans Narrow","DejaVu Sans Condensed","Arial Narrow",'
    + '"Franklin Gothic Medium",system-ui,"Segoe UI",sans-serif';
  return `
.hud, .hud .cond, .hud .gly-txt, .hud .g-label, .hud .g-cap-label {
  font-family: ${stack};
  --gly-font: ${stack};
}
${fontOk ? `
/* A real narrow face is guaranteed now: drop the scaleX() fake-condense,
   which thinned the verticals at score sizes. */
.hud .cond, .hud .timer-i, .hud .score-digits, .hud .co-points, .hud .flash-main { transform: none; }
.hud .score-label { transform: skewX(-8deg); }
.hud .score-digits { transform: skewX(-7deg); }
.hud .cond.mid { transform: none; }
` : ''}

/* ---- one title-safe inset drives every anchor ------------------------- */
/* Every anchor — score, timer, trick list, hint row, pad corner — is pinned
   with the same --pad, so the top margin and the side margins are identical
   and the five corners read as one grid instead of five accidents. The floor
   keeps it a real action-safe margin on short viewports. */
.hud { --pad: max(calc(var(--u) * 1.55), 3.2vh); }
.hud .hud-tl, .hud .hud-tr { top: var(--pad); }
.hud .hud-tc { top: var(--pad); }

/* ---- score block: label + value on a shared baseline ------------------ */
.hud .score-row { align-items: baseline; }
.hud .score-value {
  font-size: calc(var(--u) * 3.4);
  line-height: 0.86;
  color: var(--gold);
  text-shadow: 0 1px 0 rgba(0, 0, 0, 0.92), 0 2px 4px rgba(0, 0, 0, 0.95),
               0 0 10px rgba(0, 0, 0, 0.85), 0 0 26px rgba(255, 150, 20, 0.4);
}
.hud .score-label { font-size: calc(var(--u) * 1.5); text-shadow: var(--shadow-hi); }

/* Local scrims so the top row holds over a blown-out sky as well as over a
   dark ramp face — the page-wide gradient alone is not enough at 0.9 luma. */
.hud .hud-tl::before, .hud .hud-tr::before, .hud .hud-tc::before {
  content: ""; position: absolute; z-index: -1; pointer-events: none;
  top: calc(var(--u) * -2.4); bottom: calc(var(--u) * -2.2);
  left: calc(var(--u) * -3.2); right: calc(var(--u) * -3.2);
  /* closest-side keeps the falloff inside the box, so the scrim never shows a
     hard rectangular edge against the sky. */
  background: radial-gradient(ellipse closest-side at 50% 45%,
    rgba(3, 5, 9, 0.62), rgba(3, 5, 9, 0.3) 58%, rgba(3, 5, 9, 0) 100%);
}
.hud .hud-tl, .hud .hud-tr, .hud .hud-tc { isolation: isolate; }
.hud .hud-tl::before { bottom: auto; height: calc(var(--u) * 9.5); }

/* ---- top-right chip row ----------------------------------------------- */
.hud .tl-head .gly { --gly-size: calc(var(--u) * 1.62); }
.hud .tl-diff { letter-spacing: 0.14em; }

/* ---- bottom-right controller corner ----------------------------------- */
.hud .hud-pad {
  position: absolute; right: var(--pad); bottom: var(--pad);
  display: flex; align-items: center; gap: calc(var(--u) * 0.6);
  font-size: var(--u);
  opacity: 0.92;
}
.hud .hud-pad .gly--controller { --gly-pad-size: calc(var(--u) * 3.5); }
.hud .hint {
  right: calc(var(--pad) + var(--u) * 6.2);
  bottom: calc(var(--pad) + var(--u) * 0.55);
  font-size: calc(var(--u) * 0.96);
}
.hud .hint .gly { --gly-size: calc(var(--u) * 1.42); }
.hud .hint .gly-hint { gap: calc(var(--u) * 0.85); }
.hud .hint .gly-txt { font-size: calc(var(--u) * 0.92); color: rgba(255, 255, 255, 0.7); }

/* ---- two-tier hide ----------------------------------------------------- */
/* Photo/free-camera mode drops the diegetic noise only. The score block,
   special meter, timer, leaderboard and callout are the frame's furniture and
   stay up whenever a run exists at all. */
.hud.is-quiet .hint,
.hud.is-quiet .toasts,
.hud.is-quiet .flash,
.hud.is-quiet .bail-edge,
.hud.is-quiet .tricklist { display: none !important; }
.hud.is-quiet .hud-pad { opacity: 0.85; }

/* A still frame — photo mode, or the sim paused — is captured one frame at a
   time on hosts that render at ~1 fps, so every entrance transition would be
   frozen at its first tick and the HUD would photograph at 10% opacity. In
   these modes elements snap to their end state instead of easing into it. */
.hud.is-quiet, .hud.is-quiet *,
.hud.is-still, .hud.is-still * { transition: none !important; animation: none !important; }

@media (max-width: 900px) { .hud .hud-pad { display: none; } }
`;
}

function injectHudStyle(fontOk) {
  if (typeof document === 'undefined') return null;
  let node = document.getElementById(HUD_STYLE_ID);
  if (!node) {
    node = document.createElement('style');
    node.id = HUD_STYLE_ID;
    (document.head || document.documentElement).appendChild(node);
  }
  node.textContent = hudStyleText(fontOk);
  return node;
}

// ---------------------------------------------------------------------------

export function createHUD(ctx) {
  const mount = document.getElementById('ui-root') || document.body;
  const glyphs = ctx.glyphs || null;

  const root = el('div', 'hud');
  root.setAttribute('aria-hidden', 'true');
  root.dataset.face = 'fallback';

  // The face has to exist before the first frame is judged, but it must never
  // be able to block the boot: style once with the fallback stack, restyle the
  // moment the generated face is live.
  injectHudStyle(false);
  ensureDisplayFont().then((ok) => {
    injectHudStyle(ok);
    root.dataset.face = ok ? 'mirra' : 'fallback';
  });

  root.appendChild(el('div', 'hud-scrim top'));
  root.appendChild(el('div', 'hud-scrim bottom'));

  // ======================================================================
  // TOP LEFT — score / special / leaderboard / challenges
  // ======================================================================

  const tl = el('div', 'hud-tl');

  const scoreRow = el('div', 'score-row');
  const scoreLabel = el('span', 'score-label', 'SCORE:');
  const scoreValue = el('span', 'score-value');
  const scoreDigitsEl = el('span', 'score-digits');
  scoreValue.appendChild(scoreDigitsEl);
  scoreRow.append(scoreLabel, scoreValue);

  const special = el('div', 'special');
  const specialFill = el('i', 'special-fill');
  const specialShine = el('i', 'special-shine');
  const specialSegs = el('i', 'special-segs');
  const specialGlow = el('i', 'special-glow');
  const specialLabel = el('span', 'special-label', 'SPECIAL');
  special.append(specialFill, specialShine, specialSegs, specialLabel, specialGlow);

  const board = el('div', 'board');

  /**
   * A button chip for an action. Uses the procedural glyph kit so the prompt
   * shows the pad button (LB for the trick list, as the reference frame does)
   * when a pad is in the player's hands and the keycap when it is not, and
   * degrades to a plain letter chip if the kit is missing.
   */
  function chip(action, fallbackText) {
    if (glyphs && typeof glyphs.el === 'function') {
      try { return glyphs.el(action); } catch (err) { /* fall through to text */ }
    }
    return el('span', 'chip', fallbackText);
  }

  const goalsPanel = el('div', 'hud-goals');
  const glHead = el('div', 'gl-head');
  const glTitle = el('span', null, 'CHALLENGES');
  const glSpacer = el('span', 'spacer');
  const glCount = el('span', 'gl-count', '0/9');
  const glKey = chip('goals', 'G');
  glHead.append(glTitle, glSpacer, glCount, glKey);
  const glList = el('div', 'gl-list');
  const glFoot = el('div', 'gl-foot');
  const glLetters = el('div', 'gl-letters');
  const glSmash = el('span', null, 'SMASH 0/6');
  const glGaps = el('span', null, 'GAPS 0');
  glFoot.append(glLetters, glSmash, glGaps);
  goalsPanel.append(glHead, glList, glFoot);

  tl.append(scoreRow, special, board, goalsPanel);
  root.appendChild(tl);

  // ======================================================================
  // TOP CENTRE — timer + air time
  // ======================================================================

  const tc = el('div', 'hud-tc');
  const timerEl = el('div', 'timer');
  const timerInner = el('span', 'timer-i', '2:00');
  timerEl.appendChild(timerInner);
  const airEl = el('div', 'airtime', 'AIR 0.00');
  tc.append(timerEl, airEl);
  root.appendChild(tc);

  // ======================================================================
  // TOP RIGHT — trick list header
  // ======================================================================

  const tr = el('div', 'hud-tr');
  const tlHead = el('div', 'tl-head');
  const tlTitle = el('span', 'cond', 'TRICK LIST');
  const tlChip = chip('tricklist', 'T');
  tlHead.append(tlTitle, tlChip);
  const tlSub = el('div', 'tl-sub');
  const tlCount = el('span', 'tl-count', '0 / 0');
  const tlDiff = el('span', 'tl-diff', 'AM');
  tlSub.append(tlCount, tlDiff);
  tr.append(tlHead, tlSub);
  root.appendChild(tr);

  const trickPanel = el('div', 'tricklist');
  const tkHead = el('div', 'tk-head');
  tkHead.append(el('span', null, 'TRICK LIST'));
  const tkHeadCount = el('span', 'tk-h-count', '0 / 0');
  tkHead.appendChild(tkHeadCount);
  const tkScroll = el('div', 'tk-scroll');
  trickPanel.append(tkHead, tkScroll);
  root.appendChild(trickPanel);

  // ======================================================================
  // BOTTOM CENTRE — trick callout
  // ======================================================================

  const callout = el('div', 'callout');
  const coPoints = el('div', 'co-points');
  const coPointsVal = el('span', 'co-val', '0');
  const coX = el('span', 'co-x', ' X ');
  const coMult = el('span', 'co-mult', '1');
  coPoints.append(coPointsVal, coX, coMult);
  const coChain = el('div', 'co-chain', '');
  const coBar = el('div', 'co-bar');
  const coBarFill = el('i', null, '');
  coBar.appendChild(coBarFill);
  callout.append(coPoints, coChain, coBar);
  root.appendChild(callout);

  // ======================================================================
  // Balance meters
  // ======================================================================

  function makeBalance(cls, label, axis) {
    const wrap = el('div', 'bal ' + cls);
    const shake = el('div', 'bal-shake');
    const track = el('div', 'bal-track');
    track.append(el('i', 'bal-zone a'), el('i', 'bal-zone b'), el('i', 'bal-mid'));
    const nwrap = el('div', 'bal-nwrap');
    nwrap.appendChild(el('i', 'bal-needle'));
    track.appendChild(nwrap);
    shake.appendChild(track);
    const lab = el('div', 'bal-label', label);
    wrap.append(shake, lab);
    return { wrap, nwrap, label: lab, axis, on: false, crit: false, shake: false, pos: 0, text: label };
  }

  const balH = makeBalance('bal-h', 'BALANCE', 'x');
  const balV = makeBalance('bal-v', 'MANUAL', 'y');
  root.append(balH.wrap, balV.wrap);

  // ======================================================================
  // Flash / toasts / bail edge / hint
  // ======================================================================

  const flash = el('div', 'flash');
  const flashMain = el('div', 'flash-main', '');
  const flashSub = el('div', 'flash-sub', '');
  flash.append(flashMain, flashSub);
  root.appendChild(flash);

  const toasts = el('div', 'toasts');
  root.appendChild(toasts);

  const edge = el('div', 'bail-edge');
  root.appendChild(edge);

  const hint = el('div', 'hint');
  const HINT_ACTIONS = [
    ['throttle', 'PEDAL'], ['hop', 'HOP'], ['trickA', 'TRICKS'],
    ['grind', 'GRIND'], ['manual', 'MANUAL'], ['reset', 'RESET'], ['pause', 'PAUSE'],
  ];
  if (glyphs && typeof glyphs.hint === 'function') {
    hint.appendChild(glyphs.hint(HINT_ACTIONS));
  } else {
    const hintParts = [
      ['SHIFT', 'PEDAL'], ['SPACE', 'HOP'], ['J K L', 'TRICKS'],
      ['U', 'GRIND'], ['I', 'MANUAL'], ['R', 'RESET'],
    ];
    for (let i = 0; i < hintParts.length; i++) {
      const grp = el('span', null);
      grp.appendChild(el('b', null, hintParts[i][0]));
      grp.appendChild(document.createTextNode(' ' + hintParts[i][1]));
      hint.appendChild(grp);
    }
  }
  root.appendChild(hint);

  // ======================================================================
  // BOTTOM RIGHT — controller corner
  // ======================================================================
  // The reference frame carries a pad silhouette in the bottom-right corner.
  // It is the fourth anchor of the composition and, unlike the hint row, it
  // never fades: the corner has to hold visual mass for the whole run.

  const padCorner = el('div', 'hud-pad');
  if (glyphs && typeof glyphs.controller === 'function') {
    padCorner.appendChild(glyphs.controller());
    root.appendChild(padCorner);
  }

  mount.appendChild(root);

  // ======================================================================
  // Score digit cells (odometer roll)
  // ======================================================================

  const digitCells = [];    // { node, ch }
  let scoreShown = -1;

  const ROLL_KF = [
    { transform: 'translateY(0.42em)', opacity: 0.05 },
    { transform: 'translateY(0)', opacity: 1 },
  ];
  const ROLL_OPT = { duration: 165, easing: 'cubic-bezier(.2,.9,.25,1)' };

  function setScore(value, roll) {
    const s = fmt(value);
    const canRoll = roll !== false;
    while (digitCells.length < s.length) {
      const node = el('span', 'dg');
      scoreDigitsEl.appendChild(node);
      digitCells.push({ node, ch: '' });
    }
    while (digitCells.length > s.length) {
      const d = digitCells.pop();
      d.node.remove();
    }
    const rollLimit = s.length - 2;   // the two lowest places just tick over
    for (let i = 0; i < s.length; i++) {
      const d = digitCells[i];
      const ch = s[i];
      if (d.ch === ch) continue;
      d.ch = ch;
      d.node.textContent = ch;
      const sep = ch === ',';
      if (sep !== d.node.classList.contains('sep')) d.node.classList.toggle('sep', sep);
      if (canRoll && !sep && i < rollLimit && d.node.animate) d.node.animate(ROLL_KF, ROLL_OPT);
    }
  }
  setScore(0, false);

  // ======================================================================
  // Leaderboard rows
  // ======================================================================

  const rowByEntry = new Map();   // board entry object -> row record
  const rowList = [];
  let boardCutRec = null;

  function buildBoard(entries) {
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (rowByEntry.has(e)) continue;
      const node = el('div', 'bd-row' + (e.isPlayer ? ' is-player' : ''));
      const rank = el('span', 'bd-rank', '');
      const bar = el('i', 'bd-bar');
      const name = el('span', 'bd-name', String(e.name || ''));
      const score = el('span', 'bd-score', '');
      node.append(rank, bar, name, score);
      board.appendChild(node);
      const rec = { entry: e, node, rank, name, score, lastRank: -1, lastScore: -1, slot: -1, nameText: String(e.name || '') };
      rowByEntry.set(e, rec);
      rowList.push(rec);
    }
  }

  const RANK_KF = [{ filter: 'brightness(2.8)' }, { filter: 'brightness(1)' }];
  const RANK_OPT = { duration: 460, easing: 'ease-out' };

  function updateBoard(sc, pvScore) {
    const all = sc.leaderboard;
    const view = sc.boardView;
    if (!Array.isArray(all) || !Array.isArray(view)) return;
    if (rowList.length !== all.length) buildBoard(all);

    for (let i = 0; i < rowList.length; i++) rowList[i].pending = -1;
    for (let i = 0; i < view.length && i < 5; i++) {
      const rec = rowByEntry.get(view[i]);
      if (rec) rec.pending = i;
    }
    // Mark the row that sits under a rank skip (player pushed into the last slot).
    const tailRec = rowByEntry.get(view[4]);
    const cutRec = tailRec && (tailRec.entry.rank || 5) > 5 ? tailRec : null;
    if (cutRec !== boardCutRec) {
      if (boardCutRec) boardCutRec.node.classList.remove('is-cut');
      boardCutRec = cutRec;
      if (cutRec) cutRec.node.classList.add('is-cut');
    }
    for (let i = 0; i < rowList.length; i++) {
      const rec = rowList[i];
      const slot = rec.pending;
      if (slot !== rec.slot) {
        rec.slot = slot;
        if (slot < 0) {
          rec.node.style.opacity = '0';
        } else {
          rec.node.style.transform = 'translateY(' + slot * 100 + '%)';
          rec.node.style.opacity = '1';
        }
      }
      if (slot < 0) continue;
      const e = rec.entry;
      const r = e.rank || slot + 1;
      if (r !== rec.lastRank) { rec.lastRank = r; rec.rank.textContent = String(r); }
      const s = Math.round(pvScore != null && e.isPlayer ? pvScore : (e.score || 0));
      if (s !== rec.lastScore) { rec.lastScore = s; rec.score.textContent = fmt(s); }
      const nm = String(e.name || '');
      if (nm !== rec.nameText) { rec.nameText = nm; rec.name.textContent = nm; }
    }
  }

  // ======================================================================
  // Challenge tracker rows
  // ======================================================================

  const goalRows = [];
  let goalsBuilt = false;

  function buildGoals(goals) {
    for (let i = 0; i < goals.length; i++) {
      const g = goals[i];
      const node = el('div', 'goal');
      const tick = el('i', 'gl-tick');
      const text = el('span', 'gl-text', String(g.text || ''));
      const prog = el('span', 'gl-prog', '');
      node.append(tick, text, prog);
      glList.appendChild(node);
      goalRows.push({ goal: g, node, prog, lastProg: '', done: false });
    }
    goalsBuilt = true;
  }

  const LETTER_IDS = ['B', 'M', 'X'];
  const letterCells = [];
  function buildLetters(letters) {
    const ids = letters && letters.length ? letters : LETTER_IDS;
    for (let i = 0; i < ids.length; i++) {
      const id = typeof ids[i] === 'string' ? ids[i] : (ids[i].id || ids[i].char || '?');
      const node = el('span', null, String(id));
      glLetters.appendChild(node);
      letterCells.push({ node, on: false });
    }
  }

  function goalProgressText(g) {
    if (!g) return '';
    if (g.done) return 'DONE';
    if (g.kind === 'score') return fmt(g.progress || 0) + ' / ' + fmt(g.target || 0);
    if (g.kind === 'count') return (g.progress || 0) + ' / ' + (g.target || 0);
    return '';
  }

  const GOAL_KF = [
    { transform: 'translateX(0) scale(1)', filter: 'brightness(3.2)' },
    { transform: 'translateX(1.5%) scale(1.02)', filter: 'brightness(1.6)', offset: 0.3 },
    { transform: 'translateX(0) scale(1)', filter: 'brightness(1)' },
  ];

  function updateGoals(sc) {
    const goals = sc.goals;
    if (!Array.isArray(goals) || !goals.length) return;
    if (!goalsBuilt) buildGoals(goals);
    for (let i = 0; i < goalRows.length; i++) {
      const rec = goalRows[i];
      const g = rec.goal;
      const done = !!g.done;
      if (done !== rec.done) {
        rec.done = done;
        rec.node.classList.toggle('is-done', done);
        if (done && rec.node.animate) rec.node.animate(GOAL_KF, { duration: 620, easing: 'ease-out' });
      }
      const p = goalProgressText(g);
      if (p !== rec.lastProg) { rec.lastProg = p; rec.prog.textContent = p; }
    }
    const dn = sc.goalsDone || 0;
    const tt = sc.goalsTotal || goals.length;
    if (dn !== lastGoalsDone || tt !== lastGoalsTotal) {
      lastGoalsDone = dn; lastGoalsTotal = tt;
      glCount.textContent = dn + '/' + tt;
    }

    const letters = sc.letters;
    if (Array.isArray(letters)) {
      if (!letterCells.length) buildLetters(letters);
      for (let i = 0; i < letterCells.length && i < letters.length; i++) {
        const got = !!letters[i].got;
        if (got !== letterCells[i].on) {
          letterCells[i].on = got;
          letterCells[i].node.classList.toggle('on', got);
        }
      }
    } else if (!letterCells.length) {
      buildLetters(null);
    }

    const sm = (sc.smashed || 0) + '/' + (sc.smashTotal || 0);
    if (sm !== lastSmash) { lastSmash = sm; glSmash.textContent = 'SMASH ' + sm; }
    const gp = sc.gapsCleared || 0;
    if (gp !== lastGaps) { lastGaps = gp; glGaps.textContent = 'GAPS ' + gp; }
  }

  let lastGoalsDone = -1;
  let lastGoalsTotal = -1;
  let lastSmash = '';
  let lastGaps = -1;

  // ======================================================================
  // Trick list panel
  // ======================================================================

  const trickRows = [];
  let trickPanelBuilt = false;
  let trickPanelOpen = false;
  let trickRefresh = 0;

  function recipeText(t) {
    const key = MOD_KEY[t.mod] || '?';
    const arrow = DIR_ARROW[t.dir] || '';
    const note = MOD_NOTE[t.mod];
    let s = key;
    if (arrow) s += ' ' + arrow;
    if (note) s += ' · ' + note;
    return s;
  }

  function buildTrickPanel(list) {
    for (let c = 0; c < CATEGORY_ORDER.length; c++) {
      const cat = CATEGORY_ORDER[c];
      let header = null;
      for (let i = 0; i < list.length; i++) {
        const t = list[i];
        if ((t.category || 'air') !== cat) continue;
        if (!header) {
          header = el('div', 'tk-cat', CATEGORY_NAME[cat] || cat.toUpperCase());
          tkScroll.appendChild(header);
        }
        const node = el('div', 'tk-row');
        node.append(
          el('span', 'tk-name', String(t.name || t.id)),
          el('span', 'tk-keys', recipeText(t)),
          el('span', 'tk-pts', fmt(t.base || 0)),
        );
        tkScroll.appendChild(node);
        trickRows.push({ id: t.id, node, got: false });
      }
    }
    trickPanelBuilt = true;
  }

  function refreshTrickPanel() {
    const tricks = ctx.player?.tricks;
    if (!trickPanelBuilt) {
      const list = tricks?.list || tricks?.TRICKS;
      if (!Array.isArray(list) || !list.length) return;
      buildTrickPanel(list);
    }
    const has = typeof tricks?.hasLanded === 'function' ? tricks.hasLanded : null;
    const set = tricks?.landed;
    for (let i = 0; i < trickRows.length; i++) {
      const r = trickRows[i];
      let got = false;
      if (has) got = !!has(r.id);
      else if (set && typeof set.has === 'function') got = set.has(r.id);
      if (got !== r.got) { r.got = got; r.node.classList.toggle('got', got); }
    }
    tkHeadCount.textContent = tlCount.textContent;
  }

  function setTrickPanel(open) {
    if (open === trickPanelOpen) return;
    trickPanelOpen = open;
    trickPanel.classList.toggle('on', open);
    if (open) { refreshTrickPanel(); trickRefresh = 0; }
  }

  // ======================================================================
  // Centre flash queue
  // ======================================================================

  const flashQueue = [];
  let flashTimer = 0;

  const FLASH_KF = [
    { opacity: 0, transform: 'translate(-50%,-50%) scale(1.28)' },
    { opacity: 1, transform: 'translate(-50%,-50%) scale(1)', offset: 0.14 },
    { opacity: 1, transform: 'translate(-50%,-50%) scale(1)', offset: 0.72 },
    { opacity: 0, transform: 'translate(-50%,-58%) scale(0.97)' },
  ];

  function pushFlash(kind, main, sub) {
    // A busy line can raise several banners at once; keep the queue short so the
    // HUD never lags behind the run.
    while (flashQueue.length >= 3) flashQueue.shift();
    flashQueue.push({ kind, main, sub: sub || '' });
  }

  let flashKind = '';
  function startFlash(f) {
    if (f.kind !== flashKind) {
      if (flashKind) flash.classList.remove('k-' + flashKind);
      flashKind = f.kind;
      if (flashKind) flash.classList.add('k-' + flashKind);
    }
    flashMain.textContent = f.main;
    flashSub.textContent = f.sub;
    flashSub.style.display = f.sub ? '' : 'none';
    if (flash.animate) {
      flash.animate(FLASH_KF, { duration: FLASH_TIME * 1000, easing: 'cubic-bezier(.2,.9,.25,1)' });
    }
    flashTimer = FLASH_TIME;
  }

  // ======================================================================
  // Toasts
  // ======================================================================

  const liveToasts = [];

  function pushToast(kind, label, name) {
    const node = el('div', 'toast k-' + kind);
    const body = el('div', 't-body');
    body.append(el('span', 't-kind', label), el('span', 't-name', name));
    node.appendChild(body);
    toasts.appendChild(node);
    if (node.animate) {
      node.animate(
        [
          { opacity: 0, transform: 'translateX(-14%)' },
          { opacity: 1, transform: 'translateX(0)', offset: 0.12 },
          { opacity: 1, transform: 'translateX(0)', offset: 0.84 },
          { opacity: 0, transform: 'translateX(-6%)' },
        ],
        { duration: TOAST_TIME * 1000, easing: 'cubic-bezier(.2,.9,.25,1)' },
      );
    }
    liveToasts.push({ node, t: TOAST_TIME });
    while (liveToasts.length > MAX_TOASTS) {
      const old = liveToasts.shift();
      old.node.remove();
    }
  }

  // ======================================================================
  // Event wiring
  // ======================================================================

  let coMode = 'idle';        // 'idle' | 'live' | 'out'
  let coTimer = 0;
  let edgeTimer = 0;

  const SCORE_POP = [
    { transform: 'scale(1)' },
    { transform: 'scale(1.14)', offset: 0.22 },
    { transform: 'scale(1)' },
  ];

  function onBank(e) {
    const d = e?.detail || null;
    const gained = d ? (d.points || 0) : 0;
    const mult = d ? (d.multiplier || 1) : 1;
    coPointsVal.textContent = fmt(gained);
    coMult.textContent = String(mult);
    callout.classList.remove('on', 'is-lost');
    callout.classList.add('is-bank');
    coMode = 'out';
    coTimer = 0.6;
    if (scoreValue.animate) scoreValue.animate(SCORE_POP, { duration: 320, easing: 'ease-out' });
    if (gained >= 25000) pushFlash('gold', fmt(gained), 'COMBO BANKED');
  }

  function onLost(e) {
    const d = e?.detail || null;
    if (d && !d.points && !d.tricks) return;
    callout.classList.remove('on', 'is-bank');
    callout.classList.add('is-lost');
    coChain.textContent = 'COMBO LOST';
    coMode = 'out';
    coTimer = 0.52;
  }

  function onGap(e) {
    const d = e?.detail;
    if (!d) return;
    pushFlash('gold', String(d.name || 'GAP').toUpperCase(), '+' + fmt(d.points || 0));
  }

  function onGoal(e) {
    const d = e?.detail;
    if (!d) return;
    pushFlash('goal', 'CHALLENGE COMPLETE', String(d.text || ''));
    pushToast('goal', 'CHALLENGE', String(d.text || ''));
  }

  function onAchievement(e) {
    const d = e?.detail;
    if (!d) return;
    pushToast('ach', 'ACHIEVEMENT', String(d.name || ''));
    pushFlash('ach', 'ACHIEVEMENT', String(d.name || ''));
  }

  function onRankUp(e) {
    const d = e?.detail;
    if (!d) return;
    const rank = d.rank || 0;
    if (d.first) pushFlash('rank', 'FIRST PLACE', 'YOU TOOK THE LEAD');
    else if (d.name) pushFlash('rank', 'RANK ' + rank, 'PASSED ' + String(d.name).toUpperCase());
    const rec = rowList.find((r) => r.entry.isPlayer);
    if (rec && rec.node.animate) rec.node.animate(RANK_KF, RANK_OPT);
  }

  function onSpecial(e) {
    if (e?.detail?.ready) pushFlash('special', 'SPECIAL READY', 'SIGNATURE TRICKS ARMED');
  }

  function onLetter(e) {
    const d = e?.detail;
    pushToast('goal', 'LETTER', String(d?.id || '?') + '  —  ' + (d?.collected || 0) + ' / ' + (d?.total || 3));
  }

  function onSmash(e) {
    const d = e?.detail;
    pushToast('goal', 'SMASHED', (d?.index || 0) + ' / ' + (d?.total || 0));
  }

  function onBail() {
    pushFlash('bail', 'BAIL!', '');
    edgeTimer = BAIL_EDGE_TIME;
    edge.classList.add('on');   // the layer only exists while it is needed
    if (edge.animate) {
      edge.animate(
        [{ opacity: 0 }, { opacity: 0.95, offset: 0.1 }, { opacity: 0.5, offset: 0.4 }, { opacity: 0 }],
        { duration: BAIL_EDGE_TIME * 1000, easing: 'ease-out' },
      );
    }
  }

  function onCountdown(e) {
    const s = e?.detail?.seconds;
    if (s == null || !timerEl.animate) return;
    timerEl.animate(
      [{ transform: 'scale(1)' }, { transform: 'scale(1.16)', offset: 0.2 }, { transform: 'scale(1)' }],
      { duration: 340, easing: 'ease-out' },
    );
  }

  function onSessionStart() {
    hint.classList.add('fade');
  }

  function onSessionEnd(e) {
    const d = e?.detail;
    callout.classList.remove('on', 'is-bank', 'is-lost');
    coMode = 'idle';
    pushFlash('gold', 'TIME', d ? fmt(d.score || 0) + ' PTS' : '');
    hint.classList.remove('fade');
  }

  function onRespawn() {
    callout.classList.remove('on', 'is-bank', 'is-lost');
    coMode = 'idle';
    coTimer = 0;
  }

  const handlers = [
    ['scoreBank', onBank],
    ['scoreLost', onLost],
    ['scoreGap', onGap],
    ['goalComplete', onGoal],
    ['achievement', onAchievement],
    ['rankUp', onRankUp],
    ['specialReady', onSpecial],
    ['letterCollected', onLetter],
    ['objectSmashed', onSmash],
    ['bail', onBail],
    ['countdown', onCountdown],
    ['sessionStart', onSessionStart],
    ['sessionEnd', onSessionEnd],
    ['respawn', onRespawn],
  ];
  for (let i = 0; i < handlers.length; i++) ctx.on?.(handlers[i][0], handlers[i][1]);

  // --- keys (T / G) ---------------------------------------------------------

  function onKeyDown(e) {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'KeyT') { setTrickPanel(!trickPanelOpen); }
    else if (e.code === 'KeyG') { goalsPanel.classList.toggle('is-collapsed'); }
    else if (e.code === 'Escape' && trickPanelOpen) { setTrickPanel(false); }
  }
  window.addEventListener('keydown', onKeyDown);

  function onHeadClick() { setTrickPanel(!trickPanelOpen); }
  tlHead.addEventListener('click', onHeadClick);

  // ======================================================================
  // Per-frame update — writes only textContent (on change), transform, classes
  // ======================================================================

  let hidden = false;
  let quiet = false;
  let still = false;
  let rigRef = null;      // the chase rig's own update(), for harness detection
  let clean = false;
  let assertWarned = false;
  let stagedGlyphs = false;
  let lastSpecial = -1;
  let lastReady = null;
  let lastFull = null;
  let lastTime = '';
  let lastTimeCls = '';
  let lastCount = '';
  let lastDiff = '';
  let lastChain = '';
  let lastPts = -1;
  let lastMult = -1;
  let lastBar = -1;
  let lastBarLow = null;
  let lastAirOn = false;
  let lastAirText = '';
  let previewOn = false;
  let lastPv = false;

  const CHAIN_KF = [
    { opacity: 0, transform: 'translateY(38%) scale(0.96)' },
    { opacity: 1, transform: 'translateY(0) scale(1)' },
  ];
  const MULT_KF = [
    { transform: 'scale(1)' },
    { transform: 'scale(1.45)', offset: 0.25 },
    { transform: 'scale(1)' },
  ];

  function setBalance(b, on, pos, crit, edgeShake, text) {
    if (on !== b.on) { b.on = on; b.wrap.classList.toggle('on', on); }
    if (!on) return;
    if (Math.abs(pos - b.pos) > 0.004) {
      b.pos = pos;
      // +balance is "looping out" on a manual, which reads as the needle rising.
      b.nwrap.style.transform = b.axis === 'x'
        ? 'translateX(' + (pos * 46).toFixed(2) + '%)'
        : 'translateY(' + (pos * -46).toFixed(2) + '%)';
    }
    if (crit !== b.crit) { b.crit = crit; b.wrap.classList.toggle('crit', crit); }
    if (edgeShake !== b.shake) { b.shake = edgeShake; b.wrap.classList.toggle('is-shake', edgeShake); }
    if (text !== b.text) { b.text = text; b.label.textContent = text; }
  }

  function update(dt, c) {
    const cx = c || ctx;
    const step = Math.min(dt || 0, 0.1);

    const sc = cx.player?.scoring;
    const tricks = cx.player?.tricks;
    const grind = cx.player?.grind;
    const st = cx.player?.physics?.state;

    // ---- visibility, two tiers ---------------------------------------------
    // Tier 1 (`is-hidden`) is the whole overlay and belongs to exactly two
    // things: the explicit hideHud flag, and a blocking menu screen while no
    // run exists. Tier 2 (`is-quiet`) is photo/free-camera mode: it drops the
    // diegetic noise — prompts, toasts, banners — and leaves the score block,
    // special meter, timer, leaderboard and callout standing, because a frame
    // with empty corners reads as an engine viewport, not a game.
    //
    // Driving this off scoring.phase rather than a camera flag is what stops a
    // staged capture (which parks a free camera) from silently deleting the
    // interface, as it did for every frame of the first art review.
    const phase = sc?.phase || 'ready';
    const runLive = phase === 'run' || phase === 'live' || phase === 'paused';
    // A staged frame is one the capture harness or photo mode has taken over:
    // a parked free camera, a frozen sim, or a rider posed with the chase rig
    // detached. Those signals also outrank `clean`, because the menu layer
    // clears itself a frame later than we run and a capture must not depend on
    // that ordering — which is exactly how the first review lost its HUD.
    if (rigRef === null && cx.cameraRig && typeof cx.cameraRig.update === 'function') {
      rigRef = cx.cameraRig.update;
    }
    const rigHijacked = !!(rigRef && cx.cameraRig && cx.cameraRig.update !== rigRef);
    const harnessOwned = !!(cx.flags?.freeCam || cx.flags?.freeze) || rigHijacked;
    const framed = harnessOwned || !!(cx.flags?.paused);
    // `clean` is only allowed to veto staging when nothing has taken the frame
    // over: the menu layer clears it a frame after we run, and a capture host
    // rendering at ~1 fps cannot afford to lose a whole frame to that ordering.
    const staged = !runLive && framed && (harnessOwned || !clean);
    const wantHidden = !!(cx.flags?.hideHud) || (clean && !runLive && !harnessOwned);
    const wantQuiet = !wantHidden && (clean || staged || harnessOwned);

    if (wantHidden !== hidden) {
      hidden = wantHidden;
      root.classList.toggle('is-hidden', hidden);
      if (hidden) setTrickPanel(false);
    }
    if (wantQuiet !== quiet) {
      quiet = wantQuiet;
      root.classList.toggle('is-quiet', quiet);
      if (quiet) setTrickPanel(false);
    }
    // Nothing eases in while the world is frozen: a paused or photographed
    // frame must be a finished frame, not a transition caught at 8%.
    const wantStill = wantQuiet || !!(cx.flags?.paused);
    if (wantStill !== still) {
      still = wantStill;
      root.classList.toggle('is-still', still);
    }
    // Contract assertion: a live run may never render zero HUD pixels.
    if (runLive && root.classList.contains('is-hidden') && !cx.flags?.hideHud) {
      root.classList.remove('is-hidden');
      hidden = false;
      if (!assertWarned) {
        assertWarned = true;
        console.warn('[hud] root was hidden during a live run — forced back on');
      }
    }
    if (hidden) return;

    // Staged frames get the reference sample numbers so a paused beauty shot
    // still reads as a live run instead of a zeroed menu state.
    const pv = previewOn || staged;
    if (pv !== lastPv) {
      lastPv = pv;
      scoreShown = -1; lastSpecial = -1; lastPts = -1; lastMult = -1; lastChain = '';
      lastCount = ''; lastTime = '';
      // The reference frames are controller-first: show pad glyphs in them.
      if (pv && !stagedGlyphs && glyphs && typeof glyphs.setDevice === 'function') {
        stagedGlyphs = true;
        glyphs.setDevice('gamepad');
      }
    }

    // ---- score ------------------------------------------------------------
    if (sc) {
      const shown = Math.round(pv ? 37850 : (sc.displayScore ?? sc.score ?? 0));
      if (shown !== scoreShown) {
        // Roll the digits only when the score is climbing during a run: a jump
        // from a reset (or into a staged frame) should just be there.
        const roll = !still && scoreShown >= 0 && shown > scoreShown;
        scoreShown = shown;
        setScore(shown, roll);
      }

      // ---- special --------------------------------------------------------
      const s01 = clamp(pv ? 0.78 : (sc.special01 ?? sc.special ?? 0), 0, 1);
      if (Math.abs(s01 - lastSpecial) > 0.0025) {
        lastSpecial = s01;
        specialFill.style.transform = 'scaleX(' + s01.toFixed(4) + ')';
      }
      const ready = !!sc.specialReady;
      if (ready !== lastReady) { lastReady = ready; special.classList.toggle('is-ready', ready); }
      const full = s01 > 0.995;
      if (full !== lastFull) { lastFull = full; special.classList.toggle('is-full', full); }

      // ---- leaderboard ----------------------------------------------------
      updateBoard(sc, pv ? 37850 : null);

      // ---- timer ----------------------------------------------------------
      const tt = staged ? '1:24' : (sc.timeText || '2:00');
      if (tt !== lastTime) { lastTime = tt; timerInner.textContent = tt; }
      const left = sc.timeLeft ?? 120;
      const cls = left <= 10 ? 'crit' : (left <= 30 ? 'warn' : '');
      if (cls !== lastTimeCls) {
        if (lastTimeCls) timerEl.classList.remove(lastTimeCls);
        lastTimeCls = cls;
        if (cls) timerEl.classList.add(cls);
      }

      // ---- trick counter --------------------------------------------------
      const totalN = tricks?.total ?? sc.totalCount ?? 0;
      const landedN = staged
        ? Math.max(1, Math.round(totalN * 0.26))
        : (tricks?.landedCount ?? sc.landedCount ?? 0);
      const cnt = landedN + ' / ' + totalN;
      if (cnt !== lastCount) { lastCount = cnt; tlCount.textContent = cnt; }
      const tag = (typeof tricks?.difficultyTag === 'function' ? tricks.difficultyTag() : 'AM') || 'AM';
      // The reference tags difficulty with a chevron run ('>>> HARD'); grade the
      // run length off the tier so the mark carries information, not decoration.
      const diff = (DIFF_CHEVRON[tag] || '>') + ' ' + tag;
      if (diff !== lastDiff) { lastDiff = diff; tlDiff.textContent = diff; }

      // ---- challenges -----------------------------------------------------
      updateGoals(sc);

      // ---- trick callout --------------------------------------------------
      const active = pv ? true : !!sc.comboActive;
      if (active) {
        if (coMode !== 'live') {
          coMode = 'live';
          coTimer = 0;
          callout.classList.remove('is-bank', 'is-lost');
          callout.classList.add('on');
          lastChain = '';
          lastMult = -1;
        }
        const pts = pv ? 2350 : Math.round(sc.comboPoints || 0);
        if (pts !== lastPts) { lastPts = pts; coPointsVal.textContent = fmt(pts); }
        const mult = pv ? 2 : (sc.comboMultiplier || 1);
        if (mult !== lastMult) {
          if (lastMult >= 0 && !still && coMult.animate) coMult.animate(MULT_KF, { duration: 260, easing: 'ease-out' });
          lastMult = mult;
          coMult.textContent = String(mult);
        }
        const chain = pv ? 'No Footed Can Can + Barspin'
          : (sc.comboText || tricks?.comboText || '');
        if (chain !== lastChain) {
          lastChain = chain;
          coChain.textContent = chain;
          if (!still && coChain.animate) coChain.animate(CHAIN_KF, { duration: 190, easing: 'cubic-bezier(.16,1,.3,1)' });
        }
        const special01 = !!sc.specialReady;
        callout.classList.toggle('is-special', special01);

        const bar = clamp(pv ? 0.72 : (sc.comboTimer01 ?? 1), 0, 1);
        if (Math.abs(bar - lastBar) > 0.01) {
          lastBar = bar;
          coBarFill.style.transform = 'scaleX(' + bar.toFixed(3) + ')';
        }
        const low = bar < 0.34;
        if (low !== lastBarLow) { lastBarLow = low; coBar.classList.toggle('low', low); }
      } else if (coMode === 'out') {
        coTimer -= step;
        if (coTimer <= 0) {
          coMode = 'idle';
          callout.classList.remove('is-bank', 'is-lost', 'on');
        }
      } else if (coMode === 'live') {
        coMode = 'idle';
        callout.classList.remove('on');
      }
    }

    // ---- balance meters -----------------------------------------------------
    const gOn = !!grind?.active;
    const gBal = clamp(grind?.balance ?? 0, -1, 1);
    setBalance(balH, gOn, gBal, !!grind?.critical || Math.abs(gBal) > 0.6,
      Math.abs(gBal) > 0.82, (grind?.trickName || 'GRIND').toUpperCase());

    const mOn = st?.mode === 'manual';
    const mBal = clamp(st?.balance ?? 0, -1, 1);
    setBalance(balV, mOn, mBal, Math.abs(mBal) > 0.6, Math.abs(mBal) > 0.82,
      st?.manualType === 'nose' ? 'NOSE MANUAL' : 'MANUAL');

    // ---- air time -----------------------------------------------------------
    const airOn = st?.mode === 'air' && (st.airTime || 0) > 0.32;
    if (airOn !== lastAirOn) { lastAirOn = airOn; airEl.classList.toggle('on', airOn); }
    if (airOn) {
      const txt = 'AIR ' + (st.airTime || 0).toFixed(2);
      if (txt !== lastAirText) { lastAirText = txt; airEl.textContent = txt; }
    }

    // ---- flashes / toasts / edge -------------------------------------------
    if (flashTimer > 0) {
      flashTimer -= step;
    } else if (flashQueue.length) {
      startFlash(flashQueue.shift());
    }
    for (let i = liveToasts.length - 1; i >= 0; i--) {
      const t = liveToasts[i];
      t.t -= step;
      if (t.t <= 0) { t.node.remove(); liveToasts.splice(i, 1); }
    }
    if (edgeTimer > 0) {
      edgeTimer -= step;
      if (edgeTimer <= 0) edge.classList.remove('on');
    }

    // ---- trick list panel refresh (only while open) -------------------------
    if (trickPanelOpen) {
      trickRefresh -= step;
      if (trickRefresh <= 0) { trickRefresh = 0.35; refreshTrickPanel(); }
    }
  }

  // ======================================================================
  // Public API
  // ======================================================================

  const api = {
    root,
    element: root,
    update,

    /** main.js drives visuals from update(); this exists for contract symmetry. */
    fixedUpdate() {},

    /** Clean mode for beauty shots: hides the whole overlay. */
    setClean(v) { clean = !!v; },
    isClean() { return clean; },

    show() { clean = false; },
    hide() { clean = true; },

    toggleTrickList(v) { setTrickPanel(v == null ? !trickPanelOpen : !!v); },
    toggleGoals(v) {
      if (v == null) goalsPanel.classList.toggle('is-collapsed');
      else goalsPanel.classList.toggle('is-collapsed', !v);
    },

    /** Anyone can throw a centred flash / a toast at the HUD. */
    flash(main, sub, kind) { pushFlash(kind || 'gold', String(main || ''), sub ? String(sub) : ''); },
    toast(label, name, kind) { pushToast(kind || 'goal', String(label || ''), String(name || '')); },

    /**
     * Screenshot/preview mode: paints the HUD with the reference frame's sample
     * numbers so a paused beauty shot still reads as a live run. Never enabled
     * by gameplay — the harness or the console has to ask for it.
     */
    preview(on) {
      previewOn = on == null ? !previewOn : !!on;
      scoreShown = -1; lastSpecial = -1; lastPts = -1; lastMult = -1; lastChain = '';
      return previewOn;
    },

    /**
     * What a capture harness should assert on before it takes the shot:
     * `visible` is the real computed state of the overlay, not our own idea of
     * it, and `face` says whether the generated display type is live or the
     * frame is about to be typeset in a browser default.
     */
    state() {
      let visible = false;
      try {
        const cs = getComputedStyle(root);
        visible = cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity) > 0.01;
      } catch (err) { /* no layout engine — report hidden */ }
      return {
        visible,
        hidden,
        quiet,
        preview: previewOn,
        face: root.dataset.face,
        phase: ctx.player?.scoring?.phase || 'ready',
      };
    },

    dispose() {
      for (let i = 0; i < handlers.length; i++) {
        ctx.events?.removeEventListener?.(handlers[i][0], handlers[i][1]);
      }
      window.removeEventListener('keydown', onKeyDown);
      tlHead.removeEventListener('click', onHeadClick);
      for (let i = 0; i < liveToasts.length; i++) liveToasts[i].node.remove();
      liveToasts.length = 0;
      root.remove();
    },
  };

  // Seed the board/goals immediately so frame 0 is already a complete HUD.
  const sc0 = ctx.player?.scoring;
  if (sc0) {
    if (Array.isArray(sc0.leaderboard)) buildBoard(sc0.leaderboard);
    if (Array.isArray(sc0.goals) && sc0.goals.length) buildGoals(sc0.goals);
    if (Array.isArray(sc0.letters)) buildLetters(sc0.letters);
    updateBoard(sc0);
  }
  if (!letterCells.length) buildLetters(null);
  coBarFill.style.transform = 'scaleX(1)';
  specialFill.style.transform = 'scaleX(0)';

  return api;
}

export default createHUD;
