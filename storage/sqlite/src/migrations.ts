import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type { StorageMigrator } from "@sixb/core"
import type {
  MigrationHistoryStore,
  MigrationRecord,
  MigrationSet,
  MigrationStep,
  MigrationStepOptions,
} from "@sixb/core/storage"
import {
  defineMigrations,
  describeMigrationHistory,
  runMigrationSet,
  step,
} from "@sixb/core/storage"
import initialSchemaSql from "./migrations/001-initial-schema.sql" with { type: "text" }
import workflowRunOutputSql from "./migrations/002-workflow-run-output.sql" with { type: "text" }
import mergeSyncRunsSql from "./migrations/003-merge-sync-runs.sql" with { type: "text" }
import executionsSql from "./migrations/004-executions.sql" with { type: "text" }
import workflowExecutionsSql from "./migrations/005-workflow-executions.sql" with { type: "text" }
import narrowOntologySourceRootIndexSql from "./migrations/006-narrow-ontology-source-root-index.sql" with {
  type: "text",
}
import splitOverridesSql from "./migrations/007-split-overrides.sql" with { type: "text" }
import actionExecutionsSql from "./migrations/008-action-executions.sql" with { type: "text" }

const MIGRATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS sixb_migrations (
    adapter_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    id TEXT NOT NULL,
    checksum TEXT,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    PRIMARY KEY (adapter_id, version)
  );
`

export const SQLITE_STORAGE_ADAPTER_ID = "SixbSqliteStorage"
export const SQLITE_STORAGE_FILE = "storage.sqlite"

export const sqliteStorageMigrations = defineMigrations({
  adapterId: SQLITE_STORAGE_ADAPTER_ID,
  steps: [
    sqliteSql("001-initial-schema", initialSchemaSql),
    sqliteSql("002-workflow-run-output", workflowRunOutputSql),
    sqliteSql("003-merge-sync-runs", mergeSyncRunsSql),
    sqliteSql("004-executions", executionsSql),
    sqliteSql("005-workflow-executions", workflowExecutionsSql),
    sqliteSql("006-narrow-ontology-source-root-index", narrowOntologySourceRootIndexSql),
    sqliteSql("007-split-overrides", splitOverridesSql),
    sqliteSql("008-action-executions", actionExecutionsSql),
  ],
})

export function sqliteStoragePath(basePath: string): string {
  return `${basePath}/${SQLITE_STORAGE_FILE}`
}

export function sqliteSql(id: string, sqlText: string): MigrationStep<Database> {
  return sqliteStep(
    id,
    (db) => {
      db.run(sqlText)
    },
    { checksum: checksum(sqlText) }
  )
}

export function sqliteStep(
  id: string,
  up: (db: Database) => void | Promise<void>,
  options: MigrationStepOptions = {}
): MigrationStep<Database> {
  return step<Database>(id, up, options)
}

export function installFreshSqliteSchema(db: Database): void {
  for (const migration of sqliteStorageMigrations.steps) {
    const installed = migration.up(db)
    if (installed instanceof Promise) {
      throw new Error(
        `[${sqliteStorageMigrations.adapterId}] Fresh SQLite schema installation must be synchronous`
      )
    }
  }
}

export function createSqliteStorageMigrators(basePath: string): readonly StorageMigrator[] {
  return [
    createSqliteMigrator({
      path: sqliteStoragePath(basePath),
      migrations: sqliteStorageMigrations,
    }),
  ]
}

export function createSqliteMigrator(params: {
  readonly path: string
  readonly migrations: MigrationSet<Database>
}): StorageMigrator {
  return {
    adapterId: params.migrations.adapterId,
    latestVersion: params.migrations.latestVersion,
    async status() {
      return describeMigrationHistory({
        migrations: params.migrations,
        rows: await readSqliteHistory(params.path, params.migrations.adapterId),
      })
    },
    async migrate() {
      return withSqliteDatabase(params.path, (db) =>
        runMigrationSet({
          context: db,
          migrations: params.migrations,
          state: sqliteMigrationHistoryStore(db),
        })
      )
    },
  }
}

export async function migrateSqliteStorage(basePath: string): Promise<void> {
  mkdirSync(basePath, { recursive: true })

  for (const migrator of createSqliteStorageMigrators(basePath)) {
    await migrator.migrate()
  }
}

export async function migrateSqliteDatabase(path: string): Promise<void> {
  await createSqliteMigrator({ path, migrations: sqliteStorageMigrations }).migrate()
}

function sqliteMigrationHistoryStore(db: Database): MigrationHistoryStore {
  return {
    ensure() {
      db.run(MIGRATIONS_TABLE_SQL)
    },
    readHistory(adapterId) {
      return db
        .query("SELECT * FROM sixb_migrations WHERE adapter_id = ? ORDER BY version")
        .all(adapterId)
        .map(rowToMigrationRecord)
    },
    markStarted(adapterId, migration, at) {
      db.query(`
        INSERT INTO sixb_migrations (
          adapter_id, version, id, checksum, status, started_at, finished_at
        ) VALUES (?, ?, ?, ?, 'started', ?, NULL)
        ON CONFLICT(adapter_id, version) DO UPDATE SET
          id = excluded.id,
          checksum = excluded.checksum,
          status = excluded.status,
          started_at = excluded.started_at,
          finished_at = NULL
      `).run(adapterId, migration.version, migration.id, migration.checksum ?? null, at)
    },
    markApplied(adapterId, migration, at) {
      db.query(`
        UPDATE sixb_migrations
        SET status = 'applied', finished_at = ?
        WHERE adapter_id = ? AND version = ?
      `).run(at, adapterId, migration.version)
    },
    async transaction(run) {
      db.run("BEGIN")

      try {
        const result = await run()
        db.run("COMMIT")
        return result
      } catch (error) {
        rollbackQuietly(db)
        throw error
      }
    },
  }
}

function rowToMigrationRecord(row: unknown): MigrationRecord {
  const migration = row as {
    adapter_id: string
    version: number
    id: string
    checksum: string | null
    status: "started" | "applied"
    started_at: string
    finished_at: string | null
  }

  return {
    adapterId: migration.adapter_id,
    version: migration.version,
    id: migration.id,
    checksum: migration.checksum ?? undefined,
    status: migration.status,
    startedAt: migration.started_at,
    finishedAt: migration.finished_at ?? undefined,
  }
}

function checksum(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

/**
 * Reads migration history without creating anything. `null` means there is no history
 * to read, which is a state and not a failure.
 *
 * `new Database(path)` creates the file, and `withSqliteDatabase` additionally mkdirs
 * its parent — fine on the way to a migration, wrong for a probe. So: `existsSync`
 * first, then open `readonly` so even a mistake below cannot write. `:memory:` is
 * always empty on a fresh connection, so there is nothing to report.
 */
async function readSqliteHistory(
  path: string,
  adapterId: string
): Promise<readonly MigrationRecord[] | null> {
  if (path === ":memory:" || !existsSync(path)) {
    return null
  }

  const db = new Database(path, { readonly: true })
  try {
    const table = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sixb_migrations'")
      .get()
    if (!table) {
      return null
    }

    return db
      .query("SELECT * FROM sixb_migrations WHERE adapter_id = ? ORDER BY version")
      .all(adapterId)
      .map(rowToMigrationRecord)
  } finally {
    db.close()
  }
}

async function withSqliteDatabase<T>(path: string, run: (db: Database) => Promise<T>): Promise<T> {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)

  try {
    return await run(db)
  } finally {
    db.close()
  }
}

function rollbackQuietly(db: Database): void {
  try {
    db.run("ROLLBACK")
  } catch {
    // Ignore rollback errors so the original migration failure is preserved.
  }
}
