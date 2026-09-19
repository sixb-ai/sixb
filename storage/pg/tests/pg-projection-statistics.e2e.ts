import { expect, test } from "bun:test"
import { defineObjectType, link, OntologyRegistry, prop } from "@sixb/core"
import { createMaterializerTestFixture, startTestProjectionRun } from "@sixb/core/testing"
import { PgMaterializationStateReader } from "../src/ontology-storage/materialization-state"
import { replacementAssertionRows } from "../src/ontology-storage/source-roots"
import { createPgClient, type SQLClient } from "../src/pg-client"
import { createTestStorage } from "./helpers"

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
  const { storage, schemaName } = await createTestStorage()
  const sql = createPgClient({ connectionString: process.env.DATABASE_URL!, schemaName, max: 1 })
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
    await storage.dropSchema()
    await storage.close()
  }
}, 60_000)

// Red proof: remove the effective-table ANALYZE in finalize. The cold lookup scans all links.
test("a published bulk load leaves selective statistics for the next sparse projection", async () => {
  const { storage, schemaName } = await createTestStorage()
  const sql = createPgClient({ connectionString: process.env.DATABASE_URL!, schemaName, max: 1 })
  try {
    await sql.unsafe("ALTER TABLE links SET (autovacuum_enabled=false); ANALYZE links")
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
  } finally {
    await sql.end()
    await storage.dropSchema()
    await storage.close()
  }
}, 60_000)
