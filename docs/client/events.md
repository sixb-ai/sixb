# Events & subscriptions

Subscribe to live data with `@sixb/client/hooks`. Subscriptions use your browser session and receive only events permitted by your grants.

For a normal action button, use [`useActionRunMutation`](../apps/actions.md). It already waits for the action and refreshes changed data.

## Subscribe to changes

Use a typed event builder with `useEvents`:

```tsx
import { events, useEvents } from "@sixb/client/hooks"
import { Invoice } from "../ontology/invoice"

function InvoiceActivity({ invoiceId }: { invoiceId: string }) {
  const state = useEvents(events.object(Invoice).byId(invoiceId).updated(), (event) => {
    console.log("Invoice changed", event.payload.properties)
  })

  return <span>{state.connected ? "Live" : "Offline"}</span>
}
```

The hook manages subscription cleanup and reconnects. For a standalone browser app, complete [client setup](overview.md#standalone-browser-apps) first.

## Filter events

| Builder | Selects |
| --- | --- |
| `events.object(Invoice).created()` | New invoices. |
| `events.object(Invoice).updated()` | Changed invoices. |
| `events.object(Invoice).upserted()` | Created or updated invoices. |
| `events.object(Invoice).byId(id).deleted()` | Deletion of one invoice. |
| `events.object(Device).telemetry(Device.p.temperature)` | Changes to one telemetry property. |
| `events.object(Invoice).link(Invoice.l.customer).created()` | New customer relationships. |
| `events.actions().run(runId).terminal()` | Completion or failure of one action run. |
| `events.workflows().run(runId)` | Events for one workflow run. |

Use topic builders such as `events.datasets()`, `events.rules()`, and `events.schedules()` for broader subscriptions. `events.all()` selects all visible events.

## Read live telemetry

`useLatest` keeps the latest received value for each telemetry property:

```tsx
import { events, useLatest } from "@sixb/client/hooks"
import { Device } from "../ontology/device"

function Temperature({ deviceId }: { deviceId: string }) {
  const { values } = useLatest(events.object(Device).byId(deviceId).telemetry())
  const value = values[Device.p.temperature.id]?.value
  return <span>{value == null ? "No reading" : String(value)}</span>
}
```

Use `useLatestByObject` for several objects; its `byObject` result groups values by object ID. Both hooks reset accumulated values when the subscription scope changes. They track received events; use a telemetry query when you also need stored readings.

## Refresh queries

Use `useInvalidateOnEvent` to refresh cached queries after matching changes:

```tsx
import { events, objectQueryKeys, useInvalidateOnEvent } from "@sixb/client/hooks"
import { Invoice } from "../ontology/invoice"
import { openInvoices } from "../queries/invoices"

useInvalidateOnEvent(
  events.object(Invoice).upserted(),
  () => [objectQueryKeys.list(openInvoices.limit(50))],
  { debounceMs: 50 }
)
```

## Subscription options

`useEvents` accepts an optional third argument:

| Option | Purpose |
| --- | --- |
| `enabled` | Start or stop the subscription. |
| `afterCursor` | Resume after a stored cursor. |
| `limit` | Set the event read batch size. |
| `reconnect`, `reconnectDelayMs` | Control reconnects. |
| `handshakeTimeoutMs` | Limit the time allowed to establish a subscription. |
| `onError` | Receive subscription errors. |

For protocol messages and replay behavior, see [WebSockets](../websockets/overview.md). Event-triggered backend work belongs in [Schedules](../schedules/overview.md#run-on-an-event).
