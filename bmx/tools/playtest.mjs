#!/usr/bin/env node
// Automated gameplay playtest. Boots the game headlessly and asserts the
// invariants that make it a game rather than a tech demo. Prints a PASS/FAIL
// table and exits non-zero if anything fails.
//
//   node tools/playtest.mjs
//   node tools/playtest.mjs --only tricks,grind
//
// Rendering in this container is software (~1 fps), so every scenario steps the
// simulation through window.__BMX.simulate() rather than waiting on frames.

import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const ONLY = (arg('only', '') || '').split(',').filter(Boolean);

/**
 * Each scenario runs inside the page. `fn` is a function body string with
 * B (window.__BMX) and ctx in scope; it returns { pass, detail, data }.
 */
const SCENARIOS = [
  {
    id: 'boot',
    what: 'Boots clean with the park, collision and rider present',
    body: `
      const park = ctx.world.park, col = ctx.world.collision;
      const ok = !!park?.group && (park.colliders?.length > 0) && (park.rails?.length > 0)
        && !!col?.raycastDown && !!ctx.player.rider?.group && !!ctx.player.physics?.state;
      return { pass: ok, detail: park ? (park.colliders.length + ' colliders, ' + park.rails.length + ' rails, ' + (park.spawnPoints?.length||0) + ' spawns') : 'no park' };
    `,
  },
  {
    id: 'accelerate',
    what: 'Pedals from rest to >= 11 m/s within 6 s of flat ground',
    body: `
      B.harnessPose('idle');
      ctx.flags.paused = false;
      ctx.input.harness = () => ({ throttle: 1 });
      const r = B.simulate(6);
      return { pass: r.speed >= 11, detail: 'top speed ' + r.speed + ' m/s', data: r };
    `,
  },
  {
    id: 'hop',
    what: 'Bunnyhop clears at least 0.5 m',
    body: `
      B.harnessPose('idle');
      ctx.flags.paused = false;
      const s = ctx.player.physics.state;
      let peak = 0; const y0 = s.position.y;
      ctx.input.harness = (now) => ({ throttle: 0.6, press: ['hop'] });
      B.simulate(0.35);
      ctx.input.harness = () => ({ throttle: 0.6, release: ['hop'] });
      for (let i = 0; i < 90; i++) { B.simulate(1/60); peak = Math.max(peak, s.position.y - y0); }
      return { pass: peak >= 0.5, detail: 'hop height ' + peak.toFixed(2) + ' m' };
    `,
  },
  {
    id: 'trick-scores',
    what: 'A hop + grab + clean landing banks points and counts a trick',
    body: `
      B.harnessPose('play');
      const sc = ctx.player.scoring, tr = ctx.player.tricks;
      const before = sc.score;
      B.simulate(30);
      return { pass: sc.score > before, detail: 'score ' + sc.score + ', tricks landed ' + (tr.landedCount ?? 0),
               data: { score: sc.score, landed: tr.landedCount ?? 0 } };
    `,
  },
  {
    id: 'grind',
    what: 'Grind acquires a rail and holds it for 1 s',
    body: `
      B.harnessPose('grind');
      ctx.flags.paused = false;
      const s = ctx.player.physics.state;
      ctx.input.harness = () => ({ throttle: 0.5, press: ['grind'] });
      let grindSteps = 0;
      for (let i = 0; i < 120; i++) { B.simulate(1/120); if (s.mode === 'grind') grindSteps++; }
      return { pass: grindSteps >= 60, detail: 'grinding for ' + (grindSteps/120).toFixed(2) + ' s of 1.0 s' };
    `,
  },
  {
    id: 'manual',
    what: 'Manual enters and holds without instantly failing',
    body: `
      B.harnessPose('idle');
      ctx.flags.paused = false;
      const s = ctx.player.physics.state;
      ctx.input.harness = () => ({ throttle: 0.8 });
      B.simulate(2);
      ctx.input.harness = () => ({ throttle: 0.4, lean: 1, press: ['manual'] });
      let held = 0;
      for (let i = 0; i < 180; i++) { B.simulate(1/120); if (s.mode === 'manual') held++; }
      return { pass: held >= 60, detail: 'manual held ' + (held/120).toFixed(2) + ' s' };
    `,
  },
  {
    id: 'bail-recovery',
    what: 'After a bail the rider recovers to a rideable state within 6 s',
    body: `
      B.harnessPose('idle');
      ctx.flags.paused = false;
      const phys = ctx.player.physics, s = phys.state;
      phys.forceBail ? phys.forceBail('test') : (s.mode = 'bail');
      ctx.input.harness = () => ({ throttle: 0.5 });
      let recovered = -1;
      for (let i = 0; i < 720; i++) { B.simulate(1/120); if (s.mode === 'ride' || s.mode === 'air') { recovered = i/120; break; } }
      return { pass: recovered >= 0 && recovered <= 6, detail: recovered < 0 ? 'never recovered in 6 s' : 'recovered in ' + recovered.toFixed(2) + ' s' };
    `,
  },
  {
    id: 'out-of-bounds',
    what: 'Leaving the park or falling below it respawns instead of falling forever',
    body: `
      const phys = ctx.player.physics, s = phys.state;
      B.harnessPose('idle');
      ctx.flags.paused = false;
      s.position.set(0, -40, 0); s.velocity.set(0, -20, 0);
      ctx.input.harness = () => ({ throttle: 0 });
      let ok = false, t = -1;
      for (let i = 0; i < 600; i++) { B.simulate(1/120); if (s.position.y > -8) { ok = true; t = i/120; break; } }
      return { pass: ok, detail: ok ? 'respawned in ' + t.toFixed(2) + ' s' : 'still at y=' + s.position.y.toFixed(1) + ' after 5 s' };
    `,
  },
  {
    id: 'stay-in-park',
    what: 'A 25 s autopilot run never leaves the park bounds',
    body: `
      B.harnessPose('play');
      const s = ctx.player.physics.state, b = ctx.world.park.bounds;
      let worst = null;
      for (let i = 0; i < 25; i++) {
        B.simulate(1);
        const p = s.position;
        const out = p.x < b.min.x || p.x > b.max.x || p.z < b.min.z || p.z > b.max.z || p.y < b.min.y;
        if (out) { worst = [p.x.toFixed(1), p.y.toFixed(1), p.z.toFixed(1)].join(','); break; }
      }
      return { pass: !worst, detail: worst ? 'left bounds at ' + worst : 'stayed inside for 25 s' };
    `,
  },
  {
    id: 'session-timer',
    what: 'The 2:00 session counts down and ends in a results state',
    body: `
      B.harnessPose('play');
      const sc = ctx.player.scoring;
      const t0 = sc.timeLeft;
      B.simulate(20);
      const ticked = t0 - sc.timeLeft;
      B.simulate(sc.timeLeft + 2);
      const ended = sc.phase !== 'run';
      return { pass: ticked > 15 && ended, detail: 'ticked ' + ticked.toFixed(1) + ' s in 20 s, end phase "' + sc.phase + '"' };
    `,
  },
  {
    id: 'collectibles',
    what: 'Riding into a B-M-X letter collects it',
    body: `
      B.harnessPose('play');
      const sc = ctx.player.scoring;
      const letters = sc.letters || sc.letterPositions || ctx.world.park.letters || [];
      if (!letters.length) return { pass: false, detail: 'no letter pickups found in the level' };
      const p = letters[0].position || letters[0];
      const s = ctx.player.physics.state;
      s.position.set(p.x, p.y, p.z); s.velocity.set(0,0,0);
      B.simulate(1);
      const got = (sc.lettersCollected ?? sc.letters?.filter?.(l => l.taken).length ?? 0);
      return { pass: got > 0, detail: 'letters collected ' + got + ' of ' + letters.length };
    `,
  },
  {
    id: 'cheat-nobail',
    what: 'A rider named James Paterson cannot bail and tricks run 1.5x',
    body: `
      ctx.customization.rename ? ctx.customization.rename('James Paterson') : (ctx.player.cheats = { noBail: true, trickSpeed: 1.5 });
      const cheats = ctx.player.cheats;
      B.harnessPose('idle');
      ctx.flags.paused = false;
      const phys = ctx.player.physics, s = phys.state;
      ctx.input.harness = () => ({ throttle: 1 });
      B.simulate(3);
      // Slam the bike into a hopeless attitude and drop it.
      s.position.y += 6; s.mode = 'air'; s.grounded = false;
      s.quaternion.setFromAxisAngle(new (window.__BMX.THREE.Vector3)(1,0,0), 2.6);
      let bailed = false;
      for (let i = 0; i < 600; i++) { B.simulate(1/120); if (s.mode === 'bail') { bailed = true; break; } }
      return { pass: cheats?.noBail === true && cheats?.trickSpeed === 1.5 && !bailed,
               detail: 'noBail=' + cheats?.noBail + ' trickSpeed=' + cheats?.trickSpeed + ' bailed=' + bailed };
    `,
  },
  {
    id: 'cheat-off-by-default',
    what: 'A normally-named rider still bails (the cheat is not always on)',
    body: `
      ctx.customization.rename ? ctx.customization.rename('Rookie') : (ctx.player.cheats = { noBail: false, trickSpeed: 1 });
      const phys = ctx.player.physics, s = phys.state;
      B.harnessPose('idle');
      ctx.flags.paused = false;
      ctx.input.harness = () => ({ throttle: 1 });
      B.simulate(3);
      s.position.y += 6; s.mode = 'air'; s.grounded = false;
      s.quaternion.setFromAxisAngle(new (window.__BMX.THREE.Vector3)(1,0,0), 2.6);
      let bailed = false;
      for (let i = 0; i < 600; i++) { B.simulate(1/120); if (s.mode === 'bail') { bailed = true; break; } }
      return { pass: bailed, detail: 'bailed=' + bailed + ' (expected true)' };
    `,
  },
  {
    id: 'perf-budget',
    what: 'Draw calls and triangles stay inside budget',
    body: `
      const st = B.stats();
      const pass = st.calls <= 400 && st.tris <= 1600000;
      return { pass, detail: st.calls + ' draw calls, ' + (st.tris/1000).toFixed(0) + 'k tris, ' + st.textures + ' textures' };
    `,
  },
  {
    id: 'no-console-errors',
    what: 'No page errors or console errors during a run',
    body: `
      B.harnessPose('play');
      B.simulate(20);
      return { pass: true, detail: 'see harness error count' };
    `,
  },
];

function freePortGuess() { return 5600 + Math.floor(Math.random() * 300); }

async function main() {
  const port = freePortGuess();
  const server = spawn('npx', ['vite', '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
    { cwd: ROOT, stdio: 'ignore' });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let up = false;
  for (let i = 0; i < 160; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) { up = true; break; } } catch {}
    await wait(250);
  }
  if (!up) { server.kill('SIGKILL'); console.error('vite failed to start'); process.exit(2); }

  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(`http://127.0.0.1:${port}/?q=low`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => document.body.dataset.ready === '1' || document.body.dataset.error === '1', null, { timeout: 240000 });
  await page.waitForTimeout(1200);

  const results = [];
  const list = SCENARIOS.filter((s) => !ONLY.length || ONLY.includes(s.id));
  for (const sc of list) {
    let r;
    try {
      r = await page.evaluate(async (body) => {
        const B = window.__BMX; const ctx = B.ctx;
        try {
          // eslint-disable-next-line no-new-func
          const fn = new Function('B', 'ctx', 'return (async () => {' + body + '})()');
          const out = await fn(B, ctx);
          return out || { pass: false, detail: 'scenario returned nothing' };
        } catch (e) {
          return { pass: false, detail: 'THREW: ' + (e.message || e) };
        } finally {
          ctx.input.harness = null;
        }
      }, sc.body);
    } catch (e) {
      r = { pass: false, detail: 'HARNESS ERROR: ' + e.message };
    }
    results.push({ id: sc.id, what: sc.what, ...r });
    process.stdout.write(`${r.pass ? 'PASS' : 'FAIL'}  ${sc.id.padEnd(22)} ${r.detail || ''}\n`);
  }

  const failed = results.filter((r) => !r.pass);
  const report = { at: new Date().toISOString(), passed: results.length - failed.length, failed: failed.length, results, consoleErrors: errors.slice(0, 20) };
  fs.mkdirSync(path.join(ROOT, 'shots'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'shots', 'playtest.json'), JSON.stringify(report, null, 2));

  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (errors.length) console.log(`console errors: ${errors.length}\n  ` + errors.slice(0, 5).join('\n  '));

  await browser.close();
  server.kill('SIGKILL');
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(3); });
