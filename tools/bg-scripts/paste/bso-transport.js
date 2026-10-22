// Built from tools/bg-scripts/bso-transport.js by tools/bg-scripts/build.js; edit that, not this.
var SCRIPT_VERSION = '23370fc9';
// BSO transport — what to move to carry the modelling around some business
// service offerings from this instance to another.
//
// Paste tools/bg-scripts/paste/bso-transport.js (not this file) into
// Scripts - Background, global scope, fill in SERVICES and run it. It reads, never
// writes. It prints:
//   1. one link per table to the list of the records to export, filtered by
//      sys_id: open it, right-click a column header › Export › XML
//   2. the order to import the files in on the target
//   3. for each service instance, the dynamic CI groups to add to it by hand
//      on the target (Manual population method), with a link to it
//
// What it collects, from the offerings:
//   - the service instances they depend on (Depends on::Used by)
//   - the dynamic CI groups that populate those instances: related to them by
//     Contains or Depends on, or on their maps (svc_ci_assoc); an instance
//     populated by the Dynamic CI Group method is a group record itself
//   - the CMDB groups behind the dynamic CI groups, and their encoded queries
//   - the relationships to export: offering -> instance, and tech offering
//     Contains instance or group. An instance's relationships to its groups
//     are left out: populating it on the target creates them.

// The business services, and the offerings of each to transport. The names
// are there to read; the numbers decide (a sys_id works too). For example:
//   var SERVICES = [
//     { "name": "Email", "number": "BSN0001001", "offerings": [
//       { "name": "Email Standard", "number": "SO0001234" },
//       { "name": "Email Premium", "number": "SO0001235" }
//     ] }
//   ];
var SERVICES = [
];
var TARGET_INSTANCE = ''; // the target's instance name (e.g. 'acmeprod'), for the links in the manual steps; '' links to this instance

// ---- lib/csdm-graph.js ----
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
 * @property {string} [url]         where the record opens on the instance; the box links there
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
 * @property {{script: string, instance?: string, baseUrl?: string, generatedAt?: string, root?: string}} source
 *           which script wrote it, where and when; root is the sys_id it started from;
 *           baseUrl the instance's address, for links to several records at once
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
      if (n.url != null && !/^https?:\/\/\S+$/i.test(n.url)) errs.push(at + ': url must be an http or https address');
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
        boxOf[n.id] = { type: 'CI', ciClass: n.className || n.table || '', names: [count(n.count) + (n.count === 1 ? ' CI' : ' CIs')], counted: true, nodes: [n] };
        boxes.push(boxOf[n.id]);
      } else if (n.type === 'CI') {
        var key = (n.className || n.table || '') + '|' + uniq(nbrs[n.id].up).sort().join(',') + '|' + uniq(nbrs[n.id].down).sort().join(',');
        var b = ciBox[key];
        if (!b) {
          b = ciBox[key] = { type: 'CI', ciClass: n.className || n.table || '', names: [], nodes: [] };
          boxes.push(b);
        }
        b.names.push(n.name);
        b.nodes.push(n);
        boxOf[n.id] = b;
      } else {
        boxOf[n.id] = { type: n.type, names: [n.name], nodes: [n] };
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

    // Each box links to its record; a stack of several CIs to a list of them
    // (on the instance the graph came from, when it says which).
    var listBase = /^https?:\/\/\S+\/$/i.test(g.source.baseUrl || '') ? g.source.baseUrl : '';
    var linked = 0;
    boxes.forEach(function (b) {
      var nodes = b.nodes;
      var url = nodes.length === 1 ? nodes[0].url : '';
      if (nodes.length > 1 && listBase) {
        url = listBase + 'cmdb_ci_list.do?sysparm_query=' + encodeURIComponent('sys_idIN' + nodes.map(function (n) { return n.id; }).join(','));
      }
      if (url) { lines.push('link ' + b.id + ' ' + quote(url)); linked++; }
    });
    if (linked) lines.push('');

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

  // Text as UTF-8 bytes, without TextEncoder (the instance has none)
  function utf8(s) {
    var bytes = [], i, c;
    for (i = 0; i < s.length; i++) {
      c = s.charCodeAt(i);
      if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) c = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(++i) - 0xdc00);
      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) bytes.push(0xc0 | c >> 6, 0x80 | c & 63);
      else if (c < 0x10000) bytes.push(0xe0 | c >> 12, 0x80 | c >> 6 & 63, 0x80 | c & 63);
      else bytes.push(0xf0 | c >> 18, 0x80 | c >> 12 & 63, 0x80 | c >> 6 & 63, 0x80 | c & 63);
    }
    return bytes;
  }

  // Bytes as base64, without btoa or Buffer; url: the URL-safe alphabet, unpadded
  function bytesToBase64(bytes, url) {
    var out = '';
    for (var i = 0; i < bytes.length; i += 3) {
      var n = bytes[i] << 16 | (bytes[i + 1] || 0) << 8 | (bytes[i + 2] || 0);
      out += B64.charAt(n >> 18 & 63) + B64.charAt(n >> 12 & 63) +
        (i + 1 < bytes.length ? B64.charAt(n >> 6 & 63) : '=') +
        (i + 2 < bytes.length ? B64.charAt(n & 63) : '=');
    }
    return url ? out.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : out;
  }

  /** Text as UTF-8, then base64. */
  function base64(s) { return bytesToBase64(utf8(s)); }

  // --- deflate -----------------------------------------------------------------
  // A raw deflate stream (RFC 1951) in one block with the fixed Huffman codes:
  // LZ77 matches over hash chains, no dynamic code tables. Any inflater reads
  // it, including the browser's DecompressionStream('deflate-raw'), which the
  // editor uses to open a link. It exists because the instance has no zlib.

  var LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  var LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  var DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  var DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

  /** Bytes compressed as raw deflate. */
  function deflateRaw(bytes) {
    var out = [], buf = 0, nbits = 0;
    // values go in least significant bit first, Huffman codes most significant first
    function put(v, n) {
      buf |= v << nbits;
      nbits += n;
      while (nbits >= 8) { out.push(buf & 255); buf >>>= 8; nbits -= 8; }
    }
    function code(c, n) {
      var r = 0;
      for (var k = 0; k < n; k++) { r = r << 1 | c & 1; c >>= 1; }
      put(r, n);
    }
    function symbol(sym) {
      if (sym < 144) code(0x30 + sym, 8);
      else if (sym < 256) code(0x190 + sym - 144, 9);
      else if (sym < 280) code(sym - 256, 7);
      else code(0xc0 + sym - 280, 8);
    }
    function lastAtMost(table, v) {
      var k = table.length - 1;
      while (table[k] > v) k--;
      return k;
    }
    var n = bytes.length, head = {}, prev = [];
    function remember(p) {
      if (p + 2 >= n) return;
      var key = bytes[p] << 16 | bytes[p + 1] << 8 | bytes[p + 2];
      prev[p] = head[key];
      head[key] = p;
    }
    put(1, 1); // the last block
    put(1, 2); // with fixed codes
    var i = 0;
    while (i < n) {
      var best = 0, dist = 0;
      if (i + 2 < n) {
        var j = head[bytes[i] << 16 | bytes[i + 1] << 8 | bytes[i + 2]];
        for (var tries = 0; j !== undefined && i - j <= 32768 && tries < 128; tries++, j = prev[j]) {
          var len = 0;
          while (len < 258 && i + len < n && bytes[j + len] === bytes[i + len]) len++;
          if (len > best) { best = len; dist = i - j; if (len === 258) break; }
        }
      }
      if (best >= 3) {
        var lk = lastAtMost(LEN_BASE, best), dk = lastAtMost(DIST_BASE, dist);
        symbol(257 + lk);
        put(best - LEN_BASE[lk], LEN_EXTRA[lk]);
        code(dk, 5);
        put(dist - DIST_BASE[dk], DIST_EXTRA[dk]);
        for (var e = 0; e < best; e++) remember(i + e);
        i += best;
      } else {
        symbol(bytes[i]);
        remember(i);
        i++;
      }
    }
    symbol(256); // end of block
    if (nbits) out.push(buf & 255);
    return out;
  }

  /**
   * An editor link that opens with this csdmflow source: `#z=` and the source
   * deflated and base64url-encoded, about a quarter of its plain length.
   */
  function playgroundUrl(source) {
    return PLAYGROUND + '#z=' + bytesToBase64(deflateRaw(utf8(source)), true);
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
    playgroundUrl: playgroundUrl, base64: base64, utf8: utf8, deflateRaw: deflateRaw
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
// ---- end lib/csdm-graph.js ----
// ---- lib/walk.js ----
// walk — which records belong in a CSDM picture, independent of Glide. The
// rules follow the ITFM 2.0 Inspector's src/server/graph/model.ts: walking out
// from a record, each type leads only to certain types (FOLLOW), through only
// certain links (LINKS), and a service map is read downwards to a fixed depth.
// lib/cmdb.js supplies the records; this file is pure, so the test runs it
// in Node. ES5: it is inlined into background scripts.

/**
 * A record as lib/cmdb.js reads it.
 * @typedef {Object} Rec
 * @property {string} id
 * @property {string} table            sys_class_name, or 'spm_service_portfolio'
 * @property {string[]} ancestors      the class and every class it extends
 * @property {string} name
 * @property {string} [classLabel]     the class's label, e.g. "Windows Server"
 * @property {string} [number]         offerings: e.g. "SO0001234"
 * @property {string} [parentId]       offerings: their parent service
 * @property {number} [count]          stands in for this many CIs of the class (a group's members), not one record
 * @property {string} [url]            where the record (or the list behind a count) opens on the instance
 * @property {string[]} [parentAncestors]  offerings: the ancestors of their parent service
 */

/**
 * A record linked to one already in the picture.
 * @typedef {Object} Link
 * @property {string} from     the record in the picture
 * @property {Rec} rec         the record it is linked to
 * @property {string} via      a cmdb_rel_type name ("Contains::Contained by"), 'parent', 'portfolio' or 'member'
 * @property {boolean} [down]  relationships: rec is the child
 */

var CsdmWalk = (function () {
  // Walking out from the root, the types each type leads on to. A business
  // service's other offerings, or another service's instances, are never
  // reached: the picture stays about the root.
  var FOLLOW = {
    BS: ['SP'],
    BSO: ['BS', 'SI'],
    SI: ['BA', 'TMSO', 'DCG', 'CI'],
    TMSO: ['TMS', 'DCG'],
    // the tech offering that manages a group an instance contains
    DCG: ['CI', 'TMSO'],
    CI: ['CI'],
    BA: [],
    TMS: [],
    SP: []
  };

  // Which links count, by the unordered pair of types. Relationship types vary
  // between CSDM versions and implementations, so each pair accepts all the
  // known spellings; the line csdmflow draws comes from the pair.
  var LINKS = {
    'BS|SP': ['portfolio'],
    'BS|BSO': ['parent'],
    'TMS|TMSO': ['parent'],
    'BSO|SI': ['Depends on::Used by'],
    'BA|SI': ['Uses::Used by', 'Consumes::Consumed by'],
    'SI|TMSO': ['Depends on::Used by', 'Contains::Contained by'],
    'DCG|TMSO': ['Contains::Contained by', 'Depends on::Used by'],
    // an instance contains the group that populates it, or depends on it
    'DCG|SI': ['Contains::Contained by', 'Depends on::Used by'],
    // the service map: an instance and its CIs, and CIs among themselves
    // ... or, for an instance populated by a dynamic CI group, its members
    'CI|SI': ['Depends on::Used by', 'Contains::Contained by', 'Runs on::Runs', 'member'],
    'CI|CI': ['Depends on::Used by', 'Runs on::Runs', 'Hosted on::Hosts', 'Contains::Contained by'],
    'CI|DCG': ['member']
  };

  /** The relationship types worth querying for at all. */
  var REL_TYPES = [];
  Object.keys(LINKS).forEach(function (k) {
    LINKS[k].forEach(function (v) {
      if (v !== 'parent' && v !== 'portfolio' && v !== 'member' && REL_TYPES.indexOf(v) < 0) REL_TYPES.push(v);
    });
  });

  function pairKey(a, b) { return [a, b].sort().join('|'); }
  function has(list, x) { return list.indexOf(x) >= 0; }

  /** The csdmflow type of a record, or null for one that stays out of the picture. */
  function classify(rec) {
    var is = function (t) { return has(rec.ancestors, t); };
    if (rec.table === 'spm_service_portfolio') return 'SP';
    // offerings extend cmdb_ci_service; the service they offer decides the kind
    if (is('service_offering')) {
      var parent = rec.parentAncestors || [];
      if (has(parent, 'cmdb_ci_service_business')) return 'BSO';
      if (has(parent, 'cmdb_ci_service_technical')) return 'TMSO';
      return null;
    }
    // dynamic CI groups extend cmdb_ci_service_auto, so they come first
    if (is('cmdb_ci_query_based_service')) return 'DCG';
    if (is('cmdb_ci_service_auto')) return 'SI';
    if (is('cmdb_ci_service_business')) return 'BS';
    if (is('cmdb_ci_service_technical')) return 'TMS';
    if (is('cmdb_ci_business_app')) return 'BA';
    // any other CI; services of other kinds (legacy, unclassified) stay out
    if (is('cmdb_ci') && !is('cmdb_ci_service')) return 'CI';
    return null;
  }

  // An application service populated by the Dynamic CI Group method is stored
  // in the dynamic CI group table itself, so a record there is an instance or a
  // group depending on what reaches it: an instance under a business offering,
  // a group under a tech offering.
  // The type a record takes when reached from a record of type hereType.
  function typeFrom(rec, hereType, via) {
    var type = classify(rec);
    if (type !== 'DCG') return type;
    var allowed = function (t) { return has(FOLLOW[hereType], t) && has(LINKS[pairKey(hereType, t)] || [], via); };
    return !allowed('DCG') && allowed('SI') ? 'SI' : 'DCG';
  }

  /** The node csdm-graph keeps for a record. */
  function toNode(rec, type) {
    var n = { id: rec.id, type: type, name: rec.name, table: rec.table };
    if (type === 'CI' && rec.classLabel) n.className = rec.classLabel;
    if (rec.number) n.number = rec.number;
    if (rec.count) n.count = rec.count;
    if (rec.url) n.url = rec.url;
    return n;
  }

  /**
   * Walks out from root into the builder, one ring of records at a time.
   * `links(ring)` returns every Link of the records in the ring ([{rec, type}]);
   * the walk keeps those FOLLOW and LINKS allow. A group's members (one Rec
   * per class, with a count) join the picture but are not walked on from; a
   * service map stops maxCiDepth hops below its instance.
   * @param {Rec} root
   * @param {function(Array<{rec: Rec, type: string}>): Link[]} links
   * @param {*} b   a CsdmGraph.builder
   * @param {{maxCiDepth?: number, skipped?: function(Link, string)}} [opts]
   *        skipped: told of every link left out, and why
   */
  function walk(root, links, b, opts) {
    var maxCiDepth = (opts && opts.maxCiDepth) || 5;
    var skip = (opts && opts.skipped) || function () {};
    var rootType = classify(root);
    if (!rootType) throw new Error((root.name || root.id) + ' is not a CSDM record csdmflow draws');
    var types = {};
    var depth = {}; // CIs: hops below their service instance
    var walked = {};
    types[root.id] = rootType;
    b.addNode(toNode(root, rootType));
    walked[root.id] = true;
    var ring = [{ rec: root, type: rootType }];
    while (ring.length) {
      var next = [];
      links(ring).forEach(function (l) {
        var hereType = types[l.from];
        var type = types[l.rec.id] || typeFrom(l.rec, hereType, l.via);
        if (!type) return skip(l, 'its class ' + l.rec.table + ' is not drawn');
        if (!has(FOLLOW[hereType], type)) return skip(l, hereType + ' does not lead to ' + type);
        if (!has(LINKS[pairKey(hereType, type)] || [], l.via)) return skip(l, hereType + ' and ' + type + ' are not linked by ' + l.via);
        var walkOn = true;
        if (type === 'CI') {
          if (l.via === 'member') walkOn = false;
          // a service map is read downwards: up from a shared server lie other applications
          else if (!l.down) return skip(l, 'above a CI in a service map');
          else {
            var d = hereType === 'CI' ? depth[l.from] + 1 : 1;
            if (d > maxCiDepth) return skip(l, 'deeper than ' + maxCiDepth + ' in a service map');
            if (!(l.rec.id in depth) || d < depth[l.rec.id]) depth[l.rec.id] = d;
          }
        }
        if (!types[l.rec.id]) {
          types[l.rec.id] = type;
          b.addNode(toNode(l.rec, type));
        }
        if (l.via === 'parent' || l.via === 'portfolio' || l.via === 'member') b.addEdge(l.from, l.rec.id, l.via === 'member' ? 'dcg_member' : l.via);
        else if (l.down) b.addEdge(l.from, l.rec.id, 'cmdb_rel_ci', l.via);
        else b.addEdge(l.rec.id, l.from, 'cmdb_rel_ci', l.via);
        if (walkOn && !walked[l.rec.id]) {
          walked[l.rec.id] = true;
          next.push({ rec: l.rec, type: type });
        }
      });
      ring = next;
    }
    return b.graph;
  }

  return { FOLLOW: FOLLOW, LINKS: LINKS, REL_TYPES: REL_TYPES, classify: classify, typeFrom: typeFrom, walk: walk };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CsdmWalk;
// ---- end lib/walk.js ----
// ---- lib/cmdb.js ----
// cmdb — the Glide side of lib/walk.js: reads records and their links, a whole
// ring of the walk at a time, so a ring of 200 CIs costs a few queries rather
// than hundreds. Only reads. ES5, global scope.

var Cmdb = (function () {
  var CHUNK = 200; // sys_ids per IN query

  function str(v) { return v == null ? '' : '' + v; }

  function chunks(ids) {
    var out = [];
    for (var i = 0; i < ids.length; i += CHUNK) out.push(ids.slice(i, i + CHUNK));
    return out;
  }

  function uniq(xs) {
    var seen = {};
    return xs.filter(function (x) { return x && !seen[x] && (seen[x] = true); });
  }

  // Each row of `table` whose `field` is one of `ids`, in chunks; `extra` adds
  // conditions to each query.
  function eachIn(table, field, ids, fn, extra) {
    chunks(uniq(ids)).forEach(function (chunk) {
      var gr = new GlideRecord(table);
      gr.addQuery(field, 'IN', chunk.join(','));
      if (extra) extra(gr);
      gr.query();
      while (gr.next()) fn(gr);
    });
  }

  // a class and every class it extends, e.g. cmdb_ci_win_server ... cmdb_ci
  var hierarchy = {};
  function ancestors(cls) {
    if (!hierarchy[cls]) {
      // TableUtils in global scope; GlideTableHierarchy only exists in a scoped app
      var list = typeof TableUtils !== 'undefined' ? new TableUtils(cls).getTables() : new GlideTableHierarchy(cls).getTables();
      var out = [];
      // a JavaScript array, or a Java list
      var n = typeof list.size === 'function' ? list.size() : list.length;
      for (var i = 0; i < n; i++) out.push(str(typeof list.get === 'function' ? list.get(i) : list[i]));
      hierarchy[cls] = out;
    }
    return hierarchy[cls];
  }

  // The instance's address, from the instance_name property (the same name the
  // diagram's subtitle shows): https://<instance_name>.service-now.com/; '' when
  // the property is unset or not a plain instance name: then boxes get no links
  var base = null;
  function baseUrl() {
    if (base === null) {
      var name = instance();
      base = /^[a-z0-9][a-z0-9-]*$/i.test(name) ? 'https://' + name + '.service-now.com/' : '';
    }
    return base;
  }
  function recordUrl(table, id) { return baseUrl() ? baseUrl() + table + '.do?sys_id=' + id : ''; }

  var cache = {}; // sys_id -> Rec, or null when it could not be read

  /** The Recs with these sys_ids, keyed by sys_id; unreadable ids are left out. */
  function read(ids) {
    var todo = uniq(ids).filter(function (id) { return !(id in cache); });
    var offerings = [];
    eachIn('cmdb_ci', 'sys_id', todo, function (gr) {
      var cls = str(gr.getValue('sys_class_name'));
      var rec = { id: str(gr.getUniqueValue()), table: cls, ancestors: ancestors(cls), name: str(gr.getValue('name')), classLabel: str(gr.getClassDisplayValue()) || cls };
      rec.url = recordUrl(cls, rec.id);
      cache[rec.id] = rec;
      if (rec.ancestors.indexOf('service_offering') >= 0) offerings.push(rec);
    });
    // what an offering offers decides whether it is a business or a tech offering
    var byId = {};
    offerings.forEach(function (o) { byId[o.id] = o; });
    eachIn('service_offering', 'sys_id', offerings.map(function (o) { return o.id; }), function (gr) {
      var o = byId[str(gr.getUniqueValue())];
      o.number = str(gr.getValue('number'));
      o.parentId = str(gr.getValue('parent'));
    });
    var parentClass = {};
    eachIn('cmdb_ci', 'sys_id', offerings.map(function (o) { return o.parentId; }), function (gr) {
      parentClass[str(gr.getUniqueValue())] = str(gr.getValue('sys_class_name'));
    });
    offerings.forEach(function (o) { if (parentClass[o.parentId]) o.parentAncestors = ancestors(parentClass[o.parentId]); });
    todo.forEach(function (id) { if (!(id in cache)) cache[id] = null; });
    var out = {};
    ids.forEach(function (id) { if (cache[id]) out[id] = cache[id]; });
    return out;
  }

  // A group's members of one class, as one Rec standing in for all of them
  var labels = {};
  function membersOf(group, cls, n) {
    if (!(cls in labels)) {
      var gr = new GlideRecord(cls);
      labels[cls] = gr.isValid() ? str(gr.getClassDisplayValue()) || cls : cls;
    }
    // the members themselves aren't read, so the link opens the list behind the count
    var url = baseUrl() ? baseUrl() + 'svc_ci_assoc_list.do?sysparm_query=' +
      encodeURIComponent('service_id=' + group + '^ci_id.sys_class_name=' + cls) : '';
    return { id: group + ':' + cls, table: cls, ancestors: ancestors(cls), name: '', classLabel: labels[cls], count: n, url: url };
  }

  function readPortfolios(ids) {
    var out = {};
    eachIn('spm_service_portfolio', 'sys_id', ids, function (gr) {
      var id = str(gr.getUniqueValue());
      out[id] = { id: id, table: 'spm_service_portfolio', ancestors: ['spm_service_portfolio'], name: str(gr.getValue('name')), url: recordUrl('spm_service_portfolio', id) };
    });
    return out;
  }

  // relationship types by their stored name ("Contains::Contained by"), not
  // their display text, which a language or a renamed label could change
  var relTypes = null;
  function relTypeIds() {
    if (!relTypes) {
      relTypes = {};
      eachIn('cmdb_rel_type', 'name', CsdmWalk.REL_TYPES, function (gr) { relTypes[str(gr.getUniqueValue())] = str(gr.getValue('name')); });
    }
    return relTypes;
  }

  /**
   * Every Link of the records in a ring of the walk (see lib/walk.js).
   * @param {Array<{rec: Rec, type: string}>} ring
   */
  function links(ring) {
    var out = [];
    var of = function (type) { return ring.filter(function (x) { return x.type === type; }).map(function (x) { return x.rec; }); };
    var pending = []; // [from, id, via, down]: read the records in one go at the end

    // an offering's service
    of('BSO').concat(of('TMSO')).forEach(function (o) { if (o.parentId) pending.push([o.id, o.parentId, 'parent']); });

    // a service names its portfolio directly, and through its taxonomy node
    var services = of('BS');
    if (services.length) {
      var portfolios = [], nodeOf = {};
      eachIn('cmdb_ci_service', 'sys_id', services.map(function (s) { return s.id; }), function (gr) {
        var id = str(gr.getUniqueValue());
        if (gr.getValue('spm_service_portfolio')) portfolios.push([id, str(gr.getValue('spm_service_portfolio'))]);
        if (gr.getValue('spm_taxonomy_node')) nodeOf[str(gr.getValue('spm_taxonomy_node'))] = id;
      });
      eachIn('spm_taxonomy_node', 'sys_id', Object.keys(nodeOf), function (gr) {
        if (gr.getValue('spm_service_portfolio')) portfolios.push([nodeOf[str(gr.getUniqueValue())], str(gr.getValue('spm_service_portfolio'))]);
      });
      var recs = readPortfolios(portfolios.map(function (p) { return p[1]; }));
      portfolios.forEach(function (p) { if (recs[p[1]]) out.push({ from: p[0], rec: recs[p[1]], via: 'portfolio' }); });
    }

    // relationships of the allowed types; a CI's service map is only read
    // downwards, so for CIs only their children matter
    var types = relTypeIds();
    var typeList = Object.keys(types).join(',');
    var both = of('BSO').concat(of('SI'), of('TMSO'), of('DCG')).map(function (r) { return r.id; });
    var down = both.concat(of('CI').map(function (r) { return r.id; }));
    var seen = {};
    var rel = function (gr) {
      var key = str(gr.getUniqueValue());
      if (seen[key]) return;
      seen[key] = true;
      return [str(gr.getValue('parent')), str(gr.getValue('child')), types[str(gr.getValue('type'))]];
    };
    var byType = function (gr) { gr.addQuery('type', 'IN', typeList); };
    if (typeList) {
      eachIn('cmdb_rel_ci', 'parent', down, function (gr) {
        var r = rel(gr);
        if (r) pending.push([r[0], r[1], r[2], true]);
      }, byType);
      eachIn('cmdb_rel_ci', 'child', both, function (gr) {
        var r = rel(gr);
        if (r) pending.push([r[1], r[0], r[2], false]);
      }, byType);
    }

    // a group's members, as the platform has computed them: counted per
    // class, in one query for the whole ring, without reading a single CI.
    // An instance populated by a dynamic CI group is such a group itself.
    var groups = of('DCG').concat(of('SI').filter(function (s) {
      return s.ancestors.indexOf('cmdb_ci_query_based_service') >= 0;
    })).map(function (g) { return g.id; });
    if (groups.length) {
      var ga = new GlideAggregate('svc_ci_assoc');
      ga.addQuery('service_id', 'IN', groups.join(','));
      ga.addAggregate('COUNT');
      ga.groupBy('service_id');
      ga.groupBy('ci_id.sys_class_name');
      ga.query();
      while (ga.next()) {
        var group = str(ga.getValue('service_id')), cls = str(ga.getValue('ci_id.sys_class_name'));
        if (!cls) continue;
        out.push({ from: group, rec: membersOf(group, cls, parseInt(ga.getAggregate('COUNT'), 10)), via: 'member' });
      }
    }

    var recs = read(pending.map(function (p) { return p[1]; }));
    pending.forEach(function (p) {
      if (recs[p[1]]) out.push({ from: p[0], rec: recs[p[1]], via: p[2], down: p[3] });
    });
    return out;
  }

  /**
   * Every relationship of a record, of any type, as text: for finding out why
   * the walk leaves something out.
   */
  function describeRelations(id) {
    var out = [];
    ['parent', 'child'].forEach(function (end) {
      var gr = new GlideRecord('cmdb_rel_ci');
      gr.addQuery(end, id);
      gr.query();
      while (gr.next()) {
        var other = end === 'parent' ? gr.child : gr.parent;
        var cls = str(other.sys_class_name);
        out.push((end === 'parent' ? '--[' : '<--[') + str(gr.type.name) + ']-- ' + str(other.getDisplayValue()) +
          ' (' + cls + (cls ? ' < ' + ancestors(cls).join(' < ') : '') + ')');
      }
    });
    return out;
  }

  /** The sys_id of the service offering with this sys_id or number, or ''. */
  function findOffering(key) {
    key = str(key).replace(/^\s+|\s+$/g, '');
    var gr = new GlideRecord('service_offering');
    if (/^[0-9a-f]{32}$/.test(key)) {
      if (gr.get(key)) return str(gr.getUniqueValue());
    } else {
      gr.addQuery('number', key);
      gr.query();
      if (gr.next()) return str(gr.getUniqueValue());
    }
    return '';
  }

  function instance() { return str(gs.getProperty('instance_name')); }

  return { read: read, links: links, describeRelations: describeRelations, findOffering: findOffering, instance: instance, baseUrl: baseUrl };
})();
// ---- end lib/cmdb.js ----
(function () {
  // which copy of the script ran (set by build.js)
  gs.print('bso-transport version ' + (typeof SCRIPT_VERSION === 'undefined' ? 'unbuilt' : SCRIPT_VERSION));
  var isArray = function (x) { return Object.prototype.toString.call(x) === '[object Array]'; };
  if (!isArray(SERVICES) || !SERVICES.length) return gs.print('Fill in SERVICES first: the business services and their offerings to transport.');

  var DEPENDS = 'Depends on::Used by', CONTAINS = 'Contains::Contained by';
  var CHUNK = 200;

  function str(v) { return v == null ? '' : '' + v; }
  function uniq(xs) {
    var seen = {};
    return xs.filter(function (x) { return x && !seen[x] && (seen[x] = true); });
  }
  function values(o) { return Object.keys(o).map(function (k) { return o[k]; }); }
  // Each row of `table` whose `field` is one of `ids`, in chunks; `extra` adds conditions.
  function eachIn(table, field, ids, fn, extra) {
    ids = uniq(ids);
    for (var i = 0; i < ids.length; i += CHUNK) {
      var gr = new GlideRecord(table);
      gr.addQuery(field, 'IN', ids.slice(i, i + CHUNK).join(','));
      if (extra) extra(gr);
      gr.query();
      while (gr.next()) fn(gr);
    }
  }

  // relationship types by their stored name, not their display text
  var typeId = {}, typeName = {};
  eachIn('cmdb_rel_type', 'name', [DEPENDS, CONTAINS], function (gr) {
    typeId[str(gr.getValue('name'))] = str(gr.getUniqueValue());
    typeName[str(gr.getUniqueValue())] = str(gr.getValue('name'));
  });
  // relationships of these types with `end` ('parent' or 'child') one of ids: [{id, parent, child, type}]
  function rels(end, ids, names) {
    var out = [];
    var types = names.map(function (n) { return typeId[n]; }).filter(function (t) { return t; });
    if (!types.length) return out;
    eachIn('cmdb_rel_ci', end, ids, function (gr) {
      out.push({ id: str(gr.getUniqueValue()), parent: str(gr.getValue('parent')), child: str(gr.getValue('child')), type: typeName[str(gr.getValue('type'))] });
    }, function (gr) { gr.addQuery('type', 'IN', types.join(',')); });
    return out;
  }
  var isGroup = function (rec) { return rec.ancestors.indexOf('cmdb_ci_query_based_service') >= 0; };

  // the offerings, service by service; each is checked against its service
  var bsos = [], problems = [], plan = [];
  SERVICES.forEach(function (svc, i) {
    if (!svc || typeof svc !== 'object') return problems.push('SERVICES[' + i + '] is not a service object; left out.');
    var title = (svc.name || '(no name)') + ' (' + (svc.number || 'no number') + ')';
    var svcId = '';
    if (!svc.number) {
      problems.push('The service ' + title + ' has no number, so its offerings are not checked against it.');
    } else {
      var sg = new GlideRecord('cmdb_ci_service');
      sg.addQuery(/^[0-9a-f]{32}$/.test(str(svc.number)) ? 'sys_id' : 'number', str(svc.number));
      sg.query();
      if (sg.next()) {
        svcId = str(sg.getUniqueValue());
        if (svc.name && str(sg.getValue('name')) !== str(svc.name)) problems.push('The service ' + svc.number + ' is called "' + str(sg.getValue('name')) + '" here, not "' + svc.name + '".');
      } else {
        problems.push('No service with number ' + title + ', so its offerings are not checked against it.');
      }
    }
    if (!isArray(svc.offerings) || !svc.offerings.length) return problems.push('The service ' + title + ' has no offerings; nothing to transport for it.');
    var mine = [];
    svc.offerings.forEach(function (o, j) {
      var key = o && typeof o === 'object' ? str(o.number) : '';
      if (!key) return problems.push('Offering ' + (j + 1) + ' of ' + title + ' has no number; left out.');
      var id = Cmdb.findOffering(key);
      var rec = id && Cmdb.read([id])[id];
      if (!rec) return problems.push('No service offering with sys_id or number "' + key + '" (' + (o.name || 'no name') + '); left out.');
      var kind = CsdmWalk.classify(rec);
      if (kind !== 'BSO') {
        return problems.push(rec.name + ' (' + (rec.number || id) + ') is ' +
          (kind ? 'a ' + kind : 'an offering of neither a business nor a technology management service') + ', not a BSO; left out.');
      }
      if (o.name && rec.name !== str(o.name)) problems.push('The offering ' + key + ' is called "' + rec.name + '" here, not "' + o.name + '".');
      if (svcId && rec.parentId !== svcId) problems.push(rec.name + ' (' + rec.number + ') is not an offering of ' + title + '; transported anyway.');
      mine.push(rec.name + ' (' + rec.number + ')');
      if (bsos.every(function (b) { return b.id !== rec.id; })) bsos.push(rec);
    });
    if (mine.length) plan.push(title + ': ' + mine.join(', '));
  });
  problems.forEach(function (p) { gs.print('warning: ' + p); });
  if (!bsos.length) return gs.print('No business service offerings to transport.');

  var exportRels = {}; // sys_id -> true: the cmdb_rel_ci records to export

  // offering -> service instance
  var sis = {}; // sys_id -> {rec, groups: {sys_id: Rec}}
  var bsoRels = rels('parent', bsos.map(function (b) { return b.id; }), [DEPENDS]);
  var children = Cmdb.read(bsoRels.map(function (r) { return r.child; }));
  bsoRels.forEach(function (r) {
    var rec = children[r.child];
    if (!rec || CsdmWalk.typeFrom(rec, 'BSO', r.type) !== 'SI') return;
    exportRels[r.id] = true;
    if (!sis[rec.id]) sis[rec.id] = { rec: rec, groups: {} };
  });

  // the dynamic CI groups populating each instance: related either way, or on its map
  var mapped = Object.keys(sis).filter(function (id) { return !isGroup(sis[id].rec); });
  var pairs = []; // [instance, record]
  rels('parent', mapped, [DEPENDS, CONTAINS]).forEach(function (r) { pairs.push([r.parent, r.child]); });
  rels('child', mapped, [DEPENDS, CONTAINS]).forEach(function (r) { pairs.push([r.child, r.parent]); });
  eachIn('svc_ci_assoc', 'service_id', mapped, function (gr) { pairs.push([str(gr.getValue('service_id')), str(gr.getValue('ci_id'))]); });
  var linked = Cmdb.read(pairs.map(function (p) { return p[1]; }));
  pairs.forEach(function (p) {
    var rec = linked[p[1]];
    if (rec && isGroup(rec) && sis[p[0]]) sis[p[0]].groups[rec.id] = rec;
  });

  // every dynamic CI group record: the groups, and instances stored as groups
  var dcigs = {};
  values(sis).forEach(function (s) {
    if (isGroup(s.rec)) dcigs[s.rec.id] = s.rec;
    values(s.groups).forEach(function (g) { dcigs[g.id] = g; });
  });

  // tech offering Contains instance or group
  var reached = Object.keys(sis).concat(Object.keys(dcigs));
  var tmsoRels = rels('child', reached, [CONTAINS]);
  var parents = Cmdb.read(tmsoRels.map(function (r) { return r.parent; }));
  tmsoRels.forEach(function (r) {
    if (parents[r.parent] && CsdmWalk.classify(parents[r.parent]) === 'TMSO') exportRels[r.id] = true;
  });

  // the CMDB groups behind the dynamic CI groups, and their encoded queries
  var groups = [], noGroup = [];
  eachIn('cmdb_ci_query_based_service', 'sys_id', Object.keys(dcigs), function (gr) {
    var g = str(gr.getValue('cmdb_group'));
    if (g) groups.push(g);
    else noGroup.push(str(gr.getValue('name')));
  });
  groups = uniq(groups);
  var queries = [];
  eachIn('cmdb_group_contains_encoded_query', 'group', groups, function (gr) { queries.push(str(gr.getUniqueValue())); });
  // other ways of filling a group that the lists below leave out
  var groupName = {};
  eachIn('cmdb_group', 'sys_id', groups, function (gr) { groupName[str(gr.getUniqueValue())] = str(gr.getValue('group_name')); });
  var other = {};
  [['cmdb_group_contains_qb_query', 'saved queries'], ['cmdb_group_contains_ci', 'manually added CIs']].forEach(function (t) {
    eachIn(t[0], 'group', groups, function (gr) {
      var g = str(gr.getValue('group'));
      other[g + '|' + t[1]] = (groupName[g] || g) + ' also has ' + t[1] + ' (' + t[0] + '), which this export leaves out.';
    });
  });

  // the lists, one per table; the instances per class, as XML is imported per table
  var source = Cmdb.baseUrl();
  var plain = function (n) { return /^[a-z0-9][a-z0-9-]*$/i.test(n); };
  var targetName = plain(str(TARGET_INSTANCE)) ? str(TARGET_INSTANCE) : Cmdb.instance();
  var target = plain(targetName) ? 'https://' + targetName + '.service-now.com/' : '';
  var on = targetName || 'the target';
  var byClass = {};
  values(sis).forEach(function (s) {
    if (!isGroup(s.rec)) (byClass[s.rec.table] = byClass[s.rec.table] || []).push(s.rec.id);
  });
  var lists = [
    ['cmdb_group', groups],
    ['cmdb_group_contains_encoded_query', queries],
    ['cmdb_ci_query_based_service', Object.keys(dcigs)]
  ];
  Object.keys(byClass).sort(function (a, b) {
    return (a === 'cmdb_ci_service_discovered' ? -1 : b === 'cmdb_ci_service_discovered' ? 1 : a < b ? -1 : 1);
  }).forEach(function (cls) { lists.push([cls, byClass[cls]]); });
  lists.push(['cmdb_rel_ci', Object.keys(exportRels)]);

  var listUrl = function (table, ids) {
    var q = 'sys_idIN' + ids.slice().sort().join(',');
    return (source ? source + table + '_list.do?sysparm_query=' + encodeURIComponent(q) : table + ' filtered on ' + q);
  };

  var counts = [values(sis).length + ' service instances', Object.keys(dcigs).length + ' dynamic CI groups',
    groups.length + ' CMDB groups', queries.length + ' encoded queries', Object.keys(exportRels).length + ' relationships'];
  gs.print('Transport of ' + bsos.length + ' offering' + (bsos.length > 1 ? 's' : '') + ': ' + counts.join(', ') + '\n' +
    plan.map(function (l) { return '  ' + l; }).join('\n'));
  noGroup.forEach(function (n) { gs.print('warning: the dynamic CI group ' + n + ' has no CMDB group.'); });
  values(other).forEach(function (w) { gs.print('warning: ' + w); });

  var out = ['', '--- 1. Export from ' + (Cmdb.instance() || 'this instance') + ': open each list, right-click a column header › Export › XML ---'];
  lists.forEach(function (l, i) {
    out.push((i + 1) + '. ' + l[0] + ' (' + l[1].length + ')');
    out.push('   ' + (l[1].length ? listUrl(l[0], l[1]) : 'nothing to export'));
  });
  var last = lists.length;
  out.push('', '--- 2. Import on ' + on + ': right-click a column header in any list › Import XML, files 1–' + (last - 1) + ' in this order ---');
  out.push('', '--- 3. Add the dynamic CI groups to each service instance on ' + on + ' ---');
  out.push('Open it (or find it under CSDM › Manage Technology Management Services › Application Service), then on the Populate the Application Service tab:');
  values(sis).sort(function (a, b) { return a.rec.name < b.rec.name ? -1 : 1; }).forEach(function (s) {
    var link = target ? ' ' + target + s.rec.table + '.do?sys_id=' + s.rec.id : '';
    var names = values(s.groups).map(function (g) { return g.name; }).sort();
    if (isGroup(s.rec)) {
      out.push('- ' + s.rec.name + ': populated by the Dynamic CI Group method; its group comes with file 3. Nothing to do.');
    } else if (s.rec.table !== 'cmdb_ci_service_discovered') {
      out.push('- ' + s.rec.name + link + ': a ' + s.rec.classLabel + ' (' + s.rec.table + '), not a manually populated instance. Check its population by hand.');
    } else if (!names.length) {
      out.push('- ' + s.rec.name + link + ': no dynamic CI groups found on it. Compare its map with the source by hand.');
    } else {
      out.push('- ' + s.rec.name + link);
      out.push('    Choose Manual, Class "Dynamic CI Group", CI "' + names[0] + '".');
      if (names.length > 1) out.push('    Then Add Method and do the same for: ' + names.slice(1).map(function (g) { return '"' + g + '"'; }).join(', ') + '.');
      out.push('    Save.');
    }
  });
  out.push('', '--- 4. Then import file ' + last + ' (cmdb_rel_ci) on ' + on + ' ---');
  out.push('', '--- 5. Check each instance\'s map against the source, and that no relationship is there twice ---');
  gs.print(out.join('\n'));
})();
