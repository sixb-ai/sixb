# Server & API

The Sixb server wraps a running Sixb runtime in an [Elysia](https://elysiajs.com) HTTP + WebSocket API. It exposes your ontology, objects, telemetry, actions, automation runs, agents, and domain events as JSON routes under `/api/*`, real-time WebSocket streams for events (`/ws/events`), logs (`/ws/logs`), and agent runs (`/ws/agents`), and interactive OpenAPI docs at `/docs`.

Reach for it whenever a browser front-end or another service needs to talk to your runtime over the network. The server serves the API only — the built-in admin UI (**atlas**) and any custom app run as separate servers that call it over HTTP.

## Mental model

Sixb splits into three layers. The server is the middle one: it takes an already-built runtime and puts it on the network. It does **not** construct a runtime for you.

| Layer      | You call                                | What it is                                                       |
| ---------- | --------------------------------------- | --------------------------------------------------------------- |
| Runtime    | `createSixb()`                          | Your ontology, objects, automation, and storage, in-process.    |
| API        | `createSixbServer({ sixb, browser })`   | An Elysia HTTP + WebSocket server over that runtime.            |
| Front-ends | atlas + your app                        | Separate browser clients that call `/api` over HTTP.            |

Data flows one direction: **front-ends → `/api` (cookies + CSRF) → server → runtime → storage**, with domain events streaming back out over `/ws/events`.

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
    publicOrigin: "https://api.acme.example",
    allowedOrigins: [
      { origin: "https://atlas.acme.example", audience: "atlas" },
      { origin: "https://app.acme.example", audience: "app" },
    ],
  },
})

await server.start()
// API at      http://0.0.0.0:3000
// OpenAPI at  http://0.0.0.0:3000/docs

await server.stop()
```

### Options

| Option    | Type                   | Default     | Description                                                     |
| --------- | ---------------------- | ----------- | --------------------------------------------------------------- |
| `sixb`    | `Sixb`                 | (required)  | A runtime from `createSixb()`. The server never builds one.     |
| `browser` | `SixbApiBrowserPolicy` | (required)  | Origin policy: the API's `publicOrigin` and `allowedOrigins`.   |
| `port`    | `number`               | `3000`      | TCP port to listen on.                                          |
| `host`    | `string`               | `"0.0.0.0"` | Bind host.                                                      |
| `quiet`   | `boolean`              | `false`     | Suppress startup logging.                                       |

The `browser` policy is load-bearing for security: it drives CORS, rejects disallowed `Origin` headers up front, and resolves the public origin used to mint auth redirects. Each `allowedOrigins` entry maps one front-end origin to its auth `audience` (`atlas` or `app`), and each audience can have only one origin. Configured audiences become invitation destinations and application-access boundaries.

## Route groups

All JSON routes are prefixed with `/api` and mirror the runtime's typed APIs; see the linked pages for behavior. The full per-route request/response contract for objects lives in the [HTTP reference](../objects/http-reference.md).

| Group          | Representative routes                                                                | See                                             |
| -------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------- |
| Objects CRUD   | `GET /api/objects`, `GET/PUT /api/objects/:type/:id`                                 | [Objects](../objects/overview.md)               |
| Object query   | `POST /api/objects/query`, `.../query/count`, `.../query/exists`, `.../query/facets` | [Querying](../objects/querying.md)              |
| Telemetry      | `GET/POST /api/objects/:type/:id/telemetry/:prop`, `.../history`, `.../latest`       | [Telemetry](../objects/telemetry.md)            |
| Links          | `GET/PUT/DELETE /api/objects/:type/:id/links/:linkId`                                | [Links](../ontology/links.md)                   |
| Actions        | `GET /api/actions`, `POST /api/actions/:actionId`                                    | [Actions](../actions/overview.md)               |
| Action runs    | `GET /api/action-runs`, `GET /api/action-runs/:runId`                                | [Actions](../actions/overview.md)               |
| Ontology       | `GET /api/object-types`, `GET /api/object-types/:objectTypeId`                       | [Ontology](../ontology/overview.md)             |
| Events (WS)    | `GET /ws/events`                                                                     | [Events](../events/overview.md)                 |
| Agents         | `GET /api/agents`, `/api/agent-threads`, `.../messages`, `/api/agent-runs/:runId`, `GET /ws/agents` | [Agents](../agents/overview.md)  |
| Logs           | `GET /api/logs`, `GET /ws/logs`                                                      | [Logging](../logging/overview.md)               |
| Workflows      | `GET /api/workflows`, `/api/workflow-runs`, `/api/workflows/:id/runs`                | [Workflows](../workflows/overview.md)           |
| Interventions  | `/api/workflow-interventions`, `.../:id/submit`, `.../:id/cancel`                    | [Interventions](../workflows/interventions.md)  |
| Rules          | `GET /api/rules`, `GET /api/rule-states`                                             | [Rules](../rules/overview.md)                   |
| Datasets       | `/api/datasets`, `.../versions`, `.../rows`                                          | [Datasets](../data/datasets.md)                 |
| Syncs          | `/api/syncs`, `/api/sync-runs`, `/api/syncs/:id/runs`                                | [Syncs](../data/syncs.md)                       |
| Pipelines      | `/api/pipelines`, `/api/pipeline-runs`, `/api/pipelines/:id/runs`                    | [Pipelines](../data/pipelines.md)               |
| Projections    | `GET /api/projections`, `GET /api/projections/:projectionId`                         | [Projections](../data/projections.md)           |
| Connectors     | `GET /api/connectors`, `GET /api/connectors/:connectorId`                            | [Connectors](../data/connectors.md)             |
| Webhooks       | `POST /api/webhooks/:connectorId/:webhookId`, `GET /api/webhook-runs`               | [Connectors](../data/connectors.md)             |
| Auth           | `/api/auth/session`, `/auth/sign-in`, `/auth/callback`, `/api/auth/...`              | [Auth](../auth/overview.md)                     |
| Project/Status | `GET /api/project`, `GET /api/status`, `GET /health`, `GET /ready`                   | —                                               |

The object, link, and telemetry **writes are not grant-checked in 0.1.0**: any authenticated session
can call them. Reads are filtered. See [Authorization](../auth/authorization.md).

Status endpoints have distinct meanings:

| Endpoint | Meaning | Failure behavior |
| --- | --- | --- |
| `GET /health` | The API process is alive. | Returns `200` while the process can serve HTTP. |
| `GET /ready` | Storage is reachable and its schema is current. | Returns `503` when the runtime must leave traffic. |
| `GET /api/status` | Cached outbox, retry, cleanup, and maintenance state. | Reports `degraded` without removing a healthy API from traffic. |

## Real-time events

`GET /ws/events` is a WebSocket stream of [domain events](../events/overview.md) — `object.created`, `object.updated`, `telemetry.appended`, `link.created`, `action.requested`, and more. Any authenticated principal may connect; each event is filtered per-principal by grants as it streams.

On connect, the server sends a `connected` control frame. Send a `subscribe` message to filter the stream — by `topic` (one domain-event topic such as `objects`, `telemetry`, `links`, or `actions`), `types` (specific event types), and/or `objectTypeId` (one object type) — and `unsubscribe` to stop:

```json
{ "type": "subscribe", "topic": "objects", "types": ["object.created", "object.updated"], "objectTypeId": "Invoice", "limit": 100 }
```

The example above streams create and update events for `Invoice` objects only — useful for a billing dashboard that reacts as invoices are created, sent, or marked paid. The server replies with `subscribed` and `unsubscribed` control frames, streams matching events as `{ "type": "event", "event": ... }`, and reports problems as `{ "type": "error", "message": ... }`. For a typed client over this stream, see [Client](../client/overview.md).

Two more WebSocket streams follow the same connect/subscribe shape: `/ws/logs` for run [logs](../logging/overview.md) and `/ws/agents` for live [agent](../agents/overview.md) runs.

## OpenAPI

The server mounts Swagger UI at `/docs` and serves an OpenAPI document for every route group (tagged Objects, Telemetry, Actions, Workflows, Datasets, Syncs, Pipelines, Projections, Auth, and more). Zod schemas are converted to JSON Schema automatically, so the docs stay in sync with route validation. The generated typed client in [`packages/client`](../client/overview.md) is built from this contract — when routes or schemas change, run `bun run generate:client`.

## Auth, CSRF, and cookies

Auth is enforced centrally. On every request the server resolves the session once, attaches the principal's scoped SDK (`sixb.as(authz)`), and rejects denied requests before any route runs. When auth is disabled (privileged mode) the scoped context stays `null` and routes run unguarded.

| Mechanism      | Detail                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------- |
| Session        | `/auth/sign-in` starts the flow; `/auth/callback` mints the `httpOnly` session cookie.          |
| CSRF           | Double-submit: a `sixb_csrf` cookie plus a matching `x-sixb-csrf` request header on mutations.  |
| Browser origin | Disallowed `Origin` headers get a `403` before routing; CORS is restricted to `allowedOrigins`. |

Browser front-ends call the API with credentials (cookies) and echo the CSRF token in the `x-sixb-csrf` header on writes. Server-to-server callers authenticate per your auth provider. See [Authentication](../auth/authentication.md) and [Authorization](../auth/authorization.md) for the full model.

## Admin UI (atlas) vs custom apps

The API server serves no HTML. Front-ends are separate servers pointed at `apiBaseUrl`:

- **atlas** — the built-in admin UI (`@sixb/atlas`). `sixb dev` starts it automatically alongside the API. It is a browser client for the same `/api` routes, scoped to the `atlas` audience.
- **custom app** — your own front-end under the project's app directory, served with the `app` audience. See [Apps](../apps/overview.md).

Both are ordinary API clients. To build one, consume the typed [Client](../client/overview.md) and the [Objects HTTP reference](../objects/http-reference.md).

## Related

- [Client](../client/overview.md) — the generated typed client over these routes
- [Apps](../apps/overview.md) — building a custom front-end
- [Authentication](../auth/authentication.md) and [Authorization](../auth/authorization.md)
- [Objects HTTP reference](../objects/http-reference.md)
