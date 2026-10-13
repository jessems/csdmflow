#!/usr/bin/env node
'use strict';

// Relationship rules that are not covered by an example diagram.
const { compileCsdm, parseCsdm } = require('../src/csdm');
const { renderSvg } = require('../src/gridflow');

let failed = 0;
function check(what, fn) {
  try { fn(); } catch (err) { failed++; console.error(`FAIL ${what}: ${err.message}`); }
}
function eq(actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`expected ${e}, got ${a}`);
}

const SI_DCG = `SI mail: Mail Gateway Prod
DCG gw: Mail Gateways
CI(Linux Server) hosts: mailgw-01, mailgw-02
`;

check('a service instance contains the dynamic CI group that populates it', () => {
  const { warnings, gf } = compileCsdm(SI_DCG + 'mail -> gw\ngw -> hosts\n');
  eq(warnings, []);
  if (!/Contains/.test(gf)) throw new Error('no "Contains" label in ' + gf);
});

check('written the other way round, the line is turned to CSDM direction', () => {
  const { warnings } = compileCsdm(SI_DCG + 'gw -> mail\n');
  eq(warnings, []);
  const r = parseCsdm(SI_DCG + 'gw -> mail\n').rels[0];
  eq([r.from, r.to, r.sem.label], ['mail', 'gw', 'Contains']);
});

check('it renders', () => {
  const r = renderSvg(compileCsdm(SI_DCG + 'mail -> gw\ngw -> hosts\n').gf);
  eq(r.nodes.map(n => n.id).filter(id => ['mail', 'gw', 'hosts'].includes(id)).sort(), ['gw', 'hosts', 'mail']);
});

if (failed) process.exit(1);
console.log('relations: ok');
