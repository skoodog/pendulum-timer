import * as THREE from 'three';
// STUB — replaced by the park agent.
export async function createPark(ctx) {
  const group = new THREE.Group();
  const colliders = [];
  const ground = new THREE.Mesh(new THREE.BoxGeometry(160, 1, 160), ctx.materials.get('asphalt'));
  ground.position.y = -0.5;
  ground.receiveShadow = true;
  group.add(ground);
  colliders.push({ mesh: ground, type: 'ground', friction: 0.9 });
  const ramp = new THREE.Mesh(new THREE.BoxGeometry(12, 2, 6), ctx.materials.get('plywood'));
  ramp.position.set(0, 1, -14); ramp.rotation.x = -0.35;
  ramp.castShadow = ramp.receiveShadow = true;
  group.add(ramp);
  colliders.push({ mesh: ramp, type: 'ramp', friction: 0.95 });
  return { group, colliders, rails: [], spawnPoints: [{ position: new THREE.Vector3(0, 1.2, 8), yaw: Math.PI }], bounds: new THREE.Box3(new THREE.Vector3(-80, -2, -80), new THREE.Vector3(80, 30, 80)) };
}
