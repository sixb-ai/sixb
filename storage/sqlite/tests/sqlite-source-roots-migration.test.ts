import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { legacySourceFixture } from "../../tests/legacy-source-fixture"
import { sqliteStorageMigrations } from "../src/migrations"

// Red proof: remove the INSERT ... SELECT backfill from migration 038.
test("source-root upgrade preserves active, terminal and unfinished snapshots", async () => {
  const db = new Database(":memory:")
  try {
    db.exec("PRAGMA foreign_keys = ON")
    const steps = sqliteStorageMigrations.steps
    const migrationIndex = steps.findIndex((step) => step.id === "038-projection-source-roots")
    expect(migrationIndex).toBeGreaterThan(-1)
    for (const step of steps.slice(0, migrationIndex)) await step.up(db)
    db.exec(legacySourceFixture())
    await steps[migrationIndex]!.up(db)
    expect(
      db
        .query(`SELECT materialization_id, active, retired_at IS NOT NULL AS retired
      FROM ontology_source_roots ORDER BY materialization_id`)
        .all()
    ).toEqual([
      { materialization_id: "abandoned", active: 0, retired: 1 },
      { materialization_id: "active", active: 1, retired: 0 },
      { materialization_id: "ready", active: 0, retired: 0 },
      { materialization_id: "staging", active: 0, retired: 0 },
      { materialization_id: "superseded", active: 0, retired: 1 },
    ])
    expect(
      db
        .query(`SELECT count(*) AS count FROM ontology_source_rows AS rows
      JOIN ontology_source_roots AS roots USING (project_id,source_id,materialization_id,root_sort_key)
      WHERE roots.active = 1`)
        .get()
    ).toEqual({ count: 2 })
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([])
    expect(() =>
      db.exec(
        "UPDATE ontology_source_roots SET active=1,retired_at=NULL WHERE materialization_id='superseded'"
      )
    ).toThrow("UNIQUE")
    expect(() => db.exec("UPDATE ontology_sources SET base_commit_id='partial'")).toThrow("CHECK")
  } finally {
    db.close()
  }
})
