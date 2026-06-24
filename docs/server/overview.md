# Server & API

The Sixb server wraps a running Sixb runtime in an [Elysia](https://elysiajs.com) HTTP + WebSocket API. It exposes your ontology, objects, telemetry, actions, automation runs, and domain events over JSON routes under `/api/*`, a real-time event stream over `/ws/events`, and interactive OpenAPI docs at `/docs`.

The server only serves the API. The built-in admin UI (**atlas**) and any custom app run as separate servers that talk to this API over HTTP — see [Apps](../apps/overview.md) and [Client](../client/overview.md).

## Mental model

```txt
createSixb()  ->  Sixb runtime
       |
createSixbServer({ sixb, browser })  ->  Elysia API on :3000
       |
   /api/*   JSON routes (objects, telemetry, actions, runs, auth)
   /ws/events   live domain-event stream
   /docs    OpenAPI (Swagger UI)
       ^
       |  HTTP (cookies + CSRF)
   atlas UI  +  custom app  (separate servers)
```

The server takes an already-constructed runtime — it does **not** build one for you. You create the runtime with `createSixb()`, then hand it to `createSixbServer`.

## Starting the server

The common path is `sixb dev` (runtime + atlas + custom app) or `sixb api` (API only). To embed the server directly:

```ts
import { createSixb } from "@sixb/core"
import { createSixbServer } from "@sixb/server"

const sixb = await createSixb()

const server = createSixbServer({
  sixb,
  port: 3000,
  host: "0.0.0.0",
  browser: {
    publicOrigin: "https://api.example.com",
    allowedOrigins: ["https://atlas.example.com"],
  },
})

await server.start()
// API at      http://0.0.0.0:3000
// OpenAPI at  http://0.0.0.0:3000/docs

await server.stop()
```

### Options

| Option    | Type                  | Default     | Description                                                       |
| --------- | --------------------- | ----------- | ----------------------------------------------------------------- |
| `sixb`    | `Sixb`                | (required)  | A runtime from `createSixb()`. The server never constructs one.   |
| `browser` | `SixbApiBrowserPolicy`| (required)  | Origin policy: the API's `publicOrigin` and `allowedOrigins`.     |
| `port`    | `number`              | `3000`      | TCP port to listen on.                                            |
| `host`    | `string`              | `"0.0.0.0"` | Bind host.                                                        |
| `quiet`   | `boolean`             | `false`     | Suppress startup logging.                                         |

The `browser` policy is load-bearing for security: it drives CORS, blocks disallowed `Origin` headers up front, and resolves the public origin used when minting auth redirects. Set `allowedOrigins` to the origins of every browser front-end (atlas, custom apps) that calls the API.

## Route groups

All JSON routes are prefixed with `/api`. They mirror the runtime's typed APIs; see the linked concept pages for behavior. The full per-route request/response contract for objects lives in the [HTTP reference](../objects/http-reference.md).

| Group        | Representative routes                                                        | See                                          |
| ------------ | --------------------------------------------------------------------------- | -------------------------------------------- |
| Objects CRUD | `GET /api/objects`, `GET/PUT /api/objects/:type/:id`                         | [Objects](../objects/overview.md)            |
| Object query | `POST /api/objects/query`, `.../query/count`, `.../query/exists`, `.../query/facets` | [Querying](../objects/querying.md)   |
| Telemetry    | `GET/POST /api/objects/:type/:id/telemetry/:prop`, `.../history`, `.../latest` | [Telemetry](../objects/telemetry.md)      |
| Links        | `GET/PUT/DELETE /api/objects/:type/:id/links/:linkId`                        | [Links](../ontology/links.md)                |
| Actions      | `GET /api/actions`, `POST /api/actions/:actionId`                            | [Actions](../actions/overview.md)            |
| Action runs  | `GET /api/action-runs`, `GET /api/action-runs/:runId`                       | [Actions](../actions/overview.md)            |
| Ontology     | `GET /api/object-types`, `GET /api/object-types/:objectTypeId`               | [Ontology](../ontology/overview.md)          |
| Events (WS)  | `GET /ws/events`                                                             | [Events](../events/overview.md)              |
| Workflows    | `GET /api/workflows`, `/api/workflow-runs`, `/api/workflows/:id/runs`        | [Workflows](../workflows/overview.md) |
| Interventions| `/api/workflow-interventions`, `.../:id/submit`, `.../:id/cancel`           | [Interventions](../workflows/interventions.md) |
| Rules        | `GET /api/rules`, `GET /api/rule-states`                                     | [Rules](../rules/overview.md)         |
| Datasets     | `/api/datasets`, `.../versions`, `.../rows`                                  | [Datasets](../data/datasets.md)              |
| Syncs        | `/api/syncs`, `/api/sync-runs`, `/api/syncs/:id/runs`                       | [Syncs](../data/syncs.md)                    |
| Pipelines    | `/api/pipelines`, `/api/pipeline-runs`, `/api/pipelines/:id/runs`           | [Pipelines](../data/pipelines.md)            |
| Projections  | `GET /api/projections`, `GET /api/projections/:projectionId`                | [Projections](../data/projections.md)        |
| Connectors   | `GET /api/connectors`, `GET /api/connectors/:connectorId`                   | [Connectors](../data/connectors.md)          |
| Webhooks     | `POST /api/webhooks/:connectorId/:webhookId`, `GET /api/webhook-runs`       | [Connectors](../data/connectors.md)          |
| Auth         | `/api/auth/session`, `/auth/sign-in`, `/auth/callback`, `/api/auth/...`     | [Auth](../auth/overview.md)                  |
| Project/Status | `GET /api/project`, `GET /api/status`                                     | —                                            |

## Real-time events

`GET /ws/events` is a WebSocket stream of [domain events](../events/overview.md) (`object.upserted`, `telemetry.appended`, `link.upserted`, `link.removed`, `action.requested`, and more). Any authenticated principal may connect; each event is filtered per-principal by grants as it streams.

After connecting, send a `subscribe` message to filter the stream and a `unsubscribe` to stop:

```json
{ "type": "subscribe", "topic": "object.upserted", "types": ["sensor"], "limit": 100 }
```

The server replies with `connected`, `subscribed`, and `unsubscribed` control frames and then streams matching events. For a typed client over this stream, see [Client](../client/overview.md).

## OpenAPI

The server mounts Swagger UI at `/docs` and serves the OpenAPI document for every route group (tagged Objects, Telemetry, Actions, Workflows, Datasets, Syncs, Pipelines, Projections, Auth, and more). Zod schemas are converted to JSON Schema automatically, so the docs stay in sync with route validation. The generated typed client in [`packages/client`](../client/overview.md) is built from this contract — when routes or schemas change, run `bun run generate:client`.

## Auth, CSRF, and cookies

Auth is enforced centrally. On every request the server resolves the session once, attaches the principal's scoped SDK (`sixb.as(authz)`), and rejects denied requests before any route runs. When auth is disabled (privileged mode) the scoped context stays `null` and routes run unguarded.

| Mechanism      | Detail                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------- |
| Session        | `/auth/sign-in` starts the flow; `/auth/callback` mints the `httpOnly` session cookie.          |
| CSRF           | Double-submit: a `sixb_csrf` cookie plus a matching `x-sixb-csrf` request header on mutations.  |
| Browser origin | Disallowed `Origin` headers get a `403` before routing; CORS is restricted to `allowedOrigins`. |

Browser front-ends call the API with credentials (cookies) and echo the CSRF token in the `x-sixb-csrf` header on writes. Server-to-server callers authenticate per your auth provider. See [Authentication](../auth/authentication.md) and [Authorization](../auth/authorization.md) for the full model.

## Admin UI (atlas) vs custom apps

The API server does **not** serve any HTML. Front-ends are separate servers pointed at `apiBaseUrl`:

- **atlas** — the built-in admin UI (`@sixb/atlas`). `sixb dev` starts it automatically alongside the API. It is a browser client for the same `/api` routes, scoped to the `atlas` audience.
- **custom app** — your own front-end under the project's app directory, served with the `app` audience. See [Apps](../apps/overview.md).

Both are ordinary API clients. To build one, consume the typed [Client](../client/overview.md) and the [Objects HTTP reference](../objects/http-reference.md).
