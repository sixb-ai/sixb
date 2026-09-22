# Client SDK

`@sixb/client` connects TypeScript code to a Sixb API. It includes typed API functions, object queries, React hooks, and live subscriptions.

In a Sixb `app/`, client configuration and React Query setup are automatic. Start with [Apps](../apps/overview.md) for page-building examples.

## Choose an import

| Import | Use for |
| --- | --- |
| `@sixb/client` | API functions, action helpers, and the shared client. |
| `@sixb/client/query` | Typed object queries without React. |
| `@sixb/client/hooks` | React queries, mutations, and live event hooks. |
| `@sixb/client/browser` | Authentication setup for a standalone browser app. |
| `@sixb/client/logs` | Reading and subscribing to run logs. |

## Configure a client

For scripts and other server-side TypeScript code, configure the API origin and an [access token](../auth/members.md#service-accounts-and-tokens):

```ts
import { client } from "@sixb/client"

client.setConfig({
  baseUrl: "https://api.example.com",
  headers: { Authorization: `Bearer ${process.env.SIXB_API_TOKEN}` },
})
```

The shared client is used by API functions and query builders. Never expose a service token in browser code.

## Standalone browser apps

For a browser app served outside Sixb, initialize the browser client before rendering. The API must allow the app's [public origin](../deployment/overview.md#configure-public-origins).

```ts
import {
  configureSixbBrowserClient,
  requireSixbBrowserAuthSession,
} from "@sixb/client/browser"

const config = {
  api: { baseUrl: "https://api.example.com" },
  auth: { audience: "app" as const, enabled: true },
}
const controller = configureSixbBrowserClient(config)
await requireSixbBrowserAuthSession(config, controller)
```

This handles cookies, CSRF, session activity, and sign-in redirects. Call `controller.dispose()` when tearing down this setup. Expired sessions redirect to sign-in; failed mutations are not automatically retried.

React hooks also need a TanStack `QueryClientProvider`. A Sixb-served app supplies it for you; a standalone React app supplies its own.

## Call the API

API functions accept `path`, `query`, and `body` options matching the endpoint. Set `throwOnError` to reject failed requests:

```ts
import { getObject } from "@sixb/client"

const { data } = await getObject({
  path: { objectTypeId: "Invoice", objectId: "inv-1" },
  throwOnError: true,
})
```

Use [typed queries](typed-queries.md) when you want ontology-derived property types. Your API's `/docs` page contains the complete endpoint schemas.

## Wait for an action

`requestActionAndWait` waits for a terminal result. The lower-level `requestAction` returns when the request is queued.

```ts
import { requestActionAndWait } from "@sixb/client"

const run = await requestActionAndWait({
  path: { actionId: "markPaid" },
  body: {
    subject: { kind: "object", objectTypeId: "Invoice", primaryId: "inv-1" },
    params: {},
  },
  timeoutMs: 30_000,
})
```

Failed or cancelled runs reject with `ActionRunFailedError`; a timeout rejects with `ActionRunTimeoutError` and does not cancel the run. The helper follows terminal events when available and polls the run as a fallback.

In React, use [`useActionRunMutation`](../apps/actions.md), which includes loading and error state.

## Display files

Use `objectFileContentUrl` to render an object property's file. The example assumes `invoice` came from a typed query and has a `scan` file property.

```tsx
import { objectFileContentUrl } from "@sixb/client"

const url = objectFileContentUrl({
  objectTypeId: "Invoice",
  objectId: invoice.primaryId,
  pathSegments: ["scan"],
  fileRef: invoice.properties.scan,
  disposition: "attachment",
})

const download = <a href={url}>Download invoice</a>
```

Use `inline` for images. Pass the current file reference so the URL updates when the property changes. Native links use browser sessions; bearer-token callers must fetch file content through an authenticated request.

## Read run logs

Read or subscribe to captured logs with the logs builder:

```ts
import { logs } from "@sixb/client/logs"

const page = await logs.actions().run("run-1").tail({ limit: 50 })
const stop = logs.actions().run("run-1").subscribe((line) => {
  console.log(line.level, line.message)
})

// Call stop() when the subscription is no longer needed.
```

Other selectors include `logs.all()`, `logs.syncs()`, `logs.pipelines()`, and `logs.workflows()`. Add `.level("warn")` for warnings and errors. Reading logs requires `can.observe("logs")`; subscriptions use browser sessions.

For live data, see [Events & subscriptions](events.md). For error handling, see [Errors](../errors/overview.md).
