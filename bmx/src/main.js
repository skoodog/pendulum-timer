// Boot + frame loop. Owns the shared `ctx` every system reads from.

import * as THREE from 'three';
import { createEngine } from './core/engine.js';
import { createInput } from './core/input.js';
import { createCameraRig } from './core/camera.js';
import { seed } from './core/mathx.js';

import { createMaterials } from './world/materials.js';
import { createEnvironment } from './world/environment.js';
import { createPark } from './world/park.js';
import { createCollision } from './physics/collision.js';
import { createBikePhysics } from './physics/bikePhysics.js';
import { createRider } from './rider/bike.js';
import { createRiderAnim } from './rider/riderAnim.js';
import { createTricks } from './gameplay/tricks.js';
import { createGrind } from './gameplay/grind.js';
import { createScoring } from './gameplay/scoring.js';
import { createFX } from './fx/particles.js';
import { createAudio } from './audio/audio.js';
import { createHUD } from './ui/hud.js';
import { createScreens } from './ui/screens.js';

const FIXED_DT = 1 / 120;
const MAX_SUBSTEPS = 6;

async function boot() {
  seed(0x5eed1e);

  const canvas = document.getElementById('viewport');
  const params = new URLSearchParams(location.search);
  const quality = params.get('q') || 'high';

  const engine = createEngine(canvas, { quality });
  const input = createInput();

  const ctx = {
    engine,
    renderer: engine.renderer,
    scene: engine.scene,
    camera: engine.camera,
    input,
    time: { elapsed: 0, dt: 0, fixedDt: FIXED_DT, frame: 0, scale: 1 },
    world: {},
    player: {},
    flags: {
      paused: false,
      freeze: params.has('freeze'),     // harness: no simulation, render only
      hideHud: params.has('nohud'),
    },
    events: new EventTarget(),
    emit(type, detail) { ctx.events.dispatchEvent(new CustomEvent(type, { detail })); },
    on(type, fn) { ctx.events.addEventListener(type, fn); },
  };

  // --- world ---------------------------------------------------------------
  ctx.materials = await createMaterials(ctx);
  ctx.world.environment = await createEnvironment(ctx);
  ctx.world.park = await createPark(ctx);
  ctx.scene.add(ctx.world.park.group);
  ctx.world.collision = createCollision(ctx.world.park.colliders, ctx.world.park.rails);

  // --- player --------------------------------------------------------------
  ctx.player.rider = await createRider(ctx);
  ctx.scene.add(ctx.player.rider.group);
  ctx.player.physics = createBikePhysics(ctx);
  ctx.player.anim = createRiderAnim(ctx.player.rider, ctx);
  ctx.player.grind = createGrind(ctx);
  ctx.player.tricks = createTricks(ctx);
  ctx.player.scoring = createScoring(ctx);

  // --- presentation --------------------------------------------------------
  ctx.fx = createFX(ctx);
  ctx.audio = createAudio(ctx);
  ctx.hud = createHUD(ctx);
  ctx.screens = createScreens(ctx);
  ctx.cameraRig = createCameraRig(ctx);

  const spawn = ctx.world.park.spawnPoints?.[0];
  if (spawn) ctx.player.physics.respawn(spawn);
  ctx.cameraRig.snap(ctx);

  engine.configureAO({ radius: 0.4, distanceExponent: 1.7, thickness: 0.35, scale: 1.1 });

  // --- loop ----------------------------------------------------------------
  let last = performance.now();
  let accumulator = 0;

  function frame(now) {
    requestAnimationFrame(frame);
    const rawDt = Math.min((now - last) / 1000, 0.25);
    last = now;
    const dt = rawDt * ctx.time.scale;
    ctx.time.dt = dt;
    ctx.time.elapsed += dt;
    ctx.time.frame++;

    input.poll(now);

    if (!ctx.flags.paused && !ctx.flags.freeze) {
      accumulator += dt;
      let steps = 0;
      while (accumulator >= FIXED_DT && steps < MAX_SUBSTEPS) {
        ctx.player.physics.fixedUpdate(FIXED_DT, ctx);
        ctx.player.grind.fixedUpdate(FIXED_DT, ctx);
        ctx.player.tricks.fixedUpdate(FIXED_DT, ctx);
        ctx.player.scoring.fixedUpdate(FIXED_DT, ctx);
        accumulator -= FIXED_DT;
        steps++;
      }
      if (steps === MAX_SUBSTEPS) accumulator = 0;
    }

    ctx.player.anim.update(dt, ctx);
    ctx.world.environment.update?.(dt, ctx);
    ctx.world.park.update?.(dt, ctx);
    ctx.cameraRig.update(dt, ctx);
    ctx.fx.update(dt, ctx);
    ctx.audio.update(dt, ctx);
    ctx.hud.update(dt, ctx);
    ctx.screens.update?.(dt, ctx);

    engine.render(ctx.time.elapsed);
  }
  requestAnimationFrame(frame);

  // --- harness hooks (used by the screenshot/critic tooling) ---------------
  window.__BMX = {
    ctx,
    THREE,
    ready: true,
    stats: () => ({
      calls: engine.renderer.info.render.calls,
      tris: engine.renderer.info.render.triangles,
      programs: engine.renderer.info.programs?.length ?? 0,
      textures: engine.renderer.info.memory.textures,
      geometries: engine.renderer.info.memory.geometries,
    }),
    /** Park a free camera for beauty shots: pos/target in world space. */
    setCamera(px, py, pz, tx, ty, tz, fov = 45) {
      ctx.flags.freeCam = true;
      engine.camera.position.set(px, py, pz);
      engine.camera.fov = fov;
      engine.camera.updateProjectionMatrix();
      engine.camera.lookAt(tx, ty, tz);
      ctx.cameraRig.update = () => {};
    },
    teleport(x, y, z, yaw = 0) {
      ctx.player.physics.respawn({ position: new THREE.Vector3(x, y, z), yaw });
      ctx.cameraRig.snap?.(ctx);
    },
    setQuality: (q) => engine.setQuality(q),
    pause: (v) => { ctx.flags.paused = v; },
  };
  document.body.dataset.ready = '1';
}

boot().catch((err) => {
  console.error(err);
  const el = document.createElement('pre');
  el.style.cssText = 'position:fixed;inset:0;padding:24px;color:#ff6b6b;background:#12141a;font:13px/1.5 ui-monospace,monospace;white-space:pre-wrap;z-index:9999';
  el.textContent = 'BOOT FAILURE\n\n' + (err?.stack || err);
  document.body.appendChild(el);
  document.body.dataset.error = '1';
});
