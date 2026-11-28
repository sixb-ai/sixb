import type { Database, SQLQueryBindings } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runOntologyMigrationContractSuite } from "@sixb/core/testing"
import { migrateSqliteStorage, SqliteStorage } from "../src"
import { freshSqliteDatabase } from "../src/migrations"
import { SqliteOntologyMigrationStorage } from "../src/ontology-storage/migrations"
import { getSqliteStorageTestingAdapter } from "../src/testing"

const directories = new WeakMap<SqliteStorage, string>()

/** An edit stored before edit times were: its times are its update's. */
async function clearEditTimes(
  storage: SqliteStorage,
  ref: { readonly projectId: string; readonly objectTypeId: string; readonly primaryId: string }
): Promise<void> {
  getSqliteStorageTestingAdapter(storage)
    .db.query(
      `UPDATE ontology_object_overrides SET edited_at = '{}'
       WHERE project_id = ? AND object_type_id = ? AND primary_id = ?`
    )
    .run(ref.projectId, ref.objectTypeId, ref.primaryId)
}

// A file, as a project runs on, and a database in memory, as `sixb dev` may.
runOntologyMigrationContractSuite("SQLite storage", {
  createStorage: async () => {
    const directory = await mkdtemp(join(tmpdir(), "sixb-sqlite-migrations-"))
    await migrateSqliteStorage(directory)

    const storage = new SqliteStorage({ path: directory })
    directories.set(storage, directory)
    return storage
  },
  clearEditTimes,
  cleanup: async (storage) => {
    storage.close()
    const directory = directories.get(storage)
    if (directory) await rm(directory, { recursive: true, force: true })
  },
})

runOntologyMigrationContractSuite("SQLite storage in memory", {
  createStorage: () => new SqliteStorage(),
  clearEditTimes,
  cleanup: (storage) => storage.close(),
})

// Removal proof: in `deleteSourceLinks`, take the next `batchRows` rows from the type's first
// entry again instead of after the cursor; no batch then seeks past the sources before it, and
// each one walks again every kept `depot` row the batches before it walked.
test("SQLite storage removes a link's source rows in batches that each start after the last", async () => {
  const db = freshSqliteDatabase()
  try {
    db.run(`INSERT INTO ontology_sources (
      project_id, source_id, materialization_id, projection_run_id, projection_kind, protocol,
      status, execution_token, dataset_id, dataset_version_id, dataset_version_created_at,
      projection_revision, ownership_hash, ontology_revision, root_count, assertion_count,
      created_at, ready_at, updated_at
    ) VALUES ('p', 'jobs', 'm', 'r', 'object', 'replacement', 'ready', 't', 'd', 'v', '${AT}',
      'rev', 'own', 'ont', 5, 12, '${AT}', '${AT}', '${AT}')`)

    // Every job has a kept `depot` row before its `lead`; `s-2`'s three leads span two batches.
    const leads: Record<string, readonly string[]> = { "s-2": ["t-1", "t-2", "t-3"] }
    for (const [index, id] of ["s-1", "s-2", "s-3", "s-4", "s-5"].entries()) {
      db.run(
        `INSERT INTO ontology_source_roots (id, version_id, project_id, root_key, staging_ordinal)
         VALUES (?, 1, 'p', ?, ?)`,
        [index + 1, JSON.stringify(["object", "Job", id]), index]
      )
      for (const [linkId, target] of [
        ["depot", "t-1"],
        ...(leads[id] ?? ["t-1"]).map((lead) => ["lead", lead]),
      ]) {
        db.run(
          `INSERT INTO ontology_source_rows (root_id, entity_kind, source_type_id,
             source_primary_id, link_id, target_type_id, target_primary_id, payload)
           VALUES (?, 'link', 'Job', ?, ?, 'Technician', ?, '{}')`,
          [index + 1, id, linkId!, target!]
        )
      }
    }

    const plans: string[] = []
    const migrations = new SqliteOntologyMigrationStorage(
      observeSourceLinkPlans(db, plans),
      async (run) => run()
    )
    const shape = { properties: {}, links: {} }
    const run = await migrations.startRun({
      projectId: "p",
      id: "run",
      executionId: "kernel:run",
      startedAt: AT,
      plan: {
        ontologyRevision: "ont",
        migrations: [{ id: "job-lead", hash: "hash" }],
        types: [
          {
            objectTypeId: "Job",
            fromShape: shape,
            toShape: shape,
            steps: [{ kind: "removeLink", linkId: "lead", migrationId: "job-lead" }],
          },
        ],
      },
      parts: 1,
    })

    // The derived lane alone: the other lanes have nothing to rewrite.
    let lane = run.lanes.find((candidate) => candidate.lane.kind === "derived")!
    while (lane.cursor !== null) {
      lane = await migrations.applyBatch({
        projectId: "p",
        runId: "run",
        ordinal: lane.ordinal,
        batches: lane.batches,
        commit: { id: `run_${lane.batches}` } as never,
        batchRows: 2,
      })
    }

    const left = db
      .query(`SELECT source_primary_id AS id, link_id AS link FROM ontology_source_rows
        ORDER BY source_primary_id, link_id`)
      .all()
    expect(left).toEqual(["s-1", "s-2", "s-3", "s-4", "s-5"].map((id) => ({ id, link: "depot" })))
    expect(lane.counts.sources).toBe(7)
    expect(db.query("SELECT assertion_count FROM ontology_sources").get()).toEqual({
      assertion_count: 5,
    })

    // Both statements of the two batches after the first seek past the sources before them,
    // through the link-source index, and none scans the rows.
    const seeks = plans.filter((detail) =>
      detail.includes(
        "idx_ontology_source_rows_link_source (source_type_id=? AND source_primary_id>?"
      )
    )
    expect(seeks.length).toBe(4)
    expect(plans.filter((detail) => detail.startsWith("SCAN rows"))).toEqual([])
  } finally {
    db.close()
  }
})

const AT = "2026-04-01T00:00:00.000Z"

/** `db`, recording the plan of every statement that reads a removed link's source rows. */
function observeSourceLinkPlans(db: Database, plans: string[]): Database {
  return new Proxy(db, {
    get(target, property) {
      if (property !== "query") return Reflect.get(target, property, target)

      return (sql: string) => {
        const statement = target.query(sql)
        if (!sql.includes("rows.link_id IN")) return statement

        return new Proxy(statement, {
          get(query, method) {
            if (method !== "get" && method !== "all" && method !== "run") {
              return Reflect.get(query, method, query)
            }
            return (...bindings: SQLQueryBindings[]) => {
              const explained = target
                .query<{ detail: string }, SQLQueryBindings[]>(`EXPLAIN QUERY PLAN ${sql}`)
                .all(...bindings)
              plans.push(...explained.map((row) => row.detail))
              return query[method](...bindings)
            }
          },
        })
      }
    },
  })
}
