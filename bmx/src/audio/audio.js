// MIRRA CITY — the whole soundtrack, synthesized.
//
// Zero assets: every sample, impulse response and note in this file is generated with
// the WebAudio API at boot. Nothing is fetched, nothing is decoded.
//
// Shape of the mix
// ----------------
//   sources -> category bus -> busIn -> limiter -> master -> destination
//                     \-> reverb send -> convolver (procedural 1.45 s outdoor IR)
//                     \-> slap delay  (grind only)
//
// Category buses exist so the send amounts, and therefore the sense of space, are
// decided once instead of per voice:
//   busLoop   tyre roll / wind / freewheel / skid   — dry, small room
//   busSfx    hops, landings, clanks, UI            — a touch of lot reverb
//   busGrind  the grind loop                        — reverb + slap, it is the loudest thing in the park
//   busCrowd  cheers, gasps                         — drowned in reverb, it is 40 m away
//   busMusic  the backing track                     — nearly dry, ducked under big hits
//
// Continuous layers (tyre, wind, freewheel, skid, grind) are built ONCE at init and
// only ever have their AudioParams retargeted, so `update()` allocates nothing and
// costs a couple of dozen `setTargetAtTime` calls. One-shots take a pooled
// filter+gain channel and only allocate the source node WebAudio forces us to
// allocate (BufferSource/Oscillator are single-use by spec).
//
// Determinism: buffer generation runs on `nrand()` below — the same xorshift32 as
// `rng()` in core/mathx.js, but on a private stream, so pulling half a million
// samples for the noise buffers cannot shift the shared sequence the world and rider
// systems draw from. Nothing here ever calls Math.random().

import * as THREE from 'three';
import { clamp } from '../core/mathx.js';

// --- private deterministic noise source (xorshift32, as in core/mathx.js) ---
let _nseed = 0x9e3779b9 >>> 0;
function nrand() {
  _nseed ^= _nseed << 13; _nseed >>>= 0;
  _nseed ^= _nseed >>> 17;
  _nseed ^= _nseed << 5; _nseed >>>= 0;
  return _nseed / 4294967296;
}

// ---------------------------------------------------------------------------
// mix constants
// ---------------------------------------------------------------------------

const MIX = {
  master: 0.85,
  music: 0.30,
  loops: 0.85,
  sfx: 0.90,
  crowd: 0.75,
  grind: 0.85,

  revLoop: 0.05,
  revSfx: 0.20,
  revGrind: 0.26,
  revCrowd: 0.62,
  revMusic: 0.045,
  dlyGrind: 0.30,
};

// Tyre timbre per surface. `lp` is the broadband roll-off, `band` the resonant body
// of the tyre carcass, `q` how much that body rings, `level` overall loudness.
const SURFACES = {
  concrete: { lp: 2700, band: 205, q: 3.0, band0: 0.55, broad: 0.50, sub: 0.45, level: 1.00 },
  wood:     { lp: 1450, band: 122, q: 5.6, band0: 0.85, broad: 0.34, sub: 0.70, level: 0.95 },
  dirt:     { lp: 1050, band: 330, q: 1.1, band0: 0.30, broad: 0.95, sub: 0.35, level: 0.90 },
  metal:    { lp: 5400, band: 940, q: 9.0, band0: 0.42, broad: 0.30, sub: 0.20, level: 0.72 },
};

// Grind timbre per rail material (grind.js reports 'rail' | 'coping' | 'ledge').
const RAILS = {
  rail:   { saw: 78, sawG: 0.50, bp: 2050, q: 6.5, noise: 0.38, nbp: 2600, nq: 1.4, level: 1.00 },
  coping: { saw: 92, sawG: 0.58, bp: 3050, q: 13.0, noise: 0.24, nbp: 4200, nq: 2.2, level: 1.05 },
  ledge:  { saw: 44, sawG: 0.20, bp: 880, q: 1.5, noise: 0.80, nbp: 1150, nq: 0.9, level: 0.92 },
};

// Minimum seconds between two firings of the same cue. Doubles as the de-duplicator:
// several gameplay systems both emit an event AND call `play()` for the same beat.
const MIN_GAP = {
  wheelContact: 0.09,
  trick: 0.06,
  land: 0.05,
  hop: 0.05,
  grindStart: 0.08,
  grindEnd: 0.08,
  bank: 0.08,
  cheer: 0.55,
  gasp: 0.40,
  letter: 0.05,
  smash: 0.04,
  countdown: 0.20,
};
const MIN_GAP_DEFAULT = 0.03;

// ---------------------------------------------------------------------------
// music: 150 BPM punk / big-beat, 16 bars of 16th notes (two 8-bar sections)
// ---------------------------------------------------------------------------

const BPM = 150;
const STEP_DUR = 60 / BPM / 4;        // 0.1 s per 16th
const TOTAL_STEPS = 16 * 16;          // 16 bars

/** '.' rest, 'x' note, 'X' accent, 'o' open (hats). */
function pat(s) {
  const a = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    const c = s[i];
    a[i] = c === 'X' ? 2 : c === 'o' ? 3 : c === 'x' ? 1 : 0;
  }
  return a;
}

const KICK = [pat('X..x..X...x.X...'), pat('X...X..x..X.x..x')];
const SNARE = [pat('....X.......X...'), pat('....X.......X.xx'), pat('....X...x...X.Xx')];
const HAT8 = pat('x.X.x.X.x.X.x.X.');
const HAT16 = pat('xXxxxXxxxXxxxXxo');
const BASS8 = pat('X.x.X.x.X.x.X.x.');
const BASS16 = pat('X.xxX.x.X.xxX.xx');
const STAB_A = pat('X.....x...x.....');
const STAB_B = pat('X..x....X..x...x');

// Roots in MIDI. Section A walks a i-VI-III-VII punk turnaround, section B sits on
// pairs so the second half reads as a chorus rather than a repeat.
const ROOTS_A = [45, 41, 48, 43, 45, 41, 43, 43];   // A2 F2 C3 G2 ...
const ROOTS_B = [45, 45, 41, 41, 48, 48, 43, 43];

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

// ---------------------------------------------------------------------------
// scratch
// ---------------------------------------------------------------------------

const _v = new THREE.Vector3();

// ===========================================================================

export function createAudio(ctx) {
  let ac = null;
  let ready = false;         // graph built and context running
  let built = false;
  let disposed = false;
  let volume = MIX.master;
  let muted = false;
  let musicOn = true;

  // --- graph handles (all null until build()) --------------------------------
  let master, limiter, busIn, busLoop, busSfx, busGrind, busCrowd, busMusic;
  let revSend, convolver, revReturn;
  let dlySend, dly, dlyFb, dlyLP, dlyReturn;
  let musicDuck, guitarDrive;
  let noiseBuf, clickBuf;
  let noiseSrc, clickSrc;

  // tyre / wind / freewheel / skid
  let tyrePan, tyreLP, tyreBroad, tyreBP, tyreBand, tyreSub, tyreSubG;
  let windLP, windHP, windG;
  let clickHP, clickG, whirBP, whirG;
  let skidBP, skidG;

  // grind
  let grindPan, saw1, saw2, sawMix, grindBP, grindG, grindNoiseBP, grindNoiseG;
  let wobLFO, wobG;

  let poolSfx = null, poolCrowd = null, poolGrind = null;

  // --- runtime state (all preallocated) --------------------------------------
  const gp = { active: false, speed: 0, material: 'rail', balance: 0, critical: false, gain: 0 };
  const lastAt = new Map();
  let noiseCursor = 0;
  let pan = 0;
  let duckAmount = 0;
  let musicStep = 0;
  let musicNext = 0;
  let musicStarted = false;
  let comboHeat = 0;         // rises with combo length, feeds trick whoosh pitch
  let tyreLevel = 0;
  let grindLevel = 0;
  let elapsed = 0;

  const api = {
    enabled: false,
    ctxAudio: null,
    setMasterVolume,
    mute,
    play,
    update,
    dispose,
    // sibling hooks (grind.js probes for setGrind, tricks.js for trick)
    setGrind,
    trick,
    resume: kick,
    setMusicVolume,
    enableMusic,
    get muted() { return muted; },
    get volume() { return volume; },
  };

  // =========================================================================
  // buffers
  // =========================================================================

  /**
   * White noise, deterministic, long enough that the loop period is inaudible.
   * Mono on purpose: every consumer either pans it or throws it at the convolver,
   * both of which want a single channel in.
   */
  function makeNoise(seconds) {
    const sr = ac.sampleRate;
    const n = Math.floor(sr * seconds);
    const b = ac.createBuffer(1, n, sr);
    const d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = nrand() * 2 - 1;
    return b;
  }

  /**
   * A freewheel pawl train: 28 clicks per second of buffer, so the whole buffer loops
   * seamlessly and `playbackRate` alone sets the ratchet rate.
   */
  function makeClicks() {
    const sr = ac.sampleRate;
    const rate = 28;
    const n = sr;                                   // exactly one second
    const b = ac.createBuffer(1, n, sr);
    const d = b.getChannelData(0);
    const spacing = sr / rate;
    const len = Math.max(6, Math.floor(sr * 0.0022));
    for (let k = 0; k < rate; k++) {
      const start = Math.floor(k * spacing);
      const amp = 0.75 + nrand() * 0.45;            // pawls are never identical
      for (let i = 0; i < len; i++) {
        const t = i / len;
        const e = Math.pow(1 - t, 3.4);
        d[start + i] += (nrand() * 2 - 1) * e * amp;
      }
    }
    return b;
  }

  /**
   * Impulse response for the lot: exponentially decaying noise, progressively damped
   * (a one-pole whose cutoff falls with time, which is what air absorption does), a
   * handful of early reflections off the concrete, and slightly different taps per
   * channel so the tail widens instead of collapsing to mono.
   */
  function makeIR() {
    const sr = ac.sampleRate;
    const n = Math.floor(sr * 1.45);
    const b = ac.createBuffer(2, n, sr);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      let lp = 0;
      let dc = 0;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        const e = Math.pow(1 - t, 2.4) * Math.exp(-t * 2.6);
        const w = nrand() * 2 - 1;
        const a = 0.60 - 0.46 * t;                  // damping closes as the tail ages
        lp += a * (w - lp);
        dc += 0.004 * (lp - dc);
        d[i] = (lp - dc) * e;
      }
      // Early reflections: back wall of the plaza, the scaffold, the far bowl.
      const taps = c === 0
        ? [0.011, 0.019, 0.031, 0.047, 0.068, 0.097]
        : [0.013, 0.022, 0.029, 0.051, 0.064, 0.103];
      for (let k = 0; k < taps.length; k++) {
        const idx = Math.floor(taps[k] * sr);
        if (idx < n) d[idx] += (k % 2 ? -1 : 1) * (0.55 - k * 0.07);
      }
    }
    // Normalise so the send level means the same thing on every sample rate.
    let peak = 0;
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < n; i++) { const v = Math.abs(d[i]); if (v > peak) peak = v; }
    }
    if (peak > 0) {
      const k = 0.9 / peak;
      for (let c = 0; c < 2; c++) {
        const d = b.getChannelData(c);
        for (let i = 0; i < n; i++) d[i] *= k;
      }
    }
    return b;
  }

  /** Soft asymmetric clip for the guitar bus. */
  function makeDriveCurve() {
    const n = 1024;
    const c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = Math.tanh(x * 2.6) * 0.82 + Math.tanh(x * 0.7) * 0.18;
    }
    return c;
  }

  // =========================================================================
  // graph
  // =========================================================================

  function pooled(dest, n) {
    const list = new Array(n);
    for (let i = 0; i < n; i++) {
      const f = ac.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 18000;
      f.Q.value = 0.0001;
      const g = ac.createGain();
      g.gain.value = 0.0001;
      f.connect(g);
      g.connect(dest);
      list[i] = { f, g };
    }
    return { list, i: 0 };
  }

  function chan(pool) {
    const c = pool.list[pool.i];
    pool.i = (pool.i + 1) % pool.list.length;
    return c;
  }

  function gain(v, dest) {
    const g = ac.createGain();
    g.gain.value = v;
    if (dest) g.connect(dest);
    return g;
  }

  function biquad(type, f, q, dest) {
    const b = ac.createBiquadFilter();
    b.type = type;
    b.frequency.value = f;
    b.Q.value = q;
    if (dest) b.connect(dest);
    return b;
  }

  function build() {
    if (built) return;
    built = true;

    // --- master -------------------------------------------------------------
    master = gain(muted ? 0 : volume, ac.destination);
    limiter = ac.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 14;
    limiter.ratio.value = 4.5;
    limiter.attack.value = 0.004;
    limiter.release.value = 0.18;
    limiter.connect(master);
    busIn = gain(1, limiter);

    // --- reverb -------------------------------------------------------------
    convolver = ac.createConvolver();
    convolver.normalize = true;      // equal-power scaling: the send levels mean the same everywhere
    convolver.buffer = makeIR();
    revReturn = gain(0.85, busIn);
    convolver.connect(revReturn);
    revSend = gain(1, convolver);

    // --- slap delay (grind) --------------------------------------------------
    dly = ac.createDelay(0.5);
    dly.delayTime.value = 0.082;
    dlyFb = gain(0.30);
    dlyLP = biquad('lowpass', 3200, 0.7);
    dly.connect(dlyFb);
    dlyFb.connect(dly);
    dly.connect(dlyLP);
    dlyReturn = gain(0.45, busIn);
    dlyLP.connect(dlyReturn);
    dlySend = gain(1, dly);

    // --- category buses ------------------------------------------------------
    busLoop = gain(MIX.loops, busIn);
    busSfx = gain(MIX.sfx, busIn);
    busGrind = gain(MIX.grind, busIn);
    busCrowd = gain(MIX.crowd, busIn);
    musicDuck = gain(1, busIn);
    busMusic = gain(musicOn ? musicVolume : 0, musicDuck);

    busLoop.connect(gain(MIX.revLoop, revSend));
    busSfx.connect(gain(MIX.revSfx, revSend));
    busGrind.connect(gain(MIX.revGrind, revSend));
    busGrind.connect(gain(MIX.dlyGrind, dlySend));
    busCrowd.connect(gain(MIX.revCrowd, revSend));
    busMusic.connect(gain(MIX.revMusic, revSend));

    guitarDrive = ac.createWaveShaper();
    guitarDrive.curve = makeDriveCurve();
    guitarDrive.oversample = '2x';
    guitarDrive.connect(busMusic);

    // --- shared noise / click sources ---------------------------------------
    noiseBuf = makeNoise(5);
    clickBuf = makeClicks();

    noiseSrc = ac.createBufferSource();
    noiseSrc.buffer = noiseBuf;
    noiseSrc.loop = true;
    const noiseHub = gain(1);
    noiseSrc.connect(noiseHub);

    // --- tyre roll -----------------------------------------------------------
    tyrePan = makePanner(busLoop);
    tyreBroad = gain(0.0001, tyrePan);
    tyreLP = biquad('lowpass', SURFACES.concrete.lp, 0.9, tyreBroad);
    noiseHub.connect(tyreLP);

    tyreBand = gain(0.0001, tyrePan);
    tyreBP = biquad('bandpass', SURFACES.concrete.band, SURFACES.concrete.q, tyreBand);
    noiseHub.connect(tyreBP);

    tyreSubG = gain(0.0001, tyrePan);
    tyreSub = biquad('lowpass', 110, 1.4, tyreSubG);
    noiseHub.connect(tyreSub);

    // --- wind ----------------------------------------------------------------
    windG = gain(0.0001, busLoop);
    windLP = biquad('lowpass', 320, 0.8, windG);
    windHP = biquad('highpass', 160, 0.6, windLP);
    noiseHub.connect(windHP);

    // --- freewheel + chain ---------------------------------------------------
    clickSrc = ac.createBufferSource();
    clickSrc.buffer = clickBuf;
    clickSrc.loop = true;
    clickG = gain(0.0001, tyrePan);
    clickHP = biquad('highpass', 900, 1.1, clickG);
    clickSrc.connect(clickHP);

    whirG = gain(0.0001, tyrePan);
    whirBP = biquad('bandpass', 1600, 2.6, whirG);
    noiseHub.connect(whirBP);

    // --- skid ----------------------------------------------------------------
    skidG = gain(0.0001, tyrePan);
    skidBP = biquad('bandpass', 1150, 2.2, skidG);
    noiseHub.connect(skidBP);

    // --- grind loop ----------------------------------------------------------
    grindPan = makePanner(busGrind);
    grindG = gain(0.0001, grindPan);
    grindBP = biquad('bandpass', RAILS.rail.bp, RAILS.rail.q, grindG);
    sawMix = gain(0.5, grindBP);
    saw1 = ac.createOscillator();
    saw1.type = 'sawtooth';
    saw1.frequency.value = RAILS.rail.saw;
    saw2 = ac.createOscillator();
    saw2.type = 'sawtooth';
    saw2.frequency.value = RAILS.rail.saw * 1.006;
    saw2.detune.value = 11;
    saw1.connect(sawMix);
    saw2.connect(sawMix);

    grindNoiseG = gain(0.0001, grindPan);
    grindNoiseBP = biquad('bandpass', RAILS.rail.nbp, RAILS.rail.nq, grindNoiseG);
    noiseHub.connect(grindNoiseBP);

    wobLFO = ac.createOscillator();
    wobLFO.type = 'sine';
    wobLFO.frequency.value = 6.5;
    wobG = gain(0.0001);
    wobLFO.connect(wobG);
    wobG.connect(saw1.detune);
    wobG.connect(saw2.detune);

    // --- one-shot pools ------------------------------------------------------
    poolSfx = pooled(busSfx, 18);
    poolCrowd = pooled(busCrowd, 16);
    poolGrind = pooled(busGrind, 6);

    const t = ac.currentTime;
    noiseSrc.start(t);
    clickSrc.start(t);
    saw1.start(t);
    saw2.start(t);
    wobLFO.start(t);
  }

  function makePanner(dest) {
    if (typeof ac.createStereoPanner === 'function') {
      const p = ac.createStereoPanner();
      p.connect(dest);
      return p;
    }
    return gain(1, dest);      // ancient WebKit: no panning, still audible
  }

  // =========================================================================
  // lifecycle
  // =========================================================================

  function kick() {
    if (disposed) return;
    if (!ac) {
      const AC = typeof window !== 'undefined'
        ? (window.AudioContext || window.webkitAudioContext) : null;
      if (!AC) return;
      try { ac = new AC({ latencyHint: 'interactive' }); } catch (e) { ac = null; return; }
      api.ctxAudio = ac;
    }
    try {
      if (!built) build();
    } catch (e) {
      ac = null; built = false; ready = false; api.enabled = false;
      return;
    }
    if (ac.state === 'suspended') {
      const p = ac.resume();
      if (p && typeof p.then === 'function') p.then(onRunning, () => {});
    }
    if (ac.state === 'running') onRunning();
  }

  function onRunning() {
    if (disposed || !ac || ac.state !== 'running') return;
    ready = true;
    api.enabled = true;
    removeGestureHooks();
    if (musicOn && !musicStarted) {
      musicStarted = true;
      musicNext = ac.currentTime + 0.12;
      musicStep = 0;
    }
  }

  const onGesture = () => kick();
  let hooksLive = false;
  function addGestureHooks() {
    if (hooksLive || typeof window === 'undefined') return;
    hooksLive = true;
    window.addEventListener('keydown', onGesture, { passive: true });
    window.addEventListener('pointerdown', onGesture, { passive: true });
    window.addEventListener('touchstart', onGesture, { passive: true });
    window.addEventListener('mousedown', onGesture, { passive: true });
  }
  function removeGestureHooks() {
    if (!hooksLive || typeof window === 'undefined') return;
    hooksLive = false;
    window.removeEventListener('keydown', onGesture);
    window.removeEventListener('pointerdown', onGesture);
    window.removeEventListener('touchstart', onGesture);
    window.removeEventListener('mousedown', onGesture);
  }

  function applyMaster() {
    if (!master || !ac) return;
    master.gain.setTargetAtTime(muted ? 0 : volume, ac.currentTime, 0.02);
    master.gain.__t = undefined;
  }

  function setMasterVolume(v) {
    volume = clamp(typeof v === 'number' ? v : MIX.master, 0, 1.5);
    applyMaster();
    return volume;
  }

  function mute(v) {
    muted = v === undefined ? !muted : !!v;
    applyMaster();
    return muted;
  }

  let musicVolume = MIX.music;
  function setMusicVolume(v) {
    musicVolume = clamp(typeof v === 'number' ? v : MIX.music, 0, 1);
    if (busMusic && ac) {
      busMusic.gain.setTargetAtTime(musicOn ? musicVolume : 0, ac.currentTime, 0.05);
      busMusic.gain.__t = undefined;
    }
    return musicVolume;
  }

  function enableMusic(on) {
    musicOn = on === undefined ? !musicOn : !!on;
    if (musicOn && ready && !musicStarted) {
      musicStarted = true;
      musicNext = ac.currentTime + 0.1;
      musicStep = 0;
    }
    setMusicVolume(musicVolume);
    return musicOn;
  }

  // =========================================================================
  // param helpers (allocation-free)
  // =========================================================================

  /** Retarget a param, skipping the call when the target has not moved. */
  function setP(param, v, tc) {
    if (param.__t !== undefined && Math.abs(param.__t - v) < 1e-4) return;
    param.__t = v;
    param.setTargetAtTime(v, ac.currentTime, tc || 0.035);
  }

  function env(param, t, peak, atk, dur) {
    const p = Math.max(peak, 0.0001);
    param.cancelScheduledValues(t);
    param.setValueAtTime(0.0001, t);
    param.exponentialRampToValueAtTime(p, t + Math.max(atk, 0.0008));
    param.exponentialRampToValueAtTime(0.0001, t + Math.max(dur, atk + 0.01));
    param.__t = undefined;
  }

  function nextNoiseOffset() {
    noiseCursor = (noiseCursor + 0.1373) % 3.0;   // buffer is 5 s: any burst fits
    return noiseCursor;
  }

  /** A filtered noise burst on a pooled channel. */
  function nzShot(pool, type, f0, f1, q, peak, atk, dur, delay) {
    if (!ready) return;
    const t = ac.currentTime + (delay || 0);
    const c = chan(pool);
    c.f.type = type;
    c.f.frequency.cancelScheduledValues(t);
    c.f.frequency.setValueAtTime(Math.max(20, f0), t);
    if (f1 && Math.abs(f1 - f0) > 1) {
      c.f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur * 0.85);
    }
    c.f.frequency.__t = undefined;
    c.f.Q.cancelScheduledValues(t);
    c.f.Q.setValueAtTime(q, t);
    env(c.g.gain, t, peak, atk, dur);
    const s = ac.createBufferSource();
    s.buffer = noiseBuf;
    s.connect(c.f);
    s.start(t, nextNoiseOffset(), dur + 0.04);
    s.stop(t + dur + 0.04);
    s.onended = () => s.disconnect();
  }

  /** A pitched voice on a pooled channel, optionally swept and filtered. */
  function tnShot(pool, wave, f0, f1, peak, atk, dur, ftype, ff, q, delay, detune) {
    if (!ready) return;
    const t = ac.currentTime + (delay || 0);
    const c = chan(pool);
    c.f.type = ftype || 'lowpass';
    c.f.frequency.cancelScheduledValues(t);
    c.f.frequency.setValueAtTime(ff || 18000, t);
    c.f.frequency.__t = undefined;
    c.f.Q.cancelScheduledValues(t);
    c.f.Q.setValueAtTime(q === undefined ? 0.0001 : q, t);
    env(c.g.gain, t, peak, atk, dur);
    const o = ac.createOscillator();
    o.type = wave;
    o.frequency.setValueAtTime(Math.max(10, f0), t);
    if (f1 && Math.abs(f1 - f0) > 0.5) {
      o.frequency.exponentialRampToValueAtTime(Math.max(10, f1), t + dur * 0.9);
    }
    if (detune) o.detune.value = detune;
    o.connect(c.f);
    o.start(t);
    o.stop(t + dur + 0.03);
    o.onended = () => o.disconnect();
  }

  /** Pull the music down under a big hit, then let it back up. */
  function duck(amount) {
    if (!ready) return;
    duckAmount = Math.max(duckAmount, clamp(amount, 0, 0.8));
    musicDuck.gain.cancelScheduledValues(ac.currentTime);
    musicDuck.gain.setTargetAtTime(1 - duckAmount, ac.currentTime, 0.015);
    musicDuck.gain.__t = undefined;
  }

  // =========================================================================
  // one-shots
  // =========================================================================

  function sHop(power) {
    const p = clamp(power, 0, 1);
    // Tyre unweighting: a short rubber pop plus the frame creaking off the ground.
    nzShot(poolSfx, 'bandpass', 420 + p * 260, 150, 1.4, 0.30 + p * 0.22, 0.004, 0.085);
    tnShot(poolSfx, 'sine', 120 + p * 60, 52, 0.34 + p * 0.20, 0.004, 0.13, 'lowpass', 900, 0.4);
  }

  function sLand(impact, quality, surface) {
    const i = clamp(impact / 11, 0.12, 1.4);
    const surf = surface === 'dirt' ? SURFACES.dirt : SURFACES.concrete;
    // Tyre thud: the harder the hit the lower and louder the carcass slap.
    tnShot(poolSfx, 'sine', 92 - i * 34, 40, 0.30 + i * 0.42, 0.003, 0.10 + i * 0.10,
      'lowpass', 700, 0.6);
    nzShot(poolSfx, 'lowpass', surf.lp * (0.5 + i * 0.5), 260, 0.9, 0.20 + i * 0.34,
      0.003, 0.09 + i * 0.09);
    nzShot(poolSfx, 'bandpass', 190 + i * 120, 120, 2.4, 0.16 + i * 0.20, 0.004, 0.16);
    if (i > 0.55) duck(0.10 + i * 0.10);
    // Clean landing gets a cloth/air whoosh on top — this is the "stuck it" cue.
    if (quality > 0.62) {
      nzShot(poolSfx, 'bandpass', 1500, 380, 1.1, 0.16 + quality * 0.14, 0.03, 0.30, 0.01);
    }
  }

  function sBail(speed) {
    const s = clamp((speed || 6) / 12, 0.3, 1.3);
    // (a) the crunch — broad, ugly, immediate
    nzShot(poolSfx, 'lowpass', 3400, 500, 0.8, 0.62 * s, 0.002, 0.42);
    nzShot(poolSfx, 'bandpass', 1500, 700, 1.0, 0.34 * s, 0.002, 0.26, 0.012);
    // (b) metal clang — inharmonic partials, the bike hitting concrete
    tnShot(poolSfx, 'square', 1870, 1790, 0.20 * s, 0.001, 0.55, 'bandpass', 2100, 6, 0.030);
    tnShot(poolSfx, 'square', 2790, 2680, 0.13 * s, 0.001, 0.45, 'bandpass', 3000, 8, 0.034);
    tnShot(poolSfx, 'triangle', 640, 615, 0.22 * s, 0.001, 0.70, 'bandpass', 700, 5, 0.028);
    // (c) body thud — the rider
    tnShot(poolSfx, 'sine', 78, 38, 0.50 * s, 0.004, 0.24, 'lowpass', 400, 0.6, 0.070);
    nzShot(poolSfx, 'lowpass', 480, 160, 0.7, 0.30 * s, 0.006, 0.22, 0.072);
    duck(0.42);
    sGasp(clamp(s, 0.4, 1));
  }

  function sGrindChirp(railType, speed) {
    const r = RAILS[railType] || RAILS.rail;
    const s = clamp((speed || 6) / 10, 0.25, 1.2);
    // Peg meeting the rail: a fast upward chirp, bright on steel, dull on concrete.
    nzShot(poolGrind, 'bandpass', r.bp * 0.55, r.bp * 1.9, railType === 'ledge' ? 1.2 : 7,
      0.34 * s, 0.002, 0.075);
    if (railType !== 'ledge') {
      tnShot(poolGrind, 'triangle', 1200 * s + 900, 2600, 0.16 * s, 0.001, 0.10,
        'bandpass', 2400, 9, 0.004);
    }
  }

  function sGrindClank(railType, speed) {
    const r = RAILS[railType] || RAILS.rail;
    const s = clamp((speed || 6) / 10, 0.25, 1.2);
    nzShot(poolGrind, 'bandpass', r.bp * 1.4, r.bp * 0.5, 3, 0.30 * s, 0.001, 0.14);
    if (railType !== 'ledge') {
      tnShot(poolGrind, 'square', 1450, 1410, 0.13 * s, 0.001, 0.42, 'bandpass', 1600, 10);
      tnShot(poolGrind, 'triangle', 2180, 2140, 0.09 * s, 0.001, 0.34, 'bandpass', 2300, 12, 0.006);
    } else {
      tnShot(poolGrind, 'sine', 210, 150, 0.20 * s, 0.002, 0.16, 'lowpass', 600, 0.7);
    }
  }

  function sWhoosh(pitch, level) {
    nzShot(poolSfx, 'bandpass', 900 * pitch, 2400 * pitch, 1.3, level, 0.02, 0.20);
  }

  function sCheer(intensity) {
    const k = clamp(intensity, 0.2, 1);
    // Voices: two wide bands that swell and fall.
    nzShot(poolCrowd, 'bandpass', 780, 1180, 1.0, 0.42 * k, 0.30, 1.35 + k * 0.5);
    nzShot(poolCrowd, 'bandpass', 1900, 2400, 1.4, 0.22 * k, 0.38, 1.20 + k * 0.4, 0.05);
    nzShot(poolCrowd, 'bandpass', 380, 460, 1.1, 0.20 * k, 0.42, 1.5, 0.02);
    // Applause: a scatter of short bright bursts.
    const claps = 5 + Math.round(k * 3);
    for (let i = 0; i < claps; i++) {
      nzShot(poolCrowd, 'highpass', 2200 + nrand() * 1800, 0, 0.7,
        0.10 * k, 0.002, 0.055, 0.05 + nrand() * 0.55);
    }
    duck(0.14 * k);
  }

  function sGasp(k) {
    nzShot(poolCrowd, 'bandpass', 760, 340, 1.6, 0.40 * k, 0.09, 0.70);
    nzShot(poolCrowd, 'bandpass', 1500, 900, 2.2, 0.18 * k, 0.06, 0.45, 0.02);
  }

  function sChime(root, n, level) {
    for (let i = 0; i < n; i++) {
      const f = root * Math.pow(2, i / 4);
      tnShot(poolSfx, 'sine', f, f, level, 0.004, 0.85, 'lowpass', 6000, 0.7, i * 0.075);
      tnShot(poolSfx, 'sine', f * 2.76, f * 2.76, level * 0.24, 0.003, 0.42,
        'bandpass', f * 2.76, 4, i * 0.075);
    }
  }

  function sBeep(f, level, dur) {
    tnShot(poolSfx, 'square', f, f, level * 0.35, 0.003, dur, 'lowpass', f * 4, 0.7);
    tnShot(poolSfx, 'sine', f, f, level, 0.003, dur, 'lowpass', 8000, 0.7);
  }

  function sHorn() {
    // Session-end air horn: stacked detuned saws under a closing lowpass.
    for (let i = 0; i < 3; i++) {
      const f = 165 * (i + 1);
      tnShot(poolSfx, 'sawtooth', f, f * 0.97, 0.20 / (i * 0.5 + 1), 0.02, 1.5,
        'lowpass', 2600, 1.2, 0, (i - 1) * 9);
    }
    tnShot(poolSfx, 'sawtooth', 110, 108, 0.22, 0.03, 1.6, 'lowpass', 1200, 1.0);
    duck(0.30);
  }

  // =========================================================================
  // cue dispatch
  // =========================================================================

  function allow(name) {
    const t = elapsed;
    const g = MIN_GAP[name] === undefined ? MIN_GAP_DEFAULT : MIN_GAP[name];
    const last = lastAt.get(name);
    if (last !== undefined && t - last < g) return false;
    lastAt.set(name, t);
    return true;
  }

  /**
   * Fire a cue. Safe to call before the context exists, with an unknown name, or
   * with a null payload. Several systems both emit an event and call this for the
   * same beat, so identical cues inside `MIN_GAP` collapse into one.
   */
  function play(name, o) {
    if (!ready || !name) return;
    if (!allow(name)) return;
    const d = o || null;

    switch (name) {
      // --- riding ---------------------------------------------------------
      case 'hop':
        sHop(d && d.charge !== undefined ? d.charge : 0.5);
        break;
      case 'pump':
        nzShot(poolSfx, 'lowpass', 700, 220, 0.9, 0.16, 0.03, 0.20);
        break;
      case 'land':
        sLand(d ? d.impact || d.speed || 5 : 5, d ? (d.quality === undefined ? 1 : d.quality) : 1,
          d ? d.surface : 'ground');
        break;
      case 'wheelContact':
        nzShot(poolSfx, 'bandpass', 240, 150, 2.0,
          0.07 * clamp((d && d.speed ? d.speed : 4) / 10, 0.2, 1.2), 0.003, 0.07);
        break;
      case 'skid':
        nzShot(poolSfx, 'bandpass', 1400, 900, 2.0, 0.14, 0.02, 0.18);
        break;
      case 'wallride':
        nzShot(poolSfx, 'bandpass', 900, 1700, 1.3, 0.26, 0.008, 0.22);
        tnShot(poolSfx, 'sine', 150, 90, 0.16, 0.004, 0.14, 'lowpass', 600, 0.6);
        break;
      case 'bail':
      case 'crash':
        sBail(d ? d.speed : 6);
        break;
      case 'respawn':
        nzShot(poolSfx, 'bandpass', 2400, 500, 1.0, 0.16, 0.02, 0.34);
        tnShot(poolSfx, 'sine', 520, 200, 0.10, 0.01, 0.30, 'lowpass', 3000, 0.7);
        break;

      // --- grinds ----------------------------------------------------------
      case 'grindStart':
        sGrindChirp(d ? d.rail : 'rail', d ? d.speed : 6);
        break;
      // A bailed grind also fires physics' own 'bail', so the clank is all we add here.
      case 'grindEnd':
        sGrindClank(d ? d.rail : 'rail', d ? d.speed : 6);
        break;
      case 'grindTransfer':
        sGrindChirp(d ? d.rail : 'rail', 9);
        sWhoosh(1.3, 0.16);
        break;
      case 'grindSwitch':
        nzShot(poolGrind, 'bandpass', 2600, 3400, 6, 0.14, 0.003, 0.07);
        break;
      case 'revert':
        nzShot(poolSfx, 'bandpass', 700, 1500, 1.6, 0.24, 0.01, 0.24);
        break;

      // --- tricks / scoring -------------------------------------------------
      case 'trick':
        // Each trick in a line whooshes a little higher — the combo audibly escalates.
        sWhoosh(0.9 + comboHeat * 0.55, 0.10 + comboHeat * 0.08);
        comboHeat = clamp(comboHeat + 0.16, 0, 1);
        break;
      case 'comboLand':
        sWhoosh(1.5, 0.14);
        break;
      case 'bank':
      case 'scoreBank':
      case 'comboBank': {
        const pts = d ? (d.points || d.raw || 0) : 0;
        const n = clamp(1 + Math.floor(Math.log10(Math.max(pts, 10))) - 1, 1, 5);
        sChime(523.25, n, 0.14);
        if (pts >= 15000) sCheer(clamp(pts / 60000, 0.35, 1));
        break;
      }
      case 'comboBail':
      case 'scoreLost':
        tnShot(poolSfx, 'sawtooth', 320, 90, 0.16, 0.01, 0.42, 'lowpass', 1400, 1.2);
        break;
      case 'gap':
      case 'scoreGap':
        sChime(659.25, 2, 0.15);
        sWhoosh(1.6, 0.14);
        break;
      case 'letter':
      case 'letterCollected':
        tnShot(poolSfx, 'sine', 880, 880, 0.20, 0.003, 0.24, 'lowpass', 9000, 0.7);
        tnShot(poolSfx, 'sine', 1318.5, 1318.5, 0.16, 0.003, 0.32, 'lowpass', 9000, 0.7, 0.07);
        break;
      case 'smash':
      case 'objectSmashed':
        nzShot(poolSfx, 'highpass', 2600, 1200, 0.8, 0.34, 0.002, 0.28);
        nzShot(poolSfx, 'bandpass', 800, 400, 1.4, 0.22, 0.002, 0.16, 0.01);
        tnShot(poolSfx, 'triangle', 1900, 1830, 0.10, 0.001, 0.30, 'bandpass', 2000, 9, 0.008);
        break;
      case 'goal':
      case 'goalComplete':
        sChime(659.25, 3, 0.18);
        sCheer(0.7);
        break;
      case 'achievement':
        sChime(523.25, 4, 0.17);
        tnShot(poolSfx, 'sawtooth', 261.6, 261.6, 0.10, 0.02, 0.9, 'lowpass', 2200, 1.0, 0.24);
        sCheer(0.55);
        break;
      case 'rankUp':
        tnShot(poolSfx, 'sawtooth', 220, 660, 0.16, 0.02, 0.45, 'lowpass', 3000, 1.4);
        sCheer(d && d.first ? 1 : 0.6);
        break;
      case 'special':
      case 'specialReady':
        if (d && d.ready === false) break;
        // Shimmer up into the special: rising saw + noise sweep, drenched in the lot.
        tnShot(poolSfx, 'sawtooth', 180, 1440, 0.16, 0.03, 0.75, 'lowpass', 4000, 1.6);
        nzShot(poolSfx, 'bandpass', 1200, 5200, 2.2, 0.20, 0.05, 0.80);
        sChime(783.99, 3, 0.15);
        sCheer(0.8);
        duck(0.18);
        break;
      case 'specialSpent':
        nzShot(poolSfx, 'bandpass', 3600, 900, 1.6, 0.18, 0.01, 0.35);
        break;

      // --- session ----------------------------------------------------------
      case 'countdown': {
        const s = d && d.seconds !== undefined ? d.seconds : 5;
        sBeep(s <= 1 ? 1174.7 : 880, 0.24, 0.09);
        break;
      }
      case 'sessionStart':
        sBeep(1174.7, 0.26, 0.14);
        sCheer(0.8);
        break;
      case 'sessionEnd':
        sHorn();
        sCheer(1);
        break;

      // --- generic / UI ------------------------------------------------------
      case 'cheer':
        sCheer(d && d.intensity !== undefined ? d.intensity : 0.8);
        break;
      case 'gasp':
        sGasp(0.9);
        break;
      case 'chime':
        sChime(659.25, 3, 0.16);
        break;
      case 'uiMove':
      case 'menu':
      case 'click':
        sBeep(660, 0.10, 0.05);
        break;
      case 'uiSelect':
      case 'pause':
        sBeep(880, 0.14, 0.07);
        break;
      default:
        break;
    }
  }

  /**
   * tricks.js calls this directly for every committed trick (and also emits 'trick',
   * which lands here too — `play`'s dedupe window collapses the pair).
   */
  function trick(entry) {
    play('trick', entry);
  }

  /** grind.js pushes its live parameters here a few times a second. */
  function setGrind(p) {
    if (!p) { gp.active = false; return; }
    gp.active = !!p.active;
    gp.speed = p.speed || 0;
    gp.material = p.material || p.rail || 'rail';
    gp.balance = p.balance || 0;
    gp.critical = !!p.critical;
    gp.gain = p.gain === undefined ? 1 : p.gain;
  }

  // =========================================================================
  // continuous layers
  // =========================================================================

  function surfaceOf(type, friction) {
    const f = typeof friction === 'number' ? friction : 0.95;
    if (f <= 0.62) return SURFACES.metal;
    if (type === 'ground') return f < 0.85 ? SURFACES.dirt : SURFACES.concrete;
    if (type === 'wall') return SURFACES.concrete;
    if (f >= 0.995) return SURFACES.wood;
    if (f <= 0.74) return SURFACES.metal;
    return SURFACES.concrete;
  }

  /**
   * `frozen` is the pause / screenshot-harness case: the sim is not stepping, so the
   * bike is not really rolling however fast the last state said it was. Everything
   * continuous fades out; the music keeps playing under a small duck.
   */
  function updateLoops(dt, st, grind, camera, frozen) {
    const speed = frozen || !st ? 0 : st.speed || 0;
    const s01 = clamp(speed / 14, 0, 1);
    const grounded = st ? !!st.grounded : false;
    const mode = st ? st.mode : 'ride';
    const grinding = !frozen && (grind ? !!grind.active : gp.active);

    // --- pan by screen-space X ----------------------------------------------
    let targetPan = 0;
    if (st && camera) {
      _v.copy(st.position);
      _v.y += 0.6;
      _v.project(camera);
      if (Number.isFinite(_v.x)) targetPan = clamp(_v.x * 0.55, -0.8, 0.8);
    }
    pan += (targetPan - pan) * clamp(dt * 7, 0, 1);
    if (tyrePan.pan) setP(tyrePan.pan, pan, 0.05);
    if (grindPan.pan) setP(grindPan.pan, pan, 0.05);

    // --- tyre roll -----------------------------------------------------------
    const surf = surfaceOf(st ? st.surfaceType : 'ground', st ? st.surfaceFriction : 1);
    const rolling = grounded && !grinding && mode !== 'bail' && speed > 0.2;
    const want = rolling ? Math.pow(s01, 0.7) * surf.level : 0;
    tyreLevel += (want - tyreLevel) * clamp(dt * (want > tyreLevel ? 12 : 9), 0, 1);
    const tl = tyreLevel;

    setP(tyreLP.frequency, surf.lp * (0.42 + 0.72 * s01), 0.05);
    setP(tyreBroad.gain, Math.max(0.0001, tl * surf.broad * 0.30), 0.04);
    setP(tyreBP.frequency, surf.band * (0.55 + 0.85 * s01), 0.05);
    setP(tyreBP.Q, surf.q, 0.10);
    setP(tyreBand.gain, Math.max(0.0001, tl * surf.band0 * 0.34), 0.04);
    setP(tyreSubG.gain, Math.max(0.0001, tl * surf.sub * 0.20), 0.05);

    // --- wind ----------------------------------------------------------------
    const air = st && !frozen ? Math.hypot(st.velocity.x, st.velocity.y, st.velocity.z) : 0;
    const a01 = clamp((air - 3) / 12, 0, 1);
    const airborne = !grounded ? 1 : 0.35;
    setP(windLP.frequency, 260 + a01 * 1500, 0.08);
    setP(windG.gain, Math.max(0.0001, Math.pow(a01, 1.4) * 0.30 * airborne), 0.09);

    // --- freewheel + chain ---------------------------------------------------
    const spin = st && !frozen ? Math.abs(st.wheelSpin || 0) : 0;
    const revs = spin / (Math.PI * 2);
    const rate = clamp((revs * 9) / 28, 0.28, 3.0);
    setP(clickSrc.playbackRate, rate, 0.06);
    const throttle = ctx.input && ctx.input.state ? ctx.input.state.throttle : 0;
    const coasting = throttle < 0.05 && !grinding && mode !== 'bail' && revs > 0.25;
    setP(clickG.gain,
      Math.max(0.0001, coasting ? clamp(revs / 5, 0.15, 1) * 0.16 * (grounded ? 1 : 0.55) : 0.0001),
      0.05);
    setP(whirBP.frequency, 1200 + s01 * 1400, 0.08);
    setP(whirG.gain,
      Math.max(0.0001, throttle > 0.05 && grounded ? 0.045 * throttle * (0.4 + s01) : 0.0001),
      0.06);

    // --- skid ----------------------------------------------------------------
    const skid = st && !frozen ? st.skid || 0 : 0;
    setP(skidBP.frequency, 950 + s01 * 900, 0.06);
    setP(skidG.gain, Math.max(0.0001, skid * 0.26 * clamp(s01 * 1.6, 0.2, 1)), 0.05);

    // --- grind ---------------------------------------------------------------
    const railType = grind && grind.active ? grind.railType : gp.material;
    const r = RAILS[railType] || RAILS.rail;
    const gs = grind && grind.active ? grind.speed || 0 : gp.speed;
    const g01 = clamp(gs / 11, 0, 1);
    const bal = grind && grind.active ? Math.abs(grind.balance || 0) : Math.abs(gp.balance);
    const crit = grind && grind.active ? !!grind.critical : gp.critical;
    const gwant = grinding ? clamp(gs / 7.5, 0.25, 1) * r.level * (crit ? 1.12 : 1) : 0;
    grindLevel += (gwant - grindLevel) * clamp(dt * (gwant > grindLevel ? 26 : 16), 0, 1);

    const sawF = r.saw * (0.70 + g01 * 0.95);
    setP(saw1.frequency, sawF, 0.04);
    setP(saw2.frequency, sawF * 1.007, 0.04);
    setP(grindBP.frequency, r.bp * (0.72 + g01 * 0.55), 0.05);
    setP(grindBP.Q, r.q, 0.08);
    setP(sawMix.gain, r.sawG, 0.08);
    setP(grindG.gain, Math.max(0.0001, grindLevel * 0.34), 0.03);
    setP(grindNoiseBP.frequency, r.nbp * (0.7 + g01 * 0.6), 0.05);
    setP(grindNoiseBP.Q, r.nq, 0.08);
    setP(grindNoiseG.gain, Math.max(0.0001, grindLevel * r.noise * 0.30), 0.03);
    setP(wobG.gain, Math.max(0.0001, grinding ? bal * 45 + (crit ? 25 : 0) : 0.0001), 0.05);
  }

  // =========================================================================
  // music
  // =========================================================================

  function mGain(peak, t, atk, dur, dest) {
    const g = ac.createGain();
    env(g.gain, t, peak, atk, dur);
    g.connect(dest || busMusic);
    return g;
  }

  function mKick(t, accent) {
    const g = mGain(0.85 * accent, t, 0.004, 0.30);
    const o = ac.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(155, t);
    o.frequency.exponentialRampToValueAtTime(44, t + 0.085);
    o.connect(g);
    o.start(t);
    o.stop(t + 0.32);
    o.onended = () => { o.disconnect(); g.disconnect(); };
  }

  function mNoise(t, peak, atk, dur, type, f, q, dest) {
    const g = mGain(peak, t, atk, dur, dest);
    const b = biquad(type, f, q, g);
    const s = ac.createBufferSource();
    s.buffer = noiseBuf;
    s.connect(b);
    s.start(t, nextNoiseOffset(), dur + 0.03);
    s.stop(t + dur + 0.03);
    s.onended = () => { s.disconnect(); b.disconnect(); g.disconnect(); };
  }

  function mSnare(t, accent) {
    mNoise(t, 0.42 * accent, 0.002, 0.16, 'highpass', 1400, 0.8);
    const g = mGain(0.26 * accent, t, 0.002, 0.10);
    const o = ac.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(200, t);
    o.frequency.exponentialRampToValueAtTime(140, t + 0.08);
    o.connect(g);
    o.start(t);
    o.stop(t + 0.12);
    o.onended = () => { o.disconnect(); g.disconnect(); };
  }

  function mHat(t, accent, open) {
    mNoise(t, (open ? 0.13 : 0.10) * accent, 0.001, open ? 0.17 : 0.032, 'highpass', 7600, 0.9);
  }

  function mCrash(t) {
    mNoise(t, 0.20, 0.003, 1.35, 'highpass', 4600, 0.7);
  }

  function mBass(t, midi, dur, accent) {
    const f = mtof(midi);
    const g = mGain(0.34 * accent, t, 0.006, dur);
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 4.5;
    lp.frequency.setValueAtTime(340, t);
    lp.frequency.exponentialRampToValueAtTime(1500 * accent, t + 0.03);
    lp.frequency.exponentialRampToValueAtTime(300, t + dur);
    lp.connect(g);
    const o1 = ac.createOscillator();
    o1.type = 'sawtooth';
    o1.frequency.value = f;
    const o2 = ac.createOscillator();
    o2.type = 'square';
    o2.frequency.value = f;
    o2.detune.value = -9;
    o1.connect(lp);
    o2.connect(lp);
    o1.start(t); o2.start(t);
    o1.stop(t + dur + 0.03); o2.stop(t + dur + 0.03);
    o1.onended = () => { o1.disconnect(); o2.disconnect(); lp.disconnect(); g.disconnect(); };
  }

  /** Power chord: root + fifth + octave, detuned, through the shared amp shaper. */
  function mStab(t, midi, dur, accent) {
    const g = mGain(0.13 * accent, t, 0.004, dur, guitarDrive);
    const lp = biquad('lowpass', 2800, 0.9, g);
    const o1 = ac.createOscillator();
    const o2 = ac.createOscillator();
    const o3 = ac.createOscillator();
    o1.type = o2.type = o3.type = 'sawtooth';
    o1.frequency.value = mtof(midi + 24);
    o2.frequency.value = mtof(midi + 31);
    o3.frequency.value = mtof(midi + 36);
    o1.detune.value = -8;
    o3.detune.value = 8;
    o1.connect(lp); o2.connect(lp); o3.connect(lp);
    o1.start(t); o2.start(t); o3.start(t);
    o1.stop(t + dur + 0.03); o2.stop(t + dur + 0.03); o3.stop(t + dur + 0.03);
    o1.onended = () => {
      o1.disconnect(); o2.disconnect(); o3.disconnect();
      lp.disconnect(); g.disconnect();
    };
  }

  function musicStepAt(step, t) {
    const bar = (step >> 4) & 15;
    const s = step & 15;
    const sectionB = bar >= 8;
    const barIn = bar & 7;

    const kickPat = KICK[sectionB ? 1 : 0];
    const snarePat = barIn === 7 ? SNARE[2] : (barIn === 3 ? SNARE[1] : SNARE[0]);
    const hatPat = (sectionB || barIn >= 4) ? HAT16 : HAT8;
    const bassPat = sectionB ? BASS16 : BASS8;
    const stabPat = (barIn & 1) ? STAB_B : STAB_A;
    const root = (sectionB ? ROOTS_B : ROOTS_A)[barIn];

    let v = kickPat[s];
    if (v) mKick(t, v === 2 ? 1 : 0.78);
    v = snarePat[s];
    if (v) mSnare(t, v === 2 ? 1 : 0.7);
    v = hatPat[s];
    if (v) mHat(t, v === 2 ? 1 : 0.72, v === 3);
    v = bassPat[s];
    if (v) {
      const oct = sectionB && (s === 6 || s === 14) ? 12 : 0;
      mBass(t, root + oct, STEP_DUR * (v === 2 ? 1.7 : 1.15), v === 2 ? 1 : 0.8);
    }
    if (barIn >= 2 || sectionB) {
      v = stabPat[s];
      if (v) mStab(t, root, STEP_DUR * (v === 2 ? 2.4 : 1.3), v === 2 ? 1 : 0.72);
    }
    if (s === 0 && (bar & 3) === 0) mCrash(t);
  }

  function scheduleMusic() {
    if (!musicOn || !musicStarted) return;
    const now = ac.currentTime;
    if (musicNext < now - 0.4) musicNext = now + 0.05;    // tab was hidden: resync
    let guard = 0;
    while (musicNext < now + 0.16 && guard++ < 48) {
      if (musicNext >= now - 0.02) musicStepAt(musicStep, musicNext);
      musicNext += STEP_DUR;
      musicStep = (musicStep + 1) % TOTAL_STEPS;
    }
  }

  // =========================================================================
  // per-frame
  // =========================================================================

  function update(dt, c) {
    if (disposed) return;
    const cx = c || ctx;
    if (!ready) {
      // Nothing to do until a gesture unlocks the context; kick() is idempotent and
      // cheap enough to poll in case the browser already allows playback.
      if (ac && ac.state === 'running' && built) onRunning();
      return;
    }
    const d = dt > 0 ? Math.min(dt, 0.1) : 0.0001;
    elapsed += d;
    comboHeat = Math.max(0, comboHeat - d * 0.35);

    const st = cx.player && cx.player.physics ? cx.player.physics.state : null;
    const grind = cx.player ? cx.player.grind : null;
    const frozen = !!(cx.flags && (cx.flags.paused || cx.flags.freeze));
    updateLoops(d, st, grind, cx.camera, frozen);

    // Music duck recovery — and a standing duck while the game is paused.
    const floor = frozen ? 0.35 : 0;
    if (duckAmount > floor + 0.0005 || duckAmount < floor - 0.0005) {
      duckAmount = duckAmount > floor
        ? Math.max(floor, duckAmount - d * 1.1)
        : Math.min(floor, duckAmount + d * 1.6);
      musicDuck.gain.setTargetAtTime(1 - duckAmount, ac.currentTime, 0.08);
      musicDuck.gain.__t = undefined;
    }

    scheduleMusic();
  }

  // =========================================================================
  // events
  // =========================================================================

  const listeners = [];
  function on(type, fn) {
    if (!ctx || typeof ctx.on !== 'function') return;
    ctx.on(type, fn);
    listeners.push([type, fn]);
  }

  const relay = (name) => (e) => play(name, e && e.detail);

  function wire() {
    on('hop', relay('hop'));
    on('pump', relay('pump'));
    on('land', relay('land'));
    on('bail', relay('bail'));
    on('skid', relay('skid'));
    on('wheelContact', relay('wheelContact'));
    on('wallride', relay('wallride'));
    on('respawn', relay('respawn'));

    on('grindStart', relay('grindStart'));
    on('grindEnd', relay('grindEnd'));
    on('grindTransfer', relay('grindTransfer'));
    on('grindSwitch', relay('grindSwitch'));
    on('revert', relay('revert'));

    on('trick', (e) => trick(e && e.detail));
    on('comboLand', relay('comboLand'));
    on('comboBank', relay('comboBank'));
    on('comboBail', relay('comboBail'));

    on('scoreBank', relay('bank'));
    on('scoreLost', relay('scoreLost'));
    on('scoreGap', relay('gap'));
    on('letterCollected', relay('letter'));
    on('objectSmashed', relay('smash'));
    on('goalComplete', relay('goal'));
    on('achievement', relay('achievement'));
    on('rankUp', relay('rankUp'));
    on('specialReady', (e) => {
      const dd = e && e.detail;
      if (dd && dd.ready === false) return;      // meter emptying is silent
      play('special', dd);
    });
    on('specialSpent', relay('specialSpent'));
    on('countdown', relay('countdown'));
    on('sessionStart', relay('sessionStart'));
    on('sessionEnd', relay('sessionEnd'));
  }

  // =========================================================================
  // teardown
  // =========================================================================

  function dispose() {
    if (disposed) return;
    disposed = true;
    ready = false;
    api.enabled = false;
    removeGestureHooks();
    if (ctx && ctx.events) {
      for (let i = 0; i < listeners.length; i++) {
        ctx.events.removeEventListener(listeners[i][0], listeners[i][1]);
      }
    }
    listeners.length = 0;
    if (!ac) return;
    try {
      const t = ac.currentTime;
      if (noiseSrc) noiseSrc.stop(t);
      if (clickSrc) clickSrc.stop(t);
      if (saw1) saw1.stop(t);
      if (saw2) saw2.stop(t);
      if (wobLFO) wobLFO.stop(t);
      if (master) master.disconnect();
    } catch (e) { /* already stopped */ }
    try { ac.close(); } catch (e) { /* closing twice is harmless */ }
    ac = null;
    api.ctxAudio = null;
  }

  // =========================================================================
  // boot
  // =========================================================================

  wire();
  addGestureHooks();
  // Try immediately: on a page that already has a gesture (a reload after play, or
  // a permissive autoplay policy) this starts the music without waiting.
  kick();

  return api;
}
