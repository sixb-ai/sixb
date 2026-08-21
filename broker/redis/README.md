# @sixb/broker-redis

Redis Streams-backed implementation of the Sixb `Broker` interface. Use it
for deployments that want a durable multi-process broker backed by Redis.

## Installation

```bash
bun add @sixb/broker-redis
```

Requires Redis 7.2 or newer.

This package uses Bun's native Redis client.

## Usage

```typescript
import { createSixb, InMemoryQueues } from "@sixb/core"
import { RedisBroker } from "@sixb/broker-redis"

export const sixb = createSixb({
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
first `append()`, `read()`, or `subscribe()` call. If `connection` is omitted,
the broker reads `REDIS_URL`, then `VALKEY_URL`, before falling back to Bun's
default Redis URL.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `connection` | `RedisBrokerConnectionOptions` | `undefined` | Redis connection and command settings. Supports `url`, `commandTimeoutMs`, `connectionTimeout`, `idleTimeout`, `autoReconnect`, `maxRetries`, `enableOfflineQueue`, `enableAutoPipelining`, and `tls`. |
| `prefix` | `string` | `"sixb:broker"` | Redis key prefix. |
| `dedupeTtlMs` | `number` | `120000` | Retry dedupe window for `idempotencyKey`. |
| `readBatchSize` | `number` | `1000` | `XRANGE COUNT` page size for retained reads. |
| `subscribeBatchSize` | `number` | `100` | `XREAD COUNT` page size for subscriptions. |
| `subscribeBlockMs` | `number` | `1000` | `XREAD BLOCK` duration. |

Connection examples:

```typescript
new RedisBroker()
new RedisBroker({ connection: { url: "redis://localhost:6379" } })
new RedisBroker({ connection: { url: "rediss://redis.example.com:6379", tls: true } })
```

## Redis Key Scheme

The provider stores one Redis Stream plus one metadata hash per Sixb project
and broker stream id:

| Concept | Shape |
| --- | --- |
| Stream key | `{prefix}:brk:{base64url(projectId):base64url(streamId)}:stream` |
| Metadata key | `{prefix}:brk:{base64url(projectId):base64url(streamId)}:meta` |
| Dedupe key | `{prefix}:brk:{base64url(projectId):base64url(streamId)}:dedupe:{base64url(idempotencyKey)}` |

The `{...}` segment is hash-tag-compatible and keeps the stream, metadata, and
dedupe keys for one logical broker stream grouped together. Bun's native Redis
client does not currently support Redis Cluster, so this provider targets
standalone Redis-compatible servers.

## Behavior Notes

### Cursors

Broker cursors are opaque strings. This provider uses Redis stream IDs such as
`1716400000000-0`. Callers should only pass cursors back to `read()` or
`subscribe()`.

When retention removes old entries, the provider records the latest trimmed
cursor in metadata. Reads after older cursors reject instead of silently
skipping unavailable history.

### Append

A single `append()` sends the complete record batch through one Lua call. The
`XADD` and retry-deduplication writes are atomic across that batch. Physical
retention trimming follows as a separate command; the append script records the
logical retained boundary first so concurrent reads cannot expose trimmed data.

For retryable writes, pass a stable `idempotencyKey`. The provider maps it to a
short-lived Redis key and returns the original retained record when the same key
is retried within `dedupeTtlMs`.

Appends, reads, and retention commands share one Redis client. Each command sent
through that client is bounded by `connection.commandTimeoutMs` (30 seconds by
default). The value must be an integer from 1 through 2,147,483,647 milliseconds,
which is the largest delay Bun's timer can represent. Bun's `connectionTimeout`
covers connecting and `idleTimeout` covers an idle socket; neither bounds a
command that was sent and never answered. One operation can make multiple round
trips; each round trip gets its own command timeout.

A command that passes the bound fails with a `RedisBrokerError`, and its client is discarded rather than reused, because the missing reply may still arrive and a late reply on a shared connection can be matched to the wrong command. A timeout is **indeterminate**: Redis may still apply a write after its caller has failed. Pass a stable `idempotencyKey` and retry while its deduplication key is still alive. Size `dedupeTtlMs` for the complete elapsed time from the original write through any later commands and retry backoff; `commandTimeoutMs` alone cannot guarantee that window. A Redis failover longer than the bound no longer completes transparently through Bun's reconnect and offline queue; it surfacesas a failed command.

### Subscribe

`subscribe()` uses plain `XREAD`, not consumer groups. That preserves the Sixb
broker contract: every subscriber receives every matching record independently.

By default subscriptions start at the latest retained cursor and receive only
new records. Use `from: "earliest"` or `afterCursor` for retained replay.

Subscription clients are disposable and do not reconnect in place. An
application-level watchdog also bounds each `XREAD BLOCK` call. If a read stalls
or its connection fails, the broker replaces that client and resumes from the
last observed cursor.

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
