# Client SDK

`@sixb/client` is the type-safe SDK for talking to a Sixb server from the
browser (or any TypeScript runtime). It is generated from the server's OpenAPI
schema, so every route, request body, and response is typed end to end.

The package ships as a set of focused subpaths. You import only the layer you
need: the raw generated SDK, a typed object-query builder, TanStack Query
hooks, live WebSocket event hooks, or the browser auth bootstrap.

## Mental model

Every subpath calls the same shared transport: a single generated `client`
instance (a [hey-api](https://heyapi.dev) fetch client). You configure it once —
base URL, credentials, auth interceptors — and all SDK calls, query builders,
hooks, and the events WebSocket inherit that configuration.

```ts
import { client } from "@sixb/client"

client.setConfig({
  baseUrl: "https://ops.acme.example",
  credentials: "include",
})
```

In a Sixb-served app (the `app/` directory), this is done for you: the runtime
injects config via [`/browser`](#browser-auth-bootstrap) and wraps your pages in
a `QueryClientProvider`. You write pages with the [`/hooks`](#hooks-tanstack-query)
layer and never touch the transport directly. In a standalone app, configure
`client` yourself and optionally wrap your tree in `SixbProvider`.

## Subpath map

| Import | What it gives you |
| --- | --- |
| `@sixb/client` | Generated per-route SDK functions, terminal action wait helpers, the shared `client`, and the UI models from `/models` |
| `@sixb/client/query` | `objects(Type).query()` — typed object-query builder over HTTP |
| `@sixb/client/hooks` | TanStack Query hooks and `*Options` factories, plus `SixbProvider` |
| `@sixb/client/events` | `SixbEvent` types and the `events.object(...)` builder |
| `@sixb/client/logs` | The `logs` builder — read, tail, and subscribe to run logs |
| `@sixb/client/agent-streams` | `useAgentRunStream` — stream a live agent run's messages |
| `@sixb/client/browser` | CSRF/auth bootstrap and `__SIXB_RUNTIME__` handoff |
| `@sixb/client/models` | `encode`/`decodeObjectId`, `executeAction`, UI shape mappers |

> `@sixb/client/hooks` re-exports `@sixb/client/events` and the typed-query
> hooks, so a React app usually only imports from `/hooks`.

## Root: generated SDK

The root export is the generated SDK: one function per server route, each fully
typed against its request and response schema. This is the lowest-level,
framework-agnostic way to call the API.

```ts
import { listObjects, getObject } from "@sixb/client"

const { data } = await listObjects({
  query: { objectTypeId: "Invoice", limit: "50" },
  throwOnError: true,
})
```

Every SDK function accepts the standard hey-api options (`path`, `query`,
`body`, `throwOnError`, `responseStyle`, and a per-call `client` override). The
shared `client` is also exported here for configuration.

For actions that should behave like a normal async command, use
`requestActionAndWait`. It sends the enqueue request, listens for terminal action
events, and fetches the final action-run detail as the source of truth.

```ts
import { requestActionAndWait } from "@sixb/client"

const run = await requestActionAndWait({
  path: { actionId: "markPaid" },
  body: {
    subject: { kind: "object", objectTypeId: "Invoice", primaryId: "inv-1" },
    params: { paymentMethod: "card" },
  },
  timeoutMs: 30_000,
})
```

Failed and cancelled terminal runs reject with `ActionRunFailedError`; timeouts
reject with `ActionRunTimeoutError`. Keep the generated `requestAction()` when
you only need enqueue acknowledgement.

## /query: typed object queries

`@sixb/client/query` exposes `objects(Type).query()` — the same fluent query
builder the server runtime uses, wired to the object-query routes through the
generated SDK. Queries are validated server-side; failures throw `SixbQueryError`
carrying the validation `issues`.

```ts
import { objects } from "@sixb/client/query"
import { Invoice } from "./ontology/invoice"

const result = await objects(Invoice)
  .query()
  .where((inv) => inv.p.status.eq("overdue"))
  .list()
```

This is the direct, hook-free path. For caching and React integration, the
`/hooks` layer wraps the same builder. See
[typed queries](typed-queries.md) for the full builder reference.

## /hooks: TanStack Query

`@sixb/client/hooks` is the React layer. It provides two kinds of API:

- `*Options` factories (e.g. `listObjectsOptions`, `objectQueryOptions`) that
  return TanStack Query option objects for prefetching, loaders, and SSR.
- `use*` hooks (e.g. `useObjectsQuery`, `useObjectsInfinite`,
  `useTelemetryHistoryQuery`) for components.

```tsx
import { listObjectsOptions } from "@sixb/client/hooks"
import { useQuery } from "@tanstack/react-query"

function Invoices() {
  const { data } = useQuery(
    listObjectsOptions({ query: { objectTypeId: "Invoice", limit: "200" } })
  )
  return <ul>{data?.map((o) => <li key={o.id}>{o.name}</li>)}</ul>
}
```

`SixbProvider` binds a specific `client` to the React tree so hooks and query
builders execute through it; without it, they fall back to the global `client`.

```tsx
import { SixbProvider } from "@sixb/client/hooks"

<SixbProvider client={client}>{children}</SixbProvider>
```

For typed-query hooks (`useObjectsQuery` and friends), see
[querying data](../apps/querying-data.md).

### Action run mutations

Use `useActionRunMutation` when mutation state should represent the final action
run, not just the enqueue request.

```tsx
import { useActionRunMutation } from "@sixb/client/hooks"
import { Invoice } from "../ontology/invoice"

const markPaid = useActionRunMutation<{ paymentMethod: "card" | "ach" }>({
  actionId: "markPaid",
  subject: { objectType: Invoice, primaryId: invoiceId },
  invalidateOnCommit: true,
})
```

With `invalidateOnCommit: true`, terminal runs refresh action-run caches and, when
a commit diff exists, object detail caches plus the typed object-query cache
group. See [running actions from apps](../apps/actions.md) for loading, error,
high-frequency control, and manual invalidation patterns.

## /events: live WebSocket

`@sixb/client/events` carries the `SixbEvent` union types, the `isSixbEvent`
guard, and the fluent `events.object(...)` builder. React apps use the builder through
hooks re-exported from `/hooks`: `useEvents`, `useLatest`, `useLatestByObject`,
and `useInvalidateOnEvent`.

```tsx
import { events, useEvents } from "@sixb/client/hooks"
import { Invoice } from "../ontology/invoice"

useEvents(events.object(Invoice).byId(invoiceId).updated(), (event) => {
  console.log(event.payload.properties)
})
```

The builder scopes and narrows event payloads by object type, topic, action run,
and action subject. See [client events](events.md) for setup, builder methods,
latest telemetry hooks, and cache invalidation patterns.

## /browser: auth bootstrap

Sixb-generated apps configure the browser client for you. Use `@sixb/client/browser` only when
bootstrapping a standalone app:

```ts
import {
  configureSixbBrowserClient,
  readSixbBrowserRuntimeConfig,
  requireSixbBrowserAuthSession,
} from "@sixb/client/browser"

const config = readSixbBrowserRuntimeConfig({ audience: "app" })
const browserClient = configureSixbBrowserClient(config)

if (config.auth.enabled) {
  await requireSixbBrowserAuthSession(config, browserClient)
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => browserClient.dispose())
}
```

After setup, use the generated SDK, hooks, and query client normally. Sixb handles cookies, CSRF,
session activity, and sign-in redirects. Expired sessions return users to their current page, but
failed requests are not replayed; users must submit failed mutations again.

See [authentication](../auth/authentication.md) to configure session timeouts.

## /models: ids and actions

`@sixb/client/models` holds object-id codecs, the action helper, and the UI
shape mappers used by the built-in UI.

| Export | Purpose |
| --- | --- |
| `encodeObjectId(typeId, primaryId)` | Encode a `typeId~primaryId` opaque object id |
| `decodeObjectId(id)` | Decode it back to `{ objectTypeId, primaryId }` or `null` |
| `executeAction({ path, body })` | Request an action on an object by encoded id |
| `executeGlobalAction({ path, body })` | Request a project-level (non-object) action |

```ts
import { encodeObjectId, executeAction } from "@sixb/client/models"

const id = encodeObjectId("Invoice", "inv-2042")
const { data } = await executeAction({
  path: { objectId: id, actionId: "markPaid" },
  body: { params: {} },
})
```

Object ids are encoded as `encodeURIComponent(typeId)~encodeURIComponent(primaryId)`,
so they are safe to pass through URLs and route params.

## Which subpath to use

| Goal | Use |
| --- | --- |
| One-off API call, no React | root SDK function (`@sixb/client`) |
| Typed object query, no React | `@sixb/client/query` |
| React component reading data | `@sixb/client/hooks` |
| React action button with terminal loading/error state | `useActionRunMutation` (`@sixb/client/hooks`) |
| Live updates in React | `events.object(...)` with `useEvents` / `useLatest` (`@sixb/client/hooks`) |
| Live run logs in an app | `logs.actions()`/`.syncs()`/… `.subscribe()` (`@sixb/client/logs`) |
| Stream a live agent run | `useAgentRunStream` (`@sixb/client/agent-streams`) |
| Bootstrap a standalone browser client | `@sixb/client/browser` |
| Encode/decode ids or fire actions | `@sixb/client/models` |

## Related

- [Typed queries](typed-queries.md) — the object-query builder reference
- [Client events](events.md) — live event builders and React hooks
- [Logging](../logging/overview.md) — the `@sixb/client/logs` builder
- [Querying data in apps](../apps/querying-data.md) — hooks in practice
- [Running actions from apps](../apps/actions.md) — action buttons and terminal mutation state
- [Events](../events/overview.md) — topics and event types
- [Authentication](../auth/authentication.md) — sessions and CSRF
- [Building apps](../apps/overview.md) — the Sixb-served app model
