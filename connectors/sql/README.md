# @sixb/connector-sql

SQL connector for Sixb, built on `Bun.SQL`.

Gives syncs and pipelines a connection to an external database — the usual way to pull rows out of a
system of record and into the ontology. PostgreSQL, MySQL, and SQLite all share the same runtime
shape, so a sync written against one moves to another by changing the connection.

## Install

```bash
bun add @sixb/connector-sql
```

## Usage

```ts
// connectors/warehouse.ts
import { sql } from "@sixb/connector-sql"

export const warehouse = sql(process.env.WAREHOUSE_URL)
```

`createSixb()` discovers `connectors/`, so the export is all the registration you need. A connection
string, a `URL`, or a `Bun.SQL` options object all work.

Handlers receive a `SqlClient` — a live `Bun.SQL` instance — so queries use Bun's tagged-template API:

```ts
const rows = await client`select id, name, updated_at from customers where updated_at > ${since}`
```

Sixb opens the connection when a run starts and closes it when the run ends. Interpolated values are
sent as bound parameters, never spliced into the statement text.
