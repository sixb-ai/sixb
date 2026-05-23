# Dataset

A dataset is Sixb's definition for a table of rows.

It gives a table a stable id, a required schema, and optional metadata such as partitioning
and description.

Syncs write datasets. Pipelines read datasets and produce new datasets. Storage versions a
dataset's contents over time.

If ontology types are Sixb's model for objects, datasets are Sixb's model for tables and rows.

## What It Is

A dataset is the contract for one table.

That contract includes:

- a stable id
- a required schema
- optional partitioning
- an optional description

The important idea is that you define this contract once, then reuse it everywhere that table
appears.

In Sixb, datasets are always schema-first. A dataset is not just "some rows with a name". It
is a named table with an explicit shape, and there is no schemaless dataset write path.

## What It Gives You

- one place to define a table's shape
- one shared definition that syncs, pipelines, and storage can all reference
- row validation before data is committed
- versioned dataset contents over time

## Parts

| Piece | Role |
| --- | --- |
| `defineDataset` | Creates a runtime dataset definition |
| `col` | Declares one dataset column |
| `schema` | Lists allowed columns, types, and nullability |
| `partitionBy` | Declares logical partition columns |
| `description` | Adds human-readable context |
| runtime registry | Registers datasets and resolves them by id |
| lake storage | Materializes dataset definitions and versions writes |

## Define a dataset

File: `datasets/orders.ts`

```ts
import { col, defineDataset } from "@sixb/core"

export const rawOrdersDataset = defineDataset("raw.erp.orders", {
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
```

This defines one reusable dataset contract. Anything that writes to `raw.erp.orders` should use
this same definition.

Every dataset must declare a schema. There is no schemaless dataset write path.

## Derive a dataset schema

When a pipeline output keeps the same shape as an input dataset, or only narrows it to a known
set of columns, derive the output schema from the parent dataset instead of restating every
column:

```ts
import { col, defineDataset } from "@sixb/core"
import { rawProjectsDataset } from "./projects"

export const activeProjectsDataset = defineDataset("erp.active_projects").derive(
  rawProjectsDataset
)

export const projectSummariesDataset = defineDataset("erp.project_summaries").derive(
  rawProjectsDataset,
  {
    pick: ["project_id", "project_name", "status", "budget_amount"],
    add: [col("priority", "int64")],
  }
)
```

`pick` columns must exist on the parent dataset. TypeScript catches typos for literal parent
datasets, and runtime validation catches invalid dynamic values. `derive(...)` only derives the
schema; set `partitionBy` and `description` explicitly when the child dataset needs its own
metadata.

## Column types

Supported dataset column types:

- `string`
- `boolean`
- `int64`
- `float64`
- `decimal`
- `date`
- `timestamp`
- `json`
- `fileRef`

Use `nullable: true` when a column may be `null` or omitted.

## Use datasets from syncs

```ts
import { defineSync } from "@sixb/core"
import { erpDb } from "../connectors/erpDb"
import { rawOrdersDataset } from "../datasets/orders"

export const syncOrders = defineSync("sync-orders")
  .from(erpDb)
  .read(({ query }) => query("select * from orders"))
  .intoDataset(rawOrdersDataset)
```

Syncs reference the dataset definition directly, so the worker can materialize and validate
against the same schema.

## Use datasets from pipelines

```ts
import { col, datasetUpdated, defineDataset, definePipeline, definePipelineStep } from "@sixb/core"
import { rawOrdersDataset } from "../datasets/orders"

export const canonicalOrdersDataset = defineDataset("canonical.orders", {
  schema: [
    col("id", "string"),
    col("customerId", "string"),
    col("total", "float64", { nullable: true }),
  ],
})

export const normalizeOrdersStep = definePipelineStep("normalize-orders")
  .inputs({ rawOrders: rawOrdersDataset })
  .output(canonicalOrdersDataset)
  .run(async ({ inputs, output }) => {
    async function* rows() {
      for await (const order of inputs.rawOrders.readRows()) {
        yield {
          id: order.orderId,
          customerId: order.customerId,
          total: order.total,
        }
      }
    }

    await output.writeRows(rows())
  })

export const normalizeOrders = definePipeline("normalize-orders")
  .when(datasetUpdated(rawOrdersDataset.id))
  .then(normalizeOrdersStep)
```

## Convention

Export dataset definitions from `datasets/`:

```txt
your-project/
  datasets/
    orders.ts
    orderEvents.ts
  syncs/
    syncOrders.ts
  pipelines/
    normalizeOrders.ts
  sixb.config.ts
```

`createSixb()` scans `datasets/` and registers exported dataset definitions automatically.

You can also register them explicitly with:

```ts
createSixb({
  datasets: [rawOrdersDataset],
  // ...
})
```

## Runtime lookups

Sixb exposes dataset definitions through the runtime:

```ts
sixb.getDatasetDefinitions()
sixb.getDatasetById("raw.erp.orders")
```

Startup rejects:

- duplicate dataset ids
- datasets without schemas
- syncs that target unknown datasets
- pipelines that reference unknown datasets

## Validation rules

Rows are validated against the dataset schema before commit.

Rules:

- every non-nullable column must be present
- `null` is allowed only for nullable columns
- every value must match the declared column type
- unknown columns are rejected

If you want to keep raw source payloads, declare them explicitly:

```ts
col("raw", "json", { nullable: true })
```

## Lake behavior

When a worker writes to a dataset:

1. it resolves the registered dataset definition
2. it calls `lakeStorage.createDataset(dataset)`
3. it opens a write with `beginWrite({ dataset, ... })`
4. it validates rows against `dataset.schema`
5. it commits a new dataset version

`createDataset(...)` is idempotent. It does not only create a brand-new dataset. It also lets
lake storage check whether the dataset definition declared by the current runtime still matches
the definition already known by that storage provider.

That comparison is between two dataset definitions:

- the persisted definition: the definition storage already knows about
- the runtime definition: the definition currently declared in code

Most providers reject incompatible definition changes. Some durable providers may apply a small
safe subset of schema or metadata changes, such as adding nullable columns, and then expose that
definition-only change as a dataset version.

This is separate from dataset content versioning. A `DatasetVersion` represents committed rows
at a point in time.

## Guidelines

- Define datasets once and reuse them everywhere.
- Keep raw and canonical datasets separate.
- Be explicit about nullable fields from external systems.
- Use `json` only when the payload is intentionally unstructured.
- Treat `partitionBy` as part of the dataset contract, not per-sync behavior.
