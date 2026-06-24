# Datasets

A dataset is a typed table of rows.

Datasets are where sixb stores table-shaped data: raw rows from external systems, cleaned rows from pipelines, and rows that projections turn into app objects.

A dataset gives table data a stable contract: what the table is called, which columns exist, what type each column has, and which columns can be missing or `null`. Once a dataset is defined, [syncs](./syncs.md), [pipelines](./pipelines.md), [projections](./projections.md), and storage can all point at the same shape.

If an [ontology](../ontology/overview.md) is your app's object model, a dataset is your table model.

## Core terms

| Concept | Meaning |
| --- | --- |
| Dataset | A named table contract |
| Column | One typed field in each row |
| Row | One record written to the dataset |
| Schema | The ordered list of column definitions |

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

The dataset id, `raw.erp.orders`, is the stable name other parts of the project reference.

### `defineDataset` options

| Option | Type | Description |
| --- | --- | --- |
| `schema` | `col(...)[]` | Required. The list of column definitions. |
| `partitionBy` | `string[]` | Optional. Logical partition columns; each name must exist in `schema`. |
| `description` | `string` | Optional. Human-readable description. |

### `col` options

```ts
col(name, type)
col(name, type, { nullable: true })
```

Use `nullable: true` when a column may be missing or `null`. Use `json` when the source payload is intentionally unstructured:

```ts
col("raw", "json", { nullable: true })
```

## Column types

| Type | Accepts |
| --- | --- |
| `string` | a string |
| `boolean` | a boolean |
| `int64` | an integer, or an integer string |
| `float64` | a finite number |
| `decimal` | a finite number, or a numeric string |
| `date` | a `Date`, or a `YYYY-MM-DD` string |
| `timestamp` | a `Date`, or a parseable date string |
| `json` | any JSON value |
| `fileRef` | a [file reference](../infrastructure/overview.md) |

## Use a dataset from a sync

[Syncs](./syncs.md) read from a [connector](./connectors.md) and write into one dataset. The sync does not repeat the table shape; it references the dataset definition.

```ts
import { defineSync } from "@sixb/core"
import { erpDb } from "../connectors/erp-db"
import { rawOrdersDataset } from "../datasets/orders"

export const syncOrders = defineSync("sync-orders")
  .from(erpDb)
  .read((db) => db`select * from orders`)
  .intoDataset(rawOrdersDataset)
```

## Use a dataset from a pipeline

[Pipelines](./pipelines.md) read datasets and write new datasets, keeping raw source data separate from cleaner app-ready data.

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

## Derive a dataset

Use `.derive(parent)` to copy a parent schema, then narrow it with `pick` or extend it with `add`.

```ts
import { col, defineDataset } from "@sixb/core"
import { rawOrdersDataset } from "./orders"

// Copy the full parent schema
export const ordersCopy = defineDataset("orders.copy").derive(rawOrdersDataset)

// Narrow to a subset of columns and add new ones
export const ordersSummary = defineDataset("orders.summary").derive(rawOrdersDataset, {
  pick: ["order_id", "customer_id"],
  add: [col("processed_at", "timestamp")],
})
```

| `derive` option | Type | Description |
| --- | --- | --- |
| `pick` | `string[]` | Keep only these parent columns. Each name must exist on the parent. |
| `add` | `col(...)[]` | Append these columns after the kept ones. |
| `partitionBy` | `string[]` | Optional partition columns for the derived dataset. |
| `description` | `string` | Optional description for the derived dataset. |

## Dataset vs ontology

Datasets and ontology types solve different problems.

| Use | Choose |
| --- | --- |
| Raw source rows | Dataset |
| Cleaned table rows | Dataset |
| App objects users interact with | [Ontology](../ontology/overview.md) |
| Relationships between objects | [Ontology links](../ontology/links.md) |

Usually source data lands in a raw dataset, pipelines shape it into a clean dataset, and [projections](./projections.md) turn it into ontology objects.

## Registration

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

`createSixb()` discovers exported dataset definitions from `datasets/` automatically. You can also register them explicitly:

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

## Row validation

Rows are validated against the schema:

- A row must be a plain object and may not contain unknown columns.
- Each column value must match its declared type.
- A non-nullable column may not be missing, `undefined`, or `null`.
- A nullable column may be omitted or set to `null`.

The important first step is to define the table shape once and reuse that definition wherever the table appears.
