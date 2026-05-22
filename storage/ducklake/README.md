# @pario/ducklake

Durable Pario `LakeStorage` provider backed by DuckDB and the DuckLake
extension.

DuckLake owns physical tables, Parquet files, transactions, snapshots, and time
travel. Pario keeps ownership of dataset ids, dataset-definition compatibility,
version shape, producer metadata, and `fileRef` values.

## Usage

```ts
import { DuckLakeStorage } from "@pario/ducklake"

const lakeStorage = new DuckLakeStorage({
  catalog: {
    type: "duckdb",
    path: ".pario/lake/metadata.ducklake",
  },
  dataPath: ".pario/lake/data",
})

await lakeStorage.close()
```

Datasets must declare a schema before they can be stored in DuckLake:

```ts
import { col, defineDataset, defineSync } from "@pario/core"

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
`createPario({ datasets: [rawOrdersDataset], ... })` so the runtime and worker
use the same schema that DuckLake materializes.

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

Pario matches existing columns by name, not by declaration position. If a
developer declares a new nullable column between existing columns, DuckLake still
stores that new physical column at the end of the table. Later `getDataset(...)`
calls return DuckLake's stored order.

Schema-only DuckLake commits count as Pario dataset versions. After a schema
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
- `custom`: escape hatch for DuckLake catalog URI forms Pario does not model
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
    metadataSchema: "pario_lake",
  },
  dataPath: "s3://pario-lake/data",
  secrets: [
    {
      type: "s3",
      keyId: process.env.AWS_ACCESS_KEY_ID,
      secret: process.env.AWS_SECRET_ACCESS_KEY,
      region: "us-east-1",
      scope: "s3://pario-lake",
    },
  ],
})
```

Use `custom` when you need to pass a DuckLake catalog URI that Pario does not
model directly:

```ts
const lakeStorage = new DuckLakeStorage({
  catalog: {
    type: "custom",
    uri: "postgres:dbname=ducklake host=127.0.0.1 user=postgres",
    extensions: ["postgres"],
  },
  dataPath: "s3://pario-lake/data",
})
```

`setupSql` runs after required DuckDB extensions load and before DuckLake
`ATTACH`, so callers can install extra extensions, set DuckDB options, or create
secrets manually when the typed options are not enough.

## Blob Storage

DuckLake stores `fileRef` values as dataset row metadata only. Blob payload
bytes are owned by a separate Pario `BlobStorage` provider, such as
`@pario/blob-local`, and should be composed beside this lake provider when
creating a runtime.

## Tests

Fast unit tests:

```bash
bun --filter @pario/ducklake test
```

Local DuckLake e2e tests:

```bash
bun --filter @pario/ducklake test:e2e:local
```

Docker-backed PostgreSQL and MinIO/S3-compatible e2e tests:

```bash
bun --filter @pario/ducklake test:e2e:remote
```

`test:e2e` runs the local suite first, then the remote suite. Remote e2e
container setup and teardown live in `tests/setup.ts`, following the same
preload pattern as the other Docker-backed packages in this repo.

Relevant upstream docs:

- [DuckLake connecting](https://ducklake.select/docs/stable/duckdb/usage/connecting)
- [DuckLake catalog choices](https://ducklake.select/docs/stable/duckdb/usage/choosing_a_catalog_database)
- [DuckDB S3 API and secrets](https://duckdb.org/docs/current/core_extensions/httpfs/s3api)
- [DuckDB Azure extension](https://duckdb.org/docs/current/core_extensions/azure)
