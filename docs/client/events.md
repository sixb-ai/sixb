# Events & subscriptions

Subscribe to live data with `@sixb/client/hooks`. Subscriptions use your browser session, or a [native client's session](overview.md#tools-outside-the-browser), and receive only events permitted by your grants.

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

The hook manages subscription cleanup and reconnects. In a Sixb app, every subscription on the page shares one connection. For a standalone browser app, complete [client setup](overview.md#standalone-browser-apps) first, and wrap it in `SixbEventsProvider` to share one connection the same way.

## Filter events

| Builder | Selects |
| --- | --- |
| `events.object(Invoice).created()` | New invoices. |
| `events.object(Invoice).updated()` | Changed invoices. |
| `events.object(Invoice).upserted()` | Created or updated invoices. |
| `events.object(Invoice).byId(id).deleted()` | Deletion of one invoice. |
| `events.object(Device).telemetry(Device.p.temperature)` | Changes to one telemetry property. |
| `events.object(Invoice).link(Invoice.l.customer).created()` | New customer relationships. |
| `events.workflows().run(runId)` | Events for one workflow run. |
| `events.users().joined()` | New [members](../auth/members.md#react-to-member-changes). Requires `can.view(project.users)`. |

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

To keep every cached object query current, mount `useObjectQueryLiveUpdates` once near the root. A
query refreshes only when a type it reads changes, through its filters, traversals or expansions.
Changes gather for a second, and while the page is hidden, so a burst of writes refreshes each query
at most once a second. A query already fetching finishes first, then reads again, and a reconnect
refreshes everything:

```tsx
import { useObjectQueryLiveUpdates } from "@sixb/client/hooks"

function App({ children }: { children: React.ReactNode }) {
  useObjectQueryLiveUpdates()
  return children
}
```

It follows object and link events, so it can't see a member renaming themselves for a query that expands
`users`, or a change that moves an object out of what the reader may see, which sends the reader no
event. A write made just before the stream first connects can be missed the same way. Those refresh with
the next change to a type the query reads. In a standalone browser app, wrap it in `SixbEventsProvider` so
its two subscriptions share one connection; that connection uses the global client, not a `SixbProvider`
client. Pass `onError` to hear when the stream fails, since queries then stop refreshing.

## Subscription options

`useEvents` accepts an optional third argument:

| Option | Purpose |
| --- | --- |
| `enabled` | Start or stop the subscription. |
| `afterCursor` | Resume after a stored cursor. |
| `limit` | Set the page size for replaying from `afterCursor`. |
| `reconnect`, `reconnectDelayMs` | Control reconnects. |
| `handshakeTimeoutMs` | Limit the time allowed to establish a subscription. |
| `onError` | Receive subscription errors. |

For protocol messages and replay behavior, see [WebSockets](../websockets/overview.md). Event-triggered backend work belongs in [Schedules](../schedules/overview.md#run-on-an-event).
