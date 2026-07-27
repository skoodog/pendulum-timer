import * as THREE from 'three';
// STUB — replaced by the collision agent.
export function createCollision(colliders = [], rails = []) {
  const raycaster = new THREE.Raycaster();
  const meshes = colliders.map((c) => c.mesh);
  const byMesh = new Map(colliders.map((c) => [c.mesh, c]));
  const down = new THREE.Vector3(0, -1, 0);
  return {
    raycastDown(origin, maxDist = 6) {
      raycaster.set(origin, down);
      raycaster.far = maxDist;
      const hits = raycaster.intersectObjects(meshes, true);
      if (!hits.length) return null;
      const h = hits[0];
      let node = h.object, info = null;
      while (node && !info) { info = byMesh.get(node); node = node.parent; }
      return { hit: true, point: h.point, normal: h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : new THREE.Vector3(0, 1, 0), distance: h.distance, friction: info?.friction ?? 0.9, surface: info?.type ?? 'ground' };
    },
    sweepSphere() { return null; },
    nearestRail() { return null; },
    dispose() {},
  };
}
