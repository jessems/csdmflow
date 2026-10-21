// BSO cluster — everything around one service offering, as a csdmflow diagram.
//
// Paste tools/bg-scripts/paste/bso-cluster.js (not this file) into
// Scripts - Background, global scope, set ROOT and run it. It reads, never
// writes. It prints:
//   1. the csdmflow source, ready for the playground or a .csdm file
//   2. a playground link that opens it
//   3. the csdm-graph JSON on one line, for tools that want the data
//      (node tools/bg-scripts/lib/csdm-graph.js export.txt turns it back into source)
//
// What it walks to is set by lib/walk.js, the same rules as the ITFM 2.0
// Inspector: the offering's service (and its portfolio), its service
// instances, their applications, tech offerings and dynamic CI groups, the
// groups' tech offerings and members (counted per class, not read), the tech
// offerings' services and other groups, and each instance's service map,
// downwards.

var ROOT = '';            // the business service offering's sys_id or number, e.g. 'SO0001234'
var LAYOUT = '';          // '' (csdmflow's default), 'cross', 'tiers', 'row' or 'lanes'
var MAX_CI_DEPTH = 5;     // hops a service map is followed below its instance
var DEBUG = false;        // also print the offering's relationships and every link left out, and why

//#include lib/csdm-graph.js
//#include lib/walk.js
//#include lib/cmdb.js

(function () {
  if (!ROOT) return gs.print('Set ROOT to a service offering\'s sys_id or number first.');
  var rootId = Cmdb.findOffering(ROOT);
  var root = rootId && Cmdb.read([rootId])[rootId];
  if (!root) return gs.print('No service offering with sys_id or number "' + ROOT + '".');
  var kind = CsdmWalk.classify(root);
  if (kind !== 'BSO') {
    return gs.print(root.name + ' (' + (root.number || rootId) + ') is ' +
      (kind ? 'a ' + kind : 'an offering of neither a business nor a technology management service') + ', not a BSO. Please provide a BSO.');
  }

  var b = CsdmGraph.builder({ script: 'bso-cluster', instance: Cmdb.instance(), baseUrl: Cmdb.baseUrl(), generatedAt: new Date().toISOString(), root: rootId });
  var started = new Date().getTime();
  var skipped = [];
  var g = CsdmWalk.walk(root, Cmdb.links, b, {
    maxCiDepth: MAX_CI_DEPTH,
    skipped: function (l, why) {
      var from = b.node(l.from);
      skipped.push((from ? from.name : l.from) + ' -[' + l.via + ']- ' + (l.rec.name || l.rec.table) + ' (' + l.rec.table + '): ' + why);
    }
  });
  if (DEBUG) {
    gs.print('--- relationships of ' + root.name + ' (' + root.table + ', parent ' + (root.parentAncestors || ['?'])[0] + ') ---\n' +
      (Cmdb.describeRelations(rootId).join('\n') || '(none)'));
    gs.print('--- left out ---\n' + (skipped.join('\n') || '(nothing)'));
  }

  var source = CsdmGraph.toCsdm(g, { layout: LAYOUT || undefined });
  var counts = {};
  g.nodes.forEach(function (n) { counts[n.type] = (counts[n.type] || 0) + 1; });
  gs.print('BSO cluster of ' + root.name + ': ' + Object.keys(counts).map(function (t) { return counts[t] + ' ' + t; }).join(', ') +
    ' (' + ((new Date().getTime() - started) / 1000).toFixed(1) + ' s)');
  g.warnings.forEach(function (w) { gs.print('warning: ' + w); });
  gs.print('--- csdmflow ---\n' + source);
  gs.print('--- playground ---\n' + CsdmGraph.playgroundUrl(source));
  gs.print('--- csdm-graph ---\n' + JSON.stringify(g));
})();
