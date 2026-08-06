import { createHash } from "node:crypto"
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
import agentExecutionsSql from "./migrations/009-agent-executions.sql" with { type: "text" }
import aiUsageAccountingFoundationSql from "./migrations/010-ai-usage-accounting-foundation.sql" with {
  type: "text",
}
import syncFailureRecordSql from "./migrations/011-sync-failure-record.sql" with { type: "text" }
import pipelineFailureRecordSql from "./migrations/012-pipeline-failure-record.sql" with {
  type: "text",
}
import workflowFailureRecordSql from "./migrations/013-workflow-failure-record.sql" with {
  type: "text",
}
import agentFailureRecordSql from "./migrations/014-agent-failure-record.sql" with { type: "text" }
import type { SQL, SQLClient } from "./pg-client"

export interface PostgresMigrationContext {
  exec(sqlText: string): Promise<void>
}

export const POSTGRES_STORAGE_ADAPTER_ID = "SixbPostgresStorage"

export function pgSql(id: string, sqlText: string): MigrationStep<PostgresMigrationContext> {
  return pgStep(id, (context) => context.exec(sqlText), { checksum: checksum(sqlText) })
}

export function pgStep(
  id: string,
  up: (context: PostgresMigrationContext) => void | Promise<void>,
  options: MigrationStepOptions = {}
): MigrationStep<PostgresMigrationContext> {
  return step<PostgresMigrationContext>(id, up, options)
}

export function createPostgresStorageMigrators(
  sql: SQL,
  schemaName: string
): readonly StorageMigrator[] {
  return [
    createPostgresMigrator({
      sql,
      schemaName,
      migrations: postgresStorageMigrations,
    }),
  ]
}

export function createPostgresMigrator(params: {
  readonly sql: SQL
  readonly schemaName: string
  readonly migrations: MigrationSet<PostgresMigrationContext>
}): StorageMigrator {
  return {
    adapterId: params.migrations.adapterId,
    latestVersion: params.migrations.latestVersion,
    async status() {
      return describeMigrationHistory({
        migrations: params.migrations,
        rows: await readPostgresHistory(params.sql, params.schemaName, params.migrations.adapterId),
      })
    },
    migrate() {
      return withPostgresMigrationLock(params, async (sql) => {
        const session = postgresMigrationSession(sql, params.schemaName)
        return runMigrationSet({
          context: session.context,
          migrations: params.migrations,
          state: session.state,
        })
      })
    },
  }
}

export async function migratePostgresStorage(sql: SQL, schemaName: string): Promise<void> {
  await createPostgresMigrator({
    sql,
    schemaName,
    migrations: postgresStorageMigrations,
  }).migrate()
}

export async function dropSchema(sql: SQL, schemaName: string): Promise<void> {
  await sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdent(schemaName)} CASCADE`)
}

export function quoteIdent(identifier: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
    throw new Error(`[SixbPg] Invalid identifier: ${identifier}`)
  }
  return `"${identifier}"`
}

function postgresMigrationSession(
  sql: SQL,
  schemaName: string
): { context: PostgresMigrationContext; state: MigrationHistoryStore } {
  const schema = quoteIdent(schemaName)
  const migrationsTable = `${schema}.sixb_migrations`
  // Migration steps receive a stable context; route exec() through the active transaction.
  let active: SQLClient | null = null
  const connection = (): SQLClient => active ?? sql

  return {
    context: {
      async exec(sqlText) {
        await connection().unsafe(sqlText)
      },
    },
    state: {
      async ensure() {
        await sql.unsafe(`
          CREATE SCHEMA IF NOT EXISTS ${schema};

          CREATE TABLE IF NOT EXISTS ${migrationsTable} (
            adapter_id TEXT NOT NULL,
            version INTEGER NOT NULL,
            id TEXT NOT NULL,
            checksum TEXT,
            status TEXT NOT NULL CHECK (status IN ('started', 'applied')),
            started_at TIMESTAMPTZ NOT NULL,
            finished_at TIMESTAMPTZ,
            PRIMARY KEY (adapter_id, version)
          );
        `)
      },
      async readHistory(adapterId) {
        const rows = await sql.unsafe<PostgresMigrationRow[]>(
          `SELECT * FROM ${migrationsTable} WHERE adapter_id = $1 ORDER BY version`,
          [adapterId]
        )
        return rows.map(rowToMigrationRecord)
      },
      async markStarted(adapterId, migration, at) {
        await connection().unsafe(
          `
            INSERT INTO ${migrationsTable} (
              adapter_id, version, id, checksum, status, started_at, finished_at
            ) VALUES ($1, $2, $3, $4, 'started', $5, NULL)
            ON CONFLICT(adapter_id, version) DO UPDATE SET
              id = excluded.id,
              checksum = excluded.checksum,
              status = excluded.status,
              started_at = excluded.started_at,
              finished_at = NULL
          `,
          [adapterId, migration.version, migration.id, migration.checksum ?? null, at]
        )
      },
      async markApplied(adapterId, migration, at) {
        await connection().unsafe(
          `
            UPDATE ${migrationsTable}
            SET status = 'applied', finished_at = $1
            WHERE adapter_id = $2 AND version = $3
          `,
          [at, adapterId, migration.version]
        )
      },
      async transaction(run) {
        // `sql` is the reserved connection holding the migration advisory lock. porsager's
        // reserved connection has no `.begin`, so drive the transaction manually on it and
        // route exec()/markStarted()/markApplied() through the same connection via `active`.
        const previous = active
        active = sql
        await sql.unsafe("BEGIN")
        try {
          await sql.unsafe(`SET LOCAL search_path TO ${schema}`)
          const result = await run()
          await sql.unsafe("COMMIT")
          return result
        } catch (error) {
          await sql.unsafe("ROLLBACK")
          throw error
        } finally {
          active = previous
        }
      },
    },
  }
}

/**
 * Reads migration history without DDL and without the advisory lock. `null` means the
 * history table does not exist, which is a state and not a failure.
 *
 * `migrate()` cannot be used for this: it calls `ensure()` first, so it runs
 * `CREATE SCHEMA`/`CREATE TABLE` and reserves a connection to hold
 * `pg_advisory_lock`. A probe must need no DDL grant — `/ready` is public and
 * unauthenticated — and must not serialize N replicas behind one lock.
 *
 * `to_regclass` returns NULL for a missing relation (including a missing schema)
 * instead of raising, and needs no catalog privileges.
 */
async function readPostgresHistory(
  sql: SQL,
  schemaName: string,
  adapterId: string
): Promise<readonly MigrationRecord[] | null> {
  const schema = quoteIdent(schemaName)
  const probe = await sql.unsafe<{ oid: string | null }[]>(`SELECT to_regclass($1) AS oid`, [
    `${schema}.sixb_migrations`,
  ])
  if (!probe[0]?.oid) {
    return null
  }

  const rows = await sql.unsafe<PostgresMigrationRow[]>(
    `SELECT * FROM ${schema}.sixb_migrations WHERE adapter_id = $1 ORDER BY version`,
    [adapterId]
  )
  return rows.map(rowToMigrationRecord)
}

async function withPostgresMigrationLock<T>(
  params: {
    readonly sql: SQL
    readonly schemaName: string
    readonly migrations: MigrationSet<PostgresMigrationContext>
  },
  run: (sql: SQL) => Promise<T>
): Promise<T> {
  const sql = await params.sql.reserve()
  const [first, second] = advisoryLockParts(
    `storage:migration:${params.schemaName}:${params.migrations.adapterId}`
  )

  try {
    await sql`SELECT pg_advisory_lock(${first}, ${second})`
    try {
      return await run(sql)
    } finally {
      await sql`SELECT pg_advisory_unlock(${first}, ${second})`
    }
  } finally {
    sql.release()
  }
}

function advisoryLockParts(key: string): readonly [number, number] {
  const hash = createHash("sha256").update(key).digest()
  return [hash.readInt32BE(0), hash.readInt32BE(4)]
}

function rowToMigrationRecord(row: PostgresMigrationRow): MigrationRecord {
  return {
    adapterId: row.adapter_id,
    version: row.version,
    id: row.id,
    checksum: row.checksum ?? undefined,
    status: row.status,
    startedAt: toIsoString(row.started_at),
    finishedAt: row.finished_at ? toIsoString(row.finished_at) : undefined,
  }
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function checksum(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

export const postgresStorageMigrations = defineMigrations<PostgresMigrationContext>({
  adapterId: POSTGRES_STORAGE_ADAPTER_ID,
  steps: [
    pgSql("001-initial-schema", initialSchemaSql),
    pgSql("002-workflow-run-output", workflowRunOutputSql),
    pgSql("003-merge-sync-runs", mergeSyncRunsSql),
    pgSql("004-executions", executionsSql),
    pgSql("005-workflow-executions", workflowExecutionsSql),
    pgSql("006-narrow-ontology-source-root-index", narrowOntologySourceRootIndexSql),
    pgSql("007-split-overrides", splitOverridesSql),
    pgSql("008-action-executions", actionExecutionsSql),
    pgSql("009-agent-executions", agentExecutionsSql),
    pgSql("010-ai-usage-accounting-foundation", aiUsageAccountingFoundationSql),
    pgSql("011-sync-failure-record", syncFailureRecordSql),
    pgSql("012-pipeline-failure-record", pipelineFailureRecordSql),
    pgSql("013-workflow-failure-record", workflowFailureRecordSql),
    pgSql("014-agent-failure-record", agentFailureRecordSql),
  ],
})

interface PostgresMigrationRow {
  readonly adapter_id: string
  readonly version: number
  readonly id: string
  readonly checksum: string | null
  readonly status: MigrationRecord["status"]
  readonly started_at: Date | string
  readonly finished_at: Date | string | null
}
