# Running Actions from Apps

Apps usually want actions to feel like ordinary button clicks: press the button, show loading,
surface success or failure, and refresh the data the action changed. Use
`useActionRunMutation` for that path.

For action definitions, phases, and server-side `edits(...)`, see
[Actions](../actions/overview.md). This page covers the browser/app side.

## Recommended Button Flow

`useActionRunMutation` requests the action and waits for the durable run to reach a terminal
status. `isPending` means the run is still queued or running. `isSuccess` means the action
finished with status `succeeded`. `isError` covers request errors, failed runs, cancelled runs,
and wait timeouts.

```tsx
import { useActionRunMutation } from "@sixb/client/hooks"
import { Invoice } from "../../ontology/invoice"

export function MarkPaidButton({ invoiceId }: { invoiceId: string }) {
  const markPaid = useActionRunMutation<{ paymentMethod: "card" | "ach" }>({
    actionId: "markPaid",
    subject: { objectType: Invoice, primaryId: invoiceId },
    invalidateOnCommit: true,
    timeoutMs: 30_000,
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
      {markPaid.isError ? <p role="alert">{markPaid.error.message}</p> : null}
      {markPaid.isSuccess ? <p>Paid.</p> : null}
    </>
  )
}
```

`invalidateOnCommit: true` invalidates action-run caches after the terminal run. When the run
has a commit diff, it also invalidates the changed object detail caches and the typed
object-query cache group, so `useObjectsQuery` screens refresh without a custom event listener.

## Object and Global Actions

For object actions, configure the action once and pass only params to `mutate`:

```tsx
const approveQuote = useActionRunMutation<{ note?: string }>({
  actionId: "approveQuote",
  subject: { objectType: Quote, primaryId: quoteId },
  invalidateOnCommit: true,
})

approveQuote.mutate({ note: "Approved from the quote screen." })
```

For global actions, omit `subject`:

```tsx
const createDraft = useActionRunMutation<{ customerId: string }>({
  actionId: "createDraftInvoice",
  invalidateOnCommit: true,
})

createDraft.mutate({ customerId })
```

For dynamic action ids or subjects, call the hook without an `actionId` and pass a request-shaped
value to `mutate`:

```tsx
const runAction = useActionRunMutation()

runAction.mutate({
  path: { actionId },
  body: {
    subject: { objectType, primaryId },
    params,
  },
})
```

If you are building a generic screen and only have string ids, the generated subject shape still
works: `{ kind: "object", objectTypeId, primaryId }`.

## High-Frequency Controls

For a single destructive command, disabling the button while `mutation.isPending` is usually
right. For controls that users press repeatedly, such as volume buttons, do not globally block
the control surface. Track local pending counts and call `mutateAsync` for each click:

```tsx
const pressButton = useActionRunMutation<{ button: string }>({
  actionId: "pressButton",
  subject: { objectType: Television, primaryId: televisionId },
  invalidateOnCommit: true,
})

const [pendingByButton, setPendingByButton] = useState<Record<string, number>>({})

function press(button: string) {
  setPendingByButton((current) => ({
    ...current,
    [button]: (current[button] ?? 0) + 1,
  }))

  void pressButton
    .mutateAsync({ button })
    .catch((error) => console.error(error))
    .finally(() => {
      setPendingByButton((current) => {
        const next = { ...current }
        const count = (next[button] ?? 0) - 1
        if (count > 0) next[button] = count
        else delete next[button]
        return next
      })
    })
}
```

TanStack Query does not serialize these calls unless you configure a mutation `scope`, so each
click creates its own action run. Show a compact side status, per-button spinner, or both.

## Enqueue-Only vs Terminal Mutations

Sixb keeps the generated `requestActionMutation()` and root `requestAction()` API enqueue-only.
They resolve when the server accepts the request and returns `{ runId, queuedAt, created }`.
Use them when the UI should not wait for the work, such as starting a long import, kicking off
a background repair, or navigating directly to a run details page.

Use `useActionRunMutation()` when the UI state should represent the action outcome:

| Need | Use |
| --- | --- |
| Button loading until the action succeeds or fails | `useActionRunMutation` |
| Toast or inline error for terminal action failure | `useActionRunMutation` |
| Refresh object queries after committed edits | `useActionRunMutation({ invalidateOnCommit: true })` |
| Fire-and-forget background work | generated `requestActionMutation()` or `requestAction()` |
| Custom run history UI that watches many runs | enqueue-only request plus action-run queries/events |

## React-Free Waiting

Non-React code can use the same terminal semantics from `@sixb/client`:

```ts
import { requestActionAndWait, waitForActionRun } from "@sixb/client"

const run = await requestActionAndWait({
  path: { actionId: "approveQuote" },
  body: {
    subject: { kind: "object", objectTypeId: "Quote", primaryId: quoteId },
    params: { note: "Approved." },
  },
  timeoutMs: 30_000,
})

await waitForActionRun({ runId: run.id })
```

By default, failed and cancelled terminal runs reject with `ActionRunFailedError`, and timeouts
reject with `ActionRunTimeoutError`. Pass `rejectOnTerminalFailure: false` when you want to
inspect the terminal run record yourself.

## Scoped Action Events

Most apps should not subscribe manually just to update a button. The wait helpers already listen
for terminal events and fetch the final run detail. Use event builders when the screen needs
broader live coordination:

```tsx
import { events, useEvents } from "@sixb/client/hooks"

useEvents(events.actions().subject(Quote).object(quoteId).terminal(), (event) => {
  console.log("quote action finished", event.payload.runId)
})

useEvents(events.actions().run(runId).completed(), () => {
  console.log("this run succeeded")
})
```

Useful scopes are:

| Builder | Meaning |
| --- | --- |
| `events.actions().run(runId)` | One action run |
| `events.actions().action("approveQuote")` | One action definition |
| `events.actions().subject(Quote).object(quoteId)` | Actions against one object |
| `.requested()` | Only enqueue events |
| `.completed()` | Successful terminal events |
| `.failed()` | Failed or cancelled terminal events |
| `.terminal()` | Completed plus failed events |

See [Client events](../client/events.md) for the full event builder and hook reference.

## Manual Invalidation

If you handle events yourself, use the exported object-query keys and invalidation helpers
instead of copying cache keys:

```tsx
import { invalidateObjectQuery } from "@sixb/client/hooks"
import { useQueryClient } from "@tanstack/react-query"
import { openInvoices } from "../queries/invoices"

const queryClient = useQueryClient()

await invalidateObjectQuery(queryClient, openInvoices.limit(50))
```

`objectQueryKeys` also exposes `list`, `count`, `exists`, `facets`, `infinite`, and `all`
keys for advanced TanStack Query integration.

## Related

- [Querying data](querying-data.md) - typed object reads in custom apps.
- [Client SDK](../client/overview.md) - root SDK, hooks, events, and transport setup.
- [Client events](../client/events.md) - event builders and React hooks.
- [Actions](../actions/overview.md) - defining actions and server-side run lifecycle.
- [Events](../events/overview.md) - event stream and scoped action subscriptions.
