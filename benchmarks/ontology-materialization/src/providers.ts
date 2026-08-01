import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { migrateStorage, type Storage } from "@sixb/core"
import { PostgresStorage } from "@sixb/pg"
import { migrateSqliteStorage, SqliteStorage } from "@sixb/sqlite"
import postgres from "postgres"

export type BenchmarkProvider = "postgres" | "sqlite"

export interface StorageSnapshot {
  readonly databaseBytes: number
  readonly wal: number | string
}

export interface BenchmarkBackend {
  readonly provider: BenchmarkProvider
  readonly storage: Storage
  snapshot(): Promise<StorageSnapshot>
  walGrowth(before: StorageSnapshot, after: StorageSnapshot): Promise<number>
  close(): Promise<void>
}

export async function createBenchmarkBackend(
  provider: BenchmarkProvider
): Promise<BenchmarkBackend> {
  return provider === "sqlite" ? createSqliteBackend() : createPostgresBackend()
}

async function createSqliteBackend(): Promise<BenchmarkBackend> {
  const directory = await mkdtemp(join(tmpdir(), "sixb-materialization-benchmark-"))
  const databasePath = join(directory, "storage.sqlite")
  await migrateSqliteStorage(directory)
  const storage = new SqliteStorage({ path: directory })

  return {
    provider: "sqlite",
    storage,
    async snapshot() {
      return {
        databaseBytes: await fileSize(databasePath),
        wal: await fileSize(`${databasePath}-wal`),
      }
    },
    async walGrowth(before, after) {
      return Number(after.wal) - Number(before.wal)
    },
    async close() {
      storage.close()
      await rm(directory, { force: true, recursive: true })
    },
  }
}

async function createPostgresBackend(): Promise<BenchmarkBackend> {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error("DATABASE_URL is required for the Postgres benchmark.")
  }

  const schemaName = `sixb_benchmark_${Date.now()}_${crypto.randomUUID().replaceAll("-", "")}`
  const storage = new PostgresStorage({ connectionString, max: 5, schemaName })
  const diagnostics = postgres(connectionString, {
    max: 1,
    prepare: false,
    connection: { search_path: "public" },
    onnotice: () => {},
  })
  await migrateStorage(storage)

  return {
    provider: "postgres",
    storage,
    async snapshot() {
      const [size] = await diagnostics<{ bytes: string }[]>`
        SELECT COALESCE(
          SUM(pg_total_relation_size(format('%I.%I', schemaname, tablename)::regclass)),
          0
        )::text AS bytes
        FROM pg_tables
        WHERE schemaname = ${schemaName}
      `
      const [wal] = await diagnostics<{ lsn: string }[]>`
        SELECT pg_current_wal_lsn()::text AS lsn
      `
      if (!size || !wal) throw new Error("Postgres benchmark diagnostics returned no row.")
      return { databaseBytes: Number(size.bytes), wal: wal.lsn }
    },
    async walGrowth(before, after) {
      const [row] = await diagnostics<{ bytes: string }[]>`
        SELECT pg_wal_lsn_diff(${String(after.wal)}::pg_lsn, ${String(before.wal)}::pg_lsn)::text AS bytes
      `
      if (!row) throw new Error("Postgres WAL diagnostics returned no row.")
      return Number(row.bytes)
    },
    async close() {
      await storage.dropSchema()
      await Promise.all([storage.close(), diagnostics.end({ timeout: 5 })])
    },
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch (error) {
    if (isMissingFile(error)) return 0
    throw error
  }
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}
