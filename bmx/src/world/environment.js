// Sky, lighting rig, image-based lighting, height fog and time of day.
//
// The sky is a single analytic-scattering dome (Preetham-flavoured) with two
// procedural cloud decks, a horizon haze band, a ground-bounce hemisphere and a
// star field for dusk. That same dome is rendered into a PMREM cube so every PBR
// material in the park is lit by the real sky instead of a constant ambient.
//
// Default state at boot is late-afternoon golden hour: sun at ~22 degrees, warm
// key, cool sky bounce, long shadows, dusty air.

import * as THREE from 'three';
import { PMREMGenerator } from 'three';
import { clamp, lerp, rand, deg } from '../core/mathx.js';

// ---------------------------------------------------------------------------
// Height fog: patch the shared fog chunks so density falls off with altitude.
// Ground haze stays thick, the park and the skyline tops stay crisp. Colour and
// density still come from scene.fog so the renderer keeps refreshing them.
// ---------------------------------------------------------------------------

const FOG_BASE_HEIGHT = 0.0;      // metres — where the haze layer sits
const FOG_HEIGHT_FALLOFF = 0.062; // 1/m — density halves every ~11 m of altitude

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
    gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
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

    uCloudDrift: { value: new THREE.Vector2(0, 0) },
    uCloudCover: { value: 0.42 },
    uCloudScale: { value: 1.10 },
    uCloudOpacity: { value: 0.95 },
    uCloudGain: { value: 1.35 },
    uCirrusCover: { value: 0.42 },
    uCloudShadowTint: { value: new THREE.Color(0.33, 0.38, 0.52) },
    uCloudLitTint: { value: new THREE.Color(1.0, 0.86, 0.68) },

    uHazeTint: { value: new THREE.Color(1.0, 0.72, 0.46) },
    uHazeStrength: { value: 0.18 },
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
      sunFex = max( sunFex, vec3( sunFexMax * 0.20 ) );
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

    uniform vec2 uCloudDrift;
    uniform float uCloudCover;
    uniform float uCloudScale;
    uniform float uCloudOpacity;
    uniform float uCloudGain;
    uniform float uCirrusCover;
    uniform vec3 uCloudShadowTint;
    uniform vec3 uCloudLitTint;

    uniform vec3 uHazeTint;
    uniform float uHazeStrength;
    uniform vec3 uGroundColor;
    uniform float uGroundGain;
    uniform vec3 uTwilightColor;
    uniform float uTwilightStrength;
    uniform float uNight;

    const float pi = 3.141592653589793;
    const vec3 up = vec3( 0.0, 1.0, 0.0 );

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

    // Both fbm variants are normalised to 0..1 so the coverage thresholds below
    // behave the same however many octaves are used.
    float fbm4( vec2 p ) {
      float v = 0.0, a = 0.5, n = 0.0;
      for ( int i = 0; i < 4; i ++ ) {
        v += a * vnoise( p );
        n += a;
        p = M2 * p * 2.06 + 11.3;
        a *= 0.5;
      }
      return v / n;
    }

    float fbm6( vec2 p ) {
      float v = 0.0, a = 0.5, n = 0.0;
      for ( int i = 0; i < 6; i ++ ) {
        v += a * vnoise( p );
        n += a;
        p = M2 * p * 2.03 + 7.1;
        a *= 0.52;
      }
      return v / n;
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
      float corrL = dot( corr, vec3( 0.2126, 0.7152, 0.0722 ) );
      float corrW = clamp( pow( 1.0 - dot( up, vSunDirection ), 5.0 ), 0.0, 0.6 );
      Lin *= mix( vec3( 1.0 ), mix( vec3( corrL ), corr, 0.45 ), corrW );

      vec3 col = ( Lin + vec3( 0.09 ) * Fex ) * 0.04;

      // Preetham's aureole trends blue-white; push it toward the sun's own
      // extinguished colour in proportion to the Mie share of the scattering,
      // which is what actually makes a low sun glow orange.
      float mieShare = dot( betaMTheta, vec3( 1.0 ) ) / max( dot( betaRTheta + betaMTheta, vec3( 1.0 ) ), 1e-9 );
      float aureoleW = pow( max( cosTheta, 0.0 ), 3.0 );
      vec3 sunHue = clamp( vSunIrradiance / max( dot( vSunIrradiance, vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-4 ), 0.0, 2.6 );
      sunHue = mix( vec3( 1.0 ), sunHue, 0.88 );   // never fully kill a channel
      // forward hemisphere only — the anti-sun sky must stay blue
      float tintW = clamp( aureoleW * 0.9 + mieShare * 0.4 * max( cosTheta, 0.0 ), 0.0, 0.9 );
      col = mix( col, col * sunHue, tintW );

      // direct sunlight reaching the cloud deck, already scaled to sky units
      vec3 sunIrr = vSunIrradiance;
      // lambertian cloud top, albedo ~0.72
      vec3 cloudLit = sunIrr * 0.229 * uCloudGain * uCloudLitTint;
      float sunLumV = dot( sunIrr, vec3( 0.2126, 0.7152, 0.0722 ) );

      // --- cumulus deck -----------------------------------------------------
      float above = smoothstep( 0.0, 0.035, direction.y );
      if ( above > 0.0 && uCloudOpacity > 0.001 ) {
        // soft cloud-plane projection; the +0.13 keeps the horizon from
        // compressing into aliasing-grade high frequency
        vec2 cuv = direction.xz / ( direction.y + 0.13 ) * uCloudScale + uCloudDrift;

        // domain warp keeps the deck from looking like tiled noise
        vec2 warp = vec2( fbm4( cuv * 0.42 + 3.1 ), fbm4( cuv * 0.42 + 17.7 ) ) - 0.5;
        vec2 puv = cuv + warp * 1.35;

        // value-noise fbm clusters around 0.5; stretch it before thresholding or
        // the coverage control does nothing
        float base = smoothstep( 0.36, 0.70, fbm6( puv ) );
        float thr = 1.0 - uCloudCover;
        float density = smoothstep( thr, thr + 0.22 * uCloudCover + 0.06, base );

        // erode the edges with a higher-frequency pass so silhouettes are wispy
        float detail = fbm4( puv * 3.4 + 21.0 );
        density = clamp( density - ( 1.0 - density ) * ( detail - 0.34 ) * 1.1, 0.0, 1.0 );
        density *= smoothstep( 0.0, 0.10, direction.y );

        if ( density > 0.002 ) {
          // fake self-shadowing: look up-sun through the field
          vec2 sunStep = normalize( vSunDirection.xz + vec2( 1e-4, 1e-4 ) ) * 0.55;
          float upSun = smoothstep( 0.36, 0.70, fbm6( puv + sunStep ) );
          float lit = smoothstep( -0.30, 0.16, upSun - base + 0.05 );
          lit = mix( 0.30, 1.0, lit );

          // bases stay in shadow, tops catch the warm key
          float tops = smoothstep( 0.05, 0.85, base );
          lit = clamp( lit * ( 0.55 + 0.45 * tops ), 0.0, 1.0 );

          // shadowed side is lit by the sky dome plus a little bounced sun
          float skyLum = dot( col, vec3( 0.2126, 0.7152, 0.0722 ) );
          vec3 cloudShade = uCloudShadowTint * ( skyLum * 2.4 + sunLumV * 0.05 ) * uCloudGain;

          vec3 cc = mix( cloudShade, cloudLit, lit );

          // forward-scattered silver lining on the sun side
          cc += cloudLit * hgPhase( cosTheta, 0.78 ) * 1.5 * ( 1.0 - density * 0.65 );

          // aerial perspective: distant / low cloud fades into the sky
          float horizonMix = 0.08 + 0.62 * ( 1.0 - smoothstep( 0.04, 0.32, direction.y ) );
          cc = mix( cc, col, horizonMix );

          col = mix( col, cc, density * uCloudOpacity * above );
        }
      }

      // --- high cirrus ------------------------------------------------------
      if ( direction.y > 0.02 && uCirrusCover > 0.001 ) {
        vec2 huv = direction.xz / ( direction.y + 0.09 ) * ( uCloudScale * 0.42 ) + uCloudDrift * 0.42;
        huv.x *= 0.30;                       // stretched, wind-combed streaks
        float h = smoothstep( 0.38, 0.68, fbm4( huv * 1.9 + 41.0 ) );
        float ha = smoothstep( 0.55, 0.95, h ) * uCirrusCover;
        ha *= smoothstep( 0.02, 0.30, direction.y );
        vec3 hc = cloudLit * 1.18 + cloudLit * hgPhase( cosTheta, 0.62 ) * 0.9;
        col = mix( col, mix( col, hc, 0.72 ), ha * 0.55 );
      }

      // --- horizon haze band -------------------------------------------------
      float hz = pow( 1.0 - abs( direction.y ), 7.0 );
      float sunSide = 0.30 + 0.70 * pow( max( dot( normalize( direction.xz + 1e-5 ), normalize( vSunDirection.xz + 1e-5 ) ) * 0.5 + 0.5, 0.0 ), 2.2 );
      col += uHazeTint * hz * uHazeStrength * sunSide * ( 0.35 + 0.55 * sunLumV );

      // --- twilight ----------------------------------------------------------
      // Preetham's earth-shadow hack drops to zero the moment the sun sets, so
      // hand back the residual scattered light that makes blue hour readable.
      float twilight = smoothstep( 0.11, -0.15, vSunDirection.y ) * uTwilightStrength;
      if ( twilight > 0.001 ) {
        float azim = dot( normalize( direction.xz + 1e-5 ), normalize( vSunDirection.xz + 1e-5 ) ) * 0.5 + 0.5;
        vec3 tw = uTwilightColor * ( 0.42 + 0.58 * pow( 1.0 - abs( direction.y ), 2.4 ) );
        tw *= 0.55 + 0.85 * pow( azim, 2.0 );
        // low warm afterglow hugging the horizon on the sun side
        tw += uHazeTint * uTwilightColor.b * 2.6 * pow( azim, 5.0 ) * pow( max( 1.0 - abs( direction.y ) * 3.4, 0.0 ), 2.0 );
        // specified in post-exposure units so the presets stay readable
        col += tw * twilight / max( uSkyIntensity, 1e-3 );
      }

      // --- ground bounce hemisphere (drives the lower half of the IBL) -------
      if ( direction.y < 0.02 ) {
        float t = smoothstep( 0.02, -0.16, direction.y );
        // albedo/pi * (direct sun on a flat lot + sky ambient)
        vec3 g = uGroundColor * uGroundGain * ( sunIrr * 0.318 * max( vSunDirection.y, 0.0 ) + col * 0.62 );
        // a little forward glint back toward the sun
        g *= 1.0 + 0.55 * pow( max( dot( normalize( direction.xz + 1e-5 ), normalize( vSunDirection.xz + 1e-5 ) ), 0.0 ), 3.0 );
        col = mix( col, g, t );
      }

      // --- stars at dusk ------------------------------------------------------
      if ( uNight > 0.001 && direction.y > 0.0 ) {
        vec2 suv = vec2( atan( direction.z, direction.x ), acos( clamp( direction.y, -1.0, 1.0 ) ) ) * 210.0;
        vec2 sc = floor( suv );
        vec2 sf = fract( suv ) - 0.5;
        float pick = hash21( sc + 3.0 );
        vec2 jitter = ( vec2( hash21( sc + 11.0 ), hash21( sc + 23.0 ) ) - 0.5 ) * 0.7;
        float d = length( sf - jitter );
        float star = step( 0.9855, pick ) * exp( -d * d * 90.0 ) * ( 0.35 + 0.65 * hash21( sc + 41.0 ) );
        col += vec3( 0.82, 0.88, 1.0 ) * star * uNight * 0.09 * smoothstep( 0.02, 0.28, direction.y );
      }

      // Sky exposure, then a soft shoulder. Preetham radiance spans four orders
      // of magnitude; without this the whole sun side clips to flat white under
      // ACES at exposure 1.05.
      col *= uSkyTint * uSkyIntensity;
      // Compress on luminance, not per channel, so the aureole rolls off as a
      // warm gradient instead of clipping to flat white. A little per-channel
      // compression is blended back in so the very core still whitens.
      float skyL = dot( col, vec3( 0.2126, 0.7152, 0.0722 ) );
      float skyLc = skyL / ( 1.0 + skyL * uSkyRolloff );
      col = mix( col * ( skyLc / max( skyL, 1e-5 ) ), col / ( 1.0 + col * uSkyRolloff ), 0.22 );

      // --- sun disc, added past the shoulder so it still blows out and blooms --
      float discMask = smoothstep( sunAngularDiameterCos, sunAngularDiameterCos + 0.000018, cosTheta );
      float limb = 0.55 + 0.45 * sqrt( max( 0.0, 1.0 - pow( ( 1.0 - cosTheta ) / ( 1.0 - sunAngularDiameterCos ), 2.0 ) ) );
      vec3 discHue = Fex / max( max( Fex.r, max( Fex.g, Fex.b ) ), 1e-4 );
      vec3 disc = discHue * uSunDiscIntensity * uShowSunDisc *
        ( discMask * limb + 0.055 * pow( max( cosTheta, 0.0 ), 380.0 ) );
      col += min( disc, vec3( 90.0 ) );

      gl_FragColor = vec4( max( col, 0.0 ), 1.0 );

      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }
  `,
};

// Additive aureole billboard that sits on the sun direction. Cheap stand-in for
// volumetric god rays; it also feeds the bloom pass so low sun blooms properly.
const SunHazeShader = {
  uniforms: {
    uColor: { value: new THREE.Color(1.0, 0.72, 0.42) },
    uIntensity: { value: 1.0 },
    uStreak: { value: 0.55 },
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
    uniform float uStreak;
    varying vec2 vUv;
    void main() {
      vec2 p = vUv * 2.0 - 1.0;
      float r = length( p );
      float core = exp( -r * r * 64.0 ) * 1.9;
      float aureole = exp( -r * 5.4 ) * 0.30;
      float streak = exp( -abs( p.x ) * 3.2 ) * exp( -abs( p.y ) * 60.0 ) * uStreak;
      float ring = smoothstep( 0.58, 0.45, r ) * smoothstep( 0.32, 0.45, r ) * 0.05;
      float a = ( core + aureole + streak + ring ) * uIntensity;
      a *= smoothstep( 1.0, 0.55, r );
      gl_FragColor = vec4( uColor * max( a, 0.0 ), 1.0 );
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
// ---------------------------------------------------------------------------

function srgb(hex) { return new THREE.Color().setHex(hex, THREE.SRGBColorSpace); }

const TOD_STOPS = [
  { // 0.00 — dawn
    t: 0.00, elev: 1.2, azim: 84,
    turbidity: 4.2, rayleigh: 3.3, mie: 0.0075, mieG: 0.9, skyIntensity: 0.28, skyRolloff: 0.5, sunDisc: 20, cloudGain: 4.5, groundGain: 1.5,
    sun: srgb(0xff9a58), sunIntensity: 0.9,
    hemiSky: srgb(0x5d7196), hemiGround: srgb(0x4a3a2e), hemiIntensity: 0.30,
    rim: srgb(0x7f9ecb), rimIntensity: 0.22, bounce: srgb(0x8a6a4a), bounceIntensity: 0.16,
    fog: srgb(0x6e5347), fogDensity: 0.0092,
    haze: srgb(0xff8a4a), hazeStrength: 0.3, ground: srgb(0x3a3028),
    cloudCover: 0.4, cirrus: 0.34, cloudLit: srgb(0xffd9b8), cloudShadow: srgb(0x5a5a78),
    exposure: 0.98, envIntensity: 1.0, practical: 0.55, night: 0.28, hazeGlow: 0.9, twilight: srgb(0x22345c), twilightStrength: 1.05,
  },
  { // 0.14 — morning
    t: 0.14, elev: 15, azim: 95,
    turbidity: 3.2, rayleigh: 2.5, mie: 0.0052, mieG: 0.885, skyIntensity: 0.17, skyRolloff: 0.44, sunDisc: 44, cloudGain: 1.5, groundGain: 1.6,
    sun: srgb(0xffc78d), sunIntensity: 2.35,
    hemiSky: srgb(0x8fb0dd), hemiGround: srgb(0x5c4b3a), hemiIntensity: 0.45,
    rim: srgb(0x9dbde8), rimIntensity: 0.26, bounce: srgb(0x9a7a55), bounceIntensity: 0.18,
    fog: srgb(0xc7b3a2), fogDensity: 0.0082,
    haze: srgb(0xffb27a), hazeStrength: 0.2, ground: srgb(0x4a4038),
    cloudCover: 0.43, cirrus: 0.44, cloudLit: srgb(0xfff0dc), cloudShadow: srgb(0x6c7896),
    exposure: 1.00, envIntensity: 1.0, practical: 0.08, night: 0.0, hazeGlow: 0.55, twilight: srgb(0x22345c), twilightStrength: 0.0,
  },
  { // 0.33 — noon
    t: 0.33, elev: 66, azim: 176,
    turbidity: 2.3, rayleigh: 1.7, mie: 0.0035, mieG: 0.86, skyIntensity: 0.145, skyRolloff: 0.4, sunDisc: 55, cloudGain: 1.0, groundGain: 1.6,
    sun: srgb(0xfff4e6), sunIntensity: 3.55,
    hemiSky: srgb(0xaecdf5), hemiGround: srgb(0x6a5b48), hemiIntensity: 0.40,
    rim: srgb(0xb7d2f7), rimIntensity: 0.22, bounce: srgb(0xa08a68), bounceIntensity: 0.20,
    fog: srgb(0xb9c8da), fogDensity: 0.0048,
    haze: srgb(0xd8dbe0), hazeStrength: 0.13, ground: srgb(0x565049),
    cloudCover: 0.36, cirrus: 0.34, cloudLit: srgb(0xffffff), cloudShadow: srgb(0x7c8aa8),
    exposure: 1.00, envIntensity: 1.0, practical: 0.0, night: 0.0, hazeGlow: 0.35, twilight: srgb(0x2a3a60), twilightStrength: 0.0,
  },
  { // 0.52 — afternoon
    t: 0.52, elev: 43, azim: 226,
    turbidity: 2.6, rayleigh: 2.0, mie: 0.004, mieG: 0.87, skyIntensity: 0.156, skyRolloff: 0.41, sunDisc: 52, cloudGain: 1.05, groundGain: 1.6,
    sun: srgb(0xffe9c9), sunIntensity: 3.30,
    hemiSky: srgb(0xa6c6ee), hemiGround: srgb(0x6d5a44), hemiIntensity: 0.40,
    rim: srgb(0xa8c8f2), rimIntensity: 0.24, bounce: srgb(0xa88a62), bounceIntensity: 0.22,
    fog: srgb(0xc2c6c9), fogDensity: 0.0055,
    haze: srgb(0xeccfa8), hazeStrength: 0.16, ground: srgb(0x554d43),
    cloudCover: 0.39, cirrus: 0.38, cloudLit: srgb(0xfff6e8), cloudShadow: srgb(0x74809c),
    exposure: 1.02, envIntensity: 1.0, practical: 0.0, night: 0.0, hazeGlow: 0.5, twilight: srgb(0x2a3a60), twilightStrength: 0.0,
  },
  { // 0.68 — GOLDEN HOUR (default boot state, sun ~22 degrees)
    t: 0.68, elev: 22, azim: 252,
    turbidity: 3.1, rayleigh: 2.7, mie: 0.0046, mieG: 0.895, skyIntensity: 0.15, skyRolloff: 0.4, sunDisc: 40, cloudGain: 1.35, groundGain: 1.7,
    sun: srgb(0xffdcb4), sunIntensity: 3.05,
    hemiSky: srgb(0x8fb4e8), hemiGround: srgb(0x7a5a3a), hemiIntensity: 0.42,
    rim: srgb(0x8fb2e6), rimIntensity: 0.30, bounce: srgb(0xc08d54), bounceIntensity: 0.28,
    fog: srgb(0xc6a583), fogDensity: 0.0046,
    haze: srgb(0xffb069), hazeStrength: 0.24, ground: srgb(0x4e4237),
    cloudCover: 0.42, cirrus: 0.42, cloudLit: srgb(0xffd8a8), cloudShadow: srgb(0x5b6688),
    exposure: 1.05, envIntensity: 1.0, practical: 0.0, night: 0.0, hazeGlow: 1.0, twilight: srgb(0x243a66), twilightStrength: 0.0,
  },
  { // 0.84 — low sun
    t: 0.84, elev: 6, azim: 268,
    turbidity: 4.2, rayleigh: 3.4, mie: 0.0065, mieG: 0.905, skyIntensity: 0.18, skyRolloff: 0.45, sunDisc: 28, cloudGain: 3.6, groundGain: 1.7,
    sun: srgb(0xff9f61), sunIntensity: 1.95,
    hemiSky: srgb(0x7a94c8), hemiGround: srgb(0x7d5334), hemiIntensity: 0.30,
    rim: srgb(0x8098d0), rimIntensity: 0.30, bounce: srgb(0xc07a42), bounceIntensity: 0.26,
    fog: srgb(0xcc8f66), fogDensity: 0.0066,
    haze: srgb(0xff8a44), hazeStrength: 0.34, ground: srgb(0x453a31),
    cloudCover: 0.38, cirrus: 0.3, cloudLit: srgb(0xffdcc0), cloudShadow: srgb(0x545e84),
    exposure: 1.06, envIntensity: 1.0, practical: 0.22, night: 0.0, hazeGlow: 1.35, twilight: srgb(0x243a66), twilightStrength: 0.06,
  },
  { // 0.93 — dusk
    t: 0.93, elev: -1.6, azim: 276,
    turbidity: 5.2, rayleigh: 3.7, mie: 0.008, mieG: 0.91, skyIntensity: 0.195, skyRolloff: 0.5, sunDisc: 13, cloudGain: 6.5, groundGain: 1.6,
    sun: srgb(0xff7a4e), sunIntensity: 0.52,
    hemiSky: srgb(0x5a6a9c), hemiGround: srgb(0x5c4030), hemiIntensity: 0.24,
    rim: srgb(0x6d80b8), rimIntensity: 0.26, bounce: srgb(0x9a6038), bounceIntensity: 0.18,
    fog: srgb(0x4a3d48), fogDensity: 0.0108,
    haze: srgb(0xff6f3c), hazeStrength: 0.3, ground: srgb(0x332c27),
    cloudCover: 0.4, cirrus: 0.32, cloudLit: srgb(0xffcbb0), cloudShadow: srgb(0x424c70),
    exposure: 1.10, envIntensity: 1.05, practical: 0.85, night: 0.35, hazeGlow: 1.1, twilight: srgb(0x27406e), twilightStrength: 0.95,
  },
  { // 1.00 — blue hour
    t: 1.00, elev: -8, azim: 284,
    turbidity: 4.2, rayleigh: 3.0, mie: 0.007, mieG: 0.9, skyIntensity: 0.2, skyRolloff: 0.56, sunDisc: 4, cloudGain: 5.0, groundGain: 1.5,
    sun: srgb(0x6f83b4), sunIntensity: 0.10,
    hemiSky: srgb(0x3f4e77), hemiGround: srgb(0x3b2c22), hemiIntensity: 0.18,
    rim: srgb(0x4c5e90), rimIntensity: 0.20, bounce: srgb(0x6a4630), bounceIntensity: 0.12,
    fog: srgb(0x1e2740), fogDensity: 0.0125,
    haze: srgb(0x8a6a86), hazeStrength: 0.18, ground: srgb(0x22201f),
    cloudCover: 0.4, cirrus: 0.34, cloudLit: srgb(0x9aa4c8), cloudShadow: srgb(0x2c3450),
    exposure: 1.16, envIntensity: 1.15, practical: 1.0, night: 1.0, hazeGlow: 0.5, twilight: srgb(0x1d3260), twilightStrength: 1.05,
  },
];

const DEFAULT_TOD = 0.68;   // golden hour

const _numericKeys = [
  'elev', 'azim', 'turbidity', 'rayleigh', 'mie', 'mieG', 'skyIntensity',
  'skyRolloff', 'sunDisc', 'cloudGain', 'groundGain',
  'sunIntensity', 'hemiIntensity', 'rimIntensity', 'bounceIntensity',
  'fogDensity', 'hazeStrength', 'cloudCover', 'cirrus',
  'exposure', 'envIntensity', 'practical', 'night', 'hazeGlow', 'twilightStrength',
];
const _colorKeys = ['sun', 'hemiSky', 'hemiGround', 'rim', 'bounce', 'fog', 'haze', 'ground', 'cloudLit', 'cloudShadow', 'twilight'];

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
  // (expensive) scattering + cloud shader off ~60% of the frame.
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
    // The disc is 40x brighter than the sky; leaving it in produces ringing in
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
  const sun = new THREE.DirectionalLight(0xffdcb4, 3.05);
  sun.name = 'SunLight';
  sun.castShadow = true;
  sun.shadow.mapSize.set(shadowSize, shadowSize);
  sun.shadow.bias = -0.00028;
  sun.shadow.normalBias = 0.028;
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
  const hemi = new THREE.HemisphereLight(0x8fb4e8, 0x7a5a3a, 0.42);
  hemi.name = 'SkyBounce';
  scene.add(hemi);

  // Cool rim from the anti-sun side — separates the rider from warm concrete.
  const rimLight = new THREE.DirectionalLight(0x8fb2e6, 0.30);
  rimLight.name = 'SkyRim';
  scene.add(rimLight, rimLight.target);

  // Warm ground bounce, aimed upward, keeps undersides from going black.
  const bounceLight = new THREE.DirectionalLight(0xc08d54, 0.28);
  bounceLight.name = 'GroundBounce';
  scene.add(bounceLight, bounceLight.target);

  // --- fog -----------------------------------------------------------------
  const fog = new THREE.FogExp2(0xd0b18c, 0.0094);
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
  sunHaze.scale.setScalar(230);
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
  const wind = new THREE.Vector2(0.0155, 0.0068);   // cloud-plane units per second

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
    SU.uCirrusCover.value = preset.cirrus;
    SU.uCloudLitTint.value.copy(preset.cloudLit);
    SU.uCloudShadowTint.value.copy(preset.cloudShadow);
    SU.uHazeTint.value.copy(preset.haze);
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
    hazeMaterial.uniforms.uStreak.value = lerp(0.25, 0.85, clamp(1 - preset.elev / 45, 0, 1));

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
  function update(dt, c = ctx) {
    const step = Math.min(dt, 0.1);

    // drift the cloud decks; wrap to keep noise coords in a friendly range
    cloudTime += step;
    const drift = SU.uCloudDrift.value;
    drift.x = (drift.x + wind.x * step) % 4096;
    drift.y = (drift.y + wind.y * step) % 4096;

    // follow the player with the shadow frustum
    const pos = c.player?.physics?.state?.position;
    recenterShadows(pos || _v2.set(0, 0, 0));

    // sun haze billboard: park it on the sun ray in front of the camera
    const cam = c.camera;
    if (cam) {
      sunHaze.position.copy(cam.position).addScaledVector(sunDir, 340);
      sunHaze.quaternion.copy(cam.quaternion);
      cam.getWorldDirection(_v1);
      const facing = clamp(_v1.dot(sunDir), 0, 1);
      const lowSun = clamp(1 - Math.abs(preset.elev) / 40, 0, 1);
      const above = clamp((preset.elev + 4) / 8, 0, 1);
      const amount = preset.hazeGlow * (0.18 + 0.82 * Math.pow(facing, 2.2)) * (0.35 + 0.65 * lowSun) * above;
      hazeMaterial.uniforms.uIntensity.value = amount;
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
    /** Cloud wind in cloud-plane units/second. */
    setWind(x, y) { wind.set(x, y); },
    /** Force an IBL rebuild on the next update (e.g. after a park rebuild). */
    invalidateEnvironment() { envDirty = true; },
    setTimeOfDay,
    recenterShadows,
    update,
    dispose,
  };
}
