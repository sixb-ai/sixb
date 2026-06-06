# Workflow

A workflow runs a business process in a known order.

Use workflows when work needs multiple named steps, typed data between those steps, and a run
history you can inspect.

## Why it is useful

Workflows are useful when a process should be more than one function call.

Use a workflow to:

- prepare data before an action
- break a process into clear steps
- pass typed outputs from one step to the next
- request object actions at the right time
- track whether a process is running, succeeded, or failed

A workflow is made of steps and optional actions. Steps create data. Actions do something to an
object.

## Define a step

File: `workflows/invoice-reminder.ts`

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

A step is a typed function. It declares the input it needs, the output it returns, and the code
that runs.

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
    target: steps.prepareInvoiceReminder.invoice,
    params: {
      message: steps.prepareInvoiceReminder.message,
    },
  }))
```

This workflow prepares a reminder message, then requests the `sendReminder` action for the
invoice.

`sendReminder` is an object action defined elsewhere. The workflow decides when to call it and
what params to pass.

## What each part does

| Part | Meaning |
| --- | --- |
| `defineWorkflow("invoice-reminder")` | Names the workflow |
| `.input({ invoice })` | Declares the input needed to start the workflow |
| `.then(prepareInvoiceReminder)` | Runs a step |
| `.then(sendReminder, mapper)` | Requests an action |
| `steps.prepareInvoiceReminder` | Reads output from the earlier step |

Step ids become camelCase keys in `steps`. For example, `prepare-invoice-reminder` becomes
`steps.prepareInvoiceReminder`.

## Pass data between steps

Use direct `.then(step)` when the previous output already matches the next step input.

```ts
export const reviewInvoiceWorkflow = defineWorkflow("review-invoice")
  .input({
    invoice: ref(Invoice),
  })
  .then(prepareInvoiceReminder)
  .then(reviewReminderMessage)
```

Use a mapper when the next step or action needs a specific shape.

```ts
export const reviewInvoiceWorkflow = defineWorkflow("review-invoice")
  .input({
    invoice: ref(Invoice),
  })
  .then(prepareInvoiceReminder)
  .then(reviewReminderMessage, ({ input, steps }) => ({
    invoice: input.invoice,
    message: steps.prepareInvoiceReminder.message,
  }))
```

Mappers can read the original workflow `input` and outputs from earlier `steps`.

## Add a schedule

Workflows can start from a schedule.

```ts
import { defineSchedule, defineWorkflow } from "@sixb/core"

export const daily = defineSchedule("daily-invoice-reminders").cron("0 9 * * *")

export const dailyInvoiceReminders = defineWorkflow("daily-invoice-reminders")
  .input({})
  .when(daily)
  .then(findInvoicesToRemind)
```

Scheduled workflows should use empty input. A schedule says "run now"; it does not provide an
invoice, customer, or other business object.

If a workflow needs input, start it from your app or API with that input.

## Workflow vs other concepts

| Need | Use |
| --- | --- |
| Move data from an external system | Sync |
| Clean or join table data | Pipeline |
| Turn rows into objects | Projection |
| Watch whether an object needs attention | Rule |
| Run a multi-step business process | Workflow |
| Perform one command on one object | Action |

A good rule: workflows coordinate work; steps and actions do the work.

## Convention

Put workflow definitions in `workflows/` and export them.

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

`createSixb()` discovers exported workflow definitions from `workflows/` automatically.

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

## How to model workflows

Start with the business process, not the code.

1. Name the outcome the workflow should produce.
2. Decide what input is needed to start.
3. Define the smallest first step.
4. Add another step only when it has a clear job.
5. Use actions for side effects on objects.
6. Add a schedule only when the workflow can start without business input.

Good workflow names describe the process:

- `invoice-reminder`
- `review-invoice`
- `close-stale-projects`
- `daily-health-check`

## Starting workflows

A workflow can be started by your app, by the API, or by a schedule.

In local development, `sixb dev` can run workflow workers when workflows are registered.

For a separate worker process:

```bash
sixb worker workflow
```

## Extra details

- workflows run nodes sequentially in V1.
- a workflow must contain at least one node.
- step input and output are validated at runtime.
- action nodes must use a mapper.
- action nodes request object actions and wait for them to finish.
- scheduled auto-start works for workflows with empty input.
- registered workflows can be inspected with `sixb.getWorkflowDefinitions()` and
  `sixb.getWorkflowById(...)`.

The important first step is to make each workflow read like the business process it represents.
