#!/usr/bin/env node
'use strict';

// Regenerates the README images in docs/images/ from examples/.
const fs = require('node:fs');
const path = require('node:path');
const { compileCsdm } = require('../src/csdm');
const { renderSvg } = require('../src/gridflow');

const root = path.join(__dirname, '..');
const out = path.join(root, 'docs', 'images');
fs.mkdirSync(out, { recursive: true });

const IMAGES = {
  'hello': 'hello.csdm',
  'variants': 'variants.csdm',
  'layout-cross': 'slide-043-microsoft-dynamics-fly.csdm',
  'layout-tiers': 'slide-033-epic-healthcare-saas-platform-run.csdm',
  'layout-row': 'slide-037-o365-platform-run.csdm',
  'layout-reach-1-2': 'slide-047-solidworks-pdm-client-run.csdm',
};

for (const [name, file] of Object.entries(IMAGES)) {
  const src = fs.readFileSync(path.join(root, 'examples', file), 'utf8');
  const { svg } = renderSvg(compileCsdm(src).gf);
  fs.writeFileSync(path.join(out, name + '.svg'), svg + '\n');
  console.log(`docs/images/${name}.svg  <- examples/${file}`);
}
