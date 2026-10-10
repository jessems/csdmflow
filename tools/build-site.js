#!/usr/bin/env node
'use strict';

// Builds the GitHub Pages site into _site/: the playground page from site/,
// the browser bundle from dist/ (run `npm run build` first), and every model
// in examples/ as examples.json for the playground's example picker.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const out = path.join(root, '_site');
const bundle = path.join(root, 'dist', 'csdmflow.min.js');
if (!fs.existsSync(bundle)) {
  console.error('build-site: dist/csdmflow.min.js is missing — run `npm run build` first');
  process.exit(1);
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.cpSync(path.join(root, 'site'), out, { recursive: true });
fs.copyFileSync(bundle, path.join(out, 'csdmflow.min.js'));

// hello and variants first; the transcribed slides after, in slide order
const first = ['hello.csdm', 'variants.csdm'];
const files = fs.readdirSync(path.join(root, 'examples')).filter(f => f.endsWith('.csdm'));
const rank = f => (first.includes(f) ? first.indexOf(f) : first.length);
files.sort((a, b) => (rank(a) - rank(b)) || a.localeCompare(b));
const examples = files.map(file => ({
  file,
  source: fs.readFileSync(path.join(root, 'examples', file), 'utf8'),
}));
fs.writeFileSync(path.join(out, 'examples.json'), JSON.stringify(examples));
console.log(`wrote _site/ (${examples.length} examples)`);
