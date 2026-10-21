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
