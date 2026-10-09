#!/usr/bin/env node
'use strict';

// csdmflow CLI: csdmflow <file.csdm|file.gf> [-o out.svg] [--png] [--emit-gf]
// A .csdm file is compiled to gridflow source first (see src/csdm.js); --emit-gf
// writes that generated source next to the output as <name>.gen.gf.
// Emits <file>.svg next to the input (or at -o); --png also writes <file>.png
// via rsvg-convert. Exits non-zero with a one-line message on bad input.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { renderSvg } = require('../src/gridflow');
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
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--emit-gf') {
    emitGf = true;
  } else if (args[i] === '--png') {
    png = true;
  } else if (args[i] === '-o') {
    output = args[++i];
    if (!output) fail('-o needs a path');
  } else if (!input) {
    input = args[i];
  } else {
    fail(`unexpected argument "${args[i]}" (usage: csdmflow <file.gf|file.csdm> [-o out.svg] [--png] [--emit-gf])`);
  }
}
if (!input) fail('usage: csdmflow <file.gf|file.csdm> [-o out.svg] [--png] [--emit-gf]');
if (!fs.existsSync(input)) fail(`no such file: ${input}`);

let source;
try {
  source = fs.readFileSync(input, 'utf8');
} catch (err) {
  fail(`cannot read ${input}: ${err.message}`);
}

const extraWarnings = [];
let result;
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
  result = renderSvg(source);
} catch (err) {
  if (err.gridflow) fail(`${input}: ${err.message}`);
  throw err;
}

const svgOut = output || input.replace(/\.[^.]*$/, '') + '.svg';
fs.writeFileSync(svgOut, result.svg + '\n', 'utf8');
console.log(`wrote ${svgOut} (${result.width}x${result.height})`);
for (const w of [...extraWarnings, ...result.warnings]) console.error('csdmflow warning: ' + w);

if (png) {
  const pngOut = svgOut.replace(/\.svg$/, '.png');
  try {
    execFileSync('rsvg-convert', ['-z', '2', '-o', pngOut, svgOut], { stdio: 'pipe', timeout: 15000 });
    console.log(`wrote ${pngOut}`);
  } catch (err) {
    fail(`--png needs a working rsvg-convert (librsvg): ${err.message.split('\n')[0]}`);
  }
}
