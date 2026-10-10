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

File-content `GET`/`HEAD` routes accept `?audience=app` or `?audience=atlas` for
browser navigations that omit `Origin`. Use `objectFileContentUrl({ ..., audience: "app" })`
in a separate app. The audience must be configured in `allowedOrigins` or be the
`apiOriginAudience`; an explicit `Origin` must match it. The server authenticates only
the selected audience and still checks application and resource access. Omitting the
selector preserves the API audience default (`atlas`). This selector applies only to
file-content reads, including object, action/workflow run, and agent message files.
It does not change authentication for other routes. API cookies must reach the request;
with Sixb's `SameSite=Strict` cookies, use same-site app/API origins for embedding.

## API Routes

### Connector OAuth callbacks

`GET /auth/connectors/callback` disables Bun's socket idle timeout while preserving provider-operation
deadlines. Reverse proxies must also allow enough time for provider processing.

Organization selection has no time limit. The initiating user can resume pending runs through
`GET /api/connectors/:connectorId/connection-runs`, with current connector-management permission.
See [OAuth connection flows](../../docs/connectors/authentication.md#connect-an-oauth-account-from-an-app).

### REST Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/project` | Project metadata |
| `GET` | `/api/status` | Runtime status (object type and function counts) |
| `GET` | `/api/actions` | List registered actions |
| `GET` | `/api/actions/:actionId` | Get action metadata |
| `POST` | `/api/actions/:actionId` | Run an action and return its finished run (`subject` is optional for global actions) |
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
| `GET` | `/api/files/downloads/:token` | Download a file through a URL from `blobs.createDownloadUrl()`; public, the token is the credential |

Upload sessions live in `storage.fileUploadSessions`, so they survive restarts and span replicas
with `@sixb/pg` and `@sixb/sqlite`. The session routes answer `501` when the storage has no such
store; single-request `POST /api/files` does not use it. A session that expires unfinished while
holding a provider upload is aborted by the API's maintenance pass, then deleted.

Download URLs live in `storage.fileDownloadGrants`, which stores each URL's token only as a hash.
They name `browser.publicOrigin`, which the server records on the host for that purpose. The
maintenance pass deletes a grant a week after it expires; until then it records which execution
exposed which file.

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
- **`SixbServerOptions`** -- Config: `host` and `browser` (required), `port` (default 3000), `hostname` (default `"0.0.0.0"`), `quiet`, `trustedProxies` (default `["private"]`: loopback, private, and link-local networks whose `x-forwarded-for` entries identify the client).

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
