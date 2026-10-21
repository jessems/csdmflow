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
