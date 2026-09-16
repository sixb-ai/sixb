# @sixb/sqlite

SQLite storage provider for Sixb, built on `bun:sqlite`.

Backs every Sixb store — objects, ontology commits, auth, agents, the immutable execution and AI
usage ledgers, timeseries, and the run history for actions, syncs, pipelines, projections,
workflows, webhooks, and managed connector connections — from a single local database file. This
is the storage `bun create sixb` scaffolds, and part of what makes a fresh project run with no
service to install.

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

## Vector profiles

Named `search.vectors` profiles persist outside object properties as float32 blobs with their
provenance. Writes and invalidation share the object's materialization transaction; stale model
results fail explicitly instead of overwriting newer vectors. No extension is needed to persist.

Search uses the bundled `sqlite-vec` 0.1.9 extension, loaded on the query connection when needed.
On macOS, install an extension-capable SQLite (`brew install sqlite`) and select its library
**before opening any database**:

```ts
import { Database } from "bun:sqlite"

Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib")
```

Use the actual library path on your machine; the selection applies to the process. Linux and
Windows do not need this macOS setup. Unsupported native platforms fail with a diagnostic.

```ts
const result = await sixb.objects(Product).query()
  .vector("content", queryVector, { k: 10 }).list()
```

Exact cosine search uses normalized vectors and applies filters and source permissions before
ranking. It rejects more than 10,000 eligible vectors or 16 million coordinates per search.
SQLite reads remain synchronous: these bounds limit scoring work, not wall-clock time;
`busy_timeout` only bounds lock waits. Existing numeric arrays are not promoted to profiles.

Run vector integration tests with `bun run test:e2e`. On macOS, set `SIXB_TEST_SQLITE_LIBRARY`
to the SQLite library path; tests use a separate process for library selection.

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
