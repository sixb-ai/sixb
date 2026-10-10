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

This handles cookies, CSRF, session activity, and sign-in redirects. When the API runs with auth disabled, `requireSixbBrowserAuthSession` returns `{ authenticated: false, authEnabled: false }` instead of redirecting. Call `controller.dispose()` when tearing down this setup. Expired sessions redirect to sign-in; failed mutations are not automatically retried.

React hooks also need a TanStack `QueryClientProvider`. A Sixb-served app supplies it for you; a standalone React app supplies its own.

## Tools outside the browser

A command-line tool or other program that runs outside the browser signs its user in through the browser and holds a session instead of a token. Store the session where your platform keeps secrets:

```ts
import {
  client,
  configureSixbClient,
  type SixbSessionStore,
  signOutSixbSession,
  startSixbDeviceLogin,
} from "@sixb/client"

const baseUrl = "https://api.example.com"
const store: SixbSessionStore = {
  load: () => secureStorage.get("sixb-session"),
  save: (tokens) => secureStorage.set("sixb-session", tokens),
  clear: () => secureStorage.delete("sixb-session"),
}

// Sign in once: the user approves in the browser.
const login = await startSixbDeviceLogin({ baseUrl, clientName: "Acme CLI" })
openInBrowser(login.verificationUriComplete) // shows login.userCode
await store.save(await login.complete())

// Every API function, query, hook, and live subscription now uses the session.
configureSixbClient(client, {
  baseUrl,
  auth: { kind: "session", store, onSessionEnded: () => showSignIn() },
})

// Sign out on the server and clear the store.
await signOutSixbSession({ baseUrl, store })
```

The access token lasts 15 minutes. The client refreshes it before it expires, and once more if the API rejects it, so the user stays signed in while the tool is used. The session ends after the API's idle timeout without use, or when it is signed out or revoked; the client then clears the store and calls `onSessionEnded`. The session appears under the tool's name in the user's sessions in Atlas.

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

## Run an action

`requestAction` runs the action and returns its finished run. A run that fails comes back with `status: "failed"` and its `error`. An error response usually means no run was requested, but it can also follow a run that started: send the request again with the same `runId` to get that run's record.

```ts
import { requestAction } from "@sixb/client"

const { data: run } = await requestAction({
  path: { actionId: "markPaid" },
  body: {
    subject: { kind: "object", objectTypeId: "Invoice", primaryId: "inv-1" },
    params: {},
  },
  throwOnError: true,
})

if (run.status !== "succeeded") {
  console.error(run.error?.message)
}
```

To retry safely, send your own `runId` in the body. A repeated request returns the finished run instead of running the action again, and answers 409 while it still runs. Closing the connection does not cancel the action.

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

Use `inline` for images, video, and audio. Pass the current file reference so the URL updates when the property changes. Native links use browser sessions; bearer-token callers must fetch file content through an authenticated request.

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
