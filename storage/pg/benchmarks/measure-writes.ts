import { migrateStorage } from "@sixb/core"
import { type PgObjectQueryIndex, PostgresStorage } from "../src"
import { createPgClient } from "../src/pg-client"

const connectionString =
  process.env.QUERY_BENCH_URL ??
  "postgresql://postgres:local-benchmark-only@127.0.0.1:55506/sixb_query_bench"
const url = new URL(connectionString)
if (
  !["127.0.0.1", "localhost", "host.docker.internal"].includes(url.hostname) ||
  url.port !== "55506" ||
  url.pathname !== "/sixb_query_bench"
)
  throw new Error("Expected the dedicated local benchmark database")
const scope = { projectId: "query-benchmark", objectTypeId: "User" }
const indexes: PgObjectQueryIndex[] = []
for (const fields of [
  [{ propertyId: "createdAt", direction: "desc" as const }],
  [{ propertyId: "lastName" }, { propertyId: "firstName" }],
])
  for (const equality of [[], ["status"]])
    indexes.push({ ...scope, kind: "sort", fields, equality })
for (const status of ["1", "2", "3"]) indexes.push({ ...scope, kind: "count", where: { status } })
indexes.push(
  { ...scope, kind: "text", propertyId: "searchText" },
  { ...scope, kind: "filter", properties: ["id"] },
  { ...scope, kind: "sort", fields: [{ propertyId: "firstSubscribedAt" }] }
)
const results = []
for (const mode of ["plain", "indexed", "text_counts"] as const) {
  const schemaName = `bench_write_${mode}`
  const storage = new PostgresStorage({ connectionString, schemaName, max: 1 })
  await migrateStorage(storage)
  const sql = createPgClient({ connectionString, schemaName, max: 1 })
  // This script owns only these three fixed scratch schemas. Recreate rows for comparable passes.
  await sql.unsafe("DELETE FROM objects")
  await sql.unsafe(
    `INSERT INTO objects (project_id,object_type_id,primary_id,properties,created_at,updated_at,version,last_commit_id) SELECT project_id,object_type_id,primary_id,properties,created_at,updated_at,version,last_commit_id FROM bench_300000.objects WHERE object_type_id='User' ORDER BY primary_id LIMIT 50000`
  )
  if (mode !== "plain") await storage.ensureObjectQueryIndexes(indexes)
  if (mode === "text_counts")
    await storage.prepareObjectTextCounts([
      { ...scope, propertyId: "searchText", filters: ["status"] },
    ])
  await sql.unsafe("VACUUM (ANALYZE) objects")
  const times: { insert: number[]; update: number[] } = { insert: [], update: [] }
  for (let pass = 0; pass < 5; pass++) {
    let started = performance.now()
    await sql`INSERT INTO objects (project_id,object_type_id,primary_id,properties,created_at,updated_at,version,last_commit_id) SELECT project_id,object_type_id,primary_id||${`-batch-${pass}`},properties,created_at,updated_at,version,last_commit_id FROM bench_300000.objects WHERE object_type_id='User' ORDER BY primary_id LIMIT 1000`
    times.insert.push(performance.now() - started)
    started = performance.now()
    await sql`UPDATE objects SET properties=jsonb_set(jsonb_set(properties,'{status}',to_jsonb(${String((pass % 3) + 1)}::text)),'{searchText}',to_jsonb((properties->>'searchText')||${` pass${pass}`}::text)),version=version+1 WHERE project_id='query-benchmark' AND object_type_id='User' AND primary_id=ANY(SELECT primary_id FROM objects WHERE project_id='query-benchmark' AND object_type_id='User' ORDER BY primary_id LIMIT 1000)`
    times.update.push(performance.now() - started)
  }
  const [size] = await sql`SELECT pg_total_relation_size('objects') AS bytes`
  const result = { mode, rows: 55000, batch: 1000, times, bytes: size?.bytes }
  results.push(result)
  console.log(JSON.stringify(result))
  await sql.end()
  await storage.dropSchema()
  await storage.close()
}
await Bun.write(".local/query-bench/write-cost.json", JSON.stringify(results, null, 2))
