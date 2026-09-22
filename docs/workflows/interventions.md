# Human-in-the-Loop

An intervention pauses a [workflow](overview.md) for someone to review information and submit a
response. The workflow continues using that response.

## Define an intervention

Use `.input()` for the data shown to the reviewer and `.response()` for the fields they submit.
Add `.defaults()` to pre-fill values that the reviewer can edit.

File: `workflows/steps/review-reminder.ts`

```ts
import { defineIntervention, interventionField, ref } from "@sixb/core"
import { Invoice } from "../../ontology/invoice"

export const reviewReminder = defineIntervention("review-reminder", {
  description: "Review the message before sending the invoice reminder.",
})
  .input({ invoice: ref(Invoice), message: "string" })
  .response({
    message: "string",
    reviewerNote: interventionField("string", { required: false }),
  })
  .defaults(({ input }) => ({ message: input.message }))
```

Response fields are required by default. Use `interventionField()` with `required` set to `false`
for an optional field, or add `description` to explain what a field is for.

## Add it to a workflow

Place the review between preparing the reminder and sending it. This example reuses `prepareReminder`
from the [overview](overview.md#define-a-workflow) and a project `sendReminder` action that accepts
a `message` parameter:

File: `workflows/reviewed-reminder.ts`

```ts
import { defineWorkflow, ref } from "@sixb/core"
import { sendReminder } from "../actions/send-reminder"
import { Invoice } from "../ontology/invoice"
import { prepareReminder } from "./invoice-reminder"
import { reviewReminder } from "./steps/review-reminder"

export const reviewedReminder = defineWorkflow("reviewed-reminder")
  .input({ invoice: ref(Invoice) })
  .then(prepareReminder)
  .then(reviewReminder)
  .then(sendReminder, ({ input, steps }) => ({
    subject: input.invoice,
    params: { message: steps.reviewReminder.message },
  }))
```

The run waits at `reviewReminder`. After a valid response is submitted, `steps.reviewReminder`
contains that response, so the action sends the reviewed message.

Submitting a response resumes the workflow. A field such as `approved: false` does not stop it
unless your following step or action handles that value. Cancelling the intervention stops the run.

## Submit a response

In Atlas, open the workflow run and select its waiting review step to fill in the response form.
Sixb validates the response and records the authenticated reviewer.

For a custom app, use the [client hooks](../client/typed-queries.md#react-hooks).
Call `listWorkflowInterventionsOptions()` with the `status` query filter set to `pending`.
Each record includes `id`, `input`, and `defaultResponse`.

Pass the record's `id` and the message from `defaultResponse` to a form like this:

```tsx
import { submitWorkflowInterventionMutation } from "@sixb/client/hooks"
import { useMutation } from "@tanstack/react-query"

export function ReviewReminder({
  interventionId,
  message,
}: {
  interventionId: string
  message: string
}) {
  const submit = useMutation(submitWorkflowInterventionMutation())

  if (submit.isSuccess) return <p>Response submitted.</p>

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        const form = new FormData(event.currentTarget)
        submit.mutate({
          path: { interventionId },
          body: { response: { message: String(form.get("message") ?? "") } },
        })
      }}
    >
      <label>
        Message
        <textarea
          name="message"
          defaultValue={message}
          required
          disabled={submit.isPending}
        />
      </label>
      <button type="submit" disabled={submit.isPending}>
        {submit.isPending ? "Submitting..." : "Approve and continue"}
      </button>
      {submit.isError && <p role="alert">Could not submit the review. Try again.</p>}
    </form>
  )
}
```

Use the record's ID as the form's React `key` when switching between reviews. After submission,
refresh your pending-review query. To stop a run from your app, use
`cancelWorkflowInterventionMutation()` with the same `interventionId`.
