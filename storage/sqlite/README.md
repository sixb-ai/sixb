# @sixb/sqlite

SQLite storage provider for Sixb, built on `bun:sqlite`.

Backs every Sixb store — objects, ontology commits, auth, agents, the immutable execution and AI
usage ledgers, timeseries, and the run history for actions, syncs, pipelines, projections,
workflows, and webhooks — from a single local database file. This is the storage `bun create sixb`
scaffolds, and part of what makes a fresh project run with no service to install.

## Install

```bash
bun add @sixb/sqlite
```

## Usage

```ts
import { SqliteStorage } from "@sixb/sqlite"
import { createSixb, InMemoryBroker } from "@sixb/core"

const storage = new SqliteStorage({ path: ".sixb" })

export const sixb = createSixb({ storage, broker: new InMemoryBroker() })
```

`path` is a **directory**; the provider owns the database file inside it. Omit `path` and the database
is in-memory: useful for tests, and it also means there is nothing to migrate, so `migrators` is
empty.

## Migrations

With a `path`, `SqliteStorage` exposes core's `StorageMigrator` contract and the CLI runs it at
startup. You do not write migrations — they ship inside this package.

Applied migrations are checksummed and schema changes ship as new ordered steps. Keep the database
file when upgrading normally; incompatible or dirty history fails startup instead of silently
rewriting an unknown schema. Before 1.0, an explicitly breaking migration may still require deleting
the database file and starting over.

## Transactions

```ts
await storage.transaction(async (tx) => {
  // Use `tx`, never the root storage — the root throws inside a transaction callback.
})
```

Nested transactions are rejected. The `isolation` option is accepted and **ignored**: every write
transaction runs through one connection, serialized by an internal lock and a `BEGIN IMMEDIATE`, so
there is no concurrent writer to isolate against. `isolation: "serializable"` only becomes meaningful
on a provider with true concurrent connections, such as [`@sixb/pg`](../pg).

File-backed storage uses WAL mode and serves object and timeseries queries from a separate read-only
snapshot connection. Long materializations therefore do not block those reads behind the writer.
In-memory storage keeps one connection because SQLite in-memory databases are connection-local.

Reach for `@sixb/pg` before scaling out: SQLite still has one writer and is intended for one local
Sixb process, not shared replicas.

Call `close()` on shutdown.
