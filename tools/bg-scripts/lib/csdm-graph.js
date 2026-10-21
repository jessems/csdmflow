// csdm-graph — the intermediate format every background script writes, and its
// conversion to csdmflow source. A graph is plain data straight from the CMDB:
// nodes are records, edges are the links between them. What a diagram needs
// beyond that (ids, grouping CIs into stacks, quoting) is decided here, so every
// script draws the same way.
//
// ES5 on purpose: build.js inlines this file into scripts that run as
// ServiceNow background scripts, and global scope there is ES5. It runs in Node
// too (tests, and `node tools/bg-scripts/lib/csdm-graph.js export.txt`).

/**
 * The csdmflow entity types a node can have.
 * @typedef {'BC'|'BA'|'SI'|'TMS'|'TMSO'|'DCG'|'CI'|'BSO'|'BS'|'SP'} EntityType
 */

/**
 * One CMDB record.
 * @typedef {Object} GraphNode
 * @property {string} id            sys_id
 * @property {EntityType} type
 * @property {string} name
 * @property {string} [table]       sys_class_name, e.g. "cmdb_ci_win_server"
 * @property {string} [className]   the class's label, e.g. "Windows Server"; a CI's box title
 * @property {string} [number]      e.g. a service offering's "SO0001234"
 * @property {number} [count]       CIs only: stands in for this many CIs of the class, e.g. a
 *                                  group's members; then id is made up and name is empty
 * @property {Object<string, *>} [attrs]  anything else a script wants to keep
 */

/**
 * A link between two nodes, oriented parent -> child as ServiceNow stores it
 * (cmdb_rel_ci parent/child, offering -> its parent service, service -> its
 * portfolio, group -> member).
 * csdmflow turns each pair the CSDM way round itself.
 * @typedef {Object} GraphEdge
 * @property {string} from          sys_id of a node in the graph
 * @property {string} to            sys_id of a node in the graph
 * @property {'cmdb_rel_ci'|'parent'|'portfolio'|'svc_ci_assoc'|'dcg_member'} via  where the link was found
 * @property {string} [rel]         the cmdb_rel_type name, e.g. "Depends on::Used by" (via cmdb_rel_ci)
 */

/**
 * @typedef {Object} CsdmGraph
 * @property {'csdm-graph'} format
 * @property {1} version
 * @property {{script: string, instance?: string, generatedAt?: string, root?: string}} source
 *           which script wrote it, where and when; root is the sys_id it started from
 * @property {GraphNode[]} nodes
 * @property {GraphEdge[]} edges
 * @property {string[]} warnings    what the script could not read or chose to leave out
 */

var CsdmGraph = (function () {
  var FORMAT = 'csdm-graph';
  var VERSION = 1;
  var TYPES = ['BC', 'BA', 'SI', 'TMS', 'TMSO', 'DCG', 'CI', 'BSO', 'BS', 'SP'];
  var VIAS = ['cmdb_rel_ci', 'parent', 'portfolio', 'svc_ci_assoc', 'dcg_member'];
  var PLAYGROUND = 'https://jessems.github.io/csdmflow/editor.html';

  function has(list, x) { return list.indexOf(x) >= 0; }

  /** @returns {CsdmGraph} an empty graph */
  function create(source) {
    return { format: FORMAT, version: VERSION, source: source, nodes: [], edges: [], warnings: [] };
  }

  /**
   * A graph to fill in, which ignores a node or edge it already has.
   * @returns {{graph: CsdmGraph, node: function(string): GraphNode, addNode: function(GraphNode): GraphNode,
   *            addEdge: function(string, string, string, string=), warn: function(string)}}
   */
  function builder(source) {
    var g = create(source);
    var nodes = {};
    var edges = {};
    return {
      graph: g,
      node: function (id) { return nodes[id]; },
      addNode: function (n) {
        if (!nodes[n.id]) { nodes[n.id] = n; g.nodes.push(n); }
        return nodes[n.id];
      },
      // one edge per pair of nodes: the first way it was found wins
      addEdge: function (from, to, via, rel) {
        var key = from < to ? from + '|' + to : to + '|' + from;
        if (from === to || edges[key] || !nodes[from] || !nodes[to]) return;
        edges[key] = true;
        var e = { from: from, to: to, via: via };
        if (rel) e.rel = rel;
        g.edges.push(e);
      },
      warn: function (msg) { g.warnings.push(msg); }
    };
  }

  /**
   * Everything wrong with a graph, as messages; empty when it is valid.
   * @param {*} g
   * @returns {string[]}
   */
  function validate(g) {
    var errs = [];
    if (!g || typeof g !== 'object') return ['not an object'];
    if (g.format !== FORMAT) errs.push('format must be "' + FORMAT + '"');
    if (g.version !== VERSION) errs.push('version must be ' + VERSION);
    if (!g.source || typeof g.source.script !== 'string') errs.push('source.script is missing');
    if (!isArray(g.nodes)) errs.push('nodes must be an array');
    if (!isArray(g.edges)) errs.push('edges must be an array');
    if (!isArray(g.warnings)) errs.push('warnings must be an array');
    if (errs.length) return errs;
    var ids = {};
    g.nodes.forEach(function (n, i) {
      var at = 'nodes[' + i + ']';
      if (!n || typeof n.id !== 'string' || !n.id) return errs.push(at + ': id is missing');
      if (ids[n.id]) errs.push(at + ': duplicate id ' + n.id);
      ids[n.id] = true;
      if (!has(TYPES, n.type)) errs.push(at + ': type must be one of ' + TYPES.join(', ') + ', not ' + n.type);
      if (typeof n.name !== 'string') errs.push(at + ': name is missing');
      if (n.count != null && !(n.type === 'CI' && n.count > 0 && n.count % 1 === 0)) errs.push(at + ': count must be a positive whole number, on a CI');
    });
    g.edges.forEach(function (e, i) {
      var at = 'edges[' + i + ']';
      if (!e || !ids[e.from]) errs.push(at + ': from is not a node: ' + (e && e.from));
      if (!e || !ids[e.to]) errs.push(at + ': to is not a node: ' + (e && e.to));
      if (e && !has(VIAS, e.via)) errs.push(at + ': via must be one of ' + VIAS.join(', '));
    });
    return errs;
  }

  function isArray(x) { return Object.prototype.toString.call(x) === '[object Array]'; }

  // --- to csdmflow -------------------------------------------------------------

  // Text inside csdmflow quotes: only `"` and `#` are special.
  function quote(s) {
    return '"' + (clean(s) || '(no name)').replace(/#/g, '#35;').replace(/"/g, '#quot;') + '"';
  }
  // 1'250 as in Switzerland; by hand, since the instance's JavaScript has no Intl
  function count(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, "'"); }

  // boxes by type, then name, as the ITFM 2.0 Inspector writes them
  var ORDER = ['BA', 'SI', 'TMSO', 'TMS', 'DCG', 'CI', 'BSO', 'BS', 'SP', 'BC'];

  // Lines whose relationship type is not the one csdmflow labels the pair
  // with (Contains, for a group under an offering or an instance).
  var LABELS = {
    'DCG|SI': { 'Depends on::Used by': 'Depends On' },
    'DCG|TMSO': { 'Depends on::Used by': 'Depends On' }
  };
  // A CI class sits in parentheses, so those are escaped too.
  function classText(s) {
    return clean(s).replace(/#/g, '#35;').replace(/\(/g, '#40;').replace(/\)/g, '#41;');
  }
  function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').replace(/^ | $/g, ''); }
  function slug(s) {
    return clean(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  }

  /**
   * csdmflow source for a graph.
   *
   * CIs that share a class and exactly the same neighbours become one stacked
   * box titled with the count ("CI(Windows Server (2)) web: "web01", "web02""),
   * so a group of 200 servers is one box, not 200. Edges between the same two
   * boxes are drawn once.
   *
   * @param {CsdmGraph} g
   * @param {{title?: string, subtitle?: string, layout?: string, maxNames?: number}} [opts]
   *        maxNames: names shown on a stacked box; beyond, the first few and "…" (default 4)
   * @returns {string}
   */
  function toCsdm(g, opts) {
    opts = opts || {};
    var maxNames = opts.maxNames || 4;
    var errs = validate(g);
    if (errs.length) throw new Error('not a valid csdm-graph: ' + errs.join('; '));

    var byId = {};
    g.nodes.forEach(function (n) { byId[n.id] = n; });
    var nbrs = {};
    g.nodes.forEach(function (n) { nbrs[n.id] = { up: [], down: [] }; });
    g.edges.forEach(function (e) {
      if (e.from === e.to) return;
      nbrs[e.from].down.push(e.to);
      nbrs[e.to].up.push(e.from);
    });

    // one box per non-CI node; CIs share a box when class and neighbours match
    var boxes = [];
    var boxOf = {};
    var ciBox = {};
    g.nodes.forEach(function (n) {
      if (n.type === 'CI' && n.count) {
        // CIs counted, not read: a box of their own, "Windows Server" / "1'250 CIs"
        boxOf[n.id] = { type: 'CI', ciClass: n.className || n.table || '', names: [count(n.count) + (n.count === 1 ? ' CI' : ' CIs')], counted: true };
        boxes.push(boxOf[n.id]);
      } else if (n.type === 'CI') {
        var key = (n.className || n.table || '') + '|' + uniq(nbrs[n.id].up).sort().join(',') + '|' + uniq(nbrs[n.id].down).sort().join(',');
        var b = ciBox[key];
        if (!b) {
          b = ciBox[key] = { type: 'CI', ciClass: n.className || n.table || '', names: [] };
          boxes.push(b);
        }
        b.names.push(n.name);
        boxOf[n.id] = b;
      } else {
        boxOf[n.id] = { type: n.type, names: [n.name] };
        boxes.push(boxOf[n.id]);
      }
    });

    var rank = function (t) { var i = ORDER.indexOf(t); return i < 0 ? ORDER.length : i; };
    var first = function (b) { return (b.counted ? b.ciClass : b.names.slice().sort()[0]) || ''; };
    boxes.sort(function (a, z) {
      return rank(a.type) - rank(z.type) || (first(a) < first(z) ? -1 : first(a) > first(z) ? 1 : 0);
    });

    var taken = {};
    boxes.forEach(function (b) {
      var base = slug(b.type === 'CI' ? (b.counted ? (b.ciClass || 'ci') + ' members' : b.names.length > 1 ? b.ciClass || 'ci' : b.names[0]) : b.names[0]) || b.type.toLowerCase();
      var id = base;
      for (var k = 2; taken[id]; k++) id = base + '-' + k;
      taken[id] = true;
      b.id = id;
    });

    var lines = [];
    var root = g.source.root && byId[g.source.root];
    var title = opts.title || (root ? root.name : '');
    if (title) lines.push('title ' + quote(title));
    var sub = opts.subtitle;
    if (sub == null) {
      sub = [root && root.number, g.source.instance, g.source.generatedAt && g.source.generatedAt.slice(0, 10)]
        .filter(Boolean).join(' · ');
    }
    if (sub) lines.push('subtitle ' + quote(sub));
    if (opts.layout) lines.push('layout ' + opts.layout);
    if (lines.length) lines.push('');

    boxes.forEach(function (b) {
      var shown = b.names.slice().sort();
      if (shown.length > maxNames) shown = shown.slice(0, maxNames - 1).concat(['…']);
      // several CIs: the count in the title, "Linux Server (7)"
      var cls = classText(b.ciClass || 'CI') + (b.names.length > 1 ? ' #40;' + count(b.names.length) + '#41;' : '');
      var head = b.type === 'CI' ? 'CI(' + cls + ')' : b.type;
      lines.push(head + ' ' + b.id + ': ' + shown.map(quote).join(', '));
    });
    lines.push('');

    var seen = {};
    g.edges.forEach(function (e) {
      var a = boxOf[e.from].id, z = boxOf[e.to].id;
      if (a === z || seen[a + '>' + z]) return;
      seen[a + '>' + z] = true;
      var types = [byId[e.from].type, byId[e.to].type].sort().join('|');
      var label = LABELS[types] && LABELS[types][e.rel];
      lines.push(a + ' -> ' + z + (label ? ' : ' + label : ''));
    });
    return lines.join('\n') + '\n';
  }

  function uniq(xs) {
    var out = [], seen = {};
    xs.forEach(function (x) { if (!seen[x]) { seen[x] = true; out.push(x); } });
    return out;
  }

  // --- playground link ---------------------------------------------------------

  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  // UTF-8 then base64, without btoa or Buffer (neither exists on the instance)
  function base64(s) {
    var bytes = [], i, c;
    for (i = 0; i < s.length; i++) {
      c = s.charCodeAt(i);
      if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) c = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(++i) - 0xdc00);
      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) bytes.push(0xc0 | c >> 6, 0x80 | c & 63);
      else if (c < 0x10000) bytes.push(0xe0 | c >> 12, 0x80 | c >> 6 & 63, 0x80 | c & 63);
      else bytes.push(0xf0 | c >> 18, 0x80 | c >> 12 & 63, 0x80 | c >> 6 & 63, 0x80 | c & 63);
    }
    var out = '';
    for (i = 0; i < bytes.length; i += 3) {
      var n = bytes[i] << 16 | (bytes[i + 1] || 0) << 8 | (bytes[i + 2] || 0);
      out += B64.charAt(n >> 18 & 63) + B64.charAt(n >> 12 & 63) +
        (i + 1 < bytes.length ? B64.charAt(n >> 6 & 63) : '=') +
        (i + 2 < bytes.length ? B64.charAt(n & 63) : '=');
    }
    return out;
  }

  /** A playground link that opens with this csdmflow source. */
  function playgroundUrl(source) {
    return PLAYGROUND + '#src=' + encodeURIComponent(base64(source));
  }

  /**
   * The graph in text copied from a background script's output: the one
   * {"format":"csdm-graph",…} line, whatever surrounds it.
   * @returns {CsdmGraph}
   */
  function parse(text) {
    var at = text.search(/\{\s*"format"\s*:\s*"csdm-graph"/);
    if (at < 0) throw new Error('no {"format":"csdm-graph",…} line found');
    var g;
    try { g = JSON.parse(text.slice(at).split(/\r?\n/)[0]); } catch (e) {
      throw new Error('the csdm-graph JSON is cut off or garbled; copy it again');
    }
    var errs = validate(g);
    if (errs.length) throw new Error('not a valid csdm-graph: ' + errs.join('; '));
    return g;
  }

  return {
    FORMAT: FORMAT, VERSION: VERSION, TYPES: TYPES,
    create: create, builder: builder, validate: validate, toCsdm: toCsdm, parse: parse,
    playgroundUrl: playgroundUrl, base64: base64
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = CsdmGraph;
  // node tools/bg-scripts/lib/csdm-graph.js export.txt [--layout tiers]: the csdmflow source
  if (typeof require !== 'undefined' && require.main === module) {
    var args = process.argv.slice(2);
    var li = args.indexOf('--layout');
    var layout = li >= 0 ? args.splice(li, 2)[1] : undefined;
    if (!args[0]) {
      console.error('usage: node tools/bg-scripts/lib/csdm-graph.js <export.txt> [--layout cross|tiers|row|lanes]');
      process.exit(1);
    }
    process.stdout.write(CsdmGraph.toCsdm(CsdmGraph.parse(require('fs').readFileSync(args[0], 'utf8')), { layout: layout }));
  }
}
