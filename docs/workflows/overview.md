# Workflows

A workflow runs a business process in a known order. Reach for one when work needs multiple named
steps, typed data flowing between them, an object [action](../actions/overview.md) at the end, and a
run history you can inspect.

A workflow chains **nodes**: **steps** (typed functions), **agent tasks** (model-driven work with
structured output), **action nodes**, and **interventions** (human decisions — see
[Interventions](interventions.md)).

## When to use a workflow

| Need | Use |
| --- | --- |
| Move data from an external system | [Sync](../data/syncs.md) |
| Clean or join table data | [Pipeline](../data/pipelines.md) |
| Turn rows into objects | [Projection](../data/projections.md) |
| Watch whether an object needs attention | [Rule](../rules/overview.md) |
| Perform one command on one object | [Action](../actions/overview.md) |
| Run a multi-step business process | Workflow |

Workflows coordinate the work; steps and actions do it.

## Define steps

A step is a typed function: it declares the `input` it needs, the `output` it returns, and the code
that runs. The `.run(...)` handler receives `{ input, sixb }` — use `sixb` to read or write objects.

```ts
import { defineWorkflowStep, ref } from "@sixb/core"
import { Invoice } from "../ontology/invoice"

const loadInvoiceContext = defineWorkflowStep("load-invoice-context")
  .input({ invoice: ref(Invoice) })
  .output({
    invoice: ref(Invoice),
    invoiceNumber: "string",
    amountLabel: "string",
    status: "string",
  })
  .run(async ({ input, sixb }) => {
    const invoice = await sixb.objects(Invoice).get(input.invoice.primaryId)
    if (!invoice) {
      throw new Error(`[AcmeCorp] Invoice '${input.invoice.primaryId}' was not found.`)
    }

    const amount = Number(invoice.properties.amount ?? 0)
    const currency = String(invoice.properties.currency ?? "USD")

    return {
      invoice: input.invoice,
      invoiceNumber: String(invoice.properties.number ?? invoice.primaryId),
      amountLabel: `${currency} ${amount.toFixed(2)}`,
      status: String(invoice.properties.status ?? "unknown"),
    }
  })
```

A field typed `ref(Invoice)` carries an object reference of the shape `{ objectTypeId, primaryId }`.

## Define agent tasks

An agent task is a fresh, headless Agent execution dedicated to one workflow node. It does not
reuse the conversational Agent or its thread.

```ts
import { defineAgentStep, ref } from "@sixb/core"
import { finance } from "../security/groups/finance"
import { searchInvoices } from "../agent-tools/search-invoices"

const composeReminder = defineAgentStep("compose-reminder", {
  instructions: "Draft a concise reminder grounded in invoice data.",
  reasoning: "medium",
  groups: [finance],
  tools: [searchInvoices],
})
  .input({ invoice: ref(Invoice) })
  .output({ invoice: ref(Invoice), message: "string" })
  .prompt(({ input }) => `Draft a reminder for invoice '${input.invoice.primaryId}'.`)
```

During its tool loop, the model receives two distinct messages:

| Message | Content |
| --- | --- |
| System | Sixb runtime context, the step's `instructions`, then non-overridable workflow rules |
| User | The string returned by `.prompt(...)` for this run |

After the loop, Sixb performs a tool-free structured-output pass using the same instructions,
original prompt, and final answer. This validates the value against `.output(...)` without doing
new work.

| Option | Behavior |
| --- | --- |
| `instructions` | Stable task-specific guidance added to the system prompt |
| `model` | Optional; otherwise uses the first `models.language` entry |
| `reasoning` | Optional AI SDK reasoning level for the task |
| `groups` | Permissions of the task's stable, Sixb-managed service account; defaults to none |
| `tools` | Additional project-defined tools available to this task; defaults to none |

Tools must also be registered in `createSixb({ tools })`. When a model catalog is configured, an
explicit model must belong to `models.language`.

Every task also receives the sandboxed `sixb` CLI plus `read`, `view_file`, and `bash`. It can
therefore explore live project objects without a custom tool, within the permissions granted by
`groups`. The `tools` option only selects project-defined AI SDK tools for that task.

## Compose the chain

`defineWorkflow(id)` declares the input, then `.then(...)` appends each node in order.

```ts
import { defineWorkflow, ref } from "@sixb/core"
import { sendReminder } from "../actions/send-reminder"
import { Invoice } from "../ontology/invoice"

export const invoiceReminder = defineWorkflow("invoice-reminder")
  .input({ invoice: ref(Invoice) })
  .then(loadInvoiceContext)
  .then(composeReminder)
  .then(reviewReminder)
  .then(sendReminder, ({ steps }) => ({
    subject: steps.composeReminder.invoice,
    params: {
      approved: steps.reviewReminder.approved,
      message: steps.reviewReminder.message,
      reviewerNote: steps.reviewReminder.reviewerNote,
    },
  }))
```

| Part | Meaning |
| --- | --- |
| `defineWorkflow("invoice-reminder")` | Names the workflow |
| `.input({ invoice })` | Declares the input needed to start a run |
| `.when(schedule, mapper?)` | Auto-starts from a cron or [event schedule](../schedules/events.md) |
| `.then(step)` | Runs a step |
| `.then(agentTask)` | Runs an agent task and waits for its structured output |
| `.then(action, mapper)` | Runs an object action |
| `.then(intervention)` | Pauses for a human decision |
| `steps.composeReminder` | Reads the output of an earlier node |

Each node id becomes a camelCase key on `steps`: `compose-reminder` is `steps.composeReminder`.

## Pass data between nodes

Use a bare `.then(node)` when the previous output already matches the next node's input shape.

Use a **mapper** when the next node needs a different shape. A mapper receives `{ input, steps }` —
the original workflow `input` plus every earlier node's output — and returns the next node's input.

```ts
  .then(composeReminder, ({ input, steps }) => ({
    invoice: input.invoice,
    amountLabel: steps.loadInvoiceContext.amountLabel,
  }))
```

## Action nodes

An action node runs an object [action](../actions/overview.md) and waits for it to finish. Action
nodes **must** use a mapper. For an object action, the mapper returns `subject` (the object the
action runs on) and `params`:

```ts
  .then(sendReminder, ({ steps }) => ({
    subject: steps.composeReminder.invoice,
    params: {
      approved: steps.reviewReminder.approved,
      message: steps.reviewReminder.message,
      reviewerNote: steps.reviewReminder.reviewerNote,
    },
  }))
```

For a global action, omit `subject` and return only `params`.

## Pause for a human with interventions

An **intervention** node suspends the run until someone submits a response, then resumes with that
response on `steps`. Define it with `defineIntervention(id, options?)`: `.input(...)` is the data
the reviewer sees, `.response(...)` is the decision they submit, and `.defaults(...)` pre-fills the
form.

```ts
import { defineIntervention, interventionField, ref } from "@sixb/core"

export const reviewReminder = defineIntervention("review-reminder", {
  description: "Approve or request changes before sending the invoice reminder.",
})
  .input({ invoice: ref(Invoice), message: "string" })
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

Add it to the chain, then read the response in a later node (see the `sendReminder` mapper above,
which reads `steps.reviewReminder.approved`). See [Interventions](interventions.md) for the full
reference and how to submit a response.

## Start a run

Registered workflows are reachable through `sixb.workflows`.

| Method | Returns |
| --- | --- |
| `sixb.workflows.list()` | All registered workflow definitions |
| `sixb.workflows.getById(id)` | One definition, or `null` |
| `sixb.workflows.request(workflow, options?)` | Queues a run with typed input |
| `sixb.workflows.requestById(input)` | Queues a run by workflow id |

```ts
const result = await sixb.workflows.request(invoiceReminder, {
  input: {
    invoice: { objectTypeId: "Invoice", primaryId: "inv-001" },
  },
})

console.log(result.runId, result.created)
```

`request(...)` returns `{ workflowId, runId, queuedAt, jobId?, created }`. `created` is `false` when
a run with the same `runId` already existed, so no duplicate job was enqueued.

Use `sixb.workflows.requestById(...)` from server routes and dynamic cases where you only have the
id. The other primitives expose the same grouped shape through `actions.request`, `syncs.request`,
`pipelines.request`, and `agents.request`: everything is queued, never run inline.

```ts
await sixb.workflows.requestById({
  workflowId: "invoice-reminder",
  input: {
    invoice: { objectTypeId: "Invoice", primaryId: "inv-001" },
  },
})
```

The name is uniform; the guarantee is not, and the return type says so. A workflow run row exists as
soon as `workflows.requestById` resolves, which is what lets it report `created`. Sync and pipeline runs
are created by the worker that claims the job, so those two verbs report only that the request was
accepted — passing the same `runId` twice still produces one run, but the second call cannot tell you
it was a duplicate.

### Start from a schedule

A workflow can auto-start from a [schedule](../schedules/overview.md) with `.when(...)`. A schedule
says "run now" — it provides no business object, so **scheduled workflows must take empty input**.
If the run needs an invoice or customer, start it from your app or the API instead.

```ts
import { defineSchedule, defineWorkflow } from "@sixb/core"

export const daily = defineSchedule("daily-invoice-reminders").cron("0 9 * * *")

export const dailyInvoiceReminders = defineWorkflow("daily-invoice-reminders")
  .input({})
  .when(daily)
  .then(findOverdueInvoices)
```

### Bind to an event schedule

A workflow can reference an [event schedule](../schedules/events.md) with
`.when(schedule, mapper?)`. Use a mapper when the selected event must be converted into the
workflow input.

```ts
export const reviewHighValuePayment = defineWorkflow("review-high-value-payment")
  .input({
    invoice: ref(Invoice),
    payment: ref(Payment),
    amount: "double",
  })
  .when(highValuePaymentLinked, ({ event }) => ({
    invoice: event.source,
    payment: event.target,
    amount: event.link.p.amount,
  }))
  .then(reviewPayment)
```

## Run lifecycle

A run moves through these statuses, recorded per run and per node so you can inspect history:

| Status | Meaning |
| --- | --- |
| `queued` | Requested; waiting for a worker |
| `running` | A node is executing |
| `waiting` | Suspended while an intervention or agent task completes |
| `succeeded` | All nodes finished |
| `failed` | A node threw; the run stopped |
| `cancelled` | The run was cancelled |

Nodes run sequentially. Step `input` and `output` are validated against their schemas at runtime, so
a malformed shape fails the run rather than passing bad data downstream.

`GET /api/workflows` carries a `latestRun` per workflow. It is `null` when the workflow has never
run, and also when the `storage` provider keeps no run history — every published provider does, so
only a partial custom provider hits that second case.

## Register and run

Put workflow definitions under `workflows/` and export them. `createSixb()` discovers them
automatically, along with the actions and ontology they reference.

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

You can also register them explicitly. `createSixb()` is async:

```ts
import { createSixb } from "@sixb/core"
import { sendReminder } from "./actions/send-reminder"
import { Invoice } from "./ontology/invoice"
import { invoiceReminder } from "./workflows/invoice-reminder"

export const sixb = await createSixb({
  ontologies: [Invoice],
  actions: [sendReminder],
  workflows: [invoiceReminder],
})
```

`sixb dev` runs workflow workers automatically when workflows are registered. For a dedicated worker
process in production, run:

```bash
sixb worker workflow
```

## Related

- [Interventions](interventions.md) — human-in-the-loop pauses and submitting responses
- [Actions](../actions/overview.md) — commands run by action nodes
- [Rules](../rules/overview.md) — watch objects and react
- [Automation](../schedules/overview.md) — schedules that auto-start workflows
