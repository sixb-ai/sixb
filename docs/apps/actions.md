# Running Actions

Use `useActionRunMutation` to run an action from your app. It gives your component loading, success,
and error states that follow the action's outcome.

Define the action in your project first. See [Actions](../actions/overview.md) for the server-side
definition.

## Run an action

Set `actionId` to the action's ID. For an object action, pass the object type and primary ID in
`subject`. Pass its parameters to `mutate` when the user clicks the button.

```tsx
import { useActionRunMutation } from "@sixb/client/hooks"
import { Invoice } from "../../ontology/invoice"

export function MarkPaidButton({ invoiceId }: { invoiceId: string }) {
  const markPaid = useActionRunMutation<{ paymentMethod: "card" | "ach" }>({
    actionId: "markPaid",
    subject: { objectType: Invoice, primaryId: invoiceId },
    invalidateOnCommit: true,
  })

  return (
    <>
      <button
        type="button"
        disabled={markPaid.isPending}
        onClick={() => markPaid.mutate({ paymentMethod: "card" })}
      >
        {markPaid.isPending ? "Marking paid..." : "Mark paid"}
      </button>
      {markPaid.isError && <p role="alert">{markPaid.error.message}</p>}
      {markPaid.isSuccess && <p>Paid.</p>}
    </>
  )
}
```

`isPending` stays true while the action runs. `isSuccess` means the action succeeded. `isError`
covers rejected requests and runs that failed or timed out; for a run, the error is an
`ActionRunFailedError` whose `run` holds its details. Leaving the page does not cancel the action.

## Run a global action

A global action is not attached to one object. Configure the hook inside your component without
`subject`, then pass its parameters to `mutate` in your click handler:

```tsx
const createDraft = useActionRunMutation<{ customerId: string }>({
  actionId: "createDraftInvoice",
  invalidateOnCommit: true,
})

// In the click handler:
createDraft.mutate({ customerId })
```

## Refresh data

Set `invalidateOnCommit: true` to refresh object queries after a completed run that committed
changes. This also refreshes data when an action committed changes before failing.

Outside React, use `requestAction` from `@sixb/client`, which also returns the finished run. See the
[Client SDK](../client/overview.md#run-an-action). Work that needs more than an action's
[30 seconds](../actions/overview.md#request-an-action) belongs in a
[workflow](../workflows/overview.md).
