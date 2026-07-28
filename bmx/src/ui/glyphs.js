// MIRRA CITY / CONCRETE REPUBLIC — procedural input glyphs.
//
// Every button prompt in the game (HUD hint, trick-list chip, menu footers,
// settings rebind rows, rider creator) is drawn from this file. Nothing here
// downloads anything: each glyph is inline SVG built from primitives, coloured
// through CSS custom properties, with a built-in dark scrim so it stays legible
// over a blown-out sky *and* over wet concrete.
//
// ---------------------------------------------------------------------------
// USAGE
// ---------------------------------------------------------------------------
//   import { createGlyphs } from './glyphs.js';
//   const glyphs = createGlyphs(ctx);          // ctx optional — binds ctx.input
//
//   glyphs.el('hop')                 -> <span> A button, or the SPACE keycap,
//                                       depending on the device in the player's
//                                       hands right now. Switches itself live.
//   glyphs.el('pad:rb')              -> always the RB shoulder chip
//   glyphs.el('key:Space')           -> always the SPACE keycap
//   glyphs.el('KeyJ')                -> keycap for a raw KeyboardEvent.code
//   glyphs.el('a', { size: 2 })      -> the A button at 2em tall
//   glyphs.svg('lt')                 -> raw SVG markup string
//   glyphs.controller()              -> the pad silhouette for the HUD corner
//   glyphs.prompt('grind', 'GRIND')  -> glyph + caption row
//   glyphs.hint([['hop','HOP'], ['grind','GRIND']])
//
// The stylesheet is injected once per document (guarded by an element id, so a
// second bundle or a hot reload can never double up). `glyphs.css` hands the
// same text back for anyone who would rather inline it themselves.
//
// ---------------------------------------------------------------------------
// DEVICE SWITCHING
// ---------------------------------------------------------------------------
// Device state is module-level, so every instance of the library agrees on what
// the player is holding. If `input.onDeviceChange` exists (the controller-first
// input layer) we subscribe to it. If it does not, we fall back to our own
// listeners: any keypress/click means keyboard, any pad button press or stick
// deflection means gamepad. Elements built from an *action* name remember their
// spec and re-render themselves the moment the device flips.
//
// ---------------------------------------------------------------------------
// PAD LAYOUT (ARCHITECTURE.md "CONTROLLER SUPPORT")
// ---------------------------------------------------------------------------
//   left stick  steer / lean      right stick  camera
//   A  hop      X/Y/B trick sets  RB grind     LB trick list
//   RT pedal    LT brake          LS (click) manual
//   Start pause Back restart      d-pad = digital left stick
// The tables below are only a *fallback*: when input.js exposes per-device bind
// tables or a glyphFor(action) helper, those win, so remapping shows up in every
// prompt without this file knowing anything about it.

// ===========================================================================
// Stylesheet
// ===========================================================================

const STYLE_ID = 'cr-glyph-styles';

export const GLYPH_CSS = `
:root{
  --gly-size:1.34em;
  --gly-a:#5fb04a;
  --gly-b:#e2463b;
  --gly-x:#3d8ede;
  --gly-y:#f0bc2c;
  --gly-ink:#ffffff;
  --gly-ink-halo:rgba(3,6,10,.66);
  --gly-shell:#1c232c;
  --gly-shell-2:#0b1015;
  --gly-rim:rgba(255,255,255,.44);
  --gly-scrim:rgba(3,6,10,.74);
  --gly-accent:#ffc434;
  --gly-key-face:#eef3f8;
  --gly-key-edge:#96a3b0;
  --gly-key-ink:#0d1218;
  --gly-pad-body:#141a22;
  --gly-font:"Oswald","Roboto Condensed","Barlow Condensed","Archivo Narrow",
    "Liberation Sans Narrow","DejaVu Sans Condensed","Arial Narrow",
    "Franklin Gothic Medium",system-ui,"Segoe UI",sans-serif;
}

.gly{
  display:inline-flex; align-items:center; justify-content:center;
  flex:0 0 auto;
  height:var(--gly-size);
  width:calc(var(--gly-size) * var(--gly-ar,1));
  vertical-align:-.26em;
  line-height:0;
  pointer-events:none;
  filter:drop-shadow(0 1px 1.1px rgba(0,0,0,.85)) drop-shadow(0 0 3px rgba(0,0,0,.5));
}
.gly.no-scrim{filter:none;}
.gly--controller{
  height:var(--gly-pad-size,2.7em);
  width:calc(var(--gly-pad-size,2.7em) * var(--gly-ar,1));
  vertical-align:middle;
}
.gly--arrows{
  height:var(--gly-arrows-size,2.15em);
  width:calc(var(--gly-arrows-size,2.15em) * var(--gly-ar,1));
}
.gly-svg{display:block; width:100%; height:100%; overflow:visible; shape-rendering:geometricPrecision;}

/* --- shared parts -------------------------------------------------------- */
.gly .g-scrim{fill:var(--gly-scrim); stroke:none;}
.gly .g-scrim-o{fill:var(--gly-scrim); stroke:var(--gly-scrim); stroke-width:2.8; stroke-linejoin:round;}
.gly .g-shell{fill:var(--gly-shell);}
.gly .g-shell-2{fill:var(--gly-shell-2);}
.gly .g-rim{fill:none; stroke:var(--gly-rim); stroke-width:1.1; stroke-linejoin:round;}
.gly .g-rim.hair{stroke-width:.85; stroke-opacity:.72;}
.gly .g-round{stroke:var(--gly-shell); stroke-width:2.6; stroke-linejoin:round;}
.gly--dpad .g-scrim-o{stroke-width:5;}
.gly .g-hi{fill:#fff; opacity:.155;}
.gly .g-sh{fill:#000; opacity:.22;}
.gly .g-ink{fill:var(--gly-ink);}
.gly .g-mark{fill:var(--gly-ink); opacity:.74;}
.gly .g-mark.on{fill:var(--gly-accent); opacity:1;}
.gly .g-cut{fill:var(--gly-ink); stroke:var(--gly-shell); stroke-width:1.7;}
.gly .g-stroke{fill:none; stroke:var(--gly-ink); stroke-width:2.8;
  stroke-linecap:round; stroke-linejoin:round;}
.gly .g-stroke.thin{stroke-width:2.2;}
.gly .g-stroke-halo{fill:none; stroke:var(--gly-ink-halo); stroke-width:5.2;
  stroke-linecap:round; stroke-linejoin:round;}
.gly .g-label{
  fill:var(--gly-ink); font-family:var(--gly-font); font-weight:800;
  text-rendering:geometricPrecision; paint-order:stroke fill;
  stroke:var(--gly-ink-halo); stroke-width:.9; stroke-linejoin:round;
}
.gly .g-label.plain{stroke:none;}

/* --- face buttons -------------------------------------------------------- */
.gly--a .g-face{fill:var(--gly-a);}
.gly--b .g-face{fill:var(--gly-b);}
.gly--x .g-face{fill:var(--gly-x);}
.gly--y .g-face{fill:var(--gly-y);}
.gly--mono .g-face{fill:var(--gly-shell);}

/* --- keycaps ------------------------------------------------------------- */
.gly .g-cap{fill:var(--gly-key-edge);}
.gly .g-cap-face{fill:var(--gly-key-face);}
.gly .g-cap-lip{fill:#000; opacity:.16;}
.gly .g-cap-ink{fill:var(--gly-key-ink);}
.gly .g-cap-label{fill:var(--gly-key-ink); font-family:var(--gly-font); font-weight:800;
  text-rendering:geometricPrecision;}
.gly--dark .g-cap{fill:#000; fill-opacity:.55;}
.gly--dark .g-cap-face{fill:var(--gly-shell);}
.gly--dark .g-cap-ink,
.gly--dark .g-cap-label{fill:var(--gly-ink);}
.gly--dark .g-cap-lip{opacity:.34;}

/* --- controller silhouette ---------------------------------------------- */
.gly--controller .g-body{fill:var(--gly-pad-body);}
.gly--controller .g-body-hi{fill:#fff; opacity:.06;}
.gly--controller .g-pad-part{fill:var(--gly-shell-2);}
.gly--controller .g-pad-top{fill:#39434e;}
.gly--controller .g-guide{fill:#eef3f8;}

/* --- prompt rows --------------------------------------------------------- */
.gly-group{display:inline-flex; align-items:center; gap:.24em; vertical-align:-.26em;}
.gly-group .gly{vertical-align:baseline;}
.gly-sep{
  font-family:var(--gly-font); font-size:.78em; opacity:.5;
  line-height:1; pointer-events:none;
}
.gly-prompt{display:inline-flex; align-items:center; gap:.44em; white-space:nowrap;}
.gly-prompt .gly-txt{
  font-family:var(--gly-font); font-weight:700; letter-spacing:.09em;
  text-shadow:0 1px 2px rgba(0,0,0,.92), 0 0 9px rgba(0,0,0,.55);
}
.gly-hint{display:flex; align-items:center; gap:1.05em; flex-wrap:wrap;}

@media (prefers-reduced-motion: reduce){
  .gly{transition:none !important;}
}
`;

let styleInjected = false;

/** Add the glyph stylesheet to `doc` exactly once. Safe to call from anywhere. */
export function injectGlyphStyles(doc) {
  const d = doc || (typeof document !== 'undefined' ? document : null);
  if (!d) return null;
  const existing = d.getElementById(STYLE_ID);
  if (existing) { styleInjected = true; return existing; }
  const node = d.createElement('style');
  node.id = STYLE_ID;
  node.textContent = GLYPH_CSS;
  (d.head || d.documentElement).appendChild(node);
  styleInjected = true;
  return node;
}

// ===========================================================================
// Small string helpers
// ===========================================================================

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const n2 = (v) => (Math.round(v * 100) / 100).toString();

/**
 * SVG <text> that can never overflow its glyph: textLength + spacingAndGlyphs
 * squeezes or opens the label to the exact width we designed for, whatever font
 * the machine actually has.
 */
function txt(str, x, y, size, len, cls) {
  return `<text class="g-label${cls ? ' ' + cls : ''}" x="${n2(x)}" y="${n2(y)}"`
    + ` font-size="${n2(size)}" textLength="${n2(len)}" lengthAdjust="spacingAndGlyphs"`
    + ` text-anchor="middle" dominant-baseline="central">${esc(str)}</text>`;
}

function capText(str, x, y, size, len) {
  return `<text class="g-cap-label" x="${n2(x)}" y="${n2(y)}"`
    + ` font-size="${n2(size)}" textLength="${n2(len)}" lengthAdjust="spacingAndGlyphs"`
    + ` text-anchor="middle" dominant-baseline="central">${esc(str)}</text>`;
}

// ===========================================================================
// Glyph builders — each returns { w, h, body, cls[], label }
// ===========================================================================

/** Face-button letters, drawn as stroked paths so no font is involved. */
const FACE_LETTERS = {
  A: 'M10.4 22.6L16 9.4L21.6 22.6M12.6 18.4H19.4',
  B: 'M11.9 9.6V22.8M11.9 9.6H16.7A3.3 3.3 0 0 1 16.7 16.2H11.9'
   + 'M11.9 16.2H17.5A3.3 3.3 0 0 1 17.5 22.8H11.9',
  X: 'M11.2 9.6L20.8 22.6M20.8 9.6L11.2 22.6',
  Y: 'M11.2 9.6L16 16.5L20.8 9.6M16 16.5V22.6',
};

function faceGlyph(letter) {
  const key = letter.toLowerCase();
  const d = FACE_LETTERS[letter];
  return {
    w: 32, h: 32,
    cls: ['gly--pad', 'gly--face', 'gly--' + key],
    label: letter + ' button',
    body:
      '<circle class="g-scrim" cx="16" cy="16" r="15.4"/>'
      + '<circle class="g-face" cx="16" cy="16" r="12.9"/>'
      + '<ellipse class="g-hi" cx="16" cy="10.3" rx="8.5" ry="5"/>'
      + '<ellipse class="g-sh" cx="16" cy="22.8" rx="9.7" ry="5.6"/>'
      + '<circle class="g-rim" cx="16" cy="16" r="12.9"/>'
      + `<path class="g-stroke-halo" d="${d}"/>`
      + `<path class="g-stroke" d="${d}"/>`,
  };
}

/** LB / RB — a wide bumper seen from above: flat base, domed top. */
const BUMPER_D = 'M4 25.4V15C4 7 11.6 3.2 23 3.2S42 7 42 15v10.4'
  + 'a3.2 3.2 0 0 1-3.2 3.2H7.2A3.2 3.2 0 0 1 4 25.4z';

function bumperGlyph(side) {
  const name = side.toUpperCase() + 'B';
  return {
    w: 46, h: 30,
    cls: ['gly--pad', 'gly--bumper', 'gly--' + name.toLowerCase()],
    label: name + ' bumper',
    body:
      `<path class="g-scrim-o" d="${BUMPER_D}"/>`
      + `<path class="g-shell" d="${BUMPER_D}"/>`
      + '<path class="g-hi" d="M6.4 14.2C7 8.4 13.6 5.4 23 5.4s16 3 16.6 8.8'
      + 'C36.4 10.6 30.4 8.8 23 8.8S9.6 10.6 6.4 14.2z"/>'
      + `<path class="g-rim hair" d="${BUMPER_D}"/>`
      + txt(name, 23, 18.4, 12.6, 17.2),
  };
}

/** LT / RT — a taller arch, clearly not a bumper at a glance. */
const TRIGGER_D = 'M6 28.4V14.6C6 6.4 12.2 2 20 2s14 4.4 14 12.6v13.8'
  + 'a2.6 2.6 0 0 1-2.6 2.6H8.6A2.6 2.6 0 0 1 6 28.4z';

function triggerGlyph(side) {
  const name = side.toUpperCase() + 'T';
  return {
    w: 40, h: 32,
    cls: ['gly--pad', 'gly--trigger', 'gly--' + name.toLowerCase()],
    label: name + ' trigger',
    body:
      `<path class="g-scrim-o" d="${TRIGGER_D}"/>`
      + `<path class="g-shell" d="${TRIGGER_D}"/>`
      + '<path class="g-hi" d="M9 13.8C9.4 8 14.2 4.6 20 4.6S30.6 8 31 13.8'
      + 'C28.4 10.4 24.6 8.6 20 8.6S11.6 10.4 9 13.8z"/>'
      + '<path class="g-sh" d="M6 24h28v4.4a2.6 2.6 0 0 1-2.6 2.6H8.6A2.6 2.6 0 0 1 6 28.4z"/>'
      + `<path class="g-rim hair" d="${TRIGGER_D}"/>`
      + txt(name, 20, 20.6, 12.4, 15.4),
  };
}

/** Outward-pointing triangle at `r` from centre, for stick / d-pad directions. */
function dirArrow(cx, cy, r, dir, cls) {
  const ang = { up: -90, right: 0, down: 90, left: 180 }[dir];
  if (ang == null) return '';
  return `<g transform="translate(${n2(cx)} ${n2(cy)}) rotate(${ang})">`
    + `<path class="${cls}" d="M${n2(r + 4.6)} 0L${n2(r - 1)} 3.7V-3.7Z"/></g>`;
}

const DIR_VEC = {
  up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0],
};

/** Left / right analogue stick. `dir` adds a deflection + arrow, `press` = click. */
function stickGlyph(side, dir, press) {
  const S = side === 'r' ? 'R' : 'L';
  const c = 20;
  const v = DIR_VEC[dir] || [0, 0];
  const dx = v[0] * 2.5;
  const dy = v[1] * 2.5;
  const lab = press ? S + '3' : S;
  const cls = ['gly--pad', 'gly--stick', 'gly--' + side + 's'];
  if (dir) cls.push('gly--' + side + 's-' + dir);
  if (press) cls.push('gly--' + side + '3');
  return {
    w: 40, h: 40,
    cls,
    label: (side === 'r' ? 'Right' : 'Left') + ' stick'
      + (dir ? ' ' + dir : '') + (press ? ' click' : ''),
    body:
      `<circle class="g-scrim" cx="${c}" cy="${c}" r="14.6"/>`
      + `<circle class="g-shell-2" cx="${c}" cy="${c}" r="13.3"/>`
      + `<circle class="g-rim hair" cx="${c}" cy="${c}" r="13.3"/>`
      + `<g transform="translate(${n2(dx)} ${n2(dy)})">`
      + `<circle class="g-shell" cx="${c}" cy="${c}" r="9.2"/>`
      + `<ellipse class="g-hi" cx="${c}" cy="${c - 3.6}" rx="6" ry="3.2"/>`
      + `<circle class="g-rim" cx="${c}" cy="${c}" r="9.2"/>`
      + txt(lab, c, c + 0.4, press ? 8 : 9.4, press ? 8.4 : 5.2)
      + '</g>'
      + (dir ? dirArrow(c, c, 14.6, dir, 'g-mark on') : '')
      + (press ? '<path class="g-mark on" d="M20 33.4l3.4 3.9h-6.8z"/>' : ''),
  };
}

/** D-pad cross. Rounded by stroking the outline with the same fill. */
const DPAD_D = 'M10.8 3.2h10.4v7.6h7.6v10.4h-7.6v7.6H10.8v-7.6H3.2V10.8h7.6z';
const DPAD_MARKS = {
  up: 'M16 5.6l3.1 4.2h-6.2z',
  down: 'M16 26.4l-3.1-4.2h6.2z',
  left: 'M5.6 16l4.2-3.1v6.2z',
  right: 'M26.4 16l-4.2 3.1v-6.2z',
};

function dpadGlyph(dir) {
  let marks = '';
  for (const k of ['up', 'down', 'left', 'right']) {
    marks += `<path class="g-mark${dir === k ? ' on' : ''}" d="${DPAD_MARKS[k]}"/>`;
  }
  return {
    w: 32, h: 32,
    cls: ['gly--pad', 'gly--dpad'].concat(dir ? ['gly--dpad-' + dir] : []),
    label: 'D-pad' + (dir ? ' ' + dir : ''),
    body:
      `<path class="g-scrim-o" d="${DPAD_D}"/>`
      + `<path class="g-shell g-round" d="${DPAD_D}"/>`
      + `<path class="g-rim hair" d="${DPAD_D}"/>`
      + marks,
  };
}

/** Start / "menu" — three bars in a disc. */
function startGlyph() {
  return {
    w: 32, h: 32,
    cls: ['gly--pad', 'gly--start'],
    label: 'Menu button',
    body:
      '<circle class="g-scrim" cx="16" cy="16" r="15.4"/>'
      + '<circle class="g-shell" cx="16" cy="16" r="12.9"/>'
      + '<ellipse class="g-hi" cx="16" cy="10.3" rx="8.5" ry="5"/>'
      + '<circle class="g-rim" cx="16" cy="16" r="12.9"/>'
      + '<path class="g-stroke thin" d="M9.8 11.4h12.4M9.8 16h12.4M9.8 20.6h12.4"/>',
  };
}

/** Back / "view" — two overlapping panels in a disc. */
function backGlyph() {
  return {
    w: 32, h: 32,
    cls: ['gly--pad', 'gly--view'],
    label: 'View button',
    body:
      '<circle class="g-scrim" cx="16" cy="16" r="15.4"/>'
      + '<circle class="g-shell" cx="16" cy="16" r="12.9"/>'
      + '<ellipse class="g-hi" cx="16" cy="10.3" rx="8.5" ry="5"/>'
      + '<circle class="g-rim" cx="16" cy="16" r="12.9"/>'
      + '<rect class="g-mark" x="8.2" y="10.6" width="10" height="7.6" rx="1.6"/>'
      + '<rect class="g-cut" x="13" y="14" width="10" height="7.6" rx="1.6"/>',
  };
}

/** Neutral centre/home button — invented mark, no trademark anywhere. */
function guideGlyph() {
  return {
    w: 32, h: 32,
    cls: ['gly--pad', 'gly--guide'],
    label: 'Home button',
    body:
      '<circle class="g-scrim" cx="16" cy="16" r="15.4"/>'
      + '<circle class="g-shell" cx="16" cy="16" r="12.9"/>'
      + '<circle class="g-rim" cx="16" cy="16" r="12.9"/>'
      + '<circle class="g-rim" cx="16" cy="16" r="6.4"/>'
      + '<circle class="g-ink" cx="16" cy="16" r="2.5"/>',
  };
}

/** Placeholder for "not bound on this device". */
function noneGlyph() {
  return {
    w: 34, h: 30,
    cls: ['gly--none'],
    label: 'unbound',
    body:
      '<rect class="g-scrim" x="0" y="0" width="34" height="30" rx="6"/>'
      + '<rect class="g-rim hair" x="2.2" y="2.2" width="29.6" height="25.6" rx="5"'
      + ' stroke-dasharray="3 3"/>'
      + '<path class="g-stroke thin" d="M11 15h12" opacity=".62"/>',
  };
}

// --- keyboard --------------------------------------------------------------

const ARROW_D = 'M0 -5.9L5.7 1.2H2.8V6.5H-2.8V1.2H-5.7Z';
const ARROW_ROT = { ArrowUp: 0, ArrowRight: 90, ArrowDown: 180, ArrowLeft: 270 };

const KEY_WIDTH = { Space: 88, ShiftLeft: 74, ShiftRight: 74, Enter: 74, NumpadEnter: 84 };

/**
 * A rounded keycap: dark edge, lighter top face, label on the face.
 * Width grows with the label so long names never crop.
 */
function keyGlyph(code, labelOverride) {
  const isArrow = ARROW_ROT[code] != null;
  const label = labelOverride != null ? String(labelOverride) : keyLabel(code);
  const chars = isArrow ? 2 : Math.max(1, label.length);
  const preset = labelOverride == null ? KEY_WIDTH[code] : 0;
  const w = preset || Math.round(Math.min(132, Math.max(30, 15 + chars * 11.6)));
  const h = 30;
  const fx = 3.2;              // face inset
  const faceW = w - fx * 2;
  const size = chars > 5 ? 11.6 : 13.4;

  const inner = isArrow
    ? `<g transform="translate(${n2(w / 2)} 13.6) rotate(${ARROW_ROT[code]})">`
      + `<path class="g-cap-ink" d="${ARROW_D}"/></g>`
    : capText(label, w / 2, 13.4, size, Math.min(faceW - 7, Math.max(6, chars * size * 0.66)));

  return {
    w, h,
    cls: ['gly--key', 'gly--key-' + String(code || label).replace(/[^A-Za-z0-9]/g, '')],
    label: label + ' key',
    body:
      `<rect class="g-scrim" x="0" y="0" width="${w}" height="${h}" rx="6.4"/>`
      + `<rect class="g-cap" x="1.4" y="1.4" width="${n2(w - 2.8)}" height="27.2" rx="5.4"/>`
      + `<rect class="g-cap-face" x="${fx}" y="2.9" width="${n2(faceW)}" height="18.6" rx="4.2"/>`
      + `<rect class="g-cap-lip" x="${fx}" y="21.5" width="${n2(faceW)}" height="4.4" rx="2.1"/>`
      + `<rect class="g-rim hair" x="1.4" y="1.4" width="${n2(w - 2.8)}" height="27.2" rx="5.4"/>`
      + inner,
  };
}

/** The four arrow keys as one cluster (inverted-T), for "navigate" prompts. */
function arrowsGlyph() {
  const cap = (code, x, y) => {
    const g = keyGlyph(code);
    return `<g transform="translate(${x} ${y})">${g.body}</g>`;
  };
  // Each arrow cap is 38 wide, 30 tall; inverted-T with a 2px gutter.
  return {
    w: 118, h: 64,
    cls: ['gly--key', 'gly--arrows'],
    label: 'Arrow keys',
    body: cap('ArrowUp', 40, 0)
      + cap('ArrowLeft', 0, 34)
      + cap('ArrowDown', 40, 34)
      + cap('ArrowRight', 80, 34),
  };
}

// --- controller silhouette -------------------------------------------------

const PAD_BODY_D = 'M64 6C76 6 88 8 98 11.5C112 16 123 25 124.5 38'
  + 'C126 51 121 66 114.5 76C110.5 82 103 84.5 97.5 80C92 75.6 88.5 68 83 63.5'
  + 'C78.5 59.8 71.5 58 64 58C56.5 58 49.5 59.8 45 63.5C39.5 68 36 75.6 30.5 80'
  + 'C25 84.5 17.5 82 13.5 76C7 66 2 51 3.5 38C5 25 16 16 30 11.5'
  + 'C40 8 52 6 64 6Z';

/**
 * Xbox-style pad silhouette for the bottom-right HUD hint. Pure paths.
 * opts.colour === false gives a monochrome version.
 */
function controllerGlyph(opts) {
  const colour = !opts || opts.colour !== false;
  const faceCol = (v) => (colour ? ` fill="var(--gly-${v})"` : '');
  const stick = (cx, cy) =>
    `<circle class="g-pad-part" cx="${cx}" cy="${cy}" r="10"/>`
    + `<circle class="g-pad-top" cx="${cx}" cy="${cy}" r="6.2"/>`
    + `<circle class="g-rim hair" cx="${cx}" cy="${cy}" r="10"/>`;

  return {
    w: 128, h: 88,
    cls: ['gly--controller'],
    label: 'Controller',
    body:
      // shoulder bumpers peeking above the shell
      '<rect class="g-pad-part" x="26" y="3" width="24" height="11" rx="4.6"/>'
      + '<rect class="g-pad-part" x="78" y="3" width="24" height="11" rx="4.6"/>'
      + `<path class="g-scrim-o" d="${PAD_BODY_D}"/>`
      + `<path class="g-body" d="${PAD_BODY_D}"/>`
      + '<path class="g-body-hi" d="M64 9C84 9 104 14 114 24C104 17 86 13 64 13'
      + 'S24 17 14 24C24 14 44 9 64 9Z"/>'
      + `<path class="g-rim hair" d="${PAD_BODY_D}"/>`
      // left stick + d-pad
      + stick(36.5, 33)
      + '<path class="g-pad-part" d="M48.6 50.4h6.8v5h5v6.8h-5v5h-6.8v-5h-5v-6.8h5z"'
      + ' stroke="var(--gly-shell-2)" stroke-width="2.4" stroke-linejoin="round"/>'
      // right stick
      + stick(77, 52)
      // centre buttons
      + '<circle class="g-guide" cx="64" cy="19.5" r="5.6"/>'
      + '<circle class="g-pad-part" cx="53" cy="30.5" r="3"/>'
      + '<circle class="g-pad-part" cx="75" cy="30.5" r="3"/>'
      // face cluster
      + `<circle class="g-pad-part" cx="95.5" cy="22.6" r="4.5"${faceCol('y')}/>`
      + `<circle class="g-pad-part" cx="87" cy="31.1" r="4.5"${faceCol('x')}/>`
      + `<circle class="g-pad-part" cx="104" cy="31.1" r="4.5"${faceCol('b')}/>`
      + `<circle class="g-pad-part" cx="95.5" cy="39.6" r="4.5"${faceCol('a')}/>`,
  };
}

// ===========================================================================
// Names, aliases, tables
// ===========================================================================

const ALIAS = {
  'btn-a': 'a', 'btn-b': 'b', 'btn-x': 'x', 'btn-y': 'y',
  l1: 'lb', r1: 'rb', l2: 'lt', r2: 'rt',
  lbumper: 'lb', rbumper: 'rb', ltrigger: 'lt', rtrigger: 'rt',
  l3: 'ls-press', r3: 'rs-press', 'ls-click': 'ls-press', 'rs-click': 'rs-press',
  lstick: 'ls', rstick: 'rs', 'left-stick': 'ls', 'right-stick': 'rs',
  menu: 'start', options: 'start', pause: 'start',
  view: 'back-btn', select: 'back-btn', 'pad-back': 'back-btn', share: 'back-btn',
  home: 'guide', xbox: 'guide',
  dpad: 'dpad', 'd-pad': 'dpad',
  pad: 'controller', gamepad: 'controller', joypad: 'controller',
  arrowkeys: 'arrows', 'arrow-keys': 'arrows',
  empty: 'none', unbound: 'none', '-': 'none',
};

const DIRS = ['up', 'down', 'left', 'right'];

/** Standard Gamepad API button index -> glyph name, for index-based bind tables. */
const STANDARD_BUTTONS = [
  'a', 'b', 'x', 'y', 'lb', 'rb', 'lt', 'rt', 'back-btn', 'start',
  'ls-press', 'rs-press', 'dpad-up', 'dpad-down', 'dpad-left', 'dpad-right', 'guide',
];

/** Pad glyph name per action — fallback only; input.js wins when it can. */
export const PAD_ACTIONS = {
  forward: 'ls-up', back: 'ls-down', left: 'ls-left', right: 'ls-right',
  steer: 'ls', lean: 'ls', look: 'rs', move: 'ls',
  pedal: 'rt', throttle: 'rt', brake: 'lt',
  hop: 'a', trickA: 'x', trickB: 'y', trickC: 'b',
  spinLeft: 'ls-left', spinRight: 'ls-right',
  grind: 'rb', manual: 'ls-press', special: 'rs-press',
  reset: 'back-btn', pause: 'start', camera: 'rs', debug: 'none',
  tricklist: 'lb', goals: 'dpad-down',
  // menu / UI verbs
  confirm: 'a', cancel: 'b', accept: 'a', backOut: 'b',
  navigate: 'ls', adjust: 'ls', tabLeft: 'lb', tabRight: 'rb',
  rebind: 'a', randomize: 'y', deleteItem: 'x', start: 'start',
};

/** Keyboard code per action — used only when input.js has no bind table yet. */
export const KEY_ACTIONS = {
  forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD',
  steer: 'KeyA', lean: 'KeyW', look: 'ArrowUp', move: 'KeyW',
  pedal: 'ShiftLeft', throttle: 'ShiftLeft', brake: 'KeyS',
  hop: 'Space', trickA: 'KeyJ', trickB: 'KeyK', trickC: 'KeyL',
  spinLeft: 'KeyQ', spinRight: 'KeyE',
  grind: 'KeyU', manual: 'KeyI', special: 'KeyO',
  reset: 'KeyR', pause: 'Escape', camera: 'KeyC', debug: 'Backquote',
  tricklist: 'KeyT', goals: 'KeyG',
  confirm: 'Enter', cancel: 'Escape', accept: 'Enter', backOut: 'Escape',
  navigate: 'arrows', adjust: 'arrows', tabLeft: 'KeyQ', tabRight: 'KeyE',
  rebind: 'Enter', randomize: 'KeyR', deleteItem: 'Delete', start: 'Enter',
};

const ACTION_SET = new Set(Object.keys(PAD_ACTIONS).concat(Object.keys(KEY_ACTIONS)));

/** Human labels for KeyboardEvent.code values. */
export const KEY_LABELS = {
  Space: 'SPACE', Escape: 'ESC', Enter: 'ENTER', NumpadEnter: 'NUM ENTER',
  Tab: 'TAB', Backspace: 'BKSP', Delete: 'DEL', Insert: 'INS',
  CapsLock: 'CAPS', ContextMenu: 'MENU',
  ShiftLeft: 'SHIFT', ShiftRight: 'SHIFT', ControlLeft: 'CTRL', ControlRight: 'CTRL',
  AltLeft: 'ALT', AltRight: 'ALT', MetaLeft: 'META', MetaRight: 'META',
  ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT',
  Home: 'HOME', End: 'END', PageUp: 'PGUP', PageDown: 'PGDN',
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  NumpadAdd: 'NUM +', NumpadSubtract: 'NUM -', NumpadMultiply: 'NUM *',
  NumpadDivide: 'NUM /', NumpadDecimal: 'NUM .', NumLock: 'NUM LK',
};

/** KeyboardEvent.code -> the short label printed on the cap. */
export function keyLabel(code) {
  if (!code) return '?';
  const c = String(code);
  if (KEY_LABELS[c]) return KEY_LABELS[c];
  let m = /^Key([A-Z])$/.exec(c);
  if (m) return m[1];
  m = /^Digit(\d)$/.exec(c);
  if (m) return m[1];
  m = /^Numpad(\d)$/.exec(c);
  if (m) return 'NUM ' + m[1];
  if (/^F\d{1,2}$/.test(c)) return c;
  if (c.length <= 3) return c.toUpperCase();
  return c.replace(/([a-z])([A-Z0-9])/g, '$1 $2').toUpperCase();
}

// ===========================================================================
// Name -> glyph resolution
// ===========================================================================

const PAD_NAMES = [
  'a', 'b', 'x', 'y', 'lb', 'rb', 'lt', 'rt', 'ls', 'rs',
  'ls-press', 'rs-press', 'dpad', 'start', 'back-btn', 'guide', 'controller',
];
for (const d of DIRS) {
  PAD_NAMES.push('ls-' + d, 'rs-' + d, 'dpad-' + d);
}

const PAD_NAME_SET = new Set(PAD_NAMES);

function normalise(name) {
  const s = String(name == null ? '' : name).trim().toLowerCase()
    .replace(/[\s_]+/g, '-');
  return ALIAS[s] || s;
}

/** Build the geometry record for a canonical pad-glyph name. */
function buildPad(name, opts) {
  switch (name) {
    case 'a': case 'b': case 'x': case 'y':
      return faceGlyph(name.toUpperCase());
    case 'lb': return bumperGlyph('l');
    case 'rb': return bumperGlyph('r');
    case 'lt': return triggerGlyph('l');
    case 'rt': return triggerGlyph('r');
    case 'ls': return stickGlyph('l', null, false);
    case 'rs': return stickGlyph('r', null, false);
    case 'ls-press': return stickGlyph('l', null, true);
    case 'rs-press': return stickGlyph('r', null, true);
    case 'dpad': return dpadGlyph(null);
    case 'start': return startGlyph();
    case 'back-btn': return backGlyph();
    case 'guide': return guideGlyph();
    case 'controller': return controllerGlyph(opts);
    default: break;
  }
  let m = /^(l|r)s-(up|down|left|right)$/.exec(name);
  if (m) return stickGlyph(m[1], m[2], false);
  m = /^dpad-(up|down|left|right)$/.exec(name);
  if (m) return dpadGlyph(m[1]);
  return null;
}

const KEY_CODE_RE = /^(Key[A-Z]|Digit\d|Numpad[A-Za-z0-9]+|F\d{1,2}|Arrow(Up|Down|Left|Right)|[A-Z][A-Za-z]+)$/;

function looksLikeKeyCode(s) {
  return KEY_CODE_RE.test(s) || KEY_LABELS[s] != null;
}

/**
 * Turn any accepted spec into a geometry record.
 * Returns { w, h, body, cls, label } or a { group: [...] } bundle.
 */
function buildGlyph(spec, opts) {
  const o = opts || {};

  if (spec && typeof spec === 'object') {
    if (spec.device === 'keyboard' || spec.kind === 'key') {
      return keyGlyph(spec.code || spec.input || spec.name, spec.label);
    }
    const nm = normalise(spec.name || spec.glyph || spec.input || '');
    return buildPad(nm, o) || keyGlyph(nm, spec.label);
  }

  const raw = String(spec == null ? '' : spec).trim();

  // Explicit device prefixes: "pad:rb" / "key:Space" / "key:KeyJ|KeyK"
  const pfx = /^(pad|gp|gamepad|key|kb|keyboard):(.*)$/i.exec(raw);
  if (pfx) {
    const rest = pfx[2];
    const isKey = /^(key|kb|keyboard)$/i.test(pfx[1]);
    if (rest.indexOf('|') >= 0) {
      return { group: rest.split('|').map((p) => buildGlyph((isKey ? 'key:' : 'pad:') + p, o)) };
    }
    if (isKey) {
      if (normalise(rest) === 'arrows') return arrowsGlyph();
      return keyGlyph(rest, o.label);
    }
    return buildPad(normalise(rest), o) || noneGlyph();
  }

  if (raw.indexOf('|') >= 0) {
    return { group: raw.split('|').map((p) => buildGlyph(p, o)) };
  }

  const nm = normalise(raw);
  if (nm === 'none' || nm === '') return noneGlyph();
  if (nm === 'arrows') return arrowsGlyph();
  if (PAD_NAME_SET.has(nm)) return buildPad(nm, o) || noneGlyph();
  if (looksLikeKeyCode(raw)) return keyGlyph(raw, o.label);
  return keyGlyph(raw, o.label != null ? o.label : raw.toUpperCase());
}

// ===========================================================================
// Markup
// ===========================================================================

function svgString(g, opts) {
  const o = opts || {};
  const cls = ['gly-svg'].concat(g.cls || []);
  if (o.svgClass) cls.push(o.svgClass);
  return `<svg class="${cls.join(' ')}" viewBox="0 0 ${g.w} ${g.h}"`
    + ` width="${g.w}" height="${g.h}" preserveAspectRatio="xMidYMid meet"`
    + ' focusable="false" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">'
    + g.body + '</svg>';
}

/** Raw SVG markup for a glyph name (or action, resolved for `opts.device`). */
export function glyphSvg(name, opts) {
  const o = opts || {};
  const g = buildGlyph(name, o);
  if (g.group) return g.group.map((x) => svgString(x, o)).join('');
  return svgString(g, o);
}

/** The pad silhouette on its own, as markup. */
export function controllerSvg(opts) {
  return svgString(controllerGlyph(opts || {}), opts || {});
}

// ===========================================================================
// Module-level device state (shared by every instance)
// ===========================================================================

let activeDevice = 'keyboard';
const deviceListeners = new Set();
let fallbackRefs = 0;
let fallbackTimer = 0;
let fallbackBound = false;

function notifyDevice() {
  for (const fn of deviceListeners) {
    try { fn(activeDevice); } catch (err) { /* a bad listener must not stall the UI */ }
  }
}

function setActiveDevice(d) {
  const next = d === 'gamepad' || d === 'pad' ? 'gamepad' : 'keyboard';
  if (next === activeDevice) return false;
  activeDevice = next;
  notifyDevice();
  return true;
}

const onAnyKey = () => setActiveDevice('keyboard');

function pollPads() {
  if (typeof navigator === 'undefined' || !navigator.getGamepads) return;
  if (typeof document !== 'undefined' && document.hidden) return;
  const pads = navigator.getGamepads();
  for (let i = 0; i < pads.length; i++) {
    const p = pads[i];
    if (!p || !p.connected) continue;
    const btns = p.buttons;
    for (let b = 0; b < btns.length; b++) {
      const v = btns[b];
      if (v && (v.pressed || v.value > 0.4)) { setActiveDevice('gamepad'); return; }
    }
    const ax = p.axes;
    for (let a = 0; a < ax.length && a < 4; a++) {
      if (Math.abs(ax[a] || 0) > 0.55) { setActiveDevice('gamepad'); return; }
    }
  }
}

function bindFallbackListeners() {
  fallbackRefs++;
  if (fallbackBound || typeof window === 'undefined') return;
  fallbackBound = true;
  window.addEventListener('keydown', onAnyKey, true);
  window.addEventListener('pointerdown', onAnyKey, true);
  fallbackTimer = window.setInterval(pollPads, 150);
}

function unbindFallbackListeners() {
  fallbackRefs = Math.max(0, fallbackRefs - 1);
  if (fallbackRefs > 0 || !fallbackBound || typeof window === 'undefined') return;
  fallbackBound = false;
  window.removeEventListener('keydown', onAnyKey, true);
  window.removeEventListener('pointerdown', onAnyKey, true);
  if (fallbackTimer) window.clearInterval(fallbackTimer);
  fallbackTimer = 0;
}

// ===========================================================================
// createGlyphs
// ===========================================================================

/**
 * @param {object} [ctx] shared game context (uses ctx.input when present)
 * @param {object} [options] { input, device, padActions, keyActions, autoInject }
 */
export function createGlyphs(ctx, options) {
  const opt = options || (ctx && !ctx.input && !ctx.player && !ctx.engine ? ctx : null) || {};
  const input = opt.input || (ctx && ctx.input) || null;

  if (opt.autoInject !== false) injectGlyphStyles();

  const padActions = Object.assign(Object.create(null), PAD_ACTIONS, opt.padActions || null);
  const keyActions = Object.assign(Object.create(null), KEY_ACTIONS, opt.keyActions || null);

  // --- live elements ------------------------------------------------------
  // Tracked weakly: a prompt that gets torn down with its screen must not be
  // kept alive by this list.
  const tracked = [];
  const hasWeakRef = typeof WeakRef === 'function';

  function track(node) {
    tracked.push(hasWeakRef ? new WeakRef(node) : { deref: () => node });
    if (tracked.length > 512) prune();
  }

  function prune() {
    let w = 0;
    for (let i = 0; i < tracked.length; i++) {
      const node = tracked[i].deref();
      if (node && node.isConnected !== false) tracked[w++] = tracked[i];
    }
    tracked.length = w;
  }

  // --- device -------------------------------------------------------------

  function readDevice() {
    if (!input) return activeDevice;
    if (typeof input.activeDevice === 'string') return input.activeDevice === 'gamepad' ? 'gamepad' : 'keyboard';
    if (input.state && input.state.anyGamepad) return 'gamepad';
    return activeDevice;
  }

  let unsubInput = null;
  if (input && typeof input.onDeviceChange === 'function') {
    const off = input.onDeviceChange((d) => { setActiveDevice(d); });
    unsubInput = typeof off === 'function' ? off : null;
    setActiveDevice(readDevice());
  } else {
    bindFallbackListeners();
    setActiveDevice(readDevice());
  }

  const localListeners = new Set();
  const onDeviceChanged = () => { refreshAll(); for (const fn of localListeners) fn(activeDevice); };
  deviceListeners.add(onDeviceChanged);

  function device(want) {
    if (want === 'gamepad' || want === 'pad') return 'gamepad';
    if (want === 'keyboard' || want === 'key' || want === 'kb') return 'keyboard';
    return activeDevice;
  }

  // --- action resolution --------------------------------------------------

  /** The keyboard codes bound to `action`, from input.js if it will tell us. */
  function boundKeys(action) {
    if (input && input.binds) {
      const b = input.binds;
      const table = b.keyboard && typeof b.keyboard === 'object' && !Array.isArray(b.keyboard)
        ? b.keyboard : b;
      const v = table[action];
      if (Array.isArray(v) && v.length) return v;
      if (typeof v === 'string') return [v];
    }
    const fb = keyActions[action];
    return fb ? [fb] : null;
  }

  /** The pad glyph name for `action`, preferring anything input.js publishes. */
  function padName(action) {
    if (input && typeof input.glyphFor === 'function') {
      let g = null;
      try { g = input.glyphFor(action, 'gamepad'); } catch (err) { g = null; }
      if (g && (g.device === 'gamepad' || g.kind === 'pad' || g.kind === 'button')) {
        const nm = normalise(g.glyph || g.name || g.label || '');
        if (PAD_NAME_SET.has(nm)) return nm;
      }
    }
    if (input && input.binds && input.binds.gamepad) {
      const v = input.binds.gamepad[action];
      const first = Array.isArray(v) ? v[0] : v;
      if (first != null) {
        const nm = normalise(padInputName(first));
        if (PAD_NAME_SET.has(nm)) return nm;
      }
    }
    return padActions[action] || null;
  }

  /** Standard-mapping button/axis id -> glyph name. */
  function padInputName(v) {
    if (typeof v === 'string') {
      const s = v.toLowerCase();
      const m = /^(?:b|button)(\d+)$/.exec(s);
      if (m) return STANDARD_BUTTONS[+m[1]] || 'none';
      return s;
    }
    if (typeof v === 'number') return STANDARD_BUTTONS[v] || 'none';
    if (v && typeof v === 'object') return padInputName(v.button != null ? v.button : v.id);
    return 'none';
  }

  /**
   * Canonical glyph name for an action on a device.
   * Keyboard results come back as "key:<code>" so the caller can tell them apart.
   */
  function nameFor(action, wantDevice, opts) {
    const dev = device(wantDevice);
    if (dev === 'gamepad') return padName(action) || 'none';
    const keys = boundKeys(action);
    if (!keys || !keys.length) return 'none';
    if (opts && opts.all && keys.length > 1) {
      return keys.map((k) => 'key:' + k).join('|');
    }
    return 'key:' + keys[0];
  }

  /** Short text version of a prompt, for places that cannot take an element. */
  function labelFor(action, wantDevice) {
    const nm = nameFor(action, wantDevice);
    if (nm.startsWith('key:')) return keyLabel(nm.slice(4));
    if (nm === 'none') return '—';
    if (nm === 'back-btn') return 'BACK';
    if (nm === 'start') return 'START';
    const m = /^(l|r)s-(up|down|left|right)$/.exec(nm);
    if (m) return (m[1] + 'S').toUpperCase() + ' ' + m[2].toUpperCase();
    if (nm === 'ls-press') return 'L3';
    if (nm === 'rs-press') return 'R3';
    if (nm.startsWith('dpad')) return 'D-PAD' + (nm.length > 4 ? ' ' + nm.slice(5).toUpperCase() : '');
    return nm.toUpperCase();
  }

  /** Is this string one of our action names (rather than a glyph/key name)? */
  function isAction(spec) {
    if (typeof spec !== 'string') return false;
    if (spec.indexOf(':') >= 0 || spec.indexOf('|') >= 0) return false;
    return ACTION_SET.has(spec);
  }

  // --- rendering ----------------------------------------------------------

  function sizeValue(v) {
    if (v == null) return null;
    if (typeof v === 'number') return v + 'em';
    return String(v);
  }

  function paint(node, spec, opts) {
    const o = opts || {};
    const action = isAction(spec) && o.as !== 'input';
    const resolved = action ? nameFor(spec, o.device, o) : spec;
    const g = buildGlyph(resolved, o);

    const classes = ['gly'];
    let markup;
    let aria;

    if (g.group) {
      node.className = 'gly-group' + (o.class ? ' ' + o.class : '');
      const parts = [];
      for (let i = 0; i < g.group.length; i++) {
        if (i) parts.push('<span class="gly-sep">/</span>');
        const child = g.group[i];
        parts.push(`<span class="gly ${(child.cls || []).join(' ')}"`
          + ` style="--gly-ar:${n2(child.w / child.h)}">${svgString(child, o)}</span>`);
      }
      markup = parts.join('');
      aria = g.group.map((c) => c.label).join(' or ');
      node.style.removeProperty('--gly-ar');
    } else {
      node.className = classes.concat(g.cls || [], o.class ? [o.class] : []).join(' ');
      if (o.scrim === false) node.classList.add('no-scrim');
      if (o.tone === 'dark') node.classList.add('gly--dark');
      if (o.mono) node.classList.add('gly--mono');
      node.style.setProperty('--gly-ar', n2(g.w / g.h));
      markup = svgString(g, o);
      aria = g.label;
    }

    const sz = sizeValue(o.size);
    if (sz) {
      node.style.setProperty('--gly-size', sz);
      node.style.setProperty('--gly-pad-size', sz);
      node.style.setProperty('--gly-arrows-size', sz);
    }

    node.innerHTML = markup;
    node.setAttribute('role', 'img');
    node.setAttribute('aria-label', o.aria || aria || 'input');
    if (o.title) node.title = o.title;
    node.__glyph = { spec, opts: o, action };
    return node;
  }

  /**
   * Build a glyph element.
   * `spec` may be an action ('hop'), a glyph name ('rb'), a prefixed name
   * ('pad:rb' / 'key:Space'), a raw KeyboardEvent.code, or a descriptor object.
   */
  function elFn(spec, opts) {
    const node = document.createElement('span');
    paint(node, spec, opts);
    if (node.__glyph.action && (!opts || opts.auto !== false)) track(node);
    return node;
  }

  /** Re-point an existing glyph element at a new spec (no DOM churn). */
  function set(node, spec, opts) {
    if (!node) return node;
    const prev = node.__glyph;
    paint(node, spec, opts || (prev && prev.opts) || null);
    if (node.__glyph.action) track(node);
    return node;
  }

  function refresh(node) {
    const g = node && node.__glyph;
    if (!g) return;
    paint(node, g.spec, g.opts);
  }

  function refreshAll() {
    prune();
    for (let i = 0; i < tracked.length; i++) {
      const node = tracked[i].deref();
      if (node && node.__glyph && node.__glyph.action) paint(node, node.__glyph.spec, node.__glyph.opts);
    }
  }

  /** glyph + caption, e.g. [A] HOP. */
  function promptFn(spec, text, opts) {
    const wrap = document.createElement('span');
    wrap.className = 'gly-prompt' + (opts && opts.rowClass ? ' ' + opts.rowClass : '');
    wrap.appendChild(elFn(spec, opts));
    if (text != null && text !== '') {
      const t = document.createElement('span');
      t.className = 'gly-txt';
      t.textContent = String(text);
      wrap.appendChild(t);
    }
    return wrap;
  }

  /** A row of prompts: hint([['hop','HOP'], ['grind','GRIND']]). */
  function hintFn(pairs, opts) {
    const row = document.createElement('span');
    row.className = 'gly-hint' + (opts && opts.class ? ' ' + opts.class : '');
    const list = pairs || [];
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (Array.isArray(p)) row.appendChild(promptFn(p[0], p[1], opts));
      else if (p && typeof p === 'object') row.appendChild(promptFn(p.input || p.action, p.text, opts));
      else row.appendChild(promptFn(p, null, opts));
    }
    return row;
  }

  function controllerFn(opts) {
    const node = document.createElement('span');
    paint(node, 'controller', opts);
    return node;
  }

  // --- api ----------------------------------------------------------------

  const api = {
    /** Build a glyph element for an action, a glyph name or a key code. */
    el: elFn,
    /** Raw SVG markup string. */
    svg(name, opts) {
      const o = opts || {};
      const resolved = isAction(name) && o.as !== 'input' ? nameFor(name, o.device, o) : name;
      return glyphSvg(resolved, o);
    },
    /** The stylesheet, for anyone who would rather inline it. */
    css: GLYPH_CSS,
    inject: injectGlyphStyles,

    prompt: promptFn,
    hint: hintFn,
    controller: controllerFn,
    controllerSvg,

    set,
    refresh,
    refreshAll,

    nameFor,
    labelFor,
    keyLabel,
    isAction,

    /** Every canonical glyph name this library can draw. */
    names: PAD_NAMES.concat(['arrows', 'none']),

    get device() { return activeDevice; },
    set device(d) { setActiveDevice(d); },
    setDevice: setActiveDevice,
    /** fn(device) on every switch; returns an unsubscribe. */
    onDeviceChange(fn) {
      if (typeof fn !== 'function') return () => {};
      localListeners.add(fn);
      return () => localListeners.delete(fn);
    },

    /** Optional: main.js may call this; the library also self-updates. */
    update() {
      const d = readDevice();
      if (d !== activeDevice) setActiveDevice(d);
    },
    fixedUpdate() {},

    dispose() {
      deviceListeners.delete(onDeviceChanged);
      localListeners.clear();
      if (unsubInput) { try { unsubInput(); } catch (err) { /* ignore */ } unsubInput = null; }
      else if (!(input && typeof input.onDeviceChange === 'function')) unbindFallbackListeners();
      tracked.length = 0;
    },
  };

  return api;
}

export default createGlyphs;
