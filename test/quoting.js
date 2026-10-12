#!/usr/bin/env node
'use strict';

// Quoted names and data-id: text from a CMDB must come out exactly as written,
// whatever commas, brackets, quotes, bars or hashes it holds, and every box must
// carry its .csdm id so a page can tell which box was clicked.
const { compileCsdm, parseCsdm } = require('../src/csdm');
const { renderSvg } = require('../src/gridflow');
const browser = require('../src/browser');

let failed = 0;
function check(what, fn) {
  try { fn(); } catch (err) { failed++; console.error(`FAIL ${what}: ${err.message}`); }
}
function eq(actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`expected ${e}, got ${a}`);
}
const ent = (src, id) => parseCsdm(src).ents.get(id);
const svgOf = src => renderSvg(compileCsdm(src).gf).svg;
// the text rows of one box, unescaped
const boxText = (svg, id) => {
  const g = new RegExp(`<g data-id="${id}">([\\s\\S]*?)</g>`).exec(svg);
  if (!g) throw new Error(`no box with data-id="${id}"`);
  return [...g[1].matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map(m =>
    m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
};

check('a quoted comma is text, not a second instance', () => {
  const e = ent('BSO pb: "Payroll, Benefits"', 'pb');
  eq([e.name, e.instances, e.variants], ['Payroll, Benefits', ['Payroll, Benefits'], []]);
  if (/stack/.test(compileCsdm('BSO pb: "Payroll, Benefits"').gf)) throw new Error('drawn as a stack');
});

check('quoted brackets are text, not variants', () => {
  const e = ent('SI sap: "SAP [Prod]"', 'sap');
  eq([e.name, e.variants], ['SAP [Prod]', []]);
});

check('several quoted names are instances', () => {
  eq(ent('CI(Server) s: "web, 01", "web, 02"', 's').instances, ['web, 01', 'web, 02']);
});

check('a quoted name takes a variant list, quoted items included', () => {
  eq(ent('SI ea: "EA, Prod" [Dev, "QA, EU"]', 'ea').variants, ['Dev', 'QA, EU']);
});

check('entity codes: #quot; and decimal codes', () => {
  eq(ent('BA a: "The #quot;Best#quot; App #35;1"', 'a').name, 'The "Best" App #1');
});

check('quotes, bars and hashes reach the picture unchanged', () => {
  const svg = svgOf('BA a: "Sales | Ops #quot;HQ#quot; #35;1"');
  // the name may wrap over several rows; rejoined it must read as written
  const text = boxText(svg, 'a').join(' ');
  if (!text.endsWith('Sales | Ops "HQ" #1')) throw new Error(`box reads "${text}"`);
});

check('every .csdm example in the README parses as shown', () => {
  const readme = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'README.md'), 'utf8');
  // walk the fences in order: only blocks without a language tag hold .csdm
  const blocks = [];
  let open = null;
  for (const line of readme.split('\n')) {
    if (!line.startsWith('```')) { if (open) open.lines.push(line); continue; }
    if (open) { if (!open.lang) blocks.push(open.lines.join('\n')); open = null; }
    else open = { lang: line.slice(3).trim(), lines: [] };
  }
  const csdm = blocks.filter(b => /^(title |(BC|BA|SI|TMSO|TMS|DCG|CI|BSO|BS|SP)[ (])/m.test(b));
  if (csdm.length < 3) throw new Error(`found only ${csdm.length} .csdm blocks`);
  for (const b of csdm) {
    const { ents, rels } = parseCsdm(b);
    // a comment swallowed into a name or label means the example misleads
    for (const t of [...[...ents.values()].map(e => e.name), ...rels.map(r => r.label || '')]) {
      if (t.includes('#') && !/#\d/.test(t)) throw new Error(`comment inside "${t}"`);
    }
  }
  const quoted = csdm.find(b => b.includes('"Payroll, Benefits"'));
  eq([...parseCsdm(quoted).ents.values()].map(e => [e.name, e.instances.length, e.variants]), [
    ['Payroll, Benefits', 1, []], ['SAP [Prod]', 1, []], ['The "HQ" Portal', 1, []],
    ['web, 01, web, 02', 2, []], ['EA, Prod', 1, ['Dev', 'QA, EU']],
  ]);
});

check('unquoted names behave as before', () => {
  const e = ent('CI(Server) w: web01, web02 [Dev]', 'w');
  eq([e.instances, e.variants], [['web01', 'web02'], ['Dev']]);
  eq(ent('BS s1: Service #1', 's1').name, 'Service #1');
});

check('titles take entity codes and keep them through rendering', () => {
  const svg = svgOf('title "The #quot;Payroll#quot; view | 2026"\nBS s: S');
  if (!svg.includes('The &quot;Payroll&quot; view | 2026')) throw new Error('title text lost');
});

check('bad quoting is an error with a line number', () => {
  for (const [src, msg] of [
    ['BS s: "Payroll', /line 1: unterminated quote/],
    ['BS s: "a", b', /expected a quoted name/],
    ['BS s: "a" trailing', /unexpected text/],
    ['BS s: "a" []', /empty variant list/],
    ['BS s: "a\\"b"', /unexpected text/], // no backslash escapes: #quot; is the way
  ]) {
    let err = null;
    try { parseCsdm(src); } catch (e) { err = e; }
    if (!err || !msg.test(err.message)) throw new Error(`${src}: got ${err ? err.message : 'no error'}`);
  }
});

check('every box carries its id, sys_ids included', () => {
  const src = 'BA 3f2a9c0e1b7d4e6a8c5b2d1f0e9a8b7c: "App"\nSI 9c1d: Inst [Dev]\nTMSO t: T, U\n' +
    '3f2a9c0e1b7d4e6a8c5b2d1f0e9a8b7c -> 9c1d\nt -> 9c1d';
  const svg = svgOf(src);
  const ids = [...svg.matchAll(/data-id="([^"]*)"/g)].map(m => m[1]);
  // a box each, plus its variant card (name and card) and stack cards
  eq([...new Set(ids)].sort(), ['3f2a9c0e1b7d4e6a8c5b2d1f0e9a8b7c', '9c1d', 't']);
  eq(boxText(svg, '3f2a9c0e1b7d4e6a8c5b2d1f0e9a8b7c').pop(), 'App');
});

check('the browser bundle scopes ids but leaves data-id alone', () => {
  const { svg } = browser.render('BA 3f2a: App\nSI 9c1d: Inst\n3f2a -> 9c1d');
  eq([...svg.matchAll(/data-id="([^"]*)"/g)].map(m => m[1]), ['3f2a', '9c1d']);
  if (!/ id="csdmflow-\d+-gf-bg"/.test(svg)) throw new Error('ids not scoped');
});

console.log(`${failed ? 'FAILED' : 'ok'} — quoting and data-id`);
process.exit(failed ? 1 : 0);
