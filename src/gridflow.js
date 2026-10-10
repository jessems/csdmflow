'use strict';

// gridflow — grid-pinned diagram renderer.
// parse() -> model, layout() -> geometry, route() -> orthogonal paths, renderSvg() -> string.
// Deterministic by design: no randomness, edges routed in declaration order.

// Text metrics; `font <px>` in a .gf file rescales them for that render.
let FONT_SIZE = 14;
let CHAR_W = 7.7; // estimated average glyph width at 14px semi-bold sans
const PAD_X = 12;
const BOX_H = 56;
const BOX_W_MIN = 160;
const BOX_W_MAX = 220;
const COL_GAP_DEFAULT = 60;
const ROW_GAP_DEFAULT = 70;
const MARGIN = 30;
const LANE_STEP = 8;
const PORT_STEP = 14;
const HOP_R = 6;
const DOT_R = 2.5;
const STROKE_W = 2;
const DEFAULT_FILL = '#f2f2f2';
const DEFAULT_STROKE = '#4a4a4a';
const TEXT_COLOR = '#33322e';
let LINE_H = 17;
let PAD_Y = 10;
// Variant back cards (environments, locations): offset per card, scaled by font.
const VARIANT_DX = 26;
const VARIANT_DY = 16;
const OUTER_GAP = 44; // width of the outer channel used by via=left/right edges
const TITLE_H = 70;
let LABEL_SIZE = 12;
let LABEL_CHAR_W = 6.4;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parseError(msg, lineNo) {
  const e = new Error(lineNo ? `line ${lineNo}: ${msg}` : msg);
  e.gridflow = true;
  return e;
}

function tokenizeCells(s, ln) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    if (/\s/.test(s[i])) { i++; continue; }
    if (s[i] === '.') { out.push('.'); i++; continue; }
    const m = /^[A-Za-z][\w-]*(\["[^"]*"\])?/.exec(s.slice(i));
    if (!m) throw parseError(`bad cell token near "${s.slice(i, i + 15)}"`, ln);
    out.push(m[0]);
    i += m[0].length;
  }
  return out;
}

function parse(source) {
  const nodes = new Map();
  const grid = [];
  const edges = [];
  const classes = new Map();
  const linkClasses = new Map();
  const shifts = [];
  const meta = { background: null, title: null, subtitle: null, box: null, gap: null, legend: [], legendTitle: null, key: [], notes: [], stacks: [], variants: [] };

  const kvs = (parts, ln) => {
    const out = { names: [] };
    for (const p of parts) {
      const kv = /^([a-z]+)=(\S+)$/.exec(p);
      if (kv) out[kv[1]] = kv[2];
      else out.names.push(p);
    }
    return out;
  };

  source.split(/\r?\n/).forEach((raw, i) => {
    const ln = i + 1;
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) return;

    if (/^row(\s|$)/.test(line)) {
      const cells = [];
      for (const [c, tok] of tokenizeCells(line.slice(3).trim(), ln).entries()) {
        if (tok === '.') { cells.push(null); continue; }
        const m = /^([A-Za-z][\w-]*)(?:\["([^"]*)"\])?$/.exec(tok);
        if (!m) throw parseError(`bad cell token "${tok}"`, ln);
        if (nodes.has(m[1])) throw parseError(`duplicate node "${m[1]}"`, ln);
        const text = m[2] !== undefined ? m[2] : m[1];
        const [title, ...rest] = text.split('|');
        nodes.set(m[1], { id: m[1], label: title, sub: rest.join(' '), row: grid.length, col: c, cls: null, dx: 0, dy: 0 });
        cells.push(m[1]);
      }
      grid.push(cells);
      return;
    }

    let m = /^([A-Za-z][\w-]*)\s*(<-->|<-\.->|-->|-\.->|---|-\.-)\s*([A-Za-z][\w-]*)\s*(?::\s*([^{]*?))?\s*(?:\{([^}]*)\})?$/.exec(line);
    if (m) {
      const op = m[2];
      const attrs = kvs((m[5] || '').trim().split(/\s+/).filter(Boolean), ln);
      edges.push({
        from: m[1], to: m[3], line: ln,
        dashed: op.includes('.'),
        arrowEnd: op.endsWith('>'),
        arrowStart: op.startsWith('<'),
        label: m[4] ? m[4].trim() : '',
        attrs,
      });
      return;
    }

    m = /^(title|subtitle)\s+"([^"]*)"$/.exec(line);
    if (m) { meta[m[1]] = m[2]; return; }

    m = /^font\s+(\d+(?:\.\d+)?)$/.exec(line);
    if (m) { meta.font = +m[1]; return; }

    m = /^box\s+(\d+)$/.exec(line);
    if (m) { meta.box = +m[1]; return; }

    m = /^gap\s+(\d+)\s+(\d+)$/.exec(line);
    if (m) { meta.gap = [+m[1], +m[2]]; return; }

    m = /^note\s+([A-Za-z][\w-]*)\s+"([^"]*)"$/.exec(line);
    if (m) { meta.notes.push({ id: m[1], text: m[2], line: ln }); return; }

    m = /^variants\s+([A-Za-z][\w-]*)\s+(.+)$/.exec(line);
    if (m) {
      const names = [...m[2].matchAll(/"([^"]*)"/g)].map(x => x[1]);
      if (!names.length) throw parseError('variants needs quoted names, e.g. variants ea "Dev" "QA"', ln);
      meta.variants.push({ id: m[1], names, line: ln });
      return;
    }

    m = /^stack\s+(.+)$/.exec(line);
    if (m) { meta.stacks.push(...m[1].trim().split(/\s+/)); return; }

    m = /^key\s+"([^"]*)"\s+(\S+)$/.exec(line);
    if (m) { meta.key.push({ text: m[1], lc: m[2], line: ln }); return; }

    m = /^legend\s+"([^"]*)"(?:\s+(\S+))?$/.exec(line);
    if (m) {
      if (m[2]) meta.legend.push({ text: m[1], color: m[2] });
      else meta.legendTitle = m[1];
      return;
    }

    m = /^background\s+(\S+)(?:\s+(\S+))?$/.exec(line);
    if (m) { meta.background = [m[1], m[2] || m[1]]; return; }

    m = /^shift\s+([A-Za-z][\w-]*)\s+(-?[\d.]+)(?:\s+(-?[\d.]+))?$/.exec(line);
    if (m) { shifts.push({ id: m[1], dx: +m[2], dy: m[3] ? +m[3] : 0, line: ln }); return; }

    if (/^linkclass\s/.test(line)) {
      const parts = line.split(/\s+/).slice(1);
      const name = parts.shift();
      if (!name) throw parseError('linkclass needs a name', ln);
      linkClasses.set(name, kvs(parts, ln));
      return;
    }

    if (/^class\s/.test(line)) {
      const parts = line.split(/\s+/).slice(1);
      if (!parts.length) throw parseError('class needs a name', ln);
      const name = parts.shift();
      const def = { fill: DEFAULT_FILL, stroke: DEFAULT_STROKE, ids: [], line: ln };
      for (const p of parts) {
        const kv = /^(fill|stroke|text)=(\S+)$/.exec(p);
        if (kv) def[kv[1]] = kv[2];
        else def.ids.push(p);
      }
      classes.set(name, def);
      return;
    }

    throw parseError(`unrecognised line: "${line}"`, ln);
  });

  if (!nodes.size) throw parseError('no rows/nodes defined');

  const known = () => [...nodes.keys()].join(', ');
  for (const [name, def] of classes) {
    for (const id of def.ids) {
      const n = nodes.get(id);
      if (!n) throw parseError(`class ${name}: unknown node "${id}" (known: ${known()})`, def.line);
      n.cls = name;
    }
  }
  for (const e of edges) {
    for (const id of [e.from, e.to]) {
      if (!nodes.has(id)) throw parseError(`edge references unknown node "${id}" (known: ${known()})`, e.line);
    }
    // resolve linkclass names into the edge's own attrs (explicit keys win)
    for (const name of e.attrs.names) {
      const lc = linkClasses.get(name);
      if (!lc) throw parseError(`unknown linkclass "${name}"`, e.line);
      for (const [k, v] of Object.entries(lc)) if (k !== 'names' && e.attrs[k] === undefined) e.attrs[k] = v;
    }
    if (e.attrs.via && !['left', 'right'].includes(e.attrs.via)) throw parseError(`via must be left or right`, e.line);
  }
  for (const nt of meta.notes) {
    if (!nodes.has(nt.id)) throw parseError(`note: unknown node "${nt.id}"`, nt.line);
  }
  for (const v of meta.variants) {
    if (!nodes.has(v.id)) throw parseError(`variants: unknown node "${v.id}"`, v.line);
    nodes.get(v.id).variants = v.names;
  }
  for (const id of meta.stacks) {
    if (!nodes.has(id)) throw parseError(`stack: unknown node "${id}"`);
    nodes.get(id).stack = true;
  }
  for (const k of meta.key) {
    k.style = linkClasses.get(k.lc);
    if (!k.style) throw parseError(`key: unknown linkclass "${k.lc}"`, k.line);
  }
  for (const sh of shifts) {
    const n = nodes.get(sh.id);
    if (!n) throw parseError(`shift: unknown node "${sh.id}" (known: ${known()})`, sh.line);
    n.dx = sh.dx; n.dy = sh.dy;
  }
  return { nodes, grid, edges, classes, meta };
}

// ---------------------------------------------------------------------------
// Layout — uniform boxes on a fixed grid
// ---------------------------------------------------------------------------

function bestTwoLineSplit(label) {
  const words = label.split(' ');
  if (words.length === 1) return [label];
  let best = null;
  let bestLen = Infinity;
  for (let k = 1; k < words.length; k++) {
    const a = words.slice(0, k).join(' ');
    const b = words.slice(k).join(' ');
    const len = Math.max(a.length, b.length);
    if (len < bestLen) { bestLen = len; best = [a, b]; }
  }
  return best;
}

function neededWidth(label) {
  const oneLine = label.length * CHAR_W + PAD_X * 2;
  if (oneLine <= BOX_W_MIN) return BOX_W_MIN;
  const split = bestTwoLineSplit(label);
  const longest = Math.max(...split.map(s => s.length));
  return longest * CHAR_W + PAD_X * 2;
}

function wrapLabel(label, boxW) {
  if (label.length * CHAR_W + PAD_X * 2 <= boxW) return [label];
  return bestTwoLineSplit(label);
}

const variantDx = () => Math.round(VARIANT_DX * FONT_SIZE / 14);
const variantDy = () => Math.round(VARIANT_DY * FONT_SIZE / 14);

// Full footprint of a node, including any variant cards behind it.
function nodeExtent(n) {
  const nv = (n.variants || []).length;
  return { x0: n.x, y0: n.y, x1: n.x + n.w + nv * variantDx(), y1: n.y + n.h + nv * variantDy() };
}

// Line patterns: `-.->` gives dash; {dash=dashdot} a dash-dot (data flows).
const DASHES = { dash: '6 4', dashdot: '9 4 2 4' };
const dashAttr = d => (d ? ` stroke-dasharray="${DASHES[d] || DASHES.dash}"` : '');

function darken(hex, f) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const v = parseInt(m[1], 16);
  const c = sh => Math.round(((v >> sh) & 255) * (1 - f)).toString(16).padStart(2, '0');
  return '#' + c(16) + c(8) + c(0);
}

function luminance(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 1;
  const v = parseInt(m[1], 16);
  return (0.299 * ((v >> 16) & 255) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255)) / 255;
}

function wrapGreedy(text, boxW) {
  const maxChars = Math.max(4, Math.floor((boxW - PAD_X) / CHAR_W));
  const out = [];
  let cur = '';
  for (const w of text.split(' ')) {
    if (cur && (cur + ' ' + w).length > maxChars) { out.push(cur); cur = w; }
    else cur = cur ? cur + ' ' + w : w;
  }
  if (cur) out.push(cur);
  return out;
}

function layout(model) {
  const fixedW = model.meta.box;
  // variant back cards spill into the gaps: widen them by the deepest stack
  const maxVariants = Math.max(0, ...[...model.nodes.values()].map(n => (n.variants || []).length));
  const COL_GAP = (model.meta.gap ? model.meta.gap[0] : COL_GAP_DEFAULT) + maxVariants * variantDx();
  const ROW_GAP = (model.meta.gap ? model.meta.gap[1] : ROW_GAP_DEFAULT) + maxVariants * variantDy();
  let boxW = fixedW || BOX_W_MIN;
  if (!fixedW) {
    for (const n of model.nodes.values()) {
      boxW = Math.max(boxW, Math.min(BOX_W_MAX, neededWidth(n.label)));
      if (n.sub) boxW = Math.max(boxW, Math.min(BOX_W_MAX, neededWidth(n.sub)));
    }
  }
  const wrap = fixedW ? wrapGreedy : wrapLabel;
  let maxLines = 1;
  for (const n of model.nodes.values()) {
    n.lines = wrap(n.label, boxW);
    n.subLines = n.sub ? wrap(n.sub, boxW) : [];
    maxLines = Math.max(maxLines, n.lines.length + n.subLines.length);
  }
  const boxH = Math.max(BOX_H, maxLines * LINE_H + PAD_Y * 2);

  let nCols = 0;
  for (const n of model.nodes.values()) nCols = Math.max(nCols, n.col + 1);
  const nRows = model.grid.length;

  // outer channels for via=left/right edges sit outside the grid
  const vias = model.edges.map(e => e.attrs.via);
  const padL = vias.includes('left') ? OUTER_GAP : 0;
  const padR = vias.includes('right') ? OUTER_GAP : 0;
  const keyRows = model.meta.key.length > 3 ? 2 : (model.meta.key.length ? 1 : 0);
  const legendH = Math.max(model.meta.legend.length ? 24 + model.meta.legend.length * 16 + 10 : 0, keyRows ? keyRows * Math.round(70 * (model.meta.font || 14) / 14) + 14 : 0);
  const top = MARGIN + Math.max(model.meta.title ? TITLE_H : 0, legendH);
  const left = MARGIN + padL;
  const colStep = boxW + COL_GAP;
  const rowStep = boxH + ROW_GAP;

  let maxX = 0, maxY = 0;
  for (const n of model.nodes.values()) {
    n.gc = n.col + n.dx;
    n.gr = n.row + n.dy;
    n.x = left + (n.col + n.dx) * colStep;
    n.y = top + (n.row + n.dy) * rowStep;
    n.w = boxW;
    n.h = boxH;
    n.cx = n.x + boxW / 2;
    n.cy = n.y + boxH / 2;
    const nv = (n.variants || []).length;
    maxX = Math.max(maxX, n.x + boxW + nv * variantDx());
    maxY = Math.max(maxY, n.y + boxH + nv * variantDy());
  }
  const gridRight = left + nCols * colStep - COL_GAP;
  const bg = model.meta.background;
  const dark = bg ? luminance(bg[0]) < 0.4 : false;
  return {
    dark,
    edgeColor: dark ? '#e9ebed' : DEFAULT_STROKE,
    labelColor: dark ? '#ffffff' : TEXT_COLOR,
    boxW,
    boxH,
    nCols,
    nRows,
    width: Math.max(maxX, gridRight) + padR + MARGIN,
    height: maxY + MARGIN,
    // center x of the gutter to the RIGHT of column c (c may be -1 for left margin)
    gutterX: c => left + (c + 1) * colStep - COL_GAP / 2,
    // center y of the gutter BELOW row r
    gutterY: r => top + (r + 1) * rowStep - ROW_GAP / 2,
    // outer channel lanes
    outerX: side => side === 'left' ? left - OUTER_GAP / 2 - 8 : Math.max(maxX, gridRight) + OUTER_GAP / 2 + 8,
  };
}

// ---------------------------------------------------------------------------
// Routing — auto 3-tier: straight -> L(v-first) -> L(h-first) -> Z(gutter lane)
// ---------------------------------------------------------------------------

function sidePoint(n, side, off) {
  off = off || 0;
  switch (side) {
    case 'top': return { x: n.cx + off, y: n.y };
    case 'bottom': return { x: n.cx + off, y: n.y + n.h };
    case 'left': return { x: n.x, y: n.cy + off };
    case 'right': return { x: n.x + n.w, y: n.cy + off };
  }
}

function toSegs(points) {
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    if (Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01) continue;
    if (Math.abs(a.x - b.x) < 0.01) out.push({ o: 'v', x: a.x, y1: a.y, y2: b.y });
    else out.push({ o: 'h', y: a.y, x1: a.x, x2: b.x });
  }
  return out;
}

function passesThroughNode(seg, n) {
  const eps = 0.5;
  if (seg.o === 'v') {
    if (seg.x <= n.x + eps || seg.x >= n.x + n.w - eps) return false;
    const y1 = Math.min(seg.y1, seg.y2), y2 = Math.max(seg.y1, seg.y2);
    return y2 > n.y + eps && y1 < n.y + n.h - eps;
  }
  if (seg.y <= n.y + eps || seg.y >= n.y + n.h - eps) return false;
  const x1 = Math.min(seg.x1, seg.x2), x2 = Math.max(seg.x1, seg.x2);
  return x2 > n.x + eps && x1 < n.x + n.w - eps;
}

// Collinear overlap; end-to-end touching (gap <= 2px) counts too, so a corner
// landing exactly on another edge's segment falls through to the next lane.
function segsOverlap(a, b) {
  if (a.o !== b.o) return false;
  if (a.o === 'v') {
    if (Math.abs(a.x - b.x) > 0.5) return false;
    const a1 = Math.min(a.y1, a.y2), a2 = Math.max(a.y1, a.y2);
    const b1 = Math.min(b.y1, b.y2), b2 = Math.max(b.y1, b.y2);
    return Math.min(a2, b2) - Math.max(a1, b1) > -2;
  }
  if (Math.abs(a.y - b.y) > 0.5) return false;
  const a1 = Math.min(a.x1, a.x2), a2 = Math.max(a.x1, a.x2);
  const b1 = Math.min(b.x1, b.x2), b2 = Math.max(b.x1, b.x2);
  return Math.min(a2, b2) - Math.max(a1, b1) > -2;
}

function route(model, geom, warnings) {
  const nodes = model.nodes;
  const placed = []; // {edge, points, enterSide, exitSide, style, trunkKey}
  const ports = new Map(); // "nodeId|side" -> [{off, style, dir}]

  const styleOf = e => {
    const src = nodes.get(e.from);
    const cls = src.cls ? model.classes.get(src.cls) : null;
    const color = e.attrs.stroke || (cls ? cls.stroke : geom.edgeColor);
    const dashed = e.attrs.dash && e.attrs.dash !== 'none' ? e.attrs.dash : (e.dashed ? 'dash' : false);
    return { color, dashed };
  };
  const styleKey = st => `${st.color}|${st.dashed}`;

  // Tentative port allocation. dir: 'in' | 'out'. Incoming edges with identical
  // style share the center attachment (trunk); everything else spreads ±14px.
  // pref biases spreading toward the target's side (+1 = positive offsets first).
  function allocPort(nodeId, side, st, dir, pref) {
    const key = nodeId + '|' + side;
    const list = ports.get(key) || [];
    // same-style edges share the center attachment on both directions:
    // incoming groups merge into a target trunk, outgoing groups fan out from
    // one stem (bus) instead of spreading offset ports.
    const mate = list.find(p => p.dir === dir && p.styleKey === styleKey(st));
    if (mate) return { off: mate.off, shared: true, key };
    const used = new Set(list.map(p => p.off));
    const seq = pref > 0
      ? [0, PORT_STEP, 2 * PORT_STEP, -PORT_STEP, -2 * PORT_STEP]
      : pref < 0
        ? [0, -PORT_STEP, -2 * PORT_STEP, PORT_STEP, 2 * PORT_STEP]
        : [0, PORT_STEP, -PORT_STEP, 2 * PORT_STEP, -2 * PORT_STEP];
    const off = seq.find(o => !used.has(o));
    return { off: off !== undefined ? off : 0, shared: false, key };
  }
  function commitPort(alloc, st, dir) {
    if (alloc.shared) return;
    const list = ports.get(alloc.key) || [];
    list.push({ off: alloc.off, styleKey: styleKey(st), dir });
    ports.set(alloc.key, list);
  }

  // Ports for a straight line: both ends need the same offset. Each end picks
  // its own first free spot, which can differ (e.g. the source's centre is
  // taken by an incoming line of another style); then look for an offset free
  // on both ends, so the line runs straight beside the other one instead of
  // detouring around the box. Shared (same-style) ports stay fixed.
  function matchPorts(s, exitSide, t, enterSide, st) {
    const po = allocPort(s.id, exitSide, st, 'out');
    const pi = allocPort(t.id, enterSide, st, 'in');
    if (po.off === pi.off) return [po, pi];
    const freeAt = (id, side, off) => !(ports.get(id + '|' + side) || []).some(p => p.off === off);
    for (const o of [po.off, pi.off, 0, PORT_STEP, -PORT_STEP, 2 * PORT_STEP, -2 * PORT_STEP]) {
      const okS = po.shared ? o === po.off : (o === po.off || freeAt(s.id, exitSide, o));
      const okT = pi.shared ? o === pi.off : (o === pi.off || freeAt(t.id, enterSide, o));
      if (okS && okT) return [{ ...po, off: o }, { ...pi, off: o }];
    }
    return null;
  }

  // Candidate check: node collisions + collinear overlap with placed edges.
  // Final-approach overlap between same (target, side, style) edges is the trunk
  // merge and is allowed.
  function candidateOk(points, s, t, st, enterSide, exitSide) {
    const segs = toSegs(points);
    for (const seg of segs) {
      for (const n of nodes.values()) {
        if (n === s || n === t) continue;
        if (passesThroughNode(seg, n)) return false;
      }
    }
    const trunkKey = `${t.id}|${enterSide}|${styleKey(st)}`;
    const srcTrunkKey = `${s.id}|${exitSide}|${styleKey(st)}`;
    for (let i = 0; i < segs.length; i++) {
      for (const p of placed) {
        if (p.srcTrunkKey === srcTrunkKey) continue; // outgoing bus: overlap IS the trunk
        const pSegs = toSegs(p.points);
        for (let j = 0; j < pSegs.length; j++) {
          if (!segsOverlap(segs[i], pSegs[j])) continue;
          const bothFinal = i === segs.length - 1 && j === pSegs.length - 1;
          if (bothFinal && p.trunkKey === trunkKey) continue; // incoming trunk merge
          if (p.trunkKey === trunkKey && i > 0 && j > 0) continue; // shared approach lane
          return false;
        }
      }
    }
    return true;
  }

  function accept(edge, points, exitInfo, enterInfo, st, exitSide, enterSide, t) {
    commitPort(exitInfo, st, 'out');
    commitPort(enterInfo, st, 'in');
    placed.push({
      edge, points, exitSide, enterSide, style: st,
      trunkKey: `${t.id}|${enterSide}|${styleKey(st)}`,
      srcTrunkKey: `${edge.from}|${exitSide}|${styleKey(st)}`,
    });
  }

  for (const edge of model.edges) {
    const s = nodes.get(edge.from);
    const t = nodes.get(edge.to);
    const st = styleOf(edge);
    let done = false;

    // --- outer channel (via=left|right): run outside the grid ---
    // H-V-H straight out of the facing side, else V-H-V-H via the gutter
    // next to the source row.
    if (edge.attrs.via) {
      const side = edge.attrs.via;
      const base = geom.outerX(side);
      const step = side === 'left' ? -LANE_STEP : LANE_STEP;
      outerLoop:
      for (let k = 0; k < 4; k++) {
        const laneX = base + k * step;
        const pi = allocPort(t.id, side, st, 'in');
        const p2 = sidePoint(t, side, pi.off);
        const cands = [];
        {
          const po = allocPort(s.id, side, st, 'out');
          const p1 = sidePoint(s, side, po.off);
          cands.push({ po, exitSide: side, pts: [p1, { x: laneX, y: p1.y }, { x: laneX, y: p2.y }, p2] });
        }
        {
          const down = t.cy > s.cy;
          const exitSide = down ? 'bottom' : 'top';
          const po = allocPort(s.id, exitSide, st, 'out', side === 'left' ? -1 : 1);
          const p1 = sidePoint(s, exitSide, po.off);
          const laneY = (down ? geom.gutterY(s.gr) : geom.gutterY(s.gr - 1)) + k * LANE_STEP;
          cands.push({ po, exitSide, pts: [p1, { x: p1.x, y: laneY }, { x: laneX, y: laneY }, { x: laneX, y: p2.y }, p2] });
        }
        if (edge.attrs.exit && edge.attrs.exit !== side) cands.reverse();
        for (const c of cands) {
          if (candidateOk(c.pts, s, t, st, side, c.exitSide)) {
            accept(edge, c.pts, c.po, pi, st, c.exitSide, side, t);
            done = true;
            break outerLoop;
          }
        }
      }
    }

    // --- side hints: exit=left|right enter=left|right -> H-V-H via source gutter ---
    const hx = edge.attrs.exit, hn = edge.attrs.enter;
    if (!done && !edge.attrs.via && (hx === 'left' || hx === 'right') && (hn === 'left' || hn === 'right')) {
      const laneBase = geom.gutterX(hx === 'right' ? s.gc : s.gc - 1);
      for (const laneOff of [0, LANE_STEP, -LANE_STEP, 2 * LANE_STEP, -2 * LANE_STEP]) {
        const laneX = laneBase + laneOff;
        const po = allocPort(s.id, hx, st, 'out');
        const pi = allocPort(t.id, hn, st, 'in');
        const p1 = sidePoint(s, hx, po.off);
        const p2 = sidePoint(t, hn, pi.off);
        const pts = [p1, { x: laneX, y: p1.y }, { x: laneX, y: p2.y }, p2];
        if (candidateOk(pts, s, t, st, hn, hx)) {
          accept(edge, pts, po, pi, st, hx, hn, t);
          done = true;
          break;
        }
      }
    }

    // --- straight ---
    if (!done && s.gr === t.gr && s.gc !== t.gc) {
      const exitSide = t.cx > s.cx ? 'right' : 'left';
      const enterSide = t.cx > s.cx ? 'left' : 'right';
      const pair = matchPorts(s, exitSide, t, enterSide, st);
      if (pair) {
        const [po, pi] = pair;
        const pts = [sidePoint(s, exitSide, po.off), sidePoint(t, enterSide, pi.off)];
        if (candidateOk(pts, s, t, st, enterSide, exitSide)) {
          accept(edge, pts, po, pi, st, exitSide, enterSide, t);
          done = true;
        }
      }
    }
    // same row with something in between: U under (then over) the row
    if (!done && s.gr === t.gr && Math.abs(s.gc - t.gc) > 1) {
      for (const below of [true, false]) {
        const side = below ? 'bottom' : 'top';
        const baseY = below ? geom.gutterY(s.gr) : geom.gutterY(s.gr - 1);
        for (const laneOff of [0, LANE_STEP, -LANE_STEP, 2 * LANE_STEP]) {
          const laneY = baseY + laneOff;
          const po = allocPort(s.id, side, st, 'out', Math.sign(t.cx - s.cx));
          const pi = allocPort(t.id, side, st, 'in', Math.sign(s.cx - t.cx));
          const p1 = sidePoint(s, side, po.off);
          const p2 = sidePoint(t, side, pi.off);
          const pts = [p1, { x: p1.x, y: laneY }, { x: p2.x, y: laneY }, p2];
          if (candidateOk(pts, s, t, st, side, side)) {
            accept(edge, pts, po, pi, st, side, side, t);
            done = true;
            break;
          }
        }
        if (done) break;
      }
    }
    if (!done && s.gc === t.gc && s.gr !== t.gr) {
      const exitSide = t.cy > s.cy ? 'bottom' : 'top';
      const enterSide = t.cy > s.cy ? 'top' : 'bottom';
      const pair = matchPorts(s, exitSide, t, enterSide, st);
      if (pair) {
        const [po, pi] = pair;
        const pts = [sidePoint(s, exitSide, po.off), sidePoint(t, enterSide, pi.off)];
        if (candidateOk(pts, s, t, st, enterSide, exitSide)) {
          accept(edge, pts, po, pi, st, exitSide, enterSide, t);
          done = true;
        }
      }
    }

    // --- Z vertical-first through a row-gutter lane (V-H-V): exit top/bottom,
    // horizontal run in the gutter adjacent to the target row, enter top/bottom.
    // For downward edges this is tried BEFORE L horizontal-first, so fan-outs to
    // children originate from the source's bottom.
    const tryZvhv = () => {
      if (s.gc === t.gc || s.gr === t.gr) return false;
      const down = t.cy > s.cy;
      const exitSide = down ? 'bottom' : 'top';
      const baseY = down ? geom.gutterY(t.gr - 1) : geom.gutterY(t.gr);
      for (const laneOff of [0, LANE_STEP, -LANE_STEP, 2 * LANE_STEP, -2 * LANE_STEP, 3 * LANE_STEP]) {
        const laneY = baseY + laneOff;
        const enterSide = laneY < t.cy ? 'top' : 'bottom';
        const po = allocPort(s.id, exitSide, st, 'out', Math.sign(t.cx - s.cx));
        const pi = allocPort(t.id, enterSide, st, 'in');
        const p1 = sidePoint(s, exitSide, po.off);
        const p2 = sidePoint(t, enterSide, pi.off);
        const pts = [p1, { x: p1.x, y: laneY }, { x: p2.x, y: laneY }, p2];
        if (candidateOk(pts, s, t, st, enterSide, exitSide)) {
          accept(edge, pts, po, pi, st, exitSide, enterSide, t);
          return true;
        }
      }
      return false;
    };
    // Near neighbours (less than one column apart, i.e. a shifted node) read
    // better as a bus into the target's top than as an L into its side.
    if (!done && t.gr > s.gr && Math.abs(s.gc - t.gc) < 1) done = tryZvhv();

    // --- L vertical-first: exit top/bottom, corner at (s.cx, t.cy), enter left/right ---
    if (!done && s.gc !== t.gc && s.gr !== t.gr) {
      const exitSide = t.cy > s.cy ? 'bottom' : 'top';
      const enterSide = t.cx > s.cx ? 'left' : 'right';
      const po = allocPort(s.id, exitSide, st, 'out', Math.sign(t.cx - s.cx));
      const pi = allocPort(t.id, enterSide, st, 'in');
      const p1 = sidePoint(s, exitSide, po.off);
      const p2 = sidePoint(t, enterSide, pi.off);
      const pts = [p1, { x: p1.x, y: p2.y }, p2];
      if (candidateOk(pts, s, t, st, enterSide, exitSide)) {
        accept(edge, pts, po, pi, st, exitSide, enterSide, t);
        done = true;
      }
    }

    if (!done && t.gr > s.gr) done = tryZvhv();

    // --- L horizontal-first: exit left/right, corner at (t.cx, s.cy), enter top/bottom ---
    if (!done && s.gc !== t.gc && s.gr !== t.gr) {
      const exitSide = t.cx > s.cx ? 'right' : 'left';
      const enterSide = t.cy > s.cy ? 'top' : 'bottom';
      const po = allocPort(s.id, exitSide, st, 'out', Math.sign(t.cy - s.cy));
      const pi = allocPort(t.id, enterSide, st, 'in');
      const p1 = sidePoint(s, exitSide, po.off);
      const p2 = sidePoint(t, enterSide, pi.off);
      const pts = [p1, { x: p2.x, y: p1.y }, p2];
      if (candidateOk(pts, s, t, st, enterSide, exitSide)) {
        accept(edge, pts, po, pi, st, exitSide, enterSide, t);
        done = true;
      }
    }
    if (!done && t.gr < s.gr) done = tryZvhv();

    // --- Z through a gutter lane ---
    if (!done) {
      const zCandidates = [];
      if (s.gc !== t.gc) {
        // H-V-H: lane in the gutter adjacent to the source, toward the target
        const dir = t.cx > s.cx ? 1 : -1;
        const exitSide = dir > 0 ? 'right' : 'left';
        const laneBase = geom.gutterX(dir > 0 ? s.gc : s.gc - 1);
        zCandidates.push({ exitSide, laneBase });
      } else {
        // same column: lane beside the column, right gutter then left
        zCandidates.push({ exitSide: 'right', laneBase: geom.gutterX(s.gc) });
        zCandidates.push({ exitSide: 'left', laneBase: geom.gutterX(s.gc - 1) });
      }
      outer:
      for (const zc of zCandidates) {
        for (const laneOff of [0, LANE_STEP, -LANE_STEP, 2 * LANE_STEP, -2 * LANE_STEP, 3 * LANE_STEP]) {
          const laneX = zc.laneBase + laneOff;
          const enterSide = laneX < t.cx ? 'left' : 'right';
          const po = allocPort(s.id, zc.exitSide, st, 'out', Math.sign(t.cy - s.cy));
          const pi = allocPort(t.id, enterSide, st, 'in');
          const p1 = sidePoint(s, zc.exitSide, po.off);
          const p2 = sidePoint(t, enterSide, pi.off);
          const pts = [p1, { x: laneX, y: p1.y }, { x: laneX, y: p2.y }, p2];
          if (candidateOk(pts, s, t, st, enterSide, zc.exitSide)) {
            accept(edge, pts, po, pi, st, zc.exitSide, enterSide, t);
            done = true;
            break outer;
          }
        }
      }
    }

    // --- last resort: draw the base Z anyway, warn, never fail ---
    if (!done) {
      const dir = t.cx >= s.cx ? 1 : -1;
      const exitSide = s.gc === t.gc ? 'right' : (dir > 0 ? 'right' : 'left');
      const laneX = s.gc === t.gc ? geom.gutterX(s.gc) : geom.gutterX(dir > 0 ? s.gc : s.gc - 1);
      const enterSide = laneX < t.cx ? 'left' : 'right';
      const po = allocPort(s.id, exitSide, st, 'out');
      const pi = allocPort(t.id, enterSide, st, 'in');
      const p1 = sidePoint(s, exitSide, po.off);
      const p2 = sidePoint(t, enterSide, pi.off);
      const pts = [p1, { x: laneX, y: p1.y }, { x: laneX, y: p2.y }, p2];
      warnings.push(`edge ${edge.from} -> ${edge.to}: no clean route found; drew best-effort Z`);
      accept(edge, pts, po, pi, st, exitSide, enterSide, t);
    }
  }

  return placed;
}

// ---------------------------------------------------------------------------
// Trunk merging (shared bus into one target side, same style) + dots
// ---------------------------------------------------------------------------

function buildDrawing(model, placed) {
  const nodes = model.nodes;
  const paths = []; // {points, style, arrow:boolean, edgeRef}
  const dots = []; // {x, y, color}

  const groups = new Map();
  for (const p of placed) {
    const arr = groups.get(p.trunkKey) || [];
    arr.push(p);
    groups.set(p.trunkKey, arr);
  }

  for (const [key, members] of groups) {
    if (members.length === 1) {
      const e = members[0].edge;
      paths.push({ points: members[0].points, style: members[0].style, arrow: e.arrowEnd, arrowStart: e.arrowStart });
      continue;
    }
    const [targetId, side] = key.split('|');
    const t = nodes.get(targetId);
    const border = members[0].points[members[0].points.length - 1]; // same for all (shared port)
    const vertical = side === 'top' || side === 'bottom';
    // joint = last corner of each member (point before the border point)
    const joints = members.map(m => m.points[m.points.length - 2]);
    // farthest joint from the border along the approach axis
    const dist = j => vertical ? Math.abs(j.y - border.y) : Math.abs(j.x - border.x);
    let far = joints[0];
    for (const j of joints) if (dist(j) > dist(far)) far = j;
    // trunk path: far joint -> border, single arrowhead
    paths.push({ points: [far, border], style: members[0].style, arrow: members.some(m => m.edge.arrowEnd) });
    // member paths end at their joint; interior joints get dots
    members.forEach((m, i) => {
      const pts = m.points.slice(0, -1);
      if (pts.length >= 2) paths.push({ points: pts, style: m.style, arrow: false, arrowStart: m.edge.arrowStart });
      const j = joints[i];
      if (dist(j) > 0.5 && dist(j) < dist(far) - 0.5) {
        dots.push({ x: j.x, y: j.y, color: m.style.color });
      }
    });
  }
  // Outgoing bus groups: same-style edges leaving one node side share the
  // center port, so their common prefixes overdraw as a single trunk line.
  // Here we only add the junction dots where branches peel off the trunk.
  const outGroups = new Map();
  for (const p of placed) {
    const arr = outGroups.get(p.srcTrunkKey) || [];
    arr.push(p);
    outGroups.set(p.srcTrunkKey, arr);
  }
  const dotSeen = new Set(dots.map(d => `${Math.round(d.x)},${Math.round(d.y)}`));
  for (const members of outGroups.values()) {
    if (members.length < 2) continue;
    const drawn = new Map(); // 'v|x' / 'h|y' -> [[min,max], ...]
    const lineKey = seg => seg.o === 'v' ? `v|${seg.x.toFixed(1)}` : `h|${seg.y.toFixed(1)}`;
    members.forEach((m, mi) => {
      const segs = toSegs(m.points);
      if (mi > 0) {
        for (let i = 0; i < segs.length; i++) {
          const seg = segs[i];
          const from = seg.o === 'v' ? seg.y1 : seg.x1;
          const to = seg.o === 'v' ? seg.y2 : seg.x2;
          const dir = to >= from ? 1 : -1;
          let reach = from;
          const ivs = drawn.get(lineKey(seg)) || [];
          let moved = true;
          while (moved) {
            moved = false;
            for (const [a, b] of ivs) {
              if (reach >= a - 0.5 && reach <= b + 0.5) {
                const far = dir > 0 ? b : a;
                if (far * dir > reach * dir + 0.5) { reach = far; moved = true; }
              }
            }
          }
          if (reach * dir >= to * dir - 0.5) continue; // segment fully on the trunk
          const diverged = !(i === 0 && Math.abs(reach - from) < 0.5);
          if (diverged) {
            const pt = seg.o === 'v' ? { x: seg.x, y: reach } : { x: reach, y: seg.y };
            const k = `${Math.round(pt.x)},${Math.round(pt.y)}`;
            if (!dotSeen.has(k)) {
              dotSeen.add(k);
              dots.push({ x: pt.x, y: pt.y, color: m.style.color });
            }
          }
          break;
        }
      }
      for (const seg of segs) {
        const iv = seg.o === 'v'
          ? [Math.min(seg.y1, seg.y2), Math.max(seg.y1, seg.y2)]
          : [Math.min(seg.x1, seg.x2), Math.max(seg.x1, seg.x2)];
        const list = drawn.get(lineKey(seg)) || [];
        list.push(iv);
        drawn.set(lineKey(seg), list);
      }
    });
  }

  // Edge labels: one per edge, except edges merged into the same trunk or
  // bus with the same label share a single label. Each label is then placed
  // by scoring candidate spots along its own line (see placeLabels).
  const requests = [];
  const labelSeen = new Set();
  for (const p of placed) {
    const text = p.edge.label;
    if (!text) continue;
    const inGroup = groups.get(p.trunkKey);
    let segs = toSegs(p.points);
    if (inGroup && inGroup.length > 1 && inGroup.every(m => m.edge.label === text)) {
      const k = 'in|' + p.trunkKey + '|' + text;
      if (labelSeen.has(k)) continue;
      labelSeen.add(k);
      // shared label: any segment of any member (the trunk is part of each)
      segs = inGroup.flatMap(m => toSegs(m.points));
    }
    requests.push({ text, segs, via: p.edge.attrs.via || null, members: inGroup && inGroup.length > 1 ? inGroup : [p] });
  }
  const labels = placeLabels(requests, model, paths);

  return { paths, dots, labels };
}

// ---------------------------------------------------------------------------
// Label placement: score candidate spots, pick the cheapest, greedily
// ---------------------------------------------------------------------------

const LABEL_GAP = 4; // distance between a line and its label

function rectsOverlap(a, b, m = 0) {
  return a.x0 < b.x1 - m && a.x1 > b.x0 + m && a.y0 < b.y1 - m && a.y1 > b.y0 + m;
}
function overlapArea(a, b) {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return w > 0 && h > 0 ? w * h : 0;
}
function segHitsRect(sg, r) {
  if (sg.o === 'h') {
    const lo = Math.min(sg.x1, sg.x2), hi = Math.max(sg.x1, sg.x2);
    return sg.y > r.y0 && sg.y < r.y1 && hi > r.x0 && lo < r.x1;
  }
  const lo = Math.min(sg.y1, sg.y2), hi = Math.max(sg.y1, sg.y2);
  return sg.x > r.x0 && sg.x < r.x1 && hi > r.y0 && lo < r.y1;
}

function labelCandidates(req, size, lines) {
  const k = size / LABEL_SIZE;
  const w = Math.max(...lines.map(t => t.length)) * LABEL_CHAR_W * k;
  const h = size + (lines.length - 1) * size * 1.15;
  const wrapped = lines.length > 1 ? { lines } : {};
  const out = [];
  const len = sg => (sg.o === 'h' ? Math.abs(sg.x2 - sg.x1) : Math.abs(sg.y2 - sg.y1));
  const segs = [...req.segs].sort((a, b) => len(b) - len(a));
  segs.forEach((sg, si) => {
    const L = len(sg);
    if (L < 8) return;
    for (const [fi, f] of [0.5, 0.3, 0.7, 0.15, 0.85].entries()) {
      const rank = si * 4 + fi;
      if (sg.o === 'h') {
        const x = Math.min(sg.x1, sg.x2) + L * f;
        for (const [side, y] of [['above', sg.y - LABEL_GAP - (h - size)], ['below', sg.y + LABEL_GAP + size * 0.8]]) {
          const overhang = Math.max(0, w - L) / 2;
          out.push({ text: req.text, ...wrapped, x, y, anchor: 'middle', rotate: false, size, rank: rank + (side === 'below' ? 1 : 0), overhang });
        }
      } else {
        const y = Math.min(sg.y1, sg.y2) + L * f + size * 0.3 - (h - size) / 2;
        out.push({ text: req.text, ...wrapped, x: sg.x + LABEL_GAP + 1, y, anchor: 'start', rotate: false, size, rank, overhang: 0 });
        out.push({ text: req.text, ...wrapped, x: sg.x - LABEL_GAP - 1, y, anchor: 'end', rotate: false, size, rank: rank + 1, overhang: 0 });
        // long vertical runs (outer channels) can carry the label along the line
        if (lines.length === 1 && L > w + 20) {
          const yc = Math.min(sg.y1, sg.y2) + L * f;
          const xr = req.via === 'right' ? sg.x - LABEL_GAP - 1 : sg.x + LABEL_GAP + size * 0.8;
          out.push({ text: req.text, x: xr, y: yc, anchor: 'middle', rotate: true, size, rank: rank + (req.via ? 0 : 3), overhang: 0 });
        }
      }
    }
  });
  return out;
}

// Split a long label into n lines, balancing line lengths; null if too few words.
function splitLabel(text, n) {
  const words = text.split(' ');
  if (words.length < n) return null;
  let best = null;
  const walk = (start, left, acc) => {
    if (left === 1) {
      const lines = [...acc, words.slice(start).join(' ')];
      const worst = Math.max(...lines.map(l => l.length));
      if (!best || worst < best.worst) best = { lines, worst };
      return;
    }
    for (let i = start + 1; i <= words.length - left + 1; i++) walk(i, left - 1, [...acc, words.slice(start, i).join(' ')]);
  };
  walk(0, n, []);
  return best.lines;
}

function placeLabels(requests, model, paths) {
  const nodes = [...model.nodes.values()].map(nodeExtent);
  const allSegs = paths.flatMap(p => toSegs(p.points));
  // keep labels off arrowheads: a small box around every arrow tip
  const tips = [];
  for (const p of paths) {
    const ends = [];
    if (p.arrow) ends.push(p.points[p.points.length - 1]);
    if (p.arrowStart) ends.push(p.points[0]);
    for (const e of ends) tips.push({ x0: e.x - 9, y0: e.y - 7, x1: e.x + 9, y1: e.y + 7 });
  }
  const placedLabels = [];
  const cost = (c, req) => {
    const r = labelRect(c);
    let score = c.rank * 2 + c.overhang * 3;
    if (c.size < LABEL_SIZE) score += 40;
    if (r.x0 < 2 || r.y0 < 2) score += 2000;
    for (const n of nodes) { const a = overlapArea(r, n); if (a > 0) score += 1000 + a; }
    for (const o of placedLabels) { const a = overlapArea(r, o); if (a > 0) score += 1000 + a; }
    for (const t of tips) if (rectsOverlap(r, t)) score += 120;
    // lines through the text: other edges' lines cost more than its own
    for (const sg of allSegs) {
      if (!segHitsRect(sg, r)) continue;
      score += req.segs.some(t => t.o === sg.o && (t.o === 'h' ? t.y === sg.y : t.x === sg.x)) ? 30 : 150;
    }
    return score;
  };
  // tightest first: requests whose longest segment is shortest
  const longest = req => Math.max(...req.segs.map(sg => (sg.o === 'h' ? Math.abs(sg.x2 - sg.x1) : Math.abs(sg.y2 - sg.y1))));
  const order = [...requests].sort((a, b) => longest(a) - longest(b));
  const result = new Map();
  for (const req of order) {
    let best = null;
    const small = Math.round(LABEL_SIZE * 0.85 * 10) / 10;
    const two = splitLabel(req.text, 2);
    const three = splitLabel(req.text, 3);
    const tries = [[LABEL_SIZE, [req.text]]];
    if (two) tries.push([LABEL_SIZE, two]);
    tries.push([small, [req.text]]);
    if (two) tries.push([small, two]);
    if (three) tries.push([small, three]);
    for (const [size, lines] of tries) {
      for (const c of labelCandidates(req, size, lines)) {
        const sc = cost(c, req) + (lines.length > 1 ? 25 : 0);
        if (!best || sc < best.sc) best = { c, sc };
      }
      if (best && best.sc < 1000) break; // first variant without collisions wins
    }
    if (!best) continue;
    placedLabels.push(labelRect(best.c));
    result.set(req, best.c);
  }
  return requests.filter(r => result.has(r)).map(r => result.get(r));
}

// ---------------------------------------------------------------------------
// SVG rendering with hop bridges
// ---------------------------------------------------------------------------

// Approximate bounding box of an edge label as drawn.
function labelRect(l) {
  const size = l.size || LABEL_SIZE;
  const lines = l.lines || [l.text];
  const w = Math.max(...lines.map(t => t.length)) * LABEL_CHAR_W * (size / LABEL_SIZE);
  const h = size + (lines.length - 1) * size * 1.15;
  if (l.rotate) return { text: l.text, x0: l.x - h * 0.8, y0: l.y - w / 2, x1: l.x + h * 0.2, y1: l.y + w / 2 };
  const x0 = l.anchor === 'start' ? l.x : l.anchor === 'end' ? l.x - w : l.x - w / 2;
  // y is the baseline of the first line
  return { text: l.text, x0, y0: l.y - size * 0.8, x1: x0 + w, y1: l.y - size * 0.8 + h };
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmt(n) {
  return Math.abs(n - Math.round(n)) < 0.001 ? String(Math.round(n)) : n.toFixed(1);
}

function pathD(points, allVSegs, ownIdx) {
  let d = `M ${fmt(points[0].x)} ${fmt(points[0].y)}`;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const horizontal = Math.abs(a.y - b.y) < 0.01;
    if (!horizontal) {
      d += ` L ${fmt(b.x)} ${fmt(b.y)}`;
      continue;
    }
    // hop over vertical segments of other paths (circuit convention: h hops v)
    const lo = Math.min(a.x, b.x), hi = Math.max(a.x, b.x);
    const dir = b.x > a.x ? 1 : -1;
    const xs = [];
    for (const v of allVSegs) {
      if (v.owner === ownIdx) continue;
      const vy1 = Math.min(v.y1, v.y2), vy2 = Math.max(v.y1, v.y2);
      if (v.x > lo + HOP_R && v.x < hi - HOP_R && a.y > vy1 + 0.5 && a.y < vy2 - 0.5) xs.push(v.x);
    }
    xs.sort((p, q) => dir > 0 ? p - q : q - p);
    for (const x of xs) {
      d += ` L ${fmt(x - dir * HOP_R)} ${fmt(a.y)}`;
      d += ` A ${HOP_R} ${HOP_R} 0 0 ${dir > 0 ? 1 : 0} ${fmt(x + dir * HOP_R)} ${fmt(a.y)}`;
    }
    d += ` L ${fmt(b.x)} ${fmt(b.y)}`;
  }
  return d;
}

function setFont(px) {
  const k = px / 14;
  FONT_SIZE = px;
  CHAR_W = 7.7 * k;
  LINE_H = Math.round(17 * k * 10) / 10;
  PAD_Y = Math.round(10 * k);
  LABEL_SIZE = Math.round(12 * k * 10) / 10;
  LABEL_CHAR_W = 6.4 * k;
}

function renderSvg(source) {
  const warnings = [];
  const model = parse(source);
  setFont(model.meta.font || 14);
  const geom = layout(model);
  const placed = route(model, geom, warnings);
  const { paths, dots, labels } = buildDrawing(model, placed);

  // grow the canvas so edge labels near the border are not clipped
  for (const l of labels) {
    const r = labelRect(l);
    geom.width = Math.max(geom.width, Math.ceil(r.x1 + MARGIN / 2));
    geom.height = Math.max(geom.height, Math.ceil(r.y1 + MARGIN / 2));
  }

  // collect vertical segments for hop computation
  const allVSegs = [];
  paths.forEach((p, idx) => {
    for (const seg of toSegs(p.points)) {
      if (seg.o === 'v') allVSegs.push({ ...seg, owner: idx });
    }
  });

  // header: title on the left, key + legend on the right; widen the canvas
  // rather than let them overlap
  if (model.meta.title && (model.meta.key.length || model.meta.legend.length)) {
    const titleRight = MARGIN + model.meta.title.length * 17;
    const perRowK = model.meta.key.length > 3 ? Math.ceil(model.meta.key.length / 2) : model.meta.key.length;
    const keyW = model.meta.key.length ? Math.round(140 * FONT_SIZE / 14) * perRowK + 20 : 0;
    geom.width = Math.max(geom.width, Math.ceil(titleRight + 24 + keyW + 170 + MARGIN));
  }

  const colors = [...new Set([
    ...paths.filter(p => p.arrow || p.arrowStart).map(p => p.style.color),
    ...model.meta.key.map(k => k.style.stroke || geom.edgeColor),
  ])];
  const markerId = c => 'arw-' + c.replace(/[^a-zA-Z0-9]/g, '');

  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${geom.width} ${geom.height}" width="${geom.width}" height="${geom.height}" font-family="-apple-system, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif">`);
  out.push('<defs>');
  for (const c of colors) {
    out.push(`<marker id="${markerId(c)}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${esc(c)}"/></marker>`);
  }
  const bg = model.meta.background;
  if (bg) out.push(`<linearGradient id="gf-bg" x1="0" y1="0" x2="0.35" y2="1"><stop offset="0" stop-color="${esc(bg[0])}"/><stop offset="1" stop-color="${esc(bg[1])}"/></linearGradient>`);
  out.push('</defs>');
  if (bg) out.push(`<rect x="0" y="0" width="${geom.width}" height="${geom.height}" fill="url(#gf-bg)"/>`);
  if (model.meta.title) {
    out.push(`<text x="${MARGIN}" y="${MARGIN + 26}" font-size="30" font-weight="700" fill="${geom.labelColor}">${esc(model.meta.title)}</text>`);
  }
  if (model.meta.legend.length) {
    const lx = geom.width - MARGIN - 170;
    let ly = MARGIN + 4;
    out.push(`<text x="${lx}" y="${ly + 10}" font-size="14" font-weight="700" fill="${geom.labelColor}">${esc(model.meta.legendTitle || 'Legend')}</text>`);
    ly += 22;
    for (const item of model.meta.legend) {
      out.push(`<rect x="${lx}" y="${ly}" width="18" height="10" fill="${esc(item.color)}"/>`);
      out.push(`<text x="${lx + 26}" y="${ly + 9}" font-size="11" fill="${geom.labelColor}">${esc(item.text)}</text>`);
      ly += 16;
    }
  }
  if (model.meta.key.length) {
    const perRow = model.meta.key.length > 3 ? Math.ceil(model.meta.key.length / 2) : model.meta.key.length;
    const nRowsK = Math.ceil(model.meta.key.length / perRow);
    const kk = FONT_SIZE / 14;
    const kw = Math.round(140 * kk) * perRow;
    const kx = geom.width - MARGIN - 170 - 20 - kw;
    const ky0 = MARGIN;
    const rowHK = Math.round(70 * kk);
    out.push(`<rect x="${kx}" y="${ky0}" width="${kw}" height="${rowHK * nRowsK}" fill="none" stroke="${geom.labelColor}" stroke-width="1"/>`);
    model.meta.key.forEach((k, i) => {
      const x = kx + 14 + (i % perRow) * Math.round(140 * kk);
      const ky = ky0 + Math.floor(i / perRow) * rowHK;
      const c = k.style.stroke || geom.edgeColor;
      const dash = k.style.dash ? dashAttr(k.style.dash) : k.style.dashed === 'yes' ? dashAttr('dash') : '';
      const both = k.style.both === 'yes';
      out.push(`<path d="M ${x} ${ky + 12 * kk} L ${x} ${ky + 50 * kk}" stroke="${esc(c)}" stroke-width="2"${dash} marker-end="url(#${markerId(c)})"${both ? ` marker-start="url(#${markerId(c)})"` : ''}/>`);
      const words = wrapGreedy(k.text, 150 * kk);
      words.forEach((w, j) => out.push(`<text x="${x + 10}" y="${ky + 20 + j * 12}" font-size="10" fill="${geom.labelColor}">${esc(w)}</text>`));
    });
  }
  if (model.meta.subtitle) {
    model.meta.subtitle.split('|').forEach((line, i) => {
      out.push(`<text x="${MARGIN}" y="${MARGIN + 52 + i * 22}" font-size="15" font-weight="600" fill="${geom.labelColor}">${esc(line)}</text>`);
    });
  }

  // Variant back cards go first, under the edges: lines stay visible across
  // them (as on the reference slides) and only the front card covers lines.
  for (const n of model.nodes.values()) {
    if (!n.variants || !n.variants.length) continue;
    const cls = n.cls ? model.classes.get(n.cls) : null;
    const fill = cls ? cls.fill : DEFAULT_FILL;
    const stroke = cls ? cls.stroke : DEFAULT_STROKE;
    const textColor = (cls && cls.text) || TEXT_COLOR;
    for (let k = n.variants.length; k >= 1; k--) {
      const x = n.x + k * variantDx(), y = n.y + k * variantDy();
      out.push(`<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(n.w)}" height="${fmt(n.h)}" rx="6" fill="${esc(darken(fill, 0.08 * k))}" stroke="${esc(stroke)}" stroke-width="${STROKE_W}"/>`);
      // name in the strip this card shows below the card in front of it
      out.push(`<text x="${fmt(x + n.w - 6)}" y="${fmt(y + n.h - 4)}" text-anchor="end" font-size="${fmt(FONT_SIZE * 0.85)}" font-weight="600" fill="${esc(textColor)}">${esc(n.variants[k - 1])}</text>`);
    }
  }

  // edges under nodes? No — boxes are opaque; draw edges first is safer either way.
  paths.forEach((p, idx) => {
    const d = pathD(p.points, allVSegs, idx);
    const dash = dashAttr(p.style.dashed);
    const marker = (p.arrow ? ` marker-end="url(#${markerId(p.style.color)})"` : '') +
      (p.arrowStart ? ` marker-start="url(#${markerId(p.style.color)})"` : '');
    out.push(`<path d="${d}" fill="none" stroke="${esc(p.style.color)}" stroke-width="${STROKE_W}"${dash}${marker}/>`);
  });

  for (const dot of dots) {
    out.push(`<circle cx="${fmt(dot.x)}" cy="${fmt(dot.y)}" r="${DOT_R}" fill="${esc(dot.color)}"/>`);
  }

  for (const n of model.nodes.values()) {
    const cls = n.cls ? model.classes.get(n.cls) : null;
    const fill = cls ? cls.fill : DEFAULT_FILL;
    const stroke = cls ? cls.stroke : DEFAULT_STROKE;
    if (n.stack) {
      for (const k of [2, 1]) {
        out.push(`<rect x="${fmt(n.x + 5 * k)}" y="${fmt(n.y + 5 * k)}" width="${fmt(n.w)}" height="${fmt(n.h)}" rx="6" fill="${esc(fill)}" stroke="${esc(stroke)}" stroke-width="${STROKE_W}"/>`);
      }
    }
    out.push(`<rect x="${fmt(n.x)}" y="${fmt(n.y)}" width="${fmt(n.w)}" height="${fmt(n.h)}" rx="6" fill="${esc(fill)}" stroke="${esc(stroke)}" stroke-width="${STROKE_W}"/>`);
    const textColor = (cls && cls.text) || TEXT_COLOR;
    const rows = [
      ...n.lines.map(t => ({ t, w: n.subLines.length ? 700 : 600 })),
      ...n.subLines.map(t => ({ t, w: 400 })),
    ];
    const y0 = n.cy - ((rows.length - 1) * LINE_H) / 2 + 5;
    rows.forEach((r, i) => {
      out.push(`<text x="${fmt(n.cx)}" y="${fmt(y0 + i * LINE_H)}" text-anchor="middle" font-size="${FONT_SIZE}" font-weight="${r.w}" fill="${esc(textColor)}">${esc(r.t)}</text>`);
    });
  }

  for (const nt of model.meta.notes) {
    const n = model.nodes.get(nt.id);
    out.push(`<text x="${fmt(n.cx)}" y="${fmt(n.y - 7)}" text-anchor="middle" font-size="13" font-weight="700" fill="${geom.labelColor}">${esc(nt.text)}</text>`);
  }

  // a halo in the background colour keeps labels legible where lines pass
  const halo = bg ? bg[0] : '#ffffff';
  for (const l of labels) {
    const tr = l.rotate ? ` transform="rotate(90 ${fmt(l.x)} ${fmt(l.y)})"` : '';
    const size = l.size || LABEL_SIZE;
    const body = (l.lines || [l.text]).map((t, i) => i === 0 ? esc(t) : `<tspan x="${fmt(l.x)}" dy="${fmt(size * 1.15)}">${esc(t)}</tspan>`).join('');
    out.push(`<text x="${fmt(l.x)}" y="${fmt(l.y)}" text-anchor="${l.anchor}" font-size="${size}" font-weight="600" fill="${geom.labelColor}" stroke="${esc(halo)}" stroke-width="3" stroke-linejoin="round" paint-order="stroke"${tr}>${body}</text>`);
  }

  out.push('</svg>');
  const nodeRects = [...model.nodes.values()].map(n => ({ id: n.id, ...nodeExtent(n) }));
  return { svg: out.join('\n'), width: geom.width, height: geom.height, warnings, labels: labels.map(labelRect), nodes: nodeRects };
}

module.exports = { parse, layout, route, renderSvg };
