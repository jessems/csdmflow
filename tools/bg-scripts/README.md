# Background scripts

Scripts to paste into **System Definition › Scripts - Background** (global
scope) on a ServiceNow instance. Each one reads part of the CMDB and prints
it as a csdmflow diagram. They only read and never write. These files are not
part of the npm package.

The easiest way to get one is the [Tools page](https://jessems.github.io/csdmflow/tools.html):
**Copy script** puts the paste-ready file on your clipboard.

**Paste the file in [`paste/`](paste/), not the one beside this README.** A
background script has to be one block, so `npm run bg-scripts` builds each
script with its `//#include`d libraries inlined.

| Script | Starts from | Draws |
|---|---|---|
| [`bso-cluster.js`](bso-cluster.js) | a business service offering's sys_id or number (`ROOT`); a tech offering is refused | the offering, its business service and portfolio, its service instances, their applications, tech offerings and dynamic CI groups, the groups' tech offerings and members, and each instance's service map |

## What gets walked

[`lib/walk.js`](lib/walk.js) decides which records belong in a picture. It uses
the same rules as the ITFM 2.0 Inspector (`src/server/graph/model.ts`), so a
script and the inspector draw the same cluster:

- **`FOLLOW`**: which types each type leads on to. From an offering the walk
  reaches its service but never that service's other offerings.
- **`LINKS`**: which relationship types count for each pair of types, by their
  stored name. The query asks only for those types.
- **Service maps** are read downwards from an instance, at most `MAX_CI_DEPTH`
  hops. Going up from a shared server would pull in other applications.
- **A group's members** are counted per class, not read. One `GlideAggregate`
  on `svc_ci_assoc` (which the platform keeps up to date) covers every group in
  a ring. Each class becomes one box, "Windows Server" / "1'250 CIs", and the
  walk doesn't continue from it.
- **A Dynamic CI Group record** is an instance when a business offering
  reaches it and a group when a tech offering does. ServiceNow stores an
  application service populated by the Dynamic CI Group method in the group
  table itself.
- **Offerings** are business or tech offerings depending on the class of their
  parent service. Services that are neither stay out.

[`lib/cmdb.js`](lib/cmdb.js) feeds the walk from the instance. It reads one
ring of records at a time, so a ring of 200 CIs takes a few queries, not
hundreds.

Each script prints three things:

1. **The csdmflow source.** Paste it into the
   [playground](https://jessems.github.io/csdmflow/) or save it as a `.csdm` file.
2. **A playground link** that opens the diagram directly. It is long when the
   cluster is big.
3. **The csdm-graph JSON** on one line. This is the data behind the diagram.
   To turn copied output back into source, maybe with another layout, run:
   ```sh
   node tools/bg-scripts/lib/csdm-graph.js output.txt --layout tiers > cluster.csdm
   ```

## The csdm-graph format

Every script builds the same intermediate format. The JSDoc types in
[`lib/csdm-graph.js`](lib/csdm-graph.js) define it, and `CsdmGraph.validate`
checks a graph against them.

```json
{
  "format": "csdm-graph",
  "version": 1,
  "source": { "script": "bso-cluster", "instance": "dev12345", "generatedAt": "2026-10-21T07:02:36Z", "root": "<sys_id>" },
  "nodes": [
    { "id": "<sys_id>", "type": "BSO", "name": "Email Standard", "table": "service_offering", "number": "SO0001" },
    { "id": "<sys_id>", "type": "CI", "name": "ex01", "table": "cmdb_ci_win_server", "className": "Windows Server" }
  ],
  "edges": [
    { "from": "<sys_id>", "to": "<sys_id>", "via": "cmdb_rel_ci", "rel": "Depends on::Used by" }
  ],
  "warnings": []
}
```

- **Nodes are CMDB records.** `id` is the record's sys_id. `type` is one of
  csdmflow's entity types (`BC BA SI TMS TMSO DCG CI BSO BS SP`).
- **Edges point from parent to child, the way ServiceNow stores them.** Examples:
  `cmdb_rel_ci` parent → child, an offering → its `parent` service, a service
  → its portfolio, a group → its member. `via` says where the link came from:
  `cmdb_rel_ci`, `parent`, `portfolio`, `svc_ci_assoc` or `dcg_member`. csdmflow turns each pair the CSDM way round
  when it draws.
- **The graph holds raw data, not layout decisions.** `CsdmGraph.toCsdm` makes
  those choices: it picks readable ids, quotes names, and merges CIs that have
  the same class and the same neighbours into one stacked box. The box title
  carries the count ("Windows Server (12)"), and past four names the list
  ends in "…". A node with a `count` stands in for that many CIs of its class
  (a group's members). Its id is made up and its name is empty.

## Adding a script

1. Create `tools/bg-scripts/<name>.js`:
   - Put the settings at the top, then the `//#include` lines for
     `lib/csdm-graph.js`, `lib/walk.js` and `lib/cmdb.js` (in that order),
     then the body in an IIFE.
   - Build the graph with `CsdmGraph.builder(...)`, usually through
     `CsdmWalk.walk`, and print it with the same three sections
     `bso-cluster.js` uses.
2. Write ES5 only: `var`, `function`, no arrows or template strings. Global
   background scripts run ES5. `npm test` checks this.
3. Run `npm run bg-scripts` and commit the file it writes to `paste/`. `npm test`
   fails while a file in `paste/` is out of date.
4. Add a mocked-instance test to [`test/bg-scripts.js`](../../test/bg-scripts.js).
   `bso-cluster`'s test shows how to mock the instance.
