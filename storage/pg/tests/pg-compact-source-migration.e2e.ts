import { expect, test } from "bun:test"
import { legacySourceFixture } from "../../tests/legacy-source-fixture"
import { postgresStorageMigrations, quoteIdent } from "../src/migrations"
import { PgMaterializationStateReader } from "../src/ontology-storage/materialization-state"
import { createPgClient } from "../src/pg-client"

// Red proofs: drop the CASE fallback to `versions.updated_at` in migration 052 and the superseded
// root becomes live again; drop the payload rewrite and the stored assertion keeps its ref copy.
test("compacting source storage keeps every root, row and live root", async () => {
  const schema = `compact_sources_${crypto.randomUUID().replaceAll("-", "")}`
  const sql = createPgClient({
    connectionString: process.env.DATABASE_URL!,
    schemaName: schema,
    max: 1,
  })
  try {
    await sql.unsafe(`CREATE SCHEMA ${quoteIdent(schema)}`)
    const context = {
      exec: async (text: string) => {
        await sql.unsafe(text)
      },
    }
    const steps = postgresStorageMigrations.steps
    const roots = steps.findIndex((step) => step.id === "039-projection-source-roots")
    const compact = steps.findIndex((step) => step.id === "052-compact-source-storage")
    expect(roots).toBeGreaterThan(-1)
    expect(compact).toBeGreaterThan(roots)
    for (const step of steps.slice(0, roots)) await step.up(context)
    await sql.unsafe(legacySourceFixture())
    for (const step of steps.slice(roots, compact)) await step.up(context)
    // A published root neither active nor retired must not come back to life.
    await sql`UPDATE ontology_source_roots SET retired_at = NULL
      WHERE materialization_id = 'superseded'`
    await steps[compact]!.up(context)

    const migrated = await sql`
      SELECT versions.materialization_id, roots.root_key, roots.retired_at IS NOT NULL AS retired,
        roots.retired_at IS NULL AND NOT roots.deleted
          AND versions.status IN ('active', 'superseded') AS live
      FROM ontology_source_roots AS roots
      JOIN ontology_sources AS versions USING (version_id)
      ORDER BY versions.materialization_id`
    const key = '["object","Device","a"]'
    expect([...migrated]).toEqual([
      { materialization_id: "abandoned", root_key: key, retired: true, live: false },
      { materialization_id: "active", root_key: key, retired: false, live: true },
      { materialization_id: "ready", root_key: key, retired: false, live: false },
      { materialization_id: "staging", root_key: key, retired: false, live: false },
      { materialization_id: "superseded", root_key: key, retired: true, live: false },
    ])
    const [rows] = await sql`SELECT count(*)::int AS count FROM ontology_source_rows`
    expect(rows?.count).toBe(10)

    const [state] = await new PgMaterializationStateReader(sql, "p").objectStates([
      { objectTypeId: "Device", primaryId: "a" },
    ])
    expect(state?.source).toEqual({
      source: { projectionId: "source" },
      materializationId: "active",
      root: { kind: "object", ref: { objectTypeId: "Device", primaryId: "a" } },
      assertion: {
        kind: "object",
        ref: { objectTypeId: "Device", primaryId: "a" },
        properties: { id: "a", name: "active" },
      },
      stagingOrdinal: 0,
    })
    const payloads = await sql`SELECT DISTINCT payload FROM ontology_source_rows
      WHERE entity_kind = 'link'`
    expect([...payloads]).toEqual([{ payload: null }])
    await expect(
      Promise.resolve(sql`INSERT INTO ontology_source_roots (version_id, project_id, root_key,
        staging_ordinal) SELECT version_id, 'p', ${key}, 1 FROM ontology_sources
        WHERE materialization_id = 'active'`)
    ).rejects.toThrow("duplicate key")
  } finally {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`)
    await sql.end()
  }
})
