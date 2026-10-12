#!/usr/bin/env node
'use strict';

// ServiceNow pages load Prototype.js 1.7.3, which replaces Array#entries with
// a version that is not iterable. Render every example with it broken that way
// and check the pictures come out exactly as they do with a clean Array.
const fs = require('node:fs');
const path = require('node:path');
const { compileCsdm } = require('../src/csdm');
const { renderSvg } = require('../src/gridflow');

const dir = path.join(__dirname, '..', 'examples');
const files = fs.readdirSync(dir).filter(n => n.endsWith('.csdm')).sort();
const render = f => renderSvg(compileCsdm(fs.readFileSync(path.join(dir, f), 'utf8')).gf).svg;

const clean = files.map(render);
const native = Array.prototype.entries;
// what Prototype's Enumerable mixin leaves behind: callable, not iterable
Array.prototype.entries = function () { return {}; };
let failed = 0;
try {
  files.forEach((f, i) => {
    try {
      if (render(f) !== clean[i]) throw new Error('renders differently');
    } catch (err) {
      failed++;
      console.error(`FAIL ${f}: ${err.message}`);
    }
  });
} finally {
  Array.prototype.entries = native;
}
console.log(`${failed ? 'FAILED' : 'ok'} — ${files.length} examples render with Prototype.js's Array#entries`);
process.exit(failed ? 1 : 0);
