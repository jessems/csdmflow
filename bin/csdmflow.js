#!/usr/bin/env node
'use strict';

// csdmflow CLI: csdmflow <file.csdm|file.gf> [-o out.svg] [--png] [--pptx] [--drawio] [--emit-gf]
// A .csdm file is compiled to gridflow source first (see src/csdm.js); --emit-gf
// writes that generated source next to the output as <name>.gen.gf.
// Emits <file>.svg next to the input (or at -o); --png also writes <file>.png
// via rsvg-convert; --pptx and --drawio write editable PowerPoint / draw.io
// files next to the svg. Exits non-zero with a one-line message on bad input.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { buildScene, sceneToSvg } = require('../src/gridflow');
const { toPptx, toDrawio } = require('../src/export');
const { compileCsdm } = require('../src/csdm');

function fail(msg) {
  console.error('csdmflow: ' + msg);
  process.exit(1);
}

const args = process.argv.slice(2);
let input = null;
let output = null;
let emitGf = false;
let png = false;
let pptx = false;
let drawio = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--emit-gf') {
    emitGf = true;
  } else if (args[i] === '--png') {
    png = true;
  } else if (args[i] === '--pptx') {
    pptx = true;
  } else if (args[i] === '--drawio') {
    drawio = true;
  } else if (args[i] === '-o') {
    output = args[++i];
    if (!output) fail('-o needs a path');
  } else if (!input) {
    input = args[i];
  } else {
    fail(`unexpected argument "${args[i]}" (usage: csdmflow <file.gf|file.csdm> [-o out.svg] [--png] [--pptx] [--drawio] [--emit-gf])`);
  }
}
if (!input) fail('usage: csdmflow <file.gf|file.csdm> [-o out.svg] [--png] [--pptx] [--drawio] [--emit-gf]');
if (!fs.existsSync(input)) fail(`no such file: ${input}`);

let source;
try {
  source = fs.readFileSync(input, 'utf8');
} catch (err) {
  fail(`cannot read ${input}: ${err.message}`);
}

const extraWarnings = [];
let scene;
try {
  if (/\.csdm$/.test(input)) {
    const compiled = compileCsdm(source);
    extraWarnings.push(...compiled.warnings);
    source = compiled.gf;
    if (emitGf) {
      const gfOut = (output || input).replace(/\.[^.]*$/, '') + '.gen.gf';
      fs.writeFileSync(gfOut, source, 'utf8');
      console.log(`wrote ${gfOut}`);
    }
  }
  scene = buildScene(source);
} catch (err) {
  if (err.gridflow) fail(`${input}: ${err.message}`);
  throw err;
}

const svgOut = output || input.replace(/\.[^.]*$/, '') + '.svg';
fs.writeFileSync(svgOut, sceneToSvg(scene) + '\n', 'utf8');
console.log(`wrote ${svgOut} (${scene.width}x${scene.height})`);
for (const w of [...extraWarnings, ...scene.warnings]) console.error('csdmflow warning: ' + w);

if (png) {
  const pngOut = svgOut.replace(/\.svg$/, '.png');
  try {
    execFileSync('rsvg-convert', ['-z', '2', '-o', pngOut, svgOut], { stdio: 'pipe', timeout: 15000 });
    console.log(`wrote ${pngOut}`);
  } catch (err) {
    fail(`--png needs a working rsvg-convert (librsvg): ${err.message.split('\n')[0]}`);
  }
}

const title = (/^title\s+"([^"]*)"/m.exec(source) || [])[1] || path.basename(input).replace(/\.[^.]*$/, '');
if (pptx) {
  const out = svgOut.replace(/\.svg$/, '.pptx');
  fs.writeFileSync(out, toPptx(scene, title));
  console.log(`wrote ${out}`);
}
if (drawio) {
  const out = svgOut.replace(/\.svg$/, '.drawio');
  fs.writeFileSync(out, toDrawio(scene, title), 'utf8');
  console.log(`wrote ${out}`);
}
