#!/usr/bin/env node
'use strict';

// Exports every example to PowerPoint and draw.io and checks the results hang
// together: the .pptx is a readable zip whose parts are all present, every box
// becomes one shape with its text, and draw.io edges are glued to boxes.
const fs = require('node:fs');
const path = require('node:path');
const { compileCsdm } = require('../src/csdm');
const { buildScene } = require('../src/gridflow');
const { toPptx, toDrawio } = require('../src/export');

// Read a stored (uncompressed) zip: name → text.
function unzip(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const files = {};
  let p = 0;
  while (v.getUint32(p, true) === 0x04034b50) {
    const size = v.getUint32(p + 18, true), nameLen = v.getUint16(p + 26, true), extra = v.getUint16(p + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 30, p + 30 + nameLen));
    const start = p + 30 + nameLen + extra;
    files[name] = new TextDecoder().decode(bytes.subarray(start, start + size));
    p = start + size;
  }
  return files;
}

const PARTS = ['[Content_Types].xml', '_rels/.rels', 'ppt/presentation.xml', 'ppt/slides/slide1.xml', 'ppt/slideMasters/slideMaster1.xml', 'ppt/slideLayouts/slideLayout1.xml', 'ppt/theme/theme1.xml'];

const dir = path.join(__dirname, '..', 'examples');
const files = fs.readdirSync(dir).filter(n => n.endsWith('.csdm')).sort();
let failed = 0, glued = 0, edges = 0;
for (const f of files) {
  try {
    const scene = buildScene(compileCsdm(fs.readFileSync(path.join(dir, f), 'utf8')).gf);
    const nodes = scene.items.filter(i => i.type === 'node');

    const pptx = unzip(toPptx(scene, f));
    for (const part of PARTS) if (!pptx[part]) throw new Error(`pptx is missing ${part}`);
    const slide = pptx['ppt/slides/slide1.xml'];
    for (const n of nodes) {
      const first = n.rows[0].text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      if (!slide.includes(`<a:t>${first}</a:t>`)) throw new Error(`pptx lost the text "${n.rows[0].text}"`);
    }
    const ids = [...slide.matchAll(/<p:cNvPr id="(\d+)"/g)].map(m => m[1]);
    if (new Set(ids).size !== ids.length) throw new Error('pptx shape ids are not unique');

    const drawio = toDrawio(scene, f);
    const vertices = (drawio.match(/vertex="1"/g) || []).length;
    if (vertices < nodes.length) throw new Error(`draw.io has ${vertices} shapes for ${nodes.length} boxes`);
    const cellIds = [...drawio.matchAll(/<mxCell id="([^"]+)"/g)].map(m => m[1]);
    if (new Set(cellIds).size !== cellIds.length) throw new Error('draw.io cell ids are not unique');
    for (const m of drawio.matchAll(/(?:source|target)="([^"]+)"/g)) {
      if (!cellIds.includes(m[1])) throw new Error(`draw.io edge glued to unknown cell ${m[1]}`);
    }
    edges += (drawio.match(/edge="1"/g) || []).length;
    glued += (drawio.match(/edge="1" parent="1" source="/g) || []).length;
  } catch (err) {
    failed++;
    console.error(`FAIL ${f}: ${err.message}`);
  }
}
console.log(`${failed ? 'FAILED' : 'ok'} — ${files.length} examples exported; ${glued}/${edges} draw.io lines glued at the start`);
process.exit(failed ? 1 : 0);
