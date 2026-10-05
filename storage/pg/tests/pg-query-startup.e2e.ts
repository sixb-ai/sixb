import { expect, test } from "bun:test"
import {
  defineObjectType,
  migrateStorage,
  OntologyRegistry,
  prepareObjectQueries,
  prop,
} from "@sixb/core"
import { PostgresStorage } from "../src"
import { createPgClient } from "../src/pg-client"
import { createTestStorage } from "./helpers"

const Item = defineObjectType({
  id: "Item",
  name: "Item",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { query: { searchable: true, sortable: true, text: true } }),
    prop("status", "string", { query: { searchable: true, filterable: true, facet: true } }),
  ],
  query: { indexes: [{ kind: "text", propertyId: "name", filters: ["status"] }] },
})
const ontology = new OntologyRegistry({ sources: [Item] })

// Guard removal: omit the completion recheck under the session lock in prepare-queries.ts.
// Both simultaneous starts report "prepared" instead of only the first one. Replacing
// lockPgPreparation with a blocking pg_advisory_lock also reproduces a snapshot deadlock.
test("simultaneous migrations prepare once, even with one connection per instance", async () => {
  const created = await createTestStorage({ migrate: false })
  const options = {
    connectionString: process.env.DATABASE_URL,
    schemaName: created.schemaName,
    max: 1,
  }
  const peers = [new PostgresStorage(options), new PostgresStorage(options)]
  try {
    const results = await Promise.all(
      peers.map((storage) => migrateStorage(storage, { projectId: "p", ontology }))
    )
    expect(results.map((result) => result.queries?.status).sort()).toEqual(["current", "prepared"])
    expect(results[0]!.queries!.indexes).toBeGreaterThan(0)
    const sql = createPgClient(options)
    try {
      const [state] = await sql`SELECT count(*) AS count FROM object_query_preparation`
      expect(Number(state!.count)).toBe(1)
      // Guard removal: allow singleton=false in migration 055; a second state becomes possible.
      await expect(
        Promise.resolve(sql`INSERT INTO object_query_preparation (singleton,fingerprint,result)
        VALUES (false,'second','{}'::jsonb)`)
      ).rejects.toThrow()
      const columns = await sql`SELECT column_name FROM information_schema.columns
        WHERE table_schema=${created.schemaName} AND table_name='object_query_preparation'`
      expect(columns.map((column) => column.column_name)).not.toContain("project_id")
    } finally {
      await sql.end()
    }
  } finally {
    await Promise.all(peers.map((storage) => storage.close()))
    await created.storage.dropSchema()
    await created.storage.close()
  }
}, 30_000)

// Guard removal: bypass both completion returns; repeated startup will touch the locked
// objects table and hit statement_timeout. Merely recreating existing indexes is not a no-op.
test("unchanged preparation is read-only and never waits for an object table lock", async () => {
  const { storage, schemaName } = await createTestStorage()
  const sql = createPgClient({ connectionString: process.env.DATABASE_URL, schemaName, max: 1 })
  const reader = new PostgresStorage({
    connectionString: process.env.DATABASE_URL,
    schemaName,
    max: 1,
    statementTimeoutMillis: 500,
  })
  try {
    await prepareObjectQueries({ projectId: "p", ontology, storage })
    const [before] =
      await sql`SELECT fingerprint,prepared_at FROM object_query_preparation WHERE singleton`
    // Property declaration order does not change physical requirements.
    const reordered = new OntologyRegistry({
      sources: [defineObjectType({ ...Item, properties: [...Item.properties].reverse() })],
    })
    await sql.begin(async (tx) => {
      await tx`LOCK TABLE objects IN ACCESS EXCLUSIVE MODE`
      const result = await prepareObjectQueries({
        projectId: "p",
        ontology: reordered,
        storage: reader,
      })
      expect(result.status).toBe("current")
    })
    const [after] =
      await sql`SELECT fingerprint,prepared_at FROM object_query_preparation WHERE singleton`
    expect(after).toEqual(before)
  } finally {
    await reader.close()
    await sql.end()
    await storage.dropSchema()
    await storage.close()
  }
}, 30_000)

// Guard removal: drop indexes absent from a new preparation plan; an older release would
// remove the newer release's ordered access path.
test("ontology changes prepare automatically and older releases retain newer indexes", async () => {
  const { storage, schemaName } = await createTestStorage()
  const sql = createPgClient({ connectionString: process.env.DATABASE_URL, schemaName, max: 1 })
  const newer = new OntologyRegistry({
    sources: [
      defineObjectType({
        ...Item,
        properties: [
          ...Item.properties,
          prop("category", "string", { query: { searchable: true, facet: true } }),
        ],
        query: {
          indexes: [
            ...Item.query!.indexes!,
            {
              kind: "sort",
              fields: [{ propertyId: "name", direction: "desc" }],
              filters: ["status"],
            },
          ],
        },
      }),
    ],
  })
  try {
    await migrateStorage(storage, { projectId: "p", ontology })
    const changed = await migrateStorage(storage, { projectId: "p", ontology: newer })
    expect(changed.queries?.status).toBe("prepared")
    const [before] =
      await sql`SELECT count(*) AS count FROM pg_indexes WHERE schemaname=${schemaName}`
    await migrateStorage(storage, { projectId: "p", ontology })
    const [after] =
      await sql`SELECT count(*) AS count FROM pg_indexes WHERE schemaname=${schemaName}`
    expect(after).toEqual(before)
    const [state] = await sql`SELECT count(*) AS count FROM object_query_preparation`
    expect(Number(state!.count)).toBe(1)
  } finally {
    await sql.end()
    await storage.dropSchema()
    await storage.close()
  }
}, 30_000)

// Guard removal: persist completion before physical preparation. The retry would incorrectly
// report current after the blocked CREATE INDEX fails.
test("failed preparation does not record success and can resume on a later startup", async () => {
  const { storage, schemaName } = await createTestStorage()
  const sql = createPgClient({ connectionString: process.env.DATABASE_URL, schemaName, max: 1 })
  const impatient = new PostgresStorage({
    connectionString: process.env.DATABASE_URL,
    schemaName,
    max: 1,
    statementTimeoutMillis: 250,
  })
  try {
    await sql.begin(async (tx) => {
      await tx`LOCK TABLE links IN ACCESS EXCLUSIVE MODE`
      await expect(
        prepareObjectQueries({ projectId: "p", ontology, storage: impatient })
      ).rejects.toThrow()
    })
    const [state] =
      await sql`SELECT count(*) AS count FROM object_query_preparation WHERE singleton`
    expect(Number(state!.count)).toBe(0)
    expect((await prepareObjectQueries({ projectId: "p", ontology, storage })).status).toBe(
      "prepared"
    )
  } finally {
    await impatient.close()
    await sql.end()
    await storage.dropSchema()
    await storage.close()
  }
}, 30_000)
