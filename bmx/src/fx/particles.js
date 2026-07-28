// GPU particle systems, ground decals and screen effects.
//
// Design notes
//  * Two pooled systems (soft/alpha-blended, additive/hot) share one procedural
//    atlas. Each is an InstancedBufferGeometry quad; the CPU only ever writes the
//    spawn state of a particle. Position, size, rotation, colour ramp and fade are
//    integrated in the vertex shader from `uTime - spawnTime`:
//        p = p0 + v * (1 - e^-kt)/k + 0.5 * g * t^2
//    so a frame costs one uniform write plus a free-list sweep over live indices.
//  * Recycling is a compacting sweep over an Int32Array of live indices; dead slots
//    are pushed back onto a free-list stack. Nothing in the update path allocates.
//  * The composer's render target has no readable depth texture (GTAO builds its own),
//    so soft particles use a spherical alpha falloff plus a near-camera fade instead
//    of a depth-buffer soft clip. depthWrite is off, depthTest on, and the systems
//    have fixed renderOrders so they resolve against opaque geometry correctly.
//  * Dust and smoke are shaded per-fragment with a sphere-normal wrapped lambert
//    (warm sun + cool sky) so puffs read volumetric rather than as flat sprites, and
//    stay well under the 0.92 bloom threshold. Sparks and flashbulbs are emitted at
//    3-8 in linear HDR so they blow through the threshold and bloom hard.

import * as THREE from 'three';
import { clamp, lerp, rng, rand, fbm2, TAU } from '../core/mathx.js';

// --------------------------------------------------------------------------- config

const SOFT_POOL = 2800;      // dust, smoke, puffs, debris, gravel
const HOT_POOL = 1600;       // sparks, flashbulbs, speed lines
const DECAL_POOL = 128;      // tyre / skid ground stamps
const MAX_SPARK_LIGHTS = 2;

const TILE_SMOKE = 0;
const TILE_DUST = 1;
const TILE_SPARK = 2;
const TILE_CHIP = 3;

const DECAL_TREAD = 0;
const DECAL_SKID = 1;
const DECAL_PERIOD = 0.42;   // metres of travel per decal texture repeat

// Half a wheelbase; kept local so this module does not depend on physics tuning.
const HALF_WHEELBASE = 0.52;

/** Per-surface dust look. Colours are albedo — the shader lights them. */
const SURFACE_DUST = {
  ground: { color: [0.80, 0.75, 0.67], rate: 1.0, coolMix: 0.30 },
  concrete: { color: [0.82, 0.77, 0.70], rate: 0.9, coolMix: 0.32 },
  asphalt: { color: [0.66, 0.63, 0.61], rate: 1.0, coolMix: 0.34 },
  ramp: { color: [0.80, 0.76, 0.69], rate: 0.55, coolMix: 0.30 },
  wood: { color: [0.74, 0.59, 0.43], rate: 0.7, coolMix: 0.22 },
  plywood: { color: [0.74, 0.59, 0.43], rate: 0.7, coolMix: 0.22 },
  metal: { color: [0.70, 0.70, 0.74], rate: 0.35, coolMix: 0.40 },
  coping: { color: [0.70, 0.70, 0.74], rate: 0.3, coolMix: 0.40 },
  dirt: { color: [0.68, 0.49, 0.31], rate: 2.6, coolMix: 0.12 },
  grass: { color: [0.52, 0.52, 0.30], rate: 1.6, coolMix: 0.18 },
  gravel: { color: [0.72, 0.65, 0.55], rate: 2.2, coolMix: 0.20 },
  wall: { color: [0.78, 0.73, 0.68], rate: 0.6, coolMix: 0.30 },
};
const COOL_TINT = [0.58, 0.69, 0.88];   // sky-lit side of a dust cloud

/**
 * Emitter presets. Ranges are [min, max]; everything else is a scalar.
 *   drag      linear air drag, 1/s
 *   gravity   m/s^2 pulling -Y
 *   fadePow   alpha = (1 - age)^fadePow — high = a sharp pop, low = a long tail
 *   turb      m/s of shader-side curl wander
 *   stretch   seconds of velocity smeared into the quad's length
 *   soft      0 = texture alpha only, 1 = full spherical falloff
 */
const PRESETS = {
  rollDust: {
    life: [0.55, 1.05], size: [0.12, 0.22], grow: [2.6, 3.8], alpha: [0.14, 0.26],
    color: [0.82, 0.77, 0.70], colorJitter: 0.10, coolMix: 0.32,
    drag: 2.6, gravity: -0.5, fadePow: 1.5, turb: 0.16, stretch: 0.012,
    rot: 1.1, tile: TILE_DUST, heat: 0, soft: 1, posJitter: 0.07, velJitter: 0.35,
  },
  dirtDust: {
    life: [0.8, 1.6], size: [0.18, 0.34], grow: [2.8, 4.4], alpha: [0.26, 0.44],
    color: [0.68, 0.49, 0.31], colorJitter: 0.14, coolMix: 0.14,
    drag: 2.0, gravity: 0.6, fadePow: 1.3, turb: 0.24, stretch: 0.01,
    rot: 1.4, tile: TILE_DUST, heat: 0, soft: 1, posJitter: 0.09, velJitter: 0.6,
  },
  skidSmoke: {
    life: [0.9, 1.8], size: [0.16, 0.30], grow: [3.4, 5.2], alpha: [0.18, 0.32],
    color: [0.34, 0.335, 0.35], colorJitter: 0.16, coolMix: 0.22,
    drag: 1.6, gravity: 1.1, fadePow: 1.1, turb: 0.30, stretch: 0.008,
    rot: 0.9, tile: TILE_SMOKE, heat: 0, soft: 1, posJitter: 0.08, velJitter: 0.5,
  },
  landPuff: {
    life: [0.6, 1.25], size: [0.16, 0.30], grow: [3.2, 4.8], alpha: [0.22, 0.38],
    color: [0.82, 0.77, 0.70], colorJitter: 0.10, coolMix: 0.34,
    drag: 3.2, gravity: -0.4, fadePow: 1.4, turb: 0.22, stretch: 0.014,
    rot: 1.2, tile: TILE_SMOKE, heat: 0, soft: 1, posJitter: 0.10, velJitter: 0.5,
  },
  gravel: {
    life: [0.7, 1.4], size: [0.026, 0.055], grow: [0.9, 1.1], alpha: [0.85, 1.0],
    color: [0.46, 0.40, 0.33], colorJitter: 0.28, coolMix: 0.10,
    drag: 0.28, gravity: 16.0, fadePow: 0.35, turb: 0, stretch: 0.004,
    rot: 9.0, tile: TILE_CHIP, heat: 0, soft: 0, posJitter: 0.05, velJitter: 1.6,
  },
  debris: {
    life: [0.9, 1.9], size: [0.035, 0.085], grow: [0.9, 1.15], alpha: [0.85, 1.0],
    color: [0.38, 0.34, 0.30], colorJitter: 0.34, coolMix: 0.16,
    drag: 0.32, gravity: 15.0, fadePow: 0.3, turb: 0, stretch: 0.006,
    rot: 12.0, tile: TILE_CHIP, heat: 0, soft: 0, posJitter: 0.10, velJitter: 2.4,
  },
  spark: {
    life: [0.22, 0.62], size: [0.030, 0.062], grow: [0.35, 0.6], alpha: [0.85, 1.0],
    color: [1.0, 1.0, 1.0], colorJitter: 0.06, coolMix: 0,
    drag: 1.5, gravity: 11.0, fadePow: 1.8, turb: 0, stretch: 0.028,
    rot: 0, tile: TILE_SPARK, heat: 1, soft: 0, posJitter: 0.02, velJitter: 1.5,
  },
  emberTrail: {
    life: [0.5, 1.15], size: [0.016, 0.030], grow: [0.5, 0.8], alpha: [0.5, 0.85],
    color: [1.0, 1.0, 1.0], colorJitter: 0.05, coolMix: 0,
    drag: 2.4, gravity: 6.0, fadePow: 2.6, turb: 0.10, stretch: 0.010,
    rot: 0, tile: TILE_SPARK, heat: 1, soft: 0, posJitter: 0.03, velJitter: 0.9,
  },
  flash: {
    life: [0.10, 0.17], size: [0.26, 0.44], grow: [1.5, 2.2], alpha: [0.9, 1.0],
    color: [7.4, 7.8, 9.2], colorJitter: 0.08, coolMix: 0,
    drag: 0.1, gravity: 0, fadePow: 3.2, turb: 0, stretch: 0,
    rot: 0.4, tile: TILE_SPARK, heat: 0, soft: 0, posJitter: 0.05, velJitter: 0.05,
  },
  flashGlow: {
    life: [0.28, 0.46], size: [0.5, 0.9], grow: [1.8, 2.6], alpha: [0.10, 0.20],
    color: [1.5, 1.7, 2.3], colorJitter: 0.08, coolMix: 0,
    drag: 0.1, gravity: 0, fadePow: 2.4, turb: 0, stretch: 0,
    rot: 0.2, tile: TILE_SMOKE, heat: 0, soft: 1, posJitter: 0.05, velJitter: 0.05,
  },
  speedLine: {
    life: [0.16, 0.30], size: [0.014, 0.032], grow: [0.7, 1.0], alpha: [0.10, 0.22],
    color: [0.62, 0.70, 0.86], colorJitter: 0.10, coolMix: 0,
    drag: 0.05, gravity: 0, fadePow: 1.6, turb: 0, stretch: 0.055,
    rot: 0, tile: TILE_SPARK, heat: 0, soft: 0, posJitter: 0.0, velJitter: 0.6,
  },
  wallScuff: {
    life: [0.4, 0.9], size: [0.10, 0.20], grow: [2.4, 3.4], alpha: [0.12, 0.24],
    color: [0.78, 0.73, 0.68], colorJitter: 0.12, coolMix: 0.30,
    drag: 2.8, gravity: 2.0, fadePow: 1.5, turb: 0.18, stretch: 0.012,
    rot: 1.4, tile: TILE_DUST, heat: 0, soft: 1, posJitter: 0.06, velJitter: 0.5,
  },
};

// --------------------------------------------------------------------------- textures

const sstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Wrap-blended fbm so a pattern repeats seamlessly across `period` in y. */
function fbmWrapY(x, y, period, oct) {
  const a = fbm2(x, y, oct);
  const b = fbm2(x, y - period, oct);
  return lerp(a, b, clamp(y / period, 0, 1));
}

/**
 * 512^2 RGBA atlas, 2x2 tiles: cloudy smoke puff, gritty dust wisp, hot spark
 * streak, lit stone chip. RGB is a linear multiplier (not sRGB) so tinting is
 * predictable; every tile fades to alpha 0 at its border so mips cannot bleed.
 */
function makeParticleAtlas() {
  const S = 256, N = 2, W = S * N;
  const data = new Uint8Array(W * W * 4);

  const put = (tx, ty, x, y, r, g, b, a) => {
    const p = (((ty * S + y) * W) + (tx * S + x)) * 4;
    data[p] = clamp(r, 0, 1) * 255;
    data[p + 1] = clamp(g, 0, 1) * 255;
    data[p + 2] = clamp(b, 0, 1) * 255;
    data[p + 3] = clamp(a, 0, 1) * 255;
  };

  // --- tile 0: cauliflower smoke puff --------------------------------------
  // Built from overlapping lobes rather than one radial gradient: a single
  // gradient reads as a blurry disc the moment a puff gets big on screen.
  const puffPhase = rng() * 64;
  const lobes = [];
  for (let i = 0; i < 7; i++) {
    const ang = (i / 7) * TAU + rand(-0.4, 0.4);
    const d = i === 0 ? 0 : rand(0.16, 0.40);
    lobes.push([Math.cos(ang) * d, Math.sin(ang) * d, rand(0.30, 0.48)]);
  }
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = ((x + 0.5) / S - 0.5) * 2, dy = ((y + 0.5) / S - 0.5) * 2;
      const r = Math.hypot(dx, dy);
      let a = 0;
      for (let i = 0; i < lobes.length; i++) {
        const L = lobes[i];
        const d = Math.hypot(dx - L[0], dy - L[1]);
        const k = sstep(0, 0.30, L[2] - d);
        if (k > a) a = k;
      }
      // two-scale density: big internal shadows plus fine grain
      const dens = 0.46 + 0.70 * fbm2(dx * 3.4 + 13.7, dy * 3.4 + 5.2, 4)
        * (0.72 + 0.42 * fbm2(dx * 11.0 + 61.3, dy * 11.0 + 27.9, 3));
      a *= clamp(dens, 0, 1.1);
      a *= sstep(0.0, 0.14, 1.0 - r);
      const v = 0.74 + 0.30 * fbm2(dx * 4.7 + 31.2 + puffPhase, dy * 4.7 + 9.4, 4);
      put(0, 0, x, y, v, v * 0.995, v * 0.99, a * 0.95);
    }
  }

  // --- tile 1: gritty dust wisp -------------------------------------------
  const wispPhase = rng() * 64;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = ((x + 0.5) / S - 0.5) * 2, dy = ((y + 0.5) / S - 0.5) * 2;
      const r = Math.hypot(dx * 0.86, dy * 1.18);
      const ang = Math.atan2(dy, dx);
      const lump = 0.66 + 0.34 * fbm2(Math.cos(ang) * 3.4 + wispPhase, Math.sin(ang) * 3.4 + wispPhase * 0.7, 4);
      let a = sstep(0, 0.46, lump - r);
      const grain = 0.30 + 0.95 * fbm2(dx * 6.4 + 3.9, dy * 6.4 + 21.5, 5);
      a *= clamp(grain, 0, 1.1) * 0.85;
      a *= sstep(0.0, 0.20, 1.0 - Math.hypot(dx, dy));
      const v = 0.80 + 0.22 * fbm2(dx * 7.1 + 51.0, dy * 7.1 + 17.0, 3);
      put(1, 0, x, y, v, v * 0.99, v * 0.975, a);
    }
  }

  // --- tile 2: spark core + streak ----------------------------------------
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = ((x + 0.5) / S - 0.5) * 2, dy = ((y + 0.5) / S - 0.5) * 2;
      const core = Math.exp(-(dx * dx + dy * dy) * 22.0);
      const streak = Math.exp(-(dx * dx * 150.0 + dy * dy * 2.4)) * 0.85;
      const glow = Math.exp(-(dx * dx + dy * dy) * 4.2) * 0.16;
      const a = clamp(core + streak + glow, 0, 1) * sstep(0.0, 0.12, 1.0 - Math.hypot(dx, dy));
      put(0, 1, x, y, 1, 1, 1, a);
    }
  }

  // --- tile 3: lit stone chip ---------------------------------------------
  const chipPhase = rng() * 64;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = ((x + 0.5) / S - 0.5) * 2, dy = ((y + 0.5) / S - 0.5) * 2;
      const r = Math.hypot(dx, dy);
      const ang = Math.atan2(dy, dx);
      const rad = 0.48 + 0.34 * fbm2(Math.cos(ang) * 1.9 + chipPhase, Math.sin(ang) * 1.9 + chipPhase * 0.3, 2);
      const a = clamp((rad - r) * S * 0.12, 0, 1);
      // fake bevel: lit from upper-left, plus grain so chips are not flat blobs
      const facet = fbm2(dx * 5.0 + 71.3, dy * 5.0 + 44.1, 2);
      const shade = clamp(0.44 + 0.62 * (0.5 - dy * 0.55 - dx * 0.22) + 0.28 * (facet - 0.5), 0.12, 1.0);
      put(1, 1, x, y, shade, shade * 0.965, shade * 0.93, a);
    }
  }

  const tex = new THREE.DataTexture(data, W, W, THREE.RGBAFormat);
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/**
 * 512x256 decal atlas: [tread | skid]. Both tiles are seamless in V so
 * consecutive stamps along a wheel path join into one continuous mark; they
 * fade to zero across U so the edges of the strip are soft.
 */
function makeDecalAtlas() {
  const S = 256, W = S * 2;
  const data = new Uint8Array(W * S * 4);
  const put = (tx, x, y, a) => {
    const p = ((y * W) + (tx * S + x)) * 4;
    data[p] = 255; data[p + 1] = 255; data[p + 2] = 255;
    data[p + 3] = clamp(a, 0, 1) * 255;
  };

  const treadPhase = rng() * 32;
  for (let y = 0; y < S; y++) {
    const v = (y + 0.5) / S;
    for (let x = 0; x < S; x++) {
      const u = (x + 0.5) / S;
      // width profile — soft shoulders, eroded by noise
      const edge = 0.5 - Math.abs(u - 0.5);
      let w = sstep(0.03, 0.19, edge);
      w *= 0.72 + 0.5 * fbmWrapY(u * 5.0 + treadPhase, v * 6.0, 6.0, 3);
      // knobby blocks, 8 per repeat, plus a centre channel
      const blk = (v * 8.0) % 1.0;
      const knob = 0.34 + 0.66 * (sstep(0.02, 0.12, blk) * (1.0 - sstep(0.66, 0.80, blk)));
      const channel = 1.0 - 0.42 * (1.0 - sstep(0.0, 0.045, Math.abs(u - 0.5)));
      const grain = 0.62 + 0.6 * fbmWrapY(u * 13.0 + 7.0, v * 15.0, 15.0, 4);
      put(0, x, y, clamp(w * knob * channel * grain, 0, 1) * 0.92);
    }
  }

  const skidPhase = rng() * 32;
  for (let y = 0; y < S; y++) {
    const v = (y + 0.5) / S;
    for (let x = 0; x < S; x++) {
      const u = (x + 0.5) / S;
      const edge = 0.5 - Math.abs(u - 0.5);
      let w = sstep(0.02, 0.34, edge);
      // longitudinal streaks: mostly a function of u, so V stays seamless
      const streak = 0.30 + 0.95 * fbm2(u * 26.0 + skidPhase, 3.7, 3);
      const smear = 0.45 + 0.85 * fbmWrapY(u * 4.0 + 19.0, v * 3.0, 3.0, 3);
      w *= clamp(streak * smear, 0, 1.2);
      put(1, x, y, clamp(w, 0, 1) * 0.95);
    }
  }

  const tex = new THREE.DataTexture(data, W, S, THREE.RGBAFormat);
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;   // V repeats along the travel direction
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

// --------------------------------------------------------------------------- shaders

const PARTICLE_VERT = /* glsl */`
  precision highp float;

  attribute vec3 aOrigin;
  attribute vec3 aVel;
  attribute vec4 aTime;    // spawnTime, 1/life, seed, tile
  attribute vec4 aSize;    // size0, size1, stretchSeconds, rotRate
  attribute vec4 aColor;   // rgb, alpha
  attribute vec4 aPhys;    // drag, gravity, fadePow, turbulence
  attribute vec2 aExtra;   // heat, softness

  uniform float uTime;
  uniform float uFogDensity;   // > 0 only for the additive pass (fades alpha, not colour)

  varying vec4 vColor;
  varying vec2 vUv;
  varying vec2 vQ;
  varying float vSoft;

  #include <fog_pars_vertex>

  void main() {
    float t = uTime - aTime.x;
    float age = t * aTime.y;

    if (age < 0.0 || age >= 1.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);   // clipped: dead slot
      vColor = vec4(0.0); vUv = vec2(0.0); vQ = vec2(0.0); vSoft = 0.0;
      return;
    }

    // --- integrate motion in closed form ---------------------------------
    float k = max(aPhys.x, 1e-4);
    float ex = exp(-k * t);
    float damping = (1.0 - ex) / k;
    vec3 g = vec3(0.0, -aPhys.y, 0.0);
    vec3 wp = aOrigin + aVel * damping + 0.5 * g * t * t;
    vec3 vel = aVel * ex + g * t;

    float ph = aTime.z * 6.2831853;
    if (aPhys.w > 0.0) {
      // cheap curl-ish wander so dust rolls instead of drifting in straight lines
      vec3 curl = vec3(sin(ph + t * 1.9), sin(ph * 1.7 + t * 1.15) * 0.55, cos(ph * 0.8 + t * 2.3));
      wp += aPhys.w * t * curl;
      vel += aPhys.w * curl * 0.5;
    }

    // --- billboard --------------------------------------------------------
    float ease = 1.0 - (1.0 - age) * (1.0 - age);
    float sz = mix(aSize.x, aSize.y, ease);

    vec4 mvPosition = modelViewMatrix * vec4(wp, 1.0);

    vec2 c = position.xy;                    // quad corner, [-0.5, 0.5]
    vec3 offset;
    vec3 vv = (modelViewMatrix * vec4(vel, 0.0)).xyz;
    float vl = length(vv.xy);
    if (aSize.z > 0.0001 && vl > 0.0001) {
      // stretch along the screen-space velocity: sparks become streaks.
      // perp is chosen so (perp, dir) stays right-handed — a mirrored basis
      // would flip the winding and the quad would be back-face culled.
      vec2 dir = vv.xy / vl;
      vec2 perp = vec2(dir.y, -dir.x);
      float len = sz + aSize.z * vl;
      offset = vec3(perp * (c.x * sz) + dir * (c.y * len), 0.0);
    } else {
      float rot = ph + aSize.w * t;
      float cs = cos(rot), sn = sin(rot);
      offset = vec3(vec2(c.x * cs - c.y * sn, c.x * sn + c.y * cs) * sz, 0.0);
    }
    mvPosition.xyz += offset;

    // --- shading inputs ---------------------------------------------------
    float fade = smoothstep(0.0, 0.07, age) * pow(1.0 - age, aPhys.z);
    float alpha = aColor.a * fade;

    // near-plane soft clip: kills the pop when a puff swallows the camera
    float depth = -mvPosition.z;
    alpha *= smoothstep(0.10, 0.85, depth);

    if (uFogDensity > 0.0) {
      float f = uFogDensity * depth;
      alpha *= exp(-f * f);
    }

    vec3 rgb = aColor.rgb;
    if (aExtra.x > 0.0) {
      vec3 heatRamp = mix(vec3(6.6, 5.5, 3.7), vec3(3.5, 0.86, 0.10), pow(age, 0.6));
      rgb = mix(rgb, rgb * heatRamp, aExtra.x);
    }

    vColor = vec4(rgb, alpha);
    vSoft = aExtra.y;
    vQ = c;

    float tile = aTime.w;
    vec2 tileOff = vec2(mod(tile, 2.0), floor(tile * 0.5));
    vUv = (uv + tileOff) * 0.5;

    gl_Position = projectionMatrix * mvPosition;

    #include <fog_vertex>
  }
`;

const PARTICLE_FRAG = /* glsl */`
  precision highp float;

  uniform sampler2D uMap;
  uniform vec3 uSunDir;      // view space
  uniform vec3 uSunColor;
  uniform vec3 uAmbient;

  varying vec4 vColor;
  varying vec2 vUv;
  varying vec2 vQ;
  varying float vSoft;

  #include <fog_pars_fragment>

  void main() {
    vec4 tex = texture2D(uMap, vUv);
    float r2 = dot(vQ, vQ) * 4.0;
    // gentle: the atlas tiles already fade out, so this only rounds off the corners
    // and keeps the puff's lumpy silhouette instead of masking it to a disc
    float radial = 1.0 - smoothstep(0.60, 1.25, r2);
    float a = tex.a * vColor.a * mix(1.0, radial, vSoft);
    if (a < 0.0035) discard;

    vec3 rgb = vColor.rgb * tex.rgb;

    #ifdef LIT
      // treat the billboard as a sphere so puffs get a warm lit face and a cool
      // sky-bounced shadow side — the biggest "not a flat sprite" win available
      vec3 n = normalize(vec3(vQ * 2.0, sqrt(max(0.05, 1.0 - min(r2, 1.0)))));
      float ndl = dot(n, uSunDir) * 0.5 + 0.5;
      // heavily wrapped: airborne dust forward-scatters, so even the shadow side
      // carries a lot of sun. A pure lambert reads as a dark bruise.
      rgb *= uAmbient + uSunColor * (0.38 + 0.62 * ndl * ndl);
      // hard ceiling just under the bloom threshold (0.92): dust must never glow
      rgb = min(rgb, vec3(0.88));
    #endif

    gl_FragColor = vec4(rgb, a);

    #include <fog_fragment>
  }
`;

const DECAL_VERT = /* glsl */`
  precision highp float;

  attribute vec3 aCenter;
  attribute vec3 aAxisU;    // half-width across the mark
  attribute vec3 aAxisV;    // half-length along travel
  attribute vec4 aParam;    // spawnTime, 1/life, tile, strength
  attribute vec2 aUvV;      // v scale, v offset
  attribute vec3 aTint;

  uniform float uTime;
  uniform float uFogDensity;

  varying vec2 vUv;
  varying float vAmount;
  varying vec3 vTint;

  void main() {
    float age = (uTime - aParam.x) * aParam.y;
    if (age < 0.0 || age >= 1.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      vUv = vec2(0.0); vAmount = 0.0; vTint = vec3(1.0);
      return;
    }
    vec3 wp = aCenter + aAxisU * (position.x * 2.0) + aAxisV * (position.y * 2.0);
    vec4 mvPosition = modelViewMatrix * vec4(wp, 1.0);

    float fade = 1.0 - smoothstep(0.55, 1.0, age);
    float depth = -mvPosition.z;
    float f = uFogDensity * depth;
    vAmount = aParam.w * fade * exp(-f * f);
    vUv = vec2((uv.x + aParam.z) * 0.5, uv.y * aUvV.x + aUvV.y);
    vTint = aTint;

    gl_Position = projectionMatrix * mvPosition;
  }
`;

const DECAL_FRAG = /* glsl */`
  precision highp float;

  uniform sampler2D uMap;
  varying vec2 vUv;
  varying float vAmount;
  varying vec3 vTint;

  void main() {
    float a = texture2D(uMap, vUv).a * vAmount;
    if (a < 0.004) discard;
    // multiplicative: rubber darkens whatever light the ground already has
    gl_FragColor = vec4(mix(vec3(1.0), vTint, a), 1.0);
  }
`;

// --------------------------------------------------------------------------- pools

/** Shared, reused spawn descriptor — emitting a particle allocates nothing. */
const P = {
  x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
  life: 1, size0: 0.2, size1: 0.4,
  r: 1, g: 1, b: 1, alpha: 1,
  drag: 1, gravity: 0, fadePow: 1, turb: 0, stretch: 0, rotRate: 0,
  tile: 0, heat: 0, soft: 1,
};

function quadGeometry() {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(
    [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
  return geo;
}

function instAttr(count, size) {
  const a = new THREE.InstancedBufferAttribute(new Float32Array(count * size), size);
  a.setUsage(THREE.DynamicDrawUsage);
  return a;
}

/**
 * GTAOPass renders the scene with a MeshNormalMaterial override to build its
 * G-buffer. Billboards have no meaningful normals and would punch huge opaque
 * occluders into the AO term, so we collapse the draw whenever the renderer
 * hands us a material that is not ours.
 */
function skipOverridePasses(mesh, geo, material) {
  let saved = 0;
  mesh.onBeforeRender = (renderer, scene, camera, geometry, mat) => {
    if (mat !== material) { saved = geo.instanceCount; geo.instanceCount = 0; }
  };
  mesh.onAfterRender = (renderer, scene, camera, geometry, mat) => {
    if (mat !== material) geo.instanceCount = saved;
  };
}

/** Upload only the slice of each attribute that was touched this frame. */
function flushAttrs(attrs, lo, span) {
  for (let i = 0; i < attrs.length; i++) {
    const attr = attrs[i];
    if (attr.clearUpdateRanges) {
      attr.clearUpdateRanges();
      attr.addUpdateRange(lo * attr.itemSize, span * attr.itemSize);
    }
    attr.needsUpdate = true;
  }
}

/**
 * One pooled particle system. `clock` is the shared FX clock object so both
 * systems and the decal buffer read the exact same time base.
 */
function createParticleSystem({ count, atlas, additive, lit, useFog, renderOrder, clock }) {
  const geo = quadGeometry();

  const aOrigin = instAttr(count, 3);
  const aVel = instAttr(count, 3);
  const aTime = instAttr(count, 4);
  const aSize = instAttr(count, 4);
  const aColor = instAttr(count, 4);
  const aPhys = instAttr(count, 4);
  const aExtra = instAttr(count, 2);
  geo.setAttribute('aOrigin', aOrigin);
  geo.setAttribute('aVel', aVel);
  geo.setAttribute('aTime', aTime);
  geo.setAttribute('aSize', aSize);
  geo.setAttribute('aColor', aColor);
  geo.setAttribute('aPhys', aPhys);
  geo.setAttribute('aExtra', aExtra);
  const attrs = [aOrigin, aVel, aTime, aSize, aColor, aPhys, aExtra];

  const origin = aOrigin.array, vel = aVel.array, tim = aTime.array;
  const siz = aSize.array, col = aColor.array, phy = aPhys.array, ext = aExtra.array;

  // Dead slots get a huge 1/life so the vertex shader clips them immediately.
  for (let i = 0; i < count; i++) tim[i * 4 + 1] = 1e9;

  const own = {
    uTime: { value: 0 },
    uMap: { value: atlas },
    uSunDir: { value: new THREE.Vector3(0.4, 0.55, -0.73) },
    uSunColor: { value: new THREE.Vector3(0.92, 0.78, 0.60) },
    uAmbient: { value: new THREE.Vector3(0.44, 0.48, 0.58) },
    uFogDensity: { value: additive ? 0.006 : 0.0 },
  };
  // scene.fog needs its uniforms present on the material before the renderer
  // refreshes them, so merge in UniformsLib.fog when this pass is fogged.
  const uniforms = useFog
    ? Object.assign(THREE.UniformsUtils.clone(THREE.UniformsLib.fog), own)
    : own;

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: PARTICLE_VERT,
    fragmentShader: PARTICLE_FRAG,
    defines: lit ? { LIT: '' } : {},
    transparent: true,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,   // billboards must survive any basis handedness
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    fog: !!useFog,
    toneMapped: false,       // the composer's OutputPass owns tone mapping
  });

  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.renderOrder = renderOrder;
  mesh.name = additive ? 'FXParticlesAdditive' : 'FXParticlesSoft';
  geo.instanceCount = 0;
  skipOverridePasses(mesh, geo, material);

  const free = new Int32Array(count);
  const live = new Int32Array(count);
  const dead = new Float32Array(count);
  for (let i = 0; i < count; i++) free[i] = count - 1 - i;
  let freeCount = count;
  let liveCount = 0;
  let dirtyLo = count, dirtyHi = -1;

  function spawn(p) {
    if (freeCount === 0) return false;
    const i = free[--freeCount];
    live[liveCount++] = i;
    const life = p.life > 0.016 ? p.life : 0.016;
    dead[i] = clock.t + life;

    let o = i * 3;
    origin[o] = p.x; origin[o + 1] = p.y; origin[o + 2] = p.z;
    vel[o] = p.vx; vel[o + 1] = p.vy; vel[o + 2] = p.vz;

    o = i * 4;
    tim[o] = clock.t; tim[o + 1] = 1 / life; tim[o + 2] = rng(); tim[o + 3] = p.tile;
    siz[o] = p.size0; siz[o + 1] = p.size1; siz[o + 2] = p.stretch; siz[o + 3] = p.rotRate;
    col[o] = p.r; col[o + 1] = p.g; col[o + 2] = p.b; col[o + 3] = p.alpha;
    phy[o] = p.drag; phy[o + 1] = p.gravity; phy[o + 2] = p.fadePow; phy[o + 3] = p.turb;

    o = i * 2;
    ext[o] = p.heat; ext[o + 1] = p.soft;

    if (i < dirtyLo) dirtyLo = i;
    if (i > dirtyHi) dirtyHi = i;
    return true;
  }

  function update() {
    const t = clock.t;
    let n = 0, hi = 0;
    for (let k = 0; k < liveCount; k++) {
      const i = live[k];
      if (dead[i] <= t) {
        free[freeCount++] = i;
      } else {
        live[n++] = i;
        if (i >= hi) hi = i + 1;
      }
    }
    liveCount = n;
    geo.instanceCount = hi;
    uniforms.uTime.value = t;

    if (dirtyHi >= dirtyLo) {
      flushAttrs(attrs, dirtyLo, dirtyHi - dirtyLo + 1);
      dirtyLo = count; dirtyHi = -1;
    }
  }

  return {
    mesh, material, uniforms, spawn, update,
    get liveCount() { return liveCount; },
    dispose() { geo.dispose(); material.dispose(); },
  };
}

/** Pooled ring buffer of ground stamps (tyre tread + skid smears). */
function createDecalBuffer({ atlas, clock, count = DECAL_POOL }) {
  const geo = quadGeometry();

  const aCenter = instAttr(count, 3);
  const aAxisU = instAttr(count, 3);
  const aAxisV = instAttr(count, 3);
  const aParam = instAttr(count, 4);
  const aUvV = instAttr(count, 2);
  const aTint = instAttr(count, 3);
  geo.setAttribute('aCenter', aCenter);
  geo.setAttribute('aAxisU', aAxisU);
  geo.setAttribute('aAxisV', aAxisV);
  geo.setAttribute('aParam', aParam);
  geo.setAttribute('aUvV', aUvV);
  geo.setAttribute('aTint', aTint);
  const attrs = [aCenter, aAxisU, aAxisV, aParam, aUvV, aTint];

  const cen = aCenter.array, axU = aAxisU.array, axV = aAxisV.array;
  const par = aParam.array, uvv = aUvV.array, tnt = aTint.array;
  for (let i = 0; i < count; i++) par[i * 4 + 1] = 1e9;

  const uniforms = {
    uTime: { value: 0 },
    uMap: { value: atlas },
    uFogDensity: { value: 0.006 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: DECAL_VERT,
    fragmentShader: DECAL_FRAG,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.CustomBlending,
    blendSrc: THREE.DstColorFactor,
    blendDst: THREE.ZeroFactor,
    blendEquation: THREE.AddEquation,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
    toneMapped: false,
  });

  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.renderOrder = 3;
  mesh.name = 'FXDecals';
  geo.instanceCount = 0;
  skipOverridePasses(mesh, geo, material);

  let cursor = 0, used = 0;
  let dirtyLo = count, dirtyHi = -1;

  /**
   * @param {THREE.Vector3} centre  midpoint of the stamp
   * @param {THREE.Vector3} normal  surface normal (unit)
   * @param {THREE.Vector3} along   travel direction (unit)
   */
  function stamp(centre, normal, along, halfLen, halfWidth, life, strength, tile, vOffset, tint) {
    const i = cursor;
    cursor = (cursor + 1) % count;
    if (used < count) used++;

    _u.copy(along).addScaledVector(normal, -along.dot(normal));
    if (_u.lengthSq() < 1e-8) {
      _u.set(1, 0, 0).addScaledVector(normal, -normal.x);
      if (_u.lengthSq() < 1e-8) _u.set(0, 0, 1);
    }
    _u.normalize();
    // u x normal keeps (aAxisU, aAxisV) facing along +normal, not into the ground
    _w.crossVectors(_u, normal).normalize();   // across the mark

    let o = i * 3;
    cen[o] = centre.x + normal.x * 0.016;
    cen[o + 1] = centre.y + normal.y * 0.016;
    cen[o + 2] = centre.z + normal.z * 0.016;
    axU[o] = _w.x * halfWidth; axU[o + 1] = _w.y * halfWidth; axU[o + 2] = _w.z * halfWidth;
    axV[o] = _u.x * halfLen; axV[o + 1] = _u.y * halfLen; axV[o + 2] = _u.z * halfLen;
    tnt[o] = tint[0]; tnt[o + 1] = tint[1]; tnt[o + 2] = tint[2];

    o = i * 4;
    par[o] = clock.t; par[o + 1] = 1 / life; par[o + 2] = tile; par[o + 3] = strength;

    o = i * 2;
    uvv[o] = (halfLen * 2) / DECAL_PERIOD; uvv[o + 1] = vOffset;

    if (i < dirtyLo) dirtyLo = i;
    if (i > dirtyHi) dirtyHi = i;
  }

  function update() {
    uniforms.uTime.value = clock.t;
    geo.instanceCount = used;
    if (dirtyHi >= dirtyLo) {
      flushAttrs(attrs, dirtyLo, dirtyHi - dirtyLo + 1);
      dirtyLo = count; dirtyHi = -1;
    }
  }

  function clear() {
    for (let i = 0; i < count; i++) par[i * 4 + 1] = 1e9;
    dirtyLo = 0; dirtyHi = count - 1;
    used = 0; cursor = 0;
  }

  return {
    mesh, material, uniforms, stamp, update, clear,
    dispose() { geo.dispose(); material.dispose(); },
  };
}

// --------------------------------------------------------------------------- scratch

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _u = new THREE.Vector3();
const _w = new THREE.Vector3();
const _dir = new THREE.Vector3();   // owned by impact(): never aliases a caller's vector
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _sun = new THREE.Vector3();
const _nrm = new THREE.Vector3(0, 1, 0);
const _lastStamp = new THREE.Vector3();
const _stampMid = new THREE.Vector3();

const RUBBER = [0.13, 0.125, 0.13];
const SCUFF = [0.30, 0.26, 0.22];

// --------------------------------------------------------------------------- system

export function createFX(ctx) {
  const scene = ctx.scene;
  const clock = { t: 0 };

  const atlas = makeParticleAtlas();
  const decalAtlas = makeDecalAtlas();

  const soft = createParticleSystem({
    count: SOFT_POOL, atlas, additive: false, lit: true, useFog: true,
    renderOrder: 10, clock,
  });
  const hot = createParticleSystem({
    count: HOT_POOL, atlas, additive: true, lit: false, useFog: false,
    renderOrder: 11, clock,
  });
  const decals = createDecalBuffer({ atlas: decalAtlas, clock });

  const group = new THREE.Group();
  group.name = 'FX';
  group.matrixAutoUpdate = false;
  group.add(decals.mesh, soft.mesh, hot.mesh);
  scene.add(group);

  // --- spark point lights ---------------------------------------------------
  // Kept permanently in the scene at zero intensity: toggling `visible` would
  // change the light count and force every material to recompile mid-run.
  const sparkLights = [];
  for (let i = 0; i < MAX_SPARK_LIGHTS; i++) {
    const light = new THREE.PointLight(0xffb070, 0, 4.5, 2);
    light.name = `FXSparkLight${i}`;
    light.castShadow = false;
    group.add(light);
    sparkLights.push({ light, until: 0, base: 0, phase: rng() * 10 });
  }
  let sparkLightCursor = 0;

  // --- grade / screen effects ----------------------------------------------
  const gu = ctx.engine?.passes?.gradePass?.uniforms ?? null;
  const baseGrade = gu ? {
    sat: gu.uSaturation.value,
    contrast: gu.uContrast.value,
    vignette: gu.uVignette.value,
    aberration: gu.uAberration.value,
    grain: gu.uGrain.value,
    lift: gu.uLift.value.clone(),
  } : null;
  let flashAmt = 0;      // white impact flash
  let desatAmt = 0;      // bail desaturation

  // --- crowd flashbulb positions -------------------------------------------
  const flashPoints = [];
  {
    const b = ctx.world?.park?.bounds;
    const cx = b ? (b.min.x + b.max.x) * 0.5 : 0;
    const cz = b ? (b.min.z + b.max.z) * 0.5 : 0;
    const rx = b ? Math.max(8, (b.max.x - b.min.x) * 0.46) : 26;
    const rz = b ? Math.max(8, (b.max.z - b.min.z) * 0.46) : 26;
    const y0 = b && Number.isFinite(b.min.y) ? b.min.y : 0;
    for (let i = 0; i < 44; i++) {
      const ang = (i / 44) * TAU + rand(-0.05, 0.05);
      const k = rand(0.86, 1.14);
      flashPoints.push(new THREE.Vector3(
        cx + Math.cos(ang) * rx * k,
        y0 + rand(1.2, 3.4),
        cz + Math.sin(ang) * rz * k,
      ));
    }
  }

  // --- emitter state --------------------------------------------------------
  const acc = { roll: 0, skid: 0, spark: 0, wind: 0, flash: 0, wall: 0, grindDust: 0 };
  let decalV = 0;              // running texture offset so stamps join seamlessly
  let stampValid = false;
  let flashUrgency = 0;        // crowd excitement, decays
  let emitState = null;        // physics state pointer, refreshed each frame

  const surfaceDust = (name) => SURFACE_DUST[name] || SURFACE_DUST.ground;
  const dustyPreset = (s) => (s.rate > 1.4 ? PRESETS.dirtDust : PRESETS.rollDust);

  /** Fill the shared descriptor from a preset and push it into a system. */
  function emitP(sys, pre, x, y, z, vx, vy, vz, scale, alphaScale, tint) {
    P.life = rand(pre.life[0], pre.life[1]);
    P.size0 = rand(pre.size[0], pre.size[1]) * scale;
    P.size1 = P.size0 * rand(pre.grow[0], pre.grow[1]);

    const pj = pre.posJitter * scale;
    if (pj > 0) {
      P.x = x + rand(-pj, pj); P.y = y + rand(-pj, pj); P.z = z + rand(-pj, pj);
    } else {
      P.x = x; P.y = y; P.z = z;
    }
    const vj = pre.velJitter;
    P.vx = vx + rand(-vj, vj); P.vy = vy + rand(-vj, vj); P.vz = vz + rand(-vj, vj);

    const c0 = tint || pre.color;
    const cj = 1 + rand(-pre.colorJitter, pre.colorJitter);
    if (pre.coolMix > 0) {
      const m = rng() * pre.coolMix;
      P.r = lerp(c0[0], COOL_TINT[0], m) * cj;
      P.g = lerp(c0[1], COOL_TINT[1], m) * cj;
      P.b = lerp(c0[2], COOL_TINT[2], m) * cj;
    } else {
      P.r = c0[0] * cj; P.g = c0[1] * cj; P.b = c0[2] * cj;
    }
    P.alpha = rand(pre.alpha[0], pre.alpha[1]) * alphaScale;

    P.drag = pre.drag; P.gravity = pre.gravity; P.fadePow = pre.fadePow;
    P.turb = pre.turb; P.stretch = pre.stretch;
    P.rotRate = pre.rot > 0 ? rand(-pre.rot, pre.rot) : 0;
    P.tile = pre.tile; P.heat = pre.heat; P.soft = pre.soft;
    return sys.spawn(P);
  }

  function addSparkLight(pos, duration, intensity) {
    const slot = sparkLights[sparkLightCursor % MAX_SPARK_LIGHTS];
    sparkLightCursor++;
    slot.light.position.copy(pos);
    slot.until = clock.t + duration;
    slot.base = intensity;
    slot.phase = rng() * 10;
  }

  // --------------------------------------------------------------- public FX

  /** Hot metal-on-concrete sparks. `dir` is the shed direction. */
  function spark(pos, dir, n = 12, power = 1) {
    const dx = dir?.x ?? 0, dy = dir?.y ?? 0.3, dz = dir?.z ?? 0;
    const count = Math.min(n | 0, 60);
    for (let i = 0; i < count; i++) {
      const s = rand(1.6, 5.4) * power;
      emitP(hot, PRESETS.spark, pos.x, pos.y, pos.z,
        dx * s + rand(-1.1, 1.1), dy * s + rand(0.4, 2.6), dz * s + rand(-1.1, 1.1), 1, 1);
    }
    const embers = Math.max(1, count >> 2);
    for (let i = 0; i < embers; i++) {
      emitP(hot, PRESETS.emberTrail, pos.x, pos.y, pos.z,
        dx * rand(0.4, 1.6) + rand(-0.5, 0.5),
        dy * rand(0.4, 1.6) + rand(0.2, 1.2),
        dz * rand(0.4, 1.6) + rand(-0.5, 0.5), 1, 1);
    }
    addSparkLight(pos, 0.09 + 0.05 * power, 5.0 * power);
  }

  /** Surface dust kicked up at a point. */
  function dust(pos, n = 8, surface = 'ground', vel = null, scale = 1) {
    const s = surfaceDust(surface);
    const pre = dustyPreset(s);
    const count = Math.min(n | 0, 40);
    const vx = vel?.x ?? 0, vy = vel?.y ?? 0, vz = vel?.z ?? 0;
    for (let i = 0; i < count; i++) {
      emitP(soft, pre, pos.x, pos.y, pos.z,
        vx * 0.25, vy * 0.15 + rand(0.1, 0.7), vz * 0.25, scale, 1, s.color);
    }
  }

  /** Soft dark tyre smoke. */
  function smoke(pos, n = 6, vel = null, scale = 1, alpha = 1) {
    const count = Math.min(n | 0, 40);
    const vx = vel?.x ?? 0, vy = vel?.y ?? 0, vz = vel?.z ?? 0;
    for (let i = 0; i < count; i++) {
      emitP(soft, PRESETS.skidSmoke, pos.x, pos.y, pos.z,
        vx * 0.3, vy * 0.3 + rand(0.15, 0.8), vz * 0.3, scale, alpha);
    }
  }

  /** Stone/plastic fragments — bail wreckage, smashed props. */
  function debris(pos, n = 14, vel = null, scale = 1) {
    const count = Math.min(n | 0, 48);
    const vx = vel?.x ?? 0, vy = vel?.y ?? 0, vz = vel?.z ?? 0;
    for (let i = 0; i < count; i++) {
      emitP(soft, PRESETS.debris, pos.x, pos.y + 0.1, pos.z,
        vx * 0.45 + rand(-1.4, 1.4), vy * 0.3 + rand(1.4, 4.6), vz * 0.45 + rand(-1.4, 1.4),
        scale, 1);
    }
  }

  /** Loose chips flicked off dirt/gravel. */
  function gravel(pos, n = 6, dirX = 0, dirZ = 0, power = 1) {
    const count = Math.min(n | 0, 24);
    for (let i = 0; i < count; i++) {
      emitP(soft, PRESETS.gravel, pos.x, pos.y + 0.03, pos.z,
        dirX * rand(0.5, 2.2) * power, rand(1.2, 3.8) * power, dirZ * rand(0.5, 2.2) * power, 1, 1);
    }
  }

  /** Landing / collision: puff, chips, shake and a short screen flash. */
  function impact(pos, strength = 1, surface = 'ground', normal = null) {
    const s = surfaceDust(surface);
    const k = clamp(strength, 0, 2);
    _nrm.set(normal?.x ?? 0, normal?.y ?? 1, normal?.z ?? 0);
    if (_nrm.lengthSq() < 1e-8) _nrm.set(0, 1, 0);
    const n = Math.round(6 + 14 * k);
    for (let i = 0; i < n; i++) {
      const ang = rng() * TAU;
      const r = rand(0.4, 1.0) * (1.6 + 2.4 * k);
      // radiate along the surface, with a little lift along the normal
      _dir.set(Math.cos(ang), 0, Math.sin(ang));
      _dir.addScaledVector(_nrm, -_dir.dot(_nrm));
      if (_dir.lengthSq() < 1e-6) continue;
      _dir.normalize();
      emitP(soft, PRESETS.landPuff,
        pos.x + _dir.x * 0.12, pos.y + 0.04, pos.z + _dir.z * 0.12,
        _dir.x * r, _nrm.y * rand(0.3, 1.3) * k + 0.2, _dir.z * r,
        0.85 + 0.6 * k, 0.8 + 0.5 * k, s.color);
    }
    if (s.rate > 1.4) gravel(pos, Math.round(3 + 7 * k), rand(-1, 1), rand(-1, 1), 0.7 + k);
    flashAmt = Math.min(0.55, flashAmt + 0.06 * k);
    shake(0.18 * k);
  }

  /** Crowd camera flash, somewhere on the spectator ring. */
  function flashbulb(index) {
    const p = flashPoints[Math.abs(index | 0) % flashPoints.length];
    emitP(hot, PRESETS.flash, p.x, p.y, p.z, 0, 0, 0, 1, 1);
    emitP(hot, PRESETS.flashGlow, p.x, p.y, p.z, 0, 0, 0, 1, 1);
  }

  // --------------------------------------------------------------- screen fx

  function shake(amount) { ctx.cameraRig?.addShake?.(amount); }
  function flash(amount) { flashAmt = clamp(flashAmt + amount, 0, 1); }
  function desaturate(amount) { desatAmt = clamp(desatAmt + amount, 0, 1); }

  // --------------------------------------------------------------- decals

  function stampTrail(pos, normal, dir, len, width, strength, tile, tint, life) {
    decalV += len / DECAL_PERIOD;
    if (decalV > 4096) decalV -= 4096;
    decals.stamp(pos, normal, dir, len * 0.5, width * 0.5, life, strength, tile, decalV, tint);
  }

  /** Public: drop a single mark (scripted events, smashables, debug). */
  function tyreMark(pos, normal, dir, opts = {}) {
    _nrm.copy(normal || _up.set(0, 1, 0));
    if (_nrm.lengthSq() < 1e-8) _nrm.set(0, 1, 0);
    _nrm.normalize();
    _c.copy(dir || _fwd.set(0, 0, 1));
    if (_c.lengthSq() < 1e-8) _c.set(0, 0, 1);
    _c.normalize();
    stampTrail(pos, _nrm, _c,
      opts.length ?? 0.5, opts.width ?? 0.14, opts.strength ?? 0.7,
      opts.skid ? DECAL_SKID : DECAL_TREAD, opts.tint || RUBBER, opts.life ?? 18);
  }

  // --------------------------------------------------------------- events

  function onLand(e) {
    const st = ctx.player?.physics?.state;
    if (!st) return;
    const d = e.detail || {};
    const amt = clamp((d.impact ?? d.speed ?? 4) / 9, 0.12, 1.6);
    _a.copy(st.position);
    const nrm = st.surfaceNormal ?? _up.set(0, 1, 0);
    impact(_a, amt, d.surface || st.surfaceType, nrm);
    // a scuff of rubber on touchdown
    _c.copy(st.velocity); _c.y = 0;
    if (_c.lengthSq() > 0.04) {
      _c.normalize();
      stampTrail(_a, nrm, _c, 0.55 + 0.5 * amt, 0.15,
        clamp(0.25 + 0.45 * amt, 0, 0.85), DECAL_SKID, RUBBER, 16);
    }
    stampValid = false;
    if ((d.quality ?? 0) > 0.7 || (d.airTime ?? 0) > 0.9) {
      flashUrgency = Math.min(3.2, flashUrgency + 1.4 + (d.airTime ?? 0));
    }
  }

  function onBail() {
    const st = ctx.player?.physics?.state;
    if (!st) return;
    _a.copy(st.position);
    _b.copy(st.velocity);
    debris(_a, 24, _b, 1.15);
    gravel(_a, 10, _b.x * 0.2, _b.z * 0.2, 1.2);
    dust(_a, 14, st.surfaceType, _b, 1.4);
    smoke(_a, 6, _b, 1.5, 0.7);
    _c.set(-_b.x, 0.4, -_b.z);
    if (_c.lengthSq() < 1e-6) _c.set(0, 1, 0);
    _c.normalize();
    spark(_a, _c, 10, 0.8);
    shake(0.95);
    flash(0.42);
    desaturate(1.0);
    flashUrgency = Math.min(3.5, flashUrgency + 2.0);
    _c.copy(st.velocity); _c.y = 0;
    if (_c.lengthSq() > 0.05) {
      _c.normalize();
      stampTrail(_a, st.surfaceNormal ?? _up.set(0, 1, 0), _c, 1.4, 0.24, 0.8, DECAL_SKID, RUBBER, 20);
    }
    stampValid = false;
  }

  function onHop(e) {
    const st = ctx.player?.physics?.state;
    if (!st) return;
    const power = clamp(e.detail?.power ?? 0.6, 0.1, 1.4);
    _fwd.set(0, 0, 1).applyQuaternion(st.quaternion);
    _a.copy(st.position).addScaledVector(_fwd, -HALF_WHEELBASE * 0.8);
    const s = surfaceDust(e.detail?.surface || st.surfaceType);
    const n = Math.round(3 + 6 * power * s.rate);
    for (let i = 0; i < n; i++) {
      const ang = rng() * TAU;
      emitP(soft, dustyPreset(s), _a.x, _a.y + 0.03, _a.z,
        Math.cos(ang) * rand(0.3, 1.5), rand(0.2, 0.9), Math.sin(ang) * rand(0.3, 1.5),
        0.85, 0.75 + 0.4 * power, s.color);
    }
    if (s.rate > 1.4) gravel(_a, 4, rand(-1, 1), rand(-1, 1), 0.8);
  }

  function onSkid(e) {
    const st = ctx.player?.physics?.state;
    if (!st) return;
    const amount = clamp(e.detail?.amount ?? 0.5, 0, 1);
    _fwd.set(0, 0, 1).applyQuaternion(st.quaternion);
    _a.copy(st.position).addScaledVector(_fwd, -HALF_WHEELBASE);
    _b.copy(st.velocity).multiplyScalar(-0.18);
    smoke(_a, Math.round(3 + 6 * amount), _b, 0.9 + 0.5 * amount, 0.8);
    stampValid = false;
  }

  function onWheelContact(e) {
    const st = ctx.player?.physics?.state;
    if (!st) return;
    const d = e.detail || {};
    const speed = clamp(d.speed ?? st.speed, 0, 20);
    if (speed < 1.6) return;
    _fwd.set(0, 0, 1).applyQuaternion(st.quaternion);
    _a.copy(st.position).addScaledVector(_fwd, d.wheel === 'front' ? HALF_WHEELBASE : -HALF_WHEELBASE);
    const s = surfaceDust(d.surface || st.surfaceType);
    const n = Math.round(clamp(speed * 0.35 * s.rate, 1, 8));
    for (let i = 0; i < n; i++) {
      emitP(soft, dustyPreset(s), _a.x, _a.y + 0.02, _a.z,
        _fwd.x * rand(-0.6, -0.1) * speed * 0.1, rand(0.15, 0.6),
        _fwd.z * rand(-0.6, -0.1) * speed * 0.1,
        0.8, 0.7, s.color);
    }
  }

  function onWallride(e) {
    const st = ctx.player?.physics?.state;
    if (!st) return;
    const d = e.detail || {};
    _b.set(d.nx ?? 0, d.ny ?? 0, d.nz ?? 1);
    if (_b.lengthSq() < 1e-6) _b.set(0, 0, 1);
    _b.normalize();
    const wp = st.wall?.point;
    _a.copy(wp && wp.lengthSq() > 0 ? wp : st.position);
    const speed = clamp(d.speed ?? st.speed, 0, 20);
    for (let i = 0; i < 8; i++) {
      emitP(soft, PRESETS.wallScuff, _a.x, _a.y, _a.z,
        _b.x * rand(0.4, 1.6), rand(0.1, 1.0), _b.z * rand(0.4, 1.6), 1, 0.9);
    }
    if (speed > 6) spark(_a, _b, 8, 0.6);
    shake(0.12);
  }

  function onGrindStart() {
    const st = ctx.player?.physics?.state;
    if (!st) return;
    grindContact(st, _a);
    _b.copy(st.velocity);
    if (_b.lengthSq() < 1e-6) _b.set(0, 0, 1);
    _b.normalize().multiplyScalar(-1);
    spark(_a, _b, 18, 1.2);
    shake(0.1);
  }

  function onRespawn() {
    stampValid = false;
    desatAmt = 0;
    flashAmt = 0;
  }

  const handlers = [
    ['land', onLand],
    ['bail', onBail],
    ['hop', onHop],
    ['skid', onSkid],
    ['wheelContact', onWheelContact],
    ['wallride', onWallride],
    ['grind', onGrindStart],
    ['grindStart', onGrindStart],
    ['respawn', onRespawn],
  ];
  for (let i = 0; i < handlers.length; i++) ctx.on?.(handlers[i][0], handlers[i][1]);

  // --------------------------------------------------------------- emitters

  /** Where the pegs meet the rail, roughly. */
  function grindContact(st, out) {
    const r = st.rail;
    if (r && r.point && typeof r.point.x === 'number') out.copy(r.point);
    else out.copy(st.position);
    _up.set(0, 1, 0).applyQuaternion(st.quaternion);
    out.addScaledVector(_up, -0.035);
    return out;
  }

  /** Rate-limited emission: `rate` particles per second, capped per frame. */
  function pump(key, rate, dt, cap, fn) {
    let n = acc[key] + rate * dt;
    let spawned = 0;
    while (n >= 1 && spawned < cap) { n -= 1; fn(); spawned++; }
    acc[key] = n > cap ? 0 : n;
  }

  function emitRollDust() {
    const st = emitState;
    const s = surfaceDust(st.surfaceType);
    _fwd.set(0, 0, 1).applyQuaternion(st.quaternion);
    _a.copy(st.position).addScaledVector(_fwd, -HALF_WHEELBASE);
    const sp = st.speed;
    emitP(soft, dustyPreset(s), _a.x, _a.y + 0.03, _a.z,
      -_fwd.x * sp * 0.13 + rand(-0.25, 0.25), rand(0.12, 0.55) + sp * 0.02,
      -_fwd.z * sp * 0.13 + rand(-0.25, 0.25),
      0.8 + sp * 0.03, clamp(0.25 + sp * 0.055, 0.2, 1.0), s.color);
  }

  function emitSkidSmoke() {
    const st = emitState;
    _fwd.set(0, 0, 1).applyQuaternion(st.quaternion);
    _a.copy(st.position).addScaledVector(_fwd, -HALF_WHEELBASE);
    const sp = st.speed;
    emitP(soft, PRESETS.skidSmoke, _a.x, _a.y + 0.05, _a.z,
      -_fwd.x * sp * 0.10 + rand(-0.3, 0.3), rand(0.25, 0.9),
      -_fwd.z * sp * 0.10 + rand(-0.3, 0.3),
      0.9 + sp * 0.035, clamp(0.4 + st.skid * 0.6, 0.3, 1.0));
    if (st.skid > 0.5 && rng() < 0.25) gravel(_a, 2, -_fwd.x, -_fwd.z, 0.5);
  }

  function emitGrindSpark() {
    const st = emitState;
    grindContact(st, _a);
    _fwd.set(0, 0, 1).applyQuaternion(st.quaternion);
    _right.set(1, 0, 0).applyQuaternion(st.quaternion);
    const sp = clamp(st.speed, 2, 18);
    const side = rng() < 0.5 ? -1 : 1;
    _c.copy(_fwd).multiplyScalar(-rand(0.35, 1.0) * sp * 0.32)
      .addScaledVector(_right, side * rand(0.3, 1.5));
    _c.y += rand(0.4, 2.2);
    emitP(hot, PRESETS.spark, _a.x + rand(-0.06, 0.06), _a.y, _a.z + rand(-0.06, 0.06),
      _c.x, _c.y, _c.z, 1, 1);
    if (rng() < 0.35) {
      emitP(hot, PRESETS.emberTrail, _a.x, _a.y, _a.z, _c.x * 0.4, _c.y * 0.4, _c.z * 0.4, 1, 1);
    }
  }

  function emitGrindDust() {
    const st = emitState;
    grindContact(st, _a);
    emitP(soft, PRESETS.rollDust, _a.x, _a.y - 0.02, _a.z,
      rand(-0.3, 0.3), rand(-0.1, 0.4), rand(-0.3, 0.3),
      0.55, 0.35, SURFACE_DUST.concrete.color);
  }

  function emitWallScuff() {
    const st = emitState;
    const wp = st.wall.point;
    _a.copy(wp && wp.lengthSq() > 0 ? wp : st.position);
    _b.copy(st.wall.normal);
    emitP(soft, PRESETS.wallScuff, _a.x, _a.y, _a.z,
      _b.x * rand(0.2, 1.0), rand(-0.2, 0.6), _b.z * rand(0.2, 1.0), 0.9, 0.7);
  }

  function emitSpeedLine() {
    const st = emitState;
    _b.copy(st.velocity);
    const sp = _b.length();
    if (sp < 1) return;
    _b.multiplyScalar(1 / sp);
    // ring around the travel axis, a few metres ahead of the camera
    _u.set(-_b.z, 0, _b.x);
    if (_u.lengthSq() < 1e-5) _u.set(1, 0, 0);
    _u.normalize();
    _w.crossVectors(_b, _u);
    const ang = rng() * TAU;
    const rad = rand(1.1, 3.4);
    _a.copy(ctx.camera.position)
      .addScaledVector(_b, rand(3.0, 9.0))
      .addScaledVector(_u, Math.cos(ang) * rad)
      .addScaledVector(_w, Math.sin(ang) * rad);
    emitP(hot, PRESETS.speedLine, _a.x, _a.y, _a.z,
      -_b.x * sp * 1.7, -_b.y * sp * 1.7, -_b.z * sp * 1.7, 1, clamp(sp * 0.06, 0.2, 1));
  }

  function emitFlashbulb() {
    flashbulb(Math.floor(rng() * flashPoints.length));
  }

  function updateEmitters(dt) {
    const st = ctx.player?.physics?.state;
    if (!st) return;
    emitState = st;
    const mode = st.mode;
    const sp = st.speed;
    const s = surfaceDust(st.surfaceType);

    // --- rolling dust ------------------------------------------------------
    if (st.grounded && mode !== 'grind' && mode !== 'bail' && sp > 2.4) {
      pump('roll', (sp - 2.0) * 4.5 * s.rate, dt, 8, emitRollDust);
    }

    // --- skid smoke --------------------------------------------------------
    if (st.grounded && st.skid > 0.08) {
      pump('skid', 16 + 42 * st.skid, dt, 8, emitSkidSmoke);
    }

    // --- grind sparks + contact light --------------------------------------
    if (mode === 'grind' && sp > 2.2) {
      pump('spark', 22 + sp * 5.5, dt, 10, emitGrindSpark);
      pump('grindDust', 6 + sp, dt, 4, emitGrindDust);
      grindContact(st, _a);
      addSparkLight(_a, 0.10, 3.2 + sp * 0.28);
    }

    // --- wallride scuff ----------------------------------------------------
    if (st.wall?.active) pump('wall', 10 + sp * 2.0, dt, 6, emitWallScuff);

    // --- wind speed lines --------------------------------------------------
    const wind = sp - (mode === 'air' ? 8.5 : 10.5);
    if (wind > 0) pump('wind', wind * 9, dt, 10, emitSpeedLine);

    // --- crowd flashbulbs --------------------------------------------------
    flashUrgency = Math.max(0, flashUrgency - dt * 0.8);
    pump('flash', 0.55 + flashUrgency * 2.6, dt, 4, emitFlashbulb);

    // --- persistent ground marks -------------------------------------------
    const laying = st.grounded && mode !== 'grind' && mode !== 'bail' &&
      (st.skid > 0.12 || (sp > 5 && Math.abs(st.lateralSpeed ?? 0) > 1.6));
    if (!laying) {
      stampValid = false;
      return;
    }
    if (!stampValid) {
      _lastStamp.copy(st.position);
      stampValid = true;
      return;
    }
    _a.copy(st.position).sub(_lastStamp);
    const len = _a.length();
    // ~0.3 m per stamp: the 128-quad ring then covers ~38 m of continuous mark
    if (len <= 0.30) return;
    if (len < 2.5) {
      _a.multiplyScalar(1 / len);
      _stampMid.copy(_lastStamp).addScaledVector(_a, len * 0.5);
      const skiddy = st.skid > 0.2;
      const strength = clamp(
        (skiddy ? 0.34 + st.skid * 0.38 : 0.24) * clamp(sp / 8, 0.35, 1.2), 0, 0.72);
      // exactly abutting quads: any overlap double-darkens under multiply blending
      stampTrail(_stampMid, st.surfaceNormal ?? _up.set(0, 1, 0), _a,
        len, skiddy ? 0.17 : 0.13, strength,
        skiddy ? DECAL_SKID : DECAL_TREAD,
        s.rate > 1.4 ? SCUFF : RUBBER, skiddy ? 20 : 14);
    }
    _lastStamp.copy(st.position);
  }

  // --------------------------------------------------------------- frame

  function updateLights() {
    for (let i = 0; i < sparkLights.length; i++) {
      const s = sparkLights[i];
      if (s.until <= clock.t) {
        if (s.light.intensity !== 0) s.light.intensity = 0;
        continue;
      }
      const k = clamp((s.until - clock.t) / 0.16, 0, 1);
      const flicker = 0.55 + 0.45 * Math.sin(clock.t * 61.0 + s.phase * 7.3)
        * Math.sin(clock.t * 37.0 + s.phase);
      s.light.intensity = s.base * k * flicker;
    }
  }

  function updateGrade(dt) {
    if (!gu) return;
    flashAmt = Math.max(0, flashAmt - dt * 3.6);
    desatAmt = Math.max(0, desatAmt - dt * 0.85);

    const d = desatAmt * desatAmt;
    const f = flashAmt * flashAmt;
    gu.uSaturation.value = baseGrade.sat * (1 - 0.78 * d);
    gu.uContrast.value = baseGrade.contrast * (1 + 0.10 * d);
    gu.uVignette.value = baseGrade.vignette + 0.26 * d;
    gu.uAberration.value = baseGrade.aberration * (1 + 3.4 * d + 2.0 * flashAmt);
    gu.uGrain.value = baseGrade.grain * (1 + 1.6 * d);
    gu.uLift.value.set(
      baseGrade.lift.x + f * 0.62,
      baseGrade.lift.y + f * 0.60,
      baseGrade.lift.z + f * 0.56,
    );
  }

  function updateLighting() {
    const sun = ctx.engine?.sunLight;
    if (sun) {
      _sun.copy(sun.position);
      if (sun.target) _sun.sub(sun.target.position);
      if (_sun.lengthSq() < 1e-6) _sun.set(0.4, 0.6, -0.7);
      _sun.normalize().transformDirection(ctx.camera.matrixWorldInverse);
      soft.uniforms.uSunDir.value.copy(_sun);
      const c = sun.color;
      const k = clamp(sun.intensity * 0.26, 0.20, 0.95);
      soft.uniforms.uSunColor.value.set(c.r * k, c.g * k, c.b * k);
    }
    const fog = ctx.scene.fog;
    if (fog) {
      if (fog.isFogExp2) {
        hot.uniforms.uFogDensity.value = fog.density * 0.85;
        decals.uniforms.uFogDensity.value = fog.density * 0.9;
      }
      soft.uniforms.uAmbient.value.set(
        0.30 + fog.color.r * 0.25,
        0.34 + fog.color.g * 0.25,
        0.42 + fog.color.b * 0.26,
      );
    }
  }

  let disposed = false;

  function update(dt) {
    if (disposed) return;
    // Pausing stops the clock so live particles hold their pose. `freeze` (the
    // screenshot harness) only stops the automatic emitters, so effects fired
    // by hand from the console still animate and expire normally.
    const paused = ctx.flags?.paused === true;
    const d = paused ? 0 : (dt > 0.1 ? 0.1 : (dt > 0 ? dt : 0));
    clock.t += d;

    if (!paused && !ctx.flags?.freeze) updateEmitters(d);

    updateLighting();
    updateLights();
    updateGrade(d);

    soft.update();
    hot.update();
    decals.update();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (let i = 0; i < handlers.length; i++) {
      ctx.events?.removeEventListener?.(handlers[i][0], handlers[i][1]);
    }
    if (gu && baseGrade) {
      gu.uSaturation.value = baseGrade.sat;
      gu.uContrast.value = baseGrade.contrast;
      gu.uVignette.value = baseGrade.vignette;
      gu.uAberration.value = baseGrade.aberration;
      gu.uGrain.value = baseGrade.grain;
      gu.uLift.value.copy(baseGrade.lift);
    }
    for (let i = 0; i < sparkLights.length; i++) {
      sparkLights[i].light.intensity = 0;
      group.remove(sparkLights[i].light);
    }
    scene.remove(group);
    soft.dispose();
    hot.dispose();
    decals.dispose();
    atlas.dispose();
    decalAtlas.dispose();
  }

  return {
    group,
    // --- contract ---
    spark, dust, smoke, impact, update, shake, dispose,
    // --- extended API ---
    debris, gravel, flashbulb, flash, desaturate, tyreMark,
    clearDecals: decals.clear,
    fixedUpdate() {},
    get counts() { return { soft: soft.liveCount, hot: hot.liveCount }; },
  };
}
