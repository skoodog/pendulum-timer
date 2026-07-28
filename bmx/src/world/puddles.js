// MIRRA CITY — wet ground and standing-water reflections.
//
// The reference frame's single strongest element is a soaked plaza: large
// irregular puddles that mirror the sky, the skyline and the floodlights, with
// darkened wet borders bleeding into the concrete around them. This module owns
// all of that.
//
// How it works
// ------------
// 1.  SURVEY. `ctx.world.collision.raycastDown` is fired on a coarse grid over
//     the park. Every sample records the top surface height, its normal and its
//     surface class. A cell is "poolable" only if it and its four neighbours are
//     genuinely flat (normal.y > 0.994, height agreement inside 5 cm) and are
//     ground, not wall. Ramp transitions, coping, deck lips and the sculpted
//     dirt jumps therefore fail the test and never hold water.
// 2.  FIELD. A low-frequency fbm field is baked into one RGBA texture covering
//     the survey region (world XZ -> uv). It is biased two ways that match how
//     water actually behaves on a slab: UP near the foot of a transition (a
//     chamfer distance transform of the poolable mask) and DOWN wherever a cell
//     sits above its local low point. The texture also carries the feathered
//     poolable mask and a high-frequency "drying patch" channel.
// 3.  MESH. One quad sheet is emitted over every poolable cell, split by water
//     level. Quads on the dominant level (the main slab) become a single
//     `Reflector` — ONE planar reflection shared by every puddle on that level.
//     Quads on other levels (bowl floor, decks, mini-ramp flat) become one
//     MeshPhysicalMaterial sheet lit by the scene's PMREM environment instead.
//     Two draw calls, ~10-20 k triangles, no per-puddle objects.
// 4.  SHADING. Both materials read the same field texture and resolve, per
//     pixel: standing water (mirror, roughness 0.06, albedo x ~0.22), a defined
//     dark rim, damp concrete (albedo x ~0.56, roughness ~0.5) and dry. The
//     composition is the real one for a thin film over concrete —
//     alpha = wetDark + (1 - wetDark) * mirror, rgb = reflection * mirror,
//     premultiplied — so the water removes exactly the diffuse it replaces.
//     Reflectance follows Schlick, biased to a 34% floor on open water because
//     the physical 2% at 45 degrees reads as tar. Grazing angles still mirror
//     hardest by a long way, which is what sells the reference frame.
//     Animated ripple gradients shimmer the reflection and carry the expanding
//     rings pushed in by splash().
//
// Cost control: ONE reflection render target (768x384 by default, half float, no
// MSAA), updated on at most every 3rd frame, skipped entirely when the camera
// has barely moved, when the reflector is off-screen, when no water is in range
// and whenever the scene is being drawn with an override material (GTAO's
// depth/normal prepass). Everything under 3 m across is culled out of the
// reflection pass, so the mirror costs a fraction of a scene pass. Steady state
// the whole system is 2 draw calls and ~25 k triangles.

import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { clamp, lerp, smoothstep, fbm2, valueNoise2 } from '../core/mathx.js';

// --- survey / bake resolution ---------------------------------------------
const SURVEY_STEP = 1.2;      // m between raycasts
const CELL = 0.8;             // m between puddle-sheet vertices
const FIELD_RES = 512;        // field texture is FIELD_RES^2 over the region
const REGION_HALF = 52;       // m — clamp the survey to the play area
const FLAT_DOT = 0.994;       // cos of the steepest slope that can hold water
const FLAT_DH = 0.05;         // m — height agreement with the four neighbours
const LEVEL_EPS = 0.06;       // m — how close a quad must be to the mirror plane
const WATER_LIFT = 0.012;     // m — water surface above the concrete
const MIN_POOL_AREA = 1.5;    // m^2 — smaller components are not counted as pools
const MAX_SPLASH = 6;         // concurrent ripple bursts

// The baked field is RANK-normalised over the poolable area, so its value is
// literally "fraction of the plaza that is drier than here". Thresholds are
// therefore coverage targets and are independent of the noise's own statistics
// (mathx's fbm2 lands in a narrow band around 0.25, so raw values are useless).
const THRESH_DRY = 0.945;     // wetness 0 -> ~5% of the flat area holds water
const THRESH_WET = 0.660;     // wetness 1 -> ~34% of the flat area holds water
const FEATHER = 0.120;        // rank units from shoreline to open water
const SHEEN_BAND = 0.620;     // rank units of damp film outside the shoreline

// ---------------------------------------------------------------------------
// Shared GLSL
// ---------------------------------------------------------------------------

// Height fog matched to environment.js' patched fog chunks. Duplicated rather
// than #included because these materials are premultiplied transparencies and
// the stock chunk would blend fog in at full coverage over a 20%-alpha pixel.
const FOG_GLSL = /* glsl */`
uniform vec3  uFogColor;
uniform float uFogDensity;
float bmxFogFactor( vec3 worldPos, vec3 eye ) {
  const float k = 0.062;
  float dy   = worldPos.y - eye.y;
  float a    = exp( -k * eye.y );
  float b    = exp( -k * worldPos.y );
  float att  = abs( dy ) > 0.02 ? ( a - b ) / ( k * dy ) : a;
  float dist = length( worldPos - eye ) * clamp( att, 0.0, 1.6 );
  return 1.0 - exp( -uFogDensity * uFogDensity * dist * dist );
}
`;

// Field decode + ripple integrator. Shared verbatim by both materials so the
// mirror sheet and the environment sheet agree pixel-for-pixel where they meet.
const FIELD_GLSL = /* glsl */`
uniform sampler2D uFieldTex;
uniform sampler2D uDetailTex;
uniform vec4  uRegion;        // minX, minZ, 1/width, 1/depth
uniform float uThreshold;
uniform float uFeather;
uniform float uWetness;
uniform float uTime;
uniform float uRippleAmp;
uniform vec4  uSplash[ ${MAX_SPLASH} ];   // x, z, age(s), strength

struct Wet {
  float mask;    // 0 dry .. 1 deep inside a puddle footprint
  float water;   // 0 damp .. 1 open standing water (mirror weight)
  float rim;     // dark shoreline band
  float sheen;   // broad damp film reaching outside the puddles
};

Wet bmxWetness( vec3 worldPos ) {
  vec2 fuv = ( worldPos.xz - uRegion.xy ) * uRegion.zw;
  vec4 F   = texture2D( uFieldTex, fuv );
  vec4 D   = texture2D( uDetailTex, worldPos.xz * 0.3413 );
  vec4 D2  = texture2D( uDetailTex, worldPos.xz * 0.0871 + vec2( 0.37, 0.11 ) );

  // Break the bilinear field up so the shoreline reads as organic, then carve
  // drying patches out of the shallow water with the blob channel.
  float field = F.r
    + ( D.r - 0.5 ) * 0.055
    + ( D2.g - 0.5 ) * 0.075
    - smoothstep( 0.62, 0.97, F.a ) * 0.090;

  float valid = smoothstep( 0.12, 0.55, F.g );

  Wet w;
  w.mask  = smoothstep( uThreshold, uThreshold + uFeather, field ) * valid;
  w.water = smoothstep( 0.26, 0.86, w.mask );
  // A defined dark ring sitting exactly on the shoreline.
  w.rim   = smoothstep( 0.05, 0.22, w.mask ) * ( 1.0 - smoothstep( 0.22, 0.55, w.mask ) );
  // Nothing flat is bone dry after rain: a broad film reaches out past the
  // shoreline and dies off well inside the sheet so no geometry edge shows.
  float broad = smoothstep( uThreshold - ${SHEEN_BAND.toFixed(3)}, uThreshold - 0.02, field ) * valid;
  w.sheen = max( w.mask, broad );
  return w;
}

// Surface gradient of the water: four crossed travelling waves plus any live
// splash rings, in metres of slope — ready to build a normal from.
vec2 bmxRipple( vec2 p, float water ) {
  float t = uTime;
  vec2 g = vec2( 0.0 );
  g += vec2(  0.86,  0.51 ) * sin( dot( p, vec2(  3.10,  1.73 ) ) + t * 1.55 );
  g += vec2( -0.48,  0.88 ) * sin( dot( p, vec2( -2.21,  2.94 ) ) + t * 1.17 );
  g += vec2(  0.31, -0.95 ) * sin( dot( p, vec2(  4.83, -3.37 ) ) + t * 2.31 );
  g += vec2(  0.70, -0.71 ) * sin( dot( p, vec2( -6.10, -5.20 ) ) + t * 3.05 ) * 0.45;
  g *= 0.0042 * uRippleAmp * mix( 1.35, 0.62, water );

  for ( int i = 0; i < ${MAX_SPLASH}; i++ ) {
    vec4 s = uSplash[ i ];
    if ( s.w > 0.001 ) {
      vec2  d = p - s.xy;
      float r = length( d ) + 1e-4;
      float radius = s.z * 2.35;
      float ring = exp( -abs( r - radius ) * 2.6 ) * exp( -s.z * 1.9 );
      g += ( d / r ) * cos( ( r - radius ) * 13.0 ) * ring * s.w * 0.055;
    }
  }
  return g;
}
`;

// ---------------------------------------------------------------------------
// Mirror shader (drives the shared Reflector)
// ---------------------------------------------------------------------------

const MirrorShader = {
  name: 'PuddleMirrorShader',
  uniforms: {
    color: { value: null },
    tDiffuse: { value: null },
    textureMatrix: { value: null },

    uFieldTex: { value: null },
    uDetailTex: { value: null },
    uRegion: { value: new THREE.Vector4() },
    uThreshold: { value: 0.6 },
    uFeather: { value: FEATHER },
    uWetness: { value: 1 },
    uTime: { value: 0 },
    uRippleAmp: { value: 1 },
    uSplash: { value: [] },

    uCamPos: { value: new THREE.Vector3() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color(1, 1, 1) },
    uSkyColor: { value: new THREE.Color(0.5, 0.6, 0.72) },
    uReflStrength: { value: 1 },
    uSpecGain: { value: 1 },
    uDebug: { value: 0 },
    uTexel: { value: new THREE.Vector2(1 / 768, 1 / 384) },

    uFogColor: { value: new THREE.Color(0.8, 0.8, 0.8) },
    uFogDensity: { value: 0.005 },
  },
  vertexShader: /* glsl */`
    uniform mat4 textureMatrix;
    varying vec4 vCoord;
    varying vec3 vWorld;
    void main() {
      vCoord = textureMatrix * vec4( position, 1.0 );
      vec4 wp = modelMatrix * vec4( position, 1.0 );
      vWorld = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `,
  fragmentShader: /* glsl */`
    uniform vec3 color;
    uniform sampler2D tDiffuse;
    uniform vec3 uCamPos, uSunDir;
    uniform vec3 uSunColor, uSkyColor;
    uniform float uReflStrength, uSpecGain, uDebug;
    uniform vec2 uTexel;
    varying vec4 vCoord;
    varying vec3 vWorld;

    ${FIELD_GLSL}
    ${FOG_GLSL}

    // Five-tap cross blur. The offset scale is the reflection's blur radius, so
    // choppy water and distant water go soft while a calm near puddle stays a
    // mirror. Five taps of a 768x384 texture is cheap even at full screen.
    vec3 sampleRefl( vec2 uv, float blur ) {
      vec2 o = uTexel * blur;
      vec3 c  = texture2D( tDiffuse, uv ).rgb * 0.36;
      c += texture2D( tDiffuse, uv + vec2(  o.x,  0.0 ) ).rgb * 0.16;
      c += texture2D( tDiffuse, uv + vec2( -o.x,  0.0 ) ).rgb * 0.16;
      c += texture2D( tDiffuse, uv + vec2(  0.0,  o.y ) ).rgb * 0.16;
      c += texture2D( tDiffuse, uv + vec2(  0.0, -o.y ) ).rgb * 0.16;
      return c;
    }

    void main() {
      Wet w = bmxWetness( vWorld );
      if ( uDebug > 3.5 ) {
        vec4 F = texture2D( uFieldTex, ( vWorld.xz - uRegion.xy ) * uRegion.zw );
        if ( uDebug < 4.5 ) gl_FragColor = vec4( F.r, F.g, F.a, 1.0 );
        else                gl_FragColor = vec4( w.sheen, w.mask, w.water, 1.0 );
        return;
      }
      if ( w.sheen <= 0.004 && uDebug < 0.5 ) discard;

      vec3 V = uCamPos - vWorld;
      float dist = length( V );
      V /= dist;

      vec2 grad = bmxRipple( vWorld.xz, w.water );
      vec3 N = normalize( vec3( -grad.x, 1.0, -grad.y ) );

      // Two reflectance curves. fresBase is close to Schlick for water and
      // drives the damp film and the sun glint. fresWater is the art-biased
      // curve for standing water: pure physics gives 2% at 45 degrees, which
      // reads as tar, so open water keeps a 22% floor and climbs faster. Both
      // still peak hard at grazing, which is what sells the reference frame.
      float cosT = clamp( dot( N, V ), 0.0, 1.0 );
      float fresBase  = mix( 0.03, 1.0, pow( 1.0 - cosT, 3.4 ) );
      float fresWater = mix( 0.34, 1.0, pow( 1.0 - cosT, 2.0 ) );
      float fres = fresBase;

      // Projected reflection UV, pushed around by the ripple slope.
      vec2 uv = vCoord.xy / max( vCoord.w, 1e-4 );
      uv += grad * ( 6.5 + dist * 0.16 );
      uv = clamp( uv, vec2( 0.002 ), vec2( 0.998 ) );

      float blur = mix( 6.0, 0.9, w.water ) + dist * 0.06;
      vec3 refl = sampleRefl( uv, blur ) * color;
      if ( uDebug > 0.5 ) {
        if ( uDebug < 1.5 )      gl_FragColor = vec4( refl, 1.0 );
        else if ( uDebug < 2.5 ) gl_FragColor = vec4( texture2D( tDiffuse, vec2( 0.5, 0.55 ) ).rgb, 1.0 );
        else                     gl_FragColor = vec4( uv, 0.0, 1.0 );
        return;
      }

      // ---- composition -----------------------------------------------------
      // A puddle is a thin dielectric film over concrete, so the frame is
      //     out = mirror * reflection + ( 1 - mirror ) * wetConcrete
      // and wetConcrete is the real concrete times the wetting factor. We only
      // ADD the reflection and REMOVE coverage, hence:
      //     alpha  = wetDark + ( 1 - wetDark ) * mirror
      //     rgb    = reflection * mirror        (premultiplied)
      // Getting this wrong in either direction reads as tar or as glass.
      float mirror = clamp( uReflStrength * (
          w.water * fresWater
        + ( w.mask - w.water ) * fresWater * 0.35
        + max( w.sheen - w.mask, 0.0 ) * fresBase * 0.18 ), 0.0, 1.0 );

      // Wetting: damp concrete is albedo x ~0.5, standing water x ~0.34 before
      // the mirror term is layered on top.
      float wetDark = w.sheen * mix( 0.44, 0.78, w.water ) * ( 0.45 + 0.55 * uWetness );
      wetDark += w.rim * 0.30 * uWetness;              // defined dark shoreline
      wetDark = clamp( wetDark, 0.0, 0.90 );

      float darken = clamp( wetDark + ( 1.0 - wetDark ) * mirror, 0.0, 0.985 );

      // Sharp sun glint riding the ripples — this is what makes it look alive.
      vec3 H = normalize( uSunDir + V );
      float spec = pow( max( dot( N, H ), 0.0 ), mix( 90.0, 700.0, w.water ) );
      vec3 glint = uSunColor * spec * uSpecGain * w.water * fres * 1.6;

      // Premultiplied: rgb is light we ADD, alpha is coverage we REMOVE.
      vec3 outCol = refl * mirror + glint + uSkyColor * wetDark * 0.05;

      float fog = bmxFogFactor( vWorld, uCamPos );
      outCol = mix( outCol, uFogColor * darken, fog );

      gl_FragColor = vec4( max( outCol, vec3( 0.0 ) ), darken );
    }
  `,
};

// ---------------------------------------------------------------------------
// Ground survey
// ---------------------------------------------------------------------------

function surveyGround(collision, region, log) {
  const { minX, minZ, maxX, maxZ } = region;
  const nx = Math.max(2, Math.round((maxX - minX) / SURVEY_STEP) + 1);
  const nz = Math.max(2, Math.round((maxZ - minZ) / SURVEY_STEP) + 1);
  const h = new Float32Array(nx * nz);
  const ok = new Uint8Array(nx * nz);
  const origin = new THREE.Vector3();
  const originY = 34;
  const maxDist = 120;

  const now = () => (typeof performance !== 'undefined' ? performance.now() : 0);
  const t0 = now();
  for (let j = 0; j < nz; j++) {
    const z = minZ + j * SURVEY_STEP;
    for (let i = 0; i < nx; i++) {
      const x = minX + i * SURVEY_STEP;
      origin.set(x, originY, z);
      const hit = collision.raycastDown(origin, maxDist);
      const k = j * nx + i;
      if (!hit) { h[k] = -999; continue; }
      h[k] = hit.point.y;
      ok[k] = (hit.normal.y > FLAT_DOT && hit.surface !== 'wall') ? 1 : 0;
    }
  }
  log.surveyMs = Math.round(now() - t0);
  log.surveySamples = nx * nz;

  // A cell only holds water if its neighbourhood is level too. This is what
  // keeps water off transition entries, coping lips and deck edges.
  const flat = new Uint8Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (!ok[k]) continue;
      let good = 1;
      for (let d = 0; d < 4; d++) {
        const ii = i + (d === 0 ? -1 : d === 1 ? 1 : 0);
        const jj = j + (d === 2 ? -1 : d === 3 ? 1 : 0);
        if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) { good = 0; break; }
        const kk = jj * nx + ii;
        if (!ok[kk] || Math.abs(h[kk] - h[k]) > FLAT_DH) { good = 0; break; }
      }
      flat[k] = good;
    }
  }

  // Chamfer distance (metres) from every flat cell to the nearest non-flat one
  // — water pools at the foot of the walls and transitions.
  const BIG = 1e6;
  const dist = new Float32Array(nx * nz);
  for (let k = 0; k < dist.length; k++) dist[k] = flat[k] ? BIG : 0;
  const dO = SURVEY_STEP, dD = SURVEY_STEP * Math.SQRT2;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      let v = dist[k];
      if (i > 0) v = Math.min(v, dist[k - 1] + dO);
      if (j > 0) v = Math.min(v, dist[k - nx] + dO);
      if (i > 0 && j > 0) v = Math.min(v, dist[k - nx - 1] + dD);
      if (i < nx - 1 && j > 0) v = Math.min(v, dist[k - nx + 1] + dD);
      dist[k] = v;
    }
  }
  for (let j = nz - 1; j >= 0; j--) {
    for (let i = nx - 1; i >= 0; i--) {
      const k = j * nx + i;
      let v = dist[k];
      if (i < nx - 1) v = Math.min(v, dist[k + 1] + dO);
      if (j < nz - 1) v = Math.min(v, dist[k + nx] + dO);
      if (i < nx - 1 && j < nz - 1) v = Math.min(v, dist[k + nx + 1] + dD);
      if (i > 0 && j < nz - 1) v = Math.min(v, dist[k + nx - 1] + dD);
      dist[k] = v;
    }
  }

  // How far each flat cell sits above the lowest flat point within ~6 m.
  const R = 5;
  const drop = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (!flat[k]) { drop[k] = 2; continue; }
      let lo = h[k];
      const j0 = Math.max(0, j - R), j1 = Math.min(nz - 1, j + R);
      const i0 = Math.max(0, i - R), i1 = Math.min(nx - 1, i + R);
      for (let jj = j0; jj <= j1; jj++) {
        for (let ii = i0; ii <= i1; ii++) {
          const kk = jj * nx + ii;
          if (flat[kk] && h[kk] < lo) lo = h[kk];
        }
      }
      drop[k] = h[k] - lo;
    }
  }

  return { nx, nz, h, flat, dist, drop };
}

/** Bilinear sample of a survey channel at world XZ. */
function sampleGrid(g, arr, x, z, region, fallback = 0) {
  const fx = (x - region.minX) / SURVEY_STEP;
  const fz = (z - region.minZ) / SURVEY_STEP;
  const i0 = Math.floor(fx), j0 = Math.floor(fz);
  const tx = fx - i0, tz = fz - j0;
  const i1 = i0 + 1, j1 = j0 + 1;
  if (i0 < 0 || j0 < 0 || i1 >= g.nx || j1 >= g.nz) return fallback;
  const a = arr[j0 * g.nx + i0], b = arr[j0 * g.nx + i1];
  const c = arr[j1 * g.nx + i0], d = arr[j1 * g.nx + i1];
  return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
}

/** Nearest flat cell's height — used to seat sheet vertices on real ground. */
function sampleHeight(g, x, z, region) {
  const fx = clamp((x - region.minX) / SURVEY_STEP, 0, g.nx - 1);
  const fz = clamp((z - region.minZ) / SURVEY_STEP, 0, g.nz - 1);
  const i = Math.round(fx), j = Math.round(fz);
  const k = j * g.nx + i;
  if (g.flat[k]) return g.h[k];
  for (let r = 1; r <= 2; r++) {
    for (let jj = j - r; jj <= j + r; jj++) {
      for (let ii = i - r; ii <= i + r; ii++) {
        if (ii < 0 || jj < 0 || ii >= g.nx || jj >= g.nz) continue;
        const kk = jj * g.nx + ii;
        if (g.flat[kk]) return g.h[kk];
      }
    }
  }
  return NaN;
}

// ---------------------------------------------------------------------------
// Field bake
// ---------------------------------------------------------------------------

/** Stretch a channel to fill 0..1 using its own 1st/99th percentile. */
function normalise(arr, out, lo = 0.01, hi = 0.99) {
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < arr.length; i++) { if (arr[i] < mn) mn = arr[i]; if (arr[i] > mx) mx = arr[i]; }
  if (!(mx > mn)) { out.fill(0.5); return; }
  const B = 512;
  const hist = new Uint32Array(B);
  const s = B / (mx - mn);
  for (let i = 0; i < arr.length; i++) hist[Math.min(B - 1, ((arr[i] - mn) * s) | 0)]++;
  let acc = 0, loV = mn, hiV = mx;
  const nLo = arr.length * lo, nHi = arr.length * hi;
  let gotLo = false;
  for (let b = 0; b < B; b++) {
    acc += hist[b];
    if (!gotLo && acc >= nLo) { loV = mn + (b / B) * (mx - mn); gotLo = true; }
    if (acc >= nHi) { hiV = mn + ((b + 1) / B) * (mx - mn); break; }
  }
  const inv = 1 / Math.max(1e-6, hiV - loV);
  for (let i = 0; i < arr.length; i++) out[i] = clamp((arr[i] - loV) * inv, 0, 1);
}

/**
 * Rank-normalise `arr` over the texels where `weight > 0.5`, so the result is
 * uniform on [0,1] and a threshold reads directly as "fraction left dry".
 */
function rankNormalise(arr, weight, out) {
  let mn = Infinity, mx = -Infinity, n = 0;
  for (let i = 0; i < arr.length; i++) {
    if (weight[i] <= 0.5) continue;
    n++;
    if (arr[i] < mn) mn = arr[i];
    if (arr[i] > mx) mx = arr[i];
  }
  if (n < 16 || !(mx > mn)) { normalise(arr, out); return; }
  const B = 2048;
  const hist = new Uint32Array(B);
  const s = (B - 1) / (mx - mn);
  for (let i = 0; i < arr.length; i++) {
    if (weight[i] <= 0.5) continue;
    hist[Math.round((arr[i] - mn) * s)]++;
  }
  const cdf = new Float32Array(B);
  let acc = 0;
  for (let b = 0; b < B; b++) { acc += hist[b]; cdf[b] = acc / n; }
  for (let i = 0; i < arr.length; i++) {
    const t = clamp((arr[i] - mn) * s, 0, B - 1);
    const b0 = t | 0, b1 = Math.min(B - 1, b0 + 1);
    out[i] = lerp(cdf[b0], cdf[b1], t - b0);
  }
}

function bakeField(g, region) {
  const N = FIELD_RES;
  const T = N * N;
  const raw = new Float32Array(T);
  const validity = new Float32Array(T);
  const dryRaw = new Float32Array(T);
  const detRaw = new Float32Array(T);
  const w = region.maxX - region.minX;
  const d = region.maxZ - region.minZ;

  for (let j = 0; j < N; j++) {
    const z = region.minZ + ((j + 0.5) / N) * d;
    for (let i = 0; i < N; i++) {
      const x = region.minX + ((i + 0.5) / N) * w;
      const k = j * N + i;

      // Two scales of blob: ~20 m pools broken up by ~7 m lobes.
      const big = fbm2(x * 0.0475 + 31.7, z * 0.0475 + 12.9, 3);
      const mid = fbm2(x * 0.1430 + 77.1, z * 0.1430 + 3.30, 3);
      let field = big * 0.62 + mid * 0.38;

      // Pool against transitions: peaks 1.5-4 m out from the flat/not-flat edge.
      const dd = sampleGrid(g, g.dist, x, z, region, 0);
      const edge = smoothstep(clamp(dd / 1.6, 0, 1)) * (1 - smoothstep(clamp((dd - 2.0) / 6.5, 0, 1)));
      field += edge * 0.055;

      // Drain off high ground (values are in metres above the local low point).
      const drop = sampleGrid(g, g.drop, x, z, region, 2);
      field -= clamp(drop * 0.30, 0, 0.12);

      raw[k] = field;
      validity[k] = clamp(sampleGrid(g, g.flat, x, z, region, 0), 0, 1);
      dryRaw[k] = fbm2(x * 0.395 + 5.1, z * 0.395 + 9.7, 3);
      detRaw[k] = fbm2(x * 0.86 + 61.3, z * 0.86 + 44.9, 2);
    }
  }

  const fieldN = new Float32Array(T);
  const dryN = new Float32Array(T);
  const detN = new Float32Array(T);
  rankNormalise(raw, validity, fieldN);
  normalise(dryRaw, dryN);
  normalise(detRaw, detN);

  const data = new Uint8Array(T * 4);
  for (let k = 0; k < T; k++) {
    data[k * 4] = fieldN[k] * 255;
    data[k * 4 + 1] = validity[k] * 255;
    data[k * 4 + 2] = detN[k] * 255;
    data[k * 4 + 3] = dryN[k] * 255;
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.LinearFilter;
  // NO MIPMAPS, deliberately. A ground plane seen at a grazing angle has a huge
  // uv derivative, so a mipped mask collapses to its global average about ten
  // metres out — the puddles fade away exactly where the reference frame shows
  // them best, and the poolable mask drops under its own threshold and discards
  // the whole sheet. Unfiltered minification shimmers slightly instead, which
  // the ripple normals and the distance blur already hide.
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return { tex, data };
}

/** Small tiling noise: shoreline breakup (R), drying blobs (G). */
function bakeDetail() {
  const N = 128;
  const T = N * N;
  const a = new Float32Array(T), b = new Float32Array(T), c = new Float32Array(T);
  const S = 6;
  for (let j = 0; j < N; j++) {
    const v = j / N;
    for (let i = 0; i < N; i++) {
      const u = i / N;
      const k = j * N + i;
      // Seamless fbm: blend the four wrapped lookups of the tile.
      const f = (ox, oy) => fbm2(u * S + ox, v * S + oy, 3);
      a[k] = lerp(lerp(f(0, 0), f(S, 0), u), lerp(f(0, S), f(S, S), u), v);
      b[k] = lerp(lerp(fbm2(u * 3 + 40, v * 3 + 70, 2), fbm2(u * 3 + 43, v * 3 + 70, 2), u),
        lerp(fbm2(u * 3 + 40, v * 3 + 73, 2), fbm2(u * 3 + 43, v * 3 + 73, 2), u), v);
      c[k] = valueNoise2(u * 12 + 3, v * 12 + 8);
    }
  }
  const an = new Float32Array(T), bn = new Float32Array(T), cn = new Float32Array(T);
  normalise(a, an); normalise(b, bn); normalise(c, cn);
  const data = new Uint8Array(T * 4);
  for (let k = 0; k < T; k++) {
    data[k * 4] = an[k] * 255;
    data[k * 4 + 1] = bn[k] * 255;
    data[k * 4 + 2] = cn[k] * 255;
    data[k * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Bilinear read of a baked field channel at world XZ (CPU side). */
function fieldAt(field, region, x, z, channel) {
  const N = FIELD_RES;
  const fx = ((x - region.minX) / (region.maxX - region.minX)) * N - 0.5;
  const fz = ((z - region.minZ) / (region.maxZ - region.minZ)) * N - 0.5;
  const i0 = clamp(Math.floor(fx), 0, N - 1);
  const j0 = clamp(Math.floor(fz), 0, N - 1);
  const i1 = clamp(i0 + 1, 0, N - 1);
  const j1 = clamp(j0 + 1, 0, N - 1);
  const tx = clamp(fx - i0, 0, 1), tz = clamp(fz - j0, 0, 1);
  const a = field.data[(j0 * N + i0) * 4 + channel];
  const b = field.data[(j0 * N + i1) * 4 + channel];
  const c = field.data[(j1 * N + i0) * 4 + channel];
  const d = field.data[(j1 * N + i1) * 4 + channel];
  return lerp(lerp(a, b, tx), lerp(c, d, tx), tz) / 255;
}

// ---------------------------------------------------------------------------
// Pool statistics (connected components of the standing-water mask)
// ---------------------------------------------------------------------------

function findPools(field, region, nx, nz) {
  const mask = new Uint8Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    const z = region.minZ + j * CELL;
    for (let i = 0; i < nx; i++) {
      const x = region.minX + i * CELL;
      if (fieldAt(field, region, x, z, 1) < 0.5) continue;
      if (fieldAt(field, region, x, z, 0) < THRESH_WET) continue;
      mask[j * nx + i] = 1;
    }
  }
  const label = new Int32Array(nx * nz).fill(-1);
  const pools = [];
  const stack = [];
  const cellArea = CELL * CELL;
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || label[s] >= 0) continue;
    const id = pools.length;
    let count = 0;
    let sx = 0, sz = 0;
    stack.length = 0;
    stack.push(s);
    label[s] = id;
    while (stack.length) {
      const k = stack.pop();
      count++;
      const i = k % nx, j = (k - i) / nx;
      sx += region.minX + i * CELL;
      sz += region.minZ + j * CELL;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue;
          const kk = jj * nx + ii;
          if (mask[kk] && label[kk] < 0) { label[kk] = id; stack.push(kk); }
        }
      }
    }
    pools.push({ area: count * cellArea, x: sx / count, z: sz / count });
  }
  return pools.filter((p) => p.area >= MIN_POOL_AREA).sort((a, b) => b.area - a.area);
}

// ---------------------------------------------------------------------------
// Sheet build
// ---------------------------------------------------------------------------

/**
 * Emit two vertex sets: quads that sit on the dominant water level (the mirror,
 * authored in the local XY plane because Reflector's plane normal is local +Z)
 * and everything else (world space, environment-reflected).
 */
function buildSheets(g, field, region, nx, nz, level) {
  const mk = () => ({ pos: [], idx: [], map: new Map() });
  const mirror = mk();
  const other = mk();

  const cw = nx + 1;
  const cornerH = new Float32Array(cw * (nz + 1));
  const cornerOk = new Uint8Array(cw * (nz + 1));
  for (let j = 0; j <= nz; j++) {
    const z = region.minZ + (j - 0.5) * CELL;
    for (let i = 0; i <= nx; i++) {
      const x = region.minX + (i - 0.5) * CELL;
      const y = sampleHeight(g, x, z, region);
      const k = j * cw + i;
      if (Number.isNaN(y)) { cornerOk[k] = 0; cornerH[k] = level; } else { cornerOk[k] = 1; cornerH[k] = y; }
    }
  }

  const vert = (set, i, j, flat) => {
    const key = j * cw + i;
    let v = set.map.get(key);
    if (v !== undefined) return v;
    const x = region.minX + (i - 0.5) * CELL;
    const z = region.minZ + (j - 0.5) * CELL;
    v = set.pos.length / 3;
    if (flat) set.pos.push(x, -z, 0);                     // local XY plane
    else set.pos.push(x, cornerH[key] + WATER_LIFT, z);   // world space
    set.map.set(key, v);
    return v;
  };

  let mirrorQuads = 0, otherQuads = 0;
  for (let j = 0; j < nz; j++) {
    const zc = region.minZ + j * CELL;
    for (let i = 0; i < nx; i++) {
      const xc = region.minX + i * CELL;
      // Emit wherever the ground can be damp at all; the shader's `valid`
      // smoothstep starts higher, so the film always dies inside the sheet.
      if (fieldAt(field, region, xc, zc, 1) < 0.06) continue;
      const k00 = j * cw + i, k10 = k00 + 1;
      const k01 = k00 + cw, k11 = k01 + 1;
      if (!cornerOk[k00] || !cornerOk[k10] || !cornerOk[k01] || !cornerOk[k11]) continue;
      let lo = cornerH[k00], hi = lo;
      for (const kk of [k10, k01, k11]) {
        if (cornerH[kk] < lo) lo = cornerH[kk];
        if (cornerH[kk] > hi) hi = cornerH[kk];
      }
      if (hi - lo > FLAT_DH) continue;                    // straddles a step
      const isMirror = Math.abs((lo + hi) * 0.5 - level) <= LEVEL_EPS;
      const set = isMirror ? mirror : other;
      const a = vert(set, i, j, isMirror);
      const b = vert(set, i + 1, j, isMirror);
      const c = vert(set, i + 1, j + 1, isMirror);
      const d = vert(set, i, j + 1, isMirror);
      // Both parametrisations need the same winding to face up.
      set.idx.push(a, c, b, a, d, c);
      if (isMirror) mirrorQuads++; else otherQuads++;
    }
  }

  // Both sheets MUST carry a normal attribute even though neither material
  // uses it for lighting: the GTAO pass re-renders the whole scene with an
  // override material, and a missing `normal` makes normalize(vec3(0)) produce
  // NaN in the AO normal buffer — which multiplies the beauty frame to black
  // over exactly the puddle footprint. Local up is +Z on the mirror sheet
  // (it is authored in XY and rotated flat) and +Y on the world-space sheet.
  const toGeo = (set, axis) => {
    if (!set.idx.length) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(set.pos, 3));
    const n = new Float32Array(set.pos.length);
    for (let i = axis; i < n.length; i += 3) n[i] = 1;
    geo.setAttribute('normal', new THREE.BufferAttribute(n, 3));
    geo.setIndex(set.idx);
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    return geo;
  };

  return { mirrorGeo: toGeo(mirror, 2), otherGeo: toGeo(other, 1), mirrorQuads, otherQuads };
}

// ---------------------------------------------------------------------------
// Environment-reflected sheet (everything not on the mirror plane)
// ---------------------------------------------------------------------------

function makeWetMaterial(shared) {
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0x05070a,
    roughness: 0.08,
    metalness: 0,
    transparent: true,
    depthWrite: false,
    envMapIntensity: 2.6,
    side: THREE.FrontSide,
    fog: true,
  });
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = -3;
  mat.polygonOffsetUnits = -3;

  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, shared);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vPuddleWorld;')
      .replace('#include <begin_vertex>',
        '#include <begin_vertex>\nvPuddleWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');

    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vPuddleWorld;\n${FIELD_GLSL}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        {
          Wet w1 = bmxWetness( vPuddleWorld );
          if ( w1.sheen <= 0.004 ) discard;
          roughnessFactor = mix( 0.52, 0.06, w1.water );
          float darken = w1.sheen * mix( 0.44, 0.78, w1.water ) * ( 0.45 + 0.55 * uWetness );
          darken += w1.rim * 0.30 * uWetness;
          diffuseColor.a = clamp( darken, 0.0, 0.86 );
        }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          Wet w0 = bmxWetness( vPuddleWorld );
          vec2 g0 = bmxRipple( vPuddleWorld.xz, w0.water );
          vec3 wn = normalize( vec3( -g0.x, 1.0, -g0.y ) );
          normal = normalize( mix( normal, normalize( ( viewMatrix * vec4( wn, 0.0 ) ).xyz ), 0.92 ) );
        }`);
  };
  // Force a private program so the injected chunks never leak into the
  // material library's other physical materials.
  mat.customProgramCacheKey = () => 'bmx-puddle-wet';
  return mat;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const _scale = new THREE.Vector3();

export function createPuddles(ctx) {
  const group = new THREE.Group();
  group.name = 'puddles';
  group.matrixAutoUpdate = false;

  const collision = ctx?.world?.collision;
  const scene = ctx?.scene;
  const renderer = ctx?.renderer;
  if (!collision || !scene || !renderer) return stub(group);

  const log = {};
  const pb = ctx.world?.park?.bounds;
  const region = {
    minX: Math.max(pb ? pb.min.x : -REGION_HALF, -REGION_HALF),
    maxX: Math.min(pb ? pb.max.x : REGION_HALF, REGION_HALF),
    minZ: Math.max(pb ? pb.min.z : -REGION_HALF, -REGION_HALF),
    maxZ: Math.min(pb ? pb.max.z : REGION_HALF, REGION_HALF),
  };
  if (region.maxX - region.minX < 8 || region.maxZ - region.minZ < 8) return stub(group);

  const survey = surveyGround(collision, region, log);

  // Dominant water level = the modal height of the poolable cells. Everything
  // within LEVEL_EPS of it shares the one planar reflection.
  const bins = new Map();
  for (let k = 0; k < survey.flat.length; k++) {
    if (!survey.flat[k]) continue;
    const b = Math.round(survey.h[k] / 0.1);
    bins.set(b, (bins.get(b) || 0) + 1);
  }
  if (!bins.size) return stub(group);
  let bestBin = 0, bestCount = -1;
  for (const [b, c] of bins) if (c > bestCount) { bestCount = c; bestBin = b; }
  const level = bestBin * 0.1;

  const field = bakeField(survey, region);
  const detailTex = bakeDetail();

  const nx = Math.max(1, Math.floor((region.maxX - region.minX) / CELL));
  const nz = Math.max(1, Math.floor((region.maxZ - region.minZ) / CELL));
  const pools = findPools(field, region, nx, nz);
  const { mirrorGeo, otherGeo, mirrorQuads, otherQuads } =
    buildSheets(survey, field, region, nx, nz, level);

  if (!mirrorGeo && !otherGeo) {
    field.tex.dispose(); detailTex.dispose();
    return stub(group);
  }

  // --- shared uniforms -----------------------------------------------------
  const splashes = [];
  for (let i = 0; i < MAX_SPLASH; i++) splashes.push(new THREE.Vector4(0, 0, 0, 0));

  const shared = {
    uFieldTex: { value: field.tex },
    uDetailTex: { value: detailTex },
    uRegion: {
      value: new THREE.Vector4(region.minX, region.minZ,
        1 / (region.maxX - region.minX), 1 / (region.maxZ - region.minZ)),
    },
    uThreshold: { value: THRESH_WET },
    uFeather: { value: FEATHER },
    uWetness: { value: 1 },
    uTime: { value: 0 },
    uRippleAmp: { value: 1 },
    uSplash: { value: splashes },
    uFogColor: { value: new THREE.Color(0.8, 0.8, 0.8) },
    uFogDensity: { value: 0.005 },
  };

  // --- the mirror ----------------------------------------------------------
  const tier = ctx.engine?.tier?.name || 'high';
  const RT_W = tier === 'low' ? 384 : tier === 'medium' ? 512 : 768;
  const RT_H = Math.round(RT_W * 0.5);
  // Every 3rd frame at 60 fps is 20 Hz of reflection. Nothing in a rippled
  // puddle reads at 20 Hz, and it keeps the peak-frame draw calls in budget.
  const REFLECT_EVERY = (tier === 'ultra') ? 2 : (tier === 'high') ? 3 : 4;

  let reflector = null;
  if (mirrorGeo) {
    reflector = new Reflector(mirrorGeo, {
      shader: MirrorShader,
      textureWidth: RT_W,
      textureHeight: RT_H,
      clipBias: 0.0035,
      multisample: 0,
      color: 0xd2d8df,   // water loses ~30% into the film; a white mirror reads as snow
    });
    reflector.name = 'puddle_mirror';
    reflector.rotation.x = -Math.PI / 2;
    reflector.position.y = level + WATER_LIFT;
    reflector.renderOrder = 3;
    reflector.castShadow = false;
    reflector.receiveShadow = false;
    reflector.userData.__puddle = true;
    reflector.updateMatrix();
    reflector.updateMatrixWorld(true);

    const u = reflector.material.uniforms;
    for (const key in shared) u[key] = shared[key];
    u.uTexel.value.set(1 / RT_W, 1 / RT_H);

    const m = reflector.material;
    m.transparent = true;
    m.premultipliedAlpha = true;
    m.depthWrite = false;
    m.depthTest = true;
    m.side = THREE.FrontSide;
    m.toneMapped = false;
    m.polygonOffset = true;
    m.polygonOffsetFactor = -3;
    m.polygonOffsetUnits = -3;
    group.add(reflector);
  }

  // --- the environment sheet ----------------------------------------------
  let wetMesh = null;
  let wetMaterial = null;
  if (otherGeo) {
    wetMaterial = makeWetMaterial(shared);
    wetMesh = new THREE.Mesh(otherGeo, wetMaterial);
    wetMesh.name = 'puddle_wet';
    wetMesh.renderOrder = 3;
    wetMesh.castShadow = false;
    wetMesh.receiveShadow = false;
    wetMesh.matrixAutoUpdate = false;
    wetMesh.userData.__puddle = true;
    wetMesh.updateMatrix();
    group.add(wetMesh);
  }

  // --- reflection scheduling ----------------------------------------------
  const cullHidden = [];
  let cullListBuilt = false;
  const _lastPos = new THREE.Vector3(1e9, 1e9, 1e9);
  const _lastQuat = new THREE.Quaternion(2, 0, 0, 0);
  let sinceReflect = 99;
  let reflectFrames = 0;
  let reflectEnabled = true;
  const mirrorCentre = new THREE.Vector3();
  let mirrorRadius = 0;
  if (mirrorGeo?.boundingSphere) {
    mirrorCentre.set(mirrorGeo.boundingSphere.center.x, level, -mirrorGeo.boundingSphere.center.y);
    mirrorRadius = mirrorGeo.boundingSphere.radius;
  }

  // Used when the environment has not published a PMREM yet.
  const skyFallback = new THREE.Color(0.42, 0.48, 0.58);

  function isOurs(o) {
    for (let p = o; p; p = p.parent) if (p === group) return true;
    return false;
  }

  function buildCullList() {
    cullListBuilt = true;
    // Anything under 3 m across contributes nothing readable to a 768x384
    // reflection of a rippled puddle — skip it and buy the draw calls back.
    // This is what keeps the reflection pass at roughly a sixth of a scene
    // pass instead of doubling the frame.
    scene.traverse((o) => {
      if (!(o.isMesh || o.isPoints || o.isLine) || isOurs(o)) return;
      // The sky dome pins itself to the far plane (gl_Position.z = w) and is
      // drawn last with depth test on. Reflector's oblique near plane rewrites
      // the depth range, so in the reflection pass the dome loses the depth
      // test against the park and the mirror comes back skyless. The PMREM
      // environment is substituted as scene.background instead — same sky,
      // one draw call, and no dependency on the depth range surviving.
      if (o.name === 'SkyDome') { cullHidden.push(o); return; }
      if (o.name === 'park_decals' || o.name.indexOf('decal_') === 0) { cullHidden.push(o); return; }
      const geo = o.geometry;
      if (!geo) return;
      if (!geo.boundingSphere) { try { geo.computeBoundingSphere(); } catch { return; } }
      if (!geo.boundingSphere) return;
      const s = o.getWorldScale(_scale);
      let r = geo.boundingSphere.radius * Math.max(s.x, s.y, s.z);
      if (o.isInstancedMesh) r *= 4;      // instances spread far past their proto
      if (r > 0 && r < 3.0) cullHidden.push(o);
    });
    log.reflectionCulled = cullHidden.length;
  }

  if (reflector) {
    const inner = reflector.onBeforeRender;
    reflector.onBeforeRender = function (r, sc, cam) {
      if (!reflectEnabled) return;
      if (sc.overrideMaterial) return;                     // GTAO depth/normal prepass
      if (ctx.camera && cam !== ctx.camera) return;        // creator/preview cameras
      if (reflectFrames > 0) {
        if (sinceReflect < REFLECT_EVERY) return;
        const moved = cam.position.distanceToSquared(_lastPos) > 4e-4
          || Math.abs(cam.quaternion.dot(_lastQuat)) < 0.99997;
        if (!moved && sinceReflect < 30) return;
        if (mirrorRadius > 0 && cam.position.distanceTo(mirrorCentre) > mirrorRadius + 110) return;
      }
      if (!cullListBuilt) buildCullList();

      _lastPos.copy(cam.position);
      _lastQuat.copy(cam.quaternion);
      sinceReflect = 0;
      reflectFrames++;

      const wasWet = wetMesh ? wetMesh.visible : false;
      const wasBg = sc.background;
      const wasBgInt = sc.backgroundIntensity;
      if (wetMesh) wetMesh.visible = false;
      for (let i = 0; i < cullHidden.length; i++) {
        const o = cullHidden[i];
        o.userData._puddleVis = o.visible;
        o.visible = false;
      }
      const env = ctx.world?.environment;
      sc.background = env?.envMap || skyFallback;
      sc.backgroundIntensity = 1;
      try {
        inner.call(this, r, sc, cam);
      } finally {
        sc.background = wasBg;
        sc.backgroundIntensity = wasBgInt;
        for (let i = 0; i < cullHidden.length; i++) {
          const o = cullHidden[i];
          o.visible = o.userData._puddleVis !== false;
        }
        if (wetMesh) wetMesh.visible = wasWet;
      }
    };
  }

  // --- runtime -------------------------------------------------------------
  let wetness = 1;
  let splashCursor = 0;
  let sprayCooldown = 0;
  const _v = new THREE.Vector3();
  const _sunDir = new THREE.Vector3(0, 1, 0);

  function setWetness(v) {
    wetness = clamp(v, 0, 1);
    shared.uWetness.value = wetness;
    shared.uThreshold.value = lerp(THRESH_DRY, THRESH_WET, wetness);
    shared.uRippleAmp.value = 0.35 + 0.65 * wetness;
    group.visible = wetness > 0.005;
    if (reflector) {
      const u = reflector.material.uniforms;
      u.uRippleAmp.value = shared.uRippleAmp.value;
      u.uReflStrength.value = reflectEnabled ? 0.72 + 0.30 * wetness : 0.20;
      u.uSpecGain.value = 0.6 + 0.9 * wetness;
    }
  }

  /** Standing-water depth factor at a world XZ, 0 dry .. 1 open water. */
  function wetnessAt(x, z) {
    if (x < region.minX || x > region.maxX || z < region.minZ || z > region.maxZ) return 0;
    const valid = fieldAt(field, region, x, z, 1);
    if (valid < 0.2) return 0;
    const f = fieldAt(field, region, x, z, 0);
    return clamp((f - shared.uThreshold.value) / FEATHER, 0, 1) * valid;
  }

  /** Ripple burst at a world position. `speed` in m/s scales the ring. */
  function splash(position, speed = 6) {
    if (!position || wetness <= 0.005) return 0;
    const x = position.x !== undefined ? position.x : position[0];
    const z = position.z !== undefined ? position.z : position[2];
    const w = wetnessAt(x, z);
    if (w < 0.12) return 0;
    const s = splashes[splashCursor];
    splashCursor = (splashCursor + 1) % MAX_SPLASH;
    s.set(x, z, 0, clamp(0.25 + speed * 0.075, 0.2, 1.3) * w);
    return w;
  }

  function update(dt, c) {
    if (!group.visible) return;
    const cc = c || ctx;
    const cam = cc.camera || ctx.camera;
    const env = cc.world?.environment || ctx.world?.environment;
    shared.uTime.value = cc.time?.elapsed ?? (shared.uTime.value + dt);
    sinceReflect++;

    for (let i = 0; i < MAX_SPLASH; i++) {
      const s = splashes[i];
      if (s.w <= 0.001) continue;
      s.z += dt;
      if (s.z > 2.6) s.set(0, 0, 0, 0);
    }

    if (env?.sunDirection) _sunDir.copy(env.sunDirection).normalize();
    const fog = scene.fog;
    if (fog) {
      shared.uFogColor.value.copy(fog.color);
      shared.uFogDensity.value = fog.density !== undefined ? fog.density : 0.005;
    }

    if (reflector) {
      const u = reflector.material.uniforms;
      u.uCamPos.value.copy(cam.position);
      u.uSunDir.value.copy(_sunDir);
      if (env?.sun) {
        u.uSunColor.value.copy(env.sun.color).multiplyScalar(clamp(env.sun.intensity * 0.32, 0, 2.2));
      }
      if (env?.hemi) u.uSkyColor.value.copy(env.hemi.color);
    }

    // Tyre wake straight off the bike, so the water is alive even when nothing
    // else calls splash().
    const st = cc.player?.physics?.state;
    sprayCooldown -= dt;
    if (st && st.grounded && st.speed > 3.2 && sprayCooldown <= 0) {
      const w = splash(st.position, st.speed);
      if (w > 0.15) {
        sprayCooldown = 0.11;
        const fx = cc.fx;
        if (fx?.smoke && w > 0.35 && st.speed > 6) {
          _v.copy(st.position); _v.y += 0.06;
          try { fx.smoke(_v, 2, undefined, 0.35, 0.5); } catch { /* fx is optional */ }
        }
      } else {
        sprayCooldown = 0.05;
      }
    }
  }

  function dispose() {
    if (reflector) { reflector.dispose(); group.remove(reflector); }
    if (wetMesh) { wetMesh.geometry.dispose(); wetMaterial.dispose(); group.remove(wetMesh); }
    field.tex.dispose();
    detailTex.dispose();
    cullHidden.length = 0;
    group.clear();
  }

  setWetness(1);

  const stats = {
    ...log,
    pools: pools.length,
    largestPoolArea: pools.length ? +pools[0].area.toFixed(1) : 0,
    waterArea: +pools.reduce((a, p) => a + p.area, 0).toFixed(1),
    mirrorQuads,
    otherQuads,
    triangles: (mirrorQuads + otherQuads) * 2,
    drawCalls: (reflector ? 1 : 0) + (wetMesh ? 1 : 0),
    reflectionTarget: `${RT_W}x${RT_H}`,
    reflectEvery: REFLECT_EVERY,
    level: +level.toFixed(2),
  };
  console.info(`[puddles] ${stats.pools} pools / ${stats.waterArea} m² standing water, `
    + `${stats.triangles} tris in ${stats.drawCalls} draw calls, mirror ${stats.reflectionTarget} `
    + `every ${REFLECT_EVERY} frames, survey ${stats.surveySamples} rays in ${stats.surveyMs} ms`);

  return {
    group,
    stats,
    update,
    fixedUpdate() {},
    setWetness,
    get wetness() { return wetness; },
    wetnessAt,
    splash,
    /**
     * Diagnostic view of the water solve, drawn straight to the frame:
     * 0 off, 1 raw reflection, 2 reflection texture centre, 3 projected uv,
     * 4 field texture (R field, G poolable, B drying), 5 mask/water solve.
     * This system is almost entirely shader-side, so leaving the probe in is
     * the difference between five minutes and an afternoon next time.
     */
    setDebug(mode) { if (reflector) reflector.material.uniforms.uDebug.value = mode || 0; },
    /** Kill the planar reflection entirely (quality tiers / perf panic). */
    setReflections(on) {
      reflectEnabled = !!on;
      setWetness(wetness);
    },
    dispose,
    reflector,
    wetMesh,
  };
}

function stub(group) {
  return {
    group,
    stats: { pools: 0, triangles: 0, drawCalls: 0 },
    update() {},
    fixedUpdate() {},
    setWetness() {},
    get wetness() { return 0; },
    wetnessAt() { return 0; },
    splash() { return 0; },
    setDebug() {},
    setReflections() {},
    dispose() { group.clear(); },
  };
}

export default createPuddles;
