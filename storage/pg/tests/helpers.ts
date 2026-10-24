import { defineMigrations } from "@sixb/core/storage"
import { PostgresStorage } from "../src"
import { createPostgresMigrator, postgresStorageMigrations, quoteIdent } from "../src/migrations"
import { createPgClient, type SQL } from "../src/pg-client"

export interface TestStorageOptions {
  /** `false` starts from an empty database; `true` (the default) from the migrated schema. */
  readonly migrate?: boolean
  /** Start with only the first `migrateThrough` migrations applied, history included. */
  readonly migrateThrough?: number
}

export interface TestStorage {
  readonly storage: PostgresStorage
  readonly schemaName: string
  /** The test's own database: open further clients on it with this, not `DATABASE_URL`. */
  readonly connectionString: string
}

/**
 * Every test storage gets a database of its own, copied from a template migrated once per
 * process: `CREATE DATABASE … TEMPLATE` takes ~30 ms where running the migrations takes ~500 ms.
 * Templates are kept every few migrations so a migration test copies the nearest one and runs
 * the rest. Databases are isolated from each other, extensions included.
 */
const SCHEMA_NAME = "sixb_test"
const CHECKPOINT_INTERVAL = 8
const steps = postgresStorageMigrations.steps

const databases = new WeakMap<PostgresStorage, string>()
const templates = new Map<number, Promise<string>>()
let admin: SQL | undefined

export async function createTestStorage(options: TestStorageOptions = {}): Promise<TestStorage> {
  const migrated = options.migrateThrough ?? (options.migrate === false ? 0 : steps.length)
  if (!Number.isInteger(migrated) || migrated < 0 || migrated > steps.length) {
    throw new Error(`[SixbPg] migrateThrough must be between 0 and ${steps.length}.`)
  }

  const database = `sixb_test_${crypto.randomUUID().replaceAll("-", "")}`
  const checkpoint =
    migrated === steps.length ? migrated : migrated - (migrated % CHECKPOINT_INTERVAL)
  const template = checkpoint > 0 ? await migratedTemplate(checkpoint) : undefined
  await createDatabase(database, template)
  if (migrated > checkpoint) await migrateDatabase(database, migrated)

  const connectionString = databaseUrl(database)
  const storage = new PostgresStorage({ connectionString, schemaName: SCHEMA_NAME, max: 5 })
  databases.set(storage, database)
  return { storage, schemaName: SCHEMA_NAME, connectionString }
}

/** Closes the storage and drops its database, with any connection a test left open. */
export async function disposeTestStorage(storage: PostgresStorage): Promise<void> {
  await storage.close()
  const database = databases.get(storage)
  if (!database) return
  databases.delete(storage)
  await adminClient().unsafe(`DROP DATABASE IF EXISTS ${quoteIdent(database)} WITH (FORCE)`)
}

/**
 * Resolves once `waiters` connections to the database are blocked on a lock, or once `competing`
 * (the operation expected to block) settles without blocking: the point a concurrency test waits
 * for before releasing the transaction that holds the lock.
 */
export async function waitForLockWait(
  connectionString: string,
  competing: Promise<unknown>,
  waiters = 1
): Promise<void> {
  let settled = false
  competing.then(
    () => (settled = true),
    () => (settled = true)
  )
  const sql = createPgClient({ connectionString, schemaName: "public", max: 1 })
  try {
    for (const deadline = Date.now() + 10_000; !settled; await Bun.sleep(5)) {
      const [row] = await sql<{ waiting: number }[]>`
        SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
      `
      if ((row?.waiting ?? 0) >= waiters) return
      if (Date.now() > deadline) {
        throw new Error(`[SixbPg] ${waiters} sessions did not wait on a lock within 10s.`)
      }
    }
  } finally {
    await sql.end()
  }
}

/** Migrates the template every test storage is copied from; `tests/setup.ts` runs it once. */
export async function prepareTestDatabases(): Promise<void> {
  await migratedTemplate(steps.length)
}

export async function closeTestDatabases(): Promise<void> {
  await admin?.end({ timeout: 1 })
  admin = undefined
}

function migratedTemplate(migrated: number): Promise<string> {
  let template = templates.get(migrated)
  if (!template) {
    template = (async () => {
      const name = `sixb_template_${process.pid}_${migrated}`
      const previous = (Math.ceil(migrated / CHECKPOINT_INTERVAL) - 1) * CHECKPOINT_INTERVAL
      await createDatabase(name, previous > 0 ? await migratedTemplate(previous) : undefined)
      await migrateDatabase(name, migrated)
      return name
    })()
    templates.set(migrated, template)
  }
  return template
}

async function migrateDatabase(database: string, migrated: number): Promise<void> {
  const sql = createPgClient({
    connectionString: databaseUrl(database),
    schemaName: SCHEMA_NAME,
    max: 1,
  })
  try {
    await createPostgresMigrator({
      sql,
      schemaName: SCHEMA_NAME,
      migrations: defineMigrations({
        adapterId: postgresStorageMigrations.adapterId,
        steps: steps.slice(0, migrated),
      }),
    }).migrate()
  } finally {
    await sql.end()
  }
}

async function createDatabase(name: string, template?: string): Promise<void> {
  const from = template ? ` TEMPLATE ${quoteIdent(template)}` : ""
  await adminClient().unsafe(`CREATE DATABASE ${quoteIdent(name)}${from}`)
}

function adminClient(): SQL {
  admin ??= createPgClient({ connectionString: baseUrl(), schemaName: "public", max: 1 })
  return admin
}

function databaseUrl(database: string): string {
  const url = new URL(baseUrl())
  url.pathname = `/${database}`
  return url.toString()
}

function baseUrl(): string {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error(
      "[SixbPg] DATABASE_URL is required. Run `bun run test:e2e` from the @sixb/pg package."
    )
  }
  return connectionString
}
