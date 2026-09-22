# Workflows

A workflow runs a sequence of steps, passing data from one step to the next. Combine code, AI
tasks, and actions into a process that Sixb runs and tracks.

## Define a workflow

Export a workflow from `workflows/`. Sixb discovers it automatically. Define steps with
`defineWorkflowStep()`, then add them to a workflow with `.then()`.

A step declares its input, output, and the code to run. This step reads an invoice and prepares a
reminder:

File: `workflows/invoice-reminder.ts`

```ts
import { defineWorkflow, defineWorkflowStep, ref } from "@sixb/core"
import { Invoice } from "../ontology/invoice"

export const prepareReminder = defineWorkflowStep("prepare-reminder")
  .input({ invoice: ref(Invoice) })
  .output({ invoice: ref(Invoice), message: "string" })
  .run(async ({ input, sixb }) => {
    const invoice = await sixb.objects(Invoice).get(input.invoice.primaryId)
    if (!invoice) throw new Error("Invoice not found.")

    return {
      invoice: input.invoice,
      message: `Please arrange payment for invoice ${invoice.properties.number}.`,
    }
  })

export const invoiceReminder = defineWorkflow("invoice-reminder")
  .input({ invoice: ref(Invoice) })
  .then(prepareReminder)
```

`ref(Invoice)` declares an invoice reference containing `objectTypeId` and `primaryId`.
The step's `sixb` context gives you access to objects, connectors, and other framework APIs.

Steps run in order. Sixb validates their inputs and outputs, and a failed step stops the run.

## Pass data between steps

The first step receives the workflow's input. Each following `.then(step)` receives the previous
step's output, which must contain the fields it needs.

To change that input, pass a mapper as the second argument to `.then()`. It receives the original
workflow `input` and earlier outputs in `steps`. Step IDs become camelCase keys:
`prepare-reminder` becomes `steps.prepareReminder`.

## Run an action

Add an [action](../actions/overview.md) with `.then(action, mapper)`. The mapper returns the action's
`subject` and `params`. The workflow waits for the action to finish before continuing.

For a project action named `sendReminder` that accepts a `message` parameter, extend the workflow
above like this:

```ts
import { sendReminder } from "../actions/send-reminder"

export const invoiceReminder = defineWorkflow("invoice-reminder")
  .input({ invoice: ref(Invoice) })
  .then(prepareReminder)
  .then(sendReminder, ({ input, steps }) => ({
    subject: input.invoice,
    params: { message: steps.prepareReminder.message },
  }))
```

For a global action, return only `params`.

## Add an AI task

Use `defineAgentStep()` when a task needs an AI model to work with tools. Declare the input and
expected output, then provide instructions and a prompt:

```ts
import { defineAgentStep, ref } from "@sixb/core"
import { Invoice } from "../ontology/invoice"
import { finance } from "../security/groups/finance"

export const draftReminder = defineAgentStep("draft-reminder", {
  instructions: "Read the invoice and draft a reminder. Do not send it.",
  groups: [finance],
})
  .input({ invoice: ref(Invoice) })
  .output({ message: "string" })
  .prompt(({ input }) => `Draft a reminder for invoice '${input.invoice.primaryId}'.`)
```

Add it with `.then(draftReminder)`, just like a regular step. The workflow waits for its validated
output before continuing.

The task uses your [configured language model](../models/configuration.md#language-models) and built-in sandbox
tools. `groups` controls its access to project data; grant the example's `finance` group permission
to read invoices. Without groups, it has no project grants. To add custom tools, select them with
`tools: [...]` and register them in `createSixb({ tools })`. See
[Tools and skills](../models/tools-and-authorization.md).

For a single model call that does not need tools, use an ordinary step with
[`sixb.models.language.generate()`](../models/configuration.md#generate-a-response).

## Start a workflow

Run a workflow from Atlas, or request it from your app with the
[Client SDK](../client/typed-queries.md#react-hooks). Use `requestWorkflowRunMutation()` from
`@sixb/client/hooks` to submit its input from a React component.

To start automatically, attach a [schedule](../schedules/overview.md) with `.when()` before the first
step. For an event schedule, map the event into the workflow's input. Using the `highValueInvoice`
schedule from the [Schedules guide](../schedules/overview.md#run-on-an-event):

```ts
import { highValueInvoice } from "../schedules/invoices"

export const invoiceReminder = defineWorkflow("invoice-reminder")
  .input({ invoice: ref(Invoice) })
  .when(highValueInvoice, ({ event }) => ({
    invoice: { objectTypeId: Invoice.id, primaryId: event.object.primaryId },
  }))
  .then(prepareReminder)
  .then(sendReminder, ({ input, steps }) => ({
    subject: input.invoice,
    params: { message: steps.prepareReminder.message },
  }))
```

Cron schedules do not supply input, so workflows attached to them must declare `.input({})`.

To pause for a review before sending, add an intervention. See
[Human-in-the-Loop](interventions.md) for defining the review and submitting a response.
