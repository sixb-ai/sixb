# Pipeline

A pipeline is a small ordered graph of dataset transform steps.

Each step reads one or more committed dataset versions and commits one normal dataset version.
Pipeline outputs can trigger projections, downstream pipelines, or any other route that listens for
`dataset.version.committed`.

## Define SQL Steps

Use SQL steps for dataset-to-dataset transforms that can be expressed by the lake storage SQL
engine.

```ts
import { datasetUpdated, definePipeline, definePipelineStep } from "@pario/core"
import { customersDataset, rawCustomersDataset } from "../datasets/customers"

export const cleanCustomersStep = definePipelineStep("clean-customers")
  .inputs({ rawCustomers: rawCustomersDataset })
  .output(customersDataset)
  .sql(({ rawCustomers }) => `
    select
      id,
      trim(name) as name,
      email
    from ${rawCustomers}
  `)

export const customersPipeline = definePipeline("customers")
  .when(datasetUpdated(rawCustomersDataset.id))
  .then(cleanCustomersStep)
```

SQL steps require a lake storage provider with SQL transform support. Pario does not fall back to
JavaScript execution when SQL support is missing.

`definePipelineStep(...)` is inert by itself. Exporting a standalone step does not register work
unless a `definePipeline(...)` references it with `.then(step)`.

## Compose Steps

```ts
export const customerInsightsPipeline = definePipeline("customer-insights")
  .when(datasetUpdated(rawCustomersDataset.id))
  .then(cleanCustomersStep)
  .then(customerInsightsStep)
```

V1 runs steps sequentially. If an earlier step commits successfully and a later step fails, the
earlier dataset version remains durable and the pipeline run is marked failed.

## Define Run Steps

Use run steps when the transform needs TypeScript logic, library calls, or row-by-row behavior that
does not fit naturally in SQL.

```ts
export const cleanCustomersRunStep = definePipelineStep("clean-customers")
  .inputs({ rawCustomers: rawCustomersDataset })
  .output(customersDataset)
  .run(async ({ inputs, output }) => {
    async function* rows() {
      for await (const row of inputs.rawCustomers.readRows()) {
        yield {
          id: row.id,
          name: String(row.name).trim(),
          email: row.email,
        }
      }
    }

    await output.writeRows(rows())
  })
```

The worker pins each input to a committed dataset version before calling the handler, and the
handler writes through a worker-owned output writer.

## Running Pipelines

`pario dev` co-hosts `PipelineWorker` automatically when pipelines are registered.

For a separate worker process:

```bash
pario worker --worker pipeline
```

Running all workers with `pario worker` starts the worker types that have registered definitions in
the project.
