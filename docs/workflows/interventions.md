# Human-in-the-Loop

An **intervention** is a [workflow](overview.md) node that pauses a run and waits for a human (or
service account) to submit a response before the run continues. Reach for it when a step needs a
decision that should not be automated: an approval, a review, a sign-off.

You define an intervention with `defineIntervention`, place it in a chain with `.then(...)`, and the
run *waits* until an app submits a response over the HTTP API. The submitted response flows
downstream exactly like a step's output.

## Defining an intervention

`defineIntervention(id, options?)` returns a builder. Chain `.input(...)` to declare the data shown
to the reviewer, then `.response(...)` to declare the fields they fill in. Optionally chain
`.defaults(...)` to pre-fill the response form.

```ts
import { defineIntervention, interventionField, ref } from "@sixb/core"
import { Invoice } from "../ontology/invoice"

export const reviewInvoiceReminder = defineIntervention("review-invoice-reminder", {
  description: "Approve or request changes before sending the invoice reminder.",
})
  .input({
    invoice: ref(Invoice),
    message: "string",
    channel: "string",
    deliveryBatchId: "string",
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

| Method | Purpose |
| --- | --- |
| `defineIntervention(id, options?)` | Start the builder. `id` must be non-empty; `options.description` is optional. |
| `.input(shape)` | Schema record describing the data presented to the reviewer. Each value is a `SchemaOrRef` (e.g. `"string"`, `ref(Invoice)`). |
| `.response(shape)` | Schema record describing the fields the reviewer submits. Each value is a bare `SchemaOrRef` or an `interventionField(...)` config. |
| `.defaults(handler)` | Optional. Computes a partial response to pre-fill the form. |

### Response fields

A `.response(...)` value can be a plain schema, or an `interventionField(schema, options)` config
when you need to mark a field optional or document it. Fields are required by default.

```ts
interventionField("boolean")                          // required
interventionField("string", { required: false })      // optional
interventionField("string", { description: "Note to the customer" })
```

| `interventionField` argument | Type | Notes |
| --- | --- | --- |
| `schema` | `SchemaOrRef` | The field's value type. |
| `options.required` | `boolean` | Defaults to `true`. Must be a literal `true` / `false`. |
| `options.description` | `string` | Optional human-facing label. |

### Defaults

`.defaults(handler)` pre-fills the form. The handler receives the resolved node `input`, the original
`workflowInput`, and prior `steps` outputs, and returns a *partial* response — the reviewer can still
change every field. The result is persisted on the pending record as `defaultResponse`.

```ts
.defaults(({ input, workflowInput, steps }) => ({
  approved: true,
  message: input.message,
}))
```

## Placing an intervention in a workflow

Add the intervention to a chain with `.then(...)`. Its `.response(...)` shape becomes the node's
output, available to later nodes under a key derived from the intervention id (camelCased, so
`review-invoice-reminder` → `reviewInvoiceReminder`).

Like a step, an intervention's `input` is fed by direct dataflow (the prior node's output matches the
intervention's input shape) or by a mapper function as the second `.then(...)` argument.

```ts
import { defineWorkflow, ref } from "@sixb/core"
import { sendReminder } from "../actions/sendReminder"
import { Invoice } from "../ontology/invoice"

export const invoiceReminderWorkflow = defineWorkflow("invoice-reminder-workflow")
  .input({ invoice: ref(Invoice) })
  .then(loadInvoiceContext)
  .then(evaluateReminderPolicy)
  .then(composeInvoiceReminder)
  .then(reviewInvoiceReminder)
  .then(sendReminder, ({ steps }) => ({
    subject: steps.composeInvoiceReminder.invoice,
    params: {
      approved: steps.reviewInvoiceReminder.approved,
      message: steps.reviewInvoiceReminder.message,
      reviewerNote: steps.reviewInvoiceReminder.reviewerNote,
    },
  }))
```

## Lifecycle: waiting → submit → resume

When a run reaches an intervention node, the runtime:

1. Evaluates `.defaults(...)` (if present) and creates a **pending intervention record** with status
   `pending`. The node run and workflow run move to `waiting`.
2. Emits `workflow.intervention.requested` (and `workflow.run.waiting`).
3. Stops advancing the run until the pending intervention is resolved.

An app then **submits** a response. The record moves to `submitted`,
`workflow.intervention.submitted` fires, and a `workflow.run.resume.requested` job is enqueued. The
runtime resumes the run, exposing the submitted response as the node's output to downstream nodes.

If the intervention is **cancelled** instead, the node run, workflow run, and record all move to
`cancelled` and the run finishes.

| Status | Meaning |
| --- | --- |
| `pending` | Created and waiting for a response. Only `pending` records can be submitted or cancelled. |
| `submitted` | A response was submitted; the run resumes. |
| `cancelled` | Cancelled; the node and run finish as `cancelled`. |
| `expired` | Passed its `expiresAt` without a response. |

### Lifecycle events

These fire on the `workflows` topic (see [Events](../events/overview.md)). Each payload carries
`workflowId`, `runId`, `nodeRunId`, `interventionId`, `pendingInterventionId`, and the relevant
timestamp.

| Event | When |
| --- | --- |
| `workflow.intervention.requested` | A pending intervention is created and the run waits. |
| `workflow.intervention.submitted` | A response is submitted and the run resumes. |
| `workflow.intervention.cancelled` | The intervention is cancelled. |
| `workflow.intervention.expired` | The intervention expires. |

## Resolving interventions (HTTP)

Apps list and resolve pending interventions through the workflow HTTP routes. The submitted
`response` is validated against the intervention's `.response(...)` contract before the run resumes.

| Method & path | Purpose |
| --- | --- |
| `GET /api/workflow-interventions` | List interventions. Filter by `status`, `workflowId`, `workflowRunId`, `nodeRunId`, `interventionId`, and `requestedAfter` / `requestedBefore`. |
| `GET /api/workflow-interventions/:interventionId` | Get one record, including `input` and `defaultResponse`. |
| `POST /api/workflow-interventions/:interventionId/submit` | Submit a response. Returns `202` and enqueues the resume job. |
| `POST /api/workflow-interventions/:interventionId/cancel` | Cancel a pending intervention. Finishes the run as `cancelled`. |

```bash
curl "$BASE_URL/api/workflow-interventions?status=pending&workflowId=invoice-reminder-workflow"
```

Each record includes `input` (data for the reviewer), `defaultResponse` (pre-filled values), `status`,
and — once resolved — `response`, `submittedAt`, and `submittedBy`.

### Submitting a response

```json
{
  "response": {
    "approved": true,
    "message": "Reminder approved. Please send today.",
    "reviewerNote": "Customer asked for a softer tone."
  },
  "submittedBy": {
    "principalType": "user",
    "principalId": "u_123"
  }
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `response` | object | Values keyed by the intervention's `.response(...)` field names. Validated against the contract. |
| `submittedBy` | object | Optional actor. `principalType` is `"user"`, `"serviceAccount"`, or `"system"`; `principalId` is a string. |

The submit and cancel endpoints require CSRF protection. See [Server](../server/overview.md) and
[Authentication](../auth/authentication.md).

## Related

- [Workflows](overview.md) — the chain DSL, steps, and actions.
- [Rules](../rules/overview.md) — automatic, non-blocking reactions.
- [Actions](../actions/overview.md) — used as workflow nodes after a decision.
- [Events](../events/overview.md) — subscribe to intervention lifecycle events.
