import {
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  SixbHost,
} from "@sixb/core"
import { createTestSixb } from "@sixb/core/testing"
import { PostgresStorage } from "../src"
import { benchmarkOntology, User } from "./ontology"

const connectionString =
  process.env.QUERY_BENCH_URL ??
  "postgresql://postgres:local-benchmark-only@127.0.0.1:55506/sixb_query_bench"
const url = new URL(connectionString)
const schemaName = process.env.QUERY_BENCH_SCHEMA ?? "bench"
if (
  !["127.0.0.1", "localhost", "host.docker.internal"].includes(url.hostname) ||
  url.port !== "55506" ||
  url.pathname !== "/sixb_query_bench" ||
  !/^bench(?:_[0-9]+)?$/.test(schemaName)
)
  throw new Error("Expected the dedicated local benchmark database")
const max = Number(process.env.QUERY_BENCH_POOL ?? 2)
const storage = new PostgresStorage({ connectionString, schemaName, max })
const host = new SixbHost({
  id: "query-benchmark",
  ontology: benchmarkOntology.listObjectTypes(),
  storage,
  broker: new InMemoryBroker(),
  queues: new InMemoryQueues(),
  lakeStorage: new InMemoryLakeStorage(),
  blobStorage: new InMemoryBlobStorage(),
})
const sixb = createTestSixb(host)

const { createPgClient } = await import("../src/pg-client")
const sql = createPgClient({ connectionString, schemaName, max: 2 })
const source = sixb
  .objects(User)
  .query()
  .search("martin", { fields: [User.p.searchText] })
const facets = [{ property: User.p.status, limit: 100 }]
const saved = await sql<
  { primary_id: string; properties: Record<string, unknown> }[]
>`SELECT primary_id,properties FROM objects WHERE project_id='query-benchmark' AND object_type_id='User' ORDER BY primary_id LIMIT 100`
await Bun.write(`.local/query-bench/mixed-backup-${schemaName}.json`, JSON.stringify(saved))
const before = await source.facets(facets)
const removed = saved.filter((row) =>
  String(row.properties.searchText).toLowerCase().includes("martin")
)
const expected = before.total - removed.length
const samples = []
let restoredTotal: number | undefined
try {
  for (let pass = 0; pass < 3; pass++) {
    const writeStart = performance.now()
    await Promise.all(
      [saved.slice(0, 50), saved.slice(50)].map(
        (rows) => sql`
    UPDATE objects o SET properties=o.properties||jsonb_build_object('status',${String(pass + 1)}::text,'searchText','mixed-benchmark-'||o.primary_id||${String(pass)}::text)
    WHERE project_id='query-benchmark' AND object_type_id='User' AND primary_id=ANY(${sql.array(rows.map((row) => row.primary_id))}::text[])`
      )
    )
    const writeMs = performance.now() - writeStart
    const reads = await Promise.all(
      Array.from({ length: 5 }, async () => {
        const started = performance.now()
        const [page, summary] = await Promise.all([
          source
            .orderBy(User.p.createdAt, "desc")
            .expand(User.l.currentCity)
            .page({ pageSize: 40 })
            .list({ includeTotal: false }),
          source.facets(facets),
        ])
        if (summary.total !== expected || page.objects.length !== 40)
          throw new Error("Mixed read result is incorrect")
        for (const bucket of before.facets[0]!.buckets) {
          const value =
            summary.facets[0]!.buckets.find((item) => item.value === bucket.value)?.count ?? 0
          if (
            value !==
            bucket.count - removed.filter((row) => row.properties.status === bucket.value).length
          )
            throw new Error("Mixed facet bucket is stale")
        }
        return performance.now() - started
      })
    )
    const point = { pass, writeMs, reads }
    samples.push(point)
    console.log(JSON.stringify(point))
  }
} finally {
  await sql`UPDATE objects o SET properties=v.properties FROM jsonb_to_recordset(${JSON.stringify(saved)}::text::jsonb) v(primary_id text,properties jsonb) WHERE o.project_id='query-benchmark' AND o.object_type_id='User' AND o.primary_id=v.primary_id`
  const restored = await source.facets(facets)
  restoredTotal = restored.total
  await Bun.write(
    `.local/query-bench/mixed-${schemaName}.json`,
    JSON.stringify({ before, expected, samples, restored }, null, 2)
  )
  await sql.end()
  await host.closeBroker()
  await host.closeBlobs()
  await host.closeLogger()
  await storage.close()
}

if (restoredTotal !== before.total) throw new Error("Synthetic fixture restoration failed")
