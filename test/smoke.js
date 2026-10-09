#!/usr/bin/env node
'use strict';

// Compiles and renders every example; fails on any error. Prints warning counts.
const fs = require('node:fs');
const path = require('node:path');
const { compileCsdm } = require('../src/csdm');
const { renderSvg } = require('../src/gridflow');

const dir = path.join(__dirname, '..', 'examples');
let failed = 0;
let warnings = 0;
for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.csdm')).sort()) {
  try {
    const c = compileCsdm(fs.readFileSync(path.join(dir, f), 'utf8'));
    const r = renderSvg(c.gf);
    if (!r.svg.startsWith('<svg')) throw new Error('no svg output');
    warnings += c.warnings.length + r.warnings.length;
  } catch (err) {
    failed++;
    console.error(`FAIL ${f}: ${err.message}`);
  }
}
console.log(`${failed ? 'FAILED' : 'ok'} — ${fs.readdirSync(dir).filter(n => n.endsWith('.csdm')).length} examples, ${warnings} warnings`);
process.exit(failed ? 1 : 0);
