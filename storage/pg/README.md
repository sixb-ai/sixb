# @sixb/pg

PostgreSQL storage provider for Sixb.

One shared connection pool (porsager `postgres`) backs every Sixb store: objects, ontology commits,
auth, agents, timeseries, and the run history for actions, syncs, pipelines, projections, workflows,
and webhooks. This is the provider to use for anything you intend to operate.

## Install

```bash
bun add @sixb/pg
```

## Usage

```ts
import { PostgresStorage } from "@sixb/pg"
import { createSixb } from "@sixb/core"

const storage = new PostgresStorage({
  connectionString: process.env.DATABASE_URL,
})

export const sixb = createSixb({ storage, broker })
```

All Sixb tables live in one schema, `sixb` by default. Set `schemaName` to share a database with
other applications; it is pinned through `search_path` on every pooled connection.

## Migrations

`PostgresStorage` exposes core's `StorageMigrator` contract. The CLI runs it at startup and
`sixb db migrate` runs it on demand — you do not write migrations, they ship inside this package.

Before 1.0 the schema is a single migration whose checksum is verified at boot. A schema change
**replaces** that migration instead of adding another, so moving between 0.x versions can require
recreating the database. `dropSchema()` exists for exactly that, and for test teardown — it deletes
every Sixb table and the schema itself.

## Pooling and timeouts

| Option | Default | Why you would set it |
| --- | --- | --- |
| `max` | `10` | Pool size. Size it per role, not per project — an API replica and a worker each get their own pool. |
| `statementTimeoutMillis` | unset | A single stalled query can otherwise pin its connection until the process restarts. Keep it generous or unset for workers that run long bulk writes. |
| `idleInTransactionSessionTimeoutMillis` | unset | Aborts transactions left open and idle, releasing the connection. |
| `idleTimeoutMillis` | `30000` | Returns idle connections to the server. |
| `connectTimeoutMillis` | `10000` | Fail fast when the database is unreachable. |
| `shutdownTimeoutMillis` | `5000` | `close()` stops accepting queries and waits this long for in-flight work, so a restart drains instead of severing live writes. |

Call `close()` on shutdown.

### Behind a connection pooler

`prepare` defaults to `true`, which is correct for a direct connection. In PgBouncer transaction
mode, server-side prepared statements need PgBouncer >= 1.21 with `max_prepared_statements > 0`; set
`prepare: false` for an older PgBouncer, or when that setting is `0`.

## Transactions

```ts
await storage.transaction(
  async (tx) => {
    // Use `tx`, never the root storage — the root throws inside a transaction callback.
  },
  { isolation: "serializable" }
)
```

Nested transactions are rejected. A serialization conflict or deadlock surfaces as a
`StorageTransactionError` with `code: "serialization_failure"`, which is the signal that the
operation is safe to retry.
