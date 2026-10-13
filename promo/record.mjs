#!/usr/bin/env node
// Records promo.html to an MP4, one frame at a time.
//
//   node promo/record.mjs                      → promo/csdmflow-promo.mp4
//   node promo/record.mjs --stills 0,8.5,36    → promo/stills/t8.5.png …
//   node promo/record.mjs --from 25 --to 44    → just that stretch
//
// Drives headless Chrome over the DevTools protocol (Node's built-in
// WebSocket, no packages): seek(t) for every frame, screenshot, pipe the PNGs
// into ffmpeg. Deterministic, so a frame looks the same however slow the
// machine is. Needs Google Chrome and ffmpeg (with libx264).

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const W = 1080, H = 1350;
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const port = 9400 + Math.floor(Math.random() * 400);
const profile = mkdtempSync(path.join(tmpdir(), 'csdmflow-promo-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--hide-scrollbars', '--force-device-scale-factor=1', '--font-render-hinting=none',
  `--window-size=${W},${H}`, 'about:blank',
], { stdio: 'ignore' });
const cleanup = () => { try { chrome.kill(); } catch {} try { rmSync(profile, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

async function json(url) {
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(url); if (r.ok) return await r.json(); } catch {}
    await sleep(100);
  }
  throw new Error('Chrome did not start: ' + url);
}

const page = (await json(`http://127.0.0.1:${port}/json/list`)).find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0;
const pending = new Map(), events = [];
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) rej(new Error(m.error.message)); else res(m.result);
  } else if (m.method) events.forEach(f => f(m));
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

await send('Page.enable');
await send('Runtime.enable');
events.push(m => { if (m.method === 'Runtime.exceptionThrown') console.error('page error:', m.params.exceptionDetails.exception?.description); });
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
const loaded = new Promise(res => events.push(m => { if (m.method === 'Page.loadEventFired') res(); }));
await send('Page.navigate', { url: pathToFileURL(path.join(here, 'promo.html')).href });
await loaded;
await evaluate('window.promoReady');
const fps = await evaluate('window.PROMO_FPS');
const duration = await evaluate('window.PROMO_DURATION');

async function frame(t) {
  await evaluate(`seek(${t})`);
  const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: W, height: H, scale: 1 } });
  return Buffer.from(data, 'base64');
}

const stills = opt('stills');
if (stills) {
  const dir = path.join(here, 'stills');
  mkdirSync(dir, { recursive: true });
  for (const s of stills.split(',')) {
    writeFileSync(path.join(dir, `t${s}.png`), await frame(+s));
    console.log(`stills/t${s}.png`);
  }
} else {
  const from = +opt('from', 0), to = +opt('to', duration);
  const out = opt('out', path.join(here, 'csdmflow-promo.mp4'));
  const ff = spawn('ffmpeg', [
    '-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-tune', 'animation',
    '-pix_fmt', 'yuv420p', '-r', String(fps), '-movflags', '+faststart', out,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });
  const total = Math.round((to - from) * fps);
  const started = Date.now();
  for (let f = 0; f < total; f++) {
    const buf = await frame(from + f / fps);
    if (!ff.stdin.write(buf)) await once(ff.stdin, 'drain');
    if (f % 60 === 0) process.stdout.write(`\rframe ${f}/${total} (${((Date.now() - started) / 1000).toFixed(0)}s)`);
  }
  ff.stdin.end();
  const [code] = await once(ff, 'close');
  if (code !== 0) throw new Error('ffmpeg failed with code ' + code);
  console.log(`\nwrote ${path.relative(process.cwd(), out)} (${total} frames, ${(total / fps).toFixed(1)}s)`);
}
ws.close();
cleanup();
process.exit(0);
