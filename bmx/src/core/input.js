// ---------------------------------------------------------------------------
// input.js — controller-first input layer (keyboard + Gamepad API)
// ---------------------------------------------------------------------------
//
// Owns: device polling, per-device bind tables, edge detection, the trick input
// buffer, analog shaping, device-activity tracking, rebind capture and rumble.
//
// Consumers (do not break these):
//   input.state { steer, throttle, brake, lean, look:{x,y}, anyGamepad }
//   input.held(a) / pressed(a) / released(a) / bufferedIn(a, ms) / consumeBuffer(a)
//   input.binds  — legacy flat table: action -> array of KeyboardEvent.code
//   input.setBind(action, keys)      — legacy 2-arg form, keyboard device
//   input.poll(elapsedMs), input.harness, input.dispose()
//
// ===========================================================================
// DEFAULT BIND TABLE
// ===========================================================================
//
//  action      keyboard (KeyboardEvent.code)   gamepad (Xbox names)   notes
//  ---------------------------------------------------------------------------
//  forward     W / ArrowUp                     D-Pad Up               lean fwd, soft pedal
//  back        S / ArrowDown                   D-Pad Down             lean back
//  left        A / ArrowLeft                   D-Pad Left             steer left
//  right       D / ArrowRight                  D-Pad Right            steer right
//  pedal       LShift / RShift                 RT                     full pedal (analog)
//  brake       S                               LT                     brake (analog)
//  hop         Space                           A                      bunnyhop / boost
//  spinLeft    Q                               LS full left           air rotation
//  spinRight   E                               LS full right          air rotation
//  trickA      J                               X                      trick set A — grabs
//  trickB      K                               Y                      trick set B — bike spins
//  trickC      L                               B                      trick set C — flips
//  grind       U                               RB                     grind / lip trick
//  manual      I                               LS click (L3)          manual / nose manual
//  special     O                               RS click (R3)          signature trick
//  trickList   T                               LB                     trick list panel
//  reset       R                               Back / View            respawn / restart
//  pause       Escape                          Start / Menu           pause
//  camera      C                               —                      (right stick is the camera on a pad)
//  debug       Backquote                       —                      debug overlay
//
// The left stick is steer (X) + lean (Y); the right stick is camera look. The
// d-pad is a digital alternative to the left stick, so it is bound to the same
// four actions as WASD. Sticks feed `state` through a radial deadzone, a
// response curve and a sensitivity multiplier; the d-pad and the keyboard feed
// the same fields digitally (±1).
//
// GAMEPAD BIND TOKENS
//   'b<N>'   button index N in the standard mapping (0 = A, 4 = LB, 12 = D-Up …)
//   'a<N>+'  axis N pushed positive past the digital threshold
//   'a<N>-'  axis N pushed negative past the digital threshold
// Axis tokens use hysteresis (press 0.60 / release 0.45) so a stick used for
// steering does not machine-gun a digital action; that is also why the default
// spin binds sit at the far end of the left stick's travel.
//
// TRIGGERS
//   Standard mapping exposes LT/RT as buttons 6/7 with an analog `.value`.
//   Non-standard pads often expose them as axes instead. Tokens 'b6'/'b7' are
//   transparently redirected onto the detected trigger axes for those pads, and
//   each trigger axis self-calibrates its rest position (−1 or 0 conventions).
//
// EDGE SEMANTICS (unchanged, and load-bearing for screens.js)
//   Keyboard state is applied in the DOM event, so a key pressed between frames
//   is already down when poll() snapshots the previous frame — pressed()/
//   released() therefore only report *pad* edges, while bufferedIn() sees both.
//   screens.js relies on this: it takes keyboard Escape from the DOM event and
//   the pad Start button from input.pressed('pause').
//
// PERSISTENCE
//   Binds + analog/vibration options are stored under 'concreterepublic.input.v1'
//   and reloaded on construction.
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'concreterepublic.input.v1';
const STORAGE_VERSION = 1;

// ---------------------------------------------------------------------------
// Gamepad access can be REFUSED, not merely absent.
//
// Inside an embedded frame the Permissions Policy can disallow the "gamepad"
// feature, and then navigator.getGamepads() THROWS a SecurityError rather than
// returning an empty list. This is polled at the top of every frame, so an
// unguarded call takes down the whole frame loop before the renderer ever runs
// — the DOM HUD keeps its last paint while the canvas stays black.
//
// One refusal is permanent for the life of the document, so latch it and stop
// asking. Keyboard play is unaffected.
// ---------------------------------------------------------------------------
let gamepadBlocked = false;
const EMPTY_PADS = [];

function readGamepads() {
  if (gamepadBlocked) return EMPTY_PADS;
  if (typeof navigator === 'undefined' || !navigator.getGamepads) return EMPTY_PADS;
  try {
    return navigator.getGamepads() || EMPTY_PADS;
  } catch (err) {
    gamepadBlocked = true;
    console.warn('[input] gamepad access refused by permissions policy; keyboard only:', err && err.message);
    return EMPTY_PADS;
  }
}

/** True when this document is not allowed to see gamepads at all. */
export function gamepadsUnavailable() { return gamepadBlocked; }


/** Declaration order — also the order the settings screen walks. */
export const ACTIONS = [
  'forward', 'back', 'left', 'right', 'pedal', 'brake',
  'hop', 'spinLeft', 'spinRight', 'trickA', 'trickB', 'trickC',
  'grind', 'manual', 'special', 'trickList',
  'reset', 'pause', 'camera', 'debug',
];

/** Human labels + grouping, for the controls screen and glyph prompts. */
export const ACTION_INFO = {
  forward: { label: 'Pedal / Lean Forward', group: 'ride' },
  back: { label: 'Brake / Lean Back', group: 'ride' },
  left: { label: 'Steer Left', group: 'ride' },
  right: { label: 'Steer Right', group: 'ride' },
  pedal: { label: 'Sprint Pedal', group: 'ride' },
  brake: { label: 'Brake', group: 'ride' },
  hop: { label: 'Bunnyhop / Boost', group: 'tricks' },
  spinLeft: { label: 'Spin Left', group: 'tricks' },
  spinRight: { label: 'Spin Right', group: 'tricks' },
  trickA: { label: 'Trick Set A — grabs', group: 'tricks' },
  trickB: { label: 'Trick Set B — spins of the bike', group: 'tricks' },
  trickC: { label: 'Trick Set C — flips', group: 'tricks' },
  grind: { label: 'Grind / Lip Trick', group: 'tricks' },
  manual: { label: 'Manual', group: 'tricks' },
  special: { label: 'Signature Trick', group: 'tricks' },
  trickList: { label: 'Trick List', group: 'system' },
  reset: { label: 'Respawn', group: 'system' },
  pause: { label: 'Pause', group: 'system' },
  camera: { label: 'Camera', group: 'system' },
  debug: { label: 'Debug Overlay', group: 'system' },
};

/** Legacy export: the keyboard table, flat, exactly as the old module shipped it. */
export const DEFAULT_BINDS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  pedal: ['ShiftLeft', 'ShiftRight'],
  brake: ['KeyS'],
  hop: ['Space'],
  spinLeft: ['KeyQ'],
  spinRight: ['KeyE'],
  trickA: ['KeyJ'],
  trickB: ['KeyK'],
  trickC: ['KeyL'],
  grind: ['KeyU'],
  manual: ['KeyI'],
  special: ['KeyO'],
  trickList: ['KeyT'],
  reset: ['KeyR'],
  pause: ['Escape'],
  camera: ['KeyC'],
  debug: ['Backquote'],
};

export const DEFAULT_PAD_BINDS = {
  forward: ['b12'],
  back: ['b13'],
  left: ['b14'],
  right: ['b15'],
  pedal: ['b7'],
  brake: ['b6'],
  hop: ['b0'],
  spinLeft: ['a0-'],
  spinRight: ['a0+'],
  trickA: ['b2'],
  trickB: ['b3'],
  trickC: ['b1'],
  grind: ['b5'],
  manual: ['b10'],
  special: ['b11'],
  trickList: ['b4'],
  reset: ['b8'],
  pause: ['b9'],
  camera: [],
  debug: [],
};

/** Pairs that are allowed to share an input without being reported as a clash. */
const CONFLICT_EXEMPT = [
  ['back', 'brake'],
  ['forward', 'pedal'],
];

export const DEFAULT_OPTIONS = {
  deadzone: { left: 0.18, right: 0.16 },
  curve: { left: 'linear', right: 'quadratic' },
  sensitivity: { left: 1, right: 1 },
  triggerDeadzone: 0.06,
  invertY: false,
  vibration: { enabled: true, strength: 1 },
};

const PAD_BUTTON_LABEL = [
  'A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'BACK', 'START',
  'LS', 'RS', 'D-PAD ↑', 'D-PAD ↓', 'D-PAD ←', 'D-PAD →', 'GUIDE',
];
const PAD_BUTTON_KIND = [
  'face', 'face', 'face', 'face', 'shoulder', 'shoulder', 'trigger', 'trigger',
  'system', 'system', 'stick', 'stick', 'dpad', 'dpad', 'dpad', 'dpad', 'system',
];
const PAD_AXIS_LABEL = [
  ['LS ←', 'LS →'],
  ['LS ↑', 'LS ↓'],
  ['RS ←', 'RS →'],
  ['RS ↑', 'RS ↓'],
];

const KEY_LABEL = {
  Space: 'SPACE', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  ShiftLeft: 'L SHIFT', ShiftRight: 'R SHIFT', ControlLeft: 'L CTRL', ControlRight: 'R CTRL',
  AltLeft: 'L ALT', AltRight: 'R ALT', MetaLeft: 'L META', MetaRight: 'R META',
  Escape: 'ESC', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Semicolon: ';', Quote: '\'', Comma: ',', Period: '.', Slash: '/',
  Tab: 'TAB', Enter: 'ENTER', NumpadEnter: 'NUM ENTER', Backspace: 'BKSP', CapsLock: 'CAPS',
  NumpadAdd: 'NUM +', NumpadSubtract: 'NUM -', NumpadMultiply: 'NUM *', NumpadDivide: 'NUM /',
  NumpadDecimal: 'NUM .', PageUp: 'PG UP', PageDown: 'PG DN', Home: 'HOME', End: 'END',
  Insert: 'INS', Delete: 'DEL',
};

const WIDE_KEYS = {
  Space: 1, ShiftLeft: 1, ShiftRight: 1, ControlLeft: 1, ControlRight: 1,
  AltLeft: 1, AltRight: 1, Enter: 1, NumpadEnter: 1, Backspace: 1, CapsLock: 1,
  Escape: 1, Tab: 1, MetaLeft: 1, MetaRight: 1,
};

const MAX_PADS = 8;
const MAX_PAD_BUTTONS = 32;
const MAX_PAD_AXES = 16;
const AXIS_PRESS = 0.60;
const AXIS_RELEASE = 0.45;
const RUMBLE_SLOTS = 8;

function noop() {}

function keyLabelFor(code) {
  if (!code) return '—';
  const named = KEY_LABEL[code];
  if (named) return named;
  if (code.length > 3 && code.slice(0, 3) === 'Key') return code.slice(3);
  if (code.length > 5 && code.slice(0, 5) === 'Digit') return code.slice(5);
  if (code.length > 6 && code.slice(0, 6) === 'Numpad') return 'NUM ' + code.slice(6);
  return code.toUpperCase();
}

/** 'b5' | 'a0-' -> { kind, index, sign, raw } | null */
function parseToken(tok) {
  if (typeof tok !== 'string' || tok.length < 2) return null;
  const head = tok.charCodeAt(0);
  if (head === 98 /* b */) {
    const n = parseInt(tok.slice(1), 10);
    if (!Number.isFinite(n) || n < 0 || n >= MAX_PAD_BUTTONS) return null;
    return { kind: 0, index: n, sign: 1, raw: tok };
  }
  if (head === 97 /* a */) {
    const last = tok.charCodeAt(tok.length - 1);
    if (last !== 43 && last !== 45) return null;                       // '+' | '-'
    const n = parseInt(tok.slice(1, tok.length - 1), 10);
    if (!Number.isFinite(n) || n < 0 || n >= MAX_PAD_AXES) return null;
    return { kind: 1, index: n, sign: last === 43 ? 1 : -1, raw: tok };
  }
  return null;
}

function padLabelFor(tok) {
  const t = parseToken(tok);
  if (!t) return { label: '—', kind: 'none' };
  if (t.kind === 0) {
    return {
      label: PAD_BUTTON_LABEL[t.index] || ('BTN ' + t.index),
      kind: PAD_BUTTON_KIND[t.index] || 'face',
    };
  }
  const pair = PAD_AXIS_LABEL[t.index];
  if (pair) return { label: t.sign > 0 ? pair[1] : pair[0], kind: 'stick' };
  return { label: 'AXIS ' + t.index + (t.sign > 0 ? '+' : '-'), kind: 'stick' };
}

function cleanList(value) {
  const out = [];
  if (typeof value === 'string') { if (value) out.push(value); return out; }
  if (!Array.isArray(value)) return out;
  for (let i = 0; i < value.length; i++) {
    const v = value[i];
    if (typeof v === 'string' && v && out.indexOf(v) < 0) out.push(v);
  }
  return out;
}

// ---------------------------------------------------------------------------

export function createInput(opts) {
  const cfgIn = (opts && typeof opts === 'object' && !opts.addEventListener) ? opts : {};
  const target = (opts && opts.addEventListener) ? opts : (cfgIn.target || (typeof window !== 'undefined' ? window : null));
  const storageKey = cfgIn.storageKey || STORAGE_KEY;
  const hasWindow = !!(target && target.addEventListener);

  // ---- action tables ------------------------------------------------------
  const actions = ACTIONS.slice();
  const actionIndex = new Map();
  for (let i = 0; i < actions.length; i++) actionIndex.set(actions[i], i);

  const binds = {};                 // enumerable: action -> keyboard codes (legacy surface)
  const padBinds = {};              // action -> gamepad tokens
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    binds[a] = (DEFAULT_BINDS[a] || []).slice();
    padBinds[a] = (DEFAULT_PAD_BINDS[a] || []).slice();
  }
  // `binds.keyboard` is the flat table itself, so the legacy `binds[action]`
  // form and the per-device `binds.keyboard[action]` form can never drift.
  // Both device handles are non-enumerable so Object.keys(binds) still lists
  // actions only (screens.js builds its rows from that).
  Object.defineProperty(binds, 'keyboard', { value: binds, enumerable: false, configurable: true });
  Object.defineProperty(binds, 'gamepad', { value: padBinds, enumerable: false, configurable: true });

  const options = {
    deadzone: { left: DEFAULT_OPTIONS.deadzone.left, right: DEFAULT_OPTIONS.deadzone.right },
    curve: { left: DEFAULT_OPTIONS.curve.left, right: DEFAULT_OPTIONS.curve.right },
    sensitivity: { left: DEFAULT_OPTIONS.sensitivity.left, right: DEFAULT_OPTIONS.sensitivity.right },
    triggerDeadzone: DEFAULT_OPTIONS.triggerDeadzone,
    invertY: DEFAULT_OPTIONS.invertY,
    vibration: { enabled: DEFAULT_OPTIONS.vibration.enabled, strength: DEFAULT_OPTIONS.vibration.strength },
  };

  // ---- per-action state (indexed, so poll() never allocates) --------------
  const N = actions.length;
  const keyHeld = new Uint8Array(N);
  const padHeld = new Uint8Array(N);
  const harnessHeld = new Uint8Array(N);
  let harnessActive = false;   // true while a scripted-input hook is installed
  const downNow = new Uint8Array(N);
  const downPrev = new Uint8Array(N);
  const lastPress = new Float64Array(N);
  const padValue = new Float32Array(N);      // analog strength of the pad binding
  const padWas = new Uint8Array(N);          // previous-frame pad digital, for axis hysteresis
  for (let i = 0; i < N; i++) lastPress[i] = -1e12;

  const keyToActions = new Map();            // code -> array of action indices
  const padCompiled = new Array(N);          // action index -> array of parsed tokens
  for (let i = 0; i < N; i++) padCompiled[i] = [];

  const exempt = new Map();                  // action -> group id
  for (let g = 0; g < CONFLICT_EXEMPT.length; g++) {
    const grp = CONFLICT_EXEMPT[g];
    for (let i = 0; i < grp.length; i++) exempt.set(grp[i], g);
  }

  let now = 0;

  const state = {
    steer: 0,        // -1 .. 1
    throttle: 0,     // 0 .. 1 pedalling
    brake: 0,        // 0 .. 1
    lean: 0,         // -1 .. 1 (pitch: manual / nose manual)
    look: { x: 0, y: 0 },
    anyGamepad: false,
    padCount: 0,
    device: 'keyboard',
  };

  // ---- bind compilation ---------------------------------------------------

  // Cached indices for the six actions poll() reads every frame.
  let iLeft = 0, iRight = 0, iFwd = 0, iBack = 0, iPedal = 0, iBrake = 0;

  function rebuild() {
    keyToActions.clear();
    for (let i = 0; i < actions.length; i++) {
      const list = binds[actions[i]];
      if (Array.isArray(list)) {
        for (let k = 0; k < list.length; k++) {
          const code = list[k];
          let arr = keyToActions.get(code);
          if (!arr) { arr = []; keyToActions.set(code, arr); }
          if (arr.indexOf(i) < 0) arr.push(i);
        }
      }
      const toks = padCompiled[i];
      toks.length = 0;
      const pl = padBinds[actions[i]];
      if (Array.isArray(pl)) {
        for (let k = 0; k < pl.length; k++) {
          const t = parseToken(pl[k]);
          if (t) toks.push(t);
        }
      }
    }
    iLeft = actionIndex.get('left') || 0;
    iRight = actionIndex.get('right') || 0;
    iFwd = actionIndex.get('forward') || 0;
    iBack = actionIndex.get('back') || 0;
    iPedal = actionIndex.get('pedal') || 0;
    iBrake = actionIndex.get('brake') || 0;
  }

  function ensureAction(name) {
    if (actionIndex.has(name)) return actionIndex.get(name);
    // An unknown action can only arrive from a caller adding one; growing the
    // typed arrays here keeps every indexed lookup valid.
    const i = actions.length;
    actions.push(name);
    actionIndex.set(name, i);
    binds[name] = [];
    padBinds[name] = [];
    padCompiled.push([]);
    grow(i + 1);
    return i;
  }

  let cap = N;
  let A = { keyHeld, padHeld, harnessHeld, downNow, downPrev, lastPress, padValue, padWas };
  function grow(size) {
    if (size <= cap) return;
    const nc = Math.max(size, cap * 2);
    const g = (src, Ctor, fill) => {
      const d = new Ctor(nc);
      d.set(src);
      if (fill !== undefined) for (let i = src.length; i < nc; i++) d[i] = fill;
      return d;
    };
    A = {
      keyHeld: g(A.keyHeld, Uint8Array),
      padHeld: g(A.padHeld, Uint8Array),
      harnessHeld: g(A.harnessHeld, Uint8Array),
      downNow: g(A.downNow, Uint8Array),
      downPrev: g(A.downPrev, Uint8Array),
      lastPress: g(A.lastPress, Float64Array, -1e12),
      padValue: g(A.padValue, Float32Array),
      padWas: g(A.padWas, Uint8Array),
    };
    cap = nc;
  }

  rebuild();

  // ---- device tracking ----------------------------------------------------

  let activeDevice = 'keyboard';
  const deviceSubs = [];

  function setActiveDevice(d) {
    if (d === activeDevice) return;
    activeDevice = d;
    state.device = d;
    for (let i = 0; i < deviceSubs.length; i++) {
      try { deviceSubs[i](d); } catch (err) { /* a listener must never break input */ }
    }
  }

  // ---- keyboard -----------------------------------------------------------

  function onKeyDown(e) {
    if (capture && capture.device === 'keyboard') {
      e.preventDefault();
      if (e.repeat) return;
      if (e.code === 'Escape') { finishCapture(null, 'cancelled'); return; }
      if (e.code === 'Tab') return;
      finishCapture(e.code, 'ok');
      return;
    }
    if (e.repeat) return;
    setActiveDevice('keyboard');
    const list = keyToActions.get(e.code);
    if (!list) return;
    e.preventDefault();
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      A.keyHeld[a] = 1;
      A.downNow[a] = 1;
      A.lastPress[a] = now;
    }
  }

  function onKeyUp(e) {
    if (capture && capture.device === 'keyboard') { e.preventDefault(); return; }
    const list = keyToActions.get(e.code);
    if (!list) return;
    e.preventDefault();
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      A.keyHeld[a] = 0;
      A.downNow[a] = (A.padHeld[a] | A.harnessHeld[a]) ? 1 : 0;
    }
  }

  function clearAll() {
    for (let i = 0; i < actions.length; i++) {
      A.keyHeld[i] = 0;
      A.padHeld[i] = 0;
      A.harnessHeld[i] = 0;
      A.downNow[i] = 0;
      A.padValue[i] = 0;
    }
  }
  const onBlur = () => { clearAll(); stopRumble(); };

  // ---- gamepads -----------------------------------------------------------

  const padProfiles = new Array(MAX_PADS);

  function onPadConnected(e) {
    const g = e && e.gamepad;
    if (g) padProfiles[g.index % MAX_PADS] = null;    // profile is rebuilt on the next poll
    setActiveDevice('gamepad');
  }
  function onPadDisconnected(e) {
    const g = e && e.gamepad;
    if (g) padProfiles[g.index % MAX_PADS] = null;
    for (let i = 0; i < actions.length; i++) {
      A.padHeld[i] = 0;
      A.padValue[i] = 0;
      A.downNow[i] = (A.keyHeld[i] | A.harnessHeld[i]) ? 1 : 0;
    }
  }

  /**
   * Build (and cache) the axis layout for a pad. `mapping === 'standard'` is the
   * happy path; everything else falls back to plain index mapping with a couple
   * of well-known non-standard shapes handled explicitly.
   */
  function profileFor(g) {
    const slot = g.index % MAX_PADS;
    let p = padProfiles[slot];
    if (p && p.id === g.id && p.axes === g.axes.length && p.buttons === g.buttons.length) return p;

    const axes = g.axes.length;
    const buttons = g.buttons.length;
    p = {
      id: g.id, axes, buttons, standard: g.mapping === 'standard',
      lsX: 0, lsY: 1, rsX: 2, rsY: 3, ltAxis: -1, rtAxis: -1,
      rest: new Float32Array(Math.max(axes, 1)),
      restSet: new Uint8Array(Math.max(axes, 1)),
    };
    if (g.mapping !== 'standard') {
      // Triggers as buttons is still the common case; only reach for axes when
      // the pad plainly does not have enough buttons to carry them.
      if (buttons < 8) {
        if (axes >= 6) { p.ltAxis = 4; p.rtAxis = 5; p.rsX = 2; p.rsY = 3; }
        else if (axes >= 4) { p.rsX = 2; p.rsY = 3; }
      } else if (axes >= 6) {
        // 6-axis DirectInput layouts usually keep the right stick on 2/3 as well;
        // 4-axis pads fall through to the standard indices unchanged.
        p.rsX = 2; p.rsY = 3;
      }
      if (p.rsX >= axes) p.rsX = axes > 2 ? 2 : 0;
      if (p.rsY >= axes) p.rsY = axes > 3 ? 3 : 1;
    }
    padProfiles[slot] = p;
    return p;
  }

  function axisRaw(g, i) {
    const v = g.axes[i];
    return typeof v === 'number' && v === v ? v : 0;
  }

  /** Normalised 0..1 for an axis used as a trigger, self-calibrating its rest point. */
  function triggerAxis(g, p, i) {
    const raw = axisRaw(g, i);
    if (!p.restSet[i]) { p.rest[i] = raw; p.restSet[i] = 1; }
    else if (raw < p.rest[i]) p.rest[i] = raw;
    const rest = p.rest[i];
    const span = 1 - rest;
    if (span <= 1e-3) return 0;
    const v = (raw - rest) / span;
    return v < 0 ? 0 : (v > 1 ? 1 : v);
  }

  function buttonValue(g, i) {
    const b = g.buttons[i];
    if (b == null) return 0;
    if (typeof b === 'number') return b;
    if (typeof b.value === 'number' && b.value === b.value) return b.value;
    return b.pressed ? 1 : 0;
  }

  function buttonPressed(g, i) {
    const b = g.buttons[i];
    if (b == null) return false;
    if (typeof b === 'number') return b > 0.5;
    return !!b.pressed || (typeof b.value === 'number' && b.value > 0.5);
  }

  /** Analog 0..1 for one compiled token on one pad. */
  function tokenValue(g, p, t) {
    if (t.kind === 0) {
      if (t.index === 6 && p.ltAxis >= 0) return triggerAxis(g, p, p.ltAxis);
      if (t.index === 7 && p.rtAxis >= 0) return triggerAxis(g, p, p.rtAxis);
      if (t.index >= p.buttons) return 0;
      return buttonValue(g, t.index);
    }
    if (t.index >= p.axes) return 0;
    const v = axisRaw(g, t.index) * t.sign;
    return v > 0 ? v : 0;
  }

  function tokenDigital(g, p, t, wasDown) {
    if (t.kind === 0) {
      if (t.index === 6 && p.ltAxis >= 0) return triggerAxis(g, p, p.ltAxis) > 0.5;
      if (t.index === 7 && p.rtAxis >= 0) return triggerAxis(g, p, p.rtAxis) > 0.5;
      if (t.index >= p.buttons) return false;
      return buttonPressed(g, t.index);
    }
    if (t.index >= p.axes) return false;
    const v = axisRaw(g, t.index) * t.sign;
    return v > (wasDown ? AXIS_RELEASE : AXIS_PRESS);
  }

  // Merged stick / trigger reads, filled every poll.
  let mLX = 0, mLY = 0, mRX = 0, mRY = 0, mLT = 0, mRT = 0;
  let padActivity = false;

  function samplePads() {
    for (let i = 0; i < actions.length; i++) { A.padHeld[i] = 0; A.padValue[i] = 0; }
    mLX = 0; mLY = 0; mRX = 0; mRY = 0; mLT = 0; mRT = 0;
    padActivity = false;
    state.padCount = 0;

    if (gamepadBlocked) { state.anyGamepad = false; return; }
    // getGamepads() allocates its snapshot array — that is the API, and it is the
    // only allocation in the polling path.
    const pads = readGamepads();
    if (!pads) { state.anyGamepad = false; return; }

    let count = 0;
    for (let pi = 0; pi < pads.length; pi++) {
      const g = pads[pi];
      if (!g || !g.connected) continue;
      count++;
      const p = profileFor(g);

      // sticks — keep the strongest deflection across pads
      const lx = p.lsX < p.axes ? axisRaw(g, p.lsX) : 0;
      const ly = p.lsY < p.axes ? axisRaw(g, p.lsY) : 0;
      const rx = p.rsX < p.axes ? axisRaw(g, p.rsX) : 0;
      const ry = p.rsY < p.axes ? axisRaw(g, p.rsY) : 0;
      if (lx * lx + ly * ly > mLX * mLX + mLY * mLY) { mLX = lx; mLY = ly; }
      if (rx * rx + ry * ry > mRX * mRX + mRY * mRY) { mRX = rx; mRY = ry; }

      const lt = p.ltAxis >= 0 ? triggerAxis(g, p, p.ltAxis) : (p.buttons > 6 ? buttonValue(g, 6) : 0);
      const rt = p.rtAxis >= 0 ? triggerAxis(g, p, p.rtAxis) : (p.buttons > 7 ? buttonValue(g, 7) : 0);
      if (lt > mLT) mLT = lt;
      if (rt > mRT) mRT = rt;

      // actions
      for (let ai = 0; ai < actions.length; ai++) {
        const toks = padCompiled[ai];
        if (!toks.length) continue;
        const wasDown = A.padHeld[ai] === 1 || downPrevPad(ai);
        for (let ti = 0; ti < toks.length; ti++) {
          const t = toks[ti];
          const v = tokenValue(g, p, t);
          if (v > A.padValue[ai]) A.padValue[ai] = v;
          if (tokenDigital(g, p, t, wasDown)) A.padHeld[ai] = 1;
        }
      }

      if (!padActivity) {
        if (lx * lx + ly * ly > 0.16 || rx * rx + ry * ry > 0.16 || lt > 0.2 || rt > 0.2) padActivity = true;
        else {
          for (let bi = 0; bi < g.buttons.length && bi < MAX_PAD_BUTTONS; bi++) {
            if (buttonPressed(g, bi)) { padActivity = true; break; }
          }
        }
      }
    }
    state.padCount = count;
    state.anyGamepad = count > 0;
  }

  // Hysteresis reference: an axis-driven action counts as "was down" if it was
  // down on the previous frame from the pad.
  function downPrevPad(i) { return A.padWas[i] === 1; }

  // ---- analog shaping -----------------------------------------------------

  let shapedX = 0, shapedY = 0;

  /** Radial deadzone + response curve + sensitivity, written to shapedX/shapedY. */
  function shapeStick(x, y, dz, curve, sens) {
    const mag = Math.sqrt(x * x + y * y);
    if (mag <= dz || mag <= 1e-5) { shapedX = 0; shapedY = 0; return; }
    let n = (mag - dz) / (1 - dz);
    if (n > 1) n = 1;
    if (curve === 'quadratic') n *= n;
    else if (curve === 'cubic') n *= n * n;
    n *= sens;
    const s = n / mag;
    let ox = x * s;
    let oy = y * s;
    if (ox > 1) ox = 1; else if (ox < -1) ox = -1;
    if (oy > 1) oy = 1; else if (oy < -1) oy = -1;
    shapedX = ox;
    shapedY = oy;
  }

  // ---- rebind capture -----------------------------------------------------

  let capture = null;
  const captureBtnBase = new Uint8Array(MAX_PADS * MAX_PAD_BUTTONS);
  const captureAxisBase = new Float32Array(MAX_PADS * MAX_PAD_AXES);

  function finishCapture(input, reason) {
    if (!capture) return;
    const c = capture;
    capture = null;
    const result = input == null ? null : {
      action: c.action,
      device: c.device,
      input,
      label: c.device === 'gamepad' ? padLabelFor(input).label : keyLabelFor(input),
      conflict: api.conflict(c.action, c.device, input),
      reason,
    };
    c.resolve(result);
  }

  function captureBaseline() {
    const pads = readGamepads();
    if (!pads.length) return;
    if (!pads) return;
    captureBtnBase.fill(0);
    captureAxisBase.fill(0);
    for (let pi = 0; pi < pads.length && pi < MAX_PADS; pi++) {
      const g = pads[pi];
      if (!g || !g.connected) continue;
      for (let b = 0; b < g.buttons.length && b < MAX_PAD_BUTTONS; b++) {
        captureBtnBase[pi * MAX_PAD_BUTTONS + b] = buttonPressed(g, b) ? 1 : 0;
      }
      for (let a = 0; a < g.axes.length && a < MAX_PAD_AXES; a++) {
        captureAxisBase[pi * MAX_PAD_AXES + a] = axisRaw(g, a);
      }
    }
  }

  function pollCapture() {
    if (!capture) return;
    if (now >= capture.deadline) { finishCapture(null, 'timeout'); return; }
    if (capture.device !== 'gamepad') return;
    if (!capture.based) { captureBaseline(); capture.based = true; return; }
    const pads = readGamepads();
    if (!pads.length) return;
    if (!pads) return;
    for (let pi = 0; pi < pads.length && pi < MAX_PADS; pi++) {
      const g = pads[pi];
      if (!g || !g.connected) continue;
      for (let b = 0; b < g.buttons.length && b < MAX_PAD_BUTTONS; b++) {
        const pressed = buttonPressed(g, b);
        if (!pressed || captureBtnBase[pi * MAX_PAD_BUTTONS + b]) {
          captureBtnBase[pi * MAX_PAD_BUTTONS + b] = pressed ? 1 : 0;
          continue;
        }
        setActiveDevice('gamepad');
        if (b === 1) { finishCapture(null, 'cancelled'); return; }   // B cancels
        finishCapture('b' + b, 'ok');
        return;
      }
      for (let a = 0; a < g.axes.length && a < MAX_PAD_AXES; a++) {
        const v = axisRaw(g, a);
        const base = captureAxisBase[pi * MAX_PAD_AXES + a];
        if (Math.abs(v - base) > 0.75 && Math.abs(v) > AXIS_PRESS) {
          setActiveDevice('gamepad');
          finishCapture('a' + a + (v > 0 ? '+' : '-'), 'ok');
          return;
        }
      }
    }
  }

  // ---- vibration ----------------------------------------------------------

  const rumbleSlots = new Array(RUMBLE_SLOTS);
  for (let i = 0; i < RUMBLE_SLOTS; i++) rumbleSlots[i] = { active: false, strong: 0, weak: 0, until: 0 };
  const effectParams = { startDelay: 0, duration: 0, strongMagnitude: 0, weakMagnitude: 0 };
  let sentStrong = -1;
  let sentWeak = -1;
  let refreshAt = 0;

  function eachActuator(fn) {
    const pads = readGamepads();
    if (!pads.length) return;
    if (!pads) return;
    for (let i = 0; i < pads.length; i++) {
      const g = pads[i];
      if (!g || !g.connected) continue;
      fn(g);
    }
  }

  function sendRumble(g, strong, weak, ms) {
    const act = g.vibrationActuator;
    if (act && typeof act.playEffect === 'function') {
      effectParams.startDelay = 0;
      effectParams.duration = ms;
      effectParams.strongMagnitude = strong;
      effectParams.weakMagnitude = weak;
      try {
        const r = act.playEffect(act.type || 'dual-rumble', effectParams);
        if (r && typeof r.catch === 'function') r.catch(noop);
      } catch (err) { /* unsupported effect type — silently no-op */ }
      return;
    }
    if (act && typeof act.pulse === 'function') {
      try { const r = act.pulse(Math.max(strong, weak), ms); if (r && r.catch) r.catch(noop); } catch (err) { /* no-op */ }
      return;
    }
    const legacy = g.hapticActuators && g.hapticActuators[0];
    if (legacy && typeof legacy.pulse === 'function') {
      try { const r = legacy.pulse(Math.max(strong, weak), ms); if (r && r.catch) r.catch(noop); } catch (err) { /* no-op */ }
    }
  }

  function updateRumble() {
    let strong = 0;
    let weak = 0;
    let until = 0;
    let any = false;
    for (let i = 0; i < RUMBLE_SLOTS; i++) {
      const s = rumbleSlots[i];
      if (!s.active) continue;
      if (now >= s.until) { s.active = false; continue; }
      any = true;
      if (s.strong > strong) strong = s.strong;
      if (s.weak > weak) weak = s.weak;
      if (s.until > until) until = s.until;
    }
    if (!options.vibration.enabled || !state.anyGamepad) {
      if (sentStrong > 0 || sentWeak > 0) {
        sentStrong = 0; sentWeak = 0;
        eachActuator((g) => sendRumble(g, 0, 0, 1));
      }
      return;
    }
    const k = options.vibration.strength;
    strong = Math.min(1, Math.max(0, strong * k));
    weak = Math.min(1, Math.max(0, weak * k));

    if (!any) {
      if (sentStrong > 0.001 || sentWeak > 0.001) {
        sentStrong = 0; sentWeak = 0; refreshAt = 0;
        eachActuator((g) => sendRumble(g, 0, 0, 1));
      }
      return;
    }
    const changed = Math.abs(strong - sentStrong) > 0.04 || Math.abs(weak - sentWeak) > 0.04;
    if (!changed && now < refreshAt) return;

    let ms = until - now;
    if (ms > 260) ms = 260;
    if (ms < 30) ms = 30;
    sentStrong = strong;
    sentWeak = weak;
    refreshAt = now + ms * 0.7;
    eachActuator((g) => sendRumble(g, strong, weak, ms));
  }

  function stopRumble() {
    for (let i = 0; i < RUMBLE_SLOTS; i++) rumbleSlots[i].active = false;
    sentStrong = 0; sentWeak = 0; refreshAt = 0;
    eachActuator((g) => sendRumble(g, 0, 0, 1));
  }

  // ---- persistence --------------------------------------------------------

  let autoSave = cfgIn.autoSave !== false;

  function save() {
    let store = null;
    try { store = globalThis.localStorage; } catch (err) { store = null; }
    if (!store) return false;
    const data = { v: STORAGE_VERSION, keyboard: {}, gamepad: {}, options: {
      deadzone: { left: options.deadzone.left, right: options.deadzone.right },
      curve: { left: options.curve.left, right: options.curve.right },
      sensitivity: { left: options.sensitivity.left, right: options.sensitivity.right },
      triggerDeadzone: options.triggerDeadzone,
      invertY: options.invertY,
      vibration: { enabled: options.vibration.enabled, strength: options.vibration.strength },
    } };
    for (let i = 0; i < actions.length; i++) {
      const a = actions[i];
      data.keyboard[a] = binds[a].slice();
      data.gamepad[a] = padBinds[a].slice();
    }
    try { store.setItem(storageKey, JSON.stringify(data)); return true; } catch (err) { return false; }
  }

  function load() {
    let raw = null;
    try { raw = globalThis.localStorage ? globalThis.localStorage.getItem(storageKey) : null; } catch (err) { raw = null; }
    if (!raw) return false;
    let data = null;
    try { data = JSON.parse(raw); } catch (err) { return false; }
    if (!data || typeof data !== 'object') return false;

    if (data.keyboard && typeof data.keyboard === 'object') {
      for (const a of Object.keys(data.keyboard)) {
        if (!actionIndex.has(a)) continue;
        const list = cleanList(data.keyboard[a]);
        binds[a] = list;
      }
    }
    if (data.gamepad && typeof data.gamepad === 'object') {
      for (const a of Object.keys(data.gamepad)) {
        if (!actionIndex.has(a)) continue;
        const list = cleanList(data.gamepad[a]);
        const ok = [];
        for (let i = 0; i < list.length; i++) if (parseToken(list[i])) ok.push(list[i]);
        padBinds[a] = ok;
      }
    }
    const o = data.options;
    if (o && typeof o === 'object') {
      if (o.deadzone) {
        if (Number.isFinite(o.deadzone.left)) options.deadzone.left = Math.min(0.6, Math.max(0, o.deadzone.left));
        if (Number.isFinite(o.deadzone.right)) options.deadzone.right = Math.min(0.6, Math.max(0, o.deadzone.right));
      }
      if (o.curve) {
        if (o.curve.left === 'linear' || o.curve.left === 'quadratic' || o.curve.left === 'cubic') options.curve.left = o.curve.left;
        if (o.curve.right === 'linear' || o.curve.right === 'quadratic' || o.curve.right === 'cubic') options.curve.right = o.curve.right;
      }
      if (o.sensitivity) {
        if (Number.isFinite(o.sensitivity.left)) options.sensitivity.left = Math.min(3, Math.max(0.2, o.sensitivity.left));
        if (Number.isFinite(o.sensitivity.right)) options.sensitivity.right = Math.min(3, Math.max(0.2, o.sensitivity.right));
      }
      if (Number.isFinite(o.triggerDeadzone)) options.triggerDeadzone = Math.min(0.5, Math.max(0, o.triggerDeadzone));
      options.invertY = !!o.invertY;
      if (o.vibration) {
        options.vibration.enabled = o.vibration.enabled !== false;
        if (Number.isFinite(o.vibration.strength)) options.vibration.strength = Math.min(2, Math.max(0, o.vibration.strength));
      }
    }
    rebuild();
    return true;
  }

  if (cfgIn.autoLoad !== false) { try { load(); } catch (err) { /* corrupt store — defaults stand */ } }

  // ---- listeners ----------------------------------------------------------

  if (hasWindow) {
    target.addEventListener('keydown', onKeyDown, { passive: false });
    target.addEventListener('keyup', onKeyUp, { passive: false });
    target.addEventListener('blur', onBlur);
    target.addEventListener('gamepadconnected', onPadConnected);
    target.addEventListener('gamepaddisconnected', onPadDisconnected);
  }

  // ---- public API ---------------------------------------------------------

  const api = {
    state,
    binds,
    options,
    actions,
    ACTION_INFO,

    /** 'gamepad' | 'keyboard' — flips the moment the other device is used. */
    get activeDevice() { return activeDevice; },
    set activeDevice(d) { if (d === 'gamepad' || d === 'keyboard') setActiveDevice(d); },

    /** onDeviceChange(fn) -> unsubscribe. fn('gamepad'|'keyboard'). */
    onDeviceChange(fn) {
      if (typeof fn !== 'function') return noop;
      deviceSubs.push(fn);
      return () => {
        const i = deviceSubs.indexOf(fn);
        if (i >= 0) deviceSubs.splice(i, 1);
      };
    },

    // -- binds --------------------------------------------------------------

    /**
     * setBind(action, keys)                  legacy keyboard form
     * setBind(action, 'keyboard'|'gamepad', inputs)
     * Returns the clashing action name (if any) — the bind is applied either way.
     */
    setBind(action, a, b) {
      let device = 'keyboard';
      let inputs = a;
      if (a === 'keyboard' || a === 'gamepad') { device = a; inputs = b; }
      const i = ensureAction(action);
      const list = cleanList(inputs);
      if (device === 'gamepad') {
        const ok = [];
        for (let k = 0; k < list.length; k++) if (parseToken(list[k])) ok.push(list[k]);
        padBinds[action] = ok;
      } else {
        binds[action] = list;
      }
      // A rebind must not leave the action stuck down from its previous input.
      A.keyHeld[i] = 0;
      A.padHeld[i] = 0;
      A.downNow[i] = A.harnessHeld[i] ? 1 : 0;
      rebuild();
      if (autoSave) save();
      return api.conflict(action, device, device === 'gamepad' ? padBinds[action] : binds[action]);
    },

    getBind(action, device) {
      return (device === 'gamepad' ? padBinds[action] : binds[action]) || null;
    },

    addBind(action, device, input) {
      const cur = ((device === 'gamepad' ? padBinds[action] : binds[action]) || []).slice();
      if (cur.indexOf(input) < 0) cur.push(input);
      return api.setBind(action, device === 'gamepad' ? 'gamepad' : 'keyboard', cur);
    },

    /**
     * conflict(action, device, inputs) -> clashing action name | null.
     * `inputs` may be a single token or an array. Exempt pairs (back/brake,
     * forward/pedal) are allowed to share and never report.
     */
    conflict(action, device, inputs) {
      const list = cleanList(inputs);
      if (!list.length) return null;
      const table = device === 'gamepad' ? padBinds : binds;
      const grp = exempt.get(action);
      for (let i = 0; i < actions.length; i++) {
        const other = actions[i];
        if (other === action) continue;
        if (grp !== undefined && exempt.get(other) === grp) continue;
        const arr = table[other];
        if (!Array.isArray(arr)) continue;
        for (let k = 0; k < list.length; k++) if (arr.indexOf(list[k]) >= 0) return other;
      }
      return null;
    },

    /** resetDefaults() -> both devices; resetDefaults('gamepad') -> just that one. */
    resetDefaults(device) {
      for (let i = 0; i < actions.length; i++) {
        const a = actions[i];
        if (device !== 'gamepad') binds[a] = (DEFAULT_BINDS[a] || []).slice();
        if (device !== 'keyboard') padBinds[a] = (DEFAULT_PAD_BINDS[a] || []).slice();
      }
      if (!device) {
        options.deadzone.left = DEFAULT_OPTIONS.deadzone.left;
        options.deadzone.right = DEFAULT_OPTIONS.deadzone.right;
        options.curve.left = DEFAULT_OPTIONS.curve.left;
        options.curve.right = DEFAULT_OPTIONS.curve.right;
        options.sensitivity.left = DEFAULT_OPTIONS.sensitivity.left;
        options.sensitivity.right = DEFAULT_OPTIONS.sensitivity.right;
        options.triggerDeadzone = DEFAULT_OPTIONS.triggerDeadzone;
        options.invertY = DEFAULT_OPTIONS.invertY;
        options.vibration.enabled = DEFAULT_OPTIONS.vibration.enabled;
        options.vibration.strength = DEFAULT_OPTIONS.vibration.strength;
      }
      clearAll();
      rebuild();
      if (autoSave) save();
    },

    save,
    load,
    set autoSave(v) { autoSave = !!v; },
    get autoSave() { return autoSave; },

    // -- analog options -----------------------------------------------------

    setDeadzone(stick, v) {
      const s = stick === 'right' ? 'right' : 'left';
      options.deadzone[s] = Math.min(0.6, Math.max(0, Number(v) || 0));
      if (autoSave) save();
    },
    setSensitivity(stick, v) {
      const s = stick === 'right' ? 'right' : 'left';
      options.sensitivity[s] = Math.min(3, Math.max(0.2, Number(v) || 1));
      if (autoSave) save();
    },
    setCurve(stick, curve) {
      const s = stick === 'right' ? 'right' : 'left';
      if (curve === 'linear' || curve === 'quadratic' || curve === 'cubic') options.curve[s] = curve;
      if (autoSave) save();
    },
    setInvertY(v) { options.invertY = !!v; if (autoSave) save(); },
    setVibration(enabled, strength) {
      options.vibration.enabled = !!enabled;
      if (Number.isFinite(strength)) options.vibration.strength = Math.min(2, Math.max(0, strength));
      if (!options.vibration.enabled) stopRumble();
      if (autoSave) save();
    },

    // -- rumble -------------------------------------------------------------

    /**
     * rumble(strong, weak, ms) — queued, so a landing thump and a grind loop
     * layer instead of cancelling each other. No-op without pad haptics.
     */
    rumble(strong = 0.6, weak = 0.4, ms = 140) {
      if (!options.vibration.enabled) return false;
      const s = Math.min(1, Math.max(0, strong));
      const w = Math.min(1, Math.max(0, weak));
      const until = now + Math.max(10, ms);
      let slot = null;
      let weakest = null;
      for (let i = 0; i < RUMBLE_SLOTS; i++) {
        const c = rumbleSlots[i];
        if (!c.active || now >= c.until) { slot = c; break; }
        if (!weakest || (c.strong + c.weak) < (weakest.strong + weakest.weak)) weakest = c;
      }
      if (!slot) {
        if (weakest && (weakest.strong + weakest.weak) >= s + w) return false;
        slot = weakest;
      }
      if (!slot) return false;
      slot.active = true;
      slot.strong = s;
      slot.weak = w;
      slot.until = until;
      return true;
    },
    stopRumble,

    // -- rebind capture -----------------------------------------------------

    /**
     * beginCapture(action, device, { timeoutMs = 6000 })
     * -> Promise<{ action, device, input, label, conflict, reason } | null>
     * Resolves null on Escape (keyboard), B (pad) or timeout. Game actions are
     * suspended while a capture is live.
     */
    beginCapture(action, device = 'keyboard', opt) {
      api.cancelCapture();
      const dev = device === 'gamepad' ? 'gamepad' : 'keyboard';
      const timeoutMs = (opt && Number.isFinite(opt.timeoutMs)) ? opt.timeoutMs : 6000;
      clearAll();
      // poll() may not have run yet (settings opened before the first frame),
      // so fall back to the wall clock poll() itself is fed from.
      const t0 = now || (typeof performance !== 'undefined' ? performance.now() : 0);
      return new Promise((resolve) => {
        capture = { action, device: dev, resolve, deadline: t0 + timeoutMs, based: false };
      });
    },
    cancelCapture() { if (capture) finishCapture(null, 'cancelled'); },
    get capturing() { return !!capture; },

    // -- glyphs -------------------------------------------------------------

    /**
     * glyphFor(action, device = activeDevice)
     * -> { device, label, kind, input, wide }
     * kind: 'face'|'shoulder'|'trigger'|'dpad'|'stick'|'system'|'key'|'none'
     */
    glyphFor(action, device) {
      const dev = device === 'gamepad' || device === 'keyboard' ? device : activeDevice;
      if (dev === 'gamepad') {
        const list = padBinds[action];
        const tok = list && list.length ? list[0] : null;
        if (!tok) return { device: 'gamepad', label: '—', kind: 'none', input: null, wide: false };
        const g = padLabelFor(tok);
        return { device: 'gamepad', label: g.label, kind: g.kind, input: tok, wide: g.label.length > 2 };
      }
      const list = binds[action];
      const code = list && list.length ? list[0] : null;
      if (!code) return { device: 'keyboard', label: '—', kind: 'none', input: null, wide: false };
      return { device: 'keyboard', label: keyLabelFor(code), kind: 'key', input: code, wide: !!WIDE_KEYS[code] };
    },

    /** Label for a raw bind token, for list rows in the settings screen. */
    labelFor(input, device) {
      return device === 'gamepad' ? padLabelFor(input).label : keyLabelFor(input);
    },

    // -- polling ------------------------------------------------------------

    poll(elapsedMs) {
      now = elapsedMs;

      // Previous-frame snapshot. Keyboard edges are already folded in (see the
      // header note) — this is what makes pressed() a pad-edge signal.
      for (let i = 0; i < actions.length; i++) {
        A.downPrev[i] = A.downNow[i];
        A.padWas[i] = A.padHeld[i];
      }

      pollCapture();
      samplePads();

      if (capture) {
        // Suspend gameplay input while the settings screen is listening.
        for (let i = 0; i < actions.length; i++) { A.padHeld[i] = 0; A.padValue[i] = 0; A.downNow[i] = 0; }
        state.steer = 0; state.lean = 0; state.throttle = 0; state.brake = 0;
        state.look.x = 0; state.look.y = 0;
        updateRumble();
        return;
      }

      if (padActivity) setActiveDevice('gamepad');

      for (let i = 0; i < actions.length; i++) {
        const on = (A.keyHeld[i] | A.padHeld[i] | A.harnessHeld[i]) ? 1 : 0;
        if (on && !A.downPrev[i]) A.lastPress[i] = now;
        A.downNow[i] = on;
      }

      // --- digital baseline (keyboard + d-pad) -------------------------------
      let steer = (A.downNow[iRight] ? 1 : 0) - (A.downNow[iLeft] ? 1 : 0);
      let lean = (A.downNow[iBack] ? 1 : 0) - (A.downNow[iFwd] ? 1 : 0);
      let throttle = A.downNow[iPedal] ? 1 : (A.downNow[iFwd] ? 0.55 : 0);
      let brake = (A.downNow[iBrake] && !A.downNow[iPedal]) ? 1 : 0;

      // --- analog overrides --------------------------------------------------
      if (state.anyGamepad) {
        shapeStick(mLX, mLY, options.deadzone.left, options.curve.left, options.sensitivity.left);
        if (shapedX !== 0) steer = shapedX;
        if (shapedY !== 0) lean = shapedY;

        const td = options.triggerDeadzone;
        // Analog strength of whatever is actually bound to pedal/brake, so a
        // rebind onto a face button still gives a clean 0..1.
        const pv = A.padValue[iPedal];
        const bv = A.padValue[iBrake];
        if (pv > td) throttle = Math.min(1, (pv - td) / (1 - td));
        else if (mRT > td && A.padHeld[iPedal]) throttle = Math.min(1, (mRT - td) / (1 - td));
        if (bv > td) brake = Math.min(1, (bv - td) / (1 - td));
        else if (mLT > td && A.padHeld[iBrake]) brake = Math.min(1, (mLT - td) / (1 - td));

        shapeStick(mRX, mRY, options.deadzone.right, options.curve.right, options.sensitivity.right);
        state.look.x = shapedX;
        state.look.y = options.invertY ? -shapedY : shapedY;
      } else {
        state.look.x = 0;
        state.look.y = 0;
      }

      state.steer = steer < -1 ? -1 : (steer > 1 ? 1 : steer);
      state.lean = lean < -1 ? -1 : (lean > 1 ? 1 : lean);
      state.throttle = throttle < 0 ? 0 : (throttle > 1 ? 1 : throttle);
      state.brake = brake < 0 ? 0 : (brake > 1 ? 1 : brake);

      // Scripted-input hook used by the screenshot harness / demo autopilot.
      // Clearing `harness` must also drop anything it was holding, or a stale
      // held action leaks into whatever runs next.
      if (!api.harness && harnessActive) {
        for (let i = 0; i < N; i++) {
          if (!A.harnessHeld[i]) continue;
          A.harnessHeld[i] = 0;
          A.downNow[i] = (A.keyHeld[i] | A.padHeld[i]) ? 1 : 0;
        }
        harnessActive = false;
      }
      if (api.harness) {
        harnessActive = true;
        const h = api.harness(now, api);
        if (h) {
          if (h.steer != null) state.steer = h.steer;
          if (h.lean != null) state.lean = h.lean;
          if (h.throttle != null) state.throttle = h.throttle;
          if (h.brake != null) state.brake = h.brake;
          if (h.look) { state.look.x = h.look.x || 0; state.look.y = h.look.y || 0; }
          if (h.press) {
            for (let i = 0; i < h.press.length; i++) {
              const idx = actionIndex.get(h.press[i]);
              if (idx === undefined) continue;
              A.harnessHeld[idx] = 1;
              if (!A.downNow[idx]) A.lastPress[idx] = now;
              A.downNow[idx] = 1;
            }
          }
          if (h.release) {
            for (let i = 0; i < h.release.length; i++) {
              const idx = actionIndex.get(h.release[i]);
              if (idx === undefined) continue;
              A.harnessHeld[idx] = 0;
              A.downNow[idx] = (A.keyHeld[idx] | A.padHeld[idx]) ? 1 : 0;
            }
          }
        }
      }

      updateRumble();
    },

    /** fn(nowMs, input) -> { steer, lean, throttle, brake, press:[], release:[] } | null */
    harness: null,

    _keyHeld(action) {
      const i = actionIndex.get(action);
      return i !== undefined && A.keyHeld[i] === 1;
    },

    held(a) { const i = actionIndex.get(a); return i !== undefined && A.downNow[i] === 1; },
    pressed(a) { const i = actionIndex.get(a); return i !== undefined && A.downNow[i] === 1 && A.downPrev[i] === 0; },
    released(a) { const i = actionIndex.get(a); return i !== undefined && A.downNow[i] === 0 && A.downPrev[i] === 1; },
    /** Analog 0..1 for an action's pad binding (triggers, stick edges). */
    analog(a) { const i = actionIndex.get(a); return i === undefined ? 0 : A.padValue[i]; },

    /** Was `a` pressed within the last `ms` milliseconds? Used for trick buffering. */
    bufferedIn(a, ms = 220) {
      const i = actionIndex.get(a);
      if (i === undefined) return false;
      const t = A.lastPress[i];
      return t > -1e11 && now - t <= ms;
    },
    consumeBuffer(a) { const i = actionIndex.get(a); if (i !== undefined) A.lastPress[i] = -1e12; },

    dispose() {
      api.cancelCapture();
      stopRumble();
      deviceSubs.length = 0;
      if (hasWindow) {
        target.removeEventListener('keydown', onKeyDown);
        target.removeEventListener('keyup', onKeyUp);
        target.removeEventListener('blur', onBlur);
        target.removeEventListener('gamepadconnected', onPadConnected);
        target.removeEventListener('gamepaddisconnected', onPadDisconnected);
      }
    },
  };

  return api;
}

export default createInput;
