# Infrastructure

A Sixb runtime is wired to five infrastructure providers. Every one is **required** and
passed to [`createSixb()`](../runtime/overview.md). They split cleanly into three storage
slots plus two messaging slots:

| Slot | Option | Holds |
| --- | --- | --- |
| Storage | `storage` | Objects, links, telemetry, and run history |
| Lake storage | `lakeStorage` | Versioned [datasets](../data/datasets.md) (the lake) |
| Blob storage | `blobStorage` | `fileRef` payloads (binary blobs) |
| Broker | `broker` | The append-only [event log](../events/overview.md) |
| Queues | `queues` | Background work lanes (actions, syncs, pipelines, projections, workflows) |

```ts
import { createSixb, InMemoryBroker, InMemoryQueues } from "@sixb/core"
import { SqliteStorage } from "@sixb/sqlite"
import { LocalLakeStorage } from "@sixb/lake-local"
import { LocalBlobStorage } from "@sixb/blob-local"

export const sixb = await createSixb({
  id: "my-app",
  storage: new SqliteStorage({ path: ".sixb" }),
  lakeStorage: new LocalLakeStorage({ path: ".sixb/lake" }),
  blobStorage: new LocalBlobStorage({ basePath: ".sixb" }),
  broker: new InMemoryBroker(),
  queues: new InMemoryQueues(),
})
```

## The Three Storage Slots

Sixb deliberately separates storage by access pattern. They are not interchangeable, and
each takes its own provider.

- **`storage`** — the operational store. Objects and their properties, links, appended
  telemetry (timeseries), and run-history tables for actions, syncs, pipelines,
  projections, and workflows. This is the database behind `sixb.objects(...)` reads and
  writes.
- **`lakeStorage`** — the versioned data lake. Holds [datasets](../data/datasets.md)
  produced by [syncs](../data/syncs.md), [pipelines](../data/pipelines.md), and
  [connectors](../data/connectors.md), with snapshots and version compatibility.
- **`blobStorage`** — content-addressed binary blobs. When a dataset column or property is
  a `fileRef`, the bytes live here and the lake/object stores keep only the reference.

## Broker vs Queues

These are the two messaging slots and they are **not** the same thing. Keep them distinct.

| | Broker | Queues |
| --- | --- | --- |
| Shape | Append-only event log | Lease-based work lanes |
| Purpose | Records what happened, fans out to subscribers | Dispatches and retries background jobs |
| Operations | `append`, `read`, `subscribe` | `enqueue`, `claim`, `complete`, `retry`, `fail`, `renewLease` |
| Carries | Domain [events](../events/overview.md) (`object.upserted`, `telemetry.appended`, `link.upserted`, `action.requested`, …) | Run requests per lane |
| Replayable | Yes — retained, ordered history | No — jobs are consumed |

The broker is the source of truth for what has occurred; functions and projections
subscribe to it. Queues are the execution layer that turns requested work into running
work, with leases and retries.

The `queues` slot exposes one lane per kind of background work:

```ts
sixb.queues.actions
sixb.queues.syncRuns
sixb.queues.pipelines
sixb.queues.projections
sixb.queues.workflows
```

## Provider Matrix

Use the real provider class for each slot. `In*` providers come from `@sixb/core` and need
no extra install.

| Slot | Provider | Package | Notes |
| --- | --- | --- | --- |
| `storage` | `InMemoryStorage` | `@sixb/core` | Dev/tests only; not durable |
| `storage` | `SqliteStorage` | `@sixb/sqlite` | Single-process durable file store |
| `storage` | `PostgresStorage` | `@sixb/pg` | Multi-process production store |
| `lakeStorage` | `InMemoryLakeStorage` | `@sixb/core` | Dev/tests only |
| `lakeStorage` | `LocalLakeStorage` | `@sixb/lake-local` | Datasets on local disk |
| `lakeStorage` | `DuckLakeStorage` | `@sixb/ducklake` | DuckDB + DuckLake; durable, time travel |
| `blobStorage` | `InMemoryBlobStorage` | `@sixb/core` | Dev/tests only |
| `blobStorage` | `LocalBlobStorage` | `@sixb/blob-local` | Blobs on local disk |
| `blobStorage` | `S3BlobStorage` | `@sixb/blob-s3` | AWS S3 and S3-compatible (R2, MinIO, …) |
| `broker` | `InMemoryBroker` | `@sixb/core` | Dev/tests only |
| `broker` | `NatsBroker` | `@sixb/broker-nats` | NATS JetStream; durable, multi-process |
| `broker` | `RedisBroker` | `@sixb/broker-redis` | Redis Streams; durable, multi-process |
| `queues` | `InMemoryQueues` | `@sixb/core` | **Dev only** — single-process, not durable |
| `queues` | `BullMqQueues` | `@sixb/queues-bullmq` | Redis/BullMQ; durable, multi-process |

`InMemoryQueues` runs entirely in one process and loses jobs on restart. It is fine for
local development and tests, but a production deployment must use a durable provider such
as `BullMqQueues`.

## Production Example

A durable multi-process setup pairs PostgreSQL, DuckLake, S3 blobs, and Redis-backed
messaging:

```ts
import { createSixb } from "@sixb/core"
import { PostgresStorage } from "@sixb/pg"
import { DuckLakeStorage } from "@sixb/ducklake"
import { S3BlobStorage } from "@sixb/blob-s3"
import { RedisBroker } from "@sixb/broker-redis"
import { BullMqQueues } from "@sixb/queues-bullmq"

export const sixb = await createSixb({
  id: "my-app",
  storage: new PostgresStorage({ connectionString: process.env.DATABASE_URL! }),
  lakeStorage: new DuckLakeStorage({
    catalog: { type: "postgres", host: "localhost", database: "lake", user: "sixb", password: "secret" },
    dataPath: "s3://my-lake/data",
  }),
  blobStorage: new S3BlobStorage({ bucket: "my-lake", region: "us-east-1", basePath: "sixb" }),
  broker: new RedisBroker({ connection: { url: "redis://localhost:6379" } }),
  queues: new BullMqQueues({ connection: "redis://localhost:6379" }),
})
```

See [Deployment](../deployment/overview.md) for running this in production.

## Migrations

SQL-backed storage providers (`@sixb/pg`, `@sixb/sqlite`) own their schema and ship
migrations. The CLI applies them:

```bash
sixb db:migrate
```

This loads your runtime and runs `migrateStorage(sixb.storage)` against the configured
`storage` provider. The CLI also runs migrations automatically on startup, so you mainly
need `db:migrate` for explicit, pre-deploy migration steps. In-memory and file-lake
providers have no schema and skip this step.
