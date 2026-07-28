#!/usr/bin/env node
// Quick headless probe: boot the game, run a scripted action, dump state.
// Usage: node tools/probe.mjs "<js expression evaluated after boot>"
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = process.argv[2] || 'JSON.stringify(window.__BMX.stats())';
const WAIT = parseInt(process.argv[3] || '4000', 10);
const port = 5400 + Math.floor(Math.random() * 300);

const server = spawn('npx', ['vite', '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
  { cwd: ROOT, stdio: 'ignore' });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 120; i++) {
  try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) break; } catch {}
  await wait(250);
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 520 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push('[pageerror] ' + (e.stack || e.message)));
await page.goto(`http://127.0.0.1:${port}/?q=low`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => document.body.dataset.ready === '1' || document.body.dataset.error === '1', null, { timeout: 180000 });
await page.waitForTimeout(1500);

const out = await page.evaluate(async ({ script, waitMs }) => {
  // eslint-disable-next-line no-new-func
  const fn = new Function('return (async () => { ' + script + ' })()');
  try { return await fn(); } catch (e) { return 'EVAL ERROR: ' + (e.stack || e.message); }
}, { script: SCRIPT, waitMs: WAIT });

console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
if (logs.length) console.log('\n--- console ---\n' + logs.slice(-25).join('\n'));
await browser.close();
server.kill('SIGKILL');
process.exit(0);
