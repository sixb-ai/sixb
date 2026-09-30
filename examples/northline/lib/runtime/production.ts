import { magicLink } from "@sixb/auth-magic-link"
import { RedisBroker } from "@sixb/broker-redis"
import { type DuckLakeCatalogOptions, DuckLakeStorage } from "@sixb/ducklake"
import { PostgresStorage } from "@sixb/pg"
import { BullMqQueues } from "@sixb/queues-bullmq"
import { operators } from "../../security/groups/operators"

/**
 * Providers for a deployed Northline, whose processes share state: PostgreSQL for objects and the
 * lake catalog, Redis for events and jobs. Lake data and files stay on the server's disk.
 *
 * Sign-in is by magic link. With no email service configured, the link is written to the API's
 * log, which only people with access to the server can read: `sixb deploy logs api`.
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
    auth: magicLink({
      allowedDomains: listEnv("SIXB_AUTH_ALLOWED_DOMAINS"),
      bootstrapUsers: listEnv("SIXB_AUTH_BOOTSTRAP_USERS"),
      bootstrapGroups: [operators],
      subject: "Sign in to Northline Operations",
      sendMagicLink: async ({ email, url }) => {
        console.log(`[Northline] Sign-in link for ${email}: ${url}`)
      },
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

function listEnv(name: string): string[] {
  const values = requiredEnv(name)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
  if (values.length === 0) throw new Error(`[Northline] ${name} lists nothing.`)
  return values
}
