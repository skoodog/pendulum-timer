#!/usr/bin/env node
// Assemble the built game into ONE self-contained HTML file suitable for
// publishing as an Artifact (strict CSP: no external requests at all).
//
//   npx vite build && node tools/bundle.mjs
//
// Output: dist/play.html

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

const assets = fs.readdirSync(path.join(DIST, 'assets'));
const jsFile = assets.find((f) => f.endsWith('.js'));
const cssFile = assets.find((f) => f.endsWith('.css'));
if (!jsFile) throw new Error('no js bundle in dist/assets');

const js = fs.readFileSync(path.join(DIST, 'assets', jsFile), 'utf8');
const css = cssFile ? fs.readFileSync(path.join(DIST, 'assets', cssFile), 'utf8') : '';

// A literal </script> inside the bundle would close the tag early.
const safeJs = js.replace(/<\/script/gi, '<\\/script');

const html = `<title>Mirra City — BMX Freestyle</title>
<style>
/* ---- page ground: the game owns the whole viewport ---------------------- */
:root { color-scheme: dark; }
html, body { margin: 0; padding: 0; height: 100%; background: #0a0c11; overflow: hidden; }
#viewport { position: fixed; inset: 0; width: 100vw; height: 100vh; display: block; }
#ui-root { position: fixed; inset: 0; pointer-events: none; }

/* ---- boot curtain -------------------------------------------------------
   The world is generated procedurally at load (textures, park, collision
   grid), which takes a few seconds. Show something with the game's own
   identity rather than a white void. */
#boot {
  position: fixed; inset: 0; z-index: 50;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 1.25rem; background: radial-gradient(120% 90% at 50% 30%, #17202e 0%, #0a0c11 70%);
  font-family: ui-sans-serif, "Helvetica Neue", Arial, sans-serif; color: #f2f5fa;
  transition: opacity .5s ease; cursor: pointer;
}
#boot.gone { opacity: 0; pointer-events: none; }
#boot h1 {
  margin: 0; font-size: clamp(2rem, 7vw, 4.5rem); font-weight: 800;
  letter-spacing: -.03em; font-style: italic; line-height: .95;
  text-transform: uppercase; text-wrap: balance;
  background: linear-gradient(180deg, #ffd76a 0%, #f0a12c 100%);
  -webkit-background-clip: text; background-clip: text; color: transparent;
}
#boot .sub {
  margin: 0; font-size: .8rem; letter-spacing: .34em; text-transform: uppercase;
  color: #8494ab; font-weight: 600;
}
#boot .bar { width: min(340px, 62vw); height: 3px; background: #1e2734; overflow: hidden; border-radius: 2px; }
#boot .bar i { display: block; height: 100%; width: 35%; background: linear-gradient(90deg, #f0a12c, #ffd76a);
  animation: slide 1.15s ease-in-out infinite; }
@keyframes slide { 0% { transform: translateX(-100%); } 100% { transform: translateX(390%); } }
#boot .hint { margin: 0; font-size: .82rem; color: #63718a; letter-spacing: .02em; }
#boot .keys { display: flex; gap: .4rem; flex-wrap: wrap; justify-content: center; max-width: 34rem; }
#boot kbd {
  font: 600 .7rem/1 ui-monospace, SFMono-Regular, Menlo, monospace;
  padding: .34rem .5rem; border-radius: 4px; color: #cbd5e3;
  background: #161d28; border: 1px solid #263141; border-bottom-width: 2px;
}
@media (prefers-reduced-motion: reduce) { #boot .bar i { animation: none; width: 100%; } }
</style>

<canvas id="viewport"></canvas>
<div id="ui-root"></div>

<div id="boot">
  <h1>Mirra City</h1>
  <p class="sub">BMX Freestyle</p>
  <div class="bar"><i></i></div>
  <p class="hint">Building the park — textures, geometry and collision are generated in your browser.</p>
  <div class="keys">
    <kbd>W A S D</kbd><kbd>Shift — pedal</kbd><kbd>Space — hop</kbd><kbd>J K L — tricks</kbd>
    <kbd>U — grind</kbd><kbd>I — manual</kbd><kbd>Q E — spin</kbd><kbd>R — respawn</kbd><kbd>Esc — pause</kbd>
  </div>
</div>

<style>${css}</style>
<script type="module">${safeJs}</script>
<script>
(function () {
  var boot = document.getElementById('boot');
  function dismiss() {
    if (!boot || boot.classList.contains('gone')) return;
    boot.classList.add('gone');
    setTimeout(function () { boot.remove(); }, 600);
    try { window.focus(); } catch (e) {}
  }
  // The game stamps data-ready on <body> once the world has finished building.
  var poll = setInterval(function () {
    if (document.body.dataset.ready === '1') { clearInterval(poll); dismiss(); }
    else if (document.body.dataset.error === '1') { clearInterval(poll); dismiss(); }
  }, 250);
  boot && boot.addEventListener('click', dismiss);
  // Keyboard goes to the frame that has focus; take it on any interaction.
  window.addEventListener('pointerdown', function () { try { window.focus(); } catch (e) {} });
})();
</script>
`;

fs.writeFileSync(path.join(DIST, 'play.html'), html);
const kb = (fs.statSync(path.join(DIST, 'play.html')).size / 1024).toFixed(0);
console.log(`dist/play.html  ${kb} KB  (js ${(js.length / 1024).toFixed(0)} KB, css ${(css.length / 1024).toFixed(0)} KB)`);
