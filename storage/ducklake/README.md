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

### Maintenance

DuckLake keeps historical snapshots and deleted files until maintenance runs.
Maintenance is operator-driven: run it on demand from the CLI or call
`runMaintenance()` directly. It expires snapshots, reclaims deleted file blocks,
and removes orphaned files through DuckLake's explicit maintenance functions,
keeping seven days of snapshots/files by default.

Run it from the CLI (preview with `--dry-run`):

```bash
sixb lake cleanup --dry-run
sixb lake cleanup --expire-older-than "14 days" --delete-older-than "14 days"
```

Or run it directly against the provider:

```ts
const report = await lakeStorage.runMaintenance({
  dryRun: true,
  expireOlderThan: "7 days",
})
```

### Read and Write Concurrency

Reads, writes, SQL previews, and SQL transforms use the same DuckDB runtime and
the same DuckLake PostgreSQL metadata pool. Work is serialized inside one
`DuckLakeStorage` instance, so a queued DuckDB operation makes later operations
wait. Only actual DuckDB work holds the runtime: batch appends, commits, SQL
transforms, and metadata reads. A large streaming read can also make a later
write wait until the stream is consumed or closed.

A write does not hold the runtime while its source iterable is producing rows.
`writeRows(...)` validates and stages rows in bounded in-memory batches, then
takes a queue slot only to flush each batch into the staging table. Slow external
reads (pagination, APIs, SFTP, retries) run outside the queue, so other reads and
write batches can interleave between a write's batches.

```txt
same provider instance:
  read -> write -> read

the operations run in order on one DuckDB runtime
```

This is the simplest and most predictable default, especially for small
PostgreSQL plans. A future provider option could add a bounded read-runtime pool
for deployments that have enough PostgreSQL capacity and need more concurrent
read throughput.

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
| `maxConnections` | Hard cap for DuckDB PostgreSQL extension connections. |
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

Docker-backed PostgreSQL and MinIO/S3-compatible e2e tests:

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
