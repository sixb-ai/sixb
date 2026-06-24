# Data

Sixb's data plane brings table-shaped data in from the outside world, cleans it, and turns it
into app objects.

Five pieces work together. Each has one job, and they chain in a fixed order:

```txt
connector ──▶ sync ──▶ dataset ──▶ pipeline ──▶ projection
  reach        pull      store       shape        publish
external      rows       table       rows         objects +
system        in        contract    into rows     telemetry
```

A [connector](./connectors.md) reaches an external system. A [sync](./syncs.md) reads from it and
writes rows into a [dataset](./datasets.md). A [pipeline](./pipelines.md) transforms one or more
datasets into cleaner datasets. A [projection](./projections.md) turns dataset rows into
[ontology](../ontology/overview.md) objects, links, and telemetry.

## The pieces

| Piece | One line | Page |
| --- | --- | --- |
| Connector | A reusable connection to an external system | [connectors.md](./connectors.md) |
| Sync | Moves data from an external system into a dataset | [syncs.md](./syncs.md) |
| Dataset | A named, typed table contract | [datasets.md](./datasets.md) |
| Pipeline | Transforms datasets into other datasets | [pipelines.md](./pipelines.md) |
| Projection | Turns dataset rows into objects, links, and telemetry | [projections.md](./projections.md) |

## How they connect

Each piece references the ones before it by their definitions, not by copying shape.

```ts
import { col, defineConnector, defineDataset, defineSync } from "@sixb/core"
import { sql } from "@sixb/connector-sql"

// connector: how to reach the external system
export const erpDb = defineConnector("erp-db", sql(process.env.DATABASE_URL!))

// dataset: the table contract
export const rawOrdersDataset = defineDataset("raw.erp.orders", {
  schema: [
    col("order_id", "string"),
    col("customer_id", "string"),
    col("total", "decimal", { nullable: true }),
  ],
})

// sync: connector in, dataset out
export const syncOrders = defineSync("sync-orders")
  .from(erpDb)
  .read((db) => db`select * from orders`)
  .intoDataset(rawOrdersDataset)
```

From there a [pipeline](./pipelines.md) cleans `rawOrdersDataset` into an app-ready dataset, and a
[projection](./projections.md) maps that dataset's rows onto an ontology object type.

## Mental model

- **Datasets are tables. Ontology types are objects.** The data plane's job is to get rows into
  tables, and projections cross the gap from tables to objects.
- **Each step has one input source and one output target.** A sync writes one dataset; a pipeline
  step writes one dataset; a projection writes one object type, link, or telemetry property.
- **Definitions are reused, not redeclared.** A dataset is defined once and referenced by syncs,
  pipelines, and projections so the shape stays consistent.
- **Steps are event-driven.** Pipelines and projections run when a dataset gets a new committed
  version. See [events](../events/overview.md) for the triggers.

## When to use what

| Goal | Use |
| --- | --- |
| Talk to a database or API | [Connector](./connectors.md) |
| Pull rows from a source into Sixb | [Sync](./syncs.md) |
| Give table data a stable shape | [Dataset](./datasets.md) |
| Clean, filter, rename, or join tables | [Pipeline](./pipelines.md) |
| Make rows show up as app objects | [Projection](./projections.md) |

## Discovery

`createSixb()` auto-discovers `connectors/`, `datasets/`, `syncs/`, `pipelines/`, and
`projections/` directories. Export a definition from a file in the matching folder and the
runtime registers it. See [runtime](../runtime/overview.md) and
[project structure](../fundamentals/project-structure.md).
