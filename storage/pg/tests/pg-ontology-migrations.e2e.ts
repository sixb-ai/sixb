import { expect, test } from "bun:test"
import { runOntologyMigrationContractSuite } from "@sixb/core/testing"
import { createPgClient } from "../src/pg-client"
import { createTestStorage, disposeTestStorage, type TestStorage } from "./helpers"

runOntologyMigrationContractSuite("PostgreSQL storage", {
  createStorage: async () => (await createTestStorage()).storage,
  cleanup: (storage) => disposeTestStorage(storage),
})

const PROJECT = "unique-walk"
const RUN = "migration_walk"

/**
 * Removes `Job.gate`, whose unique values sit in a table another type's values fill, and returns
 * how the derived lane walked them, batch by batch: `pages` or `values`.
 */
async function removeUniqueValues(
  created: TestStorage,
  values: { readonly gate: number; readonly padding: number; readonly batchRows: number },
  /** Run between the first batch and the next. */
  between?: (sql: ReturnType<typeof createPgClient>) => Promise<void>
): Promise<{ readonly walks: readonly string[]; readonly left: Record<string, number> }> {
  const { storage, connectionString, schemaName } = created
  const sql = createPgClient({ connectionString, schemaName, max: 1 })
  const operation = { type: "ontology.migrate", runId: RUN } as const

  try {
    await sql`
      INSERT INTO object_unique_values (project_id, object_type_id, property_id, value_hash,
        value_key, primary_id)
      SELECT ${PROJECT}, owner.type, owner.property, sha256(convert_to(owner.key, 'UTF8')),
        owner.key, owner.key
      FROM (
        SELECT 'Pad' AS type, 'code' AS property, 'P' || i AS key
        FROM generate_series(1, ${values.padding}) AS i
        UNION ALL
        SELECT 'Job', 'gate', 'G' || i FROM generate_series(1, ${values.gate}) AS i
      ) AS owner
    `
    await sql`
      INSERT INTO object_unique_properties (project_id, object_type_id, property_id, key_kind,
        key_version, prepared_at)
      VALUES (${PROJECT}, 'Job', 'gate', 'string', 1, '2026-04-01T00:00:00.000Z')
    `
    await sql`ANALYZE object_unique_values`
    await storage.executions.create({
      id: `kernel:${RUN}`,
      projectId: PROJECT,
      executor: { type: "kernel", operation },
      requesterGroupIds: [],
      source: { type: "http", requestId: RUN },
      correlationId: RUN,
      authorizationRef: { type: "kernel", operation },
    })

    const shape = { properties: {}, links: {} }
    const run = await storage.transaction((tx) =>
      tx.ontology.migrations!.startRun({
        projectId: PROJECT,
        id: RUN,
        executionId: `kernel:${RUN}`,
        startedAt: "2026-04-01T00:00:00.000Z",
        plan: {
          ontologyRevision: "walk",
          migrations: [{ id: "job-gate", hash: "walk" }],
          types: [
            {
              objectTypeId: "Job",
              fromShape: shape,
              toShape: shape,
              steps: [{ kind: "removeProperty", propertyId: "gate", migrationId: "job-gate" }],
            },
          ],
        },
        parts: 1,
      })
    )

    // The derived lane alone: the other lanes have nothing to rewrite.
    let lane = run.lanes.find((candidate) => candidate.lane.kind === "derived")!
    const walks: string[] = []
    while (lane.cursor !== null) {
      if (
        lane.cursor.kind === "derived" &&
        lane.cursor.store === "uniqueValues" &&
        lane.cursor.after
      ) {
        walks.push(lane.cursor.after[0]!)
      }
      lane = await storage.ontology.migrations!.applyBatch({
        projectId: PROJECT,
        runId: RUN,
        ordinal: lane.ordinal,
        batches: lane.batches,
        commit: { id: `${RUN}_${lane.batches}` } as never,
        batchRows: values.batchRows,
      })
      if (lane.batches === 1) await between?.(sql)
    }

    const rows = await sql<{ readonly property: string; readonly values: string }[]>`
      SELECT object_type_id || '.' || property_id AS property, count(*) AS values
      FROM object_unique_values WHERE project_id = ${PROJECT}
      GROUP BY 1
    `
    const left = Object.fromEntries(rows.map((row) => [row.property, Number(row.values)]))
    return { walks, left }
  } finally {
    await sql.end()
  }
}

// Removal proof: in `firstUniqueWalk`, always walk by key; the walk is then `values`.
test("PostgreSQL storage walks a large property's unique values by heap page", async () => {
  const created = await createTestStorage()
  try {
    const { walks, left } = await removeUniqueValues(created, {
      gate: 5_000,
      padding: 0,
      batchRows: 1_000,
    })

    expect(new Set(walks)).toEqual(new Set(["pages"]))
    expect(left).toEqual({})
    const prepared = await created.storage.ontology.uniqueValues.listPrepared({
      projectId: PROJECT,
    })
    expect(prepared).toEqual([])
  } finally {
    await disposeTestStorage(created.storage)
  }
}, 30_000)

// Removal proof: in `firstUniqueWalk`, always walk by page; the walk is then `pages`, through
// every page of the padding for five values.
test("PostgreSQL storage walks a small property's unique values by key in a large table", async () => {
  const created = await createTestStorage()
  try {
    const { walks, left } = await removeUniqueValues(created, {
      gate: 5,
      padding: 40_000,
      batchRows: 2,
    })

    expect(new Set(walks)).toEqual(new Set(["values"]))
    expect(left).toEqual({ "Pad.code": 40_000 })
  } finally {
    await disposeTestStorage(created.storage)
  }
}, 30_000)

// Removal proof: in `uniqueValuesByPages`, finish at the last page without `leftAfterPages`; the
// values the rewrite moved below the cursor then stay, about a fifth of them here.
test("PostgreSQL storage finishes by key what a table rewrite moved below the page walk", async () => {
  const created = await createTestStorage()
  try {
    const { walks, left } = await removeUniqueValues(
      created,
      { gate: 5_000, padding: 0, batchRows: 1_000 },
      async (sql) => {
        await sql`VACUUM FULL object_unique_values`
      }
    )

    expect(walks).toContain("pages")
    expect(walks).toContain("values")
    expect(left).toEqual({})
  } finally {
    await disposeTestStorage(created.storage)
  }
}, 30_000)
