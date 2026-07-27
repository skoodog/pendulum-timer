// Chase camera: spring follow, speed FOV, air pull-back, grind framing, bail orbit.

import * as THREE from 'three';
import { clamp, damp, lerp } from './mathx.js';

const _target = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _offset = new THREE.Vector3();
const _flatVel = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _look = new THREE.Vector3();
const _dir = new THREE.Vector3();

export function createCameraRig(ctx) {
  const camera = ctx.camera;
  const pos = new THREE.Vector3(0, 4, 10);
  const look = new THREE.Vector3();
  let yaw = 0;
  let fov = 62;
  let shake = 0;
  let shakeSeed = 0;
  let mode = 'chase';

  const TUNE = {
    distance: 5.4,
    height: 1.85,
    lookAhead: 2.2,
    lookHeight: 1.05,
    posLambda: 7.5,
    lookLambda: 11.0,
    yawLambda: 5.0,
    airDistance: 6.9,
    airHeight: 2.5,
    fovBase: 62,
    fovSpeedGain: 13,
    fovAir: 4,
  };

  const rig = {
    camera,
    mode,
    setMode(m) { mode = m; },
    addShake(a) { shake = Math.min(1.4, shake + a); },

    update(dt, ctx) {
      const p = ctx.player?.physics?.state;
      if (!p) return;

      const speed = p.speed ?? 0;
      const speed01 = clamp(speed / 14, 0, 1.25);
      const airing = p.mode === 'air';
      const bailing = p.mode === 'bail';

      // Desired yaw follows travel direction; falls back to bike heading when slow.
      _flatVel.set(p.velocity.x, 0, p.velocity.z);
      let targetYaw;
      if (_flatVel.lengthSq() > 1.2) {
        targetYaw = Math.atan2(_flatVel.x, _flatVel.z);
      } else {
        _dir.set(0, 0, 1).applyQuaternion(p.quaternion);
        targetYaw = Math.atan2(_dir.x, _dir.z);
      }
      // shortest-path yaw damping
      let d = targetYaw - yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      const yawLambda = bailing ? 1.6 : TUNE.yawLambda * (airing ? 0.55 : 1);
      yaw += d * (1 - Math.exp(-yawLambda * dt));

      const dist = lerp(TUNE.distance, TUNE.airDistance, airing ? clamp(p.airTime / 0.8, 0, 1) : 0);
      const hgt = lerp(TUNE.height, TUNE.airHeight, airing ? clamp(p.airTime / 0.8, 0, 1) : 0);

      _offset.set(-Math.sin(yaw) * dist, hgt, -Math.cos(yaw) * dist);
      _desired.copy(p.position).add(_offset);

      // Do not let the camera sink through the park.
      const col = ctx.world?.collision;
      if (col?.raycastDown) {
        const ground = col.raycastDown(_desired.clone().setY(_desired.y + 6), 12);
        if (ground?.hit && _desired.y < ground.point.y + 0.55) _desired.y = ground.point.y + 0.55;
      }

      const posLambda = bailing ? 3.5 : TUNE.posLambda;
      pos.x = damp(pos.x, _desired.x, posLambda, dt);
      pos.y = damp(pos.y, _desired.y, posLambda * 1.15, dt);
      pos.z = damp(pos.z, _desired.z, posLambda, dt);

      _target.copy(p.position);
      _target.y += TUNE.lookHeight;
      _look.set(Math.sin(yaw), 0, Math.cos(yaw)).multiplyScalar(TUNE.lookAhead * speed01);
      _target.add(_look);
      look.x = damp(look.x, _target.x, TUNE.lookLambda, dt);
      look.y = damp(look.y, _target.y, TUNE.lookLambda, dt);
      look.z = damp(look.z, _target.z, TUNE.lookLambda, dt);

      camera.position.copy(pos);
      if (shake > 0.001) {
        shakeSeed += dt * 47;
        const s = shake * shake * 0.32;
        camera.position.x += Math.sin(shakeSeed * 3.1) * s;
        camera.position.y += Math.sin(shakeSeed * 2.3 + 1.7) * s;
        camera.position.z += Math.sin(shakeSeed * 4.7 + 0.4) * s * 0.6;
        shake = Math.max(0, shake - dt * 2.6);
      }
      camera.up.copy(_up);
      camera.lookAt(look);

      const targetFov = TUNE.fovBase + speed01 * TUNE.fovSpeedGain + (airing ? TUNE.fovAir : 0);
      fov = damp(fov, targetFov, 4.5, dt);
      if (Math.abs(camera.fov - fov) > 0.01) {
        camera.fov = fov;
        camera.updateProjectionMatrix();
      }

      ctx.engine.setSpeedBlur(clamp((speed - 8.5) / 8, 0, 1) * 0.9);
    },
    snap(ctx) {
      const p = ctx.player?.physics?.state;
      if (!p) return;
      _dir.set(0, 0, 1).applyQuaternion(p.quaternion);
      yaw = Math.atan2(_dir.x, _dir.z);
      pos.copy(p.position).add(_offset.set(-Math.sin(yaw) * TUNE.distance, TUNE.height, -Math.cos(yaw) * TUNE.distance));
      look.copy(p.position);
      camera.position.copy(pos);
      camera.lookAt(look);
    },
    dispose() {},
  };
  return rig;
}
