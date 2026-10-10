'use strict';

// Browser entry: bundled to dist/csdmflow.min.js as the global `csdmflow`.
// Including the script renders every <pre class="csdmflow"> (CSDM source) and
// <pre class="gridflow"> (raw .gf source) on DOMContentLoaded, mermaid-style.
// Call csdmflow.initialize({ startOnLoad: false }) before load to opt out, and
// csdmflow.run() to render blocks added later.

const { renderSvg } = require('./gridflow');
const { compileCsdm } = require('./csdm');

const SELECTOR = 'pre.csdmflow, pre.gridflow, div.csdmflow, div.gridflow';
let startOnLoad = true;
let counter = 0;

// Compile (if CSDM) and render. Returns { svg, width, height, warnings }.
function render(source, opts = {}) {
  const lang = opts.lang || 'csdm';
  let gf = source;
  const warnings = [];
  if (lang === 'csdm') {
    const compiled = compileCsdm(source);
    gf = compiled.gf;
    warnings.push(...compiled.warnings);
  }
  const result = renderSvg(gf);
  return { ...result, svg: scopeIds(result.svg), warnings: [...warnings, ...result.warnings] };
}

// renderSvg uses fixed ids (gf-bg, arrow markers); several diagrams on one page
// would collide, so give each render its own prefix.
function scopeIds(svg) {
  const p = `csdmflow-${++counter}-`;
  return svg.replace(/\bid="([^"]+)"/g, `id="${p}$1"`).replace(/url\(#([^)]+)\)/g, `url(#${p}$1)`);
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Dedent so sources indented inside HTML still parse.
function sourceOf(el) {
  const lines = el.textContent.replace(/^\n+|\s+$/g, '').split('\n');
  const indent = Math.min(...lines.filter(l => l.trim()).map(l => /^[ \t]*/.exec(l)[0].length));
  return lines.map(l => l.slice(indent)).join('\n');
}

function run(opts = {}) {
  const root = opts.root || document;
  const nodes = opts.nodes || root.querySelectorAll(SELECTOR);
  for (const el of nodes) {
    if (el.dataset.processed) continue;
    el.dataset.processed = 'true';
    const lang = el.classList.contains('gridflow') ? 'gf' : 'csdm';
    try {
      const { svg, warnings } = render(sourceOf(el), { lang });
      const out = document.createElement('div');
      out.className = 'csdmflow-diagram';
      out.dataset.processed = 'true';
      out.innerHTML = svg;
      const svgEl = out.firstElementChild;
      svgEl.style.maxWidth = '100%';
      svgEl.style.height = 'auto';
      el.replaceWith(out);
      for (const w of warnings) console.warn('csdmflow: ' + w);
    } catch (err) {
      el.dataset.processed = 'error';
      el.insertAdjacentHTML('afterend', `<div class="csdmflow-error" style="color:#b00020;font:13px monospace">csdmflow: ${esc(err.message)}</div>`);
      if (!err.gridflow) console.error(err);
    }
  }
}

function initialize(opts = {}) {
  if ('startOnLoad' in opts) startOnLoad = !!opts.startOnLoad;
}

if (typeof document !== 'undefined') {
  const start = () => { if (startOnLoad) run(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else setTimeout(start, 0); // script injected after load; let initialize() run first
}

module.exports = { render, run, initialize, compileCsdm, renderSvg };
