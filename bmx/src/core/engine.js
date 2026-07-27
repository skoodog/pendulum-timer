// Renderer, post-processing chain and quality tiers. This is the spine — systems
// hang off it but must not rewrite it.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { clamp } from './mathx.js';

/** Final grade: vignette, chromatic aberration, grain, radial speed blur. */
const GradeShader = {
  name: 'GradeShader',
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uSpeed: { value: 0 },        // 0..1 radial blur amount
    uVignette: { value: 0.42 },
    uAberration: { value: 0.0016 },
    uGrain: { value: 0.028 },
    uSaturation: { value: 1.06 },
    uContrast: { value: 1.04 },
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
    uniform float uTime, uSpeed, uVignette, uAberration, uGrain, uSaturation, uContrast;
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

      // lift / gain grade
      col = col * uGain + uLift * (1.0 - col);

      // contrast around 0.18 grey, then saturation
      col = (col - 0.18) * uContrast + 0.18;
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

export const QUALITY = {
  ultra: { pixelRatio: 2.0, shadowMap: 4096, gtao: true, bloom: true, smaa: true, anisotropy: 16 },
  high: { pixelRatio: 1.5, shadowMap: 2048, gtao: true, bloom: true, smaa: true, anisotropy: 8 },
  medium: { pixelRatio: 1.0, shadowMap: 1024, gtao: false, bloom: true, smaa: true, anisotropy: 4 },
  low: { pixelRatio: 0.85, shadowMap: 1024, gtao: false, bloom: false, smaa: false, anisotropy: 2 },
};

export function createEngine(canvas, { quality = 'high' } = {}) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    powerPreference: 'high-performance',
    stencil: false,
    alpha: false,
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.info.autoReset = true;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(62, 1, 0.08, 900);
  camera.position.set(0, 3, 8);

  const composer = new EffectComposer(renderer);
  composer.setSize(1, 1);

  const renderPass = new RenderPass(scene, camera);
  const gtaoPass = new GTAOPass(scene, camera, 1, 1);
  gtaoPass.output = GTAOPass.OUTPUT.Default;
  const aoParameters = {
    radius: 0.35, distanceExponent: 1.6, thickness: 0.4, scale: 1.0,
    samples: 16, distanceFallOff: 1.0, screenSpaceRadius: false,
  };
  const pdParameters = { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 4, radiusExponent: 1, rings: 2, samples: 16 };
  gtaoPass.updateGtaoMaterial(aoParameters);
  gtaoPass.updatePdMaterial(pdParameters);
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.42, 0.62, 0.92);
  const gradePass = new ShaderPass(GradeShader);
  const smaaPass = new SMAAPass(1, 1);
  const outputPass = new OutputPass();

  const resizeHandlers = [];
  const tier = { name: quality, ...QUALITY[quality] };

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
    composer.setSize(w, h);
    bloomPass.setSize(w, h);
    gtaoPass.setSize(w, h);
    smaaPass.setSize(w * dpr, h * dpr);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    gradePass.uniforms.uResolution.value.set(w * dpr, h * dpr);
    for (const fn of resizeHandlers) fn(w, h);
  }

  window.addEventListener('resize', resize);

  const engine = {
    renderer, scene, camera, composer, tier,
    passes: { renderPass, gtaoPass, bloomPass, gradePass, smaaPass, outputPass },
    sunLight: null,       // set by environment
    envScene: null,       // set by environment

    setQuality(name) {
      const q = QUALITY[name];
      if (!q) return;
      Object.assign(tier, q, { name });
      rebuildChain();
      resize();
    },
    /** GTAO needs scene-scale hints once the park exists. */
    configureAO({ radius = 0.35, distanceExponent = 1.6, thickness = 0.4, scale = 1.0, samples = 16 } = {}) {
      aoParameters.radius = radius;
      aoParameters.distanceExponent = distanceExponent;
      aoParameters.thickness = thickness;
      aoParameters.scale = scale;
      aoParameters.samples = samples;
      gtaoPass.updateGtaoMaterial(aoParameters);
      gtaoPass.updatePdMaterial(pdParameters);
    },
    registerResize(fn) { resizeHandlers.push(fn); },
    setSpeedBlur(v) { gradePass.uniforms.uSpeed.value = clamp(v, 0, 1); },
    render(elapsed) {
      gradePass.uniforms.uTime.value = elapsed;
      composer.render();
    },
    resize,
    dispose() {
      window.removeEventListener('resize', resize);
      composer.dispose?.();
      renderer.dispose();
    },
  };

  resize();
  return engine;
}
