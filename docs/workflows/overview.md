# Workflows

A workflow runs a business process in a known order. Use a workflow when work needs multiple
named steps, typed data flowing between them, and a run history you can inspect.

A workflow is made of **steps** (which create typed data), optional **action nodes** (which run an
object [action](../actions/overview.md)), and optional **interventions** (which pause for a human
decision — see [Interventions](interventions.md)).

## When to use a workflow

| Need | Use |
| --- | --- |
| Move data from an external system | [Sync](../data/syncs.md) |
| Clean or join table data | [Pipeline](../data/pipelines.md) |
| Turn rows into objects | [Projection](../data/projections.md) |
| Watch whether an object needs attention | [Rule](../rules/overview.md) |
| Perform one command on one object | [Action](../actions/overview.md) |
| Run a multi-step business process | Workflow |

Workflows coordinate work; steps and actions do the work.

## Define a step

A step is a typed function. It declares the input it needs, the output it returns, and the code
that runs. File: `workflows/invoice-reminder.ts`.

```ts
import { defineWorkflowStep, ref } from "@sixb/core"
import { Invoice } from "../ontology/invoice"

export const prepareInvoiceReminder = defineWorkflowStep("prepare-invoice-reminder")
  .input({
    invoice: ref(Invoice),
  })
  .output({
    invoice: ref(Invoice),
    message: "string",
  })
  .run(({ input }) => ({
    invoice: input.invoice,
    message: "Please review this invoice and submit payment when convenient.",
  }))
```

The `.run(...)` handler receives `{ input, sixb }`. Use `sixb` to read or write objects from inside
a step.

```ts
export const loadInvoiceContext = defineWorkflowStep("load-invoice-context")
  .input({ invoice: ref(Invoice) })
  .output({ invoice: ref(Invoice), status: "string" })
  .run(async ({ input, sixb }) => {
    const invoice = await sixb.objects(Invoice).get(input.invoice.primaryId)
    if (!invoice) {
      throw new Error(`[AcmeCorp] Invoice '${input.invoice.primaryId}' was not found.`)
    }
    return {
      invoice: input.invoice,
      status: String(invoice.properties.status ?? "unknown"),
    }
  })
```

## Compose a workflow

```ts
import { defineWorkflow, ref } from "@sixb/core"
import { sendReminder } from "../actions/send-reminder"
import { Invoice } from "../ontology/invoice"
import { prepareInvoiceReminder } from "./invoice-reminder"

export const invoiceReminderWorkflow = defineWorkflow("invoice-reminder")
  .input({
    invoice: ref(Invoice),
  })
  .then(prepareInvoiceReminder)
  .then(sendReminder, ({ steps }) => ({
    subject: steps.prepareInvoiceReminder.invoice,
    params: {
      message: steps.prepareInvoiceReminder.message,
    },
  }))
```

This workflow prepares a reminder message, then requests the `sendReminder` object action for the
invoice. The workflow decides when to call the action and what params to pass.

| Part | Meaning |
| --- | --- |
| `defineWorkflow("invoice-reminder")` | Names the workflow |
| `.input({ invoice })` | Declares the input needed to start the workflow |
| `.when(schedule)` | Auto-starts the workflow from a [schedule](../schedules/overview.md) |
| `.then(step)` | Runs a step |
| `.then(action, mapper)` | Requests an object action |
| `.then(intervention)` | Pauses for a human decision |
| `steps.prepareInvoiceReminder` | Reads output from an earlier node |

Node ids become camelCase keys on `steps`. For example, `prepare-invoice-reminder` becomes
`steps.prepareInvoiceReminder`.

## Pass data between nodes

Use a direct `.then(node)` when the previous output already matches the next node's input shape.

```ts
export const reviewInvoiceWorkflow = defineWorkflow("review-invoice")
  .input({ invoice: ref(Invoice) })
  .then(prepareInvoiceReminder)
  .then(reviewReminderMessage)
```

Use a **mapper** when the next node needs a specific shape. A mapper receives
`{ input, steps }` — the original workflow `input` and outputs from earlier `steps`.

```ts
export const reviewInvoiceWorkflow = defineWorkflow("review-invoice")
  .input({ invoice: ref(Invoice) })
  .then(prepareInvoiceReminder)
  .then(reviewReminderMessage, ({ input, steps }) => ({
    invoice: input.invoice,
    message: steps.prepareInvoiceReminder.message,
  }))
```

## Action nodes

An action node requests an object action and waits for it to finish. Action nodes **must** use a
mapper. For an object action, the mapper returns `subject` (the object the action runs on) and
`params`.

```ts
  .then(sendReminder, ({ steps }) => ({
    subject: steps.composeInvoiceReminder.invoice,
    params: {
      message: steps.composeInvoiceReminder.message,
    },
  }))
```

For a global action, omit `subject` and return only `params`. See
[Actions](../actions/overview.md) for how actions are defined and bound.

## Human-in-the-loop with interventions

To pause a workflow and wait for a human decision, add an **intervention** node. The workflow
suspends until a response is submitted, then resumes with that response available on `steps`. See
[Interventions](interventions.md) for the full reference.

```ts
import { defineIntervention, interventionField, ref } from "@sixb/core"

export const reviewInvoiceReminder = defineIntervention("review-invoice-reminder", {
  description: "Approve or request changes before sending the invoice reminder.",
})
  .input({
    invoice: ref(Invoice),
    message: "string",
  })
  .response({
    approved: interventionField("boolean", { required: true }),
    message: interventionField("string", { required: true }),
    reviewerNote: interventionField("string", { required: false }),
  })
  .defaults(({ input }) => ({
    approved: true,
    message: input.message,
  }))
```

Add it to the chain, then read its response downstream:

```ts
  .then(reviewInvoiceReminder)
  .then(sendReminder, ({ steps }) => ({
    subject: steps.composeInvoiceReminder.invoice,
    params: {
      approved: steps.reviewInvoiceReminder.approved,
      message: steps.reviewInvoiceReminder.message,
    },
  }))
```

## Start from a schedule

A workflow can auto-start from a [schedule](../schedules/overview.md) with `.when(...)`.

```ts
import { defineSchedule, defineWorkflow } from "@sixb/core"

export const daily = defineSchedule("daily-invoice-reminders").cron("0 9 * * *")

export const dailyInvoiceReminders = defineWorkflow("daily-invoice-reminders")
  .input({})
  .when(daily)
  .then(findInvoicesToRemind)
```

Scheduled workflows must use empty input. A schedule says "run now"; it does not provide an
invoice, customer, or other business object. If a workflow needs input, start it from your app or
the API with that input.

## Register workflows

Put workflow definitions in `workflows/` and export them. `createSixb()` discovers them
automatically.

```txt
your-project/
  actions/
    send-reminder.ts
  ontology/
    invoice.ts
  workflows/
    invoice-reminder.ts
  sixb.config.ts
```

You can also register workflows explicitly:

```ts
import { createSixb } from "@sixb/core"
import { sendReminder } from "./actions/send-reminder"
import { Invoice } from "./ontology/invoice"
import { invoiceReminderWorkflow } from "./workflows/invoice-reminder"

export const sixb = createSixb({
  ontology: [Invoice],
  actions: [sendReminder],
  workflows: [invoiceReminderWorkflow],
})
```

## Start and inspect runs

Registered workflows are reachable through `sixb.workflows`.

| Method | Returns |
| --- | --- |
| `sixb.workflows.list()` | All registered workflow definitions |
| `sixb.workflows.getById(id)` | One definition, or `null` |
| `sixb.workflows.request(workflow, options?)` | Starts a run with typed input |
| `sixb.workflows.requestById(input)` | Starts a run by workflow id |

Start a run with typed input:

```ts
const result = await sixb.workflows.request(invoiceReminderWorkflow, {
  input: {
    invoice: { objectTypeId: "Invoice", primaryId: "inv-001" },
  },
})

console.log(result.runId)
```

A workflow input field declared with `ref(Invoice)` takes a ref value of the shape
`{ objectTypeId, primaryId }`.

`request(...)` returns `{ workflowId, runId, queuedAt, jobId?, created }`. `created` is `false` when
a run with the same deterministic `runId` already existed, so no duplicate job was enqueued.

Start a run by id (useful for server routes and dynamic cases):

```ts
await sixb.workflows.requestById({
  workflowId: "invoice-reminder",
  input: {
    invoice: { objectTypeId: "Invoice", primaryId: "inv-001" },
  },
})
```

## Run workers

In local development, `sixb dev` runs workflow workers when workflows are registered. For a
separate worker process:

```bash
sixb worker workflow
```

## Behavior notes

- Workflows run nodes sequentially in V1.
- A workflow must contain at least one node.
- Step input and output are validated at runtime.
- Action nodes must use a mapper and wait for the action to finish.
- Intervention nodes pause the run until a response is submitted.
- Scheduled auto-start works only for workflows with empty input.

## Related

- [Rules](../rules/overview.md) — watch objects and react
- [Interventions](interventions.md) — human-in-the-loop pauses
- [Actions](../actions/overview.md) — commands run by action nodes
- [Automation](../schedules/overview.md) — schedules and triggers
