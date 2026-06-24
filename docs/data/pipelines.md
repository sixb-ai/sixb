# Pipelines

A pipeline transforms [datasets](./datasets.md). Use one after a [sync](./syncs.md) when raw
source rows need to become cleaner, smaller, joined, or more useful table data.

Syncs get data into Sixb. Pipelines shape it: clean rows, rename columns, filter records, join
datasets, build app-ready tables, and prepare rows for [projections](./projections.md).

A pipeline is made of steps. Each step reads one or more input datasets and writes one output
dataset.

## Define a pipeline

File: `pipelines/orders.ts`

```ts
import { datasetUpdated, definePipeline, definePipelineStep } from "@sixb/core"
import { ordersDataset, rawOrdersDataset } from "../datasets/orders"

export const cleanOrdersStep = definePipelineStep("clean-orders")
  .inputs({ rawOrders: rawOrdersDataset })
  .output(ordersDataset)
  .sql(({ rawOrders }) => `
    select
      order_id as id,
      customer_id,
      total
    from ${rawOrders}
    where order_id is not null
  `)

export const ordersPipeline = definePipeline("orders")
  .when(datasetUpdated(rawOrdersDataset.id))
  .then(cleanOrdersStep)
```

This runs when `rawOrdersDataset` gets a new committed version. It reads raw order rows and
writes cleaner order rows.

| Part | Meaning |
| --- | --- |
| `definePipelineStep("clean-orders")` | Defines one transform step |
| `.inputs({ rawOrders })` | Names the datasets the step reads |
| `.output(ordersDataset)` | Chooses the dataset the step writes |
| `.sql(...)` / `.run(...)` | Defines the transform |
| `definePipeline("orders")` | Names the pipeline |
| `.when(datasetUpdated(...))` | Trigger that runs the pipeline |
| `.then(cleanOrdersStep)` | Adds a step to the sequence |

Steps are inert, reusable definitions. A step only runs when a pipeline references it with
`.then(...)`.

## Step builder

`definePipelineStep(id)` chains in a fixed order: `.inputs(...)`, then `.output(...)`, then a
terminal `.sql(...)` or `.run(...)`. Input keys map to the names you read inside the executor.

| Method | Purpose |
| --- | --- |
| `.inputs(record)` | Named input datasets, e.g. `{ rawOrders: rawOrdersDataset }`. At least one required. |
| `.output(dataset, options?)` | Output dataset and optional write mode. |
| `.sql(fn)` | SQL transform. `fn` receives the input names as interpolatable refs. |
| `.run(handler)` | TypeScript transform. `handler` receives a run context. |

### Output options

```ts
.output(ordersDataset, { mode: "append" })
```

| `mode` | Behavior |
| --- | --- |
| `"snapshot"` (default) | Step writes a full replacement version. |
| `"append"` | Step appends rows to the output dataset. |

## SQL steps

Use SQL when the transform can be written as a query — selecting, renaming, filtering, simple
joins, and aggregations.

```ts
export const activeCustomersStep = definePipelineStep("active-customers")
  .inputs({ customers: rawCustomersDataset })
  .output(activeCustomersDataset)
  .sql(({ customers }) => `
    select
      customer_id as id,
      contact_name as name,
      service_tier
    from ${customers}
    where status = 'active'
  `)
```

SQL steps run on the DuckDB dialect and require a lake storage provider with SQL transform
support. See [connectors](./connectors.md) for storage providers.

## TypeScript steps

Use a TypeScript step (`.run(...)`) when the transform needs application logic, library calls, or
row-by-row behavior that does not fit naturally in SQL. The handler receives a context with the
named `inputs` and an `output`.

```ts
export const cleanCustomersStep = definePipelineStep("clean-customers")
  .inputs({ rawCustomers: rawCustomersDataset })
  .output(customersDataset)
  .run(async ({ inputs, output }) => {
    async function* rows() {
      for await (const customer of inputs.rawCustomers.readRows()) {
        yield {
          id: customer.customer_id,
          name: String(customer.contact_name).trim(),
          tier: customer.service_tier,
        }
      }
    }

    await output.writeRows(rows())
  })
```

The run context exposes:

| Field | Type | Description |
| --- | --- | --- |
| `inputs[name]` | `PipelineStepInput` | One per `.inputs(...)` key. Has `dataset`, `version`, `readRows(input?)`. |
| `output` | `PipelineStepOutput` | `writeRows(rows)` accepts a sync or async iterable of rows. |
| `projectId`, `pipelineId`, `stepId`, `runId` | `string` | Identifiers for the current run. |
| `signal` | `AbortSignal` | Aborts when the run is cancelled. |

`input.readRows(input?)` returns an `AsyncIterable` of rows; pass read options to scope the read.
Start with SQL when you can; use TypeScript when the transform needs code.

## Compose steps

Pipelines run their steps in order. Each step writes its output before the next step runs.

```ts
export const customerPipeline = definePipeline("customers")
  .when(datasetUpdated(rawCustomersDataset.id))
  .then(cleanCustomersStep)
  .then(customerInsightsStep)
```

A step can read a dataset that an earlier step wrote, so chains build progressively richer tables.

## Triggers

Pass `.when(...)` a [trigger](../schedules/overview.md) or a schedule. Add more than one `.when(...)`
to run on multiple triggers.

| Trigger | Runs when |
| --- | --- |
| `datasetUpdated(datasetId)` | A dataset commits a new version |
| `syncFinished(syncId)` | A sync run finishes |
| `pipelineFinished(pipelineId)` | Another pipeline finishes |
| a [schedule](../schedules/overview.md) | The schedule fires |

```ts
import { defineSchedule } from "@sixb/core"

const nightly = defineSchedule("nightly-orders").cron("0 2 * * *")

export const nightlyOrders = definePipeline("orders")
  .when(nightly)
  .then(cleanOrdersStep)
```

## Pipeline vs sync

| Need | Use |
| --- | --- |
| Read from an external system | [Sync](./syncs.md) |
| Write raw source rows | [Sync](./syncs.md) |
| Clean or reshape rows | Pipeline |
| Join datasets | Pipeline |
| Create projection-ready rows | Pipeline |

A good rule: sync first, shape later.

## Convention and registration

Put pipeline definitions in `pipelines/` and export them.

```txt
your-project/
  datasets/
    orders.ts
  syncs/
    orders.ts
  pipelines/
    orders.ts
  projections/
    orders.ts
  sixb.config.ts
```

`createSixb()` discovers exported pipeline definitions from `pipelines/` automatically. You can
also register them explicitly:

```ts
import { createSixb } from "@sixb/core"
import { ordersDataset, rawOrdersDataset } from "./datasets/orders"
import { ordersPipeline } from "./pipelines/orders"

export const sixb = createSixb({
  datasets: [rawOrdersDataset, ordersDataset],
  pipelines: [ordersPipeline],
})
```

See [the runtime](../runtime/overview.md) for how `createSixb()` wires everything together.

## How to model pipelines

1. Pick the raw dataset you want to clean.
2. Define the output dataset.
3. Create one step that writes that output.
4. Trigger the pipeline with `datasetUpdated(inputDataset.id)`.
5. Add more steps only when each step has a clear job.

Good pipeline names describe the data they produce: `orders`, `customers`, `project-reporting`,
`device-inventory`.

## Running pipelines

In local development, `sixb dev` co-hosts pipeline workers when pipelines are registered.

In production, start a dedicated pipeline worker process:

```bash
sixb worker pipeline
```

For constrained deployments, `sixb worker-group` co-hosts several queue workers in one process:

```bash
sixb worker-group sync pipeline projection
```

See [deployment](../deployment/overview.md) for running workers in production.

## Notes

- Pipeline steps write `snapshot` output by default; use `{ mode: "append" }` when needed.
- V1 runs pipeline steps sequentially.
- If a later step fails, earlier committed dataset versions remain durable.

The important first step is to keep each pipeline focused on turning one table shape into a
better table shape.
