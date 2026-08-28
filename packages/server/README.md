# @sixb/server

Sixb API server. Owns the REST API, auth routes, WebSocket API, and OpenAPI docs. The built-in
Atlas UI is served by `@sixb/atlas`.

## Installation

```bash
bun add @sixb/server
```

## Usage

```typescript
import { createSixb } from "@sixb/core"
import { createSixbServer } from "@sixb/server"

const host = await createSixb({ /* providers, ontology, ... */ })

const server = createSixbServer({
  host,
  port: 3002,
  browser: {
    publicOrigin: "https://api.example.com",
    allowedOrigins: [
      { origin: "https://atlas.example.com", audience: "atlas" },
      { origin: "https://app.example.com", audience: "app" },
    ],
  },
})
await server.start()
// Server running at http://0.0.0.0:3002
// OpenAPI docs at http://0.0.0.0:3002/docs
```

Each configured audience identifies the browser application for exactly one origin. Configured
origins are shown as invitation destinations and participate in `can.access(applications.atlas)` or
`can.access(applications.app)` authorization.

## API Routes

### REST Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/project` | Project metadata |
| `GET` | `/api/status` | Runtime status (object type and function counts) |
| `GET` | `/api/actions` | List registered actions |
| `GET` | `/api/actions/:actionId` | Get action metadata |
| `POST` | `/api/actions/:actionId` | Request an action (`subject` is optional for global actions) |
| `GET` | `/api/object-types` | List registered object types |
| `GET` | `/api/object-types/:objectTypeId` | Get object type definition |
| `GET` | `/api/objects` | List objects (`?objectTypeId=&idPrefix=&limit=&offset=&orderBy=&order=`) |
| `GET` | `/api/objects/:objectTypeId/:objectKey` | Get object by key |
| `PUT` | `/api/objects/:objectTypeId/:objectKey` | Create or update object |
| `POST` | `/api/objects/query/links` | Query physical links for a bounded object selector |
| `PUT` | `/api/objects/:objectTypeId/:objectKey/links/:linkId` | Create or update link |
| `DELETE` | `/api/objects/:objectTypeId/:objectKey/links/:linkId` | Remove link (`?targetTypeId=&targetKey=`) |
| `POST` | `/api/objects/:objectTypeId/:objectKey/telemetry/:propertyId` | Append telemetry point |
| `GET` | `/api/objects/:objectTypeId/:objectKey/telemetry/:propertyId/history` | Get telemetry history (`?from=&to=&limit=&order=`) |
| `GET` | `/api/objects/:objectTypeId/:objectKey/telemetry/:propertyId/latest` | Get latest telemetry point |
| `GET` | `/api/events` | Read domain events (`?topic=&type=&afterCursor=&limit=`) |
| `POST` | `/api/files` | Upload a file in one request |
| `POST` | `/api/files/uploads` | Open an upload session for a large or client-uploaded file |
| `PUT` | `/api/files/uploads/:uploadId/content` | Send session content through the API |
| `POST` | `/api/files/uploads/:uploadId/parts/:partNumber` | Sign one part for direct upload to blob storage |
| `POST` | `/api/files/uploads/:uploadId/complete` | Complete the session and return the file reference |
| `POST` | `/api/files/uploads/:uploadId/abort` | Discard the session |
| `GET` | `/api/objects/:objectTypeId/:objectKey/files/content` | Download a `fileRef` property (`?path=/properties/scan`) |

Upload sessions default to an in-memory store: neither `@sixb/pg` nor `@sixb/sqlite` implements
`fileUploadSessions` in the pre-0.1 line, so a session does not survive a restart and is not shared
across replicas. Single-request `POST /api/files` is unaffected.

### WebSocket

**`/ws/events`** -- Real-time domain event streaming. On connect, the server sends a `connected` message and waits for an explicit subscription.

Send messages to control the subscription:

```json
{ "type": "subscribe", "topic": "telemetry", "types": ["telemetry.appended"], "afterCursor": "42" }
{ "type": "unsubscribe" }
```

- `topic` -- Filter by topic: `objects`, `telemetry`, `links`, `actions`, `schedules`, `syncs`, `pipelines`, `workflows`, `datasets`, or `rules`.
- `types` -- Filter by event type, for example `object.updated`, `link.created`, `telemetry.appended`, `action.requested`, or `workflow.run.finished`.
- `afterCursor` -- Start streaming after a broker cursor. Defaults to the cursor captured when the socket opened.

Events are delivered as:

```json
{ "type": "event", "event": { "cursor": "42", "type": "telemetry.appended", "payload": { ... }, "occurredAt": "..." } }
```

## Exports

```typescript
import { createSixbServer, SixbServer } from "@sixb/server"
import type { SixbServerOptions } from "@sixb/server"
```

- **`createSixbServer(options)`** -- Entrypoint for starting the API/auth/ws/docs server.
- **`SixbServer`** -- Manages the server lifecycle (`start`, `stop`).
- **`SixbServerOptions`** -- Config: `host` and `browser` (required), `port` (default 3000), `hostname` (default `"0.0.0.0"`), `quiet`.

## OpenAPI

The server auto-generates an OpenAPI spec from route definitions. Interactive docs are served at `/docs`. To extract the spec as JSON:

```bash
bun run generate:openapi
```

## Client Package

`@sixb/client` is auto-generated from this server's OpenAPI spec. After modifying routes, regenerate with:

```bash
bun generate:client
```

Always set `detail.operationId` on routes to keep generated function names stable.
