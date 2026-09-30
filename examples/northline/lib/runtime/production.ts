import { RedisBroker } from "@sixb/broker-redis"
import { type DuckLakeCatalogOptions, DuckLakeStorage } from "@sixb/ducklake"
import { PostgresStorage } from "@sixb/pg"
import { BullMqQueues } from "@sixb/queues-bullmq"

/**
 * Providers for a deployed Northline, whose processes share state: PostgreSQL for objects and the
 * lake catalog, Redis for events and jobs. Lake data and files stay on the server's disk.
 */
export function productionRuntime() {
  const databaseUrl = requiredEnv("DATABASE_URL")
  const redisUrl = requiredEnv("REDIS_URL")

  return {
    storage: new PostgresStorage({ connectionString: databaseUrl }),
    broker: new RedisBroker({ connection: { url: redisUrl } }),
    queues: new BullMqQueues({ connection: redisUrl }),
    lakeStorage: new DuckLakeStorage({
      catalog: postgresCatalog(databaseUrl),
      dataPath: ".sixb/lake/data",
    }),
  }
}

function postgresCatalog(databaseUrl: string): DuckLakeCatalogOptions {
  const url = new URL(databaseUrl)
  return {
    type: "postgres",
    host: url.hostname,
    ...(url.port ? { port: Number(url.port) } : {}),
    database: decodeURIComponent(url.pathname.slice(1)),
    ...(url.username ? { user: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    metadataSchema: "northline_lake",
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`[Northline] Set ${name} to run Northline in production.`)
  return value
}
