#!/usr/bin/env node
'use strict';

// Label quality check: counts edge labels that overlap a box, another label, or
// fall off the canvas, across all examples; fails if any. --list shows each offender.
const fs = require('node:fs');
const path = require('node:path');
const { compileCsdm } = require('../src/csdm');
const { renderSvg } = require('../src/gridflow');

const dir = path.join(__dirname, '..', 'examples');
const list = process.argv.includes('--list');
const hit = (a, b, m = 0) => a.x0 < b.x1 - m && a.x1 > b.x0 + m && a.y0 < b.y1 - m && a.y1 > b.y0 + m;
let total = 0, onBox = 0, onLabel = 0, offCanvas = 0;
for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.csdm')).sort()) {
  const r = renderSvg(compileCsdm(fs.readFileSync(path.join(dir, f), 'utf8')).gf);
  r.labels.forEach((l, i) => {
    total++;
    const boxes = r.nodes.filter(n => hit(l, n, 1));
    const others = r.labels.filter((o, j) => j !== i && hit(l, o, 1));
    const off = l.x0 < 0 || l.y0 < 0 || l.x1 > r.width || l.y1 > r.height;
    if (boxes.length) onBox++;
    if (others.length) onLabel++;
    if (off) offCanvas++;
    if (list && (boxes.length || others.length || off)) {
      console.log(`${f}: "${l.text}"${boxes.length ? ' on box ' + boxes.map(b => b.id).join(',') : ''}${others.length ? ' on label ' + others.map(o => '"' + o.text + '"').join(',') : ''}${off ? ' off canvas' : ''}`);
    }
  });
}
console.log(`${total} labels: ${onBox} overlap a box, ${onLabel} overlap another label, ${offCanvas} off canvas`);
process.exit(onBox + onLabel + offCanvas ? 1 : 0);
