# Pipelines

A pipeline transforms [datasets](./datasets.md). Reach for one after a [sync](./syncs.md) lands raw
source rows that need to be cleaned, filtered, reshaped, joined, or made ready for a
[projection](./projections.md).

A pipeline is a sequence of **steps**. Each step reads one or more input datasets and writes one
output dataset. Steps are inert definitions — a step only runs when a pipeline references it with
`.then(...)`.

## Define a pipeline

Suppose a sync has populated `erpInvoicesDataset` with raw ERP rows. This pipeline keeps only
billable invoices, then derives a finance summary table.

File: `pipelines/invoice-reporting.ts`

```ts
import { datasetUpdated, definePipeline, definePipelineStep } from "@sixb/core"
import {
  erpBillableInvoicesDataset,
  erpInvoiceSummariesDataset,
  erpInvoicesDataset,
} from "../datasets/erp"

export const billableInvoicesStep = definePipelineStep("billable-invoices")
  .inputs({ invoices: erpInvoicesDataset })
  .output(erpBillableInvoicesDataset)
  .sql(({ invoices }) => `
    select *
    from ${invoices}
    where status in ('sent', 'paid', 'overdue')
  `)

export const invoiceSummariesStep = definePipelineStep("invoice-summaries")
  .inputs({ invoices: erpBillableInvoicesDataset })
  .output(erpInvoiceSummariesDataset)
  .sql(({ invoices }) => `
    select id, number, amount, currency, status, customer_id, project_id
    from ${invoices}
  `)

export const invoiceReportingPipeline = definePipeline("invoice-reporting")
  .when(datasetUpdated(erpInvoicesDataset.id))
  .then(billableInvoicesStep)
  .then(invoiceSummariesStep)
```

This runs whenever `erpInvoicesDataset` commits a new version. The first step writes billable
invoices; the second reads that output and writes a trimmed summary.

| Part | Meaning |
| --- | --- |
| `definePipelineStep("billable-invoices")` | Defines one transform step |
| `.inputs({ invoices })` | Names the datasets the step reads |
| `.output(dataset)` | The dataset the step writes |
| `.sql(...)` / `.run(...)` | The transform (terminal — pick one) |
| `definePipeline("invoice-reporting")` | Names the pipeline |
| `.when(datasetUpdated(...))` | Trigger that runs the pipeline |
| `.then(step)` | Appends a step to the sequence |

## Step builder

`definePipelineStep(id)` chains in a fixed order: `.inputs(...)`, then `.output(...)`, then a
terminal `.sql(...)` or `.run(...)`. Input keys become the names you read inside the executor.

| Method | Purpose |
| --- | --- |
| `.inputs(record)` | Named input datasets, e.g. `{ invoices: erpInvoicesDataset }`. At least one required. |
| `.output(dataset, options?)` | Output dataset and optional write mode. |
| `.sql(fn)` | SQL transform. `fn` receives each input as an interpolatable ref. |
| `.run(handler)` | TypeScript transform. `handler` receives a run context. |

### Write mode

```ts
.output(erpInvoiceSummariesDataset, { mode: "append" })
```

| `mode` | Behavior |
| --- | --- |
| `"snapshot"` (default) | Writes a full replacement version. |
| `"append"` | Appends rows to the output dataset. |

## SQL steps

Use SQL when the transform is a query — select, rename, filter, join, aggregate. Each input name
interpolates into the query as a table reference.

```ts
export const overdueInvoicesStep = definePipelineStep("overdue-invoices")
  .inputs({ invoices: erpInvoicesDataset })
  .output(erpOverdueInvoicesDataset)
  .sql(({ invoices }) => `
    select id, number, amount, currency, customer_id
    from ${invoices}
    where status = 'overdue'
  `)
```

SQL steps run on the DuckDB dialect and require a lake storage provider with SQL transform
support. See [connectors](./connectors.md) for storage providers.

## TypeScript steps

Use `.run(...)` when the transform needs application logic, library calls, or row-by-row work that
does not fit SQL. The handler receives a context with the named `inputs` and an `output`.

```ts
import type { DatasetRow } from "@sixb/core"

async function* billable(rows: AsyncIterable<DatasetRow>) {
  for await (const row of rows) {
    if (row.status === "sent" || row.status === "paid" || row.status === "overdue") {
      yield row
    }
  }
}

export const billableInvoicesStep = definePipelineStep("billable-invoices")
  .inputs({ invoices: erpInvoicesDataset })
  .output(erpBillableInvoicesDataset)
  .run(async ({ inputs, output }) => {
    await output.writeRows(billable(inputs.invoices.readRows()))
  })
```

The run context exposes:

| Field | Type | Description |
| --- | --- | --- |
| `inputs[name]` | `PipelineStepInput` | One per `.inputs(...)` key. Has `dataset`, `version`, `readRows(input?)`. |
| `output` | `PipelineStepOutput` | `writeRows(rows)` accepts a sync or async iterable of rows. |
| `projectId`, `pipelineId`, `stepId`, `runId` | `string` | Identifiers for the current run. |
| `signal` | `AbortSignal` | Aborts when the run is cancelled. |

`readRows(input?)` returns an `AsyncIterable` of rows; pass read options to scope the read. Prefer
SQL when the transform is a query; reach for TypeScript when it needs code.

## Compose steps

Steps run in order, and each commits its output before the next runs. A later step can read a
dataset an earlier step wrote, so chains build progressively richer tables.

```ts
export const invoiceReportingPipeline = definePipeline("invoice-reporting")
  .when(datasetUpdated(erpInvoicesDataset.id))
  .then(billableInvoicesStep)
  .then(invoiceSummariesStep)
```

## Triggers

Pass `.when(...)` a [trigger](../schedules/overview.md) or a [schedule](../schedules/overview.md).
Add more than one `.when(...)` to run on multiple triggers.

| Trigger | Runs when |
| --- | --- |
| `datasetUpdated(datasetId)` | A dataset commits a new version |
| `syncFinished(syncId)` | A sync run finishes successfully |
| `pipelineFinished(pipelineId)` | Another pipeline finishes successfully |
| a [schedule](../schedules/overview.md) | The schedule fires |

```ts
import { defineSchedule } from "@sixb/core"

const nightly = defineSchedule("nightly-invoices").cron("0 2 * * *")

export const nightlyInvoices = definePipeline("invoice-reporting")
  .when(nightly)
  .then(billableInvoicesStep)
```

## Pipeline vs sync

| Need | Use |
| --- | --- |
| Read from an external system (e.g. the ERP) | [Sync](./syncs.md) |
| Write raw source rows | [Sync](./syncs.md) |
| Clean or reshape rows | Pipeline |
| Join datasets | Pipeline |
| Create projection-ready rows | Pipeline |

A good rule: sync first, shape later.

## Registration

`createSixb()` discovers exported pipeline definitions from `pipelines/` automatically.

```txt
your-project/
  datasets/
    erp.ts
  syncs/
    erp.ts
  pipelines/
    invoice-reporting.ts
  projections/
    invoices.ts
  sixb.config.ts
```

You can also register pipelines explicitly:

```ts
import { createSixb } from "@sixb/core"
import { erpBillableInvoicesDataset, erpInvoicesDataset } from "./datasets/erp"
import { invoiceReportingPipeline } from "./pipelines/invoice-reporting"

export const sixb = await createSixb({
  datasets: [erpInvoicesDataset, erpBillableInvoicesDataset],
  pipelines: [invoiceReportingPipeline],
})
```

## Running pipelines

In local development, `sixb dev` co-hosts pipeline workers when pipelines are registered.

In production, run a dedicated pipeline worker:

```bash
sixb worker pipeline
```

For constrained deployments, `sixb worker-group` co-hosts several queue workers in one process:

```bash
sixb worker-group sync pipeline projection
```

See [deployment](../deployment/overview.md) for running workers in production.

## Notes

- Steps write `snapshot` output by default; use `{ mode: "append" }` when you mean to add rows.
- Pipeline steps run sequentially.
- If a later step fails, earlier committed dataset versions stay durable.

Keep each pipeline focused on turning one table shape into a better one.

## Next

- [Projections](./projections.md) — map pipeline output rows onto ontology objects
- [Datasets](./datasets.md) — define the input and output tables
- [Syncs](./syncs.md) — get raw source rows into Sixb
