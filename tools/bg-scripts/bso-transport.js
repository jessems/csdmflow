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

//#include lib/csdm-graph.js
//#include lib/walk.js
//#include lib/cmdb.js

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
