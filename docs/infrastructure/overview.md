# Infrastructure

Every Sixb runtime is wired to five infrastructure providers. All are **required** and
passed to [`createSixb()`](../runtime/overview.md). They split into three storage slots and
two messaging slots.

| Slot | Option | Holds |
| --- | --- | --- |
| Storage | `storage` | Objects, links, telemetry, and run history |
| Lake storage | `lakeStorage` | Versioned [datasets](../datasets/overview.md) (the lake) |
| Blob storage | `blobStorage` | `fileRef` payloads (binary blobs) |
| Broker | `broker` | The append-only [event log](../events/overview.md) |
| Queues | `queues` | Background work lanes (actions, syncs, pipelines, projections, workflows) |

A typical local setup uses durable on-disk storage and in-memory messaging:

```ts
import { createSixb, InMemoryBroker, InMemoryQueues } from "@sixb/core"
import { SqliteStorage } from "@sixb/sqlite"
import { LocalLakeStorage } from "@sixb/lake-local"
import { LocalBlobStorage } from "@sixb/blob-local"

export const sixb = await createSixb({
  id: "northline",
  storage: new SqliteStorage({ path: ".sixb" }),
  lakeStorage: new LocalLakeStorage({ path: ".sixb/lake" }),
  blobStorage: new LocalBlobStorage({ basePath: ".sixb" }),
  broker: new InMemoryBroker(),
  queues: new InMemoryQueues(),
})
```

The CLI awaits the exported configuration before starting the project.

## The three storage slots

Sixb separates storage by access pattern. The slots are not interchangeable, and each takes
its own provider.

- **`storage`** — the operational store. Objects and their properties, links, appended
  telemetry, and run-history tables for actions, syncs, pipelines, projections, and
  workflows. This is the database behind `sixb.objects(...)` reads and writes.
- **`lakeStorage`** — the versioned data lake. Holds [datasets](../datasets/overview.md)
  produced by [syncs](../syncs/overview.md), [pipelines](../pipelines/overview.md), and
  [connectors](../connectors/overview.md), with snapshots and version compatibility.
- **`blobStorage`** — content-addressed binary blobs. When a property or dataset column is a
  `fileRef`, the bytes live here and the other stores keep only the reference.

## Events and background jobs

The broker delivers events to subscribers. Queues distribute background jobs to workers.
Use durable, shared providers for production: Redis Streams for events and BullMQ for jobs.
In-memory providers are intended for local development and tests.

## Existing data

There is no automatic importer for earlier unpublished storage schemas. Export project-owned data,
create fresh storage, then re-import through syncs, projections, actions, or the runtime API.
Keep project-specific migration scripts with your application.

## Retention

Sixb periodically cleans up delivered events and completed projection staging data. Both are kept
for 24 hours by default; pending work is retained. The commit history is not automatically purged,
so plan disk capacity accordingly. At least one API process must be running for cleanup and event
recovery to work.

Override the defaults only when you need a different retention window:

```ts
export const sixb = await createSixb({
  // ...
  ontologyMaintenance: {
    intervalMs: 60_000,
    publishedOutboxRetentionMs: 24 * 60 * 60_000,
    terminalSourceRetentionMs: 24 * 60 * 60_000,
    cleanupLimit: 1_000, // rows deleted per table per pass
  },
})
```

## Provider matrix

Pick a real provider class for each slot. `InMemory*` providers come from `@sixb/core` and
need no extra install — they are for development and tests only, never production.

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
| `queues` | `InMemoryQueues` | `@sixb/core` | Dev/tests only; loses jobs on restart |
| `queues` | `BullMqQueues` | `@sixb/queues-bullmq` | Redis/BullMQ; durable, multi-process |
| `logger` | `PinoLogger` | `@sixb/logger-pino` | **Optional** process-level log output (Pino) |

`logger` is the one **optional** slot. Omit it for broker-only logging (still readable in Atlas,
`sixb.logs`, and the client `logs` builder); add a `LoggerProvider` such as `PinoLogger` to also
emit process-level output. See [Logging](../logging/overview.md).

## Production configuration

See [Runtime](../runtime/overview.md#configure-your-project) for a complete PostgreSQL, DuckLake,
S3, and Redis configuration, then [Deployment](../deployment/overview.md) for the process layout.

## Migrations

SQL-backed storage providers (`@sixb/pg`, `@sixb/sqlite`) own their schema and ship
migrations. The six roles that touch the schema apply them at startup, so the explicit
command is for running the migration as its own deploy stage:

```bash
sixb db migrate
```

This loads your runtime and applies pending migrations against the configured `storage`
provider. In-memory and file-lake providers have no schema and skip this step. See
[Deployment](../deployment/overview.md#storage-migrations) for which roles migrate and how
to start them without migrating.

## Related

- [Runtime](../runtime/overview.md) — `createSixb()` and convention-based discovery
- [Events](../events/overview.md) — the domain events the broker carries
- [Deployment](../deployment/overview.md) — running a durable setup in production
