# @sixb/client

Type-safe API client for Sixb, auto-generated from the server's OpenAPI spec. Provides a fetch-based SDK for all REST endpoints, TanStack Query hooks, and a core-typed real-time domain event hook.

## Installation

```bash
bun add @sixb/client
```

For React hooks, also install the peer dependencies:

```bash
bun add @tanstack/react-query react
```

## Regenerating

The SDK is generated from the server's OpenAPI spec using `@hey-api/openapi-ts`. After modifying server routes, regenerate from the repository root:

```bash
bun generate:client
```

## Usage

### SDK (direct fetch)

```typescript
import { client, listObjects, getObject, getTelemetryHistory, listObjectTypes } from "@sixb/client"

// Configure the base URL
client.setConfig({ baseUrl: "http://localhost:3002" })

// List all object types
const { data: types } = await listObjectTypes()

// List objects with filtering
const { data: objects } = await listObjects({
  query: { objectTypeId: "thermostat", limit: "100" },
})

// Get a single object
const { data: object } = await getObject({
  path: { objectTypeId: "thermostat", objectId: "living-room" },
})

// Fetch telemetry history
const { data: history } = await getTelemetryHistory({
  path: { objectTypeId: "thermostat", objectId: "living-room", propertyId: "temperature" },
  query: { from: "2025-01-01T00:00:00Z", to: "2025-01-02T00:00:00Z", order: "asc" },
})

// Request an action on an object, then wait for terminal success/failure
import { requestActionAndWait } from "@sixb/client"

const run = await requestActionAndWait({
  path: { actionId: "setTemperature" },
  body: {
    subject: { kind: "object", objectTypeId: "thermostat", primaryId: "living-room" },
    params: { target: 72 },
  },
  timeoutMs: 30_000,
})
```

### React Query hooks

```tsx
import { useQuery } from "@tanstack/react-query"
import {
  listObjectsOptions,
  getObjectOptions,
  getTelemetryHistoryOptions,
  telemetryHistoryQueryOptions,
  useActionRunMutation,
  useTelemetryHistoryQuery,
} from "@sixb/client/hooks"
import { Thermostat } from "./ontology/Thermostat"

// List objects with automatic caching and refetching
const { data: objects } = useQuery(listObjectsOptions())

// Get a single object (uses encoded objectId = "objectTypeId~objectKey")
const { data: object } = useQuery(
  getObjectOptions({ path: { objectId: "thermostat~living-room" } })
)

// Get telemetry history with a time range
const { data: history } = useQuery(
  getTelemetryHistoryOptions({
    path: { objectId: "thermostat~living-room", propertyId: "temperature" },
    query: { range: "5m" },
  })
)

// Typed telemetry history with ontology tokens
const { data: temperatureHistory } = useTelemetryHistoryQuery({
  objectType: Thermostat,
  objectId: "living-room",
  property: Thermostat.p.temperature,
  from: new Date("2025-01-01T00:00:00Z"),
  to: new Date("2025-01-02T00:00:00Z"),
})

// The same token-based shape is available as a query options factory.
const temperatureHistoryOptions = telemetryHistoryQueryOptions({
  objectType: Thermostat,
  objectId: "living-room",
  property: Thermostat.p.temperature,
})

// Action mutation whose success means the action run reached terminal success.
function SetTemperatureButton() {
  const setTemperature = useActionRunMutation<{ target: number }>({
    actionId: "setTemperature",
    subject: { objectType: Thermostat, primaryId: "living-room" },
    invalidateOnCommit: true,
  })

  return (
    <button
      type="button"
      disabled={setTemperature.isPending}
      onClick={() => setTemperature.mutate({ target: 72 })}
    >
      {setTemperature.isPending ? "Setting..." : "Set to 72"}
    </button>
  )
}
```

Use `useActionRunMutation()` for app buttons where loading, success, and error states should
reflect the final action run. Keep the generated `requestActionMutation()` or root
`requestAction()` for enqueue-only flows where accepting the request is enough, such as long
background work or screens that immediately navigate to a run detail view.

### Domain events

Subscribe with the fluent `events(Type)` builder (mirrors `objects(Type)`):
channels narrow the event and type the payload, `.object(key)` scopes to one
instance, and the hooks take a built builder as their first argument.

```tsx
import { events, useEvents, useLatest } from "@sixb/client/hooks"
import { Thermostat } from "./ontology/Thermostat"

function LiveDashboard() {
  // Typed telemetry value for one property.
  const { connected } = useEvents(
    events(Thermostat).telemetry(Thermostat.p.temperature),
    (event) => console.log(event.payload.value)
  )

  // Latest value per property for a single object.
  const { values } = useLatest(events(Thermostat).object("living-room").telemetry())

  return <div>{connected ? "Connected" : "Disconnected"}</div>
}
```

Action events can be scoped by run, action id, or object subject when a screen needs custom
coordination:

```typescript
useEvents(events.actions().run("run_123").terminal(), (event) => {
  console.log("action finished", event.payload.runId)
})

useEvents(events.actions().subject(Thermostat).object("living-room").completed(), () => {
  console.log("thermostat action succeeded")
})
```

Use `useInvalidateOnEvent(builder, resolveKeys)` to invalidate TanStack Query keys on
matching events. See `docs/client/events.md` for the full event builder and hook guide.

### UI models

```typescript
import type { ObjectSummary, ObjectDetail, TelemetryHistory } from "@sixb/client/models"
import { toObjectSummary, toObjectDetail, executeAction } from "@sixb/client/models"
```

The models module provides normalized types and adapter functions that transform raw API responses into UI-friendly shapes with merged telemetry properties, parsed actions, and computed fields.

## Exports

| Entry point | What it provides |
|---|---|
| `@sixb/client` | `client`, all generated SDK functions (`listObjects`, `getObject`, `upsertObject`, `requestAction`, `getActionRun`, `getTelemetryHistory`, etc.), terminal action wait helpers (`requestActionAndWait`, `waitForActionRun`), all generated types, and UI model types/adapters |
| `@sixb/client/hooks` | TanStack Query `queryOptions` factories (`listObjectsOptions`, `getObjectOptions`, `getTelemetryHistoryOptions`, `telemetryHistoryQueryOptions`, `listRelationshipsOptions`), typed hooks (`useTelemetryHistoryQuery`, object query hooks, `useActionRunMutation`), object-query key/invalidation helpers, the `events(Type)` builder, and event hooks (`useEvents`, `useLatest`, `useLatestByObject`, `useInvalidateOnEvent`, `SixbEventsProvider`) |
| `@sixb/client/models` | UI model types (`ObjectSummary`, `ObjectDetail`, `TelemetryHistory`, `RelationshipEdge`, etc.) and adapters (`toObjectSummary`, `toObjectDetail`, `toTelemetryHistoryWithRange`, `executeAction`) |
