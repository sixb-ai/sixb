import { expect, test } from "bun:test"
import { legacySourceFixture } from "../../tests/legacy-source-fixture"
import { postgresStorageMigrations, quoteIdent } from "../src/migrations"
import { createPgClient } from "../src/pg-client"

// Red proof: remove the INSERT ... SELECT backfill from migration 039.
test("source-root upgrade preserves active, terminal and unfinished snapshots", async () => {
  const schema = `roots_upgrade_${crypto.randomUUID().replaceAll("-", "")}`
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
    const migrationIndex = steps.findIndex((step) => step.id === "039-projection-source-roots")
    expect(migrationIndex).toBeGreaterThan(-1)
    for (const step of steps.slice(0, migrationIndex)) await step.up(context)
    await sql.unsafe(legacySourceFixture())
    await steps[migrationIndex]!.up(context)
    const rows = await sql`SELECT materialization_id,active,retired_at IS NOT NULL AS retired
      FROM ontology_source_roots ORDER BY materialization_id`
    expect([...rows]).toEqual([
      { materialization_id: "abandoned", active: false, retired: true },
      { materialization_id: "active", active: true, retired: false },
      { materialization_id: "ready", active: false, retired: false },
      { materialization_id: "staging", active: false, retired: false },
      { materialization_id: "superseded", active: false, retired: true },
    ])
    const [active] = await sql`SELECT count(*)::int AS count FROM ontology_source_rows AS rows
      JOIN ontology_source_roots AS roots USING (project_id,source_id,materialization_id,root_sort_key)
      WHERE roots.active`
    expect(active?.count).toBe(2)
    await expect(
      Promise.resolve(
        sql`UPDATE ontology_source_roots SET active=TRUE,retired_at=NULL WHERE materialization_id='superseded'`
      )
    ).rejects.toThrow("duplicate key")
    await expect(
      Promise.resolve(sql`UPDATE ontology_sources SET base_commit_id='partial'`)
    ).rejects.toThrow("check constraint")
  } finally {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`)
    await sql.end()
  }
})
