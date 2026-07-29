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
