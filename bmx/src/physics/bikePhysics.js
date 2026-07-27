import * as THREE from 'three';
// STUB — replaced by the physics agent.
export const TUNING = { gravity: 22, maxSpeed: 14, accel: 9, hop: 5.6 };
export function createBikePhysics(ctx) {
  const state = { position: new THREE.Vector3(), velocity: new THREE.Vector3(), quaternion: new THREE.Quaternion(), grounded: true, airTime: 0, speed: 0, lean: 0, pitch: 0, mode: 'ride', crank: 0, steer: 0, yaw: 0 };
  return {
    state,
    respawn(sp) { state.position.copy(sp.position); state.velocity.set(0, 0, 0); state.yaw = sp.yaw || 0; state.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), state.yaw); },
    applyTrickRotation() {},
    fixedUpdate(fdt, ctx) {
      const i = ctx.input.state;
      state.yaw -= i.steer * fdt * 2.2;
      state.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), state.yaw);
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(state.quaternion);
      state.velocity.addScaledVector(fwd, i.throttle * TUNING.accel * fdt);
      state.velocity.y -= TUNING.gravity * fdt;
      state.position.addScaledVector(state.velocity, fdt);
      const g = ctx.world.collision.raycastDown(state.position.clone().setY(state.position.y + 1.5), 4);
      if (g && state.position.y < g.point.y + 0.45) { state.position.y = g.point.y + 0.45; state.velocity.y = Math.max(0, state.velocity.y); state.grounded = true; state.mode = 'ride'; state.airTime = 0; }
      else { state.grounded = false; state.mode = 'air'; state.airTime += fdt; }
      state.velocity.multiplyScalar(1 - 0.6 * fdt);
      state.speed = Math.hypot(state.velocity.x, state.velocity.z);
    },
    dispose() {},
  };
}
