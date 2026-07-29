# Infrastructure

Every Sixb runtime is wired to five infrastructure providers. All are **required** and
passed to [`createSixb()`](../runtime/overview.md). They split into three storage slots and
two messaging slots.

| Slot | Option | Holds |
| --- | --- | --- |
| Storage | `storage` | Objects, links, telemetry, and run history |
| Lake storage | `lakeStorage` | Versioned [datasets](../data/datasets.md) (the lake) |
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

`createSixb()` is async — always `await` it.

## The three storage slots

Sixb separates storage by access pattern. The slots are not interchangeable, and each takes
its own provider.

- **`storage`** — the operational store. Objects and their properties, links, appended
  telemetry, and run-history tables for actions, syncs, pipelines, projections, and
  workflows. This is the database behind `sixb.objects(...)` reads and writes.
- **`lakeStorage`** — the versioned data lake. Holds [datasets](../data/datasets.md)
  produced by [syncs](../data/syncs.md), [pipelines](../data/pipelines.md), and
  [connectors](../data/connectors.md), with snapshots and version compatibility.
- **`blobStorage`** — content-addressed binary blobs. When a property or dataset column is a
  `fileRef`, the bytes live here and the other stores keep only the reference.

## Broker vs queues

The two messaging slots are **not** the same thing — keep them distinct.

| | Broker | Queues |
| --- | --- | --- |
| Shape | Append-only event log | Lease-based work lanes |
| Purpose | Records what happened, fans out to subscribers | Dispatches and retries background jobs |
| Operations | `append`, `read`, `latestCursor`, `subscribe` | `enqueue`, `claim`, `complete`, `retry`, `fail`, `renewLease` |
| Carries | Domain [events](../events/overview.md) (`object.created`, `object.updated`, `telemetry.appended`, `link.created`, `action.requested`, …) | Run requests, one per lane |
| Replayable | Yes — retained, ordered history | No — jobs are consumed |

For ontology facts, the operational database is authoritative: the Materializer writes
`ontology_commits` and `ontology_outbox` atomically before best-effort broker publication. The
broker is the retained delivery/read surface, while queues turn requested work into running work
with leases and retries. The `queues` provider
exposes one lane per kind of background work:

```ts
sixb.queues.actions
sixb.queues.syncRuns
sixb.queues.pipelines
sixb.queues.projections
sixb.queues.workflows
```

Storage providers must preserve bounded outbox claims, lease-fenced settlement, retry summaries,
published-row retention, and child-first cleanup of terminal source materializations. Pending rows,
nonterminal sources, and `ontology_commits` are never removed by age.

The required `storage.ping()` readiness check must be lightweight and read-only. It must not open a
write transaction, run migrations, or acquire a migration/advisory lock. Schema validation is a
separate cached check and retries failures with a cooldown.

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

## Production example

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
  id: "acme-corp",
  storage: new PostgresStorage({ connectionString: process.env.DATABASE_URL! }),
  lakeStorage: new DuckLakeStorage({
    catalog: { type: "postgres", host: "localhost", database: "lake", user: "sixb", password: "secret" },
    dataPath: "s3://acme-lake/data",
  }),
  blobStorage: new S3BlobStorage({ bucket: "acme-lake", region: "us-east-1", basePath: "sixb" }),
  broker: new RedisBroker({ connection: { url: "redis://localhost:6379" } }),
  queues: new BullMqQueues({ connection: "redis://localhost:6379" }),
})
```

See [Deployment](../deployment/overview.md) for running this in production.

## Migrations

SQL-backed storage providers (`@sixb/pg`, `@sixb/sqlite`) own their schema and ship
migrations. The CLI runs them automatically on startup, so you mainly need the explicit
command for pre-deploy migration steps:

```bash
sixb db:migrate
```

This loads your runtime and applies pending migrations against the configured `storage`
provider. In-memory and file-lake providers have no schema and skip this step.

## Related

- [Runtime](../runtime/overview.md) — `createSixb()` and convention-based discovery
- [Events](../events/overview.md) — the domain events the broker carries
- [Deployment](../deployment/overview.md) — running a durable setup in production
