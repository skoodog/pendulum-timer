import * as THREE from 'three';
// STUB — replaced by the animation agent.
export function createRiderAnim(rider, ctx) {
  return {
    update(dt, ctx) {
      const s = ctx.player.physics.state;
      rider.group.position.copy(s.position);
      rider.group.quaternion.copy(s.quaternion);
      for (const w of rider.bike.wheels) w.rotation.x -= s.speed * dt * 3.5;
    },
    setPose() {}, playBail() {}, dispose() {},
  };
}
