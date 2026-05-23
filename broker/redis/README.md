# @pario/broker-redis

Redis Streams-backed implementation of the Pario `Broker` interface. Use it
for deployments that want a durable multi-process broker backed by Redis.

## Installation

```bash
bun add @pario/broker-redis
```

Requires Redis 7.2 or newer.

## Usage

```typescript
import { createPario, InMemoryQueues } from "@pario/core"
import { RedisBroker } from "@pario/broker-redis"

export const pario = createPario({
  id: "my-project",
  broker: new RedisBroker({
    connection: { url: "redis://localhost:6379" },
  }),
  storage: myStorage,
  lakeStorage: myLakeStorage,
  blobStorage: myBlobStorage,
  queues: new InMemoryQueues(),
})
```

The constructor is synchronous. Redis connections are opened lazily on the
first `append()`, `read()`, or `subscribe()` call.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `connection` | `RedisClientOptions` | required | node-redis connection options. |
| `prefix` | `string` | `"pario:broker"` | Redis key prefix. |
| `dedupeTtlMs` | `number` | `120000` | Retry dedupe window for `idempotencyKey`. |
| `readBatchSize` | `number` | `1000` | `XRANGE COUNT` page size for retained reads. |
| `subscribeBatchSize` | `number` | `100` | `XREAD COUNT` page size for subscriptions. |
| `subscribeBlockMs` | `number` | `1000` | `XREAD BLOCK` duration. |

## Redis Key Scheme

The provider stores one Redis Stream plus one metadata hash per Pario project
and broker stream id:

| Concept | Shape |
| --- | --- |
| Stream key | `{prefix}:brk:{base64url(projectId):base64url(streamId)}:stream` |
| Metadata key | `{prefix}:brk:{base64url(projectId):base64url(streamId)}:meta` |
| Dedupe key | `{prefix}:brk:{base64url(projectId):base64url(streamId)}:dedupe:{base64url(idempotencyKey)}` |

The `{...}` segment is a Redis Cluster hash tag. It keeps the stream, metadata,
and dedupe keys for one logical broker stream in the same cluster slot so the
append Lua script can update them atomically.

## Behavior Notes

### Cursors

Broker cursors are opaque strings. This provider uses Redis stream IDs such as
`1716400000000-0`. Callers should only pass cursors back to `read()` or
`subscribe()`.

When retention removes old entries, the provider records the latest trimmed
cursor in metadata. Reads after older cursors reject instead of silently
skipping unavailable history.

### Append

A single `append()` call with multiple records writes them sequentially. Each
individual record append is atomic through a Lua script that handles `XADD`,
retry dedupe, retention trimming, and retained-range metadata updates.

For retryable writes, pass a stable `idempotencyKey`. The provider maps it to a
short-lived Redis key and returns the original retained record when the same key
is retried within `dedupeTtlMs`.

### Subscribe

`subscribe()` uses plain `XREAD`, not consumer groups. That preserves the Pario
broker contract: every subscriber receives every matching record independently.

By default subscriptions start at the latest retained cursor and receive only
new records. Use `from: "earliest"` or `afterCursor` for retained replay.

### Retention

`maxRecords` maps to exact `XTRIM MAXLEN`, and `maxAgeMs` maps to exact
`XTRIM MINID`. Trimming happens during append. Existing metadata is not rewritten
by later `ensureStream()` calls with different retention options.

## Local Development

Start the test Redis server:

```bash
docker compose up -d --wait
```

This exposes Redis on `127.0.0.1:46380`.

Stop and clean up with:

```bash
docker compose down -v --remove-orphans
```

## Running Tests

```bash
bun run test:e2e
```
