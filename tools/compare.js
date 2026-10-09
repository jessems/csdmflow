#!/usr/bin/env node
'use strict';

// csdmflow compare — side-by-side of each reference slide and its .csdm render.
// Self-contained, no dependencies. Hot reload: editing a .csdm file, or the
// engine/compiler in src/, re-renders and refreshes the page.
//
// Usage: node tools/compare.js [examples-dir] [--slides dir] [--port 4420]
//   examples-dir  default examples        (files named slide-NNN-*.csdm pair with slide NNN)
//   --slides      default .slides         (slide-NNN.png, see tools/extract-slides.sh)
// Without slide images it still works as a live preview of every .csdm file.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ENGINE_DIR = path.join(__dirname, '..', 'src');
const DEBOUNCE_MS = 200;

let dir = 'examples';
let slidesDir = '.slides';
let portStart = 4420;
{
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port') portStart = parseInt(args[++i], 10);
    else if (args[i] === '--slides') slidesDir = args[++i];
    else dir = args[i];
  }
}
dir = path.resolve(dir);
slidesDir = path.resolve(slidesDir);
if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
  console.error(`csdmflow-compare: no such directory: ${dir}`);
  process.exit(1);
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Fresh engine on every build so edits to gridflow.js / csdm.js hot-reload too.
function loadEngine() {
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(ENGINE_DIR + path.sep)) delete require.cache[k];
  }
  return { ...require('../src/gridflow'), ...require('../src/csdm') };
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

let examples = []; // {name, slide, title, svg, warnings, error, source, gf}
let stamp = Date.now();

function build() {
  const engine = loadEngine();
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.csdm')).sort();
  examples = files.map(f => {
    const name = f.replace(/\.csdm$/, '');
    const m = /^slide-(\d+)/.exec(name);
    const source = fs.readFileSync(path.join(dir, f), 'utf8');
    const t = /^title\s+"([^"]*)"/m.exec(source);
    const ex = { name, slide: m ? parseInt(m[1], 10) : null, title: t ? t[1] : name, source };
    try {
      const compiled = engine.compileCsdm(source);
      const r = engine.renderSvg(compiled.gf);
      Object.assign(ex, { svg: r.svg, gf: compiled.gf, warnings: [...compiled.warnings, ...r.warnings] });
    } catch (err) {
      ex.error = err.message;
      ex.warnings = [];
    }
    return ex;
  });
  stamp = Date.now();
}

const slideFile = n => `slide-${String(n).padStart(3, '0')}.png`;
// cache-bust slide images by mtime so a re-export shows up on reload
const slideStamp = n => {
  try { return Math.round(fs.statSync(path.join(slidesDir, slideFile(n))).mtimeMs); } catch (_) { return 0; }
};

function page() {
  const nav = examples.map(ex => {
    const badge = ex.error ? '<b class="bad">error</b>'
      : ex.warnings.length ? `<b class="warnb">${ex.warnings.length}</b>` : '';
    return `<a href="#${esc(ex.name)}"><span class="num">${ex.slide ?? '–'}</span>${esc(ex.title)}${badge}</a>`;
  }).join('');

  const rows = examples.map(ex => {
    const slideImg = !ex.slide
      ? '<div class="empty">no slide number in the file name</div>'
      : slideStamp(ex.slide)
        ? `<img loading="lazy" src="/slides/${slideFile(ex.slide)}?v=${slideStamp(ex.slide)}" alt="slide ${ex.slide}">`
        : `<div class="empty">no image for slide ${ex.slide}<br><small>run tools/extract-slides.sh &lt;deck.pptx&gt; ${esc(path.relative(process.cwd(), slidesDir) || '.')}</small></div>`;
    const render = ex.error
      ? `<div class="error">${esc(ex.error)}</div>`
      : `<img loading="lazy" src="/render/${encodeURIComponent(ex.name)}.svg?v=${stamp}" alt="render">`;
    const warns = ex.warnings.length
      ? `<ul class="warns">${ex.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : '';
    const gf = ex.gf ? `<details><summary>generated .gf</summary><pre>${esc(ex.gf)}</pre></details>` : '';
    return `<section id="${esc(ex.name)}">
  <header><h2><span class="num">${ex.slide ?? ''}</span>${esc(ex.title)}</h2><code>${esc(ex.name)}.csdm</code></header>
  <div class="pair">
    <figure><figcaption>reference slide</figcaption><div class="frame zoomable">${slideImg}</div></figure>
    <figure><figcaption>csdmflow render</figcaption><div class="frame zoomable">${render}</div></figure>
  </div>
  ${warns}
  <details><summary>.csdm source</summary><pre>${esc(ex.source)}</pre></details>
  ${gf}
</section>`;
  }).join('\n');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>csdmflow compare</title>
<style>
  :root { --bg:#0d1b26; --panel:#13293a; --line:#23405a; --text:#e6edf3; --muted:#8fa3b5; --accent:#73c26a; --warn:#f0ac45; --bad:#ff7b72; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.45 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; display:grid; grid-template-columns: 260px 1fr; min-height:100vh; }
  nav { position:sticky; top:0; height:100vh; overflow:auto; border-right:1px solid var(--line); padding:16px 10px; background:#0a1620; }
  nav h1 { font-size:15px; margin:0 6px 4px; }
  nav p { color:var(--muted); font-size:12px; margin:0 6px 12px; }
  nav a { display:flex; gap:8px; align-items:baseline; padding:5px 6px; border-radius:6px; color:var(--text); text-decoration:none; font-size:13px; }
  nav a:hover { background:var(--panel); }
  nav b { margin-left:auto; font-size:11px; padding:0 6px; border-radius:8px; }
  .warnb { background:#3b2a10; color:var(--warn); } .bad { background:#3d1614; color:var(--bad); }
  .num { color:var(--muted); font-variant-numeric:tabular-nums; min-width:2.2em; display:inline-block; }
  main { padding:20px 24px 80px; min-width:0; }
  .controls { position:sticky; top:0; z-index:5; background:var(--bg); padding:8px 0 12px; display:flex; gap:12px; align-items:center; color:var(--muted); font-size:13px; border-bottom:1px solid var(--line); margin-bottom:16px; }
  .controls label { display:flex; gap:6px; align-items:center; cursor:pointer; }
  .live { margin-left:auto; } .live::before { content:"●"; color:var(--accent); margin-right:6px; }
  section { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px 16px; margin-bottom:22px; scroll-margin-top:60px; }
  section header { display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; }
  h2 { font-size:16px; margin:0 0 10px; } code { color:var(--muted); font-size:12px; }
  .pair { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
  body.stacked .pair { grid-template-columns:1fr; }
  figure { margin:0; min-width:0; }
  figcaption { color:var(--muted); font-size:12px; margin-bottom:4px; }
  .frame { background:#0a1620; border:1px solid var(--line); border-radius:6px; height:var(--h, 420px); display:flex; align-items:center; justify-content:center; overflow:hidden; cursor:zoom-in; }
  .frame img { max-width:100%; max-height:100%; display:block; }
  .error { color:var(--bad); font-family:ui-monospace, Menlo, monospace; font-size:12px; padding:16px; white-space:pre-wrap; }
  .empty { color:var(--muted); }
  .warns { margin:10px 0 0; padding-left:18px; color:var(--warn); font-family:ui-monospace, Menlo, monospace; font-size:12px; }
  details { margin-top:8px; } summary { color:var(--muted); cursor:pointer; font-size:12px; }
  pre { background:#0a1620; border:1px solid var(--line); border-radius:6px; padding:10px; overflow:auto; font-size:12px; max-height:360px; }
  #lightbox { position:fixed; inset:0; background:rgba(4,10,16,.94); display:none; z-index:20; overflow:auto; cursor:zoom-out; padding:24px; }
  #lightbox.on { display:block; } #lightbox img { display:block; margin:0 auto; max-width:none; width:min(1800px, 100%); }
  @media (max-width: 900px) { body { grid-template-columns:1fr; } nav { position:static; height:auto; } .pair { grid-template-columns:1fr; } }
</style></head><body>
<nav><h1>csdmflow compare</h1><p>${examples.length} examples · ${esc(path.relative(process.cwd(), dir))}</p>${nav}</nav>
<main>
  <div class="controls">
    <label><input type="checkbox" id="stack"> stack vertically</label>
    <label>height <input type="range" id="h" min="240" max="900" step="20" value="420"></label>
    <span class="live">live — edit a .csdm file or src/</span>
  </div>
  ${rows || '<p>No .csdm files yet.</p>'}
</main>
<div id="lightbox"></div>
<script>
  // keep scroll + view settings across hot reloads
  var KEY = 'csdm-compare';
  var st = {}; try { st = JSON.parse(sessionStorage.getItem(KEY)) || {}; } catch (e) {}
  function save() { try { st.y = scrollY; sessionStorage.setItem(KEY, JSON.stringify(st)); } catch (e) {} }
  var stack = document.getElementById('stack'), h = document.getElementById('h');
  function applyView() {
    document.body.classList.toggle('stacked', !!st.stack); stack.checked = !!st.stack;
    if (st.h) h.value = st.h; document.documentElement.style.setProperty('--h', h.value + 'px');
  }
  stack.onchange = function () { st.stack = stack.checked; applyView(); save(); };
  h.oninput = function () { st.h = h.value; applyView(); save(); };
  applyView();
  if (st.y) requestAnimationFrame(function () { scrollTo(0, st.y); });
  addEventListener('scroll', function () { clearTimeout(window._t); window._t = setTimeout(save, 150); });

  var lb = document.getElementById('lightbox');
  document.querySelectorAll('.zoomable').forEach(function (f) {
    f.onclick = function () { var img = f.querySelector('img'); if (!img) return;
      lb.innerHTML = '<img src="' + img.src + '">'; lb.classList.add('on'); };
  });
  lb.onclick = function () { lb.classList.remove('on'); };
  addEventListener('keydown', function (e) { if (e.key === 'Escape') lb.classList.remove('on'); });

  var es = new EventSource('/events');
  es.onmessage = function (e) { if (e.data === 'reload') { save(); location.reload(); } };
  es.onerror = function () { setTimeout(function () { save(); location.reload(); }, 1500); };
</script>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Watch: examples (.csdm) and the engine (.js)
// ---------------------------------------------------------------------------

let sseClients = [];
let debounce = null;
function rebuild(why) {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    try {
      build();
      sseClients.forEach(res => res.write('data: reload\n\n'));
      console.log(`[csdmflow-compare] rebuilt (${why}) ${new Date().toLocaleTimeString()}`);
    } catch (err) {
      console.error('[csdmflow-compare] rebuild error: ' + err.message);
    }
  }, DEBOUNCE_MS);
}
build();
fs.watch(dir, (evt, name) => { if (name && name.endsWith('.csdm')) rebuild(name); });
fs.watch(ENGINE_DIR, (evt, name) => { if (name && name.endsWith('.js')) rebuild(name); });

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function handler(req, res) {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(page());
  }
  if (url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('data: connected\n\n');
    sseClients.push(res);
    res.on('close', () => { sseClients = sseClients.filter(c => c !== res); });
    return;
  }
  let m = /^\/render\/([\w.-]+)\.svg$/.exec(url);
  if (m) {
    const ex = examples.find(e => e.name === m[1]);
    if (ex && ex.svg) {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
      return res.end(ex.svg);
    }
  }
  m = /^\/slides\/(slide-\d{3}\.png)$/.exec(url);
  if (m) {
    const p = path.join(slidesDir, m[1]);
    if (fs.existsSync(p)) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=3600' });
      return fs.createReadStream(p).pipe(res);
    }
  }
  res.writeHead(404);
  res.end('Not found');
}

function tryListen(port) {
  if (port > portStart + 10) {
    console.error(`csdmflow-compare: no free port in ${portStart}-${portStart + 10}`);
    process.exit(1);
  }
  const server = http.createServer(handler);
  server.on('error', err => { if (err.code === 'EADDRINUSE') tryListen(port + 1); else throw err; });
  server.listen(port, () => {
    const url = `http://localhost:${port}`;
    console.log(`[csdmflow-compare] ${examples.length} examples from ${dir} at ${url}`);
    if (process.platform === 'darwin' && !process.env.NO_OPEN) {
      try { execSync('open ' + url); } catch (_) { /* best effort */ }
    }
  });
}

tryListen(portStart);
