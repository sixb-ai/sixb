# @sixb/ducklake

Durable Sixb `LakeStorage` provider backed by DuckDB and the DuckLake
extension.

DuckLake owns physical tables, Parquet files, transactions, snapshots, and time
travel. Sixb keeps ownership of dataset ids, dataset-definition compatibility,
version shape, producer metadata, and `fileRef` values.

## Usage

```ts
import { DuckLakeStorage } from "@sixb/ducklake"

const lakeStorage = new DuckLakeStorage({
  catalog: {
    type: "duckdb",
    path: ".sixb/lake/metadata.ducklake",
  },
  dataPath: ".sixb/lake/data",
})

await lakeStorage.close()
```

## Runtime and Connections

`DuckLakeStorage` creates one embedded DuckDB runtime for each provider
instance. DuckLake attaches lazily on the first lake operation, so constructing
the provider does not immediately open catalog connections.

Within one provider instance, DuckDB work is queued on that runtime. This keeps
writes, SQL transforms, and metadata reads predictable and keeps PostgreSQL
connection use bounded.

```txt
one DuckLakeStorage instance
  -> one DuckDB runtime
  -> one DuckLake attachment
  -> one bounded PostgreSQL extension pool, when catalog.type is "postgres"
```

For PostgreSQL catalogs, `postgresPool.maxConnections` is a per-instance budget.
If four production processes each create a `DuckLakeStorage` with
`maxConnections: 4`, the deployment can use about sixteen PostgreSQL catalog
connections for DuckLake metadata.

```ts
const lakeStorage = new DuckLakeStorage({
  catalog: { type: "postgres", host, database, user, password },
  dataPath: "s3://sixb-lake/data",
  duckdb: {
    config: {
      threads: "1",
    },
  },
  postgresPool: {
    maxConnections: 4,
    idleTimeoutMillis: 1_000,
    enableThreadLocalCache: false,
  },
})
```

Use `close()` during service shutdown so DuckDB can close its runtime and release
catalog connections cleanly.

### Extensions

On first use, the provider installs DuckLake and the extensions its catalog,
data path and secrets need. A missing extension is downloaded over HTTPS from
`https://extensions.duckdb.org` into DuckDB's extension directory
(`duckdb.config.extension_directory`, `~/.duckdb/extensions` by default), so a
host that allows only that HTTPS domain, such as a restricted Vercel sandbox,
can open a lake. When that download fails, the provider logs a warning and
DuckDB's own `INSTALL` downloads the extension over plain HTTP, as before.
With `custom_extension_repository` set, DuckDB installs from that repository
alone.

### Pinned DuckDB and DuckLake builds

`@duckdb/node-api` is pinned to an exact version (DuckDB 1.5.6), and the provider refuses to
attach with any DuckLake extension build but `ac7595b0`. DuckDB's extension repository serves one
build per DuckDB version and can replace it, so without the check a deploy would run whatever
build it downloaded that day. A runtime that loads another build fails before attaching, naming
both builds. Keep the tested build in the image's DuckDB extension directory
(`duckdb.config.extension_directory`) to make deploys independent of the repository.

### Maintenance

DuckLake keeps every snapshot, and every file a snapshot reads, until retention removes them.
`lakeStorage.maintenance` implements core's `LakeMaintenance`:

```ts
const report = await lakeStorage.maintenance.applyRetention({
  keepVersionsForMs: 7 * 24 * 60 * 60 * 1000, // default; at least 1 hour
  deleteFilesAfterMs: 7 * 24 * 60 * 60 * 1000, // default; at least 1 hour
  protect: [{ datasetId: "invoices", versionId: "ducklake:42" }],
})
// { expiredVersions, keptVersions, deletedFiles, orphanedFiles, hasMore, ... }

const health = await lakeStorage.maintenance.describeStorage(["invoices"])
// [{ dataFiles, smallDataFiles, deleteFiles, inlinedRows, retainedSnapshots, warnings, ... }]
```

`sixb lake cleanup` runs one pass, protecting the version each projection applied.

**What expires.** A version's age counts from the commit that replaced it, not its own: a version
expires once a newer version of its dataset has been there for `keepVersionsForMs`. A pipeline
step resolves its inputs' latest versions when it starts and reads them by id, so whatever it
resolved stays readable for that long, with nothing recorded. Each dataset's latest version and
the `protect` versions never expire; protected ones past retention are reported as
`keptVersions`. Snapshots holding no version (maintenance commits, catalog-only changes) expire
once they are older than `keepVersionsForMs`, except the newest snapshot.

**One pass is bounded.** The pass walks the history oldest first, 512 snapshots per catalog
query, and stops at the retention cutoff or once `limit` (1,000) snapshots are expirable, which
it expires by id in one call. It then deletes the files DuckLake scheduled at least
`deleteFilesAfterMs` ago, oldest first and about `limit` at most (files one commit scheduled go
together). `hasMore` says another pass has work. Orphaned files, which no catalog row knows, are
searched only on a pass with no backlog left, since the search lists the whole data path. Expiry
is catalog-only and takes no lock on reads; only file deletion waits for this provider's reads,
for as long as the deletion itself.

Two passes may overlap, from two processes on a PostgreSQL catalog: the step that loses a race
for the same rows or files yields, and the report says `hasMore`.

`deleteFilesAfterMs` is at least an hour, for both deletions. A write in another process puts its
files in the data path before it commits, where no catalog row knows them yet: deleting orphans
younger than that left a committed version unreadable. Reads in other processes are not waited
for either.

On a SQLite catalog, DuckLake `ac7595b0` compares stored schedule times with a given time
unreliably outside UTC (west of UTC it deleted files scheduled a moment ago), so files there are
deleted all at once, and only once every scheduled file is due.

### Automatic Compaction

Small writes leave small storage behind: a write of up to 10 rows is inlined in the catalog, a
larger one writes a Parquet file, and replacing rows of a file adds a delete file. The provider
compacts a dataset on its own, in the process that wrote, after the commits that need it. Nothing
is configured.

- **When.** After a dataset's first commit in a provider, then after every 8th, the provider reads
  the dataset's catalog rows (three or four queries, no data). A pass runs only past a threshold:
  1,000 inlined rows, a data file with a tenth of its rows deleted, or 16 files under 1 MiB.
- **What.** A first maintenance commit flushes inlined rows to files. A second rewrites the files
  with a tenth of their rows deleted, then merges files under 1 MiB, at most 256 per pass. A
  backlog takes several passes, one after the other.
- **Never a version.** DuckLake records these commits as `inline_flush`, `rewrite_delete` and
  `merge_adjacent`, which change no rows: they are not versions, the change feed skips them, and
  every retained version reads the same rows through the new files. Whoever runs them, by hand
  included, the rule is the same.
- **Never in a write's way.** The version is committed and returned first; the commit only
  schedules the check. One compaction runs per dataset at a time; commits meanwhile get one more
  pass. A failure goes to a `[SixbDuckLake]` warning, never to the write. Each maintenance commit
  takes the catalog commit lock like a write, so writes in the same process wait for one short
  commit at most. A compaction that conflicts with another process's write fails at once and
  yields; the next check tries again. `close()` lets the current pass finish and starts no other.

The thresholds come from measurements on DuckDB 1.5.6 with a local catalog: with 16 small files
or 4,000 inlined rows, reads cost what they cost compacted; with 256 files a full read took half
as long again, with 1,024 three times as long and a one-row append twice as long. One merge or
flush took 20–70 ms. On object storage, every file is also one more request per read.

A partitioned dataset holding under about a million rows gets a warning once per process, and in
`describeStorage`: each write adds a file per partition it touches, and merges stay within a
partition.

### Read and Write Concurrency

Large reads stream through dedicated connections in the same DuckDB engine, sharing its memory
budget and PostgreSQL metadata pool. Metadata and writes remain available between yielded rows.
Each read stays pinned to one immutable snapshot. Retention's file deletion waits until no reads
remain; it blocks new reads only while deleting, so continuous traffic can postpone it.

`readChanges` compares two versions in DuckDB. When no version between them changed rows
(`rowsChanged` in the commit metadata, read from at most 32 snapshots), it returns an empty change
set without reading the table.

`maxStreamingReads` limits native streaming readers per provider (default: `4`); extra reads use
bounded pages on the main connection. It does not limit pipeline inputs. Raise it when memory and
catalog capacity allow. Finish the iterator, use `for await` with `break`, or pass `signal` to cancel
it. Projection and pipeline workers propagate their cancellation automatically.

Small previews, SQLite/custom catalogs, and PostgreSQL reads without sufficient pool headroom
use bounded pages. PostgreSQL streaming admits at most `maxConnections - 4` cursors to leave
headroom for metadata and writes. Parallel scans can exceed the pool's cache limit, so this does
not guarantee a server-wide connection count.

Every engine uses its own spill subdirectory under `duckdb.config.temp_directory` (default:
`.tmp` for an in-memory engine). Closing it removes only that subdirectory. Sharing spill filenames
between engines can corrupt results. An empty `temp_directory` still disables spilling.

A write does not hold the runtime while its source iterable is producing rows.
`writeRows(...)` validates and stages rows in bounded in-memory batches, then
takes a queue slot only to flush each batch into the staging table. Slow external
reads (pagination, APIs, SFTP, retries) run outside the queue, so other reads and
write batches can interleave between a write's batches. Large in-memory writes
also yield to the event loop between batches.

Datasets must declare a schema before they can be stored in DuckLake:

```ts
import { col, defineDataset, defineSync } from "@sixb/core"

const rawOrdersDataset = defineDataset("raw.erp.orders", {
  schema: [
    col("orderId", "string"),
    col("customerId", "string", { nullable: true }),
    col("total", "float64", { nullable: true }),
    col("createdAt", "timestamp", { nullable: true }),
    col("raw", "json", { nullable: true }),
  ],
  partitionBy: ["createdAt"],
  description: "Raw ERP order rows",
})

export const syncOrders = defineSync("sync-orders")
  .from(erp)
  .read(readOrders)
  .intoDataset(rawOrdersDataset)
```

`intoDataset(...)` takes the dataset definition, not a dataset id and options.
Export the definition from `datasets/` or pass it to
`createSixb({ datasets: [rawOrdersDataset], ... })` so the runtime and worker
use the same schema that DuckLake materializes.

DuckLake stores Sixb `decimal` columns as `DECIMAL(38, 9)` and returns them as exact strings, including from SQL previews. Writes that need more than 29 integer digits or 9 fractional digits are rejected before DuckDB can round or overflow them.

## Keyed Merges

Datasets with a primary key can apply ordered complete-row changes directly through the lake
provider. Key columns must be non-null strings; composite key order is significant.

```ts
import { change, col, defineDataset } from "@sixb/core"

const invoices = defineDataset("erp.invoices", {
  schema: [
    col("id", "string"),
    col("status", "string"),
    col("customerId", "string"),
  ],
  primaryKey: "id",
})

await lakeStorage.createDataset(invoices)

const merge = await lakeStorage.beginMerge({ dataset: invoices })
await merge.writeChanges([
  change.upsert({ id: "inv_1", status: "paid", customerId: "cust_1" }),
  change.delete({ id: "inv_2" }),
])
const result = await merge.commit()
```

For datasets without `sequenceBy`, changes remain ordered across `writeChanges(...)` calls, and the final change for a repeated key
wins. Upserts are complete rows rather than patches. Commit checks the dataset version captured by
`beginMerge`, applies effective changes atomically, and creates a version only when visible rows
change. An initial no-op returns `{ outcome: "unchanged", version: null }`; a later no-op returns the
existing latest version.

Datasets declaring `sequenceBy` instead compare source revisions: older changes are ignored,
identical ties are unchanged, and conflicting ties abort the merge. Deletes require
`change.delete(key, { sequence })`. Source revisions and deletion tombstones are stored in a
companion DuckLake table in the same transaction as visible rows, surviving snapshot expiration.
New tombstone state creates a version even when the visible rows stay the same; such a version
records `rowsChanged: false`. So does a newer upsert that differs from the stored row only in its
`sequenceBy` column: the row is kept and only its source revision advances. Sequenced provider
writes use merge sessions; snapshot syncs convert rows to ordered upserts.
Snapshot syncs use `commit({ createInitialVersion: true })` to make a first empty result
addressable. Later no-op commits reuse the current version, including after a concurrent write.
Use `commit({ retryOnConflict: true })` to rebase retained changes, with at most 3 attempts.
Explicit `expectedLatestVersionId` guards are never relaxed.
See [source ordering](../../docs/datasets/source-ordering.md).

Local catalogs serialize commits within one process. PostgreSQL catalogs support concurrent
writer processes. DuckLake commits a transaction on top of versions committed since it began
unless one of them altered the table or deleted rows it touches, so a write that missed a
concurrent version could keep that version's rows but record what it read before them. Such a
version claims its table, an idempotent comment update that makes any later concurrent write
conflict:

- a version whose lineage carries dependencies on other datasets, or is unknown, so no later
  write records a lineage without them;
- a keyed append or merge, because DuckLake has no primary key and two writes of one new key
  would both commit;
- a write into an empty dataset, because a snapshot that also read it empty would keep its rows;
- a version that changes no rows (new provenance), which also gives it a DuckLake snapshot.

Each claim bumps DuckLake's catalog-wide schema version, which every connection then reloads. On
PostgreSQL with two writers appending 100 rows each, claiming every commit cut throughput by a
quarter to a third in our measurements, writers to two different datasets included. Snapshots that
replace rows conflict through their deletes and do not claim, nor do unkeyed appends to a dataset
that holds only its own columns, such as a sync target: those commit concurrently.

A version that changes no rows, a schema change, a merge that only advances source ordering, and
an unkeyed append guarded on `expectedLatestVersionId` also fail on a concurrent commit to any
dataset of the catalog. The writer that loses reruns its whole commit from the retained staging
table: up to 16 attempts, the first rerun at once, later ones after a random wait in a window
that doubles from 20 ms up to 1 s (at most 9.3 s of waiting in all). A merge's
`commit({ signal })` also stops the wait, and a writer that runs out of attempts fails with
`LakeConcurrencyError`. Other provider/connection failures propagate without an automatic retry.

SQLite reads commit metadata before the write transaction, then verifies the native snapshot
has not changed; a race reruns the commit the same way, and data writes are applied once per
attempt. The catalog's existing journal mode is preserved.

Snapshot, append, and SQL-transform writes to keyed datasets also enforce unique keys so a later
merge never starts from an ambiguous baseline. Application authors normally use
`defineSync(..., { mode: "merge" })`; the sync worker stages those changes through this contract.

## DuckLake SQL Transforms

DuckLake SQL transforms let the provider run dataset-to-dataset transforms in
DuckDB without materializing source rows in JavaScript. The capability is exposed
on `DuckLakeStorage`:

```ts
lakeStorage.standard.id // "ducklake"
lakeStorage.standard.version // "1.0"
lakeStorage.sql.dialect // "duckdb"
```

The SQL callback receives provider-owned relation handles. Interpolate those
handles where a relation belongs; do not use physical table names. The provider
renders each handle with DuckLake time travel and rejects unresolved or fabricated
placeholders.

```ts
const previewRows = []

for await (const row of lakeStorage.sql.preview({
  sources: {
    orders: { dataset: rawOrdersDataset },
  },
  limit: 25,
  sql: ({ orders }) => `
    select
      customerId,
      count(*)::BIGINT as orders,
      sum(total)::DOUBLE as revenue
    from ${orders}
    group by customerId
    order by customerId
  `,
})) {
  previewRows.push(row)
}
```

`preview(...)` is for development and UI inspection. It always applies a bounded
provider limit; omitted limits default to 100 rows and requested limits are capped
at 1000 rows.

`execute(...)` writes the transform result as a normal `DatasetVersion`. Target
datasets must already exist, result columns must match the target schema by name,
order, and compatible DuckDB type, and resolved source versions are recorded in
`DatasetVersion.inputs`.

```ts
const customerInsightsDataset = defineDataset("analytics.customer_insights", {
  schema: [
    col("customerId", "string"),
    col("orders", "int64"),
    col("revenue", "float64", { nullable: true }),
  ],
})

const version = await lakeStorage.sql.execute({
  sources: {
    orders: { dataset: rawOrdersDataset, versionId: "ducklake:42" },
  },
  target: customerInsightsDataset,
  mode: "snapshot",
  producer: { kind: "pipeline", id: "customer-insights", runId: "run_123" },
  sql: ({ orders }) => `
    select
      customerId,
      count(*)::BIGINT as orders,
      sum(total)::DOUBLE as revenue
    from ${orders}
    group by customerId
  `,
})
```

Use `mode: "snapshot"` to replace the target contents, or `mode: "append"` to add
new rows to the existing target. Omitting a source `versionId` resolves the latest
committed version at execution time; providing a `versionId` pins that source for
repeatable transforms.

A source can pick the columns a transform may read with `columns`. The relation then exposes only
those columns, in that order, and referencing any other column fails:

```ts
sources: {
  orders: { dataset: rawOrdersDataset, columns: ["customerId", "total"] },
}
```

The committed version records its lineage in `DatasetVersion.lineage`: which columns each output
column was computed from, and which ones decide the result's rows and their order, traced through
what the source versions read record themselves. An append also keeps the lineage of the rows it
keeps. `analyze(...)` returns the SQL's own lineage, by source name, without reading any data or
requiring a committed source version. The provider binds the SQL in an isolated DuckDB instance
against empty tables shaped like the sources. SQL it cannot analyze exactly, such as `PIVOT`, still
executes. When its parse tree reads nothing but the sources and calls only functions by names DuckDB
defines, every column the sources expose is recorded as deciding its rows, so each output column
carries the markings of all of them. A `PIVOT` needs an explicit `IN` list for that.

Lineage only covers the sources. SQL that may read anything else, such as a lake table by its name,
a table function that reads files or other tables (`read_parquet`, `read_csv`, `query_table`), or a
macro the lake's setup defines, records no lineage for a pipeline version, and an unknown lineage
for any other one. Either way, the version is classified with every marking. Read data only through
the sources.

DuckDB promotes `sum(BIGINT)` results to `HUGEINT`. When the matching target column is a Sixb
`int64`, the executor applies a checked conversion back to `BIGINT` before comparing or writing
rows. Values outside the signed 64-bit range fail the transform instead of being truncated.

## Definition Updates

DuckLake supports schema evolution, and this provider exposes a small safe
subset of dataset definition updates through repeated `createDataset(...)`
calls.

Schema changes:

- add nullable top-level columns
- reorder existing column declarations without changing the stored table

Metadata changes:

- add compatible metadata such as `description` or `partitionBy`

Rejected changes:

- add required columns
- drop columns
- rename columns
- change column types
- change column nullability
- change existing `description` or `partitionBy` metadata

Sixb matches existing columns by name, not by declaration position. If a
developer declares a new nullable column between existing columns, DuckLake still
stores that new physical column at the end of the table. Later `getDataset(...)`
calls return DuckLake's stored order.

Schema-only DuckLake commits count as Sixb dataset versions. After a schema
change, `getLatestVersion(...)` and `listVersions(...)` include the schema
version with `DatasetVersion.mode: "schema"` even if no rows were written in
that commit. Historical `DatasetVersion.schema` values come from DuckLake
metadata at that snapshot, so versioned reads validate projected columns against
the schema that existed at the requested version.

## Catalogs

Supported catalogs:

- `duckdb`: local DuckDB metadata file.
- `sqlite`: local SQLite metadata file.
- `postgres`: PostgreSQL metadata catalog, with optional `metadataSchema`.
- `custom`: escape hatch for DuckLake catalog URI forms Sixb does not model
  yet, including DuckLake secrets.

```ts
const lakeStorage = new DuckLakeStorage({
  catalog: {
    type: "postgres",
    host: "127.0.0.1",
    port: 5432,
    database: "ducklake",
    user: "postgres",
    password: process.env.POSTGRES_PASSWORD,
    metadataSchema: "sixb_lake",
  },
  dataPath: "s3://sixb-lake/data",
  secrets: [
    {
      type: "s3",
      keyId: process.env.AWS_ACCESS_KEY_ID,
      secret: process.env.AWS_SECRET_ACCESS_KEY,
      region: "us-east-1",
      scope: "s3://sixb-lake",
    },
  ],
})
```

## PostgreSQL Configuration

Use a PostgreSQL catalog for production or any deployment where multiple Sixb
processes need to see the same DuckLake snapshots. Local DuckDB or SQLite
catalogs are better suited to development and tests.

PostgreSQL stores only DuckLake metadata. Dataset table data still lives under
`dataPath`, usually in object storage such as S3, R2, GCS, or Azure Blob.

```txt
PostgreSQL catalog  -> snapshots, schemas, transactions, metadata
dataPath            -> physical DuckLake table data and files
BlobStorage         -> Sixb fileRef payload bytes
```

Recommended production shape:

```ts
const lakeStorage = new DuckLakeStorage({
  catalog: {
    type: "postgres",
    host: process.env.PGHOST!,
    port: Number(process.env.PGPORT ?? 5432),
    database: process.env.PGDATABASE!,
    user: process.env.PGUSER!,
    password: process.env.PGPASSWORD!,
    sslMode: "require",
    applicationName: "sixb-api",
    connectTimeoutSeconds: 10,
    metadataSchema: "sixb_lake",
  },
  dataPath: "s3://sixb-lake/data",
  duckdb: {
    config: {
      threads: "2",
    },
  },
  postgresPool: {
    maxConnections: 8,
    waitTimeoutMillis: 30_000,
    idleTimeoutMillis: 1_000,
    maxLifetimeMillis: 300_000,
    enableThreadLocalCache: false,
  },
  secrets: [
    {
      type: "s3",
      keyId: process.env.AWS_ACCESS_KEY_ID,
      secret: process.env.AWS_SECRET_ACCESS_KEY,
      region: "us-east-1",
      scope: "s3://sixb-lake",
    },
  ],
})
```

### What Each Setting Controls

| Setting | Controls |
| --- | --- |
| `catalog` | The PostgreSQL database DuckLake uses for metadata. |
| `catalog.metadataSchema` | The schema that holds DuckLake metadata tables. |
| `dataPath` | Where DuckLake stores physical table data. |
| `duckdb.config.threads` | Local DuckDB worker threads inside this process. |
| `postgresPool` | DuckDB PostgreSQL extension connections for DuckLake metadata. |

This pool is separate from any normal Sixb `PostgresStorage` pool. Count both
when sizing a small database.

### Connection Sizing

Start with the smallest budget that supports your workload, then raise it after
observing real latency and PostgreSQL connection use.

| Deployment | `duckdb.config.threads` | `postgresPool.maxConnections` | Notes |
| --- | ---: | ---: | --- |
| Small managed PostgreSQL, about 20 connections | `"1"` | `4` | Run only the services that need the lake provider. |
| Normal production service | `"2"` to `"4"` | `8` to `16` | Good default range for API and worker processes. |
| Larger read-heavy deployment | `"4"` or more | `16` or more | Scale only with PostgreSQL headroom and monitoring. |

The budget multiplies by process count:

```txt
estimated DuckLake catalog connections =
  number of processes with DuckLakeStorage * postgresPool.maxConnections
```

If the PostgreSQL role has a `CONNECTION LIMIT`, size it for the whole
deployment:

```txt
role connection limit >=
  DuckLake catalog connections
  + normal application PostgreSQL pool connections
  + migration, admin, and monitoring headroom
```

Leave headroom for the normal Sixb PostgreSQL storage provider, migrations,
admin sessions, monitoring, and PostgreSQL reserved connections.

### Pool Options

`postgresPool` maps to DuckDB's PostgreSQL extension pool settings for the
DuckLake metadata catalog.

| Option | Use it for |
| --- | --- |
| `maxConnections` | Pool cache limit; parallel scans can temporarily exceed it. |
| `waitTimeoutMillis` | How long a request can wait for a pool connection. |
| `idleTimeoutMillis` | How quickly unused pool connections are released. |
| `maxLifetimeMillis` | Recycling long-lived PostgreSQL connections. |
| `enableThreadLocalCache` | Keep `false` for constrained databases. |
| `healthCheckQuery` | Custom pool connection health checks, rarely needed. |

Prefer `postgresPool` over raw `setupSql` for PostgreSQL pool tuning. The
provider applies the settings before and after DuckLake attachment so the
metadata catalog uses the intended pool.

### Service Layout

Each service process that constructs `DuckLakeStorage` owns its own DuckDB
runtime and PostgreSQL pool. Avoid creating the lake provider in services that
do not need it.

```txt
needs DuckLakeStorage:
  api reads, sync worker, pipeline worker, projection worker

does not need DuckLakeStorage:
  static app server, health-only process, services that only use BlobStorage
```

On very small PostgreSQL plans, run fewer lake-owning processes or group workers
into one process before lowering `maxConnections` too far. A pool budget below
`4` can become fragile because one runtime may need several metadata operations
during attach, commit, and snapshot hydration.

Use `custom` when you need to pass a DuckLake catalog URI that Sixb does not
model directly:

```ts
const lakeStorage = new DuckLakeStorage({
  catalog: {
    type: "custom",
    uri: "postgres:dbname=ducklake host=127.0.0.1 user=postgres",
    extensions: ["postgres"],
  },
  dataPath: "s3://sixb-lake/data",
})
```

`setupSql` runs after required DuckDB extensions load and before DuckLake
`ATTACH`, so callers can install extra extensions, set DuckDB options, or create
secrets manually when the typed options are not enough.

## Blob Storage

DuckLake stores `fileRef` values as dataset row metadata only. Blob payload
bytes are owned by a separate Sixb `BlobStorage` provider, such as
`@sixb/blob-local`, and should be composed beside this lake provider when
creating a runtime.

## Tests

Fast unit tests:

```bash
bun --filter @sixb/ducklake test
```

Local DuckLake e2e tests:

```bash
bun --filter @sixb/ducklake test:e2e:local
```

Docker-backed PostgreSQL and SeaweedFS (S3-compatible) e2e tests:

```bash
bun --filter @sixb/ducklake test:e2e:remote
```

`test:e2e` runs the local suite first, then the remote suite. Remote e2e
container setup and teardown live in `tests/setup.ts`, following the same
preload pattern as the other Docker-backed packages in this repo.

Relevant upstream docs:

- [DuckLake connecting](https://ducklake.select/docs/stable/duckdb/usage/connecting)
- [DuckLake catalog choices](https://ducklake.select/docs/stable/duckdb/usage/choosing_a_catalog_database)
- [DuckDB S3 API and secrets](https://duckdb.org/docs/current/core_extensions/httpfs/s3api)
- [DuckDB Azure extension](https://duckdb.org/docs/current/core_extensions/azure)
