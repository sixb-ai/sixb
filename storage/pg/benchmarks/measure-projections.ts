import {
  col,
  defineDataset,
  defineProjection,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  migrateStorage,
  prepareObjectQueries,
  SixbHost,
} from "@sixb/core"
import type {
  ProjectionSourceBase,
  ProjectionSourceEntry,
} from "@sixb/core/internal/materialization"
import { bindDurablePrimitiveExecution } from "@sixb/core/internal/primitive-execution"
import { getProjectionRegistry } from "@sixb/core/internal/projections"
import { claimTestProjectionRun, createTestSixb } from "@sixb/core/testing"
import { PostgresStorage } from "../src"
import { createPgClient } from "../src/pg-client"
import { benchmarkOntology, User } from "./ontology"

const connectionString =
  process.env.QUERY_BENCH_URL ??
  "postgresql://postgres:local-benchmark-only@127.0.0.1:55506/sixb_query_bench"
const url = new URL(connectionString)
if (
  !["localhost", "127.0.0.1", "host.docker.internal"].includes(url.hostname) ||
  url.port !== "55506" ||
  url.pathname !== "/sixb_query_bench"
)
  throw new Error("Expected the dedicated local benchmark database")
const users = defineDataset("users", {
  schema: [
    ...[
      "id",
      "firstName",
      "lastName",
      "email",
      "phone",
      "billingCustomerId",
      "status",
      "verificationStatus",
      "searchText",
    ].map((id) => col(id, "string")),
    col("createdAt", "timestamp"),
    col("firstSubscribedAt", "timestamp"),
    col("birthDate", "date"),
    col("newsletterSubscribed", "boolean"),
  ],
})
const projection = defineProjection("users", User).fromDataset(users).properties({
  id: "id",
  firstName: "firstName",
  lastName: "lastName",
  email: "email",
  phone: "phone",
  billingCustomerId: "billingCustomerId",
  status: "status",
  verificationStatus: "verificationStatus",
  searchText: "searchText",
  createdAt: "createdAt",
  firstSubscribedAt: "firstSubscribedAt",
  birthDate: "birthDate",
  newsletterSubscribed: "newsletterSubscribed",
})
const rows = Number(process.env.QUERY_BENCH_WRITE_ROWS ?? 10000)
const batch = Math.min(1000, rows)
const results = []
for (const mode of ["baseline", "prepared"] as const) {
  const schemaName = `bench_projection_${mode}`
  const storage = new PostgresStorage({ connectionString, schemaName, max: 2 })
  // These fixed scratch schemas belong exclusively to this synthetic write benchmark.
  await storage.dropSchema()
  await migrateStorage(storage)
  const sql = createPgClient({ connectionString, schemaName, max: 1 })
  const host = new SixbHost({
    id: "query-benchmark",
    ontology: benchmarkOntology.listObjectTypes(),
    datasets: [users],
    projections: [projection],
    storage,
    broker: new InMemoryBroker(),
    queues: new InMemoryQueues(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
  })
  try {
    if (mode === "baseline") {
      await sql.unsafe("CREATE INDEX idx_objects_properties ON objects USING gin(properties)")
    } else
      await prepareObjectQueries({
        projectId: "query-benchmark",
        ontology: host.definitions.ontology,
        storage,
      })
    if (process.env.QUERY_BENCH_PROFILE) await sql`SELECT public.pg_stat_statements_reset()`
    const samples = await sql<
      { properties: Record<string, string | boolean> }[]
    >`SELECT properties FROM bench_300000.objects WHERE object_type_id='User' ORDER BY primary_id LIMIT ${rows}`
    if (samples.length !== rows) throw new Error("Synthetic source is incomplete")
    const registry = getProjectionRegistry(host)
    const resolved = registry.resolveSource("users")
    let base: ProjectionSourceBase | undefined
    const times = []
    for (let pass = 0; pass < 4; pass++) {
      const runId = `projection-${mode}-${pass}`
      const datasetVersion = {
        datasetId: "users",
        versionId: `v${pass}`,
        createdAt: new Date(Date.UTC(2026, 9, 1, 0, pass)).toISOString(),
      }
      const claim = await claimTestProjectionRun(storage, {
        id: runId,
        projectId: "query-benchmark",
        identity: {
          projectionId: "users",
          projectionKind: "object",
          protocol: "replacement",
          datasetVersion,
          ontologyRevision: registry.ontologyRevision,
          projectionRevision: resolved.projectionRevision,
          ownershipHash: resolved.ownershipHash,
        },
        target: { objectTypeId: "User" },
      })
      const execution = await storage.executions.getById({
        projectId: "query-benchmark",
        id: claim.run.executionId,
      })
      if (!execution) throw new Error("Projection execution is missing")
      const { ontologyMutations } = bindDurablePrimitiveExecution(host, {
        execution,
        primitive: { kind: "projection", id: "users", runId },
      })
      async function* entries(): AsyncIterable<ProjectionSourceEntry> {
        for (const sample of samples.slice(0, pass === 0 ? rows : batch)) {
          const properties: Record<string, string | boolean> = {
            ...sample.properties,
            ...(pass === 0
              ? {}
              : {
                  status: String(pass),
                  searchText: `${sample.properties.searchText} update${pass}`,
                }),
          }
          const ref = { objectTypeId: "User", primaryId: String(properties.id) }
          yield { root: { kind: "object", ref }, assertions: [{ kind: "object", ref, properties }] }
        }
      }
      const started = performance.now()
      const result = await ontologyMutations.replaceProjection({
        source: { projectionId: "users" },
        datasetVersion,
        execution: claim.execution,
        entries: entries(),
        ...(base ? { base } : {}),
      })
      await ontologyMutations.finishProjection({
        source: { projectionId: "users" },
        datasetVersion,
        execution: claim.execution,
        protocol: "replacement",
        status: "succeeded",
      })
      const elapsed = performance.now() - started
      const active = await ontologyMutations.getProjectionSource!({ projectionId: "users" })
      if (!active?.materializationId || !active.lastCommitId)
        throw new Error("Projection source is not active")
      base = { materializationId: active.materializationId, lastCommitId: active.lastCommitId }
      const sixb = createTestSixb(host)
      const facet = await sixb
        .objects(User)
        .query()
        .facets([{ property: User.p.status, limit: 10 }])
      if (facet.total !== rows) throw new Error("Projection and aggregate counts diverged")
      const raw = await sql<
        { value: string; count: string }[]
      >`SELECT properties->>'status' AS value,count(*) AS count FROM objects WHERE object_type_id='User' GROUP BY 1 ORDER BY 1`
      const actual = [...facet.facets[0]!.buckets].sort((a, b) =>
        String(a.value).localeCompare(String(b.value))
      )
      if (
        JSON.stringify(actual.map(({ value, count }) => ({ value, count }))) !==
        JSON.stringify(raw.map((row) => ({ value: row.value, count: Number(row.count) })))
      )
        throw new Error("Facet distribution is stale after projection")
      const point = { pass, changedRows: pass === 0 ? rows : batch, elapsed, result }
      times.push(point)
      console.log(JSON.stringify({ mode, ...point }))
    }
    const [size] =
      await sql`SELECT pg_database_size(current_database()) AS database_bytes,pg_total_relation_size('objects') AS object_bytes`
    const statements = process.env.QUERY_BENCH_PROFILE
      ? await sql`SELECT calls,total_exec_time,rows,left(query,1000) AS query FROM public.pg_stat_statements ORDER BY total_exec_time DESC LIMIT 12`
      : []
    await Bun.write(
      `.local/query-bench/projection-statements-${mode}.json`,
      JSON.stringify(statements, null, 2)
    )
    results.push({ mode, rows, batch, times, size })
  } finally {
    await host.closeBroker()
    await host.closeBlobs()
    await host.closeLogger()
    await sql.end()
    await storage.dropSchema()
    await storage.close()
  }
}
await Bun.write(".local/query-bench/projection-cost-v2.json", JSON.stringify(results, null, 2))
