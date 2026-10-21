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

// An instance depending on several groups, each with its own members: the
// groups sit side by side in the tier below the instance, as its service map
// would, each group's members under it. The group the tech offering also
// links to comes first, on the offering's side, so their lines don't merge.
check("an instance's groups sit in a row below it, members under each group", () => {
  const { gf } = compileCsdm(`SI wlan: WLAN
TMSO wlan-ops: WLAN Operations
BSO byod: BYOD WLAN
DCG g1: Group One
DCG g2: Group Two
DCG g3: Group Three
CI(Wireless Access Point) m1: "13'952 CIs"
CI(Wireless Access Point) m2: "3'829 CIs"
CI(Wireless Access Point) m3: "16'321 CIs"
byod -> wlan
wlan-ops -> wlan
wlan-ops -> g2
wlan -> g1 : Depends On
wlan -> g2 : Depends On
wlan -> g3 : Depends On
g1 -> m1
g2 -> m2
g3 -> m3
`);
  const rows = gf.split('\n').filter(l => l.startsWith('row ')).map(l => l.slice(4).replace(/\["[^"]*"\]/g, '').split(/\s+/));
  const at = id => { const r = rows.findIndex(cells => cells.includes(id)); return [r, rows[r].indexOf(id)]; };
  const [siRow, siCol] = at('wlan');
  const groups = ['g2', 'g1', 'g3'].map(at);
  eq(groups.map(([r]) => r), [siRow + 1, siRow + 1, siRow + 1]);
  eq(groups.map(([, c]) => c), [siCol - 1, siCol, siCol + 1]);
  eq(['m2', 'm1', 'm3'].map(at), groups.map(([r, c]) => [r + 1, c]));
});

// A group that only a tech offering links to keeps the reference slides'
// place: on the delivery side, in the row of its members.
check('a group under a tech offering only stays beside its members', () => {
  const { gf } = compileCsdm(`SI app: App Prod
TMSO ops: Server Ops
DCG servers: All Servers
CI(Linux Server) hosts: web01, web02
ops -> app
ops -> servers
servers -> hosts
`);
  const rows = gf.split('\n').filter(l => l.startsWith('row ')).map(l => l.slice(4).replace(/\["[^"]*"\]/g, '').split(/\s+/));
  const row = id => rows.findIndex(cells => cells.includes(id));
  eq(row('servers'), row('hosts'));
});

// A tech offering and an instance both linked to one group: the offering's
// "Contains" and the instance's "Depends On" look alike, and would merge into
// one trunk with two labels. The offering's line gets a lane of its own and
// arrives with its own arrowhead.
check("an offering's line into an instance's group doesn't merge with the instance's", () => {
  const browser = require('../src/browser');
  const { gf } = compileCsdm(`SI wlan: WLAN
TMSO ops: WLAN Ops
TMSO ops2: More Ops
BSO byod: BYOD
DCG g1: One
DCG g2: Two
DCG g3: Three
byod -> wlan
ops -> wlan
ops -> g2
ops2 -> g3
wlan -> g1 : Depends On
wlan -> g2 : Depends On
wlan -> g3 : Depends On
`);
  eq(gf.split('\n').filter(l => / lane=offering/.test(l)).map(l => l.split(' ')[0] + '>' + l.split(' ')[2]).sort(), ['ops2>g3', 'ops>g2']);
  const arrowsInto = (source, id) => {
    const s = browser.scene(source, { lang: 'gf' });
    const box = s.items.find(i => i.type === 'node' && i.id === id);
    return s.items.filter(i => i.role === 'edge' && i.arrowEnd).map(i => i.points[i.points.length - 1])
      .filter(p => p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y - 1 && p.y <= box.y + box.h + 1).length;
  };
  eq(arrowsInto(gf, 'g2'), 2);
  eq(arrowsInto(gf.replace(/ lane=offering/g, ''), 'g2'), 1); // what the lane prevents
});

// link <id> "<url>": the box becomes a link in the SVG, PowerPoint and draw.io
check('a linked box opens its url, in every format', () => {
  const browser = require('../src/browser');
  const { toPptx, toDrawio } = require('../src/export');
  const url = 'https://dev.service-now.com/cmdb_ci.do?sys_id=1&x=#y';
  const src = `BA a: App\nSI b: Prod\na -> b\nlink b "${url.replace(/#/g, '#35;')}"\n`;
  const { svg } = renderSvg(compileCsdm(src).gf);
  eq(svg.match(/<a [^>]*>/g), ['<a href="https://dev.service-now.com/cmdb_ci.do?sys_id=1&amp;x=#y" target="_blank" rel="noopener noreferrer">']);
  if (!/<a [^>]*>\n<g data-id="b">/.test(svg)) throw new Error('the link does not wrap box b');
  const sc = browser.scene(src);
  if (!toDrawio(sc).includes('link="https://dev.service-now.com/cmdb_ci.do?sys_id=1&amp;x=#y"')) throw new Error('no link in draw.io');
  const pptx = Buffer.from(toPptx(sc)).toString('latin1');
  if (!/hlinkClick r:id="rIdLink1"/.test(pptx) || !/Id="rIdLink1"[^>]*TargetMode="External"/.test(pptx)) throw new Error('no hyperlink in PowerPoint');
});

check('only web links, and only to boxes that exist', () => {
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'ftp://x', 'https://a b']) {
    let err = null;
    try { compileCsdm(`SI b: B\nlink b "${bad}"\n`); } catch (e) { err = e; }
    if (!err || !/only http and https/.test(err.message)) throw new Error(`accepted ${bad}`);
  }
  let err = null;
  try { compileCsdm('SI b: B\nlink nope "https://x"\n'); } catch (e) { err = e; }
  if (!err || !/unknown entity "nope"/.test(err.message)) throw new Error('accepted an unknown box');
});

if (failed) process.exit(1);
console.log('relations: ok');
