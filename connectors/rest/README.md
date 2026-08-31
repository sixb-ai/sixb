# @sixb/connector-rest

REST connector for Sixb, built on native `fetch`.

The base most other Sixb connectors are written on: it owns auth headers, timeouts, retry with
backoff, request pacing, and webhook registration, so a vendor-specific connector only has to
describe endpoints.

## Install

```bash
bun add @sixb/connector-rest
```

## Usage

```ts
// connectors/billing.ts
import { rest } from "@sixb/connector-rest"

export const billing = rest({
  baseUrl: "https://api.example.com/v2",
  headers: () => ({ Authorization: `Bearer ${process.env.BILLING_TOKEN}` }),
  timeoutMs: 30_000,
})
```

`createSixb()` discovers `connectors/`, so the export is all the registration you need. Handlers then
receive a `RestClient` with `request`, `get`, and `post`; each returns the raw `Response` so you decide
how to read the body.

## Options

| Option | Purpose |
| --- | --- |
| `baseUrl` | Prefix for every request path. |
| `headers` | Resolver called per request — return fresh headers so a rotating token is never captured once at construction. |
| `timeoutMs` | Per-request timeout. |
| `minDelayMs` | Minimum spacing between requests, for APIs that rate-limit by request rate. |
| `retry` | Retry policy: which statuses and errors are retried, and the backoff between attempts. |
| `onUnauthorized` | Called when the API answers 401 — refresh a token here, then the request is retried. |
| `webhooks` | `WebhookDefinition`s served by this connector, so inbound deliveries land on the same client. |

`headers` being a resolver rather than a value is the part worth remembering: it is what lets a
connector hold a short-lived credential without reconstructing the connector.

## Reliability contract

The default retry policy only replays idempotent methods (`GET`, `HEAD`, and `OPTIONS`) after a
network error, 429, or 5xx response. A request body must also be mechanically replayable: stream
bodies are never retried. Caller aborts stop both queued pacing and retry backoff immediately.

Mark a semantically read-only write explicitly, or disable retries even when a custom policy is
configured:

```ts
await client.post("reports/query", query, undefined, { idempotent: true })
await client.get("volatile-snapshot", undefined, { retryable: false })
```

For compatibility, `{ retry: false }` in the request init remains an alias for
`{ retryable: false }` and is stripped before the native `fetch` call.

`onUnauthorized` follows the same rules: only an idempotent request with a replayable body is sent
again after credentials are refreshed. The helpers `withQuery`, `readResponseBody`, and
`parseRetryAfter` are exported for typed vendor connectors built on this transport.
