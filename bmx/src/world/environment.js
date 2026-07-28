// Sky, cloud decks, lighting rig, image-based lighting, aerial perspective and
// time of day.
//
// The sky is an analytic-scattering dome (Preetham-flavoured) carrying TWO
// independently parallaxing cloud decks — a high, fine-grained deck and a low,
// large-featured deck drifting over it — plus a break-through sun glow, a wide
// horizon haze band and a ground-bounce hemisphere. That same dome is rendered
// into a PMREM cube so every PBR material in the park is lit by the real sky.
//
// The target frame is an overcast dusk: a covered deck with structure and
// volume, cool blue-grey overhead, warm light breaking through low on the sun
// side, and a city sitting inside heavy but *cool* haze. Nothing in the grade is
// allowed to blow the sky out or crush the ramps to black.

import * as THREE from 'three';
import { PMREMGenerator } from 'three';
import { clamp, lerp, rand, deg } from '../core/mathx.js';

// ---------------------------------------------------------------------------
// Height fog + aerial perspective.
//
// Patch the shared fog chunks so (a) density falls off with altitude — ground
// haze stays thick, the skyline tops stay readable — and (b) distance does what
// distance really does: it desaturates, lifts the blacks and *then* inscatters.
// Straight `mix(colour, grey, f)` is what makes a fogged frame look muddy; the
// desaturate-first ordering is what makes it look like air.
//
// Colour and density still come from scene.fog, so the renderer keeps refreshing
// them and no extra uniforms are needed on materials this module does not own.
// ---------------------------------------------------------------------------

const FOG_BASE_HEIGHT = 0.0;      // metres — where the haze layer sits
const FOG_HEIGHT_FALLOFF = 0.074; // 1/m — density halves every ~9 m of altitude

const _fogChunkBackup = {};

function installHeightFog() {
  if (THREE.ShaderChunk.__bmxHeightFog) return;
  for (const k of ['fog_pars_vertex', 'fog_vertex', 'fog_pars_fragment', 'fog_fragment']) {
    _fogChunkBackup[k] = THREE.ShaderChunk[k];
  }

  THREE.ShaderChunk.fog_pars_vertex = /* glsl */`
#ifdef USE_FOG
  varying float vFogDepth;
  varying float vFogWorldY;
#endif
`;

  // mvPosition exists in every stock vertex shader that includes fog_vertex
  // (mesh, points, line, sprite). The view matrix is rigid, so its rotation
  // inverts by transpose — that gives world Y without an extra uniform.
  THREE.ShaderChunk.fog_vertex = /* glsl */`
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  vFogWorldY = cameraPosition.y + dot( vec3( viewMatrix[ 0 ][ 1 ], viewMatrix[ 1 ][ 1 ], viewMatrix[ 2 ][ 1 ] ), mvPosition.xyz );
#endif
`;

  THREE.ShaderChunk.fog_pars_fragment = /* glsl */`
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying float vFogWorldY;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif
`;

  THREE.ShaderChunk.fog_fragment = /* glsl */`
#ifdef USE_FOG
  {
    const float fogK = ${FOG_HEIGHT_FALLOFF.toFixed(5)};
    const float fogH0 = ${FOG_BASE_HEIGHT.toFixed(3)};
    float fogEyeY = cameraPosition.y;
    float fogDy = vFogWorldY - fogEyeY;
    float fogA = exp( - fogK * ( fogEyeY - fogH0 ) );
    float fogB = exp( - fogK * ( vFogWorldY - fogH0 ) );
    // analytic integral of exp(-k*y) along the view ray, normalised by its length
    float fogAtten = abs( fogDy ) > 0.02 ? ( fogA - fogB ) / ( fogK * fogDy ) : fogA;
    float fogDist = vFogDepth * clamp( fogAtten, 0.0, 1.6 );
    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp( - fogDensity * fogDensity * fogDist * fogDist );
    #else
      float fogFactor = smoothstep( fogNear, fogFar, fogDist );
    #endif

    // --- aerial perspective -------------------------------------------------
    vec3 fogSrc = gl_FragColor.rgb;
    float fogLum = dot( fogSrc, vec3( 0.2126, 0.7152, 0.0722 ) );
    // 1. distance eats chroma long before it eats contrast
    fogSrc = mix( fogSrc, vec3( fogLum ), fogFactor * 0.72 );
    // 2. and it lifts the shadows toward the haze value faster than the highlights
    fogSrc = mix( fogSrc, fogSrc + fogColor * ( 1.0 - fogLum ) * 0.55, fogFactor * 0.75 );
    // 3. only then does the haze itself take over
    gl_FragColor.rgb = mix( fogSrc, fogColor, fogFactor );
  }
#endif
`;

  THREE.ShaderChunk.__bmxHeightFog = true;
}

function uninstallHeightFog() {
  if (!THREE.ShaderChunk.__bmxHeightFog) return;
  for (const k in _fogChunkBackup) THREE.ShaderChunk[k] = _fogChunkBackup[k];
  delete THREE.ShaderChunk.__bmxHeightFog;
}

// ---------------------------------------------------------------------------
// Sky dome shader
// ---------------------------------------------------------------------------

const SkyShader = {
  name: 'BMXSkyShader',

  uniforms: {
    uSunDirection: { value: new THREE.Vector3(0, 0.37, -1) },
    uRayleigh: { value: 2.6 },
    uTurbidity: { value: 3.6 },
    uMieCoefficient: { value: 0.0075 },
    uMieDirectionalG: { value: 0.84 },
    uSkyIntensity: { value: 0.30 },
    uSkyRolloff: { value: 0.72 },
    uSkyTint: { value: new THREE.Color(1, 1, 1) },
    uShowSunDisc: { value: 1.0 },
    uSunDiscIntensity: { value: 40.0 },

    // two decks, two drift vectors — the parallax between them is what sells
    // the deck as a volume rather than a texture
    uDriftLow: { value: new THREE.Vector2(0, 0) },
    uDriftHigh: { value: new THREE.Vector2(0, 0) },
    uCloudCover: { value: 0.72 },       // low deck
    uCloudCoverHigh: { value: 0.55 },   // high deck
    uCloudScale: { value: 1.0 },
    uCloudOpacity: { value: 1.0 },
    uCloudGain: { value: 1.35 },
    uCloudShadowTint: { value: new THREE.Color(0.33, 0.38, 0.52) },
    uCloudLitTint: { value: new THREE.Color(1.0, 0.86, 0.68) },
    uSilver: { value: 1.6 },            // forward-scatter rim on the sun side
    uWarmUnder: { value: 0.5 },         // warm bounce into the cloud bases
    uSunGlow: { value: 1.0 },           // break-through glow behind the deck
    uCloudSat: { value: 0.55 },         // multiple scattering washes cloud chroma out

    uHazeTint: { value: new THREE.Color(1.0, 0.72, 0.46) },
    uHazeStrength: { value: 0.18 },
    uHazeColor: { value: new THREE.Color(0.62, 0.66, 0.72) },
    uGroundColor: { value: new THREE.Color(0.19, 0.16, 0.13) },
    uGroundGain: { value: 1.6 },
    uTwilightColor: { value: new THREE.Color(0.014, 0.033, 0.096) },
    uTwilightStrength: { value: 0.0 },
    uNight: { value: 0.0 },
  },

  vertexShader: /* glsl */`
    uniform vec3 uSunDirection;
    uniform float uRayleigh;
    uniform float uTurbidity;
    uniform float uMieCoefficient;

    varying vec3 vWorldPosition;
    varying vec3 vSunDirection;
    varying vec3 vBetaR;
    varying vec3 vBetaM;
    varying float vSunE;
    varying vec3 vSunIrradiance;

    const float e = 2.718281828459045;
    const float pi = 3.141592653589793;

    // Preetham primaries, pre-integrated Rayleigh / Mie constants
    const vec3 totalRayleigh = vec3( 5.804542996261093E-6, 1.3562911419845635E-5, 3.0265902468824876E-5 );
    const vec3 MieConst = vec3( 1.8399918514433978E14, 2.7798023919660528E14, 4.0790479543861094E14 );

    const float cutoffAngle = 1.6110731556870734;
    const float steepness = 1.5;
    const float EE = 1000.0;

    float sunIntensity( float zenithAngleCos ) {
      zenithAngleCos = clamp( zenithAngleCos, -1.0, 1.0 );
      return EE * max( 0.0, 1.0 - pow( e, -( ( cutoffAngle - acos( zenithAngleCos ) ) / steepness ) ) );
    }

    vec3 totalMie( float T ) {
      float c = ( 0.2 * T ) * 10E-18;
      return 0.434 * c * MieConst;
    }

    void main() {
      vec4 worldPosition = modelMatrix * vec4( position, 1.0 );
      vWorldPosition = worldPosition.xyz;

      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
      gl_Position.z = gl_Position.w;   // pin the dome to the far plane

      vSunDirection = normalize( uSunDirection );
      vSunE = sunIntensity( vSunDirection.y );

      float sunfade = 1.0 - clamp( 1.0 - exp( vSunDirection.y ), 0.0, 1.0 );
      vBetaR = totalRayleigh * ( uRayleigh - ( 1.0 - sunfade ) );
      vBetaM = totalMie( uTurbidity ) * uMieCoefficient;

      // Extinction along the *sun* path, i.e. the colour of direct sunlight
      // reaching cloud tops and the ground. This is what turns the light orange
      // as the sun drops, without any hand-authored gradient.
      float sunZenith = acos( clamp( max( vSunDirection.y, 0.0 ), -1.0, 1.0 ) );
      float sunInv = 1.0 / ( cos( sunZenith ) + 0.15 * pow( 93.885 - ( ( sunZenith * 180.0 ) / pi ), -1.253 ) );
      vec3 sunFex = exp( -( vBetaR * 8.4E3 * sunInv + vBetaM * 1.25E3 * sunInv ) );
      // Preetham over-extinguishes the short wavelengths at grazing sun angles —
      // by 6 degrees blue is three orders down and cloud tops go pure red. Floor
      // each channel against the strongest so a low sun stays orange, not scarlet.
      float sunFexMax = max( sunFex.r, max( sunFex.g, sunFex.b ) );
      sunFex = max( sunFex, vec3( sunFexMax * 0.24 ) );
      // sun disc solid angle (~6.8e-5 sr) folded in, then the shared 0.04 scale
      vSunIrradiance = vSunE * 1.22 * sunFex * 0.04;
    }
  `,

  fragmentShader: /* glsl */`
    varying vec3 vWorldPosition;
    varying vec3 vSunDirection;
    varying vec3 vBetaR;
    varying vec3 vBetaM;
    varying float vSunE;
    varying vec3 vSunIrradiance;

    uniform float uMieDirectionalG;
    uniform float uSkyIntensity;
    uniform float uSkyRolloff;
    uniform vec3 uSkyTint;
    uniform float uShowSunDisc;
    uniform float uSunDiscIntensity;

    uniform vec2 uDriftLow;
    uniform vec2 uDriftHigh;
    uniform float uCloudCover;
    uniform float uCloudCoverHigh;
    uniform float uCloudScale;
    uniform float uCloudOpacity;
    uniform float uCloudGain;
    uniform vec3 uCloudShadowTint;
    uniform vec3 uCloudLitTint;
    uniform float uSilver;
    uniform float uWarmUnder;
    uniform float uSunGlow;
    uniform float uCloudSat;

    uniform vec3 uHazeTint;
    uniform float uHazeStrength;
    uniform vec3 uHazeColor;
    uniform vec3 uGroundColor;
    uniform float uGroundGain;
    uniform vec3 uTwilightColor;
    uniform float uTwilightStrength;
    uniform float uNight;

    const float pi = 3.141592653589793;
    const vec3 up = vec3( 0.0, 1.0, 0.0 );
    const vec3 LUMA = vec3( 0.2126, 0.7152, 0.0722 );

    const float rayleighZenithLength = 8.4E3;
    const float mieZenithLength = 1.25E3;
    const float sunAngularDiameterCos = 0.9999566769464483;
    const float THREE_OVER_SIXTEENPI = 0.05968310365946075;
    const float ONE_OVER_FOURPI = 0.07957747154594767;

    float rayleighPhase( float cosTheta ) {
      return THREE_OVER_SIXTEENPI * ( 1.0 + cosTheta * cosTheta );
    }

    float hgPhase( float cosTheta, float g ) {
      float g2 = g * g;
      float inv = 1.0 / pow( max( 1.0 - 2.0 * g * cosTheta + g2, 1e-4 ), 1.5 );
      return ONE_OVER_FOURPI * ( ( 1.0 - g2 ) * inv );
    }

    // --- deterministic value noise -----------------------------------------
    float hash21( vec2 p ) {
      p = fract( p * vec2( 233.34, 851.73 ) );
      p += dot( p, p + 23.45 );
      return fract( p.x * p.y );
    }

    float vnoise( vec2 p ) {
      vec2 i = floor( p );
      vec2 f = fract( p );
      f = f * f * ( 3.0 - 2.0 * f );
      float a = hash21( i );
      float b = hash21( i + vec2( 1.0, 0.0 ) );
      float c = hash21( i + vec2( 0.0, 1.0 ) );
      float d = hash21( i + vec2( 1.0, 1.0 ) );
      return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );
    }

    const mat2 M2 = mat2( 0.86, 0.51, -0.51, 0.86 );

    // Fixed-octave fbm variants, each normalised to 0..1 so a single coverage
    // threshold behaves the same however many octaves fed it. Separate functions
    // rather than a loop bound so this stays legal ESSL1 on every driver.
    float fbm3( vec2 p ) {
      float v = 0.0, a = 0.5, n = 0.0;
      for ( int i = 0; i < 3; i ++ ) {
        v += a * vnoise( p ); n += a;
        p = M2 * p * 2.07 + 11.3; a *= 0.52;
      }
      return v / n;
    }

    float fbm4( vec2 p ) {
      float v = 0.0, a = 0.5, n = 0.0;
      for ( int i = 0; i < 4; i ++ ) {
        v += a * vnoise( p ); n += a;
        p = M2 * p * 2.05 + 7.1; a *= 0.52;
      }
      return v / n;
    }

    float fbm5( vec2 p ) {
      float v = 0.0, a = 0.5, n = 0.0;
      for ( int i = 0; i < 5; i ++ ) {
        v += a * vnoise( p ); n += a;
        p = M2 * p * 2.03 + 7.1; a *= 0.53;
      }
      return v / n;
    }

    // Shape a raw fbm field into a coverage-controlled deck. 'sharp' widens or
    // tightens the transition so a stratus deck can be soft and a cumulus deck
    // can have a hard, sculpted silhouette.
    float shapeDeck( float f, float cover, float sharp ) {
      float base = smoothstep( 0.27, 0.78, f );
      float thr = 1.0 - cover;
      return smoothstep( thr, thr + sharp * cover + 0.04, base );
    }

    void main() {
      vec3 direction = normalize( vWorldPosition - cameraPosition );
      float cosTheta = dot( direction, vSunDirection );

      // --- analytic scattering ---------------------------------------------
      float zenithAngle = acos( max( 0.0, dot( up, direction ) ) );
      float inv = 1.0 / ( cos( zenithAngle ) + 0.15 * pow( 93.885 - ( ( zenithAngle * 180.0 ) / pi ), -1.253 ) );
      float sR = rayleighZenithLength * inv;
      float sM = mieZenithLength * inv;

      vec3 Fex = exp( -( vBetaR * sR + vBetaM * sM ) );

      vec3 betaRTheta = vBetaR * rayleighPhase( cosTheta * 0.5 + 0.5 );
      vec3 betaMTheta = vBetaM * hgPhase( cosTheta, uMieDirectionalG );
      vec3 betaSum = vBetaR + vBetaM;

      vec3 ratio = ( betaRTheta + betaMTheta ) / betaSum;
      vec3 Lin = pow( vSunE * ratio * ( 1.0 - Fex ), vec3( 1.5 ) );

      // Preetham's low-sun correction term goes green on the anti-sun horizon.
      // Keep its luminance falloff, but only 45% of its chroma.
      vec3 corr = pow( vSunE * ratio * Fex, vec3( 0.5 ) );
      float corrL = dot( corr, LUMA );
      float corrW = clamp( pow( 1.0 - dot( up, vSunDirection ), 5.0 ), 0.0, 0.6 );
      Lin *= mix( vec3( 1.0 ), mix( vec3( corrL ), corr, 0.45 ), corrW );

      vec3 col = ( Lin + vec3( 0.09 ) * Fex ) * 0.04;

      // Preetham's aureole trends blue-white; push it toward the sun's own
      // extinguished colour in proportion to the Mie share of the scattering,
      // which is what actually makes a low sun glow orange.
      float mieShare = dot( betaMTheta, vec3( 1.0 ) ) / max( dot( betaRTheta + betaMTheta, vec3( 1.0 ) ), 1e-9 );
      float aureoleW = pow( max( cosTheta, 0.0 ), 3.0 );
      vec3 sunHue = clamp( vSunIrradiance / max( dot( vSunIrradiance, LUMA ), 1e-4 ), 0.0, 2.6 );
      sunHue = mix( vec3( 1.0 ), sunHue, 0.88 );   // never fully kill a channel
      // forward hemisphere only — the anti-sun sky must stay blue
      float tintW = clamp( aureoleW * 0.9 + mieShare * 0.4 * max( cosTheta, 0.0 ), 0.0, 0.9 );
      col = mix( col, col * sunHue, tintW );

      // --- geometry shared by both decks ------------------------------------
      vec3 sunIrr = vSunIrradiance;
      float sunLumV = dot( sunIrr, LUMA );
      float sunUp = clamp( vSunDirection.y * 3.2 + 0.25, 0.0, 1.0 );

      vec2 sunAz = normalize( vSunDirection.xz + vec2( 1e-4 ) );
      vec2 viewAz = normalize( direction.xz + vec2( 1e-5 ) );
      float azAlign = dot( viewAz, sunAz ) * 0.5 + 0.5;         // 1 = looking up-sun

      // How obliquely we cut the deck. 1 at the horizon (we see cloud sides and
      // tops edge-on, stacked into a solid band), 0 overhead (we see the bases,
      // broken and dark). This single term is what turns a flat noise field into
      // something that reads as a ceiling with depth.
      float sideness = 1.0 - smoothstep( 0.010, 0.30, direction.y );

      // A clearing on the sun side, low down: the break the warm light comes
      // through. Widest right at the horizon, gone by ~12 degrees up.
      float breakMask = pow( azAlign, 1.6 ) * ( 1.0 - smoothstep( 0.0, 0.30, direction.y ) );

      // --- break-through glow, laid down BEFORE the clouds so they occlude it -
      vec3 glowCol = sunHue * uSunGlow * sunLumV *
        ( pow( max( cosTheta, 0.0 ), 5.0 ) * 0.55 + pow( max( cosTheta, 0.0 ), 60.0 ) * 1.10 );
      glowCol *= 0.55 + 0.45 * sideness;
      col += glowCol;

      float skyLumPre = dot( col, LUMA );

      // Direct sunlight arriving at the deck, already in sky units.
      vec3 litCol = sunIrr * uCloudGain * uCloudLitTint * 0.235;
      // Up-sun march length in cloud-plane units — grows as the sun drops, so a
      // low sun rakes across the deck and throws long internal shadows.
      float marchLen = mix( 1.35, 0.42, clamp( vSunDirection.y * 2.4, 0.0, 1.0 ) );
      vec2 sunStep = sunAz * marchLen;

      float coverA = 0.0;   // total alpha accumulated, for the glow bleed below

      // ======================================================================
      // HIGH DECK — small features, far away, slow drift, brighter and thinner.
      // Composited first so the low deck reads as passing in front of it.
      // ======================================================================
      if ( direction.y > 0.004 && uCloudCoverHigh > 0.002 ) {
        vec2 uv = direction.xz / ( direction.y + 0.05 ) * ( uCloudScale * 2.55 ) + uDriftHigh;

        float f = fbm4( uv * vec2( 0.66, 1.0 ) + 41.0 );        // wind-combed
        float coverH = uCloudCoverHigh * ( 1.0 - 0.35 * breakMask );
        float d = shapeDeck( f, coverH, 0.34 );
        // stack toward the horizon
        d = 1.0 - pow( 1.0 - d, 1.0 + 2.6 * sideness );
        d *= smoothstep( 0.004, 0.075, direction.y );

        if ( d > 0.003 ) {
          float fu = fbm3( uv * vec2( 0.66, 1.0 ) + 41.0 + sunStep * 0.6 );
          float du = shapeDeck( fu, coverH, 0.34 );
          float trans = exp( -du * 1.7 );

          float alt = smoothstep( 0.30, 0.85, f );
          vec3 amb = uCloudShadowTint * ( skyLumPre * 3.7 ) * uCloudGain;
          vec3 cc = amb * ( 0.85 + 0.5 * alt )
                  + litCol * ( 0.28 + 0.72 * trans ) * ( 0.30 + 0.70 * sideness ) * 0.85
                  + litCol * hgPhase( cosTheta, 0.76 ) * uSilver * ( 1.0 - d ) * 1.1;

          cc = mix( vec3( dot( cc, LUMA ) ), cc, mix( uCloudSat, 1.0, breakMask ) );

          // thin high cloud always keeps some of the sky behind it
          float aH = d * uCloudOpacity * 0.80;
          float fade = 1.0 - smoothstep( 0.02, 0.24, direction.y );
          cc = mix( cc, col + uHazeColor * uHazeStrength * 0.5 * sunLumV, fade * 0.72 );
          col = mix( col, cc, aH );
          coverA = aH;
        }
      }

      // ======================================================================
      // LOW DECK — the hero. Large domain-warped features, closer (so it
      // parallaxes faster), heavier, dark cool bases with warm underlighting.
      // ======================================================================
      if ( direction.y > 0.002 && uCloudOpacity > 0.002 ) {
        // +0.145 keeps the horizon from compressing into aliasing-grade detail
        vec2 uv = direction.xz / ( direction.y + 0.145 ) * ( uCloudScale * 1.45 ) + uDriftLow;

        // domain warp — cheap, but it is the difference between "cloud" and
        // "noise texture": it curls the silhouettes and breaks the fbm grid.
        // Kept modest; push it past ~1.0 and the deck turns to marbling.
        vec2 w = vec2( fbm3( uv * 0.36 + 3.1 ), fbm3( uv * 0.36 + 17.7 ) ) - 0.5;
        vec2 p = uv + w * 0.9;

        float f = fbm5( p );
        float coverL = uCloudCover * ( 1.0 - 0.52 * breakMask );
        float d = shapeDeck( f, coverL, 0.32 );

        // erode the silhouette with a higher-frequency pass so edges are wispy
        float det = fbm4( p * 4.2 + 21.0 );
        d = clamp( d - ( 1.0 - d ) * ( det - 0.34 ) * 0.90, 0.0, 1.0 );

        // stack toward the horizon into a solid band
        d = 1.0 - pow( 1.0 - d, 1.0 + 2.4 * sideness * ( 1.0 - 0.75 * breakMask ) );
        d *= smoothstep( 0.002, 0.055, direction.y );

        if ( d > 0.003 ) {
          // Fake a light march: how much cloud sits between here and the sun.
          float f1 = fbm4( p + sunStep * 0.45 );
          float f2 = fbm4( p + sunStep );
          float d1 = shapeDeck( f1, coverL, 0.32 );
          float d2 = shapeDeck( f2, coverL, 0.32 );
          float trans = exp( -( d1 * 1.5 + d2 * 1.1 ) );

          // Where we sit in the vertical body of the cloud: high fbm values are
          // the built-up towers (bright tops), low values the thin flat base.
          float alt = smoothstep( 0.34, 0.86, f );

          // Ambient: the top of a cloud sees the whole sky dome, the base sees
          // the ground and a sliver of horizon. Which of the two we are looking
          // at is 'sideness'.
          vec3 ambTop = uCloudShadowTint * ( skyLumPre * 4.4 ) * uCloudGain;
          vec3 ambBase = ambTop * 0.62
            + uHazeTint * uWarmUnder * sunLumV * uCloudGain * ( 0.25 + 0.75 * pow( azAlign, 2.4 ) ) * sideness;
          vec3 amb = mix( ambBase, ambTop, sideness * 0.75 + alt * 0.25 );

          // Direct: only the flanks and tops we can actually see catch the key,
          // and under a deck this is a minority of the light — overdo it and the
          // whole sky goes orange instead of grey with a warm break.
          vec3 direct = litCol * ( 0.10 + 0.90 * trans ) *
            ( 0.30 + 0.70 * sideness ) * ( 0.35 + 0.65 * alt ) * 0.95;

          // Silver lining: forward scattering through the thin edges. Peaks
          // where the deck is half transparent, which is exactly the silhouette.
          float edge = d * ( 1.0 - d ) * 4.0;
          vec3 silver = litCol * hgPhase( cosTheta, 0.82 ) * uSilver *
            ( 0.30 + 0.70 * edge ) * ( 1.0 - d * 0.55 )
            // thin edges are bright from every direction, not only up-sun
            + ambTop * edge * 0.20
            // and the built-up crowns catch the key almost unattenuated
            + litCol * pow( alt, 2.0 ) * trans * 0.50;

          // Internal mottling: without this the body of a big cloud is a flat
          // grey field and the whole deck reads as a cut-out.
          amb *= 0.68 + 0.64 * alt + 0.30 * ( det - 0.45 );

          vec3 cc = amb + direct + silver;
          // Deep cloud is grey: enough scattering events and the hue washes out.
          // Only the break keeps its colour.
          cc = mix( vec3( dot( cc, LUMA ) ), cc, mix( uCloudSat, 1.0, breakMask ) );

          // aerial perspective on the deck itself — distant low cloud dissolves
          // into the horizon haze rather than staying crisp to the edge of frame
          float fade = 1.0 - smoothstep( 0.010, 0.16, direction.y );
          vec3 hazeCol = mix( uHazeColor, uHazeTint, pow( azAlign, 2.6 ) ) *
            uHazeStrength * ( 0.55 + 0.9 * sunLumV ) + col * 0.55;
          cc = mix( cc, hazeCol, fade * 0.66 );

          float aL = d * uCloudOpacity;
          col = mix( col, cc, aL );
          coverA = coverA + aL - coverA * aL;
        }
      }

      // A little of the break-through glow survives the deck — thin cloud lights
      // up from behind instead of reading as a flat cut-out.
      col += glowCol * coverA * 0.45 * sunUp;

      // --- horizon haze -------------------------------------------------------
      // Two terms: a wide value lift that removes the hard sky/ground line, and
      // a tight bright band sitting right on it.
      float below = 1.0 - abs( direction.y );
      float wide = pow( clamp( below, 0.0, 1.0 ), 5.5 );
      float band = pow( clamp( below, 0.0, 1.0 ), 26.0 );
      float sunSide = 0.40 + 0.60 * pow( azAlign, 1.8 );
      vec3 hazeMix = mix( uHazeColor, uHazeTint, clamp( pow( azAlign, 2.2 ) * ( 0.35 + 0.65 * ( 1.0 - sunUp * 0.6 ) ), 0.0, 1.0 ) );
      col = mix( col, hazeMix * ( 0.5 + 1.2 * sunLumV ), wide * uHazeStrength * sunSide * 0.80 );
      col += hazeMix * band * uHazeStrength * sunSide * ( 0.4 + 0.8 * sunLumV );

      // --- twilight ----------------------------------------------------------
      // Preetham's earth-shadow hack drops to zero the moment the sun sets, so
      // hand back the residual scattered light that makes blue hour readable.
      float twilight = smoothstep( 0.11, -0.15, vSunDirection.y ) * uTwilightStrength;
      if ( twilight > 0.001 ) {
        vec3 tw = uTwilightColor * ( 0.42 + 0.58 * pow( clamp( below, 0.0, 1.0 ), 2.4 ) );
        tw *= 0.55 + 0.85 * pow( azAlign, 2.0 );
        // low warm afterglow hugging the horizon on the sun side
        tw += uHazeTint * uTwilightColor.b * 2.6 * pow( azAlign, 5.0 ) * pow( max( 1.0 - abs( direction.y ) * 3.4, 0.0 ), 2.0 );
        // specified in post-exposure units so the presets stay readable
        col += tw * twilight / max( uSkyIntensity, 1e-3 );
      }

      // --- ground bounce hemisphere (drives the lower half of the IBL) -------
      // Rolled off over a wide arc so the dome never draws a line where the
      // real ground plane ends; the first few degrees below the horizon stay
      // haze-coloured and the bounce only takes over well down.
      if ( direction.y < 0.10 ) {
        float t = smoothstep( 0.10, -0.34, direction.y );
        vec3 g = uGroundColor * uGroundGain * ( sunIrr * 0.318 * max( vSunDirection.y, 0.0 ) + col * 0.62 );
        g *= 1.0 + 0.55 * pow( max( dot( viewAz, sunAz ), 0.0 ), 3.0 );
        // blend through the haze colour, not straight to dirt
        vec3 nearGround = mix( col, hazeMix * ( 0.42 + 0.9 * sunLumV ), 0.55 );
        col = mix( col, mix( nearGround, g, smoothstep( 0.0, -0.22, direction.y ) ), t );
      }

      // --- stars at dusk ------------------------------------------------------
      if ( uNight > 0.001 && direction.y > 0.0 ) {
        vec2 suv = vec2( atan( direction.z, direction.x ), acos( clamp( direction.y, -1.0, 1.0 ) ) ) * 210.0;
        vec2 sc = floor( suv );
        vec2 sf = fract( suv ) - 0.5;
        float pick = hash21( sc + 3.0 );
        vec2 jitter = ( vec2( hash21( sc + 11.0 ), hash21( sc + 23.0 ) ) - 0.5 ) * 0.7;
        float dd = length( sf - jitter );
        float star = step( 0.9855, pick ) * exp( -dd * dd * 90.0 ) * ( 0.35 + 0.65 * hash21( sc + 41.0 ) );
        col += vec3( 0.82, 0.88, 1.0 ) * star * uNight * 0.09 *
          smoothstep( 0.02, 0.28, direction.y ) * ( 1.0 - coverA * 0.9 );
      }

      // Sky exposure, then a soft shoulder. Preetham radiance spans four orders
      // of magnitude; without this the whole sun side clips to flat white under
      // ACES at exposure 1.0.
      col *= uSkyTint * uSkyIntensity;
      // Compress on luminance, not per channel, so the aureole rolls off as a
      // warm gradient instead of clipping to flat white. A little per-channel
      // compression is blended back in so the very core still whitens.
      float skyL = dot( col, LUMA );
      float skyLc = skyL / ( 1.0 + skyL * uSkyRolloff );
      col = mix( col * ( skyLc / max( skyL, 1e-5 ) ), col / ( 1.0 + col * uSkyRolloff ), 0.22 );

      // --- sun disc, added past the shoulder so it still blows out and blooms --
      // Behind a covered deck it is mostly hidden; that is the point.
      float discMask = smoothstep( sunAngularDiameterCos, sunAngularDiameterCos + 0.000018, cosTheta );
      float limb = 0.55 + 0.45 * sqrt( max( 0.0, 1.0 - pow( ( 1.0 - cosTheta ) / ( 1.0 - sunAngularDiameterCos ), 2.0 ) ) );
      vec3 discHue = Fex / max( max( Fex.r, max( Fex.g, Fex.b ) ), 1e-4 );
      vec3 disc = discHue * uSunDiscIntensity * uShowSunDisc *
        ( discMask * limb + 0.055 * pow( max( cosTheta, 0.0 ), 380.0 ) );
      col += min( disc, vec3( 90.0 ) ) * ( 1.0 - coverA * 0.88 );

      gl_FragColor = vec4( max( col, 0.0 ), 1.0 );

      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }
  `,
};

// Additive aureole + crepuscular-ray billboard parked on the sun direction.
// One quad; the angular noise gives shafts that read as light spilling through
// gaps in the deck, and the whole thing feeds the bloom pass.
const SunHazeShader = {
  uniforms: {
    uColor: { value: new THREE.Color(1.0, 0.72, 0.42) },
    uIntensity: { value: 1.0 },
    uShafts: { value: 0.55 },
    uTime: { value: 0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }
  `,
  fragmentShader: /* glsl */`
    uniform vec3 uColor;
    uniform float uIntensity;
    uniform float uShafts;
    uniform float uTime;
    varying vec2 vUv;

    float hash21( vec2 p ) {
      p = fract( p * vec2( 233.34, 851.73 ) );
      p += dot( p, p + 23.45 );
      return fract( p.x * p.y );
    }
    float vnoise( vec2 p ) {
      vec2 i = floor( p ), f = fract( p );
      f = f * f * ( 3.0 - 2.0 * f );
      return mix( mix( hash21( i ), hash21( i + vec2( 1.0, 0.0 ) ), f.x ),
                  mix( hash21( i + vec2( 0.0, 1.0 ) ), hash21( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
    }

    void main() {
      vec2 p = vUv * 2.0 - 1.0;
      float r = length( p );
      vec2 dir = p / max( r, 1e-4 );

      float core = exp( -r * r * 70.0 ) * 1.7;
      float aureole = exp( -r * 5.0 ) * 0.34;

      // Crepuscular rays: 1D noise sampled on the unit circle, so it is seamless
      // by construction. Two bands give thick shafts with finer ones inside.
      vec2 a = dir * 9.0 + uTime * 0.013;
      vec2 b = dir * 23.0 - uTime * 0.021;
      float rays = vnoise( a ) * 0.70 + vnoise( b ) * 0.30;
      rays = pow( clamp( rays * 1.55 - 0.34, 0.0, 1.0 ), 1.7 );
      rays *= smoothstep( 0.02, 0.30, r ) * exp( -r * 2.4 ) * uShafts;

      float amount = ( core + aureole + rays ) * uIntensity;
      amount *= smoothstep( 1.0, 0.48, r );
      gl_FragColor = vec4( uColor * max( amount, 0.0 ), 1.0 );
    }
  `,
};

// Emissive bulb for the park practical lights (instanced, HDR so bloom catches it).
const BulbShader = {
  uniforms: {
    uColor: { value: new THREE.Color(1.0, 0.66, 0.36) },
    uIntensity: { value: 0.0 },
  },
  vertexShader: /* glsl */`
    varying vec3 vN;
    void main() {
      #include <begin_vertex>
      #include <beginnormal_vertex>
      vec4 mv = modelViewMatrix * instanceMatrix * vec4( transformed, 1.0 );
      vN = normalize( normalMatrix * objectNormal );
      gl_Position = projectionMatrix * mv;
    }
  `,
  fragmentShader: /* glsl */`
    uniform vec3 uColor;
    uniform float uIntensity;
    varying vec3 vN;
    void main() {
      float f = 0.55 + 0.45 * pow( 1.0 - abs( vN.z ), 2.0 );
      gl_FragColor = vec4( uColor * uIntensity * f, 1.0 );
    }
  `,
};

// ---------------------------------------------------------------------------
// Time-of-day keyframes. Colours are authored in sRGB and converted to the
// linear working space on load; everything between stops is lerped.
//
// The reference frame is the `golden` stop: broken-overcast dusk. Read that stop
// as the art direction and the others as excursions from it.
//   - `fog` / `fogSun` are the two ends of the aerial-perspective haze; the
//     frame update blends between them by how far the camera is turned into the
//     sun, which is what a single fog colour cannot do.
//   - `sunIntensity` is deliberately modest and `hemiIntensity` large: light
//     through a cloud deck is mostly ambient. A key/fill ratio near 2:1 is what
//     keeps the ramp faces off black.
// ---------------------------------------------------------------------------

function srgb(hex) { return new THREE.Color().setHex(hex, THREE.SRGBColorSpace); }

const TOD_STOPS = [
  { // 0.00 — dawn
    t: 0.00, elev: 1.2, azim: 84,
    turbidity: 4.2, rayleigh: 3.3, mie: 0.0075, mieG: 0.9, skyIntensity: 0.27, skyRolloff: 0.50, sunDisc: 20,
    cloudGain: 4.2, groundGain: 1.5,
    sun: srgb(0xff9a58), sunIntensity: 0.85,
    hemiSky: srgb(0x66799c), hemiGround: srgb(0x4a3a2e), hemiIntensity: 0.62,
    rim: srgb(0x8aa4cd), rimIntensity: 0.26, bounce: srgb(0x8a6a4a), bounceIntensity: 0.22,
    fog: srgb(0x59606e), fogSun: srgb(0xa8785f), fogDensity: 0.0086,
    haze: srgb(0xff9a5e), hazeColor: srgb(0x8792a6), hazeStrength: 0.26, ground: srgb(0x3a3028),
    cloudCover: 0.66, cloudHigh: 0.52, cloudLit: srgb(0xffd9b8), cloudShadow: srgb(0x646c80),
    silver: 1.8, warmUnder: 0.85, sunGlow: 0.9, cloudSat: 0.66,
    exposure: 1.00, envIntensity: 1.10, practical: 0.55, night: 0.28, hazeGlow: 0.9,
    twilight: srgb(0x22345c), twilightStrength: 1.05,
  },
  { // 0.14 — morning
    t: 0.14, elev: 15, azim: 95,
    turbidity: 3.2, rayleigh: 2.5, mie: 0.0052, mieG: 0.885, skyIntensity: 0.155, skyRolloff: 0.44, sunDisc: 44,
    cloudGain: 1.5, groundGain: 1.6,
    sun: srgb(0xffc78d), sunIntensity: 2.05,
    hemiSky: srgb(0x9ab8de), hemiGround: srgb(0x5c4b3a), hemiIntensity: 0.80,
    rim: srgb(0xa4c2e8), rimIntensity: 0.30, bounce: srgb(0x9a7a55), bounceIntensity: 0.24,
    fog: srgb(0x9aa5b4), fogSun: srgb(0xd6b295), fogDensity: 0.0068,
    haze: srgb(0xffc191), hazeColor: srgb(0xa8b3c2), hazeStrength: 0.20, ground: srgb(0x4a4038),
    cloudCover: 0.60, cloudHigh: 0.50, cloudLit: srgb(0xfff0dc), cloudShadow: srgb(0x76808f),
    silver: 1.5, warmUnder: 0.45, sunGlow: 0.7, cloudSat: 0.50,
    exposure: 1.00, envIntensity: 1.05, practical: 0.08, night: 0.0, hazeGlow: 0.55,
    twilight: srgb(0x22345c), twilightStrength: 0.0,
  },
  { // 0.33 — noon
    t: 0.33, elev: 66, azim: 176,
    turbidity: 2.3, rayleigh: 1.7, mie: 0.0035, mieG: 0.86, skyIntensity: 0.135, skyRolloff: 0.40, sunDisc: 55,
    cloudGain: 1.0, groundGain: 1.6,
    sun: srgb(0xfff4e6), sunIntensity: 3.15,
    hemiSky: srgb(0xb4d0f5), hemiGround: srgb(0x6a5b48), hemiIntensity: 0.72,
    rim: srgb(0xbdd6f7), rimIntensity: 0.24, bounce: srgb(0xa08a68), bounceIntensity: 0.26,
    fog: srgb(0xa8b6c6), fogSun: srgb(0xc4ccd4), fogDensity: 0.0042,
    haze: srgb(0xd8dbe0), hazeColor: srgb(0xb4c0cd), hazeStrength: 0.14, ground: srgb(0x565049),
    cloudCover: 0.50, cloudHigh: 0.40, cloudLit: srgb(0xffffff), cloudShadow: srgb(0x8a94a2),
    silver: 1.2, warmUnder: 0.22, sunGlow: 0.45, cloudSat: 0.42,
    exposure: 0.98, envIntensity: 1.05, practical: 0.0, night: 0.0, hazeGlow: 0.35,
    twilight: srgb(0x2a3a60), twilightStrength: 0.0,
  },
  { // 0.52 — afternoon
    t: 0.52, elev: 40, azim: 232,
    turbidity: 2.7, rayleigh: 2.0, mie: 0.0042, mieG: 0.87, skyIntensity: 0.145, skyRolloff: 0.41, sunDisc: 52,
    cloudGain: 1.08, groundGain: 1.6,
    sun: srgb(0xffe9c9), sunIntensity: 2.90,
    hemiSky: srgb(0xaac9ee), hemiGround: srgb(0x6d5a44), hemiIntensity: 0.78,
    rim: srgb(0xaccbf2), rimIntensity: 0.28, bounce: srgb(0xa89070), bounceIntensity: 0.28,
    fog: srgb(0xa4b0bc), fogSun: srgb(0xcbc0b2), fogDensity: 0.0046,
    haze: srgb(0xe8ceb0), hazeColor: srgb(0xaab6c4), hazeStrength: 0.17, ground: srgb(0x554d43),
    cloudCover: 0.56, cloudHigh: 0.44, cloudLit: srgb(0xfff6e8), cloudShadow: srgb(0x7f8896),
    silver: 1.4, warmUnder: 0.32, sunGlow: 0.6, cloudSat: 0.46,
    exposure: 1.00, envIntensity: 1.05, practical: 0.0, night: 0.0, hazeGlow: 0.5,
    twilight: srgb(0x2a3a60), twilightStrength: 0.0,
  },
  { // 0.68 — THE REFERENCE FRAME: broken-overcast dusk, sun low behind the deck
    t: 0.68, elev: 13, azim: 246,
    turbidity: 3.4, rayleigh: 2.5, mie: 0.0050, mieG: 0.895, skyIntensity: 0.162, skyRolloff: 0.40, sunDisc: 34,
    cloudGain: 1.45, groundGain: 1.7,
    sun: srgb(0xffd9ac), sunIntensity: 2.30,
    hemiSky: srgb(0x9fbadd), hemiGround: srgb(0x726557), hemiIntensity: 1.05,
    rim: srgb(0x93b3e2), rimIntensity: 0.34, bounce: srgb(0xb59372), bounceIntensity: 0.40,
    fog: srgb(0x99a3b1), fogSun: srgb(0xceb098), fogDensity: 0.0044,
    haze: srgb(0xffcda4), hazeColor: srgb(0x9fabbb), hazeStrength: 0.22, ground: srgb(0x4e4237),
    cloudCover: 0.74, cloudHigh: 0.58, cloudLit: srgb(0xffeada), cloudShadow: srgb(0x717c90),
    silver: 1.9, warmUnder: 0.55, sunGlow: 1.0, cloudSat: 0.44,
    exposure: 1.06, envIntensity: 1.12, practical: 0.0, night: 0.0, hazeGlow: 1.0,
    twilight: srgb(0x243a66), twilightStrength: 0.0,
  },
  { // 0.84 — low sun raking under the deck
    t: 0.84, elev: 5, azim: 262,
    turbidity: 4.2, rayleigh: 3.2, mie: 0.0066, mieG: 0.905, skyIntensity: 0.168, skyRolloff: 0.44, sunDisc: 26,
    cloudGain: 2.4, groundGain: 1.7,
    sun: srgb(0xffa970), sunIntensity: 1.65,
    hemiSky: srgb(0x8296c6), hemiGround: srgb(0x7a5f45), hemiIntensity: 0.82,
    rim: srgb(0x8497cf), rimIntensity: 0.34, bounce: srgb(0xc08a56), bounceIntensity: 0.36,
    fog: srgb(0x7e8496), fogSun: srgb(0xc08a68), fogDensity: 0.0064,
    haze: srgb(0xffa76c), hazeColor: srgb(0x8b93a6), hazeStrength: 0.28, ground: srgb(0x453a31),
    cloudCover: 0.72, cloudHigh: 0.54, cloudLit: srgb(0xffdcc0), cloudShadow: srgb(0x666e82),
    silver: 2.2, warmUnder: 0.95, sunGlow: 1.25, cloudSat: 0.64,
    exposure: 1.02, envIntensity: 1.10, practical: 0.22, night: 0.0, hazeGlow: 1.35,
    twilight: srgb(0x243a66), twilightStrength: 0.06,
  },
  { // 0.93 — dusk
    t: 0.93, elev: -1.6, azim: 272,
    turbidity: 5.0, rayleigh: 3.6, mie: 0.008, mieG: 0.91, skyIntensity: 0.175, skyRolloff: 0.48, sunDisc: 12,
    cloudGain: 5.6, groundGain: 1.6,
    sun: srgb(0xff7a4e), sunIntensity: 0.48,
    hemiSky: srgb(0x63739f), hemiGround: srgb(0x5c4030), hemiIntensity: 0.64,
    rim: srgb(0x7183b8), rimIntensity: 0.30, bounce: srgb(0x9a6038), bounceIntensity: 0.28,
    fog: srgb(0x454c60), fogSun: srgb(0x8a5a4c), fogDensity: 0.0098,
    haze: srgb(0xff7346), hazeColor: srgb(0x5e6780), hazeStrength: 0.26, ground: srgb(0x332c27),
    cloudCover: 0.72, cloudHigh: 0.54, cloudLit: srgb(0xffcbb0), cloudShadow: srgb(0x505874),
    silver: 2.0, warmUnder: 0.9, sunGlow: 1.1, cloudSat: 0.70,
    exposure: 1.06, envIntensity: 1.12, practical: 0.85, night: 0.35, hazeGlow: 1.1,
    twilight: srgb(0x27406e), twilightStrength: 0.95,
  },
  { // 1.00 — blue hour
    t: 1.00, elev: -8, azim: 284,
    turbidity: 4.2, rayleigh: 3.0, mie: 0.007, mieG: 0.9, skyIntensity: 0.19, skyRolloff: 0.54, sunDisc: 4,
    cloudGain: 4.5, groundGain: 1.5,
    sun: srgb(0x6f83b4), sunIntensity: 0.10,
    hemiSky: srgb(0x46557f), hemiGround: srgb(0x3b2c22), hemiIntensity: 0.34,
    rim: srgb(0x506394), rimIntensity: 0.22, bounce: srgb(0x6a4630), bounceIntensity: 0.14,
    fog: srgb(0x232c46), fogSun: srgb(0x3d3a56), fogDensity: 0.0118,
    haze: srgb(0x8a6a86), hazeColor: srgb(0x3c4664), hazeStrength: 0.17, ground: srgb(0x22201f),
    cloudCover: 0.66, cloudHigh: 0.50, cloudLit: srgb(0x9aa4c8), cloudShadow: srgb(0x363d52),
    silver: 1.4, warmUnder: 0.5, sunGlow: 0.5, cloudSat: 0.60,
    exposure: 1.12, envIntensity: 1.18, practical: 1.0, night: 1.0, hazeGlow: 0.5,
    twilight: srgb(0x1d3260), twilightStrength: 1.05,
  },
];

const DEFAULT_TOD = 0.68;   // the reference frame

const _numericKeys = [
  'elev', 'azim', 'turbidity', 'rayleigh', 'mie', 'mieG', 'skyIntensity',
  'skyRolloff', 'sunDisc', 'cloudGain', 'groundGain',
  'sunIntensity', 'hemiIntensity', 'rimIntensity', 'bounceIntensity',
  'fogDensity', 'hazeStrength', 'cloudCover', 'cloudHigh',
  'silver', 'warmUnder', 'sunGlow', 'cloudSat',
  'exposure', 'envIntensity', 'practical', 'night', 'hazeGlow', 'twilightStrength',
];
const _colorKeys = [
  'sun', 'hemiSky', 'hemiGround', 'rim', 'bounce', 'fog', 'fogSun',
  'haze', 'hazeColor', 'ground', 'cloudLit', 'cloudShadow', 'twilight',
];

function makeBlankPreset() {
  const p = {};
  for (const k of _numericKeys) p[k] = 0;
  for (const k of _colorKeys) p[k] = new THREE.Color();
  return p;
}

/** Sample the keyframe table into `out` without allocating. */
function samplePreset(t, out) {
  t = clamp(t, 0, 1);
  let i = 0;
  while (i < TOD_STOPS.length - 2 && t > TOD_STOPS[i + 1].t) i++;
  const a = TOD_STOPS[i];
  const b = TOD_STOPS[i + 1];
  const span = Math.max(1e-5, b.t - a.t);
  let f = clamp((t - a.t) / span, 0, 1);
  f = f * f * (3 - 2 * f);                        // ease so the sun never snaps
  for (const k of _numericKeys) out[k] = lerp(a[k], b[k], f);
  for (const k of _colorKeys) out[k].lerpColors(a[k], b[k], f);
  return out;
}

// ---------------------------------------------------------------------------

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _right = new THREE.Vector3();
const _upAxis = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _box = new THREE.Box3();
const _center = new THREE.Vector3();
const _snapped = new THREE.Vector3();
const _fogTarget = new THREE.Color();
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const FALLBACK_UP = new THREE.Vector3(0, 0, 1);

const SHADOW_HALF_EXTENT = 28;   // metres — 56 m across, ~13.7 mm/texel at 4096
const SHADOW_DISTANCE = 72;
const MAX_PRACTICALS = 8;

export function createEnvironment(ctx) {
  const { scene, renderer, engine } = ctx;

  installHeightFog();

  // --- sky dome ------------------------------------------------------------
  const skyGeometry = new THREE.BoxGeometry(1, 1, 1);
  const skyMaterial = new THREE.ShaderMaterial({
    name: SkyShader.name,
    uniforms: THREE.UniformsUtils.clone(SkyShader.uniforms),
    vertexShader: SkyShader.vertexShader,
    fragmentShader: SkyShader.fragmentShader,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
    fog: false,
  });
  const SU = skyMaterial.uniforms;

  const sky = new THREE.Mesh(skyGeometry, skyMaterial);
  sky.name = 'SkyDome';
  sky.scale.setScalar(6000);
  sky.frustumCulled = false;
  // Drawn last among the opaques with depth test on: the dome sits exactly on
  // the far plane, so it only shades pixels no geometry claimed. That keeps the
  // (expensive) scattering + two-deck cloud shader off ~60% of the frame.
  sky.renderOrder = 1000;
  sky.matrixAutoUpdate = false;
  sky.updateMatrix();
  scene.add(sky);
  scene.background = null;

  // Second dome sharing the same material so the PMREM pass sees exactly the
  // sky the player sees, without re-parenting anything.
  const envScene = new THREE.Scene();
  const envSky = new THREE.Mesh(skyGeometry, skyMaterial);
  envSky.scale.setScalar(6000);
  envSky.frustumCulled = false;
  envSky.matrixAutoUpdate = false;
  envSky.updateMatrix();
  envScene.add(envSky);
  engine.envScene = envScene;

  // --- IBL -----------------------------------------------------------------
  const pmrem = new PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  let envRT = null;
  let envDirty = true;
  let envCooldown = 0;

  function regenerateEnvironment() {
    const prevDisc = SU.uShowSunDisc.value;
    // The disc is 34x brighter than the sky; leaving it in produces ringing in
    // the roughness mips. The DirectionalLight already carries that energy.
    SU.uShowSunDisc.value = 0;
    const prevRT = envRT;
    envRT = pmrem.fromScene(envScene, 0.02, 1, 20000);
    SU.uShowSunDisc.value = prevDisc;
    scene.environment = envRT.texture;
    if (prevRT) prevRT.dispose();
    envDirty = false;
    envCooldown = 0.25;
  }

  // --- sun -----------------------------------------------------------------
  const shadowSize = clamp((engine.tier?.shadowMap ?? 2048) * 2, 1024, 4096);
  const sun = new THREE.DirectionalLight(0xffd9ac, 2.30);
  sun.name = 'SunLight';
  sun.castShadow = true;
  sun.shadow.mapSize.set(shadowSize, shadowSize);
  sun.shadow.bias = -0.00026;
  sun.shadow.normalBias = 0.026;
  sun.shadow.radius = 2.2;
  sun.shadow.blurSamples = 12;
  {
    const c = sun.shadow.camera;
    c.left = -SHADOW_HALF_EXTENT;
    c.right = SHADOW_HALF_EXTENT;
    c.top = SHADOW_HALF_EXTENT;
    c.bottom = -SHADOW_HALF_EXTENT;
    c.near = 0.6;
    c.far = SHADOW_DISTANCE * 2.1;
    c.updateProjectionMatrix();
  }
  scene.add(sun);
  scene.add(sun.target);
  engine.sunLight = sun;

  // --- fill / bounce -------------------------------------------------------
  // Under a deck this carries most of the illumination, so it is much stronger
  // than a clear-sky rig would want. It is what keeps the ramps off black.
  const hemi = new THREE.HemisphereLight(0x9fbadd, 0x726557, 0.95);
  hemi.name = 'SkyBounce';
  scene.add(hemi);

  // Cool rim from the anti-sun side — separates the rider from warm concrete.
  const rimLight = new THREE.DirectionalLight(0x93b3e2, 0.34);
  rimLight.name = 'SkyRim';
  scene.add(rimLight, rimLight.target);

  // Warm ground bounce, aimed upward, keeps undersides off black. The lot is a
  // huge mid-grey concrete reflector; without this term nothing under a ramp lip
  // or a rider's arm reads at all.
  const bounceLight = new THREE.DirectionalLight(0xb59372, 0.34);
  bounceLight.name = 'GroundBounce';
  scene.add(bounceLight, bounceLight.target);

  // --- fog -----------------------------------------------------------------
  const fog = new THREE.FogExp2(0x9aa4b2, 0.0050);
  scene.fog = fog;

  // --- sun haze billboard --------------------------------------------------
  const hazeGeometry = new THREE.PlaneGeometry(1, 1);
  const hazeMaterial = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.clone(SunHazeShader.uniforms),
    vertexShader: SunHazeShader.vertexShader,
    fragmentShader: SunHazeShader.fragmentShader,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    fog: false,
  });
  const sunHaze = new THREE.Mesh(hazeGeometry, hazeMaterial);
  sunHaze.name = 'SunHaze';
  sunHaze.scale.setScalar(260);
  sunHaze.renderOrder = 6;
  scene.add(sunHaze);

  // --- practical lights (dusk) ---------------------------------------------
  const practicals = [];
  const bulbGeometry = new THREE.SphereGeometry(0.13, 8, 6);
  const bulbMaterial = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.clone(BulbShader.uniforms),
    vertexShader: BulbShader.vertexShader,
    fragmentShader: BulbShader.fragmentShader,
    fog: false,
  });
  const bulbs = new THREE.InstancedMesh(bulbGeometry, bulbMaterial, MAX_PRACTICALS);
  bulbs.name = 'PracticalBulbs';
  bulbs.count = 0;
  bulbs.visible = false;
  bulbs.frustumCulled = false;
  bulbs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(bulbs);

  for (let i = 0; i < MAX_PRACTICALS; i++) {
    const l = new THREE.PointLight(0xffab63, 0, 34, 2);
    l.name = `Practical${i}`;
    l.visible = false;
    l.castShadow = false;
    scene.add(l);
    practicals.push({ light: l, phase: rand(0, Math.PI * 2), rate: rand(1.7, 3.4), amp: rand(0.03, 0.09) });
  }
  let practicalsPlaced = false;

  /** Find the park's own lamp posts; otherwise ring the play area. */
  function placePracticals() {
    const park = ctx.world?.park;
    if (!park?.group) return false;

    const spots = [];
    park.group.traverse((o) => {
      if (spots.length >= MAX_PRACTICALS) return;
      const tag = o.userData?.practicalLight;
      const named = typeof o.name === 'string' && /lamp|lightpost|light_post|floodlight/i.test(o.name);
      if (tag || named) {
        o.getWorldPosition(_v1);
        spots.push(new THREE.Vector3(_v1.x, _v1.y + (typeof tag === 'number' ? tag : 5.4), _v1.z));
      }
    });

    if (spots.length === 0) {
      _box.setFromObject(park.group);
      if (_box.isEmpty()) return false;
      _box.getCenter(_center);
      const hx = clamp((_box.max.x - _box.min.x) * 0.42, 12, 46);
      const hz = clamp((_box.max.z - _box.min.z) * 0.42, 12, 46);
      const n = 8;
      const postY = clamp(_box.min.y, -3, 3) + 6.2;   // lamp head height above the lot
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + 0.32;
        spots.push(new THREE.Vector3(
          _center.x + Math.cos(a) * hx,
          postY,
          _center.z + Math.sin(a) * hz,
        ));
      }
    }

    const m = new THREE.Matrix4();
    for (let i = 0; i < practicals.length; i++) {
      const p = practicals[i];
      if (i < spots.length) {
        p.light.position.copy(spots[i]);
        m.makeTranslation(spots[i].x, spots[i].y, spots[i].z);
        bulbs.setMatrixAt(i, m);
      } else {
        p.light.visible = false;
      }
    }
    bulbs.count = Math.min(spots.length, MAX_PRACTICALS);
    bulbs.instanceMatrix.needsUpdate = true;
    return true;
  }

  // --- time of day ---------------------------------------------------------
  const preset = makeBlankPreset();
  const sunDir = new THREE.Vector3();
  let timeOfDay = DEFAULT_TOD;
  let cloudTime = 0;
  // Cloud-plane units per second. The two decks share a wind direction but the
  // low one is closer, so it sweeps across the frame noticeably faster — that
  // differential is the whole parallax cue.
  const wind = new THREE.Vector2(0.0165, 0.0072);

  function applyPreset() {
    const el = preset.elev * deg;
    const az = preset.azim * deg;
    // azimuth 0 = +Z (north), increasing clockwise toward +X (east)
    sunDir.set(
      Math.cos(el) * Math.sin(az),
      Math.sin(el),
      Math.cos(el) * Math.cos(az),
    ).normalize();

    // sky
    SU.uSunDirection.value.copy(sunDir);
    SU.uRayleigh.value = preset.rayleigh;
    SU.uTurbidity.value = preset.turbidity;
    SU.uMieCoefficient.value = preset.mie;
    SU.uMieDirectionalG.value = preset.mieG;
    SU.uSkyIntensity.value = preset.skyIntensity;
    SU.uSkyRolloff.value = preset.skyRolloff;
    SU.uSunDiscIntensity.value = preset.sunDisc;
    SU.uCloudGain.value = preset.cloudGain;
    SU.uGroundGain.value = preset.groundGain;
    SU.uCloudCover.value = preset.cloudCover;
    SU.uCloudCoverHigh.value = preset.cloudHigh;
    SU.uCloudLitTint.value.copy(preset.cloudLit);
    SU.uCloudShadowTint.value.copy(preset.cloudShadow);
    SU.uSilver.value = preset.silver;
    SU.uWarmUnder.value = preset.warmUnder;
    SU.uSunGlow.value = preset.sunGlow;
    SU.uCloudSat.value = preset.cloudSat;
    SU.uHazeTint.value.copy(preset.haze);
    SU.uHazeColor.value.copy(preset.hazeColor);
    SU.uHazeStrength.value = preset.hazeStrength;
    SU.uGroundColor.value.copy(preset.ground);
    SU.uTwilightColor.value.copy(preset.twilight);
    SU.uTwilightStrength.value = preset.twilightStrength;
    SU.uNight.value = preset.night;

    // key light
    sun.color.copy(preset.sun);
    sun.intensity = preset.sunIntensity;
    sun.visible = preset.sunIntensity > 0.02;
    sun.castShadow = preset.sunIntensity > 0.25;

    // fills
    hemi.color.copy(preset.hemiSky);
    hemi.groundColor.copy(preset.hemiGround);
    hemi.intensity = preset.hemiIntensity;

    rimLight.color.copy(preset.rim);
    rimLight.intensity = preset.rimIntensity;
    bounceLight.color.copy(preset.bounce);
    bounceLight.intensity = preset.bounceIntensity;

    // fog + exposure
    fog.color.copy(preset.fog);
    fog.density = preset.fogDensity;
    renderer.toneMappingExposure = preset.exposure;
    scene.environmentIntensity = preset.envIntensity;

    // sun haze
    hazeMaterial.uniforms.uColor.value.copy(preset.sun);
    hazeMaterial.uniforms.uShafts.value = lerp(0.25, 1.15, clamp(1 - preset.elev / 42, 0, 1));

    // practicals
    bulbMaterial.uniforms.uColor.value.setRGB(1.0, 0.66, 0.36);
    bulbMaterial.uniforms.uIntensity.value = preset.practical * 3.4;
  }

  function setTimeOfDay(t) {
    timeOfDay = clamp(t, 0, 1);
    samplePreset(timeOfDay, preset);
    applyPreset();
    envDirty = true;
  }

  /**
   * Re-centre the tight shadow ortho on `target`, snapping the centre to whole
   * shadow-map texels along the light basis so the map does not crawl.
   */
  function recenterShadows(target) {
    if (!target) return;
    _fwd.copy(sunDir).negate();                       // light -> scene
    _right.crossVectors(WORLD_UP, _fwd);
    if (_right.lengthSq() < 1e-6) _right.crossVectors(FALLBACK_UP, _fwd);
    _right.normalize();
    _upAxis.crossVectors(_fwd, _right).normalize();

    const texel = (SHADOW_HALF_EXTENT * 2) / sun.shadow.mapSize.x;
    const px = Math.round(target.dot(_right) / texel) * texel;
    const py = Math.round(target.dot(_upAxis) / texel) * texel;
    const pz = target.dot(_fwd);

    _snapped.set(0, 0, 0)
      .addScaledVector(_right, px)
      .addScaledVector(_upAxis, py)
      .addScaledVector(_fwd, pz);

    sun.target.position.copy(_snapped);
    sun.target.updateMatrixWorld();
    sun.position.copy(_snapped).addScaledVector(sunDir, SHADOW_DISTANCE);
    sun.updateMatrixWorld();

    // Keep the fills anchored to the player too so their direction stays stable.
    rimLight.target.position.copy(_snapped);
    rimLight.target.updateMatrixWorld();
    rimLight.position.copy(_snapped)
      .addScaledVector(_right, -60)
      .addScaledVector(WORLD_UP, 34)
      .addScaledVector(sunDir, -26);
    rimLight.updateMatrixWorld();

    bounceLight.target.position.copy(_snapped).addScaledVector(WORLD_UP, 8);
    bounceLight.target.updateMatrixWorld();
    bounceLight.position.copy(_snapped)
      .addScaledVector(sunDir, -34)
      .addScaledVector(WORLD_UP, -12);
    bounceLight.updateMatrixWorld();
  }

  setTimeOfDay(DEFAULT_TOD);
  recenterShadows(_v2.set(0, 0, 0));
  regenerateEnvironment();

  // --- frame update --------------------------------------------------------
  let fogBlend = 0;

  function update(dt, c = ctx) {
    const step = Math.min(dt, 0.1);

    // Drift both decks. The low deck is nearer, so it moves ~2.3x faster across
    // the frame; wrap to keep the noise coordinates in a friendly float range.
    cloudTime += step;
    const dLow = SU.uDriftLow.value;
    dLow.x = (dLow.x + wind.x * step) % 4096;
    dLow.y = (dLow.y + wind.y * step) % 4096;
    const dHigh = SU.uDriftHigh.value;
    dHigh.x = (dHigh.x + wind.x * 0.43 * step) % 4096;
    dHigh.y = (dHigh.y + wind.y * 0.43 * step) % 4096;

    // follow the player with the shadow frustum
    const pos = c.player?.physics?.state?.position;
    recenterShadows(pos || _v2.set(0, 0, 0));

    const cam = c.camera;
    if (cam) {
      // --- steer the aerial-perspective haze ------------------------------
      // A single fog colour cannot be both the cool grey of the anti-sun
      // distance and the warm wash in front of a low sun. Blend the two ends of
      // the preset by how far the camera is turned into the sun, damped so a
      // fast whip-pan does not strobe the whole frame.
      cam.getWorldDirection(_v1);
      const fa = Math.hypot(_v1.x, _v1.z) || 1;
      const sa = Math.hypot(sunDir.x, sunDir.z) || 1;
      const align = clamp(((_v1.x * sunDir.x + _v1.z * sunDir.z) / (fa * sa)) * 0.5 + 0.5, 0, 1);
      const lowSun = clamp(1 - Math.abs(preset.elev) / 46, 0, 1);
      const wantBlend = Math.pow(align, 2.4) * (0.30 + 0.70 * lowSun);
      fogBlend += (wantBlend - fogBlend) * (1 - Math.exp(-2.6 * step));
      _fogTarget.copy(preset.fog).lerp(preset.fogSun, fogBlend);
      fog.color.copy(_fogTarget);

      // --- sun haze / crepuscular billboard --------------------------------
      sunHaze.position.copy(cam.position).addScaledVector(sunDir, 360);
      sunHaze.quaternion.copy(cam.quaternion);
      const facing = clamp(_v1.dot(sunDir), 0, 1);
      const above = clamp((preset.elev + 4) / 8, 0, 1);
      const amount = preset.hazeGlow * (0.14 + 0.86 * Math.pow(facing, 2.0)) *
        (0.30 + 0.70 * lowSun) * above;
      hazeMaterial.uniforms.uIntensity.value = amount;
      hazeMaterial.uniforms.uTime.value = cloudTime;
      sunHaze.visible = amount > 0.002;
    }

    // practicals: place once the park exists, then flicker gently
    if (!practicalsPlaced) practicalsPlaced = placePracticals();
    const pf = preset.practical;
    const lit = pf > 0.02;
    bulbs.visible = lit && bulbs.count > 0;
    for (let i = 0; i < practicals.length; i++) {
      const p = practicals[i];
      if (!lit || i >= bulbs.count) { p.light.visible = false; continue; }
      p.light.visible = true;
      const flick = 1 + Math.sin(cloudTime * p.rate + p.phase) * p.amp;
      p.light.intensity = 42 * pf * flick;
    }

    // deferred IBL refresh — never more than once every quarter second
    if (envCooldown > 0) envCooldown -= step;
    if (envDirty && envCooldown <= 0) regenerateEnvironment();
  }

  function dispose() {
    scene.remove(sky, sunHaze, bulbs, hemi, sun, sun.target, rimLight, rimLight.target, bounceLight, bounceLight.target);
    for (const p of practicals) scene.remove(p.light);
    envScene.remove(envSky);

    skyGeometry.dispose();
    skyMaterial.dispose();
    hazeGeometry.dispose();
    hazeMaterial.dispose();
    bulbGeometry.dispose();
    bulbMaterial.dispose();
    bulbs.dispose();

    sun.shadow.dispose();
    if (envRT) { envRT.dispose(); envRT = null; }
    pmrem.dispose();

    scene.environment = null;
    scene.fog = null;
    if (engine.sunLight === sun) engine.sunLight = null;
    if (engine.envScene === envScene) engine.envScene = null;
    uninstallHeightFog();
  }

  return {
    sun, hemi, sky,
    rimLight, bounceLight, sunHaze, fog, envScene,
    sunDirection: sunDir,
    get timeOfDay() { return timeOfDay; },
    get envMap() { return envRT ? envRT.texture : null; },
    /** Cloud wind in cloud-plane units/second (low deck; the high deck follows). */
    setWind(x, y) { wind.set(x, y); },
    /** Force an IBL rebuild on the next update (e.g. after a park rebuild). */
    invalidateEnvironment() { envDirty = true; },
    setTimeOfDay,
    recenterShadows,
    update,
    dispose,
  };
}
