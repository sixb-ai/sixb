import { PostgresStorage } from "../src/index"
import { createPgClient } from "../src/pg-client"

const schemaName = process.env.QUERY_BENCH_SCHEMA ?? "bench"
if (!/^bench(?:_[0-9]+)?$/.test(schemaName)) throw new Error("Expected a dedicated bench schema")
const connectionString =
  process.env.QUERY_BENCH_URL ??
  "postgresql://postgres:local-benchmark-only@127.0.0.1:55506/sixb_query_bench"
const url = new URL(connectionString)
if (
  !["127.0.0.1", "localhost", "host.docker.internal"].includes(url.hostname) ||
  url.port !== "55506" ||
  url.pathname !== "/sixb_query_bench"
)
  throw new Error("Refusing a non-benchmark database")
const pg = new PostgresStorage({ connectionString, schemaName })
const sql = createPgClient({ connectionString, schemaName, max: 1 })
await sql.unsafe("CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public")
const scope = { projectId: "query-benchmark", objectTypeId: "User" }
for (const fields of [
  [{ propertyId: "createdAt", direction: "desc" as const }],
  [{ propertyId: "lastName" }, { propertyId: "firstName" }],
]) {
  for (const equality of [[], ["status"]]) {
    console.time(JSON.stringify({ fields, equality }))
    console.log(await pg.ensureObjectQueryIndexes([{ ...scope, kind: "sort", fields, equality }]))
    console.timeEnd(JSON.stringify({ fields, equality }))
  }
}
for (const status of ["1", "2", "3"])
  console.log(await pg.ensureObjectQueryIndexes([{ ...scope, kind: "count", where: { status } }]))
console.time("text")
console.log(
  await pg.ensureObjectQueryIndexes([{ ...scope, kind: "text", propertyId: "searchText" }])
)
console.timeEnd("text")

for (const objectTypeId of ["City", "User"])
  console.log(
    await pg.ensureObjectQueryIndexes([
      { projectId: "query-benchmark", objectTypeId, kind: "incomingLinks" },
    ])
  )
await sql.unsafe("VACUUM (ANALYZE) objects")
await sql.unsafe("VACUUM (ANALYZE) links")
console.log(await sql`SELECT pg_size_pretty(pg_total_relation_size('objects')) AS objects`)
await sql.end()
await pg.close()
