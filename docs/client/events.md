# Client Events

`@sixb/client` exposes the domain event stream to app pages. Use it when a screen needs live
telemetry, an activity feed, or custom coordination around runs. For a normal action button, prefer
[`useActionRunMutation`](../apps/actions.md) — it already waits for terminal action events and
invalidates committed object changes.

## Event Builders

The `events.object(...)` builder creates a typed event filter. Start with an ontology object type when the
screen is about one object family:

```tsx
import { events } from "@sixb/client/hooks"
import { Device } from "../ontology/device"

events.object(Device).byId(deviceId).telemetry()
events.object(Device).telemetry(Device.p.temperature)
events.object(Device).byId(deviceId).upserted()
events.object(Device).byId(deviceId).deleted()
events.object(Device).linked(Device.l.installedIn)
```

Object-type builders carry type information. For example, `telemetry(Device.p.temperature)` narrows
the event payload to that property, and `upserted()` types `payload.properties` from `Device`.

Use topic builders when the screen is broader or dynamic:

```tsx
events.telemetry().byId(deviceId)
events.objects()
events.links()
events.datasets()
events.rules()
events.workflows().run(workflowRunId)
events.pipelines().run(pipelineRunId)
events.syncs().run(syncRunId)
```

Action events have extra scopes:

```tsx
events.actions().run(runId).terminal()
events.actions().action("approveQuote").completed()
events.actions().subject(Quote).byId(quoteId).failed()
events.actions().requested()
```

Use `.terminal()` for completed plus failed action events. Use `.completed()` only when successful
terminal runs matter.

## useEvents

`useEvents(builder, onEvent, options?)` subscribes to matching events and returns the socket state:

```tsx
import { events, useEvents } from "@sixb/client/hooks"
import { Invoice } from "../ontology/invoice"

function InvoiceActivity({ invoiceId }: { invoiceId: string }) {
  const state = useEvents(events.object(Invoice).byId(invoiceId).upserted(), (event) => {
    console.log("invoice changed", event.payload.properties)
  })

  return <span>{state.connected ? "Live" : "Offline"}</span>
}
```

The handler can change without reopening the socket. The subscription is rebuilt only when the
builder filter or transport options change.

Common options:

| Option | Purpose |
| --- | --- |
| `enabled` | Turn the subscription on or off. |
| `afterCursor` | Replay events after a stored cursor. |
| `limit` | Limit replayed events on subscribe. |
| `reconnect` | Enable or disable reconnects. |
| `reconnectDelayMs` | Delay before reconnecting. |
| `handshakeTimeoutMs` | Maximum time to establish and acknowledge the event subscription. |
| `onError` | Receive socket or subscription errors. |

## Latest Telemetry

Use `useLatest` when a component needs the current live value per telemetry property:

```tsx
import { events, useLatest } from "@sixb/client/hooks"
import { Device } from "../ontology/device"

function DeviceReading({ deviceId }: { deviceId: string }) {
  const { values, connected } = useLatest(events.object(Device).byId(deviceId).telemetry())
  const temperature = values[Device.p.temperature.id]?.value

  return (
    <p>
      {connected ? "Live" : "Offline"}: {temperature == null ? "No reading" : String(temperature)}
    </p>
  )
}
```

Use `useLatestByObject` for a dashboard that buckets live telemetry by object id:

```tsx
import { events, useLatestByObject } from "@sixb/client/hooks"
import { Device } from "../ontology/device"

const { byObject } = useLatestByObject(events.object(Device).telemetry(Device.p.temperature))

const value = byObject[deviceId]?.[Device.p.temperature.id]?.value
```

Both hooks reset their accumulated values when the builder scope changes.

## Invalidate on Events

Use `useInvalidateOnEvent` when an event should refresh TanStack Query caches:

```tsx
import { events, objectQueryKeys, useInvalidateOnEvent } from "@sixb/client/hooks"
import { openInvoices } from "../queries/invoices"
import { Invoice } from "../ontology/invoice"

useInvalidateOnEvent(
  events.object(Invoice).upserted(),
  () => [objectQueryKeys.list(openInvoices.limit(50))],
  { debounceMs: 50 }
)
```

For action buttons, `useActionRunMutation({ invalidateOnCommit: true })` is usually simpler. It
uses action events internally and invalidates from the terminal run's commit diff.

## Related

- [Client SDK](overview.md) - SDK subpaths and transport setup.
- [Typed queries](typed-queries.md) - object query builders and cache keys.
- [Running actions from apps](../apps/actions.md) - action buttons and terminal mutation state.
- [Domain events](../events/overview.md) - event catalog, runtime reads, and server subscriptions.
