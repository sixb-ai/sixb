import { expect, test } from "bun:test"
import {
  col,
  defineDataset,
  defineObjectType,
  defineProjection,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  link,
  OntologyRegistry,
  prop,
  SixbHost,
} from "@sixb/core"
import { objectRefKey } from "@sixb/core/internal/materialization"
import { bindDurablePrimitiveExecution } from "@sixb/core/internal/primitive-execution"
import { createProjectionRunId, getProjectionRegistry } from "@sixb/core/internal/projections"
import { createMaterializerTestFixture, startTestProjectionRun } from "@sixb/core/testing"
import type { PostgresStorage } from "../src"
import { PgMaterializationStateReader } from "../src/ontology-storage/materialization-state"
import { replacementAssertionRows } from "../src/ontology-storage/source-roots"
import { createPgClient, type SQLClient } from "../src/pg-client"
import { createTestStorage, disposeTestStorage } from "./helpers"

interface PlanNode {
  readonly "Relation Name"?: string
  readonly "Actual Rows"?: number
  readonly "Actual Loops"?: number
  readonly "Rows Removed by Filter"?: number
  readonly Plans?: readonly PlanNode[]
}
function visits(node: PlanNode, relation: string): number {
  return (
    (node["Relation Name"] === relation
      ? ((node["Actual Rows"] ?? 0) + (node["Rows Removed by Filter"] ?? 0)) *
        (node["Actual Loops"] ?? 0)
      : 0) + (node.Plans ?? []).reduce((count, child) => count + visits(child, relation), 0)
  )
}
async function visitedRows(
  sql: SQLClient,
  query: ReturnType<SQLClient["unsafe"]>,
  relation: string
) {
  const rows = await sql`EXPLAIN (ANALYZE, FORMAT JSON, TIMING OFF) ${query}`
  const plan = rows[0]?.["QUERY PLAN"] as readonly { readonly Plan: PlanNode }[]
  return visits(plan[0]!.Plan, relation)
}

// Red proof: remove ANALYZE in sources.markReady. The cold plan rereads the run for each identity.
test("a freshly sealed source uses bounded identity reads before autovacuum runs", async () => {
  const { storage, schemaName, connectionString } = await createTestStorage()
  const sql = createPgClient({ connectionString, schemaName, max: 1 })
  try {
    await sql.unsafe(
      "ALTER TABLE ontology_source_rows SET (autovacuum_enabled=false); ANALYZE ontology_source_rows"
    )
    const identity = {
      projectionId: "source",
      projectionKind: "object" as const,
      protocol: "replacement" as const,
      datasetVersion: {
        datasetId: "dataset",
        versionId: "v1",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      projectionRevision: "projection",
      ontologyRevision: "ontology",
      ownershipHash: "ownership",
    }
    const run = await startTestProjectionRun(storage, {
      projectId: "p",
      id: "run",
      identity,
      target: { objectTypeId: "Device" },
    })
    const input = {
      projectId: "p",
      source: { projectionId: "source" },
      materializationId: "candidate",
      execution: run.execution,
    }
    await storage.ontology.sources.beginMaterialization({
      ...input,
      ...identity,
      createdAt: identity.datasetVersion.createdAt,
    })
    const refs = Array.from({ length: 5_000 }, (_, i) => ({
      kind: "object" as const,
      ref: { objectTypeId: "Device", primaryId: String(i) },
    }))
    await storage.ontology.sources.stageRows({
      ...input,
      rows: refs.map((root, stagingOrdinal) => ({
        root,
        stagingOrdinal,
        assertion: { ...root, properties: { id: root.ref.primaryId } },
      })),
    })
    await storage.ontology.sources.markReady({
      ...input,
      rootCount: refs.length,
      assertionCount: refs.length,
      readyAt: identity.datasetVersion.createdAt,
    })
    const query = replacementAssertionRows(sql, {
      projectId: "p",
      sourceId: "source",
      materializationId: "candidate",
      incremental: false,
      includePrevious: false,
      refs: refs.slice(0, 100),
    })
    expect(await visitedRows(sql, query, "ontology_source_rows")).toBeLessThan(1_000)
    expect(await query).toHaveLength(100)
  } finally {
    await sql.end()
    await disposeTestStorage(storage)
  }
}, 60_000)

// Red proof: remove the effective-table ANALYZE in finalize. The cold lookup scans all links.
test("a published bulk load leaves selective statistics for the next sparse projection", async () => {
  const { storage, schemaName, connectionString } = await createTestStorage()
  const sql = createPgClient({ connectionString, schemaName, max: 1 })
  try {
    await sql.unsafe(
      "ALTER TABLE links SET (autovacuum_enabled=false); ALTER TABLE objects_default SET (autovacuum_enabled=false); ANALYZE links"
    )
    const Device = defineObjectType({
      id: "Device",
      name: "Device",
      properties: [prop("id", "string", { primary: true, required: true })],
      links: [link.self("parent", { cardinality: "one" })],
    })
    const fixture = createMaterializerTestFixture({
      projectId: "p",
      ontology: new OntologyRegistry({ sources: [Device] }),
      storage,
    })
    const refs = Array.from({ length: 20_000 }, (_, i) => ({
      objectTypeId: "Device",
      primaryId: String(i),
    }))
    const links = refs.slice(1).map((source) => ({ source, linkId: "parent", target: refs[0]! }))
    await fixture.seed({
      objects: refs.map((ref) => ({ ref, properties: { id: ref.primaryId } })),
      links: links.map((ref) => ({ ref })),
    })
    const seen: number[] = []
    const observed = new Proxy(sql, {
      apply(target, thisArg, args: unknown[]) {
        const query = Reflect.apply(target, thisArg, args) as ReturnType<SQLClient["unsafe"]>
        if (
          !Array.isArray(args[0]) ||
          !args[0].some(
            (part) => typeof part === "string" && part.includes("SELECT links.* FROM links")
          )
        )
          return query
        return (async () => {
          seen.push(await visitedRows(sql, query, "links"))
          return query
        })()
      },
    })
    const states = await new PgMaterializationStateReader(observed, "p").linkStates(
      links.slice(0, 100)
    )
    expect(states.every((state) => state.effective !== null)).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBeLessThan(500)
    // Guard removal: restore unconditional ANALYZE for every >=1000-object publication.
    // The added small batch then changes reltuples, proving it repeated full statistics work.
    const [before] = await sql`SELECT reltuples FROM pg_class WHERE oid='objects'::regclass`
    await fixture.seed({
      objects: Array.from({ length: 1000 }, (_, i) => ({
        ref: { objectTypeId: "Device", primaryId: `additional-${i}` },
        properties: { id: `additional-${i}` },
      })),
    })
    const [after] = await sql`SELECT reltuples FROM pg_class WHERE oid='objects'::regclass`
    expect(Number(before!.reltuples)).toBeGreaterThan(0)
    expect(after!.reltuples).toBe(before!.reltuples)
  } finally {
    await sql.end()
    await disposeTestStorage(storage)
  }
}, 60_000)

// Red proof: count the identities a stream planned instead of the work it staged, or restore
// ANALYZE_ROWS = 10_000. The plan tables keep the statistics of the first plan, which expect none
// of the second plan's rows, and each key lookup reads all of its work.
test("a streamed plan seeks its staged work by key before its links are planned", async () => {
  const { storage, schemaName, connectionString } = await createTestStorage()
  const sql = createPgClient({ connectionString, schemaName, max: 1 })
  try {
    await sql.unsafe(
      "ALTER TABLE ontology_replacement_plan_identities SET (autovacuum_enabled=false); " +
        "ALTER TABLE ontology_replacement_plan_work SET (autovacuum_enabled=false)"
    )
    const publish = await devicePublisher(storage)

    // 600 objects: fewer identities than ANALYZE_ROWS, but four times as many rows of work.
    await publish(1, 600)
    // Autovacuum analyzes the plan tables while they hold the first plan.
    await sql`ANALYZE ontology_replacement_plan_identities, ontology_replacement_plan_work`
    await publish(2, 600)

    // The lookups of a link page: the planned existence of each endpoint, by its unique key.
    const [plan] = await sql<{ readonly version_id: string }[]>`
      SELECT MAX(version_id) AS version_id FROM ontology_replacement_plans
    `
    const keys = Array.from({ length: 100 }, (_, i) =>
      objectRefKey({ objectTypeId: "Device", primaryId: String(i) })
    )
    const lookups = sql`
      SELECT (
        SELECT payload FROM ontology_replacement_plan_work
        WHERE work_id = ${plan!.version_id} AND unique_key = 'object-existence:' || requested.key
      )
      FROM unnest(${sql.array(keys)}::text[]) AS requested(key)
    `

    expect(await visitedRows(sql, lookups, "ontology_replacement_plan_work")).toBeLessThan(1_000)
  } finally {
    await sql.end()
    await storage.dropSchema()
    await storage.close()
  }
}, 60_000)

/** Publishes `count` devices as a projection worker does once it has read its dataset. */
async function devicePublisher(storage: PostgresStorage) {
  const Device = defineObjectType({
    id: "Device",
    name: "Device",
    properties: [prop("id", "string", { primary: true, required: true }), prop("name", "string")],
  })
  const devices = defineDataset("statistics.devices", {
    primaryKey: "id",
    schema: [col("id", "string"), col("name", "string")],
  })
  const projection = defineProjection("statistics-devices", Device)
    .fromDataset(devices)
    .properties({ id: "id", name: "name" })
  const host = new SixbHost({
    id: "statistics",
    ontology: [Device],
    datasets: [devices],
    projections: [projection],
    storage,
    lakeStorage: new InMemoryLakeStorage(),
    broker: new InMemoryBroker(),
    queues: new InMemoryQueues(),
    blobStorage: new InMemoryBlobStorage(),
  })
  await host.closeBroker()

  return async (version: number, count: number) => {
    const dispatch = getProjectionRegistry(host).resolveDispatch(projection.id)
    const identity = {
      projectionId: projection.id,
      projectionKind: "object" as const,
      protocol: "replacement" as const,
      datasetVersion: {
        datasetId: dispatch.datasetId,
        versionId: `v${version}`,
        createdAt: `2026-01-0${version}T00:00:00.000Z`,
      },
      ontologyRevision: dispatch.ontologyRevision,
      projectionRevision: dispatch.projectionRevision,
      ownershipHash: dispatch.ownershipHash,
    }
    const id = createProjectionRunId(host.id, identity)
    const claim = await startTestProjectionRun(storage, {
      projectId: host.id,
      id,
      identity,
      target: { objectTypeId: Device.id },
    })
    const run = await storage.projectionRuns.getById({ projectId: host.id, id })
    const execution = await storage.executions.getById({ projectId: host.id, id: run!.executionId })
    const { ontologyMutations } = bindDurablePrimitiveExecution(host, {
      execution: execution!,
      primitive: { kind: "projection", id: projection.id, runId: id },
    })

    await ontologyMutations.replaceProjection({
      source: { projectionId: projection.id },
      datasetVersion: identity.datasetVersion,
      execution: claim.execution,
      entries: (async function* () {
        for (let i = 0; i < count; i++) {
          const ref = { objectTypeId: Device.id, primaryId: String(i) }
          yield {
            root: { kind: "object" as const, ref },
            assertions: [
              { kind: "object" as const, ref, properties: { name: `v${version}-${i}` } },
            ],
          }
        }
      })(),
    })
  }
}
