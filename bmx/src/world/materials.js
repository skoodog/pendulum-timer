import * as THREE from 'three';
// STUB — replaced by the materials agent.
export async function createMaterials(ctx) {
  const mk = (color, roughness = 0.9, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
  const lib = { concrete: mk(0x9a978f), asphalt: mk(0x3a3a3e), plywood: mk(0xb08a52), metalCoping: mk(0xc8ccd2, 0.3, 1), railSteel: mk(0xb9bec6, 0.28, 1), grass: mk(0x4a6b32), dirt: mk(0x6b543a) };
  return { ...lib, get: (n) => lib[n] || lib.concrete, dispose() { for (const m of Object.values(lib)) m.dispose?.(); } };
}
