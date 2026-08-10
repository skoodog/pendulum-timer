// Renderer, post-processing chain and quality tiers. This is the spine — systems
// hang off it but must not rewrite it.
//
// Three things live here that are easy to miss because they are installed into
// three's own shader chunks rather than into a pass:
//
//   1. PCSS contact-hardening shadows  (installContactShadows)
//   2. A filmic tone curve with a real shoulder (installToneCurve)
//   3. A clamp on what the bloom pass is allowed to see (clampBloomHighlights)
//
// All three are global, idempotent, and installed once at module scope.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { clamp } from './mathx.js';

// ===========================================================================
// 1. CONTACT-HARDENING SHADOWS (PCSS)
// ===========================================================================
// three r185 removed PCFSoftShadowMap (it now silently degrades to a 5-tap
// PCFShadowMap and prints a deprecation warning), which is why every shadow in
// the park had one constant, stair-stepped width no matter how far the caster
// was from the surface: `shadow.radius` was being applied as a fixed texel blur
// and `blurSamples` was ignored outright.
//
// The fix is a real variable-penumbra sampler. We run the renderer in
// BasicShadowMap mode — the only mode whose shadow map is bound as a plain
// `sampler2D`, so the shader can *read* the stored depth rather than only ask
// the hardware for a comparison result — and replace three's one-tap
// `getShadow()` with a blocker-search + variable-width PCF.
//
// `shadowRadius` is repurposed as the penumbra slope: filter width in shadow
// texels per unit of normalised depth gap between receiver and blocker. It is
// recomputed every frame from the live shadow-camera extents (see
// `updateShadowPenumbra`), so the penumbra comes out as a real world size —
// ~2 cm where a tyre touches the concrete, ~40 cm at the lip of a 3 m
// quarterpipe — and stays that size when the shadow frustum is re-fitted.

const PCSS_GET_SHADOW = /* glsl */`
		// --- PCSS, injected by src/core/engine.js -------------------------
		#define PCSS_CONTACT 1.6          // texels: the hard floor at contact
		#define PCSS_MAX_PENUMBRA 30.0    // texels: cap, keeps the tap count sane
		#define PCSS_SEARCH_HINT 0.030    // depth gap the blocker search spans

		float pcssNoise( vec2 position ) {
			return fract( 52.9829189 * fract( dot( position, vec2( 0.06711056, 0.00583715 ) ) ) );
		}

		vec2 pcssDisk( int sampleIndex, int samplesCount, float phi ) {
			const float goldenAngle = 2.399963229728653;
			float r = sqrt( ( float( sampleIndex ) + 0.5 ) / float( samplesCount ) );
			float theta = float( sampleIndex ) * goldenAngle + phi;
			return vec2( cos( theta ), sin( theta ) ) * r;
		}

		float getShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord ) {

			shadowCoord.xyz /= shadowCoord.w;

			#ifdef USE_REVERSED_DEPTH_BUFFER
				float sgn = -1.0;
			#else
				float sgn = 1.0;
			#endif

			float zRecv = shadowCoord.z + sgn * shadowBias;
			bool inFrustum = shadowCoord.x >= 0.0 && shadowCoord.x <= 1.0 && shadowCoord.y >= 0.0 && shadowCoord.y <= 1.0;
			if ( ! ( inFrustum && shadowCoord.z <= 1.0 ) ) return 1.0;

			vec2 texel = vec2( 1.0 ) / shadowMapSize;
			float phi = pcssNoise( gl_FragCoord.xy ) * PI2;

			// --- 1. blocker search -----------------------------------------
			float search = clamp( shadowRadius * PCSS_SEARCH_HINT, 3.0, PCSS_MAX_PENUMBRA );
			float blockerSum = 0.0;
			float blockerCount = 0.0;
			for ( int i = 0; i < 10; i ++ ) {
				vec2 o = pcssDisk( i, 10, phi ) * search;
				float d = texture2D( shadowMap, shadowCoord.xy + o * texel ).r;
				if ( sgn * ( zRecv - d ) > 0.0 ) {
					blockerSum += d;
					blockerCount += 1.0;
				}
			}
			// Nothing between this fragment and the light. This is the common
			// case across a sunlit plaza, and it is what makes a full PCSS
			// filter affordable at all.
			if ( blockerCount < 0.5 ) return 1.0;

			// --- 2. penumbra width from the average blocker distance -------
			float avgBlocker = blockerSum / blockerCount;
			float gap = max( sgn * ( zRecv - avgBlocker ), 0.0 );
			float penumbra = min( PCSS_CONTACT + shadowRadius * gap, PCSS_MAX_PENUMBRA );

			// --- 3. PCF at that width --------------------------------------
			// A wide filter reaches far enough across a sloped receiver to
			// shadow itself, so the depth bias scales with the filter width.
			float zFilter = shadowCoord.z + sgn * shadowBias * ( 1.0 + penumbra * 0.30 );
			int taps = penumbra < 3.0 ? 8 : ( penumbra < 10.0 ? 12 : 20 );
			float lit = 0.0;
			for ( int i = 0; i < taps; i ++ ) {
				vec2 o = pcssDisk( i, taps, phi ) * penumbra;
				float d = texture2D( shadowMap, shadowCoord.xy + o * texel ).r;
				lit += ( sgn * ( zFilter - d ) > 0.0 ) ? 0.0 : 1.0;
			}

			return mix( 1.0, lit / float( taps ), shadowIntensity );
		}
`;

let contactShadowsInstalled = null;   // null = not tried, true/false = result

/**
 * Swap three's basic (single-tap) `getShadow` for the PCSS sampler above.
 *
 * The replacement is surgical rather than a wholesale rewrite of the chunk: we
 * find the *last* `getShadow( sampler2D ... )` in `shadowmap_pars_fragment` —
 * that is the one inside the `#else` (BasicShadowMap) branch, the VSM one comes
 * first — and brace-match its body. If a future three ever changes the shape of
 * that chunk the match simply fails and returns false, and `createEngine` keeps
 * three's PCF rather than shipping the one-tap hard shadow that BasicShadowMap
 * gives on its own. `engine.features.contactShadows` reports which one is live.
 */
function installContactShadows() {
  if (contactShadowsInstalled !== null) return contactShadowsInstalled;
  contactShadowsInstalled = false;
  const src = THREE.ShaderChunk.shadowmap_pars_fragment;
  if (typeof src !== 'string') return false;
  // Already injected — a dev-server module reload re-runs this file but three's
  // chunks are global and keep the patch.
  if (src.indexOf('PCSS_MAX_PENUMBRA') >= 0) { contactShadowsInstalled = true; return true; }
  const start = src.lastIndexOf('float getShadow( sampler2D shadowMap');
  if (start < 0) return false;
  const open = src.indexOf('{', start);
  if (open < 0) return false;
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end < 0) return false;
  THREE.ShaderChunk.shadowmap_pars_fragment = src.slice(0, start) + PCSS_GET_SHADOW + src.slice(end);
  contactShadowsInstalled = true;
  return true;
}

// ===========================================================================
// 2. TONE CURVE
// ===========================================================================
// three's ACES fit ends in a `saturate()`, and it compresses each channel
// independently. Point it at a low sun and the result is a featureless white
// hole with a coloured fringe where the disc should be, while the shadow end
// runs straight into zero. Both ends of that response were called out.
//
// This curve instead:
//   * tone-scales the *peak* channel and carries the colour ratio, so a hot
//     highlight walks toward white along a controlled path (blended with a
//     per-channel pass so it still desaturates the way film does),
//   * uses a rational curve with a long shoulder normalised to a 12x white
//     point, so cloud tops and the sun disc keep gradation instead of clipping,
//   * is calibrated so 0.18 linear lands within ~1% of where ACES put it —
//     nothing else in the game has to be re-exposed.

const TONE_CURVE = /* glsl */`
vec3 CustomToneMapping( vec3 color ) {

	color = max( color * toneMappingExposure, vec3( 0.0 ) );

	float peak = max( color.r, max( color.g, color.b ) );
	peak = max( peak, 1e-5 );
	vec3 ratio = color / peak;

	// Highlight desaturation: eases in above 1.0, most of the way there by 8x.
	ratio = mix( ratio, vec3( 1.0 ), smoothstep( 1.0, 8.0, peak ) * 0.6 );

	vec3 perChannel = vec3(
		toneCurve( color.r ),
		toneCurve( color.g ),
		toneCurve( color.b )
	);
	vec3 hueSafe = ratio * toneCurve( peak );

	// Per-channel desaturates highlights the way film does; the hue-safe path
	// keeps a saturated sunset from turning into a grey blob. Take both.
	return clamp( mix( perChannel, hueSafe, 0.65 ), 0.0, 1.0 );
}
`;

// Rational filmic curve. The 0.8 input pre-scale and the 1.0081 normaliser (the
// curve's own value at 12x) were picked together so f(0.18) lands within ~1% of
// where three's ACES fit put mid-grey, while f() stays strictly below 1.0 out to
// ~12 stops over. That headroom is the shoulder the frames were missing.
const TONE_HELPER = /* glsl */`
float toneCurve( float x ) {
	x = max( x, 0.0 ) * 0.8;
	float num = x * ( 2.51 * x + 0.03 );
	float den = x * ( 2.43 * x + 0.59 ) + 0.14;
	return ( num / den ) / 1.0081;
}
`;

let toneCurveInstalled = null;

/** Define `CustomToneMapping` so `THREE.CustomToneMapping` selects our curve. */
function installToneCurve() {
  if (toneCurveInstalled !== null) return toneCurveInstalled;
  toneCurveInstalled = false;
  const src = THREE.ShaderChunk.tonemapping_pars_fragment;
  if (typeof src !== 'string') return false;
  if (src.indexOf('float toneCurve( float x )') >= 0) { toneCurveInstalled = true; return true; }
  const stub = 'vec3 CustomToneMapping( vec3 color ) { return color; }';
  if (src.indexOf(stub) < 0) return false;
  THREE.ShaderChunk.tonemapping_pars_fragment =
    src.replace(stub, TONE_HELPER + TONE_CURVE);
  toneCurveInstalled = true;
  return true;
}

// ===========================================================================
// 3. BLOOM HIGHLIGHT CLAMP
// ===========================================================================
// UnrealBloomPass extracts everything over the threshold *at full HDR value*.
// The sun disc is ~34x sky brightness, so a single sprite was smearing a third
// of the frame to featureless white. Thresholding harder does not fix that —
// it only decides *whether* the disc blooms, not how much energy it dumps.
//
// So clamp what the high-pass hands to the blur chain. The disc still flares;
// the flare is now bounded and shaped instead of eating the frame.

const BLOOM_CLAMP_FROM = 'gl_FragColor = mix( outputColor, texel, alpha );';
const BLOOM_CLAMP_TO = /* glsl */`
			float lum = max( v, 1e-5 );
			vec4 bright = texel;
			bright.rgb *= min( lum, bloomClamp ) / lum;
			gl_FragColor = mix( outputColor, bright, alpha );`;

function clampBloomHighlights(bloomPass, value) {
  const mat = bloomPass.materialHighPassFilter;
  if (!mat || !mat.fragmentShader) return false;
  if (!mat.uniforms.bloomClamp) {
    if (mat.fragmentShader.indexOf(BLOOM_CLAMP_FROM) < 0) return false;
    // `materialHighPassFilter.uniforms` *is* `highPassUniforms`, so this reaches
    // the pass's own uniform bag too.
    mat.uniforms.bloomClamp = { value };
    mat.fragmentShader = mat.fragmentShader
      .replace('uniform float smoothWidth;', 'uniform float smoothWidth;\n\t\tuniform float bloomClamp;')
      .replace(BLOOM_CLAMP_FROM, BLOOM_CLAMP_TO);
    mat.needsUpdate = true;
  }
  mat.uniforms.bloomClamp.value = value;
  return true;
}

// ===========================================================================
// GRADE
// ===========================================================================

/**
 * Final grade: display-space AO, contrast, black floor, vignette, chromatic
 * aberration, grain, radial speed blur.
 *
 * This pass runs *after* OutputPass, so everything in it is display-referred.
 * Two consequences drove the shape of it:
 *
 *  - The contrast pivot has to sit at display mid-grey (~0.45), not at 0.18.
 *    Pivoting a display-referred image at 0.18 barely touches the mid-tones,
 *    which is how concrete, benches and a crowd ended up on one muddy value.
 *  - Ambient occlusion applied in linear HDR gets eaten by the tone-map
 *    shoulder. A second, gentler AO term here is what actually darkens the
 *    seam where a stanchion base plate meets the slab.
 */
const GradeShader = {
  name: 'GradeShader',
  uniforms: {
    tDiffuse: { value: null },
    tAO: { value: null },
    uTime: { value: 0 },
    uSpeed: { value: 0 },        // 0..1 radial blur amount
    uVignette: { value: 0.34 },
    uAberration: { value: 0.0016 },
    uGrain: { value: 0.028 },
    uSaturation: { value: 1.06 },
    uContrast: { value: 1.1 },
    uPivot: { value: 0.45 },     // display mid-grey — the contrast hinge
    uHighlightKnee: { value: 0.90 },
    uShadowFloor: { value: 0.05 },
    uAOStrength: { value: 0.6 },
    uAOPower: { value: 1.9 },
    uLift: { value: new THREE.Vector3(0.005, 0.004, 0.012) },
    uGain: { value: new THREE.Vector3(1.015, 1.0, 0.985) },
    uResolution: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform sampler2D tAO;
    uniform float uTime, uSpeed, uVignette, uAberration, uGrain, uSaturation, uContrast;
    uniform float uPivot, uHighlightKnee, uShadowFloor, uAOStrength, uAOPower;
    uniform vec3 uLift, uGain;
    uniform vec2 uResolution;
    varying vec2 vUv;

    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

    void main() {
      vec2 uv = vUv;
      vec2 c = uv - 0.5;
      float r = length(c);

      // radial speed blur
      vec3 col = vec3(0.0);
      if (uSpeed > 0.001) {
        float amt = uSpeed * 0.045 * smoothstep(0.15, 0.75, r);
        float total = 0.0;
        for (int i = 0; i < 6; i++) {
          float t = float(i) / 5.0;
          vec2 suv = uv - c * amt * t;
          float w = 1.0 - t * 0.55;
          col += texture2D(tDiffuse, suv).rgb * w;
          total += w;
        }
        col /= total;
      } else {
        col = texture2D(tDiffuse, uv).rgb;
      }

      // chromatic aberration, strongest at frame edge
      float ab = uAberration * (0.35 + r * r * 2.2);
      col.r = mix(col.r, texture2D(tDiffuse, uv + c * ab).r, 0.9);
      col.b = mix(col.b, texture2D(tDiffuse, uv - c * ab).b, 0.9);

      // Contact darkening. The GTAO pass already multiplied its AO into the
      // linear buffer, but the tone-map shoulder flattens most of that back
      // out; this second bite lands in display space where it reads.
      if (uAOStrength > 0.001) {
        float ao = clamp(texture2D(tAO, uv).r, 0.0, 1.0);
        col *= mix(1.0, pow(ao, uAOPower), uAOStrength);
      }

      // gain
      col = col * uGain;

      // Contrast hinged at display mid-grey, then a filmic soft clip: the top
      // rolls off asymptotically towards 1.0 instead of clipping to paper, so
      // a bright cloud deck keeps its modelling even after added contrast.
      col = (col - uPivot) * uContrast + uPivot;
      vec3 over = max(col - uHighlightKnee, 0.0);
      float head = max(1.0 - uHighlightKnee, 1e-3);
      col = min(col, vec3(uHighlightKnee)) + head * (1.0 - exp(-over / head));
      col = max(col, 0.0);

      // Black floor. uLift carries the (cool) tint; uShadowFloor guarantees a
      // minimum level so deep shadow under a ramp keeps detail instead of
      // clipping to zero. Topping the lift up preserves the tint either way.
      float liftLum = (uLift.r + uLift.g + uLift.b) / 3.0;
      vec3 lift = uLift + vec3(max(0.0, uShadowFloor - liftLum));
      col = col + lift * (1.0 - col);

      // saturation
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l), col, uSaturation);

      // vignette
      float vig = 1.0 - uVignette * smoothstep(0.28, 0.95, r);
      col *= vig;

      // animated film grain, luminance-weighted so shadows stay clean-ish
      float g = hash(uv * uResolution + fract(uTime) * 137.0) - 0.5;
      col += g * uGrain * (0.35 + 0.65 * (1.0 - l));

      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }
  `,
};

// ===========================================================================
// QUALITY
// ===========================================================================
// `aoSamples` feeds GTAO's SAMPLES define, which it splits into slice
// directions x steps: below 30 it uses 3 directions, at or above 30 it uses 5.
// Ultra buys the fifth direction; high spends its budget on extra steps per
// direction instead, which is the cheaper way to cover the sample radius.
//
// GTAO is now on at medium too. Contact grounding is not a luxury — without it
// props sit *on top of* the concrete rather than in it — and at 1024 shadow
// maps and 16 samples it is affordable. Only `low` gives it up, and `low` gets
// no display-space AO term either, so nothing there depends on a missing pass.

export const QUALITY = {
  ultra: { pixelRatio: 2.0, shadowMap: 4096, gtao: true, aoSamples: 32, bloom: true, smaa: true, anisotropy: 16 },
  high: { pixelRatio: 1.5, shadowMap: 2048, gtao: true, aoSamples: 24, bloom: true, smaa: true, anisotropy: 8 },
  medium: { pixelRatio: 1.0, shadowMap: 1024, gtao: true, aoSamples: 16, bloom: true, smaa: true, anisotropy: 4 },
  low: { pixelRatio: 0.85, shadowMap: 1024, gtao: false, aoSamples: 16, bloom: false, smaa: false, anisotropy: 2 },
};

/** Sun angular size as a tangent. Physically ~0.0093; a hazy overcast key
 *  reads much softer than that, and the target look is an overcast deck. */
const DEFAULT_SHADOW_SOFTNESS = 0.13;

/**
 * Compile a throwaway scene that exercises the injected shader chunks, and
 * report whether the driver accepted them.
 *
 * We hand-patch two of three's shader chunks (PCSS `getShadow`, the custom tone
 * curve). A software rasteriser accepts GLSL that a real driver rejects, so a
 * build verified headlessly can compile nothing at all on the user's GPU — and
 * a failed program link means every material draws nothing while the DOM UI
 * carries on rendering. That failure mode looks exactly like "the HUD works but
 * there are no graphics", so we detect it here, before the world is built,
 * rather than shipping a black canvas.
 */
function shaderChunksCompile(renderer) {
  // The injected chunk only lands in a shader that actually samples a shadow
  // map, so the probe has to run with shadows switched on and in the same
  // shadow mode the engine will use. Probing before that is why an earlier
  // version of this check passed a deliberately broken shader.
  const prevEnabled = renderer.shadowMap.enabled;
  const prevType = renderer.shadowMap.type;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.BasicShadowMap;

  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 10);
  cam.position.set(0, 1, 3);
  const light = new THREE.DirectionalLight(0xffffff, 1);
  light.position.set(2, 4, 2);
  light.castShadow = true;
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0x808080, roughness: 0.6, metalness: 0.2 }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  // A receiver the caster can actually shadow, so the sampler is exercised.
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(6, 6),
    new THREE.MeshStandardMaterial({ color: 0x909090, roughness: 0.8 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.6;
  ground.receiveShadow = true;
  scene.add(light, light.target, mesh, ground);

  const originalError = console.error;
  let failed = false;
  let message = '';
  console.error = (...args) => {
    const text = args.map((a) => (a && a.message) || String(a)).join(' ');
    if (/shader|program|glsl|compile|link/i.test(text)) {
      failed = true;
      if (!message) message = text.slice(0, 400);
    }
    originalError.apply(console, args);
  };
  try {
    renderer.compile(scene, cam);
    renderer.render(scene, cam);
  } catch (err) {
    failed = true;
    message = message || String(err && err.message || err);
  } finally {
    console.error = originalError;
    mesh.geometry.dispose();
    mesh.material.dispose();
    ground.geometry.dispose();
    ground.material.dispose();
    renderer.shadowMap.enabled = prevEnabled;
    renderer.shadowMap.type = prevType;
  }
  return { ok: !failed, message };
}

export function createEngine(canvas, { quality = 'high' } = {}) {
  // Keep the originals so a driver that rejects our GLSL can be given three's.
  const originalShadowChunk = THREE.ShaderChunk.shadowmap_pars_fragment;
  const originalToneChunk = THREE.ShaderChunk.tonemapping_pars_fragment;

  let pcssOk = installContactShadows();
  let toneOk = installToneCurve();

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    powerPreference: 'high-performance',
    stencil: false,
    alpha: false,
  });
  // Pre-flight: if the driver rejects the injected chunks, put three's own back
  // and carry on with standard PCF shadows and ACES. A slightly softer look
  // beats a black canvas.
  let shaderFallback = null;
  if (pcssOk || toneOk) {
    const probe = shaderChunksCompile(renderer);
    if (!probe.ok) {
      THREE.ShaderChunk.shadowmap_pars_fragment = originalShadowChunk;
      THREE.ShaderChunk.tonemapping_pars_fragment = originalToneChunk;
      contactShadowsInstalled = false;
      toneCurveInstalled = false;
      pcssOk = false;
      toneOk = false;
      shaderFallback = probe.message || 'shader compilation failed';
      // Do NOT dispose the renderer here — the probe's own materials are gone
      // and every later material compiles fresh against the restored chunks.
      console.warn('[engine] custom shader chunks rejected by this driver, falling back:', shaderFallback);
    }
  }

  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = toneOk ? THREE.CustomToneMapping : THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  // BasicShadowMap is the only mode that binds the shadow map as a plain
  // sampler2D, which is what the PCSS blocker search needs to read depth. If
  // the injection failed, fall back to three's PCF rather than shipping the
  // one-tap hard shadow that BasicShadowMap gives on its own.
  renderer.shadowMap.type = pcssOk ? THREE.BasicShadowMap : THREE.PCFShadowMap;
  renderer.info.autoReset = true;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(62, 1, 0.08, 900);
  camera.position.set(0, 3, 8);

  const composer = new EffectComposer(renderer);
  composer.setSize(1, 1);

  // 1x1 white stand-in so the grade's AO sampler is always bound, even on the
  // tiers where GTAO never runs.
  const whiteAO = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  whiteAO.needsUpdate = true;

  const renderPass = new RenderPass(scene, camera);
  const gtaoPass = new GTAOPass(scene, camera, 1, 1);
  gtaoPass.output = GTAOPass.OUTPUT.Default;

  // GTAO rejects any sample whose view-depth delta exceeds `thickness`. On a
  // grazing surface — which is most of a skatepark seen from a chase camera —
  // that delta is roughly the sample radius, so a thickness below the radius
  // silently throws away every ground sample and the AO buffer comes back
  // white. `configureAO` enforces the ratio for exactly that reason.
  const aoParameters = {
    radius: 0.35, distanceExponent: 1.6, thickness: 0.6, scale: 1.0,
    samples: 32, distanceFallOff: 1.0, screenSpaceRadius: false,
  };
  const pdParameters = { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 4, radiusExponent: 1, rings: 2, samples: 16 };

  // (resolution, strength, radius, threshold). The threshold sits past the tone
  // curve's white point so only genuinely over-range highlights — the sun disc,
  // sparks, coping speculars, lit windows — flare at all, and the clamp below
  // bounds how much energy each of them can dump into the blur chain.
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.28, 0.58, 1.1);
  clampBloomHighlights(bloomPass, 6.0);

  const gradePass = new ShaderPass(GradeShader);
  gradePass.uniforms.tAO.value = whiteAO;
  const smaaPass = new SMAAPass(1, 1);
  const outputPass = new OutputPass();

  const resizeHandlers = [];
  const tier = { name: quality, ...QUALITY[quality] };
  let shadowSoftness = DEFAULT_SHADOW_SOFTNESS;

  function applyAO() {
    aoParameters.samples = tier.aoSamples || 16;
    // See the note on `aoParameters`: thickness must span the sample radius or
    // GTAO returns a blank buffer on every near-horizontal surface.
    const thickness = Math.max(aoParameters.thickness, aoParameters.radius * 1.6);
    gtaoPass.updateGtaoMaterial({ ...aoParameters, thickness });
    gtaoPass.updatePdMaterial(pdParameters);
  }
  applyAO();

  function rebuildChain() {
    composer.passes.length = 0;
    composer.addPass(renderPass);
    if (tier.gtao) composer.addPass(gtaoPass);
    if (tier.bloom) composer.addPass(bloomPass);
    composer.addPass(outputPass);
    composer.addPass(gradePass);
    if (tier.smaa) composer.addPass(smaaPass);
    gradePass.renderToScreen = !tier.smaa;
  }
  rebuildChain();

  function resize() {
    const w = Math.max(1, canvas.clientWidth || window.innerWidth);
    const h = Math.max(1, canvas.clientHeight || window.innerHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, tier.pixelRatio);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    composer.setPixelRatio(dpr);
    // composer.setSize already forwards w*dpr / h*dpr to every pass it owns.
    // Re-calling setSize on the bloom and GTAO passes with CSS pixels (as this
    // used to) quietly ran them at a lower resolution than the buffer they
    // composite into, which is part of why the AO never resolved a crease.
    composer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    gradePass.uniforms.uResolution.value.set(w * dpr, h * dpr);
    for (const fn of resizeHandlers) fn(w, h);
  }

  window.addEventListener('resize', resize);

  /**
   * Drive the sun's PCSS penumbra slope from the live shadow camera.
   *
   * `shadow.radius` reaches the sampler as "filter texels per unit of
   * normalised depth gap", so it has to be re-derived whenever the shadow
   * frustum is re-fitted (environment.js quantises and re-centres it every
   * frame). The result: a fixed *world* penumbra rate rather than a fixed
   * texel blur, which is the whole point of contact hardening.
   */
  function updateShadowPenumbra() {
    const light = engine.sunLight;
    if (!light || !light.castShadow || !light.shadow) return;
    const sh = light.shadow;
    const cam = sh.camera;
    if (!cam || !cam.isOrthographicCamera) return;
    const texel = (cam.right - cam.left) / Math.max(1, sh.mapSize.x);
    if (!(texel > 0)) return;
    const depthRange = Math.max(1e-3, cam.far - cam.near);
    sh.radius = clamp((shadowSoftness * depthRange) / texel, 1, 4000);
  }

  const engine = {
    renderer, scene, camera, composer, tier,
    passes: { renderPass, gtaoPass, bloomPass, gradePass, smaaPass, outputPass },
    sunLight: null,       // set by environment
    envScene: null,       // set by environment
    /** Diagnostics for the capture harness / settings screen. */
    features: { contactShadows: pcssOk, toneCurve: toneOk, shaderFallback },

    setQuality(name) {
      const q = QUALITY[name];
      if (!q) return;
      Object.assign(tier, q, { name });
      applyAO();
      rebuildChain();
      resize();
    },
    /**
     * GTAO needs scene-scale hints once the park exists.
     *
     * `bounds` (a Box3 over the park) is accepted as an alternative to a raw
     * radius: contact AO wants a fixed *physical* radius, so the box is only
     * used to sanity-clamp it against the actual world scale rather than to
     * scale it linearly — a 200 m plaza does not want a 20 m AO radius.
     */
    configureAO({ radius, distanceExponent, thickness, scale, samples, bounds } = {}) {
      if (bounds && bounds.isBox3 && !bounds.isEmpty()) {
        const span = Math.max(
          bounds.max.x - bounds.min.x,
          bounds.max.y - bounds.min.y,
          bounds.max.z - bounds.min.z,
        );
        // ~0.35 m on a park a hundred-odd metres across; scales gently if the
        // level is built at a different size.
        if (radius === undefined) radius = clamp(span * 0.0035, 0.2, 0.9);
      }
      if (radius !== undefined) aoParameters.radius = radius;
      if (distanceExponent !== undefined) aoParameters.distanceExponent = distanceExponent;
      if (thickness !== undefined) aoParameters.thickness = thickness;
      if (scale !== undefined) aoParameters.scale = scale;
      if (samples !== undefined) aoParameters.samples = samples;
      applyAO();
    },
    /** Art-directed sun size: tangent of the source's apparent half-angle. */
    setShadowSoftness(v) {
      shadowSoftness = clamp(v, 0.002, 0.6);
      updateShadowPenumbra();
    },
    /** Cap on the HDR value the bloom pass is allowed to see. */
    setBloomClamp(v) { clampBloomHighlights(bloomPass, Math.max(0.1, v)); },
    registerResize(fn) { resizeHandlers.push(fn); },
    setSpeedBlur(v) { gradePass.uniforms.uSpeed.value = clamp(v, 0, 1); },
    render(elapsed) {
      gradePass.uniforms.uTime.value = elapsed;
      updateShadowPenumbra();
      // Feed the denoised AO buffer to the grade so contact darkening survives
      // the tone-map; fall back to flat white on the tiers with no GTAO.
      const aoTex = tier.gtao ? gtaoPass.pdRenderTarget?.texture : null;
      gradePass.uniforms.tAO.value = aoTex || whiteAO;
      gradePass.uniforms.uAOStrength.value = aoTex ? engine.aoStrength : 0;
      composer.render();
    },
    /** Display-space contact-darkening strength (0 disables the second bite). */
    aoStrength: 0.6,
    resize,
    dispose() {
      window.removeEventListener('resize', resize);
      whiteAO.dispose();
      composer.dispose?.();
      renderer.dispose();
    },
  };

  resize();
  return engine;
}
