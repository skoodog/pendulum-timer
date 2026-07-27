import * as THREE from 'three';
// STUB — replaced by the environment agent.
export async function createEnvironment(ctx) {
  ctx.scene.background = new THREE.Color(0x8fb6da);
  ctx.scene.fog = new THREE.Fog(0x8fb6da, 60, 320);
  const hemi = new THREE.HemisphereLight(0xbcd6f2, 0x5a5145, 1.1);
  ctx.scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff0d8, 2.4);
  sun.position.set(38, 46, 24);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const c = sun.shadow.camera; c.left = -55; c.right = 55; c.top = 55; c.bottom = -55; c.near = 1; c.far = 160;
  ctx.scene.add(sun, sun.target);
  ctx.engine.sunLight = sun;
  return { sun, hemi, setTimeOfDay() {}, update() {}, dispose() {} };
}
