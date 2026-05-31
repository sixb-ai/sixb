# Pipeline

A pipeline transforms datasets.

Use pipelines after syncs when raw source rows need to become cleaner, smaller, joined, or more
useful table data.

## Why it is useful

Syncs should stay focused on getting data into Sixb. Pipelines are where you shape that data.

Use a pipeline to:

- clean source rows
- rename columns
- filter records
- join datasets
- create app-ready tables
- prepare rows for projections

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

## What each part does

| Part | Meaning |
| --- | --- |
| `definePipelineStep("clean-orders")` | Defines one transform step |
| `.inputs({ rawOrders })` | Names the datasets the step reads |
| `.output(ordersDataset)` | Chooses the dataset the step writes |
| `.sql(...)` | Defines the transform |
| `definePipeline("orders")` | Names the pipeline |
| `.when(datasetUpdated(...))` | Runs after a dataset changes |
| `.then(cleanOrdersStep)` | Adds the step to the pipeline |

Steps are reusable definitions. A step only runs when a pipeline references it with `.then(...)`.

## SQL steps

Use SQL when the transform can be written as a query.

SQL is usually the best first choice for:

- selecting columns
- renaming columns
- filtering rows
- simple joins
- aggregations

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

SQL steps require a lake storage provider with SQL transform support.

## TypeScript steps

Use a TypeScript step when the transform needs application logic, library calls, or row-by-row
behavior that does not fit naturally in SQL.

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

Start with SQL when you can. Use TypeScript when the transform needs code.

## Compose steps

Pipelines can run multiple steps in order.

```ts
export const customerPipeline = definePipeline("customers")
  .when(datasetUpdated(rawCustomersDataset.id))
  .then(cleanCustomersStep)
  .then(customerInsightsStep)
```

Each step writes its output before the next step runs.

## Pipeline vs sync

Syncs and pipelines solve different problems.

| Need | Use |
| --- | --- |
| Read from an external system | Sync |
| Write raw source rows | Sync |
| Clean or reshape rows | Pipeline |
| Join datasets | Pipeline |
| Create projection-ready rows | Pipeline |

A good rule: sync first, shape later.

## Convention

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

`createSixb()` discovers exported pipeline definitions from `pipelines/` automatically.

You can also register pipelines explicitly:

```ts
import { createSixb } from "@sixb/core"
import { ordersDataset, rawOrdersDataset } from "./datasets/orders"
import { ordersPipeline } from "./pipelines/orders"

export const sixb = createSixb({
  datasets: [rawOrdersDataset, ordersDataset],
  pipelines: [ordersPipeline],
})
```

## How to model pipelines

Start with one small transform.

1. Pick the raw dataset you want to clean.
2. Define the output dataset.
3. Create one step that writes that output.
4. Trigger the pipeline with `datasetUpdated(inputDataset.id)`.
5. Add more steps only when each step has a clear job.

Good pipeline names describe the data they produce:

- `orders`
- `customers`
- `project-reporting`
- `device-inventory`

## Running pipelines

In local development, `sixb dev` can co-host pipeline workers when pipelines are registered.

In production, start a dedicated pipeline worker process:

```bash
sixb worker pipeline
```

For constrained deployments, `sixb worker-group` can co-host several queue workers in one
process, for example:

```bash
sixb worker-group sync pipeline projection
```

## Extra details

- pipeline steps write `snapshot` output by default.
- step outputs can use `{ mode: "append" }` when needed.
- V1 runs pipeline steps sequentially.
- if a later step fails, earlier committed dataset versions remain durable.
- a pipeline can also be triggered by a schedule with `.when(schedule)`.

The important first step is to keep each pipeline focused on turning one table shape into a
better table shape.
