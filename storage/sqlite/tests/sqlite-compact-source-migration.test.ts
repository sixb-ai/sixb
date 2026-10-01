import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defineMigrations } from "@sixb/core/storage"
import { legacySourceFixture } from "../../tests/legacy-source-fixture"
import { createSqliteMigrator, sqliteStorageMigrations, sqliteStoragePath } from "../src/migrations"
import { SqliteMaterializationStateReader } from "../src/ontology-storage/materialization-state"

const directories: string[] = []

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

/** A database migrated up to `id` (excluded), in a real file through the real runner. */
async function migratedUntil(id: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sixb-sqlite-compact-sources-"))
  directories.push(directory)
  const path = sqliteStoragePath(directory)
  await migrateTo(path, id)
  return path
}

async function migrateTo(path: string, id?: string): Promise<void> {
  const version = sqliteStorageMigrations.steps.find((step) => step.id === id)?.version
  await createSqliteMigrator({
    path,
    migrations: defineMigrations({
      adapterId: sqliteStorageMigrations.adapterId,
      steps: sqliteStorageMigrations.steps.filter(
        (step) => version === undefined || step.version < version
      ),
    }),
  }).migrate()
}

function withDatabase<T>(path: string, run: (db: Database) => T): T {
  const db = new Database(path)
  try {
    return run(db)
  } finally {
    db.close()
  }
}

// Red proofs: drop the CASE fallback to `versions.updated_at` in migration 052 and the superseded
// root becomes live again; drop the payload rewrite and the stored assertion keeps its ref copy.
test("compacting source storage keeps every version, root, row and live root", async () => {
  const path = await migratedUntil("038-projection-source-roots")
  withDatabase(path, (db) => db.exec(legacySourceFixture()))
  await migrateTo(path, "052-compact-source-storage")
  // A published root neither active nor retired must not come back to life.
  withDatabase(path, (db) =>
    db.exec(`UPDATE ontology_source_roots SET retired_at = NULL
      WHERE materialization_id = 'superseded'`)
  )
  await migrateTo(path)

  withDatabase(path, (db) => {
    const key = '["object","Device","a"]'
    expect(
      db
        .query(`SELECT versions.materialization_id, roots.root_key,
          roots.retired_at IS NOT NULL AS retired,
          roots.retired_at IS NULL AND roots.deleted = 0
            AND versions.status IN ('active', 'superseded') AS live
        FROM ontology_source_roots AS roots
        JOIN ontology_sources AS versions USING (version_id)
        ORDER BY versions.materialization_id`)
        .all()
    ).toEqual([
      { materialization_id: "abandoned", root_key: key, retired: 1, live: 0 },
      { materialization_id: "active", root_key: key, retired: 0, live: 1 },
      { materialization_id: "ready", root_key: key, retired: 0, live: 0 },
      { materialization_id: "staging", root_key: key, retired: 0, live: 0 },
      { materialization_id: "superseded", root_key: key, retired: 1, live: 0 },
    ])
    expect(db.query("SELECT count(*) AS count FROM ontology_sources").get()).toEqual({ count: 5 })
    expect(db.query("SELECT count(*) AS count FROM ontology_source_rows").get()).toEqual({
      count: 10,
    })

    const [state] = new SqliteMaterializationStateReader(db, "p").objectStates([
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
    expect(
      db.query("SELECT DISTINCT payload FROM ontology_source_rows WHERE entity_kind = 'link'").all()
    ).toEqual([{ payload: null }])
    expect(() =>
      db.exec(`INSERT INTO ontology_source_roots (version_id, project_id, root_key, staging_ordinal)
        SELECT version_id, 'p', '${key}', 1 FROM ontology_sources
        WHERE materialization_id = 'active'`)
    ).toThrow("UNIQUE")
  })
})

// Red proof: drop the count check around migration 052 and it commits without the orphan row.
test("compacting source storage fails rather than drop a row without a root", async () => {
  const path = await migratedUntil("038-projection-source-roots")
  withDatabase(path, (db) => db.exec(legacySourceFixture()))
  await migrateTo(path, "052-compact-source-storage")
  withDatabase(path, (db) =>
    db.exec(`DELETE FROM ontology_source_roots WHERE materialization_id = 'staging'`)
  )

  await expect(migrateTo(path)).rejects.toThrow(
    "Source versions, roots or rows were lost while compacting source storage."
  )
  withDatabase(path, (db) =>
    expect(
      db.query("SELECT count(*) AS count FROM ontology_source_rows WHERE root_sort_key <> ''").get()
    ).toEqual({ count: 10 })
  )
})
