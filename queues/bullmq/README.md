# @sixb/queues-bullmq

A Redis/BullMQ-backed implementation of the Sixb `Queues` interface. Swap it in wherever `InMemoryQueues` is used to get durability, multi-process sharing, and Redis-level observability without any consumer changes.

## Installation

```bash
bun add @sixb/queues-bullmq
```

## Usage

```typescript
import { createSixb } from "@sixb/core"
import { BullMqQueues } from "@sixb/queues-bullmq"

const sixb = await createSixb({
  queues: new BullMqQueues({ connection: "redis://localhost:6379" }),
})
```

The rest of your code keeps calling `sixb.queues.syncRuns.enqueue(...)`,
`sixb.queues.pipelines.claim(...)`, `sixb.queues.projections.claim(...)`, or
`sixb.queues.workflows.claim(...)` exactly as before — the adapter translates Sixb's lease-based
`claim`/`complete`/`retry`/`fail`/`renewLease` onto BullMQ's manual-fetch primitives.

## Options

| Option             | Type                                       | Default                               | Description                                                                                           |
| ------------------ | ------------------------------------------ | ------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `connection`       | `string \| RedisOptions \| IORedis`        | _(required)_                          | Redis URL, ioredis options, or an existing IORedis client with `maxRetriesPerRequest: null`.          |
| `prefix`           | `string`                                   | `"sixb"`                             | BullMQ key prefix. Keys look like `sixb:{<projectId>:<lane>}:wait`.                                  |
| `defaultLeaseMs`   | `number`                                   | `30000`                               | Lease duration applied when callers do not pass `leaseMs` to `claim()`.                               |
| `stalledInterval`  | `number`                                   | `30000`                               | Interval for the stalled-job checker. Lower values speed up lease-expiry redelivery in tests.         |
| `maxStalledCount`  | `number`                                   | `Number.MAX_SAFE_INTEGER`             | Maximum stalls before BullMQ moves a job to `failed`. Large by default so retries stay caller-driven. |
| `removeOnComplete` | `LaneRemovalPolicy \| number \| boolean`   | `{ age: 86400, count: 1000 }`         | BullMQ cleanup policy for completed jobs.                                                             |
| `removeOnFail`     | `LaneRemovalPolicy \| number \| boolean`   | `{ age: 604800 }`                     | BullMQ cleanup policy for failed jobs.                                                                |

## Where jobs live in Redis

With the default prefix, each `(projectId, lane)` pair maps to a BullMQ queue named `${projectId}:${lane}`:

```
sixb:<projectId>:{sync.runs}:wait        LIST      ready to be claimed
sixb:<projectId>:{sync.runs}:active      LIST      currently leased
sixb:<projectId>:{sync.runs}:delayed     ZSET      scheduled, score = availableAt (ms)
sixb:<projectId>:{sync.runs}:completed   ZSET      bounded history
sixb:<projectId>:{sync.runs}:failed      ZSET      bounded history
sixb:<projectId>:{sync.runs}:<jobId>:lock STRING EX the lease, TTL = lockDuration
```

The `{...}` around the queue name is a Redis Cluster hash tag — it forces every key of a given queue onto the same slot so BullMQ's Lua scripts stay atomic in cluster mode.

Per-project queues keep tenants isolated — `getNextJob` on one project's queue never returns another project's jobs, so `attemptsMade` counters stay accurate under contention.

## Translation cheatsheet

| Sixb `Queue<TJob>`       | BullMQ                                  |
| ------------------------- | --------------------------------------- |
| `enqueue(jobs)`           | `queue.addBulk([{ name, data, opts }])` |
| `claim({ leaseMs })`      | `worker.getNextJob(token)` + `extendLock` |
| `complete(leaseId)`       | `job.moveToCompleted(_, token, false)`  |
| `retry(availableAt)`      | `job.moveToDelayed(ts, token)`          |
| `fail(error)`             | `job.moveToFailed(err, token, false)`   |
| `renewLease(leaseMs)`     | `job.extendLock(token, leaseMs)`        |
| `leaseId`                 | BullMQ `token` (minted per claim)       |
| `attempt`                 | BullMQ `attemptsStarted`                |

Retries are caller-driven: `enqueue` always sets BullMQ `attempts: 1` so BullMQ never auto-retries. Sixb's own `retry(availableAt)` uses `moveToDelayed`, which is the only release primitive available to a manually-fetched job.

## Connections

`connection` accepts a URL string, a `RedisOptions` object, or an existing `IORedis` instance.

- **URL / `RedisOptions`** (default path) — BullMQ creates and owns the underlying ioredis
  instances. `BullMqQueues.close()` closes the BullMQ handles, which transitively closes
  their connections. This path keeps the "Connection is closed" shutdown race (between
  BullMQ's stalled-check timer and connection quit) inside BullMQ, where
  `checkConnectionError` already swallows it.
- **Existing `IORedis` instance** — borrowed. Must have `maxRetriesPerRequest: null` set
  because BullMQ's workers block on it. `close()` does not quit the borrowed instance; the
  caller retains ownership.

BullMQ's `Worker` requires `maxRetriesPerRequest: null` internally. The provider transparently
applies that to the worker-side connection spec; callers don't need to set it unless they pass
a borrowed `IORedis`.
