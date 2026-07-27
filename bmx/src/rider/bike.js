import * as THREE from 'three';
// STUB — replaced by the rider/bike agent.
export async function createRider(ctx) {
  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.7, 6, 12), new THREE.MeshStandardMaterial({ color: 0xcc4433, roughness: 0.7 }));
  body.position.y = 0.9; body.castShadow = true;
  const frame = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.1, 0.1), new THREE.MeshStandardMaterial({ color: 0x2a2f3a, metalness: 1, roughness: 0.35 }));
  frame.position.y = 0.45; frame.castShadow = true;
  const wheelGeo = new THREE.TorusGeometry(0.26, 0.05, 10, 24);
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.85 });
  const wheels = [-0.5, 0.5].map((x) => { const w = new THREE.Mesh(wheelGeo, wheelMat); w.position.set(x, 0.28, 0); w.rotation.y = Math.PI / 2; w.castShadow = true; return w; });
  group.add(body, frame, ...wheels);
  return { group, bike: { frame, wheels, cranks: null, bars: null }, rig: { hips: body, spine: null, head: null, armL: [], armR: [], legL: [], legR: [] } };
}
