#!/usr/bin/env node
'use strict';

// Background scripts: the pasted files are current and ES5, the csdm-graph
// format converts to csdmflow source that compiles, and bso-cluster walks a
// mocked instance to the cluster it should, by lib/walk.js's rules.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const { compileCsdm, parseCsdm } = require('../src/csdm');
const { renderSvg } = require('../src/gridflow');
const CsdmGraph = require('../tools/bg-scripts/lib/csdm-graph');
const CsdmWalk = require('../tools/bg-scripts/lib/walk');
const { bundle, scripts } = require('../tools/bg-scripts/build');

let failed = 0;
function check(what, fn) {
  try { fn(); } catch (err) { failed++; console.error(`FAIL ${what}: ${err.message}`); }
}
function eq(actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`expected ${e}, got ${a}`);
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }

const pasteDir = path.join(__dirname, '..', 'tools', 'bg-scripts', 'paste');

for (const f of scripts()) {
  check(`paste/${f} is current (npm run bg-scripts)`, () => {
    const p = path.join(pasteDir, f);
    ok(fs.existsSync(p) && fs.readFileSync(p, 'utf8') === bundle(f), 'stale or missing');
  });
  check(`${f} is ES5`, () => {
    const code = bundle(f);
    transformSync(code, { target: 'es5' }); // throws on let, const, class …
    // … but quietly lowers these, which Rhino would choke on
    const bad = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').match(/=>|`|\.\.\.[a-zA-Z_[]/);
    ok(!bad, `uses ${bad && bad[0]}`);
  });
}

// --- csdm-graph --------------------------------------------------------------

const graph = (nodes, edges) => ({ format: 'csdm-graph', version: 1, source: { script: 'test' }, nodes, edges, warnings: [] });

check('validate names what is wrong', () => {
  eq(CsdmGraph.validate(graph([{ id: 'a', type: 'BSO', name: 'A' }], [])), []);
  const errs = CsdmGraph.validate(graph(
    [{ id: 'a', type: 'XX', name: 'A' }, { id: 'a', type: 'CI', name: 'B' }],
    [{ from: 'a', to: 'zz', via: 'cmdb_rel_ci' }]));
  eq(errs.length, 3);
});

check('names from the CMDB survive quoting', () => {
  const src = CsdmGraph.toCsdm(graph([
    { id: 'a', type: 'BSO', name: 'Payroll, "EU" #1 [Prod]' },
    { id: 'b', type: 'CI', name: 'srv (1)', className: 'Linux Server (x86)' },
  ], [{ from: 'a', to: 'b', via: 'cmdb_rel_ci' }]));
  const { ents } = parseCsdm(src);
  const a = [...ents.values()].find(e => e.type === 'BSO'), b = [...ents.values()].find(e => e.type === 'CI');
  eq(a.name, 'Payroll, "EU" #1 [Prod]');
  eq(b.name, 'srv (1)');
  eq(b.ciClass, 'Linux Server (x86)');
});

check('CIs with the same class and neighbours share a box, counted', () => {
  const ci = (id, cls) => ({ id, type: 'CI', name: id, className: cls });
  const src = CsdmGraph.toCsdm(graph(
    [{ id: 'si', type: 'SI', name: 'App' }, ci('w1', 'Win'), ci('w2', 'Win'), ci('w3', 'Win'), ci('l1', 'Linux')],
    ['w1', 'w2', 'w3', 'l1'].map(c => ({ from: 'si', to: c, via: 'cmdb_rel_ci' }))), { maxNames: 2 });
  const { ents, rels } = parseCsdm(src);
  eq([...ents.values()].map(e => [e.ciClass, e.instances]), [[null, ['App']], ['Linux', ['l1']], ['Win (3)', ['w1', '…']]]);
  eq(rels.length, 2);
});

check('a group an instance depends on says so', () => {
  const src = CsdmGraph.toCsdm(graph([{ id: 's', type: 'SI', name: 'S' }, { id: 'd', type: 'DCG', name: 'D' }],
    [{ from: 's', to: 'd', via: 'cmdb_rel_ci', rel: 'Depends on::Used by' }]));
  ok(/^s -> d : Depends On$/m.test(src), src);
});

check('counted CIs: one box with the class and how many', () => {
  const src = CsdmGraph.toCsdm(graph([{ id: 'd', type: 'DCG', name: 'D' },
    { id: 'd:w', type: 'CI', name: '', className: 'Windows Server', count: 1250 },
    { id: 'd:x', type: 'CI', name: '', className: 'Windows Server', count: 1 }],
  [{ from: 'd', to: 'd:w', via: 'dcg_member' }, { from: 'd', to: 'd:x', via: 'dcg_member' }]));
  const cis = [...parseCsdm(src).ents.values()].filter(e => e.type === 'CI');
  eq(cis.map(e => [e.id, e.ciClass, e.name]), [['windows-server-members', 'Windows Server', "1'250 CIs"], ['windows-server-members-2', 'Windows Server', '1 CI']]);
  eq(CsdmGraph.validate(graph([{ id: 'x', type: 'SI', name: '', count: 3 }], [])), ['nodes[0]: count must be a positive whole number, on a CI']);
});

check('deflate round-trips through zlib, and the link is #z=', () => {
  const zlib = require('node:zlib');
  for (const s of ['', 'a', 'x'.repeat(1000), 'Prod · Zürich 🙂', ...fs.readdirSync(path.join(__dirname, '..', 'examples')).map(f => fs.readFileSync(path.join(__dirname, '..', 'examples', f), 'utf8'))]) {
    eq(zlib.inflateRawSync(Buffer.from(CsdmGraph.deflateRaw(CsdmGraph.utf8(s)))).toString('utf8'), s);
  }
  const url = CsdmGraph.playgroundUrl('BA a: A\nSI b: B\na -> b\n');
  ok(url.startsWith('https://jessems.github.io/csdmflow/editor.html#z='), url);
  eq(zlib.inflateRawSync(Buffer.from(url.split('#z=')[1], 'base64url')).toString('utf8'), 'BA a: A\nSI b: B\na -> b\n');
});

check('base64 matches Node for any text', () => {
  for (const s of ['', 'a', 'ab', 'abc', 'Prod · Zürich', 'emoji 🙂 ok']) eq(CsdmGraph.base64(s), Buffer.from(s, 'utf8').toString('base64'));
});

// --- walk ----------------------------------------------------------------------

const rec = (id, table, ancestors, extra) => ({ id, table, ancestors: [table, ...ancestors], name: id, ...extra });
const SVC = ['cmdb_ci_service', 'cmdb_ci'];
const BIZ = ['cmdb_ci_service_business', ...SVC];

check('walk: a service map is read downwards, to a depth', () => {
  const si = rec('si', 'cmdb_ci_service_auto', SVC);
  const ci = id => rec(id, 'cmdb_ci_linux_server', ['cmdb_ci']);
  // si -> c1 -> c2 -> c3 -> c4; c1 also runs other-app, above it
  const down = { si: ['c1'], c1: ['c2'], c2: ['c3'], c3: ['c4'] };
  const g = CsdmWalk.walk(si, ring => ring.flatMap(({ rec: r }) => [
    ...(down[r.id] || []).map(c => ({ from: r.id, rec: ci(c), via: 'Runs on::Runs', down: true })),
    ...(r.id === 'c1' ? [{ from: 'c1', rec: rec('other-app', 'cmdb_ci_appl', ['cmdb_ci']), via: 'Runs on::Runs', down: false }] : []),
  ]), CsdmGraph.builder({ script: 'test' }), { maxCiDepth: 3 });
  eq(g.nodes.map(n => n.id), ['si', 'c1', 'c2', 'c3']);
});

check('walk: a dynamic CI group record is an instance under a business offering', () => {
  const q = rec('q', 'cmdb_ci_query_based_service', ['cmdb_ci_service_auto', ...SVC]);
  eq(CsdmWalk.typeFrom(q, 'BSO', 'Depends on::Used by'), 'SI');
  eq(CsdmWalk.typeFrom(q, 'TMSO', 'Contains::Contained by'), 'DCG');
  eq(CsdmWalk.typeFrom(q, 'SI', 'Contains::Contained by'), 'DCG');
});

check('walk: links the rules do not allow stay out', () => {
  const bso = rec('bso', 'service_offering', SVC, { parentAncestors: BIZ });
  const g = CsdmWalk.walk(bso, ring => ring[0].rec.id !== 'bso' ? [] : [
    { from: 'bso', rec: rec('si', 'cmdb_ci_service_auto', SVC), via: 'Depends on::Used by', down: true },
    { from: 'bso', rec: rec('si2', 'cmdb_ci_service_auto', SVC), via: 'Contains::Contained by', down: true }, // wrong type
    { from: 'bso', rec: rec('other', 'service_offering', SVC, { parentAncestors: BIZ }), via: 'Depends on::Used by', down: true }, // BSO -> BSO
    { from: 'bso', rec: rec('legacy', 'cmdb_ci_service', ['cmdb_ci']), via: 'Depends on::Used by', down: true }, // unclassified
  ], CsdmGraph.builder({ script: 'test' }));
  eq(g.nodes.map(n => n.id), ['bso', 'si']);
});

// --- bso-cluster on a mocked instance ----------------------------------------

const HIER = {
  service_offering: SVC,
  cmdb_ci_service_business: SVC,
  cmdb_ci_service_technical: SVC,
  cmdb_ci_service_discovered: ['cmdb_ci_service_auto', ...SVC],
  cmdb_ci_service_calculated: ['cmdb_ci_service_auto', ...SVC],
  cmdb_ci_query_based_service: ['cmdb_ci_service_auto', ...SVC],
  cmdb_ci_appl: ['cmdb_ci'],
  cmdb_ci_win_server: ['cmdb_ci_server', 'cmdb_ci_computer', 'cmdb_ci'],
  cmdb_ci_db_mssql_instance: ['cmdb_ci_db_instance', 'cmdb_ci'],
};
const LABEL = { cmdb_ci_appl: 'Application', cmdb_ci_win_server: 'Windows Server', cmdb_ci_db_mssql_instance: 'MSSQL Instance' };
const tablesOf = cls => [cls, ...(HIER[cls] || ['cmdb_ci'])];

function mockInstance(instanceName = 'dev12345') {
  const ci = (sys_id, sys_class_name, name, extra) => ({ sys_id, sys_class_name, name, ...extra });
  const cmdb_ci = [
    ci('bs', 'cmdb_ci_service_business', 'Email', { spm_service_portfolio: 'sp' }),
    ci('bso', 'service_offering', 'Email "Standard", EU', { number: 'SO0001', parent: 'bs' }),
    ci('bso-other', 'service_offering', 'Email Premium', { number: 'SO0009', parent: 'bs' }),
    ci('si-prod', 'cmdb_ci_service_discovered', 'Exchange Prod'),
    ci('si-dr', 'cmdb_ci_service_calculated', 'Exchange DR'),
    ci('si-other', 'cmdb_ci_service_discovered', 'Other App'),
    ci('dcg-dr', 'cmdb_ci_query_based_service', 'Exchange DR servers'),
    // an application service populated by the Dynamic CI Group method: stored as a group
    ci('si-q', 'cmdb_ci_query_based_service', 'Exchange Archive'),
    ci('dcg-win', 'cmdb_ci_query_based_service', 'All Windows servers'),
    ci('tms-win', 'cmdb_ci_service_technical', 'Windows Server Management'),
    ci('tmso-win', 'service_offering', 'Windows Server Support', { number: 'SO0002', parent: 'tms-win' }),
    ci('tms-app', 'cmdb_ci_service_technical', 'Messaging Management'),
    ci('tmso-app', 'service_offering', 'Exchange App Support', { number: 'SO0003', parent: 'tms-app' }),
    ci('app', 'cmdb_ci_appl', 'Exchange 2019'),
    ci('other-app', 'cmdb_ci_appl', 'Other 2019'),
    ci('ex01', 'cmdb_ci_win_server', 'ex01'),
    ci('ex02', 'cmdb_ci_win_server', 'ex02'),
    ci('exdb', 'cmdb_ci_db_mssql_instance', 'exdb'),
    ci('dr01', 'cmdb_ci_win_server', 'dr01'),
    ci('dr02', 'cmdb_ci_win_server', 'dr02'),
    ci('other99', 'cmdb_ci_win_server', 'other99'),
  ];
  const relTypes = ['Depends on::Used by', 'Contains::Contained by', 'Runs on::Runs', 'Connects to::Connected by']
    .map((name, i) => ({ sys_id: `t${i}`, name }));
  const typeId = name => relTypes.find(t => t.name === name).sys_id;
  let n = 0;
  const rel = (parent, type, child) => ({ sys_id: `r${n++}`, parent, child, type: typeId(type) });
  const db = {
    cmdb_ci,
    cmdb_rel_type: relTypes,
    cmdb_rel_ci: [
      rel('bso', 'Depends on::Used by', 'si-prod'),
      rel('bso', 'Depends on::Used by', 'si-dr'),
      rel('bso', 'Depends on::Used by', 'si-q'),
      rel('tmso-win', 'Contains::Contained by', 'si-q'),
      rel('bso-other', 'Depends on::Used by', 'si-other'),
      rel('si-prod', 'Depends on::Used by', 'tmso-app'),
      rel('si-prod', 'Depends on::Used by', 'app'),
      rel('si-dr', 'Contains::Contained by', 'dcg-dr'),
      rel('tmso-win', 'Contains::Contained by', 'dcg-dr'),
      rel('tmso-win', 'Contains::Contained by', 'dcg-win'),
      rel('app', 'Runs on::Runs', 'ex01'),
      rel('app', 'Runs on::Runs', 'ex02'),
      rel('app', 'Depends on::Used by', 'exdb'),
      rel('other-app', 'Runs on::Runs', 'ex01'), // above a shared server: not followed
      rel('ex01', 'Connects to::Connected by', 'exdb'), // a type the walk does not follow
    ],
    svc_ci_assoc: [['dcg-dr', 'dr01'], ['dcg-dr', 'dr02'], ['dcg-win', 'ex01'], ['dcg-win', 'ex02'], ['dcg-win', 'dr01'], ['dcg-win', 'other99'], ['dcg-win', 'exdb'], ['si-q', 'dr02']]
      .map(([service_id, ci_id], i) => ({ sys_id: `a${i}`, service_id, ci_id })),
    spm_service_portfolio: [{ sys_id: 'sp', name: 'Collaboration' }],
    spm_taxonomy_node: [],
  };

  const queries = [];
  class GlideRecord {
    constructor(table) {
      this.table = table;
      this.rows = db[table] || cmdb_ci.filter(r => tablesOf(r.sys_class_name).includes(table));
      this.conds = [];
      this.limit = Infinity;
    }
    addQuery(f, op, v) {
      if (v === undefined) [op, v] = ['=', op];
      this.conds.push(op === 'IN' ? r => String(v).split(',').includes(r[f]) : r => r[f] === v);
    }
    setLimit(n) { this.limit = n; }
    query() { queries.push(this.table); this.hits = this.rows.filter(r => this.conds.every(c => c(r))).slice(0, this.limit); this.i = -1; }
    next() { return ++this.i < this.hits.length; }
    get(id) { queries.push(this.table); this.hits = this.rows.filter(r => r.sys_id === id); this.i = 0; return this.hits.length > 0; }
    row() { return this.hits[this.i]; }
    getValue(f) { const v = this.row()[f]; return v === undefined || v === '' ? null : v; }
    getClassDisplayValue() { const cls = this.hits ? this.row().sys_class_name : this.table; return LABEL[cls] || cls; }
    isValid() { return this.table in HIER || this.table in db; }
    getUniqueValue() { return this.row().sys_id; }
  }
  // counts per group of the conditions' rows; only what links() asks of it
  class GlideAggregate extends GlideRecord {
    addAggregate() {}
    groupBy() {}
    query() {
      queries.push(this.table);
      const counts = new Map();
      for (const r of this.rows.filter(r => this.conds.every(c => c(r)))) {
        const cls = cmdb_ci.find(c => c.sys_id === r.ci_id).sys_class_name;
        const key = `${r.service_id}|${cls}`;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      this.hits = [...counts].map(([k, n]) => ({ service_id: k.split('|')[0], 'ci_id.sys_class_name': k.split('|')[1], n }));
      this.i = -1;
    }
    getAggregate() { return String(this.row().n); }
  }
  const out = [];
  const context = {
    GlideRecord,
    GlideAggregate,
    // global scope: TableUtils, handing back a Java list
    TableUtils: function (cls) { const t = tablesOf(cls); this.getTables = () => ({ size: () => t.length, get: i => t[i] }); },
    gs: {
      print: s => out.push(`*** Script: ${s}`),
      // glide.servlet.uri differs on purpose: links come from instance_name
      getProperty: k => ({ instance_name: instanceName, 'glide.servlet.uri': 'https://wrong.example.com/' })[k],
    },
  };
  return { context, out, queries };
}

// settings: {NAME: 'js value'} for the lines at the top of the script
// instanceName: the instance's instance_name property
function runCluster(settings, instanceName) {
  const { context, out, queries } = mockInstance(instanceName);
  let code = fs.readFileSync(path.join(pasteDir, 'bso-cluster.js'), 'utf8');
  for (const [k, v] of Object.entries(settings)) code = code.replace(new RegExp(`^var ${k} = .*?;`, 'm'), `var ${k} = ${v};`);
  vm.runInNewContext(code, context);
  return Object.assign(out.join('\n'), { queries });
}

check('bso-cluster: walks the cluster around an offering', () => {
  const text = runCluster({ ROOT: "'SO0001'" });
  const g = CsdmGraph.parse(text);
  eq(g.nodes.map(x => x.id).sort(), ['app', 'bs', 'bso', 'dcg-dr', 'dcg-dr:cmdb_ci_win_server',
    'dcg-win', 'dcg-win:cmdb_ci_db_mssql_instance', 'dcg-win:cmdb_ci_win_server', 'ex01', 'ex02', 'exdb',
    'si-dr', 'si-prod', 'si-q', 'si-q:cmdb_ci_win_server', 'sp', 'tms-app', 'tms-win', 'tmso-app', 'tmso-win']);
  eq(g.nodes.filter(x => x.count).map(x => [x.id, x.className, x.count]).sort(), [
    ['dcg-dr:cmdb_ci_win_server', 'Windows Server', 2],
    ['dcg-win:cmdb_ci_db_mssql_instance', 'MSSQL Instance', 1],
    ['dcg-win:cmdb_ci_win_server', 'Windows Server', 4],
    ['si-q:cmdb_ci_win_server', 'Windows Server', 1],
  ]);
  const type = Object.fromEntries(g.nodes.map(x => [x.id, x.type]));
  eq([type.bso, type.bs, type.sp, type['si-prod'], type['si-q'], type['dcg-dr'], type['tmso-win'], type['tms-win'], type.ex01],
    ['BSO', 'BS', 'SP', 'SI', 'SI', 'DCG', 'TMSO', 'TMS', 'CI']);
  eq(g.edges.map(e => `${e.from}>${e.to}`).sort(), [
    'app>ex01', 'app>ex02', 'app>exdb',
    'bs>sp', 'bso>bs', 'bso>si-dr', 'bso>si-prod', 'bso>si-q',
    'dcg-dr>dcg-dr:cmdb_ci_win_server',
    'dcg-win>dcg-win:cmdb_ci_db_mssql_instance', 'dcg-win>dcg-win:cmdb_ci_win_server',
    'si-dr>dcg-dr', 'si-prod>app', 'si-prod>tmso-app', 'si-q>si-q:cmdb_ci_win_server',
    'tmso-app>tms-app', 'tmso-win>dcg-dr', 'tmso-win>dcg-win', 'tmso-win>si-q', 'tmso-win>tms-win',
  ]);
  eq(g.edges.find(e => e.from === 'si-dr').rel, 'Contains::Contained by');
  eq(g.source.root, 'bso');
  eq(g.warnings, []);
});

check('bso-cluster: reads a ring at a time', () => {
  // one query per table per ring, not one per record
  const { queries } = runCluster({ ROOT: "'SO0001'" });
  ok(queries.length < 60, `${queries.length} queries`);
});

check('bso-cluster: group members are counted, never read', () => {
  const { queries } = runCluster({ ROOT: "'SO0001'" });
  eq(queries.filter(t => t === 'svc_ci_assoc').length, 3); // one aggregate per ring holding groups
});

check('bso-cluster: a tech offering is refused', () => {
  const text = runCluster({ ROOT: "'SO0002'" });
  ok(/Windows Server Support \(SO0002\) is a TMSO, not a BSO\. Please provide a BSO\./.test(text), text);
  ok(!/--- csdmflow ---/.test(text), 'drew it anyway');
});

check('bso-cluster: every box links to its record on the instance', () => {
  const text = runCluster({ ROOT: "'SO0001'" });
  const src = /--- csdmflow ---\n([\s\S]*?)\n\*\*\* Script: --- playground/.exec(text)[1];
  const { ents } = parseCsdm(src);
  const href = name => [...ents.values()].find(e => e.instances.join(', ') === name).href;
  const base = 'https://dev12345.service-now.com/';
  eq(href('Exchange Prod'), base + 'cmdb_ci_service_discovered.do?sys_id=si-prod');
  eq(href('Email "Standard", EU'), base + 'service_offering.do?sys_id=bso');
  eq(href('Collaboration'), base + 'spm_service_portfolio.do?sys_id=sp');
  // a stack of several CIs: the list of them
  eq(href('ex01, ex02'), base + 'cmdb_ci_list.do?sysparm_query=' + encodeURIComponent('sys_idINex01,ex02'));
  // counted members: the list behind the count
  eq(href('4 CIs'), base + 'svc_ci_assoc_list.do?sysparm_query=' + encodeURIComponent('service_id=dcg-win^ci_id.sys_class_name=cmdb_ci_win_server'));
  ok([...ents.values()].every(e => e.href), 'a box without a link');
  eq(compileCsdm(src).warnings, []);
});

check('bso-cluster: no usable instance address, no links, no failure', () => {
  for (const name of [null, '', 'dev 1', 'evil.com/x', 'javascript:alert(1)//']) {
    const src = /--- csdmflow ---\n([\s\S]*?)\n\*\*\* Script: --- playground/.exec(runCluster({ ROOT: "'SO0001'" }, name))[1];
    ok(!/^link /m.test(src), `links with instance_name ${JSON.stringify(name)}`);
  }
});

check('bso-cluster: an unknown offering says so', () => {
  ok(/No service offering with sys_id or number "SO9999"/.test(runCluster({ ROOT: "'SO9999'" })), 'no message');
});

check('bso-cluster: the printed source compiles and renders', () => {
  const src = /--- csdmflow ---\n([\s\S]*?)\n\*\*\* Script: --- playground/.exec(runCluster({ ROOT: "'SO0001'" }))[1];
  const c = compileCsdm(src);
  eq(c.warnings, []);
  ok(renderSvg(c.gf).svg.startsWith('<svg'), 'no svg');
  ok(/^title "Email #quot;Standard#quot;, EU"$/m.test(src), 'title');
});

console.log(`${failed ? 'FAILED' : 'ok'} — bg-scripts`);
process.exit(failed ? 1 : 0);
