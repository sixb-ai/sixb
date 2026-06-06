# Dataset

A dataset is a typed table of rows.

Datasets are where Sixb stores table-shaped data: raw rows from external systems, cleaned
rows from pipelines, and rows that projections can turn into app objects.

## Why it is useful

A dataset gives table data a stable contract.

That contract says:

- what the dataset is called
- which columns exist
- what type each column has
- which columns can be missing or `null`

Once a dataset is defined, syncs, pipelines, projections, and storage can all point at the
same shape.

## Core terms

| Concept | Meaning |
| --- | --- |
| Dataset | A named table contract |
| Column | One typed field in each row |
| Row | One record written to the dataset |
| Version | One committed set of rows |

If an [ontology](./ontology.md) is your app's object model, a dataset is your table model.

## Define a dataset

File: `datasets/orders.ts`

```ts
import { col, defineDataset } from "@sixb/core"

export const rawOrdersDataset = defineDataset("raw.erp.orders", {
  schema: [
    col("order_id", "string"),
    col("customer_id", "string"),
    col("total", "decimal", { nullable: true }),
    col("created_at", "timestamp"),
  ],
  description: "Raw order rows from the ERP.",
})
```

This defines one reusable table shape.

The dataset id, `raw.erp.orders`, is the stable name other parts of the project use.

## Use a dataset from a sync

Syncs read from a connector and write into one dataset.

```ts
import { defineSync } from "@sixb/core"
import { erpDb } from "../connectors/erp-db"
import { rawOrdersDataset } from "../datasets/orders"

export const syncOrders = defineSync("sync-orders")
  .from(erpDb)
  .read((db) => db`select * from orders`)
  .intoDataset(rawOrdersDataset)
```

The sync does not need to repeat the table shape. It references the dataset definition.

## Use a dataset from a pipeline

Pipelines read datasets and write new datasets.

```ts
import { col, datasetUpdated, defineDataset, definePipeline, definePipelineStep } from "@sixb/core"
import { rawOrdersDataset } from "../datasets/orders"

export const ordersDataset = defineDataset("orders", {
  schema: [
    col("id", "string"),
    col("customer_id", "string"),
    col("total", "decimal", { nullable: true }),
  ],
})

export const cleanOrdersStep = definePipelineStep("clean-orders")
  .inputs({ rawOrders: rawOrdersDataset })
  .output(ordersDataset)
  .sql(({ rawOrders }) => `
    select
      order_id as id,
      customer_id,
      total
    from ${rawOrders}
  `)

export const ordersPipeline = definePipeline("orders")
  .when(datasetUpdated(rawOrdersDataset.id))
  .then(cleanOrdersStep)
```

This keeps raw source data separate from cleaner app-ready table data.

## Dataset vs ontology

Datasets and ontology types solve different problems.

| Use | Choose |
| --- | --- |
| Raw source rows | Dataset |
| Cleaned table rows | Dataset |
| App objects users interact with | Ontology |
| Relationships between objects | Ontology links |

Usually, source data lands in a raw dataset, pipelines shape it into a clean dataset, and
projections turn it into ontology objects.

## Column types

Common column types:

- `string`
- `boolean`
- `int64`
- `float64`
- `decimal`
- `date`
- `timestamp`
- `json`
- `fileRef`

Use `nullable: true` when a column may be missing or `null`.

Use `json` when the source payload is intentionally unstructured:

```ts
col("raw", "json", { nullable: true })
```

## Convention

Put dataset definitions in `datasets/` and export them.

```txt
your-project/
  datasets/
    orders.ts
    customers.ts
  syncs/
    orders.ts
  pipelines/
    orders.ts
  sixb.config.ts
```

`createSixb()` discovers exported dataset definitions from `datasets/` automatically.

You can also register datasets explicitly:

```ts
import { createSixb } from "@sixb/core"
import { rawOrdersDataset } from "./datasets/orders"

export const sixb = createSixb({
  datasets: [rawOrdersDataset],
})
```

## How to model datasets

Start with the source shape.

1. Define a raw dataset for data coming from an external system.
2. Keep source column names if that makes debugging easier.
3. Mark uncertain fields as nullable.
4. Add a `json` column only when you intentionally want to keep the raw payload.
5. Create cleaner datasets later with pipelines.

Good dataset names usually describe the layer and source:

- `raw.erp.orders`
- `raw.stripe.invoices`
- `orders`
- `customer_activity`

## Extra details

- `partitionBy` declares logical partition columns.
- `defineDataset("next").derive(parent)` copies a parent schema.
- `derive(parent, { pick, add })` narrows or extends a parent schema.
- rows are validated against the schema before commit.
- each successful write commits a new dataset version.
- durable lake storage providers may reject incompatible schema changes.

The important first step is to define the table shape once and reuse that definition wherever
the table appears.
