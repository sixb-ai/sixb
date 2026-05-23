import { createHash } from "node:crypto"
import type {
  MigrationHistoryStore,
  MigrationRecord,
  MigrationSet,
  MigrationStep,
  MigrationStepOptions,
  StorageMigrator,
} from "@sixb/core"
import { defineMigrations, planMigrationSet, runMigrationSet, step } from "@sixb/core"
import type { SQL } from "bun"
import initialSchemaSql from "./migrations/001-initial-schema.sql" with { type: "text" }

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
    plan() {
      return withPostgresMigrationLock(params, async (sql) => {
        const session = postgresMigrationSession(sql, params.schemaName)
        return planMigrationSet({
          migrations: params.migrations,
          state: session.state,
        })
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
  let active: SQL | null = null
  const connection = () => active ?? sql

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
        const rows = (await sql.unsafe(
          `SELECT * FROM ${migrationsTable} WHERE adapter_id = $1 ORDER BY version`,
          [adapterId]
        )) as PostgresMigrationRow[]
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
        return sql.begin(async (tx) => {
          const previous = active
          active = tx

          try {
            await tx.unsafe(`SET LOCAL search_path TO ${schema}`)
            return await run()
          } finally {
            active = previous
          }
        })
      },
    },
  }
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
  steps: [pgSql("001-initial-schema", initialSchemaSql)],
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
