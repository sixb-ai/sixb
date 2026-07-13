# @sixb/broker-nats

NATS JetStream-backed implementation of the Sixb `Broker` interface.
Use it for deployments that want a durable multi-process broker instead of
the in-memory provider.

## Installation

```bash
bun add @sixb/broker-nats
```

Requires NATS server 2.10 or newer for multi-filter consumers.

## Usage

```typescript
import { createSixb, InMemoryQueues } from "@sixb/core"
import { NatsBroker } from "@sixb/broker-nats"

export const sixb = createSixb({
  id: "my-project",
  broker: new NatsBroker({
    connection: { servers: "nats://localhost:4222" },
  }),
  storage: myStorage,
  lakeStorage: myLakeStorage,
  blobStorage: myBlobStorage,
  queues: new InMemoryQueues(),
})
```

The constructor is synchronous. The underlying NATS connection is opened
lazily on the first `append()`, `read()`, or `subscribe()` call.

## Authentication

All NATS authentication modes are supported through the pass-through
`connection` option from `@nats-io/nats-core`.

```typescript
new NatsBroker({
  connection: {
    servers: "nats://localhost:4222",
    user: "sixb",
    pass: "secret",
  },
})

new NatsBroker({
  connection: {
    servers: "nats://localhost:4222",
    token: "supersecret",
  },
})
```

## Stream And Subject Scheme

The provider creates a dedicated JetStream stream for each Sixb project and
broker stream id.

| Concept | Shape |
| --- | --- |
| Stream name | `SIXB_BRK_{namespace}_{projectId}_{encodedStreamId}` |
| Subject filter | `{namespace}.{projectId}.{encodedStreamId}.>` |
| Record subject | `{namespace}.{projectId}.{encodedStreamId}.{encodedName}` |

`namespace` defaults to `sixb_broker` and can be overridden to isolate
environments or tests. `projectId` is restricted to `[a-zA-Z0-9_-]+`.
Stream ids and record names are base64url-encoded before they are placed into
NATS names or subjects.

## Retention

Retention is controlled by the `BrokerStreamDefinition.retention` value passed
when core runtimes ensure a stream:

```typescript
await broker.ensureStream({
  projectId: "acme",
  stream: {
    id: "__events",
    retention: { maxAgeMs: 2 * 24 * 60 * 60 * 1000 },
  },
})

await broker.append({
  projectId: "acme",
  streamId: "__events",
  records: [{ name: "test.record", payload: { id: "room-1" } }],
})
```

`maxAgeMs` maps to JetStream `max_age`, and `maxRecords` maps to
JetStream `max_msgs`. Streams are created with `discard: old`, so bounded
streams drop the oldest records when retention limits are reached. Existing
stream configurations are not rewritten by the provider.

## Behavior Notes

### Cursors

Broker cursors are opaque strings. This provider encodes JetStream stream
sequence numbers as cursors, but callers should only pass cursors back to
`read({ afterCursor })` or `subscribe({ afterCursor })`. If retention removes old
messages, `read({ afterCursor })` rejects when the cursor is older than the
earliest retained record, so callers can trigger hard recovery instead of
silently skipping unavailable history.

### Append

A single `append()` call with multiple records publishes them sequentially.
NATS JetStream has no multi-message transaction; if a later publish fails,
earlier records are already committed. For retryable writes, pass a stable
`idempotencyKey` on each record so JetStream can deduplicate within its
duplicate window.

### Subscribe

`subscribe()` uses ephemeral ordered consumers. By default it starts at
`from: "latest"` and only receives new records. Use `from: "earliest"` or
`afterCursor` when a caller needs retained replay. Multiple subscribers each
receive every matching record independently.

### Close

`NatsBroker` implements optional `Broker.close()` and drains active
subscriptions before closing the underlying NATS connection.

## Local Development

A `docker-compose.yml` is included for running the test server:

```bash
docker compose up -d --wait
```

This exposes a JetStream-enabled NATS server on `127.0.0.1:42222` with the
monitoring endpoint on `42223`.

Stop and clean up with:

```bash
docker compose down -v --remove-orphans
```

## Running Tests

```bash
bun run test:e2e
```

The e2e suite starts the local JetStream server, runs the shared broker
contract suite against `NatsBroker`, then tears the container down.
