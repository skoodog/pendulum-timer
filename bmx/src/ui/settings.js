// =============================================================================
// CONCRETE REPUBLIC — SETTINGS
// =============================================================================
//
// The options screen: five tabs (CONTROLS / VIDEO / AUDIO / GAMEPLAY / DATA),
// every row operable with mouse, keyboard and gamepad, every change applied live
// and persisted to localStorage.
//
// Contract
// --------
//   const settings = createSettings(ctx);
//   settings.open('video')      open (optionally on a named tab)
//   settings.close()            close and save
//   settings.isOpen             boolean getter
//   settings.update(dt, ctx)    per frame — pad navigation, fps counter, watchdogs
//   settings.dispose()          full teardown, restores everything it patched
//   settings.settings           the live values object (also on ctx.settings)
//
// Ownership rules this file obeys
// -------------------------------
//  * It owns src/ui/settings.js and nothing else. hud.css and screens.js are read
//    for their visual language; the stylesheet below is injected under a private
//    `.cfg-` namespace and never touches theirs.
//  * Input bindings, deadzones, sensitivity, invert-Y and vibration live in
//    input.js and persist there — this screen drives them through the public API
//    (setBind / beginCapture / conflict / resetDefaults / setDeadzone / ...) so
//    there is exactly one source of truth for them.
//  * Everything else (video, audio, gameplay, HUD) lives in the `settings` object
//    below, is persisted under STORAGE_KEY, and is broadcast on every change as
//    `ctx.emit('settingschange', { settings, section, key, value })` so sibling
//    systems can react without importing this file.
//
// Live application
// ----------------
//  * Quality tier      -> ctx.engine.setQuality()
//  * Resolution scale  -> engine.tier.pixelRatio + engine.resize()
//  * Grade / bloom     -> engine.passes.gradePass.uniforms + bloomPass
//  * Shadows           -> renderer.shadowMap + every shadow-casting light
//  * Speed blur        -> engine.setSpeedBlur is wrapped with a scale factor,
//                         because camera.js re-drives it every frame
//  * FOV               -> cameraRig.setFov / cameraRig.TUNE.fovBase when they
//                         exist; otherwise a get/set accessor on camera.fov adds
//                         the player's offset on top of whatever the rig writes
//  * Audio             -> ctx.audio setters, with live preview cues
//  * HUD               -> `--u` on the HUD root + private visibility classes
//  * Difficulty        -> scales the landing/bail tolerances in physics TUNING
//
// Only one modal may own the pad at a time: while this screen is up it keeps
// screens.js closed (remembering what was showing) and restores it on the way
// out, so the two never fight over the d-pad.
//
// All branding invented. No downloads: glyphs come from ./glyphs.js, type comes
// from the same system-font stack as the HUD.
// =============================================================================

import { createGlyphs } from './glyphs.js';
import { ACTIONS as DEFAULT_ACTIONS, ACTION_INFO as DEFAULT_ACTION_INFO } from '../core/input.js';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const STORAGE_KEY = 'concreterepublic.settings.v2';
const STORAGE_VERSION = 2;

/** Mirrors scoring.js's own key — used only to persist a reset immediately. */
const PROFILE_KEY = 'mirracity.profile.v2';

/** The shipped base FOV (engine.js camera + camera.js TUNE.fovBase). */
const BASE_FOV = 62;

const QUALITY_ORDER = ['low', 'medium', 'high', 'ultra'];
const QUALITY_LABEL = { low: 'LOW', medium: 'MEDIUM', high: 'HIGH', ultra: 'ULTRA' };

const SHADOW_ORDER = ['auto', 'off', 'low', 'medium', 'high'];
const SHADOW_LABEL = { auto: 'MATCH QUALITY', off: 'OFF', low: 'LOW', medium: 'MEDIUM', high: 'HIGH' };
const SHADOW_SIZE = { off: 0, low: 1024, medium: 2048, high: 4096 };

const CURVE_ORDER = ['linear', 'quadratic', 'cubic'];
const CURVE_LABEL = { linear: 'LINEAR', quadratic: 'SMOOTH', cubic: 'PRECISE' };

const RUN_LENGTHS = [60, 90, 120, 180, 300];

const DIFFICULTY_ORDER = ['casual', 'am', 'pro', 'sick'];
const DIFFICULTY_LABEL = { casual: 'CASUAL', am: 'AM', pro: 'PRO', sick: 'SICK' };
/** Multiplier on the forgiving side of the physics tuning. 'am' is shipped tuning. */
const DIFFICULTY_SCALE = {
  casual: { tol: 1.5, impact: 1.32, balance: 0.62 },
  am: { tol: 1.0, impact: 1.0, balance: 1.0 },
  pro: { tol: 0.86, impact: 0.92, balance: 1.18 },
  sick: { tol: 0.74, impact: 0.84, balance: 1.36 },
};

/** HUD element toggles: setting key -> the class added to the HUD root. */
const HUD_PARTS = [
  ['score', 'SCORE', 'The score readout in the top-left corner'],
  ['special', 'SPECIAL METER', 'The orange signature-trick meter under the score'],
  ['board', 'LEADERBOARD', 'The five-rider competition board you climb during a run'],
  ['challenges', 'CHALLENGES', 'The nine per-run goals, letters and smash counter'],
  ['timer', 'RUN TIMER', 'The clock and air-time readout across the top'],
  ['trickList', 'TRICK LIST', 'The landed-trick counter and difficulty tag, top-right'],
  ['callout', 'TRICK CALLOUT', 'The score and trick chain that pops at the bottom'],
  ['balance', 'BALANCE METERS', 'Grind and manual balance needles'],
  ['hint', 'BUTTON HINTS', 'The control reminder along the bottom edge'],
];

const TABS = [
  { id: 'controls', label: 'CONTROLS', sub: 'Select a row and press to rebind — Escape or B cancels' },
  { id: 'video', label: 'VIDEO', sub: 'Quality, image, camera' },
  { id: 'audio', label: 'AUDIO', sub: 'Levels and preview' },
  { id: 'gameplay', label: 'GAMEPLAY', sub: 'Run length, HUD, difficulty' },
  { id: 'data', label: 'DATA', sub: 'Saved progress' },
];

/** One line of help per bindable action — the settings screen is where a new
 *  player learns what the trick modifiers actually do. */
const ACTION_HELP = {
  forward: 'Soft pedal, and the lean that sets up a nose manual',
  back: 'Rear brake, and the lean that pulls into a manual',
  left: 'Steer left; in the air it drifts your landing line',
  right: 'Steer right; in the air it drifts your landing line',
  pedal: 'Full sprint — the only way to reach 14 m/s before the roll-in',
  brake: 'Squeeze for control, lock it for a skid',
  hop: 'Bunnyhop. Hold to load it, release at the lip for the biggest air',
  spinLeft: 'Throws an anticlockwise spin: 360, 540, 720',
  spinRight: 'Throws a clockwise spin: 360, 540, 720',
  trickA: 'Grabs and body tricks — tabletop, superman, toboggan, can-can',
  trickB: 'Bike spins — barspin, tailwhip, X-up, decade',
  trickC: 'Flips — backflip, frontflip, flair',
  grind: 'Hold near coping, a rail or a ledge to lock into a grind or lip trick',
  manual: 'Balance on the back wheel to link two features into one line',
  special: 'Signature trick, once the SPECIAL meter is full',
  trickList: 'Opens the full trick list and how many of them you have landed',
  reset: 'Respawn at the last safe spot — the combo goes with it',
  pause: 'Pause the run and open this menu',
  camera: 'Cycle the chase camera framing',
  debug: 'Developer overlay: colliders, contacts and timings',
};

const ACTION_GROUPS = [
  ['ride', 'RIDING', 'Everything that moves the bike'],
  ['tricks', 'TRICKS', 'Modifiers, grinds, manuals and the signature trick'],
  ['system', 'SYSTEM', 'Menus, respawn and overlays'],
];

/** Standard Gamepad API token -> glyphs.js glyph name. */
const PAD_TOKEN_GLYPH = {
  b0: 'a', b1: 'b', b2: 'x', b3: 'y', b4: 'lb', b5: 'rb', b6: 'lt', b7: 'rt',
  b8: 'back-btn', b9: 'start', b10: 'ls-press', b11: 'rs-press',
  b12: 'dpad-up', b13: 'dpad-down', b14: 'dpad-left', b15: 'dpad-right', b16: 'guide',
  'a0-': 'ls-left', 'a0+': 'ls-right', 'a1-': 'ls-up', 'a1+': 'ls-down',
  'a2-': 'rs-left', 'a2+': 'rs-right', 'a3-': 'rs-up', 'a3+': 'rs-down',
};

// -----------------------------------------------------------------------------
// Defaults
// -----------------------------------------------------------------------------

/**
 * Every default is a no-op against the shipped look: the multipliers sit at 1,
 * shadows follow the quality tier and the FOV is the engine's own. Turning the
 * settings screen on changes nothing until the player moves something.
 */
function defaults() {
  return {
    v: STORAGE_VERSION,
    video: {
      quality: 'high',
      resolution: 1,        // × the tier's pixel ratio
      fov: BASE_FOV,        // degrees
      speedBlur: 1,         // × the camera rig's request
      bloom: 1,
      grain: 1,
      aberration: 1,
      vignette: 1,
      shadows: 'auto',
      fps: false,
    },
    audio: { master: 0.85, music: 0.55, sfx: 1, crowd: 0.85 },
    gameplay: {
      runLength: 120,
      difficulty: 'am',
      autoRestart: false,
      hudScale: 1,
      cameraDistance: 5.4,
      cameraHeight: 1.85,
      hud: {
        score: true, special: true, board: true, challenges: true, timer: true,
        trickList: true, callout: true, balance: true, hint: true,
      },
    },
  };
}

// -----------------------------------------------------------------------------
// Small helpers
// -----------------------------------------------------------------------------

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function num(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function pick(v, list, fallback) {
  return list.indexOf(v) >= 0 ? v : fallback;
}

function pct(v) { return Math.round(v * 100) + '%'; }

function timeText(s) {
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return m + ':' + (r < 10 ? '0' : '') + r;
}

/** Quantise to a step without floating-point fuzz. */
function quantise(v, min, max, step) {
  if (!(step > 0)) return clamp(v, min, max);
  const n = Math.round((v - min) / step);
  return clamp(Math.round((min + n * step) * 1e6) / 1e6, min, max);
}

// =============================================================================

export function createSettings(ctx) {
  const context = ctx || {};
  const input = context.input || null;
  const engine = context.engine || null;

  // ---------------------------------------------------------------- state ----

  const S = defaults();
  let open = false;
  let tabIndex = 0;
  let disposed = false;
  let listening = null;          // bind row currently capturing
  let armed = null;              // row with a confirm step armed
  let armedTimer = 0;
  let statusTimer = 0;
  let prevScreen = null;         // screens.js state to restore on close
  let prevFocus = null;
  let deviceUserPicked = false;
  let ctrlDevice = (input && input.activeDevice === 'gamepad') ? 'gamepad' : 'keyboard';

  const glyphs = createGlyphs(context);

  // ------------------------------------------------------------ persistence --

  let saveTimer = 0;

  function store() {
    try { return globalThis.localStorage || null; } catch (err) { return null; }
  }

  function save() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = 0; }
    const st = store();
    if (!st) return false;
    try { st.setItem(STORAGE_KEY, JSON.stringify(S)); return true; } catch (err) { return false; }
  }

  function queueSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(save, 400);
  }

  /**
   * Read the stored blob field by field. Anything missing, of the wrong type or
   * from an older shape simply falls back to the default, so a corrupt or
   * out-of-date entry can never take the boot down or half-apply.
   */
  function load() {
    const st = store();
    if (!st) return false;
    let raw = null;
    try { raw = st.getItem(STORAGE_KEY); } catch (err) { raw = null; }
    if (!raw) return false;
    let d = null;
    try { d = JSON.parse(raw); } catch (err) { return false; }
    if (!d || typeof d !== 'object') return false;

    const v = d.video && typeof d.video === 'object' ? d.video : {};
    S.video.quality = pick(v.quality, QUALITY_ORDER, S.video.quality);
    S.video.resolution = clamp(num(v.resolution, S.video.resolution), 0.5, 1.5);
    S.video.fov = clamp(num(v.fov, S.video.fov), 50, 95);
    S.video.speedBlur = clamp(num(v.speedBlur, S.video.speedBlur), 0, 1.5);
    S.video.bloom = clamp(num(v.bloom, S.video.bloom), 0, 2);
    S.video.grain = clamp(num(v.grain, S.video.grain), 0, 2);
    S.video.aberration = clamp(num(v.aberration, S.video.aberration), 0, 2);
    S.video.vignette = clamp(num(v.vignette, S.video.vignette), 0, 2);
    S.video.shadows = pick(v.shadows, SHADOW_ORDER, S.video.shadows);
    S.video.fps = !!v.fps;

    const a = d.audio && typeof d.audio === 'object' ? d.audio : {};
    S.audio.master = clamp(num(a.master, S.audio.master), 0, 1);
    S.audio.music = clamp(num(a.music, S.audio.music), 0, 1);
    S.audio.sfx = clamp(num(a.sfx, S.audio.sfx), 0, 1);
    S.audio.crowd = clamp(num(a.crowd, S.audio.crowd), 0, 1);

    const g = d.gameplay && typeof d.gameplay === 'object' ? d.gameplay : {};
    S.gameplay.runLength = RUN_LENGTHS.indexOf(Math.round(num(g.runLength, 0))) >= 0
      ? Math.round(g.runLength) : S.gameplay.runLength;
    S.gameplay.difficulty = pick(g.difficulty, DIFFICULTY_ORDER, S.gameplay.difficulty);
    S.gameplay.autoRestart = !!g.autoRestart;
    S.gameplay.hudScale = clamp(num(g.hudScale, S.gameplay.hudScale), 0.7, 1.5);
    S.gameplay.cameraDistance = clamp(num(g.cameraDistance, S.gameplay.cameraDistance), 3.4, 8.5);
    S.gameplay.cameraHeight = clamp(num(g.cameraHeight, S.gameplay.cameraHeight), 0.9, 3.4);
    const h = g.hud && typeof g.hud === 'object' ? g.hud : {};
    for (let i = 0; i < HUD_PARTS.length; i++) {
      const k = HUD_PARTS[i][0];
      if (typeof h[k] === 'boolean') S.gameplay.hud[k] = h[k];
    }
    return true;
  }

  // ------------------------------------------------------------ event out ----

  function emit(section, key, value) {
    if (typeof context.emit === 'function') {
      try { context.emit('settingschange', { settings: S, section, key, value }); } catch (err) { /* listener fault */ }
    }
  }

  // =========================================================================
  // LIVE APPLICATION
  // =========================================================================

  // --- video ---------------------------------------------------------------

  const passes = (engine && engine.passes) || null;
  const gradeU = passes && passes.gradePass ? passes.gradePass.uniforms : null;
  const bloom = passes ? passes.bloomPass : null;

  const BASE = {
    pixelRatio: engine && engine.tier ? num(engine.tier.pixelRatio, 1.5) : 1.5,
    bloom: bloom ? num(bloom.strength, 0.42) : 0.42,
    grain: gradeU && gradeU.uGrain ? num(gradeU.uGrain.value, 0.028) : 0.028,
    aberration: gradeU && gradeU.uAberration ? num(gradeU.uAberration.value, 0.0016) : 0.0016,
    vignette: gradeU && gradeU.uVignette ? num(gradeU.uVignette.value, 0.42) : 0.42,
  };

  function applyResolution() {
    if (!engine || !engine.tier) return;
    engine.tier.pixelRatio = BASE.pixelRatio * S.video.resolution;
    if (typeof engine.resize === 'function') engine.resize();
  }

  function applyQuality() {
    if (!engine) return;
    if (engine.tier && engine.tier.name !== S.video.quality && typeof engine.setQuality === 'function') {
      engine.setQuality(S.video.quality);
      // setQuality resets the tier wholesale — re-read the new base and re-apply
      // the player's scale and shadow choice on top of it.
      BASE.pixelRatio = num(engine.tier.pixelRatio, BASE.pixelRatio);
    }
    applyResolution();
    applyShadows();
  }

  function applyImage() {
    if (bloom) bloom.strength = BASE.bloom * S.video.bloom;
    if (gradeU) {
      if (gradeU.uGrain) gradeU.uGrain.value = BASE.grain * S.video.grain;
      if (gradeU.uAberration) gradeU.uAberration.value = BASE.aberration * S.video.aberration;
      if (gradeU.uVignette) gradeU.uVignette.value = BASE.vignette * S.video.vignette;
    }
  }

  /** Every shadow-casting light in the scene, sun first. */
  function shadowLights() {
    const out = [];
    if (engine && engine.sunLight && engine.sunLight.shadow) out.push(engine.sunLight);
    const scene = context.scene || (engine && engine.scene);
    if (scene && typeof scene.traverse === 'function') {
      scene.traverse((o) => {
        if (o && o.isLight && o.shadow && out.indexOf(o) < 0) out.push(o);
      });
    }
    return out;
  }

  // Whatever environment.js chose for each light, remembered the first time we
  // touch it so 'MATCH QUALITY' can put it back exactly.
  const shadowBase = typeof WeakMap === 'function' ? new WeakMap() : null;

  function applyShadows() {
    const renderer = context.renderer || (engine && engine.renderer);
    if (!renderer || !renderer.shadowMap) return;
    const mode = S.video.shadows;
    if (mode === 'auto') {
      renderer.shadowMap.enabled = true;
      resizeShadows(0);            // 0 = restore each light's authored size
      renderer.shadowMap.needsUpdate = true;
      return;
    }
    const size = SHADOW_SIZE[mode] || 0;
    renderer.shadowMap.enabled = size > 0;
    if (size > 0) resizeShadows(size);
    renderer.shadowMap.needsUpdate = true;
  }

  /** size > 0 forces that map size; size === 0 restores the authored one. */
  function resizeShadows(size) {
    const lights = shadowLights();
    for (let i = 0; i < lights.length; i++) {
      const light = lights[i];
      const sh = light.shadow;
      if (!sh || !sh.mapSize) continue;
      if (shadowBase && !shadowBase.has(light)) shadowBase.set(light, sh.mapSize.x);
      let want = size;
      if (want <= 0) {
        want = shadowBase && shadowBase.has(light) ? shadowBase.get(light) : sh.mapSize.x;
      }
      if (sh.mapSize.x === want && sh.mapSize.y === want) continue;
      sh.mapSize.set(want, want);
      // The old render target is the wrong size now: drop it and let three
      // rebuild it on the next shadow pass.
      if (sh.map) { sh.map.dispose(); sh.map = null; }
      if (sh.mapPass) { sh.mapPass.dispose(); sh.mapPass = null; }
    }
  }

  // Speed blur: camera.js pushes a fresh value every frame, so the only place a
  // player-facing scale can live is on top of the setter itself.
  let baseSetSpeedBlur = null;
  if (engine && typeof engine.setSpeedBlur === 'function') {
    baseSetSpeedBlur = engine.setSpeedBlur.bind(engine);
    engine.setSpeedBlur = (v) => baseSetSpeedBlur((num(v, 0)) * S.video.speedBlur);
  }

  // FOV: prefer a real hook on the rig; fall back to an accessor that adds the
  // player's offset on top of whatever the rig last wrote.
  let fovHooked = false;
  let fovRaw = BASE_FOV;
  let fovOffset = 0;

  function fovCamera() { return context.camera || (engine && engine.camera) || null; }

  function installFovHook() {
    const cam = fovCamera();
    if (!cam || fovHooked) return;
    try {
      fovRaw = num(cam.fov, BASE_FOV);
      Object.defineProperty(cam, 'fov', {
        configurable: true,
        enumerable: true,
        get() { return fovRaw + fovOffset; },
        set(v) { fovRaw = num(v, fovRaw); },
      });
      fovHooked = true;
    } catch (err) { fovHooked = false; }
  }

  function removeFovHook() {
    const cam = fovCamera();
    if (!cam || !fovHooked) return;
    const value = fovRaw;
    try {
      delete cam.fov;
      cam.fov = value;
    } catch (err) { /* leave it as it stands */ }
    fovHooked = false;
    if (cam.updateProjectionMatrix) cam.updateProjectionMatrix();
  }

  function applyFov() {
    const rig = context.cameraRig;
    let handled = false;
    if (rig) {
      if (typeof rig.setFov === 'function') { rig.setFov(S.video.fov); handled = true; }
      else if (rig.TUNE && typeof rig.TUNE.fovBase === 'number') { rig.TUNE.fovBase = S.video.fov; handled = true; }
    }
    if (handled) {
      fovOffset = 0;
      removeFovHook();
    } else {
      fovOffset = S.video.fov - BASE_FOV;
      if (Math.abs(fovOffset) < 0.01) removeFovHook();
      else installFovHook();
    }
    const cam = fovCamera();
    if (cam && cam.updateProjectionMatrix) cam.updateProjectionMatrix();
  }

  // --- audio ---------------------------------------------------------------

  /** Call the first setter the audio module actually implements. */
  function audioCall(names, value) {
    const a = context.audio;
    if (!a) return false;
    for (let i = 0; i < names.length; i++) {
      const fn = a[names[i]];
      if (typeof fn === 'function') {
        try { fn.call(a, value); return true; } catch (err) { return false; }
      }
    }
    if (typeof a.setBusVolume === 'function') {
      try { a.setBusVolume(names[0], value); return true; } catch (err) { return false; }
    }
    return false;
  }

  function applyAudio() {
    const a = context.audio;
    if (!a) return;
    audioCall(['setMasterVolume', 'setMaster', 'setVolume'], S.audio.master);
    if (typeof a.mute === 'function') {
      const wantMute = S.audio.master <= 0.001;
      if (!!a.muted !== wantMute) { try { a.mute(wantMute); } catch (err) { /* ignore */ } }
    }
    audioCall(['setMusicVolume', 'setMusic'], S.audio.music);
    if (typeof a.enableMusic === 'function') {
      try { a.enableMusic(S.audio.music > 0.001); } catch (err) { /* ignore */ }
    }
    // sfx / crowd have no setter in the shipped audio module: the value is still
    // stored and broadcast, so audio.js can read ctx.settings whenever it grows one.
    audioCall(['setSfxVolume', 'setSFXVolume', 'setEffectsVolume'], S.audio.sfx);
    audioCall(['setCrowdVolume', 'setCrowd'], S.audio.crowd);
  }

  let previewTimer = 0;
  function preview(kind) {
    const a = context.audio;
    if (!a) return;
    if (previewTimer > 0) return;
    previewTimer = 0.16;
    try {
      if (typeof a.resume === 'function') a.resume();
      if (kind === 'crowd') a.play('cheer', { intensity: 0.75 });
      else if (kind === 'sfx') a.play('land', { impact: 6, quality: 1, surface: 'ground' });
      else if (kind === 'music') { /* the bed itself is the preview */ }
      else a.play('uiSelect');
    } catch (err) { /* preview is never load-bearing */ }
  }

  // --- HUD -----------------------------------------------------------------

  function hudRoot() {
    const h = context.hud;
    if (h && h.root) return h.root;
    if (h && h.element) return h.element;
    return document.querySelector('.hud');
  }

  function applyHudScale() {
    const node = hudRoot();
    if (!node) return;
    const s = S.gameplay.hudScale;
    node.style.setProperty('--u',
      'clamp(' + (10 * s).toFixed(2) + 'px, calc((0.55vw + 0.55vh) * ' + s.toFixed(3) + '), '
      + (20 * s).toFixed(2) + 'px)');
  }

  function applyHudParts() {
    const node = hudRoot();
    if (!node) return;
    for (let i = 0; i < HUD_PARTS.length; i++) {
      const k = HUD_PARTS[i][0];
      node.classList.toggle('cfg-hide-' + k, !S.gameplay.hud[k]);
    }
  }

  // --- gameplay ------------------------------------------------------------

  function applyRunLength() {
    const sc = context.player && context.player.scoring;
    if (!sc) return;
    const secs = S.gameplay.runLength;
    if (sc.TUNE && typeof sc.TUNE.sessionTime === 'number') sc.TUNE.sessionTime = secs;
    if (typeof sc.setSessionTime === 'function') {
      try { sc.setSessionTime(secs); } catch (err) { /* ignore */ }
    }
    // Only rewrite the live clock when a run has not started yet.
    if (sc.phase !== 'run') {
      sc.timeTotal = secs;
      sc.timeLeft = secs;
      const m = Math.floor(secs / 60);
      const r = Math.floor(secs - m * 60);
      sc.timeText = m + ':' + (r < 10 ? '0' : '') + r;
    }
  }

  // Physics tolerances: captured once so difficulty always scales the shipped
  // numbers instead of compounding on top of the previous setting.
  let physBase = null;
  function applyDifficulty() {
    const phys = context.player && context.player.physics;
    const T = phys && phys.TUNING;
    if (context.flags) context.flags.difficulty = S.gameplay.difficulty;
    if (phys && typeof phys.setDifficulty === 'function') {
      try { phys.setDifficulty(S.gameplay.difficulty); } catch (err) { /* ignore */ }
    }
    if (!T) return;
    if (!physBase) {
      physBase = {
        landYawTol: num(T.landYawTol, 0.611),
        landPitchTol: num(T.landPitchTol, 0.436),
        landRollTol: num(T.landRollTol, 0.436),
        maxImpactSpeed: num(T.maxImpactSpeed, 17),
        balanceGravity: num(T.balanceGravity, 4.2),
      };
    }
    const k = DIFFICULTY_SCALE[S.gameplay.difficulty] || DIFFICULTY_SCALE.am;
    T.landYawTol = physBase.landYawTol * k.tol;
    T.landPitchTol = physBase.landPitchTol * k.tol;
    T.landRollTol = physBase.landRollTol * k.tol;
    T.maxImpactSpeed = physBase.maxImpactSpeed * k.impact;
    T.balanceGravity = physBase.balanceGravity * k.balance;
  }

  function applyCameraTune() {
    const rig = context.cameraRig;
    if (!rig) return;
    if (typeof rig.setChase === 'function') {
      try { rig.setChase(S.gameplay.cameraDistance, S.gameplay.cameraHeight); return; } catch (err) { /* fall through */ }
    }
    if (typeof rig.setDistance === 'function') { try { rig.setDistance(S.gameplay.cameraDistance); } catch (err) { /* ignore */ } }
    if (typeof rig.setHeight === 'function') { try { rig.setHeight(S.gameplay.cameraHeight); } catch (err) { /* ignore */ } }
    const T = rig.TUNE || rig.tune;
    if (T && typeof T.distance === 'number') {
      const dd = S.gameplay.cameraDistance - 5.4;
      const dh = S.gameplay.cameraHeight - 1.85;
      T.distance = S.gameplay.cameraDistance;
      T.height = S.gameplay.cameraHeight;
      if (typeof T.airDistance === 'number') T.airDistance = 6.9 + dd;
      if (typeof T.airHeight === 'number') T.airHeight = 2.5 + dh;
    }
  }

  // --- input mirrors -------------------------------------------------------

  function inputOptions() {
    return (input && input.options) || null;
  }

  // --- everything ----------------------------------------------------------

  function applyAll() {
    const steps = [
      applyQuality, applyImage, applyShadows, applyFov,
      applyAudio, applyHudScale, applyHudParts,
      applyRunLength, applyDifficulty, applyCameraTune,
    ];
    for (let i = 0; i < steps.length; i++) {
      try { steps[i](); } catch (err) { /* a bad sibling must never break the menu */ }
    }
  }

  // =========================================================================
  // STYLE
  // =========================================================================

  const CSS = `
.cfg-root{
  position:absolute; inset:0; z-index:60; pointer-events:none;
  user-select:none; -webkit-user-select:none; -webkit-font-smoothing:antialiased;
  --su: clamp(9px, calc(0.52vw + 0.52vh), 17px);
  --gold:#ffc434; --gold2:#ffe89a; --amber:#ff8f16; --accent:#5ad4ff;
  --red:#ff4b39; --green:#6ee87f; --violet:#c08cff;
  --ink:rgba(255,255,255,.95); --dim:rgba(255,255,255,.58); --dim2:rgba(255,255,255,.34);
  --line:rgba(255,255,255,.10);
  --sh:0 1px 2px rgba(0,0,0,.9), 0 0 12px rgba(0,0,0,.5);
  font-family:"Oswald","Roboto Condensed","Barlow Condensed","Archivo Narrow",
    "Liberation Sans Narrow","DejaVu Sans Condensed","Arial Narrow",
    "Franklin Gothic Medium","Impact",system-ui,"Segoe UI",sans-serif;
  font-weight:700; font-stretch:87.5%; color:var(--ink); line-height:1;
  letter-spacing:.012em; font-variant-numeric:tabular-nums lining-nums;
}
.cfg-root *{box-sizing:border-box; margin:0;}
.cfg-root button{
  font:inherit; color:inherit; letter-spacing:inherit; background:none; border:0;
  padding:0; cursor:pointer; text-align:left; -webkit-appearance:none; appearance:none;
}
.cfg-root button:focus{outline:none;}

/* ---- scrim ------------------------------------------------------------- */
.cfg-scrim{
  position:absolute; inset:0; opacity:0; visibility:hidden;
  background:radial-gradient(120% 100% at 50% 40%, rgba(4,6,11,.46), rgba(2,3,6,.80));
  transition:opacity 260ms ease, visibility 0s linear 260ms;
}
.cfg-root.is-open .cfg-scrim{
  opacity:1; visibility:visible;
  backdrop-filter:blur(14px) saturate(.80) brightness(.58);
  -webkit-backdrop-filter:blur(14px) saturate(.80) brightness(.58);
  transition:opacity 260ms ease, visibility 0s;
}

/* ---- shell ------------------------------------------------------------- */
.cfg-wrap{
  position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
  padding:calc(var(--su)*1.4);
  opacity:0; visibility:hidden; pointer-events:none;
  transform:translateY(1.4%) scale(.985);
  transition:opacity 200ms ease, transform 320ms cubic-bezier(.2,.9,.25,1), visibility 0s linear 240ms;
}
.cfg-root.is-open .cfg-wrap{
  opacity:1; visibility:visible; pointer-events:auto; transform:none;
  transition:opacity 220ms ease, transform 420ms cubic-bezier(.16,1,.3,1), visibility 0s;
}
.cfg-panel{
  position:relative; width:100%; max-width:calc(var(--su)*74); max-height:94vh;
  display:flex; flex-direction:column;
  background:linear-gradient(180deg,rgba(10,13,19,.955),rgba(6,8,12,.975));
  border:1px solid rgba(255,255,255,.14);
  box-shadow:0 34px 100px rgba(0,0,0,.82), 0 0 0 1px rgba(0,0,0,.5);
}
.cfg-panel::before{
  content:""; position:absolute; left:0; right:0; top:0; height:calc(var(--su)*.16);
  background:linear-gradient(90deg,var(--amber),var(--gold) 40%,rgba(255,196,52,0) 92%);
}

/* ---- header ------------------------------------------------------------ */
.cfg-head{padding:calc(var(--su)*1.0) calc(var(--su)*1.2) 0;}
.cfg-title-row{display:flex; align-items:baseline; gap:calc(var(--su)*.8);}
.cfg-title{
  font-size:calc(var(--su)*2.2); letter-spacing:.09em; transform:skewX(-7deg);
  transform-origin:left center; text-shadow:var(--sh);
}
.cfg-title b{color:var(--gold); font-weight:700;}
.cfg-sub{
  margin-left:auto; text-align:right; font-size:calc(var(--su)*.9); font-weight:600;
  font-style:italic; color:var(--dim); max-width:50%;
}
.cfg-tabs{
  display:flex; align-items:stretch; gap:calc(var(--su)*.3);
  margin-top:calc(var(--su)*.85); border-bottom:1px solid var(--line);
}
.cfg-tabs .cfg-bump{
  display:flex; align-items:center; padding:0 calc(var(--su)*.3) calc(var(--su)*.5);
  opacity:.85;
}
.cfg-root .cfg-tab{
  position:relative; padding:calc(var(--su)*.5) calc(var(--su)*.85) calc(var(--su)*.62);
  font-size:calc(var(--su)*1.12); letter-spacing:.11em; color:rgba(255,255,255,.5);
  white-space:nowrap; transition:color 140ms linear, background 140ms linear;
}
.cfg-tab::after{
  content:""; position:absolute; left:calc(var(--su)*.3); right:calc(var(--su)*.3); bottom:-1px;
  height:calc(var(--su)*.16); background:var(--gold); transform:scaleX(0);
  transition:transform 220ms cubic-bezier(.16,1,.3,1);
}
.cfg-tab:hover{color:rgba(255,255,255,.82);}
.cfg-tab.is-on{color:#fff; background:linear-gradient(180deg,rgba(255,196,52,0),rgba(255,150,20,.12));}
.cfg-tab.is-on::after{transform:scaleX(1);}
.cfg-tab.is-focus{color:#fff;}
.cfg-tab.is-focus::after{transform:scaleX(1); background:var(--accent);}

/* ---- body -------------------------------------------------------------- */
.cfg-body{
  flex:1 1 auto; overflow-y:auto; overscroll-behavior:contain;
  padding:calc(var(--su)*.2) calc(var(--su)*1.2) calc(var(--su)*1.0);
  scrollbar-width:thin; scrollbar-color:rgba(255,255,255,.24) transparent;
}
.cfg-body::-webkit-scrollbar{width:9px;}
.cfg-body::-webkit-scrollbar-thumb{background:rgba(255,255,255,.2);}
.cfg-body::-webkit-scrollbar-track{background:rgba(255,255,255,.04);}
.cfg-page{display:none;}
.cfg-page.is-on{display:block; animation:cfgPage 260ms cubic-bezier(.16,1,.3,1) both;}
@keyframes cfgPage{from{opacity:0; transform:translateY(calc(var(--su)*.7));} to{opacity:1; transform:none;}}

.cfg-sec{padding-top:calc(var(--su)*.9);}
.cfg-sec-h{
  display:flex; align-items:center; gap:calc(var(--su)*.7);
  padding:calc(var(--su)*.35) 0 calc(var(--su)*.35);
}
.cfg-sec-h span{font-size:calc(var(--su)*.9); letter-spacing:.26em; color:var(--amber); white-space:nowrap;}
.cfg-sec-h i{flex:1 1 auto; height:1px; background:linear-gradient(90deg,rgba(255,143,22,.5),rgba(255,143,22,0));}
.cfg-sec-h em{font-size:calc(var(--su)*.84); font-weight:600; font-style:italic; color:var(--dim2);
  white-space:nowrap;}

/* ---- rows -------------------------------------------------------------- */
.cfg-root .cfg-row{
  position:relative; display:grid; width:100%; align-items:center;
  grid-template-columns:minmax(0,1fr) minmax(calc(var(--su)*13),auto);
  gap:calc(var(--su)*1.0);
  padding:calc(var(--su)*.46) calc(var(--su)*.7);
  color:rgba(255,255,255,.78);
  border-left:calc(var(--su)*.16) solid transparent;
  transition:background 130ms linear, color 130ms linear, border-color 130ms linear,
    transform 200ms cubic-bezier(.2,.9,.25,1);
}
.cfg-row + .cfg-row{box-shadow:inset 0 1px 0 rgba(255,255,255,.05);}
.cfg-row:hover{color:rgba(255,255,255,.92); background:rgba(255,255,255,.03);}
.cfg-row.is-sel{
  color:#fff; border-left-color:var(--accent);
  background:linear-gradient(90deg,rgba(90,212,255,.15),rgba(90,212,255,.02) 62%,rgba(90,212,255,0));
  transform:translateX(calc(var(--su)*.2));
}
.cfg-row.is-sel .cfg-help{color:rgba(255,255,255,.72);}
.cfg-row.is-danger.is-sel{
  border-left-color:var(--red);
  background:linear-gradient(90deg,rgba(255,75,57,.18),rgba(255,75,57,0) 62%);
}
.cfg-main{min-width:0; display:flex; flex-direction:column; gap:calc(var(--su)*.16);}
.cfg-label{
  font-size:calc(var(--su)*1.14); letter-spacing:.035em; white-space:nowrap;
  overflow:hidden; text-overflow:ellipsis;
}
.cfg-help{
  font-size:calc(var(--su)*.84); font-weight:600; font-style:italic; color:var(--dim);
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; transition:color 130ms linear;
}
.cfg-warn{
  display:none; font-size:calc(var(--su)*.82); font-weight:700; font-style:normal;
  letter-spacing:.08em; color:var(--red);
}
.cfg-row.is-clash .cfg-warn{display:block;}
.cfg-ctl{
  display:flex; align-items:center; justify-content:flex-end; gap:calc(var(--su)*.5);
  justify-self:end; white-space:nowrap;
}

/* ---- slider ------------------------------------------------------------ */
.cfg-slider{display:flex; align-items:center; gap:calc(var(--su)*.6);}
.cfg-track{
  position:relative; width:calc(var(--su)*11); height:calc(var(--su)*.5);
  background:rgba(255,255,255,.13); cursor:pointer;
  box-shadow:inset 0 1px 2px rgba(0,0,0,.6);
}
.cfg-track::after{
  content:""; position:absolute; inset:calc(var(--su)*-.55) 0; /* fat hit area */
}
.cfg-fill{
  position:absolute; left:0; top:0; bottom:0; width:100%; display:block;
  background:linear-gradient(90deg,#ff5f0a,#ffb824 70%,#ffdf5c);
  transform-origin:left center; transform:scaleX(0);
  transition:transform 90ms linear;
}
.cfg-knob{
  position:absolute; top:50%; left:0; display:block;
  width:calc(var(--su)*.42); height:calc(var(--su)*1.28);
  background:#fff; box-shadow:0 1px 4px rgba(0,0,0,.8);
  transform:translate(-50%,-50%); transition:left 90ms linear, background 130ms linear;
}
.cfg-row.is-sel .cfg-knob{background:var(--gold2); box-shadow:0 0 10px rgba(255,196,52,.7);}
.cfg-val{
  min-width:calc(var(--su)*4.2); text-align:right; font-size:calc(var(--su)*1.12);
  color:var(--gold); letter-spacing:.04em;
}

/* ---- option (cycler) --------------------------------------------------- */
.cfg-opt{display:flex; align-items:center; gap:calc(var(--su)*.5);}
.cfg-root .cfg-arw{
  font-size:calc(var(--su)*1.0); color:var(--dim2); padding:0 calc(var(--su)*.15);
  transition:color 130ms linear, transform 130ms linear;
}
.cfg-row.is-sel .cfg-arw{color:var(--accent);}
.cfg-arw:hover{color:#fff; transform:scale(1.2);}
.cfg-optv{
  min-width:calc(var(--su)*8.4); text-align:center; font-size:calc(var(--su)*1.12);
  color:var(--gold); letter-spacing:.08em;
}

/* ---- toggle ------------------------------------------------------------ */
.cfg-toggle{
  position:relative; display:block; width:calc(var(--su)*3.1); height:calc(var(--su)*1.42);
  background:rgba(255,255,255,.14); box-shadow:inset 0 1px 3px rgba(0,0,0,.65);
  transition:background 220ms cubic-bezier(.2,.9,.25,1);
}
.cfg-toggle i{
  position:absolute; top:calc(var(--su)*.16); left:calc(var(--su)*.16); display:block;
  width:calc(var(--su)*1.1); height:calc(var(--su)*1.1);
  background:rgba(255,255,255,.62); box-shadow:0 1px 3px rgba(0,0,0,.7);
  transition:transform 220ms cubic-bezier(.16,1,.3,1), background 220ms linear;
}
.cfg-row.is-on .cfg-toggle{background:linear-gradient(90deg,#ff8f16,#ffc434);}
.cfg-row.is-on .cfg-toggle i{transform:translateX(calc(var(--su)*1.68)); background:#12151b;}
.cfg-state{
  min-width:calc(var(--su)*2.6); text-align:right; font-size:calc(var(--su)*1.06);
  color:var(--dim2); letter-spacing:.1em; transition:color 160ms linear;
}
.cfg-row.is-on .cfg-state{color:var(--gold);}

/* ---- action / confirm -------------------------------------------------- */
.cfg-act{
  padding:calc(var(--su)*.34) calc(var(--su)*.85);
  font-size:calc(var(--su)*1.02); letter-spacing:.12em;
  border:1px solid rgba(255,255,255,.26); color:rgba(255,255,255,.86);
  background:linear-gradient(180deg,rgba(255,255,255,.07),rgba(255,255,255,.01));
  transition:color 130ms linear, background 130ms linear, border-color 130ms linear;
}
.cfg-row.is-sel .cfg-act{color:#12151b; border-color:var(--gold2);
  background:linear-gradient(180deg,var(--gold2),var(--gold));}
.cfg-row.is-danger .cfg-act{border-color:rgba(255,75,57,.55); color:#ffb3aa;}
.cfg-row.is-danger.is-sel .cfg-act{color:#1b0d0b; border-color:#ff8f7f;
  background:linear-gradient(180deg,#ff8f7f,var(--red));}
.cfg-row.is-armed .cfg-act{animation:cfgPulse .9s ease-in-out infinite alternate;}
@keyframes cfgPulse{from{filter:brightness(1);} to{filter:brightness(1.45);}}
.cfg-done{color:var(--green); font-size:calc(var(--su)*1.0); letter-spacing:.12em;}

/* ---- bind rows --------------------------------------------------------- */
.cfg-binds{display:flex; align-items:center; gap:calc(var(--su)*.34); min-height:calc(var(--su)*1.7);}
.cfg-binds .gly{--gly-size:calc(var(--su)*1.86);}
.cfg-bindtxt{font-size:calc(var(--su)*.94); letter-spacing:.08em; color:var(--dim2);}
.cfg-listen{
  display:none; font-size:calc(var(--su)*1.02); letter-spacing:.14em; color:var(--gold);
  animation:cfgBlink .8s steps(2,end) infinite;
}
@keyframes cfgBlink{50%{opacity:.22;}}
.cfg-row.is-listening{background:linear-gradient(90deg,rgba(255,150,20,.26),rgba(255,150,20,0) 70%);
  border-left-color:var(--gold);}
.cfg-row.is-listening .cfg-binds{display:none;}
.cfg-row.is-listening .cfg-listen{display:block;}

/* ---- segmented device picker ------------------------------------------- */
.cfg-seg{display:flex; border:1px solid rgba(255,255,255,.18);}
.cfg-root .cfg-seg-b{
  display:flex; align-items:center; gap:calc(var(--su)*.34); cursor:pointer;
  padding:calc(var(--su)*.3) calc(var(--su)*.7);
  font-size:calc(var(--su)*1.0); letter-spacing:.1em; color:rgba(255,255,255,.55);
  transition:color 140ms linear, background 140ms linear;
}
.cfg-seg-b + .cfg-seg-b{border-left:1px solid rgba(255,255,255,.18);}
.cfg-seg-b.is-on{color:#12151b; background:linear-gradient(180deg,var(--gold2),var(--gold));}
.cfg-seg-b .gly{--gly-size:calc(var(--su)*1.35);}

/* ---- data readout ------------------------------------------------------ */
.cfg-stats{
  display:flex; flex-wrap:wrap; gap:calc(var(--su)*1.2);
  padding:calc(var(--su)*.55) calc(var(--su)*.7) calc(var(--su)*.7);
  font-size:calc(var(--su)*.94); color:var(--dim);
}
.cfg-stats b{color:#fff; font-weight:700;}
.cfg-note{
  padding:calc(var(--su)*.5) calc(var(--su)*.7); font-size:calc(var(--su)*.88);
  font-weight:600; font-style:italic; color:var(--dim); line-height:1.5;
}

/* ---- footer ------------------------------------------------------------ */
.cfg-foot{
  display:flex; align-items:center; gap:calc(var(--su)*1.1); flex-wrap:wrap;
  padding:calc(var(--su)*.6) calc(var(--su)*1.2);
  border-top:1px solid var(--line); background:rgba(0,0,0,.3);
  font-size:calc(var(--su)*.9); letter-spacing:.1em; color:var(--dim);
}
.cfg-foot .gly-txt{font-size:calc(var(--su)*.86); color:var(--dim);}
.cfg-foot .gly{--gly-size:calc(var(--su)*1.42);}
.cfg-status{
  margin-left:auto; text-align:right; font-size:calc(var(--su)*.92); font-style:italic;
  font-weight:600; color:var(--gold); opacity:0; transition:opacity 200ms linear;
  max-width:52%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
}
.cfg-status.is-on{opacity:1;}

/* ---- fps counter (lives outside the panel) ----------------------------- */
.cfg-fps{
  position:absolute; left:calc(var(--su)*1.1); bottom:calc(var(--su)*1.1);
  display:none; align-items:baseline; gap:calc(var(--su)*.4);
  padding:calc(var(--su)*.26) calc(var(--su)*.55);
  background:rgba(4,6,10,.56); border:1px solid rgba(255,255,255,.12);
  font-size:calc(var(--su)*1.0); letter-spacing:.06em; color:var(--green);
  text-shadow:var(--sh); z-index:2;
}
.cfg-fps.is-on{display:flex;}
.cfg-fps u{text-decoration:none; color:var(--dim2); font-size:calc(var(--su)*.8);}
.cfg-fps.warn{color:var(--gold);}
.cfg-fps.bad{color:var(--red);}

/* ---- HUD element toggles (private classes on the HUD root) -------------- */
.hud.cfg-hide-score .score-row{display:none !important;}
.hud.cfg-hide-special .special{display:none !important;}
.hud.cfg-hide-board .board{display:none !important;}
.hud.cfg-hide-challenges .hud-goals{display:none !important;}
.hud.cfg-hide-timer .hud-tc{display:none !important;}
.hud.cfg-hide-trickList .hud-tr,
.hud.cfg-hide-trickList .tricklist{display:none !important;}
.hud.cfg-hide-callout .callout{display:none !important;}
.hud.cfg-hide-balance .bal{display:none !important;}
.hud.cfg-hide-hint .hint{display:none !important;}

/* ---- narrow / short --------------------------------------------------- */
@media (max-width:860px){
  .cfg-help{display:none;}
  .cfg-sub{display:none;}
  .cfg-track{width:calc(var(--su)*8);}
}
@media (max-height:620px){
  .cfg-help{display:none;}
  .cfg-title{font-size:calc(var(--su)*1.7);}
}
@media (prefers-reduced-motion: reduce){
  .cfg-root *{animation-duration:.001ms !important; transition-duration:.001ms !important;}
}
`;

  let styleEl = document.getElementById('cfg-style');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'cfg-style';
    styleEl.textContent = CSS;
    document.head.appendChild(styleEl);
  }

  // =========================================================================
  // DOM SHELL
  // =========================================================================

  const mount = document.getElementById('ui-root') || document.body;
  const root = el('div', 'cfg-root');
  const scrim = el('div', 'cfg-scrim');
  const wrap = el('div', 'cfg-wrap');
  const panel = el('div', 'cfg-panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', 'Settings');

  const head = el('div', 'cfg-head');
  const titleRow = el('div', 'cfg-title-row');
  const titleEl = el('div', 'cfg-title', 'SETTINGS');
  const subEl = el('div', 'cfg-sub', 'Every change applies immediately and is saved');
  titleRow.append(titleEl, subEl);
  head.appendChild(titleRow);

  const tabBar = el('div', 'cfg-tabs');
  tabBar.setAttribute('role', 'tablist');
  const bumpL = el('div', 'cfg-bump');
  bumpL.appendChild(glyphs.el('pad:lb', { size: 1.25 }));
  const bumpR = el('div', 'cfg-bump');
  bumpR.appendChild(glyphs.el('pad:rb', { size: 1.25 }));
  tabBar.appendChild(bumpL);
  head.appendChild(tabBar);
  panel.appendChild(head);

  const body = el('div', 'cfg-body');
  panel.appendChild(body);

  const foot = el('div', 'cfg-foot');
  const statusEl = el('div', 'cfg-status', '');
  panel.appendChild(foot);

  wrap.appendChild(panel);
  root.append(scrim, wrap);

  const fpsEl = el('div', 'cfg-fps');
  const fpsNum = el('span', null, '60');
  const fpsUnit = el('u', null, 'FPS');
  const fpsMs = el('u', null, '16.7 ms');
  fpsEl.append(fpsNum, fpsUnit, fpsMs);
  root.appendChild(fpsEl);

  mount.appendChild(root);

  // Footer prompts — glyphs switch device on their own.
  foot.appendChild(glyphs.hint([
    ['navigate', 'NAVIGATE'],
    ['adjust', 'ADJUST'],
    ['confirm', 'SELECT'],
    ['tabLeft', 'TAB'],
    ['cancel', 'BACK'],
  ]));
  foot.appendChild(statusEl);

  function setStatus(text, hold) {
    statusEl.textContent = text || '';
    statusEl.classList.toggle('is-on', !!text);
    statusTimer = text ? (hold || 3.2) : 0;
  }

  // =========================================================================
  // ROW FACTORIES
  // =========================================================================

  /** tabs[i] = { id, el(page), rows[], sel } */
  const pages = [];
  const tabButtons = [];

  for (let i = 0; i < TABS.length; i++) {
    const t = TABS[i];
    const page = el('div', 'cfg-page');
    page.dataset.page = t.id;
    body.appendChild(page);
    page.setAttribute('role', 'tabpanel');
    page.setAttribute('aria-label', t.label);
    const rec = { id: t.id, def: t, el: page, rows: [], sel: 0 };
    pages.push(rec);

    const b = el('button', 'cfg-tab', t.label);
    b.type = 'button';
    b.dataset.tab = t.id;
    b.setAttribute('role', 'tab');
    b.addEventListener('click', () => { setTab(i); focusRow(); });
    tabBar.appendChild(b);
    tabButtons.push(b);
  }
  tabBar.appendChild(bumpR);

  function section(page, label, note) {
    const s = el('div', 'cfg-sec');
    const h = el('div', 'cfg-sec-h');
    h.appendChild(el('span', null, label));
    h.appendChild(el('i'));
    if (note) h.appendChild(el('em', null, note));
    s.appendChild(h);
    page.el.appendChild(s);
    return s;
  }

  /** Shared row shell. Returns { el, main, ctl, warn, page }. */
  function rowShell(page, host, label, help, cls) {
    const b = el('button', 'cfg-row' + (cls ? ' ' + cls : ''));
    b.type = 'button';
    const main = el('div', 'cfg-main');
    main.appendChild(el('div', 'cfg-label', label));
    if (help) main.appendChild(el('div', 'cfg-help', help));
    const warn = el('div', 'cfg-warn', '');
    main.appendChild(warn);
    const ctl = el('div', 'cfg-ctl');
    b.append(main, ctl);
    host.appendChild(b);
    return { el: b, main, ctl, warn, page };
  }

  function register(page, rec) {
    rec.index = page.rows.length;
    page.rows.push(rec);
    rec.el.addEventListener('pointerenter', () => {
      if (!open || listening) return;
      selectIndex(page, rec.index, false);
    });
    return rec;
  }

  // --- slider --------------------------------------------------------------

  function addSlider(page, host, opts) {
    const sh = rowShell(page, host, opts.label, opts.help);
    const box = el('div', 'cfg-slider');
    const track = el('div', 'cfg-track');
    const fill = el('i', 'cfg-fill');
    const knob = el('i', 'cfg-knob');
    track.append(fill, knob);
    const val = el('div', 'cfg-val', '');
    box.append(track, val);
    sh.ctl.appendChild(box);

    const rec = {
      type: 'slider', el: sh.el, warn: sh.warn, page,
      min: opts.min, max: opts.max, step: opts.step,
      get: opts.get, set: opts.set, fmt: opts.fmt || pct,
      preview: opts.preview || null,
      refresh() {
        const v = clamp(num(rec.get(), rec.min), rec.min, rec.max);
        const t = rec.max > rec.min ? (v - rec.min) / (rec.max - rec.min) : 0;
        fill.style.transform = 'scaleX(' + t.toFixed(4) + ')';
        knob.style.left = (t * 100).toFixed(2) + '%';
        const s = rec.fmt(v);
        if (val.textContent !== s) val.textContent = s;
      },
      adjust(dir, fast) {
        const step = rec.step * (fast ? 4 : 1);
        commit(quantise(num(rec.get(), rec.min) + dir * step, rec.min, rec.max, rec.step));
      },
      activate() { rec.adjust(1, false); },
    };

    function commit(v) {
      const now = clamp(v, rec.min, rec.max);
      rec.set(now);
      rec.refresh();
      if (rec.preview) preview(rec.preview);
      onChanged();
    }

    function fromPointer(e) {
      const r = track.getBoundingClientRect();
      if (r.width <= 0) return;
      const t = clamp((e.clientX - r.left) / r.width, 0, 1);
      commit(quantise(rec.min + t * (rec.max - rec.min), rec.min, rec.max, rec.step));
    }

    let dragging = false;
    track.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      selectIndex(page, rec.index, true);
      dragging = true;
      try { track.setPointerCapture(e.pointerId); } catch (err) { /* not captured */ }
      fromPointer(e);
    });
    track.addEventListener('pointermove', (e) => { if (dragging) fromPointer(e); });
    const endDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      try { track.releasePointerCapture(e.pointerId); } catch (err) { /* already gone */ }
    };
    track.addEventListener('pointerup', endDrag);
    track.addEventListener('pointercancel', endDrag);
    sh.el.addEventListener('click', (e) => { e.preventDefault(); selectIndex(page, rec.index, true); });

    return register(page, rec);
  }

  // --- option cycler -------------------------------------------------------

  function addOption(page, host, opts) {
    const sh = rowShell(page, host, opts.label, opts.help);
    const box = el('div', 'cfg-opt');
    const left = el('span', 'cfg-arw', '◂');
    const value = el('span', 'cfg-optv', '');
    const right = el('span', 'cfg-arw', '▸');
    box.append(left, value, right);
    sh.ctl.appendChild(box);

    const rec = {
      type: 'option', el: sh.el, warn: sh.warn, page,
      values: opts.values, get: opts.get, set: opts.set,
      label: opts.labels || null, wrapAround: opts.wrap !== false,
      refresh() {
        const v = rec.get();
        const i = rec.values.indexOf(v);
        const text = rec.label ? (rec.label[v] != null ? rec.label[v] : String(v)) : String(v);
        if (value.textContent !== text) value.textContent = text;
        left.style.opacity = (!rec.wrapAround && i <= 0) ? '.2' : '';
        right.style.opacity = (!rec.wrapAround && i >= rec.values.length - 1) ? '.2' : '';
      },
      adjust(dir) {
        const n = rec.values.length;
        let i = rec.values.indexOf(rec.get());
        if (i < 0) i = 0;
        i = rec.wrapAround ? ((i + dir) % n + n) % n : clamp(i + dir, 0, n - 1);
        rec.set(rec.values[i]);
        rec.refresh();
        onChanged();
      },
      activate() { rec.adjust(1); },
    };

    left.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); selectIndex(page, rec.index, true); rec.adjust(-1); });
    right.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); selectIndex(page, rec.index, true); rec.adjust(1); });
    sh.el.addEventListener('click', (e) => { e.preventDefault(); selectIndex(page, rec.index, true); rec.adjust(1); });

    return register(page, rec);
  }

  // --- toggle --------------------------------------------------------------

  function addToggle(page, host, opts) {
    const sh = rowShell(page, host, opts.label, opts.help);
    const sw = el('div', 'cfg-toggle');
    sw.appendChild(el('i'));
    const state = el('div', 'cfg-state', 'OFF');
    sh.ctl.append(state, sw);

    const rec = {
      type: 'toggle', el: sh.el, warn: sh.warn, page,
      get: opts.get, set: opts.set, preview: opts.preview || null,
      refresh() {
        const on = !!rec.get();
        sh.el.classList.toggle('is-on', on);
        const t = on ? 'ON' : 'OFF';
        if (state.textContent !== t) state.textContent = t;
      },
      adjust(dir) {
        const on = !!rec.get();
        if ((dir > 0 && on) || (dir < 0 && !on)) return;
        rec.activate();
      },
      activate() {
        rec.set(!rec.get());
        rec.refresh();
        if (rec.preview) preview(rec.preview);
        onChanged();
      },
    };
    sh.el.addEventListener('click', (e) => { e.preventDefault(); selectIndex(page, rec.index, true); rec.activate(); });
    return register(page, rec);
  }

  // --- plain action --------------------------------------------------------

  function addAction(page, host, opts) {
    const sh = rowShell(page, host, opts.label, opts.help, opts.danger ? 'is-danger' : '');
    const btn = el('div', 'cfg-act', opts.button || 'GO');
    sh.ctl.appendChild(btn);
    const rec = {
      type: 'action', el: sh.el, warn: sh.warn, page, btn,
      base: opts.button || 'GO',
      refresh() { if (!rec.armedText) btn.textContent = rec.base; },
      adjust() {},
      activate() {
        try { opts.run(rec); } catch (err) { setStatus('That did not work.'); }
      },
    };
    sh.el.addEventListener('click', (e) => { e.preventDefault(); selectIndex(page, rec.index, true); rec.activate(); });
    return register(page, rec);
  }

  /** Two-step destructive action: arm, then confirm (or time out). */
  function addConfirm(page, host, opts) {
    const rec = addAction(page, host, {
      label: opts.label,
      help: opts.help,
      button: opts.button || 'RESET',
      danger: true,
      run(r) {
        if (armed === r) {
          disarm();
          try { opts.run(); } catch (err) { /* reported below */ }
          r.btn.textContent = 'DONE';
          r.armedText = true;
          setStatus(opts.done || 'Done.');
          setTimeout(() => {
            if (disposed) return;
            r.armedText = false;
            r.btn.textContent = r.base;
            refreshPage();
          }, 1400);
          return;
        }
        disarm();
        armed = r;
        armedTimer = 4.5;
        r.el.classList.add('is-armed');
        r.btn.textContent = 'CONFIRM?';
        setStatus(opts.warn || 'Press again to confirm — this cannot be undone.', 4.5);
      },
    });
    return rec;
  }

  function disarm() {
    if (!armed) return;
    armed.el.classList.remove('is-armed');
    armed.btn.textContent = armed.base;
    armed = null;
    armedTimer = 0;
  }

  // --- bind row ------------------------------------------------------------

  const bindRows = [];

  function padGlyphFor(token) {
    return PAD_TOKEN_GLYPH[token] || null;
  }

  function addBind(page, host, action, label, help) {
    const sh = rowShell(page, host, label, help);
    const binds = el('div', 'cfg-binds');
    const listen = el('div', 'cfg-listen', 'PRESS ANY KEY…');
    sh.ctl.append(binds, listen);

    const rec = {
      type: 'bind', el: sh.el, warn: sh.warn, page, action, binds, listen,
      refresh() {
        while (binds.firstChild) binds.removeChild(binds.firstChild);
        const list = (input && input.getBind ? input.getBind(action, ctrlDevice) : null) || [];
        listen.textContent = ctrlDevice === 'gamepad'
          ? 'PRESS A BUTTON…' : 'PRESS A KEY…';
        if (!list.length) {
          binds.appendChild(el('span', 'cfg-bindtxt', 'UNBOUND'));
        } else {
          for (let i = 0; i < list.length && i < 2; i++) {
            const tok = list[i];
            if (ctrlDevice === 'gamepad') {
              const name = padGlyphFor(tok);
              if (name) binds.appendChild(glyphs.el('pad:' + name, { auto: false }));
              else binds.appendChild(el('span', 'cfg-bindtxt', labelOf(tok)));
            } else {
              binds.appendChild(glyphs.el('key:' + tok, { auto: false }));
            }
          }
          if (list.length > 2) binds.appendChild(el('span', 'cfg-bindtxt', '+' + (list.length - 2)));
        }
        // conflicts
        let clash = null;
        if (input && typeof input.conflict === 'function' && list.length) {
          clash = input.conflict(action, ctrlDevice, list);
        }
        sh.el.classList.toggle('is-clash', !!clash);
        sh.warn.textContent = clash ? ('ALSO BOUND TO ' + actionLabel(clash).toUpperCase()) : '';
      },
      adjust() {},
      activate() { startRebind(rec); },
    };
    sh.el.addEventListener('click', (e) => { e.preventDefault(); selectIndex(page, rec.index, true); rec.activate(); });
    bindRows.push(rec);
    return register(page, rec);
  }

  function labelOf(token) {
    if (input && typeof input.labelFor === 'function') {
      try { return input.labelFor(token, ctrlDevice); } catch (err) { /* fall through */ }
    }
    return String(token || '—');
  }

  function actionLabel(a) {
    const info = (input && input.ACTION_INFO) || DEFAULT_ACTION_INFO;
    return (info && info[a] && info[a].label) || a;
  }

  function refreshBinds() {
    for (let i = 0; i < bindRows.length; i++) bindRows[i].refresh();
  }

  async function startRebind(rec) {
    if (!input || typeof input.beginCapture !== 'function' || listening) return;
    disarm();
    listening = rec;
    rec.el.classList.add('is-listening');
    setStatus(ctrlDevice === 'gamepad'
      ? 'Listening — press a button or push a stick. B cancels.'
      : 'Listening — press a key. Escape cancels.', 8);
    let res = null;
    try {
      res = await input.beginCapture(rec.action, ctrlDevice, { timeoutMs: 7000 });
    } catch (err) { res = null; }
    rec.el.classList.remove('is-listening');
    listening = null;
    if (!open || disposed) { refreshBinds(); return; }

    if (!res || !res.input) {
      setStatus(res && res.reason === 'timeout' ? 'Rebind timed out — nothing changed.' : 'Rebind cancelled.');
    } else {
      const prevList = (input.getBind ? input.getBind(rec.action, ctrlDevice) : null) || [];
      const next = [res.input];
      for (let i = 0; i < prevList.length && next.length < 3; i++) {
        if (prevList[i] !== res.input && i > 0) next.push(prevList[i]);
      }
      const clash = input.setBind(rec.action, ctrlDevice, next);
      if (clash) {
        setStatus(res.label + ' is also bound to ' + actionLabel(clash) + '.', 4.5);
      } else {
        setStatus(actionLabel(rec.action) + ' → ' + res.label);
      }
      emit('controls', rec.action, res.input);
    }
    refreshBinds();
    focusRow();
  }

  // =========================================================================
  // PAGE: CONTROLS
  // =========================================================================

  const pControls = pages[0];
  let segKeyboard = null;
  let segGamepad = null;
  {
    const secDev = section(pControls, 'DEVICE', 'Prompts follow whatever you last touched');
    const sh = rowShell(pControls, secDev, 'EDIT BINDINGS FOR',
      'Both devices keep their own profile — switching here never wipes the other');
    // Spans, not buttons: this row is itself a <button>, and interactive
    // elements must never nest.
    const seg = el('div', 'cfg-seg');
    segGamepad = el('span', 'cfg-seg-b');
    segGamepad.appendChild(glyphs.el('pad:a', { size: 1.3, auto: false }));
    segGamepad.appendChild(el('span', null, 'GAMEPAD'));
    segKeyboard = el('span', 'cfg-seg-b');
    segKeyboard.appendChild(glyphs.el('key:Space', { size: 1.3, auto: false }));
    segKeyboard.appendChild(el('span', null, 'KEYBOARD'));
    seg.append(segGamepad, segKeyboard);
    sh.ctl.appendChild(seg);

    const devRec = {
      type: 'device', el: sh.el, warn: sh.warn, page: pControls,
      refresh() {
        segGamepad.classList.toggle('is-on', ctrlDevice === 'gamepad');
        segKeyboard.classList.toggle('is-on', ctrlDevice === 'keyboard');
      },
      adjust(dir) { setDevice(dir > 0 ? 'keyboard' : 'gamepad', true); },
      activate() { setDevice(ctrlDevice === 'gamepad' ? 'keyboard' : 'gamepad', true); },
    };
    segGamepad.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); selectIndex(pControls, devRec.index, true); setDevice('gamepad', true); });
    segKeyboard.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); selectIndex(pControls, devRec.index, true); setDevice('keyboard', true); });
    sh.el.addEventListener('click', (e) => { e.preventDefault(); selectIndex(pControls, devRec.index, true); devRec.activate(); });
    register(pControls, devRec);

    // --- bind rows, grouped -------------------------------------------------
    const actions = (input && Array.isArray(input.actions) && input.actions.length)
      ? input.actions : DEFAULT_ACTIONS;
    const info = (input && input.ACTION_INFO) || DEFAULT_ACTION_INFO;

    for (let g = 0; g < ACTION_GROUPS.length; g++) {
      const [groupId, groupLabel, groupNote] = ACTION_GROUPS[g];
      const rows = [];
      for (let i = 0; i < actions.length; i++) {
        const a = actions[i];
        const meta = info[a];
        if (!meta || meta.group !== groupId) continue;
        rows.push([a, meta.label]);
      }
      if (!rows.length) continue;
      const sec = section(pControls, groupLabel, groupNote);
      for (let i = 0; i < rows.length; i++) {
        addBind(pControls, sec, rows[i][0], rows[i][1], ACTION_HELP[rows[i][0]] || '');
      }
    }
    // Anything input.js declares that our group table does not cover.
    const extra = [];
    for (let i = 0; i < actions.length; i++) {
      const a = actions[i];
      if (!info[a]) extra.push(a);
    }
    if (extra.length) {
      const sec = section(pControls, 'OTHER', 'Declared by the input layer');
      for (let i = 0; i < extra.length; i++) addBind(pControls, sec, extra[i], extra[i], '');
    }

    // --- analog -------------------------------------------------------------
    const secStick = section(pControls, 'STICKS & TRIGGERS', 'Gamepad only');
    const opt = () => inputOptions();

    addSlider(pControls, secStick, {
      label: 'LEFT STICK DEADZONE',
      help: 'Dead travel around centre before the bike steers or leans',
      min: 0, max: 0.6, step: 0.01,
      get: () => (opt() ? opt().deadzone.left : 0.18),
      set: (v) => { if (input && input.setDeadzone) input.setDeadzone('left', v); },
      fmt: (v) => Math.round(v * 100) + '%',
    });
    addSlider(pControls, secStick, {
      label: 'RIGHT STICK DEADZONE',
      help: 'Dead travel around centre before the camera moves',
      min: 0, max: 0.6, step: 0.01,
      get: () => (opt() ? opt().deadzone.right : 0.16),
      set: (v) => { if (input && input.setDeadzone) input.setDeadzone('right', v); },
      fmt: (v) => Math.round(v * 100) + '%',
    });
    addSlider(pControls, secStick, {
      label: 'STEER SENSITIVITY',
      help: 'How far a given stick push pulls the bars over',
      min: 0.2, max: 3, step: 0.05,
      get: () => (opt() ? opt().sensitivity.left : 1),
      set: (v) => { if (input && input.setSensitivity) input.setSensitivity('left', v); },
      fmt: (v) => v.toFixed(2) + '×',
    });
    addSlider(pControls, secStick, {
      label: 'CAMERA SENSITIVITY',
      help: 'Right-stick look speed',
      min: 0.2, max: 3, step: 0.05,
      get: () => (opt() ? opt().sensitivity.right : 1),
      set: (v) => { if (input && input.setSensitivity) input.setSensitivity('right', v); },
      fmt: (v) => v.toFixed(2) + '×',
    });
    addOption(pControls, secStick, {
      label: 'CAMERA RESPONSE',
      help: 'Shape of the right-stick curve — smooth is easier to aim, linear is quicker',
      values: CURVE_ORDER, labels: CURVE_LABEL, wrap: false,
      get: () => (opt() ? opt().curve.right : 'quadratic'),
      set: (v) => { if (input && input.setCurve) input.setCurve('right', v); },
    });
    addToggle(pControls, secStick, {
      label: 'INVERT LOOK (Y)',
      help: 'Push the right stick down to look up',
      get: () => !!(opt() && opt().invertY),
      set: (v) => { if (input && input.setInvertY) input.setInvertY(v); },
    });

    const secVib = section(pControls, 'VIBRATION', 'Needs a pad with haptics');
    addToggle(pControls, secVib, {
      label: 'VIBRATION',
      help: 'Light bump on landing, sharp knock on a bail, low rumble while grinding',
      get: () => !!(opt() && opt().vibration.enabled),
      set: (v) => {
        if (!input || !input.setVibration) return;
        input.setVibration(v, opt() ? opt().vibration.strength : 1);
        if (v && input.rumble) input.rumble(0.5, 0.35, 160);
      },
    });
    addSlider(pControls, secVib, {
      label: 'VIBRATION STRENGTH',
      help: 'Scales every rumble the game asks for',
      min: 0, max: 2, step: 0.05,
      get: () => (opt() ? opt().vibration.strength : 1),
      set: (v) => {
        if (!input || !input.setVibration) return;
        input.setVibration(opt() ? opt().vibration.enabled : true, v);
      },
      fmt: (v) => Math.round(v * 100) + '%',
    });
    addAction(pControls, secVib, {
      label: 'TEST RUMBLE',
      help: 'Fires a landing thump followed by a bail knock',
      button: 'TEST',
      run() {
        if (!input || typeof input.rumble !== 'function') { setStatus('No pad connected.'); return; }
        if (!(opt() && opt().vibration.enabled)) { setStatus('Vibration is switched off.'); return; }
        input.rumble(0.55, 0.35, 150);
        setTimeout(() => { if (!disposed) input.rumble(0.95, 0.7, 260); }, 320);
        setStatus(input.state && input.state.anyGamepad ? 'Rumbling…' : 'No pad connected.');
      },
    });

    const secReset = section(pControls, 'RESTORE', '');
    addConfirm(pControls, secReset, {
      label: 'RESTORE DEFAULT BINDINGS',
      help: 'Puts this device back to the shipped layout',
      button: 'RESET',
      warn: 'Press again to wipe your bindings for this device.',
      done: 'Bindings restored.',
      run() {
        if (input && input.resetDefaults) input.resetDefaults(ctrlDevice);
        refreshBinds();
        emit('controls', 'reset', ctrlDevice);
      },
    });
    addConfirm(pControls, secReset, {
      label: 'RESTORE ALL INPUT DEFAULTS',
      help: 'Bindings for both devices plus deadzones, sensitivity and vibration',
      button: 'RESET ALL',
      warn: 'Press again to reset every control option.',
      done: 'Input defaults restored.',
      run() {
        if (input && input.resetDefaults) input.resetDefaults();
        refreshBinds();
        refreshPage();
        emit('controls', 'reset', 'all');
      },
    });
  }

  function setDevice(d, manual) {
    const next = d === 'gamepad' ? 'gamepad' : 'keyboard';
    if (next === ctrlDevice) return;
    ctrlDevice = next;
    if (manual) deviceUserPicked = true;
    refreshBinds();
    refreshPage();
  }

  // =========================================================================
  // PAGE: VIDEO
  // =========================================================================

  const pVideo = pages[1];
  {
    const secR = section(pVideo, 'RENDERING', 'Costs frames — start here if the run stutters');
    addOption(pVideo, secR, {
      label: 'QUALITY',
      help: 'Master preset: resolution, shadows, ambient occlusion, bloom and anti-aliasing',
      values: QUALITY_ORDER, labels: QUALITY_LABEL, wrap: false,
      get: () => S.video.quality,
      set: (v) => { S.video.quality = v; applyQuality(); emit('video', 'quality', v); },
    });
    addSlider(pVideo, secR, {
      label: 'RESOLUTION SCALE',
      help: 'Renders below or above the window size and rescales — the cheapest frame you can buy',
      min: 0.5, max: 1.5, step: 0.05,
      get: () => S.video.resolution,
      set: (v) => { S.video.resolution = v; applyResolution(); emit('video', 'resolution', v); },
      fmt: (v) => Math.round(v * 100) + '%',
    });
    addOption(pVideo, secR, {
      label: 'SHADOW QUALITY',
      help: 'Shadow map size for the sun and every practical light',
      values: SHADOW_ORDER, labels: SHADOW_LABEL, wrap: false,
      get: () => S.video.shadows,
      set: (v) => { S.video.shadows = v; applyShadows(); emit('video', 'shadows', v); },
    });

    const secC = section(pVideo, 'CAMERA & MOTION', '');
    addSlider(pVideo, secC, {
      label: 'FIELD OF VIEW',
      help: 'Wider sees more of the lot and reads faster; narrower keeps the rider big in frame',
      min: 50, max: 95, step: 1,
      get: () => S.video.fov,
      set: (v) => { S.video.fov = v; applyFov(); emit('video', 'fov', v); },
      fmt: (v) => Math.round(v) + '°',
    });
    addSlider(pVideo, secC, {
      label: 'SPEED BLUR',
      help: 'Radial streaking above about 10 m/s',
      min: 0, max: 1.5, step: 0.05,
      get: () => S.video.speedBlur,
      set: (v) => { S.video.speedBlur = v; emit('video', 'speedBlur', v); },
      fmt: (v) => (v <= 0 ? 'OFF' : Math.round(v * 100) + '%'),
    });

    const secI = section(pVideo, 'IMAGE', 'Post-processing grade');
    addSlider(pVideo, secI, {
      label: 'BLOOM',
      help: 'Glow on speculars and the bright cloud break',
      min: 0, max: 2, step: 0.05,
      get: () => S.video.bloom,
      set: (v) => { S.video.bloom = v; applyImage(); emit('video', 'bloom', v); },
      fmt: (v) => (v <= 0 ? 'OFF' : Math.round(v * 100) + '%'),
    });
    addSlider(pVideo, secI, {
      label: 'FILM GRAIN',
      help: 'Fine animated grain over the whole frame',
      min: 0, max: 2, step: 0.05,
      get: () => S.video.grain,
      set: (v) => { S.video.grain = v; applyImage(); emit('video', 'grain', v); },
      fmt: (v) => (v <= 0 ? 'OFF' : Math.round(v * 100) + '%'),
    });
    addSlider(pVideo, secI, {
      label: 'CHROMATIC ABERRATION',
      help: 'Colour fringing towards the edges of the lens',
      min: 0, max: 2, step: 0.05,
      get: () => S.video.aberration,
      set: (v) => { S.video.aberration = v; applyImage(); emit('video', 'aberration', v); },
      fmt: (v) => (v <= 0 ? 'OFF' : Math.round(v * 100) + '%'),
    });
    addSlider(pVideo, secI, {
      label: 'VIGNETTE',
      help: 'Corner darkening that keeps the eye on the rider',
      min: 0, max: 2, step: 0.05,
      get: () => S.video.vignette,
      set: (v) => { S.video.vignette = v; applyImage(); emit('video', 'vignette', v); },
      fmt: (v) => (v <= 0 ? 'OFF' : Math.round(v * 100) + '%'),
    });

    const secD = section(pVideo, 'DISPLAY', '');
    addToggle(pVideo, secD, {
      label: 'FPS COUNTER',
      help: 'Frame rate and frame time in the bottom-left corner',
      get: () => S.video.fps,
      set: (v) => { S.video.fps = v; fpsEl.classList.toggle('is-on', v); emit('video', 'fps', v); },
    });
    addConfirm(pVideo, secD, {
      label: 'RESTORE VIDEO DEFAULTS',
      help: 'Back to the shipped look and the quality this machine booted with',
      button: 'RESET',
      warn: 'Press again to restore every video setting.',
      done: 'Video defaults restored.',
      run() {
        const d = defaults().video;
        d.quality = S.video.quality;         // keep the tier the player chose
        S.video = d;
        applyResolution(); applyImage(); applyShadows(); applyFov();
        fpsEl.classList.toggle('is-on', S.video.fps);
        emit('video', 'reset', null);
        refreshPage();
      },
    });
  }

  // =========================================================================
  // PAGE: AUDIO
  // =========================================================================

  const pAudio = pages[2];
  {
    const sec = section(pAudio, 'LEVELS', 'Moving a slider plays a sample of that bus');
    addSlider(pAudio, sec, {
      label: 'MASTER',
      help: 'Everything: tyres, grinds, crowd and music',
      min: 0, max: 1, step: 0.02, preview: 'master',
      get: () => S.audio.master,
      set: (v) => { S.audio.master = v; applyAudio(); emit('audio', 'master', v); },
      fmt: (v) => (v <= 0.001 ? 'MUTE' : Math.round(v * 100) + '%'),
    });
    addSlider(pAudio, sec, {
      label: 'MUSIC',
      help: 'The synthesized punk backing track',
      min: 0, max: 1, step: 0.02, preview: 'music',
      get: () => S.audio.music,
      set: (v) => { S.audio.music = v; applyAudio(); emit('audio', 'music', v); },
      fmt: (v) => (v <= 0.001 ? 'OFF' : Math.round(v * 100) + '%'),
    });
    addSlider(pAudio, sec, {
      label: 'EFFECTS',
      help: 'Tyres, hops, landings, grinds and clanks',
      min: 0, max: 1, step: 0.02, preview: 'sfx',
      get: () => S.audio.sfx,
      set: (v) => { S.audio.sfx = v; applyAudio(); emit('audio', 'sfx', v); },
      fmt: (v) => (v <= 0.001 ? 'OFF' : Math.round(v * 100) + '%'),
    });
    addSlider(pAudio, sec, {
      label: 'CROWD',
      help: 'Cheers, gasps and flashbulbs from the spectator deck',
      min: 0, max: 1, step: 0.02, preview: 'crowd',
      get: () => S.audio.crowd,
      set: (v) => { S.audio.crowd = v; applyAudio(); emit('audio', 'crowd', v); },
      fmt: (v) => (v <= 0.001 ? 'OFF' : Math.round(v * 100) + '%'),
    });

    const sec2 = section(pAudio, 'PREVIEW', '');
    addAction(pAudio, sec2, {
      label: 'PLAY A TEST LINE',
      help: 'Hop, land, grind chirp and a crowd reaction at the current mix',
      button: 'PLAY',
      run() {
        const a = context.audio;
        if (!a || typeof a.play !== 'function') { setStatus('Audio is not running yet.'); return; }
        try { if (a.resume) a.resume(); } catch (err) { /* ignore */ }
        const cue = (name, detail, ms) => setTimeout(() => {
          if (disposed) return;
          try { a.play(name, detail); } catch (err) { /* ignore */ }
        }, ms);
        cue('hop', { charge: 0.9 }, 0);
        cue('land', { impact: 7, quality: 1, surface: 'ground' }, 420);
        cue('grindStart', { rail: 'rail', speed: 8 }, 760);
        cue('grindEnd', { rail: 'rail', speed: 8 }, 1400);
        cue('cheer', { intensity: 0.85 }, 1560);
        setStatus('Playing…');
      },
    });
    addConfirm(pAudio, sec2, {
      label: 'RESTORE AUDIO DEFAULTS',
      help: 'Back to the shipped mix',
      button: 'RESET',
      warn: 'Press again to restore the default mix.',
      done: 'Audio defaults restored.',
      run() {
        S.audio = defaults().audio;
        applyAudio();
        emit('audio', 'reset', null);
        refreshPage();
      },
    });
  }

  // =========================================================================
  // PAGE: GAMEPLAY
  // =========================================================================

  const pGame = pages[3];
  {
    const secS = section(pGame, 'SESSION', '');
    const runLabels = {};
    for (let i = 0; i < RUN_LENGTHS.length; i++) runLabels[RUN_LENGTHS[i]] = timeText(RUN_LENGTHS[i]);
    addOption(pGame, secS, {
      label: 'RUN LENGTH',
      help: 'Takes effect on the next run — 2:00 is the competition length',
      values: RUN_LENGTHS, labels: runLabels, wrap: false,
      get: () => S.gameplay.runLength,
      set: (v) => { S.gameplay.runLength = v; applyRunLength(); emit('gameplay', 'runLength', v); },
    });

    addOption(pGame, secS, {
      label: 'DIFFICULTY',
      help: 'Scales landing tolerance, slam threshold and how fast a manual falls away',
      values: DIFFICULTY_ORDER, labels: DIFFICULTY_LABEL, wrap: false,
      get: () => S.gameplay.difficulty,
      set: (v) => { S.gameplay.difficulty = v; applyDifficulty(); emit('gameplay', 'difficulty', v); },
    });
    addToggle(pGame, secS, {
      label: 'AUTO-RESTART ON BAIL',
      help: 'Starts a fresh run a couple of seconds after a crash instead of rolling on',
      get: () => S.gameplay.autoRestart,
      set: (v) => { S.gameplay.autoRestart = v; emit('gameplay', 'autoRestart', v); },
    });

    const secC = section(pGame, 'CAMERA', 'Chase rig');
    addSlider(pGame, secC, {
      label: 'CAMERA DISTANCE',
      help: 'How far the chase camera trails the bike',
      min: 3.4, max: 8.5, step: 0.1,
      get: () => S.gameplay.cameraDistance,
      set: (v) => { S.gameplay.cameraDistance = v; applyCameraTune(); emit('gameplay', 'cameraDistance', v); },
      fmt: (v) => v.toFixed(1) + ' M',
    });
    addSlider(pGame, secC, {
      label: 'CAMERA HEIGHT',
      help: 'Eye height above the bike — low and close reads like the reference frame',
      min: 0.9, max: 3.4, step: 0.05,
      get: () => S.gameplay.cameraHeight,
      set: (v) => { S.gameplay.cameraHeight = v; applyCameraTune(); emit('gameplay', 'cameraHeight', v); },
      fmt: (v) => v.toFixed(2) + ' M',
    });

    const secH = section(pGame, 'HUD', 'Turn off anything you do not read');
    addSlider(pGame, secH, {
      label: 'HUD SCALE',
      help: 'Size of the score, timer, board and trick callout',
      min: 0.7, max: 1.5, step: 0.05,
      get: () => S.gameplay.hudScale,
      set: (v) => { S.gameplay.hudScale = v; applyHudScale(); emit('gameplay', 'hudScale', v); },
      fmt: (v) => Math.round(v * 100) + '%',
    });
    for (let i = 0; i < HUD_PARTS.length; i++) {
      const [key, label, help] = HUD_PARTS[i];
      addToggle(pGame, secH, {
        label,
        help,
        get: () => S.gameplay.hud[key],
        set: (v) => { S.gameplay.hud[key] = v; applyHudParts(); emit('gameplay', 'hud.' + key, v); },
      });
    }
    addConfirm(pGame, secH, {
      label: 'RESTORE GAMEPLAY DEFAULTS',
      help: 'Run length, difficulty, camera and the whole HUD',
      button: 'RESET',
      warn: 'Press again to restore the gameplay defaults.',
      done: 'Gameplay defaults restored.',
      run() {
        S.gameplay = defaults().gameplay;
        applyRunLength(); applyDifficulty(); applyCameraTune(); applyHudScale(); applyHudParts();
        emit('gameplay', 'reset', null);
        refreshPage();
      },
    });
  }

  // =========================================================================
  // PAGE: DATA
  // =========================================================================

  const pData = pages[4];
  let statsEl = null;
  {
    const sec = section(pData, 'SAVED PROGRESS', 'Stored in this browser only');
    statsEl = el('div', 'cfg-stats');
    sec.appendChild(statsEl);

    addConfirm(pData, sec, {
      label: 'RESET HIGH SCORES',
      help: 'Clears the top five runs and your personal best',
      button: 'RESET',
      warn: 'Press again to erase every high score.',
      done: 'High scores cleared.',
      run() { resetScores(); refreshData(); },
    });
    addConfirm(pData, sec, {
      label: 'RESET ACHIEVEMENTS',
      help: 'Re-locks every achievement so they can be earned again',
      button: 'RESET',
      warn: 'Press again to re-lock every achievement.',
      done: 'Achievements re-locked.',
      run() { resetAchievements(); refreshData(); },
    });
    addConfirm(pData, sec, {
      label: 'RESET ALL PROGRESS',
      help: 'High scores, achievements, challenges, gaps, letters and the landed trick list',
      button: 'ERASE',
      warn: 'Press again to erase ALL saved progress. This cannot be undone.',
      done: 'All progress erased.',
      run() { resetAll(); refreshData(); },
    });

    const sec2 = section(pData, 'SETTINGS', '');
    addConfirm(pData, sec2, {
      label: 'RESTORE ALL SETTINGS',
      help: 'Every video, audio and gameplay option back to the shipped values (bindings are kept)',
      button: 'RESET',
      warn: 'Press again to restore every setting.',
      done: 'Settings restored.',
      run() {
        const q = S.video.quality;
        const d = defaults();
        S.video = d.video;
        S.video.quality = q;
        S.audio = d.audio;
        S.gameplay = d.gameplay;
        applyAll();
        fpsEl.classList.toggle('is-on', S.video.fps);
        emit('all', 'reset', null);
        refreshPage();
      },
    });

    pData.el.appendChild(el('div', 'cfg-note',
      'Progress and settings live in this browser\'s local storage. Clearing site data, '
      + 'or opening the game in a private window, starts you with a clean profile.'));
  }

  function scoring() { return (context.player && context.player.scoring) || null; }

  function persistProfile(profile) {
    if (!profile) return;
    const sc = scoring();
    if (sc && typeof sc.save === 'function') {
      try { sc.save(); return; } catch (err) { /* fall through to the direct write */ }
    }
    const st = store();
    if (!st) return;
    try { st.setItem(PROFILE_KEY, JSON.stringify(profile)); } catch (err) { /* no storage */ }
  }

  function resetScores() {
    const sc = scoring();
    const p = sc && sc.profile;
    if (p) {
      if (Array.isArray(p.scores)) p.scores.length = 0;
      if (p.best) p.best.score = 0;
    }
    if (sc && Array.isArray(sc.highScores) && (!p || sc.highScores !== p.scores)) sc.highScores.length = 0;
    persistProfile(p);
    emit('data', 'scores', null);
  }

  function resetAchievements() {
    const sc = scoring();
    const p = sc && sc.profile;
    if (p && Array.isArray(p.achievements)) p.achievements.length = 0;
    if (sc && Array.isArray(sc.achievements)) {
      for (let i = 0; i < sc.achievements.length; i++) {
        const a = sc.achievements[i];
        if (!a) continue;
        a.unlocked = false;
        if (typeof a.progress === 'number') a.progress = 0;
      }
      sc.achievementsUnlocked = 0;
    }
    persistProfile(p);
    emit('data', 'achievements', null);
  }

  function resetAll() {
    const sc = scoring();
    const p = sc && sc.profile;
    if (p) {
      const lists = ['scores', 'achievements', 'goals', 'gaps', 'grinds', 'landed'];
      for (let i = 0; i < lists.length; i++) {
        if (Array.isArray(p[lists[i]])) p[lists[i]].length = 0;
      }
      if (p.best) for (const k of Object.keys(p.best)) p.best[k] = 0;
      if (p.totals) for (const k of Object.keys(p.totals)) p.totals[k] = 0;
    }
    resetAchievements();
    if (sc) {
      if (Array.isArray(sc.highScores) && (!p || sc.highScores !== p.scores)) sc.highScores.length = 0;
      if (Array.isArray(sc.goals)) {
        for (let i = 0; i < sc.goals.length; i++) {
          const g = sc.goals[i];
          if (!g) continue;
          g.done = false;
          g.everDone = false;
          if (typeof g.progress === 'number') g.progress = 0;
        }
        sc.goalsDone = 0;
      }
      sc.landedCount = 0;
    }
    const tricks = context.player && context.player.tricks;
    if (tricks && typeof tricks.resetTrickList === 'function') {
      try { tricks.resetTrickList(); } catch (err) { /* ignore */ }
    }
    const st = store();
    if (st) { try { st.removeItem(PROFILE_KEY); } catch (err) { /* no storage */ } }
    emit('data', 'all', null);
  }

  function refreshData() {
    if (!statsEl) return;
    const sc = scoring();
    const p = sc && sc.profile;
    const best = p && p.best ? Math.round(p.best.score || 0) : 0;
    const runs = p && p.totals ? Math.round(p.totals.runs || 0) : 0;
    const ach = sc && Array.isArray(sc.achievements) ? sc.achievements.length : 0;
    let unlocked = 0;
    if (sc && Array.isArray(sc.achievements)) {
      for (let i = 0; i < sc.achievements.length; i++) if (sc.achievements[i] && sc.achievements[i].unlocked) unlocked++;
    }
    const landed = sc ? Math.round(sc.landedCount || 0) : 0;
    const total = sc ? Math.round(sc.totalCount || 0) : 0;
    const scores = p && Array.isArray(p.scores) ? p.scores.length : 0;

    while (statsEl.firstChild) statsEl.removeChild(statsEl.firstChild);
    const add = (label, value) => {
      const s = el('span', null, label + ' ');
      s.appendChild(el('b', null, value));
      statsEl.appendChild(s);
    };
    add('RUNS', String(runs));
    add('SAVED SCORES', String(scores));
    add('PERSONAL BEST', best.toLocaleString ? best.toLocaleString('en-US') : String(best));
    add('ACHIEVEMENTS', unlocked + ' / ' + (ach || 0));
    add('TRICK LIST', landed + ' / ' + (total || 0));
  }

  // =========================================================================
  // NAVIGATION
  // =========================================================================

  function currentPage() { return pages[tabIndex]; }

  function setTab(i, silent) {
    const n = pages.length;
    const next = ((i % n) + n) % n;
    if (next === tabIndex && pages[next].el.classList.contains('is-on')) return;
    tabIndex = next;
    for (let k = 0; k < pages.length; k++) {
      const on = k === tabIndex;
      pages[k].el.classList.toggle('is-on', on);
      tabButtons[k].classList.toggle('is-on', on);
      tabButtons[k].setAttribute('aria-selected', on ? 'true' : 'false');
    }
    subEl.textContent = TABS[tabIndex].sub;
    body.scrollTop = 0;
    disarm();
    refreshPage();
    if (!silent) sfx('uiMove');
  }

  function selectIndex(page, i, withSound) {
    if (!page.rows.length) return;
    const n = page.rows.length;
    const next = ((i % n) + n) % n;
    if (next === page.sel) {
      applySelection(page);
      return;
    }
    page.sel = next;
    if (armed && armed.page === page && armed !== page.rows[next]) disarm();
    applySelection(page);
    if (withSound !== false) sfx('uiMove');
  }

  function applySelection(page) {
    for (let i = 0; i < page.rows.length; i++) {
      page.rows[i].el.classList.toggle('is-sel', i === page.sel);
    }
  }

  function focusRow() {
    const page = currentPage();
    const rec = page.rows[page.sel];
    if (!rec) return;
    applySelection(page);
    if (!open) return;
    try { rec.el.focus({ preventScroll: true }); } catch (err) { rec.el.focus(); }
    if (rec.el.scrollIntoView) rec.el.scrollIntoView({ block: 'nearest' });
  }

  function move(dir) {
    const page = currentPage();
    if (!page.rows.length) return;
    selectIndex(page, page.sel + dir);
    focusRow();
  }

  function adjust(dir, fast) {
    const page = currentPage();
    const rec = page.rows[page.sel];
    if (!rec || !rec.adjust) return;
    disarm();
    rec.adjust(dir, fast);
  }

  function activate() {
    const page = currentPage();
    const rec = page.rows[page.sel];
    if (!rec) return;
    const a = context.audio;
    if (a && typeof a.resume === 'function') { try { a.resume(); } catch (err) { /* ignore */ } }
    if (rec.type !== 'action') disarm();
    sfx('uiSelect');
    if (rec.activate) rec.activate();
  }

  function refreshPage() {
    const page = currentPage();
    for (let i = 0; i < page.rows.length; i++) {
      const r = page.rows[i];
      if (r.refresh) {
        try { r.refresh(); } catch (err) { /* one bad row must not stop the rest */ }
      }
    }
    if (page.id === 'data') refreshData();
    applySelection(page);
  }

  function refreshAll() {
    for (let p = 0; p < pages.length; p++) {
      const rows = pages[p].rows;
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].refresh) {
          try { rows[i].refresh(); } catch (err) { /* ignore */ }
        }
      }
    }
    refreshData();
  }

  function onChanged() {
    queueSave();
  }

  const SFX_ALIAS = { uiBack: 'uiMove', uiOpen: 'uiSelect' };
  function sfx(name) {
    const a = context.audio;
    if (!a) return;
    const n = SFX_ALIAS[name] || name;
    try {
      if (typeof a[n] === 'function') a[n]();
      else if (typeof a.play === 'function') a.play(n);
    } catch (err) { /* audio is never load-bearing for the UI */ }
  }

  // =========================================================================
  // KEYBOARD
  // =========================================================================

  function onKeyDown(e) {
    if (!open || disposed) return;
    // A live rebind belongs to input.js: let the key straight through.
    if (listening || (input && input.capturing)) return;
    if (e.ctrlKey || e.metaKey) return;

    const c = e.code;
    let used = true;

    if (c === 'ArrowUp' || c === 'KeyW') move(-1);
    else if (c === 'ArrowDown' || c === 'KeyS') move(1);
    else if (c === 'ArrowLeft' || c === 'KeyA') adjust(-1, e.shiftKey);
    else if (c === 'ArrowRight' || c === 'KeyD') adjust(1, e.shiftKey);
    else if (c === 'Enter' || c === 'NumpadEnter' || c === 'Space') activate();
    else if (c === 'Escape' || c === 'Backspace') {
      if (armed) { disarm(); setStatus('Cancelled.'); }
      else closePanel();
    } else if (c === 'Tab') { setTab(tabIndex + (e.shiftKey ? -1 : 1)); focusRow(); }
    else if (c === 'KeyQ' || c === 'PageUp') { setTab(tabIndex - 1); focusRow(); }
    else if (c === 'KeyE' || c === 'PageDown') { setTab(tabIndex + 1); focusRow(); }
    else if (c === 'Home') { selectIndex(currentPage(), 0); focusRow(); }
    else if (c === 'End') { selectIndex(currentPage(), currentPage().rows.length - 1); focusRow(); }
    else used = false;

    if (used) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  // =========================================================================
  // GAMEPAD
  // =========================================================================

  const padPrev = {
    up: false, down: false, left: false, right: false,
    ok: false, back: false, lb: false, rb: false, start: false,
  };
  let padSeeded = false;
  let padRepeat = 0;

  function pollPad(dt) {
    if (!open || listening || (input && input.capturing)) return;
    const list = (typeof navigator !== 'undefined' && navigator.getGamepads) ? navigator.getGamepads() : null;
    let pad = null;
    if (list) {
      for (let i = 0; i < list.length; i++) {
        if (list[i] && list[i].connected) { pad = list[i]; break; }
      }
    }
    if (!pad) {
      padPrev.up = padPrev.down = padPrev.left = padPrev.right = false;
      padPrev.ok = padPrev.back = padPrev.lb = padPrev.rb = padPrev.start = false;
      padSeeded = false;
      return;
    }

    const btn = (i) => {
      const b = pad.buttons[i];
      if (!b) return false;
      return typeof b === 'number' ? b > 0.5 : (!!b.pressed || b.value > 0.5);
    };
    const ax = pad.axes[0] || 0;
    const ay = pad.axes[1] || 0;

    const now = {
      up: btn(12) || ay < -0.55,
      down: btn(13) || ay > 0.55,
      left: btn(14) || ax < -0.55,
      right: btn(15) || ax > 0.55,
      ok: btn(0),
      back: btn(1),
      lb: btn(4),
      rb: btn(5),
      start: btn(9),
    };

    // The button that opened this screen must not also press the first row.
    if (!padSeeded) {
      padSeeded = true;
      for (const k of Object.keys(padPrev)) padPrev[k] = now[k];
      return;
    }

    const held = now.up || now.down || now.left || now.right;
    if (!held) padRepeat = 0;
    else padRepeat -= dt;
    const fire = held && padRepeat <= 0;

    if (now.up && (!padPrev.up || fire)) { move(-1); padRepeat = padPrev.up ? 0.11 : 0.32; }
    else if (now.down && (!padPrev.down || fire)) { move(1); padRepeat = padPrev.down ? 0.11 : 0.32; }
    else if (now.left && (!padPrev.left || fire)) { adjust(-1, false); padRepeat = padPrev.left ? 0.09 : 0.34; }
    else if (now.right && (!padPrev.right || fire)) { adjust(1, false); padRepeat = padPrev.right ? 0.09 : 0.34; }

    if (now.ok && !padPrev.ok) activate();
    if (now.back && !padPrev.back) {
      if (armed) { disarm(); setStatus('Cancelled.'); }
      else closePanel();
    }
    if (now.lb && !padPrev.lb) { setTab(tabIndex - 1); focusRow(); }
    if (now.rb && !padPrev.rb) { setTab(tabIndex + 1); focusRow(); }
    if (now.start && !padPrev.start) closePanel();

    for (const k of Object.keys(padPrev)) padPrev[k] = now[k];
  }

  // =========================================================================
  // OPEN / CLOSE
  // =========================================================================

  function openPanel(tabId) {
    if (open || disposed) return;
    open = true;
    padSeeded = false;
    padRepeat = 0;
    deviceUserPicked = false;
    if (input && input.activeDevice) {
      ctrlDevice = input.activeDevice === 'gamepad' ? 'gamepad' : 'keyboard';
    }

    // One modal at a time: park screens.js and remember where it was.
    const scr = context.screens;
    prevScreen = null;
    if (scr && typeof scr.state === 'string' && scr.state !== 'none') {
      prevScreen = scr.state;
      if (typeof scr.hide === 'function') { try { scr.hide(); } catch (err) { /* ignore */ } }
    }

    prevFocus = document.activeElement;
    if (context.flags) context.flags.paused = true;

    let idx = 0;
    if (tabId) {
      for (let i = 0; i < TABS.length; i++) if (TABS[i].id === tabId) idx = i;
    }
    tabIndex = -1;
    setTab(idx, true);
    refreshBinds();
    refreshAll();
    setStatus('');

    root.classList.add('is-open');
    window.addEventListener('keydown', onKeyDown, { capture: true });
    sfx('uiSelect');
    if (typeof context.emit === 'function') {
      try { context.emit('settingsopen', { settings: S }); } catch (err) { /* ignore */ }
    }
    // Focus after the entrance transition has started so the scroll lands right.
    setTimeout(() => { if (open && !disposed) focusRow(); }, 30);
  }

  function closePanel() {
    if (!open || disposed) return;
    open = false;
    disarm();
    if (input && typeof input.cancelCapture === 'function') input.cancelCapture();
    if (listening) {
      listening.el.classList.remove('is-listening');
      listening = null;
    }
    root.classList.remove('is-open');
    window.removeEventListener('keydown', onKeyDown, { capture: true });
    setStatus('');
    save();

    if (document.activeElement && panel.contains(document.activeElement)) {
      document.activeElement.blur();
    }

    const scr = context.screens;
    if (prevScreen && scr && typeof scr.show === 'function') {
      try { scr.show(prevScreen); } catch (err) { /* ignore */ }
    } else if (context.flags && (!scr || scr.state === 'none')) {
      context.flags.paused = false;
    }
    prevScreen = null;

    if (prevFocus && prevFocus.focus && document.contains(prevFocus) && !panel.contains(prevFocus)) {
      try { prevFocus.focus({ preventScroll: true }); } catch (err) { /* ignore */ }
    }
    prevFocus = null;

    sfx('uiMove');
    if (typeof context.emit === 'function') {
      try { context.emit('settingsclose', { settings: S }); } catch (err) { /* ignore */ }
    }
  }

  // Clicking outside the panel closes, like every other options screen. The
  // scrim itself inherits pointer-events:none, so the hit test lives on the
  // wrapper, which is the element that actually covers the rest of the screen.
  wrap.addEventListener('pointerdown', (e) => {
    if (e.target !== wrap) return;
    e.preventDefault();
    closePanel();
  });

  // Device auto-follow: touching the other device flips the CONTROLS tab with it
  // (unless the player has picked one by hand during this visit).
  let unsubDevice = null;
  if (input && typeof input.onDeviceChange === 'function') {
    const off = input.onDeviceChange((d) => {
      if (disposed || deviceUserPicked) return;
      const next = d === 'gamepad' ? 'gamepad' : 'keyboard';
      if (next === ctrlDevice) return;
      ctrlDevice = next;
      refreshBinds();
      if (open && currentPage().id === 'controls') refreshPage();
    });
    unsubDevice = typeof off === 'function' ? off : null;
  }

  // =========================================================================
  // FRAME
  // =========================================================================

  let fpsAccum = 0;
  let fpsFrames = 0;
  let bailWatch = 0;
  let lastMode = '';
  let screenGuard = false;

  function update(dt, c) {
    if (disposed) return;
    const cx = c || context;
    let step = num(dt, 0);
    if (step < 0) step = 0;
    if (step > 0.5) step = 0.5;

    // --- fps counter (runs whether or not the panel is up) -------------------
    if (S.video.fps) {
      fpsAccum += step;
      fpsFrames++;
      if (fpsAccum >= 0.35 && fpsFrames > 0) {
        const fps = fpsFrames / fpsAccum;
        const ms = (fpsAccum / fpsFrames) * 1000;
        fpsNum.textContent = String(Math.round(fps));
        fpsMs.textContent = ms.toFixed(1) + ' ms';
        fpsEl.classList.toggle('warn', fps < 55 && fps >= 40);
        fpsEl.classList.toggle('bad', fps < 40);
        fpsAccum = 0;
        fpsFrames = 0;
      }
    }

    if (previewTimer > 0) previewTimer = Math.max(0, previewTimer - step);
    if (statusTimer > 0) {
      statusTimer -= step;
      if (statusTimer <= 0) setStatus('');
    }
    if (armedTimer > 0) {
      armedTimer -= step;
      if (armedTimer <= 0) { disarm(); setStatus(''); }
    }

    // --- auto-restart on bail ------------------------------------------------
    const st = cx.player && cx.player.physics && cx.player.physics.state;
    const mode = st ? st.mode : '';
    if (S.gameplay.autoRestart && !open) {
      if (mode === 'bail' && lastMode !== 'bail') bailWatch = 2.6;
      if (bailWatch > 0) {
        bailWatch -= step;
        if (bailWatch <= 0) {
          const sc = scoring();
          if (sc && sc.phase !== 'results') {
            if (cx.screens && typeof cx.screens.startSession === 'function') cx.screens.startSession();
            else if (typeof sc.restart === 'function') sc.restart();
            if (cx.hud && typeof cx.hud.flash === 'function') cx.hud.flash('RUN RESTARTED', 'AUTO-RESTART ON BAIL', 'red');
          }
        }
      }
    } else {
      bailWatch = 0;
    }
    lastMode = mode;

    if (!open) return;

    // --- keep ownership of the modal layer ----------------------------------
    if (cx.flags) cx.flags.paused = true;
    const scr = cx.screens;
    if (scr && typeof scr.state === 'string' && scr.state !== 'none') {
      // Something opened a screen behind us (Escape or Start reaching screens.js
      // first). Take it back down. `prevScreen` is deliberately NOT updated —
      // where we came from is decided at open() and nowhere else.
      if (!screenGuard) {
        screenGuard = true;
        if (typeof scr.hide === 'function') { try { scr.hide(); } catch (err) { /* ignore */ } }
        screenGuard = false;
      }
    }

    pollPad(step);
  }

  // =========================================================================
  // BOOT
  // =========================================================================

  // A fresh profile inherits whatever the engine actually booted with (main.js
  // honours ?q=low), so opening the menu can never silently change the tier.
  if (engine && engine.tier && QUALITY_ORDER.indexOf(engine.tier.name) >= 0) {
    S.video.quality = engine.tier.name;
  }
  load();
  applyAll();
  fpsEl.classList.toggle('is-on', S.video.fps);
  setTab(0, true);
  refreshAll();

  // Publish the values so any module can read them without importing this file.
  if (!context.settings || typeof context.settings !== 'object') context.settings = S;
  context.gameSettings = S;

  // =========================================================================
  // API
  // =========================================================================

  const api = {
    root,
    settings: S,

    /** open('video') jumps straight to a tab. */
    open(tabId) { openPanel(typeof tabId === 'string' ? tabId : null); },
    close() { closePanel(); },
    toggle(tabId) { if (open) closePanel(); else openPanel(typeof tabId === 'string' ? tabId : null); },

    get isOpen() { return open; },
    get visible() { return open; },
    get tab() { return TABS[tabIndex].id; },
    set tab(id) {
      for (let i = 0; i < TABS.length; i++) if (TABS[i].id === id) setTab(i, true);
    },

    /** Re-read every row (after another module has changed something we show). */
    refresh() { refreshBinds(); refreshAll(); },

    /** Re-apply every live value — used after a level or renderer rebuild. */
    apply() { applyAll(); },

    save,

    update,
    fixedUpdate() {},

    dispose() {
      if (disposed) return;
      disposed = true;
      if (open) {
        open = false;
        window.removeEventListener('keydown', onKeyDown, { capture: true });
      }
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = 0; }
      save();
      if (input && typeof input.cancelCapture === 'function') input.cancelCapture();
      if (unsubDevice) { try { unsubDevice(); } catch (err) { /* ignore */ } }
      if (baseSetSpeedBlur && engine) engine.setSpeedBlur = baseSetSpeedBlur;
      fovOffset = 0;
      removeFovHook();
      const hud = hudRoot();
      if (hud) {
        for (let i = 0; i < HUD_PARTS.length; i++) hud.classList.remove('cfg-hide-' + HUD_PARTS[i][0]);
      }
      if (glyphs && typeof glyphs.dispose === 'function') glyphs.dispose();
      root.remove();
      if (styleEl && styleEl.parentNode) styleEl.remove();
      if (context.settings === S) context.settings = null;
      if (context.gameSettings === S) context.gameSettings = null;
    },
  };

  return api;
}

export default createSettings;
