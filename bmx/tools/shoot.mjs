#!/usr/bin/env node
// Screenshot harness: boots the game headlessly, drives it through a set of
// camera/gameplay poses and writes PNGs + a run report. Used by the visual
// critic loop.
//
//   node tools/shoot.mjs --out shots/base
//   node tools/shoot.mjs --out shots/x --only hero,rider --w 1600 --h 900
//
// Exit code is non-zero if the page threw during boot.

import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : def;
};
const OUT = path.resolve(ROOT, arg('out', 'shots/run'));
const WIDTH = parseInt(arg('w', '1600'), 10);
const HEIGHT = parseInt(arg('h', '900'), 10);
const ONLY = (arg('only', '') || '').split(',').filter(Boolean);
const QUALITY = arg('q', 'high');

/** Beauty/diagnostic shots. `cam` = [px,py,pz, tx,ty,tz, fov]. */
// `rel` = camera offset relative to the rider [x, y, z, fov] (used with `setup`).
// `cam` = absolute [px,py,pz, tx,ty,tz, fov] for environment shots.
export const SHOTS = [
  { id: 'hero', desc: 'Signature marketing frame: rider mid-air off the big quarterpipe, park and skyline behind.',
    setup: 'air', rel: [3.4, 1.2, 4.2, 42] },
  { id: 'park-wide', desc: 'Establishing wide of the whole park showing layout, lighting and set dressing.',
    cam: [-34, 22, 38, 0, 1, -4, 45] },
  { id: 'rider-closeup', desc: 'Close-up on the rider and bike: frame welds, spokes, tyre tread, cloth, helmet.',
    setup: 'idle', rel: [1.9, 0.7, 2.2, 34] },
  { id: 'bike-detail', desc: 'Macro on the drivetrain and rear wheel: cranks, sprocket, chain, pegs, hub.',
    setup: 'idle', rel: [0.9, -0.25, 1.1, 26] },
  { id: 'grind', desc: 'Rail grind: sparks, contact shadow, rail material, rider balance pose.',
    setup: 'grind', rel: [3.2, 0.9, 3.4, 40] },
  { id: 'gameplay', desc: 'Actual in-game chase camera during a run — what the player really sees, HUD included.',
    setup: 'play' },
  { id: 'bowl', desc: 'Bowl / pool section: coping, transitions, tiling, drain, graffiti.',
    cam: [-20, 8, 14, -30, 0, 0, 48] },
  { id: 'ground-detail', desc: 'Low angle at ground level: concrete texel density, cracks, AO contact, decals.',
    cam: [4, 0.35, 16, -4, 0.1, 6, 40] },
  { id: 'skyline', desc: 'Camera looking out at the sky, backdrop and distant city — atmosphere and fog.',
    cam: [0, 6, 20, 0, 14, -60, 55] },
  { id: 'dusk', desc: 'Same hero framing under the evening lighting preset (lights, bloom, shadow length).',
    setup: 'air', rel: [3.4, 1.2, 4.2, 42], timeOfDay: 0.88 },

  // --- framings that mirror the supplied reference frames -------------------
  { id: 'ref1-match', desc: 'REFERENCE 1 FRAMING: close chase camera from behind and slightly above, rider mid-air over a concrete transition, park and city skyline filling the background, HUD live. Compare directly against reference/target-look.png.',
    setup: 'air', rel: [0.2, 1.5, 5.2, 46], hud: true },
  { id: 'ref2-match', desc: 'REFERENCE 2 FRAMING: low close camera near ledge height looking slightly up at the rider grinding, ground surface filling the lower third, city behind. Compare against the SECOND REFERENCE description in ARCHITECTURE.md.',
    setup: 'grind', rel: [2.2, 0.35, 3.0, 44], hud: true },
];

function freePort(start = 5178) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(start, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.on('error', () => resolve(freePort(start + 1)));
  });
}

async function waitForServer(url, timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const port = await freePort(5178 + Math.floor(Math.random() * 400));
  const server = spawn('npx', ['vite', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' },
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });

  const base = `http://127.0.0.1:${port}/`;
  if (!(await waitForServer(base))) {
    server.kill('SIGKILL');
    console.error('vite failed to start:\n' + serverLog);
    process.exit(2);
  }

  const browser = await chromium.launch({
    args: [
      '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-dev-shm-usage',
    ],
  });
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });

  const errors = [];
  const logs = [];
  page.on('console', (m) => {
    const t = `[${m.type()}] ${m.text()}`;
    logs.push(t);
    if (m.type() === 'error') errors.push(t);
  });
  page.on('pageerror', (e) => errors.push('[pageerror] ' + (e.stack || e.message)));

  const report = { startedAt: new Date().toISOString(), width: WIDTH, height: HEIGHT, shots: [], errors, boot: {} };

  await page.goto(`${base}?q=${QUALITY}`, { waitUntil: 'load', timeout: 120000 });

  // Wait for boot (or a boot failure banner).
  try {
    await page.waitForFunction(() => document.body.dataset.ready === '1' || document.body.dataset.error === '1', null, { timeout: 180000 });
  } catch {
    errors.push('[harness] boot timed out after 180s');
  }
  const failed = await page.evaluate(() => document.body.dataset.error === '1');
  report.boot.ok = !failed;
  if (failed) {
    report.boot.message = await page.evaluate(() => document.querySelector('pre')?.textContent || '');
  }

  if (!failed) {
    // let generation settle + a few frames render
    await page.waitForTimeout(2500);
    report.boot.stats = await page.evaluate(() => window.__BMX?.stats?.() ?? null);
    report.boot.fps = await page.evaluate(async () => {
      const t0 = performance.now(); let frames = 0;
      await new Promise((res) => {
        const tick = () => { frames++; if (performance.now() - t0 > 2000) res(); else requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
      });
      return Math.round((frames * 1000) / (performance.now() - t0));
    });

    const shots = SHOTS.filter((s) => !ONLY.length || ONLY.includes(s.id));
    for (const shot of shots) {
      try {
        await page.evaluate(async (s) => {
          const B = window.__BMX;
          if (!B) return;
          if (s.timeOfDay != null) B.ctx.world.environment.setTimeOfDay?.(s.timeOfDay);
          else B.ctx.world.environment.setTimeOfDay?.(0.72);
          if (s.hud) {
            // Put a real run on the clock so the HUD has a score, combo and timer
            // to show, then stage the pose and keep the HUD visible.
            B.harnessPose?.('play');
            B.simulate?.(24);
          }
          if (s.setup) B.harnessPose?.(s.setup, s.rel);
          else if (s.cam) B.setCamera(...s.cam);
          if (s.hud) { B.ctx.flags.freeCam = false; B.ctx.flags.hideHud = false; }
        }, shot);
        await page.waitForTimeout(shot.setup === 'play' ? 5000 : 1200);
        if (shot.setup === 'play') await page.evaluate(() => window.__BMX?.pause(true));
        const file = path.join(OUT, `${shot.id}.png`);
        await page.screenshot({ path: file, type: 'png', timeout: 180000 });
        report.shots.push({ id: shot.id, desc: shot.desc, file: path.relative(ROOT, file) });
      } catch (e) {
        report.shots.push({ id: shot.id, error: String(e) });
      }
    }
  }

  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(OUT, 'console.log'), logs.join('\n'));
  await browser.close();
  server.kill('SIGKILL');

  console.log(JSON.stringify({
    out: path.relative(ROOT, OUT),
    bootOk: report.boot.ok,
    fps: report.boot.fps,
    stats: report.boot.stats,
    shots: report.shots.map((s) => s.id + (s.error ? ' (ERROR)' : '')),
    errorCount: errors.length,
    firstErrors: errors.slice(0, 5),
    bootMessage: report.boot.message,
  }, null, 2));

  process.exit(report.boot.ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(3); });
