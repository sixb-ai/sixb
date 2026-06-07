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
  path: { objectTypeId: "thermostat", objectKey: "living-room" },
})

// Fetch telemetry history
const { data: history } = await getTelemetryHistory({
  path: { objectTypeId: "thermostat", objectKey: "living-room", propertyId: "temperature" },
  query: { from: "2025-01-01T00:00:00Z", to: "2025-01-02T00:00:00Z", order: "asc" },
})

// Request an action on an object
import { requestAction } from "@sixb/client"

await requestAction({
  path: { actionId: "setTemperature" },
  body: {
    subject: { kind: "object", objectTypeId: "thermostat", primaryId: "living-room" },
    params: { target: 72 },
  },
})
```

### React Query hooks

```typescript
import { useQuery } from "@tanstack/react-query"
import {
  listObjectsOptions,
  getObjectOptions,
  getTelemetryHistoryOptions,
} from "@sixb/client/hooks"

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
```

### Domain events

```typescript
import { useSixbEvents } from "@sixb/client/hooks"

function LiveDashboard() {
  const { connected } = useSixbEvents({
    topic: "telemetry",
    types: ["telemetry.appended"],
    onEvent(event) {
      console.log(event.type, event.payload)
    },
  })

  return <div>{connected ? "Connected" : "Disconnected"}</div>
}
```

### UI models

```typescript
import type { ObjectSummary, ObjectDetail, TelemetryHistory } from "@sixb/client/models"
import { toObjectSummary, toObjectDetail, executeAction } from "@sixb/client/models"
```

The models module provides normalized types and adapter functions that transform raw API responses into UI-friendly shapes with merged telemetry properties, parsed actions, and computed fields.

## Exports

| Entry point | What it provides |
|---|---|
| `@sixb/client` | `client`, all generated SDK functions (`listObjects`, `getObject`, `upsertObject`, `requestAction`, `getTelemetryHistory`, etc.), all generated types, and UI model types/adapters |
| `@sixb/client/hooks` | TanStack Query `queryOptions` factories (`listObjectsOptions`, `getObjectOptions`, `getTelemetryHistoryOptions`, `listRelationshipsOptions`) and `useSixbEvents` |
| `@sixb/client/models` | UI model types (`ObjectSummary`, `ObjectDetail`, `TelemetryHistory`, `RelationshipEdge`, etc.) and adapters (`toObjectSummary`, `toObjectDetail`, `toTelemetryHistoryWithRange`, `executeAction`) |
