#!/usr/bin/env node
'use strict';

// Builds the paste-ready background scripts: every tools/bg-scripts/*.js except
// this one, with each `//#include lib/x.js` line replaced by that file, written
// to tools/bg-scripts/paste/. A background script is pasted as one block, so the
// shared libraries have to be inside it.
//
// Usage: npm run bg-scripts   (npm test fails while a pasted script is out of date)
const fs = require('node:fs');
const path = require('node:path');

const dir = __dirname;
const out = path.join(dir, 'paste');

function bundle(file) {
  const src = fs.readFileSync(path.join(dir, file), 'utf8');
  const body = src.replace(/^\/\/#include (\S+)\s*$/gm, (_, inc) => {
    const p = path.join(dir, inc);
    if (!fs.existsSync(p)) throw new Error(`${file}: no such include: ${inc}`);
    return `// ---- ${inc} ----\n${fs.readFileSync(p, 'utf8').trimEnd()}\n// ---- end ${inc} ----`;
  });
  return `// Built from tools/bg-scripts/${file} by tools/bg-scripts/build.js; edit that, not this.\n${body}`;
}

const scripts = () => fs.readdirSync(dir).filter(f => f.endsWith('.js') && f !== 'build.js').sort();

if (require.main === module) {
  fs.mkdirSync(out, { recursive: true });
  for (const f of scripts()) {
    fs.writeFileSync(path.join(out, f), bundle(f));
    console.log(`wrote tools/bg-scripts/paste/${f}`);
  }
}

module.exports = { bundle, scripts };
