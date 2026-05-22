# @pario/server

Built-in Pario runtime server. Owns the REST API, WebSocket API, OpenAPI docs, and the built-in React UI served from `/`.

## Installation

```bash
bun add @pario/server
```

## Usage

```typescript
import { Pario } from "@pario/core"
import { createParioServer } from "@pario/server"

const pario = new Pario({ /* ... */ })
await pario.init()

const server = createParioServer({ pario, port: 3000 })
await server.start()
// Server running at http://0.0.0.0:3000
// Built-in UI at http://0.0.0.0:3000/
// OpenAPI docs at http://0.0.0.0:3000/docs
```

## API Routes

### REST Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/project` | Project metadata |
| `GET` | `/api/status` | Runtime status (object type and function counts) |
| `GET` | `/api/object-types` | List registered object types |
| `GET` | `/api/object-types/:objectTypeId` | Get object type definition |
| `GET` | `/api/objects` | List objects (`?objectTypeId=&keyPrefix=&limit=&offset=&orderBy=&order=`) |
| `GET` | `/api/objects/:objectTypeId/:objectKey` | Get object by key |
| `PUT` | `/api/objects/:objectTypeId/:objectKey` | Create or update object |
| `POST` | `/api/objects/:objectTypeId/:objectKey/actions/:actionId` | Request an action on an object |
| `GET` | `/api/objects/:objectTypeId/:objectKey/links` | List object links (`?linkId=`) |
| `PUT` | `/api/objects/:objectTypeId/:objectKey/links/:linkId` | Create or update link |
| `DELETE` | `/api/objects/:objectTypeId/:objectKey/links/:linkId` | Remove link (`?targetTypeId=&targetKey=`) |
| `POST` | `/api/objects/:objectTypeId/:objectKey/telemetry/:propertyId` | Append telemetry point |
| `GET` | `/api/objects/:objectTypeId/:objectKey/telemetry/:propertyId/history` | Get telemetry history (`?from=&to=&limit=&order=`) |
| `GET` | `/api/objects/:objectTypeId/:objectKey/telemetry/:propertyId/latest` | Get latest telemetry point |
| `GET` | `/api/events` | Read domain events (`?topic=&type=&afterCursor=&limit=`) |

### WebSocket

**`/ws/events`** -- Real-time domain event streaming. On connect, the server begins tailing new events from the latest cursor.

Send messages to control the subscription:

```json
{ "type": "subscribe", "topic": "telemetry", "types": ["telemetry.appended"], "afterCursor": "42" }
{ "type": "unsubscribe" }
```

- `topic` -- Filter by topic: `objects`, `telemetry`, `links`, `actions`, `schedules`, `syncs`, `pipelines`, `workflows`, `datasets`, or `rules`.
- `types` -- Filter by event type, for example `object.upserted`, `telemetry.appended`, `action.requested`, or `workflow.run.finished`.
- `afterCursor` -- Start streaming after a broker cursor. Defaults to latest.

Events are delivered as:

```json
{ "type": "event", "event": { "cursor": "42", "type": "telemetry.appended", "payload": { ... }, "occurredAt": "..." } }
```

## Exports

```typescript
import {
  createApp,
  createParioApi,
  createParioServer,
  ParioServer,
} from "@pario/server"
import type { CustomAppMount, ParioApp, ParioServerOptions } from "@pario/server"
```

- **`createParioServer(options)`** -- Preferred entrypoint for starting Pario server surfaces.
- **`ParioServer`** -- Manages the server lifecycle (`start`, `stop`).
- **`createParioApi(server)`** -- Creates the raw Elysia app with all API and WebSocket routes.
- **`createApp(server)`** -- Alias for `createParioApi(server)` for compatibility.
- **`ParioApp`** -- Type alias for the Elysia app returned by `createParioApi`.
- **`CustomAppMount`** -- Technical custom app mount consumed by `surface: { kind: "customApp", app }`.
- **`ParioServerOptions`** -- Config: `pario` (required), `port` (default 3000), `host` (default `"0.0.0.0"`), `quiet`, `surface`, `ui` compatibility, `sessionAudience`, and `publicOrigin`.

`surface` selects what the visible host serves:

- `{ kind: "builtInUi" }` for the default admin UI;
- `{ kind: "customApp", app }` for a custom app served same-origin with `/api`, `/auth`, `/ws`, and `/docs`;
- `{ kind: "apiOnly" }` for API-only hosts.

Custom app mounts declare technical resources only. The server keeps ownership of reserved routes, auth, session audience, runtime CSRF injection, HTTP proxying, and HMR WebSocket bridging.

## OpenAPI

The server auto-generates an OpenAPI spec from route definitions. Interactive docs are served at `/docs`. To extract the spec as JSON:

```bash
bun run generate:openapi
```

## Client Package

`@pario/client` is auto-generated from this server's OpenAPI spec. After modifying routes, regenerate with:

```bash
bun generate:client
```

Always set `detail.operationId` on routes to keep generated function names stable.
