# @sixb/pg

PostgreSQL storage provider for Sixb.

One shared connection pool (porsager `postgres`) backs every Sixb store: objects, ontology commits,
auth, agents, the immutable execution and AI usage ledgers, timeseries, and the run history for
actions, syncs, pipelines, projections, workflows, webhooks, and managed connector connections.
This is the provider to use for anything you intend to operate.

## Install

```bash
bun add @sixb/pg
```

## Usage

```ts
import { PostgresStorage } from "@sixb/pg"
import { createSixb } from "@sixb/core"

const storage = new PostgresStorage({
  connectionString: process.env.DATABASE_URL,
})

export const sixb = createSixb({ storage, broker })
```

All Sixb tables live in one schema, `sixb` by default. Set `schemaName` to share a database with
other applications; it is pinned through `search_path` on every pooled connection.

## Migrations

`PostgresStorage` exposes core's `StorageMigrator` contract. The CLI runs it at startup and
`sixb db migrate` runs it on demand — you do not write migrations, they ship inside this package.

Applied migrations are checksummed. Schema changes ship as new ordered steps; changing an already
applied step fails startup instead of silently rewriting migration history. Before 1.0, an explicitly
breaking migration may still require recreating the database. `dropSchema()` exists for exactly
that, and for test teardown — it deletes every Sixb table and the schema itself.

## Vector profiles

Named `search.vectors` profiles persist by default after the standard migrations. Embeddings
and provenance live in `object_vectors`, using native `real[]` values; pgvector is not required.

```ts
await sixb.objects(Product).byId("product-1").vector("content").index()
```

Generation runs outside the transaction. The subsequent write checks object and vector revisions;
source changes invalidate affected profiles atomically, including projection updates. Reindexing
leaves the business object's version and events unchanged.

Search requires pgvector installed in the `public` schema by the database administrator:

```sql
CREATE EXTENSION vector WITH SCHEMA public;
```

```ts
const result = await sixb.objects(Product).query()
  .vector("content", "lightweight running shoes", { k: 10 }).list()
```

The exact cosine search applies filters and source-property permissions before ranking.
Sixb normalizes stored and query vectors to unit length. At most 10,000 eligible vectors and
16 million coordinates may be scored per search; larger queries fail explicitly. Configure
`statementTimeoutMillis` to bound SQL execution time.

Projections refresh embeddings in the background. Use `index()` to index existing objects after
adding or changing a profile, or to retry explicitly.

Tested with pgvector 0.8.1; no approximate index is created.

## Pooling and timeouts

| Option | Default | Why you would set it |
| --- | --- | --- |
| `maxConcurrentAggregates` | `1` | Root count/facet calculations admitted at once; keep below `max` to leave connections for pages. Increase for larger database CPUs after measuring. |
| `max` | `10` | Pool size. Size it per role, not per project — an API replica and a worker each get their own pool. |
| `statementTimeoutMillis` | unset | A single stalled query can otherwise pin its connection until the process restarts. Keep it generous or unset for workers that run long bulk writes. |
| `idleInTransactionSessionTimeoutMillis` | unset | Aborts transactions left open and idle, releasing the connection. |
| `idleTimeoutMillis` | `30000` | Returns idle connections to the server. |
| `connectTimeoutMillis` | `10000` | Fail fast when the database is unreachable. |
| `shutdownTimeoutMillis` | `5000` | `close()` stops accepting queries and waits this long for in-flight work, so a restart drains instead of severing live writes. |

Call `close()` on shutdown.

### Behind a connection pooler

`prepare` defaults to `true`, which is correct for a direct connection. In PgBouncer transaction
mode, server-side prepared statements need PgBouncer >= 1.21 with `max_prepared_statements > 0`; set
`prepare: false` for an older PgBouncer, or when that setting is `0`.

## Transactions

```ts
await storage.transaction(
  async (tx) => {
    // Use `tx`, never the root storage — the root throws inside a transaction callback.
  },
  { isolation: "serializable" }
)
```

Nested transactions are rejected. A serialization conflict or deadlock surfaces as a
`StorageTransactionError` with `code: "serialization_failure"`, which is the signal that the
operation is safe to retry.

## Preparing queries

Declare query capabilities on properties and recurring compound access patterns on the object type:

```ts
const User = defineObjectType({
  id: "User",
  name: "User",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("status", "string", { query: { searchable: true, filterable: true, facet: true } }),
    prop("createdAt", "timestamp", { query: { searchable: true, sortable: true } }),
    prop("searchText", "string", { query: { searchable: true, text: true } }),
  ],
  query: {
    indexes: [
      { kind: "sort", fields: [{ propertyId: "createdAt", direction: "desc" }] },
      {
        kind: "sort",
        fields: [{ propertyId: "createdAt", direction: "desc" }],
        filters: ["status"],
      },
      { kind: "text", propertyId: "searchText", filters: ["status"] },
    ],
  },
})
```

Sixb prepares declared query structures automatically after schema migrations, before its
CLI development runtime or production services start. `bun sixb db migrate` performs both steps;
`bun sixb db prepare` remains available for explicit preparation. `--no-migrate` and
`SIXB_SKIP_MIGRATION=1` disable both steps for production services when a separate release step
has already run them. No index is built in a request handler.

Custom runtimes can opt into the same lifecycle with:

```ts
await migrateStorage(storage, {
  projectId: sixb.id,
  ontology: sixb.definitions.ontology,
})
```

Passing only `storage` retains schema-only migration. Providers without query preparation,
including SQLite and in-memory storage, continue normally; explicitly calling
`prepareObjectQueries` or `db prepare` on them reports the unsupported capability.

Each project database has one preparation record, enforced by a singleton key. PostgreSQL records
the completed declaration fingerprint there. Unchanged declarations need one small
read, without index DDL, statistics refreshes, or object-table locks. Concurrent
instances serialize changed preparation and recheck completion before doing work, including with
a single-connection pool. Completion is recorded only after every step succeeds; failures stop
startup and are surfaced. Indexes are additive across rolling releases.
A removed declaration does not remove its physical structures. The completion record assumes
framework-owned structures have not been manually dropped or changed.

**Allow maintenance time for the initial preparation.** To avoid doing it at service startup,
run `bun sixb db migrate` before starting the new release. Ordinary indexes build concurrently. A text
hint also adds STORED generated columns: the initial call rewrites the objects table under an
exclusive lock.
Provide all definitions together, allow temporary disk headroom, and measure projection throughput.
Preparation attempts to install `pg_trgm` in `public`; the database administrator must provide that
extension when the maintenance role cannot install it.

Preparation creates access paths for enabled filter, sort and text operations, incoming links,
and the explicitly declared combinations. Compound sort filters are string equality prefixes;
queries without those filters need an unfiltered index too. Primary identity predicates use the
existing primary key through the core query planner. Unsupported dedicated scalar indexes produce
warnings and keep the exact general query path.

Identical preparation is repeatable. Definitions are additive: removing an ontology hint does
not drop existing indexes or generated columns. Retire obsolete structures through explicit
PostgreSQL maintenance after coordinating application versions. An interrupted invalid index build
is reported with repair instructions. Low-level `ensureObjectQueryIndexes` and
`prepareObjectTextCounts` remain available for provider-specific maintenance and experiments;
application configuration should use ontology declarations.

### Pages, search and totals

Use `list({ includeTotal: false })` for independently loaded pages. Existing cursor pagination
uses ordered index ranges, including deep pages. Incoming relationship pages can choose an ordered
endpoint scan after a bounded fanout probe; aggregates use their own execution plan.

Search remains literal, case-insensitive substring search, including `%`, `_` and `\` characters.
Trigrams accelerate selective terms; short or very common terms still require scanning. A text
hint provides a compact covering representation for broad exact counts and facets. Its normal path
covers text up to 1024 UTF-8 bytes and each filter up to 128 bytes; longer values remain valid and
are included through an exact overflow path. Sort indexes also separate oversized entries from
the bounded ordered index. No truncation changes results.

To load multiple facet counts and the matching total together:

```ts
const { total, facets } = await sixb.objects(User).query()
  .search("martin", { fields: [User.p.searchText] })
  .facets([{ property: User.p.status, limit: 100 }])
```

`total` counts all matching objects, including those without the facet property. Facet limits
truncate buckets, never the total. Explicit null is a bucket; missing properties are not. Do not
sum truncated buckets to infer the total, or treat an omitted bucket as necessarily zero.
This changes the earlier array-only `.facets()` result; SDK consumers now read `.facets` on the
returned object. The HTTP response adds `total` alongside its existing `facets` member.

Totals and facet buckets are calculated from current objects on each request. No aggregate
state tables, counter triggers or result caches participate in reads or writes. Compact text
indexes can reduce scan work, but broad exact counts still cost CPU on every request, including
repeated identical searches.

Root count/facet calculations queue before reserving a connection, including totals requested
with a page. `maxConcurrentAggregates` defaults to one per storage instance; use a pool of at least
two to leave capacity for independent page requests. Selected scopes and transaction-bound
readers preserve their own exact execution paths. Index maintenance still adds write work;
benchmark mixed reads and writes for your workload. Small projection deltas
rely on autovacuum for routine statistics maintenance; a first bulk publication or a substantial
replacement refreshes statistics synchronously.

The generic whole-document JSON GIN index is removed by migration 055: framework predicates use
property expressions, not whole-document containment. Applications running custom containment SQL
may choose their own suitable index.

See [the reproducible benchmark](benchmarks/README.md) for resources, synthetic data, SDK queries,
concurrent screens, relationship traversal and real projection measurements.
