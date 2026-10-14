#!/usr/bin/env node
'use strict';

// Routing invariants, on every example and on generated large models:
//   - no line runs along (or within 3px of) a line it does not merge with
//   - no line passes through a box, its own included
//   - no edge falls back to the best-effort route
const fs = require('node:fs');
const path = require('node:path');
const { compileCsdm } = require('../src/csdm');
const gf = require('../src/gridflow');

const segsOf = pts => {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01) continue;
    if (Math.abs(a.x - b.x) < 0.01) out.push({ o: 'v', c: a.x, lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y) });
    else out.push({ o: 'h', c: a.y, lo: Math.min(a.x, b.x), hi: Math.max(a.x, b.x) });
  }
  return out;
};
const styleKey = st => `${st.color}|${st.dashed}`;
const edgeName = p => `${p.edge.from} -> ${p.edge.to}`;

function problems(source) {
  const src = compileCsdm(source).gf;
  // buildScene sets the font metrics the bare layout below relies on
  const out = gf.buildScene(src).warnings.filter(w => /best-effort/.test(w));
  const model = gf.parse(src);
  const placed = gf.route(model, gf.layout(model), []);
  for (let a = 0; a < placed.length; a++) {
    for (let b = a + 1; b < placed.length; b++) {
      const A = placed[a], B = placed[b];
      const same = styleKey(A.style) === styleKey(B.style);
      const merged = same && (A.srcTrunkKey === B.srcTrunkKey || A.trunkKey === B.trunkKey);
      for (const x of segsOf(A.points)) for (const y of segsOf(B.points)) {
        if (x.o !== y.o || Math.abs(x.c - y.c) > 3) continue;
        if (Math.min(x.hi, y.hi) - Math.max(x.lo, y.lo) <= 1) continue;
        if (merged && Math.abs(x.c - y.c) < 0.5) continue;
        out.push(`${edgeName(A)} runs along ${edgeName(B)}`);
      }
    }
  }
  for (const p of placed) {
    for (const sg of segsOf(p.points)) {
      for (const n of model.nodes.values()) {
        const d = n.stack ? 10 : 0;
        const [c0, c1, l0, l1] = sg.o === 'v' ? [n.x, n.x + n.w + d, n.y, n.y + n.h + d] : [n.y, n.y + n.h + d, n.x, n.x + n.w + d];
        if (sg.c > c0 + 0.5 && sg.c < c1 - 0.5 && Math.min(sg.hi, l1) - Math.max(sg.lo, l0) > 1) out.push(`${edgeName(p)} passes through ${n.id}`);
      }
    }
  }
  return out;
}

// A seeded model of `apps` applications with instances, CI chains, shared
// offerings, dependencies, data flows and capabilities: dense enough to make
// the simple route shapes fail.
function bigModel(seed, apps, layout) {
  let s = seed >>> 0;
  const rnd = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; };
  const pick = a => a[Math.floor(rnd() * a.length)];
  const L = [`layout ${layout}`, 'TMS tms0: Hosting', 'TMS tms1: App Mgmt', 'SP tsp: Tech Portfolio', 'BS bs0: Sales', 'BS bs1: Finance',
    'SP bsp: Business Portfolio', 'BC bc0: Selling', 'BC bc1: Accounting', 'tms0 -> tsp', 'tms1 -> tsp', 'bs0 -> bsp', 'bs1 -> bsp'];
  const tmso = ['tmso0', 'tmso1', 'tmso2'];
  tmso.forEach((t, i) => L.push(`TMSO ${t}: Offering ${i}`, `${t} -> tms${i % 2}`));
  const sis = [], servers = [];
  for (let a = 0; a < apps; a++) {
    L.push(`BA ba${a}: App ${a}`, `${pick(['bc0', 'bc1'])} -> ba${a}`);
    for (let k = 0; k < (rnd() < 0.4 ? 2 : 1); k++) {
      const si = `si${a}-${k}`;
      sis.push(si);
      L.push(`SI ${si}: App ${a} ${k ? 'EU' : 'Prod'}${rnd() < 0.25 ? ' [Dev, QA]' : ''}`, `ba${a} -> ${si}`, `${pick(tmso)} -> ${si}`);
      if (rnd() < 0.7) {
        L.push(`CI(Application) app${a}-${k}: App ${a}.${k}`, `CI(Linux Server) srv${a}-${k}: ${rnd() < 0.3 ? 'srv1, srv2' : 'srv' + a}`,
          `${si} -> app${a}-${k}`, `app${a}-${k} -> srv${a}-${k} : Runs On`);
        servers.push(`srv${a}-${k}`);
        if (rnd() < 0.5) L.push(`CI(Database) db${a}-${k}: DB ${a}`, `app${a}-${k} -> db${a}-${k}`);
      }
    }
    if (rnd() < 0.8) L.push(`BSO bso${a}: Offering ${a}`, `bso${a} -> si${a}-0`, `bso${a} -> ${pick(['bs0', 'bs1'])}`);
  }
  for (let i = 0; i < apps / 2; i++) { const x = pick(sis), y = pick(sis); if (x !== y) L.push(`${x} -> ${y}`); }
  for (let i = 0; i < apps / 3; i++) { const x = pick(sis), y = pick(sis); if (x !== y) L.push(`${x} -> ${y} : Sends data to`); }
  if (servers.length) L.push('DCG dcg: Server Group', 'tmso0 -> dcg', ...servers.slice(0, 3).map(id => `dcg -> ${id}`));
  L.push('bc0 -> bs0', 'bc1 -> tms0');
  return [...new Set(L)].join('\n') + '\n';
}

let failed = 0, cases = 0;
const report = (name, list) => {
  cases++;
  if (!list.length) return;
  failed++;
  console.error(`FAIL ${name}: ${list.length} problem(s)\n  ${list.slice(0, 5).join('\n  ')}`);
};
const dir = path.join(__dirname, '..', 'examples');
for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.csdm')).sort()) report(f, problems(fs.readFileSync(path.join(dir, f), 'utf8')));
for (const layout of ['cross', 'tiers', 'row', 'lanes', 'reach 1 2']) {
  for (const apps of [8, 14]) {
    for (const seed of [1, 2, 3]) report(`generated ${layout}, ${apps} apps, seed ${seed}`, problems(bigModel(seed, apps, layout)));
  }
}
console.log(`${failed ? 'FAILED' : 'ok'} — routing: ${cases} diagrams, ${failed} with problems`);
process.exit(failed ? 1 : 0);
