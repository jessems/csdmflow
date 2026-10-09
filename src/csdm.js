'use strict';

// csdm — content-only front-end for gridflow.
// A .csdm file lists CSDM entities and relationships; everything visual
// (grid placement, relationship labels/styles, colours, legend, key) is derived
// here from CSDM semantics and emitted as ordinary gridflow source.
//
//   layout cross|tiers|row               (default cross; see place())
//   layout reach <delivery> <consumption>  (each 0-2; presets are shorthands)
//   theme dark|light                     (default dark)
//   linecolors domain|plain              (default domain: relationships take the
//                                         colour of their domain, as on the slides)
//   title "..." / subtitle "..."
//   <TYPE>[(ci class)] [id:] Name[, Name2] [Variant, ...]
//                                         e.g.  BA o365: O365 E5
//                                               SI ea: *EA Prod [Dev, QA]
//   a -> b [: label override]

const TYPES = {
  BC: { title: 'Business Capability', domain: 'design' },
  BA: { title: 'Business Application', domain: 'design' },
  SI: { title: 'Service Instance', domain: 'delivery' },
  TMS: { title: 'Tech Mgmt Service', domain: 'delivery' },
  TMSO: { title: 'Tech Mgmt Service Offering', domain: 'offering' },
  DCG: { title: 'Dynamic CI Group', domain: 'offering' },
  CI: { title: 'Infrastructure CI', domain: 'delivery' },
  BSO: { title: 'Bus Service Offering', domain: 'consumption' },
  BS: { title: 'Bus Service', domain: 'consumption' },
  SP: { title: 'Service Portfolio', domain: 'consumption' },
};

// Relationship semantics keyed "FROM>TO". kind: rel | ref | map | strategic.
const RELS = {
  'BC>BA': { label: 'Provided by', kind: 'rel' },
  'BA>SI': { label: 'Consumes', kind: 'rel' },
  'BA>BA': { label: 'References', kind: 'ref' },
  'BSO>SI': { label: 'Depends On', kind: 'rel' },
  'BSO>BS': { label: 'References', kind: 'ref' },
  'TMSO>TMS': { label: 'References', kind: 'ref' },
  'TMSO>SI': { label: 'Contains', kind: 'rel' },
  'TMSO>DCG': { label: 'Contains', kind: 'rel' },
  'TMSO>CI': { label: 'Contains', kind: 'rel' },
  'DCG>CI': { label: 'Query based Contains', kind: 'rel' },
  'SI>CI': { label: '', kind: 'map' },
  'CI>CI': { label: '', kind: 'map' },
  'SI>SI': { label: 'Depends On', kind: 'rel' },
  'TMS>SP': { label: 'References', kind: 'ref' },
  'BS>SP': { label: 'References', kind: 'ref' },
  'BC>TMS': { label: 'Provided by::Provides', kind: 'strategic' },
  'BC>BS': { label: 'Provided by::Provides', kind: 'strategic' },
};

const THEMES = {
  dark: {
    background: '#112c40 #204242',
    edge: '#e9ebed', map: '#69aeef', strategic: '#a974e8',
    lines: { delivery: '#f0ac45', consumption: '#73c26a' },
    domains: {
      design: ['#5dbfcd', '#8fd6e0'],
      delivery: ['#f0ac45', '#f6c983'],
      offering: ['#b88c44', '#d2ad72'],
      consumption: ['#73c26a', '#a3d99c'],
    },
    text: '#0b0b0b',
  },
  light: {
    background: null,
    edge: '#4a4a4a', map: '#2f80d1', strategic: '#8a4fd6',
    lines: { delivery: '#e2711d', consumption: '#169873' },
    domains: {
      design: ['#d6f0f4', '#2a9fb1'],
      delivery: ['#fbe3d4', '#e2711d'],
      offering: ['#f1e2c6', '#a87a2c'],
      consumption: ['#d9ede4', '#169873'],
    },
    text: '#33322e',
  },
};

const LEGEND = [
  ['Ideation and Strategy', '#f3dc4b'],
  ['Design and Planning', '#5dbfcd'],
  ['Build & Integration', '#e9707f'],
  ['Service Delivery', '#f0ac45'],
  ['Service Consumption', '#73c26a'],
];

function csdmError(msg, ln) {
  const e = new Error(ln ? `line ${ln}: ${msg}` : msg);
  e.gridflow = true;
  return e;
}

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function parseCsdm(source) {
  const opts = { reach: PRESETS.cross, theme: 'dark', linecolors: 'domain', title: null, subtitle: null, warnings: [] };
  const ents = new Map();
  const rels = [];
  const typeAlt = Object.keys(TYPES).join('|');
  const entRe = new RegExp(`^(${typeAlt})(?:\\(([^)]*)\\))?\\s+(?:([a-z0-9][a-z0-9-]*):\\s*)?(.+)$`);

  source.split(/\r?\n/).forEach((raw, i) => {
    const ln = i + 1;
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    let m;
    if ((m = /^layout\s+(cross|tiers|row)$/.exec(line))) { opts.reach = PRESETS[m[1]]; return; }
    if ((m = /^layout\s+reach\s+([0-2])\s+([0-2])$/.exec(line))) { opts.reach = [+m[1], +m[2]]; return; }
    if ((m = /^orientation\s+(horizontal|vertical)$/.exec(line))) {
      // pre-`layout` spelling
      opts.reach = m[1] === 'vertical' ? PRESETS.tiers : PRESETS.cross;
      opts.warnings.push(`line ${ln}: "orientation ${m[1]}" is deprecated; use "layout ${m[1] === 'vertical' ? 'tiers' : 'cross'}"`);
      return;
    }
    if (/^layout\b/.test(line)) throw csdmError(`layout must be cross, tiers, row or "reach <0-2> <0-2>"`, ln);
    if ((m = /^theme\s+(dark|light)$/.exec(line))) { opts.theme = m[1]; return; }
    if ((m = /^linecolors\s+(domain|plain)$/.exec(line))) { opts.linecolors = m[1]; return; }
    if ((m = /^(title|subtitle)\s+"([^"]*)"$/.exec(line))) { opts[m[1]] = m[2]; return; }
    if ((m = /^([a-z0-9][a-z0-9-]*)\s*->\s*([a-z0-9][a-z0-9-]*)\s*(?::\s*(.+))?$/.exec(line))) {
      rels.push({ from: m[1], to: m[2], label: m[3] ? m[3].trim() : null, ln });
      return;
    }
    if ((m = entRe.exec(line))) {
      let name = m[4].trim();
      // trailing [A, B]: variants of this entity (environments, locations)
      let variants = [];
      const vm = /^(.*?)\s*\[([^\]]*)\]$/.exec(name);
      if (vm) {
        name = vm[1].trim();
        variants = vm[2].split(',').map(v => v.trim()).filter(Boolean);
        if (!variants.length) throw csdmError('empty variant list "[]"', ln);
      }
      const id = m[3] || slug(name);
      if (ents.has(id)) throw csdmError(`duplicate id "${id}" — give one of them an explicit id ("${m[1]} myid: ${name}")`, ln);
      const instances = name.split(/\s*,\s*/);
      ents.set(id, { id, type: m[1], ciClass: m[2] || null, name, instances, variants, order: ents.size, ln });
      return;
    }
    throw csdmError(`unrecognised line: "${line}"`, ln);
  });

  for (const r of rels) {
    for (const id of [r.from, r.to]) {
      if (!ents.has(id)) throw csdmError(`unknown entity "${id}"`, r.ln);
    }
    const a = ents.get(r.from), b = ents.get(r.to);
    let sem = RELS[`${a.type}>${b.type}`];
    if (!sem && RELS[`${b.type}>${a.type}`]) {
      // written against the CSDM direction: flip it
      [r.from, r.to] = [r.to, r.from];
      sem = RELS[`${b.type}>${a.type}`];
    }
    r.sem = sem || { label: '', kind: 'rel', unknown: true };
  }
  return { opts, ents, rels };
}

// --- placement ---------------------------------------------------------------
//
// Every slide in the reference deck keeps the same skeleton: business
// applications (and capabilities) above their service instances, tech
// offerings to the LEFT of what they contain, business offerings to the RIGHT,
// infrastructure below. What varies is how far each side's chain runs sideways
// before it turns downward:
//
//   Tech Mgmt Service <- Tech Mgmt Offering <- [Service Instance] -> Bus Offering -> Bus Service
//
// `reach` is that distance per side, [delivery, consumption], each 0..2:
//   2  both boxes beside the instance row
//   1  the offering beside the instance, its service stacked below it
//   0  the offering one tier below the instance, its service below that
// Presets: cross = 2 1 (most slides), tiers = 0 0, row = 2 2.
// With consumption reach 2 and several instances, the application stacks become
// rows instead of columns (applications left of their instance), mirroring `tiers`.
//
// Everything else is derived: positions follow the median of already-placed
// neighbours. Portfolios continue their service's direction.

const PRESETS = { cross: [2, 1], tiers: [0, 0], row: [2, 2] };

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
}

function place(model) {
  const { ents, rels, opts } = model;
  const [dReach, cReach] = opts.reach;
  const adj = new Map([...ents.keys()].map(id => [id, []]));
  for (const r of rels) {
    adj.get(r.from).push(r.to);
    adj.get(r.to).push(r.from);
  }
  const order = [...ents.values()].sort((a, b) => a.order - b.order);
  const ofType = (...ts) => order.filter(e => ts.includes(e.type));
  const nbrs = (e, ...ts) => adj.get(e.id).map(id => ents.get(id)).filter(n => !ts.length || ts.includes(n.type));

  const cells = new Map(); // "row|col" -> id
  const pos = new Map(); // id -> {row, col}
  const free = (r, c) => !cells.has(`${r}|${c}`);
  const occupy = (e, r, c) => { cells.set(`${r}|${c}`, e.id); pos.set(e.id, { row: r, col: c }); };
  const placedCols = list => list.map(n => pos.get(n.id)).filter(Boolean).map(p => p.col);
  const placedRows = list => list.map(n => pos.get(n.id)).filter(Boolean).map(p => p.row);
  const cols = () => [...pos.values()].map(p => p.col);
  const rows = () => [...pos.values()].map(p => p.row);
  const nextCol = () => (pos.size ? Math.max(...cols()) + 1 : 0);

  // nearest free column in a row (ties go right), optionally bounded
  const putInRow = (e, row, want, lo = -Infinity, hi = Infinity) => {
    for (let d = 0; ; d++) {
      for (const c of d ? [want + d, want - d] : [want]) {
        if (c >= lo && c <= hi && free(row, c)) return occupy(e, row, c);
      }
      if (want + d > hi && want - d < lo) throw new Error('csdm: no free cell');
    }
  };
  // nearest free row in a column at or below `min`, preferring `want`
  const putInCol = (e, col, want, min = 0) => {
    want = Math.max(want, min);
    for (let d = 0; ; d++) {
      for (const r of d ? [want + d, want - d] : [want]) {
        if (r >= min && free(r, col)) return occupy(e, r, col);
      }
    }
  };
  // shelf rows: try the preferred row near `want`, then the rows below it
  const putOnShelf = (e, row, want, lo, hi) => {
    for (let r = row; ; r++) {
      for (let d = 0; d <= 2; d++) {
        for (const c of d ? [want + d, want - d] : [want]) {
          if (c >= lo && c <= hi && free(r, c)) return occupy(e, r, c);
        }
      }
    }
  };
  const colWant = (e, fallback, ...ts) => { const m = median(placedCols(nbrs(e, ...ts))); return m === null ? fallback : m; };
  const rowWant = (e, fallback, ...ts) => { const m = median(placedRows(nbrs(e, ...ts))); return m === null ? fallback : m; };
  const lowest = list => { const r = placedRows(list); return r.length ? Math.max(...r) : null; };

  // When consumption runs fully sideways (reach 2) every application stack
  // becomes a row: instances stack vertically and applications sit to their
  // left (slides 37, 55). Otherwise stacks are columns: instances share one row
  // with applications above them.
  const stackRows = cReach === 2 && ofType('SI').length > 1;
  const BC = 0, BA = 1, SI = stackRows ? 1 : 2;

  // --- app zone ---
  if (stackRows) {
    ofType('SI').forEach((e, i) => occupy(e, SI + i, 0));
    for (const e of ofType('BA')) {
      const own = placedRows(nbrs(e, 'SI'));
      if (own.length) putInCol(e, -1, median(own), SI);
      else putInRow(e, 0, -1); // platform host: above the applications that reference it
    }
    for (const e of ofType('BC')) putInRow(e, 0, colWant(e, -1, 'BA'));
  } else {
    ofType('SI').forEach((e, i) => occupy(e, SI, i));
    // applications sit over their own instance; a platform host (no instance of
    // its own) sits over the applications that reference it
    for (const e of ofType('BA')) {
      const own = placedCols(nbrs(e, 'SI'));
      putInRow(e, BA, own.length ? median(own) : colWant(e, nextCol(), 'BA', 'SI'));
    }
    for (const e of ofType('BC')) putInRow(e, BC, colWant(e, nextCol(), 'BA'));
  }
  const appLo = 0;
  const appHi = Math.max(0, nextCol() - 1);

  // --- consumption, reach 0: offerings tier under their instance, then down ---
  if (cReach === 0) {
    for (const e of ofType('BSO')) putInRow(e, SI + 1, colWant(e, nextCol(), 'SI'));
    for (const e of ofType('BS')) putInRow(e, SI + 2, colWant(e, nextCol(), 'BSO'));
    for (const e of ofType('SP').filter(sp => nbrs(sp, 'BS').length)) putInRow(e, SI + 3, colWant(e, nextCol(), 'BS'));
  }

  // --- infrastructure: below the instances (and below a stacked consumption tier) ---
  const ciTop = (cReach === 0 || stackRows) && pos.size ? Math.max(...rows()) + 1 : SI + 1;
  // Service mapping runs downward on the reference slides: each hop from the
  // instance (app -> server -> database -> switch ...) is one row lower, and
  // CIs at the same depth spread sideways under their parent. A hop between
  // two CIs of the same class (app -> app) is a peer link and stays level.
  const depth = new Map();
  const mapRels = rels.filter(r => r.sem.kind === 'map' || ents.get(r.to).type === 'CI');
  const peer = (a, b) => a.type === 'CI' && b.type === 'CI' && (a.ciClass || '') === (b.ciClass || '');
  const frontier = ofType('SI').map(e => e.id);
  frontier.forEach(id => depth.set(id, 0));
  while (frontier.length) {
    const id = frontier.shift();
    for (const r of mapRels) {
      if (r.from !== id || ents.get(r.to).type !== 'CI') continue;
      const d = depth.get(id) + (peer(ents.get(id), ents.get(r.to)) ? 0 : 1);
      if (depth.has(r.to) && depth.get(r.to) <= d) continue;
      depth.set(r.to, d);
      frontier.push(r.to);
    }
  }
  const parentsOf = e => mapRels.filter(r => r.to === e.id && depth.has(r.from) && depth.get(r.from) <= (depth.get(e.id) ?? Infinity) && r.from !== e.id)
    .map(r => ents.get(r.from));
  const cis = ofType('CI').sort((a, b) => (depth.get(a.id) ?? 99) - (depth.get(b.id) ?? 99));
  for (const e of cis) {
    const d = depth.get(e.id);
    if (d === undefined) continue; // not reachable from an instance: placed below
    const want = median(placedCols(parentsOf(e)));
    putInRow(e, ciTop + d - 1, want === null ? colWant(e, appLo, 'SI', 'CI') : want);
  }
  // CIs only reachable via groups or other CIs: shelf below the mapped tree
  const treeBottom = Math.max(ciTop - 1, ...cis.filter(e => pos.has(e.id)).map(e => pos.get(e.id).row));
  let pending = ofType('CI').filter(e => !pos.has(e.id));
  while (pending.length) {
    const ready = pending.filter(e => placedCols(nbrs(e, 'SI', 'CI')).length);
    for (const e of ready.length ? ready : [pending[0]]) {
      putOnShelf(e, treeBottom + 1, colWant(e, appLo, 'SI', 'CI'), appLo, Math.max(appHi, appLo + 2));
    }
    pending = pending.filter(e => !pos.has(e.id));
  }
  const lo = Math.min(...cols());
  const hi = Math.max(...cols());

  // --- consumption, reach 1-2: flank to the right of the app zone ---
  if (cReach > 0) {
    const bsoCol = hi + 1;
    for (const e of ofType('BSO')) putInCol(e, bsoCol, rowWant(e, SI, 'SI'), SI);
    if (cReach === 2) {
      for (const e of ofType('BS')) putInCol(e, bsoCol + 1, rowWant(e, SI, 'BSO'), SI);
    } else {
      // service stacked under its offering(s), same column
      for (const e of ofType('BS')) {
        const under = lowest(nbrs(e, 'BSO'));
        putInCol(e, bsoCol, under === null ? SI + 1 : under + 1, SI + 1);
      }
    }
    for (const e of ofType('SP').filter(sp => nbrs(sp, 'BS').length)) {
      const bs = nbrs(e, 'BS').find(n => pos.has(n.id));
      const p = bs ? pos.get(bs.id) : { row: SI, col: bsoCol };
      if (cReach === 2) putInCol(e, p.col + 1, p.row, SI);
      else putInCol(e, p.col, p.row + 1, p.row + 1);
    }
  }

  // --- delivery: flank to the left of everything placed so far ---
  const dcgs = ofType('DCG');
  if (dReach > 0) {
    const dcgCol = lo - 1;
    const tmsoCol = lo - (dcgs.length ? 2 : 1);
    for (const e of dcgs) putInCol(e, dcgCol, rowWant(e, SI + 1, 'CI'), SI);
    for (const e of ofType('TMSO')) {
      putInCol(e, tmsoCol, rowWant(e, SI, 'SI', 'CI', 'DCG'), SI);
      // reach 1: a service owned by this offering alone goes straight under it
      if (dReach === 1) {
        for (const t of nbrs(e, 'TMS')) {
          if (!pos.has(t.id) && nbrs(t, 'TMSO').length === 1) putInCol(t, tmsoCol, pos.get(e.id).row + 1, pos.get(e.id).row + 1);
        }
      }
    }
    if (dReach === 2) {
      for (const e of ofType('TMS')) putInCol(e, tmsoCol - 1, rowWant(e, SI, 'TMSO'), SI);
    } else {
      for (const e of ofType('TMS').filter(t => !pos.has(t.id))) {
        const under = lowest(nbrs(e, 'TMSO'));
        putInCol(e, tmsoCol, under === null ? SI + 1 : under + 1, SI + 1);
      }
    }
  } else {
    // offerings tier, one column per tech offering, left of the app zone
    const tmsos = ofType('TMSO');
    const left = lo - tmsos.length;
    tmsos.forEach((e, k) => occupy(e, SI + 1, left + k));
    for (const e of ofType('TMS')) putInRow(e, SI + 2, colWant(e, left, 'TMSO'), -Infinity, lo - 1);
    for (const e of dcgs) {
      const ciRow = median(placedRows(nbrs(e, 'CI')));
      putInRow(e, ciRow === null ? SI + 3 : ciRow, colWant(e, left, 'TMSO'), -Infinity, lo - 1);
    }
  }
  for (const e of ofType('SP').filter(sp => !pos.has(sp.id) && nbrs(sp, 'TMS').length)) {
    const tms = nbrs(e, 'TMS').find(n => pos.has(n.id));
    const p = tms ? pos.get(tms.id) : { row: SI, col: lo - 1 };
    if (dReach === 2) putInCol(e, p.col - 1, p.row, SI);
    else putInCol(e, p.col, p.row + 1, p.row + 1);
  }

  // anything of an unexpected shape that is still unplaced
  for (const e of order) if (!pos.has(e.id)) putInRow(e, SI + 1, nextCol());

  // normalise to a 0-based grid
  const minC = Math.min(...cols());
  for (const p of pos.values()) p.col -= minC;
  return pos;
}

// --- emit gridflow -----------------------------------------------------------

const q = s => s.replace(/"/g, "'");

function compileCsdm(source) {
  const model = parseCsdm(source);
  const { opts, ents, rels } = model;
  const theme = THEMES[opts.theme];
  const pos = place(model);
  const warnings = [...opts.warnings, ...rels.filter(r => r.sem.unknown).map(r =>
    `line ${r.ln}: no CSDM relationship known for ${ents.get(r.from).type} -> ${ents.get(r.to).type}; drawn unlabeled`)];
  const stacked = opts.reach[0] === 0 && opts.reach[1] === 0;
  const grid = [];
  for (const [id, p] of pos) (grid[p.row] = grid[p.row] || [])[p.col] = id;
  const nCols = Math.max(...grid.filter(Boolean).map(r => r.length));

  const out = ['# generated by csdm.js — edit the .csdm source, not this file'];
  if (theme.background) out.push(`background ${theme.background}`);
  if (opts.title) out.push(`title "${q(opts.title)}"`);
  if (opts.subtitle) out.push(`subtitle "${q(opts.subtitle)}"`);
  out.push('font 11', 'box 112', stacked ? 'gap 56 56' : 'gap 74 56');

  // legend: only domains present
  const usedDomains = new Set([...ents.values()].map(e => TYPES[e.type].domain));
  const domainLegend = { design: 1, delivery: 3, offering: 3, consumption: 4 };
  const legendIdx = new Set([...usedDomains].map(d => domainLegend[d]));
  out.push('legend "Domains"');
  LEGEND.forEach(([t, c], i) => { if (legendIdx.has(i)) out.push(`legend "${t}" ${c}`); });

  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] || [];
    const cells = [];
    for (let c = 0; c < nCols; c++) {
      const id = row[c];
      if (!id) { cells.push('.'); continue; }
      const e = ents.get(id);
      const title = e.type === 'CI' && e.ciClass ? e.ciClass : TYPES[e.type].title;
      cells.push(`${gfId(id)}["${q(title)}|${q(e.name)}"]`);
    }
    if (cells.every(c => c === '.')) continue;
    out.push('row ' + cells.join(' '));
  }

  // edge styles + key: only kinds present
  const kinds = new Set(rels.map(r => r.sem.kind));
  out.push(`linkclass rel stroke=${theme.edge}`);
  out.push(`linkclass rel-delivery stroke=${theme.lines.delivery}`);
  out.push(`linkclass rel-consumption stroke=${theme.lines.consumption}`);
  out.push(`linkclass ref stroke=${theme.edge} dashed=yes`);
  out.push(`linkclass map stroke=${theme.map}`);
  out.push(`linkclass strategic stroke=${theme.strategic} both=yes`);
  if (kinds.has('strategic')) out.push('key "Strategic Relationship (Provides)" strategic');
  if (kinds.has('rel')) out.push('key "Relationship" rel');
  if (kinds.has('map')) out.push('key "Service Mapping" map');
  if (kinds.has('ref')) out.push('key "References" ref');

  // Strategic edges go around the outside, on the side their far end sits.
  const center = (nCols - 1) / 2;
  // Edges route in declaration order, and earlier edges claim the best ports:
  // main relationships and mappings first, references next, strategic last.
  const rank = { rel: 0, map: 1, ref: 2, strategic: 3 };
  const routed = [...rels].sort((x, y) => rank[x.sem.kind] - rank[y.sem.kind] || x.ln - y.ln);
  for (const r of routed) {
    const a = gfId(r.from), b = gfId(r.to);
    const label = r.label !== null ? r.label : r.sem.label;
    const lab = label ? ` : ${label}` : '';
    const k = r.sem.kind;
    const op = k === 'ref' ? '-.->' : k === 'map' ? '---' : k === 'strategic' ? '<-->' : '-->';
    let attrs = k;
    if (k === 'rel' && opts.linecolors === 'domain') attrs = relLineClass(ents.get(r.from), ents.get(r.to));
    if (k === 'strategic') {
      attrs += ` via=${pos.get(r.to).col <= center ? 'left' : 'right'} exit=bottom`;
    }
    out.push(`${a} ${op} ${b}${lab} {${attrs}}`);
  }

  // variants: labelled back cards (environments, locations)
  for (const e of ents.values()) {
    if (e.variants.length) out.push(`variants ${gfId(e.id)} ${e.variants.map(v => `"${q(v)}"`).join(' ')}`);
  }

  // stacks for multi-instance entities
  const stacks = [...ents.values()].filter(e => e.instances.length > 1).map(e => gfId(e.id));
  if (stacks.length) out.push('stack ' + stacks.join(' '));

  // classes by domain
  const byDomain = {};
  for (const e of ents.values()) (byDomain[TYPES[e.type].domain] = byDomain[TYPES[e.type].domain] || []).push(gfId(e.id));
  for (const [d, ids] of Object.entries(byDomain)) {
    const [fill, stroke] = theme.domains[d];
    out.push(`class ${d} fill=${fill} stroke=${stroke} text=${theme.text} ${ids.join(' ')}`);
  }
  return { gf: out.join('\n') + '\n', warnings };
}

// Relationship line colour by domain (slides 41, 43, 56): consumption-side
// relationships (business offering -> instance) are green, relationships inside
// Delivery (offering contains instance/CI, instance -> instance, group -> CI)
// are orange, anything from the Design side (Consumes, Provided by) stays plain.
const DELIVERY = new Set(['SI', 'TMS', 'TMSO', 'DCG', 'CI']);
function relLineClass(from, to) {
  if (TYPES[from.type].domain === 'consumption') return 'rel-consumption';
  if (DELIVERY.has(from.type) && DELIVERY.has(to.type)) return 'rel-delivery';
  return 'rel';
}

// gridflow ids must start with a letter and be [\w-]
function gfId(id) {
  return /^[A-Za-z]/.test(id) ? id : 'n' + id;
}

module.exports = { compileCsdm, parseCsdm, TYPES, RELS };
