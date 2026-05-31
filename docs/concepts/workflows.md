# Workflow

A workflow describes an ordered business process over typed inputs, step outputs, and action
requests.

## What It Is

- an inert definition built with `defineWorkflow(...)`
- a typed input contract using the same schema language as ontology values and action params
- a linear sequence of step and action nodes
- optionally triggered by a schedule
- registered explicitly or discovered from `workflows/`
- routable by the orchestrator when a scheduled workflow has empty input

Workflows are useful when business logic needs to move through several named stages and keep the
data passed between those stages typed.

## Parts

| Piece | Role |
| --- | --- |
| `defineWorkflowStep` | Defines one reusable step handler with input and output schemas |
| `defineWorkflow` | Defines the workflow input and ordered node list |
| `.then(step)` | Adds a step when previous output already matches the step input |
| `.then(step, mapper)` | Adds a step with an explicit input mapper |
| `.then(action, mapper)` | Adds an action request node with target and params mapping |
| `.when(schedule)` | Adds a schedule trigger to the definition |
| `compileRoutes(...)` | Routes eligible scheduled workflows to `queues.workflows` |
| `WorkflowWorker` | Consumes queued workflow runs and executes nodes sequentially |

## Define a Step

File: `workflows/reconcileTransaction.ts`

```ts
import { defineWorkflowStep, ref } from "@pario/core"
import { Invoice, Transaction } from "../ontology/transaction"

export const findBestInvoice = defineWorkflowStep("find-best-invoice")
  .input({
    transaction: ref(Transaction),
  })
  .output({
    transaction: ref(Transaction),
    invoice: ref(Invoice),
    confidence: "double",
  })
  .run(async ({ input, pario }) => {
    return {
      transaction: input.transaction,
      invoice: { objectTypeId: "Invoice", primaryId: "invoice:1" },
      confidence: 0.98,
    }
  })
```

Step ids are also used to derive keys for `steps` data. For example, `find-best-invoice` becomes
`steps.findBestInvoice`.

## Compose a Workflow

```ts
import { actionParam, defineAction, defineWorkflow, ref } from "@pario/core"
import { Invoice, Transaction } from "../ontology/transaction"
import { findBestInvoice } from "./reconcileTransaction"

export const attachInvoice = defineAction("attach-invoice")
  .target(Transaction)
  .params({
    invoice: actionParam(ref(Invoice), { required: true }),
  })
  .run(async () => {})

export const reconcileTransaction = defineWorkflow("reconcile-transaction")
  .input({
    transaction: ref(Transaction),
  })
  .then(findBestInvoice)
  .then(attachInvoice, ({ input, steps }) => ({
    target: input.transaction,
    params: {
      invoice: steps.findBestInvoice.invoice,
    },
  }))
```

The action mapper must return:

```ts
{
  target: { objectTypeId: "Transaction", primaryId: "txn_123" },
  params: { invoice: { objectTypeId: "Invoice", primaryId: "invoice:1" } },
}
```

Action nodes do not add business output to `steps`.

## Step Dataflow

When the previous workflow state already matches the next step input, use direct dataflow:

```ts
defineWorkflow("direct-reconciliation")
  .input({ transaction: ref(Transaction) })
  .then(findBestInvoice)
  .then(reviewInvoiceMatch)
```

Use a mapper when the next step needs a different shape:

```ts
defineWorkflow("mapped-reconciliation")
  .input({ transaction: ref(Transaction) })
  .then(findBestInvoice)
  .then(reviewInvoiceMatch, ({ input, steps }) => ({
    transaction: input.transaction,
    invoice: steps.findBestInvoice.invoice,
    confidence: steps.findBestInvoice.confidence,
  }))
```

Mappers receive:

- `input`: the original workflow input
- `steps`: outputs from earlier step nodes, keyed by derived step key

Later step outputs are not available yet, and action nodes do not expose step output.

## Schedule Triggers

Workflows can attach schedule triggers:

```ts
import { defineSchedule, defineWorkflow } from "@pario/core"

export const daily = defineSchedule("daily-reconciliation").cron("0 6 * * *")

export const nightlyReconciliation = defineWorkflow("nightly-reconciliation")
  .input({})
  .when(daily)
  .then(findTransactionsToReview)
```

A schedule event has no business payload. Because of that, the orchestrator only auto-routes
scheduled workflows whose input shape is empty.

This is routable:

```ts
defineWorkflow("nightly-reconciliation").input({}).when(daily).then(findTransactionsToReview)
```

This is registered and valid, but not auto-routed from the schedule:

```ts
defineWorkflow("reconcile-transaction")
  .input({ transaction: ref(Transaction) })
  .when(daily)
  .then(findBestInvoice)
```

Use `compileRoutesWithDiagnostics(...)` to see skipped scheduled workflows:

```ts
import { compileRoutesWithDiagnostics } from "@pario/orchestrator"

const { routes, diagnostics } = compileRoutesWithDiagnostics({
  syncs: pario.getSyncDefinitions(),
  pipelines: pario.getPipelineDefinitions(),
  projections: [...pario.getObjectProjections(), ...pario.getLinkProjections()],
  workflows: pario.getWorkflowDefinitions(),
})
```

The diagnostic type is:

```ts
{
  type: "workflow.schedule.input-required",
  workflowId: "reconcile-transaction",
  scheduleId: "daily-reconciliation",
  inputFields: ["transaction"],
}
```

## Discovery

Export workflow definitions from `workflows/`:

```txt
your-project/
  actions/
    attachInvoice.ts
  ontology/
    transaction.ts
  schedules/
    daily.ts
  workflows/
    reconcileTransaction.ts
  pario.config.ts
```

`createPario()` scans `workflows/` and registers exported workflow definitions automatically.

You can also register workflows explicitly:

```ts
createPario({
  ontologies: [Transaction, Invoice],
  actions: [attachInvoice],
  schedules: [daily],
  workflows: [reconcileTransaction],
  // ...
})
```

Registered workflows can be inspected from the runtime:

```ts
pario.getWorkflowDefinitions()
pario.getWorkflowById("reconcile-transaction")
```

## Runtime Validation

At startup, Pario rejects:

- duplicate workflow ids
- workflows with no nodes
- workflow triggers that are not schedules
- workflows referencing unknown schedules
- workflows referencing unknown actions
- duplicate node ids
- duplicate derived node keys
- action nodes without a mapper

## How Scheduled Routing Fits

The orchestrator compiles routes at startup:

```text
workflow definitions
  -> compileRoutes(...)
  -> route table
```

When a matching schedule event is observed, the orchestrator enqueues a workflow run request:

```text
schedule.triggered
  -> OrchestratorWorker
  -> queues.workflows.enqueue(workflow.run.requested)
```

The queued payload for an empty-input scheduled workflow looks like:

```ts
{
  type: "workflow.run.requested",
  payload: {
    workflowId: "nightly-reconciliation",
    input: {},
  },
}
```

Source event metadata is attached to the queue job envelope.

In local development, `pario dev` co-hosts `WorkflowWorker` when workflows are registered:

```text
pario dev
  -> compile workflow routes
  -> start WorkflowWorker
  -> start OrchestratorWorker
  -> start scheduler
```

For a dedicated process, use:

```bash
pario worker workflow
```

## Current Scope

The current workflow surface defines, registers, validates, discovers, routes, and executes
sequential workflow definitions. It does not add branching, parallel execution, nested workflows, trigger admission mappers, or aliases for workflow node keys.

Scheduled auto-routing only supports empty workflow input. Workflows with required input need an
explicit caller or a future trigger-admission mapper that can build input from the triggering event.

## Guidelines

- Keep workflow ids stable and business-readable.
- Use step ids that produce readable derived keys, such as `find-best-invoice`.
- Prefer direct `.then(step)` when the previous output already matches the next input.
- Use mappers when passing a small, explicit shape is clearer.
- Keep action nodes for side-effect requests and step nodes for workflow dataflow.
- Use empty workflow input for scheduled workflows in V1.
